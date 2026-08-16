/**
 * Pure lexical path containment for `nexus.fs`.
 *
 * No `vscode` import — worker-safe, same rule as `scriptTypes.ts`. This is also
 * the module a future `nexus.include()` (Phase 2) would reuse; that is the only
 * Phase-2 accommodation made here.
 *
 * Containment is LEXICAL, not filesystem-verified: no `realpathSync` anywhere.
 * Symlinks under a scope root are followed, matching `scriptScanner.ts`'s
 * documented policy of walking through them. This module only ever looks at
 * strings.
 *
 * Decision table (verbatim from the implementation plan). `D` = the running
 * script's own directory, `R` = the scripts root (`resolveScriptsDir`).
 *
 * | # | Input (`requested`) | Setup | Result | Why |
 * |---|---|---|---|---|
 * | 1 | `"data.json"` | D inside R | ok → `D/data.json` | plain relative |
 * | 2 | `"./x.json"`, `"sub//x.json"`, `"sub/./x.json"` | — | ok, normalized | `p.resolve` collapses |
 * | 3 | `"../shared/x.json"` | `D=R/cisco` | ok → `R/shared/x.json` | `..` allowed while it lands in a scope root |
 * | 4 | `"../../secrets.txt"` | `D=R/cisco` | PathOutsideScope | escapes R and D |
 * | 5 | `"/etc/passwd"` (posix) / `"C:\\Windows\\win.ini"` (win32) | — | PathOutsideScope | outside absolute |
 * | 6 | absolute path inside R | script anywhere | ok | decision 4: root is always in the union |
 * | 7 | `""`, `"   "`, non-string, `"a\0b"` | — | InvalidPath | steps 1-2 |
 * | 8 | `"."` | — | ok → `D` itself | resolves to a directory; the *read* then fails (FileNotFound, "is a directory") — containment is not the layer that knows file types |
 * | 9 | `".."` | `D=R/cisco` | ok → `R` | inside R |
 * | 10 | candidate `R + "-evil/x"` (e.g. `/ws/.nexus/scripts-evil/x`) | — | PathOutsideScope | sibling-prefix trap; killed by `p.relative`, not string prefixes |
 * | 11 | `"../..foo/x"` where `..foo` is a real dir under R | `D=R/b` | ok | segment-aware `..` check |
 * | 12 | R configured with trailing separator (`"/ws/scripts/"`) | — | ok for members | step 1 of isLexicallyWithin strips it |
 * | 13 | `"C:x.json"` (win32) | — | InvalidPath | drive-relative |
 * | 14 | `"\\x.json"` (win32 rootless absolute) | `D=C:\ws\...` | resolves to `C:\x.json` → PathOutsideScope | resolved onto D's drive, then rejected |
 * | 15 | `"D:\\x"` (win32, other drive) | `D` on `C:` | PathOutsideScope | cross-drive → `rel` absolute |
 * | 16 | `"..\\shared/x.json"` (win32 mixed separators) | — | ok | win32 resolve accepts both |
 * | 17 | Different casing, win32: candidate `C:\WS\.NEXUS\Scripts\X.JSON` vs root `c:\ws\.nexus\scripts` | — | ok (inside) | decision 3 |
 * | 18 | UNC: `D=\\srv\share\scripts\cisco`, `R=\\srv\share\scripts`; `"..\\lib\\x"` | — | ok | UNC treated as ordinary win32 paths by `path.win32` |
 * | 19 | UNC cross-share `\\srv\share2\x` or cross-host `\\other\share\x` | R as in 18 | PathOutsideScope | relative comes back absolute |
 * | 20 | `"linked/x.json"` where `D/linked` is a symlink out of R | — | ok (lexical!) | decision 3 — no realpath; consistent with scanner |
 * | 21 | any input | `scriptsRootPath === undefined` | only D-subtree passes | scheme-mismatch / untrusted-root fallback |
 * | 22 | script outside R (CodeLens on arbitrary file), `"x.json"` | `D=/home/u/proj` | ok → `D/x.json` | decision 4: own-folder scope survives |
 * | 23 | `"./b.js"` resolved from base `R/lib` (a module's own dir) | `D=R/cisco` | ok → `R/lib/b.js` | Phase 2: the RESOLUTION base is per-file |
 * | 24 | `"x.js"` resolved from a base outside both roots | — | PathOutsideScope | Phase 2: a base is NOT a third root — the containment union is unchanged |
 * | 25 | `""`, non-string, NUL, `"C:x"` from any base | — | InvalidPath | Phase 2: pre-resolution refusals happen before the base is consulted |
 */

