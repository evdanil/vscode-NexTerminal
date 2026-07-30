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
  findHiddenScriptFolderSegment,
  scanScriptsDir,
  SCRIPT_SCAN_MAX_DEPTH,
  SCRIPT_SCAN_MAX_ENTRIES
} from "../../../src/services/scripts/scriptScanner";
import { MAX_FOLDER_DEPTH } from "../../../src/utils/folderPaths";

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
    expect(result).toEqual({ scripts: [], folders: [], truncated: false, examined: 0, depthTruncated: false });
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

  it("flags a symlinked folder, and everything under it, as `linked` — the watcher cannot see inside either", async () => {
    // Following a link is a promise this scanner keeps and the file-system
    // watcher does not (VS Code's recursive watcher resolves only its own root),
    // so the tree has to be able to say which rows it will not be told about.
    // A plain directory INSIDE the link is just as unwatched as the link itself,
    // which is why the flag is inherited downward rather than set on the link
    // alone — a user who expands straight into `link/sub` would otherwise get no
    // explanation at all.
    mockFsEntries.set(ROOT, [["link", (DIR | 64) as vscode.FileType], ["plain", DIR]]);
    mockFsEntries.set(`${ROOT}/link`, [["sub", DIR]]);
    mockFsEntries.set(`${ROOT}/link/sub`, []);
    mockFsEntries.set(`${ROOT}/plain`, [["nested", DIR]]);
    mockFsEntries.set(`${ROOT}/plain/nested`, []);

    const result = await scanScriptsDir(rootUri as never);

    const byPath = new Map(result.folders.map((f) => [f.path, f.linked]));
    expect(byPath.get("link")).toBe(true);
    expect(byPath.get("link/sub")).toBe(true);
    expect(byPath.get("plain")).toBe(false);
    expect(byPath.get("plain/nested")).toBe(false);
  });

  it(`descends fully into a folder at exactly the max depth (${SCRIPT_SCAN_MAX_DEPTH}) — normalizeFolderPath accepts a path of exactly this many segments, so the scanner must read it (Fix 2)`, async () => {
    // Build a straight-line chain d1/d2/.../d10, each containing only the
    // next directory. ROOT/d1/.../d10 (the depth-10 folder — exactly as deep
    // as a user is allowed to create) contains a script that MUST surface:
    // before Fix 2, this folder was listed but never read, making a
    // legitimately-created script invisible in both the tree and the picker.
    const dirNames = Array.from({ length: SCRIPT_SCAN_MAX_DEPTH }, (_, i) => `d${i + 1}`);
    let currentDirPath = ROOT;
    for (const name of dirNames) {
      mockFsEntries.set(currentDirPath, [[name, DIR]]);
      currentDirPath = `${currentDirPath}/${name}`;
    }
    // currentDirPath is now ROOT/d1/.../d10 — must be read.
    mockFsEntries.set(currentDirPath, [["deep.js", FILE]]);

    const expectedFolderPaths: string[] = [];
    let rel = "";
    for (const name of dirNames) {
      rel = rel ? `${rel}/${name}` : name;
      expectedFolderPaths.push(rel);
    }
    const depth10Path = expectedFolderPaths[expectedFolderPaths.length - 1];

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(expectedFolderPaths.sort());
    expect(result.scripts).toEqual([
      expect.objectContaining({ fileName: "deep.js", folderPath: depth10Path })
    ]);
    expect(result.truncated).toBe(false);
    // Fix 6 — nothing here was cut off by the depth cap (the deepest folder
    // was fully read), so the separate depth-truncation flag must stay false.
    expect(result.depthTruncated).toBe(false);
  });

  it(`a folder found one level beyond the cap (depth ${SCRIPT_SCAN_MAX_DEPTH + 1}) still renders but is never descended into`, async () => {
    // Same chain, one directory deeper: ROOT/d1/.../d10/d11. Folders are
    // always pushed when discovered regardless of the depth cap (§5.4 — all
    // directories render), so d11 must still appear in the folder list — but
    // reading ITS listing would be depth-12 work, so a script placed directly
    // inside it must never surface.
    const dirNames = Array.from({ length: SCRIPT_SCAN_MAX_DEPTH + 1 }, (_, i) => `d${i + 1}`);
    let currentDirPath = ROOT;
    for (const name of dirNames) {
      mockFsEntries.set(currentDirPath, [[name, DIR]]);
      currentDirPath = `${currentDirPath}/${name}`;
    }
    // currentDirPath is now ROOT/d1/.../d11 — must NOT be read.
    mockFsEntries.set(currentDirPath, [["toodeep.js", FILE]]);

    const expectedFolderPaths: string[] = [];
    let rel = "";
    for (const name of dirNames) {
      rel = rel ? `${rel}/${name}` : name;
      expectedFolderPaths.push(rel);
    }

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual(expectedFolderPaths.sort());
    expect(result.scripts).toEqual([]); // toodeep.js lives inside the un-descended depth-11 folder
    // `truncated` (the ENTRY-count cap) is correctly false — nowhere near
    // 500 entries were examined. Fix 6: asserting only this, as the
    // pre-fix version of this test did, codified the actual bug — a
    // depth-11 folder was silently skipped with NO signal anywhere in the
    // result, so the "Stopped after 500 entries" warning node never
    // rendered and nothing else explained the missing script either.
    // `depthTruncated` is the separate flag this fix adds specifically for
    // that case, and it MUST be true here.
    expect(result.truncated).toBe(false);
    expect(result.depthTruncated).toBe(true);
  });

  it(`truncates after examining ${SCRIPT_SCAN_MAX_ENTRIES} directory entries, reporting exactly the cap — not one past it (Fix 3 off-by-one)`, async () => {
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < SCRIPT_SCAN_MAX_ENTRIES + 1; i++) {
      entries.push([`d${String(i).padStart(4, "0")}`, DIR]);
      mockFsEntries.set(`${ROOT}/d${String(i).padStart(4, "0")}`, []);
    }
    mockFsEntries.set(ROOT, entries);

    const result = await scanScriptsDir(rootUri as never);
    expect(result.truncated).toBe(true);
    // Before Fix 3 this reported 501 (increment-then-compare) while the
    // truncation row said "Stopped after 500" — the tooltip and the row
    // disagreed. Checking the budget BEFORE incrementing means `examined`
    // never exceeds the advertised cap.
    expect(result.examined).toBe(SCRIPT_SCAN_MAX_ENTRIES);
    expect(result.folders.length).toBe(SCRIPT_SCAN_MAX_ENTRIES);
  });

  it(`counts .js files against the entry budget too (Fix 3) — bounds the per-script readFile fan-out downstream`, async () => {
    // Before Fix 3, a directory full of `.js` files scanned for free: `examined`
    // stayed 0 and `truncated` stayed false no matter how many scripts existed,
    // so both the Scripts tree and pickScriptFromWorkspace() would issue one
    // sequential readFile per script with no cap and no truncation node.
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < SCRIPT_SCAN_MAX_ENTRIES + 1; i++) {
      entries.push([`s${String(i).padStart(4, "0")}.js`, FILE]);
    }
    mockFsEntries.set(ROOT, entries);

    const result = await scanScriptsDir(rootUri as never);
    expect(result.truncated).toBe(true);
    expect(result.examined).toBe(SCRIPT_SCAN_MAX_ENTRIES);
    expect(result.scripts.length).toBe(SCRIPT_SCAN_MAX_ENTRIES); // fan-out bounded, not 501
  });

  it("skips the generated types/ directory at the scripts root case-insensitively (WSL2's /mnt/c mount is case-insensitive)", async () => {
    mockFsEntries.set(ROOT, [["Types", DIR]]);
    mockFsEntries.set(`${ROOT}/Types`, [["nexus-scripts.d.ts", FILE]]);

    const result = await scanScriptsDir(rootUri as never);
    expect(folderPaths(result)).toEqual([]);
    expect(result.scripts).toEqual([]);
  });

  it("SCRIPT_SCAN_MAX_DEPTH tracks MAX_FOLDER_DEPTH", () => {
    // The two are the same bound seen from two sides: normalizeFolderPath is
    // what stops a user creating a folder deeper than this, and this scanner
    // is what has to find what they created.
    //
    // Be honest about what this catches. Import-vs-literal is a source-text
    // property, and while the two numbers happen to be equal a literal `10`
    // passes here just as an import does. The mutation it DOES fail against is
    // the one that matters: MAX_FOLDER_DEPTH moving while a re-declared copy
    // stays behind, which is the drift the import exists to make impossible.
    expect(SCRIPT_SCAN_MAX_DEPTH).toBe(MAX_FOLDER_DEPTH);
  });
});

