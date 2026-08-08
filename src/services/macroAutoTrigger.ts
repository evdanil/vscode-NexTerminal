import * as vscode from "vscode";
import { createAnsiRegex } from "../utils/ansi";
import { clamp } from "../utils/helpers";
import { validateRegexSafety } from "../utils/regexSafety";
import type { MacroTriggerScope, TerminalMacro } from "../models/terminalMacro";
import { resolveMacroRunTarget } from "../models/terminalMacro";
import { hasProfileTokens } from "./profileTokens";
import { hasMacroVariables } from "./macroVariables";
import type { ScriptMacroFilter } from "./scripts/scriptMacroFilter";
import { getMacros } from "../macroSettings";
import {
  DEFAULT_TRIGGER_COOLDOWN,
  VALID_MACRO_TRIGGER_SCOPES,
  compiledTriggerCooldownSeconds,
  compiledTriggerIntervalSeconds
} from "../storage/macroStore";

const MAX_INPUT_LENGTH = 8192;
const MAX_BUFFER_LENGTH = 2048;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
// Both defined in storage/macroStore.ts, alongside the content keys and the import sanitizer that
// have to agree with what this file compiles. `DEFAULT_TRIGGER_COOLDOWN` is re-exported because
// that is where its existing consumer imports it from.
export { DEFAULT_TRIGGER_COOLDOWN };

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
 * Guards with `typeof macro.id === "string" && macro.id.length > 0` rather than a
 * bare truthy/`.length` check on `macro.id`: a corrupt import can hand this a
 * non-string `id` (e.g. `{length: 1}`), which is truthy and has a positive
 * `.length` yet is not the string MacroStore's uniqueness invariant actually
 * guarantees. Two such distinct objects would both stringify to the same
 * `id:[object Object]` key here despite never having been deduped as equal
 * anywhere upstream — exactly the collision this key exists to prevent.
 *
 * This key is NOT guaranteed unique across an arbitrary macro set. `MacroStore.save()`
 * enforces uniqueness on the way in, but a set already sitting in globalState from
 * before that invariant existed (or one that never went through a store at all) can
 * hold two macros that resolve to the same key: a shared `id`, or — via the fallback
 * below — two id-less macros with identical name AND text. When that happens the key
 * is ambiguous and no per-macro state may be recorded or acted upon under it. See
 * `findAmbiguousMacroStateKeys()`.
 */
export function macroStateKey(macro: TerminalMacro): string {
  return typeof macro.id === "string" && macro.id.length > 0 ? `id:${macro.id}` : `anon:${macro.name}\u0000${macro.text}`;
}

/**
 * Returns every `macroStateKey()` that MORE THAN ONE macro in `macros` resolves to.
 *
 * Why ambiguity is resolved here rather than repaired at the storage layer: once two
 * macros share an `id`, "which of them owns the single vault entry at
 * `macroSecretKey(id)`" is genuinely unanswerable — pre-invariant duplicate secret
 * saves were last-write-wins, so the stored value may belong to either. Every award
 * heuristic tried in review either handed one macro another macro's password, deleted
 * the only copy of a legitimate secret, or re-derived ownership from array position —
 * which is exactly the positional keying `macroStateKey()` exists to eliminate. So the
 * store no longer guesses: `VscodeMacroStore.reloadFromState()` preserves what is on
 * disk verbatim, and ambiguity is handled HERE, in the only fail-safe direction
 * available. An ambiguous macro compiles no rule, owns no interval and records no
 * pause state — it cannot fire at all, rather than possibly firing the wrong thing.
 *
 * Measured across the WHOLE macro set, not just the trigger-capable subset: every
 * macro claims its key regardless of whether it compiles a rule (`setDisabled()` /
 * `isDisabled()` accept any macro, and `pruneState()` derives key liveness from all of
 * them), so a non-trigger macro sharing a trigger macro's id makes that key just as
 * ambiguous as two trigger macros would.
 *
 * The remedy is a WRITE, never a load-time rewrite: `MacroStore.save()` re-keys
 * duplicates, so opening and saving either colliding macro clears the conflict
 * permanently. `MacroTreeProvider` renders the suppressed state so the macro is never
 * silently broken.
 */
export function findAmbiguousMacroStateKeys(macros: readonly TerminalMacro[]): Set<string> {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const macro of macros) {
    const key = macroStateKey(macro);
    if (seen.has(key)) ambiguous.add(key);
    else seen.add(key);
  }
  return ambiguous;
}

/**
 * Why `reload()` will refuse to compile an auto-trigger rule for a macro that
 * nonetheless declares a `triggerPattern`. `undefined` = nothing per-macro stands
 * in the way.
 */
