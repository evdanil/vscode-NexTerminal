import * as net from "node:net";
import type { TunnelRegistryStore } from "../../core/contracts";
import type { NexusCore } from "../../core/nexusCore";
import type { ActiveTunnel, TunnelRegistryEntry } from "../../models/config";
import type { NetworkRouteIdentity } from "../ssh/sshNetworkRoute";
import { networkRoutesOverlap } from "../ssh/sshNetworkRoute";

const POLL_INTERVAL_MS = 3_000;
const PROBE_TIMEOUT_MS = 200;
const SLOW_REPROBE_INTERVAL_MS = 60_000;
/** Entries not refreshed within this window are considered stale. */
const STALE_THRESHOLD_MS = 30_000;

export type ProbePortFn = (port: number) => Promise<boolean>;

export interface RetiredReverseBindFence {
  fenceId: string;
  routeIdentity: NetworkRouteIdentity;
  remotePort: number;
  settled: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEndpointIdentity(value: unknown): { hosts: readonly string[]; port: number } | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.hosts) ||
    !value.hosts.every((host) => typeof host === "string") ||
    typeof value.port !== "number"
  ) {
    return undefined;
  }
  return { hosts: value.hosts, port: value.port };
}

function parseNetworkRouteIdentity(value: string): NetworkRouteIdentity | undefined {
  let route: unknown;
  try {
    route = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }

  const parse = (candidate: unknown, depth: number): NetworkRouteIdentity | undefined => {
    if (!isRecord(candidate) || depth > 32 || typeof candidate.kind !== "string") {
      return undefined;
    }
    if (candidate.kind === "unresolved") {
      return typeof candidate.serverId === "string"
        ? { kind: "unresolved", serverId: candidate.serverId }
        : undefined;
    }
    const endpoint = parseEndpointIdentity(candidate.endpoint);
    if (!endpoint) {
      return undefined;
    }
    if (candidate.kind === "direct") {
      return { kind: "direct", endpoint };
    }
    if (candidate.kind === "cycle") {
      return typeof candidate.serverId === "string"
        ? { kind: "cycle", serverId: candidate.serverId, endpoint }
        : undefined;
    }
    if (candidate.kind === "ssh") {
      const jump = parse(candidate.jump, depth + 1);
      return jump ? { kind: "ssh", endpoint, jump } : undefined;
    }
    if (candidate.kind === "socks5" || candidate.kind === "http") {
      return typeof candidate.proxyHost === "string" && typeof candidate.proxyPort === "number"
        ? { kind: candidate.kind, proxyHost: candidate.proxyHost, proxyPort: candidate.proxyPort, endpoint }
        : undefined;
    }
    return undefined;
  };

  return parse(route, 0);
}

function retiredRouteOverlaps(
  entry: TunnelRegistryEntry,
  routeIdentity: NetworkRouteIdentity,
  remotePort: number
): boolean {
  const retired = entry.retiredReverseBind;
  if (!retired || retired.remotePort !== remotePort) {
    return false;
  }
  const retiredRoute = parseNetworkRouteIdentity(retired.routeIdentity);
  return retiredRoute !== undefined && networkRoutesOverlap(retiredRoute, routeIdentity);
}

function defaultProbePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

export class TunnelRegistrySync {
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reprobeTimer: ReturnType<typeof setInterval> | undefined;
  private lastRemoteJson = "";
  private readonly probePort: ProbePortFn;
  private readonly unsettledReverseBindFenceIds = new Set<string>();

  public constructor(
    private readonly store: TunnelRegistryStore,
    private readonly core: NexusCore,
    private readonly sessionId: string,
    probePortFn?: ProbePortFn
  ) {
    this.probePort = probePortFn ?? defaultProbePort;
  }

  public async initialize(): Promise<void> {
    await this.syncWithProbe();
    this.pollTimer = setInterval(() => void this.syncFast(), POLL_INTERVAL_MS);
    this.reprobeTimer = setInterval(() => void this.syncWithProbe(), SLOW_REPROBE_INTERVAL_MS);
  }

