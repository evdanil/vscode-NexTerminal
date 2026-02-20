const MODIFIER_GROUPS = ["alt", "alt+shift", "ctrl+shift"] as const;
const KEYS = [
  "a","b","c","d","e","f","g","h","i","j","k","l","m",
  "n","o","p","q","r","s","t","u","v","w","x","y","z",
  "0","1","2","3","4","5","6","7","8","9"
] as const;

export const ALL_BINDINGS: string[] = [];
for (const mod of MODIFIER_GROUPS) {
  for (const key of KEYS) {
    ALL_BINDINGS.push(`${mod}+${key}`);
  }
}

const BINDING_SET = new Set(ALL_BINDINGS);

export function isValidBinding(binding: string): boolean {
  return BINDING_SET.has(binding.toLowerCase());
}

export function bindingToContextKey(binding: string): string {
  const b = binding.toLowerCase();
  if (b.startsWith("alt+shift+")) {
    return `nexus.macro.altShift.${b.slice(10)}`;
  }
  if (b.startsWith("ctrl+shift+")) {
    return `nexus.macro.ctrlShift.${b.slice(11)}`;
  }
  // alt+X
  return `nexus.macro.alt.${b.slice(4)}`;
}

export function bindingToVscodeKey(binding: string): string {
  const b = binding.toLowerCase();
  // VS Code expects "shift+alt+X" not "alt+shift+X"
  if (b.startsWith("alt+shift+")) {
    return `shift+alt+${b.slice(10)}`;
  }
  // "ctrl+shift+X" is already fine
  return b;
}

export function bindingToDisplayLabel(binding: string): string {
  const b = binding.toLowerCase();
  const parts = b.split("+");
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("+");
}

export function slotToBinding(slot: number): string {
  return `alt+${slot}`;
}

/** Ctrl+Shift keys that conflict with common VS Code defaults */
export const CRITICAL_CTRL_SHIFT_KEYS = new Set([
  "p", "f", "e", "g", "d", "x", "m", "u", "y", "n", "k", "t"
]);

/** Warnings for specific bindings */
export const SPECIAL_BINDING_WARNINGS: Record<string, string> = {
  "alt+s": "This will override the Alt+S macro quick pick shortcut. You can still access the quick pick from the command palette."
};
