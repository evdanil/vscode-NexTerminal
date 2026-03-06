import { slotToBinding } from "./macroBindings";
import type { TerminalMacro } from "./models/terminalMacro";

export function normalizeBinding(binding: string | null | undefined): string | undefined {
  const normalized = binding?.trim().toLowerCase();
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
