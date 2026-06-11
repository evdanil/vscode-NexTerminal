import { beforeEach, describe, expect, it } from "vitest";
import {
  clearWriteRegistry,
  consumeNexusConfigWrite,
  recordNexusConfigWrite,
  MAX_PENDING_WRITES_PER_KEY,
  WRITE_REGISTRY_TTL_MS,
} from "../../src/services/terminal/settingsWriteRegistry";

const KEY = "nexus.terminal.passthroughKeys";

describe("settingsWriteRegistry", () => {
  beforeEach(() => clearWriteRegistry());

  it("matches a recorded value and consumes it", () => {
    recordNexusConfigWrite(KEY, ["a"], 0);
    expect(consumeNexusConfigWrite(KEY, ["a"], 10)).toBe(true);
    expect(consumeNexusConfigWrite(KEY, ["a"], 20)).toBe(false); // consumed
  });

  it("does not match a different value or a different key", () => {
    recordNexusConfigWrite(KEY, ["a"], 0);
    expect(consumeNexusConfigWrite(KEY, ["b"], 10)).toBe(false);
    expect(consumeNexusConfigWrite("other.key", ["a"], 10)).toBe(false);
    expect(consumeNexusConfigWrite(KEY, ["a"], 20)).toBe(true); // still pending
  });

  it("treats a recorded undefined (key removal) as wildcard within TTL", () => {
    recordNexusConfigWrite(KEY, undefined, 0);
    expect(consumeNexusConfigWrite(KEY, ["whatever", "default"], 10)).toBe(true);
    expect(consumeNexusConfigWrite(KEY, ["x"], 20)).toBe(false);
  });

  it("expires entries after the TTL", () => {
    recordNexusConfigWrite(KEY, ["a"], 0);
    expect(consumeNexusConfigWrite(KEY, ["a"], WRITE_REGISTRY_TTL_MS + 1)).toBe(false);
  });

  it("consumes the match and all older entries, keeps newer ones", () => {
    recordNexusConfigWrite(KEY, ["a"], 0);
    recordNexusConfigWrite(KEY, ["a", "b"], 1);
    recordNexusConfigWrite(KEY, ["a", "b", "c"], 2);
    // Event for the middle write arrives: older ["a"] dropped with it.
    expect(consumeNexusConfigWrite(KEY, ["a", "b"], 10)).toBe(true);
    expect(consumeNexusConfigWrite(KEY, ["a"], 11)).toBe(false);
    expect(consumeNexusConfigWrite(KEY, ["a", "b", "c"], 12)).toBe(true);
  });

  it("caps pending entries per key", () => {
    for (let i = 0; i <= MAX_PENDING_WRITES_PER_KEY + 5; i++) {
      recordNexusConfigWrite(KEY, [`v${i}`], i);
    }
    // Oldest entries were evicted.
    expect(consumeNexusConfigWrite(KEY, ["v0"], 50)).toBe(false);
    expect(consumeNexusConfigWrite(KEY, [`v${MAX_PENDING_WRITES_PER_KEY + 5}`], 50)).toBe(true);
  });
});
