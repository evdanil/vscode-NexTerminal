/**
 * Tree view for the Embedded Network Servers (TFTP + DHCP).
 *
 * Renders exclusively from `NexusCore`'s snapshot — the daemon is never
 * queried from here. `NetworkServerManager.refreshRuntime()` already pushes
 * debounced runtime detail into the core, so a view that issued its own RPC on
 * expansion would duplicate that traffic and could hang the tree behind a
 * timeout. Settings are read directly (they are synchronous and always
 * available), which is what lets the two root nodes and their configuration
 * rows render before either service has ever been started.
 */

import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";
import type {
  ActiveNetworkServerSession,
  NetworkServerKind,
  NetworkServerLeaseSummary,
  NetworkServerRuntimeDetail,
  NetworkServerStatus,
  NetworkServerTransferHistoryEntry,
  NetworkServerTransferSummary
} from "../models/networkServer";
import { networkInterfaceBindOptions } from "../commands/networkInterfaceOptions";
import { dhcpCurrentCidr, dhcpInterfaceSubnetStatus } from "../commands/networkServerSettings";
import {
  NETWORK_SERVER_KINDS,
  readDhcpConfig,
  readTftpConfig
} from "../services/networkServers/networkServerManager";
import { formatBytes } from "../utils/helpers";

/** DHCP always binds the IANA port; only TFTP exposes a port setting. */
const DHCP_IANA_PORT = 67;

const SERVICE_LABELS: Record<NetworkServerKind, string> = {
  tftp: "TFTP",
  dhcp: "DHCP"
};

/** Root codicon per service — status is carried by colour plus `description`. */
const SERVICE_ICONS: Record<NetworkServerKind, string> = {
  tftp: "radio-tower",
  dhcp: "broadcast"
};

/**
 * Status → icon/colour, following the same status-to-visual conventions the
 * other Nexus tree surfaces use so every view reads identically.
 *
 * `icon` is set only where the service's own codicon would understate what is
 * going on: a spinner for the transitional states (the one thing a static
 * colour cannot express, and exactly where the user is waiting on something),
 * and a warning/error glyph where the row is reporting a fault.
 */
function networkServerStatusVisuals(status: NetworkServerStatus): {
  icon?: string;
  color: vscode.ThemeColor;
  description: string;
} {
  switch (status) {
    case "running":
      return { color: new vscode.ThemeColor("testing.iconPassed"), description: "running" };
    case "starting":
      return { icon: "sync~spin", color: new vscode.ThemeColor("testing.iconQueued"), description: "starting" };
    case "stopping":
      return { icon: "sync~spin", color: new vscode.ThemeColor("testing.iconQueued"), description: "stopping" };
    case "error":
      return { icon: "error", color: new vscode.ThemeColor("testing.iconFailed"), description: "error" };
    case "stopped":
    default:
      return { color: new vscode.ThemeColor("testing.iconUnset"), description: "stopped" };
  }
}

/**
 * Whether a running service is bound somewhere its clients will not look.
 *
 * Both adapters answer an `EACCES` on the IANA port by binding an unprivileged
 * one instead (69 → 1069, 67 → 1067) rather than failing to start. That keeps
 * the service usable for a client you can point at a port — but TFTP and DHCP
 * clients target the well-known port, and a DHCP client cannot be redirected at
 * all, so in the ordinary case the service is up and unreachable. A plain green
 * "running" is the one thing the row must not say about that.
 *
 * The test is "bound somewhere other than where it was asked to bind", not a
 * comparison against the literal 1069/1067: a user who deliberately configures
 * TFTP on 6969 gets exactly that port and is not degraded, and any future
 * fallback target is covered without a second constant to keep in sync.
 */
function isFallbackPortBind(
  status: NetworkServerStatus,
  boundPort: number | null | undefined,
  configuredPort: number
): boolean {
  return status === "running" && typeof boundPort === "number" && boundPort !== configuredPort;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "expired";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
  if (minutes > 0) return `${String(minutes)}m`;
  return `${String(Math.floor(seconds))}s`;
}

