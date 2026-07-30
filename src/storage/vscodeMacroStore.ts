import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { TerminalMacro } from "../models/terminalMacro";
import {
  assignIdsForAbsorbedMacros,
  assignMacroIds,
  canonicalMacroBinding,
  canonicalMacroSecret,
  canonicalMacroTriggerTerms,
  canonicalMacroVariableTerms,
  isValidMacroId,
  withMigratedSlot,
  type MacroStore,
  type MacroStoreChangeListener
} from "./macroStore";
import { withRedactedVariables } from "../services/macroVariables";

const MACROS_KEY = "nexus.macros";
const SECRET_PREFIX = "macro-secret-text-";

/**
 * `globalState.get(key, [])` returns the default only when the key is ABSENT.
 * A corrupt non-array value (object/string/null from a Settings Sync conflict or
 * storage corruption) would otherwise be iterated directly and throw during
 * `initialize()`. Degrade any non-array shape to an empty list.
 */
function asArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

export interface VscodeMacroStoreOptions {
  /** If false, skip the one-time legacy-settings absorption (used by tests). Default: true. */
  runLegacyMigration?: boolean;
}

export function macroSecretKey(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}

export class VscodeMacroStore implements MacroStore {
  private resolved: TerminalMacro[] = [];
  /**
   * Ids of secret macros whose vault entry `reloadFromState()` could NOT read —
   * `secrets.get()` resolved `undefined`. That is the same answer the API gives for "no
   * entry" and for "the OS keyring is unavailable" (a known Linux transient; it resolves
   * `undefined` rather than rejecting), so the two cannot be told apart at the call site.
   * Both resolve to `text: ""` in memory, and `save()` uses this set twice: to refuse to
   * write that empty string back over whatever is really in the vault, AND to refuse to
   * re-key the macro away from the entry it cannot carry (`cannotCarrySecret()`). Either
   * half alone is insufficient — see `save()`.
   *
   * Keyed by the id as READ from globalState, which is the id the vault entry is filed
   * under. Any lookup in this set must therefore use `MacroIdAssignment.priorId`, never a
   * post-dedup `macro.id`.
   */
  private unresolvedSecretIds = new Set<string>();
  /**
   * Tail of the serialization chain for this store's MUTATING operations — see
   * `runExclusive()`.
   */
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<MacroStoreChangeListener>();
  private readonly runMigration: boolean;
  private _lastAbsorbedCount = 0;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    options: VscodeMacroStoreOptions = {}
  ) {
    this.runMigration = options.runLegacyMigration ?? true;
  }

  public async initialize(): Promise<void> {
    this._lastAbsorbedCount = 0;
    if (this.runMigration) {
      await this.absorbLegacySettingsIfPresent();
    }
    await this.reloadFromState();
  }

  /**
   * Returns the count of macros absorbed from legacy settings during the most recent
   * `initialize()` call. Resets to 0 at the start of each `initialize()`.
   */
  public getLastAbsorbedCount(): number {
    return this._lastAbsorbedCount;
  }

  public getAll(): TerminalMacro[] {
    return this.resolved.map((m) => ({ ...m }));
  }

  public async save(macros: TerminalMacro[]): Promise<void> {
    await this.runExclusive(() => this.write(macros));
  }

  /**
   * Runs `op` with no other mutating operation of THIS store in flight.
   *
   * `save()`, `replaceAll()` and `clearAll()` each interleave several `await`s over two
   * separate storage media (`globalState` and `SecretStorage`), and their write orders are
   * only a crash contract while they run one at a time. They do not: every one of them is a
   * user-initiated VS Code command, `SecretStorage` calls can block for seconds behind an OS
   * keychain unlock prompt, and nothing stops the user from running Complete Reset while a
   * macro save is sitting on that prompt. Interleaved, `clearAll()`'s vault deletes can land
   * between `save()`'s stores and its `MACROS_KEY` commit, publishing `secret: true` records
   * with no values behind them — the same torn state the cross-window race produces, but from
   * a single window and entirely within this file's reach.
   *
   * So it is fixed here, and only here. This is a WITHIN-WINDOW lock and makes no claim
   * beyond that: it does not serialize two VS Code windows against each other, because
   * `globalState` and `SecretStorage` expose no cross-process lock and no compare-and-swap.
   * See `write()`'s cross-window note for what is and is not guaranteed there.
   *
   * `this.tail` is only ever settled by the `release()` below, never rejected, so a failing
   * operation does not poison the chain for the next caller — it propagates to ITS caller and
   * the queue moves on.
   *
   * `initialize()` is deliberately NOT wrapped. It runs exactly once, from `activate()`, and is
   * awaited there before any command that could reach this store is registered, so there is
   * nothing for it to interleave with. Wrapping it would suggest a concurrency it does not
   * have. If a second caller of `initialize()` ever appears, it belongs in here too.
   */
  private async runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await op();
    } finally {
      release();
    }
  }

  /**
   * See `MacroStore.replaceAll()`. The whole implementation is the `id: undefined` below, and
   * that is deliberate: everything downstream already treats a record with no usable id as a
   * record this store has never seen, so stripping the ids is enough to make every
   * "what do I already know about this record?" question answer "nothing" — truthfully, for
   * records that arrived from a file.
   *
   * Concretely, after the strip: `assignMacroIds()` reports `priorId: undefined` for every
   * record, so `readFailed` is false, `cannotCarrySecret()` returns false at its
   * `isValidMacroId(macro.id)` term, `lastKnown` cannot match a freshly minted UUID, and every
   * id currently held falls into `currentIds` minus `nextIds` and has its vault entry deleted.
   * No branch of `write()` can be reached in a state where an incoming record is treated as
   * the continuation of a stored one, because no incoming record claims to be one.
   *
   * Non-object entries pass through untouched rather than being spread into a phantom
   * `{ id: undefined }` record — same rule as `assignIdsForAbsorbedMacros()`.
   */
  public async replaceAll(macros: TerminalMacro[]): Promise<void> {
    const stripped = macros.map((m) => (m && typeof m === "object" ? { ...m, id: undefined } : m));
    await this.runExclusive(() => this.write(stripped));
  }

  private async write(macros: TerminalMacro[]): Promise<void> {
    // Sanitizing here rather than at each consumer makes this the chokepoint: every
    // write to globalState goes through `save()`, so a masked variable's plaintext
    // `default` can never be persisted regardless of which caller supplied it.
    //
    // Unique, non-empty, STRING ids are enforced in this same chokepoint: nothing
    // upstream guarantees it (a record can arrive from a hand-edited backup, from
    // legacy settings absorption, or from globalState written by a build that predates
    // the invariant — see configCommands.ts), and MacroAutoTrigger's
    // `macroStateKey()` treats any two macros with equal `id` as the SAME macro for
    // pause/resume, interval ownership and cooldown state. `assignMacroIds()`
    // (macroStore.ts; `InMemoryMacroStore.save()` uses the same implementation via the
    // `assignUniqueMacroIds()` wrapper) treats an empty string AND any non-string value
    // (e.g. `{length: 1}` from a corrupt import — a plain `.length` check would be fooled
    // by that) as missing, matching `macroStateKey()`'s own guard. Dedup runs BEFORE the
    // vault read/write loop below, which keys every vault entry by the final `m.id` — so by
    // the time that loop runs, ids are already unique and no secret macro's vault entry can
    // be overwritten or cross-read by another macro that happened to share its id.
    //
    // Re-keying is safe HERE, and only here, because this is a write path: every caller is
    // a user-initiated command (macro add/edit/remove/reorder, the macro editor panel,
    // config import) and none of them runs at activation — the read path
    // `reloadFromState()` deliberately leaves stored ids alone. Keeping it that way is a
    // requirement on callers, not a happy accident; `MacroStore.save()`'s doc comment
    // records the activation-time caller that used to exist and why it was removed.
    //
    // It is loss-free for a duplicated secret whose vault value was actually READ at load:
    // that value sits in `m.text`, and the store loop below writes it back under the fresh
    // key before any delete runs.
    //
    // A value that could NOT be read cannot be carried anywhere, so such a record is not
    // moved either: `cannotCarrySecret()` pins it to the id its (unreadable) vault entry is
    // filed under, and the twins that merely collide with it are re-keyed instead. Refusing
    // only the WRITE, as an earlier revision did, was not enough — the re-keyed secret ended
    // up filed under a fresh id with nothing behind it while the non-secret twin kept the old
    // id and its `else` branch below deleted the entry that held the only copy of the
    // password. One transient keyring failure plus any save at all (a rename, a reorder, a
    // shortcut) was sufficient. See `unresolvedSecretIds` and the write-order block below.
    //
    // Awarding a stored vault entry to an incoming record is an ownership decision, and it is
    // sound only under `MacroStore.save()`'s precondition: an incoming record carrying a
    // currently-held id IS the record held under it. That precondition is a property of the
    // ENTRY POINT, not of the data — `public save()` above is the one that asserts it, and
    // `public replaceAll()` is the one that cannot, so `replaceAll()` strips every incoming id
    // before reaching here. That is the only reason `cannotCarrySecret()` may be consulted at
    // all; there is no state in which this function sees an externally-supplied id.
    //
    // Legacy `slot` is normalized here as well as on the read path, so a restored slot-era
    // backup (configCommands.ts hands `save()` the file's records verbatim) converges to
    // `keybinding` on disk instead of only in memory.
    const assignments = assignMacroIds(macros, {
      keepIdIfPossible: (m) => this.cannotCarrySecret(m)
    });
    const normalized: TerminalMacro[] = assignments.map(({ macro }) =>
      withRedactedVariables(withMigratedSlot(macro))
    );

    const currentIds = new Set(this.resolved.map((m) => m.id).filter((v): v is string => Boolean(v)));
    const nextIds = new Set(normalized.map((m) => m.id!).filter(Boolean));

    const vaultStores: Array<{ id: string; value: string }> = [];
    const vaultDeletes: string[] = [];

    // Plan first, write second. Nothing below this loop touches storage, so the ordering
    // of the awaits that follow is stated in one place rather than emerging from where
    // each case happens to sit in the loop.
    const onDisk: TerminalMacro[] = [];
    for (let i = 0; i < normalized.length; i++) {
      const m = normalized[i];
      const id = m.id!;
      // The id this record ARRIVED with, and therefore the id any vault entry of its own is
      // filed under. Every question of the form "what do I already know about this record's
      // secret?" must be asked with THIS id, never with `m.id`: for a re-keyed record `m.id`
      // is a UUID minted moments ago that no vault entry and no failed read can ever have
      // been recorded against, so asking with it answers "nothing known" for precisely the
      // records the store knows least about. That mistake is what let a keyring outage
      // destroy a password; see the `assignMacroIds()` call above.
      const priorId = assignments[i].priorId;
      const readFailed = priorId !== undefined && this.unresolvedSecretIds.has(priorId);
      if (m.secret) {
        // A secret resolving to "" whose vault read failed is NOT a cleared secret, it is
        // an unknown one. `SecretStorage.get()` cannot distinguish a keyring outage from a
        // missing entry, so writing the empty string back would silently destroy every
        // password on the machine on the next save of any kind. Skipping the write is
        // exactly right in the outage case and a no-op in the missing-entry case (the
        // record still says `secret: true`, so it resolves to "" again next load). The
        // cost is stated in MacroStore.save()'s doc: an unreadable secret also cannot be
        // deliberately cleared until the keyring answers again.
        //
        // Almost every such record kept its id (`cannotCarrySecret()` pinned it), so this
        // guard is normally asking about the very entry it is protecting. The one record
        // that reaches here re-keyed is the loser of a collision between TWO unreadable
        // secrets sharing one stored id: the winner keeps the id and the entry, and the
        // loser must not leave an empty entry behind under its fresh id.
        //
        // THAT IS THE ONLY SKIP. Every other secret whose value this window HOLDS is written
        // on every save, including one whose value has not changed since this window loaded
        // it — the same bytes, back to the same key. Two earlier revisions tried to elide
        // that write, and both were wrong in the same way, so the reasoning is recorded here
        // rather than rediscovered a third time:
        //
        //   - Eliding it is not a local no-op, because the key is shared with every other VS
        //     Code window. If another window deleted the macro (or ran Complete Reset) since
        //     this one loaded, the MACROS_KEY write below republishes the record as
        //     `secret: true` while nothing puts a value back — an empty secret at the next
        //     load, reported to nobody, which is neither window's user's intent.
        //   - Reading the key back first and restoring it only when it has GONE does not fix
        //     that. There is no compare-and-swap over `SecretStorage`, so the read and the
        //     MACROS_KEY commit are separated by every remaining `await` in this function: a
        //     delete landing in that gap produces exactly the torn record the read was meant
        //     to prevent, and another window's store landing in it is destroyed by the
        //     restore. A check that can be invalidated before the write it guards is not a
        //     guard, and adding a second one after it just moves the gap.
        //
        // So the write is unconditional and the cost is taken openly: a stale window's save
        // puts its own copy of a secret back over a newer value another window wrote. That is
        // the SAME wholesale last-writer-wins the MACROS_KEY write below already has for
        // every non-secret field — name, trigger, keybinding, order — so a save publishes this
        // window's whole view of a macro instead of a mixture of its own view and another
        // window's. `MacroStore.save()` states it as a documented limit, and the docs and
        // CHANGELOG say the same thing in user terms.
        if (m.text === "" && readFailed) {
          // Nothing to write: this window never learned what is behind the key, so it has no
          // value to put there. Stated as a cost in MacroStore.save()'s doc comment.
        } else {
          vaultStores.push({ id, value: m.text });
        }
        onDisk.push({ ...m, text: "" });
      } else {
        // If this macro was previously secret, clean its vault entry.
        //
        // This delete is INCIDENTAL — it fires for every non-secret macro on every save,
        // including macros that have never been secret — so it must not be reachable by an
        // entry whose contents this call does not know. It is not: the only key it can name
        // is this record's own, and an unreadable secret colliding with this record on a
        // stored id has taken that id back (`cannotCarrySecret()`), leaving this record on a
        // fresh UUID and this delete a no-op. The one case where the collision does NOT take
        // the id back is a secret the user has just given a new value, and then the entry
        // being deleted is the superseded old value of that same macro — exactly what a
        // healthy keyring would delete on the same edit.
        //
        // Deletes that DO destroy a known value are the user's own: removing a macro (the
        // `currentIds`-minus-`nextIds` loop below) or turning a secret one into a plain one.
        // Those are identical with a healthy keyring and with a broken one, so an outage
        // cannot be what caused them.
        vaultDeletes.push(id);
        onDisk.push({ ...m });
      }
    }
    for (const oldId of currentIds) {
      if (!nextIds.has(oldId)) vaultDeletes.push(oldId);
    }

    // Write order is STORE → MACROS_KEY → DELETE, and it is the reverse of the obvious one.
    //
    // 1. STORE, then write MACROS_KEY. A crash between them leaves a vault entry no macro
    //    record names, which `clearAll()` sweeps by enumerating `SecretStorage` itself
    //    (`readVaultSecretIds()`). Nothing has to be NAMED anywhere first for that to work,
    //    which is why the marker files and the `nexus.macros.secretIds` ledger that used to
    //    run ahead of this loop are gone: both existed only to give the sweep a list of keys
    //    to try, both were cross-window read-modify-writes that could lose an id, and the
    //    host now answers the same question directly and exactly.
    // 2. DELETE only after MACROS_KEY is the record of truth. The deletes are what destroy
    //    data, so they run last and never before the store that may be carrying the same
    //    value to a new key: with `[non-secret(id X), secret(id X)]` and a vault that
    //    ANSWERED at load, the secret is re-keyed to a fresh Y while X stays with the
    //    non-secret twin, and X's entry — the only durable copy of the secret's value — must
    //    not be deleted until Y holds it.
    //
    //    Ordering alone does not cover the same shape when the vault did NOT answer, because
    //    then no store carries the value anywhere and there is nothing for the delete to run
    //    after. That case is handled before this point, by not re-keying: the secret keeps X
    //    and the non-secret twin takes the fresh id, so X is in `nextIds`, no branch names it
    //    for deletion, and the macro that needs the entry is still the one filed under it.
    //
    // What this order does NOT give: any guarantee against another VS Code WINDOW. A delete
    // landing between a `secrets.store()` here and the MACROS_KEY commit below still leaves a
    // record naming an entry that is gone. Nothing at this layer closes that — `globalState`
    // and `SecretStorage` have neither a compare-and-swap nor a shared lock — and no
    // arrangement of these same awaits makes the gap disappear, so it is stated rather than
    // papered over. Within ONE window the gap does not exist at all, because `runExclusive()`
    // keeps `clearAll()` and a concurrent save from interleaving with it.
    for (const { id, value } of vaultStores) {
      await this.context.secrets.store(macroSecretKey(id), value);
      this.unresolvedSecretIds.delete(id);
    }
    await this.context.globalState.update(MACROS_KEY, onDisk);
    for (const id of vaultDeletes) {
      await this.context.secrets.delete(macroSecretKey(id));
      this.unresolvedSecretIds.delete(id);
    }
    this.resolved = normalized;
    this.emit();
  }

  /**
   * True when this record is a secret whose vault value this store could not read, so the
   * value cannot travel with it. `save()` passes this to `assignMacroIds()` as
   * `keepIdIfPossible`: such a record keeps the id its entry is filed under and any macro
   * that merely collides with it on that id is re-keyed instead.
   *
   * Keyed on the id the record ARRIVED with, which is what `unresolvedSecretIds` is keyed on
   * (`reloadFromState()` records the id it read, i.e. the stored one). The `text === ""` term
   * matters: a user who has typed a NEW value for an unreadable secret is carrying a value
   * after all, so that record re-keys normally and the new value is written under the new id.
   *
   * This IS an ownership decision, and an earlier revision of this comment wrongly claimed it
   * was not. Awarding `macro-secret-text-<id>` to whichever record is holding that id at save
   * time decides who gets the value once the keyring answers again. What makes it sound is not
   * the shape of the record but where the record came from: under `MacroStore.save()`'s
   * precondition the claimant IS the store's own record, carried forward by the caller, so the
   * award changes nothing about who owns what.
   *
   * That precondition is not expressed in any type — `TerminalMacro` is `TerminalMacro`
   * wherever it was parsed from — so it is not relied on as one. It is guaranteed by the entry
   * points: `save()` is reached only from callers mutating `getAll()` (or appending records
   * with provably-unknown ids), and every wholesale-external list goes through `replaceAll()`,
   * which strips ids so that `isValidMacroId(macro.id)` below is false for all of them. An
   * incoming record that is NOT the store's own record therefore never reaches this predicate
   * in a state where it could answer `true`.
   */
  private cannotCarrySecret(macro: TerminalMacro): boolean {
    if (!macro || typeof macro !== "object") return false;
    return (
      Boolean(macro.secret) &&
      macro.text === "" &&
      isValidMacroId(macro.id) &&
      this.unresolvedSecretIds.has(macro.id)
    );
  }

  public onDidChange(listener: MacroStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clearAll(): Promise<void> {
    await this.runExclusive(() => this.clearAllExclusive());
  }

  private async clearAllExclusive(): Promise<void> {
    // Snapshot ids before wiping state — once globalState is cleared, `this.resolved`
    // is authoritative and will not survive a reload.
    const ids = this.resolved.map((m) => m.id).filter((v): v is string => Boolean(v));

    // Clear MACROS_KEY first so stale entries don't show as broken macros after crash.
    await this.context.globalState.update(MACROS_KEY, undefined);
    this.resolved = [];
    this.unresolvedSecretIds = new Set<string>();

    // Sweep the union of what this window knows about and what the HOST itself reports, so
    // orphans `resolved` no longer accounts for still go. The second half is the whole of the
    // guarantee: `readVaultSecretIds()` asks the storage that actually holds the values which
    // of this extension's keys exist, so it finds entries no macro record names — an entry a
    // crash left behind between a `secrets.store()` and its MACROS_KEY commit, one a stale
    // save in a second window re-created after this one deleted it, and anything a build
    // predating any of this wrote.
    //
    // It replaced two name-based records that used to run alongside it — a per-secret-id
    // marker file under `globalStorageUri` and the `nexus.macros.secretIds` array in
    // `globalState`. Both existed for one reason: `SecretStorage` had no enumeration API, so a
    // sweep could only delete keys something already named, and the extension had to keep its
    // own list. Both were cross-window read-modify-writes over shared state and both could
    // therefore lose an id — which is a stranded plaintext credential in the OS keyring — and
    // no ordering of writes fixed that, because the write that UNNAMES an entry happens after
    // the writes that name it. Enumeration has no such race: it is not a record of what was
    // written, it is a question asked of the thing that holds it. Neither record is read or
    // written any more; see the release notes for what an upgrading profile is left holding.
    //
    // `this.resolved` is kept in the union because it is free and it is what still answers on
    // a host whose `keys()` rejects (a locked keyring), where `readVaultSecretIds()` degrades
    // to the empty set rather than failing the reset.
    const enumeratedIds = await this.readVaultSecretIds();

    // Delete vault entries AFTER MACROS_KEY is cleared, so a crash between these awaits leaves
    // entries that the next clearAll enumerates again rather than records pointing at values
    // that are already gone.
    const allIds = new Set([...ids, ...enumeratedIds]);
    for (const id of allIds) {
      await this.context.secrets.delete(macroSecretKey(id));
    }

    this.emit();
  }

  /**
   * Every macro-secret id the HOST itself can name, from `SecretStorage.keys()`.
   *
   * The one source in `clearAllExclusive()` that does not depend on some earlier write having
   * survived: it asks the storage that actually holds the values which of this extension's keys
   * exist. `keys()` is documented as "the keys of all the secrets stored by this extension" with
   * no qualification by vintage — the per-extension namespacing of secret keys is unchanged, so
   * an entry written by an older build is enumerated exactly like one written today. That makes
   * it a strict superset of anything a name-based ledger could have offered, which is why the
   * ledger is gone rather than kept as a fallback: every id it could still name either has a
   * live entry (enumerated) or does not (a no-op delete).
   *
   * Unconditional, since `engines.vscode` is `^1.105.0` and the API was finalized in 1.105.
   *
   * Filtered to `macro-secret-text-` and nothing else: the same `SecretStorage` holds server
   * passwords, key passphrases, proxy credentials and auth-profile secrets, and Complete Reset
   * of the MACRO store must not touch any of them. Best-effort throughout — a rejection or a
   * non-array answer degrades to "nothing extra to sweep" rather than failing a reset that has
   * vault entries of its own to delete.
   */
  private async readVaultSecretIds(): Promise<Set<string>> {
    const out = new Set<string>();
    let keys: unknown;
    try {
      keys = await this.context.secrets.keys();
    } catch {
      return out;
    }
    if (!Array.isArray(keys)) return out;
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(SECRET_PREFIX)) continue;
      const id = key.slice(SECRET_PREFIX.length);
      if (isValidMacroId(id)) out.add(id);
    }
    return out;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Pure read. Two things it deliberately does NOT do:
   *
   * 1. Repair ids. A duplicate `id` already sitting in globalState is preserved exactly
   *    as found, in memory and on disk. Deciding which of two macros sharing an id owns
   *    the single vault entry at `macroSecretKey(id)` is unanswerable — pre-invariant
   *    duplicate secret saves were last-write-wins — and every award heuristic tried in
   *    review leaked one macro's password to another, destroyed the only copy of a
   *    legitimate secret, or re-derived identity from array position. Duplicates are
   *    handled fail-safe at the use site instead (`findAmbiguousMacroStateKeys()`,
   *    services/macroAutoTrigger.ts): an ambiguous macro compiles no auto-trigger rule
   *    and cannot fire. `save()` is what re-keys them, when the user next saves.
   * 2. Write to the vault. Not a `store`, not a `delete`. Reads only. That is what makes
   *    the eventual `save()` re-key loss-free: a duplicated secret's value is resolved
   *    into `text` here, so writing it back under a fresh key preserves it — as far as
   *    the read got. A read that returned `undefined` is recorded in
   *    `unresolvedSecretIds` instead, because "" would otherwise be indistinguishable
   *    from a real empty secret at save time; `save()` then declines to re-key that macro
   *    at all, since a value it could not read is a value it cannot carry to a new key.
   *
   * What it DOES normalize is `slot` → `keybinding` (`withMigratedSlot()`, macroStore.ts),
   * in memory only. That is a pure per-record field rename with no bearing on identity or
   * on the vault, and doing it here is what removes the last activation-time `save()` from
   * the extension — see `MacroStore.save()`'s doc comment for why that mattered.
   *
   * An entry with no usable id still gets a runtime-only UUID so the rest of the app can
   * key off `macro.id`; that UUID is never persisted (the scrub below rewrites `raw`, not
   * `resolved`).
   *
   * This path writes nothing at all unless it found a masked variable's plaintext default to
   * scrub. It used to also grow the `nexus.macros.secretIds` ledger on every activation; that
   * ledger is gone, and with it the last unconditional write on the load path.
   */
  private async reloadFromState(): Promise<void> {
    const raw = asArray<TerminalMacro>(this.context.globalState.get(MACROS_KEY, []));

    const resolved: TerminalMacro[] = [];
    // Tracks whether any on-disk record still carried a masked variable's plaintext
    // default, so it can be scrubbed rather than merely hidden from `getAll()`.
    let needsDiskScrub = false;
    const unresolvedSecretIds = new Set<string>();

    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;

      const id = isValidMacroId(entry.id) ? entry.id : randomUUID();

      // Redacted on the way in as well as on the way out (`save()`), so a record
      // already sitting in globalState from an earlier build cannot leak a masked
      // variable's plaintext default into `getAll()` — and therefore into Copy All,
      // share export, or an encrypted backup's cleartext `macros` array.
      const redacted = withRedactedVariables(entry);
      if (redacted !== entry) needsDiskScrub = true;
      // `withMigratedSlot` is applied to the RESOLVED copy only; `raw` (and therefore the
      // scrub below, and `absorbLegacySettingsIfPresent()`'s `keyOfLegacy()` dedupe, which
      // reads globalState directly) keeps seeing the record exactly as stored.
      const migrated = withMigratedSlot(redacted);
      if (entry.secret) {
        const vaulted = await this.context.secrets.get(macroSecretKey(id));
        if (vaulted === undefined) unresolvedSecretIds.add(id);
        resolved.push({ ...migrated, id, text: vaulted ?? "" });
      } else {
        resolved.push({ ...migrated, id });
      }
    }
    this.resolved = resolved;
    this.unresolvedSecretIds = unresolvedSecretIds;

    // Redacting only the in-memory copy would leave the plaintext sitting in VS Code's
    // global-state storage indefinitely: nothing rewrites MACROS_KEY until the user
    // happens to save a macro. Rewrite it now.
    //
    // Two constraints on how:
    //
    // 1. Scrub the RAW array, minimally. Serializing `resolved` instead would persist
    //    this reload's incidental repairs — dropped non-object records, runtime-only
    //    UUIDs — turning a redaction into a rewrite of records that were never the
    //    problem.
    // 2. Only write if MACROS_KEY still holds what we read. globalState is shared
    //    across windows, and there is an `await` on the vault between the read and
    //    this write: another window can save, absorb legacy settings, or complete a
    //    reset in that gap, and an unconditional write would silently overwrite it —
    //    resurrecting macros the user just deleted. VS Code offers no
    //    compare-and-swap, so this is best-effort: re-read and skip if it moved.
    //    Skipping is safe, since the next `save()` redacts anyway.
    if (needsDiskScrub) {
      const current = this.context.globalState.get(MACROS_KEY);
      if (JSON.stringify(current) === JSON.stringify(raw)) {
        const scrubbed = raw.map((entry) =>
          entry && typeof entry === "object" ? withRedactedVariables(entry) : entry
        );
        await this.context.globalState.update(MACROS_KEY, scrubbed);
      }
    }
  }

  /**
   * On every activation, absorb any `nexus.terminal.macros` present in VS Code settings
   * (global / workspace / workspaceFolder) into the store, splitting secret text into the
   * vault, then clear the legacy setting from every scope.
   *
   * Naturally idempotent: dedupe by name|text|triggerPattern|keybinding, so a second run
   * with the same values adds nothing. Handles Settings Sync replay — if the old setting
   * syncs back with new entries, they get absorbed on next activation.
   *
   * Why: pre-migration, secret macros stored their `text` in cleartext in settings.json.
   */
  private async absorbLegacySettingsIfPresent(): Promise<void> {
    const config = vscode.workspace.getConfiguration("nexus.terminal");
    const inspect = config.inspect<TerminalMacro[]>("macros");
    if (!inspect) return;

    const collected: TerminalMacro[] = [];
    const scopesToClear: vscode.ConfigurationTarget[] = [];

    if (Array.isArray(inspect.globalValue) && inspect.globalValue.length > 0) {
      collected.push(...inspect.globalValue);
      scopesToClear.push(vscode.ConfigurationTarget.Global);
    }
    if (Array.isArray(inspect.workspaceValue) && inspect.workspaceValue.length > 0) {
      collected.push(...inspect.workspaceValue);
      scopesToClear.push(vscode.ConfigurationTarget.Workspace);
    }
    if (Array.isArray(inspect.workspaceFolderValue) && inspect.workspaceFolderValue.length > 0) {
      collected.push(...inspect.workspaceFolderValue);
      scopesToClear.push(vscode.ConfigurationTarget.WorkspaceFolder);
    }

    if (collected.length === 0) return; // Nothing to absorb

    // A hand-edited settings.json can put a `null` (or any non-object) in the array;
    // the shape checks above only validate the ARRAY. Such an entry is not a macro, so
    // it is dropped rather than absorbed — and dropping it here is what keeps
    // `keyOfLegacy()` from throwing during `initialize()`, which would fail activation.
    const usable = collected.filter((m): m is TerminalMacro => !!m && typeof m === "object");

    const deduped = dedupeLegacyMacros(usable);
    const existing = asArray<TerminalMacro>(this.context.globalState.get(MACROS_KEY, []));
    // `existing` may legitimately contain non-object records (see reloadFromState's
    // own guard and the `Fix D` scrub test); they can never match an absorbed macro's
    // content key, so they are excluded from the dedupe set rather than crashing it.
    const existingKeys = new Set(
      existing.filter((m): m is TerminalMacro => !!m && typeof m === "object").map(keyOfLegacy)
    );
    const toAdd = deduped.filter((m) => !existingKeys.has(keyOfLegacy(m)));
    if (toAdd.length > 0) {
      // Provenance is kept explicit rather than merged into one array: the two halves
      // have different id rules — see `assignIdsForAbsorbedMacros()`.
      const persisted = await this.persistLegacyMigration(existing, toAdd);
      if (!persisted) {
        // The absorbed records did not land — another window moved MACROS_KEY while we were
        // writing to the vault. Leave `nexus.terminal.macros` in settings exactly where it
        // is: clearing it now would be the only remaining copy of those macros disappearing.
        // Absorption is content-keyed and idempotent, so the next activation simply retries
        // against whatever it finds.
        return;
      }
      this._lastAbsorbedCount += toAdd.length;
    }

    for (const target of scopesToClear) {
      try {
        await config.update("macros", undefined, target);
      } catch {
        // Scope unavailable (e.g. no workspace open) — ignore.
      }
    }
  }

  /**
   * @param existingOnDisk records already persisted in MACROS_KEY — ids IMMUTABLE.
   * @param absorbed records lifted out of `nexus.terminal.macros` in settings.json.
   *
   * The split is the whole point; see `assignIdsForAbsorbedMacros()` for why. In short:
   * this routine runs at EVERY activation, so re-keying an already-persisted record
   * here would silently orphan its vault entry at startup (its on-disk `text` is `""`,
   * so the store branch below never re-writes the value under the new key). An absorbed
   * record, by contrast, carries its secret as settings.json cleartext and has no vault
   * entry, so re-keying a collision costs nothing and prevents its
   * `secrets.store(macroSecretKey(id), ...)` from overwriting an existing macro's secret.
   *
   * Variables are normalized here rather than only at read time: this path absorbs
   * `nexus.terminal.macros` verbatim on every activation (Settings Sync replay
   * included), so without it a hand-written masked variable carrying a plaintext
   * `default` would be written straight into globalState.
   *
   * @returns `false` when the records did not land, because another window moved MACROS_KEY
   * while this one was awaiting the vault. The caller must then leave the legacy setting in
   * place so the absorb can be retried, rather than clearing the only other
   * copy of those macros. Legacy `slot` is NOT normalized here: the records are written
   * as absorbed, and `reloadFromState()` (which runs immediately after) migrates the copy
   * the app sees. Rewriting the field on this path would desynchronize `keyOfLegacy()`,
   * which keys dedupe off the raw on-disk `keybinding`.
   */
  private async persistLegacyMigration(
    existingOnDisk: readonly TerminalMacro[],
    absorbed: readonly TerminalMacro[]
  ): Promise<boolean> {
    const keyed = assignIdsForAbsorbedMacros(existingOnDisk, absorbed);
    const assigned = [...keyed.existing, ...keyed.absorbed].map((m) =>
      m && typeof m === "object" ? withRedactedVariables(m) : m
    );

    const vaultStores: Array<{ id: string; value: string }> = [];
    const onDisk: TerminalMacro[] = [];
    for (const m of assigned) {
      // Non-object records already in MACROS_KEY are passed through verbatim rather
      // than spread into a phantom `{ id }` macro — this rewrite must not invent
      // records, only add the absorbed ones.
      if (!m || typeof m !== "object") {
        onDisk.push(m);
        continue;
      }
      if (m.secret && typeof m.text === "string" && m.text.length > 0) {
        vaultStores.push({ id: m.id!, value: m.text });
        onDisk.push({ ...m, text: "" });
      } else {
        onDisk.push({ ...m });
      }
    }

    // Same write-order contract as `save()`: STORE, then MACROS_KEY. A crash between them
    // leaves a vault entry no macro record names, which Complete Reset finds by enumerating
    // `SecretStorage` (`readVaultSecretIds()`) rather than by consulting a list this path had
    // to remember to write. Nothing is deleted from the vault here.
    for (const { id, value } of vaultStores) {
      await this.context.secrets.store(macroSecretKey(id), value);
    }

    // The same re-read-and-compare guard `reloadFromState()` documents, and for the same
    // reason: globalState is shared across windows and the `secrets.store()` awaits above
    // are a window in which another one can save, absorb, or complete a reset. Absorption
    // runs on EVERY activation, so "two windows starting with legacy settings present" and
    // "one starting while the user deletes a macro in the other" are ordinary, not exotic.
    // An unconditional write here resurrects deleted macros or drops the other window's.
    // VS Code offers no compare-and-swap, so this is best-effort; both sides go through
    // `asArray` so an absent key compares equal to the `[]` the caller read, and two
    // different corrupt non-array values both degrade to `[]` (they were unusable either
    // way — `reloadFromState()` would have shown no macros at all).
    const current = asArray<TerminalMacro>(this.context.globalState.get(MACROS_KEY, []));
    if (JSON.stringify(current) !== JSON.stringify(existingOnDisk)) return false;
    await this.context.globalState.update(MACROS_KEY, onDisk);
    return true;
  }
}

