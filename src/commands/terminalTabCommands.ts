import * as vscode from "vscode";
import type { RegistryEntry, TerminalRegistry } from "../services/terminal/terminalRegistry";
import type { SessionTerminalMap, SerialTerminalMap } from "./types";

export interface TerminalTabCommandsDeps {
  registry: TerminalRegistry;
  sessionTerminals: SessionTerminalMap;
  serialTerminals: SerialTerminalMap;
}

function resolveTerminal(
  arg: unknown,
  deps: TerminalTabCommandsDeps
): vscode.Terminal | undefined {
  if (arg && typeof (arg as vscode.Terminal).creationOptions === "object") {
    return arg as vscode.Terminal;
  }
  const asAny = arg as Record<string, unknown> | undefined;
  if (asAny?.session && typeof (asAny.session as Record<string, unknown>).id === "string") {
    const sessionId = (asAny.session as { id: string }).id;
    const ssh = deps.sessionTerminals.get(sessionId);
    if (ssh) return ssh;
    for (const entry of deps.serialTerminals.values()) {
      if (entry.terminal) return entry.terminal;
    }
  }
  if (asAny?.profile && typeof (asAny.profile as Record<string, unknown>).id === "string") {
    const profileId = (asAny.profile as { id: string }).id;
    for (const entry of deps.serialTerminals.values()) {
      if (entry.profileId === profileId) return entry.terminal;
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
