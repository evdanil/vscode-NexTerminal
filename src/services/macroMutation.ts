import { getMacros, saveMacros } from "../macroSettings";
import type { TerminalMacro } from "../models/terminalMacro";

/**
 * Shown when a macro cannot be resolved to exactly one record. Deliberately the
 * SAME sentence everywhere — the Macro Editor, every macro command, and a drag
 * onto a folder all hit it for the same reason and the fix is the same one, so
 * two wordings would just be two ways of describing one state.
 *
 * Phrased in the PAST tense ("was claimed") on purpose. The refusal covers two
 * states, and only one of them is still visible in the array being resolved
 * against: the id may be shared right now, or it may have been shared when the
 * user clicked and been split apart by a re-keying `save()` since (see
 * `resolveMacroTarget`'s rule 2). A present-tense sentence would be a false
 * statement about the second case, which is the more dangerous of the two.
 *
 * One refusal it does NOT literally describe: an `"unverified"` reference that
 * names a position which no longer holds its id (rule 2b — a drag payload from
 * a producer outside this extension). Nothing is known about that id's history,
 * so no sentence can be a statement of fact about it; this one is still the
 * right thing to show, because the state it describes is the one that CANNOT be
 * ruled out — a foreign payload may well have been captured over a duplicated
 * id — and its advice (reorder to re-key, then repeat the gesture) is sound
 * either way. That path is unreachable from payloads this extension writes.
 *
 * The advice is correct even when the command that failed IS Move Up / Move
 * Down (a stale tree item over a duplicated id, see `resolveMacroTarget`):
 * `MacroStore.save()` re-keys duplicates on every write, so reordering ANY
 * macro from a freshly rendered row clears the conflict for the whole list —
 * and once it is cleared, a reference captured from a freshly rendered row is
 * unambiguous and resolves normally.
 */
export const AMBIGUOUS_MACRO_TARGET_MESSAGE =
  "Nexus cannot tell which macro you mean — the same internal id was claimed by more than one macro. " +
  "Reorder any macro with Move Up / Move Down to assign fresh ids, then try again.";

/**
 * What the CAPTURING surface knew about `MacroRef.id` at the moment it took the
 * reference — i.e. how many macros in the array it was looking at carried that
 * id. This is provenance, not a fact about the array a reference is later
 * resolved against, and it cannot be recomputed at resolution time: see
 * `resolveMacroTarget`'s rule 2 for the interleaving that makes the two
 * indistinguishable after the fact.
 *
 * - `"unique"` — checked: exactly one macro carried the id.
 * - `"ambiguous"` — checked: more than one did.
 * - `"absent"` — checked: NONE did. Distinct from `"unique"` because "exactly
 *   one" and "none at all" are opposite facts about the future: a later array
 *   can only ever have FEWER holders of a unique id, but an id with none can
 *   gain one (a config import, legacy absorption, an undo that re-adds a
 *   record). Folding the two together is what let a reference to a row that was
 *   already deleted resolve, one await later, to a freshly imported macro that
 *   merely inherited the id — with `pasteSecret` that is a clipboard password
 *   written into a record the user has never seen. An absent reference
 *   therefore resolves to `"missing"` and never to a holder that appeared after
 *   the fact.
 * - `"unverified"` — could not be checked, because there was no array to check
 *   against. Reserved for a drag payload produced by something other than this
 *   extension (`parseMacroDragPayload`). Treated like `"unique"` ONLY while the
 *   reference names no position: a payload from an unknown producer has no
 *   capture-time state to preserve, and refusing every bare-id drop would break
 *   that contract without protecting anything. An unverified reference that DOES
 *   claim a position is a different matter — see `resolveMacroTarget`'s rule 2b.
 */
export type MacroIdProvenance = "unique" | "ambiguous" | "absent" | "unverified";

