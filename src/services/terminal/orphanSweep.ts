import type * as vscode from "vscode";

/**
 * After an extension-host reload, disable-then-enable, or update, VS Code
 * leaves previously-opened Pseudoterminal-backed terminals visually on screen
 * with their last-rendered content but no working link to the new extension
 * instance. `writeEmitter` calls made from the old `deactivate()` path race the
 * extension-host process exit and typically do not reach the renderer, so the
 * tab appears "dead". See microsoft/vscode#122825 and #140697.
 *
 * This sweep runs on every fresh `activate()` and closes any such zombie tabs,
 * so the user always gets a clean slate instead of a frozen husk.
 */
const NEXUS_TERMINAL_NAME_RE = /Nexus (SSH|Serial):/;

export interface OrphanSweepResult {
  count: number;
  names: string[];
}

export function sweepOrphanNexusTerminals(
  terminals: ReadonlyArray<vscode.Terminal>
): OrphanSweepResult {
  const matched = terminals.filter((t) => NEXUS_TERMINAL_NAME_RE.test(t.name));
  for (const terminal of matched) {
    try {
      terminal.dispose();
    } catch {
      /* best effort — ignore a disposed-during-dispose edge case */
    }
  }
  return { count: matched.length, names: matched.map((t) => t.name) };
}
