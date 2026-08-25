import * as vscode from "vscode";
import type { RegistryEntry, TerminalRegistry } from "../services/terminal/terminalRegistry";
import type { LocalShellTerminalMap, LocalServerTerminalMap, SessionTerminalMap, SerialTerminalMap } from "./types";

export interface TerminalTabCommandsDeps {
  registry: TerminalRegistry;
  sessionTerminals: SessionTerminalMap;
  serialTerminals: SerialTerminalMap;
  localShellTerminals?: LocalShellTerminalMap;
  localServerTerminals?: LocalServerTerminalMap;
}

/**
 * Duck-types VS Code's `terminal/title/context` / `editor/title/context`
 * command argument — the clicked `vscode.Terminal` itself, distinguishing it
 * from the `{ session: { id } }` / `{ profile: { id } }` tree-item shapes
 * used elsewhere in this module and from a bare `FileTreeItem`-style arg
 * (e.g. the File Explorer's `.` row, which carries neither `creationOptions`
 * nor `session`/`profile`).
 *
 * Exported so any other command module resolving the same terminal-tab
 * argument shape (`cwdSyncCommands.ts`'s `nexus.files.syncFromTerminal`)
 * shares this one definition rather than re-deriving the check.
 */
export function isTerminalArg(arg: unknown): arg is vscode.Terminal {
  return !!arg && typeof (arg as vscode.Terminal).creationOptions === "object";
}

function resolveTerminal(
  arg: unknown,
  deps: TerminalTabCommandsDeps
): vscode.Terminal | undefined {
  if (isTerminalArg(arg)) {
    return arg;
  }
  const asAny = arg as Record<string, unknown> | undefined;
  if (asAny?.session && typeof (asAny.session as Record<string, unknown>).id === "string") {
    const sessionId = (asAny.session as { id: string }).id;
    const ssh = deps.sessionTerminals.get(sessionId);
    if (ssh) return ssh;
    const serial = deps.serialTerminals.get(sessionId);
    if (serial) return serial.terminal;
    const localShell = deps.localShellTerminals?.get(sessionId);
    if (localShell) return localShell.terminal;
    const localServer = deps.localServerTerminals?.get(sessionId);
    if (localServer) return localServer.terminal;
  }
  if (asAny?.profile && typeof (asAny.profile as Record<string, unknown>).id === "string") {
    const profileId = (asAny.profile as { id: string }).id;
    for (const entry of deps.serialTerminals.values()) {
      if (entry.profileId === profileId) return entry.terminal;
    }
    for (const entry of deps.localShellTerminals?.values() ?? []) {
      if (entry.profileId === profileId) return entry.terminal;
    }
  }
  // `LocalServerConfigTreeItem` carries `config: LocalServerConfig`, so the id
  // is at `arg.config.id`. The earlier flat-`configId` probe matched no tree
  // item this view ever produces, so EVERY invocation from a local server's
  // config row fell through to the *active* terminal — a Reset there could
  // clear an unrelated tab. No caller passes a flat `configId`.
  //
  // This narrows the hazard rather than removing it. On a miss — a session that
  // died between the menu rendering and the click, say — control still reaches
  // the `activeTerminal` fall-through below and can act on the wrong tab. That
  // is the same residual shape as the `.profile` probe just above, and is
  // pre-existing rather than new; the fall-through is what keeps palette
  // invocation (which carries no argument at all) working.
  if (asAny && typeof asAny === "object") {
    const config = (asAny as { config?: { id?: unknown } }).config;
    if (config && typeof config.id === "string") {
      const configId = config.id;
      for (const entry of deps.localServerTerminals?.values() ?? []) {
        if (entry.configId === configId) return entry.terminal;
      }
    }
  }
  return vscode.window.activeTerminal ?? undefined;
}

function resolveEntry(
  arg: unknown,
  deps: TerminalTabCommandsDeps
): RegistryEntry | undefined {
  const terminal = resolveTerminal(arg, deps);
  return terminal ? deps.registry.get(terminal) : undefined;
}

export function registerTerminalTabCommands(
  context: vscode.ExtensionContext,
  deps: TerminalTabCommandsDeps
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.terminal.reset", (arg?: unknown) => {
      const entry = resolveEntry(arg, deps);
      if (!entry || !deps.registry.isConnected(entry)) return;
      entry.pty.resetTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.terminal.clearScrollback", async (arg?: unknown) => {
      const entry = resolveEntry(arg, deps);
      if (!entry || !deps.registry.isConnected(entry)) return;
      entry.buffer.clear();
      if (vscode.window.activeTerminal !== entry.terminal) {
        entry.terminal.show(true);
      }
      await vscode.commands.executeCommand("workbench.action.terminal.clear");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.terminal.copyAll", async (arg?: unknown) => {
      const entry = resolveEntry(arg, deps);
      if (!entry) return;
      const text = entry.buffer.getText();
      if (text.length === 0) {
        void vscode.window.showWarningMessage("Nothing to copy.");
        return;
      }
      try {
        await vscode.env.clipboard.writeText(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown clipboard error";
        void vscode.window.showErrorMessage(`Failed to copy to clipboard: ${message}`);
        return;
      }
      const n = entry.buffer.lineCount();
      const unit = n === 1 ? "line" : "lines";
      void vscode.window.showInformationMessage(`Copied ${n} ${unit} to clipboard.`);
    })
  );
}
