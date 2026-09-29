import * as net from "node:net";
import type { TunnelRegistryStore } from "../../core/contracts";
import type { NexusCore } from "../../core/nexusCore";
import type { ActiveTunnel, TunnelRegistryEntry } from "../../models/config";
import type { NetworkRouteIdentity } from "../ssh/sshNetworkRoute";
import { networkRoutesOverlap } from "../ssh/sshNetworkRoute";

const POLL_INTERVAL_MS = 3_000;
const PROBE_TIMEOUT_MS = 200;
const SLOW_REPROBE_INTERVAL_MS = 60_000;
const SHUTDOWN_FENCE_SETTLE_GRACE_MS = 2_000;
/** Entries not refreshed within this window are considered stale. */
const STALE_THRESHOLD_MS = 30_000;

export type ProbePortFn = (port: number) => Promise<boolean>;

export interface RetiredReverseBindFence {
  fenceId: string;
  routeIdentity: NetworkRouteIdentity;
  remotePort: number;
  settled: Promise<void>;
  allocatedPort?: Promise<number | undefined>;
}

export async function stopTunnelsForShutdown(
  stopAll: () => Promise<void>,
  unsubscribeTunnel: () => void,
  registrySync: Pick<TunnelRegistrySync, "dispose" | "cleanupOwnEntries" | "waitForFenceCleanups">,
  closeTransports?: () => void
): Promise<void> {
  try {
    await stopAll();
  } finally {
    unsubscribeTunnel();
    registrySync.dispose();
    try {
      closeTransports?.();
    } finally {
      try {
        await registrySync.cleanupOwnEntries();
      } finally {
        await registrySync.waitForFenceCleanups();
      }
    }
  }
}

/** Minimal event shape the `stopped` listener needs (see TunnelEvent). */
export interface TunnelStoppedEvent {
  tunnelId: string;
  tunnel: ActiveTunnel;
  retiredReverseBind?: RetiredReverseBindFence;
}

/**
 * The `stopped` listener body. Local teardown (core.unregisterTunnel) happens
 * first, and a registry failure afterwards is absorbed by
 * unregisterTunnelAfterStop so stop() and its callers keep going. Do not swap
 * in unregisterTunnel: a rejection would abort server removal partway.
 */
export function handleTunnelStopped(
  core: Pick<NexusCore, "getSnapshot" | "unregisterTunnel">,
  registrySync: Pick<TunnelRegistrySync, "unregisterTunnelAfterStop">,
  event: TunnelStoppedEvent
): Promise<void> | undefined {
  const stoppingTunnel = core.getSnapshot().activeTunnels.find((t) => t.id === event.tunnelId)
    ?? (event.retiredReverseBind ? event.tunnel : undefined);
  core.unregisterTunnel(event.tunnelId);
  if (!stoppingTunnel) {
    return undefined;
  }
  return registrySync.unregisterTunnelAfterStop(stoppingTunnel.profileId, {
    tunnel: stoppingTunnel,
    ...(event.retiredReverseBind ? { retiredReverseBind: event.retiredReverseBind } : {})
  });
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
  if (!retired || (retired.remotePort !== 0 && retired.remotePort !== remotePort)) {
    return false;
  }
  const retiredRoute = parseNetworkRouteIdentity(retired.routeIdentity);
  return retiredRoute !== undefined && networkRoutesOverlap(retiredRoute, routeIdentity);
}

