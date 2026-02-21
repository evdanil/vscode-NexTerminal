import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SshConnection, SshFactory } from "../../src/services/ssh/contracts";
import { SshConnectionPool, type PoolEvent } from "../../src/services/ssh/sshConnectionPool";
import type { ServerConfig } from "../../src/models/config";

const testServer: ServerConfig = {
  id: "srv-1",
  name: "Test Server",
  host: "example.com",
  port: 22,
  username: "dev",
  authType: "password",
  isHidden: false,
};

const testServer2: ServerConfig = {
  id: "srv-2",
  name: "Other Server",
  host: "other.com",
  port: 22,
  username: "admin",
  authType: "password",
  isHidden: false,
};

function createMockConnection(): SshConnection & { closeListeners: Set<() => void>; fireClose: () => void } {
  const closeListeners = new Set<() => void>();
  return {
    closeListeners,
    openShell: vi.fn(async () => ({} as any)),
    openDirectTcp: vi.fn(async () => ({} as any)),
    openSftp: vi.fn(async () => ({} as any)),
    requestForwardIn: vi.fn(async () => 0),
    cancelForwardIn: vi.fn(async () => {}),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: vi.fn((listener: () => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    }),
    dispose: vi.fn(() => {
      for (const listener of closeListeners) {
        listener();
      }
    }),
    fireClose() {
      for (const listener of closeListeners) {
        listener();
      }
    },
  };
}

function createMockFactory(connections?: SshConnection[]): SshFactory & { connect: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  return {
    connect: vi.fn(async () => {
      if (connections && callIndex < connections.length) {
        return connections[callIndex++];
      }
      return createMockConnection();
    }),
  };
}

