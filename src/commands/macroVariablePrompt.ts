import * as vscode from "vscode";
import type { MacroVariable, TerminalMacro } from "../models/terminalMacro";
import {
  getValidMacroVariables,
  scanPlaceholders,
  substituteMacroVariables
} from "../services/macroVariables";

/**
 * Runtime flow for prompted macro variables (docs/plans/2026-07-29-macro-variables.md §8).
 *
 * This module owns the ONLY send path that is not same-tick with the user's
 * invocation — everything here exists to make that safe:
 *   - §8.1 the send target is pinned at invocation, never the terminal that
 *     happens to be active when the prompts finally resolve.
 *   - §8.2 a single reused `InputBox` walks the declared-and-used variables in
 *     order, with Back support.
 *   - §8.3 every abort path reports through the status bar, never silently.
 *   - §8.4 re-entrancy is guarded by a module-level in-flight Promise, released
 *     in a `finally` that survives a throwing resolver.
 *   - §7.1 non-secret values are remembered per-window, keyed by macro id —
 *     never for secret variables, never when the macro has no id.
 */

/** In-memory only, window-scoped, lost on reload — §7.1 / §13. Key: `${macro.id}:${varName}`. */
const rememberedValues = new Map<string, string>();

/** Shared empty value map for the "declared but nothing to prompt for" path. */
const EMPTY_VALUES: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

interface InFlightRun {
  key: string;
  macroName: string;
  promise: Promise<void>;
}

let inFlight: InFlightRun | undefined;

/** Releases the re-entrancy guard only if it is still held by `key` — never someone else's. */
function releaseInFlight(key: string): void {
  if (inFlight !== undefined && inFlight.key === key) {
    inFlight = undefined;
  }
}

/** Stable-enough identity for the re-entrancy guard across separate `getMacros()` snapshots. */
function macroIdentityKey(macro: TerminalMacro): string {
  // `typeof` check, not just truthiness: `id` is optional in the type but the
  // value is only array-shape-validated on import, so a non-string can reach here
  // and two distinct macros would both key on `id:[object Object]`. Same hardening
  // as `macroStateKey()` in macroAutoTrigger.ts, for the same reason.
  return typeof macro.id === "string" && macro.id.length > 0
    ? `id:${macro.id}`
    : `anon:${macro.name}\u0000${macro.text}`;
}

function isTerminalStillValid(target: vscode.Terminal): boolean {
  return vscode.window.terminals.includes(target) && target.exitStatus === undefined;
}

/**
 * §8.1's "the send target is pinned at invocation" made explicit, so every
 * caller keeps the invariant instead of each one re-deriving a destination
 * after the prompts have resolved.
 *
 * The prompt walk can take arbitrarily long — the user is typing into a modal
 * input box — and "the terminal that is active when it finishes" is a different
 * question from "the terminal the user aimed this macro at". A target is
 * therefore CHOSEN before the first await, re-checked for validity after the
 * last one, and only then asked to deliver.
 */
export interface MacroSendTarget {
  /** Named in the status-bar confirmation. Never contains the resolved text. */
  readonly description: string;
  /** False once the destination can no longer receive (e.g. its terminal was closed). */
  isStillValid(): boolean;
  /** Delivers the resolved text. `false` means it was NOT delivered and the target already said why. */
  send(text: string): boolean | Promise<boolean>;
}

/** The ordinary target: an existing terminal, pinned by reference. */
export function terminalSendTarget(terminal: vscode.Terminal): MacroSendTarget {
  return {
    description: terminal.name,
    isStillValid: () => isTerminalStillValid(terminal),
    send(text: string): boolean {
      terminal.sendText(text, false);
      return true;
    }
  };
}

type StepOutcome = { kind: "accept"; value: string } | { kind: "back" } | { kind: "cancel" };

function waitForInputBoxStep(box: vscode.InputBox): Promise<StepOutcome> {
  return new Promise<StepOutcome>((resolve) => {
    let settled = false;
    const disposables: vscode.Disposable[] = [];
    const settle = (outcome: StepOutcome): void => {
      if (settled) return;
      settled = true;
      for (const d of disposables) d.dispose();
      resolve(outcome);
    };

    disposables.push(box.onDidAccept(() => settle({ kind: "accept", value: box.value })));
    disposables.push(
      box.onDidTriggerButton((button) => {
        // Any button that is not Back is treated as a cancel rather than ignored:
        // ignoring it would leave this promise pending forever, so `box.dispose()`
        // would never run and the re-entrancy guard would never be released.
        settle(button === vscode.QuickInputButtons.Back ? { kind: "back" } : { kind: "cancel" });
      })
    );
    // Fires on ESC, and on any other dismissal — §8.2: "ESC/hide aborts everything."
    disposables.push(box.onDidHide(() => settle({ kind: "cancel" })));

    box.show();
  });
}

