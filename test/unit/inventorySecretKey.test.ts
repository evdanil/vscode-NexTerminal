import { describe, expect, it } from "vitest";
import { inventorySecretKey } from "../../src/models/inventory";

describe("inventorySecretKey", () => {
  it("is stable for the same (sourceId, fieldId) pair", () => {
    const a = inventorySecretKey("source-1", "apiToken");
    const b = inventorySecretKey("source-1", "apiToken");
    expect(a).toBe(b);
  });

  it("matches pinned literals for fixed inputs (kills a delimiter-scheme 'simplification')", () => {
    // Any change to the delimiter/length-prefix scheme silently re-keys every
    // previously-stored credential in SecretStorage — these literals are the
    // tripwire for that.
    expect(inventorySecretKey("source-1", "apiToken")).toBe("inventory-source-8:source-1:apiToken");
    expect(inventorySecretKey("src-1", "apiToken")).toBe("inventory-source-5:src-1:apiToken");
  });

  it("the sourceId length prefix disambiguates split points, so two different (sourceId, fieldId) splits of the same joined string don't collide", () => {
    // A bare `${sourceId}-${fieldId}` concatenation would hash/join
    // "a-b" + "c" and "a" + "b-c" to the identical string "a-b-c" — one
    // source's save/edit/remove could clobber another's credential. The
    // length prefix breaks the tie.
    const a = inventorySecretKey("a-b", "c");
    const b = inventorySecretKey("a", "b-c");
    expect(a).not.toBe(b);
    expect(a).toBe("inventory-source-3:a-b:c");
    expect(b).toBe("inventory-source-1:a:b-c");
  });

  it("differs when only fieldId changes for the same sourceId", () => {
    const a = inventorySecretKey("source-1", "apiToken");
    const b = inventorySecretKey("source-1", "apiSecret");
    expect(a).not.toBe(b);
  });

  it("differs when only sourceId changes for the same fieldId", () => {
    const a = inventorySecretKey("source-1", "apiToken");
    const b = inventorySecretKey("source-2", "apiToken");
    expect(a).not.toBe(b);
  });
});
