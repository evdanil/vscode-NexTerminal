import { describe, expect, it } from "vitest";
import { POOLED_CONNECTION_FIELDS, pooledConnectionParamsChanged, serversRidingChangedJumps } from "../../src/services/ssh/pooledConnectionParams";
import type { ServerConfig } from "../../src/models/config";
import { connectDescriptor } from "../../src/models/startDescriptors";
import { SERVER_FIELDS } from "../helpers/serverFieldClassification";

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Server 1",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

describe("pooledConnectionParamsChanged (PR #67 Codex round 2 — altHost pool invalidation)", () => {
  it("returns TRUE when altHost changes (kills omitting altHost from the invalidation predicate)", () => {
    const prev = makeServer({ altHost: "2001:db8::1" });
    const next = makeServer({ altHost: "2001:db8::2" });
    // A pooled connection could have been established against the OLD alternate; it
    // MUST be invalidated. Against a predicate that ignores altHost this is false and
    // the stale connection to the old machine is reused.
    expect(pooledConnectionParamsChanged(prev, next)).toBe(true);
  });

  it("returns TRUE when altHost is added or cleared", () => {
    expect(pooledConnectionParamsChanged(makeServer(), makeServer({ altHost: "2001:db8::1" }))).toBe(true);
    expect(pooledConnectionParamsChanged(makeServer({ altHost: "2001:db8::1" }), makeServer())).toBe(true);
  });

  it("returns TRUE for the other connection-affecting fields (regression)", () => {
    expect(pooledConnectionParamsChanged(makeServer(), makeServer({ host: "10.0.0.2" }))).toBe(true);
    expect(pooledConnectionParamsChanged(makeServer(), makeServer({ port: 2222 }))).toBe(true);
    expect(pooledConnectionParamsChanged(makeServer(), makeServer({ proxy: { type: "ssh", jumpHostId: "j" } }))).toBe(true);
  });

  it("returns FALSE when nothing connection-affecting changed (a rename must not drop live connections)", () => {
    const prev = makeServer({ altHost: "2001:db8::1", name: "Old" });
    const next = makeServer({ altHost: "2001:db8::1", name: "Renamed", group: "Folder" });
    expect(pooledConnectionParamsChanged(prev, next)).toBe(false);
  });
});

describe("serversRidingChangedJumps", () => {
  const srv = (id: string, jump?: string) =>
    ({ id, name: id, host: id, port: 22, username: "u", authType: "password", isHidden: false,
       ...(jump ? { proxy: { type: "ssh" as const, jumpHostId: jump } } : {}) }) as import("../../src/models/config").ServerConfig;

  it("finds direct and transitive dependents of a changed jump, excluding the changed ones", () => {
    const servers = [srv("j"), srv("mid", "j"), srv("far", "mid"), srv("other")];
    expect([...serversRidingChangedJumps(servers, new Set(["j"]))].sort()).toEqual(["far", "mid"]);
  });

  it("terminates on a cycle", () => {
    const servers = [srv("a", "b"), srv("b", "a"), srv("t", "a")];
    expect([...serversRidingChangedJumps(servers, new Set(["a"]))].sort()).toEqual(["b", "t"]);
  });

  it("finds nothing when no server rides the changed one", () => {
    expect(serversRidingChangedJumps([srv("x"), srv("y")], new Set(["x"])).size).toBe(0);
  });
});

describe("pooled connection params agree with the start-descriptor classification", () => {
  const base = makeServer();

  it("a jump host switched from SSH to Telnet counts as a pooled change", () => {
    expect(pooledConnectionParamsChanged(base, { ...base, protocol: "telnet" })).toBe(true);
    // Absent and explicit ssh are the same protocol.
    expect(pooledConnectionParamsChanged(base, { ...base, protocol: "ssh" })).toBe(false);
  });

  it("every ServerConfig key is classified pooled or not, and the classification is exhaustive", () => {
    expect(Object.keys(POOLED_CONNECTION_FIELDS).sort()).toEqual(Object.keys(SERVER_FIELDS).sort());
  });

  it.each(Object.entries(SERVER_FIELDS).filter(([key]) => key !== "id"))("%s: pooled iff the connect descriptor reads it", (key, { use, alt }) => {
    // keyPath only enters the descriptor for a key login; the pool counts it always (documented).
    const start: ServerConfig = key === "keyPath" ? { ...base, authType: "key" } : base;
    const changed = { ...start, [key]: alt } as ServerConfig;
    const descriptorChanged = connectDescriptor(changed, { multiplexingDefault: true }) !== connectDescriptor(start, { multiplexingDefault: true });
    const pooled = pooledConnectionParamsChanged(start, changed);
    expect(POOLED_CONNECTION_FIELDS[key as keyof ServerConfig]).toBe(use !== "ignored");
    expect(pooled).toBe(descriptorChanged);
    expect(pooled).toBe(use !== "ignored");
  });

  it("documented difference: keyPath on a password server invalidates the pool though the descriptor ignores it", () => {
    expect(pooledConnectionParamsChanged(base, { ...base, keyPath: "/k" })).toBe(true);
    expect(connectDescriptor({ ...base, keyPath: "/k" }, {})).toBe(connectDescriptor(base, {}));
  });
});
