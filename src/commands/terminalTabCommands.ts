import * as vscode from "vscode";
import type { RegistryEntry, TerminalRegistry } from "../services/terminal/terminalRegistry";

function resolveEntry(
  registry: TerminalRegistry,
  terminal: vscode.Terminal | undefined
): RegistryEntry | undefined {
  const target = terminal ?? vscode.window.activeTerminal;
  return target ? registry.get(target) : undefined;
}

export function registerTerminalTabCommands(
  context: vscode.ExtensionContext,
  registry: TerminalRegistry
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.terminal.reset", (terminal?: vscode.Terminal) => {
      const entry = resolveEntry(registry, terminal);
      if (!entry || !registry.isConnected(entry)) return;
      entry.pty.resetTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.terminal.clearScrollback", async (terminal?: vscode.Terminal) => {
      const entry = resolveEntry(registry, terminal);
      if (!entry || !registry.isConnected(entry)) return;
      entry.buffer.clear();
      // `workbench.action.terminal.clear` has no terminal argument and always
      // targets the active terminal. If the user right-clicked a non-active
      // tab's title, focus the resolved terminal first so the visible-scrollback
      // clear matches the buffer clear we just did.
      if (vscode.window.activeTerminal !== entry.terminal) {
        entry.terminal.show(true);
      }
      await vscode.commands.executeCommand("workbench.action.terminal.clear");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.terminal.copyAll", async (terminal?: vscode.Terminal) => {
      const entry = resolveEntry(registry, terminal);
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
