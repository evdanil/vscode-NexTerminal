/** @author kanekitakitos */
/**
 * @author kanekitakitos
 *
 * Low-level engine that encapsulates the concrete `dhcp.Server` instance
 * (npm: `dhcp@0.2.20`). **This is the only layer of the DHCP module that
 * knows about the existence of the third-party library.**
 *
 * **Why separate Engine from Adapter (Ports & Adapters clean architecture +
 * KISS):**
 * - Keeps `DhcpAdapter.ts` (PORT) clean — only implements the
 *   `BaseNexusServer` lifecycle (start/stop/status) and delegates all heavy
 *   logic to the engine.
 * - All specific implementation (event mappings, port fallback, lease
 *   snapshots, ServerConfig construction, well-formatted error handling)
 *   lives CONCENTRATED in a single file.
 * - Facilitates unit testing of the engine without needing to instantiate
 *   VS Code or `BaseNexusServer` (if we want that in the future).
 *
 * **Module organisation (August 2026):**
 *   - `dhcpConstants.ts` — ports, defaults, message names.
 *   - `dhcpNetworkUtils.ts` — pure IPv4 maths (pool size, broadcast).
 *   - `dhcpErrors.ts` — bind error classification.
 *   - `dhcpLeaseUtils.ts` — `DhcpLeaseInfo` construction/enrichment.
 *   - `DhcpEngine.ts` (this file) — only socket lifecycle and runtime
 *     state (counters, lease diffs, events).
 *
 * **Parity with TftpEngine (August 2026):**
 *   - Extends `EventEmitter` and emits typed events (`DhcpEngineEvents`).
 *   - Packet counters (discover/offer/request/ack/nak/release/etc.).
 *   - Pool info: `poolSize`, `activeLeaseCount`, `utilizationPct`.
 *   - Leases enriched with `expiresAt`, `remainingSec`, `hostname`,
 *     `leaseType`.
 *   - Lease lifecycle events: `lease:bound`, `lease:renewed`,
 *     `lease:released`.
 *
 * **Friendly error handling:**
 *   All bind failures/error classifications return messages that explain
 *   exactly WHAT the problem is, WHERE it occurred (port 67 vs 1067), and
 *   HOW the user can resolve it (e.g. "run as Administrator" instead of
 *   the raw OS EACCES).
 *
 * @module
 */

import * as dhcp from 'dhcp';
import type { ServerConfig, LeaseState, Server, DhcpConfigValue } from 'dhcp';
import { EventEmitter } from 'node:events';

import { DEFAULT_PORT, FALLBACK_ALT_PORT, DEFAULTS, DHCP_MESSAGE_NAMES } from './dhcpConstants';
import { computePoolSize, computeBroadcastAddress, isIpInPool } from './dhcpNetworkUtils';
import { DhcpEngineError, classifyNodeError } from './dhcpErrors';
import { buildLeaseInfo, toLibraryMacKey, type DhcpLeaseInfo } from './dhcpLeaseUtils';
import {
  createDhcpLeaseStore,
  loadLeases,
  reconcilePersistedLeases,
  toReservedLeaseState,
  toRestoredLeaseState,
  RESERVED_LEASE_STATE,
  type DhcpLeaseStore,
} from './dhcpLeasePersistence';
import {
  DHCP_OPTION_CISCO_TFTP_SERVERS,
  DHCP_OPTION_VENDOR_CLASS_ID,
  encodeVendorSpecificInfo,
  matchesVendorClass,
  type DhcpVendorSpecificEntry,
} from './dhcpBootOptions';

export { DEFAULT_PORT, FALLBACK_ALT_PORT } from './dhcpConstants';
export { DhcpEngineError } from './dhcpErrors';
export type { DhcpErrorKind } from './dhcpErrors';
export type { DhcpLeaseInfo, DhcpLeaseType } from './dhcpLeaseUtils';
export type { DhcpVendorSpecificEntry } from './dhcpBootOptions';

/** `dhcp` config key the library maps to option 66. */
const LIB_KEY_TFTP_SERVER_NAME = 'tftpServer';
/** `dhcp` config key the library maps to option 67. */
const LIB_KEY_BOOTFILE_NAME = 'bootFile';
/** `dhcp` config key the library maps to option 43. */
const LIB_KEY_VENDOR_SPECIFIC = 'vendor';
/** Config key registered below for the Cisco option 150. */
const LIB_KEY_CISCO_TFTP_SERVERS = 'tftpServerAddresses';
/** Key option 60 appears under in the request snapshot handed to a config function. */
const VENDOR_CLASS_REQUEST_ATTR = 'vendorClassId';

let ciscoTftpOptionRegistered = false;

/**
 * Teaches the `dhcp` library about option 150, which it does not ship.
 *
 * Registration is unconditional rather than "only when configured": the
 * library emits an `error` event for every option a client asks for that it
 * does not know (`_getOptions` → `'Unknown option ' + req`), and Cisco phones
 * and switches routinely put 150 in their parameter request list. Registering
 * it turns that error into a normal "no value configured, skip" path.
 *
 * `Options.addOption` mutates the same `opts` table `seqbuffer.js` holds a
 * reference to, so one call covers both the config lookup and the encoder.
 */
