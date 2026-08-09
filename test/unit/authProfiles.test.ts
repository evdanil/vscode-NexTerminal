import { describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile } from "../../src/models/config";
import { authProfileNeedsServerKeyPath, authProfileOwnedCredentials } from "../../src/models/config";
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

  /**
   * REVIEW FINDING (P2) — `keyPath` was the one declared field this guard never
   * looked at, so a hand-edited backup or a version-skewed globalState row could
   * carry any JSON value there and still be handed downstream typed as
   * `AuthProfile`. It is settled here, at the boundary, because the consumers
   * are RENDERERS: `authProfileOwnedCredentials` trims it, and
   * `formatAuthProfileLabel` runs `path.posix.basename` over it for every option
   * of every Auth Profile select and every linked server's tree tooltip.
   */
  it("rejects a keyPath that is not a string (kills leaving the one optional declared field unchecked: the record loads typed as AuthProfile and the first string operation on it throws mid-render, taking out a form or the sidebar rather than one bad row)", () => {
    const base = { id: "x", name: "Imported", username: "root", authType: "key" };
    expect(validateAuthProfile({ ...base, keyPath: 12345 })).toBe(false);
    expect(validateAuthProfile({ ...base, keyPath: { path: "/keys/id" } })).toBe(false);
    expect(validateAuthProfile({ ...base, keyPath: ["/keys/id"] })).toBe(false);
    expect(validateAuthProfile({ ...base, keyPath: null })).toBe(false);
    expect(validateAuthProfile({ ...base, keyPath: true })).toBe(false);
  });

  it("still accepts an absent or EMPTY keyPath (kills tightening this with isOptionalNonEmptyString: \"\" reads identically to absent everywhere downstream, so rejecting it would discard a whole credential record — and, on the import path, its vault secrets and every server/source link to it — over a field that changes nothing)", () => {
    const base = { id: "x", name: "Imported", username: "root", authType: "key" };
    expect(validateAuthProfile(base)).toBe(true);
    expect(validateAuthProfile({ ...base, keyPath: "" })).toBe(true);
    expect(validateAuthProfile({ ...base, keyPath: "   " })).toBe(true);
    // …and both are "no usable key path" to the rule, so nothing downstream is
    // relying on this guard to have filtered them out.
    expect(authProfileOwnedCredentials({ ...base, authType: "key", keyPath: "" } as AuthProfile).keyPath).toBeUndefined();
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

  /**
   * REVIEW FINDING (P2) — the second half of the malformed-`keyPath` fix.
   * `validateAuthProfile` is what should stop such a record existing; this is
   * what stops one that got past a boundary (a profile built in-process, a
   * future writer, a caller that skipped the guard) taking a render down with
   * it. The unconditional `.trim()` this replaced threw for every consumer of
   * the rule at once — the tree, both mirrors, the lock seed, the sync plan.
   */
  it("owns no key path for a non-string one instead of throwing (kills (profile.keyPath ?? \"\").trim(): this rule runs while the tree and every profile-select form are rendering, where a TypeError is a view that never draws — not a rejected row)", () => {
    const malformed = {
      id: "ap-bad",
      name: "Imported",
      username: "root",
      authType: "key",
      keyPath: 12345
    } as unknown as AuthProfile;

    expect(() => authProfileOwnedCredentials(malformed)).not.toThrow();
    expect(authProfileOwnedCredentials(malformed)).toEqual({ username: "root", authType: "key" });
    // And it lands in the bucket blank already occupies, so the companion
    // predicate reaches the right conclusion for free: this profile cannot
    // serve a server that brings no key of its own.
    expect(authProfileNeedsServerKeyPath(malformed)).toBe(true);
  });
});

/**
 * REVIEW FINDING (P1) — the companion predicate, and the boundary between the
 * two. The rule above stays per-FIELD and unchanged: a keyless key profile
 * still owns `authType`, because a server that brings its own key file is a
 * legitimate, supported pairing (see the silentAuth test "keeps the server's
 * own key path when a key profile carries none"). What is unusable is the
 * PAIRING with a server that has no key path, which is every server an
 * inventory sync produces — so the question is asked separately, by whoever
 * decides such a pairing.
 */
