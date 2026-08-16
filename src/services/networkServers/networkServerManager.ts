/**
 * Extension-host orchestrator for the two embedded network services
 * (TFTP + DHCP).
 *
 * Sits between VS Code and {@link NetworkServerDaemonHost}, and owns three
 * responsibilities the daemon cannot handle itself:
 *
 * 1. **Reading settings.** The daemon is a bare Node process with no `vscode`
 *    module, so it cannot see `nexus.networkServers.*`. This class resolves
 *    those settings and pushes them across the RPC boundary — at spawn time as
 *    an environment seed, and again on every start/restart so a service always
 *    launches with what the user currently has configured.
 * 2. **Workspace Trust.** Binding UDP 69/67 and serving files off disk is not
 *    something a Restricted-Mode workspace gets to trigger.
 * 3. **State fan-out.** Daemon pushes become `NexusCore` runtime state (which
 *    tree views render from) and output-channel lines.
 *
 * Unlike `LocalServerManager` there is no CRUD surface: TFTP and DHCP are
 * fixed singletons, not user-created profiles.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { NexusCore } from "../../core/nexusCore";
import {
  NetworkServerError,
  type NetworkServerKind,
  type NetworkServerLeaseSummary,
  type NetworkServerRuntimeDetail,
  type NetworkServerStatus,
  type NetworkServerTransferSummary
} from "../../models/networkServer";
import { readBoundedNumber } from "../../utils/boundedConfig";
import type {
  DhcpAdapterConfig,
  DhcpVendorSpecificEntry,
  NetworkServerConfigs,
  TftpAdapterConfig
} from "./core/index";
import { isValidSubOptionCode } from "./dhcp/engine/dhcpBootOptions";
import {
  NetworkServerDaemonHost,
  type DhcpRuntimeSnapshot,
  type NetworkServerAdapterConfig,
  type NetworkServerRuntimeSnapshot,
  type TftpRuntimeSnapshot
} from "./daemonHost";

export const NETWORK_SERVER_KINDS: readonly NetworkServerKind[] = ["tftp", "dhcp"];

/**
 * How long runtime refreshes are coalesced.
 *
 * TFTP emits `runtimeUpdate` on every progress tick of every transfer; issuing
 * one `getServiceRuntime` RPC per tick would flood the pipe and re-render the
 * tree far faster than anyone can read it. One refresh per service per window
 * is plenty for a human-facing view.
 */
const RUNTIME_REFRESH_DEBOUNCE_MS = 150;

export interface NetworkServerManagerOptions {
  core: NexusCore;
  /** Extension installation root; the daemon bundle is resolved beneath it. */
  extensionPath: string;
  /**
   * `context.globalStorageUri.fsPath`. The DHCP lease table is persisted
   * beneath it so an unexpired lease survives a daemon restart.
   *
   * Optional because a headless/test manager has nowhere to write and is
   * happier without a file; omitting it simply leaves DHCP with the historical
   * in-memory-only lease table.
   */
  globalStoragePath?: string;
  /** Reuse an existing channel, or omit to have one created and owned here. */
  outputChannel?: vscode.OutputChannel;
}

/**
 * Absolute path of the DHCP lease store.
 *
 * Global storage rather than the workspace: the lease table belongs to the
 * machine's bench network, not to whichever folder happens to be open.
 */
export function resolveDhcpLeaseStorePath(globalStoragePath: string): string {
  return path.join(globalStoragePath, "networkServers", "dhcp-leases.json");
}

/**
 * Absolute path to the bundled daemon entry point.
 *
 * Mirrors `resolveLocalPtySidecarPath`: derived from `extensionPath` rather
 * than `__dirname` so it stays correct under test and does not depend on where
 * this module itself was bundled to.
 */
export function resolveNetworkServerDaemonPath(extensionPath: string): string {
  return path.join(extensionPath, "dist", "services", "networkServers", "networkServerDaemon.js");
}

/**
 * Reads a string setting, mapping blank/whitespace to `undefined`.
 *
 * An empty string is how VS Code represents "not set" for a string setting
 * with a `""` default. Forwarding it verbatim would override the adapter's own
 * default with an empty root path or an empty bind address, so it has to
 * collapse to `undefined` instead.
 */
