import type { TerminalMacro } from "../models/terminalMacro";
import {
  assignUniqueMacroIds,
  withMigratedSlot,
  type MacroStore,
  type MacroStoreChangeListener
} from "./macroStore";

export class InMemoryMacroStore implements MacroStore {
  private macros: TerminalMacro[] = [];
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

  /**
   * Mirrors `VscodeMacroStore.replaceAll()`: an id in an external file is not an identity in
   * this store, so every incoming record is re-keyed before it lands. There is no vault here
   * for a stale id to mis-claim, but the two implementations must agree on what callers
   * OBSERVE — a test or the web-host fallback that saw ids survive a replace-mode import here
   * would be documenting behaviour the production store does not have.
   */
  public async replaceAll(macros: TerminalMacro[]): Promise<void> {
    await this.save(
      macros.map((m) => (m && typeof m === "object" ? { ...m, id: undefined } : m))
    );
  }

  public onDidChange(listener: MacroStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clearAll(): Promise<void> {
    this.macros = [];
    for (const listener of this.listeners) listener();
  }
}
