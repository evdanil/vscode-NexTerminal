import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { TerminalMacro } from "../models/terminalMacro";
import type { MacroStore, MacroStoreChangeListener } from "./macroStore";

const MACROS_KEY = "nexus.macros";
const SECRET_IDS_KEY = "nexus.macros.secretIds";
const SECRET_PREFIX = "macro-secret-text-";

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
    const normalized: TerminalMacro[] = macros.map((m) => ({
      ...m,
      id: m.id && m.id.length > 0 ? m.id : randomUUID()
    }));

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

    // Clear state FIRST so a crash mid-sweep leaves nothing referencing the vault keys.
    await this.context.globalState.update(MACROS_KEY, undefined);
    this.resolved = [];

    // Also read the persisted index to sweep any orphaned vault entries that
    // were left by a prior crash between vault-store and globalState-update.
    const indexedIds = this.context.globalState.get<string[]>(SECRET_IDS_KEY, []);
    await this.context.globalState.update(SECRET_IDS_KEY, undefined);
    const allIds = new Set([...ids, ...indexedIds]);
    for (const id of allIds) {
      await this.context.secrets.delete(macroSecretKey(id));
    }

    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async reloadFromState(): Promise<void> {
    const raw = this.context.globalState.get<TerminalMacro[]>(MACROS_KEY, []);
    const resolved: TerminalMacro[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const id = entry.id && typeof entry.id === "string" ? entry.id : randomUUID();
      if (entry.secret) {
        const vaulted = await this.context.secrets.get(macroSecretKey(id));
        resolved.push({ ...entry, id, text: vaulted ?? "" });
      } else {
        resolved.push({ ...entry, id });
      }
    }
    this.resolved = resolved;
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
    const existing = this.context.globalState.get<TerminalMacro[]>(MACROS_KEY, []);
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
    const assigned = macros.map((m) => ({
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
  return `${m.name ?? ""}|${textKey}|${m.triggerPattern ?? ""}|${m.keybinding ?? ""}`;
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
