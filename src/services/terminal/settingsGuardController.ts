import * as vscode from "vscode";
import {
  appendEvent,
  assessScopes,
  classifyWatchedChange,
  computeShadowUpdate,
  evaluateRateLimit,
  formatEventLine,
  formatGuardReport,
  renderValue,
  sanitizeShadow,
  shouldRemoveCorruptNexusValue,
  type GuardEvent,
  type GuardScope,
  type ScopeAssessment,
  type SkipShellShadow,
} from "./settingsGuard";
import { consumeNexusConfigWrite, recordNexusConfigWrite } from "./settingsWriteRegistry";

const SHADOW_KEY = "nexus.settingsGuard.lastKnownGood";
const EVENT_LOG_KEY = "nexus.settingsGuard.eventLog";
const SKIP_SHELL_SECTION = "terminal.integrated";
const SKIP_SHELL_LEAF = "commandsToSkipShell";
const SKIP_SHELL_FULL = `${SKIP_SHELL_SECTION}.${SKIP_SHELL_LEAF}`;

/** Log-only watched keys; the skip-shell list gets the richer per-scope handling. */
const WATCHED_KEYS = [
  "terminal.integrated.sendKeybindingsToShell",
  "window.enableMenuBarMnemonics",
  "nexus.terminal.passthroughKeys",
  "nexus.terminal.highlighting.rules",
] as const;

export function scopeToTarget(scope: GuardScope): vscode.ConfigurationTarget {
  switch (scope) {
    case "global":
      return vscode.ConfigurationTarget.Global;
    case "workspace":
      return vscode.ConfigurationTarget.Workspace;
    case "workspaceFolder":
      return vscode.ConfigurationTarget.WorkspaceFolder;
  }
}

export function targetToScope(target: vscode.ConfigurationTarget): GuardScope {
  switch (target) {
    case vscode.ConfigurationTarget.Workspace:
      return "workspace";
    case vscode.ConfigurationTarget.WorkspaceFolder:
      return "workspaceFolder";
    default:
      return "global";
  }
}

/**
 * Orchestrates the Settings Guard (spec: docs/superpowers/specs/2026-06-11-settings-guard-design.md).
 *
 * - Auto-restores externally-stripped `terminal.integrated.commandsToSkipShell`
 *   values from a last-known-good shadow kept in globalState (opt-out via
 *   `nexus.settingsGuard.enabled`).
 * - Logs every external mutation of the watched keys to a persisted ring buffer
 *   and the "Nexus Settings Guard" output channel — always on, even when the
 *   guard itself is disabled or paused.
 */
