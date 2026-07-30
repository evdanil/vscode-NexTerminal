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
   * Invariant: every returned/persisted macro has a unique, non-empty, STRING `id` — a non-string
   * value (e.g. an object surviving a corrupt JSON import) and an empty string are both treated as
   * missing, and a later duplicate is reassigned a fresh id. MacroAutoTrigger's `macroStateKey()`
   * depends on this to keep per-macro state (pause/resume, interval ownership, cooldown) from
   * colliding across distinct macros. See `isValidMacroId()` / `assignUniqueMacroIds()` below, the
   * single implementation both `VscodeMacroStore.save()` and `InMemoryMacroStore.save()` use to
   * enforce it.
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
