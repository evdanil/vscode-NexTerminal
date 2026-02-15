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

  it("updates existing server and tunnel in place by id", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addOrUpdateServer({
      id: "s1",
      name: "Server 1",
      host: "a.example.com",
      port: 22,
      username: "dev",
      authType: "password",
      isHidden: false
    });
    await core.addOrUpdateServer({
      id: "s1",
      name: "Server 1 Updated",
      host: "b.example.com",
      port: 22,
      username: "dev",
      authType: "password",
      isHidden: false
    });

    await core.addOrUpdateTunnel({
      id: "t1",
      name: "Tunnel",
      localPort: 1000,
      remoteIP: "127.0.0.1",
      remotePort: 1000,
      autoStart: false
    });
    await core.addOrUpdateTunnel({
      id: "t1",
      name: "Tunnel Updated",
      localPort: 1001,
      remoteIP: "127.0.0.1",
      remotePort: 1001,
      autoStart: false
    });

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].name).toBe("Server 1 Updated");
    expect(snapshot.tunnels).toHaveLength(1);
    expect(snapshot.tunnels[0].name).toBe("Tunnel Updated");
    expect(snapshot.tunnels[0].localPort).toBe(1001);
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

  it("persists serial profile CRUD and tracks serial sessions", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addOrUpdateSerialProfile({
      id: "sp1",
      name: "Lab UART",
      group: "Devices",
      path: "COM4",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false
    });

    core.registerSerialSession({
      id: "serial-session-1",
      profileId: "sp1",
      terminalName: "Nexus Serial: Lab UART",
      startedAt: Date.now()
    });

    expect(core.isSerialProfileConnected("sp1")).toBe(true);
    expect(core.getSnapshot().activeSerialSessions).toHaveLength(1);

    core.unregisterSerialSession("serial-session-1");
    expect(core.getSnapshot().activeSerialSessions).toHaveLength(0);

    await core.removeSerialProfile("sp1");
    expect(core.getSnapshot().serialProfiles).toHaveLength(0);
  });
});