function formatLeaseTime(seconds: number): string {
  return `${formatDuration(seconds)} (${String(seconds)}s)`;
}

export class NetworkServerRootTreeItem extends vscode.TreeItem {
  /**
   * @param configuredPort Port the service was asked to bind — TFTP's `port`
   *   setting, or DHCP's fixed IANA 67. The row shows the port actually bound
   *   once there is one, and compares the two to spot a fallback bind.
   */
  public constructor(
    public readonly kind: NetworkServerKind,
    public readonly session: ActiveNetworkServerSession | undefined,
    configuredPort: number
  ) {
    super(SERVICE_LABELS[kind], vscode.TreeItemCollapsibleState.Collapsed);
    const status = session?.status ?? "stopped";
    const visuals = networkServerStatusVisuals(status);
    const port = session?.boundPort ?? configuredPort;
    const onFallbackPort = isFallbackPortBind(status, session?.boundPort, configuredPort);
    this.id = `networkServer:${kind}`;
    this.contextValue = `nexus.networkServer.${status}`;
    // The same inline "⚠ …" idiom the Lease Time row uses for a nearly
    // exhausted pool: the service really is running, so the row keeps saying
    // so, with the caveat that makes the difference attached to it.
    this.description = onFallbackPort
      ? `${visuals.description} · UDP ${String(port)} · ⚠ fallback port`
      : `${visuals.description} · UDP ${String(port)}`;
    this.iconPath = new vscode.ThemeIcon(
      onFallbackPort ? "warning" : (visuals.icon ?? SERVICE_ICONS[kind]),
      onFallbackPort ? new vscode.ThemeColor("testing.iconQueued") : visuals.color
    );
    const tooltipLines = [`${SERVICE_LABELS[kind]} — ${visuals.description}`, `Port: UDP ${String(port)}`];
    if (onFallbackPort) {
      tooltipLines.push(
        `Wanted UDP ${String(configuredPort)} but could not bind it (a privileged port needs Administrator/root), so it fell back to ${String(port)}.`,
        `${SERVICE_LABELS[kind]} clients target UDP ${String(configuredPort)}, so ordinary clients will not reach this service${kind === "dhcp" ? " — a DHCP client cannot be pointed at another port at all" : " unless you can point them at port " + String(port)}.`,
        `Restart VS Code with elevated privileges to bind UDP ${String(configuredPort)}.`
      );
    }
    if (session?.startedAt) {
      tooltipLines.push(`Started: ${new Date(session.startedAt).toLocaleString()}`);
    }
    if (session?.errorMessage) {
      tooltipLines.push(`Error: ${session.errorMessage}`);
    }
    this.tooltip = tooltipLines.join("\n");
    // Clicking the row opens the quick editor (and, as VS Code always does for
    // a collapsible item, also toggles the row). The kind is passed rather than
    // `this`: the command only ever needs the service, and a tree item bound
    // into `arguments` would keep a stale snapshot alive past its refresh.
    this.command = {
      command: "nexus.networkServer.quickAdjust",
      title: "Quick Settings",
      arguments: [kind]
    };
  }
}

/**
 * `contextValue` marking a row as a live TFTP transfer, which is what the
 * "Cancel Transfer" menu entry gates on in package.json.
 *
 * Intentionally outside the `nexus.networkServer.` prefix: the service-level
 * menu entries match that prefix with a regex, and reusing it here would put
 * Start / Stop / Quick Settings on a transfer row.
 */
export const NETWORK_SERVER_TRANSFER_CONTEXT = "nexus.networkServerTransfer.active";

/**
 * `contextValue` of the TFTP "History" group — what the "Clear History" menu
 * entry gates on.
 *
 * Kept outside the `nexus.networkServer.` prefix for the same reason as
 * {@link NETWORK_SERVER_TRANSFER_CONTEXT}: that prefix is regex-matched by the
 * service-level menu entries and would otherwise offer Start / Stop on this
 * node.
 */
