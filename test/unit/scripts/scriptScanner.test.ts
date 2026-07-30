import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFsEntries = new Map<string, Array<[string, number]>>();

vi.mock("vscode", () => ({
  // Real vscode.FileType values: Unknown=0, File=1, Directory=2, SymbolicLink=64.
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      toString: () => [base.fsPath, ...parts].join("/")
    })
  },
  workspace: {
    fs: {
      readDirectory: vi.fn(async (uri: { fsPath: string }) => {
        if (!mockFsEntries.has(uri.fsPath)) {
          throw new Error(`ENOENT: ${uri.fsPath}`);
        }
        return mockFsEntries.get(uri.fsPath)!;
      })
    }
  }
}));

import * as vscode from "vscode";
import {
  scanScriptsDir,
  SCRIPT_SCAN_MAX_DEPTH,
  SCRIPT_SCAN_MAX_ENTRIES
} from "../../../src/services/scripts/scriptScanner";

const ROOT = "/scripts";
const rootUri = { fsPath: ROOT, scheme: "file", path: ROOT, toString: () => ROOT };
const DIR = vscode.FileType.Directory;
const FILE = vscode.FileType.File;

function scriptNames(result: Awaited<ReturnType<typeof scanScriptsDir>>): string[] {
  return result.scripts.map((s) => s.fileName).sort();
}

function folderPaths(result: Awaited<ReturnType<typeof scanScriptsDir>>): string[] {
  return result.folders.map((f) => f.path).sort();
}

