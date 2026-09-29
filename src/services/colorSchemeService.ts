import type { ColorScheme, TerminalFontConfig } from "../models/colorScheme";
import { BUILTIN_SCHEMES } from "./builtinSchemes";

export interface ColorSchemeStorage {
  getUserSchemes(): ColorScheme[];
  saveUserSchemes(schemes: ColorScheme[]): Promise<void>;
  getActiveSchemeId(): string;
  saveActiveSchemeId(id: string): Promise<void>;
  getFontConfig(): TerminalFontConfig | undefined;
  saveFontConfig(config: TerminalFontConfig): Promise<void>;
  /** Forget every user scheme, the active selection and the font choice. */
  clearAll(): Promise<void>;
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
  async clearAll(): Promise<void> { this.schemes = []; this.activeId = ""; this.font = undefined; }
}

export class ColorSchemeService {
  private userSchemes: ColorScheme[];
  private activeId: string;
  private fontConfig: TerminalFontConfig | undefined;
  /**
   * Every mutation — and `reset()` — runs on this one chain, so a Terminal
   * Appearance action taken while Delete All Data is awaiting its storage updates
   * cannot interleave with them: it either finishes before the reset and is
   * cleared by it, or runs after it, against the empty store. NEW WRITERS MUST
   * ENLIST via `runExclusive`, and must not call another enlisted method from
   * inside it (that would wait on itself); use the private `*Unlocked` helpers.
   */
  private chain: Promise<unknown> = Promise.resolve();

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /**
   * `resetGuard` (optional) notices a Delete All Data run in another window: the
   * cached copies below are then dropped and reloaded from storage before they
   * can be read or written back (see `storage/resetGeneration.ts`).
   */
  constructor(
    private readonly storage: ColorSchemeStorage,
    private readonly resetGuard?: { consumeIfChanged(): boolean }
  ) {
    this.userSchemes = storage.getUserSchemes();
    this.activeId = storage.getActiveSchemeId();
    this.fontConfig = storage.getFontConfig();
  }

  /**
   * Residual race (see `storage/resetGeneration.ts`): this covers an action that
   * starts after the reset is visible to this window. A save already in flight
   * when another window resets, or one that starts before the new generation
   * reaches this window, can still commit; there is no compare-and-swap on
   * `globalState` to prevent it, and reloading the window clears it.
   */
  private syncAfterReset(): void {
    if (this.resetGuard?.consumeIfChanged()) {
      this.userSchemes = [...this.storage.getUserSchemes()];
      this.activeId = this.storage.getActiveSchemeId();
      this.fontConfig = this.storage.getFontConfig();
    }
  }

  getAllSchemes(): ColorScheme[] {
    this.syncAfterReset();
    return [...BUILTIN_SCHEMES, ...this.userSchemes];
  }

  getActiveSchemeId(): string {
    this.syncAfterReset();
    return this.activeId;
  }

  setActiveSchemeId(id: string): Promise<void> {
    return this.runExclusive(() => this.setActiveSchemeIdUnlocked(id));
  }

  private async setActiveSchemeIdUnlocked(id: string): Promise<void> {
    this.syncAfterReset();
    this.activeId = id;
    await this.storage.saveActiveSchemeId(id);
  }

  getSchemeById(id: string): ColorScheme | undefined {
    return this.getAllSchemes().find((s) => s.id === id);
  }

  addSchemes(schemes: ColorScheme[]): Promise<void> {
    return this.runExclusive(async () => {
      this.syncAfterReset();
      this.userSchemes.push(...schemes);
      await this.storage.saveUserSchemes(this.userSchemes);
    });
  }

  removeScheme(id: string): Promise<void> {
    return this.runExclusive(async () => {
      this.syncAfterReset();
      const idx = this.userSchemes.findIndex((s) => s.id === id);
      if (idx === -1) return;
      this.userSchemes.splice(idx, 1);
      await this.storage.saveUserSchemes(this.userSchemes);
      if (this.activeId === id) {
        await this.setActiveSchemeIdUnlocked("");
      }
    });
  }

  getFontConfig(): TerminalFontConfig | undefined {
    this.syncAfterReset();
    return this.fontConfig;
  }

  saveFontConfig(config: TerminalFontConfig): Promise<void> {
    return this.runExclusive(async () => {
      this.syncAfterReset();
      this.fontConfig = config;
      await this.storage.saveFontConfig(config);
    });
  }

  /** Delete All Data: drop the user schemes, the selection and the font choice, in memory and in storage. */
  reset(): Promise<void> {
    return this.runExclusive(async () => {
      this.userSchemes = [];
      this.activeId = "";
      this.fontConfig = undefined;
      await this.storage.clearAll();
    });
  }
}
