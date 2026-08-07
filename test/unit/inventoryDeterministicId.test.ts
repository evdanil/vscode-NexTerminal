import { describe, expect, it } from "vitest";
import { deterministicServerId, INVENTORY_ID_NAMESPACE } from "../../src/services/inventory/deterministicId";

const UUID_V8_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deterministicServerId", () => {
  it("is a fixed, non-empty namespace", () => {
    expect(INVENTORY_ID_NAMESPACE).toBe("5f6b0f89-6d3e-4f8e-9c1a-2b7d9e4a1c33");
  });

  it("is stable for the same (sourceId, externalId) pair", () => {
    const a = deterministicServerId("source-1", "device:1");
    const b = deterministicServerId("source-1", "device:1");
    expect(a).toBe(b);
  });

  it("matches a pinned literal for a fixed input (kills a randomUUID/algorithm-swap 'simplification')", () => {
    // Any change to the namespace, the name-composition scheme (F21), or the
    // hash algorithm silently re-mints every previously-synced server's id
    // on the next sync — this literal is the tripwire for that.
    expect(deterministicServerId("source-1", "device:1")).toBe("f97e80eb-e1b0-8063-8433-8c138322b978");
    expect(deterministicServerId("source-1", "device:2")).toBe("2e88fa43-6cf8-8e0a-8d2e-16d7be9d31ed");
    expect(deterministicServerId("source-2", "device:1")).toBe("4855d788-ac6c-8397-8dfd-4730ca165485");
  });

  it("differs when only externalId changes (kills hashing only sourceId)", () => {
    const a = deterministicServerId("source-1", "device:1");
    const b = deterministicServerId("source-1", "device:2");
    expect(a).not.toBe(b);
  });

  it("differs when only sourceId changes for the same externalId (kills hashing only externalId)", () => {
    const a = deterministicServerId("source-1", "device:1");
    const b = deterministicServerId("source-2", "device:1");
    expect(a).not.toBe(b);
  });

  it("always produces an RFC 9562 UUIDv8-shaped string (kills missing version/variant bits)", () => {
    expect(deterministicServerId("source-1", "device:1")).toMatch(UUID_V8_RE);
    expect(deterministicServerId("a-very-different-source-id", "another/external:id")).toMatch(UUID_V8_RE);
  });

  it("(F21) the sourceId length prefix disambiguates split points, so two different splits of the same joined string don't collide", () => {
    // "a:b" + "c" and "a" + "b:c" would hash to the same name under a bare
    // `${sourceId}:${externalId}` scheme; the length prefix breaks the tie.
    const a = deterministicServerId("a:b", "c");
    const b = deterministicServerId("a", "b:c");
    expect(a).not.toBe(b);
  });
});
