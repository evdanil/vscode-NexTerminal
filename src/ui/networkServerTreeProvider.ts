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
  NetworkServerTransferSummary
} from "../models/networkServer";
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
 * Status → icon/colour, mirroring `localServerStatusIcon` in
 * `nexusTreeProvider.ts` so both server surfaces read identically.
 *
 * `icon` is only set for the transitional states: a spinner is the one thing a
 * static colour cannot express, and those are exactly the states where the user
 * is waiting on something. Every other state keeps the service's own codicon.
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
  public constructor(
    public readonly kind: NetworkServerKind,
    public readonly session: ActiveNetworkServerSession | undefined,
    port: number
  ) {
    super(SERVICE_LABELS[kind], vscode.TreeItemCollapsibleState.Collapsed);
    const status = session?.status ?? "stopped";
    const visuals = networkServerStatusVisuals(status);
    this.id = `networkServer:${kind}`;
    this.contextValue = `nexus.networkServer.${status}`;
    this.description = `${visuals.description} · UDP ${String(port)}`;
    this.iconPath = new vscode.ThemeIcon(visuals.icon ?? SERVICE_ICONS[kind], visuals.color);
    const tooltipLines = [`${SERVICE_LABELS[kind]} — ${visuals.description}`, `Port: UDP ${String(port)}`];
    if (session?.startedAt) {
      tooltipLines.push(`Started: ${new Date(session.startedAt).toLocaleString()}`);
    }
    if (session?.errorMessage) {
      tooltipLines.push(`Error: ${session.errorMessage}`);
    }
    this.tooltip = tooltipLines.join("\n");
  }
}

export class NetworkServerDetailTreeItem extends vscode.TreeItem {
  public readonly children: readonly NetworkServerDetailTreeItem[];

  public constructor(
    id: string,
    label: string,
    options?: {
      description?: string;
      tooltip?: string;
      icon?: string;
      children?: readonly NetworkServerDetailTreeItem[];
    }
  ) {
    const children = options?.children ?? [];
    super(
      label,
      children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    this.id = id;
    this.children = children;
    this.contextValue = "nexus.networkServerDetail";
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
    return new NetworkServerRootTreeItem(kind, session, session?.boundPort ?? configuredPort);
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
    return rows;
  }

  private buildDhcpChildren(root: NetworkServerRootTreeItem): NetworkServerDetailTreeItem[] {
    const detail = root.session?.detail;
    const config = readDhcpConfig();
    const leaseTimeSec = config.leaseTimeSec ?? 86_400;
    const rows: NetworkServerDetailTreeItem[] = [
      new NetworkServerDetailTreeItem("networkServer:dhcp:pool", "DHCP Pool", {
        description: `${config.rangeStart ?? "192.168.2.10"} → ${config.rangeEnd ?? "192.168.2.199"}`,
        icon: "globe",
        tooltip: [
          `Subnet: ${config.subnet ?? "255.255.255.0"}`,
          `Gateway: ${config.gateway ?? "192.168.2.1"}`,
          `DNS: ${config.dns?.join(", ") ?? "8.8.8.8, 8.8.4.4"}`
        ].join("\n")
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
    return new NetworkServerDetailTreeItem(
      `networkServer:tftp:transfer:${String(index)}:${transfer.peer}`,
      transfer.filename,
      {
        description: `${transfer.peer} · ${progress}${speed}`,
        icon: transfer.direction === "wrq" ? "arrow-up" : "arrow-down",
        tooltip: [
          `${transfer.direction === "wrq" ? "Upload (WRQ)" : "Download (RRQ)"} — ${transfer.filename}`,
          `Peer: ${transfer.peer}`,
          `Transferred: ${progress}`
        ].join("\n")
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
