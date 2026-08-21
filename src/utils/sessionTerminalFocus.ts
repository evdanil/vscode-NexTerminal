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

export interface LocalShellTerminalEntry {
  terminal: vscode.Terminal;
}

export interface LocalServerTerminalEntry {
  terminal: vscode.Terminal;
}

export type SessionTerminalType = "ssh" | "serial" | "localShell" | "localServer";

export interface SessionActivityOptions {
  core: SessionActivityController;
  activityIndicators: Map<string, ActivityIndicatorController>;
}

export interface FocusSessionTerminalOptions extends SessionActivityOptions {
  sessionTerminals: Map<string, vscode.Terminal>;
  serialTerminals: Map<string, SerialTerminalEntry>;
  localShellTerminals?: Map<string, LocalShellTerminalEntry>;
  localServerTerminals?: Map<string, LocalServerTerminalEntry>;
  onTerminalFocused?: (terminal: vscode.Terminal) => void;
}

export function clearTrackedSessionActivity(options: SessionActivityOptions, sessionId: string): void {
  options.core.clearSessionActivity(sessionId);
  options.activityIndicators.get(sessionId)?.setActivityIndicator(false);
}

export interface FocusedSessionController extends SessionActivityController {
  setFocusedSession(sessionId: string | undefined): void;
}

/**
 * The mutable "which terminal is focused" holder — `CommandContext` in
 * production. Kept structural so the handlers below stay testable without a
 * `vscode` mock.
 */
export interface FocusedTerminalHolder {
  focusedTerminal?: vscode.Terminal | undefined;
}

export interface TerminalFocusChangeOptions extends SessionActivityOptions {
  core: FocusedSessionController;
  target: FocusedTerminalHolder;
  /** Reverse-lookup: given a VS Code terminal, the Nexus session id that owns it. */
  resolveSessionId(terminal: vscode.Terminal | undefined): string | undefined;
}

/**
 * `window.onDidChangeActiveTerminal` handler. The **only** place that drives
 * `NexusCore.setFocusedSession` — see `applyActiveEditorChange` below for why
 * that matters.
 */
export function applyActiveTerminalChange(
  options: TerminalFocusChangeOptions,
  terminal: vscode.Terminal | undefined
): void {
  options.target.focusedTerminal = terminal ?? undefined;
  const sessionId = options.resolveSessionId(terminal);
  options.core.setFocusedSession(sessionId);
  if (sessionId) {
    clearTrackedSessionActivity(options, sessionId);
  }
}

/**
 * `window.onDidChangeActiveTextEditor` handler.
 *
 * **INVARIANT (directory-sync design doc §5.3 rule 7): moving focus to an
 * editor must NOT clear `focusedSessionId`.** Only `applyActiveTerminalChange`
 * may call `core.setFocusedSession`, and VS Code fires
 * `onDidChangeActiveTerminal` solely on an actual terminal-focus change — so
 * `activeTerminal`'s "focused **or most recently focused**" semantics are
 * load-bearing: the File Explorer keeps following the last-focused terminal
 * while the user's focus is in the tree or in an editor. Do not "fix" this by
 * calling `core.setFocusedSession(undefined)` here; directory sync would go
 * dead the moment the user opened a remote file.
 */
export function applyActiveEditorChange(options: TerminalFocusChangeOptions): void {
  options.target.focusedTerminal = undefined;
}

export function focusSessionTerminal(
  options: FocusSessionTerminalOptions,
  sessionId: string,
  type: SessionTerminalType
): boolean {
  const terminal = type === "serial"
      ? options.serialTerminals.get(sessionId)?.terminal
    : type === "localShell"
      ? options.localShellTerminals?.get(sessionId)?.terminal
    : type === "localServer"
      ? options.localServerTerminals?.get(sessionId)?.terminal
      : options.sessionTerminals.get(sessionId);
  if (!terminal) {
    return false;
  }

  options.onTerminalFocused?.(terminal);
  clearTrackedSessionActivity(options, sessionId);
  terminal.show();
  return true;
}
