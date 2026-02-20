/**
 * Generates the 108 keybinding entries for package.json.
 * Usage: node scripts/generateKeybindings.mjs
 *
 * Outputs JSON array to stdout. Pipe to a file or copy into package.json.
 *
 * SYNC: The constants and mapping functions below must match src/macroBindings.ts.
 * If you change one, update the other. Verified by test/unit/macroBindings.test.ts.
 */

const MODIFIER_GROUPS = ["alt", "alt+shift", "ctrl+shift"];
const KEYS = [
  "a","b","c","d","e","f","g","h","i","j","k","l","m",
  "n","o","p","q","r","s","t","u","v","w","x","y","z",
  "0","1","2","3","4","5","6","7","8","9"
];

function bindingToVscodeKey(binding) {
  if (binding.startsWith("alt+shift+")) {
    return `shift+alt+${binding.slice(10)}`;
  }
  return binding;
}

function bindingToContextKey(binding) {
  if (binding.startsWith("alt+shift+")) {
    return `nexus.macro.altShift.${binding.slice(10)}`;
  }
  if (binding.startsWith("ctrl+shift+")) {
    return `nexus.macro.ctrlShift.${binding.slice(11)}`;
  }
  return `nexus.macro.alt.${binding.slice(4)}`;
}

const entries = [];

for (const mod of MODIFIER_GROUPS) {
  for (const key of KEYS) {
    const binding = `${mod}+${key}`;
    entries.push({
      command: "nexus.macro.runBinding",
      args: { binding },
      key: bindingToVscodeKey(binding),
      when: `terminalFocus && ${bindingToContextKey(binding)}`
    });
  }
}

console.log(JSON.stringify(entries, null, 6));
