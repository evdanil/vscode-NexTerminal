import { slotToBinding } from "./macroBindings";
import type { TerminalMacro } from "./models/terminalMacro";

/**
 * The one place a raw `keybinding` value becomes the binding the app applies. Takes `unknown`
 * and TYPE-CHECKS, rather than trusting the declared `string`, because every caller is fed by
 * something that does not enforce it:
 *
 *   - a hand-edited `nexus.terminal.macros` (`keybinding: 1` — the slot number written into the
 *     field that superseded it — is the plausible one), absorbed into the store verbatim;
 *   - a backup or share file, which is JSON from another machine;
 *   - `nexus.macro.runBinding`'s command argument.
 *
 * Without the check, `binding?.trim()` threw a TypeError for every non-string that is not
 * null/undefined, and it threw in places that had no business failing. `getAssignedBinding()`
 * below is called from `canonicalMacroBinding()` (storage/macroStore.ts), which both content
 * keys build on — so ONE such record made `VscodeMacroStore.initialize()` reject inside
 * `keyOfLegacy()`, and `extension.ts` awaits that uncaught: activation failed, on every start,
 * with no way out, since absorption throws before it clears the setting it was reading. The
 * same call sits on both import loops (`keyOf()`) and on the macro editor's own render
 * (`renderMacroEditorHtml()`'s `bindingValue`), which is what the user would have opened to
 * repair the record.
 *
 * Behaviour for strings is unchanged, byte for byte; `null`/`undefined` still answer
 * `undefined` as they always did. Only the values that used to throw now resolve — to
 * `undefined`, i.e. "this record binds nothing", which is what every consumer already does with
 * an absent keybinding and lets `getAssignedBinding()` fall through to a legacy `slot`.
 */
export function normalizeBinding(binding: unknown): string | undefined {
  if (typeof binding !== "string") return undefined;
  const normalized = binding.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function getAssignedBinding(macro: Pick<TerminalMacro, "keybinding" | "slot">): string | undefined {
  return normalizeBinding(macro.keybinding) ?? (macro.slot !== undefined ? slotToBinding(macro.slot) : undefined);
}

export function findBindingOwnerIndex(
  macros: TerminalMacro[],
  binding: string,
  excludeIndex?: number
): number {
  const normalized = normalizeBinding(binding);
  if (!normalized) {
    return -1;
  }
  return macros.findIndex((macro, index) => index !== excludeIndex && getAssignedBinding(macro) === normalized);
}

export function assignBinding(macros: TerminalMacro[], targetIndex: number, binding: string | null): void {
  const normalized = normalizeBinding(binding);
  if (!normalized) {
    delete macros[targetIndex].keybinding;
    delete macros[targetIndex].slot;
    return;
  }

  for (const macro of macros) {
    if (getAssignedBinding(macro) === normalized) {
      delete macro.keybinding;
      delete macro.slot;
    }
  }

  macros[targetIndex].keybinding = normalized;
  delete macros[targetIndex].slot;
}
