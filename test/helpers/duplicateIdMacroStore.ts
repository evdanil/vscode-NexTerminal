import type { TerminalMacro } from "../../src/models/terminalMacro";
import { assignUniqueMacroIds, type MacroStore, type MacroStoreChangeListener } from "../../src/storage/macroStore";

/**
 * A `MacroStore` whose LOADED state can contain two macros sharing an `id` —
 * and whose `save()` re-keys them exactly as production does.
 *
 * It exists because `InMemoryMacroStore` can only ever be populated through
 * `save()`, and `save()` is where `assignUniqueMacroIds()` repairs duplicates,
 * so it cannot express the one state these tests are about: a macro list where
 * two records share an `id`. That state is real and reachable —
 * `VscodeMacroStore.reloadFromState()` reads a hand-edited backup or absorbed
 * legacy settings verbatim and deliberately does NOT repair duplicate ids
 * (deciding which twin owns the single vault entry behind a shared id is
 * unanswerable; see `MacroStore.save()`'s doc comment). Everything that acts on
 * a macro therefore has to cope with it, and this store is how a test can put
 * the code in front of it.
 *
 * **That is a property of the initial state, not of `save()`.** An earlier
 * version of this double also preserved duplicate ids across `save()`, on the
 * grounds that it kept assertions legible (a re-keying store answers "which twin
 * was written?" with a fresh UUID). It bought that legibility by simulating a
 * store that cannot exist: BOTH production implementations re-key on every
 * write. The concurrent-write tests here are specifically about what happens
 * when a save lands mid-dialog, so the one detail the double got wrong was the
 * one detail under test — a reference captured while its id was shared, then
 * re-keyed by that save, resolved to the wrong twin in production.
 *
 * State that accurately, because it is easy to overstate. Deleting the
 * `assignUniqueMacroIds()` call below does NOT leave the suite green: measured
 * against `test/unit` as it stands, it fails 10 tests — the 6 `seedThree`
 * command cases in `macroCommandsIdentity.test.ts`, 3 drag-and-drop cases in
 * `macroTreeProvider.test.ts`, and 1 Macro Editor render-witness case. Those
 * tests were written in response to this hole and detect it directly. What the
 * old double bought was that none of the tests written ALONGSIDE it failed —
 * it invalidated its own contemporaries, which is the whole argument for
 * keeping a concurrency double byte-faithful to production `save()`, and a
 * strictly weaker claim than "every test passes".
 */
export class DuplicateIdMacroStore implements MacroStore {
  private macros: TerminalMacro[] = [];
  private folders: string[] = [];
  private readonly listeners = new Set<MacroStoreChangeListener>();

  /**
   * Seeds the store without going through `save()`, mirroring a load from disk
   * — the only way a duplicate-id list gets in here, and the only thing about
   * this double that differs from `InMemoryMacroStore`.
   */
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
    // The SAME `assignUniqueMacroIds()` `InMemoryMacroStore` calls, not a
    // re-implementation: a contested id is awarded in array order, so the first
    // holder keeps it and every later twin gets a fresh UUID.
    //
    // That last sentence is a property of THIS wrapper, not of saving. Desktop
    // persistence goes through `assignMacroIds(…, { keepIdIfPossible })`, which
    // can award the id to a later twin — a secret whose vault value could not be
    // read is pinned to the entry it arrived with, and an EARLIER twin is the one
    // re-keyed. What both share, and all these tests turn on, is the part that
    // does not vary: after any write the id has exactly ONE holder. Assertions
    // below that name a specific surviving twin are reading this wrapper's order,
    // and say so where they do. See the class doc comment.
    this.macros = assignUniqueMacroIds(macros).map((m) => ({ ...m }));
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
