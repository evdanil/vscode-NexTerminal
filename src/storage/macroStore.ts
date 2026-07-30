import { randomUUID } from "node:crypto";
import { slotToBinding } from "../macroBindings";
import { getAssignedBinding } from "../macroBindingHelpers";
import { clamp } from "../utils/helpers";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";

export interface MacroStoreChangeListener {
  (): void;
}

export interface MacroStore {
  /** One-time async initialization: loads persisted macros and (for Vscode impl) performs legacy migration. */
  initialize(): Promise<void>;
  /** Synchronous read of the resolved in-memory list. Secret text is included. */
  getAll(): TerminalMacro[];
  /**
   * Persists a list DERIVED FROM THIS STORE'S OWN CURRENT CONTENTS — the result of adding to,
   * editing, removing from, or reordering `getAll()`. Splits secret text into the vault;
   * writes non-secret fields to state.
   *
   * PRECONDITION, and it is load-bearing rather than descriptive: for every record in
   * `macros` that carries an id this store currently holds, that record IS the store's record
   * — the same macro, carried forward by the caller. `VscodeMacroStore.save()` keys side
   * storage (the secret vault) by macro id and decides, per record, whether a colliding id may
   * be kept or must be re-keyed; both questions are answerable only under that precondition.
   * Records that arrive from OUTSIDE the store — a backup file, a share file, a hand-edited
   * JSON payload — carry ids that are just strings which happen to collide, and MUST NOT be
   * handed to this method. See `replaceAll()`.
   *
   * TypeScript cannot express that precondition (a `TerminalMacro` from a file and one from
   * `getAll()` have the same type), so it is not claimed to be type-enforced. It is enforced by
   * construction at the entry points instead, and the enumeration is short enough to check:
   *
   *   - `commands/macroCommands.ts`, `ui/macroEditorPanel.ts` — mutate `getMacros()`.
   *   - `commands/configCommands.ts` share import — `[...getMacros(), ...incoming]` where every
   *     incoming record was given `id: randomUUID()` one line earlier, so no incoming id can
   *     name anything this store knows.
   *   - `commands/configCommands.ts` merge import — `[...getMacros(), ...incoming]` where every
   *     incoming record whose id is already present was skipped, so again no incoming id can
   *     name anything this store knows. (It ALSO skips by content key, which is what makes a
   *     merge of a file that was previously restored in replace mode idempotent — replace
   *     freshens every id, so the file's ids no longer name anything and the id skip alone
   *     would add a second copy of every macro in it. That is a separate concern from this
   *     precondition and is argued at the call site.)
   *   - `commands/configCommands.ts` REPLACE import — the one wholesale-external caller. It
   *     calls `replaceAll()`, not this.
   *
   * Invariant, enforced at WRITE TIME ONLY: every macro this call persists has a unique,
   * non-empty, STRING `id` — a non-string value (e.g. an object surviving a corrupt JSON
   * import) and an empty string are both treated as missing, and a later duplicate is
   * reassigned a fresh id. See `isValidMacroId()` / `assignMacroIds()` below, the single
   * implementation both `VscodeMacroStore.save()` and `InMemoryMacroStore.save()` use (the
   * latter through the `assignUniqueMacroIds()` wrapper, having no side storage to key).
   *
   * "Write time only" is deliberate and load-bearing. `save()` is reached exclusively from
   * user-initiated command paths (macro add/edit/remove/reorder, the macro editor panel,
   * config import) — never from activation — so re-keying here is a repair the user asked
   * for, applied to values already resolved in memory. The READ path deliberately does NOT
   * do this. `reloadFromState()` never rewrites a stored id and never touches the vault,
   * because deciding which of two macros sharing an id owns the single vault entry behind it
   * is unanswerable, and every heuristic attempted (award to the first entry, award to the
   * secret one, award to nobody) either leaks one macro's password to another, destroys the
   * only copy of a legitimate secret, or re-derives identity from array position. Duplicates
   * that already exist on disk are left alone and handled fail-safe at the use site by
   * `findAmbiguousMacroStateKeys()` (services/macroAutoTrigger.ts): an ambiguous macro
   * compiles no auto-trigger rule and carries no pause state, so it cannot fire at all.
   * Saving either colliding macro is what clears the conflict.
   *
   * "Never from activation" is a REQUIREMENT on callers, not an observation. An
   * activation-time `save()` re-keys duplicates before the user has seen the tree warning
   * or been asked anything, which silently converts the fail-safe (neither twin fires) into
   * the failure it exists to prevent (both twins compile, and a secret twin can auto-send
   * the other's password — `MacroStore.onDidChange` reaches `MacroAutoTrigger.reload()`
   * synchronously). One such caller existed and was removed: `migrateMacroSlots()` ran at
   * `activate()` and saved the whole list whenever ANY macro still carried a legacy `slot`
   * — reachable on the very first startup that absorbs a slot-era settings.json. It is now
   * `withMigratedSlot()` below, applied on the read path, so the shape the app sees is
   * already migrated and no write is needed. Do not reintroduce an activation-time save.
   *
   * Loss-free for every secret macro that SURVIVES the save, in both keyring states, and the
   * two states get there by opposite routes.
   *
   * When the vault read succeeded, the value is sitting in `text`, so re-keying is free: the
   * value is written under the new key before the old key is deleted, and the macro and its
   * value move together.
   *
   * When the read did NOT succeed, nothing can be moved. `SecretStorage.get()` resolves
   * `undefined` rather than rejecting when the OS keyring is unavailable, which is
   * indistinguishable at the type level from "no entry", so such a macro carries `text: ""`
   * and `VscodeMacroStore.save()` will neither overwrite its vault entry with that empty
   * string NOR re-key the macro away from it (`keepIdIfPossible`, below). Refusing the write
   * without also refusing the re-key would be the worse half of the deal: the value would
   * survive in the vault under an id no surviving macro names.
   *
   * Two costs, both deliberate. While a value is unreadable it also cannot be deliberately
   * cleared. And when TWO unreadable secrets share one stored id there is still only one
   * vault entry between them, so exactly one keeps the id and the other is re-keyed — it gets
   * no vault entry at all rather than an empty one, which is the honest description of a
   * macro whose value was never separately stored in the first place.
   *
   * NOT ATOMIC ACROSS VS CODE WINDOWS, and this is the whole of what that means. A save
   * publishes this window's ENTIRE view of the macro list: `globalState` is rewritten
   * wholesale, and every secret whose value this window holds is written back to the vault.
   * So a window holding a stale snapshot reverts another window's concurrent edits — a name,
   * a trigger, an order, AND a secret value it never saw changed. `globalState` and
   * `SecretStorage` offer no compare-and-swap and no shared lock, so the alternatives are
   * only: revert wholesale (this), publish a mixture of the two windows' views (which is how
   * a record ends up marked `secret: true` with no value behind it), or silently discard a
   * save the user just made and the UI just reported as succeeding. The first is the one
   * whose result a user can see and correct.
   *
   * Two residual races are therefore accepted and are NOT closed by this method:
   *   - another window's delete landing between this save's `secrets.store()` and its
   *     `globalState` commit still publishes a record naming an entry that is gone;
   *   - another window's `secrets.store()` landing in the same gap is overwritten.
   * Both need a genuine interleaving inside one save, not merely a stale snapshot.
   * `VscodeMacroStore` does serialize its OWN mutations (`save` / `replaceAll` / `clearAll`
   * within one window) so that neither race can be produced from a single window.
   */
  save(macros: TerminalMacro[]): Promise<void>;
  /**
   * Replaces the entire macro set with records from an EXTERNAL source — a decrypted backup
   * being restored in replace mode. The counterpart to `save()`, split from it because the two
   * have materially different contracts and only one of them can honour `save()`'s precondition.
   *
   * An id in an external file is not an identity in this store. It is a string that was an
   * identity somewhere else, and any agreement with an id here is a collision, not a match.
   * So this method assigns a FRESH id to every incoming record before anything else runs, and
   * the ordinary write path then deletes every vault entry the outgoing set owned (each such id
   * is, by construction, absent from the incoming set).
   *
   * That is what makes the unsound case unrepresentable rather than merely unreached. There is
   * no mode flag to pass wrongly: `VscodeMacroStore.save()`'s "keep this record on the id its
   * unreadable vault entry is filed under" rule is reachable only for a record that arrived
   * carrying a valid id, and after the re-key no record here has one. An imported record
   * therefore cannot inherit a local macro's stored password, whatever id the file gave it —
   * which is exactly the defect this split exists to close, and it was reachable: with the OS
   * keyring transiently unavailable, an imported record whose own secret failed to decrypt
   * (`text: ""`, `secret: true`) and whose id collided with a local secret's would take that
   * local secret's vault entry, keep its own auto-trigger, and resolve to the local password
   * once the keyring recovered.
   *
   * Freshening ids costs nothing IN THIS STORE. The vault keys are rewritten by this very
   * call, and every other in-process consumer (`macroStateKey()`, the tree, the editor) is
   * runtime-only state rebuilt from the store.
   *
   * It is NOT free outside this process, and an earlier revision of this paragraph claimed
   * otherwise ("nothing outside this store persists a macro id"). A BACKUP FILE persists
   * them, and merge-mode import used to key its "have I already got this one?" test solely on
   * them — so restoring a backup in replace mode and later merging that same file added a
   * second copy of every macro in it, each copy with a live auto-trigger, and a `Password:`
   * responder answered one prompt twice. That is fixed where it belongs, at the merge site,
   * by also skipping on the content key the share-import path already uses; the ids stay
   * fresh here, because the alternative is the credential reassignment this method exists to
   * prevent. Any future consumer that treats a macro id as durable across an export/import
   * round trip has to make the same accommodation.
   *
   * The converse is NOT true, so do not reach for this method as a general-purpose save.
   * Freshening an id is only free when the record's secret can travel to the new id, and a
   * secret whose vault value could not be READ (keyring outage) cannot — it would be re-keyed
   * with nothing behind it while the entry holding the real value is deleted along with the
   * rest of the outgoing set. For an external list that is correct and is what "replace" means:
   * those entries belong to macros the user is discarding. For a list derived from `getAll()`
   * it would be a data-loss bug. Such a list belongs in `save()`.
   */
  replaceAll(macros: TerminalMacro[]): Promise<void>;
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
 * Legacy `slot` → `keybinding` normalization, applied on the READ path (and again on the
 * write path so an old backup restored through `save()` converges too).
 *
 * This used to be `migrateMacroSlots()` in commands/macroCommands.ts, called from
 * `activate()`, which rewrote the field IN PLACE and then called `saveMacros()` whenever
 * any macro still carried a `slot`. That made `MacroStore.save()` an ACTIVATION path,
 * which is precisely what the duplicate-id fail-safe is built on it not being — see
 * `MacroStore.save()`'s doc comment. Worse, it was deterministically reachable: legacy
 * settings absorption copies slot-era records out of `nexus.terminal.macros` verbatim, so
 * the first activation that absorbed one also ran the save on that same startup.
 *
 * Doing it at read time needs no write at all. Nothing downstream can tell the difference:
 * `getAssignedBinding()` (macroBindingHelpers.ts) already derived `alt+{slot}` for a macro
 * with no `keybinding`, so every consumer — keybinding context keys, the tree label, the
 * quick pick, the editor — saw the same value before and sees the same value now. The
 * on-disk record keeps its `slot` until the next write the user actually asks for, at
 * which point `save()` persists the migrated shape.
 *
 * Byte-identical semantics to the routine it replaces, deliberately: a macro carrying BOTH
 * `slot` and an explicit `keybinding` keeps its `slot` untouched (the keybinding already
 * wins everywhere), which is what keeps the `nexus.macro.slot` back-compat command's
 * `m.slot === targetSlot` fallback meaningful for exactly that shape.
 */
export function withMigratedSlot<T extends { slot?: number; keybinding?: string }>(macro: T): T {
  if (macro.slot === undefined || macro.keybinding) return macro;
  const migrated: T = { ...macro, keybinding: slotToBinding(macro.slot) };
  delete (migrated as { slot?: number }).slot;
  return migrated;
}

/* ------------------------------------------------------------------------------------------
 * CONTENT-KEY CANONICALIZATION
 *
 * Two content keys exist in this codebase and both decide whether a macro is thrown away:
 * `keyOf()` (commands/configCommands.ts) drops an INCOMING record on import, and
 * `keyOfLegacy()` (storage/vscodeMacroStore.ts) decides whether a settings.json record is
 * absorbed AGAIN on the next activation. They answer different questions and they have
 * opposite failure directions — a key that is too coarse silently DROPS a legitimate macro,
 * one that is too fine DUPLICATES a macro — but they are subject to the same single rule,
 * which is why the terms live here rather than being written out twice:
 *
 *   TWO RECORDS THE RUNTIME CANNOT TELL APART MUST PRODUCE THE SAME TERMS,
 *   AND TWO RECORDS IT CAN MUST NOT.
 *
 * The runtime in question is `MacroAutoTrigger.reload()` (services/macroAutoTrigger.ts) plus
 * the variable-prompt path, so each collapse below cites the line it mirrors. Both directions
 * have been shipped as bugs on this branch:
 *
 *   - Under-collapsing: the macro editor persists an EXPLICIT `triggerScope: "all-terminals"`
 *     (ui/macroEditorHtml.ts's `?? "all-terminals"` default, written back by
 *     ui/macroEditorPanel.ts), while `sanitizeImportedMacro()` leaves an absent scope absent.
 *     The two are runtime-identical — `reload()`/`evaluate()` only ever test for
 *     `"active-session"` and `"profile"` — so a merge import of a backup written before the
 *     macro was last edited added a SECOND copy of it, both copies compiling a live rule.
 *     For a `Password:` responder that is the password sent twice per prompt.
 *   - Over-collapsing: keying `secret` as `m.secret === true` when every consumer in the
 *     codebase tests it for TRUTHINESS (legacy absorption persists `secret: "true"` verbatim)
 *     made a legacy secret macro and a plain macro with the same text collide, and the plain
 *     one was discarded with no report.
 *
 * The terms are deliberately NOT a hash and NOT a delimiter join: callers `JSON.stringify` the
 * assembled array, so a field containing the delimiter cannot forge another record's key.
 * ------------------------------------------------------------------------------------------ */

/**
 * `secret` as the STORE reads it. Every consumer tests truthiness — `reloadFromState()`'s
 * `if (entry.secret)`, `write()`'s `if (m.secret)`, `persistLegacyMigration()`'s `m.secret &&`,
 * `collectIncomingMacros()`'s `if (m.secret)` — so `secret: "true"` (which legacy settings
 * absorption persists verbatim) is the same macro as `secret: true` and must key as one.
 */
export function canonicalMacroSecret(macro: TerminalMacro): boolean {
  return Boolean(macro.secret);
}

/**
 * The binding the app actually applies, via the same helper every consumer uses
 * (`getAssignedBinding()`: normalized `keybinding`, else `alt+{slot}`). Keying the raw
 * `keybinding` field instead left `slot` out of the key entirely, so two slot-era records
 * differing only in `slot: 1` versus `slot: 2` — which `withMigratedSlot()` would have turned
 * into distinct `alt+1` / `alt+2` bindings — collided, and the second was dropped on import.
 * It also treats `Alt+1` and `alt+1` as the one binding they resolve to.
 *
 * NOT keyed, deliberately: a `slot` sitting alongside an explicit `keybinding`. `withMigratedSlot()`
 * leaves that shape untouched (the keybinding already wins), and the slot stays faintly reachable
 * through the `nexus.macro.slot` back-compat command's `m.slot === targetSlot` fallback — so
 * `{slot: 3, keybinding: "alt+m"}` and `{keybinding: "alt+m"}` are not quite identical at runtime,
 * and this key collides them. That is the same collision the pre-existing key had (it named
 * `keybinding` and nothing else), and closing it would COST more than it buys: the macro editor
 * deletes `slot` on every save while an older backup of the same macro keeps it, which is exactly
 * the editor-versus-file divergence that produced the duplicate-trigger double-fire this
 * canonicalization exists to stop. Between an obscure drop and a reachable double-send, the drop
 * is the one to take.
 */
export function canonicalMacroBinding(macro: TerminalMacro): string {
  return getAssignedBinding(macro) ?? "";
}

/** `reload()`'s explicit-cooldown bounds — `clampSeconds(macro.triggerCooldown, DEFAULT, 0, 300)`. */
const TRIGGER_COOLDOWN_MIN_SECONDS = 0;
const TRIGGER_COOLDOWN_MAX_SECONDS = 300;

/**
 * A cooldown as `MacroAutoTrigger.reload()` resolves it. THREE outcomes, not two:
 *
 *   - absent or `null` → `null` here. `reload()` takes the `this.defaultCooldownMs` branch,
 *     which comes from the `nexus.terminal.macros.defaultCooldown` SETTING.
 *   - a finite number → the CLAMPED value. `reload()` applies `clampSeconds(v, DEFAULT, 0, 300)`,
 *     so `300` and `301` (and `0` and `-5`) are one timing, not two. Keying the raw number let
 *     two records the clamp flattens together survive as two macros with identical live rules —
 *     for a `Password:` responder, the password sent twice per prompt.
 *   - anything else present (a quoted number from a hand-edited settings.json, `NaN`,
 *     `Infinity`, an object) → the fixed `"__DEFAULT__"`. `clampSeconds()` returns its
 *     `DEFAULT_TRIGGER_COOLDOWN` fallback for all of them, so they are one macro too.
 *
 * The third state is kept apart from the first deliberately, and it is the same argument that
 * keeps absent apart from an explicit `3`: absent follows a machine-local SETTING while a value
 * the clamp rejects pins the shipped constant, so they coincide only while that setting is left
 * alone. Collapsing them would make the key depend on a mutable setting and would DROP a macro
 * the moment the user changed it. A string can never collide with the clamped-number branch:
 * `JSON.stringify` writes `"__DEFAULT__"` and `300` differently.
 */
function canonicalMacroCooldown(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return clamp(value, TRIGGER_COOLDOWN_MIN_SECONDS, TRIGGER_COOLDOWN_MAX_SECONDS);
  }
  return "__DEFAULT__";
}