import * as path from "node:path";

export type ScriptFsPlatform = "win32" | "posix";

export interface ScriptFsScope {
  /** Absolute path of the running script's own directory. */
  scriptDirPath: string;
  /**
   * Absolute path of the scripts root (resolveScriptsDir), or undefined when it
   * does not apply to this script (different Uri scheme/authority — see
   * `scriptFs.ts`'s `buildScriptFsScope` — or root resolution failed). When
   * undefined, only the script-dir subtree is legal.
   */
  scriptsRootPath: string | undefined;
  /** Separator + casing semantics. Injected so the win32 matrix runs on Linux CI. */
  platform: ScriptFsPlatform;
}

export type ScriptFsResolution =
  | { ok: true; resolvedPath: string }
  | { ok: false; code: "InvalidPath" | "PathOutsideScope"; detail: string };

// win32 drive-relative paths ("C:file.txt") — path.resolve would resolve these
// against the process's per-drive CWD, which has nothing to do with the
// script. There is no sane meaning for them here (row 13).
const WIN32_DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/;

/**
 * Render an arbitrary (possibly not-actually-a-string, since `requested`
 * arrives over the worker RPC boundary as `unknown`) value into an error
 * detail / log line WITHOUT ever throwing.
 *
 * `JSON.stringify` is not safe for this: it throws on a `BigInt` ("Do not
 * know how to serialize a BigInt") and on a cyclic object ("Converting
 * circular structure to JSON") — both structured-cloneable, so both are
 * values a script's worker can genuinely send as `nexus.fs.readText(x)`.
 * Letting that throw escape here means the InvalidPath refusal never gets
 * built at all: the whole call falls through to dispatchRpc's generic catch,
 * the typed `InvalidPath` code is lost, and the refusal never reaches the
 * audit log (`ctx.log`) either — exactly the call this function's caller
 * exists to explain. Exported so `scriptFs.ts` uses the same fallback chain
 * for the identical hazard in its backslash-guard message.
 */
export function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // fall through
  }
  try {
    return String(value);
  } catch {
    // A custom toString()/valueOf()/[Symbol.toPrimitive] can throw too —
    // this never does.
    return Object.prototype.toString.call(value);
  }
}

