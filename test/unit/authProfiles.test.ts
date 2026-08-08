import { describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile } from "../../src/models/config";
import { authProfileOwnedCredentials } from "../../src/models/config";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { validateAuthProfile } from "../../src/utils/validation";
import { authProfilePassphraseSecretKey, authProfilePasswordSecretKey } from "../../src/services/ssh/silentAuth";

function makeAuthProfile(overrides?: Partial<AuthProfile>): AuthProfile {
  return {
    id: "ap1",
    name: "Production",
    username: "root",
    authType: "password",
    ...overrides
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

/**
 * REVIEW FINDING (P2) — THE ONE RULE the connect path
 * (`SilentAuthSshFactory.resolveServer`), the save path
 * (`preserveLinkedServerCredentials`) and the form path
 * (`authProfileFilledKeys` + the two `onAutofill` mirrors) all read. Before it
 * existed each answered "which fields does this profile own?" separately, and
 * the two P2 findings on this branch were two of those answers disagreeing.
 */
describe("authProfileOwnedCredentials — the shared field-ownership rule", () => {
  it("owns every field it supplies a usable value for", () => {
    expect(authProfileOwnedCredentials(makeAuthProfile({ authType: "key", keyPath: "/keys/id" }))).toEqual({
      username: "root",
      authType: "key",
      keyPath: "/keys/id"
    });
  });

  it("does NOT own a whitespace-only username — the imported-backup case validateAuthProfile lets through, which is why it accepts one two tests up", () => {
    const profile = makeAuthProfile({ username: "   " });
    expect(validateAuthProfile(profile)).toBe(true); // reachable, therefore load-bearing
    expect(authProfileOwnedCredentials(profile)).toEqual({ authType: "password" });
  });

  it("does NOT own a key path a key profile does not carry — absent or blank alike", () => {
    expect(authProfileOwnedCredentials(makeAuthProfile({ authType: "key" }))).toEqual({
      username: "root",
      authType: "key"
    });
    expect(authProfileOwnedCredentials(makeAuthProfile({ authType: "key", keyPath: "  " }))).toEqual({
      username: "root",
      authType: "key"
    });
  });

  it("always owns authType — a closed enum that is never blank", () => {
    expect(authProfileOwnedCredentials(makeAuthProfile({ username: " ", authType: "agent" })).authType).toBe("agent");
  });

  it("hands back trimmed values, so a form's display and a connection's config cannot differ", () => {
    expect(authProfileOwnedCredentials(makeAuthProfile({ username: "  bob  ", authType: "key", keyPath: " /keys/id " })))
      .toEqual({ username: "bob", authType: "key", keyPath: "/keys/id" });
  });

  it("owns nothing for no profile — an unlinked server, or an id that resolves to nothing", () => {
    expect(authProfileOwnedCredentials(undefined)).toEqual({});
  });
});

describe("authProfilePasswordSecretKey", () => {
  it("returns the correct key format", () => {
    expect(authProfilePasswordSecretKey("abc-123")).toBe("auth-profile-password-abc-123");
  });
});

describe("authProfilePassphraseSecretKey", () => {
  it("returns the correct key format", () => {
    expect(authProfilePassphraseSecretKey("abc-123")).toBe("auth-profile-passphrase-abc-123");
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
