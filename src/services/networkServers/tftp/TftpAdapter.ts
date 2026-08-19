/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * Adapter for the TFTP engine ({@link TftpEngine}) to the Nexus-tools framework.
 *
 * Implements the {@link BaseNexusServer} interface so that TFTP appears as
 * a plug-and-play service in the Nexus dashboard: start/stop lifecycle,
 * integration with the logging system, port fallback (69 → 1069 when
 * elevated privileges are missing), and translation of engine events to
 * end-user friendly messages.
 *
 * Specific responsibilities of this adapter (DO NOT duplicate in the Engine):
 *   - Resolution of the default `root` directory (`~/Nexus/tftp-root`).
 *   - Port fallback: if 69 fails with EACCES, tries 1069 and logs a warning.
 *   - Human-readable speed formatting (B/s, KB/s, MB/s, GB/s).
 *   - Duration formatting (s, m:s, h:m:s).
 *   - Translation of engine events into structured log messages.
 *   - Lifecycle management of `TftpEngine` (creation, listeners, destroy).
 *
 * @module
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerStatus } from '../core/ServerStatus';
import { BaseNexusServer } from '../core/BaseNexusServer';
import {
  TftpEngine,
  type TftpEngineOptions,
  type TftpTransferInfo,
} from './engine/TftpEngine';
import type { ServerLogLevel } from '../core/NexusServer';
import { ReverseDnsCache, formatTftpClient } from './clientIdentity';
import { formatDuration } from '../formatDuration';

/** Official IANA TFTP port (requires root/Administrator on Windows/Linux). */
const DEFAULT_PORT = 69;
/** Alternative port when elevated privileges are not available. */
const FALLBACK_ALT_PORT = 1069;

/**
 * TFTP adapter configuration.
 * All fields are optional; see each accessor for defaults.
 */
export interface TftpAdapterConfig {
  readonly root?: string;
  readonly port?: number;
  readonly allowWrite?: boolean;
  /**
   * Local IPv4 address to bind the UDP socket to — i.e. which network
   * interface serves TFTP. Omitted means `0.0.0.0` (all interfaces), which is
   * the historical behaviour and stays the default.
   *
   * Useful when the machine is multi-homed and TFTP must be reachable only on,
   * say, the lab-facing NIC (`192.168.2.1`) rather than on the corporate VPN.
   */
  readonly interface?: string;
}

export type { TftpTransferInfo } from './engine/TftpEngine';

/**
 * A transfer as published outside the daemon: the engine's own view plus the
 * client's reverse-DNS identity, which only the adapter knows about.
 *
 * `client` is pre-rendered here on purpose — the host side must show the exact
 * same string as the logs and connection toasts, and formatting it in one place
 * is what guarantees that.
 */
export interface TftpTransferView extends TftpTransferInfo {
  /** Reverse-DNS name for `peer.address`, or `null` when unresolved. */
  readonly clientHostname: string | null;
  /** Display form: `"hostname (ip)"`, or just `"ip"` when unresolved. */
  readonly client: string;
}

/**
 * Resolves the default root directory: `${homedir}/Nexus/tftp-root`.
 * Creates the tree if it does not exist; on failure, falls back to `os.tmpdir()`.
 *
 * @returns Absolute path of the root directory.
 */
function resolveDefaultRoot(): string {
  const home = os.homedir();
  const candidate = path.join(home, 'Nexus', 'tftp-root');
  if (!fs.existsSync(candidate)) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch {
      return os.tmpdir();
    }
  }
  return candidate;
}

/**
 * TFTP server integrated in the Nexus-tools ecosystem.
 *
 * Encapsulates a {@link TftpEngine} and implements the {@link BaseNexusServer}
 * lifecycle. Exposes runtime properties such as {@link allowWrite},
 * {@link root}, and {@link activeTransfers} for the UI/API.
 *
 * @example
 * ```ts
 * const tftp = new TftpAdapter({ root: '/srv/tftp', port: 69 });
 * await tftp.start();
 * // later…
 * await tftp.stop();
 * ```
 */
export class TftpAdapter extends BaseNexusServer {
  /** Underlying engine (null when the service is stopped). */
  private engine: TftpEngine | null = null;
  /**
   * Reverse-DNS answers for client IPs, so a lab device shows up by name.
   * Lives on the adapter (not the engine) because it is presentation, not
   * protocol: the engine must never wait on a name server.
   */
  private readonly hostnames = new ReverseDnsCache();
  /** Effective configuration (with defaults applied in the constructor). */
  private config: TftpAdapterConfig;

