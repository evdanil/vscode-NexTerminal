/**
 * Generates the 216 macro keybinding entries for package.json: 108 for a focused
 * terminal, then their 108 Serial Send Box twins (after all terminal entries, so
 * a runBinding twin for alt+s still outranks the picker twin, as in the terminal).
 * The `nexus.macro.run` (alt+s) pair is written by hand next to these.
 * Usage: node scripts/generateKeybindings.mjs
 *
 * Outputs JSON array to stdout. Pipe to a file or copy into package.json.
 *
 * WHY a separate twin instead of `(terminalFocus || …)` in one entry: the twin
 * passes `source: "serialSendBox"`, so only a key pressed inside a send box makes
 * the command pin that box's session. Sidebar, palette and terminal invocations
 * carry no source and keep resolving `activeTerminal` exactly as before.
 * `nexus.serialSendBoxFocused` is reported by the page itself (VS Code exposes no
 * webview-focus key); `activeWebviewPanelId` alone would stay true while focus is
 * in the sidebar, because VS Code derives it from the active editor. See
 * SERIAL_SEND_FOCUS_CONTEXT in src/ui/serialSendPanel.ts.
 *
 * SYNC: The constants and mapping functions below must match src/macroBindings.ts.
 * If you change one, update the other. Verified by test/unit/macroBindings.test.ts;
 * test/unit/packageContributions.test.ts checks package.json against this output.
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

export const SEND_BOX_FOCUS_WHEN = "nexus.serialSendBoxFocused && activeWebviewPanelId == 'nexus.serialSend'";

const entries = [];
const twins = [];

for (const mod of MODIFIER_GROUPS) {
  for (const key of KEYS) {
    const binding = `${mod}+${key}`;
    entries.push({
      command: "nexus.macro.runBinding",
      args: { binding },
      key: bindingToVscodeKey(binding),
      when: `terminalFocus && ${bindingToContextKey(binding)}`
    });
    twins.push({
      command: "nexus.macro.runBinding",
      args: { binding, source: "serialSendBox" },
      key: bindingToVscodeKey(binding),
      when: `${SEND_BOX_FOCUS_WHEN} && ${bindingToContextKey(binding)}`
    });
  }
}
entries.push(...twins);

console.log(JSON.stringify(entries, null, 6));
