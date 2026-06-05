import * as vscode from "vscode";
import { clamp } from "./helpers";

/**
 * Read a numeric VS Code setting, guarding against corrupt configured values.
 *
 * A configured value of the wrong type, `NaN`, or `Infinity` (e.g. from a
 * hand-edited `settings.json` or a Settings Sync conflict) would otherwise win
 * over the package.json default — `WorkspaceConfiguration.get(key, fallback)`
 * only substitutes the fallback when the key is entirely absent. This helper
 * degrades any non-finite/non-number value to `fallback` and clamps valid
 * numbers into `[min, max]`.
 */
export function readBoundedNumber(
  section: string,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = vscode.workspace.getConfiguration(section).get<number>(key, fallback);
  return typeof raw === "number" && Number.isFinite(raw) ? clamp(raw, min, max) : fallback;
}
