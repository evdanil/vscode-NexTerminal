/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * DHCP server adapter for the Nexus-tools framework.
 *
 * **CLEAN ARCHITECTURE (Ports & Adapters + KISS):**
 *   This file implements ONLY the `BaseNexusServer` interface — lifecycle
 *   start/stop, configuration getters, and formatted error handling at the
 *   service level (UI / Tree from the Nexus framework viewpoint).
 *
 *   **ALL** concrete implementation on top of the third-party library
 *   (`dhcp`@0.2.20) lives isolated in the `engine/` subfolder, in the
 *   {@link DhcpEngine} file. Here we know NOTHING about `dhcp.Server`, UDP
 *   sockets, port fallbacks or DHCPDISCOVER message parsing — we delegate
 *   everything.
 *
 * Clean architecture advantages:
 *   - Adapter = 0 clutter here (getters + start/stop + event bindings, easy
 *     to review in a minute).
 *   - Changing the underlying DHCP library tomorrow (e.g. to `isc-dhcp` or
 *     native dgram) = touch ONLY engine/ (Adapter intact).
 *   - Errors are formatted AT TWO LEVELS: engine (classifies raw with
 *     technical context) + adapter (human-friendly message for Nexus panel
 *     user).
 *
 * **Parity with TftpAdapter (August 2026):**
 *   - Engine recreated on each `start()` (TftpAdapter pattern) — clean state.
 *   - Public `boundPort` getter for UI to know actual port (fallback 1067
 *     vs 67).
 *   - `packetCounters` and `poolInfo` exposed for Dashboard / QuickStatus.
 *   - Lease events formatted for human logs (bound/renewed/released).
 *   - Engine `on('error')` → `setStatus(ERROR)` so UI reflects failures
 *     during RUNNING (e.g. unexpectedly closed socket).
 *   - EACCES fallback with P0 cleanup (removeAllListeners + stop of
 *     firstEngine).
 *
 * Lifecycle:
 *   ```
 *   start() → STARTING  → new DhcpEngine + engine.start(port 67)
 *                                              ──┬─ success → RUNNING
 *                                             └─ EACCES failure → fallback 1067
 *                                                                   ──┬─ success → RUNNING (with warning)
 *                                                               └──────────────────────────────────┴─ failure → ERROR
 *   stop()  → STOPPING  → engine.stop() → STOPPED
 *   ```
 *
 * @module
 */

import { ServerStatus } from '../core/ServerStatus';
import { BaseNexusServer } from '../core/BaseNexusServer';
import {
  DhcpEngine,
  DhcpEngineError,
  DEFAULT_PORT,
  FALLBACK_ALT_PORT,
  type DhcpEngineConfig,
  type DhcpVendorSpecificEntry,
  type DhcpLeaseInfo as EngineLeaseInfo,
  type DhcpPacketCounters,
  type DhcpPoolInfo,
} from './engine/DhcpEngine';
import type { ServerLogLevel } from '../core/NexusServer';

/** DHCP adapter configuration (1:1 with the engine). */
export interface DhcpAdapterConfig extends DhcpEngineConfig {}

export type { DhcpVendorSpecificEntry } from './engine/DhcpEngine';

/** Immutable snapshot of an active lease (re-export public API). */
export interface DhcpLeaseInfo extends EngineLeaseInfo {}

/**
 * DHCP server integrated into the Nexus-tools ecosystem.
 *
 * Encapsulates a {@link DhcpEngine} and implements the
 * {@link BaseNexusServer} lifecycle. Exposes runtime properties such as
 * {@link rangeStart}, {@link gateway}, {@link activeLeases},
 * {@link boundPort}, {@link packetCounters}, {@link poolInfo} for the
 * UI/API.
 *
 * @example
 * ```ts
 * const dhcp = new DhcpAdapter({ rangeStart: '10.0.0.10', rangeEnd: '10.0.0.200' });
 * await dhcp.start();
 * console.log('effective port:', dhcp.boundPort);
 * // later…
 * await dhcp.stop();
 * ```
 */
