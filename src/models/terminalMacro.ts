export type MacroTriggerScope = "all-terminals" | "active-session" | "profile";

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
}
