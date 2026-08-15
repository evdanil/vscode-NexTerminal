/*
 * Pure containment matrix for `nexus.fs` — runs the full decision table from
 * scriptFsScope.ts's own doc comment twice, once per injected `platform`, so
 * the win32 matrix runs on Linux CI via `path.win32` rather than needing a
 * Windows runner. No `vscode` mock needed — this module has no `vscode` import.
 *
 * House rule (CLAUDE.md): every test must fail against the specific wrong
 * implementation it prevents. Each block below names its target-wrong-impl (⊘).
 */
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLexicallyWithin,
  resolveScriptFsPath,
  type ScriptFsPlatform,
  type ScriptFsScope
} from "../../../src/services/scripts/scriptFsScope";

const PLATFORMS: ScriptFsPlatform[] = ["posix", "win32"];

/** Per-platform path builders so one test body covers both matrices. */
function fixture(platform: ScriptFsPlatform) {
  if (platform === "posix") {
    return {
      root: "/ws/.nexus/scripts",
      scriptDir: "/ws/.nexus/scripts/cisco", // D, one level under R
      join: (...parts: string[]) => parts.join("/")
    };
  }
  return {
    root: "C:\\ws\\.nexus\\scripts",
    scriptDir: "C:\\ws\\.nexus\\scripts\\cisco",
    join: (...parts: string[]) => parts.join("\\")
  };
}

function scopeOf(platform: ScriptFsPlatform, overrides?: Partial<ScriptFsScope>): ScriptFsScope {
  const f = fixture(platform);
  return {
    scriptDirPath: f.scriptDir,
    scriptsRootPath: f.root,
    platform,
    ...overrides
  };
}