export const NETWORK_SERVER_HISTORY_CONTEXT = "nexus.networkServerHistory.group";

export class NetworkServerDetailTreeItem extends vscode.TreeItem {
  public readonly children: readonly NetworkServerDetailTreeItem[];
  /**
   * TFTP transfer id (`address:port`) when this row *is* a transfer — the
   * handle "Cancel Transfer" needs. Undefined on every other detail row.
   */
  public readonly transferId?: string;

  public constructor(
    id: string,
    label: string,
    options?: {
      description?: string;
      tooltip?: string;
      icon?: string;
      children?: readonly NetworkServerDetailTreeItem[];
      /**
       * Overrides the default detail `contextValue`. Kept out of the
       * `nexus.networkServer.` namespace by callers, because the service-level
       * menu entries match that prefix and would otherwise offer Start/Stop on
       * a detail row.
       */
      contextValue?: string;
      transferId?: string;
    }
  ) {
    const children = options?.children ?? [];
    super(
      label,
      children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    this.id = id;
    this.children = children;
    this.transferId = options?.transferId;
    this.contextValue = options?.contextValue ?? "nexus.networkServerDetail";
    this.description = options?.description;
    this.tooltip = options?.tooltip ?? options?.description;
    if (options?.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    }
  }
}

export type NetworkServerTreeItem = NetworkServerRootTreeItem | NetworkServerDetailTreeItem;

export class NetworkServerTreeProvider implements vscode.TreeDataProvider<NetworkServerTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NetworkServerTreeItem | undefined>();
  private sessions: readonly ActiveNetworkServerSession[] = [];

  public readonly onDidChangeTreeData: vscode.Event<NetworkServerTreeItem | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  public setSnapshot(snapshot: SessionSnapshot): void {
    this.sessions = snapshot.activeNetworkServerSessions;
    this.refresh();
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: NetworkServerTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: NetworkServerTreeItem): vscode.ProviderResult<NetworkServerTreeItem[]> {
    if (!element) {
      return NETWORK_SERVER_KINDS.map((kind) => this.toRootItem(kind));
    }
    if (element instanceof NetworkServerDetailTreeItem) {
      return [...element.children];
    }
    return element.kind === "tftp" ? this.buildTftpChildren(element) : this.buildDhcpChildren(element);
  }

  private sessionFor(kind: NetworkServerKind): ActiveNetworkServerSession | undefined {
    return this.sessions.find((session) => session.kind === kind);
  }

  private toRootItem(kind: NetworkServerKind): NetworkServerRootTreeItem {
    const session = this.sessionFor(kind);
    const configuredPort = kind === "tftp" ? readTftpConfig().port ?? 69 : DHCP_IANA_PORT;
    return new NetworkServerRootTreeItem(kind, session, configuredPort);
  }

  private buildTftpChildren(root: NetworkServerRootTreeItem): NetworkServerDetailTreeItem[] {
    const detail = root.session?.detail;
    const config = readTftpConfig();
    const rows: NetworkServerDetailTreeItem[] = [
      new NetworkServerDetailTreeItem("networkServer:tftp:root", "Root Directory", {
        description: detail?.root ?? config.root ?? "~/Nexus/tftp-root (default)",
        icon: "folder",
        tooltip: detail?.root
          ? `Served directory reported by the running service:\n${detail.root}`
          : "Configured directory. The running service reports the path it actually resolved."
      }),
      new NetworkServerDetailTreeItem("networkServer:tftp:mode", "Access Mode", {
        description: (detail?.allowWrite ?? config.allowWrite) ? "Read/Write (RW)" : "Read Only (RO)",
        icon: "lock",
        tooltip: "TFTP has no authentication — write access exposes the root to any host that can reach the port."
      })
    ];

    if (!detail) {
      rows.push(this.noLiveDataRow("tftp"));
      return rows;
    }

    rows.push(this.transfersGroup(detail.transfers ?? []));
    rows.push(this.transferHistoryGroup(root.session?.transferHistory ?? []));
    return rows;
  }

