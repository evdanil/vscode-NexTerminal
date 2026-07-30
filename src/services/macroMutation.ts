import { getMacros, saveMacros } from "../macroSettings";
import type { TerminalMacro } from "../models/terminalMacro";

/**
 * Shown when a macro cannot be resolved to exactly one record. Deliberately the
 * SAME sentence everywhere — the Macro Editor, every macro command, and a drag
 * onto a folder all hit it for the same reason and the fix is the same one, so
 * two wordings would just be two ways of describing one state.
 *
 * The advice is correct even when the command that failed IS Move Up / Move
 * Down (a stale tree item over a duplicated id, see `resolveMacroTarget`):
 * `MacroStore.save()` re-keys duplicates on every write, so reordering ANY
 * macro from a freshly rendered row clears the conflict for the whole list.
 */
export const AMBIGUOUS_MACRO_TARGET_MESSAGE =
  "Another macro has the same internal id, so Nexus cannot tell which one you mean. " +
  "Reorder any macro with Move Up / Move Down to assign fresh ids, then try again.";

/**
 * How a UI surface names the macro it is acting on: the stable `id` it captured
 * plus — when the reference came from a rendered row — the position that row was
 * built at. Both are needed; neither alone is sufficient. See
 * `resolveMacroTarget`.
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
   */
  readonly index?: number;
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
 * 1. **`macros[ref.index]` when its id matches.** This is the only thing that
 *    can disambiguate two macros sharing an id, because the id — by
 *    construction — cannot. Duplicate stored ids are a REACHABLE state that the
 *    read path deliberately does not repair (`VscodeMacroStore.reloadFromState()`
 *    and `MacroStore.save()`'s doc comment explain why re-keying at load time
 *    would be worse than the duplication), so "first match wins" here means Remove
 *    Macro on the second twin confirms — and deletes — the FIRST one, under the
 *    first one's name. Position is what the user actually pointed at.
 *
 * 2. **The unique holder of `ref.id`.** A tree item outlives the array it was
 *    built from: the row for `B` in `[A, B, C]` carries index 1, and if `A` is
 *    deleted before the command runs, index 1 now names `C`. That index is not
 *    merely stale, it is confidently wrong — and a bounds check does not help,
 *    since 1 is perfectly in bounds. The id is what survives the reorder.
 *
 * 3. **Refuse.** An id claimed by more than one macro, with no index that
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
 */
export function resolveMacroTarget(macros: readonly TerminalMacro[], ref: MacroRef): MacroTarget {
  const id = ref.id;
  if (!id) {
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
