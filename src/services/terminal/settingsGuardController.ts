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
import { applyJsonKeyEdits, deriveUserSettingsPath, stripUtf8Bom, type JsonKeyEdit } from "./settingsFileBom";

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

/** Per-key desired repair state computed by computeDesiredState. */
interface KeyRepairPlan {
  /** The full dotted key name. */
  fullKey: string;
  /** The leaf name (after last dot) — used for config.update. */
  leaf: string;
  /** The section (before last dot) — used for config.update. */
  section: string;
  /** True when the current global value is corrupt and needs repair. */
  corrupt: boolean;
  /** The raw corrupt global value (for forensics / profile-safety verify). */
  corruptGlobalValue: unknown;
  /** The edit to apply to settings.json. */
  edit: JsonKeyEdit;
  /** The value config.update should write. undefined = remove key. */
  inMemoryValue: unknown;
  /**
   * Expected effective value after repair (for own-write marking):
   * - "set": the repair value
   * - "delete": the package default value (inspect().defaultValue)
   */
  expectedEffective: unknown;
  /** For skip-shell: the ScopeAssessment that drove the repair. */
  skipShellAssessment?: ScopeAssessment;
}

/**
 * Orchestrates the Settings Guard.
 *
 * - Auto-restores externally-stripped `terminal.integrated.commandsToSkipShell`
 *   values from a last-known-good shadow kept in globalState (opt-out via
 *   `nexus.settingsGuard.enabled`).
 * - Auto-restores corrupt `nexus.terminal.passthroughKeys` and
 *   `nexus.terminal.highlighting.rules` from their value shadows.
 * - On ANY corruption, recovers ALL corrupt Nexus keys together with ONE direct
 *   surgical file write (race-free) in addition to in-memory config.update calls.
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
   * In-memory mirror of the persisted value shadows. computeDesiredState
   * mutates this synchronously and persists fire-and-forget — same class as the
   * eventLog mirror: a stale read-modify-write races when concurrent captures
   * for sibling keys arrive in the same change event.
   */
  private valueShadows: Record<string, unknown[]> = {};
  /** Serializes recoverAll runs so a restore's own change event can't interleave. */
  private checkChain: Promise<void> = Promise.resolve();

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
    this.enqueueCheck(() => this.recoverAll("startup"));
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

  /**
   * Compute what every Nexus key SHOULD be, building repair plans for corrupt keys
   * and capturing healthy shadows.
   * Returns an array of KeyRepairPlan (one per Nexus-owned key that has a global override
   * or is corrupt).
   */
  private computeDesiredState(): KeyRepairPlan[] {
    const plans: KeyRepairPlan[] = [];

    // --- Skip-shell ---
    const skipConfig = vscode.workspace.getConfiguration(SKIP_SHELL_SECTION);
    const skipInspect = skipConfig.inspect<string[]>(SKIP_SHELL_LEAF);
    const current: Record<GuardScope, unknown> = {
      global: skipInspect?.globalValue,
      workspace: undefined,
      workspaceFolder: undefined,
    };
    const shadow = sanitizeShadow(this.context.globalState.get(SHADOW_KEY));
    const macrosPresent = this.hasMacros();
    const required = macrosPresent ? this.requiredCommands : [];
    const rawDefault = skipInspect?.defaultValue;
    const fallbackBases =
      macrosPresent && Array.isArray(rawDefault)
        ? { global: rawDefault.filter((c): c is string => typeof c === "string") }
        : undefined;

    const assessments = assessScopes(shadow?.values, current, required, this.ownWrites, fallbackBases);

    // Consume own-write markers
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
      // Healthy: update shadow
      const update = computeShadowUpdate(current, required, new Date().toISOString());
      if (update) void this.context.globalState.update(SHADOW_KEY, update);
    } else {
      // Only the global scope is handled for file repair
      const globalRestore = restores.find((a) => a.scope === "global");
      if (globalRestore && globalRestore.restoreValue !== undefined) {
        const value = globalRestore.restoreValue as string[];
        plans.push({
          fullKey: SKIP_SHELL_FULL,
          leaf: SKIP_SHELL_LEAF,
          section: SKIP_SHELL_SECTION,
          corrupt: true,
          corruptGlobalValue: current.global,
          edit: { key: SKIP_SHELL_FULL, action: "set", value },
          inMemoryValue: value,
          expectedEffective: value,
          skipShellAssessment: globalRestore,
        });
      }
    }

    // --- Healable watched keys ---
    for (const policy of HEALABLE_KEYS) {
      const dot = policy.key.lastIndexOf(".");
      const section = policy.key.slice(0, dot);
      const leaf = policy.key.slice(dot + 1);
      const config = vscode.workspace.getConfiguration(section);
      const inspect = config.inspect(leaf);
      const raw = inspect?.globalValue;
      const assessment = assessWatchedValue(policy, raw);

      if (assessment.state === "absent") continue;

      if (assessment.state === "healthy") {
        if (!jsonEqual(this.valueShadows[policy.key], assessment.captureValue)) {
          this.valueShadows = { ...this.valueShadows, [policy.key]: assessment.captureValue };
          void this.context.globalState.update(VALUE_SHADOW_KEY, this.valueShadows);
        }
        continue;
      }

      // corrupt
      const shadow = this.valueShadows[policy.key];
      const repairValue = shadow !== undefined ? shadow : undefined;
      const edit: JsonKeyEdit =
        repairValue !== undefined
          ? { key: policy.key, action: "set", value: repairValue }
          : { key: policy.key, action: "delete" };
      const expectedEffective =
        repairValue !== undefined ? repairValue : inspect?.defaultValue;

      plans.push({
        fullKey: policy.key,
        leaf,
        section,
        corrupt: true,
        corruptGlobalValue: raw,
        edit,
        inMemoryValue: repairValue,
        expectedEffective,
      });
    }

    return plans;
  }

  /**
   * Write surgical repairs to settings.json on disk (race-free, no BOM).
   * Returns true on success, false if skipped or failed.
   */
  private async repairNexusKeysOnDisk(
    edits: readonly JsonKeyEdit[],
    ownWriteMarks: Array<{ fullKey: string; expectedEffective: unknown }>,
    verifyKey: string,
    expectedGlobalValue: unknown,
    reason: string
  ): Promise<boolean> {
    if (this.disposed) return false;
    let uri: vscode.Uri;
    let bytes: Uint8Array;
    try {
      uri = vscode.Uri.file(deriveUserSettingsPath(this.context.globalStorageUri.fsPath));
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return false;
    }

    const stripped = stripUtf8Bom(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(stripped).toString("utf8"));
    } catch {
      return false;
    }

    const fileValue =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)[verifyKey]
        : undefined;
    // Profile-safety tripwire: verify the first corrupt key's on-disk value matches VS Code's
    // live globalValue. A wrong-profile file is very unlikely to coincidentally hold that
    // exact corrupt value, so this one check gates the entire write.
    if (!jsonEqual(fileValue, expectedGlobalValue)) {
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: "settings.json",
        kind: "file-repair-failed",
        detail: `profile-mismatch:${reason}`,
      });
      return false;
    }

    // Mark own-writes BEFORE writing
    for (const mark of ownWriteMarks) {
      if (mark.fullKey === SKIP_SHELL_FULL) {
        // skip-shell uses the ownWrites record
        this.ownWrites.global = mark.expectedEffective as string[];
      } else {
        recordNexusConfigWrite(mark.fullKey, mark.expectedEffective, Date.now());
      }
    }

    let newText: string;
    try {
      const textIn = Buffer.from(stripped).toString("utf8");
      newText = applyJsonKeyEdits(textIn, edits);
    } catch (err) {
      // Reclaim markers
      for (const mark of ownWriteMarks) {
        if (mark.fullKey === SKIP_SHELL_FULL) {
          this.ownWrites.global = null;
        } else {
          consumeNexusConfigWrite(mark.fullKey, mark.expectedEffective, Date.now());
        }
      }
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: "settings.json",
        kind: "file-repair-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    if (this.disposed) return false;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, "utf8"));
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: "settings.json",
        kind: "file-repaired",
        detail: `${reason} [${ownWriteMarks.map((m) => m.fullKey).join(", ")}]`,
      });
      return true;
    } catch (err) {
      // Reclaim markers
      for (const mark of ownWriteMarks) {
        if (mark.fullKey === SKIP_SHELL_FULL) {
          this.ownWrites.global = null;
        } else {
          consumeNexusConfigWrite(mark.fullKey, mark.expectedEffective, Date.now());
        }
      }
      this.recordEvent({
        timestamp: new Date().toISOString(),
        key: "settings.json",
        kind: "file-repair-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Unified recovery orchestrator. Computes desired state for ALL Nexus keys,
   * logs forensics, applies in-memory heals (config.update), and writes
   * disk repairs in ONE atomic file write.
   */
  private async recoverAll(trigger: "startup" | "change-event" | "resume"): Promise<void> {
    if (this.disposed) return;

    const plans = this.computeDesiredState();
    const corrupt = plans.filter((p) => p.corrupt);
    if (corrupt.length === 0) return;

    // Forensics (always logged, even when disabled/paused)
    for (const plan of corrupt) {
      if (plan.fullKey === SKIP_SHELL_FULL && plan.skipShellAssessment) {
        const a = plan.skipShellAssessment;
        const shadow = sanitizeShadow(this.context.globalState.get(SHADOW_KEY));
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key: SKIP_SHELL_FULL,
          scope: a.scope,
          kind: "external-strip",
          detail: a.classification,
          before: renderValue(shadow?.values?.[a.scope]),
          after: renderValue(plan.corruptGlobalValue),
          ...(trigger !== "startup" ? { focused: vscode.window.state.focused } : {}),
        });
      } else {
        this.recordEvent({
          timestamp: new Date().toISOString(),
          key: plan.fullKey,
          scope: "global",
          kind: "external-strip",
          detail: trigger === "startup" ? "found-at-startup" : "corrupt-value",
          before: renderValue(plan.corruptGlobalValue),
          ...(trigger !== "startup" ? { focused: vscode.window.state.focused } : {}),
        });
      }
    }

    if (!this.isEnabled() || this.paused) return;

    const pauseReason = evaluateRateLimit(this.restoreTimestamps, Date.now());
    if (pauseReason) {
      this.pause(pauseReason);
      return;
    }

    // --- Disk repair FIRST (one write for all corrupt keys) ---
    const first = corrupt[0];
    const fileRepaired = await this.repairNexusKeysOnDisk(
      corrupt.map((p) => p.edit),
      corrupt.map((p) => ({ fullKey: p.fullKey, expectedEffective: p.expectedEffective })),
      first.fullKey,
      first.corruptGlobalValue,
      trigger
    );

    // --- In-memory heals (config.update) ---
    const succeeded: KeyRepairPlan[] = [];
    const skipShellRestores: ScopeAssessment[] = [];
    for (const plan of corrupt) {
      const dot = plan.fullKey.lastIndexOf(".");
      const config = vscode.workspace.getConfiguration(plan.fullKey.slice(0, dot));
      const leaf = plan.fullKey.slice(dot + 1);

      if (plan.fullKey === SKIP_SHELL_FULL && plan.skipShellAssessment) {
        // Skip-shell uses ownWrites record for in-memory classification
        this.ownWrites.global = plan.inMemoryValue as string[];
        try {
          await config.update(leaf, plan.inMemoryValue, vscode.ConfigurationTarget.Global);
          this.recordEvent({
            timestamp: new Date().toISOString(),
            key: SKIP_SHELL_FULL,
            scope: "global",
            kind: "restore",
            after: renderValue(plan.inMemoryValue),
          });
          succeeded.push(plan);
          skipShellRestores.push(plan.skipShellAssessment);
        } catch (err) {
          this.ownWrites.global = null;
          this.recordEvent({
            timestamp: new Date().toISOString(),
            key: SKIP_SHELL_FULL,
            scope: "global",
            kind: "restore-failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // Watched keys
        try {
          recordNexusConfigWrite(plan.fullKey, plan.expectedEffective, Date.now());
          await config.update(leaf, plan.inMemoryValue, vscode.ConfigurationTarget.Global);
          this.recordEvent({
            timestamp: new Date().toISOString(),
            key: plan.fullKey,
            scope: "global",
            kind: "restore",
            detail: plan.inMemoryValue !== undefined ? "restored-from-shadow" : "removed-corrupt-key",
            after: renderValue(plan.inMemoryValue),
          });
          succeeded.push(plan);
        } catch (err) {
          consumeNexusConfigWrite(plan.fullKey, plan.expectedEffective, Date.now());
          this.recordEvent({
            timestamp: new Date().toISOString(),
            key: plan.fullKey,
            scope: "global",
            kind: "restore-failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (!fileRepaired && succeeded.length === 0) return;
    this.restoreTimestamps.push(Date.now());

    // Show restore toast
    const skipShellCurrent: Record<GuardScope, unknown> = {
      global: vscode.workspace.getConfiguration(SKIP_SHELL_SECTION).inspect<string[]>(SKIP_SHELL_LEAF)?.globalValue,
      workspace: undefined,
      workspaceFolder: undefined,
    };
    // Use corrupt values as preValues (what was there before)
    const preValues: Record<GuardScope, unknown> = {
      global: corrupt.find((p) => p.fullKey === SKIP_SHELL_FULL)?.corruptGlobalValue,
      workspace: undefined,
      workspaceFolder: undefined,
    };
    this.showRestoreToast(skipShellRestores, preValues.global !== undefined ? preValues as Record<GuardScope, unknown> : skipShellCurrent);
  }

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    let needsRecovery = false;

    if (e.affectsConfiguration(SKIP_SHELL_FULL)) {
      needsRecovery = true;
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
        // own-write: still check if there's something to capture (healthy after own write)
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

      if (healable) {
        needsRecovery = true;
      }
    }

    if (needsRecovery) {
      this.enqueueCheck(() => this.recoverAll("change-event"));
    }
  }

  private enqueueCheck(fn: () => Promise<void>): void {
    this.checkChain = this.checkChain.then(() => fn()).catch(() => undefined);
  }

  private showRestoreToast(
    restores: ScopeAssessment[],
    preValues: Record<GuardScope, unknown>
  ): void {
    const buttons: string[] = restores.length > 0
      ? ["Undo", "Disable Guard", "Show Report"]
      : ["Disable Guard", "Show Report"];
    void vscode.window
      .showWarningMessage(
        "Nexus restored terminal settings modified by an external program.",
        ...buttons
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
        : undefined;
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
    this.enqueueCheck(() => this.recoverAll("resume")); // repair immediately if settings are still corrupt
  }

  private recordEvent(event: GuardEvent): void {
    if (this.disposed) return;
    this.eventLog = appendEvent(this.eventLog, event);
    void this.context.globalState.update(EVENT_LOG_KEY, this.eventLog);
    this.output.appendLine(formatEventLine(event));
  }
}