describe.each(PLATFORMS)("resolveScriptFsPath — platform-agnostic rows (%s)", (platform) => {
  const f = fixture(platform);

  it("row 1: plain relative resolves under the script's own directory", () => {
    const r = resolveScriptFsPath("data.json", scopeOf(platform));
    expect(r).toEqual({ ok: true, resolvedPath: f.join(f.scriptDir, "data.json") });
  });

  it("row 2: '.', './', duplicate separators, and './x' all normalize the same way", () => {
    // ⊘ any implementation that skips path.resolve's normalization step.
    const a = resolveScriptFsPath("./x.json", scopeOf(platform));
    const b = resolveScriptFsPath(platform === "posix" ? "sub//x.json" : "sub\\\\x.json", scopeOf(platform));
    const c = resolveScriptFsPath(platform === "posix" ? "sub/./x.json" : "sub\\.\\x.json", scopeOf(platform));
    expect(a).toEqual({ ok: true, resolvedPath: f.join(f.scriptDir, "x.json") });
    expect(b).toEqual({ ok: true, resolvedPath: f.join(f.scriptDir, "sub", "x.json") });
    expect(c).toEqual({ ok: true, resolvedPath: f.join(f.scriptDir, "sub", "x.json") });
  });

  it("row 3: '..' that lands back inside the scripts root is allowed", () => {
    // ⊘ any implementation that bans '..' outright.
    const r = resolveScriptFsPath("../shared/x.json", scopeOf(platform));
    expect(r).toEqual({ ok: true, resolvedPath: f.join(f.root, "shared", "x.json") });
  });

  it("row 4: '..' that escapes both the script dir and the root is refused", () => {
    const r = resolveScriptFsPath("../../secrets.txt", scopeOf(platform));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PathOutsideScope");
  });

  it("row 7: empty string, whitespace-only, non-string, and NUL are all InvalidPath", () => {
    // ⊘ passing garbage straight into path.resolve.
    for (const bad of ["", "   ", "a\0b"]) {
      const r = resolveScriptFsPath(bad, scopeOf(platform));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("InvalidPath");
    }
    const nonString = resolveScriptFsPath(42 as unknown as string, scopeOf(platform));
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) expect(nonString.code).toBe("InvalidPath");
  });

  it("row 8: '.' resolves to the script directory itself (containment doesn't know file types)", () => {
    const r = resolveScriptFsPath(".", scopeOf(platform));
    expect(r).toEqual({ ok: true, resolvedPath: f.scriptDir });
  });

  it("row 9: '..' from a one-level-deep script dir resolves to the root itself", () => {
    const r = resolveScriptFsPath("..", scopeOf(platform));
    expect(r).toEqual({ ok: true, resolvedPath: f.root });
  });

  it("row 10: a sibling directory that merely shares the root's string prefix is refused", () => {
    // ⊘ raw candidate.startsWith(root) string-prefix check — "scripts-evil" starts
    // with "scripts" as a STRING but is a different, sibling directory.
    const scope = scopeOf(platform, { scriptDirPath: f.root }); // script lives directly in R
    const escapeSegment = platform === "posix" ? "../scripts-evil/x" : "..\\scripts-evil\\x";
    const r = resolveScriptFsPath(escapeSegment, scope);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PathOutsideScope");
  });

  it("row 11: a real directory literally named '..foo' inside the root is NOT mistaken for an escape", () => {
    // ⊘ `rel.startsWith("..")` without a separator guard — the exact bug
    // moveScripts.ts's old `isPathInside` had. "..foo/x".startsWith("..") is
    // true, which a naive check would wrongly reject.
    const dotDotFooSegment = platform === "posix" ? "../..foo/x" : "..\\..foo\\x";
    const r = resolveScriptFsPath(dotDotFooSegment, scopeOf(platform));
    expect(r).toEqual({ ok: true, resolvedPath: f.join(f.root, "..foo", "x") });
  });

  it("row 12: a scripts root configured with a trailing separator still contains its members", () => {
    // ⊘ naive `root + sep` string concatenation containment.
    const trailingRoot = platform === "posix" ? f.root + "/" : f.root + "\\";
    const scope = scopeOf(platform, { scriptsRootPath: trailingRoot });
    const r = resolveScriptFsPath("../shared/x.json", scope);
    expect(r).toEqual({ ok: true, resolvedPath: f.join(f.root, "shared", "x.json") });
  });

  it("row 20 (pure half): a relative path is resolved lexically — this module never touches the filesystem, so a name that happens to be a symlink is treated exactly like an ordinary directory. Filesystem-level symlink-follow behavior is covered in scriptFs.test.ts.", () => {
    // ⊘ a "hardened" realpath rewrite — this module takes ONLY strings; there is
    // nothing here that could call realpath, which is itself the guarantee.
    const r = resolveScriptFsPath("linked/x.json", scopeOf(platform));
    expect(r).toEqual({ ok: true, resolvedPath: f.join(f.scriptDir, "linked", "x.json") });
  });

  it("row 21: scriptsRootPath undefined refuses root-subtree reads but keeps the script's own-dir scope", () => {
    // ⊘ a union check that treats an undefined root as "allow everything".
    const scope = scopeOf(platform, { scriptsRootPath: undefined });
    const outsideOwnDir = resolveScriptFsPath("../shared/x.json", scope);
    expect(outsideOwnDir.ok).toBe(false);
    if (!outsideOwnDir.ok) expect(outsideOwnDir.code).toBe("PathOutsideScope");
    const insideOwnDir = resolveScriptFsPath("x.json", scope);
    expect(insideOwnDir).toEqual({ ok: true, resolvedPath: f.join(f.scriptDir, "x.json") });
  });

  it("row 22: a script running outside the scripts root still gets its own-folder scope", () => {
    // ⊘ containment logic that only ever checks against the root — a script
    // opened via CodeLens on an arbitrary file must still be able to read
    // files next to itself, even though its directory has nothing to do with R.
    const outsideDir = platform === "posix" ? "/home/u/proj" : "C:\\home\\u\\proj";
    const scope = scopeOf(platform, { scriptDirPath: outsideDir });
    const r = resolveScriptFsPath("x.json", scope);
    expect(r).toEqual({ ok: true, resolvedPath: f.join(outsideDir, "x.json") });
    // R is unconditionally part of the union too (row 6, decision 4: "root is
    // always in the union" — "script anywhere"), so an absolute path inside R
    // still resolves even though D is nowhere near it.
    const rootPath = resolveScriptFsPath(f.join(f.root, "x.json"), scope);
    expect(rootPath).toEqual({ ok: true, resolvedPath: f.join(f.root, "x.json") });
    // What's still refused is a path outside BOTH D and R.
    const trulyOutside = resolveScriptFsPath(
      platform === "posix" ? "/etc/passwd" : "C:\\Windows\\win.ini",
      scope
    );
    expect(trulyOutside.ok).toBe(false);
  });
});

