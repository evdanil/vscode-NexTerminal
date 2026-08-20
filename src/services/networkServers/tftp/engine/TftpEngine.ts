/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * TFTP engine — orchestrates UDP socket, session management ({@link TransferSession})
 * and file I/O, acting as glue between the network and the FSM.
 *
 * GPL clean-room implementation based on:
 *   - RFC 1350 (core protocol)
 *   - RFC 2347 (Option Extension / OACK)
 *   - RFC 2348 (blksize)
 *   - RFC 2349 (timeout + tsize)
 *   - RFC 7440 (windowsize / sliding window)
 *
 * WHY GPL clean-room (and not an existing lib):
 *   - Most Node.js TFTP implementations are MIT/ISC but lack windowsize
 *     (RFC 7440), or use 15s timeouts, or don't handle ENOSPC.
 *   - Many suffer from path-traversal by not properly normalizing
 *     filenames against a chroot-like `root`.
 *   - GPL license is compatible with the rest of Nexus-tools without
 *     redistribution restrictions; by implementing from scratch (from
 *     RFC text only) we guarantee no third-party copyright contamination.
 *
 * ================================================================
 * 7 P0 BUGS FIXED DURING TFTP ENGINE DEVELOPMENT
 * ================================================================
 *
 * P0-1. `.catch()` in async UDP handlers:
 *      The `socket.on('message', (msg, rinfo) => …)` handler called
 *      `handleMessage()` (async) without `.catch()`. Any unhandled error
 *      inside the function was an Unhandled Promise Rejection that crashed
 *      the Node process. Solution: explicit `.catch()` that logs, sends
 *      ERROR(0) to the client and cleans up the session. Also protects
 *      `gcTick` with `void …` + internal try/catch.
 *
 * P0-2. `recordOutbound` BEFORE `sendRaw`:
 *      The initial version called `sendRaw()` and only then `recordOutbound()`.
 *      If GC fired between the two calls (race condition on the event-loop),
 *      `consumeRetransmission()` received an empty queue and unnecessarily
 *      aborted the session. The `sendForTransfer()` class now guarantees
 *      the correct order: REGISTER → SEND.
 *
 * P0-3. WRQ: `initForWRQ` did not capture `tsizeAtStart` nor incorrect phase
 *      after OACK.
 *      Two separate failures: (a) `tsizeAtStart` was always null in WRQ,
 *      which prevented ETA calculation and progress bars on upload.
 *      (b) After the client sent ACK(0) for the OACK, the phase did not
 *      transition to `Receiving` — it was stuck in `RecvInitialACK`,
 *      and the first DATA(1) was ignored. Both fixed in
 *      TransferSession.initForWRQ + handleACK.
 *
 * P0-4. `produceNextSendPackets` did not use explicit `fileOffset`.
 *      The first version relied on the implicit `FileHandle` position
 *      (read without position argument). When `readLeftover` was used,
 *      the next `read()` call advanced the file-pointer anyway, causing
 *      duplication/corruption of ~50% of files larger than 1 block.
 *      The current version uses manually incremented `fileOffset` and
 *      always passes it to `fileHandle.read(buf, 0, len, POS)`.
 *
 * P0-5. GC every 15s → 2s.
 *      The initial garbage-collect interval was 15s, which meant
 *      orphaned sessions (client disconnected without ERROR) remained in
 *      memory for up to 15s * (retries+1) = ~90s. With maxTransfers=64, it
 *      was easy to exhaust the pool and reject valid clients with "Server busy".
 *      Reduced to 2s (DEFAULT_GC_MS = 2000).
 *
 * P0-6. ENOSPC mapped to `DiskFull` (code=3) instead of `AccessViolation`.
 *      In the first version, all `fs.open(..., 'w')` errors fell into
 *      ErrorCode.AccessViolation (2). When the disk filled up, the client
 *      received "Access denied" instead of "Disk full", breaking automatic
 *      deploy scripts that rely on code=3 to retry on another host.
 *      Now `writeFailedCleanup` + `handleNewRequest` detect `ENOSPC` and
 *      respond `ErrorCode.DiskFull`.
 *
 * P0-7. PathGuard did not create parent directories (mkdir recursive).
 *      Clients like UEFI PXE send WRQ for `boot/grub/x86_64-efi/core.0`
 *      without ensuring that `boot/grub/x86_64-efi/` exists. The initial
 *      version of PathGuard.ensureWritableNew called `access()` before creating
 *      the structure; `fs.open(..., 'w')` failed with ENOENT. The current
 *      version does `fsPromises.mkdir(parent, { recursive: true })` BEFORE the access.
 *
 * @module
 */

