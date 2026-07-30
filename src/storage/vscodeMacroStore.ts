import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { TerminalMacro } from "../models/terminalMacro";
import {
  assignIdsForAbsorbedMacros,
  assignMacroIds,
  isValidMacroId,
  withMigratedSlot,
  type MacroStore,
  type MacroStoreChangeListener
} from "./macroStore";
import { withRedactedVariables } from "../services/macroVariables";

const MACROS_KEY = "nexus.macros";
const SECRET_IDS_KEY = "nexus.macros.secretIds";
const SECRET_PREFIX = "macro-secret-text-";
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

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
    // Sanitizing here rather than at each consumer makes this the chokepoint: every
    // write to globalState goes through `save()`, so a masked variable's plaintext
    // `default` can never be persisted regardless of which caller supplied it.
    //
    // Unique, non-empty, STRING ids are enforced in this same chokepoint: nothing
    // upstream guarantees it (a replace-mode backup import saves whatever ids the
    // file contains verbatim — see configCommands.ts), and MacroAutoTrigger's
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

    // Every vault key this call deletes, so the secret-id ledger can drop it (see
    // `updateSecretIndex()`); anything not deleted stays indexed even if it is not in
    // this macro set, because its vault entry is still there.
    const deletedVaultIds = new Set<string>();
    const storedVaultIds = new Set<string>();
    const vaultStores: Array<{ id: string; value: string }> = [];
    const vaultDeletes: string[] = [];

    // What this store believes is ALREADY in the vault under each id, from the load (or the
    // last save) that produced `this.resolved`. Used to skip writes that cannot change
    // anything locally — see the cross-window note on `lastKnownVaultText()`.
    const lastKnown = this.lastKnownVaultText();

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
        // Named in the ledger whether or not the store below actually runs: the entry may
        // already exist and merely be unreadable, and the ledger's one job is to name
        // vault keys `clearAll()` must sweep.
        storedVaultIds.add(id);
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
        const unchanged = priorId === id && typeof m.text === "string" && lastKnown.get(id) === m.text;
        if (!(m.text === "" && readFailed) && !unchanged) {
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
        deletedVaultIds.add(id);
        onDisk.push({ ...m });
      }
    }
    for (const oldId of currentIds) {
      if (!nextIds.has(oldId)) {
        vaultDeletes.push(oldId);
        deletedVaultIds.add(oldId);
      }
    }

    // Write order is the crash contract, and it is the reverse of the obvious one.
    //
    // 1. GROW the ledger before any `secrets.store()`. A vault entry written under an id
    //    that neither MACROS_KEY nor the ledger names yet is unreachable forever — not by
    //    a later save, not by Complete Reset. Naming it first can only over-name: a
    //    ledger id with no entry behind it costs one no-op `secrets.delete()`.
    // 2. STORE, then write MACROS_KEY. A crash between them leaves a ledger-named orphan,
    //    which `clearAll()` sweeps.
    // 3. DELETE, and shrink the ledger, only after MACROS_KEY is the record of truth. The
    //    deletes are what destroy data, so they run last and never before the store that
    //    may be carrying the same value to a new key: with `[non-secret(id X),
    //    secret(id X)]` and a vault that ANSWERED at load, the secret is re-keyed to a fresh
    //    Y while X stays with the non-secret twin, and X's entry — the only durable copy of
    //    the secret's value — must not be deleted until Y holds it.
    //
    //    Ordering alone does not cover the same shape when the vault did NOT answer, because
    //    then no store carries the value anywhere and there is nothing for the delete to run
    //    after. That case is handled before this point, by not re-keying: the secret keeps X
    //    and the non-secret twin takes the fresh id, so X is in `nextIds`, no branch names it
    //    for deletion, and the macro that needs the entry is still the one filed under it.
    //
    // `storedVaultIds` and `deletedVaultIds` are disjoint by construction (ids are unique
    // after dedup, each macro takes exactly one branch, and a removed id is not in
    // `nextIds`), so the grow and the shrink cannot fight over the same id.
    await this.updateSecretIndex(storedVaultIds, EMPTY_ID_SET);
    for (const { id, value } of vaultStores) {
      await this.context.secrets.store(macroSecretKey(id), value);
      this.unresolvedSecretIds.delete(id);
    }
    await this.context.globalState.update(MACROS_KEY, onDisk);
    for (const id of vaultDeletes) {
      await this.context.secrets.delete(macroSecretKey(id));
      this.unresolvedSecretIds.delete(id);
    }
    await this.updateSecretIndex(EMPTY_ID_SET, deletedVaultIds);
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
   * This is NOT an ownership heuristic of the kind `reloadFromState()` refuses to make. It
   * decides nothing about who the value belongs to — the read already handed the same value
   * (or the same failure) to every record sharing the id. It only refuses to MOVE a record
   * away from side storage this call is unable to move with it.
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

  /**
   * The vault values this store last OBSERVED, by id: secrets that were read successfully at
   * load (or written by this window's own `save()`), excluding any id `this.resolved` holds
   * more than once — for a duplicated id there is no single record whose `text` describes
   * what is behind the key.
   *
   * `save()` skips a `secrets.store()` whose value equals this and whose id did not change.
   * Locally that is provably a no-op: the store would write the same bytes to the same key.
   * Across windows it is the difference between keeping and destroying a password. globalState
   * and the vault are shared, both windows hold a snapshot from whenever they last loaded, and
   * VS Code offers no compare-and-swap. Window A changes a secret to "new" and saves. Window B,
   * still holding "old", reorders an unrelated macro. Rewriting every resolved secret on every
   * save made B's reorder put "old" back over A's "new" — a value B's user never typed and
   * never saw. Writing only what B's user actually changed leaves A's value standing.
   *
   * What this deliberately does NOT do, and why there is no re-read guard on `save()` the way
   * there is on `persistLegacyMigration()` and the `reloadFromState()` scrub:
   *
   *   - It does not make `save()` atomic across windows. B's MACROS_KEY write still lands
   *     wholesale, so B can still revert A's edits to NON-secret fields (name, trigger,
   *     keybinding, order). That is the generic globalState race; it predates this store and
   *     is not fixable without a compare-and-swap primitive VS Code does not expose.
   *   - It is not extended into "re-read MACROS_KEY and abandon the save if it moved". The two
   *     places that DO re-read are best-effort repairs nobody asked for — a redaction scrub and
   *     a legacy absorption — where skipping costs nothing and the next save redoes it. `save()`
   *     is the opposite: every caller is a user-initiated command, and silently discarding a
   *     macro the user just wrote, with the UI reporting success, trades a rare cross-window
   *     revert for routine unexplained data loss. Losing an edit you can see is worse than
   *     losing one you cannot.
   *
   * The narrow, non-destructive half of the protection is therefore taken and the destructive
   * half is declined, on purpose.
   */
  private lastKnownVaultText(): Map<string, string> {
    const occurrences = new Map<string, number>();
    for (const m of this.resolved) {
      if (isValidMacroId(m.id)) occurrences.set(m.id, (occurrences.get(m.id) ?? 0) + 1);
    }
    const known = new Map<string, string>();
    for (const m of this.resolved) {
      if (!isValidMacroId(m.id) || occurrences.get(m.id) !== 1) continue;
      if (!m.secret || typeof m.text !== "string") continue;
      // An id whose read failed describes nothing: `text` is the "" the failure produced,
      // not the entry's contents. Leaving it out keeps the skip above from mistaking that
      // "" for a match — the read-failure guard in `save()` handles those records instead.
      if (this.unresolvedSecretIds.has(m.id)) continue;
      known.set(m.id, m.text);
    }
    return known;
  }

  public onDidChange(listener: MacroStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clearAll(): Promise<void> {
    // Snapshot ids before wiping state — once globalState is cleared, `this.resolved`
    // is authoritative and will not survive a reload.
    const ids = this.resolved.map((m) => m.id).filter((v): v is string => Boolean(v));

    // Clear MACROS_KEY first so stale entries don't show as broken macros after crash.
    await this.context.globalState.update(MACROS_KEY, undefined);
    this.resolved = [];
    this.unresolvedSecretIds = new Set<string>();

    // Also read the persisted index to sweep orphaned vault entries `resolved` no longer
    // accounts for. This covers every entry either writer in this file can leave behind,
    // because both name an id in the ledger BEFORE storing it (see `save()`'s write-order
    // contract and `persistLegacyMigration()`): a crash anywhere after the ledger grows
    // leaves the entry named. It does not cover an entry written by a build that predates
    // that ordering, or one whose ledger write itself was lost.
    const indexedIds = this.readSecretIndex();

    // Delete vault entries FIRST (before clearing the index) so a crash between
    // these two awaits leaves the index intact — next clearAll can still find orphans.
    const allIds = new Set([...ids, ...indexedIds]);
    for (const id of allIds) {
      await this.context.secrets.delete(macroSecretKey(id));
    }
    await this.context.globalState.update(SECRET_IDS_KEY, undefined);

    this.emit();
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
   * `resolved`) and never enters the secret-id index.
   */
  private async reloadFromState(): Promise<void> {
    const raw = asArray<TerminalMacro>(this.context.globalState.get(MACROS_KEY, []));

    const resolved: TerminalMacro[] = [];
    // Tracks whether any on-disk record still carried a masked variable's plaintext
    // default, so it can be scrubbed rather than merely hidden from `getAll()`.
    let needsDiskScrub = false;
    // Secret ids as they exist ON DISK. The runtime-only UUID minted below for an
    // id-less record has no vault entry behind it, so indexing it would describe a key
    // that cannot exist — the index's one job is to name vault entries `clearAll()`
    // must sweep.
    const persistedSecretIds = new Set<string>();
    const unresolvedSecretIds = new Set<string>();

    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;

      const persistedId = isValidMacroId(entry.id) ? entry.id : undefined;
      const id = persistedId ?? randomUUID();
      if (persistedId !== undefined && entry.secret) persistedSecretIds.add(persistedId);

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

    await this.updateSecretIndex(persistedSecretIds, EMPTY_ID_SET);
  }

  /**
   * The secret-id index is a ledger of vault keys this store may have written, kept so
   * `clearAll()` can sweep entries `this.resolved` no longer accounts for. It is
   * therefore a UNION that only ever shrinks when a vault entry is actually deleted —
   * never a wholesale rebuild from whatever the current read happened to see.
   *
   * Rebuilding it would defeat the delete-order guarantee `clearAll()` documents. Every
   * `clearAll()` is preceded by an `initialize()`, so a reload that replaced the index
   * with "the secret ids in MACROS_KEY right now" would discard exactly the orphans the
   * ordering exists to preserve: after a crash, a partial write, or a corrupt MACROS_KEY
   * degraded to `[]`, the vault entries would still be there and nothing would name them
   * again.
   *
   * Call ordering is part of the contract and is the caller's job:
   *   - GROW (`added`) BEFORE the `secrets.store()` it describes. An entry written under
   *     an id no key names is unreachable forever, including by `clearAll()`.
   *   - SHRINK (`removed`) AFTER the `secrets.delete()` it describes, and after MACROS_KEY
   *     is written. `removed` must list every id whose vault entry the caller has already
   *     deleted, so the ledger does not grow without bound.
   * Over-naming is the cheap direction: an id in the ledger with no entry behind it costs
   * one no-op `secrets.delete()` at `clearAll()`.
   *
   * KNOWN, ARGUED GAP — a cross-window ledger race, deliberately not fixed here. This is a
   * read-modify-write: two windows can each read the ledger before the other's write is
   * visible, and each writes its own union. Windows A and B add secrets `a` and `b`; both
   * read `[]`; A writes `[a]`, B writes `[b]`. If B's MACROS_KEY write also lands last,
   * `macro-secret-text-a` is named by neither key and Complete Reset cannot sweep it — a
   * stranded plaintext secret in the OS keyring. Reproduced in review.
   *
   * Not fixed because no fix is available at this layer, and the plausible-looking ones are
   * worse than the gap:
   *   - Re-reading closer to the write does nothing. The read and the `update()` call below
   *     are ALREADY adjacent with no `await` between them, so within a window the sequence is
   *     atomic. The staleness is in VS Code's cross-process globalState cache, which the
   *     extension host does not let this code bypass, invalidate, or lock.
   *   - Making the ledger append-only does not help either: the lost write is the union
   *     itself, not the shrink.
   *   - Enumerating the vault instead of keeping a ledger would remove the need for it
   *     entirely, and is what the ledger is a workaround FOR: `SecretStorage` has no list API.
   *
   * What bounds it: `reloadFromState()` re-unions every secret id in MACROS_KEY at every
   * activation, so a stranded entry is re-named the moment its macro is still on disk. The
   * residue is confined to the case where BOTH writes are lost for the same id — the macro
   * gone from MACROS_KEY and the id gone from the ledger — which requires the two windows to
   * lose the same race twice, on the same id, in the same direction. Revisit if VS Code ever
   * exposes a compare-and-swap on globalState or an enumerable SecretStorage.
   */
  private async updateSecretIndex(
    added: ReadonlySet<string>,
    removed: ReadonlySet<string>
  ): Promise<void> {
    const current = this.readSecretIndex();
    const merged = new Set(current);
    for (const id of added) merged.add(id);
    for (const id of removed) merged.delete(id);
    if (merged.size === current.size && [...merged].every((id) => current.has(id))) return;
    await this.context.globalState.update(SECRET_IDS_KEY, merged.size > 0 ? [...merged] : undefined);
  }

  private readSecretIndex(): Set<string> {
    return new Set(asArray<string>(this.context.globalState.get(SECRET_IDS_KEY, [])).filter(isValidMacroId));
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
        // Another window moved MACROS_KEY while we were writing to the vault, so the
        // absorbed records did not land. Leave `nexus.terminal.macros` in settings
        // exactly where it is: clearing it now would be the only remaining copy of
        // those macros disappearing. Absorption is content-keyed and idempotent, so the
        // next activation simply retries against whatever the other window left behind.
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
   * @returns `false` when the MACROS_KEY write was skipped because another window moved
   * the key while this one was awaiting the vault — the caller must then leave the legacy
   * setting in place so the absorb can be retried, rather than clearing the only other
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

    const storedVaultIds = new Set<string>();
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
        storedVaultIds.add(m.id!);
        onDisk.push({ ...m, text: "" });
      } else {
        onDisk.push({ ...m });
        // An already-persisted secret arrives here with `text: ""`: its value stays in
        // the vault under the id it kept, so the ledger must keep naming it.
        if (m.secret && isValidMacroId(m.id)) storedVaultIds.add(m.id);
      }
    }

    // Same write-order contract as `save()`: the ledger names every vault key BEFORE the
    // key is written, so a crash between the two leaves a sweepable orphan rather than an
    // entry no key names. `initialize()` reloads immediately after this and would union
    // the same ids in anyway, but every `secrets.store()` in this file is paired with its
    // ledger entry in the same function on purpose: that is what makes the ledger
    // trustworthy without having to reason about who calls what in which order. Nothing
    // is deleted from the vault here.
    await this.updateSecretIndex(storedVaultIds, EMPTY_ID_SET);
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

function keyOfLegacy(m: TerminalMacro): string {
  const textKey = m.secret ? "__SECRET__" : (m.text ?? "");
  // §10 — same key as configCommands.ts's keyOf(): two macros differing only in
  // their variable declarations must not collide; append the variable names.
  const variableNames = Array.isArray(m.variables) ? m.variables.map((v) => v?.name ?? "").join(",") : "";
  return `${m.name ?? ""}|${textKey}|${m.triggerPattern ?? ""}|${m.keybinding ?? ""}|${variableNames}`;
}

/** Dedupe legacy macros by `name|text|triggerPattern|keybinding`. First occurrence wins. */
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
