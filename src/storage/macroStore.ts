import type { TerminalMacro } from "../models/terminalMacro";

export interface MacroStoreChangeListener {
  (): void;
}

export interface MacroStore {
  /** One-time async initialization: loads persisted macros and (for Vscode impl) performs legacy migration. */
  initialize(): Promise<void>;
  /** Synchronous read of the resolved in-memory list. Secret text is included. */
  getAll(): TerminalMacro[];
  /** Persists the given list. Splits secret text into the vault; writes non-secret fields to state. */
  save(macros: TerminalMacro[]): Promise<void>;
  /** Subscribe to changes. Returns a disposer. */
  onDidChange(listener: MacroStoreChangeListener): () => void;
  /** Clear all state (macros + vault entries). Used by completeReset. */
  clearAll(): Promise<void>;
}