/**
 * The six auto-trigger fields, reduced to what `MacroAutoTrigger.reload()` can observe.
 *
 * WITH NO PATTERN, NOTHING ELSE MEANS ANYTHING. `reload()` starts with
 * `if (!macro.triggerPattern) continue`, so a cooldown, an interval, a scope or a start-paused
 * flag on a pattern-less macro compiles into nothing at all. The editor can persist exactly
 * that shape (its cooldown write is not gated on the pattern) while `sanitizeImportedMacro()`
 * strips the whole group, so the two shapes must collapse or the same macro imports twice.
 *
 * Per-field, when there IS a pattern:
 *   - cooldown goes through `canonicalMacroCooldown()` above: clamped exactly as `reload()`
 *     clamps it, with absent (follow the configured default) kept apart from an explicit value.
 *   - interval mirrors `typeof x === "number" && x > 0 ? x * 1000 : undefined`, so `0`, a
 *     negative, a string and absent are all "no interval". NOT clamped, because `reload()` does
 *     not clamp it either — `sanitizeImportedMacro()`'s 1..86400 window is an import-path
 *     rule, and a legacy record outside it still runs at whatever it says.
 *   - start-paused mirrors `if (macro.triggerInitiallyDisabled)` — truthy, not `=== true`.
 *   - scope: absent is `"all-terminals"`. `evaluate()` tests only for `"active-session"` and
 *     `"profile"`; everything else, absent included, falls through to "every terminal". An
 *     INVALID scope string is kept verbatim rather than folded into "no rule at all" (which is
 *     what `reload()`'s `VALID_TRIGGER_SCOPES` check makes it): keeping it can only over-name,
 *     and `sanitizeImportedMacro()` strips the whole trigger for one anyway.
 *   - profile id only when the scope is `"profile"` — `evaluate()` reads it nowhere else.
 *
 * NOT collapsed: a pattern suppressed by a non-empty `variables` array (§6.1). That suppression
 * is lifted by deleting the variables, so the pattern is real configuration the user can bring
 * back, and folding it away would drop a macro's whole trigger on the strength of a state the
 * editor refuses to create.
 */
