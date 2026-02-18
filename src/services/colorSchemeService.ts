import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import { BUILTIN_SCHEMES } from "./builtinSchemes";

export interface ColorSchemeStorage {
  getUserSchemes(): ColorScheme[];
  saveUserSchemes(schemes: ColorScheme[]): Promise<void>;
  getActiveSchemeId(): string;
  saveActiveSchemeId(id: string): Promise<void>;
  getFontConfig(): TerminalFontConfig | undefined;
  saveFontConfig(config: TerminalFontConfig): Promise<void>;
}

export class InMemoryColorSchemeStorage implements ColorSchemeStorage {
  constructor(
    private schemes: ColorScheme[] = [],
    private activeId: string = "",
    private font?: TerminalFontConfig
  ) {}

  getUserSchemes(): ColorScheme[] { return [...this.schemes]; }
  async saveUserSchemes(schemes: ColorScheme[]): Promise<void> { this.schemes = [...schemes]; }
  getActiveSchemeId(): string { return this.activeId; }
  async saveActiveSchemeId(id: string): Promise<void> { this.activeId = id; }
  getFontConfig(): TerminalFontConfig | undefined { return this.font; }
  async saveFontConfig(config: TerminalFontConfig): Promise<void> { this.font = config; }
}

export class ColorSchemeService {
  private userSchemes: ColorScheme[];
  private activeId: string;
  private fontConfig: TerminalFontConfig | undefined;

  constructor(private readonly storage: ColorSchemeStorage) {
    this.userSchemes = storage.getUserSchemes();
    this.activeId = storage.getActiveSchemeId();
    this.fontConfig = storage.getFontConfig();
  }

  getAllSchemes(): ColorScheme[] {
    return [...BUILTIN_SCHEMES, ...this.userSchemes];
  }

  getActiveSchemeId(): string {
    return this.activeId;
  }

  async setActiveSchemeId(id: string): Promise<void> {
    this.activeId = id;
    await this.storage.saveActiveSchemeId(id);
  }

  getSchemeById(id: string): ColorScheme | undefined {
    return this.getAllSchemes().find((s) => s.id === id);
  }

  async addSchemes(schemes: ColorScheme[]): Promise<void> {
    this.userSchemes.push(...schemes);
    await this.storage.saveUserSchemes(this.userSchemes);
  }

  async removeScheme(id: string): Promise<void> {
    const idx = this.userSchemes.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this.userSchemes.splice(idx, 1);
    await this.storage.saveUserSchemes(this.userSchemes);
    if (this.activeId === id) {
      await this.setActiveSchemeId("");
    }
  }

  getFontConfig(): TerminalFontConfig | undefined {
    return this.fontConfig;
  }

  async saveFontConfig(config: TerminalFontConfig): Promise<void> {
    this.fontConfig = config;
    await this.storage.saveFontConfig(config);
  }
}
