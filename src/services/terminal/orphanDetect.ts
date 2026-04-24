import type * as vscode from "vscode";

/**
 * After an extension-host reload, disable-then-enable, or update, VS Code
 * leaves previously-opened Pseudoterminal-backed terminals visually on screen
 * with their last-rendered content but no working link to the new extension
 * instance. `writeEmitter` calls made from the old `deactivate()` path race
 * the extension-host process exit and typically do not reach the renderer,
 * so the tab appears "dead". See microsoft/vscode#122825 and #140697.
 *
 * This module DELIBERATELY does not close those tabs. The last-rendered
 * content (command history, log tails, error output) is often useful to the
 * user, and VS Code gives no extension-side way to write a final banner or
 * rename a pseudoterminal whose owning extension host is already gone — so
 * the only available action on an orphan is `terminal.dispose()`, which
 * destroys that content. We leave that decision to the user and surface a
 * one-time information notification so they understand why the tabs are
 * unresponsive.
 */
const NEXUS_TERMINAL_NAME_RE = /Nexus (SSH|Serial):/;

export interface OrphanDetectResult {
  count: number;
  names: string[];
}

export function detectOrphanNexusTerminals(
  terminals: ReadonlyArray<vscode.Terminal>
): OrphanDetectResult {
  const matched = terminals.filter((t) => NEXUS_TERMINAL_NAME_RE.test(t.name));
  return { count: matched.length, names: matched.map((t) => t.name) };
}