export type TriggerCompileBlocker = "variables" | "run-target" | "profile-tokens";

/**
 * The PER-MACRO half of "will this trigger ever fire?", factored out of
 * `reload()`'s loop so that `MacroTreeProvider` cannot drift from what actually
 * compiles. The tree used to re-state one of these three rules inline and knew
 * nothing about the other two, so a browser macro (or a session macro naming
 * `${profile.…}`) with a trigger pattern rendered a zap icon and live
 * Pause/Resume items for a rule `reload()` had silently skipped — see §6.3 in
 * ui/macroTreeProvider.ts.
 *
 * These three are exactly `reload()`'s first three in-loop `continue`s and they
 * must stay applied together AT THAT POSITION — before `defaultDisabledKeys` is
 * populated — so a macro that is both un-compilable and `triggerInitiallyDisabled`
 * never records a default-disabled entry for a rule that will never compile (it
 * should behave as if it is not a trigger macro at all). Sharing them as one call
 * preserves that ordering rather than threatening it: the loop still makes the
 * whole decision in one place, before anything is written.
 *
 * Deliberately NOT covered here, and therefore still inline in `reload()`:
 *   - the `triggerScope` validity check — cheap, but a stored-value sanity check
 *     rather than a property of the macro's design;
 *   - the ambiguity check — a property of the WHOLE macro set, not of one macro;
 *     the tree gets it from `findAmbiguousMacroStateKeys()` instead;
 *   - `validateRegexSafety()` / `new RegExp()` / the empty-match test — expensive
 *     enough that a tree repaint should not pay for it once per row.
 * A tree row that survives this predicate can therefore still turn out to compile
 * nothing; the reverse — a row this predicate passes that `reload()` skips for one
 * of the three reasons below — is what it exists to rule out.
 */
export function triggerCompileBlocker(macro: TerminalMacro): TriggerCompileBlocker | undefined {
  // §6.1 — variables and auto-trigger are mutually exclusive. Untrusted shape
  // guard per §4.2 (Array.isArray + length, never `?.length`), which is precisely
  // what `hasMacroVariables()` applies — shared with the tree so the two cannot
  // disagree about what "has variables" means.
  if (hasMacroVariables(macro)) return "variables";
  // A macro that runs somewhere other than its session never auto-fires. The
  // editor already refuses the combination, but legacy-settings absorption
  // persists `nexus.terminal.macros` entries VERBATIM and bypasses that
  // validation entirely (§4.2) — and the failure mode is a browser macro opening
  // a URL, or a local shell command executing, on every line of matching terminal
  // output. Read through `resolveMacroRunTarget()`, which treats a corrupt value
  // as "session" rather than as a reason to suppress a working trigger.
  if (resolveMacroRunTarget(macro) !== "session") return "run-target";
  // The other half of issue #48: a SESSION macro whose text names `${profile.…}`.
  // A compiled rule fires from terminal output, which names no server, so there is
  // nothing to resolve the token against — the rule would send the literal
  // `${profile.host}` to the device. The editor refuses this combination too; this
  // is the guard for records that never went through it.
  if (hasProfileTokens(macro.text)) return "profile-tokens";
  return undefined;
}

/**
 * Does this macro declare an auto-trigger that nothing about the macro ITSELF
 * prevents from compiling? The predicate the sidebar renders live trigger controls
 * from. See `triggerCompileBlocker()` for what it does and does not cover.
 */
