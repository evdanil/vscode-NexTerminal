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
 * There is deliberately no CRUD surface: TFTP and DHCP are fixed singletons,
 * not user-created profiles.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { NexusCore } from "../../core/nexusCore";
import {
  NETWORK_SERVER_KINDS,
  NetworkServerError,
  isNetworkServerKind,
  type NetworkServerKind,
  type NetworkServerLeaseSummary,
  type NetworkServerRuntimeDetail,
  type NetworkServerStatus,
  type NetworkServerTransferHistoryEntry,
  type NetworkServerTransferSummary
} from "../../models/networkServer";
import type {
  DhcpAdapterConfig,
  NetworkServerConfigs,
  ServerConnectionEvent,
  TftpAdapterConfig
} from "./core/index";
import { sanitizeDhcpConfig, sanitizeTftpConfig } from "./networkServerConfigValidation";
import {
  NetworkServerDaemonHost,
  type DhcpRuntimeSnapshot,
  type NetworkServerAdapterConfig,
  type NetworkServerRuntimeSnapshot,
  type TftpRuntimeSnapshot
} from "./daemonHost";

/** Re-exported from the model so tree/UI consumers keep a single import site. */
export { NETWORK_SERVER_KINDS };

/** Service names as they appear at the head of a notification. */
const SERVICE_LABELS: Record<NetworkServerKind, string> = { tftp: "TFTP", dhcp: "DHCP" };

/**
 * Whether Verbose Mode is enabled *right now*.
 *
 * Read fresh at every notification site rather than captured in a field: a
 * toggle then takes effect on the very next event with no `onDidChangeConfiguration`
 * subscription to keep in sync, and there is no window in which a user who has
 * just switched it off keeps being notified. The read is a cached lookup in
 * VS Code's configuration model, so doing it per event costs nothing worth
 * saving.
 */
export function isNetworkServerVerboseMode(): boolean {
  return vscode.workspace.getConfiguration("nexus.networkServers").get<boolean>("verboseMode", false) === true;
}

/**
 * How long runtime refreshes are coalesced.
 *
 * TFTP emits `runtimeUpdate` on every progress tick of every transfer; issuing
 * one `getServiceRuntime` RPC per tick would flood the pipe and re-render the
 * tree far faster than anyone can read it. One refresh per service per window
 * is plenty for a human-facing view.
 */
const RUNTIME_REFRESH_DEBOUNCE_MS = 150;

/**
 * How many completed transfers the sidebar History keeps per service.
 *
 * The list is a convenience for "what did that device just pull?", not an audit
 * log — it is in-memory only and reset on every start/stop/restart. The cap
 * bounds both the memory held and the number of tree rows VS Code renders when
 * a ZTP boot pulls dozens of files in a burst.
 */
const TRANSFER_HISTORY_LIMIT = 50;

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
function readOptionalSettingValue(section: string, key: string): unknown {
  const raw = vscode.workspace.getConfiguration(section).get<unknown>(key);
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalArrayValue(section: string, key: string): unknown {
  const raw = readOptionalSettingValue(section, key);
  if (!Array.isArray(raw)) return raw;
  if (raw.length === 0) return undefined;
  return raw.map((entry) => (typeof entry === "string" ? entry.trim() : entry));
}

function readOptionalObjectValue(section: string, key: string): unknown {
  const raw = readOptionalSettingValue(section, key);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return Object.keys(raw).length > 0 ? raw : undefined;
}

/**
 * Normalizes editable static-lease map whitespace before strict validation.
 *
 * VS Code settings can retain hand-edited padding around object keys and
 * values. Trimming it here preserves the previous tolerant settings-read
 * behavior while the shared validator remains the authority for canonical MAC
 * and IPv4 syntax.
 */
function readStaticSettingValue(section: string, key: string): unknown {
  const raw = readOptionalObjectValue(section, key);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const normalized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(raw)) {
    normalized[entryKey.trim()] = typeof entryValue === "string" ? entryValue.trim() : entryValue;
  }
  return normalized;
}

/**
 * The last set of problems reported, so a standing fault is logged once rather
 * than on every read.
 *
 * `readDhcpConfig` is called from the tree provider on every expansion as well
 * as at start/restart, so an unconditional log would fill the console with one
 * copy of the same complaint per render. Keying on the joined text (rather than
 * a boolean) means a *different* fault, or the same fault reappearing after the
 * user fixed it, is still reported.
 */