function ensureCiscoTftpOptionRegistered(): void {
  if (ciscoTftpOptionRegistered) return;
  dhcp.addOption(DHCP_OPTION_CISCO_TFTP_SERVERS, {
    config: LIB_KEY_CISCO_TFTP_SERVERS,
    type: 'IPs',
    name: 'TFTP Server Address (Cisco)',
  });
  ciscoTftpOptionRegistered = true;
}

/** Log levels accepted by the logging callback injected in the constructor. */
export type DhcpLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'trace';

/** Logging callback injected by the Adapter (BaseNexusServer.log). */
export type DhcpLogger = (level: DhcpLogLevel, message: string) => void;

/** Effective DHCP engine configuration. */
export interface DhcpEngineConfig {
  readonly rangeStart?: string;
  readonly rangeEnd?: string;
  readonly subnet?: string;
  readonly gateway?: string;
  readonly dns?: readonly string[];
  readonly leaseTimeSec?: number;
  readonly serverId?: string;
  readonly broadcast?: string;
  readonly static?: Readonly<Record<string, string>>;
  /**
   * Local IPv4 address to bind the DHCP UDP socket to — i.e. which network
   * interface serves DHCP. Omitted means `0.0.0.0` (all interfaces), the
   * historical behaviour and still the default.
   *
   * On a multi-homed host this is what stops a lab DHCP server from answering
   * DISCOVERs arriving on the corporate LAN.
   */
  readonly bindAddress?: string;
  /**
   * Absolute path of the JSON file the active lease table is mirrored to, so
   * leases survive a daemon restart instead of letting a still-held address be
   * handed to a second device.
   *
   * Resolved by the extension host and passed in: nothing under `engine/` may
   * import `vscode`, and this process has no other way to learn where the
   * extension's storage lives. Omitted disables persistence entirely.
   */
  readonly leaseStorePath?: string;

  // --- Zero-Touch Provisioning boot options ---------------------------------

  /** Option 67 — bootfile a PXE/ZTP client should fetch (e.g. `ios-image.bin`). */
  readonly bootFileName?: string;
  /**
   * Option 66 — the TFTP server clients fetch {@link bootFileName} from,
   * as a name or a dotted-quad address.
   *
   * **Not** the BOOTP `siaddr` header field: `dhcp@0.2.20` hardcodes `siaddr`
   * to the server identifier in `sendOffer`/`sendAck` (dhcp.js:383, :426) with
   * no configuration hook, so option 66 is the only mechanism available. In
   * the common case where this host is also the TFTP server the two agree
   * anyway.
   */
  readonly nextServer?: string;
  /** Option 150 — Cisco's TFTP server address list; IPv4 addresses only. */
  readonly tftpServerAddresses?: readonly string[];
  /**
   * Option 60 of the *incoming* request to match before the boot options
   * above are served. Empty means serve them to every client.
   */
  readonly vendorClassId?: string;
  /** Option 43 — vendor-specific sub-options, TLV-encoded onto the wire. */
  readonly vendorSpecificOptions?: readonly DhcpVendorSpecificEntry[];
}

/** Counters for DHCP messages processed since startup.
 *  IMMUTABLE version of the public API (exported). */
export interface DhcpPacketCounters {
  /** Total UDP packets received on the DHCP socket. */
  readonly packetsReceived: number;
  /** Total UDP packets sent by the server (APPROX — `dhcp` library does not expose explicit sending). */
  readonly packetsSentEstimate: number;
  readonly discoverCount: number;
  readonly offerCount: number;
  readonly requestCount: number;
  readonly declineCount: number;
  readonly ackCount: number;
  readonly nakCount: number;
  readonly releaseCount: number;
  readonly informCount: number;
}

/** INTERNAL MUTABLE version of `DhcpPacketCounters` — used only as private
 *  state inside the engine. Not exported (public API exposes readonly). */
type DhcpCountersState = {
  packetsReceived: number;
  packetsSentEstimate: number;
  discoverCount: number;
  offerCount: number;
  requestCount: number;
  declineCount: number;
  ackCount: number;
  nakCount: number;
  releaseCount: number;
  informCount: number;
};

/** Information about the configured address pool. */
export interface DhcpPoolInfo {
  /** First IP of the dynamic range (e.g. `192.168.2.10`). */
  readonly rangeStart: string;
  /** Last IP of the dynamic range (e.g. `192.168.2.199`). */
  readonly rangeEnd: string;
  /** Theoretical pool size (rangeEnd - rangeStart + 1, if contiguous subnet). */
  readonly poolSize: number;
  /** Number of currently active leases. */
  readonly activeCount: number;
  /** Occupancy percentage (0.0 … 100.0). `poolSize`=0 returns 0. */
  readonly utilizationPct: number;
  /** Number of static entries (MAC → IP mapping) configured. */
  readonly staticEntryCount: number;
}