  private buildDhcpChildren(root: NetworkServerRootTreeItem): NetworkServerDetailTreeItem[] {
    const detail = root.session?.detail;
    const config = readDhcpConfig();
    const leaseTimeSec = config.leaseTimeSec ?? 86_400;
    const offSubnet = this.dhcpBindMismatch(config);
    const tooltip = [
      `Subnet: ${config.subnet ?? "255.255.255.0"}`,
      `Gateway: ${config.gateway ?? "192.168.2.1"}`,
      `DNS: ${config.dns?.join(", ") ?? "8.8.8.8, 8.8.4.4"}`
    ];
    if (offSubnet) {
      const network = offSubnet.cidr ? ` (${offSubnet.cidr})` : "";
      tooltip.push(
        "",
        ...(offSubnet.bindAddress === undefined
          ? [
              `⚠ No interface on this machine is on this pool's subnet${network}.`,
              "The service is listening on every interface, but none of them is on the wire these addresses belong to, so no client request can reach it. Change the pool to a network this machine is on — or turn on Serve relayed requests, if a relay agent forwards them here."
            ]
          : [
              `⚠ The service is bound to ${offSubnet.bindAddress}, which is not on this pool's subnet${network}.`,
              "Clients on the bound wire will be offered addresses they cannot use. Change the Interface setting, or the pool, so the two agree."
            ])
      );
    }
    const offSubnetNote = !offSubnet
      ? ""
      : offSubnet.bindAddress === undefined
        ? " · ⚠ no NIC is on this subnet"
        : " · ⚠ bound NIC is not on this subnet";
    const rows: NetworkServerDetailTreeItem[] = [
      new NetworkServerDetailTreeItem("networkServer:dhcp:pool", "DHCP Pool", {
        description: `${config.rangeStart ?? "192.168.2.10"} → ${config.rangeEnd ?? "192.168.2.199"}${offSubnetNote}`,
        icon: "globe",
        tooltip: tooltip.join("\n")
      }),
      new NetworkServerDetailTreeItem("networkServer:dhcp:lease", "Lease Time", {
        description: this.leaseUtilizationDescription(leaseTimeSec, detail),
        icon: "clock",
        tooltip:
          typeof detail?.packetsReceived === "number"
            ? `Packets received: ${String(detail.packetsReceived)}`
            : `Lease duration handed to clients (option 51): ${formatLeaseTime(leaseTimeSec)}`
      })
    ];

    const boot = this.bootOptionsRow(config);
    if (boot) {
      rows.push(boot);
    }

    if (detail) {
      rows.push(this.leasesGroup(detail.leases ?? []));
    } else {
      rows.push(this.noLiveDataRow("dhcp"));
    }

    rows.push(this.staticLeasesGroup(config.static));
    return rows;
  }

