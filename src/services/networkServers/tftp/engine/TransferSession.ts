/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * State machine (FSM) for an individual TFTP session (1 client:server pair).
 *
 * Implements the high-level logic of a transfer, completely separated
 * from UDP I/O (which is handled by {@link TftpEngine}). This allows
 * the FSM to be tested in isolation (pure-logic) without socket mocks.
 *
 * FSM phases:
 *   - Idle            : newly-created session, not yet initialized
 *   - SendOACK        : server negotiated options and sent OACK, waiting for
 *                       ACK(0) for RRQ or DATA(1) for WRQ
 *   - Sending         : RRQ in progress, sending DATA blocks
 *   - SentLast        : last DATA sent (<blksize), waiting for final ACK
 *   - RecvInitialACK  : WRQ without OACK, ACK(0) sent, waiting for DATA(1)
 *   - Receiving       : WRQ in progress, receiving DATA and sending ACKs
 *   - Error           : terminal error state
 *   - Done            : terminal success state
 *
 * RFCs 1350 + 2347/2348/2349/7440 are implemented here at the flow control
 * level (ack, window, timeout retransmission).
 */

import fsPromises from 'node:fs/promises';
import {
  Opcode,
  ErrorCode,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_WINDOW_SIZE,
  type ValidatedOptions,
  type RawOptions,
} from './types';
import {
  encodeACK,
  encodeDATA,
  encodeERROR,
  encodeOACK,
  validateOptions,
  validatedToRaw,
} from './protocol';

/** Default timeout (5s). RFC 2349 allows negotiation via the "timeout" option. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Size of the block-number space: block numbers are a 16-bit wire field. */
const BLOCK_SPACE = 0x10000;

/**
 * Forward distance from `from` to `to` in the 16-bit block-number space.
 *
 * Block numbers are 16 bits on the wire and this implementation wraps
 * 65535 → 1, so plain `<` / `>=` comparisons are wrong the moment a transfer
 * passes 65535 blocks (32 MB at the default blksize, one PXE image at any
 * realistic one): the sender's numbers restart while `lastAcked` is still up
 * at 65535, every subsequent ACK reads as "older than what we already have"
 * and the transfer stalls with no error on either side.
 *
 * Distance is computed modulo 65536 rather than modulo the 65535-value space
 * the wrap-to-1 actually walks. That costs one block of window width for the
 * single round after each wrap — never a stall, never an over-fill — and keeps
 * this the standard sequence-space arithmetic a reader already knows, instead
 * of a bespoke variant that has to be re-derived to be trusted.
 */
function blockDistance(from: number, to: number): number {
  return (to - from + BLOCK_SPACE) % BLOCK_SPACE;
}

/**
 * True when `later` is at or ahead of `earlier` in the block-number space —
 * the wrap-safe replacement for `later >= earlier`.
 *
 * "Ahead" is the near half of the space: an ACK more than 32768 blocks forward
 * is read as a stale duplicate lagging behind, which is what it always is in
 * practice (the window is bounded far below that).
 */
function blockAtOrAfter(earlier: number, later: number): boolean {
  return blockDistance(earlier, later) < BLOCK_SPACE / 2;
}

/** Maximum number of retransmission attempts before aborting the session. */
export const DEFAULT_MAX_RETRIES = 5;

/**
 * Phases of the {@link TransferSession} state machine.
 * @see TransferSession for description of each phase.
 */
export enum TransferPhase {
  Idle = 'idle',
  SendOACK = 'send-oack',
  Sending = 'sending',
  SentLast = 'sent-last',
  RecvInitialACK = 'recv-initial-ack',
  Receiving = 'receiving',
  Error = 'error',
  Done = 'done',
}

/**
 * Remote peer address (TFTP client).
 * Immutable during the session lifetime.
 */
export interface Peer {
  readonly address: string;
  readonly port: number;
}

/**
 * Initialization parameters for a new session.
 * Filled by {@link TftpEngine.handleNewRequest}.
 */
export interface TransferInit {
  readonly peer: Peer;
  readonly opcode: Opcode.RRQ | Opcode.WRQ;
  readonly filename: string;
  readonly absFilePath: string;
  readonly mode: 'octet' | 'netascii';
  readonly rawOptions: RawOptions;
}

/**
 * Public real-time metrics of a transfer.
 * Used by the engine's `transfer:start/progress/complete` events.
 */