/** Result of a successful `start()` (returns the actual bound port). */
export interface DhcpStartResult {
  readonly boundPort: number;
}

/** Strong types for events emitted by {@link DhcpEngine}. */
export interface DhcpEngineEvents {
  /** UDP socket successfully bound — arguments: (address, boundPort). */
  listening: [address: string, boundPort: number];
  /** Socket closed / engine stopped. */
  close: [];
  /** Fatal error emitted by the `dhcp.Server` library during RUNNING. */
  error: [err: Error];
  /** Varied-level log emitted by the engine. */
  log: [level: DhcpLogLevel, message: string];
  /** Any DHCP message received: arguments (msgTypeName, rawReq). */
  'message:dhcp': [msgType: string, req: unknown];
  /** New lease assigned to a client (first bind). Lease data. */
  'lease:bound': [lease: DhcpLeaseInfo];
  /** Existing lease renewed by the client. */
  'lease:renewed': [lease: DhcpLeaseInfo];
  /** Lease explicitly released by the client (DHCPRELEASE) or expired/withdrawn. */
  'lease:released': [info: { mac: string; ip: string | null }];
}

/**
 * Closes + cleans up listeners from a failed `dhcp.Server` instance.
 *
 * **Why separate wrapper (auditing P0 fix):**
 *   The EACCES fallback first tries 67 with an instance that is then
 *   discarded; without `removeAllListeners()` + `close()`, listeners and
 *   sockets would leak until GC.
 */
function cleanupFailedServer(server: Server | null): void {
  if (!server) return;
  try {
    server.removeAllListeners();
  } catch {
    // swallow
  }
  try {
    server.close();
  } catch {
    // swallow
  }
}

/**
 * DHCP engine: concrete implementation on top of the `dhcp` library.
 *
 * Extends `EventEmitter` for parity with `TftpEngine`, emitting lifecycle
 * events and runtime metrics that `DhcpAdapter` consumes for human logs
 * and UI/Dashboard integration.
 *
 * Responsibilities (EVERYTHING that is not BaseNexusServer lifecycle):
 *   - Defaults and `ServerConfig` build.
 *   - `dhcp.Server` lifecycle management (create/listen/close).
 *   - Port fallback 67 → 1067 when EACCES.
 *   - Packet counters and pool statistics.
 *   - Detection of changes in `_state` for lease events.
 *   - Enriched snapshot of `activeLeases()` (remainingSec, expiresAt, …).
 *   - Friendly error classification (`DhcpEngineError` with `kind`).
 */
export class DhcpEngine extends EventEmitter {
  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  /** Running DHCP server or `null` if stopped. */
  private _server: Server | null = null;
  /** Currently bound port (or `null` if stopped). */
  private _boundPort: number | null = null;
  /** Effective configuration (with defaults applied in the constructor). */
  private readonly _cfg: DhcpEngineConfig;
  /** Logger callback (injected by the Adapter). */
  private readonly _log: DhcpLogger;

  // Runtime statistics (reset on each `stop()`).
  private _counters: DhcpCountersState = DhcpEngine._emptyCounters();
  /** Previous snapshot of `_state`, used to detect new/removed leases and emit `lease:*`. */
  private _prevLeaseKeys = new Set<string>();
  /** Previous snapshot of `bindTime`, used to detect renewals. */
  private _prevBindTimes = new Map<string, number>();
  /** Debounced writer mirroring the lease table to disk, or `null` when not configured. */
  private _leaseStore: DhcpLeaseStore | null = null;

