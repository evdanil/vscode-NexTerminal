import * as vscode from "vscode";
import { validateAndSanitizeHighlightRules, type HighlightRule } from "../../utils/highlightRuleValidation";
import { upgradeHighlightRules } from "../../utils/highlightRuleUpgrade";
import { recordNexusConfigWrite } from "./settingsWriteRegistry";

export const HIGHLIGHT_RULES_SECTION = "nexus.terminal.highlighting";
export const HIGHLIGHT_RULES_KEY = "rules";
export const HIGHLIGHT_RULES_FULL_KEY = `${HIGHLIGHT_RULES_SECTION}.${HIGHLIGHT_RULES_KEY}`;

/**
 * One-shot, self-idempotent heal of a stale user rule snapshot in GLOBAL
 * settings. Run once per activation.
 *
 * Read-time upgrades (`HighlightRuleEditorPanel.readRules`,
 * `TerminalHighlighter.reload`) already make the extension BEHAVE correctly, so
 * this write is not what fixes highlighting — it fixes the artifact. Without
 * it, `settings.json` keeps the truncating IPv6 pattern and the nameless rule
 * list forever, and every configuration export carries them onward to the next
 * machine.
 *
 * Deliberate limits:
 *  - Global scope only. Workspace/folder overrides belong to a repo that may be
 *    shared, and silently rewriting those is not ours to do; the read-time
 *    upgrade covers them behaviourally.
 *  - Only when a global override actually exists. A user on the shipped
 *    defaults has `globalValue === undefined` and must stay that way — writing
 *    the defaults back would materialise a snapshot and recreate exactly the
 *    shadowing problem this whole change exists to undo.
 *  - Only when the upgrade reports a change, so activation does not rewrite
 *    settings.json (and fire the Settings Guard, and dirty file sync) on every
 *    single start.
 *
 * Non-fatal by construction: a rejected write (read-only settings.json, a
 * policy-locked profile) leaves behaviour correct via the read path, so the
 * failure is swallowed rather than surfaced during activation.
 *
 * @returns true when a write was actually issued and accepted.
 */
export async function migrateHighlightRulesGlobalSetting(now: () => number = Date.now): Promise<boolean> {
  try {
    const config = vscode.workspace.getConfiguration(HIGHLIGHT_RULES_SECTION);
    const globalValue = config.inspect<unknown>(HIGHLIGHT_RULES_KEY)?.globalValue;
    if (globalValue === undefined) {
      return false;
    }

    // Validation is a GATE, not a transform. Its result is deliberately
    // discarded: the sanitizer rebuilds every rule from a field whitelist, so
    // persisting its output would drop anything the user hand-added to
    // settings.json and normalise the fields it merely tolerates (an invalid
    // `flags`, a non-boolean `enabled`, an over-long label). This function's
    // whole contract is "change only what I know is stale", and rewriting the
    // rest of a user's array on their behalf breaks it — the RAW array is what
    // gets upgraded and written back. Read-time sanitisation still protects
    // everything that actually consumes the rules.
    if (!validateAndSanitizeHighlightRules(globalValue)) {
      return false;
    }

    const upgraded = upgradeHighlightRules(globalValue as HighlightRule[]);
    if (!upgraded.changed) {
      return false;
    }

    // Before the update, so the Settings Guard classifies the resulting change
    // event as Nexus's own rather than filing it as an external edit.
    recordNexusConfigWrite(HIGHLIGHT_RULES_FULL_KEY, upgraded.rules, now());
    await config.update(HIGHLIGHT_RULES_KEY, upgraded.rules, vscode.ConfigurationTarget.Global);
    return true;
  } catch {
    return false;
  }
}
