import type * as vscode from "vscode";

export interface SessionActivityController {
  clearSessionActivity(sessionId: string): void;
}

export interface ActivityIndicatorController {
  setActivityIndicator(active: boolean): void;
}

export interface SerialTerminalEntry {
  terminal: vscode.Terminal;
}

export type SessionTerminalType = "ssh" | "serial";

interface SessionActivityOptions {
  core: SessionActivityController;
  activityIndicators: Map<string, ActivityIndicatorController>;
}

export interface FocusSessionTerminalOptions extends SessionActivityOptions {
  sessionTerminals: Map<string, vscode.Terminal>;
  serialTerminals: Map<string, SerialTerminalEntry>;
  onTerminalFocused?: (terminal: vscode.Terminal) => void;
}

export function clearTrackedSessionActivity(options: SessionActivityOptions, sessionId: string): void {
  options.core.clearSessionActivity(sessionId);
  options.activityIndicators.get(sessionId)?.setActivityIndicator(false);
}

export function focusSessionTerminal(
  options: FocusSessionTerminalOptions,
  sessionId: string,
  type: SessionTerminalType
): boolean {
  const terminal = type === "serial"
    ? options.serialTerminals.get(sessionId)?.terminal
    : options.sessionTerminals.get(sessionId);
  if (!terminal) {
    return false;
  }

  options.onTerminalFocused?.(terminal);
  clearTrackedSessionActivity(options, sessionId);
  terminal.show();
  return true;
}