export function canonicalMacroTriggerTerms(macro: TerminalMacro): unknown[] {
  const pattern = macro.triggerPattern ?? "";
  if (!pattern) return ["", null, null, false, "", ""];
  const scope = macro.triggerScope ?? "all-terminals";
  return [
    pattern,
    canonicalMacroCooldown(macro.triggerCooldown),
    typeof macro.triggerInterval === "number" && macro.triggerInterval > 0 ? macro.triggerInterval : null,
    Boolean(macro.triggerInitiallyDisabled),
    scope,
    scope === "profile" ? (macro.triggerProfileId ?? "") : ""
  ];
}

/**
 * Every declared variable field that changes what running the macro does: what the prompt says,
 * what it is prefilled with, whether the input is masked, whether the value is remembered. Two
 * macros differing in any of them are two macros (§10).
 *
 * `default` and `remember` are reported only for a NON-masked variable, because on a masked one
 * they do not survive: `toValidMacroVariable()` ignores them, `withRedactedVariables()` deletes
 * them at every persistence boundary, and `sanitizeImportedMacroVariables()` strips them on
 * import. That gating is inert for `keyOf()` (both sides of that comparison are already
 * redacted or sanitized) and load-bearing for `keyOfLegacy()`, which compares a settings.json
 * record against the redacted copy of itself already on disk — keying a masked variable's
 * `default` there would make the two copies never match and re-absorb the macro on every single
 * activation.
 *
 * NO DECLARATION AT ALL keys as `null`, and an EMPTY ARRAY is exactly that. An earlier revision
 * kept `[]` distinct from absent on the grounds that they persist differently
 * (`withRedactedVariables()` drops a non-array while keeping an empty one), but persistence is
 * not the rule this file states — both runtime readers see one thing: §6.1's suppression is
 * `Array.isArray && length > 0`, false for both, and `getValidMacroVariables()` returns `[]` for
 * both. Separating them duplicated a macro across its own backup: absorption persists
 * `variables: []` from settings.json verbatim, export writes it out unchanged, and
 * `sanitizeImportedMacroVariables()` then DELETES it on the way back in while leaving the trigger
 * alone (`hadDeclaration` is false for a zero-length array, so §6.2 does not strip) — so the same
 * macro came back in a shape its own key no longer recognised, and the second copy carried a
 * second live `Password:` rule. A non-array keys as `null` for the same reason it always did,
 * and the redaction boundary is symmetric for both shapes, so `keyOfLegacy()` cannot desync.
 *
 * `label` reports the STRING or `null` for anything else — absent and `""` are NOT the same
 * prompt. `promptForValues()` sets `box.prompt = variable.label ?? variable.name`, so an absent
 * label asks for "host" and an empty one asks for nothing; collapsing them dropped the second of
 * two otherwise-identical legacy records in `keyOfLegacy()`, before absorption cleared the
 * setting that held the only copy. Non-string values fold in with absent because
 * `toValidMacroVariable()` discards them, and `default` folds a non-string in with `""` for the
 * same reason (its prefill is `… ?? variable.default ?? ""`, so absent and `""` genuinely are
 * one state there). Neither shape reaches here from the editor or an import — both drop an empty
 * label — which is why legacy absorption is the only path that can see one.
 *
 * NOT collapsed, deliberately: a declared variable the macro's TEXT never references. The prompt
 * path reads nothing about it (`resolveMacroText()` scans the text for uses, finds none, and
 * sends the text as-is), so by the rule at the top of this section the two records ought to key
 * as one — and they do not. The declaration is real user data that goes live again the moment
 * the TEXT gains `$host`, with no edit to the variables array at all, so collapsing would delete
 * whichever record the user listed second on the strength of a relationship a single character
 * elsewhere restores. The exception is bounded in the only way that matters: every macro this
 * term can separate has a non-empty `variables` array, and §6.1 suppresses the auto-trigger of
 * every such macro — so an extra copy here can never be an extra live rule, which is the harm
 * the collapses above exist to prevent. An invalid variable NAME (`2bad`) is kept verbatim on
 * the same grounds.
 */
