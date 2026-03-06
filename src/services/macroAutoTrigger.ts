import * as vscode from "vscode";
import { createAnsiRegex } from "../utils/ansi";
import type { TerminalMacro } from "../models/terminalMacro";

const MAX_INPUT_LENGTH = 8192;
const MAX_BUFFER_LENGTH = 2048;
export const DEFAULT_TRIGGER_COOLDOWN = 3;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export interface PtyOutputObserver {
  onOutput(text: string): void;
  dispose(): void;
}

interface CompiledTriggerRule {
  regex: RegExp;
  macroText: string;
  cooldownMs: number;
  macroIndex: number;
}

interface ObserverState {
  evaluate(): void;
  dispose(): void;
}

export class MacroAutoTrigger {
  private rules: CompiledTriggerRule[] = [];
  private enabled = true;
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
    this.enabled = vscode.workspace
      .getConfiguration("nexus.terminal.macros")
      .get<boolean>("autoTrigger", true);

    this.rules = [];
    this.defaultDisabledIndexes.clear();
    for (const [macroIndex, macro] of macros.entries()) {
      if (!macro.triggerPattern) continue;
      if (macro.triggerInitiallyDisabled) {
        this.defaultDisabledIndexes.add(macroIndex);
      }
      try {
        const regex = new RegExp(macro.triggerPattern);
        if (regex.test("")) continue;
        this.rules.push({
          regex,
          macroText: macro.text,
          cooldownMs: (macro.triggerCooldown ?? DEFAULT_TRIGGER_COOLDOWN) * 1000,
          macroIndex
        });
      } catch {
        // Invalid regex — skip silently
      }
    }
    this.pruneState(macros.length);
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
    writeBack: (text: string) => void
  ): PtyOutputObserver {
    let buffer = "";
    const lastFired = new Map<number, number>();
    let disposed = false;
    const ansiRe = createAnsiRegex();

    const evaluate = (): void => {
      if (disposed || !this.enabled || this.rules.length === 0) return;

      const now = Date.now();
      for (let i = 0; i < this.rules.length; i++) {
        const rule = this.rules[i];
        if (this.isDisabled(rule.macroIndex)) continue;
        rule.regex.lastIndex = 0;
        const match = rule.regex.exec(buffer);
        if (!match) continue;

        // Always truncate buffer past the match to prevent re-triggering
        // on same text — even when cooldown blocks the fire.
        buffer = buffer.slice(match.index + match[0].length);

        const lastTime = lastFired.get(i) ?? 0;
        if (now - lastTime < rule.cooldownMs) break;

        lastFired.set(i, now);
        const macroText = rule.macroText;
        // Defer writeBack so the current output handler unwinds before we write.
        setTimeout(() => {
          if (!disposed) writeBack(macroText);
        }, 0);
        break;
      }
    };

    const observerState: ObserverState = {
      evaluate,
      dispose: () => {
        disposed = true;
        buffer = "";
        lastFired.clear();
        this.observers.delete(observerState);
      }
    };
    this.observers.add(observerState);

    return {
      onOutput: (text: string) => {
        if (disposed || !this.enabled || this.rules.length === 0) return;
        if (text.length > MAX_INPUT_LENGTH) return;

        let stripped = text.replace(ansiRe, "");
        stripped = stripped.replace(CONTROL_CHARS_RE, "");

        buffer += stripped;
        if (buffer.length > MAX_BUFFER_LENGTH) {
          buffer = buffer.slice(buffer.length - MAX_BUFFER_LENGTH);
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

  private reevaluateObservers(): void {
    if (!this.enabled || this.rules.length === 0) {
      return;
    }
    for (const observer of this.observers) {
      observer.evaluate();
    }
  }
}
