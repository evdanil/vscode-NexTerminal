import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { renderHighlightRuleEditorHtml, type HighlightRule } from "./highlightRuleEditorHtml";

const VALID_COLORS = new Set([
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
]);

const VALID_FLAGS_RE = /^[gi]*$/;
const REDOS_RE = /(\+|\*|\{[^}]*\})\)(\+|\*|\{)/;
const MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 500;

function isForegroundCode(code: number): boolean {
  return (code >= 30 && code <= 37) || (code >= 90 && code <= 97);
}

function validateAndSanitizeRules(raw: unknown): HighlightRule[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > MAX_RULES) return undefined;

  const result: HighlightRule[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const obj = item as Record<string, unknown>;
    if (typeof obj.pattern !== "string" || obj.pattern.length === 0) return undefined;
    if (obj.pattern.length > MAX_PATTERN_LENGTH) return undefined;
    if (typeof obj.color !== "string") return undefined;

    // Validate color against named colors (case-sensitive match) or SGR range
    if (!VALID_COLORS.has(obj.color)) {
      const code = Number(obj.color);
      if (!Number.isFinite(code) || !isForegroundCode(code)) return undefined;
    }

    // Check for ReDoS
    if (REDOS_RE.test(obj.pattern)) {
      continue; // skip this rule silently
    }

    // Validate optional fields
    const flags = typeof obj.flags === "string" && VALID_FLAGS_RE.test(obj.flags) ? obj.flags : undefined;
    const bold = typeof obj.bold === "boolean" ? obj.bold : undefined;
    const underline = typeof obj.underline === "boolean" ? obj.underline : undefined;

    const rule: HighlightRule = { pattern: obj.pattern, color: obj.color };
    if (flags !== undefined) rule.flags = flags;
    if (bold !== undefined) rule.bold = bold;
    if (underline !== undefined) rule.underline = underline;
    result.push(rule);
  }
  return result;
}

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
    return config.get<HighlightRule[]>("rules", []);
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
        const validated = validateAndSanitizeRules(msg.rules);
        if (!validated) {
          void vscode.window.showErrorMessage("Invalid highlighting rules data.");
          return;
        }
        const config = vscode.workspace.getConfiguration("nexus.terminal.highlighting");
        await config.update("rules", validated, vscode.ConfigurationTarget.Global);
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