/**
 * How a UI surface names the macro it is acting on: the stable `id` it captured,
 * the position that row was built at (when the reference came from a rendered
 * row), and what was true about that id AT CAPTURE TIME. All three are needed;
 * no two of them are sufficient. See `resolveMacroTarget`.
 *
 * Build one with `captureMacroRef` / `captureMacroRefFromRow` rather than an
 * object literal: `idWhenCaptured` is required precisely so that a new call site
 * cannot quietly inherit the guessing behaviour by omitting it.
 */
export interface MacroRef {
  // `null` as well as `undefined`: the Macro Editor's webview payload carries
  // `id: string | null`, and forcing every call site to launder that into
  // `undefined` would be ceremony around a check that is already a falsy test.
  readonly id: string | null | undefined;
  /**
   * The array position this reference was RENDERED at, when there is one. Omit
   * it (rather than pass a guess) for a reference that never came from a row —
   * the Macro Editor's webview payload, for instance. A wrong index is never
   * acted on, but an absent one gives up the only signal that can separate two
   * macros sharing an id.
   *
   * Present-but-wrong is not the same as absent, and rule 2b treats them
   * differently for an `"unverified"` reference: claiming a position and being
   * wrong about it is evidence the producer's view of the list is stale, which
   * is exactly when falling back to the id can land on the wrong twin.
   */
  readonly index?: number;
  /** See `MacroIdProvenance`. Required — there is no safe default. */
  readonly idWhenCaptured: MacroIdProvenance;
}

/**
 * How many macros in `macros` carry `id`, saturating at 2 — none, one, or more
 * than one. All three are distinct answers; see `MacroIdProvenance` for why
 * "none" must not be reported as "one".
 */
function idProvenance(macros: readonly TerminalMacro[], id: string | null | undefined): MacroIdProvenance {
  if (!id) {
    // Resolves to "missing" before provenance is ever consulted, so this label
    // is never load-bearing — but "absent" is the true one.
    return "absent";
  }
  let seen = 0;
  for (const macro of macros) {
    if (macro.id === id && ++seen > 1) {
      return "ambiguous";
    }
  }
  return seen === 1 ? "unique" : "absent";
}

/**
 * The ONE way to take a reference to a macro. `macros` is the array the user was
 * looking at when they pointed at it — a tree row's list, the array a quick pick
 * was built from, the list the Macro Editor last rendered — NOT a freshly read
 * one from after an `await`. Capturing against a post-dialog array is the same
 * defect this function exists to close, just moved one await earlier.
 */
export function captureMacroRef(
  macros: readonly TerminalMacro[],
  id: string | null | undefined,
  index?: number
): MacroRef {
  return { id, index, idWhenCaptured: idProvenance(macros, id) };
}

/**
 * The duck-typed shape of a rendered macro row. `MacroTreeItem`
 * (ui/macroTreeProvider.ts) satisfies it; so does the `{ macro, index }` literal
 * every command handler already accepts, which is why this is structural rather
 * than a class import (commands/macroCommands.ts imports `MacroTreeItem` as a
 * TYPE only, deliberately).
 */
export interface MacroRowLike {
  readonly macro: { readonly id?: string };
  readonly index: number;
  /**
   * What the row was RENDERED knowing: `true` when another macro in the list the
   * row was drawn from carried the same id (`MacroTreeItem`'s identity-conflict
   * flag, which the Macros tree already computes for its warning icon).
   *
   * This is strictly better provenance than anything the command can work out
   * for itself, because it predates even the click: a re-keying save that lands
   * between the tree painting and the user clicking the row leaves the command's
   * own view of the array looking perfectly unambiguous. Absent (a hand-built
   * `{ macro, index }`), the array passed in is used instead.
   */
  readonly identityConflict?: boolean;
}

/**
 * `captureMacroRef` for a clicked row: ambiguous if EITHER the row was rendered
 * over a duplicated id or the id is duplicated in `macros` now. Two independent
 * capture points, and either one saying "shared" is enough — see
 * `MacroRowLike.identityConflict`.
 */
