import type * as vscode from "vscode";
import type { LocalShellTerminalMap, SerialTerminalMap, SessionTerminalMap } from "../commands/types";

export function resolveSessionForTerminal(
  terminal: vscode.Terminal | undefined,
  sessionTerminals: SessionTerminalMap,
  serialTerminals: SerialTerminalMap,
  localShellTerminals: LocalShellTerminalMap
): string | undefined {
  if (!terminal) return undefined;
  for (const [sid, term] of sessionTerminals) if (term === terminal) return sid;
  for (const [sid, entry] of serialTerminals) if (entry.terminal === terminal) return sid;
  for (const [sid, entry] of localShellTerminals) if (entry.terminal === terminal) return sid;
  return undefined;
}

/**
 * Script targeting resolves a terminal exactly like everything else does.
 *
 * It did not always: the script variant deliberately omitted `localShellTerminals`
 * back when scripts could not target a local shell. Local-shell scripting support
 * added that map, leaving the two functions character-identical. The separate name
 * is kept because it documents intent at the call site.
 */
export const resolveScriptSessionForTerminal = resolveSessionForTerminal;
