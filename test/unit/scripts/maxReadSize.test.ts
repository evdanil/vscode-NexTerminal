/*
 * Unit tests for the `nexus.scripts.maxReadSizeMb` resolver.
 *
 * House rule (CLAUDE.md): every test must fail against the specific wrong
 * implementation it prevents. Each block below names its target-wrong-impl (⊘).
 */
import { describe, expect, it } from "vitest";
import {
  SCRIPT_FS_DEFAULT_MAX_BYTES,
  SCRIPT_FS_MAX_BYTES_CEILING,
  SCRIPT_FS_MAX_BYTES_FLOOR,
  resolveScriptMaxReadBytes
} from "../../../src/services/scripts/maxReadSize";
import type { ScriptRuntimeConfigLike } from "../../../src/services/scripts/configHelpers";

const MiB = 1024 * 1024;

/**
 * A `WorkspaceConfiguration`-alike over a plain record. `key in values` (not
 * `?? fallback`) so an explicitly-configured `null`/`NaN` reaches the resolver
 * instead of being quietly replaced by the fallback here in the fixture — the
 * fail-safe branches under test are the resolver's job, not the fixture's.
 */
function config(values: Record<string, unknown>): ScriptRuntimeConfigLike {
  return {
    get: <T>(key: string, fallback?: T): T | undefined => (key in values ? (values[key] as T) : fallback),
    inspect: (key: string) => (key in values ? { globalValue: values[key] } : undefined)
  };
}

describe("resolveScriptMaxReadBytes", () => {
  it("exposes the documented default / floor / ceiling", () => {
    expect(SCRIPT_FS_DEFAULT_MAX_BYTES).toBe(4 * MiB);
    expect(SCRIPT_FS_MAX_BYTES_FLOOR).toBe(1 * MiB);
    expect(SCRIPT_FS_MAX_BYTES_CEILING).toBe(16 * MiB);
  });

  it("falls back to 4 MiB when the setting is absent", () => {
    expect(resolveScriptMaxReadBytes(config({}))).toBe(4 * MiB);
  });

  it("converts a configured MiB value to bytes", () => {
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 8 }))).toBe(8 * MiB);
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 1 }))).toBe(1 * MiB);
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 16 }))).toBe(16 * MiB);
  });

  it("allows fractional MiB inside the range, floored to whole bytes", () => {
    // ⊘ rounding to whole MiB (would give 2 or 3 MiB), or leaving a fractional
    // byte count that a Buffer.allocUnsafe would then reject/round on its own.
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 2.5 }))).toBe(2_621_440);
    expect(Number.isInteger(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 1.5 })))).toBe(true);
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 1.0000001 }))).toBe(Math.floor(1.0000001 * MiB));
  });

  it("clamps a below-floor value up to 1 MiB", () => {
    // ⊘ a resolver that returns the raw value unclamped — 0.5 MiB is below the
    // floor and would make ordinary reads fail for no configurable reason.
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 0.5 }))).toBe(1 * MiB);
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 0.001 }))).toBe(1 * MiB);
  });

  it("clamps an above-ceiling value down to 16 MiB", () => {
    // ⊘ a resolver that returns the raw value unclamped: 1024 MiB would hand
    // the read pools a 1 GiB per-read budget (12 × that host-side worst case),
    // far past the worker's own 192 MiB old-generation limit.
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 1024 }))).toBe(16 * MiB);
    expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: 17 }))).toBe(16 * MiB);
  });

  it("falls back to the DEFAULT (never 0, never unbounded) for every invalid shape", () => {
    // ⊘ a resolver that falls back to 0 / undefined / NaN on invalid input: a
    // 0 cap makes EVERY read throw FileTooLarge, and NaN makes every `>`
    // comparison false — i.e. unbounded. Asserting "not the raw value" alone
    // would pass against both, so the DEFAULT itself is pinned here.
    for (const bad of [NaN, "4", null, undefined, -1, -0.5, 0, Infinity, -Infinity, {}, [], true]) {
      expect(resolveScriptMaxReadBytes(config({ maxReadSizeMb: bad }))).toBe(SCRIPT_FS_DEFAULT_MAX_BYTES);
    }
  });

  it("never throws, even when the configuration object itself misbehaves", () => {
    const hostile: ScriptRuntimeConfigLike = {
      get: () => {
        throw new Error("config exploded");
      }
    };
    expect(resolveScriptMaxReadBytes(hostile)).toBe(SCRIPT_FS_DEFAULT_MAX_BYTES);
  });
});
