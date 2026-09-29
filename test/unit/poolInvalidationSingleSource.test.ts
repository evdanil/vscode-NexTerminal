import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("pool invalidation has a single source", () => {
  const extension = readFileSync(join(__dirname, "../../src/extension.ts"), "utf8");

  it("extension.ts does not invalidate the pool on the change event (a second bump would discard a reconnect's handshake)", () => {
    expect(extension).not.toContain("pool.invalidate(");
    expect(extension).not.toContain("watchSshPoolServerRemovals");
    expect(extension).toContain("watchPoolInvalidationOnConfigMutation(core, pool)");
  });
});
