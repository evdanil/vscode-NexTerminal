import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { renderSettingsHtml } from "./settingsHtml";
import { SETTINGS_META } from "./settingsMetadata";

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private pendingScrollTo: string | undefined;
  private readonly configListener: vscode.Disposable;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      "nexus.settings",
      "Nexus Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.configListener.dispose();
      SettingsPanel.instance = undefined;
    });

    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.disposed) return;
      const affected = SETTINGS_META.some(
        (m) => event.affectsConfiguration(`${m.section}.${m.key}`)
      );
      if (affected) {
        this.pushConfigUpdate();
      }
    });
  }

  public static open(scrollToCategory?: string): void {
    if (SettingsPanel.instance) {
      SettingsPanel.instance.panel.reveal();
      if (scrollToCategory) {
        SettingsPanel.instance.scrollTo(scrollToCategory);
      }
      return;
    }
    const inst = new SettingsPanel();
    SettingsPanel.instance = inst;
    if (scrollToCategory) {
      inst.pendingScrollTo = scrollToCategory;
    }
  }

  private render(): void {
    const nonce = randomBytes(16).toString("base64");
    const values = this.readAllValues();
    this.panel.webview.html = renderSettingsHtml(values, nonce);
    if (this.pendingScrollTo) {
      const cat = this.pendingScrollTo;
      this.pendingScrollTo = undefined;
      // Delay to allow webview to load
      setTimeout(() => this.scrollTo(cat), 100);
    }
  }

  private scrollTo(category: string): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "scrollTo", category });
  }

  private readAllValues(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const meta of SETTINGS_META) {
      const config = vscode.workspace.getConfiguration(meta.section);
      values[`${meta.section}.${meta.key}`] = config.get(meta.key);
    }
    return values;
  }

  private pushConfigUpdate(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: "configUpdated",
      values: this.readAllValues()
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "saveSetting": {
        const section = msg.section as string;
        const key = msg.key as string;
        const value = msg.value;
        const config = vscode.workspace.getConfiguration(section);
        await config.update(key, value, vscode.ConfigurationTarget.Global);
        break;
      }
      case "browse": {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Select Directory",
          openLabel: "Select Folder"
        });
        if (uris && uris.length > 0) {
          void this.panel.webview.postMessage({
            type: "browseResult",
            section: msg.section,
            key: msg.key,
            path: uris[0].fsPath
          });
        }
        break;
      }
      case "resetAll": {
        const confirm = await vscode.window.showWarningMessage(
          "Reset all Nexus settings to their defaults?",
          { modal: true },
          "Reset"
        );
        if (confirm === "Reset") {
          for (const meta of SETTINGS_META) {
            const config = vscode.workspace.getConfiguration(meta.section);
            await config.update(meta.key, undefined, vscode.ConfigurationTarget.Global);
          }
          this.render();
        }
        break;
      }
      case "openAppearance":
        void vscode.commands.executeCommand("nexus.terminal.appearance");
        break;
      case "openMacroEditor":
        void vscode.commands.executeCommand("nexus.macro.editor");
        break;
      case "openHighlightingJson":
        void vscode.commands.executeCommand("workbench.action.openSettingsJson", {
          revealSetting: { key: "nexus.terminal.highlighting.rules" }
        });
        break;
    }
  }
}
