import { describe, expect, it } from "vitest";
import { MAX_SCRIPT_RUNTIME_MS, MAX_SCRIPT_RUNTIME_SECONDS, resolveScriptMaxRuntimeMs } from "../../../src/services/scripts/maxRuntime";

function config(
  values: Record<string, number | undefined>,
  inspected: Record<string, Record<string, number | undefined> | undefined> = {}
) {
  return {
    get: (key: string, fallback?: number) => values[key] ?? fallback,
    inspect: (key: string) => inspected[key] ?? (values[key] === undefined ? undefined : { globalValue: values[key] })
  };
}

describe("resolveScriptMaxRuntimeMs", () => {
  it("uses explicit seconds and allows zero to disable the cap", () => {
    expect(resolveScriptMaxRuntimeMs(config({ maxRuntimeSeconds: 0 }))).toBe(0);
    expect(resolveScriptMaxRuntimeMs(config({ maxRuntimeSeconds: 12 }))).toBe(12_000);
  });

  it("honors legacy milliseconds when seconds was not explicitly configured", () => {
    expect(resolveScriptMaxRuntimeMs(config({ maxRuntimeMs: 2500 }))).toBe(2500);
  });

  it("falls back to the seconds default when neither setting is explicit", () => {
    expect(resolveScriptMaxRuntimeMs(config({}))).toBe(1_800_000);
  });

  it("uses the effective configured seconds value when any seconds scope is explicit", () => {
    expect(resolveScriptMaxRuntimeMs(config(
      { maxRuntimeSeconds: 10 },
      { maxRuntimeSeconds: { globalValue: 5, workspaceValue: 10 } }
    ))).toBe(10_000);
  });

  it("clamps runtime caps to the largest safe setTimeout delay", () => {
    expect(resolveScriptMaxRuntimeMs(config({ maxRuntimeSeconds: MAX_SCRIPT_RUNTIME_SECONDS + 100 }))).toBe(MAX_SCRIPT_RUNTIME_MS);
    expect(resolveScriptMaxRuntimeMs(config({ maxRuntimeMs: MAX_SCRIPT_RUNTIME_MS + 100 }))).toBe(MAX_SCRIPT_RUNTIME_MS);
  });
});
