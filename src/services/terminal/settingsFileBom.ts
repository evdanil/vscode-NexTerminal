/**
 * Pure (vscode-free) helpers for detecting and removing a leading UTF-8 BOM
 * from the active-profile user settings.json.
 *
 * Some corporate DLP tools rewrite settings.json as UTF-8-with-BOM (EF BB BF)
 * plus CRLF line endings. VS Code's settings writer uses jsonc-parser under the
 * hood; a leading BOM is an InvalidSymbol parse error at offset 0, and the
 * writer refuses to persist into a file that has any parse errors. Stripping
 * the BOM (all other bytes unchanged) removes the parse error and lets
 * subsequent config.update calls land normally.
 *
 * Keeping this logic vscode-free makes it trivially unit-testable without a
 * VS Code API mock.
 */

import * as path from "node:path";
import { modify, applyEdits } from "jsonc-parser";

/** UTF-8 BOM byte sequence (EF BB BF). */
export const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf] as const;

/**
 * Derive the ACTIVE profile's user settings.json path from the extension's
 * globalStorage filesystem path. VS Code lays globalStorage out as
 *   <userDataDir>/User[/profiles/<id>]/globalStorage/<publisher.name>
 * so the settings.json VS Code actually reads for this profile is two
 * directories up, a sibling of the `globalStorage` dir. Because
 * globalStorageUri is itself profile-scoped, this automatically tracks custom
 * --user-data-dir, portable mode, and non-default profiles.
 */
export function deriveUserSettingsPath(globalStorageFsPath: string): string {
  return path.join(path.dirname(path.dirname(globalStorageFsPath)), "settings.json");
}

/** True when the bytes begin with the 3-byte UTF-8 BOM. */
export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * Return the bytes with a leading UTF-8 BOM removed. When no BOM is present the
 * input is returned unchanged. The remaining bytes (line endings, indentation,
 * content) are preserved exactly.
 */
export function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  return hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
}

export type JsonKeyEdit =
  | { key: string; action: "set"; value: unknown }
  | { key: string; action: "delete" };

/**
 * Apply surgical edits to settings.json TEXT (BOM already stripped). VS Code
 * settings keys are FLAT dotted strings (e.g. "terminal.integrated.commandsToSkipShell"),
 * so each edit targets a single top-level JSON property — the jsonc path is the
 * one-element array [key]. "delete" removes the property (passes undefined to
 * modify). Returns the edited text; all other content/formatting/comments are
 * preserved by jsonc-parser. Throws only if the input text is not parseable.
 */
export function applyJsonKeyEdits(text: string, edits: readonly JsonKeyEdit[]): string {
  let out = text;
  for (const e of edits) {
    const newValue = e.action === "delete" ? undefined : e.value;
    const editOps = modify(out, [e.key], newValue, {
      formattingOptions: { insertSpaces: true, tabSize: 4 },
    });
    out = applyEdits(out, editOps);
  }
  return out;
}