export function captureMacroRefFromRow(macros: readonly TerminalMacro[], row: MacroRowLike): MacroRef {
  if (row.identityConflict === true && row.macro.id) {
    return { id: row.macro.id, index: row.index, idWhenCaptured: "ambiguous" };
  }
  return captureMacroRef(macros, row.macro.id, row.index);
}

/** The outcome of resolving a `MacroRef` against a concrete array. */
export type MacroTarget =
  | { readonly kind: "resolved"; readonly index: number }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" };

/**
 * The one way anything in this codebase turns "the macro the user clicked" into
 * "a position in THIS array". Every call site must use it; the two defects that
 * produced it were a direct consequence of each site solving half the problem
 * its own way.
 *
 * Precedence, in order:
 *
 * 0. **Refuse to look, when the id was ALREADY absent at capture time.** A
 *    reference whose `idWhenCaptured` is `"absent"` is `"missing"` and nothing
 *    else — not even by index, since a position that matches an id which was
 *    not in the capture-time array can only be matching a record that arrived
 *    afterwards. See `MacroIdProvenance`: "no holder" and "one holder" diverge
 *    in the future, so they cannot share a label.
 *
 * 1. **`macros[ref.index]` when its id matches.** This is the only thing that
 *    can disambiguate two macros sharing an id, because the id — by
 *    construction — cannot. Duplicate stored ids are a REACHABLE state that the
 *    read path deliberately does not repair (`VscodeMacroStore.reloadFromState()`
 *    and `MacroStore.save()`'s doc comment explain why re-keying at load time
 *    would be worse than the duplication), so "first match wins" here means Remove
 *    Macro on the second twin confirms — and deletes — the FIRST one, under the
 *    first one's name. Position is what the user actually pointed at.
 *
 * 2. **Refuse, when the id was ALREADY shared at capture time.** A reference
 *    whose `idWhenCaptured` is `"ambiguous"` is honoured by rule 1 and by
 *    nothing else — it never falls through to rule 3.
 *
 *    This is not the same check as rule 3, and rule 3 does not subsume it,
 *    because `MacroStore.save()` re-keys duplicates: after any save the
 *    contested id has exactly ONE holder. WHICH twin keeps it is not fixed —
 *    `assignUniqueMacroIds()` awards it in array order, while
 *    `VscodeMacroStore.save()` supplies `keepIdIfPossible`, so a secret whose
 *    vault value it could not read claims the id it arrived with ahead of array
 *    order and an EARLIER twin is re-keyed instead. This rule needs only the
 *    "exactly one holder" part. So take `[U(u), First(x), Second(x)]`, click
 *    `Second` (id `x`, index 2), and let any unrelated save land while the
 *    dialog is up — an edit to `U` is enough. Say `x` stays with `First`: the
 *    store now holds `[U(u), First(x), Second(new-id)]`, index 2 no longer
 *    matches, and `x` now has exactly ONE holder, so rule 3 would resolve —
 *    confidently, and to `First`, a macro the user never touched. Nothing in
 *    the resolved array distinguishes that from the perfectly ordinary
 *    stale-index case in rule 3; only what was true when the reference was
 *    taken does, which is why `MacroRef` carries it.
 *
 * 2b. **Refuse, when an `"unverified"` reference named a position and that
 *    position did not check out.** A payload from a producer outside this
 *    extension is trusted to name a macro by id (rule 3) precisely because it
 *    claims nothing more. The moment it also claims a POSITION and that claim
 *    turns out to be wrong, its view of the list is demonstrably stale — and
 *    "stale view of the list, id no longer where it said it was" is the exact
 *    shape of rule 2's re-keyed twin, minus the capture-time knowledge that
 *    would let the two be told apart. Falling back to the id there is the same
 *    guess rule 2 refuses, made with strictly less information. Bare-id
 *    payloads keep resolving by id: with no position claimed there is nothing
 *    to be stale about, and that contract (`parseMacroDragPayload`) predates
 *    the index.
 *
 * 3. **The unique holder of `ref.id`.** A tree item outlives the array it was
 *    built from: the row for `B` in `[A, B, C]` carries index 1, and if `A` is
 *    deleted before the command runs, index 1 now names `C`. That index is not
 *    merely stale, it is confidently wrong — and a bounds check does not help,
 *    since 1 is perfectly in bounds. The id is what survives the reorder.
 *
 * 4. **Refuse.** An id claimed by more than one macro, with no index that
 *    matched, is genuinely unresolvable: both candidates are equally plausible
 *    and one of them is someone's password. This mirrors what the Macro Editor
 *    has always done for its own save/delete and what `MacroAutoTrigger` does
 *    for an ambiguous state key — refusing is a fail-safe, and it is never a
 *    dead end, because any write re-keys duplicates.
 *
 * A missing id (a macro synthesised by a caller, never returned by the store)
 * is "no target": no write at all, never a guess. Every macro `getMacros()`
 * returns carries an id — both store implementations assign one in `save()`,
 * and `VscodeMacroStore` assigns one again in `reloadFromState()`.
 *
 * Rule 2 reports `"ambiguous"` even when the id has since vanished from the
 * array entirely, where rule 3 would have said `"missing"`. That is deliberate:
 * after a re-key, "the twin I meant was deleted" and "the twin I meant is still
 * there under a new id" produce the identical array, so `"missing"` would be a
 * guess dressed up as a fact — and `"missing"` is a state callers report to the
 * user ("…was already removed"), not merely a no-op.
 *
 * Rule 0 is the opposite trade for the opposite reason: there, `"missing"` IS
 * the fact — the id was already gone when the user pointed at it — and the only
 * thing that could turn up later is an impostor.
 */