/**
 * Walks `variables` (already filtered to "used, in declaration order") through one
 * reused InputBox. Returns the collected values, or `undefined` if the whole
 * sequence was cancelled (ESC/hide at any step) — §8.2: cancel aborts everything,
 * never a partial send.
 */
async function promptForValues(
  macro: TerminalMacro,
  variables: MacroVariable[]
): Promise<Record<string, string> | undefined> {
  const box = vscode.window.createInputBox();
  box.ignoreFocusOut = true;
  box.title = `Run "${macro.name}"`;

  const entered: Array<string | undefined> = new Array(variables.length).fill(undefined);

  try {
    let step = 0;
    while (step < variables.length) {
      const variable = variables[step];
      const rememberKey = macro.id && !variable.secret ? `${macro.id}:${variable.name}` : undefined;
      const remembered = rememberKey ? rememberedValues.get(rememberKey) : undefined;

      box.step = step + 1;
      box.totalSteps = variables.length;
      box.prompt = variable.label ?? variable.name;
      box.password = !!variable.secret;
      // A masked step never prefills — not from `remembered`/`default` (§7.1) and not
      // from `entered` either: backing into a secret step would otherwise re-seat the
      // previously typed secret in `box.value` and carry it across the remaining steps.
      box.value = variable.secret ? "" : entered[step] ?? remembered ?? variable.default ?? "";
      box.buttons = step > 0 ? [vscode.QuickInputButtons.Back] : [];

      const outcome = await waitForInputBoxStep(box);

      if (outcome.kind === "cancel") {
        return undefined;
      }
      if (outcome.kind === "back") {
        step = Math.max(0, step - 1);
        continue;
      }

      entered[step] = outcome.value;
      if (rememberKey && variable.remember !== false) {
        rememberedValues.set(rememberKey, outcome.value);
      }
      step++;
    }
  } finally {
    box.dispose();
  }

  // Object.create(null), not `{}`: `__proto__` is a legal variable name under
  // MACRO_VARIABLE_NAME_PATTERN, and `values["__proto__"] = "10.0.0.1"` on a normal
  // object literal hits Object.prototype's setter, silently creating no own property —
  // so the user would be prompted and their answer then dropped on the floor.
  const values = Object.create(null) as Record<string, string>;
  variables.forEach((variable, index) => {
    values[variable.name] = entered[index] ?? "";
  });
  return values;
}

/**
 * Resolves a macro's text against its declared variables: scans for which
 * declared placeholders actually appear (§5.3), prompts for those only, then
 * substitutes (§5.2). Returns the ORIGINAL `macro.text` by identity when there is
 * nothing to resolve (§4.1 — no macro without a `variables` array is ever
 * affected), and `undefined` if the prompt sequence was cancelled.
 *
 * Contains no target-pinning or sending — that is `runMacro()`'s job, so this
 * function is directly testable against the prompt/substitution flow alone.
 */
export async function resolveMacroText(macro: TerminalMacro): Promise<string | undefined> {
  const declared = getValidMacroVariables(macro);
  if (declared.length === 0) {
    return macro.text;
  }

  const declaredNames = declared.map((v) => v.name);
  const scan = scanPlaceholders(macro.text, declaredNames);

  // No unescaped use → nothing to prompt for, but a declared name may still appear as
  // `$${name}`, and that escape must still be un-escaped (§5.1). Returning `macro.text`
  // here would make the escape work or not depending on whether some *other* part of
  // the same macro happened to use the name unescaped.
  if (scan.used.length === 0) {
    return substituteMacroVariables(macro.text, EMPTY_VALUES, declaredNames);
  }

  const toPrompt = declared.filter((v) => scan.used.includes(v.name));
  const values = await promptForValues(macro, toPrompt);
  if (values === undefined) {
    return undefined;
  }
  // `declaredNames` is passed separately from `values`: only *used* names were
  // prompted, so a declared-but-escaped-only name has no value yet still needs its
  // escape honoured.
  return substituteMacroVariables(macro.text, values, declaredNames);
}

