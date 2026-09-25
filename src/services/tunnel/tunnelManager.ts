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

/**
 * stop() swept the tunnel while it was still connecting. start() rejects with
 * this rather than report a tunnel that no longer exists as started; the stop
 * was asked for, so callers treat it as a cancel, not a failure.
 */
export class TunnelStoppedError extends Error {
  public constructor(profileName: string) {
    super(`Tunnel ${profileName} was stopped while connecting`);
    this.name = "TunnelStoppedError";
  }
}

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
  /** Called by stop(): a start still waiting on the server bounds that wait from then on. */
  onStop?: () => void;
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

function waitForConnectionClose(connection: SshConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const finish = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe?.();
      resolve();
    };
    unsubscribe = connection.onClose(finish);
    if (closed) {
      unsubscribe?.();
    }
  });
}

function networkRouteIdentity(
  server: ServerConfig,
  serverLookup: ((id: string) => ServerConfig | undefined) | undefined,
  visited = new Set<string>()
): readonly unknown[] {
  const endpoint = [server.host.toLowerCase(), server.port];
  if (visited.has(server.id)) {
    return ["cycle", server.id, endpoint];
  }
  const nextVisited = new Set(visited);
  nextVisited.add(server.id);

  const proxy = server.proxy;
  if (!proxy) {
    return ["direct", endpoint];
  }
  if (proxy.type === "ssh") {
    const jumpHost = serverLookup?.(proxy.jumpHostId);
    return [
      "ssh",
      endpoint,
      jumpHost ? networkRouteIdentity(jumpHost, serverLookup, nextVisited) : ["unresolved", proxy.jumpHostId]
    ];
  }
  // Proxy credentials may select separate egress routes, so this can
  // serialize independent backends. The key protects the SSH server's
  // server-wide bind namespace; omitting username avoids racing two credentials
  // that reach the same proxy and SSH endpoint.
  return [proxy.type, proxy.host.toLowerCase(), proxy.port, endpoint];
}

/**
 * How long a start stopped mid-request waits for the server to answer that
 * request, and then to withdraw a forward it granted too late. Bounded
 * because a start's caller is waiting on it and ssh2 has no timeout for
 * either (issue #184). A replacement start waits for its stopped predecessor
 * without a timeout of its own: these two phases are what bound that wait.
 */
const LATE_FORWARD_CANCEL_TIMEOUT_MS = 5_000;

