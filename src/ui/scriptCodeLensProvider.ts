import * as vscode from "vscode";
import { parseScriptHeader } from "../services/scripts/scriptHeader";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";

export class ScriptCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
  private readonly managerListener: vscode.Disposable;

  public constructor(private readonly manager: ScriptRuntimeManager) {
    // Only re-emit the lens when the ▶ Run / ◼ Stop state actually changes.
    // Firing on every operationBegin/operationEnd/log event (the default event
    // stream) causes the editor to re-layout its CodeLens row many times per
    // second during an active run.
    this.managerListener = this.manager.onDidChangeRun((event) => {
      if (event.kind === "started" || event.kind === "ended") {
        this._onDidChangeCodeLenses.fire();
      }
    });
  }

  public dispose(): void {
    this.managerListener.dispose();
    this._onDidChangeCodeLenses.dispose();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const header = parseScriptHeader(document.getText());
    if (!header.marker) return [];

    const running = this.manager.getRuns().some((r) => r.scriptPath === document.uri.fsPath);
    const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const lens = new vscode.CodeLens(range);
    if (running) {
      lens.command = {
        title: "◼ Stop Nexus Script",
        command: "nexus.script.stop",
        arguments: [
          // Stop takes a sessionId; look it up from the current runs for this file path.
          this.manager.getRuns().find((r) => r.scriptPath === document.uri.fsPath)?.sessionId
        ]
      };
    } else {
      lens.command = {
        title: "▶ Run in Nexus",
        command: "nexus.script.run",
        arguments: [document.uri]
      };
    }
    return [lens];
  }
}