  public async registerTunnel(tunnel: ActiveTunnel): Promise<void> {
    const entries = await this.store.getEntries();
    const entry: TunnelRegistryEntry = {
      profileId: tunnel.profileId,
      serverId: tunnel.serverId,
      localPort: tunnel.localPort,
      remoteIP: tunnel.remoteIP,
      remotePort: tunnel.remotePort,
      connectionMode: tunnel.connectionMode,
      tunnelType: tunnel.tunnelType,
      remoteBindAddress: tunnel.remoteBindAddress,
      localTargetIP: tunnel.localTargetIP,
      startedAt: tunnel.startedAt,
      ownerSessionId: this.sessionId,
      lastSeen: Date.now()
    };
    entries.push(entry);
    await this.saveEntries(entries);
  }

  public async unregisterTunnel(
    profileId: string,
    options?: { tunnel: ActiveTunnel; retiredReverseBind?: RetiredReverseBindFence }
  ): Promise<void> {
    const entries = await this.store.getEntries();
    const filtered = entries.filter(
      (e) => !(e.ownerSessionId === this.sessionId && e.profileId === profileId)
    );
    const fence = options?.retiredReverseBind;
    if (fence && options?.tunnel) {
      this.unsettledReverseBindFenceIds.add(fence.fenceId);
      const tunnel = options.tunnel;
      filtered.push({
        profileId: tunnel.profileId,
        serverId: tunnel.serverId,
        localPort: tunnel.localPort,
        remoteIP: tunnel.remoteIP,
        remotePort: tunnel.remotePort,
        connectionMode: tunnel.connectionMode,
        tunnelType: tunnel.tunnelType,
        remoteBindAddress: tunnel.remoteBindAddress,
        localTargetIP: tunnel.localTargetIP,
        startedAt: tunnel.startedAt,
        ownerSessionId: this.sessionId,
        lastSeen: Date.now(),
        retiredReverseBind: {
          fenceId: fence.fenceId,
          routeIdentity: JSON.stringify(fence.routeIdentity),
          remotePort: fence.remotePort
        }
      });
    }
    await this.saveEntries(filtered);

    if (fence) {
      void fence.settled.then(async () => {
        this.unsettledReverseBindFenceIds.delete(fence.fenceId);
        const current = await this.store.getEntries();
        const withoutFence = current.filter(
          (entry) =>
            !(entry.ownerSessionId === this.sessionId && entry.retiredReverseBind?.fenceId === fence.fenceId)
        );
        if (withoutFence.length !== current.length) {
          await this.saveEntries(withoutFence);
        }
      });
    }
  }

  public async checkRemoteOwnership(
    profileId: string,
    localPort: number,
    reverseBind?: { routeIdentity: NetworkRouteIdentity; remotePort: number }
  ): Promise<TunnelRegistryEntry | undefined> {
    const entries = await this.store.getEntries();
    const remote = entries.find(
      (entry) => {
        if (entry.ownerSessionId === this.sessionId) {
          return false;
        }
        if (entry.retiredReverseBind) {
          return reverseBind !== undefined &&
            retiredRouteOverlaps(entry, reverseBind.routeIdentity, reverseBind.remotePort);
        }
        return entry.profileId === profileId || entry.localPort === localPort;
      }
    );
    if (!remote) {
      return undefined;
    }
    // Reverse tunnels have no local listener to probe — use heartbeat staleness check
    if (remote.tunnelType === "reverse") {
      const lastSeen = remote.lastSeen ?? remote.startedAt;
      return Date.now() - lastSeen < STALE_THRESHOLD_MS ? remote : undefined;
    }
    const alive = await this.probePort(remote.localPort);
    return alive ? remote : undefined;
  }

