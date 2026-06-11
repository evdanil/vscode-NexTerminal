import * as vscode from "vscode";
import type { SettingMeta } from "./settingsMetadata";
import { recordNexusConfigWrite } from "../services/terminal/settingsWriteRegistry";

/**
 * Reset the given settings to their defaults by clearing their global-scope
 * values. Each `meta` is reset via `getConfiguration(meta.section).update(
 * meta.key, undefined, Global)`, which removes the override so VS Code falls
 * back to the package-declared default.
 *
 * Shared by the "Reset All" command, the panel's `resetAll` message, and the
 * panel's `resetCategory` message (which passes a pre-filtered subset).
 */
export async function resetSettings(metas: SettingMeta[]): Promise<void> {
  for (const meta of metas) {
    const config = vscode.workspace.getConfiguration(meta.section);
    recordNexusConfigWrite(`${meta.section}.${meta.key}`, undefined, Date.now());
    await config.update(meta.key, undefined, vscode.ConfigurationTarget.Global);
  }
}
