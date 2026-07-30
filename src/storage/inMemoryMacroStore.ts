import type { TerminalMacro } from "../models/terminalMacro";
import {
  assignUniqueMacroIds,
  withMigratedSlot,
  type MacroStore,
  type MacroStoreChangeListener
} from "./macroStore";
import { dropNonPathGroup, sanitizeMacroFolderList } from "../services/macroFolders";

/**
 * Fix 1 — mirrors `VscodeMacroStore`'s `isUsableMacro()`: a macro is not
 * usable without a string `name` and a string `text`; anything else (e.g. a
 * caller writing through a stale/out-of-bounds index) is dropped here rather
 * than persisted, so a malformed record can never reach the tree.
 */
function isUsableMacro(m: TerminalMacro): boolean {
  return !!m && typeof m === "object" && typeof m.name === "string" && typeof m.text === "string";
}

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
    // Fix 1 — unusable records are dropped BEFORE ids are assigned, so a fresh UUID is
    // never spent on a record that is about to be discarded.
    //
    // `group` gets the same ingest GUARD VscodeMacroStore applies — the two MacroStore
    // implementations must not have different ingest contracts for the same untrusted
    // field (§4.2). Note it is a guard, not the folder-path grammar: a string group is
    // preserved exactly as given and sanitized only at read sites, so a `save()`
    // triggered by an unrelated edit can never delete another macro's stored folder
    // assignment.
    this.macros = assignUniqueMacroIds(macros.filter(isUsableMacro)).map((m) =>
      dropNonPathGroup(withMigratedSlot(m))
    );
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