export interface TransferMetrics {
  readonly speedBps: number;
  readonly etaSec: number | null;
  readonly startedAt: number;
}

/** Entry in the outbound retransmission queue. */
interface OutboundPacket {
  readonly blockNum: number | null;
  readonly buffer: Buffer;
}

/**
 * FSM state of an individual TFTP session (RRQ or WRQ).
 *
 * Purely deterministic: I/O (socket and filesystem) is done externally
 * (TftpEngine); this class only decides which packets to send in response
 * to events (received ACK, received DATA, request to produce new
 * send blocks).
 */
export class TransferSession {
  /** Remote peer (immutable). */
  public readonly peer: Peer;
  /** RRQ or WRQ (immutable). */
  public readonly opcode: Opcode.RRQ | Opcode.WRQ;
  /** Filename as it came in the request (for logs). */
  public readonly filename: string;
  /** Safe absolute path (via PathGuard) for FS operations. */
  public readonly absFilePath: string;
  /**
   * Transfer mode (RFC 1350). Always `octet` in practice: `netascii` is
   * refused during parsing (see `parseRRQorWRQ`) because the CR/LF conversion
   * it requires is not implemented, so a session is never built for one.
   */
  public readonly mode: 'octet' | 'netascii';

  /** Validated options after negotiation (RFC 2347+). */
  public opts: ValidatedOptions = {
    blksize: DEFAULT_BLOCK_SIZE,
    windowsize: DEFAULT_WINDOW_SIZE,
  };

  /** Current FSM phase. */
  public phase: TransferPhase = TransferPhase.Idle;
  /** TFTP error code (RFC 1350) if `phase === Error`. */
  public errorCode: ErrorCode | null = null;
  /** Error message if `phase === Error`. */
  public errorMessage: string | null = null;

  /** Next block number to send/receive (wrap 65535→1). */
  public blockNum = 0;
  /** Last block ACKed by the peer. */
  public lastAcked = 0;
  /** File size (RRQ = known at start; WRQ = 0 until finished). */
  public fileSize = 0;
  /** Bytes already transferred (includes non-ACKed in-flight data). */
  public bytesTransferred = 0;

  /** Timestamp of last activity (packet received or sent). */
  public lastActivity: number = Date.now();
  /** Retransmission attempt counter (reset on each valid ACK). */
  public retries = 0;
  /** Retransmission limit before aborting. */
  public readonly maxRetries = DEFAULT_MAX_RETRIES;

  /** Network timeout in ms (negotiable via RFC 2349). */
  public timeoutMs = DEFAULT_TIMEOUT_MS;
  /** Advertised size at start (tsize) for ETA/progress bar. */
  public tsizeAtStart: number | null = null;

  /** Open file handle (lazy open for RRQ). */
  private fileHandle: fsPromises.FileHandle | null = null;
  /** Extra data from the previous read, used in the next block. */
  private readLeftover: Buffer = Buffer.alloc(0);
  /** Current file read offset (avoids repeated reads). */
  private fileOffset = 0;

  /** Session start (UNIX ms). */
  public readonly startedAt: number = Date.now();
  /** Estimated instantaneous speed (EWMA). */
  private speedBps = 0;
  /** Timestamp of the last speed sample. */
  private lastMetricsSample: number = this.startedAt;
  /** EWMA smoothing factor for speed (0.25). */
  private readonly ewmaAlpha = 0.25;

  /** Queue of sent but not-yet-ACKed packets (for retransmission). */
  private outboundQueue: OutboundPacket[] = [];
  /** Timestamp of the last send (decides if it is time for retx). */
  private outboundSentLast: number = Date.now();
  /** Exponential backoff (doubles each retx, max 60s). */
  private retxBackoffMs = DEFAULT_TIMEOUT_MS;

