/**
 * Domain models for the Embedded Network Servers subsystem (TFTP + DHCP).
 *
 * Unlike Local Servers, these are **not** user-created profiles. There are
 * exactly two fixed singleton services, and everything the user can configure
 * lives in native VS Code settings under `nexus.networkServers.tftp.*` /
 * `nexus.networkServers.dhcp.*` — which VS Code itself persists. Nothing here
 * is written to `ConfigRepository`; the only state Nexus tracks is *runtime*
 * state, and only while a service is actually registered.
 *
 * Both services run inside a single shared daemon child process, so they can
 * bind privileged UDP ports (69 / 67) and crash without taking the extension
 * host with them.
 */

/** The two fixed services. There is no third, and no user-defined kind. */
export type NetworkServerKind = "tftp" | "dhcp";

/** Every service kind, in the order the UI lists them. */
export const NETWORK_SERVER_KINDS: readonly NetworkServerKind[] = ["tftp", "dhcp"];

/** Narrows an untrusted value (command argument, stored id) to a service kind. */
export function isNetworkServerKind(value: unknown): value is NetworkServerKind {
  return value === "tftp" || value === "dhcp";
}

/**
 * Lifecycle states, mirroring the daemon-side `ServerStatus` enum 1:1 so the
 * wire values pass straight through without a translation table.
 */
export type NetworkServerStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export type NetworkServerErrorCode =
  | "WorkspaceUntrusted"
  | "PrivilegedPortDenied"
  | "BindFailed"
  | "DaemonNotReady"
  | "DaemonSpawnFailed"
  | "InvalidConfiguration"
  | "ServerAlreadyRunning"
  | "ServerNotRunning"
  | "UnknownService";

export class NetworkServerError extends Error {
  public constructor(
    public readonly code: NetworkServerErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "NetworkServerError";
  }
}

/** One in-flight TFTP transfer, as rendered in the tree. */
export interface NetworkServerTransferSummary {
  /**
   * Stable identity of the transfer — the client's `address:port` (its TFTP
   * TID). This is what "Cancel Transfer" sends back down to the daemon.
   */
  readonly id: string;
  readonly filename: string;
  /** `rrq` = client is downloading, `wrq` = client is uploading. */
  readonly direction: "rrq" | "wrq";
  /**
   * Client as shown to the operator: `"hostname (ip)"` when reverse DNS
   * resolved, otherwise the bare IP. Rendered daemon-side so the tree, the logs
   * and the connection toasts never disagree about a client's name.
   */
  readonly peer: string;
  /** Raw client IPv4, always present even when `peer` carries a hostname. */
  readonly clientAddress: string;
  /** Reverse-DNS name, when one was resolved in time. */
  readonly clientHostname?: string;
  readonly bytes: number;
  /** Total size when known (`tsize` negotiated), otherwise `null`. */
  readonly totalBytes: number | null;
  readonly speedBps: number;
}

/**
 * One TFTP transfer that has already finished, as kept in the sidebar's
 * History list.
 *
 * Deliberately **not** a {@link NetworkServerTransferSummary}: a finished
 * transfer has no progress, no speed and no live identity to act on, and
 * carrying those fields around as permanently-stale numbers would invite a UI
 * to render them. What is left is what a user asks after the fact — what file,
 * from whom, and when.
 *
 * Transient by design: the list lives in memory in `NetworkServerManager` and
 * is never written through `ConfigRepository`. It is a record of what this
 * session of this service did, not a persistent audit log — and it is cleared
 * on every start/stop/restart precisely so it can never be read as one.
 */
export interface NetworkServerTransferHistoryEntry {
  /** The transfer's `address:port` TID — unique only among *live* transfers. */
  readonly id: string;
  /** Filename, when the emitting adapter reported one. */
  readonly filename?: string;
  /** Client as shown to the operator: `"hostname (ip)"`, or the bare IP. */
  readonly client: string;
  /** Epoch ms the transfer completed (host clock, i.e. when the event landed). */
  readonly timestamp: number;
}

/** One active DHCP lease, as rendered in the tree. */
export interface NetworkServerLeaseSummary {
  readonly mac: string;
  readonly ip: string;
  readonly hostname?: string;
  /** `static` for a configured MAC→IP reservation, `dynamic` for pool leases. */
  readonly leaseType: string;
  readonly remainingSec: number;
}

/**
 * Live detail behind a running service — everything a tree view needs to
 * render children and counters without issuing its own RPC.
 *
 * All fields are optional because the two services populate disjoint subsets:
 * TFTP fills `root`/`allowWrite`/`transfers`, DHCP fills
 * `leases`/`poolSize`/`activeLeaseCount`/`packetsReceived`.
 */
export interface NetworkServerRuntimeDetail {
  readonly root?: string;
  readonly allowWrite?: boolean;
  readonly transfers?: readonly NetworkServerTransferSummary[];
  readonly leases?: readonly NetworkServerLeaseSummary[];
  readonly poolSize?: number;
  readonly activeLeaseCount?: number;
  readonly utilizationPct?: number;
  readonly packetsReceived?: number;
}

/**
 * Runtime state NexusCore tracks for a registered network service.
 *
 * Keyed by {@link NetworkServerKind} rather than a generated session id: there
 * is at most one instance of each service, so the kind *is* the identity.
 */
export interface ActiveNetworkServerSession {
  readonly kind: NetworkServerKind;
  readonly status: NetworkServerStatus;
  /**
   * Port the service actually bound, which is not necessarily the configured
   * one — both adapters fall back to an unprivileged port (69 → 1069,
   * 67 → 1067) when they cannot acquire the IANA port. `null` while stopped.
   */
  readonly boundPort: number | null;
  /** Populated only when `status === "error"`. */
  readonly errorMessage?: string;
  /** Epoch ms of the last successful transition into `running`. */
  readonly startedAt?: number;
  readonly detail?: NetworkServerRuntimeDetail;
  /**
   * Transfers that finished during the current run, newest first — TFTP only.
   *
   * A sibling of `detail` rather than a field inside it: `detail` is replaced
   * wholesale by every daemon runtime refresh, and history is accumulated
   * host-side across those refreshes. Keeping it outside is what lets
   * {@link NexusCore.setNetworkServerRuntimeSnapshot} overwrite the runtime
   * without touching the history.
   */
  readonly transferHistory?: readonly NetworkServerTransferHistoryEntry[];
}
