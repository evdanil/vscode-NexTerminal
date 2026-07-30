import { randomUUID } from "node:crypto";
import type { TerminalMacro } from "../models/terminalMacro";
import type { MacroStore, MacroStoreChangeListener } from "./macroStore";

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
    // Mirrors VscodeMacroStore.save(): unique, non-empty ids are a MacroStore
    // invariant that MacroAutoTrigger's `macroStateKey()` relies on (two macros
    // with equal `id` are indistinguishable for pause/resume/interval state). An
    // explicit empty-string id is treated as missing, and a later duplicate is
    // reassigned a fresh id.
    const seenIds = new Set<string>();
    this.macros = macros.map((m) => {
      let id = m.id && m.id.length > 0 ? m.id : randomUUID();
      while (seenIds.has(id)) id = randomUUID();
      seenIds.add(id);
      return { ...m, id };
    });
    for (const listener of this.listeners) listener();
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
