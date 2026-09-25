import * as net from "node:net";
import { randomUUID } from "node:crypto";
import type { ActiveTunnel, ResolvedTunnelConnectionMode, ServerConfig, TunnelProfile, TunnelType } from "../../models/config";
import { resolveTunnelType } from "../../models/config";
import { normalizeBoundedNumber } from "../../utils/helpers";
import { isFatalToSshConnection } from "../ssh/channelErrors";
import type { SshConnection, SshFactory } from "../ssh/contracts";
import { handleSocks5Handshake, sendSocks5Failure, sendSocks5Success, Socks5HandshakeAbortedError } from "./socks5";

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
  listenerServer?: net.Server;
  sockets: Set<net.Socket>;
  sshConnections: Set<SshConnection>;
  sharedConnection?: SshConnection;
  reverseUnsubscribe?: () => void;
  reverseBindAddr?: string;
  reverseBindPort?: number;
  isStopping: boolean;
}

function listen(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
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

function normalizeSocks5HandshakeTimeoutMs(timeoutMs: number): number {
  return normalizeBoundedNumber(timeoutMs, 10_000, 2_000, 60_000);
}

/** One tunnel client and the SSH resources opened on its behalf. */
interface TunnelClient {
  /** The client has left, or its tunnel is stopping — nothing more should be opened for it. */
  gone(): boolean;
  /**
   * Gives the client its isolated connection, to be disposed with it. Returns
   * false, having disposed the connection already, when the client is gone.
   */
  own(connection: SshConnection): boolean;
  /** Forgets the client and disposes the connection it owns. Idempotent. */
  release(): void;
}

/**
 * Watches a client from the moment it arrives, not from when its stream is up.
 * Connecting can take seconds — a jump-host hop, a password or 2FA prompt — and
 * the client can leave, or stop() destroy it, meanwhile. A 'close' that fired
 * before anyone listened is never seen again: listeners attached once the
 * stream was up missed it, and the connection that finished afterwards stayed
 * open for good, holding the pooled jump-host lease under an isolated one so
 * the bastion was never idle-evicted. Listening from arrival also keeps a
 * client's reset from surfacing as an unhandled 'error'.
 */
function trackClient(runtime: ActiveTunnelRuntime, socket: net.Socket): TunnelClient {
  let released = false;
  let owned: SshConnection | undefined;
  const gone = (): boolean => released || socket.destroyed || runtime.isStopping;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    runtime.sockets.delete(socket);
    if (owned) {
      runtime.sshConnections.delete(owned);
      owned.dispose();
    }
  };
  socket.on("error", release);
  socket.on("close", release);
  return {
    gone,
    own(connection) {
      if (gone()) {
        connection.dispose();
        release();
        return false;
      }
      owned = connection;
      runtime.sshConnections.add(connection);
      return true;
    },
    release
  };
}

export class TunnelManager {
  private readonly listeners = new Set<TunnelListener>();
  private readonly activeTunnels = new Map<string, ActiveTunnelRuntime>();
  private readonly activeByProfile = new Map<string, string>();
  private trafficTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private socks5HandshakeTimeoutMs: number;

  public constructor(
    private readonly sharedFactory: SshFactory,
    private readonly isolatedFactory: SshFactory,
    socks5HandshakeTimeoutMs: number = 10_000
  ) {
    this.socks5HandshakeTimeoutMs = normalizeSocks5HandshakeTimeoutMs(socks5HandshakeTimeoutMs);
  }

  public updateSocks5HandshakeTimeout(timeoutMs: number): void {
    this.socks5HandshakeTimeoutMs = normalizeSocks5HandshakeTimeoutMs(timeoutMs);
  }

