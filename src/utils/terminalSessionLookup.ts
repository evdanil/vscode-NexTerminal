import type * as vscode from "vscode";
import type { LocalShellTerminalMap, LocalServerTerminalMap, SerialTerminalMap, SessionTerminalMap } from "../commands/types";

export function resolveSessionForTerminal(
  terminal: vscode.Terminal | undefined,
  sessionTerminals: SessionTerminalMap,
  serialTerminals: SerialTerminalMap,
  localShellTerminals: LocalShellTerminalMap,
  localServerTerminals?: LocalServerTerminalMap
): string | undefined {
  if (!terminal) return undefined;
  for (const [sid, term] of sessionTerminals) if (term === terminal) return sid;
  for (const [sid, entry] of serialTerminals) if (entry.terminal === terminal) return sid;
  for (const [sid, entry] of localShellTerminals) if (entry.terminal === terminal) return sid;
  if (localServerTerminals) {
    for (const [sid, entry] of localServerTerminals) if (entry.terminal === terminal) return sid;
  }
  return undefined;
}

/**
 * Script targeting resolves only the terminals a script can drive: SSH / Telnet,
 * serial and Local Shell. A Local Server terminal (`Nexus Local Server: <name>`)
 * is deliberately not among them — the runtime never binds to a Local Server
 * session, so resolving one handed Quick Run an id it could not map and the run
 * ended there, silently. Left out, a focused Local Server terminal is treated
 * like any plain terminal: Quick Run offers the session picker.
 */
export function resolveScriptSessionForTerminal(
  terminal: vscode.Terminal | undefined,
  sessionTerminals: SessionTerminalMap,
  serialTerminals: SerialTerminalMap,
  localShellTerminals: LocalShellTerminalMap
): string | undefined {
  return resolveSessionForTerminal(terminal, sessionTerminals, serialTerminals, localShellTerminals);
}