function matchesActiveTunnel(entry: TunnelRegistryEntry, tunnel: ActiveTunnel): boolean {
  return !entry.retiredReverseBind && entry.profileId === tunnel.profileId &&
    (entry.activeTunnelId !== undefined
      ? entry.activeTunnelId === tunnel.id
      : entry.startedAt === tunnel.startedAt);
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
  private readonly pendingFenceCleanups = new Set<{
    settled: Promise<void>;
    cleanup: Promise<void>;
    hasSettled: () => boolean;
  }>();
  private mutationTail: Promise<void> = Promise.resolve();
  private warnedFencePublishFailure = false;
  /** Fence ids whose publishFence itself failed, as opposed to a later write. */
  private readonly failedFencePublications = new Set<string>();

  public constructor(
    private readonly store: TunnelRegistryStore,
    private readonly core: NexusCore,
    private readonly sessionId: string,
    probePortFn?: ProbePortFn,
    private readonly notifyWarning?: (message: string) => void
  ) {
    this.probePort = probePortFn ?? defaultProbePort;
  }

  public async initialize(): Promise<void> {
    try {
      await this.syncWithProbe();
    } catch (error) {
      // Registry storage trouble must not stop the whole extension activating.
      // The timers below retry, so a later sweep recovers once it clears.
      console.error("[Nexus] initial tunnel registry sync failed", error);
    }
    this.pollTimer = setInterval(() => {
      this.syncFast().catch((error: unknown) => console.error("[Nexus] tunnel registry sync failed", error));
    }, POLL_INTERVAL_MS);
    this.reprobeTimer = setInterval(() => {
      this.syncWithProbe().catch((error: unknown) => console.error("[Nexus] tunnel registry sweep failed", error));
    }, SLOW_REPROBE_INTERVAL_MS);
  }

  /**
   * For the stopped-tunnel listener: local teardown is already done, so a
   * registry failure is logged instead of rejecting stop() and aborting the
   * caller's remaining cleanup. The call is still awaited, which keeps a
   * reverse-bind fence published before stop() resolves.
   */
  public async unregisterTunnelAfterStop(
    profileId: string,
    options?: { tunnel: ActiveTunnel; retiredReverseBind?: RetiredReverseBindFence }
  ): Promise<void> {
    try {
      await this.unregisterTunnel(profileId, options);
    } catch (error) {
      console.error("[Nexus] tunnel registry update after stop failed", error);
      // A later active-array save can fail after the fence is already
      // published; that is not a missing reservation, so it must neither warn
      // nor consume the one-time warning.
      const fenceId = options?.retiredReverseBind?.fenceId;
      const publishFailed = fenceId !== undefined && this.failedFencePublications.delete(fenceId);
      if (publishFailed && options?.retiredReverseBind && !this.warnedFencePublishFailure) {
        this.warnedFencePublishFailure = true;
        this.notifyWarning?.(
          `Nexus could not record a reservation for remote port ${options.retiredReverseBind.remotePort} of a stopped reverse tunnel. ` +
          "Another VS Code window may collide on that port until the old connection closes: close this server's terminals, SFTP views and tunnels, or reload this window to release it, and wait before starting the same reverse tunnel elsewhere."
        );
      }
    }
  }

  public async registerTunnel(tunnel: ActiveTunnel): Promise<void> {
    await this.mutateEntries(async () => {
      const entries = await this.store.getEntries();
      const entry: TunnelRegistryEntry = {
        activeTunnelId: tunnel.id,
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
      await this.store.saveEntries(entries);
    });
  }

  public async unregisterTunnel(
    profileId: string,
    options?: { tunnel: ActiveTunnel; retiredReverseBind?: RetiredReverseBindFence }
  ): Promise<void> {
    const fence = options?.retiredReverseBind;
    await this.mutateEntries(async () => {
      const entries = await this.store.getEntries();
      const filtered = entries.filter(
        (e) => !(e.ownerSessionId === this.sessionId && e.profileId === profileId)
      );
      if (fence && options?.tunnel) {
        this.unsettledReverseBindFenceIds.add(fence.fenceId);
        const tunnel = options.tunnel;
        const fenceEntry: TunnelRegistryEntry = {
          activeTunnelId: tunnel.id,
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
        };
        try {
          // Publish first: a stale Memento write from another window cannot
          // remove this file, and removal of our active row follows it.
          await this.store.publishFence(fenceEntry);
        } catch (error) {
          this.unsettledReverseBindFenceIds.delete(fence.fenceId);
          this.failedFencePublications.add(fence.fenceId);
          throw error;
        }
        // A later active-array save can fail. The already-published fence must
        // still be removed when the transport confirms closure.
        this.trackFenceSettlement(profileId, tunnel, fence);
      }
      await this.store.saveEntries(filtered);
    });
  }

  private trackFenceSettlement(profileId: string, tunnel: ActiveTunnel, fence: RetiredReverseBindFence): void {
    if (fence.allocatedPort) {
      void Promise.race([fence.allocatedPort, fence.settled.then(() => undefined)]).then((port) => {
        if (port === undefined || port === 0) {
          return;
        }
        return this.mutateEntries(async () => {
          if (!this.unsettledReverseBindFenceIds.has(fence.fenceId)) {
            return;
          }
          const current = await this.store.getEntries();
          const entry = current.find((item) =>
            item.ownerSessionId === this.sessionId && item.retiredReverseBind?.fenceId === fence.fenceId
          );
          if (entry?.retiredReverseBind) {
            await this.store.publishFence({
              ...entry,
              remotePort: port,
              retiredReverseBind: { ...entry.retiredReverseBind, remotePort: port }
            });
          }
        });
      });
    }
    let hasSettled = false;
    const settled = fence.settled.then(() => { hasSettled = true; });
    const cleanup = settled.then(() => this.mutateEntries(async () => {
      try {
        const entries = await this.store.getEntries();
        const filtered = entries.filter((entry) =>
          entry.retiredReverseBind !== undefined ||
          entry.ownerSessionId !== this.sessionId ||
          entry.profileId !== profileId ||
          (entry.activeTunnelId !== undefined
            ? entry.activeTunnelId !== tunnel.id
            : entry.startedAt !== tunnel.startedAt)
        );
        if (filtered.length !== entries.length) {
          // A stale window can restore the old active row while this fence is
          // held. Remove that row before another window can see settlement.
          await this.store.saveEntries(filtered);
        }
        await this.store.removeFence(fence.fenceId);
      } finally {
        // Settlement is final even when storage fails. The next slow sweep can
        // remove an unrefreshed file; heartbeat must not keep it live forever.
        this.unsettledReverseBindFenceIds.delete(fence.fenceId);
      }
    }));
    const pending = { settled, cleanup, hasSettled: () => hasSettled };
    this.pendingFenceCleanups.add(pending);
    void cleanup.then(
      () => { this.pendingFenceCleanups.delete(pending); },
      (error: unknown) => {
        this.pendingFenceCleanups.delete(pending);
        console.error("[Nexus] reverse-bind fence cleanup failed", error);
      }
    );
  }

  public async checkRemoteOwnership(
    profileId: string,
    localPort: number,
    reverseBind?: { routeIdentity: NetworkRouteIdentity; remotePort: number }
  ): Promise<TunnelRegistryEntry | undefined> {
    const entries = await this.store.getEntries();
    for (const entry of entries) {
      if (entry.ownerSessionId === this.sessionId) {
        continue;
      }
      const matches = entry.retiredReverseBind
        ? reverseBind !== undefined && retiredRouteOverlaps(entry, reverseBind.routeIdentity, reverseBind.remotePort)
        : entry.profileId === profileId || entry.localPort === localPort;
      if (!matches) {
        continue;
      }
      // Reverse tunnels have no local listener to probe — use heartbeat staleness check.
      if (entry.tunnelType === "reverse") {
        const lastSeen = entry.lastSeen ?? entry.startedAt;
        if (Date.now() - lastSeen < STALE_THRESHOLD_MS) {
          return entry;
        }
      } else if (await this.probePort(entry.localPort)) {
        return entry;
      }
    }
    return undefined;
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
    await this.mutateEntries(async () => {
      const entries = await this.store.getEntries();
      const filtered = entries.filter((entry) =>
        entry.ownerSessionId !== this.sessionId ||
        (entry.retiredReverseBind !== undefined &&
          this.unsettledReverseBindFenceIds.has(entry.retiredReverseBind.fenceId))
      );
      await this.store.saveEntries(filtered);
    });
  }

  public async waitForFenceCleanups(): Promise<void> {
    const pending = [...this.pendingFenceCleanups];
    if (pending.length === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    try {
      // Shutdown cannot wait forever for an SSH peer that never confirms close.
      // Once closure is confirmed within this grace, always finish its storage
      // deletion before deactivation returns.
      await Promise.race([
        Promise.allSettled(pending.map((item) => item.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_FENCE_SETTLE_GRACE_MS);
        })
      ]);
    } finally {
      clearTimeout(timer!);
    }
    await Promise.allSettled(pending.filter((item) => item.hasSettled()).map((item) => item.cleanup));
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
    await this.mutateEntries(async () => {
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
        if (entry.retiredReverseBind) {
          if (this.unsettledReverseBindFenceIds.has(entry.retiredReverseBind.fenceId)) {
            await this.store.publishFence({ ...entry, lastSeen: now });
          }
        } else if (activeTunnels.some((t) => matchesActiveTunnel(entry, t))) {
          entry.lastSeen = now;
          changed = true;
        }
      }

      // Self-heal: re-register own active tunnels if missing from registry
      const missingOwn = activeTunnels.filter(
        (t) => !ownEntries.some((e) => matchesActiveTunnel(e, t))
      );
      if (missingOwn.length > 0) {
        for (const tunnel of missingOwn) {
          entries.push({
            activeTunnelId: tunnel.id,
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
        await this.store.saveEntries(entries);
      }
    });
  }

  private async syncWithProbe(): Promise<void> {
    await this.mutateEntries(async () => {
      const entries = await this.store.getEntries();
      const remote = entries.filter((e) => e.ownerSessionId !== this.sessionId && !e.retiredReverseBind);
      const remoteForProbe = entries.filter((e) => e.ownerSessionId !== this.sessionId && !e.retiredReverseBind);
      const now = Date.now();

      // A terminated owner or a failed settlement deletion can leave a fence
      // file behind. Keep our own unsettled fences until closure is confirmed.
      for (const entry of entries) {
        if (
          entry.retiredReverseBind &&
          (entry.ownerSessionId !== this.sessionId ||
            !this.unsettledReverseBindFenceIds.has(entry.retiredReverseBind.fenceId)) &&
          now - (entry.lastSeen ?? entry.startedAt) >= STALE_THRESHOLD_MS
        ) {
          try {
            await this.store.removeObservedFence(entry);
          } catch (error) {
            console.error("[Nexus] expired reverse-bind fence cleanup failed", error);
          }
        }
      }

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
        await this.store.saveEntries(cleaned);
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
    });
  }

  private mutateEntries<T>(mutate: () => Promise<T>): Promise<T> {
    // globalState stores one whole array. Queue this window's read-modify-write
    // spans so concurrent stops and heartbeat writes cannot erase each other.
    const result = this.mutationTail.then(mutate);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

}
