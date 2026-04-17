import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { renderSettingsHtml } from "./settingsHtml";
import { SETTINGS_META, CATEGORY_LABELS } from "./settingsMetadata";

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private pendingScrollTo: string | undefined;
  private currentCategory: string | undefined;
  private readonly configListener: vscode.Disposable;

  private constructor(category?: string) {
    this.currentCategory = category;
    this.panel = vscode.window.createWebviewPanel(
      "nexus.settings",
      this.buildTitle(category),
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

  private buildTitle(category?: string): string {
    if (!category) return "Nexus Settings";
    const label = CATEGORY_LABELS[category];
    return label ? `Nexus: ${label} Settings` : "Nexus Settings";
  }

  public static open(category?: string): void {
    if (SettingsPanel.instance) {
      const inst = SettingsPanel.instance;
      inst.panel.reveal();
      if (category && category !== inst.currentCategory) {
        inst.switchCategory(category);
      } else if (!category && inst.currentCategory) {
        inst.switchCategory(undefined);
      } else if (category && category === inst.currentCategory) {
        // Already showing this category, just reveal
      } else if (!category) {
        if (inst.pendingScrollTo) {
          inst.scrollTo(inst.pendingScrollTo);
        }
      }
      return;
    }
    const inst = new SettingsPanel(category);
    SettingsPanel.instance = inst;
    if (!category && inst.pendingScrollTo) {
      // Will be handled in render()
    }
  }

  private switchCategory(category: string | undefined): void {
    this.currentCategory = category;
    this.panel.title = this.buildTitle(category);
    this.render();
  }

  private render(): void {
    const nonce = randomBytes(16).toString("base64");
    const values = this.readAllValues();
    this.panel.webview.html = renderSettingsHtml(values, nonce, this.currentCategory);
    if (this.pendingScrollTo && !this.currentCategory) {
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

  /**
   * Turn whatever is currently in the setting's text field into a dialog seed.
   * Resolution order:
   *   1. Absolute path that currently exists as a directory → seed there.
   *   2. Relative path resolved against the first workspace folder, if that
   *      exists as a directory → seed there.
   *   3. First workspace folder as a bare fallback, if any.
   *   4. Undefined — VS Code picks (last-visited / home).
   * We intentionally don't seed at non-existent paths; showOpenDialog's
   * behaviour for missing defaultUri varies by platform.
   */
  private async resolveBrowseDefaultUri(current: string): Promise<vscode.Uri | undefined> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

    const tryCandidate = async (uri: vscode.Uri): Promise<vscode.Uri | undefined> => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        return stat.type === vscode.FileType.Directory ? uri : undefined;
      } catch {
        return undefined;
      }
    };

    if (current) {
      if (path.isAbsolute(current)) {
        const seed = await tryCandidate(vscode.Uri.file(current));
        if (seed) return seed;
      } else if (workspaceRoot) {
        const seed = await tryCandidate(vscode.Uri.joinPath(workspaceRoot, current));
        if (seed) return seed;
      }
    }

    return workspaceRoot;
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
        const defaultUri = await this.resolveBrowseDefaultUri(
          typeof msg.current === "string" ? msg.current.trim() : ""
        );
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri,
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
      case "resetCategory": {
        const category = msg.category as string;
        const categoryLabel = CATEGORY_LABELS[category] ?? category;
        const confirm = await vscode.window.showWarningMessage(
          `Reset all ${categoryLabel} settings to their defaults?`,
          { modal: true },
          "Reset"
        );
        if (confirm === "Reset") {
          const categoryMetas = SETTINGS_META.filter((m) => m.category === category);
          for (const meta of categoryMetas) {
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
      case "openHighlightRuleEditor":
        void vscode.commands.executeCommand("nexus.openHighlightRuleEditor");
        break;
      case "reloadWindow": {
        const action = await vscode.window.showInformationMessage(
          "This setting requires a window reload to take effect.",
          "Reload Window"
        );
        if (action === "Reload Window") {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
        break;
      }
      case "backup":
        await vscode.commands.executeCommand("nexus.config.export.backup");
        break;
      case "share":
        await vscode.commands.executeCommand("nexus.config.export");
        break;
      case "importConfig":
        await vscode.commands.executeCommand("nexus.config.import");
        this.render();
        break;
      case "completeReset":
        await vscode.commands.executeCommand("nexus.config.completeReset");
        this.render();
        break;
    }
  }
}
