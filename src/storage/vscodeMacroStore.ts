import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { TerminalMacro } from "../models/terminalMacro";
import {
  assignIdsForAbsorbedMacros,
  assignUniqueMacroIds,
  isValidMacroId,
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
    // pause/resume, interval ownership and cooldown state. `assignUniqueMacroIds()`
    // (macroStore.ts, shared with InMemoryMacroStore.save()) treats an empty string
    // AND any non-string value (e.g. `{length: 1}` from a corrupt import — a plain
    // `.length` check would be fooled by that) as missing, matching
    // `macroStateKey()`'s own guard. Dedup runs BEFORE the vault read/write loop
    // below, which keys every vault entry by the final `m.id` — so by the time that
    // loop runs, ids are already unique and no secret macro's vault entry can be
    // overwritten or cross-read by another macro that happened to share its id.
    //
    // Re-keying is safe HERE, and only here, for two reasons. It is a write path: every
    // caller is a user-initiated command (macro add/edit/remove/reorder, the macro
    // editor panel, config import) and none of them runs at activation — the read path
    // `reloadFromState()` deliberately leaves stored ids alone. And it is loss-free: a
    // duplicated secret's vault value was already resolved into `m.text` at load, so the
    // loop below writes that same value back under the fresh key before the old one is
    // reused or deleted. This is also the user's remedy for a duplicate that predates
    // the invariant — saving either colliding macro clears it permanently.
    const normalized: TerminalMacro[] = assignUniqueMacroIds(macros).map((m) => withRedactedVariables(m));

    const currentIds = new Set(this.resolved.map((m) => m.id).filter((v): v is string => Boolean(v)));
    const nextIds = new Set(normalized.map((m) => m.id!).filter(Boolean));

    // Every vault key this call deletes, so the secret-id ledger can drop it (see
    // `updateSecretIndex()`); anything not deleted stays indexed even if it is not in
    // this macro set, because its vault entry is still there.
    const deletedVaultIds = new Set<string>();
    const storedVaultIds = new Set<string>();

    // Delete vault entries for removed macros
    for (const oldId of currentIds) {
      if (!nextIds.has(oldId)) {
        await this.context.secrets.delete(macroSecretKey(oldId));
        deletedVaultIds.add(oldId);
      }
    }

    // Build on-disk shape: strip text from secret macros; write secret text to vault
    const onDisk: TerminalMacro[] = [];
    for (const m of normalized) {
      if (m.secret) {
        await this.context.secrets.store(macroSecretKey(m.id!), m.text);
        storedVaultIds.add(m.id!);
        onDisk.push({ ...m, text: "" });
      } else {
        // If this macro was previously secret, clean its vault entry
        await this.context.secrets.delete(macroSecretKey(m.id!));
        deletedVaultIds.add(m.id!);
        onDisk.push({ ...m });
      }
    }

    await this.context.globalState.update(MACROS_KEY, onDisk);
    // Maintain the persistent secret-id index alongside every save
    await this.updateSecretIndex(storedVaultIds, deletedVaultIds);
    this.resolved = normalized;
    this.emit();
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

    // Also read the persisted index to sweep any orphaned vault entries that
    // were left by a prior crash between vault-store and globalState-update.
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
   *    into `text` here, so writing it back under a fresh key preserves it.
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
      if (entry.secret) {
        const vaulted = await this.context.secrets.get(macroSecretKey(id));
        resolved.push({ ...redacted, id, text: vaulted ?? "" });
      } else {
        resolved.push({ ...redacted, id });
      }
    }
    this.resolved = resolved;

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
   * `removed` must list every id whose vault entry the caller has already deleted, so
   * the ledger does not grow without bound.
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
      this._lastAbsorbedCount += toAdd.length;
      // Provenance is kept explicit rather than merged into one array: the two halves
      // have different id rules — see `assignIdsForAbsorbedMacros()`.
      await this.persistLegacyMigration(existing, toAdd);
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
   */
  private async persistLegacyMigration(
    existingOnDisk: readonly TerminalMacro[],
    absorbed: readonly TerminalMacro[]
  ): Promise<void> {
    const keyed = assignIdsForAbsorbedMacros(existingOnDisk, absorbed);
    const assigned = [...keyed.existing, ...keyed.absorbed].map((m) =>
      m && typeof m === "object" ? withRedactedVariables(m) : m
    );

    const storedVaultIds = new Set<string>();
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
        await this.context.secrets.store(macroSecretKey(m.id!), m.text);
        storedVaultIds.add(m.id!);
        onDisk.push({ ...m, text: "" });
      } else {
        onDisk.push({ ...m });
        // An already-persisted secret arrives here with `text: ""`: its value stays in
        // the vault under the id it kept, so the ledger must keep naming it.
        if (m.secret && isValidMacroId(m.id)) storedVaultIds.add(m.id);
      }
    }
    await this.context.globalState.update(MACROS_KEY, onDisk);
    // Keep the secret-id index in sync. Nothing was deleted from the vault here.
    // `initialize()` reloads immediately after this and would union the same ids in
    // anyway, but every `secrets.store()` in this file is paired with its ledger entry
    // in the same function on purpose: that is what makes the ledger trustworthy
    // without having to reason about who calls what in which order.
    await this.updateSecretIndex(storedVaultIds, EMPTY_ID_SET);
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
