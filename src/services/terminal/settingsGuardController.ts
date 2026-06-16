import * as vscode from "vscode";
import {
  appendEvent,
  assessScopes,
  assessWatchedValue,
  classifyWatchedChange,
  computeShadowUpdate,
  evaluateRateLimit,
  formatEventLine,
  formatGuardReport,
  HEALABLE_KEYS,
  jsonEqual,
  renderValue,
  sanitizeShadow,
  type GuardEvent,
  type GuardScope,
  type ScopeAssessment,
  type WatchedValuePolicy,
} from "./settingsGuard";
import { consumeNexusConfigWrite, recordNexusConfigWrite } from "./settingsWriteRegistry";
import { deriveUserSettingsPath, hasUtf8Bom, stripUtf8Bom } from "./settingsFileBom";

const SHADOW_KEY = "nexus.settingsGuard.lastKnownGood";
const VALUE_SHADOW_KEY = "nexus.settingsGuard.lastKnownGoodValues";
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
  /**
   * In-memory mirror of the persisted value shadows. captureOrHealWatchedValue
   * mutates this synchronously and persists fire-and-forget — same class as the
   * eventLog mirror: a stale read-modify-write races when concurrent captures
   * for sibling keys arrive in the same change event.
   */
  private valueShadows: Record<string, unknown[]> = {};
  /** Serializes checkSkipShell runs so a restore's own change event can't interleave. */
  private checkChain: Promise<void> = Promise.resolve();
  /** Per-key, per-session heal cap — a write-war on a nexus.* key pauses healing for that key. */
  private readonly valueHealCounts = new Map<string, number>();
  private static readonly MAX_VALUE_HEALS_PER_KEY = 3;
  /** Tracks keys for which the value-heal-cap warning toast has already been shown this session. */
  private readonly valueHealPauseToastShown = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly requiredCommands: readonly string[],
    private readonly hasMacros: () => boolean = () => true
  ) {
    this.output = vscode.window.createOutputChannel("Nexus Settings Guard");
  }

  /** Subscribe to config changes and run the activation check (catches overnight damage). */
  start(): void {
    this.eventLog = this.context.globalState.get<GuardEvent[]>(EVENT_LOG_KEY, []);
    this.valueShadows = this.loadValueShadows();
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

  private loadValueShadows(): Record<string, unknown[]> {
    const raw = this.context.globalState.get<unknown>(VALUE_SHADOW_KEY);
    if (typeof raw !== "object" || raw === null) return {};
    const result: Record<string, unknown[]> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) result[k] = v;
    }
    return result;
  }

  /**
   * Remove a leading UTF-8 BOM from the active-profile user settings.json.
   *
   * The corporate DLP rewrites settings.json as UTF-8-with-BOM; VS Code's
   * settings writer refuses to persist into a file whose JSON has a parse error,
   * and a leading BOM is exactly such an error (InvalidSymbol at offset 0). The
   * in-memory heal still works (macros keep functioning), but the disk write
   * silently never lands. Stripping the BOM first lets the subsequent
   * config.update heal persist. The strip changes no config value, so it cannot
   * be done after the write (no change event would re-trigger the heal).
   *
   * PROFILE-SAFETY: `ExtensionContext.globalStorageUri` always resolves to the
   * DEFAULT profile's path, never a named profile's path (VS Code issue #160466).
   * To avoid writing to the wrong file, we parse the BOM-stripped bytes and
   * verify that the value for `verifyKey` matches `expectedGlobalValue` (what
   * VS Code is actually reading). On a mismatch we record a "bom-strip-skipped"
   * event and return false without writing. This check is sound because:
   *   - DLP output is strict JSON modulo the BOM (no comments, no trailing
   *     commas) so JSON.parse succeeds on exactly the files we care about.
   *   - Comment-bearing user-authored settings.json is saved WITHOUT a BOM and
   *     therefore never reaches this code.
   *   - On any parse failure or value mismatch we decline to write.
   *
   * Best-effort and quiet on the common path: a missing/unreadable settings.json
   * (fresh user, in-memory test context) returns false with no event. Only a
   * failed WRITE — the interesting forensic case — is logged.
   * Returns true when a BOM was found and removed.
   */
  private async stripSettingsBomIfPresent(
    reason: string,
    verifyKey: string,
    expectedGlobalValue: unknown
  ): Promise<boolean> {
    if (this.disposed) return false;
    let uri: vscode.Uri;
    let bytes: Uint8Array;
    try {
      uri = vscode.Uri.file(deriveUserSettingsPath(this.context.globalStorageUri.fsPath));
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return false; // missing/unreadable — nothing to do, not noteworthy
    }
    if (!hasUtf8Bom(bytes)) return false;
    // Profile-safety: parse the BOM-stripped content and confirm the key's
    // value matches what VS Code reports. If they diverge, the derived path
    // points to a different profile's settings.json — do not write.
    const stripped = stripUtf8Bom(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(stripped).toString("utf8"));
    } catch {
      return false; // unparseable after BOM strip — not a DLP-rewritten file
    }
    const fileValue =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)[verifyKey]
        : undefined;
    // When the key vanished entirely both sides are undefined and this matches —
    // intentional: the legitimate same-profile "vanished" heal still needs the BOM
    // gone so config.update can re-add the key. The only action is BOM removal
    // (value-preserving), so the loosened match in that edge is harmless.
    if (!jsonEqual(fileValue, expectedGlobalValue)) {
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: "settings.json",
        kind: "bom-strip-skipped",
        detail: "profile-mismatch:" + reason,
      });
      return false;
    }
    try {
      await vscode.workspace.fs.writeFile(uri, stripped);
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: "settings.json",
        kind: "bom-stripped",
        detail: reason,
      });
      return true;
    } catch (err) {
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: "settings.json",
        kind: "bom-strip-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Capture-or-heal one healable Nexus-own setting (global scope only).
   * healthy → refresh the value shadow (filtered to valid entries).
   * corrupt → log evidence; when the guard is enabled, restore the shadowed
   * value, or remove the override when no shadow exists (package defaults
   * apply). Healing also runs on live change events — the external tool
   * rewrites settings.json while VS Code is running.
   */
  private async captureOrHealWatchedValue(
    policy: WatchedValuePolicy,
    trigger: "startup" | "change-event"
  ): Promise<void> {
    if (this.disposed) return;
    const dot = policy.key.lastIndexOf(".");
    const section = policy.key.slice(0, dot);
    const leaf = policy.key.slice(dot + 1);
    const config = vscode.workspace.getConfiguration(section);
    const raw = config.inspect(leaf)?.globalValue;
    const assessment = assessWatchedValue(policy, raw);

    if (assessment.state === "absent") return;

    if (assessment.state === "healthy") {
      if (!jsonEqual(this.valueShadows[policy.key], assessment.captureValue)) {
        // In-memory mirror prevents race: fresh globalState reads per event race
        // (stale read-modify-write drops sibling keys when one event covers both
        // healable settings) — same class as the eventLog mirror.
        this.valueShadows = { ...this.valueShadows, [policy.key]: assessment.captureValue };
        void this.context.globalState.update(VALUE_SHADOW_KEY, this.valueShadows);
      }
      return;
    }

    // corrupt
    this.recordEvent({
      timestamp: new Date().toISOString(),
      key: policy.key,
      scope: "global",
      kind: "external-strip",
      detail: trigger === "startup" ? "found-at-startup" : "corrupt-value",
      before: renderValue(raw),
      ...(trigger === "change-event" ? { focused: vscode.window.state.focused } : {}),
    });
    if (!this.isEnabled()) return;
    const healCount = this.valueHealCounts.get(policy.key) ?? 0;
    if (healCount >= SettingsGuardController.MAX_VALUE_HEALS_PER_KEY) {
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: policy.key,
        scope: "global",
        kind: "paused",
        detail: "value-heal-cap",
      });
      if (!this.valueHealPauseToastShown.has(policy.key)) {
        this.valueHealPauseToastShown.add(policy.key);
        void vscode.window
          .showWarningMessage(
            `An external program keeps corrupting ${policy.key} — Nexus auto-heal for this setting is paused.`,
            "Resume Guard",
            "Show Report"
          )
          .then((choice) => {
            if (this.disposed) return;
            if (choice === "Resume Guard") this.resume();
            else if (choice === "Show Report") this.showReport();
          });
      }
      return;
    }
    await this.stripSettingsBomIfPresent(`value-heal:${policy.key}`, policy.key, raw);
    const restoreValue = this.valueShadows[policy.key];
    try {
      recordNexusConfigWrite(policy.key, restoreValue, Date.now());
      await config.update(leaf, restoreValue, vscode.ConfigurationTarget.Global);
      this.valueHealCounts.set(policy.key, healCount + 1);
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: policy.key,
        scope: "global",
        kind: "restore",
        detail: restoreValue !== undefined ? "restored-from-shadow" : "removed-corrupt-key",
        after: renderValue(restoreValue),
      });
    } catch (err) {
      this.valueHealCounts.set(policy.key, healCount + 1); // failures count toward the cap — bounds retry against a locked file
      consumeNexusConfigWrite(policy.key, restoreValue, Date.now()); // reclaim the unconsumed marker so it can't mask a real external change
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: policy.key,
        scope: "global",
        kind: "restore-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Activation-time scan for corruption that predates this session (the
   * external tool also runs while VS Code is closed). Read-time sanitization
   * keeps runtime behavior correct, but the corrupt raw value stays in
   * settings.json and in the native settings UI — confusing and evidence-free.
   * Detection is logged always; healing (restoring from shadow, or removing the
   * corrupt override so the package default applies) is gated on the guard
   * toggle. Raw GLOBAL values only — never effective values.
   *
   * Also captures healthy values into the value shadow so the restore path
   * has material to work with. Healing also runs on live change events via
   * captureOrHealWatchedValue.
   *
   * A heal produces three log lines by design: the external-strip evidence,
   * the restore (removed-corrupt-key or restored-from-shadow), and the
   * own-write echo when the removal's change event consumes its wildcard
   * registry entry.
   */
  private async scanStartupCorruption(): Promise<void> {
    if (this.disposed) return;
    for (const policy of HEALABLE_KEYS) {
      await this.captureOrHealWatchedValue(policy, "startup");
    }
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration("nexus.settingsGuard").get<boolean>("enabled", true);
  }

  private readEffective(fullKey: string): unknown {
    const dot = fullKey.lastIndexOf(".");
    return vscode.workspace.getConfiguration(fullKey.slice(0, dot)).get(fullKey.slice(dot + 1));
  }

  private readGlobalValue(fullKey: string): unknown {
    const dot = fullKey.lastIndexOf(".");
    return vscode.workspace.getConfiguration(fullKey.slice(0, dot)).inspect(fullKey.slice(dot + 1))?.globalValue;
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
        const healableOwn = HEALABLE_KEYS.find((p) => p.key === key);
        if (healableOwn) void this.captureOrHealWatchedValue(healableOwn, "change-event");
        continue;
      }
      const healable = HEALABLE_KEYS.find((p) => p.key === key);
      const rawGlobal = healable ? this.readGlobalValue(key) : undefined;
      const healAssessment = healable ? assessWatchedValue(healable, rawGlobal) : undefined;
      const change = classifyWatchedChange(key, before, after);
      if (change && healAssessment?.state !== "corrupt") {
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key,
          kind: change.kind,
          before: change.before,
          after: change.after,
          focused: vscode.window.state.focused,
        });
      }
      if (healable) void this.captureOrHealWatchedValue(healable, "change-event");
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

    // Gate required commands and fallback base on whether macros are defined.
    // Empty required makes assessScopes classify everything none — guard stays
    // inert for skip-shell when there are no macros, and captures no shadow.
    const macrosPresent = this.hasMacros();
    const required = macrosPresent ? this.requiredCommands : [];
    const rawDefault = inspect?.defaultValue;
    const fallbackBases =
      macrosPresent && Array.isArray(rawDefault)
        ? { global: rawDefault.filter((c): c is string => typeof c === "string") }
        : undefined;

    const assessments = assessScopes(shadow?.values, current, required, this.ownWrites, fallbackBases);

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
      const update = computeShadowUpdate(current, required, new Date().toISOString());
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

    await this.stripSettingsBomIfPresent("skip-shell-restore", SKIP_SHELL_FULL, current.global);
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
    this.valueHealCounts.clear(); // Re-arms both the session-cap and the per-key value-heal cap.
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
