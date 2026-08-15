import * as vscode from "vscode";
import { resolveScriptFsPath, type ScriptFsScope } from "./scriptFsScope";
import type { ScriptFsErrorCode } from "./scriptTypes";

/** Decision 7 — not configurable. */
export const SCRIPT_FS_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface ScriptFsContext {
  scriptUri: vscode.Uri;
  /** undefined ⇢ untitled: script ⇢ every nexus.fs call throws NoScriptDir. */
  scriptDirUri: vscode.Uri | undefined;
  /** Snapshotted at run start — config changes never touch an in-flight run. */
  scriptsRootUri: vscode.Uri | undefined;
  /** Record-bound `logEvent` closure — lines get the usual `[hh:mm:ss.sss] Script@Session` prefix. */
  log: (text: string) => void;
}

/**
 * Build the pure containment scope for a run, or the sentinel that means
 * "every call throws NoScriptDir" (untitled: script — no on-disk location).
 * Exported for unit tests.
 *
 * Scheme handling (decision 5 — "all reads via `vscode.workspace.fs`,
 * remote-compat"):
 *  - `file:` scheme: paths come from `.fsPath`, platform derived from the
 *    HOST'S `process.platform` (a `file:` Uri is always local).
 *  - Any other scheme (`vscode-remote:` included — the CodeLens explicitly
 *    supports it): paths come from `.path` (always POSIX), platform "posix".
 *  - `scriptsRootUri` participates in the union ONLY if its scheme AND
 *    (case-insensitive) authority match `scriptUri`'s — never compare a
 *    remote path against a local root or vice versa.
 */
export function buildScriptFsScope(ctx: ScriptFsContext): ScriptFsScope | { code: "NoScriptDir" } {
  if (!ctx.scriptDirUri) return { code: "NoScriptDir" };

  const scriptDirPath = pathOf(ctx.scriptDirUri);
  const platform = ctx.scriptUri.scheme === "file" ? (process.platform === "win32" ? "win32" : "posix") : "posix";

  const rootMatchesScheme =
    ctx.scriptsRootUri !== undefined &&
    ctx.scriptsRootUri.scheme === ctx.scriptUri.scheme &&
    ctx.scriptsRootUri.authority.toLowerCase() === ctx.scriptUri.authority.toLowerCase();

  return {
    scriptDirPath,
    scriptsRootPath: rootMatchesScheme ? pathOf(ctx.scriptsRootUri!) : undefined,
    platform
  };
}

function pathOf(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.path;
}

/** Resolved path → Uri, preserving the script's own scheme + authority. */
function uriOf(resolvedPath: string, scriptUri: vscode.Uri): vscode.Uri {
  if (scriptUri.scheme === "file") return vscode.Uri.file(resolvedPath);
  return scriptUri.with({ path: resolvedPath, query: "", fragment: "" });
}

/**
 * Defense against a backslash-traversal bypass on non-`file` schemes.
 *
 * `buildScriptFsScope` forces `platform: "posix"` for every non-`file` scheme
 * (there is no reliable way to know a remote host's OS from its Uri), and
 * posix path semantics treat `\` as an ordinary filename character — so
 * `resolveScriptFsPath` sees `"..\\..\\etc\\passwd"` as one harmless (if
 * odd-looking) filename segment and happily contains it. But the request
 * still reaches the remote FileSystemProvider as a literal string, and if
 * that provider's actual OS is Windows (Remote-SSH / WSL to a Windows host),
 * IT normalizes `\` into a real path separator — turning our "contained"
 * lexical result into a real traversal on the far end. A local `file:` posix
 * path keeps allowing `\` (a real filename character there, and the resolver
 * and the local disk provider agree on that), so this only fires for schemes
 * where the resolver's assumption and the provider's behavior can diverge.
 */
function hasBackslashOnNonFileScheme(requested: unknown, scheme: string): boolean {
  return scheme !== "file" && typeof requested === "string" && requested.includes("\\");
}