  /**
   * Creates (but does not start) a TFTP adapter.
   *
   * @param config Optional configuration; uses reasonable defaults if omitted.
   */
  public constructor(config: TftpAdapterConfig = {}) {
    const port = config.port ?? DEFAULT_PORT;
    super('tftp', 'TFTP Server', port);
    this.config = {
      root: config.root,
      port,
      allowWrite: config.allowWrite ?? false,
      interface: config.interface,
    };
  }

  /**
   * Allow uploads via WRQ? (Default = `false` = read-only).
   */
  public get allowWrite(): boolean {
    return this.config.allowWrite ?? false;
  }

  /**
   * Root directory (chroot-like) where files are served/written.
   * Default: `~/Nexus/tftp-root` (automatically created).
   */
  public get root(): string {
    return this.config.root ?? resolveDefaultRoot();
  }

  /**
   * Local address the UDP socket binds to. `0.0.0.0` (all interfaces) unless
   * an explicit interface was configured.
   */
  public get bindAddress(): string {
    return this.config.interface ?? '0.0.0.0';
  }

  /**
   * UDP port currently bound by the TFTP server, or `null` when stopped.
   *
   * Distinguishes the IANA port 69 from the unprivileged fallback 1069 for the
   * UI — parity with {@link DhcpAdapter.boundPort}.
   */
  public get boundPort(): number | null {
    return this.engine?.boundPort ?? null;
  }

  /**
   * Snapshot of active transfers (by-value copy).
   * Useful for monitoring dashboards and APIs.
   *
   * @returns Always an array; empty if the engine is stopped.
   */
  public activeTransfers(): readonly TftpTransferView[] {
    return (this.engine?.activeTransfers() ?? []).map((info) => this.withClientIdentity(info));
  }

  /**
   * Aborts an in-flight transfer on operator request (sidebar "Cancel
   * Transfer" / command palette).
   *
   * @param transferId `${address}:${port}` id from {@link TftpTransferInfo.id}.
   * @returns `true` when a live transfer was aborted, `false` when no transfer
   *          with that id is running any more.
   * @sideeffect Delegates to {@link TftpEngine.cancelTransfer}: ERROR packet to
   *             the peer + `transfer:error`, which refreshes the UI.
   */
  public async cancelTransfer(transferId: string): Promise<boolean> {
    const engine = this.engine;
    if (!engine) return false;
    return engine.cancelTransfer(transferId);
  }

  /**
   * Decorates an engine transfer with the client's cached reverse-DNS identity.
   *
   * Read-only against the cache: the lookup itself is kicked off once per
   * transfer in {@link bindEngineEvents}, so a snapshot never blocks on DNS.
   *
   * @param info Engine-level transfer info.
   * @returns The same transfer plus `clientHostname` / `client`.
   */
  private withClientIdentity(info: TftpTransferInfo): TftpTransferView {
    const clientHostname = this.hostnames.getCached(info.peer.address);
    return { ...info, clientHostname, client: formatTftpClient(info.peer.address, clientHostname) };
  }

  /**
   * Renders a peer for operator-facing text (logs, connection toasts).
   *
   * @param address Peer IPv4.
   * @returns `"hostname (ip)"` when already resolved, otherwise `"ip"`.
   */
  private describeClient(address: string): string {
    return formatTftpClient(address, this.hostnames.getCached(address));
  }

