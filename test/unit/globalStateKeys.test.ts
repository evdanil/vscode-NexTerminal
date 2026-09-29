import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESET_CLEARED_BY_STORE_GLOBAL_STATE_KEYS,
  RESET_CLEARED_GLOBAL_STATE_KEYS,
  RESET_KEPT_GLOBAL_STATE_KEYS
} from "../../src/storage/globalStateKeys";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// Constants named *_KEY holding a "nexus.*" literal, and literals passed straight to globalState get/update.
const KEY_CONSTANT = /\b[A-Z][A-Z0-9_]*KEY[A-Z0-9_]*\s*(?::\s*string\s*)?=\s*"(nexus\.[A-Za-z0-9_.]+)"/g;
const INLINE_KEY = /globalState\s*\.\s*(?:get|update)(?:<[^>]*>)?\(\s*"(nexus\.[A-Za-z0-9_.]+)"/g;
// *_KEY constants that name settings or VS Code context keys, not globalState entries.
const NOT_GLOBAL_STATE = new Set([
  "nexus.isNexusTerminal",
  "nexus.isNexusTerminalConnected",
  "nexus.scripts.defaultTimeoutSeconds",
  "nexus.scripts.defaultTimeout"
]);

describe("every Nexus globalState key is classified for Delete All Data", () => {
  const found = new Set<string>();
  for (const file of sourceFiles(join(__dirname, "../../src"))) {
    const text = readFileSync(file, "utf8");
    for (const pattern of [KEY_CONSTANT, INLINE_KEY]) {
      for (const match of text.matchAll(pattern)) found.add(match[1]);
    }
  }
  const classified = new Set([
    ...RESET_CLEARED_GLOBAL_STATE_KEYS,
    ...RESET_CLEARED_BY_STORE_GLOBAL_STATE_KEYS,
    ...RESET_KEPT_GLOBAL_STATE_KEYS
  ]);

  it("finds the keys it is meant to (guards the scan itself)", () => {
    expect(found.has("nexus.servers")).toBe(true);
    expect(found.has("nexus.ui.collapsedFolders")).toBe(true);
    expect(found.has("nexus.macros.migrationNoticeShown")).toBe(true);
  });

  it("leaves no key unclassified — add a new key to the cleared or kept list in src/storage/globalStateKeys.ts", () => {
    const unclassified = [...found].filter((key) => !NOT_GLOBAL_STATE.has(key) && !classified.has(key));
    expect(unclassified).toEqual([]);
  });

  it("classifies each key once", () => {
    const all = [...RESET_CLEARED_GLOBAL_STATE_KEYS, ...RESET_CLEARED_BY_STORE_GLOBAL_STATE_KEYS, ...RESET_KEPT_GLOBAL_STATE_KEYS];
    expect(new Set(all).size).toBe(all.length);
  });
});
