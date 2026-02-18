import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import { parseMobaXtermIni } from "../services/colorSchemeParser";
import { buildColorCustomizations } from "../services/colorSchemeApplier";
import type { ColorSchemeService } from "../services/colorSchemeService";
import { renderTerminalAppearanceHtml } from "./terminalAppearanceHtml";

export class TerminalAppearancePanel {
  private static instance: TerminalAppearancePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
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
      TerminalAppearancePanel.instance = undefined;
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
    await this.service.setActiveSchemeId(schemeId);
    const scheme = schemeId ? this.service.getSchemeById(schemeId) ?? null : null;
    const config = vscode.workspace.getConfiguration("workbench");
    const existing = config.get<Record<string, string>>("colorCustomizations", {});
    const updated = buildColorCustomizations(existing, scheme);
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
    const config: TerminalFontConfig = {
      family: msg.family,
      size: msg.size,
      weight: msg.weight
    };
    await this.service.saveFontConfig(config);
    const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
    if (config.family) {
      await termConfig.update("fontFamily", config.family, vscode.ConfigurationTarget.Global);
    }
    if (config.size > 0) {
      await termConfig.update("fontSize", config.size, vscode.ConfigurationTarget.Global);
    }
    if (config.weight) {
      await termConfig.update("fontWeight", config.weight, vscode.ConfigurationTarget.Global);
    }
    void vscode.window.showInformationMessage("Terminal font settings applied.");
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