describe("scanScriptsDir", () => {
  beforeEach(() => {
    mockFsEntries.clear();
  });

  it("returns an empty result when the root directory does not exist", async () => {
    const result = await scanScriptsDir(rootUri as never);
    expect(result).toEqual({ scripts: [], folders: [], truncated: false, examined: 0 });
  });

  it("discovers scripts nested multiple levels deep, tagging each with its folder-relative path", async () => {
    mockFsEntries.set(ROOT, [["cisco", DIR]]);
    mockFsEntries.set(`${ROOT}/cisco`, [["routers", DIR]]);
    mockFsEntries.set(`${ROOT}/cisco/routers`, [["backup.js", FILE]]);

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(["cisco", "cisco/routers"]);
    expect(result.scripts).toEqual([
      expect.objectContaining({ fileName: "backup.js", folderPath: "cisco/routers" })
    ]);
  });

  it("includes empty directories in the folders list (§5.4 — folders show whether or not they contain scripts)", async () => {
    mockFsEntries.set(ROOT, [["empty", DIR]]);
    mockFsEntries.set(`${ROOT}/empty`, []);

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(["empty"]);
    expect(result.scripts).toEqual([]);
  });

  it("skips node_modules and dot-directories case-insensitively, never descending into them", async () => {
    mockFsEntries.set(ROOT, [
      ["NODE_MODULES", DIR],
      [".git", DIR],
      ["real", DIR]
    ]);
    // If the skip logic were broken these would leak into the result — a test
    // that never populates these directories at all couldn't tell a correct
    // "skip" apart from a bug that merely fails to recurse into everything.
    mockFsEntries.set(`${ROOT}/NODE_MODULES`, [["leaked.js", FILE]]);
    mockFsEntries.set(`${ROOT}/.git`, [["leaked2.js", FILE]]);
    mockFsEntries.set(`${ROOT}/real`, [["a.js", FILE]]);

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(["real"]);
    expect(scriptNames(result)).toEqual(["a.js"]);
  });

  it("skips the generated types/ directory at the scripts root only — a nested types/ is a real folder", async () => {
    mockFsEntries.set(ROOT, [
      ["types", DIR],
      ["cisco", DIR]
    ]);
    mockFsEntries.set(`${ROOT}/types`, [["nexus-scripts.d.ts", FILE]]);
    mockFsEntries.set(`${ROOT}/cisco`, [["types", DIR]]);
    mockFsEntries.set(`${ROOT}/cisco/types`, [["probe.js", FILE]]);

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(["cisco", "cisco/types"]);
    expect(result.scripts).toEqual([
      expect.objectContaining({ fileName: "probe.js", folderPath: "cisco/types" })
    ]);
  });

  it("matches .js case-insensitively", async () => {
    mockFsEntries.set(ROOT, [
      ["Foo.JS", FILE],
      ["bar.Js", FILE],
      ["baz.txt", FILE]
    ]);

    const result = await scanScriptsDir(rootUri as never);
    expect(scriptNames(result)).toEqual(["Foo.JS", "bar.Js"]);
  });

  it("follows a symlinked directory (bitmask test, not strict equality) — caps bound the cost instead", async () => {
    // Directory | SymbolicLink = 2 | 64 = 66. `type === FileType.Directory`
    // (66 === 2) would be false and silently drop this entry; the bitmask
    // test (66 & 2 !== 0) treats it as a directory to descend into.
    mockFsEntries.set(ROOT, [["link", (DIR | 64) as vscode.FileType]]);
    mockFsEntries.set(`${ROOT}/link`, [["hidden.js", FILE]]);

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(["link"]);
    expect(result.scripts).toEqual([
      expect.objectContaining({ fileName: "hidden.js", folderPath: "link" })
    ]);
  });

  it(`stops descending past depth ${SCRIPT_SCAN_MAX_DEPTH} — the folder at the cap is listed but not read into`, async () => {
    // Build a straight-line chain d1/d2/.../d10, each containing only the
    // next directory. ROOT/d1/.../d10 (the depth-10 folder) additionally
    // contains d11 and a script — content that must NOT surface, because
    // reading that folder's own listing would be depth-11 work.
    const dirNames = Array.from({ length: SCRIPT_SCAN_MAX_DEPTH }, (_, i) => `d${i + 1}`);
    let currentDirPath = ROOT;
    for (const name of dirNames) {
      mockFsEntries.set(currentDirPath, [[name, DIR]]);
      currentDirPath = `${currentDirPath}/${name}`;
    }
    // currentDirPath is now ROOT/d1/.../d10 — never read by the scanner.
    mockFsEntries.set(currentDirPath, [["d11", DIR], ["deep.js", FILE]]);

    const expectedFolderPaths: string[] = [];
    let rel = "";
    for (const name of dirNames) {
      rel = rel ? `${rel}/${name}` : name;
      expectedFolderPaths.push(rel);
    }

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(expectedFolderPaths.sort());
    expect(folderPaths(result)).not.toContain(`${expectedFolderPaths[expectedFolderPaths.length - 1]}/d11`);
    expect(result.scripts).toEqual([]); // deep.js lives one level past the cap
    expect(result.truncated).toBe(false);
  });

  it(`truncates after examining ${SCRIPT_SCAN_MAX_ENTRIES} directories/non-.js entries, but .js files themselves are not counted`, async () => {
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < SCRIPT_SCAN_MAX_ENTRIES + 1; i++) {
      entries.push([`d${String(i).padStart(4, "0")}`, DIR]);
      mockFsEntries.set(`${ROOT}/d${String(i).padStart(4, "0")}`, []);
    }
    mockFsEntries.set(ROOT, entries);

    const result = await scanScriptsDir(rootUri as never);
    expect(result.truncated).toBe(true);
    expect(result.examined).toBe(SCRIPT_SCAN_MAX_ENTRIES + 1);
    expect(result.folders.length).toBe(SCRIPT_SCAN_MAX_ENTRIES);
  });

  it("does not count .js files against the entry budget", async () => {
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < SCRIPT_SCAN_MAX_ENTRIES + 1; i++) {
      entries.push([`s${String(i).padStart(4, "0")}.js`, FILE]);
    }
    mockFsEntries.set(ROOT, entries);

    const result = await scanScriptsDir(rootUri as never);
    expect(result.truncated).toBe(false);
    expect(result.examined).toBe(0);
    expect(result.scripts.length).toBe(SCRIPT_SCAN_MAX_ENTRIES + 1);
  });
});
