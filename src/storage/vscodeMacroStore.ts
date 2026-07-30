import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { TerminalMacro } from "../models/terminalMacro";
import type { MacroStore, MacroStoreChangeListener } from "./macroStore";
import { withRedactedVariables } from "../services/macroVariables";

const MACROS_KEY = "nexus.macros";
const SECRET_IDS_KEY = "nexus.macros.secretIds";
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
    // Unique, non-empty ids are enforced in this same chokepoint: nothing upstream
    // guarantees it (a replace-mode backup import saves whatever ids the file
    // contains verbatim — see configCommands.ts), and MacroAutoTrigger's
    // `macroStateKey()` treats any two macros with equal `id` as the SAME macro for
    // pause/resume, interval ownership and cooldown state. An empty string is
    // treated as missing, matching `macroStateKey()`'s own falsy check. Dedup runs
    // BEFORE the vault read/write loop below, which keys every vault entry by the
    // final `m.id` — so by the time that loop runs, ids are already unique and no
    // secret macro's vault entry can be overwritten or cross-read by another macro
    // that happened to share its id.
    const seenIds = new Set<string>();
    const normalized: TerminalMacro[] = macros.map((m) => {
      let id = m.id && m.id.length > 0 ? m.id : randomUUID();
      while (seenIds.has(id)) id = randomUUID();
      seenIds.add(id);
      return withRedactedVariables({ ...m, id });
    });

    const currentIds = new Set(this.resolved.map((m) => m.id).filter((v): v is string => Boolean(v)));
    const nextIds = new Set(normalized.map((m) => m.id!).filter(Boolean));

    // Delete vault entries for removed macros
    for (const oldId of currentIds) {
      if (!nextIds.has(oldId)) {
        await this.context.secrets.delete(macroSecretKey(oldId));
      }
    }

    // Build on-disk shape: strip text from secret macros; write secret text to vault
    const onDisk: TerminalMacro[] = [];
    for (const m of normalized) {
      if (m.secret) {
        await this.context.secrets.store(macroSecretKey(m.id!), m.text);
        onDisk.push({ ...m, text: "" });
      } else {
        // If this macro was previously secret, clean its vault entry
        await this.context.secrets.delete(macroSecretKey(m.id!));
        onDisk.push({ ...m });
      }
    }

    await this.context.globalState.update(MACROS_KEY, onDisk);
    // Maintain the persistent secret-id index alongside every save
    const secretIds = normalized.filter((m) => m.secret && m.id).map((m) => m.id!);
    await this.context.globalState.update(SECRET_IDS_KEY, secretIds);
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
    const indexedIds = asArray<string>(this.context.globalState.get(SECRET_IDS_KEY, [])).filter(
      (id): id is string => typeof id === "string"
    );

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

  private async reloadFromState(): Promise<void> {
    const raw = asArray<TerminalMacro>(this.context.globalState.get(MACROS_KEY, []));
    const resolved: TerminalMacro[] = [];
    // Tracks whether any on-disk record still carried a masked variable's plaintext
    // default, so it can be scrubbed rather than merely hidden from `getAll()`.
    let needsDiskScrub = false;
    // Same unique-id invariant `save()` enforces (see its comment), applied here too:
    // on-disk state can still contain duplicate ids from before this invariant existed
    // (or from external corruption), and `resolved` is what MacroAutoTrigger keys its
    // pause/resume/interval state against. A later duplicate gets a fresh id BEFORE
    // the vault lookup below runs, so it is never fetched under an id another macro
    // already owns — it simply resolves to no vault entry (empty text) rather than
    // risking a cross-read of the wrong macro's secret. This is an in-memory repair
    // only (mirrors the "minimal raw rewrite" rule below); the next `save()` persists
    // the corrected, unique ids permanently.
    const seenIds = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      let id = entry.id && typeof entry.id === "string" && entry.id.length > 0 ? entry.id : randomUUID();
      while (seenIds.has(id)) id = randomUUID();
      seenIds.add(id);
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
    //    this reload's incidental repairs — dropped non-object records, freshly
    //    assigned UUIDs — turning a redaction into a rewrite of records that were
    //    never the problem.
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

    // Rebuild the secret-id index from the resolved list to keep it consistent
    const secretIds = resolved.filter((m) => m.secret && m.id).map((m) => m.id!);
    await this.context.globalState.update(SECRET_IDS_KEY, secretIds.length > 0 ? secretIds : undefined);
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

    const deduped = dedupeLegacyMacros(collected);
    const existing = asArray<TerminalMacro>(this.context.globalState.get(MACROS_KEY, []));
    const existingKeys = new Set(existing.map(keyOfLegacy));
    const toAdd = deduped.filter((m) => !existingKeys.has(keyOfLegacy(m)));
    if (toAdd.length > 0) {
      this._lastAbsorbedCount += toAdd.length;
      await this.persistLegacyMigration([...existing, ...toAdd]);
    }

    for (const target of scopesToClear) {
      try {
        await config.update("macros", undefined, target);
      } catch {
        // Scope unavailable (e.g. no workspace open) — ignore.
      }
    }
  }

  private async persistLegacyMigration(macros: TerminalMacro[]): Promise<void> {
    // Variables are normalized here rather than only at read time: this path absorbs
    // `nexus.terminal.macros` from settings.json verbatim on every activation
    // (Settings Sync replay included), so without it a hand-written masked variable
    // carrying a plaintext `default` would be written straight into globalState.
    const assigned = macros.map((m) => withRedactedVariables({
      ...m,
      id: m.id && typeof m.id === "string" ? m.id : randomUUID()
    }));

    const onDisk: TerminalMacro[] = [];
    for (const m of assigned) {
      if (m.secret && typeof m.text === "string" && m.text.length > 0) {
        await this.context.secrets.store(macroSecretKey(m.id!), m.text);
        onDisk.push({ ...m, text: "" });
      } else {
        onDisk.push({ ...m });
      }
    }
    await this.context.globalState.update(MACROS_KEY, onDisk);
    // Keep the secret-id index in sync
    const secretIds = assigned.filter((m) => m.secret && m.id).map((m) => m.id!);
    await this.context.globalState.update(SECRET_IDS_KEY, secretIds);
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