  /**
   * Starts the TFTP server.
   *
   * Logic:
   *   1. Early-out if already STARTING or RUNNING.
   *   2. Changes status to STARTING.
   *   3. Attempts to bind on the configured port.
   *   4. If it fails with EACCES on port 69, falls back to 1069 and logs warning.
   *   5. If it fails due to EADDRINUSE or other error, sets status = ERROR.
   *
   * @sideeffect Creates {@link TftpEngine}, binds listeners, emits logs, changes status.
   */
  public override async start(): Promise<void> {
    if (this.status === ServerStatus.STARTING || this.status === ServerStatus.RUNNING) return;
    this.setStatus(ServerStatus.STARTING);

    const root = this.root;
    const allowWrite = this.allowWrite;
    const address = this.bindAddress;
    this.log(
      'info',
      `Starting on UDP ${address}:${this.port} · root=${root} · allowWrite=${allowWrite}`,
    );

    const engineOpts: TftpEngineOptions = {
      root,
      allowWrite,
      address,
    };

    let firstEngine: TftpEngine | null = null;

    const tryStart = async (port: number): Promise<TftpEngine> => {
      const engine = new TftpEngine({ ...engineOpts, port });
      if (port === this.port) {
        firstEngine = engine;
      }
      this.bindEngineLogging(engine);
      this.bindEngineEvents(engine);
      await engine.start();
      return engine;
    };

    try {
      const engine = await tryStart(this.port);
      this.engine = engine;
      if (engine.boundPort !== null && engine.boundPort !== this.port) {
        this.log('warn', `Bound to alternate port ${engine.boundPort} instead of ${this.port}.`);
      }
      this.setStatus(ServerStatus.RUNNING);
    } catch (err) {
      const failedEngine = firstEngine as TftpEngine | null;
      if (failedEngine) {
        try {
          failedEngine.removeAllListeners();
        } catch {
          // swallow
        }
        try {
          void failedEngine.stop().catch(() => {});
        } catch {
          // swallow
        }
        firstEngine = null;
      }
      const message = err instanceof Error ? err.message : String(err);
      const isEACCES = /EACCES|Access/i.test(message) || /permission/i.test(message);
      const isInUse = /EADDRINUSE|address already in use/i.test(message);
      if (isEACCES && this.port === DEFAULT_PORT) {
        this.log(
          'warn',
          `Port ${DEFAULT_PORT} requires elevated privileges. Retrying on port ${FALLBACK_ALT_PORT}...`,
        );
        try {
          const engine = await tryStart(FALLBACK_ALT_PORT);
          this.engine = engine;
          this.setStatus(ServerStatus.RUNNING);
          this.log(
            'info',
            `Running on alternate UDP port ${FALLBACK_ALT_PORT}. Re-run as Administrator to use port ${DEFAULT_PORT}.`,
          );
          return;
        } catch (altErr) {
          const altMsg = altErr instanceof Error ? altErr.message : String(altErr);
          this.setStatus(
            ServerStatus.ERROR,
            `Failed to start (port ${DEFAULT_PORT} denied, fallback ${FALLBACK_ALT_PORT} failed: ${altMsg})`,
          );
          return;
        }
      }
      if (isInUse) {
        this.setStatus(ServerStatus.ERROR, `UDP port ${this.port} is already in use.`);
        return;
      }
      this.setStatus(ServerStatus.ERROR, `Failed to start: ${message}`);
    }
  }

