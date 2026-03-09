import * as vscode from "vscode";
import { createAnsiRegex } from "../utils/ansi";
import { clamp } from "../utils/helpers";
import type { TerminalMacro } from "../models/terminalMacro";

const MAX_INPUT_LENGTH = 8192;
const MAX_BUFFER_LENGTH = 2048;
export const DEFAULT_TRIGGER_COOLDOWN = 3;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export interface PtyOutputObserver {
  onOutput(text: string): void;
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
  macroIndex: number;
}

interface ObserverState {
  evaluate(): void;
  prune(activeRules: ReadonlyMap<number, CompiledTriggerRule>): void;
  dispose(): void;
}

export class MacroAutoTrigger {
  private rules: CompiledTriggerRule[] = [];
  private enabled = true;
  private defaultCooldownMs = DEFAULT_TRIGGER_COOLDOWN * 1000;
  private maxBufferLength = MAX_BUFFER_LENGTH;
  private readonly defaultDisabledIndexes = new Set<number>();
  private readonly disabledIndexes = new Set<number>();
  private readonly enabledIndexes = new Set<number>();
  private readonly observers = new Set<ObserverState>();

  public constructor() {
    this.reload();
  }

  public reload(): void {
    const macroConfig = vscode.workspace.getConfiguration("nexus.terminal");
    const macros = macroConfig.get<TerminalMacro[]>("macros", []);
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
    this.defaultDisabledIndexes.clear();
    const activeRules = new Map<number, CompiledTriggerRule>();
    for (const [macroIndex, macro] of macros.entries()) {
      if (!macro.triggerPattern) continue;
      if (macro.triggerInitiallyDisabled) {
        this.defaultDisabledIndexes.add(macroIndex);
      }
      try {
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
          macroIndex
        };
        this.rules.push(rule);
        activeRules.set(macroIndex, rule);
      } catch {
        // Invalid regex — skip silently
      }
    }
    this.pruneState(macros.length);
    this.pruneObservers(activeRules);
    this.reevaluateObservers();
  }

  public setDisabled(macroIndex: number, disabled: boolean): void {
    if (this.defaultDisabledIndexes.has(macroIndex)) {
      if (disabled) {
        this.enabledIndexes.delete(macroIndex);
      } else {
        this.enabledIndexes.add(macroIndex);
      }
    } else {
      if (disabled) {
        this.disabledIndexes.add(macroIndex);
      } else {
        this.disabledIndexes.delete(macroIndex);
      }
    }

    if (!disabled) {
      this.reevaluateObservers();
    }
  }

  public isDisabled(macroIndex: number): boolean {
    if (this.defaultDisabledIndexes.has(macroIndex)) {
      return !this.enabledIndexes.has(macroIndex);
    }
    return this.disabledIndexes.has(macroIndex);
  }

  public createObserver(
    writeBack: (text: string) => void,
    isActive?: () => boolean
  ): PtyOutputObserver {
    let buffer = "";
    const lastFired = new Map<number, number>();
    const readyMatches = new Set<number>();
    const scheduledTimers = new Map<number, ReturnType<typeof setTimeout>>();
    // Tracks which interval macros have been armed on this observer.
    // An interval cycle only starts when the observer is active (focused)
    // and then keeps running regardless of subsequent focus changes.
    const armedIntervals = new Set<number>();
    let disposed = false;
    const ansiRe = createAnsiRegex();

    const clearScheduledTimer = (macroIndex: number): void => {
      const timer = scheduledTimers.get(macroIndex);
      if (timer !== undefined) {
        clearTimeout(timer);
        scheduledTimers.delete(macroIndex);
      }
    };

    const clearReadyMatch = (macroIndex: number): void => {
      readyMatches.delete(macroIndex);
      clearScheduledTimer(macroIndex);
    };

    const clearAllTimers = (): void => {
      for (const timer of scheduledTimers.values()) {
        clearTimeout(timer);
      }
      scheduledTimers.clear();
    };

    const getRemainingDelay = (rule: CompiledTriggerRule, now: number): number => {
      const lastTime = lastFired.get(rule.macroIndex);
      if (lastTime === undefined) {
        return 0;
      }
      if (rule.intervalMs !== undefined) {
        return Math.max(0, lastTime + rule.intervalMs - now);
      }
      return Math.max(0, lastTime + rule.cooldownMs - now);
    };

    const scheduleEvaluation = (rule: CompiledTriggerRule, delayMs: number): void => {
      clearScheduledTimer(rule.macroIndex);
      scheduledTimers.set(
        rule.macroIndex,
        setTimeout(() => {
          scheduledTimers.delete(rule.macroIndex);
          if (!disposed) {
            evaluate();
          }
        }, Math.max(0, delayMs))
      );
    };

    const fireRule = (rule: CompiledTriggerRule, now: number): void => {
      lastFired.set(rule.macroIndex, now);
      clearReadyMatch(rule.macroIndex);

      // Interval-driven macros should not keep stale prompt text after firing.
      if (rule.intervalMs !== undefined) {
        buffer = "";
      }

      const macroText = rule.macroText;
      setTimeout(() => {
        if (!disposed) writeBack(macroText);
      }, 0);
    };

    const evaluate = (): void => {
      if (disposed || !this.enabled || this.rules.length === 0) return;

      const active = !isActive || isActive();
      const now = Date.now();
      for (const rule of this.rules) {
        if (this.isDisabled(rule.macroIndex)) {
          // Clean up armed state for disabled macros.
          if (armedIntervals.delete(rule.macroIndex)) {
            clearReadyMatch(rule.macroIndex);
          }
          continue;
        }
        if (readyMatches.has(rule.macroIndex)) {
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
        rule.regex.lastIndex = 0;
        const match = rule.regex.exec(buffer);
        if (!match) continue;

        if (rule.intervalMs !== undefined && !armedIntervals.has(rule.macroIndex)) {
          // Only start a new interval cycle on the focused terminal.
          // Don't consume the buffer so the match is available when the
          // observer becomes active later.
          if (!active) continue;
          armedIntervals.add(rule.macroIndex);
        }

        // Truncate buffer past the match to prevent re-triggering
        // on same text — even when cooldown blocks the fire.
        buffer = buffer.slice(match.index + match[0].length);

        if (rule.intervalMs !== undefined) {
          readyMatches.add(rule.macroIndex);
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
        for (const macroIndex of [...lastFired.keys()]) {
          if (!activeRules.has(macroIndex)) {
            lastFired.delete(macroIndex);
          }
        }
        for (const macroIndex of [...readyMatches]) {
          if (activeRules.get(macroIndex)?.intervalMs === undefined) {
            clearReadyMatch(macroIndex);
          }
        }
        for (const macroIndex of [...armedIntervals]) {
          if (!activeRules.has(macroIndex)) {
            armedIntervals.delete(macroIndex);
          }
        }
        clearAllTimers();
      },
      dispose: () => {
        disposed = true;
        buffer = "";
        lastFired.clear();
        readyMatches.clear();
        armedIntervals.clear();
        clearAllTimers();
        this.observers.delete(observerState);
      }
    };
    this.observers.add(observerState);

    return {
      onOutput: (text: string) => {
        if (disposed || !this.enabled || this.rules.length === 0) return;

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
      dispose: () => observerState.dispose()
    };
  }

  private pruneState(macroCount: number): void {
    for (const index of [...this.disabledIndexes]) {
      if (index >= macroCount || this.defaultDisabledIndexes.has(index)) {
        this.disabledIndexes.delete(index);
      }
    }
    for (const index of [...this.enabledIndexes]) {
      if (index >= macroCount || !this.defaultDisabledIndexes.has(index)) {
        this.enabledIndexes.delete(index);
      }
    }
  }

  private pruneObservers(activeRules: ReadonlyMap<number, CompiledTriggerRule>): void {
    for (const observer of this.observers) {
      observer.prune(activeRules);
    }
  }

  public reevaluate(): void {
    this.reevaluateObservers();
  }

  private reevaluateObservers(): void {
    if (!this.enabled || this.rules.length === 0) {
      return;
    }
    for (const observer of this.observers) {
      observer.evaluate();
    }
  }
}
