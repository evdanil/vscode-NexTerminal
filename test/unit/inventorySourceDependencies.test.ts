import { describe, expect, it } from "vitest";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import {
  assertInventorySourceDependenciesCurrent,
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

  it("rejects connection, auth, or proxy changes since discovery was captured", () => {
    const before = chain();
    const snapshot = snapshotInventorySourceDependencies("lab-host", before, []);
    const changed = chain();
    changed[1] = makeServer("jump-one", { username: "changed-user" });

    expect(() => assertInventorySourceDependenciesCurrent(snapshot, changed, [])).toThrow(/changed|identity|dependency/i);
  });
});