  /**
   * Whether the NIC the service binds is off the subnet the pool hands out.
   *
   * Advisory only — nothing here gates starting the service. The configuration
   * is legal, it is even correct behind a relay agent (which is why
   * `allowRelayAgents` suppresses the row entirely), and the daemon is the wrong
   * place to be second-guessed from a tree view. But a lab that binds
   * `192.168.1.x` and offers `10.0.0.x` leases looks perfectly configured in
   * every individual row, so the pair is worth naming where the pool is shown.
   *
   * The NIC list is a snapshot taken as the row renders — the tree already
   * refreshes on every core change, and a watcher for NIC arrivals would be a
   * subscription paying for a case the next refresh covers anyway.
   *
   * An all-interfaces bind is warned about too, and reports `bindAddress:
   * undefined`: there is no bound address to name, but "listening everywhere"
   * is not "reachable everywhere" — with no NIC on the pool's wire the service
   * is as unreachable as one bound to the wrong NIC, and this row was silent
   * about it.
   */
  private dhcpBindMismatch(
    config: ReturnType<typeof readDhcpConfig>
  ): { bindAddress: string | undefined; cidr: string | undefined } | undefined {
    const bindAddress = config.bindAddress;
    // The pool's configured END is passed too, so the row asks about the
    // addresses this pool really hands out rather than about the whole
    // advertised subnet. A pool deliberately confined to part of its subnet —
    // `10.0.0.130`–`10.0.0.200` inside a `/24` — is entirely reachable from a
    // `10.0.0.254/25` NIC, and warning about that arrangement sent the user
    // looking for a fault that was not there.
    const status = dhcpInterfaceSubnetStatus(
      bindAddress,
      config.subnet,
      config.rangeStart,
      networkInterfaceBindOptions(),
      config.allowRelayAgents === true,
      config.rangeEnd
    );
    if (status === "all-interfaces-off-subnet") {
      return { bindAddress: undefined, cidr: dhcpCurrentCidr(config.rangeStart, config.subnet) };
    }
    // `!bindAddress` stays: "mismatch" is only ever answered for an address the
    // machine actually holds, but the row's own sentence names it, so a status
    // reached without one would render a warning about nothing.
    if (status !== "mismatch" || !bindAddress) return undefined;
    return { bindAddress, cidr: dhcpCurrentCidr(config.rangeStart, config.subnet) };
  }

  private leaseUtilizationDescription(leaseTimeSec: number, detail: NetworkServerRuntimeDetail | undefined): string {
    const base = formatLeaseTime(leaseTimeSec);
    if (typeof detail?.poolSize !== "number") {
      return base;
    }
    const active = detail.activeLeaseCount ?? 0;
    const pct = detail.utilizationPct ?? 0;
    // The original add-on flagged an exhausted pool inline; a lab pool running
    // out is the failure the user is least likely to guess at from the symptom.
    const warning = pct > 85 ? " · ⚠ pool nearly exhausted" : "";
    return `${base} · ${String(active)}/${String(detail.poolSize)} used (${pct.toFixed(1)}%)${warning}`;
  }

  /**
   * What a ZTP client will actually be told to boot, or nothing at all.
   *
   * The row is omitted when no boot option is configured — most labs hand out
   * addresses and no more, and an always-present "not configured" row is noise.
   * The addresses come from `readDhcpConfig`, so an auto-linked TFTP interface
   * shows the address that will really be advertised rather than the blank
   * setting behind it, and a vendor-class filter is called out because it is
   * the reason a correctly-configured boot server reaches nothing.
   */
  private bootOptionsRow(config: ReturnType<typeof readDhcpConfig>): NetworkServerDetailTreeItem | undefined {
    const server = config.nextServer ?? config.tftpServerAddresses?.[0];
    if (!config.bootFileName && !server) {
      return undefined;
    }
    const description = config.bootFileName
      ? server
        ? `${config.bootFileName} via ${server}`
        : `${config.bootFileName} · no boot server set`
      : `${server ?? ""} · no boot file set`;
    const tooltip = [
      `Boot file (option 67): ${config.bootFileName ?? "not set"}`,
      `Boot server (option 66): ${config.nextServer ?? "not set"}`,
      `TFTP servers (option 150): ${config.tftpServerAddresses?.join(", ") ?? "not set"}`,
      `Vendor class filter (option 60): ${config.vendorClassId ?? "all clients"}`
    ];
    if (config.vendorSpecificOptions && config.vendorSpecificOptions.length > 0) {
      tooltip.push(
        `Vendor-specific (option 43): ${config.vendorSpecificOptions
          .map((entry) => `${String(entry.subOption)}=${entry.value}`)
          .join(", ")}`
      );
    }
    return new NetworkServerDetailTreeItem("networkServer:dhcp:boot", "Boot / ZTP", {
      description: config.vendorClassId ? `${description} · only "${config.vendorClassId}"` : description,
      icon: "rocket",
      tooltip: tooltip.join("\n")
    });
  }

