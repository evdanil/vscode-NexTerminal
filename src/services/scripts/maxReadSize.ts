import type { ScriptRuntimeConfigLike } from "./configHelpers";

export type { ScriptRuntimeConfigLike } from "./configHelpers";

/** `nexus.scripts.maxReadSizeMb`'s default — the historical fixed cap. */
export const SCRIPT_FS_DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Smallest configurable cap. Below this, ordinary config/inventory files stop being readable. */
export const SCRIPT_FS_MAX_BYTES_FLOOR = 1 * 1024 * 1024; // 1 MiB
/**
 * Largest configurable cap, and the number every documented memory bound must
 * be quoted against.
 *
 * WHY 16 MiB AND NOT MORE: the `nexus.fs` read pools bound host-side transient
 * read buffers at `SCRIPT_FS_MAX_CONCURRENT_READS + SCRIPT_FS_MAX_ORPHANED_READS`
 * (4 concurrent + 8 orphaned = 12) buffers of up to one cap each in steady
 * state — 12 × cap, which at this ceiling is 192 MiB, deliberately equal to
 * the script worker's own `maxOldGenerationSizeMb: 192`
 * (`scriptRuntimeManager.ts`): the host is not asked to risk more transient
 * memory for a script's reads than the script's own isolate is allowed to hold
 * in total. Two honest caveats on that anchor (it is an anchor, not a
 * guarantee): a read whose stat hint under-reported holds ~2× its cap
 * transiently while it grows once (see `boundedReadFile`), so the true peak
 * can briefly exceed 12 × cap; and every delivered read additionally lands in
 * the worker as a UTF-16 string (~2× its byte size), inside — and counted
 * against — the worker's own 192 MiB heap.
 *
 * WHY THE BOUND IS QUOTED AGAINST THE RANGE MAXIMUM RATHER THAN THE EFFECTIVE
 * CAP: both read pools are HOST-GLOBAL — one instance shared by every running
 * script (see `SCRIPT_FS_MAX_CONCURRENT_READS`'s doc comment) — while the cap
 * is snapshotted PER RUN. Concurrent runs can therefore hold buffers sized by
 * several different snapshots at once, and a setting change makes the next run
 * start with a larger one while older runs are still in flight. The only bound
 * that holds across every such mix is `12 × SCRIPT_FS_MAX_BYTES_CEILING`; the
 * "48 MiB at the default 4 MiB cap" figure is the typical case, never the
 * guarantee.
 */
export const SCRIPT_FS_MAX_BYTES_CEILING = 16 * 1024 * 1024; // 16 MiB

/**
 * The effective `nexus.fs` read cap in BYTES for a run about to start, from
 * `nexus.scripts.maxReadSizeMb` (a value in MiB).
 *
 * Pure and total — it never throws and never returns 0, NaN, or Infinity, for
 * the same reason `defaultTimeout.ts`/`maxRuntime.ts` are written this way:
 * the result is compared against real file sizes on every read, where a 0 cap
 * would make every read throw `FileTooLarge` and a NaN cap would make every
 * `>` comparison false — i.e. silently unbounded, which is the one outcome the
 * cap exists to prevent. Anything that is not a finite positive number
 * (missing, NaN, ±Infinity, negative, zero, a string, an object) therefore
 * falls back to `SCRIPT_FS_DEFAULT_MAX_BYTES`, and anything finite and
 * positive is clamped into `[floor, ceiling]` — fractional MiB values are
 * allowed inside the range and floored to whole bytes.
 */
export function resolveScriptMaxReadBytes(config: ScriptRuntimeConfigLike): number {
  let raw: unknown;
  try {
    raw = config.get<number>("maxReadSizeMb", SCRIPT_FS_DEFAULT_MAX_BYTES / (1024 * 1024));
  } catch {
    return SCRIPT_FS_DEFAULT_MAX_BYTES;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return SCRIPT_FS_DEFAULT_MAX_BYTES;
  }
  const bytes = Math.floor(raw * 1024 * 1024);
  return Math.min(Math.max(bytes, SCRIPT_FS_MAX_BYTES_FLOOR), SCRIPT_FS_MAX_BYTES_CEILING);
}