/**
 * The one entry point for running a macro that declares variables (§8.5) — the
 * four manual run paths in macroCommands.ts route here instead of
 * `sendMacroText()` whenever `hasMacroVariables(macro)` is true. Variable-free
 * macros never reach this module.
 */
export async function runMacro(macro: TerminalMacro): Promise<void> {
  // §8.1 — captured BEFORE the first await, and never re-derived afterward.
  const active = vscode.window.activeTerminal;
  if (!active) {
    vscode.window.setStatusBarMessage("No active terminal — nothing was sent.", 4000);
    return;
  }
  await runMacroWithTarget(macro, terminalSendTarget(active));
}

export interface RunMacroOptions {
  /**
   * A caveat about the text that was delivered, appended to the SUCCESS status
   * only — `nexus.server.runMacro` uses it for "an unknown `${profile.…}` token
   * went out verbatim".
   *
   * REVIEW FINDING (P2) — it is an option here rather than a notice the caller
   * shows itself because the caller cannot know, at the point it has the
   * caveat, whether anything will be delivered at all: the prompt walk, the
   * connect-first confirmation and the browser URL check all abort AFTER it,
   * and a caveat about text that was never sent is noise. Tying it to the
   * delivery report is also what keeps it on screen — a status message shown
   * moments before the success one is simply replaced by it.
   *
   * Lowercase, no trailing period: it is appended as a clause. Never include
   * the resolved text or any entered value.
   */
  readonly deliveryNote?: string;
}

/**
 * The prompt-and-send core `runMacro()` is built on, taking a target the CALLER
 * pinned (see `MacroSendTarget`). Everything §8.2-§8.4 promises — one reused
 * input box, cancel aborts everything, status-bar reporting on every path, one
 * run in flight at a time — is identical whichever target is supplied; only the
 * destination differs. Exported for `nexus.server.runMacro`, whose targets are a
 * specific server's session terminal, a fresh local terminal, or the browser.
 */
export async function runMacroWithTarget(
  macro: TerminalMacro,
  target: MacroSendTarget,
  options: RunMacroOptions = {}
): Promise<void> {
  const key = macroIdentityKey(macro);

  if (inFlight) {
    if (inFlight.key === key) {
      // Key auto-repeat firing before the first box takes focus — drop silently (§8.4).
      return;
    }
    vscode.window.setStatusBarMessage(
      `A macro is already waiting for input ("${inFlight.macroName}").`,
      4000
    );
    return;
  }

  // The guard entry is installed BEFORE the run starts, not after. If it were assigned
  // afterwards, the correctness of the whole guard would rest on the run body always
  // suspending at its first `await` — and any early `return` added above that await
  // would run `releaseInFlight` against a still-empty `inFlight`, after which this
  // assignment would install an already-completed run and lock out every macro until
  // the window reloads. That is the exact failure the guard exists to prevent.
  const entry: InFlightRun = { key, macroName: macro.name, promise: Promise.resolve() };
  inFlight = entry;

  const run = (async (): Promise<void> => {
    try {
      const resolved = await resolveMacroText(macro);
      if (resolved === undefined) {
        vscode.window.setStatusBarMessage(`Macro "${macro.name}" cancelled — nothing was sent.`, 4000);
        return;
      }
      if (!target.isStillValid()) {
        vscode.window.setStatusBarMessage("Target terminal closed — nothing was sent.", 4000);
        return;
      }
      if (!(await target.send(resolved))) {
        // The target refused (e.g. a browser macro whose resolved text is not an
        // http/https URL) and has already reported why — never claim a send.
        return;
      }
      // Every abort path above reports through the status bar (§8.3) — a
      // successful send needs the same signal, or a send to a non-focused
      // terminal is completely silent after however long the prompts took.
      // Never include the resolved text or any entered value here.
      const caveat = options.deliveryNote ? ` — ${options.deliveryNote}` : "";
      vscode.window.setStatusBarMessage(
        `Macro "${macro.name}" sent to ${target.description}${caveat}.`,
        4000
      );
    } finally {
      // §8.4 — cleared in a finally wrapping the ENTIRE resolve-and-send, so a
      // throw anywhere above still releases the guard instead of locking every
      // macro out until the window reloads.
      releaseInFlight(key);
    }
  })();

  entry.promise = run;
  await run;
}