  /**
   * Constructs a new session from an initial RRQ/WRQ.
   *
   * Validates extension options; if there is a negotiation error enters
   * `TransferPhase.Error` and the caller must send makeErrorPacket().
   *
   * @param init See {@link TransferInit}.
   */
  public constructor(init: TransferInit) {
    this.peer = init.peer;
    this.opcode = init.opcode;
    this.filename = init.filename;
    this.absFilePath = init.absFilePath;
    this.mode = init.mode;
    try {
      const validated = validateOptions(init.rawOptions, {
        blksize: DEFAULT_BLOCK_SIZE,
        windowsize: DEFAULT_WINDOW_SIZE,
      });
      this.opts = validated;
    } catch (err) {
      this.setError(
        ErrorCode.OptionNegotiation,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (this.opts.timeout !== undefined) {
      this.timeoutMs = this.opts.timeout * 1000;
    }
    this.retxBackoffMs = this.timeoutMs;
  }

  /**
   * Unique session identifier: `address:port` of the peer.
   * Used as key in the TftpEngine session Map.
   */
  public get transferId(): string {
    return `${this.peer.address}:${this.peer.port}`;
  }

  /**
   * Updates the activity timestamp and resets the retx backoff.
   * Called whenever a valid packet is received from the peer.
   *
   * @sideeffect `this.lastActivity = now`, `this.retxBackoffMs = timeoutMs`
   */
  public touch(): void {
    this.lastActivity = Date.now();
    this.retxBackoffMs = this.timeoutMs;
  }

  /**
   * Checks if the session should be collected due to total inactivity.
   *
   * The formula `timeoutMs * (retries + 1)` ensures we give enough time
   * for all scheduled retx before declaring the peer dead.
   *
   * @returns `true` if too much time has passed without activity.
   */
  public isTimedOut(): boolean {
    return Date.now() - this.lastActivity > this.timeoutMs * (this.retries + 1);
  }

  /**
   * Marks the session as error.
   *
   * @param code    RFC 1350 code.
   * @param message Human-readable message (sent in the ERROR packet).
   * @sideeffect `phase = Error`, `errorCode`, `errorMessage`
   */
  public setError(code: ErrorCode, message: string): void {
    this.phase = TransferPhase.Error;
    this.errorCode = code;
    this.errorMessage = message;
  }

  /**
   * Closes the file handle (if open).
   * Ignores close errors (the object is being destroyed).
   *
   * @sideeffect `this.fileHandle = null`
   */
  public async closeFile(): Promise<void> {
    if (this.fileHandle) {
      try {
        await this.fileHandle.close();
      } catch {
        // ignore
      }
      this.fileHandle = null;
    }
  }

  /**
   * Returns real-time metrics: speed (EWMA), ETA and start.
   *
   * @returns Always-valid {@link TransferMetrics} object.
   */
  public getMetrics(): TransferMetrics {
    const now = Date.now();
    this.updateMetrics(0, now);
    let etaSec: number | null = null;
    if (this.opcode === Opcode.RRQ && this.fileSize > 0 && this.speedBps > 0) {
      const remaining = Math.max(0, this.fileSize - this.bytesTransferred);
      etaSec = remaining / this.speedBps;
    } else if (this.tsizeAtStart !== null && this.tsizeAtStart > 0 && this.speedBps > 0) {
      const remaining = Math.max(0, this.tsizeAtStart - this.bytesTransferred);
      etaSec = remaining / this.speedBps;
    }
    return {
      speedBps: this.speedBps,
      etaSec,
      startedAt: this.startedAt,
    };
  }

  /**
   * Updates the speed estimate (EWMA).
   *
   * @param deltaBytes Bytes added since the last call.
   * @param now        Current timestamp (allows time-travel in tests).
   * @sideeffect `this.speedBps`, `this.lastMetricsSample`
   */
  private updateMetrics(deltaBytes: number, now = Date.now()): void {
    const elapsedMs = now - this.lastMetricsSample;
    if (elapsedMs >= 200) {
      const instantSpeed = deltaBytes > 0
        ? (deltaBytes * 1000) / Math.max(1, elapsedMs)
        : 0;
      if (this.speedBps === 0) {
        this.speedBps = instantSpeed;
      } else {
        this.speedBps = this.ewmaAlpha * instantSpeed + (1 - this.ewmaAlpha) * this.speedBps;
      }
      this.lastMetricsSample = now;
    }
  }

  /**
   * Records packets just sent for possible future retransmission.
   *
   * MUST be called BEFORE `socket.send` (correct order: record → send),
   * because if the caller does the reverse an immediate timeout fires
   * retx without the packets in the queue (P0 BUG fixed in TftpEngine).
   *
   * @param packets Packets that will be sent to the peer.
   * @sideeffect `this.outboundQueue`, `this.outboundSentLast`
   */
  public recordOutbound(packets: Buffer[]): void {
    for (const pkt of packets) {
      const op = pkt.readUInt16BE(0);
      let blockNum: number | null = null;
      if (op === Opcode.DATA || op === Opcode.ACK) {
        blockNum = pkt.readUInt16BE(2);
      }
      this.outboundQueue.push({ blockNum, buffer: pkt });
    }
    this.outboundSentLast = Date.now();
    if (this.outboundQueue.length > 256) {
      const drop = this.outboundQueue.length - 256;
      this.outboundQueue.splice(0, drop);
    }
  }

  /**
   * Clears all confirmed packets up to `ackBlockNum` from the retx queue.
   *
   * Called when a valid ACK arrives.
   *
   * @param ackBlockNum Block number confirmed in the ACK.
   * @sideeffect `this.outboundQueue` is truncated; `retxBackoffMs` reset.
   */
  public clearOutboundUpToAck(ackBlockNum: number): void {
    let i = 0;
    while (i < this.outboundQueue.length) {
      const p = this.outboundQueue[i];
      // `p.blockNum <= ackBlockNum` would stop dead at the wrap: a queue
      // holding 65534, 65535, 1, 2 confirmed by ACK(2) drains nothing, and the
      // session then retransmits blocks the peer already has until the queue
      // cap silently drops them.
      if (p.blockNum === null) {
        i++;
      } else if (ackBlockNum !== 0 && blockAtOrAfter(p.blockNum, ackBlockNum)) {
        i++;
      } else {
        break;
      }
    }
    if (i > 0) this.outboundQueue.splice(0, i);
    this.retxBackoffMs = this.timeoutMs;
  }

  /**
   * Checks if enough time has passed to retransmit the window.
   *
   * @returns `true` if the caller should invoke {@link consumeRetransmission}.
   */
  public timeForRetransmission(): boolean {
    if (this.outboundQueue.length === 0) return false;
    return Date.now() - this.outboundSentLast >= this.retxBackoffMs;
  }

  /**
   * Consumes the current window for retransmission: increments attempts,
   * doubles the backoff (exponential), returns the buffers to resend.
   *
   * @returns Packets to resend, or `null` if attempts are exhausted.
   * @sideeffect `retries++`, `retxBackoffMs *= 2`, `outboundSentLast = now`
   */
  public consumeRetransmission(): Buffer[] | null {
    if (this.outboundQueue.length === 0) return null;
    this.retries++;
    if (this.retries > this.maxRetries) {
      this.setError(ErrorCode.NotDefined, 'Max retries exceeded');
      return null;
    }
    this.retxBackoffMs = Math.min(this.retxBackoffMs * 2, 60_000);
    this.outboundSentLast = Date.now();
    this.lastActivity = Date.now();
    return this.outboundQueue.map((p) => p.buffer);
  }

  /**
   * Initializes the session for an RRQ (read from server to client).
   *
   * @param hasOptions `true` if the RRQ carried options (sends OACK before DATA).
   * @param fileSize   File size in bytes (for tsize + ETA).
   * @returns Initial packet(s) to send to the client (OACK or empty).
   * @sideeffect Resets `blockNum`, `fileOffset`, `bytesTransferred`, sets phase.
   */
  public initForRRQ(hasOptions: boolean, fileSize: number): Buffer[] {
    this.fileSize = fileSize;
    this.bytesTransferred = 0;
    this.blockNum = 0;
    this.lastAcked = 0;
    this.fileOffset = 0;
    this.readLeftover = Buffer.alloc(0);
    if (this.opts.tsize === 0) this.opts.tsize = fileSize;
    this.tsizeAtStart = fileSize;
    if (hasOptions) {
      this.phase = TransferPhase.SendOACK;
      return [encodeOACK(validatedToRaw(this.opts))];
    }
    this.phase = TransferPhase.Sending;
    return [];
  }

  /**
   * Initializes the session for a WRQ (write from client to server).
   *
   * P0 BUG FIXED (originally `tsizeAtStart` was not captured here):
   * now stores `this.opts.tsize` at the start, for metrics and validation.
   * RFC 2347 starts an optioned WRQ with DATA(1) after the OACK, so
   * `handleDATA` moves SendOACK into Receiving for that packet. handleACK(0)
   * remains accepted for compatibility with older clients.
   *
   * @param hasOptions `true` if WRQ carried options (responds OACK, else ACK(0)).
   * @returns Initial packet(s): OACK or ACK(0).
   * @sideeffect Resets `blockNum = 1`, sets phase, captures `tsizeAtStart`.
   */
  public initForWRQ(hasOptions: boolean): Buffer[] {
    this.bytesTransferred = 0;
    this.blockNum = 1;
    this.lastAcked = 0;
    this.tsizeAtStart = this.opts.tsize ?? null;
    if (hasOptions) {
      this.phase = TransferPhase.SendOACK;
      return [encodeOACK(validatedToRaw(this.opts))];
    }
    this.phase = TransferPhase.RecvInitialACK;
    return [encodeACK(0)];
  }

  /**
   * Processes an ACK received from the client.
   *
   * Advances the FSM, clears the retx window and signals if the caller should
   * produce more blocks (RRQ).
   *
   * @param blockNum Confirmed block number.
   * @returns Object with: `send` (packets to send now), `produceMore`
   *   (caller should call produceNextSendPackets), `done` (session finished).
   * @sideeffect Advances `phase`, updates `lastAcked`, clears retx queue.
   */
  public handleACK(blockNum: number): {
    send: Buffer[];
    produceMore: boolean;
    done: boolean;
  } {
    this.touch();
    this.retries = 0;
    if (this.phase === TransferPhase.SentLast) {
      this.clearOutboundUpToAck(blockNum);
    }
    if (this.phase === TransferPhase.Sending) {
      this.clearOutboundUpToAck(blockNum);
    }
    if (this.phase === TransferPhase.SentLast) {
      if (blockNum === this.blockNum || blockNum === 0) {
        this.phase = TransferPhase.Done;
        return { send: [], produceMore: false, done: true };
      }
    }
    if (this.phase === TransferPhase.SendOACK) {
      if (blockNum === 0) {
        this.clearOutboundUpToAck(blockNum);
        if (this.opcode === Opcode.RRQ) {
          this.phase = TransferPhase.Sending;
          return { send: [], produceMore: true, done: false };
        } else {
          this.phase = TransferPhase.Receiving;
          return { send: [], produceMore: false, done: false };
        }
      }
    }
    if (this.phase === TransferPhase.Sending) {
      if (blockNum === 0 && this.blockNum === 0) {
        return { send: [], produceMore: true, done: false };
      }
      // Wrap-safe form of `blockNum < this.lastAcked` — past block 65535 the
      // peer's ACKs restart at 1 while `lastAcked` is still 65535, and a
      // numeric compare discards every one of them: the window never advances,
      // no more DATA is produced, and the transfer stalls silently.
      if (!blockAtOrAfter(this.lastAcked, blockNum)) {
        return { send: [], produceMore: false, done: false };
      }
      this.lastAcked = blockNum;
      if (blockDistance(this.lastAcked, this.blockNum) < this.opts.windowsize) {
        return { send: [], produceMore: true, done: false };
      }
      return { send: [], produceMore: false, done: false };
    }
    return { send: [], produceMore: false, done: false };
  }

  /**
   * Processes a DATA packet received from the client (WRQ).
   *
   * Validates the block number, updates metrics and decides whether to send ACK
   * now (window full or last block) or only later.
   *
   * @param blockNum Wire block number.
   * @param data     Block payload (0..blksize).
   * @returns `send` (ACKs to send), `write` (buffer to write to disk or null), `done`.
   * @sideeffect Advances `phase` to Done if it is the last block.
   */
  public handleDATA(blockNum: number, data: Buffer): {
    send: Buffer[];
    write: Buffer | null;
    done: boolean;
  } {
    this.touch();
    this.retries = 0;
    if (this.phase === TransferPhase.RecvInitialACK) {
      this.phase = TransferPhase.Receiving;
    }
    if (
      this.phase === TransferPhase.SendOACK &&
      this.opcode === Opcode.WRQ &&
      blockNum === 1
    ) {
      this.phase = TransferPhase.Receiving;
      this.clearOutboundUpToAck(0);
    }
    if (this.phase !== TransferPhase.Receiving) {
      return { send: [], write: null, done: false };
    }
    // The block before the expected one, in the space this implementation
    // actually walks (65535 is followed by 1, not by 0 — see the wrap in the
    // advance below). Computing it as `this.blockNum - 1` yields 0 right after
    // a wrap, so a perfectly ordinary retransmission of block 65535 matches
    // nothing, falls through to the mismatch branch below, and kills a
    // transfer that was merely recovering from a lost ACK.
    const previousBlock = this.blockNum <= 1 ? 65535 : this.blockNum - 1;
    if (blockNum === previousBlock) {
      return { send: [encodeACK(previousBlock)], write: null, done: false };
    }
    if (blockNum !== this.blockNum) {
      this.setError(ErrorCode.IllegalOperation, `Block ${blockNum} expected ${this.blockNum}`);
      return { send: [this.makeErrorPacket()], write: null, done: true };
    }
    if (data.length > this.opts.blksize) {
      this.setError(ErrorCode.IllegalOperation, 'DATA exceeds blksize');
      return { send: [this.makeErrorPacket()], write: null, done: true };
    }
    const isLast = data.length < this.opts.blksize;
    const currentBlock = this.blockNum;
    this.bytesTransferred += data.length;
    this.updateMetrics(data.length, Date.now());
    if (!isLast) {
      this.blockNum = this.blockNum >= 65535 ? 1 : this.blockNum + 1;
    }
    // Same wrap hazard as the RRQ side: `currentBlock >= lastAcked + windowsize`
    // is never true again once the client's numbering restarts at 1, so the
    // server stops ACKing entirely and the upload dies on the client's retries.
    const shouldAck = isLast || blockDistance(this.lastAcked, currentBlock) >= this.opts.windowsize;
    if (shouldAck) {
      this.lastAcked = currentBlock;
      if (isLast) this.phase = TransferPhase.Done;
      const ack = [encodeACK(currentBlock)];
      this.clearOutboundUpToAck(currentBlock);
      return { send: ack, write: data, done: isLast };
    }
    return { send: [], write: data, done: false };
  }

  /**
   * Produces the next DATA packets to send (RRQ), filling the send window
   * up to the agreed `windowsize` limit.
   *
   * P0 BUG FIXED: this function now uses explicit `this.fileOffset`
   * instead of relying on the implicit FileHandle position; before, when
   * `readLeftover` existed, the next `read()` advanced the wrong offset
   * and data duplication/corruption occurred.
   *
   * @param abortAtEOF If `true`, marks the next chunk as last even if it
   *                   has exactly blksize (used at end of file).
   * @returns Array of DATA packets (0..windowsize).
   * @sideeffect Opens `fileHandle` lazy; advances `fileOffset`, `blockNum`,
   *             `bytesTransferred`, possibly `phase = SentLast`.
   */
  public async produceNextSendPackets(abortAtEOF = false): Promise<Buffer[]> {
    const out: Buffer[] = [];
    let reachedEOF = abortAtEOF;
    const startBytes = this.bytesTransferred;
    // Wrap-safe window bound. `this.blockNum < this.lastAcked + windowsize`
    // stops bounding anything once the sender wraps past 65535: the sum stays
    // up at ~65536 while `blockNum` restarts at 1, so the loop would run until
    // EOF and push the entire remaining file into memory in one call.
    while (
      this.phase === TransferPhase.Sending &&
      blockDistance(this.lastAcked, this.blockNum) < this.opts.windowsize
    ) {
      if (this.fileHandle === null) {
        this.fileHandle = await fsPromises.open(this.absFilePath, 'r');
      }
      const target = this.opts.blksize;
      const readBuffer = Buffer.alloc(target);
      let chunk: Buffer;
      if (this.readLeftover.length > 0) {
        chunk = this.readLeftover;
        this.readLeftover = Buffer.alloc(0);
      } else {
        const { bytesRead } = await this.fileHandle.read(readBuffer, 0, target, this.fileOffset);
        this.fileOffset += bytesRead;
        chunk = readBuffer.subarray(0, bytesRead);
      }
      if (chunk.length > target) {
        this.readLeftover = chunk.subarray(target);
        chunk = chunk.subarray(0, target);
      }
      this.blockNum = this.blockNum >= 65535 ? 1 : this.blockNum + 1;
      const isLastChunk = chunk.length < target || reachedEOF;
      if (isLastChunk) this.phase = TransferPhase.SentLast;
      this.bytesTransferred += chunk.length;
      out.push(encodeDATA(this.blockNum, chunk));
    }
    const delta = this.bytesTransferred - startBytes;
    if (delta > 0) this.updateMetrics(delta, Date.now());
    return out;
  }

  /**
   * Serializes the current error into a network ERROR packet.
   *
   * @returns Buffer ready for `socket.send`.
   */
  public makeErrorPacket(): Buffer {
    return encodeERROR(
      this.errorCode ?? ErrorCode.NotDefined,
      this.errorMessage ?? undefined,
    );
  }
}