export function isCompilableTriggerMacro(macro: TerminalMacro): boolean {
  return !!macro.triggerPattern && triggerCompileBlocker(macro) === undefined;
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
  private ambiguousKeys = new Set<string>();
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
    // Computed over the FULL macro set before anything is compiled — see
    // `findAmbiguousMacroStateKeys()`. Recomputed on every reload rather than cached
    // incrementally: `macros` is the only source of truth for who claims which key.
    this.ambiguousKeys = findAmbiguousMacroStateKeys(macros);
    const activeRules = new Map<string, CompiledTriggerRule>();
    for (const macro of macros) {
      if (!macro.triggerPattern) continue;
      // The three per-macro reasons a trigger never compiles — variables (§6.1),
      // a non-session run target, and `${profile.…}` tokens (both halves of issue
      // #48). Each one's own justification lives on `triggerCompileBlocker()`,
      // which `MacroTreeProvider` calls too so the sidebar cannot render live
      // trigger controls for a rule this loop skipped.
      //
      // MUST stay an in-loop `continue` at this exact position — before
      // `defaultDisabledKeys` is populated below — so a macro that declares both a
      // blocker and `triggerInitiallyDisabled` never gets a default-disabled entry
      // recorded for a rule that will never compile (it should behave as if it is
      // not a trigger macro at all). State here is keyed by `macroStateKey(macro)`
      // — a stable per-macro identity, not array position — so pre-filtering
      // `macros` before this loop would no longer corrupt keying the way it used
      // to; the ordering requirement above is about the mutual-exclusivity
      // semantics, not index integrity.
      if (triggerCompileBlocker(macro) !== undefined) continue;
      if (macro.triggerScope !== undefined && !VALID_MACRO_TRIGGER_SCOPES.has(macro.triggerScope)) continue;
      const stateKey = macroStateKey(macro);
      // Ambiguous identity — two or more macros in this set resolve to `stateKey`, so
      // every per-macro map in this file (pause/resume, interval ownership, cooldown,
      // and the `rulesByKey` lookup that gates script macro filters by NAME) would
      // silently conflate them. Compile nothing: an ambiguous macro must be unable to
      // fire rather than able to fire as, or instead of, its twin.
      //
      // Position matters, exactly as for the §6.1 skip above it: this `continue` must
      // run BEFORE `defaultDisabledKeys` is populated, so a macro that is both
      // ambiguous and `triggerInitiallyDisabled` never records a default-disabled entry
      // for a rule that will never compile. Nothing may be written under an ambiguous
      // key — `setDisabled()` refuses it and `pruneState()` evicts it — because
      // whichever macro keeps the key when the collision is later resolved by a save
      // would otherwise inherit a toggle it never earned.
      if (this.ambiguousKeys.has(stateKey)) continue;
      if (macro.triggerInitiallyDisabled) {
        this.defaultDisabledKeys.add(stateKey);
      }
      try {
        if (!validateRegexSafety(macro.triggerPattern).ok) {
          continue;
        }
        const regex = new RegExp(macro.triggerPattern);
        if (regex.test("")) continue;
        // The single definition of what a stored cooldown/interval MEANS, shared with the two
        // content keys and with `sanitizeImportedMacro()` (storage/macroStore.ts). Identical
        // arithmetic to the inline `clampSeconds(macro.triggerCooldown, DEFAULT, 0, 300) * 1000`
        // it replaces — sharing it is what stops the three readers drifting apart again, which is
        // how a record ended up unable to key-match its own exported copy.
        const cooldownSeconds = compiledTriggerCooldownSeconds(macro.triggerCooldown);
        const intervalSeconds = compiledTriggerIntervalSeconds(macro.triggerInterval);
        const rule: CompiledTriggerRule = {
          regex,
          macroText: macro.text,
          cooldownMs: cooldownSeconds !== undefined ? cooldownSeconds * 1000 : this.defaultCooldownMs,
          intervalMs: intervalSeconds !== undefined ? intervalSeconds * 1000 : undefined,
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
    // Refuse to record anything under an ambiguous key. The macro compiles no rule and
    // cannot fire either way, so nothing is lost — but a toggle stored here would be
    // silently inherited by whichever claimant keeps the key once a later `save()`
    // re-keys the duplicates, handing one macro a pause/resume decision the user made
    // while looking at another. `pruneState()` evicts keys that BECOME ambiguous after
    // being written; this closes the other direction. Unreachable from the UI (the tree
    // renders an ambiguous macro with a plain contextValue, so the Pause/Resume items
    // never appear, and both commands are hidden from the palette) — this is the guard
    // for every other caller.
    if (this.ambiguousKeys.has(stateKey)) return;
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
   * current macro set. Contract: a key survives only if EXACTLY ONE macro
   * currently in `macros` resolves to it via `macroStateKey()` — position is
   * irrelevant. A key claimed by two or more macros is evicted as aggressively
   * as one claimed by none: it compiled no rule (see `reload()`), and leaving a
   * pause/resume decision parked under it would hand that decision to whichever
   * claimant keeps the key when a later `save()` re-keys the duplicates — the
   * macro the user was NOT looking at when they set it. `disabledKeys`
   * additionally drops any key that has become
   * default-disabled (it is now tracked via `enabledKeys` instead), and
   * `enabledKeys` drops any key that is no longer default-disabled (now
   * tracked via `disabledKeys` instead) — mirroring the mutual exclusivity
   * `updateDisabledState()`/`isDisabledByKey()` rely on.
   */
  private pruneState(macros: readonly TerminalMacro[]): void {
    const currentKeys = new Set(
      macros.map((macro) => macroStateKey(macro)).filter((key) => !this.ambiguousKeys.has(key))
    );
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
