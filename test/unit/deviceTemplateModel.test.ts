import { describe, expect, it } from "vitest";
import {
  cloneServerConfig,
  mergeServerConfigFields,
  serverConfigsEqual,
  serverOriginStampsEqual,
  templatedStampsEqual
} from "../../src/models/config";
import type { ServerConfig, ServerOrigin, SshJumpProxy } from "../../src/models/config";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1) — the §1.3 bookkeeping for
 * `ServerOrigin.templated`: the stamp comparator, the deep clone, and the
 * rollback merge. Every fixture is built so the correct and the WRONG
 * implementation produce visibly different results.
 */

function origin(overrides: Partial<ServerOrigin> = {}): ServerOrigin {
  return { sourceId: "source-1", externalId: "device:1", syncedAt: 1000, ...overrides };
}

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "core-sw",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

describe("templatedStampsEqual — §1.3", () => {
  it("Fixture 1: two origins differing ONLY in templated.proxy (both present) are unequal (kills a comparator never taught the member)", () => {
    // Both sides carry a `templated` record — the vacuous-fixture trap is one
    // side simply LACKING the record, which any half-right check would catch.
    const a = origin({ templated: { proxy: { type: "socks5", host: "10.9.9.1", port: 1080 } } });
    const b = origin({ templated: { proxy: { type: "socks5", host: "10.9.9.2", port: 1080 } } });
    expect(serverOriginStampsEqual(a, b)).toBe(false);
    expect(serverConfigsEqual(server({ origin: a }), server({ origin: b }))).toBe(false);
    // Sanity: identical templated compares equal.
    expect(serverOriginStampsEqual(a, origin({ templated: { proxy: { type: "socks5", host: "10.9.9.1", port: 1080 } } }))).toBe(true);
  });

  it("Fixture 3b (presence): a boolean stamp of `false` is PRESENT, not absent (kills a truthiness presence check)", () => {
    // false vs absent must read as a DIFFERENCE; false vs false as equal.
    expect(templatedStampsEqual({ multiplexing: false }, undefined)).toBe(false);
    expect(templatedStampsEqual({ multiplexing: false }, {})).toBe(false);
    expect(templatedStampsEqual({ multiplexing: false }, { multiplexing: false })).toBe(true);
    expect(templatedStampsEqual({ multiplexing: false }, { multiplexing: true })).toBe(false);
    // Absent vs present-empty are the same "no stamp" information.
    expect(templatedStampsEqual(undefined, {})).toBe(true);
  });
});

describe("cloneServerConfig — §1.3 deep copy", () => {
  it("Fixture 2: deep-copies the nested templated.proxy so mutating the clone leaves the source untouched (kills the one-level spread)", () => {
    const proxy: SshJumpProxy = { type: "ssh", jumpHostId: "bastion-1" };
    const src = server({ origin: origin({ templated: { proxy } }) });
    const clone = cloneServerConfig(src);
    // Mutate the CLONE's nested proxy inside the nested templated record.
    (clone.origin!.templated!.proxy as SshJumpProxy).jumpHostId = "hijacked";
    expect((src.origin!.templated!.proxy as SshJumpProxy).jumpHostId).toBe("bastion-1");
    // And the clone genuinely changed (guards against the clone being a no-op).
    expect((clone.origin!.templated!.proxy as SshJumpProxy).jumpHostId).toBe("hijacked");
  });
});

describe("mergeServerConfigFields — §1.3 rollback merge", () => {
  it("Fixture 3: a concurrent templated CLEAR (current differs from batchSnapshot only in templated) is KEPT, not reverted to prior's stamp (kills a merge that ignores the member)", () => {
    // prior + batchSnapshot both carry the stamp; `current` had it cleared by a
    // concurrent change while the batch's persist was in flight. The two origins
    // differ ONLY in `templated` (same syncedAt), so a comparator that ignores
    // the member calls them equal, leaves merged.origin === prior's, and
    // silently resurrects the cleared stamp.
    const prior = server({ origin: origin({ syncedAt: 2000, templated: { multiplexing: true } }) });
    const batchSnapshot = server({ origin: origin({ syncedAt: 2000, templated: { multiplexing: true } }) });
    const current = server({ origin: origin({ syncedAt: 2000, templated: undefined }) });
    const merged = mergeServerConfigFields(prior, batchSnapshot, current);
    // The concurrent clear must survive.
    expect(merged.origin?.templated?.multiplexing).toBeUndefined();
  });
});