export class DhcpAdapter extends BaseNexusServer {
  /** Underlying engine (null when the service is stopped).  Recreated on each start(). */
  private engine: DhcpEngine | null = null;
  /** Effective configuration (with defaults applied in the constructor). */
  private config: DhcpAdapterConfig;

  public constructor(config: DhcpAdapterConfig = {}) {
    const port = DEFAULT_PORT;
    super('dhcp', 'DHCP Server', port);
    this.config = {
      rangeStart: config.rangeStart,
      rangeEnd: config.rangeEnd,
      subnet: config.subnet,
      gateway: config.gateway,
      dns: config.dns ? [...config.dns] : undefined,
      leaseTimeSec: config.leaseTimeSec,
      serverId: config.serverId,
      broadcast: config.broadcast,
      static: config.static ? { ...config.static } : undefined,
      bindAddress: config.bindAddress,
      leaseStorePath: config.leaseStorePath,
      bootFileName: config.bootFileName,
      nextServer: config.nextServer,
      tftpServerAddresses: config.tftpServerAddresses ? [...config.tftpServerAddresses] : undefined,
      vendorClassId: config.vendorClassId,
      vendorSpecificOptions: config.vendorSpecificOptions ? [...config.vendorSpecificOptions] : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Configuration getters (public API — 1:1 delegation to engine or config).
  // ---------------------------------------------------------------------------

  public get rangeStart(): string     { return this.engine?.rangeStart ?? (this.config.rangeStart ?? '192.168.2.10'); }
  public get rangeEnd(): string       { return this.engine?.rangeEnd ?? (this.config.rangeEnd ?? '192.168.2.199'); }
  public get subnet(): string       { return this.engine?.subnet ?? (this.config.subnet ?? '255.255.255.0'); }
  public get gateway(): string     { return this.engine?.gateway ?? (this.config.gateway ?? '192.168.2.1'); }
  public get dns(): readonly string[] { return this.engine?.dns ?? (this.config.dns ?? ['8.8.8.8', '8.8.4.4']); }
  public get leaseTimeSec(): number { return this.engine?.leaseTimeSec ?? (this.config.leaseTimeSec ?? 86400); }
  public get serverId(): string   { return this.engine?.serverId ?? (this.config.serverId ?? '192.168.2.1'); }
  public get broadcast(): string    { return this.engine?.broadcast ?? (this.config.broadcast ?? '192.168.2.255'); }
  public get bindAddress(): string  { return this.engine?.bindAddress ?? (this.config.bindAddress ?? '0.0.0.0'); }

  // ZTP boot options — no defaults: an unset boot server must stay unset
  // rather than point a device at an address nobody configured.
  public get bootFileName(): string | undefined { return this.config.bootFileName; }
  public get nextServer(): string | undefined { return this.config.nextServer; }
  public get tftpServerAddresses(): readonly string[] | undefined { return this.config.tftpServerAddresses; }
  public get vendorClassId(): string | undefined { return this.config.vendorClassId; }
  public get vendorSpecificOptions(): readonly DhcpVendorSpecificEntry[] | undefined {
    return this.config.vendorSpecificOptions;
  }

  /**
   * UDP port currently bound by the DHCP server.
   *
   * Differentiates IANA port 67 vs fallback 1067 for the UI
   * (Dashboard/QuickStatus).
   *
   * @returns Port number, or `null` if the engine is stopped / not bound.
   */
  public get boundPort(): number | null {
    return this.engine?.boundPort ?? null;
  }

  /**
   * Counters for packets processed since the last `start()`.
   * Copy by value — safe to pass through JSON and use in daemon IPC.
   */
  public get packetCounters(): DhcpPacketCounters {
    return this.engine?.packetCounters ?? DhcpAdapter._emptyCounters();
  }

  /**
   * Information about the dynamic pool (size, active count, % utilisation).
   */
  public get poolInfo(): DhcpPoolInfo {
    if (this.engine) return this.engine.poolInfo;
    // Fallback when stopped: pool size from configuration.
    const rangeStart = this.rangeStart;
    const rangeEnd = this.rangeEnd;
    const poolSize = computePoolSize(rangeStart, rangeEnd);
    const staticEntryCount = this.config.static ? Object.keys(this.config.static).length : 0;
    return {
      rangeStart, rangeEnd, poolSize,
      activeCount: 0, utilizationPct: 0.0, staticEntryCount,
    };
  }

  private static _emptyCounters(): DhcpPacketCounters {
    return {
      packetsReceived: 0, packetsSentEstimate: 0,
      discoverCount: 0, offerCount: 0, requestCount: 0,
      declineCount: 0, ackCount: 0, nakCount: 0,
      releaseCount: 0, informCount: 0,
    };
  }

  /** Snapshot of currently active leases ([] if the server is stopped). */
  public activeLeases(): readonly DhcpLeaseInfo[] {
    return this.engine?.activeLeases() ?? [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts the DHCP server with port fallback (67 → 1067) and creates
   * a new `DhcpEngine` instance (clean state per startup, like TFTP).
   */
  public override async start(): Promise<void> {
    if (this.status === ServerStatus.STARTING || this.status === ServerStatus.RUNNING) return;
    this.setStatus(ServerStatus.STARTING);
    this.log('info', `Starting DHCP service on UDP port ${this.port} · range ${this.rangeStart}→${this.rangeEnd} · gateway=${this.gateway} · lease=${this.leaseTimeSec}s.`);

    let firstEngine: DhcpEngine | null = null;

    const tryStart = async (port: number): Promise<DhcpEngine> => {
      const engine = new DhcpEngine(this.config, (level, msg) => this.log(level as ServerLogLevel, msg));
      if (port === this.port) {
        firstEngine = engine;
      }
      this.bindEngineLogging(engine);
      this.bindEngineEvents(engine);
      await engine.start(port);
      return engine;
    };

    try {
      const engine = await tryStart(this.port);
      this.engine = engine;
      if (engine.boundPort !== null && engine.boundPort !== this.port) {
        this.log('warn', `Bound to alternate UDP port ${engine.boundPort} instead of ${this.port}.`);
      }
      this.setStatus(ServerStatus.RUNNING);
      const actualPort = engine.boundPort ?? this.port;
      this.log('info', `DHCP service RUNNING on UDP port ${actualPort} · pool ${this.poolInfo.poolSize} addresses (${this.poolInfo.staticEntryCount} static).`);
    } catch (err) {
      // P0 cleanup: first engine removeAllListeners + stop anti-leak.
      const failedEngine = firstEngine as DhcpEngine | null;
      if (failedEngine) {
        try { failedEngine.removeAllListeners(); } catch { /* swallow */ }
        try { void failedEngine.stop().catch(() => {}); } catch { /* swallow */ }
        firstEngine = null;
      }
      const formatted = this.formatStartError(err);
      this.setStatus(ServerStatus.ERROR, formatted);
    }
  }

  /**
   * Stops the DHCP server, destroys the engine, closes sockets and sets
   * status to STOPPED. Idempotent.
   */
  public override async stop(): Promise<void> {
    if (this.status === ServerStatus.STOPPING || this.status === ServerStatus.STOPPED) return;
    this.setStatus(ServerStatus.STOPPING);
    this.log('info', 'Stopping DHCP service…');
    const engine = this.engine;
    this.engine = null;
    if (engine) {
      try {
        engine.removeAllListeners();
        await engine.stop();
      } catch (e) {
        this.log('warn', `cleanup issue (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.setStatus(ServerStatus.STOPPED);
    this.log('info', 'DHCP service stopped.');
  }

  // ---------------------------------------------------------------------------
  // Engine event bindings (parity TftpAdapter bindEngineLogging/Events).
  // ---------------------------------------------------------------------------

  /**
   * Binds `log` and `error` events from {@link DhcpEngine} to the Nexus
   * system.
   *
   * - `log` forwards to `this.log` (already has [dhcp] prefix by
   *   BaseNexusServer).
   * - `error` in RUNNING/STARTING marks adapter as ERROR so UI reflects it.
   */
  private bindEngineLogging(engine: DhcpEngine): void {
    engine.on('log', (level, message) => void this.log(level as ServerLogLevel, String(message).replace(/^\[dhcp\]\s*/, '')));
    engine.on('error', (err) => {
      if (this.status === ServerStatus.RUNNING || this.status === ServerStatus.STARTING) {
        this.setStatus(ServerStatus.ERROR, err.message);
      }
    });
  }

  /**
   * Binds lease events (bound/renewed/released) and DHCP messages to
   * formatted human logs (parity TFTP `transfer:start/progress/complete`).
   */
  private bindEngineEvents(engine: DhcpEngine): void {
    engine.on('listening', (addr, port) => {
      this.log('info', `UDP socket bound on ${addr}:${port}.`);
    });
    engine.on('close', () => {
      this.log('debug', 'DHCP socket closed.');
    });
    engine.on('lease:bound', (lease) => {
      const hostPart = lease.hostname ? ` hostname=${lease.hostname}` : '';
      this.log(
        'info',
        `LEASE BOUND MAC ${lease.mac} → IP ${lease.ip} (type=${lease.leaseType}, duration=${formatDuration(lease.leaseSec)}${hostPart}).`,
      );
      // The whole DORA exchange has completed by the time a lease binds, so
      // this is both the start of the client's connection and its outcome —
      // hence one event here and none on renewal, which would otherwise repeat
      // for the life of every device on the bench.
      this.emitConnection({
        phase: 'started',
        summary: `lease granted ${lease.ip} to ${lease.mac}${lease.hostname ? ` (${lease.hostname})` : ''}`,
      });
      this.emit('runtimeUpdate');
    });
    engine.on('lease:renewed', (lease) => {
      this.log(
        'info',
        `LEASE RENEWED MAC ${lease.mac} → IP ${lease.ip} (remaining=${formatDuration(lease.remainingSec)} of ${formatDuration(lease.leaseSec)}).`,
      );
      this.emit('runtimeUpdate');
    });
    engine.on('lease:released', (info) => {
      this.log('info', `LEASE RELEASED MAC ${info.mac}${info.ip ? ` (old IP ${info.ip})` : ''}.`);
      this.emit('runtimeUpdate', true);
    });
    // DHCPDECLINE is the only per-client failure this server can observe: the
    // engine sees received packets, so a DHCPNAK (which travels server →
    // client) never comes back through here, and a client that simply never
    // answers an OFFER produces no packet at all.
    engine.on('message:dhcp', (msgType, req) => {
      if (msgType !== 'DHCPDECLINE') return;
      const { mac, address } = describeDecline(req);
      this.log('warn', `LEASE DECLINED by MAC ${mac}${address ? ` (offered IP ${address})` : ''}.`);
      this.emitConnection({
        phase: 'failed',
        summary: `lease declined by ${mac}`,
        detail: address
          ? `Client refused ${address} — usually another host is already answering on that address.`
          : 'Client refused the offered address — usually another host is already answering on it.',
        code: 'DHCPDECLINE',
      });
      this.emit('runtimeUpdate', true);
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts any error (generic or `DhcpEngineError` with `kind`) into a
   * human-readable message, so the user understands exactly the cause of
   * the problem.
   *
   * Explicit solutions per each kind (like TftpAdapter).
   */
  private formatStartError(err: unknown): string {
    // Case A: typed engine error — we use kind for high-level formatted message.
    if (err instanceof DhcpEngineError) {
      switch (err.kind) {
        case 'EACCES_PRIVILEGES':
          return (
            `[DhcpAdapter] Failed to bind UDP port ${this.port}: Missing Administrator/root privileges. ` +
            `Solution 1: run VS Code as Administrator to use the IANA port ${this.port}. ` +
            `Solution 2: use alternate port ${FALLBACK_ALT_PORT} which works without privileges (already tried automatically). ` +
            `Technical detail: ${err.message}`
          );
        case 'EADDRINUSE_PORT_TAKEN':
          return (
            `[DhcpAdapter] Failed to bind UDP port ${this.port}: EADDRINUSE — already taken by another process. ` +
            `Resolution: first stop any other DHCP server on port ${this.port}. ` +
            `Technical detail: ${err.message}`
          );
        case 'FALLBACK_ALT_FAILED':
          return (
            `[DhcpAdapter] Both port ${DEFAULT_PORT} (official IANA) and fallback ${FALLBACK_ALT_PORT} failed. ` +
            `Check: 1) you have another DHCP server already running; 2) firewall is blocking both UDP ports; 3) privileges. ` +
            `Technical detail: ${err.message}${err.context ? ` · context: ${JSON.stringify(err.context)}` : ''}`
          );
        case 'UNKNOWN':
        default:
          return (
            `[DhcpAdapter] Unknown error starting DHCP on UDP port ${this.port}. ` +
            `Technical detail: ${err.message}${err.context ? ` · context: ${JSON.stringify(err.context)}` : ''}`
          );
      }
    }

    // Case B: unexpected generic error (e.g. TypeError from third-party library or syntax)
    // — we do not lose the original stack/message.
    const raw = err instanceof Error ? err.message : String(err);
    return (
      `[DhcpAdapter] Unexpected generic error starting DHCP on UDP port ${this.port}. ` +
      `Technical detail: ${raw}`
    );
  }
}

/** Option 50 (requested IP address) — the address a DHCPDECLINE is refusing. */
const DHCP_OPTION_REQUESTED_IP = 50;

/**
 * Pulls the client identity and the refused address out of a raw DHCPDECLINE.
 *
 * The packet arrives as the `dhcp` library's loosely-typed object, so every
 * field is treated as absent until proven to be a string — a decline whose
 * `chaddr` did not survive parsing is still worth reporting, just anonymously.
 *
 * @param req Raw request object as the library handed it over.
 * @returns The client MAC (or a placeholder) and the declined address if the
 *   packet carried one.
 */
function describeDecline(req: unknown): { mac: string; address?: string } {
  const packet = (req ?? {}) as { chaddr?: unknown; ciaddr?: unknown; options?: Record<number, unknown> };
  const mac = typeof packet.chaddr === 'string' && packet.chaddr.length > 0 ? packet.chaddr : '??:??:??:??:??:??';
  const requested = packet.options?.[DHCP_OPTION_REQUESTED_IP];
  const address =
    typeof requested === 'string' && requested.length > 0
      ? requested
      : typeof packet.ciaddr === 'string' && packet.ciaddr.length > 0 && packet.ciaddr !== '0.0.0.0'
        ? packet.ciaddr
        : undefined;
  return { mac, address };
}

/** Converts IPv4 → int to calculate pool size (copy from engine to avoid circular import). */
function ipToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p) >>> 0);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return 0;
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

/** Pool size (copy for when engine is null/stopped). */
function computePoolSize(rangeStart: string, rangeEnd: string): number {
  const a = ipToInt(rangeStart);
  const b = ipToInt(rangeEnd);
  if (a === 0 || b === 0 || b < a) return 0;
  return b - a + 1;
}

/**
 * Formats a number of seconds into human-readable duration: `0s`, `32s`,
 * `5m 12s`, `1h 30m 5s`.
 * (Parity with `formatDuration` from TftpAdapter — used for leases.)
 */
function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return '0s';
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}h ${m}m ${rs}s`;
  if (m > 0) return `${m}m ${rs}s`;
  return `${rs}s`;
}