  /**
   * Stops the TFTP server, clears all sessions and closes open handles.
   *
   * Idempotent: multiple calls are safe.
   *
   * @sideeffect Stops the engine, removes listeners, closes socket, changes status to STOPPED.
   */
  public override async stop(): Promise<void> {
    if (this.status === ServerStatus.STOPPING || this.status === ServerStatus.STOPPED) return;
    this.setStatus(ServerStatus.STOPPING);
    this.log('info', 'Stopping...');
    const engine = this.engine;
    this.engine = null;
    // Names are only meaningful while the bench they describe is being served;
    // a restart should re-observe the network rather than trust stale PTRs.
    this.hostnames.clear();
    if (engine) {
      try {
        engine.removeAllListeners();
        await engine.stop();
      } catch (err) {
        this.log('warn', `cleanup issue: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.setStatus(ServerStatus.STOPPED);
    this.log('info', 'Service stopped.');
  }

  /**
   * Binds the engine's `log` and `error` events to the Nexus logging system.
   *
   * Removes the `[tftp]` prefix added by the engine (already implicit in the
   * service name) and on socket `error`, marks the adapter as ERROR.
   *
   * @param engine Engine instance to bind.
   * @sideeffect Registers listeners on `engine`.
   */
  private bindEngineLogging(engine: TftpEngine): void {
    engine.on(
      'log',
      (level: ServerLogLevel, message: string) => void this.log(level, String(message).replace(/^\[tftp\]\s*/, '')),
    );
    engine.on('error', (err) => {
      if (this.status === ServerStatus.RUNNING || this.status === ServerStatus.STARTING) {
        this.setStatus(ServerStatus.ERROR, err.message);
      }
    });
  }

  /**
   * Binds the engine's transfer events to human-readable formatted log
   * messages for the operator (start, progress %, speed, ETA, end).
   *
   * @param engine Engine instance to bind.
   * @sideeffect Registers listeners on `engine`.
   */
  private bindEngineEvents(engine: TftpEngine): void {
    engine.on('transfer:start', (info) => {
      this.resolveClientHostname(info.peer.address);
      const verb = info.direction === 'rrq' ? 'Download started' : 'Upload started';
      const opt = `blksize=${info.blockSize}, window=${info.windowSize}`;
      this.log('info', `${verb}: ${info.filename} (${info.peer.address}:${info.peer.port}) · ${opt}`);
      this.emitConnection({
        phase: 'started',
        summary: `${describeDirection(info.direction)} started from ${this.describeClient(info.peer.address)} · ${info.filename}`,
        id: info.id,
        resource: info.filename,
        client: this.describeClient(info.peer.address),
      });
      this.emit('runtimeUpdate');
    });
    engine.on('transfer:progress', (info) => {
      const pct =
        info.totalBytes !== null && info.totalBytes > 0
          ? `${Math.round((info.bytes / info.totalBytes) * 100)}%`
          : '';
      const speed = formatSpeed(info.speedBps);
      const eta = info.etaSec !== null ? `ETA ${formatDuration(Math.ceil(info.etaSec))}` : 'ETA —';
      this.log(
        'debug',
        `${info.direction.toUpperCase()} ${info.filename}: ${info.bytes}/${info.totalBytes ?? '?'} B ${pct} · ${speed} · ${eta}`,
      );
      this.emit('runtimeUpdate');
    });
    engine.on('transfer:complete', (info) => {
      const verb = info.direction === 'rrq' ? 'Downloaded' : 'Uploaded';
      const elapsed = Math.max(0, Math.round((Date.now() - info.startedAt) / 1000));
      const avgSpeed = elapsed > 0 ? (info.bytes / elapsed) : info.speedBps;
      const speed = formatSpeed(avgSpeed);
      const total = formatDuration(elapsed);
      this.log(
        'info',
        `${verb} ${info.filename}: ${info.bytes}/${info.totalBytes ?? info.bytes} B · ${speed} · took ${total}`,
      );
      this.emitConnection({
        phase: 'completed',
        summary: `${describeDirection(info.direction)} finished from ${this.describeClient(info.peer.address)} · ${info.filename} (${info.bytes} B in ${total})`,
        id: info.id,
        resource: info.filename,
        client: this.describeClient(info.peer.address),
      });
      this.emit('runtimeUpdate', true);
    });
    engine.on('transfer:error', (info, err) => {
      this.log('warn', `${info.direction.toUpperCase()} failed ${info.filename}: ${err.message}`);
      this.emitConnection({
        phase: 'failed',
        summary: `${describeDirection(info.direction)} failed from ${this.describeClient(info.peer.address)} · ${info.filename}`,
        id: info.id,
        resource: info.filename,
        client: this.describeClient(info.peer.address),
        detail: err.message,
        // `ProtocolError` and friends carry their classification in `name`;
        // a plain `Error` would only contribute the useless literal "Error".
        code: err.name && err.name !== 'Error' ? err.name : undefined,
      });
      this.emit('runtimeUpdate', true);
    });
  }

  /**
   * Fire-and-forget reverse lookup for a client that just started a transfer.
   *
   * Nothing waits on this. When a name does come back, a plain `runtimeUpdate`
   * is emitted so the already-rendered row picks the hostname up on the next
   * snapshot — a second of "192.168.1.50" before "boot-sw01 (192.168.1.50)" is
   * an acceptable trade for never blocking a transfer on DNS.
   *
   * @param address Peer IPv4.
   * @sideeffect May emit `runtimeUpdate` once the lookup resolves.
   */
  private resolveClientHostname(address: string): void {
    if (this.hostnames.getCached(address) !== null) return;
    void this.hostnames.resolve(address).then((hostname) => {
      if (hostname === null || this.engine === null) return;
      this.log('debug', `client ${address} resolves to ${hostname}`);
      this.emit('runtimeUpdate');
    });
  }
}

/**
 * Names a transfer direction from the *client's* point of view, which is the
 * one an operator watching a device boot is thinking in: `rrq` means the client
 * is pulling a file off this server, `wrq` that it is pushing one back.
 *
 * @param direction Wire-level request type.
 * @returns `"Download"` or `"Upload"`.
 */
function describeDirection(direction: 'rrq' | 'wrq'): string {
  return direction === 'rrq' ? 'Download' : 'Upload';
}

/**
 * Formats bytes/second into human-readable units (B/s, KB/s, MB/s, GB/s).
 *
 * @param bytesPerSec Speed in bytes per second.
 * @returns Formatted string, e.g. `"12.34 MB/s"` or `"0 B/s"`.
 */
function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let v = bytesPerSec;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
