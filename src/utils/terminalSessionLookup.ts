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

export function resolveScriptSessionForTerminal(
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