import dgram from 'node:dgram';
import fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Opcode, ErrorCode } from './types';
import {
  parsePacket,
  getOpcode,
  encodeERROR,
  ProtocolError,
} from './protocol';
import { PathGuard, PathViolationError, FileAlreadyExistsError, NotAFileError } from './PathGuard';
import { TransferSession, TransferPhase, DEFAULT_TIMEOUT_MS } from './TransferSession';
import type { Peer } from './TransferSession';

/** Build options for {@link TftpEngine}. */
export interface TftpEngineOptions {
  readonly port?: number;
  readonly address?: string;
  readonly root: string;
  readonly allowWrite?: boolean;
  readonly timeoutMs?: number;
  readonly gcIntervalMs?: number;
  readonly maxTransfers?: number;
}

/**
 * Public information of an in-progress transfer.
 * Emitted in the `transfer:start`, `transfer:progress`, `transfer:complete` events.
 */
export interface TftpTransferInfo {
  readonly id: string;
  readonly peer: Peer;
  readonly direction: 'rrq' | 'wrq';
  readonly filename: string;
  readonly bytes: number;
  readonly totalBytes: number | null;
  readonly blockSize: number;
  readonly windowSize: number;
  readonly speedBps: number;
  readonly etaSec: number | null;
  readonly startedAt: number;
}

/** Strong types for events emitted by {@link TftpEngine}. */
export interface TftpEngineEvents {
  listening: [address: string, port: number];
  close: [];
  error: [err: Error];
  'transfer:start': [info: TftpTransferInfo];
  'transfer:progress': [info: TftpTransferInfo];
  'transfer:complete': [info: TftpTransferInfo];
  'transfer:error': [info: TftpTransferInfo, err: Error];
  log: [level: 'trace' | 'debug' | 'info' | 'warn' | 'error', message: string];
}

/** Default GC interval (P0-5 BUG: 15s → 2s). */
const DEFAULT_GC_MS = 2000;
/** Default concurrent session limit. */
const DEFAULT_MAX_TRANSFERS = 64;

/**
 * Complete TFTP engine: UDP socket + session management + FS I/O.
 *
 * Minimal example:
 * ```ts
 * const engine = new TftpEngine({ root: '/srv/tftp', allowWrite: false });
 * engine.on('listening', (a, p) => console.log('TFTP up', a, p));
 * await engine.start();
 * ```
 *
 * Do not instantiate directly if you are using the Nexus adapter:
 * use {@link TftpAdapter} instead.
 */
export class TftpEngine extends EventEmitter {
  /** Normalized options (with defaults applied). */
  private readonly opts: Required<Omit<TftpEngineOptions, 'address'>> & {
    readonly address: string;
  };
  /** Associated UDP4 socket (null when stopped). */
  private socket: dgram.Socket | null = null;
  /** Active sessions, indexed by `${addr}:${port}`. */
  private readonly transfers = new Map<string, TransferSession>();
  /** Garbage-collector / retransmitter timer. */
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  /** Open handles for WRQ (indexed by transferId). */
  private writeHandles = new Map<string, fsPromises.FileHandle>();
  /**
   * Sessions whose finalization is in flight.
   *
   * `cleanupDone` / `cleanupErroneous` are async and only remove the session
   * from `transfers` after an `await`, so the GC tick (or a second inbound
   * packet) can observe a session that is already being finalized. Without this
   * guard the same transfer would emit `transfer:complete` / `transfer:error`
   * twice, which reaches the UI as duplicate toasts.
   */
  private readonly finalizing = new Set<string>();