describe("authProfileNeedsServerKeyPath — can a server with no key of its own use this profile?", () => {
  it("true only for key auth with no usable key path", () => {
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "key" }))).toBe(true);
    // Blank and whitespace-only are "no key path" under THE ONE RULE, and this
    // predicate must agree with it rather than testing the field's presence.
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "key", keyPath: "" }))).toBe(true);
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "key", keyPath: "   " }))).toBe(true);
  });

  it("false for a key profile that carries a key path — the pairing works, so nothing may reject it", () => {
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "key", keyPath: "/keys/id" }))).toBe(false);
    // Trimmed by THE ONE RULE, so a padded path is a real one.
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "key", keyPath: " /keys/id " }))).toBe(false);
  });

  it("false for password and agent profiles, whether or not they happen to carry a stale key path", () => {
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "password" }))).toBe(false);
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "agent" }))).toBe(false);
    // A key path left behind by an earlier edit is inert while authType is not
    // "key" — this must key on the auth type, not on the leftover field.
    expect(authProfileNeedsServerKeyPath(makeAuthProfile({ authType: "agent", keyPath: "/keys/id" }))).toBe(false);
  });

  it("false for no profile at all — nothing is being forced onto anything", () => {
    expect(authProfileNeedsServerKeyPath(undefined)).toBe(false);
  });

  it("the ownership rule is deliberately UNCHANGED by this: a keyless key profile still owns authType (kills 'fixing' P1 by dropping authType ownership, which would silently drop every linked server back to its own auth type)", () => {
    // Dropping `authType` here would send a synced server back to SSH agent
    // auth under a profile that says key auth — a silent credential
    // substitution — and would break the server-with-its-own-key pairing for
    // every server whose own authType is not already "key".
    expect(authProfileOwnedCredentials(makeAuthProfile({ authType: "key" })).authType).toBe("key");
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

/**
 * Issue #48 PR-B — a profile can be linked twice from one server (SSH and BMC),
 * and deleting it has to sweep both. A link left naming a deleted profile
 * resolves to nothing on every run, silently, with the server form showing an
 * empty select and no explanation anywhere.
 */
describe("removeAuthProfile — ipmiAuthProfileId links", () => {
  function makeServer(overrides: Partial<import("../../src/models/config").ServerConfig> = {}) {
    return {
      id: "s1",
      name: "Core Switch",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "password" as const,
      isHidden: false,
      ...overrides
    };
  }

  it("clears a server whose ONLY link to the deleted profile is the IPMI one", async () => {
    // `authProfileId` deliberately unset: with both links set, a sweep that
    // handles only `authProfileId` still enters the loop and the fixture proves
    // nothing about the new field.
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.addOrUpdateServer(makeServer({ ipmiAuthProfileId: "ap1" }));

    await core.removeAuthProfile("ap1");

    expect(core.getSnapshot().servers[0].ipmiAuthProfileId).toBeUndefined();
  });

  it("clears both links when one profile served as both credentials", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.addOrUpdateServer(makeServer({ authProfileId: "ap1", ipmiAuthProfileId: "ap1" }));

    await core.removeAuthProfile("ap1");

    const server = core.getSnapshot().servers[0];
    expect(server.authProfileId).toBeUndefined();
    expect(server.ipmiAuthProfileId).toBeUndefined();
  });

  it("leaves the OTHER link alone when only one names the deleted profile", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.addOrUpdateAuthProfile(makeAuthProfile({ id: "ap2", name: "BMC" }));
    await core.addOrUpdateServer(makeServer({ authProfileId: "ap2", ipmiAuthProfileId: "ap1" }));

    await core.removeAuthProfile("ap1");

    const server = core.getSnapshot().servers[0];
    expect(server.ipmiAuthProfileId).toBeUndefined();
    expect(server.authProfileId).toBe("ap2");
  });

  it("does NOT drop a user-divergence stamp when the server is reached only through its BMC link", async () => {
    // The scoping the new `||` condition could quietly break, and the ONLY
    // fixture that observes it: the sync linked ap1 as this server's SSH
    // credentials (the stamp says so) and the USER then moved the link to ap2 —
    // which is precisely the per-server opt-out the stamp exists to record. The
    // server now reaches this loop through its BMC link instead, and an
    // unguarded stamp clear would erase that opt-out, after which the next sync
    // re-attaches the source's profile to a server the user deliberately moved.
    //
    // Before this PR the server never entered the loop at all, so "the stamp
    // survives" is also the pre-existing behaviour being preserved.
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.addOrUpdateAuthProfile(makeAuthProfile({ id: "ap2", name: "SSH" }));
    await core.addOrUpdateServer(
      makeServer({
        authProfileId: "ap2",
        ipmiAuthProfileId: "ap1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1000, syncedAuthProfileId: "ap1" }
      })
    );

    await core.removeAuthProfile("ap1");

    const server = core.getSnapshot().servers[0];
    expect(server.ipmiAuthProfileId).toBeUndefined();
    expect(server.origin?.syncedAuthProfileId).toBe("ap1");
    expect(server.authProfileId).toBe("ap2");
  });

  it("still drops the stamp when the SSH link itself is the one being cleared", async () => {
    // The other side of the guard: this is the case the stamp clear exists for,
    // and a guard written too tightly would break it.
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.addOrUpdateServer(
      makeServer({
        authProfileId: "ap1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1000, syncedAuthProfileId: "ap1" }
      })
    );

    await core.removeAuthProfile("ap1");

    expect(core.getSnapshot().servers[0].origin?.syncedAuthProfileId).toBeUndefined();
  });
});
