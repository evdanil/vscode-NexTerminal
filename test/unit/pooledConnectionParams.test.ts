import { describe, expect, it } from "vitest";
import { pooledConnectionParamsChanged } from "../../src/services/ssh/pooledConnectionParams";
import type { ServerConfig } from "../../src/models/config";

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
