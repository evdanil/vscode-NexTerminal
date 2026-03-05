import * as vscode from "vscode";
import { createAnsiRegex } from "../utils/ansi";
import type { TerminalMacro } from "../ui/macroTreeProvider";

const MAX_INPUT_LENGTH = 8192;
const MAX_BUFFER_LENGTH = 2048;
export const DEFAULT_TRIGGER_COOLDOWN = 3;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export interface PtyOutputObserver {
  onOutput(text: string): void;
  dispose(): void;
}

interface CompiledTriggerRule {
  regex: RegExp;
  macroText: string;
  cooldownMs: number;
  macroName: string;
}

export class MacroAutoTrigger {
  private rules: CompiledTriggerRule[] = [];
  private enabled = true;
  private readonly disabledNames = new Set<string>();

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
    for (const macro of macros) {
      if (!macro.triggerPattern) continue;
      try {
        const regex = new RegExp(macro.triggerPattern);
        if (regex.test("")) continue;
        this.rules.push({
          regex,
          macroText: macro.text,
          cooldownMs: (macro.triggerCooldown ?? DEFAULT_TRIGGER_COOLDOWN) * 1000,
          macroName: macro.name
        });
      } catch {
        // Invalid regex — skip silently
      }
    }
  }

  public setDisabled(macroName: string, disabled: boolean): void {
    if (disabled) {
      this.disabledNames.add(macroName);
    } else {
      this.disabledNames.delete(macroName);
    }
  }

  public isDisabled(macroName: string): boolean {
    return this.disabledNames.has(macroName);
  }

  public createObserver(
    writeBack: (text: string) => void
  ): PtyOutputObserver {
    let buffer = "";
    const lastFired = new Map<number, number>();
    let disposed = false;

    return {
      onOutput: (text: string) => {
        if (disposed || !this.enabled || this.rules.length === 0) return;
        if (text.length > MAX_INPUT_LENGTH) return;

        // Strip ANSI sequences
        const ansiRe = createAnsiRegex();
        let stripped = text.replace(ansiRe, "");
        // Strip control chars
        stripped = stripped.replace(CONTROL_CHARS_RE, "");

        buffer += stripped;
        if (buffer.length > MAX_BUFFER_LENGTH) {
          buffer = buffer.slice(buffer.length - MAX_BUFFER_LENGTH);
        }

        const now = Date.now();
        for (let i = 0; i < this.rules.length; i++) {
          const rule = this.rules[i];
          if (this.disabledNames.has(rule.macroName)) continue;
          rule.regex.lastIndex = 0;
          const match = rule.regex.exec(buffer);
          if (!match) continue;

          const lastTime = lastFired.get(i) ?? 0;
          if (now - lastTime < rule.cooldownMs) continue;

          lastFired.set(i, now);
          // Truncate buffer past the match to prevent re-triggering on same text
          buffer = buffer.slice(match.index + match[0].length);
          // Defer writeBack to the next event-loop turn so the stream data
          // handler unwinds before we write back.  Prevents re-entrant writes
          // on the SSH channel that can exhaust the channel window and cause
          // subsequent user keystrokes to be silently dropped.
          const macroText = rule.macroText;
          setTimeout(() => {
            if (!disposed) writeBack(macroText);
          }, 0);
          break; // first-match-wins
        }
      },
      dispose: () => {
        disposed = true;
        buffer = "";
        lastFired.clear();
      }
    };
  }
}
