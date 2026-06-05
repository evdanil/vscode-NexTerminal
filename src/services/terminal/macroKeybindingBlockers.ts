/**
 * Pure (vscode-free) detection of VS Code settings that block Nexus macro
 * keyboard shortcuts from reaching the extension.
 *
 * This is the read-only counterpart to the confirm-gated repair in
 * `extension.ts` (`repairMacroKeybindings`). It NEVER writes settings — it only
 * inspects the *effective* configuration values and reports which ones, if any,
 * would swallow macro shortcuts. The caller turns a non-empty result into a
 * proactive (but dismissible) hint pointing at "Nexus: Fix Macro Keybindings".
 *
 * Three independent blockers are recognised, in priority order:
 *
 *  1. `terminal.integrated.sendKeybindingsToShell === true`
 *     This setting overrides `commandsToSkipShell`: when on, the terminal shell
 *     receives matched keybindings first, so *every* Nexus macro shortcut is
 *     dead. Listed first because it alone kills everything.
 *  2. `terminal.integrated.commandsToSkipShell` missing any required Nexus
 *     command. A non-array (corrupt) value is treated as "missing all". The
 *     effective value is what matters here, so a workspace-scope override that
 *     replaces the user list is correctly flagged.
 *  3. `window.enableMenuBarMnemonics === true` (default on Linux/Windows)
 *     Alt+letter opens the menu bar, intercepting Alt-based macro shortcuts.
 *
 * Defensive about corrupt types: for the two boolean settings only a literal
 * `true` counts as a blocker (a string `"true"`, the number `1`, `null`, etc.
 * do not). A non-array skip list counts as missing every required command.
 *
 * Keeping this logic vscode-free makes it trivially unit-testable.
 */

export interface MacroKeybindingEnvironment {
  /** Effective value of `terminal.integrated.sendKeybindingsToShell`. */
  sendKeybindingsToShell: unknown;
  /** Effective value of `terminal.integrated.commandsToSkipShell`. */
  commandsToSkipShell: unknown;
  /** Effective value of `window.enableMenuBarMnemonics`. */
  enableMenuBarMnemonics: unknown;
  /** The commands that must be present in the skip-shell list (MACRO_SKIP_SHELL_COMMANDS). */
  requiredCommands: readonly string[];
}

/** Stable blocker identifiers — used verbatim in the toast and asserted by tests. */
export const SEND_KEYBINDINGS_BLOCKER =
  "terminal.integrated.sendKeybindingsToShell is enabled";
export const SKIP_SHELL_BLOCKER =
  "terminal.integrated.commandsToSkipShell is missing Nexus macro commands";
export const MNEMONICS_BLOCKER =
  "window.enableMenuBarMnemonics intercepts Alt shortcuts";

/**
 * Inspect the effective keybinding-related settings and return the list of
 * blockers, in priority order. An empty array means the environment is healthy.
 */
export function detectMacroKeybindingBlockers(env: MacroKeybindingEnvironment): string[] {
  const blockers: string[] = [];

  // 1. sendKeybindingsToShell — only literal `true` is a blocker.
  if (env.sendKeybindingsToShell === true) {
    blockers.push(SEND_KEYBINDINGS_BLOCKER);
  }

  // 2. commandsToSkipShell — a non-array is treated as missing every command.
  const skipList = Array.isArray(env.commandsToSkipShell) ? env.commandsToSkipShell : [];
  const missingCommand = env.requiredCommands.some((cmd) => !skipList.includes(cmd));
  if (missingCommand) {
    blockers.push(SKIP_SHELL_BLOCKER);
  }

  // 3. enableMenuBarMnemonics — only literal `true` is a blocker.
  if (env.enableMenuBarMnemonics === true) {
    blockers.push(MNEMONICS_BLOCKER);
  }

  return blockers;
}
