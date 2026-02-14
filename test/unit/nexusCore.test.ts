import { describe, expect, it } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

describe("NexusCore", () => {
  it("loads initial servers and tunnels from repository", async () => {
    const repository = new InMemoryConfigRepository(
      [
        {
          id: "s1",
          name: "Server 1",
          host: "127.0.0.1",
          port: 22,
          username: "dev",
          authType: "password",
          isHidden: false
        }
      ],
      [
        {
          id: "t1",
          name: "DB tunnel",
          localPort: 5432,
          remoteIP: "127.0.0.1",
          remotePort: 5432,
          autoStart: false
        }
      ]
    );
    const core = new NexusCore(repository);

    await core.initialize();
    const snapshot = core.getSnapshot();

    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.tunnels).toHaveLength(1);
  });

  it("persists server CRUD and tracks sessions", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addOrUpdateServer({
      id: "s1",
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password",
      isHidden: false
    });
    core.registerSession({
      id: "session-1",
      serverId: "s1",
      terminalName: "Nexus SSH: Server 1",
      startedAt: Date.now()
    });

    expect(core.getSnapshot().activeSessions).toHaveLength(1);
    expect(core.isServerConnected("s1")).toBe(true);

    core.unregisterSession("session-1");
    expect(core.getSnapshot().activeSessions).toHaveLength(0);

    await core.removeServer("s1");
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("tracks tunnel lifecycle and traffic counters", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addOrUpdateTunnel({
      id: "t1",
      name: "Redis",
      localPort: 6379,
      remoteIP: "127.0.0.1",
      remotePort: 6379,
      autoStart: false
    });

    core.registerTunnel({
      id: "active-1",
      profileId: "t1",
      serverId: "s1",
      localPort: 6379,
      remoteIP: "127.0.0.1",
      remotePort: 6379,
      startedAt: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
      connectionMode: "isolated"
    });
    core.updateTunnelTraffic("active-1", 128, 256);

    const active = core.getSnapshot().activeTunnels[0];
    expect(active.bytesIn).toBe(128);
    expect(active.bytesOut).toBe(256);

    core.unregisterTunnel("active-1");
    expect(core.getSnapshot().activeTunnels).toHaveLength(0);
  });
});