/** Whether `work` fulfilled within `timeoutMs`; false if it rejected or is still pending. */
async function fulfilledWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  /**
   * Per remote bind: tracks only the remote-forward phase, after login. A
   * stopped start may still be authenticating, but a replacement for the same
   * bind must wait for this request to settle.
   */
  private readonly forwardRequests = new Map<string, Promise<void>>();
  /** A retired transport may still own a server-wide bind while other leases use it. */
  private readonly retiredForwardTransports = new Map<string, Promise<void>>();
  /** Only explicitly discarded candidates are quiet; a superseded transport may still be in use. */
  private readonly intentionallyDiscardedSharedConnections = new WeakSet<SshConnection>();
  private trafficTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private socks5HandshakeTimeoutMs: number;

  public constructor(
    // The pool, in production: `retire` takes the transport a lease rides out
    // of reuse without closing it under the leases already on it.
    private readonly sharedFactory: SshFactory & { retire?(lease: SshConnection): Promise<void> | undefined },
    private readonly isolatedFactory: SshFactory,
    socks5HandshakeTimeoutMs: number = 10_000,
    private readonly serverLookup?: (id: string) => ServerConfig | undefined
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

  /**
   * Undoes a failed start's registration. Only its own: a start stopped while
   * connecting fails after stop() let the profile start again, and dropping
   * that newer tunnel's mapping would hide it from start(), which would then
   * open a second tunnel for the profile.
   */
  private unregisterFailedStart(activeTunnel: ActiveTunnel): void {
    this.activeTunnels.delete(activeTunnel.id);
    if (this.activeByProfile.get(activeTunnel.profileId) === activeTunnel.id) {
      this.activeByProfile.delete(activeTunnel.profileId);
    }
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
    runtime.onStop?.();
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
        // Auth failed or was canceled, or stop() swept the tunnel meanwhile —
        // tear down the listener (a second close after stop() is harmless)
        this.unregisterFailedStart(activeTunnel);
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
      const bindAddr = profile.remoteBindAddress ?? "127.0.0.1";
      const bindPort = profile.remotePort;
      // Private addresses can identify different SSH servers on different jump routes.
      const routeIdentity = networkRouteIdentity(serverConfig, this.serverLookup);
      const bindKey = (port: number): string => JSON.stringify([routeIdentity, bindAddr, port]);
      const requestKey = bindKey(bindPort);
      let requestOver: (() => void) | undefined;
      let thisRequest: Promise<void> | undefined;
      let sshConnection: SshConnection;
      let allocatedPort: number;
      try {
        while (true) {
          if (runtime.isStopping) {
            throw new TunnelStoppedError(profile.name);
          }
          const retiredAfterLogin = this.retiredForwardTransports.get(requestKey);
          if (retiredAfterLogin) {
            // The old SSH lease is gone, but a terminal may still keep its
            // transport open. Do not request the same server-wide bind over a
            // fresh connection until that transport's close removes the bind.
            await this.waitForForwardWait(runtime, retiredAfterLogin);
            if (this.retiredForwardTransports.get(requestKey) === retiredAfterLogin) {
              this.retiredForwardTransports.delete(requestKey);
            }
            continue;
          }
          const earlierRequest = this.forwardRequests.get(requestKey);
          if (earlierRequest) {
            // A stopped start may still be requesting or withdrawing this
            // bind. Wait before taking a lease, because it may retire the
            // transport if withdrawal fails. Login is outside this barrier:
            // a replacement can authenticate independently while an earlier
            // non-pooled login finishes.
            await this.waitForForwardWait(runtime, earlierRequest);
            if (runtime.isStopping) {
              throw new TunnelStoppedError(profile.name);
            }
            continue;
          }

          const candidate = await this.getOrCreateSharedConnection(runtime, activeTunnel.id);
          if (runtime.isStopping) {
            // getOrCreateSharedConnection registered the candidate before its
            // caller resumed, so stop() already released it in this case.
            throw new TunnelStoppedError(profile.name);
          }
          const retiredTransport = this.retiredForwardTransports.get(requestKey);
          if (retiredTransport) {
            // Retirement can begin while this start is authenticating. Drop
            // the candidate lease before waiting so it cannot keep the old
            // transport alive and preserve the bind conflict.
            runtime.sshConnections.delete(candidate);
            if (runtime.sharedConnection === candidate) {
              runtime.sharedConnection = undefined;
            }
            this.discardSharedConnection(candidate);
            await this.waitForForwardWait(runtime, retiredTransport);
            if (this.retiredForwardTransports.get(requestKey) === retiredTransport) {
              this.retiredForwardTransports.delete(requestKey);
            }
            continue;
          }
          const competingRequest = this.forwardRequests.get(requestKey);
          if (competingRequest) {
            // Another start can reach its forward phase while this one logs
            // in. Drop our lease before waiting so a predecessor can retire
            // its transport without leaving this start pinned to it.
            runtime.sshConnections.delete(candidate);
            if (runtime.sharedConnection === candidate) {
              runtime.sharedConnection = undefined;
            }
            this.discardSharedConnection(candidate);
            if (runtime.isStopping) {
              throw new TunnelStoppedError(profile.name);
            }
            await this.waitForForwardWait(runtime, competingRequest!);
            if (runtime.isStopping) {
              throw new TunnelStoppedError(profile.name);
            }
            continue;
          }

          sshConnection = candidate;
          thisRequest = new Promise<void>((resolve) => {
            requestOver = resolve;
          });
          this.forwardRequests.set(requestKey, thisRequest);
          break;
        }
        // The start holds the connection itself while the forward is requested,
        // out of stop()'s reach. Released under the request, a pooled lease
        // leaves the connection open for its other leases, and a forward granted
        // afterwards would stay bound on it with nothing left to withdraw it: the
        // tunnel's next start would fail as already bound until that connection
        // closed. So the forward's outcome decides what happens to it here.
        runtime.sshConnections.delete(sshConnection);
        const outcome = await this.requestForward(runtime, sshConnection, bindAddr, bindPort);
        if (outcome === "abandoned") {
          // Stopped, and the server has not answered: no telling whether it
          // will still grant the forward. Retire it from reuse and hold a
          // replacement for this bind until its transport closes.
          this.retireForwardTransport(requestKey, sshConnection);
          sshConnection.dispose();
          throw new TunnelStoppedError(profile.name);
        }
        if ("error" in outcome) {
          // Refused, or stopped meanwhile: discard this start and do not let
          // its expected close be reported as an unexpected shared-transport loss.
          if (runtime.sharedConnection === sshConnection) {
            runtime.sharedConnection = undefined;
          }
          this.discardSharedConnection(sshConnection);
          throw runtime.isStopping ? new TunnelStoppedError(profile.name) : outcome.error;
        }
        allocatedPort = outcome.port;
        if (runtime.isStopping) {
          // Granted after stop(): withdraw it, then let the connection go, and
          // do not announce a tunnel that is gone. A withdrawal refused or not
          // answered may leave the bind on a transport other leases keep open.
          // Retire it from reuse and hold a replacement until the old transport
          // closes and the server releases that bind.
          const withdrawn = await fulfilledWithin(
            Promise.resolve().then(() => sshConnection.cancelForwardIn(bindAddr, allocatedPort)),
            LATE_FORWARD_CANCEL_TIMEOUT_MS
          );
          if (!withdrawn) {
            this.retireForwardTransport(bindKey(allocatedPort), sshConnection);
          }
          sshConnection.dispose();
          throw new TunnelStoppedError(profile.name);
        }
      } finally {
        requestOver?.();
        if (thisRequest && this.forwardRequests.get(requestKey) === thisRequest) {
          this.forwardRequests.delete(requestKey);
        }
      }
      runtime.sshConnections.add(sshConnection);

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
      this.unregisterFailedStart(activeTunnel);
      throw error;
    }

    this.emit({ type: "started", tunnel: activeTunnel });
    return activeTunnel;
  }

  /**
   * The forward request's outcome — or "abandoned" once stop() has come and
   * the server has still not answered within the bound. ssh2's request has no
   * timeout of its own, and a stopped start holds a lease stop() cannot reach:
   * it must not wait on the server for ever.
   */
  private async requestForward(
    runtime: ActiveTunnelRuntime,
    connection: SshConnection,
    bindAddr: string,
    bindPort: number
  ): Promise<{ port: number } | { error: unknown } | "abandoned"> {
    const request = Promise.resolve()
      .then(() => connection.requestForwardIn(bindAddr, bindPort))
      .then(
        (port) => ({ port }),
        (error: unknown) => ({ error })
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<"abandoned">((resolve) => {
      const startClock = (): void => {
        timer = setTimeout(() => resolve("abandoned"), LATE_FORWARD_CANCEL_TIMEOUT_MS);
      };
      if (runtime.isStopping) {
        startClock();
      } else {
        runtime.onStop = startClock;
      }
    });
    try {
      return await Promise.race([request, abandoned]);
    } finally {
      runtime.onStop = undefined;
      clearTimeout(timer);
    }
  }

  private retireForwardTransport(bindKey: string, connection: SshConnection): void {
    const closed = this.sharedFactory.retire?.(connection) ?? waitForConnectionClose(connection);
    this.retiredForwardTransports.set(bindKey, closed);
    void closed.then(() => {
      if (this.retiredForwardTransports.get(bindKey) === closed) {
        this.retiredForwardTransports.delete(bindKey);
      }
    });
  }

  private async waitForForwardWait(runtime: ActiveTunnelRuntime, pending: Promise<void>): Promise<void> {
    if (runtime.isStopping) {
      throw new TunnelStoppedError(runtime.profile.name);
    }
    let signalStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      signalStop = resolve;
    });
    runtime.onStop = signalStop;
    try {
      await Promise.race([pending, stopped]);
    } finally {
      if (runtime.onStop === signalStop) {
        runtime.onStop = undefined;
      }
    }
    if (runtime.isStopping) {
      throw new TunnelStoppedError(runtime.profile.name);
    }
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
        this.unregisterFailedStart(activeTunnel);
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
    if (runtime.isStopping) {
      // stop() swept the tunnel while this connect was in flight, so its sweep
      // could not include this connection and nothing else ever will. Kept, it
      // would stay logged in until shutdown — and, as a pooled lease, keep the
      // server's multiplexed connection from ever closing as idle.
      sharedConnection.dispose();
      throw new TunnelStoppedError(runtime.profile.name);
    }
    runtime.sharedConnection = sharedConnection;
    runtime.sshConnections.add(sharedConnection);
    sharedConnection.onClose(() => {
      runtime.sshConnections.delete(sharedConnection);
      if (runtime.sharedConnection === sharedConnection) {
        runtime.sharedConnection = undefined;
      }
      // Supersession alone does not make a close expected: another client may
      // still be using this transport. Only candidates deliberately discarded
      // before use are quiet; real transport loss remains visible.
      if (
        !this.intentionallyDiscardedSharedConnections.has(sharedConnection)
        && !runtime.isStopping
        && this.activeTunnels.has(activeTunnelId)
      ) {
        this.emit({
          type: "error",
          tunnelId: activeTunnelId,
          message: `Shared SSH connection closed for tunnel ${runtime.profile.name}`
        });
      }
    });
    return sharedConnection;
  }

  private discardSharedConnection(connection: SshConnection): void {
    this.intentionallyDiscardedSharedConnections.add(connection);
    connection.dispose();
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
