import { describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { validateAuthProfile } from "../../src/utils/validation";
import { authProfilePasswordSecretKey, passwordSecretKey } from "../../src/services/ssh/silentAuth";
import type { SecretVault } from "../../src/services/ssh/contracts";

function makeServer(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    id: "s1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "olduser",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

function makeAuthProfile(overrides?: Partial<AuthProfile>): AuthProfile {
  return {
    id: "ap1",
    name: "Production",
    username: "root",
    authType: "password",
    ...overrides
  };
}

function makeVault(): SecretVault & { store: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  const storage = new Map<string, string>();
  return {
    store: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    get: vi.fn(async (key: string) => storage.get(key)),
    delete: vi.fn(async (key: string) => { storage.delete(key); })
  };
}

describe("validateAuthProfile", () => {
  it("accepts valid profile", () => {
    expect(validateAuthProfile(makeAuthProfile())).toBe(true);
  });

  it("accepts key auth profile", () => {
    expect(validateAuthProfile(makeAuthProfile({ authType: "key", keyPath: "/path/to/key" }))).toBe(true);
  });

  it("accepts agent auth profile", () => {
    expect(validateAuthProfile(makeAuthProfile({ authType: "agent" }))).toBe(true);
  });

  it("rejects missing name", () => {
    expect(validateAuthProfile({ id: "x", name: "", username: "root", authType: "password" })).toBe(false);
  });

  it("rejects missing username", () => {
    expect(validateAuthProfile({ id: "x", name: "Test", username: "", authType: "password" })).toBe(false);
  });

  it("rejects invalid authType", () => {
    expect(validateAuthProfile({ id: "x", name: "Test", username: "root", authType: "invalid" })).toBe(false);
  });

  it("rejects null", () => {
    expect(validateAuthProfile(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(validateAuthProfile("string")).toBe(false);
  });
});

describe("authProfilePasswordSecretKey", () => {
  it("returns the correct key format", () => {
    expect(authProfilePasswordSecretKey("abc-123")).toBe("auth-profile-password-abc-123");
  });
});

describe("NexusCore auth profile CRUD", () => {
  it("initializes with auth profiles from repository", async () => {
    const profile = makeAuthProfile();
    const repo = new InMemoryConfigRepository([], [], [], [], [profile]);
    const core = new NexusCore(repo);
    await core.initialize();

    const snapshot = core.getSnapshot();
    expect(snapshot.authProfiles).toHaveLength(1);
    expect(snapshot.authProfiles[0].name).toBe("Production");
  });

  it("adds and retrieves an auth profile", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();

    const profile = makeAuthProfile();
    await core.addOrUpdateAuthProfile(profile);

    expect(core.getAuthProfile("ap1")).toEqual(profile);
    expect(core.getSnapshot().authProfiles).toHaveLength(1);
  });

  it("updates an existing auth profile", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();

    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.addOrUpdateAuthProfile(makeAuthProfile({ name: "Staging" }));

    expect(core.getAuthProfile("ap1")?.name).toBe("Staging");
    expect(core.getSnapshot().authProfiles).toHaveLength(1);
  });

  it("removes an auth profile", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();

    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.removeAuthProfile("ap1");

    expect(core.getAuthProfile("ap1")).toBeUndefined();
    expect(core.getSnapshot().authProfiles).toHaveLength(0);
  });

  it("emits change events", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();

    const listener = vi.fn();
    core.onDidChange(listener);

    await core.addOrUpdateAuthProfile(makeAuthProfile());
    expect(listener).toHaveBeenCalledTimes(1);

    await core.removeAuthProfile("ap1");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("persists auth profiles through repository", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();

    await core.addOrUpdateAuthProfile(makeAuthProfile());

    // Verify persistence by creating a new core from the same repo
    const core2 = new NexusCore(repo);
    await core2.initialize();
    expect(core2.getSnapshot().authProfiles).toHaveLength(1);
    expect(core2.getAuthProfile("ap1")?.name).toBe("Production");
  });
});

describe("NexusCore.applyAuthProfileToFolder", () => {
  it("stamps username and authType onto servers in the folder", async () => {
    const servers = [
      makeServer({ id: "s1", group: "US/East", username: "olduser", authType: "password" }),
      makeServer({ id: "s2", name: "Server 2", group: "US/East", username: "olduser", authType: "password" }),
      makeServer({ id: "s3", name: "Server 3", group: "EU/West", username: "olduser", authType: "password" })
    ];
    const profile = makeAuthProfile({ username: "root", authType: "key", keyPath: "/path/to/key" });
    const repo = new InMemoryConfigRepository(servers, [], [], [], [profile]);
    const core = new NexusCore(repo);
    await core.initialize();

    const vault = makeVault();
    const count = await core.applyAuthProfileToFolder("ap1", "US/East", vault, undefined);

    expect(count).toBe(2);
    const snapshot = core.getSnapshot();
    const s1 = snapshot.servers.find((s) => s.id === "s1")!;
    const s2 = snapshot.servers.find((s) => s.id === "s2")!;
    const s3 = snapshot.servers.find((s) => s.id === "s3")!;

    expect(s1.username).toBe("root");
    expect(s1.authType).toBe("key");
    expect(s1.keyPath).toBe("/path/to/key");
    expect(s2.username).toBe("root");
    expect(s3.username).toBe("olduser"); // untouched
  });

  it("copies password to each server vault key for password auth", async () => {
    const servers = [
      makeServer({ id: "s1", group: "Prod", username: "olduser" }),
      makeServer({ id: "s2", name: "Server 2", group: "Prod", username: "olduser" })
    ];
    const profile = makeAuthProfile({ username: "admin", authType: "password" });
    const repo = new InMemoryConfigRepository(servers, [], [], [], [profile]);
    const core = new NexusCore(repo);
    await core.initialize();

    const vault = makeVault();
    await core.applyAuthProfileToFolder("ap1", "Prod", vault, "secret123");

    expect(vault.store).toHaveBeenCalledWith(passwordSecretKey("s1"), "secret123");
    expect(vault.store).toHaveBeenCalledWith(passwordSecretKey("s2"), "secret123");
  });

  it("deletes server password when switching to key auth", async () => {
    const servers = [
      makeServer({ id: "s1", group: "Prod", username: "olduser", authType: "password" })
    ];
    const profile = makeAuthProfile({ username: "admin", authType: "key", keyPath: "/key" });
    const repo = new InMemoryConfigRepository(servers, [], [], [], [profile]);
    const core = new NexusCore(repo);
    await core.initialize();

    const vault = makeVault();
    await core.applyAuthProfileToFolder("ap1", "Prod", vault, undefined);

    expect(vault.delete).toHaveBeenCalledWith(passwordSecretKey("s1"));
  });

  it("returns 0 for nonexistent profile", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();

    const vault = makeVault();
    const count = await core.applyAuthProfileToFolder("nonexistent", "Prod", vault, undefined);
    expect(count).toBe(0);
  });

  it("applies to servers in nested folders", async () => {
    const servers = [
      makeServer({ id: "s1", group: "US/East/DC1" }),
      makeServer({ id: "s2", name: "Server 2", group: "US/East" })
    ];
    const profile = makeAuthProfile({ username: "admin" });
    const repo = new InMemoryConfigRepository(servers, [], [], [], [profile]);
    const core = new NexusCore(repo);
    await core.initialize();

    const vault = makeVault();
    const count = await core.applyAuthProfileToFolder("ap1", "US/East", vault, undefined);
    expect(count).toBe(2);
  });
});
