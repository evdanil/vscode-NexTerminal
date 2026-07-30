import * as vscode from "vscode";
import { createAnsiRegex } from "../utils/ansi";
import { clamp } from "../utils/helpers";
import { validateRegexSafety } from "../utils/regexSafety";
import type { MacroTriggerScope, TerminalMacro } from "../models/terminalMacro";
import type { ScriptMacroFilter } from "./scripts/scriptMacroFilter";
import { getMacros } from "../macroSettings";

const MAX_INPUT_LENGTH = 8192;
const MAX_BUFFER_LENGTH = 2048;
export const DEFAULT_TRIGGER_COOLDOWN = 3;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const VALID_TRIGGER_SCOPES = new Set<MacroTriggerScope>(["all-terminals", "active-session", "profile"]);

/**
 * Stable per-macro identity for every state map in this file (pause/resume,
 * interval ownership, cooldown/scheduling timers). Keying by array position
 * instead of this would attach that state to a *slot*: `nexus.macro.moveUp` /
 * `moveDown` (macroCommands.ts) swap two array elements in place, and
 * `nexus.macro.remove` splices — either one silently reattaches a
 * paused/armed state to whatever macro now occupies the old slot, instead of
 * following the macro it actually belonged to. That is the bug this key
 * exists to close: a user-paused secret-password trigger could go live after
 * an unrelated reorder, while an unrelated active trigger silently paused.
 *
 * Mirrors `macroIdentityKey()` in commands/macroVariablePrompt.ts. `id` is
 * optional on `TerminalMacro` (legacy imports; `InMemoryMacroStore` and tests
 * may omit it) even though `VscodeMacroStore` guarantees one in production, so
 * the name+text composite is the fallback — it is stable across reordering,
 * which is the property that matters here (an index fallback would
 * reintroduce the exact bug). The separator below MUST be the NUL escape
 * sequence (four hex digits after `u`), never an actual NUL byte typed into
 * this source file, or the file becomes binary to git.
 *
 * Two id-less macros with identical name AND text collide on this key by
 * design — see the "collide by design" test in macroAutoTrigger.test.ts.
 */
export function macroStateKey(macro: TerminalMacro): string {
  return macro.id ? `id:${macro.id}` : `anon:${macro.name}\u0000${macro.text}`;
}

export interface PtyOutputObserver {
  onOutput(text: string): void;
  pauseIntervalMacros(): void;
  dispose(): void;
}