function readOptionalString(section: string, key: string): string | undefined {
  const raw = vscode.workspace.getConfiguration(section).get<string>(key);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads a string-array setting, dropping blanks; `undefined` when empty. */
function readOptionalStringArray(section: string, key: string): string[] | undefined {
  const raw = vscode.workspace.getConfiguration(section).get<unknown>(key);
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  return values.length > 0 ? values : undefined;
}

/**
 * Reads the MAC→IP reservation map, keeping only well-formed string pairs.
 *
 * Hand-edited `settings.json` is the normal authoring path for this setting,
 * so a nested object or a numeric value is a realistic input — and one bad
 * entry must not discard the whole map.
 */
function readStaticLeaseMap(section: string, key: string): Record<string, string> | undefined {
  const raw = vscode.workspace.getConfiguration(section).get<unknown>(key);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries: Record<string, string> = {};
  for (const [mac, ip] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ip !== "string") continue;
    const trimmedMac = mac.trim();
    const trimmedIp = ip.trim();
    if (!trimmedMac || !trimmedIp) continue;
    entries[trimmedMac] = trimmedIp;
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

/**
 * Reads the option 43 sub-option list, dropping entries that could not be put
 * on the wire.
 *
 * Same tolerance as {@link readStaticLeaseMap}: this array is authored by hand
 * in `settings.json` as often as through the form, and one malformed entry must
 * not discard the rest. Value syntax (`0x…` hex vs plain text) is validated at
 * encode time, not here — this filter only rejects entries that are not
 * `{ subOption, value }` pairs with a legal sub-option code.
 */
function readVendorSpecificOptions(section: string, key: string): DhcpVendorSpecificEntry[] | undefined {
  const raw = vscode.workspace.getConfiguration(section).get<unknown>(key);
  if (!Array.isArray(raw)) return undefined;
  const entries: DhcpVendorSpecificEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { subOption, value } = item as { subOption?: unknown; value?: unknown };
    if (typeof subOption !== "number" || !isValidSubOptionCode(subOption)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    entries.push({ subOption, value });
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * The TFTP service's own bind address, when it is one a client could reach.
 *
 * `0.0.0.0` (or unset) means "every interface", which is not an address a
 * device can be told to fetch from — there is no single right answer to guess,
 * so the caller leaves the boot options unset instead.
 */
function resolveTftpLinkAddress(): string | undefined {
  const address = readTftpConfig().interface;
  return address && address !== "0.0.0.0" ? address : undefined;
}

/** Resolves current `nexus.networkServers.tftp.*` settings. */
export function readTftpConfig(): TftpAdapterConfig {
  const section = "nexus.networkServers.tftp";
  return {
    root: readOptionalString(section, "root"),
    port: readBoundedNumber(section, "port", 69, 1, 65535),
    allowWrite: vscode.workspace.getConfiguration(section).get<boolean>("allowWrite", false) === true,
    interface: readOptionalString(section, "interface")
  };
}

/**
 * Resolves current `nexus.networkServers.dhcp.*` settings.
 *
 * @param globalStoragePath - Where the lease store lives. Omitted leaves
 *   `leaseStorePath` unset, i.e. leases stay in memory only.
 */
export function readDhcpConfig(globalStoragePath?: string): DhcpAdapterConfig {
  const section = "nexus.networkServers.dhcp";
  const nextServer = readOptionalString(section, "nextServer");
  const tftpServerAddresses = readOptionalStringArray(section, "tftpServerAddresses");
  // All-or-nothing on purpose: an explicit address in *either* key means the
  // user has already picked a boot server, and quietly advertising a second,
  // different one under the other option number is how a device ends up
  // booting from the wrong host.
  const autoLinked =
    vscode.workspace.getConfiguration(section).get<boolean>("autoLinkTftp", true) !== false &&
    !nextServer &&
    !tftpServerAddresses
      ? resolveTftpLinkAddress()
      : undefined;
  return {
    rangeStart: readOptionalString(section, "rangeStart"),
    rangeEnd: readOptionalString(section, "rangeEnd"),
    subnet: readOptionalString(section, "subnet"),
    gateway: readOptionalString(section, "gateway"),
    dns: readOptionalStringArray(section, "dns"),
    // 60s floor: shorter leases make clients renew faster than the server can
    // meaningfully track. 7-day ceiling matches common DHCP practice.
    leaseTimeSec: readBoundedNumber(section, "leaseTimeSec", 86_400, 60, 604_800),
    serverId: readOptionalString(section, "serverId"),
    broadcast: readOptionalString(section, "broadcast"),
    static: readStaticLeaseMap(section, "static"),
    bindAddress: readOptionalString(section, "interface"),
    leaseStorePath: globalStoragePath ? resolveDhcpLeaseStorePath(globalStoragePath) : undefined,
    bootFileName: readOptionalString(section, "bootFileName"),
    nextServer: nextServer ?? autoLinked,
    tftpServerAddresses: tftpServerAddresses ?? (autoLinked ? [autoLinked] : undefined),
    vendorClassId: readOptionalString(section, "vendorClassId"),
    vendorSpecificOptions: readVendorSpecificOptions(section, "vendorSpecificOptions")
  };
}

/** Resolves settings for both services in one shot (used for the spawn seed). */
export function readNetworkServerConfigs(globalStoragePath?: string): NetworkServerConfigs {
  return { tftp: readTftpConfig(), dhcp: readDhcpConfig(globalStoragePath) };
}

export class NetworkServerManager implements vscode.Disposable {
  private readonly core: NexusCore;
  private readonly outputChannel: vscode.OutputChannel;
  /** True when this instance created the channel and must therefore dispose it. */
  private readonly ownsOutputChannel: boolean;
  private readonly host: NetworkServerDaemonHost;
  private readonly subscriptions: Array<() => void> = [];
  private readonly refreshTimers = new Map<NetworkServerKind, ReturnType<typeof setTimeout>>();
  private disposed = false;

  public constructor(private readonly options: NetworkServerManagerOptions) {
    this.core = options.core;
    this.ownsOutputChannel = options.outputChannel === undefined;
    this.outputChannel = options.outputChannel ?? vscode.window.createOutputChannel("Nexus Network Servers");
    this.host = new NetworkServerDaemonHost(resolveNetworkServerDaemonPath(options.extensionPath), {
      extensionRoot: options.extensionPath,
      resolveSpawnConfig: () => readNetworkServerConfigs(options.globalStoragePath)
    });

    this.subscriptions.push(
      this.host.onDidChangeStatus((event) => this.handleStatusChange(event.id, event.status, event.error)),
      this.host.onDidUpdateRuntime((id) => this.scheduleRuntimeRefresh(id)),
      this.host.onDidLog((id, level, message) => this.log(level, `[${id}] ${message}`)),
      this.host.onDidExit((code, signal) => this.handleDaemonExit(code, signal))
    );
  }

  /**
   * Hard-refuses operation in a Restricted-Mode workspace.
   *
   * Starting these services binds privileged UDP ports and, for TFTP, exposes
   * a directory tree for reading (and optionally writing) to anything on the
   * network. That is not a capability an untrusted workspace gets to reach.
   */
  public assertTrusted(): void {
    if (vscode.workspace.isTrusted === false) {
      throw new NetworkServerError(
        "WorkspaceUntrusted",
        "Embedded network servers require a trusted workspace. Grant trust before starting TFTP or DHCP."
      );
    }
  }

  /** Starts a service with the settings currently in effect. */
  public async start(kind: NetworkServerKind): Promise<void> {
    this.assertTrusted();
    const config = this.readConfig(kind);
    this.ensureRegistered(kind);
    this.core.updateNetworkServerSessionStatus(kind, "starting");
    this.log("info", `Starting ${kind.toUpperCase()} service…`);
    try {
      await this.host.startServer(kind, config);
    } catch (error) {
      this.failSession(kind, error);
      throw this.toNetworkServerError(kind, error);
    }
    await this.refreshRuntime(kind);
  }

  /** Gracefully stops a service. */
  public async stop(kind: NetworkServerKind): Promise<void> {
    this.assertTrusted();
    this.core.updateNetworkServerSessionStatus(kind, "stopping");
    this.log("info", `Stopping ${kind.toUpperCase()} service…`);
    try {
      await this.host.stopServer(kind);
    } catch (error) {
      this.failSession(kind, error);
      throw this.toNetworkServerError(kind, error);
    }
    this.core.updateNetworkServerSessionStatus(kind, "stopped", { boundPort: null });
  }

  /** Restarts a service, re-reading settings so edits take effect. */
  public async restart(kind: NetworkServerKind): Promise<void> {
    this.assertTrusted();
    const config = this.readConfig(kind);
    this.ensureRegistered(kind);
    this.core.updateNetworkServerSessionStatus(kind, "starting");
    this.log("info", `Restarting ${kind.toUpperCase()} service…`);
    try {
      await this.host.restartServer(kind, config);
    } catch (error) {
      this.failSession(kind, error);
      throw this.toNetworkServerError(kind, error);
    }
    await this.refreshRuntime(kind);
  }

  /**
   * Pushes current settings to the daemon without starting anything.
   *
   * Useful on a settings-change event: stopped services are then rebuilt
   * against the new values the next time they start, with no extra round trip.
   */
  public async syncConfiguration(): Promise<void> {
    if (!this.host.isRunning) return;
    try {
      await this.host.configure(readNetworkServerConfigs(this.options.globalStoragePath));
    } catch (error) {
      this.log("warn", `Failed to push configuration to daemon: ${describeError(error)}`);
    }
  }

  /** Current settings for one service. */
  public readConfig(kind: NetworkServerKind): NetworkServerAdapterConfig {
    return kind === "tftp" ? readTftpConfig() : readDhcpConfig(this.options.globalStoragePath);
  }

  /** Re-reads live runtime for a service and mirrors it into NexusCore. */
  public async refreshRuntime(kind: NetworkServerKind): Promise<void> {
    if (this.disposed || !this.host.isRunning) return;
    let runtime: NetworkServerRuntimeSnapshot;
    try {
      runtime = await this.host.getServiceRuntime(kind);
    } catch (error) {
      this.log("debug", `Runtime refresh for ${kind} failed: ${describeError(error)}`);
      return;
    }
    this.ensureRegistered(kind);
    this.core.setNetworkServerRuntimeSnapshot(kind, toRuntimeDetail(kind, runtime), runtime.boundPort ?? null);
    this.core.updateNetworkServerSessionStatus(kind, runtime.snapshot.status as NetworkServerStatus, {
      boundPort: runtime.boundPort ?? null,
      errorMessage: runtime.snapshot.errorMessage
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    for (const unsubscribe of this.subscriptions) {
      try { unsubscribe(); } catch { /* tolerate */ }
    }
    this.subscriptions.length = 0;
    // Tears down the daemon child (SIGTERM → SIGKILL), which releases UDP 69/67
    // rather than leaving an orphan holding them after the host goes away.
    this.host.dispose();
    for (const kind of NETWORK_SERVER_KINDS) {
      this.core.unregisterNetworkServerSession(kind);
    }
    if (this.ownsOutputChannel) {
      this.outputChannel.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ensureRegistered(kind: NetworkServerKind): void {
    if (this.core.getNetworkServerSession(kind)) return;
    this.core.registerNetworkServerSession({ kind, status: "stopped", boundPort: null });
  }

  private handleStatusChange(id: string, status: string, error?: string): void {
    if (!isNetworkServerKind(id)) return;
    this.ensureRegistered(id);
    this.core.updateNetworkServerSessionStatus(id, status as NetworkServerStatus, { errorMessage: error });
    if (error) {
      this.log("error", `[${id}] ${error}`);
    }
    // A fresh transition changes bound port and clears/populates transfers and
    // leases, none of which the status push itself carries.
    this.scheduleRuntimeRefresh(id);
  }

  private handleDaemonExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed) return;
    this.log("warn", `Daemon exited (code=${String(code ?? "null")}, signal=${String(signal ?? "none")}).`);
    for (const kind of NETWORK_SERVER_KINDS) {
      if (!this.core.getNetworkServerSession(kind)) continue;
      this.core.updateNetworkServerSessionStatus(kind, "stopped", { boundPort: null });
    }
  }

  private scheduleRuntimeRefresh(id: string): void {
    if (this.disposed || !isNetworkServerKind(id)) return;
    if (this.refreshTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(id);
      void this.refreshRuntime(id);
    }, RUNTIME_REFRESH_DEBOUNCE_MS);
    this.refreshTimers.set(id, timer);
  }

  private failSession(kind: NetworkServerKind, error: unknown): void {
    this.ensureRegistered(kind);
    this.core.updateNetworkServerSessionStatus(kind, "error", { errorMessage: describeError(error) });
  }

  /**
   * Classifies a raw daemon/transport failure into a typed error.
   *
   * The distinctions that matter to a caller are actionable ones: a denied
   * privileged port tells the user to relaunch elevated (or accept the
   * unprivileged fallback), while a busy port tells them to stop the other
   * server first.
   */
  private toNetworkServerError(kind: NetworkServerKind, error: unknown): NetworkServerError {
    if (error instanceof NetworkServerError) return error;
    const message = describeError(error);
    const service = kind.toUpperCase();
    if (/EACCES|privileg|permission/i.test(message)) {
      return new NetworkServerError(
        "PrivilegedPortDenied",
        `${service} could not bind its privileged port: ${message}`,
        error
      );
    }
    if (/EADDRINUSE|already in use|address already/i.test(message)) {
      return new NetworkServerError("BindFailed", `${service} port is already in use: ${message}`, error);
    }
    if (/not ready|did not report ready|daemon exited|not writable|disposed/i.test(message)) {
      return new NetworkServerError("DaemonNotReady", `${service} daemon is unavailable: ${message}`, error);
    }
    if (/not found/i.test(message)) {
      return new NetworkServerError("DaemonSpawnFailed", `${service} daemon could not start: ${message}`, error);
    }
    return new NetworkServerError("BindFailed", `${service} failed to start: ${message}`, error);
  }

  private log(level: string, message: string): void {
    const stamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${stamp}] [${level}] ${message}`);
  }
}

function isNetworkServerKind(value: string): value is NetworkServerKind {
  return value === "tftp" || value === "dhcp";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrows a runtime reply to the DHCP variant. */
function isDhcpRuntime(runtime: NetworkServerRuntimeSnapshot): runtime is DhcpRuntimeSnapshot {
  return "leases" in runtime;
}

/**
 * Projects a daemon runtime reply into the tree-facing detail shape.
 *
 * Deliberately lossy: `blockSize`, `windowSize`, per-message DHCP counters and
 * the like are dropped, because the tree renders a summary line, not a packet
 * dissector. Anything a future view needs can be re-added here without
 * touching the wire protocol.
 */
function toRuntimeDetail(kind: NetworkServerKind, runtime: NetworkServerRuntimeSnapshot): NetworkServerRuntimeDetail {
  if (kind === "dhcp" && isDhcpRuntime(runtime)) {
    const leases: NetworkServerLeaseSummary[] = runtime.leases.map((lease) => ({
      mac: lease.mac,
      ip: lease.ip,
      hostname: lease.hostname ?? undefined,
      leaseType: lease.leaseType,
      remainingSec: lease.remainingSec
    }));
    return {
      leases,
      poolSize: runtime.poolInfo?.poolSize,
      activeLeaseCount: runtime.poolInfo?.activeCount,
      utilizationPct: runtime.poolInfo?.utilizationPct,
      packetsReceived: runtime.packetCounters?.packetsReceived
    };
  }

  const tftp = runtime as TftpRuntimeSnapshot;
  const transfers: NetworkServerTransferSummary[] = (tftp.transfers ?? []).map((transfer) => ({
    filename: transfer.filename,
    direction: transfer.direction,
    peer: `${transfer.peer.address}:${transfer.peer.port}`,
    bytes: transfer.bytes,
    totalBytes: transfer.totalBytes,
    speedBps: transfer.speedBps
  }));
  return { root: tftp.root, allowWrite: tftp.allowWrite, transfers };
}