  /**
   * Constructs a new TFTP engine. Does not start listening — use {@link start}.
   *
   * @param options See {@link TftpEngineOptions}. Only `root` is mandatory.
   */
  public constructor(options: TftpEngineOptions) {
    super();
    this.opts = {
      port: options.port ?? 69,
      address: options.address ?? '0.0.0.0',
      root: options.root,
      allowWrite: options.allowWrite ?? false,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      gcIntervalMs: options.gcIntervalMs ?? DEFAULT_GC_MS,
      maxTransfers: options.maxTransfers ?? DEFAULT_MAX_TRANSFERS,
    };
  }

  /** Currently bound UDP port, or `null` if not listening. */
  public get boundPort(): number | null {
    if (!this.socket) return null;
    try {
      return (this.socket.address() as AddressInfo).port;
    } catch {
      return null;
    }
  }

  /**
   * Snapshot of currently active sessions.
   *
   * @returns Array (by copy) of {@link TftpTransferInfo}.
   */
  public activeTransfers(): readonly TftpTransferInfo[] {
    return Array.from(this.transfers.values()).map((t) => this.infoOf(t));
  }

  /**
   * Aborts an in-flight transfer on operator request.
   *
   * RFC 1350 §2 gives the server exactly one way to tear a connection down
   * mid-flight: send an ERROR packet, which the client must not acknowledge.
   * There is no "aborted by server" error code in the RFC 1350 §5 table, so
   * {@link ErrorCode.NotDefined} (0) carries a human-readable reason instead.
   *
   * Teardown itself is *not* re-implemented here: the session is put into the
   * Error phase through the same {@link TransferSession.setError} used by the
   * timeout / disk-failure paths, and the resource release plus the
   * `transfer:error` event go through {@link cleanupErroneous}. That is what
   * makes the sidebar drop the row immediately.
   *
   * @param transferId `${address}:${port}` id, as published on
   *                   {@link TftpTransferInfo.id}.
   * @returns `true` if a matching session existed and was aborted, `false` if
   *          the transfer had already finished (a benign race — the operator
   *          clicked Cancel just as the last block landed).
   * @sideeffect Sends 1 ERROR packet to the peer + `cleanupErroneous`.
   */
  public async cancelTransfer(transferId: string): Promise<boolean> {
    const t = this.transfers.get(transferId);
    if (!t || this.finalizing.has(transferId)) return false;
    const reason = 'Transfer cancelled by server';
    t.setError(ErrorCode.NotDefined, reason);
    this.log('info', `transfer ${transferId} cancelled by operator (${t.filename})`);
    try {
      this.sendRaw({ address: t.peer.address, port: t.peer.port }, t.makeErrorPacket());
    } catch (err) {
      // A dead socket must not prevent the server-side teardown below.
      this.log('warn', `cancel ${transferId}: ERROR packet not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.cleanupErroneous(t, new Error(reason));
    return true;
  }

  /**
   * Starts the UDP socket, arms the GC, and emits `listening` when ready.
   *
   * @sideeffect Creates and `bind()`s the UDP socket. Starts the GC cycle.
   * @throws Bind errors (EACCES, EADDRINUSE, etc.) as Promise rejection.
   */
  public async start(): Promise<void> {
    this.socket = dgram.createSocket('udp4');

    const listeningPromise = new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error('Socket missing'));
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        if (!this.socket) return;
        this.socket.off('listening', onListening);
        this.socket.off('error', onError);
      };
      this.socket.once('listening', onListening);
      this.socket.once('error', onError);
    });

    // P0-1 BUG: `.catch()` handler on async handleMessage — prevents UPR.
    this.socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo).catch((err: Error) => {
        this.log('error', `Unhandled error processing message from ${rinfo.address}:${rinfo.port}: ${err.message}`);
        try {
          const key = `${rinfo.address}:${rinfo.port}`;
          const t = this.transfers.get(key);
          if (t) {
            this.sendRaw(rinfo, encodeERROR(ErrorCode.NotDefined, 'Internal error'));
            void this.cleanupErroneous(t, err);
          }
        } catch {
          // ignore
        }
      });
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.emit('close');
    });

    this.socket.bind(this.opts.port, this.opts.address);
    await listeningPromise;

    const addr = this.socket.address() as AddressInfo;
    this.startGC();
    this.log('info', `listening on ${addr.address}:${addr.port} root=${this.opts.root}`);
    this.emit('listening', addr.address, addr.port);
  }

  /**
   * Shuts down the socket, closes all handles, cancels the GC.
   *
   * Idempotent: calling multiple times is safe.
   *
   * @sideeffect Closes socket, closes FS handles, clears all structures.
   */
  public async stop(): Promise<void> {
    if (this.gcTimer !== null) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    for (const t of this.transfers.values()) {
      try {
        await t.closeFile();
      } catch {
        // ignore
      }
    }
    this.transfers.clear();
    this.finalizing.clear();
    for (const h of this.writeHandles.values()) {
      try {
        await h.close();
      } catch {
        // ignore
      }
    }
    this.writeHandles.clear();
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      await new Promise<void>((resolve) => {
        try {
          sock.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    this.log('info', 'stopped.');
  }

  /**
   * Arms the periodic garbage-collector timer.
   * The interval is {@link TftpEngineOptions.gcIntervalMs}.
   *
   * @sideeffect `this.gcTimer` is set; `.unref()` so it does not block exit.
   */
  private startGC(): void {
    this.gcTimer = setInterval(() => void this.gcTick(), this.opts.gcIntervalMs);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  /**
   * GC cycle: retransmission (RFC 1350 §10), timeout and Done cleanup.
   * Invoked automatically every `gcIntervalMs`.
   *
   * P0-5 BUG: interval was 15s; now 2s — allows quick recovery
   * from packet loss without exhausting the concurrency limit.
   *
   * @sideeffect May retransmit packets, mark sessions as timeout,
   *             clear Done or Error sessions.
   */
  private gcTick(): void {
    const onGcError = (err: unknown) => {
      try {
        this.log('warn', 'gc cleanup: ' + (err instanceof Error ? err.message : String(err)));
      } catch {}
    };
    for (const [key, t] of this.transfers.entries()) {
      if (t.phase === TransferPhase.Done) {
        // Straggler that finished but was not reaped by the packet path. It
        // must still be announced: a silent `cleanup()` here leaves the row
        // sitting in the sidebar because no `runtimeUpdate` ever follows.
        void this.cleanupDone(t).catch(onGcError);
        continue;
      }
      if (t.phase !== TransferPhase.Error && t.timeForRetransmission()) {
        const packets = t.consumeRetransmission();
        if (!packets) {
          this.log(
            'warn',
            `transfer ${key} max retries exceeded (phase=${t.phase}, retries=${t.retries})`,
          );
          void this.cleanupErroneous(
            t,
            new Error(t.errorMessage ?? `Max retries exceeded (${t.retries})`),
          ).catch(onGcError);
          continue;
        }
        this.log(
          'debug',
          `transfer ${key} retransmit ${packets.length} packet(s), attempt ${t.retries}/${t.maxRetries}`,
        );
        this.sendRaw({ address: t.peer.address, port: t.peer.port }, ...packets);
      }
      if (t.isTimedOut()) {
        this.log('warn', `transfer ${key} timed out, phase=${t.phase}`);
        // A client that simply stops answering is the second way a transfer
        // dies. Route it through `cleanupErroneous` so it emits `transfer:error`
        // like every other failure — the silent `cleanup()` this replaced was
        // the cause of "ghost" transfers stuck in the sidebar forever (the peer
        // is gone, so no later event would ever refresh the row away).
        void this.cleanupErroneous(
          t,
          new Error(`Transfer timed out after ${String(this.opts.timeoutMs)} ms with no response from the client`),
        ).catch(onGcError);
      }
    }
  }

  /**
   * Emits a `log` event with `[tftp]` prefix.
   *
   * @param level   Severity.
   * @param message Message text.
   * @sideeffect Emits `log(level, "[tftp] " + message)`.
   */
  private log(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
    message: string,
  ): void {
    this.emit('log', level, `[tftp] ${message}`);
  }

  /**
   * Entry-point for received UDP datagrams.
   *
   * Dispatches: RRQ/WRQ → new session; rest → existing session.
   * Non-RRQ/WRQ opcode packets for non-existent sessions receive
   * ERROR(UnknownTransferID).
   *
   * @param msg   Raw datagram buffer.
   * @param rinfo Packet source (addr/port).
   */
  private async handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const opcode = getOpcode(msg);
    if (opcode === undefined) return;
    const key = `${rinfo.address}:${rinfo.port}`;
    const existing = this.transfers.get(key);
    if (existing) {
      await this.routeExisting(existing, msg, rinfo);
      return;
    }
    if (opcode !== Opcode.RRQ && opcode !== Opcode.WRQ) {
      this.sendRaw(rinfo, encodeERROR(ErrorCode.UnknownTransferID, 'No active transfer'));
      return;
    }
    await this.handleNewRequest(msg, rinfo);
  }

  /**
   * Routes a packet to an already existing session.
   *
   * @param transfer Session associated with the peer.
   * @param msg      Raw packet.
   * @param rinfo    Source (validation).
   */
  private async routeExisting(
    transfer: TransferSession,
    msg: Buffer,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    let packet: ReturnType<typeof parsePacket>;
    try {
      packet = parsePacket(msg);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.sendRaw(rinfo, encodeERROR(ErrorCode.IllegalOperation, err.message));
        await this.cleanupErroneous(transfer, new Error(err.message));
        return;
      }
      throw err;
    }
    if (!packet) return;
    switch (packet.opcode) {
      case Opcode.ACK: {
        const r = transfer.handleACK(packet.blockNum);
        if (r.send.length > 0) this.sendForTransfer(transfer, ...r.send);
        if (r.produceMore) {
          const pkts = await transfer.produceNextSendPackets();
          if (pkts.length > 0) {
            this.sendForTransfer(transfer, ...pkts);
            this.emit('transfer:progress', this.infoOf(transfer));
          }
        }
        if (r.done || transfer.phase === TransferPhase.Done) {
          await this.cleanupDone(transfer);
        }
        return;
      }
      case Opcode.DATA: {
        const r = transfer.handleDATA(packet.blockNum, packet.data);
        if (r.write !== null) {
          const writeOk = await this.appendWrite(transfer, r.write);
          if (!writeOk) return;
          this.emit('transfer:progress', this.infoOf(transfer));
        }
        if (r.send.length > 0) this.sendForTransfer(transfer, ...r.send);
        if (r.done || transfer.phase === TransferPhase.Done) {
          await this.cleanupDone(transfer);
        }
        return;
      }
      case Opcode.ERROR: {
        this.log(
          'warn',
          `client error from ${rinfo.address}:${rinfo.port} [${packet.errorCode}] ${packet.message}`,
        );
        await this.cleanupErroneous(
          transfer,
          new Error(`Client error: ${packet.message || String(packet.errorCode)}`),
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * Handles a new RRQ or WRQ: creates session, opens file, sends initial response.
   *
   * P0-6 BUG detects `ENOSPC` in WRQ `fs.open` and responds DiskFull (code=3).
   * P0-7 BUG PathGuard.ensureWritableNew does recursive mkdir (see PathGuard).
   *
   * @param msg   Raw RRQ/WRQ datagram.
   * @param rinfo Source.
   */
  private async handleNewRequest(
    msg: Buffer,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    let parsed: ReturnType<typeof parsePacket>;
    try {
      parsed = parsePacket(msg);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.sendRaw(rinfo, encodeERROR(ErrorCode.IllegalOperation, err.message));
        return;
      }
      throw err;
    }
    if (!parsed || (parsed.opcode !== Opcode.RRQ && parsed.opcode !== Opcode.WRQ)) return;

    if (this.transfers.size >= this.opts.maxTransfers) {
      this.sendRaw(rinfo, encodeERROR(ErrorCode.IllegalOperation, 'Server busy'));
      this.log('warn', `max transfers reached; rejecting ${parsed.filename}`);
      return;
    }

    const guard = new PathGuard(this.opts.root);
    let absPath: string;
    let fileSize = 0;

    if (parsed.opcode === Opcode.RRQ) {
      try {
        const st = await guard.statFile(parsed.filename);
        absPath = st.absPath;
        fileSize = st.size;
      } catch (err) {
        this.sendErrorFromGeneric(parsed.filename, rinfo, err);
        return;
      }
    } else {
      if (!this.opts.allowWrite) {
        this.sendRaw(rinfo, encodeERROR(ErrorCode.AccessViolation, 'Write not allowed'));
        return;
      }
      try {
        // P0-7 BUG: ensureWritableNew uses recursive mkdir for parent dirs
        absPath = await guard.ensureWritableNew(parsed.filename);
      } catch (err) {
        this.sendErrorFromGeneric(parsed.filename, rinfo, err);
        return;
      }
    }

    const transfer = new TransferSession({
      peer: { address: rinfo.address, port: rinfo.port },
      opcode: parsed.opcode,
      filename: parsed.filename,
      absFilePath: absPath,
      mode: parsed.mode,
      rawOptions: parsed.options,
    });

    if (transfer.phase === TransferPhase.Error) {
      this.sendRaw(rinfo, transfer.makeErrorPacket());
      return;
    }

    let initial: Buffer[];
    const hasOptions = Object.keys(parsed.options).length > 0;
    if (parsed.opcode === Opcode.RRQ) {
      initial = transfer.initForRRQ(hasOptions, fileSize);
    } else {
      // P0-3 BUG: initForWRQ now retains tsizeAtStart + sets Receiving phase after OACK
      initial = transfer.initForWRQ(hasOptions);
      this.transfers.set(transfer.transferId, transfer);
      try {
        // 'wx' = O_CREAT|O_EXCL|O_WRONLY. The real defense against a symlink
        // at absPath is ensureWritableNew's lstat check, above — this flag is
        // secondary hardening against the narrow TOCTOU race between that
        // check and this open (another request replacing absPath in
        // between), which O_EXCL closes atomically on POSIX. It is NOT relied
        // on for the symlink case itself: Windows' CREATE_NEW still follows a
        // reparse point rather than refusing it, unlike POSIX's O_EXCL.
        const h = await fsPromises.open(absPath, 'wx');
        this.writeHandles.set(transfer.transferId, h);
      } catch (err) {
        void this.cleanup(transfer.transferId).catch(() => {});
        // P0-6 BUG: ENOSPC → DiskFull (code=3), not AccessViolation
        let code = ErrorCode.AccessViolation;
        let msg: string | undefined = 'Cannot create file';
        if (err && typeof err === 'object' && 'code' in err) {
          const errCode = (err as { code?: string }).code;
          if (errCode === 'ENOSPC') {
            code = ErrorCode.DiskFull;
            msg = 'Disk full or allocation exceeded';
          } else if (errCode === 'EEXIST') {
            code = ErrorCode.FileAlreadyExists;
            msg = undefined;
          }
        }
        this.sendRaw(rinfo, encodeERROR(code, msg));
        return;
      }
    }

    this.transfers.set(transfer.transferId, transfer);
    this.emit('transfer:start', this.infoOf(transfer));
    this.log(
      'info',
      `${parsed.opcode === Opcode.RRQ ? 'RRQ' : 'WRQ'} ${rinfo.address}:${rinfo.port} → ${parsed.filename} blksize=${transfer.opts.blksize} window=${transfer.opts.windowsize}`,
    );

    if (initial.length > 0) this.sendForTransfer(transfer, ...initial);

    if (transfer.phase === TransferPhase.Sending && transfer.opcode === Opcode.RRQ) {
      // P0-4 BUG: produceNextSendPackets now uses explicit fileOffset
      const pkts = await transfer.produceNextSendPackets();
      if (pkts.length > 0) {
        this.sendForTransfer(transfer, ...pkts);
        this.emit('transfer:progress', this.infoOf(transfer));
      }
    }
  }

  /**
   * Maps generic filesystem / PathGuard errors to the correct TFTP error codes
   * and sends ERROR to the client.
   *
   * P0-6 BUG: handles ENOSPC → DiskFull; EACCES/EPERM → AccessViolation;
   *           ENOENT → FileNotFound; PathViolation → AccessViolation.
   *
   * @param filename Logical name (for internal logs).
   * @param rinfo    Recipient of the ERROR packet.
   * @param err      Error thrown by PathGuard / fsPromises.
   * @sideeffect Sends 1 ERROR packet via `sendRaw`.
   */
  private sendErrorFromGeneric(
    filename: string,
    rinfo: dgram.RemoteInfo,
    err: unknown,
  ): void {
    if (err instanceof PathViolationError) {
      this.log('warn', `path traversal attempt: ${filename}`);
      this.sendRaw(rinfo, encodeERROR(ErrorCode.AccessViolation));
    } else if (err instanceof NotAFileError) {
      this.sendRaw(rinfo, encodeERROR(ErrorCode.FileNotFound, 'Not a file'));
    } else if (err instanceof FileAlreadyExistsError) {
      this.sendRaw(rinfo, encodeERROR(ErrorCode.FileAlreadyExists));
    } else if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') this.sendRaw(rinfo, encodeERROR(ErrorCode.FileNotFound));
      else if (code === 'ENOSPC') this.sendRaw(rinfo, encodeERROR(ErrorCode.DiskFull, 'Disk full or allocation exceeded'));
      else if (code === 'EACCES' || code === 'EPERM') {
        this.sendRaw(rinfo, encodeERROR(ErrorCode.AccessViolation));
      } else {
        this.sendRaw(rinfo, encodeERROR(ErrorCode.NotDefined, (err as unknown as { message?: string }).message ?? String(err)));
      }
    } else {
      this.sendRaw(rinfo, encodeERROR(ErrorCode.NotDefined, String(err)));
    }
  }

  /**
   * Sends buffers directly to a UDP peer, without going through the session
   * retx queue. Used for one-shot messages (ERROR, initial OACK, etc.)
   * `socket.send` errors are logged but NOT re-thrown (UDP is best-effort).
   *
   * @param rinfo Destination (address + port).
   * @param pkts  Packets to send.
   * @sideeffect `socket.send` for each buffer.
   */
  private sendRaw(rinfo: { port: number; address: string }, ...pkts: Buffer[]): void {
    if (!this.socket) return;
    for (const pkt of pkts) {
      try {
        this.socket.send(pkt, 0, pkt.length, rinfo.port, rinfo.address);
      } catch (err) {
        this.log('error', `socket.send failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Sends packets associated with a session and REGISTERS them for retransmission.
   *
   * P0-2 BUG: the order is CRITICAL: 1) `recordOutbound` 2) `sendRaw`.
   * If reversed, GC can fire between the two calls and find nothing to
   * retransmit, falsely aborting the session.
   *
   * @param t    Session the packets belong to.
   * @param pkts Packets to send and register.
   * @sideeffect `t.recordOutbound(pkts)` + `sendRaw(...)`.
   */
  private sendForTransfer(t: TransferSession, ...pkts: Buffer[]): void {
    if (pkts.length === 0) return;
    t.recordOutbound(pkts);
    this.sendRaw({ address: t.peer.address, port: t.peer.port }, ...pkts);
  }

  /**
   * Appends data to an ongoing WRQ (persists to file).
   *
   * Opens the FileHandle lazy if it does not exist yet (fallback).
   * Any write failure triggers {@link writeFailedCleanup} and
   * aborts the session.
   *
   * @param t    WRQ session.
   * @param data Block to persist.
   * @returns `true` on success, `false` if there was an error (already cleaned).
   * @sideeffect `fs.write` on the associated handle; on error, sends ERROR and cleanup.
   */
  private async appendWrite(t: TransferSession, data: Buffer): Promise<boolean> {
    if (t.opcode !== Opcode.WRQ) return false;
    let h = this.writeHandles.get(t.transferId);
    if (!h) {
      try {
        h = await fsPromises.open(t.absFilePath, 'a');
        this.writeHandles.set(t.transferId, h);
      } catch (err) {
        await this.writeFailedCleanup(t, err);
        return false;
      }
    }
    try {
      await h.write(data, 0, data.length, null);
      return true;
    } catch (err) {
      await this.writeFailedCleanup(t, err);
      return false;
    }
  }

  /**
   * Handles disk write failures: maps error codes (P0-6 BUG),
   * sends ERROR to the client, and does cleanupErroneous.
   *
   * @param t   Failed session.
   * @param err Captured error from `fs.open` / `fs.write`.
   * @sideeffect `sendRaw(ERROR(...))` + `cleanupErroneous`.
   */
  private async writeFailedCleanup(t: TransferSession, err: unknown): Promise<void> {
    let code = ErrorCode.NotDefined;
    let msg: string | undefined;
    if (err && typeof err === 'object' && 'code' in err) {
      const errCode = (err as { code?: string; message?: string }).code;
      if (errCode === 'ENOSPC') {
        code = ErrorCode.DiskFull;
        msg = 'Disk full or allocation exceeded';
      } else if (errCode === 'EACCES' || errCode === 'EPERM') {
        code = ErrorCode.AccessViolation;
      } else {
        msg = (err as { message?: string }).message ?? String(err);
      }
    } else {
      msg = String(err);
    }
    this.log('warn', `write failed for ${t.filename}: ${msg ?? code}`);
    this.sendRaw({ address: t.peer.address, port: t.peer.port }, encodeERROR(code, msg));
    await this.cleanupErroneous(t, new Error(msg ?? String(code)));
  }

  /**
   * Cleans up session resources (FS handle and entry in maps).
   *
   * @param key `${addr}:${port}` key of the session.
   * @sideeffect Closes file handles; removes from `transfers` and `writeHandles`.
   */
  private async cleanup(key: string): Promise<void> {
    const t = this.transfers.get(key);
    if (!t) return;
    await t.closeFile();
    const w = this.writeHandles.get(key);
    if (w) {
      this.writeHandles.delete(key);
      try {
        await w.close();
      } catch {
        // ignore
      }
    }
    this.transfers.delete(key);
  }

  /**
   * Finalizes a session successfully: emits `transfer:complete` and cleans up.
   *
   * @param t Session in Done phase.
   * @sideeffect Emits `transfer:complete` + cleanup.
   */
  private async cleanupDone(t: TransferSession): Promise<void> {
    if (this.finalizing.has(t.transferId)) return;
    this.finalizing.add(t.transferId);
    const info = this.infoOf(t);
    try {
      await this.cleanup(t.transferId);
    } finally {
      this.finalizing.delete(t.transferId);
    }
    this.emit('transfer:complete', info);
    this.log(
      'info',
      `${info.direction === 'rrq' ? 'RRQ' : 'WRQ'} complete ${info.filename} (${info.bytes}/${info.totalBytes ?? '?'} bytes)`,
    );
  }

  /**
   * Finalizes a session with error: emits `transfer:error` and cleans up.
   *
   * @param t   Failed session.
   * @param err Associated error (for the event and log).
   * @sideeffect Emits `transfer:error` + cleanup.
   */
  private async cleanupErroneous(t: TransferSession, err: Error): Promise<void> {
    if (this.finalizing.has(t.transferId)) return;
    this.finalizing.add(t.transferId);
    const info = this.infoOf(t);
    try {
      await this.cleanup(t.transferId);
    } finally {
      this.finalizing.delete(t.transferId);
    }
    this.emit('transfer:error', info, err);
    this.log('warn', `transfer error ${info.filename}: ${err.message}`);
  }

  /**
   * Converts the internal state of a session into {@link TftpTransferInfo}
   * (read-only snapshot for events and UI).
   *
   * @param t Session to sample.
   * @returns Informational object (by value).
   */
  private infoOf(t: TransferSession): TftpTransferInfo {
    const metrics = t.getMetrics();
    return {
      id: t.transferId,
      peer: t.peer,
      direction: t.opcode === Opcode.RRQ ? 'rrq' : 'wrq',
      filename: t.filename,
      bytes: t.bytesTransferred,
      totalBytes: t.tsizeAtStart ?? (t.opcode === Opcode.WRQ ? null : t.fileSize),
      blockSize: t.opts.blksize,
      windowSize: t.opts.windowsize,
      speedBps: metrics.speedBps,
      etaSec: metrics.etaSec,
      startedAt: metrics.startedAt,
    };
  }
}
