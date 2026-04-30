import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { renderHighlightRuleEditorHtml } from "./highlightRuleEditorHtml";
import {
  validateAndSanitizeHighlightRules,
  validateAndSanitizeHighlightRulesWithError,
  type HighlightRule
} from "../utils/highlightRuleValidation";

export class HighlightRuleEditorPanel {
  private static instance: HighlightRuleEditorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private readonly configListener: vscode.Disposable;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      "nexus.highlightRuleEditor",
      "Highlighting Rules",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.configListener.dispose();
      HighlightRuleEditorPanel.instance = undefined;
    });

    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.disposed) return;
      if (event.affectsConfiguration("nexus.terminal.highlighting.rules")) {
        this.pushRulesUpdate();
      }
    });
  }

  public static open(): void {
    if (HighlightRuleEditorPanel.instance) {
      HighlightRuleEditorPanel.instance.panel.reveal();
      return;
    }
    HighlightRuleEditorPanel.instance = new HighlightRuleEditorPanel();
  }

  private render(): void {
    const nonce = randomBytes(16).toString("base64");
    const rules = this.readRules();
    this.panel.webview.html = renderHighlightRuleEditorHtml(rules, nonce);
  }

  private readRules(): HighlightRule[] {
    const config = vscode.workspace.getConfiguration("nexus.terminal.highlighting");
    return validateAndSanitizeHighlightRules(config.get<unknown>("rules", [])) ?? [];
  }

  private pushRulesUpdate(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: "rulesUpdated",
      rules: this.readRules()
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "saveRules": {
        const validation = validateAndSanitizeHighlightRulesWithError(msg.rules);
        if (!validation.ok) {
          void this.panel.webview.postMessage({
            type: "saveResult",
            ok: false,
            message: validation.message
          });
          return;
        }
        try {
          const config = vscode.workspace.getConfiguration("nexus.terminal.highlighting");
          await config.update("rules", validation.rules, vscode.ConfigurationTarget.Global);
          void this.panel.webview.postMessage({ type: "saveResult", ok: true });
        } catch {
          void this.panel.webview.postMessage({
            type: "saveResult",
            ok: false,
            message: "Could not save highlighting rules."
          });
        }
        break;
      }
      case "resetDefaults": {
        const confirm = await vscode.window.showWarningMessage(
          "Reset highlighting rules to defaults?",
          { modal: true },
          "Reset"
        );
        if (confirm === "Reset") {
          const config = vscode.workspace.getConfiguration("nexus.terminal.highlighting");
          await config.update("rules", undefined, vscode.ConfigurationTarget.Global);
          this.render();
        }
        break;
      }
    }
  }
}