function platformPath(platform: ScriptFsPlatform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Resolve a script-supplied path against its scope, applying the two-root
 * union containment check. See the decision table above for the full matrix.
 *
 * Relative requests resolve against the running script's own directory — which
 * is exactly `resolveScriptFsPathFrom` with the entry script's directory as the
 * base, and is defined that way so the 22-row matrix above cannot drift from
 * the base-aware implementation underneath it.
 */
export function resolveScriptFsPath(requested: string, scope: ScriptFsScope): ScriptFsResolution {
  return resolveScriptFsPathFrom(requested, scope.scriptDirPath, scope);
}

/**
 * `resolveScriptFsPath` with the RESOLUTION base stated explicitly — the entry
 * point `nexus.include()` (and a module's own `nexus.fs`) uses so that a
 * relative path always resolves against the file it is written in, however deep
 * in an include chain that file sits.
 *
 * THE BASE IS NOT A ROOT. It only decides what a relative request is relative
 * to; whether the RESULT is legal is still decided by the unchanged two-root
 * union (the entry script's own directory ∪ the scripts root, rows 1-22 above).
 * Containment is a property of the run, not of the file doing the asking — one
 * containment implementation, one test matrix, one audit point (row 24). Every
 * module's directory is, by induction, already inside that union, so an honest
 * base never widens anything; a base that somehow isn't (a forged module id on
 * the RPC wire — see `scriptInclude.ts`'s trust model) can therefore only
 * change WHICH of the run's own already-resolved directories a relative path
 * is measured from, and never what the result is allowed to be.
 */
export function resolveScriptFsPathFrom(
  requested: string,
  baseDirPath: string,
  scope: ScriptFsScope
): ScriptFsResolution {
  if (typeof requested !== "string" || requested.trim() === "") {
    return {
      ok: false,
      code: "InvalidPath",
      detail: `path must be a non-empty string (got ${safeStringify(requested)})`
    };
  }
  // NUL truncation is the classic bypass for downstream native calls.
  if (requested.includes("\0")) {
    return {
      ok: false,
      code: "InvalidPath",
      detail: `path must not contain a NUL byte: ${safeStringify(requested)}`
    };
  }
  if (scope.platform === "win32" && WIN32_DRIVE_RELATIVE_RE.test(requested)) {
    return {
      ok: false,
      code: "InvalidPath",
      detail: `drive-relative paths are not supported: ${safeStringify(requested)}`
    };
  }

  const p = platformPath(scope.platform);
  // The single normalization step: collapses `.`/`..`/duplicate separators,
  // accepts both `/` and `\` on win32, makes relative paths base-dir-relative,
  // passes absolutes through, and resolves win32 rootless absolutes onto the
  // base dir's drive — after which containment decides.
  const candidate = p.resolve(baseDirPath, requested);

  const inside =
    isLexicallyWithin(candidate, scope.scriptDirPath, scope.platform) ||
    (scope.scriptsRootPath !== undefined && isLexicallyWithin(candidate, scope.scriptsRootPath, scope.platform));

  if (!inside) {
    return { ok: false, code: "PathOutsideScope", detail: candidate };
  }
  return { ok: true, resolvedPath: candidate };
}

/**
 * The directory containing `filePath`, under the SCOPE'S platform semantics
 * rather than the host's — `path.dirname` is bound to whichever platform the
 * extension host happens to run on, so a win32 path handed to it on a Linux
 * host (a `file:` script on Windows, or this repo's win32 test matrix) comes
 * back as `"."` and every module under it would resolve its siblings against
 * the process CWD. Injected platform, same reason `isLexicallyWithin` takes
 * one.
 *
 * Used to derive each included module's own resolution base (see
 * `resolveScriptFsPathFrom`) from its resolved absolute path.
 */
export function scriptFsDirname(filePath: string, platform: ScriptFsPlatform): string {
  return platformPath(platform).dirname(filePath);
}

/**
 * Segment-aware lexical containment: is `candidate` at or below `root` as a
 * PATH? Case-insensitive on win32 (decision 3) via `path.win32.relative`'s own
 * case folding — see the comment inside. Exported for tests and Phase 2
 * (`nexus.include()`).
 */
export function isLexicallyWithin(candidate: string, root: string, platform: ScriptFsPlatform): boolean {
  const p = platformPath(platform);
  // p.resolve also strips a trailing separator (p.resolve("/a/") === "/a");
  // drive roots ("C:\", "/") survive as themselves.
  const resolvedCandidate = p.resolve(candidate);
  const resolvedRoot = p.resolve(root);
  // Decision 3 (case-insensitive on win32) falls out of `path.win32.relative`
  // for free — Node's win32 path implementation already folds case when
  // comparing segments (verified empirically: `path.win32.relative("C:\\ABC",
  // "C:\\abc\\file.txt")` returns `"file.txt"`, not a `".."`-prefixed escape),
  // regardless of the host OS running this code. No explicit `.toLowerCase()`
  // step is needed — one was here previously and did nothing observable.

  const rel = p.relative(resolvedRoot, resolvedCandidate);
  if (rel === "") return true; // the root itself
  if (p.isAbsolute(rel)) return false; // cross-drive (win32) / cross-UNC-share / cross-host
  if (rel === "..") return false;
  // Segment-aware: ".." + sep, not a bare startsWith("..") — keeps a directory
  // literally named "..foo" inside the root from being rejected (row 11; the
  // bug moveScripts.ts's old `isPathInside` had).
  if (rel.startsWith(".." + p.sep)) return false;
  return true;
}
