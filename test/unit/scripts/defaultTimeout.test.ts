import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRIPT_WAIT_TIMEOUT_MS,
  MAX_SCRIPT_WAIT_TIMEOUT_MS,
  resolveScriptDefaultTimeoutMs,
  type ScriptRuntimeConfigLike
} from "../../../src/services/scripts/defaultTimeout";

function config(values: Record<string, unknown>, inspectValues: Record<string, unknown> = values): ScriptRuntimeConfigLike {
  return {
    get: <T>(key: string, fallback?: T) => (key in values ? values[key] as T : fallback),
    inspect: (key: string) => key in inspectValues ? { globalValue: inspectValues[key] } : undefined
  };
}

describe("resolveScriptDefaultTimeoutMs", () => {
  it("uses seconds-facing default wait timeout when configured", () => {
    expect(resolveScriptDefaultTimeoutMs(config({ defaultTimeoutSeconds: 45 }))).toBe(45_000);
  });

  it("falls back to legacy millisecond timeout when seconds setting is absent", () => {
    expect(resolveScriptDefaultTimeoutMs(config({ defaultTimeout: 12_500 }))).toBe(12_500);
  });

  it("uses the package default seconds setting when neither key is user-configured", () => {
    expect(resolveScriptDefaultTimeoutMs(config({ defaultTimeoutSeconds: 30 }, {}))).toBe(DEFAULT_SCRIPT_WAIT_TIMEOUT_MS);
  });

  it("rejects sub-second seconds values and clamps oversized values to the safe timer maximum", () => {
    expect(resolveScriptDefaultTimeoutMs(config({ defaultTimeoutSeconds: 0 }))).toBe(DEFAULT_SCRIPT_WAIT_TIMEOUT_MS);
    expect(resolveScriptDefaultTimeoutMs(config({ defaultTimeoutSeconds: 3_000_000 }))).toBe(MAX_SCRIPT_WAIT_TIMEOUT_MS);
  });
});