describe("resolveScriptFsPath — posix-specific rows", () => {
  it("row 5: an absolute path entirely outside root and script dir is refused", () => {
    const r = resolveScriptFsPath("/etc/passwd", scopeOf("posix"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PathOutsideScope");
  });

  it("row 6: an absolute path inside the root is allowed (root is always in the union)", () => {
    // ⊘ containment that only accepts relative paths, ignoring decision 4.
    const r = resolveScriptFsPath("/ws/.nexus/scripts/shared/x.json", scopeOf("posix"));
    expect(r).toEqual({ ok: true, resolvedPath: "/ws/.nexus/scripts/shared/x.json" });
  });
});

describe("resolveScriptFsPath — win32-specific rows", () => {
  it("row 13: drive-relative 'C:x.json' is InvalidPath, never resolved against the process CWD", () => {
    // ⊘ letting path.win32.resolve interpret drive-relative paths against
    // process.cwd() for that drive.
    const r = resolveScriptFsPath("C:x.json", scopeOf("win32"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("InvalidPath");
  });

  it("row 14: a rootless absolute '\\x.json' resolves onto the script dir's drive, then is refused", () => {
    // ⊘ treating a leading backslash as automatically out of scope without
    // resolving it onto the current drive first (or vice versa, letting it pass).
    const r = resolveScriptFsPath("\\x.json", scopeOf("win32"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PathOutsideScope");
      expect(r.detail).toBe("C:\\x.json");
    }
  });

  it("row 15: a path on a different drive is refused (path.relative returns an absolute path across drives)", () => {
    // ⊘ treating isAbsolute(rel) as "skip containment" instead of "reject".
    const r = resolveScriptFsPath("D:\\x", scopeOf("win32"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PathOutsideScope");
  });

  it("row 16: mixed '/' and '\\' separators in a traversal path resolve fine on win32", () => {
    const r = resolveScriptFsPath("..\\shared/x.json", scopeOf("win32"));
    expect(r).toEqual({ ok: true, resolvedPath: "C:\\ws\\.nexus\\scripts\\shared\\x.json" });
  });

  it("row 17: containment is case-insensitive on win32", () => {
    // ⊘ a case-sensitive comparison on win32.
    const r = resolveScriptFsPath("C:\\WS\\.NEXUS\\Scripts\\Cisco\\X.JSON", scopeOf("win32"));
    expect(r.ok).toBe(true);
  });

  it("row 18: a UNC path with a matching share stays inside its own scope", () => {
    const scope = scopeOf("win32", {
      scriptDirPath: "\\\\srv\\share\\scripts\\cisco",
      scriptsRootPath: "\\\\srv\\share\\scripts"
    });
    const r = resolveScriptFsPath("..\\lib\\x", scope);
    expect(r).toEqual({ ok: true, resolvedPath: "\\\\srv\\share\\scripts\\lib\\x" });
  });

  it("row 19: a UNC path on a different share or host is refused", () => {
    // ⊘ drive-letter-only root parsing that never checks UNC host/share equality.
    const scope = scopeOf("win32", {
      scriptDirPath: "\\\\srv\\share\\scripts\\cisco",
      scriptsRootPath: "\\\\srv\\share\\scripts"
    });
    const crossShare = resolveScriptFsPath("\\\\srv\\share2\\x", scope);
    const crossHost = resolveScriptFsPath("\\\\other\\share\\x", scope);
    expect(crossShare.ok).toBe(false);
    expect(crossHost.ok).toBe(false);
  });
});

describe("isLexicallyWithin — direct unit coverage (used by moveScripts.ts too, Amendment A)", () => {
  it("the root itself is inside the root", () => {
    expect(isLexicallyWithin("/ws/scripts", "/ws/scripts", "posix")).toBe(true);
  });

  it("a descendant is inside", () => {
    expect(isLexicallyWithin("/ws/scripts/a.js", "/ws/scripts", "posix")).toBe(true);
    expect(isLexicallyWithin("/ws/scripts/cisco/a.js", "/ws/scripts", "posix")).toBe(true);
  });

  it("an unrelated directory is outside", () => {
    expect(isLexicallyWithin("/ws/elsewhere/a.js", "/ws/scripts", "posix")).toBe(false);
  });

  it("a sibling that shares a string prefix is outside — the moveScripts.ts regression this module fixes", () => {
    // ⊘ "/ws/scripts-backup".startsWith("/ws/scripts") is true as a STRING,
    // but this is a different directory. This is the exact case
    // moveScripts.test.ts pins against moveScriptIntoFolder.
    expect(isLexicallyWithin("/ws/scripts-backup/a.js", "/ws/scripts", "posix")).toBe(false);
  });

  it("assumption pin: path.win32.relative folds case internally, on any host OS — this is WHY isLexicallyWithin needs no explicit .toLowerCase() step", () => {
    // Not a test of this module — a test of the Node stdlib behavior
    // isLexicallyWithin's win32 case-insensitivity (decision 3) rests on. If
    // a future Node version ever changed this, isLexicallyWithin's win32
    // matrix (including the very next test) would start failing and this is
    // the assertion that would tell you why.
    expect(nodePath.win32.relative("c:\\a", "C:\\A\\x")).toBe("x");
  });

  it("win32 platform selection is what makes a differently-cased path still match — not an explicit fold in THIS module (the old moveScripts.isPathInside used whatever path.relative the CI host happened to be, i.e. posix on Linux CI)", () => {
    // The case-folding itself comes from path.win32.relative (pinned above).
    // What THIS test demonstrates is that isLexicallyWithin actually reaches
    // path.win32.relative for a "win32" scope — i.e. that the injected
    // `platform` argument is honored — rather than falling through to
    // path.posix.relative (case-sensitive) the way the old fixed-to-the-host
    // helper would on a Linux CI runner.
    expect(isLexicallyWithin("C:\\WS\\Scripts\\A.JS", "c:\\ws\\scripts", "win32")).toBe(true);
  });

  it("healed defect: platform is injectable, so the win32 matrix is testable on Linux CI (the old helper always used the host platform)", () => {
    // Running this on a posix CI host and getting a win32-correct answer IS the
    // regression test for "platform not injectable".
    expect(isLexicallyWithin("C:\\ws\\scripts\\..foo\\a.js", "C:\\ws\\scripts", "win32")).toBe(true);
  });
});