export function resolveMacroTarget(macros: readonly TerminalMacro[], ref: MacroRef): MacroTarget {
  const id = ref.id;
  if (!id) {
    return { kind: "missing" };
  }
  if (ref.idWhenCaptured === "absent") {
    // Rule 0. Deliberately ahead of the index check: an index that "matches"
    // an id which was not in the capture-time array is matching an arrival, not
    // the record the user pointed at.
    return { kind: "missing" };
  }
  const index = ref.index;
  if (
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < macros.length &&
    macros[index].id === id
  ) {
    return { kind: "resolved", index };
  }
  if (ref.idWhenCaptured === "ambiguous") {
    return { kind: "ambiguous" };
  }
  if (ref.idWhenCaptured === "unverified" && index !== undefined) {
    // Rule 2b. Reaching here means rule 1 declined the position: it was out of
    // range, not an integer, or the macro sitting there carries a different id.
    // Either way a position was CLAIMED and did not check out.
    //
    // `index !== undefined` rather than `typeof index === "number"` only so this
    // does not re-state rule 1's guard; it does not widen the rule to other
    // shapes, and no such shape reaches it. `MacroRef.index` is typed `number |
    // undefined`, and the one producer of an unverified reference
    // (`parseMacroDragPayload`) keeps the field only when it already is a
    // number. A foreign payload writing `{"id":"x","index":"2"}` therefore
    // arrives as a BARE id and resolves by rule 3 — the sanctioned bare-id
    // contract (nothing was claimed that this module could check), not a way
    // around this rule. What `index !== undefined` does still cover is the
    // numbers rule 1 rejects: `NaN`, a fraction, a negative or out-of-range
    // position.
    return { kind: "ambiguous" };
  }
  const first = macros.findIndex((m) => m.id === id);
  if (first === -1) {
    return { kind: "missing" };
  }
  if (macros.some((m, i) => i > first && m.id === id)) {
    return { kind: "ambiguous" };
  }
  return { kind: "resolved", index: first };
}