  public onDidChange(listener: TunnelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getActiveTunnelId(profileId: string): string | undefined {
    return this.activeByProfile.get(profileId);
  }

  public async start(
    profile: TunnelProfile,
    serverConfig: ServerConfig,
    options?: { connectionMode?: ResolvedTunnelConnectionMode }
  ): Promise<ActiveTunnel> {
    const existingActiveId = this.activeByProfile.get(profile.id);
    if (existingActiveId) {
      const runtime = this.activeTunnels.get(existingActiveId);
      if (runtime) {
        return runtime.active;
      }
    }

    const tunnelType = resolveTunnelType(profile);

    const activeTunnel: ActiveTunnel = {
      id: randomUUID(),
      profileId: profile.id,
      serverId: serverConfig.id,
      localPort: profile.localPort,
      remoteIP: profile.remoteIP,
      remotePort: profile.remotePort,
      startedAt: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
      connectionMode: options?.connectionMode ?? "isolated",
      tunnelType,
      remoteBindAddress: profile.remoteBindAddress,
      localTargetIP: profile.localTargetIP,
      localBindAddress: profile.localBindAddress
    };

    switch (tunnelType) {
      case "local":
        return this.startLocal(profile, serverConfig, activeTunnel);
      case "reverse":
        return this.startReverse(profile, serverConfig, activeTunnel);
      case "dynamic":
        return this.startDynamic(profile, serverConfig, activeTunnel);
    }
  }

  public async stop(activeTunnelId: string): Promise<void> {
    const runtime = this.activeTunnels.get(activeTunnelId);
    if (!runtime) {
      return;
    }
    runtime.isStopping = true;
    this.activeByProfile.delete(runtime.profile.id);
    this.activeTunnels.delete(activeTunnelId);

    // Cancel reverse forwarding on the remote side
    if (runtime.reverseUnsubscribe) {
      runtime.reverseUnsubscribe();
    }
    if (runtime.reverseBindAddr !== undefined && runtime.reverseBindPort !== undefined && runtime.sharedConnection) {
      try {
        await runtime.sharedConnection.cancelForwardIn(runtime.reverseBindAddr, runtime.reverseBindPort);
      } catch {
        // Best effort — connection may already be closed
      }
    }

    for (const socket of runtime.sockets) {
      socket.destroy();
    }
    for (const sshConnection of runtime.sshConnections) {
      sshConnection.dispose();
    }
    runtime.sharedConnection = undefined;
    if (runtime.listenerServer) {
      await closeServer(runtime.listenerServer);
    }
    const pendingTimer = this.trafficTimers.get(activeTunnelId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.trafficTimers.delete(activeTunnelId);
      this.emit({
        type: "traffic",
        tunnelId: activeTunnelId,
        bytesIn: runtime.active.bytesIn,
        bytesOut: runtime.active.bytesOut
      });
    }
    this.emit({ type: "stopped", tunnelId: activeTunnelId });
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.activeTunnels.keys()].map((activeId) => this.stop(activeId)));
  }

  // ---------- Local forwarding (-L) ----------

  private async startLocal(
    profile: TunnelProfile,
    serverConfig: ServerConfig,
    activeTunnel: ActiveTunnel
  ): Promise<ActiveTunnel> {
    const listenerServer = net.createServer((socket) => {
      void this.handleLocalSocket(activeTunnel.id, socket);
    });
    listenerServer.on("error", (error) => {
      this.emit({
        type: "error",
        tunnelId: activeTunnel.id,
        message: `Tunnel ${profile.name} listener failed`,
        error
      });
    });

    await listen(listenerServer, profile.localPort, profile.localBindAddress ?? "127.0.0.1");
    const runtime: ActiveTunnelRuntime = {
      active: activeTunnel,
      profile,
      serverConfig,
      listenerServer,
      sockets: new Set(),
      sshConnections: new Set(),
      isStopping: false
    };
    this.activeTunnels.set(activeTunnel.id, runtime);
    this.activeByProfile.set(profile.id, activeTunnel.id);

    // Eagerly establish shared SSH connection so auth (including 2FA)
    // happens at tunnel start time, not on first client connect.
    if (activeTunnel.connectionMode === "shared") {
      try {
        await this.getOrCreateSharedConnection(runtime, activeTunnel.id);
      } catch (error) {
        // Auth failed or was canceled — tear down the listener
        this.activeTunnels.delete(activeTunnel.id);
        this.activeByProfile.delete(profile.id);
        await closeServer(listenerServer);
        throw error;
      }
    }

    this.emit({ type: "started", tunnel: activeTunnel });
    return activeTunnel;
  }

  private async handleLocalSocket(activeTunnelId: string, socket: net.Socket): Promise<void> {
    const runtime = this.activeTunnels.get(activeTunnelId);
    if (!runtime) {
      socket.destroy();
      return;
    }
    runtime.sockets.add(socket);
    const client = trackClient(runtime, socket);
    let sshConnection: SshConnection | undefined;
    const useSharedConnection = runtime.active.connectionMode === "shared";
    try {
      if (useSharedConnection) {
        sshConnection = await this.getOrCreateSharedConnection(runtime, activeTunnelId);
      } else {
        sshConnection = await this.isolatedFactory.connect(runtime.serverConfig);
        if (!client.own(sshConnection)) {
          return;
        }
      }
      const remoteStream = await sshConnection.openDirectTcp(runtime.profile.remoteIP, runtime.profile.remotePort);
      if (client.gone()) {
        // Opened for a client that has already left: nothing else would close it.
        remoteStream.destroy();
        client.release();
        return;
      }

      socket.on("data", (chunk: Buffer) => {
        runtime.active.bytesOut += chunk.length;
        this.scheduleTrafficEmit(activeTunnelId, runtime);
      });
      remoteStream.on("data", (chunk: Buffer) => {
        runtime.active.bytesIn += chunk.length;
        this.scheduleTrafficEmit(activeTunnelId, runtime);
      });
      remoteStream.on("error", client.release);
      remoteStream.on("close", client.release);

      socket.pipe(remoteStream);
      remoteStream.pipe(socket);
    } catch (error) {
      // Only a dead transport justifies tearing down the shared connection. A
      // channel-open refusal means the remote could not reach THIS destination;
      // disposing on it would kill every other stream currently multiplexed on
      // the tunnel and force the next request to re-authenticate (password/2FA).
      if (
        useSharedConnection
        && sshConnection
        && runtime.sharedConnection === sshConnection
        && isFatalToSshConnection(error)
      ) {
        runtime.sharedConnection = undefined;
        runtime.sshConnections.delete(sshConnection);
        sshConnection.dispose();
      }
      // A client that already left, or a tunnel being stopped, has no one
      // waiting on this connection — and its own release may be what failed it.
      if (!client.gone()) {
        this.emit({
          type: "error",
          tunnelId: activeTunnelId,
          message: `Tunnel ${runtime.profile.name} failed to proxy connection`,
          error
        });
      }
      socket.destroy();
      client.release();
    }
  }

  // ---------- Reverse forwarding (-R) ----------

  private async startReverse(
    profile: TunnelProfile,
    serverConfig: ServerConfig,
    activeTunnel: ActiveTunnel
  ): Promise<ActiveTunnel> {
    // Reverse tunnels always use shared mode (need a persistent SSH connection)
    activeTunnel.connectionMode = "shared";

    const runtime: ActiveTunnelRuntime = {
      active: activeTunnel,
      profile,
      serverConfig,
      sockets: new Set(),
      sshConnections: new Set(),
      isStopping: false
    };
    this.activeTunnels.set(activeTunnel.id, runtime);
    this.activeByProfile.set(profile.id, activeTunnel.id);

    try {
      const sshConnection = await this.getOrCreateSharedConnection(runtime, activeTunnel.id);

      const bindAddr = profile.remoteBindAddress ?? "127.0.0.1";
      const bindPort = profile.remotePort;
      const allocatedPort = await sshConnection.requestForwardIn(bindAddr, bindPort);

      runtime.reverseBindAddr = bindAddr;
      runtime.reverseBindPort = allocatedPort;

      // Update the active tunnel's remotePort if the server allocated a different port
      if (allocatedPort !== bindPort && bindPort === 0) {
        activeTunnel.remotePort = allocatedPort;
      }

      // Listen for incoming TCP connections from the remote side
      const unsubscribe = sshConnection.onTcpConnection((info, accept, reject) => {
        if (info.destPort !== allocatedPort || runtime.isStopping) {
          reject();
          return;
        }
        this.handleReverseConnection(activeTunnel.id, accept, reject);
      });
      runtime.reverseUnsubscribe = unsubscribe;
    } catch (error) {
      this.activeTunnels.delete(activeTunnel.id);
      this.activeByProfile.delete(profile.id);
      throw error;
    }

    this.emit({ type: "started", tunnel: activeTunnel });
    return activeTunnel;
  }

  private handleReverseConnection(
    activeTunnelId: string,
    accept: () => import("node:stream").Duplex,
    reject: () => void
  ): void {
    const runtime = this.activeTunnels.get(activeTunnelId);
    if (!runtime || runtime.isStopping) {
      reject();
      return;
    }

    const localTargetIP = runtime.profile.localTargetIP ?? "127.0.0.1";
    const localTargetPort = runtime.profile.localPort;

    let remoteStream: import("node:stream").Duplex;
    try {
      remoteStream = accept();
    } catch {
      return;
    }

    const localSocket = net.createConnection({ host: localTargetIP, port: localTargetPort });
    runtime.sockets.add(localSocket);

    // For reverse tunnels, SSH→local = "in", local→SSH = "out"
    remoteStream.on("data", (chunk: Buffer) => {
      runtime.active.bytesIn += chunk.length;
      this.scheduleTrafficEmit(activeTunnelId, runtime);
    });
    localSocket.on("data", (chunk: Buffer) => {
      runtime.active.bytesOut += chunk.length;
      this.scheduleTrafficEmit(activeTunnelId, runtime);
    });

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      runtime.sockets.delete(localSocket);
      localSocket.destroy();
      remoteStream.destroy();
    };

    localSocket.on("error", cleanup);
    localSocket.on("close", cleanup);
    remoteStream.on("error", cleanup);
    remoteStream.on("close", cleanup);

    localSocket.pipe(remoteStream);
    remoteStream.pipe(localSocket);
  }

  // ---------- Dynamic SOCKS5 proxy (-D) ----------

  private async startDynamic(
    profile: TunnelProfile,
    serverConfig: ServerConfig,
    activeTunnel: ActiveTunnel
  ): Promise<ActiveTunnel> {
    const listenerServer = net.createServer((socket) => {
      void this.handleDynamicSocket(activeTunnel.id, socket);
    });
    listenerServer.on("error", (error) => {
      this.emit({
        type: "error",
        tunnelId: activeTunnel.id,
        message: `Tunnel ${profile.name} SOCKS5 listener failed`,
        error
      });
    });

    await listen(listenerServer, profile.localPort, profile.localBindAddress ?? "127.0.0.1");
    const runtime: ActiveTunnelRuntime = {
      active: activeTunnel,
      profile,
      serverConfig,
      listenerServer,
      sockets: new Set(),
      sshConnections: new Set(),
      isStopping: false
    };
    this.activeTunnels.set(activeTunnel.id, runtime);
    this.activeByProfile.set(profile.id, activeTunnel.id);

    // Eagerly establish shared SSH connection
    if (activeTunnel.connectionMode === "shared") {
      try {
        await this.getOrCreateSharedConnection(runtime, activeTunnel.id);
      } catch (error) {
        this.activeTunnels.delete(activeTunnel.id);
        this.activeByProfile.delete(profile.id);
        await closeServer(listenerServer);
        throw error;
      }
    }

    this.emit({ type: "started", tunnel: activeTunnel });
    return activeTunnel;
  }

  private async handleDynamicSocket(activeTunnelId: string, socket: net.Socket): Promise<void> {
    const runtime = this.activeTunnels.get(activeTunnelId);
    if (!runtime) {
      socket.destroy();
      return;
    }
    runtime.sockets.add(socket);
    const client = trackClient(runtime, socket);
    let sshConnection: SshConnection | undefined;
    const useSharedConnection = runtime.active.connectionMode === "shared";

    try {
      // SOCKS5 handshake to determine destination
      const target = await handleSocks5Handshake(socket, this.socks5HandshakeTimeoutMs);

      if (useSharedConnection) {
        sshConnection = await this.getOrCreateSharedConnection(runtime, activeTunnelId);
      } else {
        sshConnection = await this.isolatedFactory.connect(runtime.serverConfig);
        if (!client.own(sshConnection)) {
          return;
        }
      }

      const remoteStream = await sshConnection.openDirectTcp(target.destAddr, target.destPort);
      if (client.gone()) {
        // Opened for a client that has already left: nothing else would close it.
        remoteStream.destroy();
        client.release();
        return;
      }

      // Tell the SOCKS5 client we're connected
      sendSocks5Success(socket);

      socket.on("data", (chunk: Buffer) => {
        runtime.active.bytesOut += chunk.length;
        this.scheduleTrafficEmit(activeTunnelId, runtime);
      });
      remoteStream.on("data", (chunk: Buffer) => {
        runtime.active.bytesIn += chunk.length;
        this.scheduleTrafficEmit(activeTunnelId, runtime);
      });
      remoteStream.on("error", client.release);
      remoteStream.on("close", client.release);

      socket.pipe(remoteStream);
      remoteStream.pipe(socket);
    } catch (error) {
      if (error instanceof Socks5HandshakeAbortedError) {
        socket.destroy();
        client.release();
        return;
      }
      // Same rule as the local-forward path: one browser tab asking for an
      // unreachable host must not disconnect every other tab proxied through
      // this SOCKS5 tunnel. See `isFatalToSshConnection`.
      if (
        useSharedConnection
        && sshConnection
        && runtime.sharedConnection === sshConnection
        && isFatalToSshConnection(error)
      ) {
        runtime.sharedConnection = undefined;
        runtime.sshConnections.delete(sshConnection);
        sshConnection.dispose();
      }
      // As on the local-forward path: a client that left has no one to tell.
      if (!client.gone()) {
        this.emit({
          type: "error",
          tunnelId: activeTunnelId,
          message: `Tunnel ${runtime.profile.name} SOCKS5 proxy failed`,
          error
        });
        sendSocks5Failure(socket);
      }
      socket.destroy();
      client.release();
    }
  }

  // ---------- Shared helpers ----------

  private async getOrCreateSharedConnection(
    runtime: ActiveTunnelRuntime,
    activeTunnelId: string
  ): Promise<SshConnection> {
    if (runtime.sharedConnection) {
      return runtime.sharedConnection;
    }
    const sharedConnection = await this.sharedFactory.connect(runtime.serverConfig);
    runtime.sharedConnection = sharedConnection;
    runtime.sshConnections.add(sharedConnection);
    sharedConnection.onClose(() => {
      runtime.sshConnections.delete(sharedConnection);
      if (runtime.sharedConnection === sharedConnection) {
        runtime.sharedConnection = undefined;
      }
      if (!runtime.isStopping && this.activeTunnels.has(activeTunnelId)) {
        this.emit({
          type: "error",
          tunnelId: activeTunnelId,
          message: `Shared SSH connection closed for tunnel ${runtime.profile.name}`
        });
      }
    });
    return sharedConnection;
  }

  private scheduleTrafficEmit(tunnelId: string, runtime: ActiveTunnelRuntime): void {
    if (this.trafficTimers.has(tunnelId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.trafficTimers.delete(tunnelId);
      this.emit({
        type: "traffic",
        tunnelId,
        bytesIn: runtime.active.bytesIn,
        bytesOut: runtime.active.bytesOut
      });
    }, 500);
    this.trafficTimers.set(tunnelId, timer);
  }

  private emit(event: TunnelEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