export function canonicalMacroVariableTerms(macro: TerminalMacro): unknown {
  if (!Array.isArray(macro.variables) || macro.variables.length === 0) return null;
  return macro.variables.map((v: MacroVariable | null | undefined) => {
    if (!v || typeof v !== "object") return null;
    const secret = v.secret === true;
    return [
      v.name ?? "",
      typeof v.label === "string" ? v.label : null,
      secret,
      secret ? "" : (typeof v.default === "string" ? v.default : ""),
      secret ? false : v.remember === false
    ];
  });
}

export interface MacroIdAssignment<T> {
  /** The record with its final, unique id applied. */
  macro: T;
  /**
   * The id the record ARRIVED with, when `isValidMacroId()` accepted it; `undefined`
   * otherwise. This is the id any vault entry belonging to the record is filed under, so
   * a caller that keys side storage by macro id must consult THIS, not `macro.id`, when
   * asking "what do I already know about this record?". `macro.id !== priorId` means the
   * record was re-keyed and its side storage has not moved with it.
   */
  priorId: string | undefined;
}

export interface AssignMacroIdsOptions<T> {
  /**
   * Records this returns `true` for get FIRST claim on the id they arrived with, ahead of
   * array order. Everything else is assigned in array order exactly as it would be without
   * the option, so omitting it reproduces plain `assignUniqueMacroIds()` byte for byte.
   *
   * The reason it exists: re-keying a record is only free when whatever is filed under its
   * old id can be carried to the new one in the same call. `VscodeMacroStore.save()` cannot
   * carry a secret whose vault value it failed to READ (a keyring outage is reported as
   * `undefined`, indistinguishable from "no entry"), so it pins those records instead of
   * moving them — see its `save()`. Two records that both want the same id still cannot
   * both have it; the first in array order wins and the rest are re-keyed as usual.
   *
   * This function does NOT and cannot check whether a record is entitled to the id it arrived
   * with. It applies whatever the predicate says. Deciding that a record may keep an id that
   * names side storage is an OWNERSHIP decision, and the caller supplying the predicate owns
   * it: `VscodeMacroStore.save()` may make it only because of the precondition on its own
   * input (see `MacroStore.save()`), and external input never reaches it because
   * `MacroStore.replaceAll()` strips every incoming id first.
   */
  keepIdIfPossible?: (macro: T) => boolean;
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
 * Returns the pre-dedup id alongside each record. A caller that keys SIDE STORAGE by macro
 * id (`VscodeMacroStore`'s vault) must use `priorId` to look that storage up: consulting
 * the post-dedup id for a re-keyed record asks about a key that has never existed, which
 * silently answers "nothing known" for exactly the records the caller knows least about.
 *
 * WRITE PATHS ONLY. Nothing on a load path may call this — see `MacroStore.save()`.
 */
export function assignMacroIds<T extends { id?: string }>(
  macros: readonly T[],
  options: AssignMacroIdsOptions<T> = {}
): Array<MacroIdAssignment<T>> {
  const priorIds = macros.map((m) => (isValidMacroId(m.id) ? m.id : undefined));
  const finalIds: Array<string | undefined> = macros.map(() => undefined);
  const claimed = new Set<string>();

  const keepIdIfPossible = options.keepIdIfPossible;
  if (keepIdIfPossible) {
    for (let i = 0; i < macros.length; i++) {
      const priorId = priorIds[i];
      if (priorId === undefined || claimed.has(priorId)) continue;
      if (!keepIdIfPossible(macros[i])) continue;
      claimed.add(priorId);
      finalIds[i] = priorId;
    }
  }

  for (let i = 0; i < macros.length; i++) {
    if (finalIds[i] !== undefined) continue;
    const priorId = priorIds[i];
    let id = priorId !== undefined && !claimed.has(priorId) ? priorId : randomUUID();
    while (claimed.has(id)) id = randomUUID();
    claimed.add(id);
    finalIds[i] = id;
  }

  return macros.map((m, i) => ({ macro: { ...m, id: finalIds[i]! }, priorId: priorIds[i] }));
}

/** `assignMacroIds()` without the id-provenance, for callers that keep no side storage. */
export function assignUniqueMacroIds<T extends { id?: string }>(macros: readonly T[]): T[] {
  return assignMacroIds(macros).map((a) => a.macro);
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