function clampSeconds(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function clampLength(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(Math.floor(value), min, max) : fallback;
}

interface CompiledTriggerRule {
  regex: RegExp;
  macroText: string;
  cooldownMs: number;
  intervalMs?: number;
  stateKey: string;
  name: string;
  triggerScope?: MacroTriggerScope;
  triggerProfileId?: string;
}

interface ObserverState {
  evaluate(): void;
  prune(activeRules: ReadonlyMap<string, CompiledTriggerRule>): void;
  clearIntervalState(stateKey: string): boolean;
  dispose(): void;
}

export class MacroAutoTrigger implements vscode.Disposable {
  private rules: CompiledTriggerRule[] = [];
  private rulesByKey = new Map<string, CompiledTriggerRule>();
  private enabled = true;
  private defaultCooldownMs = DEFAULT_TRIGGER_COOLDOWN * 1000;
  private maxBufferLength = MAX_BUFFER_LENGTH;
  private readonly defaultDisabledKeys = new Set<string>();
  private readonly disabledKeys = new Set<string>();
  private readonly enabledKeys = new Set<string>();
  private readonly observers = new Set<ObserverState>();
  private readonly intervalOwners = new Map<string, ObserverState>();
  private readonly observersBySession = new Map<string, ObserverState>();
  private readonly filterStacks = new Map<string, ScriptMacroFilter[]>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private disposed = false;

  public readonly onDidChange: vscode.Event<void> = this.onDidChangeEmitter.event;

  public constructor() {
    this.reload();
  }

  public reload(): void {
    const previousIntervalKeys = new Set(
      this.rules.filter((rule) => rule.intervalMs !== undefined).map((rule) => rule.stateKey)
    );
    const macros = getMacros();
    const macrosConfig = vscode.workspace.getConfiguration("nexus.terminal.macros");
    this.enabled = macrosConfig.get<boolean>("autoTrigger", true);
    this.defaultCooldownMs = clampSeconds(
      macrosConfig.get<number>("defaultCooldown", DEFAULT_TRIGGER_COOLDOWN),
      DEFAULT_TRIGGER_COOLDOWN,
      0,
      300
    ) * 1000;
    this.maxBufferLength = clampLength(
      macrosConfig.get<number>("bufferLength", MAX_BUFFER_LENGTH),
      MAX_BUFFER_LENGTH,
      256,
      16384
    );

    this.rules = [];
    this.rulesByKey = new Map();
    this.defaultDisabledKeys.clear();
    const activeRules = new Map<string, CompiledTriggerRule>();
    for (const macro of macros) {
      if (!macro.triggerPattern) continue;
      // §6.1 — variables and auto-trigger are mutually exclusive. Untrusted shape
      // guard per §4.2 (Array.isArray + length, not `?.length`); MUST be an in-loop
      // `continue` at this exact position — before `defaultDisabledKeys` is
      // populated below — so a macro that declares both `variables` and
      // `triggerInitiallyDisabled` never gets a default-disabled entry recorded
      // for a rule that will never compile (it should behave as if it is not a
      // trigger macro at all). State here is keyed by `macroStateKey(macro)` — a
      // stable per-macro identity, not array position — so pre-filtering `macros`
      // before this loop would no longer corrupt keying the way it used to; the
      // ordering requirement above is about the mutual-exclusivity semantics, not
      // index integrity.
      if (Array.isArray(macro.variables) && macro.variables.length > 0) continue;
      if (macro.triggerScope !== undefined && !VALID_TRIGGER_SCOPES.has(macro.triggerScope)) continue;
      const stateKey = macroStateKey(macro);
      if (macro.triggerInitiallyDisabled) {
        this.defaultDisabledKeys.add(stateKey);
      }
      try {
        if (!validateRegexSafety(macro.triggerPattern).ok) {
          continue;
        }
        const regex = new RegExp(macro.triggerPattern);
        if (regex.test("")) continue;
        const rule: CompiledTriggerRule = {
          regex,
          macroText: macro.text,
          cooldownMs: macro.triggerCooldown != null
            ? clampSeconds(macro.triggerCooldown, DEFAULT_TRIGGER_COOLDOWN, 0, 300) * 1000
            : this.defaultCooldownMs,
          intervalMs:
            typeof macro.triggerInterval === "number" && macro.triggerInterval > 0
              ? macro.triggerInterval * 1000
              : undefined,
          stateKey,
          name: macro.name,
          triggerScope: macro.triggerScope,
          triggerProfileId: macro.triggerProfileId
        };
        this.rules.push(rule);
        this.rulesByKey.set(stateKey, rule);
        activeRules.set(stateKey, rule);
      } catch {
        // Invalid regex — skip silently
      }
    }
    this.pruneState(macros);
    this.pruneObservers(activeRules);
    for (const stateKey of previousIntervalKeys) {
      const nextRule = activeRules.get(stateKey);
      if (!nextRule || nextRule.intervalMs === undefined || this.isDisabledByKey(stateKey)) {
        this.clearIntervalState(stateKey);
      }
    }
    for (const rule of this.rules) {
      if (rule.intervalMs !== undefined && this.isDisabledByKey(rule.stateKey)) {
        this.clearIntervalState(rule.stateKey);
      }
    }
    this.reevaluateObservers();
  }

  public setDisabled(macro: TerminalMacro, disabled: boolean): void {
    const stateKey = macroStateKey(macro);
    const disabledChanged = this.updateDisabledState(stateKey, disabled);
    const intervalRule = this.rulesByKey.get(stateKey);
    const intervalChanged =
      disabled && intervalRule?.intervalMs !== undefined
        ? this.clearIntervalState(stateKey)
        : false;

    if (!disabled) {
      this.reevaluateObservers();
    }
    if (disabledChanged || intervalChanged) {
      this.emitDidChange();
    }
  }

  public isDisabled(macro: TerminalMacro): boolean {
    return this.isDisabledByKey(macroStateKey(macro));
  }

  private isDisabledByKey(stateKey: string): boolean {
    if (this.defaultDisabledKeys.has(stateKey)) {
      return !this.enabledKeys.has(stateKey);
    }
    return this.disabledKeys.has(stateKey);
  }

  public pushFilter(sessionId: string, filter: ScriptMacroFilter): vscode.Disposable {
    const stack = this.filterStacks.get(sessionId) ?? [];
    stack.push(filter);
    this.filterStacks.set(sessionId, stack);
    return new vscode.Disposable(() => {
      const current = this.filterStacks.get(sessionId);
      if (!current) return;
      const idx = current.lastIndexOf(filter);
      if (idx === -1) return;
      current.splice(idx, 1);
      if (current.length === 0) this.filterStacks.delete(sessionId);
    });
  }

  private isMacroAllowedForSession(sessionId: string | undefined, stateKey: string): boolean {
    if (!sessionId) return true;
    const stack = this.filterStacks.get(sessionId);
    if (!stack || stack.length === 0) return true;
    const filter = stack[stack.length - 1];
    const macroName = this.rulesByKey.get(stateKey)?.name;
    if (macroName === undefined) return true;
    return filter.isAllowed(macroName);
  }

  /**
   * Retroactively associate an observer with a sessionId after the session opens.
   * Enables session-scoped macro filters (pushFilter) for SSH / Serial sessions whose
   * sessionIds are only known after the transport negotiates.
   */
  public bindObserverToSession(observer: PtyOutputObserver, sessionId: string): void {
    const bindFn = (observer as PtyOutputObserver & { __bindSessionId?: (id: string) => void }).__bindSessionId;
    bindFn?.(sessionId);
  }

  public createObserver(
    writeBack: (text: string) => void,
    isActive?: () => boolean,
    sessionId?: string,
    profileId?: string
  ): PtyOutputObserver {
    let boundSessionId = sessionId;
    let buffer = "";
    const lastFired = new Map<string, number>();
    const readyMatches = new Set<string>();
    const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const ownedIntervals = new Set<string>();
    let disposed = false;
    const ansiRe = createAnsiRegex();

    const clearScheduledTimer = (stateKey: string): boolean => {
      const timer = scheduledTimers.get(stateKey);
      if (timer === undefined) {
        return false;
      }
      clearTimeout(timer);
      scheduledTimers.delete(stateKey);
      return true;
    };

    const clearReadyMatch = (stateKey: string): boolean => {
      const removed = readyMatches.delete(stateKey);
      return clearScheduledTimer(stateKey) || removed;
    };

    const clearAllTimers = (): void => {
      for (const timer of scheduledTimers.values()) {
        clearTimeout(timer);
      }
      scheduledTimers.clear();
    };

    const clearIntervalState = (stateKey: string): boolean => {
      const clearedOwnership = ownedIntervals.delete(stateKey);
      const clearedLastFired = lastFired.delete(stateKey);
      const clearedReady = clearReadyMatch(stateKey);
      return clearedOwnership || clearedLastFired || clearedReady;
    };

    const getRemainingDelay = (rule: CompiledTriggerRule, now: number): number => {
      const lastTime = lastFired.get(rule.stateKey);
      if (lastTime === undefined) {
        return 0;
      }
      if (rule.intervalMs !== undefined) {
        return Math.max(0, lastTime + rule.intervalMs - now);
      }
      return Math.max(0, lastTime + rule.cooldownMs - now);
    };

    const scheduleEvaluation = (rule: CompiledTriggerRule, delayMs: number): void => {
      clearScheduledTimer(rule.stateKey);
      scheduledTimers.set(
        rule.stateKey,
        setTimeout(() => {
          scheduledTimers.delete(rule.stateKey);
          if (!disposed) {
            evaluate();
          }
        }, Math.max(0, delayMs))
      );
    };

    const fireRule = (rule: CompiledTriggerRule, now: number): void => {
      lastFired.set(rule.stateKey, now);
      clearReadyMatch(rule.stateKey);

      if (rule.intervalMs !== undefined) {
        buffer = "";
      }

      const macroText = rule.macroText;
      setTimeout(() => {
        if (disposed) {
          return;
        }
        if (
          rule.intervalMs !== undefined &&
          (this.isDisabledByKey(rule.stateKey) || this.intervalOwners.get(rule.stateKey) !== observerState)
        ) {
          return;
        }
        writeBack(macroText);
      }, 0);
    };

    const evaluate = (): void => {
      if (disposed || !this.enabled || this.rules.length === 0) {
        return;
      }

      const active = !isActive || isActive();
      const now = Date.now();
      for (const rule of this.rules) {
        if (rule.triggerScope === "active-session" && !active) {
          continue;
        }
        if (rule.triggerScope === "profile" && (!rule.triggerProfileId || rule.triggerProfileId !== profileId)) {
          continue;
        }
        if (!this.isMacroAllowedForSession(boundSessionId, rule.stateKey)) {
          continue;
        }
        if (this.isDisabledByKey(rule.stateKey)) {
          if (rule.intervalMs !== undefined) {
            clearIntervalState(rule.stateKey);
          }
          continue;
        }
        if (rule.intervalMs !== undefined) {
          const owner = this.intervalOwners.get(rule.stateKey);
          if (owner && owner !== observerState) {
            continue;
          }
          if (readyMatches.has(rule.stateKey)) {
          // Interval cycle already running on this observer — continue it
          // regardless of focus.
          const remaining = getRemainingDelay(rule, now);
          if (remaining > 0) {
            scheduleEvaluation(rule, remaining);
            // Don't block other rules while waiting for interval.
            continue;
          }
          fireRule(rule, now);
          break;
        }
        }
        rule.regex.lastIndex = 0;
        const match = rule.regex.exec(buffer);
        if (!match) continue;

        if (rule.intervalMs !== undefined) {
          const owner = this.intervalOwners.get(rule.stateKey);
          if (!owner) {
            if (!active) continue;
            this.intervalOwners.set(rule.stateKey, observerState);
            ownedIntervals.add(rule.stateKey);
          }
        }

        // Truncate buffer past the match to prevent re-triggering
        // on same text — even when cooldown blocks the fire.
        buffer = buffer.slice(match.index + match[0].length);

        if (rule.intervalMs !== undefined) {
          readyMatches.add(rule.stateKey);
          const remaining = getRemainingDelay(rule, now);
          if (remaining > 0) {
            scheduleEvaluation(rule, remaining);
            continue;
          }
          fireRule(rule, now);
          break;
        }

        // Non-interval rules (e.g. password prompts) fire on any terminal.
        const remaining = getRemainingDelay(rule, now);
        if (remaining > 0) continue;

        fireRule(rule, now);
        break;
      }
    };

    const observerState: ObserverState = {
      evaluate,
      prune: (activeRules) => {
        for (const stateKey of [...lastFired.keys()]) {
          if (!activeRules.has(stateKey)) {
            lastFired.delete(stateKey);
          }
        }
        for (const stateKey of [...readyMatches]) {
          if (activeRules.get(stateKey)?.intervalMs === undefined) {
            clearIntervalState(stateKey);
          }
        }
        for (const stateKey of [...ownedIntervals]) {
          if (activeRules.get(stateKey)?.intervalMs === undefined) {
            clearIntervalState(stateKey);
          }
        }
        clearAllTimers();
      },
      clearIntervalState,
      dispose: () => {
        this.pauseOwnedIntervals(observerState);
        disposed = true;
        buffer = "";
        lastFired.clear();
        readyMatches.clear();
        ownedIntervals.clear();
        clearAllTimers();
        this.observers.delete(observerState);
        if (boundSessionId && this.observersBySession.get(boundSessionId) === observerState) {
          this.observersBySession.delete(boundSessionId);
        }
      }
    };
    this.observers.add(observerState);
    if (boundSessionId) this.observersBySession.set(boundSessionId, observerState);

    const observer: PtyOutputObserver & { __bindSessionId?: (id: string) => void } = {
      onOutput: (text: string) => {
        if (disposed || !this.enabled || this.rules.length === 0) {
          return;
        }

        // Keep the tail of oversized output chunks so prompts arriving with
        // banners/login noise can still be matched without scanning unbounded text.
        if (text.length > MAX_INPUT_LENGTH) {
          text = text.slice(text.length - MAX_INPUT_LENGTH);
        }

        let stripped = text.replace(ansiRe, "");
        stripped = stripped.replace(CONTROL_CHARS_RE, "");

        buffer += stripped;
        if (buffer.length > this.maxBufferLength) {
          buffer = buffer.slice(buffer.length - this.maxBufferLength);
        }
        evaluate();
      },
      pauseIntervalMacros: () => {
        if (!disposed) {
          this.pauseOwnedIntervals(observerState);
        }
      },
      dispose: () => observerState.dispose()
    };
    observer.__bindSessionId = (id: string) => {
      if (boundSessionId && this.observersBySession.get(boundSessionId) === observerState) {
        this.observersBySession.delete(boundSessionId);
      }
      boundSessionId = id;
      this.observersBySession.set(id, observerState);
    };
    return observer;
  }

  /**
   * Prunes pause/resume state keyed to macros that no longer exist in the
   * current macro set. Contract: a key survives only if some macro currently
   * in `macros` still resolves to it via `macroStateKey()` — position is
   * irrelevant. `disabledKeys` additionally drops any key that has become
   * default-disabled (it is now tracked via `enabledKeys` instead), and
   * `enabledKeys` drops any key that is no longer default-disabled (now
   * tracked via `disabledKeys` instead) — mirroring the mutual exclusivity
   * `updateDisabledState()`/`isDisabledByKey()` rely on.
   */
  private pruneState(macros: readonly TerminalMacro[]): void {
    const currentKeys = new Set(macros.map((macro) => macroStateKey(macro)));
    for (const key of [...this.disabledKeys]) {
      if (!currentKeys.has(key) || this.defaultDisabledKeys.has(key)) {
        this.disabledKeys.delete(key);
      }
    }
    for (const key of [...this.enabledKeys]) {
      if (!currentKeys.has(key) || !this.defaultDisabledKeys.has(key)) {
        this.enabledKeys.delete(key);
      }
    }
  }

  private pruneObservers(activeRules: ReadonlyMap<string, CompiledTriggerRule>): void {
    for (const observer of this.observers) {
      observer.prune(activeRules);
    }
  }

  public reevaluate(): void {
    this.reevaluateObservers();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const observer of [...this.observers]) {
      observer.dispose();
    }
    this.intervalOwners.clear();
    this.onDidChangeEmitter.dispose();
  }

  private reevaluateObservers(): void {
    if (!this.enabled || this.rules.length === 0) {
      return;
    }
    for (const observer of this.observers) {
      observer.evaluate();
    }
  }

  private updateDisabledState(stateKey: string, disabled: boolean): boolean {
    const wasDisabled = this.isDisabledByKey(stateKey);
    if (this.defaultDisabledKeys.has(stateKey)) {
      if (disabled) {
        this.enabledKeys.delete(stateKey);
      } else {
        this.enabledKeys.add(stateKey);
      }
    } else {
      if (disabled) {
        this.disabledKeys.add(stateKey);
      } else {
        this.disabledKeys.delete(stateKey);
      }
    }
    return wasDisabled !== this.isDisabledByKey(stateKey);
  }

  private clearIntervalState(stateKey: string): boolean {
    let changed = this.intervalOwners.delete(stateKey);
    for (const observer of this.observers) {
      changed = observer.clearIntervalState(stateKey) || changed;
    }
    return changed;
  }

  private pauseOwnedIntervals(owner: ObserverState): void {
    let changed = false;
    for (const [stateKey, currentOwner] of [...this.intervalOwners.entries()]) {
      if (currentOwner !== owner) {
        continue;
      }
      changed = this.updateDisabledState(stateKey, true) || changed;
      changed = this.clearIntervalState(stateKey) || changed;
    }
    if (changed) {
      this.emitDidChange();
    }
  }

  private emitDidChange(): void {
    if (!this.disposed) {
      this.onDidChangeEmitter.fire();
    }
  }
}
