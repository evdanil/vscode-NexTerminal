import { getMacros, saveMacros } from "../macroSettings";
import type { TerminalMacro } from "../models/terminalMacro";

/**
 * What `mutateMacroById` actually did.
 *
 * `"missing"` and `"skipped"` are deliberately distinct. Both mean "nothing was
 * written", but they are different things to tell the user: the target is gone
 * versus the target is still there and no longer eligible. Collapsing them into
 * a bare `false` is what let `nexus.macro.remove` say nothing at all when its
 * macro vanished mid-dialog.
 */
export type MacroMutationOutcome = "saved" | "missing" | "skipped";

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
 * fix. `getMacros()` returns a fresh array on every call, so a pre-dialog index
 * applied to a post-dialog array is not merely stale, it is confidently wrong:
 * with `[A, B]`, opening a dialog on A (index 0) and deleting A from the Macro
 * Editor while it is open leaves `[B]`, and `splice(0, 1)` /
 * `assignBinding(latest, 0, …)` then hits **B** — a macro the user never
 * selected, after a confirmation naming A. A bounds check does not help; index
 * 0 is perfectly in bounds.
 *
 * `id` is the only stable identity a macro has across those awaits. It is a
 * `MacroStore` invariant, not a hope: both store implementations assign a UUID
 * in `save()`, and `VscodeMacroStore` assigns one again in `reloadFromState()`,
 * so everything `getMacros()` ever returns — and therefore every
 * `MacroTreeItem.macro` — carries one. A missing id can only mean the caller
 * synthesised a macro that never came from the store, and is treated as "no
 * target": no write at all, never a guess.
 *
 * **Identity is not the only precondition.** Re-resolving the macro proves it
 * is the same record; it proves nothing about the record's CONTENTS, which the
 * same concurrent writers can also have changed. `pasteSecret` is the case that
 * matters: it may only write a clipboard password into a macro that is *still*
 * `secret`, because a macro that stopped being secret between the prompt and
 * the write stores its text in cleartext in `nexus.macros`. That is what
 * `MacroMutator`'s `false` return is for — check the fresh record, bail
 * cleanly, and let the caller say why.
 *
 * `moveToFolder` and `MacroTreeProvider.handleDrop` solve the same problem in
 * their own shape — many ids / one id, no index needed, a pure field rewrite
 * expressed as a `map` — and are left as they are rather than bent through this
 * signature.
 */
export async function mutateMacroById(
  // `null` as well as `undefined`: the Macro Editor's webview payload carries
  // `id: string | null`, and forcing every call site to launder that into
  // `undefined` would be ceremony around a check that is already a falsy test.
  id: string | null | undefined,
  mutate: MacroMutator
): Promise<MacroMutationOutcome> {
  if (!id) {
    return "missing";
  }
  const latest = getMacros();
  const index = latest.findIndex((m) => m.id === id);
  if (index === -1) {
    return "missing"; // Deleted while the dialog was open — a no-op, never a wrong write.
  }
  if (mutate(latest, index) === false) {
    return "skipped"; // A precondition on the FRESH record failed — no write at all.
  }
  await saveMacros(latest);
  return "saved";
}
