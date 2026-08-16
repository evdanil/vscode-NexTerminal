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
  readonly filename: string;
  /** `rrq` = client is downloading, `wrq` = client is uploading. */
  readonly direction: "rrq" | "wrq";
  readonly peer: string;
  readonly bytes: number;
  /** Total size when known (`tsize` negotiated), otherwise `null`. */
  readonly totalBytes: number | null;
  readonly speedBps: number;
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
}