let lastReportedDhcpConfigProblems = "";
let lastReportedTftpConfigProblems = "";

/** Reports malformed DHCP settings once per distinct set of faults. */
function reportDhcpConfigProblems(problems: readonly string[]): void {
  const summary = problems.join("; ");
  if (summary === lastReportedDhcpConfigProblems) return;
  lastReportedDhcpConfigProblems = summary;
  if (problems.length === 0) return;
  console.warn(
    `[Nexus Network Servers] Ignoring malformed nexus.networkServers.dhcp settings — the packaged defaults apply instead: ${summary}.`
  );
}

/** Reports malformed TFTP settings once per distinct set of faults. */
function reportTftpConfigProblems(problems: readonly string[]): void {
  const summary = problems.join("; ");
  if (summary === lastReportedTftpConfigProblems) return;
  lastReportedTftpConfigProblems = summary;
  if (problems.length === 0) return;
  console.warn(
    `[Nexus Network Servers] Ignoring malformed nexus.networkServers.tftp settings — the packaged defaults apply instead: ${summary}.`
  );
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
  const result = sanitizeTftpConfig({
    root: readOptionalSettingValue(section, "root"),
    port: readOptionalSettingValue(section, "port"),
    allowWrite: readOptionalSettingValue(section, "allowWrite"),
    interface: readOptionalSettingValue(section, "interface")
  });
  reportTftpConfigProblems(result.warnings);
  return {
    ...result.value,
    port: result.value.port ?? 69,
    allowWrite: result.value.allowWrite ?? false
  };
}

/**
 * Resolves current `nexus.networkServers.dhcp.*` settings.
 *
 * **This is a validating read, not a raw one.** The form and the quick pick
 * check what they write, but they are not the only way these keys get set —
 * `settings.json` is editable by hand, Settings Sync can land a conflicted
 * value, and another extension can write the section outright. Anything that
 * arrives malformed by one of those routes would otherwise reach the daemon
 * (which allocates from an inverted pool by handing out nothing at all — the
 * service binds, answers no DISCOVER, and reads as "DHCP is broken") and the
 * sidebar, which would display it as the configuration in force. Each faulty
 * field is dropped back to its packaged default and the whole set is reported
 * once, in the console, per distinct fault.
 *
 * This is defence in depth behind {@link validateDhcpValues}, not a substitute
 * for it: refusing at the point of entry with a message naming the field is
 * still much better than silently substituting a default later.
 *
 * @param globalStoragePath - Where the lease store lives. Omitted leaves
 *   `leaseStorePath` unset, i.e. leases stay in memory only.
 */
