import { randomUUID } from "node:crypto";
import type { TerminalMacro } from "../models/terminalMacro";

export interface MacroStoreChangeListener {
  (): void;
}

export interface MacroStore {
  /** One-time async initialization: loads persisted macros and (for Vscode impl) performs legacy migration. */
  initialize(): Promise<void>;
  /** Synchronous read of the resolved in-memory list. Secret text is included. */
  getAll(): TerminalMacro[];
  /**
   * Persists the given list. Splits secret text into the vault; writes non-secret fields to state.
   *
   * Invariant, enforced at WRITE TIME ONLY: every macro this call persists has a unique,
   * non-empty, STRING `id` — a non-string value (e.g. an object surviving a corrupt JSON
   * import) and an empty string are both treated as missing, and a later duplicate is
   * reassigned a fresh id. See `isValidMacroId()` / `assignUniqueMacroIds()` below, the single
   * implementation both `VscodeMacroStore.save()` and `InMemoryMacroStore.save()` use.
   *
   * "Write time only" is deliberate and load-bearing. `save()` is reached exclusively from
   * user-initiated command paths (macro add/edit/remove/reorder, the macro editor panel,
   * config import) — never from activation — so re-keying here is a repair the user asked
   * for, applied to values already resolved in memory, and it is loss-free: a duplicated
   * secret's vault value was read into `text` at load, so writing it back under a fresh key
   * preserves it. The READ path deliberately does NOT do this. `reloadFromState()` never
   * rewrites a stored id and never touches the vault, because deciding which of two macros
   * sharing an id owns the single vault entry behind it is unanswerable, and every heuristic
   * attempted (award to the first entry, award to the secret one, award to nobody) either
   * leaks one macro's password to another, destroys the only copy of a legitimate secret, or
   * re-derives identity from array position. Duplicates that already exist on disk are left
   * alone and handled fail-safe at the use site by `findAmbiguousMacroStateKeys()`
   * (services/macroAutoTrigger.ts): an ambiguous macro compiles no auto-trigger rule and
   * carries no pause state, so it cannot fire at all. Saving either colliding macro is what
   * clears the conflict.
   */
  save(macros: TerminalMacro[]): Promise<void>;
  /** Subscribe to changes. Returns a disposer. */
  onDidChange(listener: MacroStoreChangeListener): () => void;
  /** Clear all state (macros + vault entries). Used by completeReset. */
  clearAll(): Promise<void>;
}

/**
 * A macro id is only ever trustworthy when it is a non-empty string. JSON import
 * (backup restore, legacy settings absorption, a hand-edited settings.json) validates
 * array SHAPE only — nothing stops a runtime `id` from being `{"length": 1}` or any
 * other non-string value. A bare `m.id && m.id.length > 0` check is fooled by that:
 * the object is truthy and its `.length` is positive, so it passes as "valid" while
 * still being a completely different id from every other such object (two distinct
 * objects are never `===`, so a `Set` never dedupes them, yet both coerce to the same
 * string — e.g. `"[object Object]"` — everywhere an id is used as a map/vault key).
 * Every place that decides whether an id may be trusted MUST use this guard, not a
 * bare `.length` shortcut.
 */
export function isValidMacroId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0;
}

/**
 * Assigns a unique, valid id to every macro, in array order: an id is kept only when
 * `isValidMacroId` accepts it AND no earlier entry in this same call already claimed
 * it; anything else (missing, non-string, empty, or a repeat) gets a fresh UUID.
 *
 * The single implementation shared by `VscodeMacroStore.save()` and
 * `InMemoryMacroStore.save()` — see `MacroStore.save()`'s doc comment above for why
 * uniqueness matters: `macroStateKey()` (services/macroAutoTrigger.ts) keys every
 * per-macro state map (pause/resume, interval ownership, cooldown) by `id`, so two
 * macros sharing one are indistinguishable to it.
 *
 * WRITE PATHS ONLY. Nothing on a load path may call this — see `MacroStore.save()`.
 */
export function assignUniqueMacroIds<T extends { id?: string }>(macros: readonly T[]): T[] {
  const seenIds = new Set<string>();
  return macros.map((m) => {
    let id = isValidMacroId(m.id) ? m.id : randomUUID();
    while (seenIds.has(id)) id = randomUUID();
    seenIds.add(id);
    return { ...m, id };
  });
}

/**
 * Id assignment for legacy-settings absorption, split by PROVENANCE.
 *
 * `VscodeMacroStore.absorbLegacySettingsIfPresent()` runs on EVERY activation and
 * rewrites all of `nexus.macros`, so it is a load path as much as a write path and the
 * two halves of its input must be treated differently.
 *
 * `existing` — already persisted in this store. Its ids are IMMUTABLE; only a value
 * `isValidMacroId()` rejects is filled in. Re-keying an already-persisted record here
 * strands its secret: an on-disk secret macro carries `text: ""` (the real value lives
 * in the vault under its CURRENT id), so the caller's `secrets.store(...)` branch is
 * skipped for it and a new id neither moves nor rewrites that vault entry — the value
 * is simply orphaned, permanently, by a routine that runs at startup. Duplicates among
 * `existing` are therefore preserved exactly as found and dealt with fail-safe at the
 * use site (`findAmbiguousMacroStateKeys()`, services/macroAutoTrigger.ts).
 *
 * `absorbed` — arriving from `nexus.terminal.macros` in settings.json. These records
 * have never had a vault entry: their secret text is the cleartext sitting in
 * settings.json, which the caller is about to write to `macroSecretKey(id)`. So an
 * absorbed id colliding with an already-claimed one is PROVABLY not the owner of the
 * vault entry behind it — provenance, not a heuristic — and must be re-keyed, or that
 * write would overwrite an existing macro's secret with the absorbed macro's.
 *
 * Non-object entries pass through untouched rather than being spread into a phantom
 * `{ id }` record that would then surface as a nameless macro.
 */
export function assignIdsForAbsorbedMacros<T extends { id?: string }>(
  existing: readonly T[],
  absorbed: readonly T[]
): { existing: T[]; absorbed: T[] } {
  const claimed = new Set<string>();
  for (const m of existing) {
    if (m && typeof m === "object" && isValidMacroId(m.id)) claimed.add(m.id);
  }
  const freshId = (): string => {
    let id = randomUUID();
    while (claimed.has(id)) id = randomUUID();
    claimed.add(id);
    return id;
  };

  const keptExisting = existing.map((m) => {
    if (!m || typeof m !== "object") return m;
    return isValidMacroId(m.id) ? m : { ...m, id: freshId() };
  });
  const rekeyedAbsorbed = absorbed.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (isValidMacroId(m.id) && !claimed.has(m.id)) {
      claimed.add(m.id);
      return m;
    }
    return { ...m, id: freshId() };
  });
  return { existing: keptExisting, absorbed: rekeyedAbsorbed };
}
