import { describe, expect, it } from "vitest";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import {
  assertInventorySourceDependenciesCurrent,
  assertInventorySourceDependenciesRemainValid,
  assertInventorySourceDependenciesSurvive,
  snapshotInventorySourceDependencies
} from "../../src/services/inventory/inventorySourceDependencies";

function makeServer(id: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id,
    name: id,
    host: `${id}.example.test`,
    port: 22,
    username: `${id}-user`,
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

function chain(): ServerConfig[] {
  return [
    makeServer("lab-host", { proxy: { type: "ssh", jumpHostId: "jump-one" } }),
    makeServer("jump-one", { proxy: { type: "ssh", jumpHostId: "jump-two" } }),
    makeServer("jump-two")
  ];
}

describe("inventory source SSH dependencies", () => {
  it("captures the lab host and every SSH jump hop in route order", () => {
    const snapshot = snapshotInventorySourceDependencies("lab-host", chain(), []);

    expect(snapshot.serverIds).toEqual(["lab-host", "jump-one", "jump-two"]);
    expect(snapshot.identity).toEqual(expect.any(String));
  });

  it("changes canonical identity when a deep hop endpoint changes", () => {
    const before = chain();
    const after = chain();
    after[2] = makeServer("jump-two", { host: "changed.example.test" });

    expect(snapshotInventorySourceDependencies("lab-host", after, []).identity).not.toBe(
      snapshotInventorySourceDependencies("lab-host", before, []).identity
    );
  });

  it("changes canonical identity when effective auth profile identity changes", () => {
    const source = [makeServer("lab-host", { authProfileId: "lab-auth" })];
    const profile = (keyPath: string): AuthProfile => ({
      id: "lab-auth",
      name: "Lab login",
      username: "operator",
      authType: "key",
      keyPath
    });

    expect(snapshotInventorySourceDependencies("lab-host", source, [profile("/keys/old")]).identity).not.toBe(
      snapshotInventorySourceDependencies("lab-host", source, [profile("/keys/new")]).identity
    );
  });

  it("changes canonical identity when configured proxy routing details change", () => {
    const before = [makeServer("lab-host", { proxy: { type: "socks5", host: "proxy-a.example.test", port: 1080, username: "route-a" } })];
    const after = [makeServer("lab-host", { proxy: { type: "socks5", host: "proxy-b.example.test", port: 1080, username: "route-a" } })];

    expect(snapshotInventorySourceDependencies("lab-host", after, []).identity).not.toBe(
      snapshotInventorySourceDependencies("lab-host", before, []).identity
    );
  });

  it("flattens untrusted dependency names while preserving combining, ZWJ, and tag sequences", () => {
    const combining = "e\u0301";
    const zwjSequence = "\u{1f469}\u200d\u{1f4bb}";
    const tagSequence = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    const hostileName = `lab\u202ehost\n${combining}${zwjSequence}${tagSequence}`;
    let detail = "";
    try {
      snapshotInventorySourceDependencies("lab-host", [makeServer("lab-host", { name: hostileName, protocol: "telnet" })], []);
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }

    expect(detail).toContain(`lab host ${combining}${zwjSequence}${tagSequence}`);
    expect(detail).not.toContain("\u202e");
    expect(detail).not.toContain("\n");
    expect(detail).toContain(combining);
    expect(detail).toContain(zwjSequence);
    expect(detail).toContain(tagSequence);
  });

  it("does not place password-like extra fields in the canonical identity", () => {
    const profile = {
      id: "lab-auth",
      name: "Lab login",
      username: "operator",
      authType: "password",
      password: "must-not-appear"
    } as AuthProfile & { password: string };
    const server = makeServer("lab-host", { authProfileId: profile.id });

    expect(snapshotInventorySourceDependencies("lab-host", [server], [profile]).identity).not.toContain("must-not-appear");
  });

  it.each([
    ["a missing lab host", "lab-host", []],
    ["a missing jump hop", "lab-host", [makeServer("lab-host", { proxy: { type: "ssh", jumpHostId: "missing-hop" } })]],
    ["a cycle", "lab-host", [makeServer("lab-host", { proxy: { type: "ssh", jumpHostId: "jump-one" } }), makeServer("jump-one", { proxy: { type: "ssh", jumpHostId: "lab-host" } })]],
    ["a non-SSH lab host", "lab-host", [makeServer("lab-host", { protocol: "telnet" })]],
    ["a non-SSH jump hop", "lab-host", [makeServer("lab-host", { proxy: { type: "ssh", jumpHostId: "jump-one" } }), makeServer("jump-one", { protocol: "telnet" })]],
    ["an addressless lab host", "lab-host", [makeServer("lab-host", { host: "", addressless: true })]],
    ["an addressless jump hop", "lab-host", [makeServer("lab-host", { proxy: { type: "ssh", jumpHostId: "jump-one" } }), makeServer("jump-one", { host: "", addressless: true })]]
  ])("fails closed for %s", (_label, labHostId, servers) => {
    expect(() => snapshotInventorySourceDependencies(labHostId, servers as ServerConfig[], [])).toThrow(/SSH|jump|host|address/i);
  });

  it("requires every captured dependency to survive the effective prune plan", () => {
    const snapshot = snapshotInventorySourceDependencies("lab-host", chain(), []);

    expect(() => assertInventorySourceDependenciesSurvive(snapshot, new Set(snapshot.serverIds))).not.toThrow();
    expect(() => assertInventorySourceDependenciesSurvive(snapshot, new Set(["lab-host", "jump-one"]))).toThrow(
      /jump|discovery|host/i
    );
  });

  it("validates the full effective route after removals and upserts without rejecting valid identity changes", () => {
    const before = chain();
    const snapshot = snapshotInventorySourceDependencies("lab-host", before, []);
    const updatedHop = { ...before[1], host: "updated.example.test" };
    expect(() => assertInventorySourceDependenciesRemainValid(snapshot, before, [], [updatedHop], [])).not.toThrow();

    const cycle = { ...before[1], proxy: { type: "ssh" as const, jumpHostId: "lab-host" } };
    expect(() => assertInventorySourceDependenciesRemainValid(snapshot, before, [], [cycle], []))
      .toThrow(/cycle|Keep Direct|Device Connection/i);
    const invalidHop = { ...before[1], host: "", addressless: true };
    expect(() => assertInventorySourceDependenciesRemainValid(snapshot, before, [], [invalidHop], []))
      .toThrow(/address/i);
  });

  it("uses the effective linked auth profile and treats an orphan after-record as the final upsert", () => {
    const profile: AuthProfile = { id: "jump-auth", name: "Jump login", username: "operator", authType: "key", keyPath: "/keys/old" };
    const before = [
      makeServer("lab-host", { proxy: { type: "ssh", jumpHostId: "jump-one" } }),
      makeServer("jump-one", { username: "", authProfileId: profile.id, proxy: { type: "ssh", jumpHostId: "jump-two" } }),
      makeServer("jump-two")
    ];
    const snapshot = snapshotInventorySourceDependencies("lab-host", before, [profile]);
    const orphanAfter = { ...before[1], proxy: undefined };
    const updatedProfile = { ...profile, keyPath: "/keys/new" };

    expect(() => assertInventorySourceDependenciesRemainValid(snapshot, before, ["jump-one"], [orphanAfter], [updatedProfile]))
      .not.toThrow();
    expect(() => assertInventorySourceDependenciesRemainValid(
      snapshot, before, [], [], [{ ...profile, username: "" }]
    )).toThrow(/authentication username/i);

    const fallbackServers = before.map((server) => server.id === "jump-one" ? { ...server, username: "fallback-user" } : server);
    const fallbackSnapshot = snapshotInventorySourceDependencies("lab-host", fallbackServers, [{ ...profile, username: "" }]);
    expect(() => assertInventorySourceDependenciesRemainValid(
      fallbackSnapshot, fallbackServers, [], [], [{ ...profile, username: "" }]
    )).not.toThrow();
  });

  it("rejects connection, auth, or proxy changes since discovery was captured", () => {
    const before = chain();
    const snapshot = snapshotInventorySourceDependencies("lab-host", before, []);
    const changed = chain();
    changed[1] = makeServer("jump-one", { username: "changed-user" });

    expect(() => assertInventorySourceDependenciesCurrent(snapshot, changed, [])).toThrow(/changed|identity|dependency/i);
  });
});