describe("SshConnectionPool", () => {
  let factory: ReturnType<typeof createMockFactory>;
  let pool: SshConnectionPool;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = createMockFactory();
    pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 5000 });
  });

  it("first connect creates underlying connection (factory called once)", async () => {
    await pool.connect(testServer);
    expect(factory.connect).toHaveBeenCalledTimes(1);
    expect(factory.connect).toHaveBeenCalledWith(testServer);
  });

  it("second connect reuses connection (factory still called once)", async () => {
    await pool.connect(testServer);
    await pool.connect(testServer);
    expect(factory.connect).toHaveBeenCalledTimes(1);
  });

  it("different servers get different connections", async () => {
    await pool.connect(testServer);
    await pool.connect(testServer2);
    expect(factory.connect).toHaveBeenCalledTimes(2);
  });

  it("lease dispose decrements refcount", async () => {
    const lease1 = await pool.connect(testServer);
    const lease2 = await pool.connect(testServer);
    lease1.dispose();
    // Connection should still be alive for lease2
    await expect(lease2.openShell()).resolves.toBeDefined();
  });

  it("idle timer starts at refcount=0, closes after timeout", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease = await p.connect(testServer);
    lease.dispose();

    // Not yet closed
    expect(conn.dispose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);

    expect(conn.dispose).toHaveBeenCalled();
  });

  it("re-acquiring during idle cancels timer", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease1 = await p.connect(testServer);
    lease1.dispose();

    vi.advanceTimersByTime(3000);
    // Re-acquire before timeout
    const lease2 = await p.connect(testServer);
    vi.advanceTimersByTime(5000);

    // Should NOT have closed because re-acquired
    expect(conn.dispose).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledTimes(1);
    lease2.dispose();
  });

  it("connection drop notifies all lease holders via onClose", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease1 = await p.connect(testServer);
    const lease2 = await p.connect(testServer);

    const listener1 = vi.fn();
    const listener2 = vi.fn();
    lease1.onClose(listener1);
    lease2.onClose(listener2);

    conn.fireClose();

    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();
  });

  it("concurrent connects serialize (factory called once, both callers get leases)", async () => {
    let resolveConnect: ((conn: SshConnection) => void) | undefined;
    const delayedFactory: SshFactory = {
      connect: vi.fn(() => new Promise<SshConnection>((resolve) => { resolveConnect = resolve; })),
    };
    const p = new SshConnectionPool(delayedFactory, { enabled: true, idleTimeoutMs: 5000 });

    const p1 = p.connect(testServer);
    const p2 = p.connect(testServer);

    const conn = createMockConnection();
    resolveConnect!(conn);

    const [lease1, lease2] = await Promise.all([p1, p2]);
    expect(delayedFactory.connect).toHaveBeenCalledTimes(1);
    expect(lease1).toBeDefined();
    expect(lease2).toBeDefined();
  });

  it("force disconnect closes regardless of refcount", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    await p.connect(testServer);
    await p.connect(testServer);

    p.disconnect(testServer.id);
    expect(conn.dispose).toHaveBeenCalled();
  });

  it("disabled mode bypasses pool (factory called each time)", async () => {
    const f = createMockFactory();
    const p = new SshConnectionPool(f, { enabled: false, idleTimeoutMs: 5000 });

    const lease1 = await p.connect(testServer);
    const lease2 = await p.connect(testServer);
    expect(f.connect).toHaveBeenCalledTimes(2);

    // Each lease gets its own connection
    expect(lease1).not.toBe(lease2);
  });

  it("dispose() is idempotent on PooledSshConnection", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease = await p.connect(testServer);
    lease.dispose();
    lease.dispose(); // second call is no-op

    // Should not have double-decremented — no idle timer double-fire, connection stays valid
    // until idle timer fires once
    vi.advanceTimersByTime(5000);
    expect(conn.dispose).toHaveBeenCalledTimes(1);
  });

  it("methods throw after dispose on PooledSshConnection", async () => {
    const lease = await pool.connect(testServer);
    lease.dispose();

    await expect(lease.openShell()).rejects.toThrow("disposed");
    await expect(lease.openDirectTcp("127.0.0.1", 80)).rejects.toThrow("disposed");
    await expect(lease.openSftp()).rejects.toThrow("disposed");
    expect(() => lease.onClose(() => {})).toThrow("disposed");
  });

  it("onClose listeners cleaned up on lease dispose (no memory leak)", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease = await p.connect(testServer);
    const listener = vi.fn();
    lease.onClose(listener);

    lease.dispose();

    // Fire close on underlying connection — listener should NOT be called
    // because it was unsubscribed during lease dispose
    conn.fireClose();
    expect(listener).not.toHaveBeenCalled();
  });

  it("pool.dispose() cleans up all entries, timers, rejects future connects", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    await p.connect(testServer);
    p.dispose();

    expect(conn.dispose).toHaveBeenCalled();
    await expect(p.connect(testServer)).rejects.toThrow("disposed");
  });

  it("unhealthy entry is evicted — new connection created", async () => {
    const conn1 = createMockConnection();
    const conn2 = createMockConnection();
    const f = createMockFactory([conn1, conn2]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease1 = await p.connect(testServer);
    // Simulate connection drop
    conn1.fireClose();

    const lease2 = await p.connect(testServer);
    expect(f.connect).toHaveBeenCalledTimes(2);

    // lease2 should work (new connection)
    await expect(lease2.openShell()).resolves.toBeDefined();

    lease1.dispose();
    lease2.dispose();
  });

  it("auth failure cleans up pending map — subsequent connect retries", async () => {
    let callCount = 0;
    const failThenSucceedFactory: SshFactory = {
      connect: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Auth failed");
        }
        return createMockConnection();
      }),
    };
    const p = new SshConnectionPool(failThenSucceedFactory, { enabled: true, idleTimeoutMs: 5000 });

    await expect(p.connect(testServer)).rejects.toThrow("Auth failed");
    // Retry should work — pending map was cleaned up
    const lease = await p.connect(testServer);
    expect(lease).toBeDefined();
    expect(failThenSucceedFactory.connect).toHaveBeenCalledTimes(2);
  });

  it("stale config scenario — disconnect evicts, fresh connect succeeds", async () => {
    const conn1 = createMockConnection();
    const conn2 = createMockConnection();
    const f = createMockFactory([conn1, conn2]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    await p.connect(testServer);
    p.disconnect(testServer.id);
    expect(conn1.dispose).toHaveBeenCalled();

    const lease = await p.connect(testServer);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(lease).toBeDefined();
  });

  it("emits connected and disconnected events", async () => {
    const events: PoolEvent[] = [];
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });
    p.onDidChange((event) => events.push(event));

    await p.connect(testServer);
    expect(events).toContainEqual({ type: "connected", serverId: "srv-1" });

    p.disconnect(testServer.id);
    expect(events).toContainEqual({ type: "disconnected", serverId: "srv-1" });
  });

  // --- Per-server multiplexing toggle ---

  it("server with multiplexing: false bypasses pool even when globally enabled", async () => {
    const noMuxServer: ServerConfig = { ...testServer, multiplexing: false };
    const conn1 = createMockConnection();
    const conn2 = createMockConnection();
    const f = createMockFactory([conn1, conn2]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease1 = await p.connect(noMuxServer);
    const lease2 = await p.connect(noMuxServer);
    // Each connect should call factory directly (no pooling)
    expect(f.connect).toHaveBeenCalledTimes(2);
    // Connections should be distinct raw connections, not pooled wrappers
    expect(lease1).not.toBe(lease2);
  });

  it("server with multiplexing: undefined follows global setting (pooled)", async () => {
    const f = createMockFactory();
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    await p.connect(testServer); // testServer has no multiplexing field
    await p.connect(testServer);
    expect(f.connect).toHaveBeenCalledTimes(1); // reused
  });

  it("server with multiplexing: true uses pool when globally enabled", async () => {
    const muxServer: ServerConfig = { ...testServer, multiplexing: true };
    const f = createMockFactory();
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    await p.connect(muxServer);
    await p.connect(muxServer);
    expect(f.connect).toHaveBeenCalledTimes(1); // reused
  });

  it("server with multiplexing: true overrides global disabled and still uses pool", async () => {
    const muxServer: ServerConfig = { ...testServer, multiplexing: true };
    const f = createMockFactory();
    const p = new SshConnectionPool(f, { enabled: false, idleTimeoutMs: 5000 });

    await p.connect(muxServer);
    await p.connect(muxServer);
    expect(f.connect).toHaveBeenCalledTimes(1); // reused
  });

  // --- Multiplexing fallback ---

  it("falls back to standalone connection when openShell fails on reused pooled connection", async () => {
    const pooledConn = createMockConnection();
    let shellCallCount = 0;
    pooledConn.openShell = vi.fn(async () => {
      shellCallCount++;
      if (shellCallCount > 1) {
        throw new Error("Channel open failure: Administratively prohibited");
      }
      return {} as any;
    });
    const standaloneConn = createMockConnection();
    standaloneConn.openShell = vi.fn(async () => ({ standalone: true }) as any);

    const f = createMockFactory([pooledConn, standaloneConn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    // First lease — openShell succeeds on pooled connection
    const lease1 = await p.connect(testServer);
    await lease1.openShell();

    // Second lease — openShell should fail on pooled, fallback to standalone
    const lease2 = await p.connect(testServer);
    const stream = await lease2.openShell();
    expect(stream).toEqual({ standalone: true });
    // Factory called twice: pooled + standalone fallback
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it("fallback is not offered on fresh (non-reused) connection", async () => {
    const conn = createMockConnection();
    conn.openShell = vi.fn(async () => {
      throw new Error("Channel open failure");
    });
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    // First and only lease — no fallback, error propagates directly
    const lease = await p.connect(testServer);
    await expect(lease.openShell()).rejects.toThrow("Channel open failure");
    // Factory called only once (no fallback attempt)
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it("fallback properly cleans up: standalone disposed on lease dispose, pooled survives for other leases", async () => {
    const pooledConn = createMockConnection();
    let pooledShellCalls = 0;
    pooledConn.openShell = vi.fn(async () => {
      pooledShellCalls++;
      if (pooledShellCalls > 1) {
        throw new Error("Channel open failure: Administratively prohibited");
      }
      return {} as any;
    });
    const standaloneConn = createMockConnection();
    standaloneConn.openShell = vi.fn(async () => ({}) as any);

    const f = createMockFactory([pooledConn, standaloneConn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    // First lease opens shell successfully on pooled connection
    const lease1 = await p.connect(testServer);
    await lease1.openShell();

    // Second lease triggers fallback — soft-removes pool entry
    const lease2 = await p.connect(testServer);
    await lease2.openShell();

    // Pooled connection should NOT be disposed yet (lease1 still holds it)
    expect(pooledConn.dispose).not.toHaveBeenCalled();

    // Dispose fallback lease — standalone connection should be disposed
    lease2.dispose();
    expect(standaloneConn.dispose).toHaveBeenCalled();
    // Pooled still alive because lease1 holds it
    expect(pooledConn.dispose).not.toHaveBeenCalled();

    // Dispose last lease — now pooled connection is orphaned and should be disposed
    lease1.dispose();
    expect(pooledConn.dispose).toHaveBeenCalled();
  });

  it("does not fall back on connection-refused channel errors from reused pooled connection", async () => {
    const pooledConn = createMockConnection();
    let directTcpCalls = 0;
    pooledConn.openDirectTcp = vi.fn(async () => {
      directTcpCalls++;
      if (directTcpCalls > 1) {
        throw new Error("Channel open failure: Connection refused");
      }
      return {} as any;
    });
    const standaloneConn = createMockConnection();
    const f = createMockFactory([pooledConn, standaloneConn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 5000 });

    const lease1 = await p.connect(testServer);
    await lease1.openDirectTcp("127.0.0.1", 8080);

    const lease2 = await p.connect(testServer);
    await expect(lease2.openDirectTcp("127.0.0.1", 8080)).rejects.toThrow("Connection refused");
    expect(f.connect).toHaveBeenCalledTimes(1); // no fallback connection created
  });

  it("idle timeout 0 means keep alive until explicit disconnect", async () => {
    const conn = createMockConnection();
    const f = createMockFactory([conn]);
    const p = new SshConnectionPool(f, { enabled: true, idleTimeoutMs: 0 });

    const lease = await p.connect(testServer);
    lease.dispose();

    // Even after a long time, connection should not be disposed
    vi.advanceTimersByTime(10_000_000);
    expect(conn.dispose).not.toHaveBeenCalled();

    // Only explicit disconnect closes it
    p.disconnect(testServer.id);
    expect(conn.dispose).toHaveBeenCalled();
  });
});