export class SettingsGuardController implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Last value Nexus itself wrote per scope (guard restore, undo, or keybinding repair). */
  private readonly ownWrites: Record<GuardScope, string[] | null> = {
    global: null,
    workspace: null,
    workspaceFolder: null,
  };
  private restoreTimestamps: number[] = [];
  private paused = false;
  private disposed = false;
  private readonly watchedSnapshot = new Map<string, unknown>();
  /**
   * In-memory mirror of the persisted event log. recordEvent appends here and
   * persists fire-and-forget; reading globalState back on every event would
   * race (stale read-modify-write drops entries when events arrive quickly).
   */
  private eventLog: GuardEvent[] = [];
  /** Serializes checkSkipShell runs so a restore's own change event can't interleave. */
  private checkChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly requiredCommands: readonly string[]
  ) {
    this.output = vscode.window.createOutputChannel("Nexus Settings Guard");
  }

  /** Subscribe to config changes and run the activation check (catches overnight damage). */
  start(): void {
    this.eventLog = this.context.globalState.get<GuardEvent[]>(EVENT_LOG_KEY, []);
    for (const key of WATCHED_KEYS) {
      this.watchedSnapshot.set(key, this.readEffective(key));
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChange(e))
    );
    void this.scanStartupCorruption();
    this.enqueueCheck();
  }

  /** Called by repairMacroKeybindings so its writes classify as own-write, not external. */
  recordOwnWrite(scope: GuardScope, value: string[]): void {
    this.ownWrites[scope] = value;
  }

  showReport(): void {
    const termInspect = vscode.workspace
      .getConfiguration("terminal.integrated")
      .inspect<string[]>("commandsToSkipShell");
    const lines: string[] = ["", "Current values (VS Code's view — compare against settings.json on disk):"];
    lines.push(`  terminal.integrated.commandsToSkipShell globalValue:    ${renderValue(termInspect?.globalValue)}`);
    lines.push(`  terminal.integrated.commandsToSkipShell workspaceValue: ${renderValue(termInspect?.workspaceValue)}`);
    lines.push(`  terminal.integrated.commandsToSkipShell effective:      ${renderValue(vscode.workspace.getConfiguration("terminal.integrated").get("commandsToSkipShell"))}`);
    for (const key of ["nexus.terminal.passthroughKeys", "nexus.terminal.highlighting.rules", "terminal.integrated.sendKeybindingsToShell", "window.enableMenuBarMnemonics"]) {
      const dot = key.lastIndexOf(".");
      const cfg = vscode.workspace.getConfiguration(key.slice(0, dot));
      lines.push(`  ${key} globalValue: ${renderValue(cfg.inspect(key.slice(dot + 1))?.globalValue)}`);
    }
    this.output.appendLine(lines.join("\n"));
    this.output.appendLine(formatGuardReport(this.eventLog, this.isEnabled(), new Date().toISOString()));
    this.output.show(true);
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.output.dispose();
  }

  /**
   * Activation-time scan for corruption that predates this session (the
   * external tool also runs while VS Code is closed). Read-time sanitization
   * keeps runtime behavior correct, but the corrupt raw value stays in
   * settings.json and in the native settings UI — confusing and evidence-free.
   * Detection is logged always; healing (removing the corrupt override so the
   * package default applies) is gated on the guard toggle. Raw GLOBAL values
   * only — never effective values.
   *
   * A heal produces three log lines by design: the external-strip evidence,
   * the restore (removed-corrupt-key), and the own-write echo when the
   * removal's change event consumes its wildcard registry entry.
   */
  private async scanStartupCorruption(): Promise<void> {
    if (this.disposed) return;
    const healable = ["nexus.terminal.passthroughKeys", "nexus.terminal.highlighting.rules"];
    for (const fullKey of healable) {
      const dot = fullKey.lastIndexOf(".");
      const section = fullKey.slice(0, dot);
      const leaf = fullKey.slice(dot + 1);
      const config = vscode.workspace.getConfiguration(section);
      const raw = config.inspect(leaf)?.globalValue;
      if (!shouldRemoveCorruptNexusValue(fullKey, raw)) continue;
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: fullKey,
        scope: "global",
        kind: "external-strip",
        detail: "found-at-startup",
        before: renderValue(raw),
      });
      if (!this.isEnabled()) continue;
      try {
        recordNexusConfigWrite(fullKey, undefined, Date.now());
        await config.update(leaf, undefined, vscode.ConfigurationTarget.Global);
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key: fullKey,
          scope: "global",
          kind: "restore",
          detail: "removed-corrupt-key",
        });
      } catch (err) {
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key: fullKey,
          scope: "global",
          kind: "restore-failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration("nexus.settingsGuard").get<boolean>("enabled", true);
  }

  private readEffective(fullKey: string): unknown {
    const dot = fullKey.lastIndexOf(".");
    return vscode.workspace.getConfiguration(fullKey.slice(0, dot)).get(fullKey.slice(dot + 1));
  }

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration(SKIP_SHELL_FULL)) {
      this.enqueueCheck();
    }
    for (const key of WATCHED_KEYS) {
      if (!e.affectsConfiguration(key)) continue;
      const before = this.watchedSnapshot.get(key);
      const after = this.readEffective(key);
      this.watchedSnapshot.set(key, after);
      if (consumeNexusConfigWrite(key, after, Date.now())) {
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key,
          kind: "own-write",
          detail: "nexus-ui",
          before: renderValue(before),
          after: renderValue(after),
        });
        continue;
      }
      const change = classifyWatchedChange(key, before, after);
      if (change) {
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key,
          kind: change.kind,
          before: change.before,
          after: change.after,
          focused: vscode.window.state.focused,
        });
      }
    }
  }

  private enqueueCheck(): void {
    this.checkChain = this.checkChain.then(() => this.checkSkipShell()).catch(() => undefined);
  }

  private async checkSkipShell(): Promise<void> {
    if (this.disposed) return;
    const config = vscode.workspace.getConfiguration(SKIP_SHELL_SECTION);
    const inspect = config.inspect<string[]>(SKIP_SHELL_LEAF);
    // The guard handles ONLY the global (user-level) scope. The shadow is
    // machine-global, while workspace/workspaceFolder values are per-workspace —
    // capturing those would bleed one workspace's list into other workspaces'
    // .vscode/settings.json. The external tool rewrites the user-level
    // settings.json only; workspace-level issues stay with the existing
    // confirm-gated "Fix Macro Keybindings" repair.
    const current: Record<GuardScope, unknown> = {
      global: inspect?.globalValue,
      workspace: undefined,
      workspaceFolder: undefined,
    };
    const shadow = sanitizeShadow(this.context.globalState.get(SHADOW_KEY));
    const assessments = assessScopes(shadow?.values, current, this.requiredCommands, this.ownWrites);

    // Consume own-write markers once observed.
    for (const a of assessments) {
      if (a.classification === "own-write") {
        this.ownWrites[a.scope] = null;
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key: SKIP_SHELL_FULL,
          scope: a.scope,
          kind: "own-write",
        });
      }
    }

    const restores = assessments.filter((a) => a.restoreValue !== undefined);
    if (restores.length === 0) {
      const update = computeShadowUpdate(current, this.requiredCommands, new Date().toISOString());
      if (update) await this.context.globalState.update(SHADOW_KEY, update);
      return;
    }

    // Forensics first — logged even when the guard is disabled or paused.
    for (const a of restores) {
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: SKIP_SHELL_FULL,
        scope: a.scope,
        kind: "external-strip",
        detail: a.classification,
        before: renderValue(shadow?.values?.[a.scope]),
        after: renderValue(current[a.scope]),
      });
    }

    if (!this.isEnabled() || this.paused) return;

    const pauseReason = evaluateRateLimit(this.restoreTimestamps, Date.now());
    if (pauseReason) {
      this.pause(pauseReason);
      return;
    }

    const succeeded: ScopeAssessment[] = [];
    for (const a of restores) {
      const value = a.restoreValue as string[];
      this.ownWrites[a.scope] = value;
      try {
        await config.update(SKIP_SHELL_LEAF, value, scopeToTarget(a.scope));
      } catch (err) {
        // Write rejected (e.g. the external tool holds settings.json). Clear the
        // phantom marker and log it — the next change event retries naturally.
        this.ownWrites[a.scope] = null;
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key: SKIP_SHELL_FULL,
          scope: a.scope,
          kind: "restore-failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: SKIP_SHELL_FULL,
        scope: a.scope,
        kind: "restore",
        after: renderValue(value),
      });
      succeeded.push(a);
    }
    if (succeeded.length === 0) return;
    this.restoreTimestamps.push(Date.now());
    this.showRestoreToast(succeeded, current);
  }

  private showRestoreToast(
    restores: ScopeAssessment[],
    preValues: Record<GuardScope, unknown>
  ): void {
    void vscode.window
      .showWarningMessage(
        "Nexus restored terminal settings modified by an external program.",
        "Undo",
        "Disable Guard",
        "Show Report"
      )
      .then(async (choice) => {
        if (this.disposed) return;
        if (choice === "Undo") {
          await this.undoRestore(restores, preValues);
        } else if (choice === "Disable Guard") {
          await vscode.workspace
            .getConfiguration("nexus.settingsGuard")
            .update("enabled", false, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(
            "Nexus Settings Guard disabled. External changes are still logged — see \"Nexus: Show Settings Guard Report\"."
          );
        } else if (choice === "Show Report") {
          this.showReport();
        }
      });
  }

  private async undoRestore(
    restores: ScopeAssessment[],
    preValues: Record<GuardScope, unknown>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(SKIP_SHELL_SECTION);

    // Clear the shadow for undone scopes FIRST so the undo write cannot be
    // re-detected as a fresh corruption and immediately re-restored.
    const shadow = sanitizeShadow(this.context.globalState.get(SHADOW_KEY));
    if (shadow) {
      const values = { ...shadow.values };
      for (const a of restores) delete values[a.scope];
      await this.context.globalState.update(SHADOW_KEY, { ...shadow, values });
    }

    for (const a of restores) {
      const prev = preValues[a.scope];
      const value = Array.isArray(prev)
        ? prev.filter((v): v is string => typeof v === "string")
        : undefined; // vanished / corrupt-type → remove the override entirely
      this.ownWrites[a.scope] = value ?? null;
      await config.update(SKIP_SHELL_LEAF, value, scopeToTarget(a.scope));
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: SKIP_SHELL_FULL,
        scope: a.scope,
        kind: "undo",
        after: renderValue(value),
      });
    }
  }

  private pause(reason: "session-cap" | "burst"): void {
    this.paused = true;
    this.recordEvent({
      timestamp: new Date().toISOString(),
      key: SKIP_SHELL_FULL,
      kind: "paused",
      detail: reason,
    });
    const count = this.restoreTimestamps.length;
    void vscode.window
      .showWarningMessage(
        `An external program keeps rewriting settings.json (${count} Nexus auto-repairs this session) — auto-repair paused.`,
        "Resume Guard",
        "Show Report"
      )
      .then((choice) => {
        if (this.disposed) return;
        if (choice === "Resume Guard") this.resume();
        else if (choice === "Show Report") this.showReport();
      });
  }

  private resume(): void {
    this.paused = false;
    this.restoreTimestamps = [];
    this.recordEvent({
      timestamp: new Date().toISOString(),
      key: SKIP_SHELL_FULL,
      kind: "resumed",
    });
    this.enqueueCheck(); // repair immediately if settings are still corrupt
  }

  private recordEvent(event: GuardEvent): void {
    if (this.disposed) return;
    this.eventLog = appendEvent(this.eventLog, event);
    void this.context.globalState.update(EVENT_LOG_KEY, this.eventLog);
    this.output.appendLine(formatEventLine(event));
  }
}