  private noLiveDataRow(kind: NetworkServerKind): NetworkServerDetailTreeItem {
    return new NetworkServerDetailTreeItem(`networkServer:${kind}:noData`, "No live data yet", {
      description: "Start the service to see live activity",
      icon: "info",
      tooltip: "Runtime detail appears once the service is running and reports its first update."
    });
  }

  private transfersGroup(transfers: readonly NetworkServerTransferSummary[]): NetworkServerDetailTreeItem {
    if (transfers.length === 0) {
      return new NetworkServerDetailTreeItem("networkServer:tftp:transfers", "Active Transfers (0)", {
        description: "No active transfers",
        icon: "list-flat",
        tooltip: "Send or request a file for it to appear here."
      });
    }
    const children = transfers.map((transfer, index) => this.transferRow(transfer, index));
    return new NetworkServerDetailTreeItem(
      "networkServer:tftp:transfers",
      `Active Transfers (${String(transfers.length)})`,
      { icon: "list-flat", tooltip: `${String(transfers.length)} TFTP sessions in progress`, children }
    );
  }

  private transferRow(transfer: NetworkServerTransferSummary, index: number): NetworkServerDetailTreeItem {
    const progress =
      transfer.totalBytes && transfer.totalBytes > 0
        ? `${String(Math.round((transfer.bytes / transfer.totalBytes) * 100))}% · ${formatBytes(transfer.bytes)}/${formatBytes(transfer.totalBytes)}`
        : formatBytes(transfer.bytes);
    const speed = transfer.speedBps > 0 ? ` · ${formatBytes(Math.round(transfer.speedBps))}/s` : "";
    // `transfer.peer` already arrives in the one display format the whole
    // feature uses — `"hostname (ip)"` when reverse DNS resolved, bare IP
    // otherwise — so nothing is reformatted here.
    return new NetworkServerDetailTreeItem(
      `networkServer:tftp:transfer:${String(index)}:${transfer.id}`,
      transfer.filename,
      {
        description: `${transfer.peer} · ${progress}${speed}`,
        icon: transfer.direction === "wrq" ? "arrow-up" : "arrow-down",
        tooltip: [
          `${transfer.direction === "wrq" ? "Upload (WRQ)" : "Download (RRQ)"} — ${transfer.filename}`,
          `Client: ${transfer.peer}`,
          `Transferred: ${progress}`
        ].join("\n"),
        contextValue: NETWORK_SERVER_TRANSFER_CONTEXT,
        transferId: transfer.id
      }
    );
  }

  /**
   * Builds the "History" group: transfers that already finished this run.
   *
   * A sibling of "Active Transfers" rather than a section inside it — a
   * finished transfer is not a row you can act on, and mixing the two would put
   * "Cancel Transfer" one mis-click away from an entry it cannot affect.
   *
   * Collapsed by default even when populated: during a ZTP boot this fills with
   * dozens of entries, and an expanded list would push the DHCP root off
   * screen. {@link NetworkServerDetailTreeItem} expands any node with children,
   * so the state is overridden here.
   */
  private transferHistoryGroup(
    history: readonly NetworkServerTransferHistoryEntry[]
  ): NetworkServerDetailTreeItem {
    if (history.length === 0) {
      return new NetworkServerDetailTreeItem("networkServer:tftp:history", "History (0)", {
        description: "No completed transfers",
        icon: "history",
        tooltip: "Completed transfers appear here. The list is cleared when the service is started, stopped or restarted.",
        contextValue: NETWORK_SERVER_HISTORY_CONTEXT
      });
    }
    const item = new NetworkServerDetailTreeItem(
      "networkServer:tftp:history",
      `History (${String(history.length)})`,
      {
        icon: "history",
        tooltip: `${String(history.length)} completed transfers this run — cleared on start, stop and restart.`,
        children: history.map((entry, index) => this.historyRow(entry, index)),
        contextValue: NETWORK_SERVER_HISTORY_CONTEXT
      }
    );
    item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    return item;
  }