/**
 * Dedupe key for LEGACY SETTINGS ABSORPTION only. It is NOT `keyOf()` (configCommands.ts) and
 * cannot be, but the two now share their canonicalization (`canonicalMacro*Terms()`,
 * macroStore.ts) so that the one rule both must obey — runtime-indistinguishable records key
 * the same, runtime-distinguishable records do not — has a single implementation.
 *
 * They answer different questions and have opposite failure directions. `keyOf()` decides
 * whether an IMPORTED record is dropped, so a key that is too coarse silently discards a
 * legitimate macro. This one decides whether a record already written to MACROS_KEY is absorbed
 * from settings.json AGAIN, on every activation and on every Settings Sync replay, so a key
 * that is too specific duplicates a macro on every start.
 *
 * THE ONLY THING THAT MAY BE OMITTED IS WHAT THE REDACTION BOUNDARY DESTROYS.
 * `persistLegacyMigration()` runs the absorbed record through `withRedactedVariables()` before
 * persisting, so a field that survives in settings.json but not on disk would make the two
 * copies never match and multiply the macro indefinitely. Exactly two things are in that
 * category, and they are handled rather than dropped from the key:
 *
 *   - a secret macro's `text` — cleartext in settings.json, `""` on disk once the value moves
 *     to the vault — which keys as the fixed `"__SECRET__"`;
 *   - a MASKED variable's `default`/`remember`, which `canonicalMacroVariableTerms()` reports
 *     only for non-masked variables (see its doc comment).
 *
 * That is the whole of the exemption. An earlier revision generalized it into "leave the
 * trigger configuration out", which is not what the boundary requires and cost real macros:
 * two legacy records differing only in `triggerCooldown: 5` versus `30`, or `slot: 1` versus
 * `slot: 2`, collapsed in `dedupeLegacyMacros()` BEFORE persistence — and then
 * `absorbLegacySettingsIfPresent()` cleared `nexus.terminal.macros` from every scope, so the
 * loser was gone for good. Nothing survives an absorb that the key cannot tell apart, which is
 * why every non-redacted content field is named here.
 *
 * Assembled with `JSON.stringify` rather than a `|` join, for the reason `keyOf()` gives: with
 * a join, a macro named `a|b` with text `c` keys identically to one named `a` with text `b|c`,
 * and a hand-written settings.json is exactly where such a name comes from.
 */
function keyOfLegacy(m: TerminalMacro): string {
  const textKey = m.secret ? "__SECRET__" : (m.text ?? "");
  return JSON.stringify([
    m.name ?? "",
    canonicalMacroSecret(m),
    textKey,
    ...canonicalMacroTriggerTerms(m),
    // The EFFECTIVE binding, so a legacy `slot` participates. `persistLegacyMigration()`
    // deliberately writes absorbed records with their `slot` intact, and `save()` writes
    // migrated ones with a `keybinding`, so keying the raw field made the same macro look
    // different depending on which path last wrote it — while `slot: 1` and `slot: 2` looked
    // identical. Both sides of the comparison go through the same helper, so the migration
    // itself cannot desynchronize them.
    canonicalMacroBinding(m),
    canonicalMacroVariableTerms(m)
  ]);
}

/** Dedupe legacy macros on `keyOfLegacy()`. First occurrence wins. */
function dedupeLegacyMacros(macros: TerminalMacro[]): TerminalMacro[] {
  const seen = new Set<string>();
  const out: TerminalMacro[] = [];
  for (const m of macros) {
    const key = keyOfLegacy(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