/**
 * What `mutateMacro` actually did.
 *
 * `"missing"`, `"ambiguous"` and `"skipped"` are deliberately distinct. All
 * three mean "nothing was written", but they are different things to tell the
 * user: the target is gone, the target cannot be identified, or the target is
 * still there and no longer eligible. Collapsing them into a bare `false` is
 * what let `nexus.macro.remove` say nothing at all when its macro vanished
 * mid-dialog.
 */
export type MacroMutationOutcome = "saved" | "missing" | "ambiguous" | "skipped";

/**
 * Receives the FRESHLY read array and the index of the target macro WITHIN THAT
 * ARRAY, so whole-array operations (`splice`, `assignBinding`'s
 * clear-the-binding-from-everyone-else pass) work exactly as before.
 *
 * Return `false` — and only an explicit `false` — to abort: no save, outcome
 * `"skipped"`. Returning nothing proceeds, so use a block body; an arrow with
 * an expression body would make the outcome depend on whatever the last
 * expression happened to evaluate to.
 */
export type MacroMutator = (macros: TerminalMacro[], index: number) => boolean | void;

/**
 * The one safe way to run the shape "resolve a macro, await a dialog, then
 * mutate the array" — hand-rolled five times before this, and wrong every time.
 *
 * **The threat is not another window.** `MacroStore.getAll()` serves an
 * in-memory `resolved` array that only this window's own `save()` /
 * `clearAll()` / `initialize()` ever update; VS Code's `Memento` has no change
 * event, so a second window writing `globalState` is invisible here until
 * reload. The writers that actually overlap a dialog are all in THIS window:
 * the Macro Editor panel saving, a drag-and-drop onto a folder, `moveToFolder`,
 * a config import, another macro command. `{ modal: true }` does not prevent
 * them — modality blocks the user's input, not the extension host's async work
 * — and the non-modal `showWarningMessage` / `showInformationMessage` used by
 * `confirmBindingWarnings` and the paste-newline prompt leave the whole window
 * interactive, so the user can drive one of those writers by hand while the
 * notification is still up.
 *
 * The trap is that re-reading `getMacros()` after the dialog is only HALF the
 * fix. `getMacros()` returns a fresh array on every call, so the reference must
 * be re-resolved against THAT array — which is what `resolveMacroTarget` is
 * for, and why the caller passes a `MacroRef` rather than an index.
 *
 * **The `ref` must be captured before the first `await`.** `MacroRef` records
 * what was true about its id when the user pointed at the macro
 * (`MacroIdProvenance`), and that is the one input `resolveMacroTarget` cannot
 * reconstruct later. Building the ref at the write site — from an array read
 * after the dialog — hands it provenance describing the post-dialog world,
 * which is exactly the state rule 2 of `resolveMacroTarget` exists to
 * distinguish from. `pasteSecret` was written that way and had to be moved.
 *
 * **Identity is not the only precondition.** Re-resolving the macro proves it
 * is the same record; it proves nothing about the record's CONTENTS, which the
 * same concurrent writers can also have changed. `pasteSecret` is the case that
 * matters: it may only write a clipboard password into a macro that is *still*
 * `secret`, because a macro that stopped being secret between the prompt and
 * the write stores its text in cleartext in `nexus.macros`. That is what
 * `MacroMutator`'s `false` return is for — check the fresh record, bail
 * cleanly, and let the caller say why.
 */
export async function mutateMacro(ref: MacroRef, mutate: MacroMutator): Promise<MacroMutationOutcome> {
  const latest = getMacros();
  const target = resolveMacroTarget(latest, ref);
  if (target.kind !== "resolved") {
    // Deleted while the dialog was open, or no longer identifiable — a no-op,
    // never a wrong write.
    return target.kind;
  }
  if (mutate(latest, target.index) === false) {
    return "skipped"; // A precondition on the FRESH record failed — no write at all.
  }
  await saveMacros(latest);
  return "saved";
}
