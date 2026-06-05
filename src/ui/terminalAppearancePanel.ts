import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import { parseMobaXtermIni } from "../services/colorSchemeParser";
import { buildColorCustomizations, colorCustomizationsWriteValue } from "../services/colorSchemeApplier";
import { planFontWrites } from "../services/terminal/fontWritePlan";
import type { ColorSchemeService } from "../services/colorSchemeService";
import { renderTerminalAppearanceHtml } from "./terminalAppearanceHtml";

/** Terminal font settings the appearance panel reads/writes (global scope). */
const FONT_SETTING_KEYS = ["fontFamily", "fontSize", "fontWeight"] as const;

export class TerminalAppearancePanel {
  private static instance: TerminalAppearancePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly configListener: vscode.Disposable;
  private disposed = false;

  private constructor(private readonly service: ColorSchemeService) {
    this.panel = vscode.window.createWebviewPanel(
      "nexus.terminalAppearance",
      "Terminal Appearance",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.configListener.dispose();
      TerminalAppearancePanel.instance = undefined;
    });

    // Keep the panel's font inputs in sync with external configuration changes
    // (other window, Settings Sync, manual settings.json edit). Without this,
    // an Apply Font click would write the stale rendered DOM values back over
    // the external change.
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.disposed) return;
      const fontAffected = FONT_SETTING_KEYS.some((key) =>
        event.affectsConfiguration(`terminal.integrated.${key}`)
      );
      if (fontAffected) {
        this.pushFontUpdate();
      }
    });
  }

  public static open(service: ColorSchemeService): void {
    if (TerminalAppearancePanel.instance) {
      TerminalAppearancePanel.instance.panel.reveal();
      TerminalAppearancePanel.instance.render();
      return;
    }
    TerminalAppearancePanel.instance = new TerminalAppearancePanel(service);
  }

  private render(): void {
    const nonce = randomBytes(16).toString("base64");
    const fontConfig = this.service.getFontConfig() ?? this.readVsCodeFontConfig();
    this.panel.webview.html = renderTerminalAppearanceHtml(
      this.service.getAllSchemes(),
      this.service.getActiveSchemeId(),
      fontConfig,
      nonce
    );
  }

  private readVsCodeFontConfig(): TerminalFontConfig {
    const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
    return {
      family: termConfig.get<string>("fontFamily", ""),
      size: termConfig.get<number>("fontSize", 14),
      weight: termConfig.get<string>("fontWeight", "normal"),
    };
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "selectScheme":
        await this.applyScheme(msg.schemeId as string);
        break;
      case "importFile":
        await this.importFile();
        break;
      case "importDirectory":
        await this.importDirectory();
        break;
      case "deleteScheme":
        await this.deleteScheme(msg.schemeId as string);
        break;
      case "applyFont":
        await this.applyFont(msg as unknown as { family: string; size: number; weight: string });
        break;
    }
  }

  private async applyScheme(schemeId: string): Promise<void> {
    if (schemeId && !this.service.getSchemeById(schemeId)) {
      void vscode.window.showErrorMessage("Unknown terminal color scheme.");
      return;
    }
    await this.service.setActiveSchemeId(schemeId);
    const scheme = schemeId ? this.service.getSchemeById(schemeId) ?? null : null;
    const config = vscode.workspace.getConfiguration("workbench");
    // Read the GLOBAL-scope value only (read-scope == write-scope invariant).
    // `get()` returns the effective deep-merged value across default/global/
    // workspace/workspaceFolder scopes; merging that and writing it to Global
    // would permanently copy workspace-scoped color keys into global settings.
    const existing =
      config.inspect<Record<string, string>>("colorCustomizations")?.globalValue ?? {};
    const merged = buildColorCustomizations(existing, scheme);
    // Write `undefined` (key removal) when nothing is left, for a clean settings.json.
    const updated = colorCustomizationsWriteValue(merged);
    await config.update("colorCustomizations", updated, vscode.ConfigurationTarget.Global);
    this.pushUpdate();
  }

  private async importFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { "MobaXterm INI": ["ini"] },
      title: "Import Color Scheme (.ini)"
    });
    if (!uris || uris.length === 0) return;
    const schemes = this.parseIniFiles(uris.map((u) => u.fsPath));
    if (schemes.length > 0) {
      await this.service.addSchemes(schemes);
      this.pushUpdate();
      void vscode.window.showInformationMessage(`Imported ${schemes.length} color scheme(s).`);
    }
  }

  private async importDirectory(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Import Color Schemes from Directory"
    });
    if (!uris || uris.length === 0) return;
    const dir = uris[0].fsPath;
    const files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".ini"))
      .map((f) => path.join(dir, f));
    const schemes = this.parseIniFiles(files);
    if (schemes.length > 0) {
      await this.service.addSchemes(schemes);
      this.pushUpdate();
      void vscode.window.showInformationMessage(`Imported ${schemes.length} color scheme(s) from directory.`);
    } else {
      void vscode.window.showWarningMessage("No valid .ini color scheme files found in directory.");
    }
  }

  private parseIniFiles(filePaths: string[]): ColorScheme[] {
    const schemes: ColorScheme[] = [];
    for (const filePath of filePaths) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const name = path.basename(filePath, ".ini");
        const scheme = parseMobaXtermIni(content, name);
        if (scheme) {
          schemes.push(scheme);
        }
      } catch {
        // skip unreadable files
      }
    }
    return schemes;
  }

  private async deleteScheme(schemeId: string): Promise<void> {
    const scheme = this.service.getSchemeById(schemeId);
    if (!scheme || scheme.builtIn) return;
    const isActive = this.service.getActiveSchemeId() === schemeId;
    await this.service.removeScheme(schemeId);
    if (isActive) {
      await this.applyScheme("");
    }
    this.pushUpdate();
  }

  private async applyFont(msg: { family: string; size: number; weight: string }): Promise<void> {
    const allowedWeights = new Set(["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"]);
    const family = typeof msg.family === "string" ? msg.family.trim() : "";
    const size = typeof msg.size === "number" && Number.isFinite(msg.size) ? Math.floor(msg.size) : 0;
    const weight = typeof msg.weight === "string" ? msg.weight.trim() : "";
    if (family.length > 200 || size < 6 || size > 72 || (weight && !allowedWeights.has(weight))) {
      void vscode.window.showErrorMessage("Invalid terminal font settings.");
      return;
    }
    const config: TerminalFontConfig = {
      family,
      size,
      weight
    };
    await this.service.saveFontConfig(config);
    const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
    // Write only the fields whose value actually differs from what VS Code
    // currently resolves. If the DOM is stale (an external change happened
    // while the panel was open), re-writing every field would clobber that
    // change; planFontWrites suppresses no-op writes.
    const current = this.readVsCodeFontConfig();
    const writes = planFontWrites(current, config);
    for (const write of writes) {
      await termConfig.update(write.field, write.value, vscode.ConfigurationTarget.Global);
    }
    void vscode.window.showInformationMessage("Terminal font settings applied.");
  }

  private pushFontUpdate(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: "fontUpdated",
      font: this.readVsCodeFontConfig()
    });
  }

  private pushUpdate(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: "schemesUpdated",
      schemes: this.service.getAllSchemes(),
      activeId: this.service.getActiveSchemeId()
    });
  }
}