describe("findHiddenScriptFolderSegment — the skip list, reused by the New Folder / New Script validators", () => {
  it("names the segment that would make a folder invisible", () => {
    expect(findHiddenScriptFolderSegment(".archive")).toBe(".archive");
    expect(findHiddenScriptFolderSegment("node_modules")).toBe("node_modules");
    expect(findHiddenScriptFolderSegment("NODE_MODULES")).toBe("NODE_MODULES");
    expect(findHiddenScriptFolderSegment("types")).toBe("types");
    expect(findHiddenScriptFolderSegment("Types")).toBe("Types");
    // Not only at the root: a hidden ANCESTOR hides everything under it.
    expect(findHiddenScriptFolderSegment("cisco/.archive/old")).toBe(".archive");
    expect(findHiddenScriptFolderSegment("cisco/node_modules")).toBe("node_modules");
  });

  it("allows everything the scanner actually walks, including a non-root types/", () => {
    expect(findHiddenScriptFolderSegment("cisco")).toBeUndefined();
    expect(findHiddenScriptFolderSegment("cisco/backup")).toBeUndefined();
    // scriptTypesGenerator only ever writes <scriptsDir>/types, so a user's own
    // cisco/types is a real folder the scanner descends into.
    expect(findHiddenScriptFolderSegment("cisco/types")).toBeUndefined();
    expect(findHiddenScriptFolderSegment("typescript")).toBeUndefined();
  });

  it("agrees with the walk it describes: every name it rejects really does fail to render", async () => {
    // The predicate and the walk must not drift — that is the entire reason
    // the predicate lives in this module.
    mockFsEntries.set(ROOT, [[".archive", DIR], ["node_modules", DIR], ["types", DIR], ["cisco", DIR]]);
    mockFsEntries.set(`${ROOT}/.archive`, [["a.js", FILE]]);
    mockFsEntries.set(`${ROOT}/node_modules`, [["b.js", FILE]]);
    mockFsEntries.set(`${ROOT}/types`, [["c.js", FILE]]);
    mockFsEntries.set(`${ROOT}/cisco`, [["types", DIR]]);
    mockFsEntries.set(`${ROOT}/cisco/types`, [["d.js", FILE]]);

    const result = await scanScriptsDir(rootUri as never);

    expect(folderPaths(result)).toEqual(["cisco", "cisco/types"]);
    expect(result.scripts.map((s) => s.fileName)).toEqual(["d.js"]);
  });
});