  // EventEmitter typing (strongly typed):
  public override on<E extends keyof DhcpEngineEvents>(
    event: E,
    listener: (...args: DhcpEngineEvents[E]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  public override once<E extends keyof DhcpEngineEvents>(
    event: E,
    listener: (...args: DhcpEngineEvents[E]) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }
  public override off<E extends keyof DhcpEngineEvents>(
    event: E,
    listener: (...args: DhcpEngineEvents[E]) => void,
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  // ---------------------------------------------------------------------------
  // Construction and static utilities
  // ---------------------------------------------------------------------------

  public constructor(cfg: DhcpEngineConfig = {}, logger: DhcpLogger) {
    super();
    this._cfg = {
      rangeStart: cfg.rangeStart,
      rangeEnd: cfg.rangeEnd,
      subnet: cfg.subnet,
      gateway: cfg.gateway,
      dns: cfg.dns ? [...cfg.dns] : undefined,
      leaseTimeSec: cfg.leaseTimeSec,
      serverId: cfg.serverId,
      broadcast: cfg.broadcast,
      static: cfg.static ? { ...cfg.static } : undefined,
      bindAddress: cfg.bindAddress,
      leaseStorePath: cfg.leaseStorePath,
      bootFileName: cfg.bootFileName,
      nextServer: cfg.nextServer,
      tftpServerAddresses: cfg.tftpServerAddresses ? [...cfg.tftpServerAddresses] : undefined,
      vendorClassId: cfg.vendorClassId,
      vendorSpecificOptions: cfg.vendorSpecificOptions ? [...cfg.vendorSpecificOptions] : undefined,
    };
    this._log = logger;
    ensureCiscoTftpOptionRegistered();
  }

  private static _emptyCounters(): DhcpCountersState {
    return {
      packetsReceived: 0,
      packetsSentEstimate: 0,
      discoverCount: 0,
      offerCount: 0,
      requestCount: 0,
      declineCount: 0,
      ackCount: 0,
      nakCount: 0,
      releaseCount: 0,
      informCount: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Public getters (EXACT same API as old Adapter — DO NOT BREAK tests/UI)
  // ---------------------------------------------------------------------------

  public get rangeStart(): string { return this._cfg.rangeStart ?? DEFAULTS.rangeStart; }
  public get rangeEnd(): string   { return this._cfg.rangeEnd   ?? DEFAULTS.rangeEnd;   }
  public get subnet(): string     { return this._cfg.subnet     ?? DEFAULTS.subnet;     }
  public get gateway(): string    { return this._cfg.gateway    ?? DEFAULTS.gateway;    }
  public get dns(): readonly string[] { return this._cfg.dns ?? DEFAULTS.dns; }
  public get leaseTimeSec(): number { return this._cfg.leaseTimeSec ?? DEFAULTS.leaseTimeSec; }
  public get serverId(): string   { return this._cfg.serverId   ?? DEFAULTS.serverId;   }
  /** Local address the UDP socket binds to (`0.0.0.0` = every interface). */
  public get bindAddress(): string { return this._cfg.bindAddress ?? '0.0.0.0'; }
  /** Option 67 — bootfile name, or `undefined` when ZTP boot info is not served. */
  public get bootFileName(): string | undefined { return this._cfg.bootFileName; }
  /** Option 66 — TFTP server name/address. */
  public get nextServer(): string | undefined { return this._cfg.nextServer; }
  /** Option 150 — Cisco TFTP server address list. */
  public get tftpServerAddresses(): readonly string[] | undefined { return this._cfg.tftpServerAddresses; }
  /** Option 60 the client must send for the boot options to apply. */
  public get vendorClassId(): string | undefined { return this._cfg.vendorClassId; }
  /** Option 43 sub-options, before TLV encoding. */
  public get vendorSpecificOptions(): readonly DhcpVendorSpecificEntry[] | undefined {
    return this._cfg.vendorSpecificOptions;
  }
  /**
   * Broadcast address. If not explicitly configured, it is **calculated**
   * from `gateway` + `subnet` (instead of always using the fixed factory
   * default — see `computeBroadcastAddress` for the bug this fixes).
   */
  public get broadcast(): string {
    return this._cfg.broadcast ?? computeBroadcastAddress(this.gateway, this.subnet);
  }
  /** Currently bound port (or `null` if stopped). */
  public get boundPort(): number | null { return this._boundPort; }
  /** Is the server running? */
  public get isRunning(): boolean { return this._server !== null && this._boundPort !== null; }

  /** Copy of packet counters since the last `start()`. */
  public get packetCounters(): DhcpPacketCounters {
    return { ...this._counters };
  }

  /** Dynamic pool info and current utilisation. */
  public get poolInfo(): DhcpPoolInfo {
    const poolSize = computePoolSize(this.rangeStart, this.rangeEnd);
    const activeCount = this.activeLeases().length;
    const utilizationPct = poolSize > 0 ? Math.min(100.0, (activeCount / poolSize) * 100.0) : 0;
    const staticEntryCount = this._cfg.static ? Object.keys(this._cfg.static).length : 0;
    return {
      rangeStart: this.rangeStart,
      rangeEnd: this.rangeEnd,
      poolSize,
      activeCount,
      utilizationPct,
      staticEntryCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Creates a `dhcp.Server`, attempts to bind on `preferredPort`, on EACCES
   * falls back to `FALLBACK_ALT_PORT`, and returns the actually bound port.
   *
   * @throws {DhcpEngineError} With discriminated `kind` and explanatory
   *   message.
   */
  public async start(preferredPort: number): Promise<DhcpStartResult> {
    const cfg = this.buildServerConfig();

    // Reset counters and diff state on each startup.
    this._counters = DhcpEngine._emptyCounters();
    this._prevLeaseKeys = new Set<string>();
    this._prevBindTimes = new Map<string, number>();

    this._log(
      'info',
      `Engine: attempting to bind on UDP port ${preferredPort} · range ${this.rangeStart}→${this.rangeEnd} · subnet=${this.subnet} · gateway=${this.gateway} · dns=[${this.dns.join(', ')}] · lease=${this.leaseTimeSec}s`,
    );

    let firstServer: Server | null = null;

    // First attempt: preferred port (e.g. 67).
    try {
      const server = await this.tryListen(preferredPort, cfg, (s) => {
        firstServer = s;
      });
      this._server = server;
      this._boundPort = preferredPort;
      this.bindLeasePersistence(server);
      this.seedStaticReservations(server);
      this.emit('listening', this.bindAddress, preferredPort);
      this.emit('log', 'info', `listening on ${this.bindAddress}:${preferredPort}`);
      return { boundPort: preferredPort };
    } catch (err) {
      cleanupFailedServer(firstServer);
      firstServer = null;

      const classified = classifyNodeError(err, preferredPort, false);

      // If it failed with EACCES AND it was the official port 67 → try fallback 1067.
      if (classified.kind === 'EACCES_PRIVILEGES' && preferredPort === DEFAULT_PORT) {
        this._log(
          'warn',
          `Engine: port ${DEFAULT_PORT} requires Admin. Trying fallback ${FALLBACK_ALT_PORT}.`,
        );
        try {
          const server = await this.tryListen(FALLBACK_ALT_PORT, cfg, () => void 0);
          this._server = server;
          this._boundPort = FALLBACK_ALT_PORT;
          this.bindLeasePersistence(server);
          this.seedStaticReservations(server);
          this.emit('listening', this.bindAddress, FALLBACK_ALT_PORT);
          this.emit('log', 'info', `listening on ${this.bindAddress}:${FALLBACK_ALT_PORT} (alternate)`);
          this._log(
            'info',
            `Engine: successfully bound on alternate port ${FALLBACK_ALT_PORT}.`,
          );
          return { boundPort: FALLBACK_ALT_PORT };
        } catch (altErr) {
          const alt = classifyNodeError(altErr, FALLBACK_ALT_PORT, true);
          throw new DhcpEngineError(alt.message, alt.kind, {
            preferredPort,
            altPort: FALLBACK_ALT_PORT,
            originalErr: classified.message,
          });
        }
      }

      // Any other case (EADDRINUSE on 67, or UNKNOWN): propagate.
      throw new DhcpEngineError(classified.message, classified.kind, {
        preferredPort,
      });
    }
  }

  /**
   * Closes the `dhcp.Server`, removes listeners and closes the socket.
   * Idempotent — multiple calls are safe.
   */
  public async stop(): Promise<void> {
    // Before `_server` goes away: the pending snapshot is read off it, and an
    // orderly shutdown is precisely when the last few seconds of lease changes
    // are worth keeping.
    await this.flushLeaseStore();
    const server = this._server;
    this._server = null;
    this._boundPort = null;
    if (!server) return;
    try {
      server.removeAllListeners();
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this.emit('close');
    } catch (err) {
      this._log(
        'warn',
        `Engine: cleanup after stop had a warning (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Reset counters at the end (we keep last state available until next start
    // so UI does not see empty in the middle of stop; but not critical).
  }

  // ---------------------------------------------------------------------------
  // Lease snapshot + statistics
  // ---------------------------------------------------------------------------

  /**
   * Snapshot (copy by value) of currently active leases.
   * Returns `[]` if the server is not RUNNING.
   *
   * Delegates construction of each entry to `buildLeaseInfo`
   * (dhcpLeaseUtils), eliminating the duplication that previously existed
   * with `_diffLeases()`.
   */
  public activeLeases(): readonly DhcpLeaseInfo[] {
    if (!this._server) return [];
    const state = this._server._state as Record<string, LeaseState>;
    const staticMap = this._cfg.static ?? {};
    const now = Date.now();
    const result: DhcpLeaseInfo[] = [];
    for (const mac of Object.keys(state)) {
      // A reservation placeholder is not a lease: no device has bound it. It is
      // excluded here so it cannot inflate pool utilisation, appear in the
      // sidebar's Active Leases, or be written to the persisted lease file —
      // that last one also keeps seeding idempotent, since a persisted
      // reservation would come back as a real lease on the next start.
      if (state[mac]?.state === RESERVED_LEASE_STATE) continue;
      const info = buildLeaseInfo(mac, state[mac], staticMap, now, this.leaseTimeSec);
      if (info) result.push(info);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Lease persistence
  // ---------------------------------------------------------------------------

  /**
   * Restores the persisted lease table into `server` and starts mirroring
   * further changes back to disk. No-op when no store path is configured.
   */
  private bindLeasePersistence(server: Server): void {
    const filePath = this._cfg.leaseStorePath;
    if (!filePath) return;
    this.restorePersistedLeases(server, filePath);
    this._leaseStore = createDhcpLeaseStore(filePath, () => this.activeLeases(), {
      onError: (error) => {
        this._log(
          'warn',
          `Engine: could not persist the lease table to ${filePath} — leases will not survive a restart: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  /**
   * Seeds `_state` with the leases still valid under the current
   * configuration, and pre-loads the diff baseline with them.
   *
   * Without that baseline the first `_diffLeases()` would see every restored
   * MAC as new and announce a `lease:bound` for a device that has not spoken
   * to us since the restart.
   */
  private restorePersistedLeases(server: Server, filePath: string): void {
    const stored = loadLeases(filePath);
    if (stored.length === 0) return;

    const { restored, dropped } = reconcilePersistedLeases(stored, {
      staticMap: this._cfg.static ?? {},
      rangeStart: this.rangeStart,
      rangeEnd: this.rangeEnd,
      now: Date.now(),
    });

    for (const lease of restored) {
      server._state[lease.mac] = toRestoredLeaseState(lease, this.serverId);
    }
    this._prevLeaseKeys = new Set(restored.map((lease) => lease.mac));
    this._prevBindTimes = new Map(restored.map((lease) => [lease.mac, lease.boundAt]));

    this._log(
      'info',
      `Engine: restored ${restored.length} lease(s) from ${filePath}${dropped.length > 0 ? ` · dropped ${dropped.length}: ${dropped.map((d) => `${d.lease.mac}→${d.lease.ip} (${d.reason})`).join(', ')}` : ''}`,
    );
  }

  /**
   * Holds every configured static address that falls inside the dynamic pool
   * out of that pool, before the socket has processed a single packet.
   *
   * The problem this solves: `_selectAddress` (dhcp.js:290-310) walks the range
   * and takes the first address not already present in `_state`. A reservation
   * lives in `config.static`, which that scan never consults — so until the
   * reserved device happens to boot, its address is just another free slot, and
   * whichever client DISCOVERs first walks away with it. The reserved device
   * then arrives to find its own address already in use.
   *
   * Reservations *outside* the range are skipped: they never compete with
   * dynamic allocation, and seeding them would only add rows to a table the
   * library scans on every packet.
   *
   * Ordering matters — this runs after {@link bindLeasePersistence}, so a
   * restored lease is already in `_state` and can be inspected here. A static
   * reservation outranks a persisted dynamic lease on the same address, which
   * is why a conflicting entry is overwritten rather than skipped.
   * ({@link reconcilePersistedLeases} normally drops those on the way in; this
   * is the backstop for when persistence is switched off entirely.)
   *
   * Idempotent by construction: each `start()` builds a fresh `dhcp.Server`
   * with an empty `_state`, and seeding derives purely from current
   * configuration. A reservation whose entry already carries the right address
   * is left untouched, so a restarted device keeps the `bindTime` history a
   * restore gave it.
   *
   * @param server Freshly listening server whose `_state` is being seeded.
   * @sideeffect Writes placeholder entries into `server._state`.
   */
  private seedStaticReservations(server: Server): void {
    const staticMap = this._cfg.static ?? {};
    const entries = Object.entries(staticMap);
    if (entries.length === 0) return;

    const state = server._state as Record<string, LeaseState>;
    const seeded: string[] = [];
    const skipped: string[] = [];

    for (const [rawMac, ip] of entries) {
      if (!isIpInPool(ip, this.rangeStart, this.rangeEnd)) {
        skipped.push(`${rawMac}→${ip}`);
        continue;
      }
      const mac = toLibraryMacKey(rawMac);
      // Already holding the reserved address — either seeded by an earlier pass
      // or restored from disk with real bind history worth keeping.
      if (state[mac]?.address === ip) continue;
      state[mac] = toReservedLeaseState(ip, this.serverId, this.leaseTimeSec);
      seeded.push(`${mac}→${ip}`);
    }

    if (seeded.length === 0 && skipped.length === 0) return;
    this._log(
      'info',
      `Engine: reserved ${seeded.length} in-pool static address(es)${seeded.length > 0 ? `: ${seeded.join(', ')}` : ''}${
        skipped.length > 0 ? ` · ${skipped.length} outside the pool (no reservation needed): ${skipped.join(', ')}` : ''
      }`,
    );
  }

  /** Writes any pending lease change and tears the writer down. Idempotent. */
  private async flushLeaseStore(): Promise<void> {
    const store = this._leaseStore;
    this._leaseStore = null;
    if (!store) return;
    try {
      await store.flush();
    } finally {
      store.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Builds the `ServerConfig` object passed to `dhcp.createServer`. */
  private buildServerConfig(): ServerConfig {
    return {
      range: [this.rangeStart, this.rangeEnd],
      netmask: this.subnet,
      router: [this.gateway],
      dns: [...this.dns],
      broadcast: this.broadcast,
      server: this.serverId,
      leaseTime: this.leaseTimeSec,
      static: this._cfg.static ? { ...this._cfg.static } : {},
      ...this.buildBootOptions(),
    };
  }

  /**
   * Maps the ZTP boot settings onto the library's config keys, plus the
   * `forceOptions` list that makes them go out.
   *
   * `forceOptions` is what turns "offered if asked for" into "always sent":
   * without it `_getOptions` (dhcp.js:206-227) only emits an option the client
   * named in its parameter request list (option 55), and plenty of ZTP-capable
   * hardware expects the boot info unsolicited.
   */
  private buildBootOptions(): Partial<ServerConfig> {
    const boot: {
      tftpServer?: DhcpConfigValue<string>;
      bootFile?: DhcpConfigValue<string>;
      tftpServerAddresses?: DhcpConfigValue<string[]>;
      vendor?: DhcpConfigValue<number[]>;
    } = {};
    const forced: string[] = [];

    if (this._cfg.nextServer) {
      boot.tftpServer = this.gateOnVendorClass(this._cfg.nextServer);
      forced.push(LIB_KEY_TFTP_SERVER_NAME);
    }
    if (this._cfg.bootFileName) {
      boot.bootFile = this.gateOnVendorClass(this._cfg.bootFileName);
      forced.push(LIB_KEY_BOOTFILE_NAME);
    }
    const tftpServerAddresses = this._cfg.tftpServerAddresses;
    if (tftpServerAddresses && tftpServerAddresses.length > 0) {
      boot.tftpServerAddresses = this.gateOnVendorClass([...tftpServerAddresses]);
      forced.push(LIB_KEY_CISCO_TFTP_SERVERS);
    }
    const vendorBytes = this.encodeVendorSpecificOption();
    if (vendorBytes) {
      boot.vendor = this.gateOnVendorClass(vendorBytes);
      forced.push(LIB_KEY_VENDOR_SPECIFIC);
    }

    if (forced.length === 0) return {};
    this._log(
      'info',
      `Engine: serving boot options [${forced.join(', ')}]${this._cfg.vendorClassId ? ` to clients whose option 60 is "${this._cfg.vendorClassId}"` : ' to every client'}.`,
    );
    return { ...boot, forceOptions: forced };
  }

  /**
   * Wraps a boot option value so it is only served to a matching client.
   *
   * The library resolves a function-valued config against the incoming
   * request's options (dhcp.js:152-163), which is the only hook available for
   * per-request decisions. `null` is the sentinel: it is the one value the
   * option writer skips outright (seqbuffer.js:197), whereas `0` or `''`
   * would be encoded as a real, empty option.
   */
  private gateOnVendorClass<T>(value: T): DhcpConfigValue<T> {
    const vendorClassId = this._cfg.vendorClassId?.trim();
    if (!vendorClassId) return value;
    return (requestOptions) =>
      matchesVendorClass(vendorClassId, requestOptions[VENDOR_CLASS_REQUEST_ATTR]) ? value : null;
  }

  /**
   * TLV-encodes option 43 into the byte array the library's `UInt8s` writer
   * expects, or `undefined` when there is nothing to send.
   *
   * A malformed sub-option is logged and dropped rather than thrown: refusing
   * to hand out addresses at all because one vendor TLV is mistyped is a far
   * worse outcome than serving the lease without option 43.
   */
  private encodeVendorSpecificOption(): number[] | undefined {
    const entries = this._cfg.vendorSpecificOptions;
    if (!entries || entries.length === 0) return undefined;
    try {
      const encoded = encodeVendorSpecificInfo(entries);
      return encoded.length > 0 ? Array.from(encoded) : undefined;
    } catch (err) {
      this._log(
        'error',
        `Engine: option 43 will NOT be served — ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** Processes a `message` event from the dhcp library and updates counters + leases diff. */
  private _processMessage(req: any): void {
    const c = this._counters;
    c.packetsReceived += 1;
    const msgTypeRaw = Number(req?.options?.[53] ?? 0);
    const name = DHCP_MESSAGE_NAMES[msgTypeRaw] ?? `UNKNOWN(${msgTypeRaw})`;
    const mac: string = req?.chaddr ?? '??:??:??:??:??:??';

    // Estimate of responses sent (1 resp per client msg that requires response).
    // 1=DISCOVER → OFFER +1; 3=REQUEST → ACK/NAK +1. The rest we do not answer directly.
    switch (msgTypeRaw) {
      case 1: c.discoverCount += 1; c.packetsSentEstimate += 1; break;
      case 2: c.offerCount    += 1; break;
      case 3: c.requestCount  += 1; c.packetsSentEstimate += 1; break;
      case 4: c.declineCount  += 1; break;
      case 5: c.ackCount      += 1; break;
      case 6: c.nakCount      += 1; break;
      case 7: c.releaseCount  += 1; break;
      case 8: c.informCount   += 1; break;
    }
    // The observed option 60 is echoed because `vendorClassId` matching is
    // exact: this log is where the user copies the string their gear sends.
    const vendorClass = req?.options?.[DHCP_OPTION_VENDOR_CLASS_ID];
    const vendorClassSuffix = typeof vendorClass === 'string' && vendorClass.length > 0
      ? ` · vendor-class="${vendorClass}"`
      : '';

    this.emit('message:dhcp', name, req);
    this.emit('log', 'debug', `${name} from MAC ${mac}${vendorClassSuffix}`);

    this._diffLeases();
  }

  /**
   * Compares the current `_state` with the previous snapshot and emits
   * appropriate `lease:bound`, `lease:renewed`, `lease:released` events.
   */
  private _diffLeases(): void {
    if (!this._server) return;
    const state = this._server._state as Record<string, LeaseState>;
    // Reservation placeholders are invisible to the diff while they are still
    // placeholders, which gets both edges right: no phantom `lease:bound` at
    // startup for a device that has not booted, and a real `lease:bound` the
    // moment that device's DISCOVER flips the entry out of RESERVED.
    const currKeys = new Set<string>(
      Object.keys(state).filter((mac) => state[mac]?.state !== RESERVED_LEASE_STATE),
    );
    const allMacs = new Set<string>([...this._prevLeaseKeys, ...currKeys]);
    const staticMap = this._cfg.static ?? {};
    const now = Date.now();
    const boundMsgs: DhcpLeaseInfo[] = [];
    const renewedMsgs: DhcpLeaseInfo[] = [];
    const releasedMsgs: { mac: string; ip: string | null }[] = [];

    for (const mac of allMacs) {
      const inPrev = this._prevLeaseKeys.has(mac);
      const inCurr = currKeys.has(mac);

      if (!inPrev && inCurr) {
        // New lease (bound).
        const info = buildLeaseInfo(mac, state[mac], staticMap, now, this.leaseTimeSec);
        if (info) boundMsgs.push(info);
      } else if (inPrev && inCurr) {
        // If bindTime changed (renewal), emit 'renewed'.
        const entry = state[mac];
        if (entry?.address) {
          const boundAt = entry.bindTime instanceof Date ? entry.bindTime.getTime() : now;
          const prev = this._prevBindTimes.get(mac);
          if (typeof prev === 'number' && boundAt > prev) {
            const info = buildLeaseInfo(mac, entry, staticMap, now, this.leaseTimeSec, 'renewed');
            if (info) renewedMsgs.push(info);
          }
        }
      } else if (inPrev && !inCurr) {
        // Gone — released/expired.
        const prevBindTime = this._prevBindTimes.get(mac);
        const ip = this._guessReleasedIp(mac, prevBindTime);
        releasedMsgs.push({ mac, ip });
      }
    }

    // Emit events.
    for (const l of boundMsgs) this.emit('lease:bound', l);
    for (const l of renewedMsgs) this.emit('lease:renewed', l);
    for (const l of releasedMsgs) this.emit('lease:released', l);

    if (boundMsgs.length > 0 || renewedMsgs.length > 0 || releasedMsgs.length > 0) {
      this._leaseStore?.schedule();
    }

    // Save state for next diff.
    this._prevLeaseKeys = currKeys;
    const nextBindTimes = new Map<string, number>();
    for (const mac of currKeys) {
      const entry = state[mac];
      if (entry) {
        const bt = entry.bindTime instanceof Date ? entry.bindTime.getTime() : now;
        nextBindTimes.set(mac, bt);
      }
    }
    this._prevBindTimes = nextBindTimes;
  }

  /** Best effort to recover the released IP (querying old entry if still available in cache; if not, returns null). */
  private _guessReleasedIp(_mac: string, _prevBindTime: number | undefined): string | null {
    // The dhcp library already removed the entry; there is no retroactive log. Best effort = null.
    return null;
  }

  /**
   * Creates a `dhcp.Server`, attaches log/event listeners, tries
   * `listen(port)`.
   *
   * @param port Port to try.
   * @param cfg Pre-built ServerConfig.
   * @param onBeforeListen Callback before `.listen()` — serves to capture
   *   the "first server" instance on the initial try for P0 cleanup in case
   *   of EACCES bind failure.
   */
  private tryListen(
    port: number,
    cfg: ServerConfig,
    onBeforeListen: (server: Server) => void,
  ): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      let settled = false;
      const server = dhcp.createServer(cfg);
      onBeforeListen(server);
      this.attachServerListeners(server);

      const onListening = () => {
        if (settled) return;
        settled = true;
        server.off('error', onError);
        resolve(server);
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        server.off('listening', onListening);
        cleanupFailedServer(server);
        reject(err);
      };

      server.once('listening', onListening);
      server.once('error', onError);

      try {
        server.listen(port, this.bindAddress);
      } catch (err) {
        if (!settled) {
          settled = true;
          server.off('listening', onListening);
          server.off('error', onError);
          cleanupFailedServer(server);
          reject(err);
        }
      }
    });
  }

  /**
   * Attaches permanent listeners (log + DHCP events) to the server.
   * They are removed en bloc via `removeAllListeners()` on stop/failure.
   */
  private attachServerListeners(server: Server): void {
    server.on('listening', (_sock) => {
      this._log('info', 'Engine: UDP socket bound and listening for DHCP broadcasts.');
    });
    server.on('close', () => {
      this._log('info', 'Engine: DHCP socket closed.');
    });
    server.on('error', (err) => {
      const msg = `Engine: error emitted by DHCP server during RUNNING: ${err.message}`;
      this._log('error', msg);
      this.emit('error', err);
      this.emit('log', 'error', msg);
    });
    server.on('message', (req) => {
      this._processMessage(req);
    });
    server.on('bound', (_state) => {
      // Diff to catch bound/renewed
      this._diffLeases();
      // Log of last added (best effort)
      const leases = this.activeLeases();
      const latest = leases[leases.length - 1];
      if (latest) {
        this._log(
          'info',
          `Engine: Lease BOUND MAC ${latest.mac} → IP ${latest.ip} (lease ${latest.leaseSec}s, remaining ${latest.remainingSec}s, type=${latest.leaseType}${latest.hostname ? `, hostname=${latest.hostname}` : ''})`,
        );
      }
    });
  }
}