  public async waitForRemoteReverseBindClear(
    reverseBind: { routeIdentity: NetworkRouteIdentity; remotePort: number },
    isCancelled: () => boolean
  ): Promise<boolean> {
    while (!isCancelled()) {
      const entries = await this.store.getEntries();
      const reserved = entries.some((entry) => {
        if (
          entry.ownerSessionId === this.sessionId ||
          !retiredRouteOverlaps(entry, reverseBind.routeIdentity, reverseBind.remotePort)
        ) {
          return false;
        }
        const lastSeen = entry.lastSeen ?? entry.startedAt;
        return Date.now() - lastSeen < STALE_THRESHOLD_MS;
      });
      if (!reserved) {
        return true;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  public async syncNow(): Promise<void> {
    await this.syncFast();
  }

  public async cleanupOwnEntries(): Promise<void> {
    const entries = await this.store.getEntries();
    const filtered = entries.filter((e) => e.ownerSessionId !== this.sessionId);
    await this.saveEntries(filtered);
  }

  public dispose(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.reprobeTimer !== undefined) {
      clearInterval(this.reprobeTimer);
      this.reprobeTimer = undefined;
    }
  }

  private async syncFast(): Promise<void> {
    const entries = await this.store.getEntries();
    const remote = entries.filter((e) => e.ownerSessionId !== this.sessionId && !e.retiredReverseBind);
    const remoteJson = JSON.stringify(remote);
    if (remoteJson !== this.lastRemoteJson) {
      this.lastRemoteJson = remoteJson;
      this.core.setRemoteTunnels(remote);
    }

    // Heartbeat: refresh lastSeen on own entries + self-heal missing entries
    const now = Date.now();
    const activeTunnels = this.core.getSnapshot().activeTunnels;
    const ownEntries = entries.filter((e) => e.ownerSessionId === this.sessionId);
    let changed = false;

    // Update lastSeen on existing own entries
    for (const entry of ownEntries) {
      if (entry.retiredReverseBind || activeTunnels.some((t) => t.profileId === entry.profileId)) {
        entry.lastSeen = now;
        changed = true;
      }
    }

    // Self-heal: re-register own active tunnels if missing from registry
    const missingOwn = activeTunnels.filter(
      (t) => !ownEntries.some((e) => e.profileId === t.profileId)
    );
    if (missingOwn.length > 0) {
      for (const tunnel of missingOwn) {
        entries.push({
          profileId: tunnel.profileId,
          serverId: tunnel.serverId,
          localPort: tunnel.localPort,
          remoteIP: tunnel.remoteIP,
          remotePort: tunnel.remotePort,
          connectionMode: tunnel.connectionMode,
          tunnelType: tunnel.tunnelType,
          remoteBindAddress: tunnel.remoteBindAddress,
          localTargetIP: tunnel.localTargetIP,
          startedAt: tunnel.startedAt,
          ownerSessionId: this.sessionId,
          lastSeen: now
        });
      }
      changed = true;
    }

    if (changed) {
      await this.saveEntries(entries);
    }
  }

  private async syncWithProbe(): Promise<void> {
    const entries = await this.store.getEntries();
    const remote = entries.filter((e) => e.ownerSessionId !== this.sessionId && !e.retiredReverseBind);
    const remoteForProbe = entries.filter((e) => e.ownerSessionId !== this.sessionId);
    const now = Date.now();

    // Probe all remote entries concurrently.
    // Reverse tunnels have no local listener to probe — use lastSeen heartbeat instead.
    // Entries without lastSeen (pre-heartbeat) are given a grace period from startedAt.
    const probeResults = await Promise.all(
      remoteForProbe.map(async (e) => {
        if (e.tunnelType === "reverse") {
          const lastSeen = e.lastSeen ?? e.startedAt;
          return { entry: e, alive: now - lastSeen < STALE_THRESHOLD_MS };
        }
        return { entry: e, alive: await this.probePort(e.localPort) };
      })
    );
    const staleProfileIds = new Set(
      probeResults.filter((r) => !r.alive).map((r) => `${r.entry.ownerSessionId}:${r.entry.profileId}`)
    );

    if (staleProfileIds.size > 0) {
      const cleaned = entries.filter(
        (e) => !staleProfileIds.has(`${e.ownerSessionId}:${e.profileId}`)
      );
      await this.saveEntries(cleaned);
      const cleanedRemote = cleaned.filter((e) => e.ownerSessionId !== this.sessionId && !e.retiredReverseBind);
      this.lastRemoteJson = JSON.stringify(cleanedRemote);
      this.core.setRemoteTunnels(cleanedRemote);
    } else {
      const remoteJson = JSON.stringify(remote);
      if (remoteJson !== this.lastRemoteJson) {
        this.lastRemoteJson = remoteJson;
        this.core.setRemoteTunnels(remote);
      }
    }
  }

  private async saveEntries(entries: TunnelRegistryEntry[]): Promise<void> {
    // A read may return an old whole-array snapshot after settlement removed a
    // fence. Keep the in-memory settlement state authoritative on every write.
    await this.store.saveEntries(entries.filter((entry) =>
      entry.ownerSessionId !== this.sessionId ||
      !entry.retiredReverseBind ||
      this.unsettledReverseBindFenceIds.has(entry.retiredReverseBind.fenceId)
    ));
  }
}