export function readDhcpConfig(globalStoragePath?: string): DhcpAdapterConfig {
  const section = "nexus.networkServers.dhcp";
  const result = sanitizeDhcpConfig({
    rangeStart: readOptionalSettingValue(section, "rangeStart"),
    rangeEnd: readOptionalSettingValue(section, "rangeEnd"),
    subnet: readOptionalSettingValue(section, "subnet"),
    gateway: readOptionalSettingValue(section, "gateway"),
    dns: readOptionalArrayValue(section, "dns"),
    leaseTimeSec: readOptionalSettingValue(section, "leaseTimeSec"),
    serverId: readOptionalSettingValue(section, "serverId"),
    broadcast: readOptionalSettingValue(section, "broadcast"),
    static: readStaticSettingValue(section, "static"),
    bindAddress: readOptionalSettingValue(section, "interface"),
    bootFileName: readOptionalSettingValue(section, "bootFileName"),
    nextServer: readOptionalSettingValue(section, "nextServer"),
    tftpServerAddresses: readOptionalArrayValue(section, "tftpServerAddresses"),
    vendorClassId: readOptionalSettingValue(section, "vendorClassId"),
    vendorSpecificOptions: readOptionalArrayValue(section, "vendorSpecificOptions")
  });
  reportDhcpConfigProblems(result.warnings);
  const nextServer = result.value.nextServer;
  const tftpServerAddresses = result.value.tftpServerAddresses;
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
    ...result.value,
    leaseTimeSec: result.value.leaseTimeSec ?? 86_400,
    leaseStorePath: globalStoragePath ? resolveDhcpLeaseStorePath(globalStoragePath) : undefined,
    nextServer: nextServer ?? autoLinked,
    tftpServerAddresses: tftpServerAddresses ?? (autoLinked ? [autoLinked] : undefined)
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
  /**
   * Completed transfers per service, newest first — the source of truth for the
   * sidebar's History node.
   *
   * Host-side and in-memory on purpose. The daemon is restartable and holds
   * only live state; persisting this through `ConfigRepository` would turn a
   * throwaway view of the current run into durable state that has to be
   * migrated, pruned and reasoned about across sessions.
   */
  private readonly transferHistory = new Map<NetworkServerKind, NetworkServerTransferHistoryEntry[]>();
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
      this.host.onDidConnection((id, event) => this.handleConnectionEvent(id, event)),
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
    this.clearTransferHistory(kind);
    this.notifyLifecycle(kind, "started");
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
    this.clearTransferHistory(kind);
    this.notifyLifecycle(kind, "stopped");
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
    this.clearTransferHistory(kind);
    this.notifyLifecycle(kind, "restarted");
  }

  /**
   * Aborts one in-flight TFTP transfer at the operator's request.
   *
   * The daemon sends the client a TFTP ERROR packet and tears the session down,
   * which comes back as a `connection` event and refreshes the sidebar. The
   * runtime is refreshed here as well so the row disappears even in the corner
   * case where the event is lost.
   *
   * @param transferId `address:port` id of the transfer to abort.
   * @returns `true` if a live transfer was cancelled, `false` if it had already
   *          finished by the time the request landed.
   * @throws {NetworkServerError} If the daemon call itself fails.
   */
  public async cancelTftpTransfer(transferId: string): Promise<boolean> {
    this.assertTrusted();
    if (!this.host.isRunning) return false;
    let cancelled: boolean;
    try {
      cancelled = await this.host.cancelTransfer("tftp", transferId);
    } catch (error) {
      throw this.toNetworkServerError("tftp", error);
    }
    if (cancelled) {
      this.log("info", `[tftp] Transfer ${transferId} cancelled by user.`);
    }
    this.refreshRuntimeNow("tftp");
    return cancelled;
  }

  /**
   * Empties the completed-transfer History for a service.
   *
   * Called both by the "Clear History" command and automatically on every
   * start/stop/restart. Unlike {@link notifyLifecycle} this is **not** gated on
   * Verbose Mode: the toast is a preference, but a History list that survived a
   * restart would be showing transfers from a service instance that no longer
   * exists — wrong regardless of what the user opted into.
   *
   * Idempotent: clearing an already-empty history still pushes the empty list,
   * which costs one snapshot emit and keeps the tree honest if it had somehow
   * drifted.
   *
   * @param kind Service whose history to drop.
   */
  public clearTransferHistory(kind: NetworkServerKind): void {
    this.transferHistory.set(kind, []);
    this.publishTransferHistory(kind);
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
    this.transferHistory.clear();
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

  /**
   * Announces a completed lifecycle transition the user asked for.
   *
   * Success only. A *failed* start/stop/restart is reported by the command
   * layer regardless of Verbose Mode: the user pressed a button and is owed an
   * answer, and reporting it here as well would show the same failure twice.
   */
  private notifyLifecycle(kind: NetworkServerKind, verb: "started" | "stopped" | "restarted"): void {
    if (this.disposed || !isNetworkServerVerboseMode()) return;
    const boundPort = verb === "stopped" ? null : this.core.getNetworkServerSession(kind)?.boundPort;
    const where = boundPort ? ` on UDP port ${boundPort}` : "";
    void vscode.window.showInformationMessage(`${SERVICE_LABELS[kind]} service ${verb}${where}.`);
  }

  /**
   * Surfaces one client connection lifecycle edge as a toast.
   *
   * Gated on Verbose Mode and default-off for a reason: a device booting over
   * ZTP opens a transfer per file, and a bench full of hardware renews leases
   * all day. The daemon already emits these only at lifecycle edges, so no
   * throttling is applied here — suppressing a *second* transfer because a
   * first one was just announced would be worse than showing both.
   *
   * The output channel keeps its own record either way; this only decides
   * whether the event also interrupts the user.
   */
  private handleConnectionEvent(id: string, event: ServerConnectionEvent): void {
    if (this.disposed || !isNetworkServerKind(id)) return;
    // A terminal edge means a row just disappeared daemon-side — a transfer
    // that finished, timed out, was aborted by the client's ERROR packet, or
    // was cancelled from the UI. Refreshing out of band (rather than through
    // the coalescing `scheduleRuntimeRefresh`) is what stops the sidebar from
    // showing a "ghost" transfer that no longer exists. This runs regardless of
    // Verbose Mode: the toast is optional, the sidebar being correct is not.
    if (event.phase !== "started") {
      this.refreshRuntimeNow(id);
    }
    // History is recorded before the Verbose Mode check on purpose: the toast
    // decides whether the user is interrupted, not whether the transfer
    // happened. Gating the record too would make the sidebar's contents depend
    // on a notification preference.
    if (id === "tftp" && event.phase === "completed") {
      this.recordCompletedTransfer(id, event);
    }
    if (!isNetworkServerVerboseMode()) return;
    const headline = `${SERVICE_LABELS[id]}: ${event.summary}`;
    if (event.phase !== "failed") {
      void vscode.window.showInformationMessage(headline);
      return;
    }
    const detail = event.detail ? ` — ${event.detail}` : "";
    const code = event.code ? ` (${event.code})` : "";
    void vscode.window.showErrorMessage(`${headline}${detail}${code}`);
  }

  /**
   * Appends one finished transfer to the service's History.
   *
   * The structured `id` / `resource` / `client` fields come straight off the
   * `connection` event, which the TFTP adapter fills in alongside the
   * human-readable `summary`. Nothing here parses `summary`: it is a sentence
   * written for a toast, and reverse-engineering fields out of it would break
   * the moment its wording changed.
   *
   * @param kind Service the transfer belongs to.
   * @param event The `completed`-phase connection event.
   * @sideeffect Trims to {@link TRANSFER_HISTORY_LIMIT} and republishes.
   */
  private recordCompletedTransfer(kind: NetworkServerKind, event: ServerConnectionEvent): void {
    const entries = this.transferHistory.get(kind) ?? [];
    entries.unshift({
      // A transfer id is only unique among *live* transfers (it is the client's
      // `address:port`), so a later transfer from the same ephemeral port can
      // legitimately repeat one already in the list. It is kept for correlation
      // with the live rows, never used as a key.
      id: event.id ?? `${kind}-${Date.now()}`,
      filename: event.resource,
      // `client` is pre-rendered daemon-side so History, the live rows and the
      // toasts all name a client identically. The id's address half is the
      // fallback when reverse DNS had not resolved in time.
      client: event.client ?? event.id?.split(":")[0] ?? "unknown client",
      timestamp: Date.now()
    });
    if (entries.length > TRANSFER_HISTORY_LIMIT) {
      entries.length = TRANSFER_HISTORY_LIMIT;
    }
    this.transferHistory.set(kind, entries);
    this.publishTransferHistory(kind);
  }

  /**
   * Mirrors the manager's history list into NexusCore so the tree can render it.
   *
   * Pushes a defensive copy: the manager keeps mutating its own array in place,
   * and handing that same reference to the snapshot would let a consumer
   * observe entries appearing without a change event.
   */
  private publishTransferHistory(kind: NetworkServerKind): void {
    if (this.disposed) return;
    this.ensureRegistered(kind);
    this.core.setNetworkServerTransferHistory(kind, [...(this.transferHistory.get(kind) ?? [])]);
  }

  /**
   * Refreshes runtime immediately, cancelling any pending debounced refresh.
   *
   * The 150 ms debounce exists to absorb the progress-event storm of a fast
   * transfer; it must not delay the removal of a transfer that has ended.
   */
  private refreshRuntimeNow(kind: NetworkServerKind): void {
    const pending = this.refreshTimers.get(kind);
    if (pending) {
      clearTimeout(pending);
      this.refreshTimers.delete(kind);
    }
    void this.refreshRuntime(kind);
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
    id: transfer.id,
    filename: transfer.filename,
    direction: transfer.direction,
    // `client` is rendered daemon-side (`"hostname (ip)"`, or the bare IP when
    // reverse DNS found nothing) so the tree, the log and the connection toasts
    // all name a client identically. The port is dropped: it is the transfer's
    // ephemeral TID, meaningless to an operator, and `id` already carries it.
    peer: transfer.client,
    clientAddress: transfer.peer.address,
    clientHostname: transfer.clientHostname ?? undefined,
    bytes: transfer.bytes,
    totalBytes: transfer.totalBytes,
    speedBps: transfer.speedBps
  }));
  return { root: tftp.root, allowWrite: tftp.allowWrite, transfers };
}
