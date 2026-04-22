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
    this.macros = macros.map((m) => ({
      ...m,
      id: m.id ?? randomUUID()
    }));
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
