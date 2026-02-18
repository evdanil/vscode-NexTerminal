import * as vscode from "vscode";
import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import type { ColorSchemeStorage } from "../services/colorSchemeService";

const SCHEMES_KEY = "nexus.colorSchemes";
const ACTIVE_SCHEME_KEY = "nexus.activeColorScheme";
const FONT_KEY = "nexus.terminalFont";

export class VscodeColorSchemeStorage implements ColorSchemeStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getUserSchemes(): ColorScheme[] {
    return this.context.globalState.get<ColorScheme[]>(SCHEMES_KEY, []);
  }

  async saveUserSchemes(schemes: ColorScheme[]): Promise<void> {
    await this.context.globalState.update(SCHEMES_KEY, schemes);
  }

  getActiveSchemeId(): string {
    return this.context.globalState.get<string>(ACTIVE_SCHEME_KEY, "");
  }

  async saveActiveSchemeId(id: string): Promise<void> {
    await this.context.globalState.update(ACTIVE_SCHEME_KEY, id);
  }

  getFontConfig(): TerminalFontConfig | undefined {
    return this.context.globalState.get<TerminalFontConfig>(FONT_KEY);
  }

  async saveFontConfig(config: TerminalFontConfig): Promise<void> {
    await this.context.globalState.update(FONT_KEY, config);
  }
}