  private historyRow(entry: NetworkServerTransferHistoryEntry, index: number): NetworkServerDetailTreeItem {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    // The adapter reports a filename for every real transfer; the fallback only
    // covers an event that arrived without one, and says so rather than
    // rendering an empty row.
    const filename = entry.filename ?? "(unnamed file)";
    return new NetworkServerDetailTreeItem(
      `networkServer:tftp:history:${String(index)}:${entry.id}`,
      filename,
      {
        // `entry.client` is the same pre-rendered `"hostname (ip)"` string the
        // live rows and toasts use, so a client reads identically everywhere.
        description: `${entry.client} · ${time}`,
        icon: "check",
        tooltip: [`Completed: ${filename}`, `Client: ${entry.client}`, `Finished: ${new Date(entry.timestamp).toLocaleString()}`].join("\n")
      }
    );
  }

  private leasesGroup(leases: readonly NetworkServerLeaseSummary[]): NetworkServerDetailTreeItem {
    if (leases.length === 0) {
      return new NetworkServerDetailTreeItem("networkServer:dhcp:leases", "Active Leases (0)", {
        description: "No active leases",
        icon: "list-flat",
        tooltip: "Connect a DHCP client for its lease to appear here."
      });
    }
    const children = leases.map((lease, index) => this.leaseRow(lease, index));
    return new NetworkServerDetailTreeItem(
      "networkServer:dhcp:leases",
      `Active Leases (${String(leases.length)})`,
      { icon: "list-flat", tooltip: `${String(leases.length)} devices`, children }
    );
  }

  private leaseRow(lease: NetworkServerLeaseSummary, index: number): NetworkServerDetailTreeItem {
    const suffix = lease.hostname ? ` (${lease.hostname})` : "";
    return new NetworkServerDetailTreeItem(
      `networkServer:dhcp:lease:${String(index)}:${lease.mac}`,
      lease.ip,
      {
        description: `${lease.mac}${suffix} · ${lease.leaseType} · ${formatDuration(lease.remainingSec)} left`,
        icon: "device-desktop",
        tooltip: [
          `IP: ${lease.ip}`,
          `MAC: ${lease.mac}`,
          `Hostname: ${lease.hostname ?? "n/a"}`,
          `Type: ${lease.leaseType}`,
          `Remaining: ${formatDuration(lease.remainingSec)}`
        ].join("\n")
      }
    );
  }

  /**
   * Configured MAC→IP reservations, rendered whether or not DHCP is running —
   * this is a settings surface, and the point of showing it is to let the user
   * confirm a reservation exists *before* the client asks for it.
   */
  private staticLeasesGroup(staticLeases: Readonly<Record<string, string>> | undefined): NetworkServerDetailTreeItem {
    const entries = Object.entries(staticLeases ?? {});
    if (entries.length === 0) {
      return new NetworkServerDetailTreeItem("networkServer:dhcp:static", "Static Leases (0)", {
        description: "No static reservations configured",
        icon: "pinned",
        tooltip: "Add MAC → IP reservations from Edit Settings on the DHCP service."
      });
    }
    const children = entries.map(
      ([mac, ip]) =>
        new NetworkServerDetailTreeItem(`networkServer:dhcp:static:${mac}`, ip, {
          description: mac,
          icon: "pinned",
          tooltip: `Reserved ${ip} for ${mac}`
        })
    );
    return new NetworkServerDetailTreeItem(
      "networkServer:dhcp:static",
      `Static Leases (${String(entries.length)})`,
      { icon: "pinned", tooltip: `${String(entries.length)} reservations`, children }
    );
  }
}