export async function scriptFsReadText(requested: unknown, ctx: ScriptFsContext): Promise<string> {
  const scope = buildScriptFsScope(ctx);
  if ("code" in scope) {
    throw fail(
      ctx,
      "readText",
      requested,
      "NoScriptDir",
      "This script has no folder on disk (untitled editor). Save it first — nexus.fs paths resolve against the script's own directory."
    );
  }
  if (hasBackslashOnNonFileScheme(requested, ctx.scriptUri.scheme)) {
    throw fail(
      ctx,
      "readText",
      requested,
      "InvalidPath",
      `backslash is not a valid path separator for a remote script location: ${JSON.stringify(requested)}`
    );
  }

  const resolution = resolveScriptFsPath(requested as string, scope);
  if (!resolution.ok) {
    throw fail(ctx, "readText", requested, resolution.code, describeResolutionFailure(resolution, scope));
  }

  const uri = uriOf(resolution.resolvedPath, ctx.scriptUri);

  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (err) {
    // Only a genuine "nothing is there" failure maps to FileNotFound; anything
    // else (permissions, an unavailable provider, ...) is ReadFailed — the
    // path resolved fine, the read itself is what didn't work.
    if (isNotFoundStatError(err)) {
      throw fail(ctx, "readText", requested, "FileNotFound", `${resolution.resolvedPath}: not found`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, "readText", requested, "ReadFailed", `${resolution.resolvedPath}: ${detail}`);
  }
  // Bitmask test, not `===` — same discipline as scriptScanner.ts, so a
  // symlinked directory is caught too.
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    throw fail(ctx, "readText", requested, "FileNotFound", `${resolution.resolvedPath}: is a directory`);
  }
  // Checked BEFORE reading so a multi-GB file is never pulled into memory.
  if (stat.size > SCRIPT_FS_MAX_BYTES) {
    throw fail(
      ctx,
      "readText",
      requested,
      "FileTooLarge",
      `${resolution.resolvedPath}: ${stat.size} bytes exceeds the ${SCRIPT_FS_MAX_BYTES}-byte limit`,
      { sizeBytes: stat.size, maxBytes: SCRIPT_FS_MAX_BYTES }
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, "readText", requested, "ReadFailed", `${resolution.resolvedPath}: ${detail}`);
  }
  // Belt-and-braces: some FileSystemProviders report a stale/zero `size` from
  // stat, and `readFile` has no size limit of its own.
  if (bytes.byteLength > SCRIPT_FS_MAX_BYTES) {
    throw fail(
      ctx,
      "readText",
      requested,
      "FileTooLarge",
      `${resolution.resolvedPath}: ${bytes.byteLength} bytes exceeds the ${SCRIPT_FS_MAX_BYTES}-byte limit`,
      { sizeBytes: bytes.byteLength, maxBytes: SCRIPT_FS_MAX_BYTES }
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail(ctx, "readText", requested, "NotUtf8", `${resolution.resolvedPath}: not valid UTF-8`);
  }

  ctx.log(`fs.readText ${resolution.resolvedPath} (${bytes.byteLength} bytes)`);
  return text;
}

export async function scriptFsExists(requested: unknown, ctx: ScriptFsContext): Promise<boolean> {
  const scope = buildScriptFsScope(ctx);
  if ("code" in scope) {
    throw fail(
      ctx,
      "exists",
      requested,
      "NoScriptDir",
      "This script has no folder on disk (untitled editor). Save it first — nexus.fs paths resolve against the script's own directory."
    );
  }
  if (hasBackslashOnNonFileScheme(requested, ctx.scriptUri.scheme)) {
    throw fail(
      ctx,
      "exists",
      requested,
      "InvalidPath",
      `backslash is not a valid path separator for a remote script location: ${JSON.stringify(requested)}`
    );
  }

  const resolution = resolveScriptFsPath(requested as string, scope);
  if (!resolution.ok) {
    throw fail(ctx, "exists", requested, resolution.code, describeResolutionFailure(resolution, scope));
  }

  const uri = uriOf(resolution.resolvedPath, ctx.scriptUri);
  let found: boolean;
  try {
    // Any entry type — file, directory, symlink — counts. readText on a
    // directory still fails; this is a plain existence probe.
    await vscode.workspace.fs.stat(uri);
    found = true;
  } catch {
    found = false;
  }
  ctx.log(`fs.exists ${resolution.resolvedPath} → ${found}`);
  return found;
}

function describeResolutionFailure(
  resolution: Extract<ReturnType<typeof resolveScriptFsPath>, { ok: false }>,
  scope: ScriptFsScope
): string {
  if (resolution.code === "InvalidPath") return resolution.detail;
  const roots = [scope.scriptDirPath, scope.scriptsRootPath].filter((r): r is string => r !== undefined);
  return `${resolution.detail} is outside the script's allowed scope (${roots.join(", ")})`;
}

/**
 * `vscode.workspace.fs.stat` codes (real `FileSystemError.code`, and the raw
 * Node `fs` codes some FileSystemProviders — and this repo's own test mocks —
 * let through unwrapped) that mean "nothing is there", as opposed to "it's
 * there but couldn't be read" (permissions, an unavailable provider, ...).
 * Only these map to `FileNotFound`; everything else maps to `ReadFailed`,
 * matching `ReadFailed`'s documented meaning ("stat ok but read failed").
 */
const NOT_FOUND_STAT_CODES = new Set(["FileNotFound", "FileNotADirectory", "ENOENT", "ENOTDIR"]);

function isNotFoundStatError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && NOT_FOUND_STAT_CODES.has(code);
}

/**
 * Local error factory — deliberately not `scriptRuntimeManager.ts`'s
 * `makeError` to avoid a manager → scriptFs import cycle. Same shape so
 * `extra` rides the existing `reviveError` channel — TOP-LEVEL, not nested
 * under an `.extra` property: `scriptRuntimeManager.ts`'s `extraFieldsOf`
 * collects every own-enumerable property except `code`/`message`/`stack`/
 * `name` into the RPC error's `extra` object, and the worker's `reviveError`
 * spreads that back onto the revived Error — so a field placed here as a
 * plain top-level property (e.g. `sizeBytes`) round-trips as
 * `err.sizeBytes` script-side, matching the docs and the d.ts. Nesting it
 * under a property literally named `extra` would round-trip as
 * `err.extra.sizeBytes` instead (double-wrapped: `extraFieldsOf` would
 * collect the single own property named `"extra"`, then `reviveError`'s
 * spread puts that whole object back under `err.extra`).
 */
function makeFsError(code: ScriptFsErrorCode, message: string, extra?: Record<string, unknown>): Error & { code: string } {
  return Object.assign(new Error(message), { code }, extra) as Error & { code: string };
}

function fail(
  ctx: ScriptFsContext,
  method: "readText" | "exists",
  requested: unknown,
  code: ScriptFsErrorCode,
  message: string,
  extra?: Record<string, unknown>
): Error {
  ctx.log(`fs.${method} ${String(requested)} → ${code}`);
  return makeFsError(code, message, extra);
}
