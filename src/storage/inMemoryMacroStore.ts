import type { TerminalMacro } from "../models/terminalMacro";
import {
  assignUniqueMacroIds,
  withMigratedSlot,
  type MacroStore,
  type MacroStoreChangeListener
} from "./macroStore";
import { sanitizeMacroFolderList } from "../services/macroFolders";

export class InMemoryMacroStore implements MacroStore {
  private macros: TerminalMacro[] = [];
  private folders: string[] = [];
  private readonly listeners = new Set<MacroStoreChangeListener>();

  public async initialize(): Promise<void> {
    // no-op for in-memory
  }

  public getAll(): TerminalMacro[] {
    return this.macros.map((m) => ({ ...m }));
  }

  public async save(macros: TerminalMacro[]): Promise<void> {
    // Mirrors VscodeMacroStore.save(): unique, non-empty, STRING ids are a MacroStore
    // invariant that MacroAutoTrigger's `macroStateKey()` relies on (two macros
    // with equal `id` are indistinguishable for pause/resume/interval state).
    // `assignUniqueMacroIds()` is the single implementation shared with
    // VscodeMacroStore.save() — see its doc comment in macroStore.ts.
    // Also mirrors the legacy `slot` → `keybinding` normalization VscodeMacroStore does,
    // so tests and the web-host fallback see the same macro shape the production store
    // hands out. See `withMigratedSlot()` in macroStore.ts.
    this.macros = assignUniqueMacroIds(macros).map((m) => withMigratedSlot(m));
    for (const listener of this.listeners) listener();
  }

  public onDidChange(listener: MacroStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clearAll(): Promise<void> {
    this.macros = [];
    this.folders = [];
    for (const listener of this.listeners) listener();
  }

  public getFolders(): string[] {
    return [...this.folders];
  }

  public async saveFolders(folders: string[]): Promise<void> {
    this.folders = sanitizeMacroFolderList(folders);
    for (const listener of this.listeners) listener();
  }
}
