import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { renderSettingsHtml } from "./settingsHtml";
import { SETTINGS_META, CATEGORY_LABELS } from "./settingsMetadata";
import { validateSettingUpdate } from "./settingsValidation";

/**
 * Pick a sensible `defaultUri` for `vscode.window.showOpenDialog` when the
 * user clicks Browse on a directory-type setting.
 *
 * `current` is the **webview DOM value** forwarded by the `browse` message,
 * not the persisted setting — debounced saves may not have flown yet when the
 * button is clicked. Seeding from the DOM matches what the user sees on screen.
 *
 * Resolution order — only existing directories seed the dialog; missing paths
 * would cause VS Code to pick an unpredictable fallback location, defeating
 * the purpose of seeding at all:
 *
 *   1. `current` is absolute and exists as a directory → seed there.
 *   2. `current` is relative, workspace is open, and `<workspace>/<current>`
 *      exists as a directory → seed there.
 *   3. `current` is relative, NO workspace, but `globalStoragePath` was
 *      injected, and `<globalStoragePath>/<current>` exists → seed there.
 *      This covers the Scripts Folder no-workspace case where scripts live
 *      under the extension's global storage.
 *   4. Workspace root, if any.
 *   5. `globalStoragePath` itself, if any (better than nothing in no-ws mode).
 *   6. Undefined — VS Code uses its own last-visited fallback.
 *
 * Exported purely so the four branches are testable in isolation; the
 * production method in `SettingsPanel` just wires up the real `stat` call.
 */
export async function resolveBrowseDefaultUri(
  current: string,
  workspaceRoot: vscode.Uri | undefined,
  globalStoragePath: string | undefined,
  isDirectory: (uri: vscode.Uri) => Promise<boolean>
): Promise<vscode.Uri | undefined> {
  if (current) {
    if (path.isAbsolute(current)) {
      const candidate = vscode.Uri.file(current);
      if (await isDirectory(candidate)) return candidate;
    } else if (workspaceRoot) {
      const candidate = vscode.Uri.joinPath(workspaceRoot, current);
      if (await isDirectory(candidate)) return candidate;
    } else if (globalStoragePath) {
      const candidate = vscode.Uri.file(path.join(globalStoragePath, current));
      if (await isDirectory(candidate)) return candidate;
    }
  }

  if (workspaceRoot) return workspaceRoot;
  if (globalStoragePath) return vscode.Uri.file(globalStoragePath);
  return undefined;
}

async function isExistingDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;
  private static globalStoragePath: string | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private pendingScrollTo: string | undefined;
  private currentCategory: string | undefined;
  private readonly configListener: vscode.Disposable;

  /**
   * Called once at extension activation so `resolveBrowseDefaultUri` can seed
   * the folder dialog at the extension's global storage when no workspace is
   * open (relevant for settings like `nexus.scripts.path`). Static-injection
   * rather than constructor-threading avoids widening the singleton's public
   * `open()` surface for a purely environmental dependency.
   */
  public static setGlobalStoragePath(storagePath: string): void {
    SettingsPanel.globalStoragePath = storagePath;
  }

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


  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "saveSetting": {
        const validation = validateSettingUpdate(msg.section, msg.key, msg.value);
        if (!validation.ok) {
          void this.panel.webview.postMessage({
            type: "saveResult",
            section: msg.section,
            key: msg.key,
            ok: false,
            message: validation.message
          });
          break;
        }
        try {
          const config = vscode.workspace.getConfiguration(validation.meta.section);
          await config.update(validation.meta.key, validation.value, vscode.ConfigurationTarget.Global);
          void this.panel.webview.postMessage({
            type: "saveResult",
            section: validation.meta.section,
            key: validation.meta.key,
            ok: true
          });
        } catch {
          void this.panel.webview.postMessage({
            type: "saveResult",
            section: validation.meta.section,
            key: validation.meta.key,
            ok: false,
            message: "Could not save this setting."
          });
        }
        break;
      }
      case "browse": {
        const defaultUri = await resolveBrowseDefaultUri(
          typeof msg.current === "string" ? msg.current.trim() : "",
          vscode.workspace.workspaceFolders?.[0]?.uri,
          SettingsPanel.globalStoragePath,
          isExistingDirectory
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
      case "openAllSettings":
        this.switchCategory(undefined);
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
