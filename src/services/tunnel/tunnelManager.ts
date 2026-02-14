import * as net from "node:net";
import { randomUUID } from "node:crypto";
import type { ActiveTunnel, ServerConfig, TunnelProfile } from "../../models/config";
import type { SshConnection } from "../ssh/contracts";

export interface TunnelSshFactory {
  connect(server: ServerConfig): Promise<SshConnection>;
}

export type TunnelEvent =
  | { type: "started"; tunnel: ActiveTunnel }
  | { type: "traffic"; tunnelId: string; bytesIn: number; bytesOut: number }
  | { type: "stopped"; tunnelId: string }
  | { type: "error"; tunnelId?: string; message: string; error?: unknown };

type TunnelListener = (event: TunnelEvent) => void;

interface ActiveTunnelRuntime {
  active: ActiveTunnel;
  profile: TunnelProfile;
  serverConfig: ServerConfig;
  listenerServer: net.Server;
  sockets: Set<net.Socket>;
  sshConnections: Set<SshConnection>;
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export class TunnelManager {
  private readonly listeners = new Set<TunnelListener>();
  private readonly activeTunnels = new Map<string, ActiveTunnelRuntime>();
  private readonly activeByProfile = new Map<string, string>();

  public constructor(private readonly sshFactory: TunnelSshFactory) {}

  public onDidChange(listener: TunnelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getActiveTunnelId(profileId: string): string | undefined {
    return this.activeByProfile.get(profileId);
  }

  public async start(profile: TunnelProfile, serverConfig: ServerConfig): Promise<ActiveTunnel> {
    const existingActiveId = this.activeByProfile.get(profile.id);
    if (existingActiveId) {
      const runtime = this.activeTunnels.get(existingActiveId);
      if (runtime) {
        return runtime.active;
      }
    }

    const activeTunnel: ActiveTunnel = {
      id: randomUUID(),
      profileId: profile.id,
      serverId: serverConfig.id,
      localPort: profile.localPort,
      remoteIP: profile.remoteIP,
      remotePort: profile.remotePort,
      startedAt: Date.now(),
      bytesIn: 0,
      bytesOut: 0
    };

    const listenerServer = net.createServer((socket) => {
      void this.handleSocket(activeTunnel.id, socket);
    });
    listenerServer.on("error", (error) => {
      this.emit({
        type: "error",
        tunnelId: activeTunnel.id,
        message: `Tunnel ${profile.name} listener failed`,
        error
      });
    });

    await listen(listenerServer, profile.localPort);
    const runtime: ActiveTunnelRuntime = {
      active: activeTunnel,
      profile,
      serverConfig,
      listenerServer,
      sockets: new Set(),
      sshConnections: new Set()
    };
    this.activeTunnels.set(activeTunnel.id, runtime);
    this.activeByProfile.set(profile.id, activeTunnel.id);
    this.emit({ type: "started", tunnel: activeTunnel });
    return activeTunnel;
  }

  public async stop(activeTunnelId: string): Promise<void> {
    const runtime = this.activeTunnels.get(activeTunnelId);
    if (!runtime) {
      return;
    }
    this.activeByProfile.delete(runtime.profile.id);
    this.activeTunnels.delete(activeTunnelId);

    for (const socket of runtime.sockets) {
      socket.destroy();
    }
    for (const sshConnection of runtime.sshConnections) {
      sshConnection.dispose();
    }
    await closeServer(runtime.listenerServer);
    this.emit({ type: "stopped", tunnelId: activeTunnelId });
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.activeTunnels.keys()].map((activeId) => this.stop(activeId)));
  }

  private async handleSocket(activeTunnelId: string, socket: net.Socket): Promise<void> {
    const runtime = this.activeTunnels.get(activeTunnelId);
    if (!runtime) {
      socket.destroy();
      return;
    }
    runtime.sockets.add(socket);
    let sshConnection: SshConnection | undefined;
    try {
      sshConnection = await this.sshFactory.connect(runtime.serverConfig);
      runtime.sshConnections.add(sshConnection);
      const remoteStream = await sshConnection.openDirectTcp(runtime.profile.remoteIP, runtime.profile.remotePort);

      socket.on("data", (chunk: Buffer) => {
        runtime.active.bytesOut += chunk.length;
        this.emit({
          type: "traffic",
          tunnelId: activeTunnelId,
          bytesIn: runtime.active.bytesIn,
          bytesOut: runtime.active.bytesOut
        });
      });
      remoteStream.on("data", (chunk: Buffer) => {
        runtime.active.bytesIn += chunk.length;
        this.emit({
          type: "traffic",
          tunnelId: activeTunnelId,
          bytesIn: runtime.active.bytesIn,
          bytesOut: runtime.active.bytesOut
        });
      });

      const cleanup = (): void => {
        runtime.sockets.delete(socket);
        runtime.sshConnections.delete(sshConnection!);
        sshConnection?.dispose();
      };

      socket.on("error", cleanup);
      socket.on("close", cleanup);
      remoteStream.on("error", cleanup);
      remoteStream.on("close", cleanup);

      socket.pipe(remoteStream);
      remoteStream.pipe(socket);
    } catch (error) {
      runtime.sockets.delete(socket);
      if (sshConnection) {
        runtime.sshConnections.delete(sshConnection);
      }
      this.emit({
        type: "error",
        tunnelId: activeTunnelId,
        message: `Tunnel ${runtime.profile.name} failed to proxy connection`,
        error
      });
      socket.destroy();
      sshConnection?.dispose();
    }
  }

  private emit(event: TunnelEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
