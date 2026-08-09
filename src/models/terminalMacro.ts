export type MacroTriggerScope = "all-terminals" | "active-session" | "profile";

/**
 * Where a macro run sends its resolved text.
 *   - `"session"`        the terminal of a Nexus session (today's only behavior)
 *   - `"localTerminal"`  a plain VS Code terminal on this machine (e.g. `ipmitool …`)
 *   - `"browser"`        the text is a URL, opened with the OS default browser
 */
export type MacroRunTarget = "session" | "localTerminal" | "browser";

export const MACRO_RUN_TARGETS: readonly MacroRunTarget[] = ["session", "localTerminal", "browser"];

export interface MacroVariable {
  /** Placeholder name. /^[A-Za-z_][A-Za-z0-9_]{0,31}$/ */
  name: string;
  /** Prompt text shown in the input box. Defaults to `name`. */
  label?: string;
  /** Prefilled value. Forbidden when `secret` (it would be plaintext in the store). */
  default?: string;
  /** Masked input box; never remembered, never persisted. */
  secret?: boolean;
  /**
   * Prefill with the last value entered in this window.
   * DEFAULT TRUE for non-secret variables — persisted only when explicitly false.
   * Always false for secret variables.
   */
  remember?: boolean;
}

export interface TerminalMacro {
  /**
   * Stable UUID assigned on creation/migration. Optional in the type to allow
   * importing legacy records; MacroStore guarantees an id on every stored macro.
   */
  id?: string;
  name: string;
  text: string;
  keybinding?: string;
  /** @deprecated Use keybinding instead. Auto-migrated on first load. */
  slot?: number;
  secret?: boolean;
  triggerPattern?: string;
  triggerCooldown?: number;
  triggerInterval?: number;
  triggerInitiallyDisabled?: boolean;
  triggerScope?: MacroTriggerScope;
  triggerProfileId?: string;
  /**
   * Prompted-input declarations. A macro may declare `variables` or `triggerPattern`,
   * never both (see MacroAutoTrigger.reload() and sanitizeImportedMacro()).
   * Additive/optional — no macro that predates this field has one, so every
   * existing macro's text is returned by identity (see src/services/macroVariables.ts).
   */
  variables?: MacroVariable[];
  /**
   * Sidebar folder path (e.g. `"Cisco/Routers"`). `""` canonicalizes to
   * `undefined` at every read and write (see `sanitizeMacroGroup()` in
   * `src/services/macroFolders.ts`). UNTRUSTED at every read site (§4.2 of
   * docs/plans/2026-07-30-macro-script-folders.md) — legacy-settings
   * absorption and a value already sitting in `MACROS_KEY` can both carry a
   * non-string, `".."`, or over-depth value. Never consult this field
   * directly; always go through `sanitizeMacroGroup()` / `macroGroup()`.
   */
  group?: string;
  /**
   * Where a run sends the resolved text. Additive and optional — ABSENT MEANS
   * `"session"`, which is what every macro written before this field existed
   * did, so no existing macro changes behavior and an older build reading a
   * `runIn` macro simply treats it as a session macro.
   *
   * UNTRUSTED at every read site, like `group` and `variables`: legacy-settings
   * absorption persists `nexus.terminal.macros` entries verbatim, so a
   * non-string or an unknown string can reach the store without ever passing
   * through the editor. Never compare this field directly — go through
   * `resolveMacroRunTarget()`.
   *
   * Mutually exclusive with `triggerPattern` (auto-firing a browser open on
   * terminal output is a popup bomb): the editor refuses the combination, and
   * `MacroAutoTrigger.reload()` refuses to compile a rule for a non-session
   * macro that got past it anyway.
   */
  runIn?: MacroRunTarget;
  /**
   * OPT-IN (issue #48 Phase 3): give this macro's local terminal the linked IPMI
   * auth profile's password in `IPMITOOL_PASSWORD` / `IPMI_PASSWORD`, so
   * `ipmitool -E` can read it without the password ever reaching the command
   * line. Only meaningful for `runIn: "localTerminal"`.
   *
   * ABSENT MEANS FALSE — no injection — so every existing macro, every macro
   * from an older build, and every imported one is non-privileged by default.
   * UNTRUSTED at every read site like `runIn` and `group`: go through
   * `macroProvidesIpmiCredentials()`, which tests `=== true`, so a non-boolean
   * absorbed from legacy settings can never become consent.
   *
   * WHY A STORED FLAG RATHER THAN "the text looks like ipmitool". Token presence
   * is not consent: a macro whose text merely mentions `${profile.ipmiHost}` —
   * a `ping`, a `curl`, an imported macro written to look innocuous — would
   * otherwise get the fleet-wide BMC password in an environment every command it
   * runs can read. The macro text is user-editable data, not an authorization
   * decision.
   *
   * NEVER SURVIVES AN IMPORT (`IMPORTED_CAPABILITY_FIELDS`,
   * commands/configCommands.ts): a stored consent flag is only consent if the
   * person it binds is the person who ticked it.
   */
  provideIpmiCredentials?: boolean;
}

