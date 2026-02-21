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

  it("manages explicit groups", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("Dev");
    await core.addGroup("Prod");
    expect(core.getSnapshot().explicitGroups).toContain("Dev");
    expect(core.getSnapshot().explicitGroups).toContain("Prod");
    expect(core.getSnapshot().explicitGroups).toHaveLength(2);

    await core.removeExplicitGroup("Dev");
    expect(core.getSnapshot().explicitGroups).not.toContain("Dev");
    expect(core.getSnapshot().explicitGroups).toHaveLength(1);

    await core.renameExplicitGroup("Prod", "Production");
    expect(core.getSnapshot().explicitGroups).not.toContain("Prod");
    expect(core.getSnapshot().explicitGroups).toContain("Production");
    expect(core.getSnapshot().explicitGroups).toHaveLength(1);
  });

  it("loads explicit groups from repository on initialize", async () => {
    const repository = new InMemoryConfigRepository([], [], [], ["Saved Group"]);
    const core = new NexusCore(repository);
    await core.initialize();

    expect(core.getSnapshot().explicitGroups).toContain("Saved Group");
    expect(core.getSnapshot().explicitGroups).toHaveLength(1);
  });

  it("manages remote tunnels via setRemoteTunnels", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    expect(core.getSnapshot().remoteTunnels).toHaveLength(0);

    const entries = [
      {
        profileId: "t1",
        serverId: "s1",
        localPort: 8080,
        remoteIP: "10.0.0.5",
        remotePort: 3306,
        connectionMode: "shared" as const,
        startedAt: Date.now(),
        ownerSessionId: "other-window"
      }
    ];
    core.setRemoteTunnels(entries);

    const snapshot = core.getSnapshot();
    expect(snapshot.remoteTunnels).toHaveLength(1);
    expect(snapshot.remoteTunnels[0].profileId).toBe("t1");
    expect(snapshot.remoteTunnels[0].ownerSessionId).toBe("other-window");

    core.setRemoteTunnels([]);
    expect(core.getSnapshot().remoteTunnels).toHaveLength(0);
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

  it("addGroup registers ancestor paths for nested folders", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("A/B/C");
    const groups = core.getSnapshot().explicitGroups;
    expect(groups).toContain("A");
    expect(groups).toContain("A/B");
    expect(groups).toContain("A/B/C");
    expect(groups).toHaveLength(3);
  });

  it("addGroup rejects invalid paths", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("../evil");
    expect(core.getSnapshot().explicitGroups).toHaveLength(0);

    await core.addGroup("");
    expect(core.getSnapshot().explicitGroups).toHaveLength(0);
  });

  it("moveFolder moves a folder and all descendant items", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("Prod/US");
    await core.addOrUpdateServer({
      id: "s1", name: "S1", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "Prod/US"
    });
    await core.addOrUpdateSerialProfile({
      id: "sp1", name: "SP1", path: "COM1", baudRate: 9600,
      dataBits: 8, stopBits: 1, parity: "none", rtscts: false, group: "Prod"
    });

    await core.moveFolder("Prod", "Staging");
    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBe("Staging/Prod/US");
    expect(snapshot.serialProfiles[0].group).toBe("Staging/Prod");
    expect(snapshot.explicitGroups).toContain("Staging/Prod/US");
    expect(snapshot.explicitGroups).toContain("Staging/Prod");
    expect(snapshot.explicitGroups).toContain("Staging");
    expect(snapshot.explicitGroups).not.toContain("Prod");
  });

  it("moveFolder to root removes parent prefix", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("Parent/Child");
    await core.addOrUpdateServer({
      id: "s1", name: "S1", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "Parent/Child"
    });

    await core.moveFolder("Parent/Child", undefined);
    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBe("Child");
    expect(snapshot.explicitGroups).toContain("Child");
    expect(snapshot.explicitGroups).not.toContain("Parent/Child");
  });

  it("moveFolder rejects cycle (moving into own descendant)", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("A/B/C");
    await core.moveFolder("A", "A/B");
    // Should be unchanged — the move was rejected
    expect(core.getSnapshot().explicitGroups).toContain("A");
    expect(core.getSnapshot().explicitGroups).toContain("A/B");
  });

  it("renameFolder renames a folder and updates descendants", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("Dev/Frontend");
    await core.addOrUpdateServer({
      id: "s1", name: "S1", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "Dev/Frontend"
    });

    await core.renameFolder("Dev", "Development");
    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBe("Development/Frontend");
    expect(snapshot.explicitGroups).toContain("Development");
    expect(snapshot.explicitGroups).toContain("Development/Frontend");
    expect(snapshot.explicitGroups).not.toContain("Dev");
  });

  it("removeFolderCascade with deleteContents removes items", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("ToDelete/Sub");
    await core.addOrUpdateServer({
      id: "s1", name: "S1", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "ToDelete"
    });
    await core.addOrUpdateServer({
      id: "s2", name: "S2", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "ToDelete/Sub"
    });
    await core.addOrUpdateServer({
      id: "s3", name: "S3", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "Safe"
    });

    await core.removeFolderCascade("ToDelete", true);
    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].id).toBe("s3");
    expect(snapshot.explicitGroups).not.toContain("ToDelete");
    expect(snapshot.explicitGroups).not.toContain("ToDelete/Sub");
  });

  it("removeFolderCascade without deleteContents moves items to parent", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("Parent/ToRemove");
    await core.addOrUpdateServer({
      id: "s1", name: "S1", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "Parent/ToRemove"
    });

    await core.removeFolderCascade("Parent/ToRemove", false);
    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBe("Parent");
    expect(snapshot.explicitGroups).not.toContain("Parent/ToRemove");
    expect(snapshot.explicitGroups).toContain("Parent");
  });

  it("removeFolderCascade root folder moves items to ungrouped", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addGroup("RootFolder");
    await core.addOrUpdateServer({
      id: "s1", name: "S1", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "RootFolder"
    });

    await core.removeFolderCascade("RootFolder", false);
    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBeUndefined();
    expect(snapshot.explicitGroups).not.toContain("RootFolder");
  });

  it("migrates legacy slash groups on initialize", async () => {
    const repository = new InMemoryConfigRepository(
      [{
        id: "s1", name: "S1", host: "h", port: 22, username: "u",
        authType: "password", isHidden: false, group: "US/East"
      }],
      [],
      [{
        id: "sp1", name: "SP1", path: "COM1", baudRate: 9600,
        dataBits: 8, stopBits: 1, parity: "none", rtscts: false, group: "Lab/Main"
      }],
      ["Legacy/Group"]
    );
    const core = new NexusCore(repository);
    await core.initialize();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBe("US-East");
    expect(snapshot.serialProfiles[0].group).toBe("Lab-Main");
    expect(snapshot.explicitGroups).toContain("Legacy-Group");
    expect(snapshot.explicitGroups).not.toContain("Legacy/Group");
  });

  it("getItemsInFolder returns direct items when not recursive", async () => {
    const repository = new InMemoryConfigRepository();
    const core = new NexusCore(repository);
    await core.initialize();

    await core.addOrUpdateServer({
      id: "s1", name: "S1", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "A"
    });
    await core.addOrUpdateServer({
      id: "s2", name: "S2", host: "h", port: 22, username: "u",
      authType: "password", isHidden: false, group: "A/B"
    });

    const direct = core.getItemsInFolder("A", false);
    expect(direct.servers).toHaveLength(1);
    expect(direct.servers[0].id).toBe("s1");

    const recursive = core.getItemsInFolder("A", true);
    expect(recursive.servers).toHaveLength(2);
  });
});
