import type { TerminalMacro } from "../../src/models/terminalMacro";
import type { MacroStore, MacroStoreChangeListener } from "../../src/storage/macroStore";

/**
 * A `MacroStore` that persists exactly what it is handed — no id re-keying, no
 * ingest guards.
 *
 * It exists because `InMemoryMacroStore` deliberately mirrors the store WRITE
 * path, where `assignUniqueMacroIds()` re-keys duplicates, so it cannot express
 * the one state these tests are about: a macro list where two records share an
 * `id`. That state is real and reachable — `VscodeMacroStore.reloadFromState()`
 * reads a hand-edited backup or absorbed legacy settings verbatim and
 * deliberately does NOT repair duplicate ids (deciding which twin owns the
 * single vault entry behind a shared id is unanswerable; see
 * `MacroStore.save()`'s doc comment). Everything that acts on a macro therefore
 * has to cope with it, and this store is how a test can put the code in front
 * of it.
 *
 * It also leaves ids alone across `save()`, which keeps assertions legible: a
 * re-keying store would answer "which twin was written?" with two fresh UUIDs.
 */
export class DuplicateIdMacroStore implements MacroStore {
  private macros: TerminalMacro[] = [];
  private folders: string[] = [];
  private readonly listeners = new Set<MacroStoreChangeListener>();

  /** Seeds the store without going through `save()`, mirroring a load from disk. */
  public constructor(initial: TerminalMacro[] = []) {
    this.macros = initial.map((m) => ({ ...m }));
  }

  public async initialize(): Promise<void> {
    // no-op
  }

  public getAll(): TerminalMacro[] {
    return this.macros.map((m) => ({ ...m }));
  }

  public async save(macros: TerminalMacro[]): Promise<void> {
    this.macros = macros.map((m) => ({ ...m }));
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
    this.folders = [...folders];
    for (const listener of this.listeners) listener();
  }
}