/**
 * The run target a macro ACTUALLY has, applied at every read site (§4.2's
 * untrusted-field discipline): absent, a non-string, or a string outside
 * `MACRO_RUN_TARGETS` all resolve to `"session"` — the compatibility default —
 * so a corrupt record behaves like the ordinary macro it was before, never like
 * one that opens a browser.
 */
export function resolveMacroRunTarget(macro: Pick<TerminalMacro, "runIn">): MacroRunTarget {
  const raw = macro.runIn as unknown;
  return typeof raw === "string" && (MACRO_RUN_TARGETS as readonly string[]).includes(raw)
    ? (raw as MacroRunTarget)
    : "session";
}

/**
 * Does a run of this macro get the linked IPMI profile's password in its
 * terminal environment? The ONE read site for `provideIpmiCredentials`, so the
 * two halves of the gate that live on the record — the flag being exactly
 * `true`, and the run actually being a local terminal — cannot be asked
 * separately or asked differently by two callers.
 *
 * The third half is not on the record and stays at the call site: a password
 * must actually be obtained (vault or masked prompt), so a cancelled prompt
 * aborts the run rather than spawning an env-less terminal.
 *
 * `=== true`, never truthiness — see the field's doc.
 */
export function macroProvidesIpmiCredentials(
  macro: Pick<TerminalMacro, "runIn" | "provideIpmiCredentials">
): boolean {
  return resolveMacroRunTarget(macro) === "localTerminal" && (macro.provideIpmiCredentials as unknown) === true;
}

/** Human-readable label for a run target, shared by the editor and the pickers. */
export function macroRunTargetLabel(target: MacroRunTarget): string {
  switch (target) {
    case "localTerminal":
      return "Local terminal";
    case "browser":
      return "Browser";
    default:
      return "Session terminal";
  }
}

/**
 * The `[Local terminal] ` / `[Browser] ` prefix pickers put in front of a
 * macro's description, and `""` for an ordinary session macro. One definition
 * so every picker that lists macros badges them identically — a macro that will
 * open a browser window instead of typing into the terminal is exactly the
 * thing a list of macros must not hide.
 */
export function macroRunTargetBadge(macro: Pick<TerminalMacro, "runIn">): string {
  const target = resolveMacroRunTarget(macro);
  return target === "session" ? "" : `[${macroRunTargetLabel(target)}] `;
}

export const MACRO_RUN_TARGET_TRIGGER_CONFLICT_MESSAGE =
  'A macro can auto-trigger or run outside its session, not both. Set "Run in" back to Session terminal, or clear the auto-trigger pattern.';

/**
 * The `runIn`/`triggerPattern` exclusion, mirroring `validateMacroVariables()`'s
 * variables/trigger exclusion (services/macroVariables.ts) — one shared rule so
 * the webview's live check and the host's save-time enforcement cannot drift.
 * Returns the message to show, or `undefined` when the combination is legal.
 */
export function validateMacroRunTarget(
  runIn: MacroRunTarget,
  options: { triggerPattern?: string } = {}
): string | undefined {
  return runIn !== "session" && options.triggerPattern ? MACRO_RUN_TARGET_TRIGGER_CONFLICT_MESSAGE : undefined;
}
