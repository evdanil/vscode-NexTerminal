import * as vscode from "vscode";
import type { SettingMeta } from "./settingsMetadata";
import { recordNexusConfigWrite } from "../services/terminal/settingsWriteRegistry";

/**
 * A configuration key that Reset must clear even though it has no row in the
 * settings panel (and therefore no `SETTINGS_META` entry).
 */
export interface ResetExtraKey {
  section: string;
  key: string;
  category: SettingMeta["category"];
}

/**
 * Keys reset by "Reset All" that are NOT contributed through SETTINGS_META.
 *
 * Highlight rules, the profile catalog and its default are edited through
 * their own webview rather than settings rows. All three overrides must be
 * removed together to restore the shipped highlight defaults. Clearing only
 * the legacy rules leaves a named catalog active; writing an empty catalog
 * explicitly selects no profiles. Only the Terminal category clears these
 * keys during a per-category reset.
 */
export const RESET_EXTRA_KEYS: ResetExtraKey[] = [
  { section: "nexus.terminal.highlighting", key: "rules", category: "terminal" },
  { section: "nexus.terminal.highlighting", key: "profiles", category: "terminal" },
  { section: "nexus.terminal.highlighting", key: "defaultProfile", category: "terminal" }
];

/**
 * Extras belonging to one category.
 *
 * `category` is REQUIRED, and the two callers are deliberately different
 * functions rather than one with an optional argument: the value reaching this
 * one comes off a webview message (`msg.category as string`), so "no category
 * given" is an untrusted-input case, not an instruction to reset everything.
 * An optional parameter turns a malformed message — or a future caller that
 * forgets the argument — into a silent Reset-All of the extras. Here it resets
 * nothing, which is what an unrecognised category should do.
 */
export function resetExtraKeysForCategory(category: string): ResetExtraKey[] {
  if (!category) return [];
  return RESET_EXTRA_KEYS.filter((extra) => extra.category === category);
}

/** Every extra, for the two Reset-All call sites. */
export function resetAllExtraKeys(): ResetExtraKey[] {
  return RESET_EXTRA_KEYS;
}

/**
 * Reset the given settings to their defaults by clearing their global-scope
 * values. Each `meta` is reset via `getConfiguration(meta.section).update(
 * meta.key, undefined, Global)`, which removes the override so VS Code falls
 * back to the package-declared default.
 *
 * Shared by the "Reset All" command, the panel's `resetAll` message, and the
 * panel's `resetCategory` message (which passes a pre-filtered subset of both
 * the metas and the extras).
 */
export async function resetSettings(metas: SettingMeta[], extras: ResetExtraKey[] = []): Promise<void> {
  for (const target of [...metas, ...extras]) {
    const config = vscode.workspace.getConfiguration(target.section);
    recordNexusConfigWrite(`${target.section}.${target.key}`, undefined, Date.now());
    await config.update(target.key, undefined, vscode.ConfigurationTarget.Global);
  }
}
