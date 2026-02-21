import * as net from "node:net";
import type { TunnelRegistryStore } from "../../core/contracts";
import type { NexusCore } from "../../core/nexusCore";
import type { ActiveTunnel, TunnelRegistryEntry } from "../../models/config";

const POLL_INTERVAL_MS = 3_000;
const PROBE_TIMEOUT_MS = 200;
const SLOW_REPROBE_INTERVAL_MS = 60_000;

export type ProbePortFn = (port: number) => Promise<boolean>;

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
      ownerSessionId: this.sessionId
    };
    entries.push(entry);
    await this.store.saveEntries(entries);
  }

  public async unregisterTunnel(profileId: string): Promise<void> {
    const entries = await this.store.getEntries();
    const filtered = entries.filter(
      (e) => !(e.ownerSessionId === this.sessionId && e.profileId === profileId)
    );
    await this.store.saveEntries(filtered);
  }

  public async checkRemoteOwnership(
    profileId: string,
    localPort: number
  ): Promise<TunnelRegistryEntry | undefined> {
    const entries = await this.store.getEntries();
    const remote = entries.find(
      (e) =>
        e.ownerSessionId !== this.sessionId &&
        (e.profileId === profileId || e.localPort === localPort)
    );
    if (!remote) {
      return undefined;
    }
    // Reverse tunnels have no local listener to probe — trust the registry
    if (remote.tunnelType === "reverse") {
      return remote;
    }
    const alive = await this.probePort(remote.localPort);
    return alive ? remote : undefined;
  }

  public async syncNow(): Promise<void> {
    await this.syncFast();
  }

  public async cleanupOwnEntries(): Promise<void> {
    const entries = await this.store.getEntries();
    const filtered = entries.filter((e) => e.ownerSessionId !== this.sessionId);
    await this.store.saveEntries(filtered);
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
    const remote = entries.filter((e) => e.ownerSessionId !== this.sessionId);
    const remoteJson = JSON.stringify(remote);
    if (remoteJson !== this.lastRemoteJson) {
      this.lastRemoteJson = remoteJson;
      this.core.setRemoteTunnels(remote);
    }

    // Self-heal: re-register own active tunnels if missing from registry
    const activeTunnels = this.core.getSnapshot().activeTunnels;
    const ownEntries = entries.filter((e) => e.ownerSessionId === this.sessionId);
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
          ownerSessionId: this.sessionId
        });
      }
      await this.store.saveEntries(entries);
    }
  }

  private async syncWithProbe(): Promise<void> {
    const entries = await this.store.getEntries();
    const remote = entries.filter((e) => e.ownerSessionId !== this.sessionId);

    // Probe all remote entries concurrently (reverse tunnels have no local listener to probe)
    const probeResults = await Promise.all(
      remote.map(async (e) => ({
        entry: e,
        alive: e.tunnelType === "reverse" ? true : await this.probePort(e.localPort)
      }))
    );
    const staleProfileIds = new Set(
      probeResults.filter((r) => !r.alive).map((r) => `${r.entry.ownerSessionId}:${r.entry.profileId}`)
    );

    if (staleProfileIds.size > 0) {
      const cleaned = entries.filter(
        (e) => !staleProfileIds.has(`${e.ownerSessionId}:${e.profileId}`)
      );
      await this.store.saveEntries(cleaned);
      const cleanedRemote = cleaned.filter((e) => e.ownerSessionId !== this.sessionId);
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
}
