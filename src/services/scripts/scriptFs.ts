import * as nodeFs from "node:fs/promises";
import * as vscode from "vscode";
import { resolveScriptFsPath, safeStringify, type ScriptFsScope } from "./scriptFsScope";
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

/**
 * The buffer size `boundedReadFile` allocates up front, given a size hint
 * (normally `stat.size`, but callers don't have to trust it) and the cap.
 * Pure, exported for direct unit tests.
 *
 * Clamped to `[0, maxBytes]` before the `+ 1`: a negative or NaN hint (a
 * hostile/buggy stat implementation) never allocates less than 1 byte, and a
 * hint already over the cap (an HONEST large-file stat — the common shape
 * once `readLocalFileBounded`'s own pre-read `stat.size > SCRIPT_FS_MAX_BYTES`
 * check has already rejected anything bigger) still allocates only the cap
 * itself, never more.
 */
export function initialReadCapacity(sizeHintBytes: number, maxBytes: number): number {
  return Math.min(Math.max(sizeHintBytes, 0), maxBytes) + 1;
}

/**
 * Read at most `maxBytes + 1` bytes of `fsPath`, allocating from `sizeHintBytes`
 * (normally `stat.size`) rather than always preallocating the full cap.
 * Exported for direct unit tests.
 *
 * WHY NOT `vscode.workspace.fs.readFile`: that API has no bounded-read
 * variant — it always materializes the entire file body in the extension
 * host before we get a chance to look at its length. If `stat` under-reports
 * (a lying FileSystemProvider, a file growing between `stat` and `read`, or —
 * pre-empted separately by the regular-file check below — a symlink inside
 * scope pointing at an endless source like `/dev/zero`), that "check the size
 * after reading" pattern has already done the unbounded read it was supposed
 * to prevent. Reading with `node:fs/promises` at the syscall level lets us
 * cap the read itself: the returned buffer can never exceed `maxBytes + 1`
 * bytes no matter how large — or endless — the underlying file turns out to
 * be. The `+ 1` (rather than exactly `maxBytes`) is what lets the caller
 * distinguish "the file is exactly at the cap" (`maxBytes` bytes back, legal)
 * from "the file is at least one byte over" (`maxBytes + 1` bytes back,
 * `FileTooLarge`) without a second syscall.
 *
 * WHY A SIZE HINT: always preallocating `maxBytes + 1` (4 MiB) regardless of
 * the real file's size meant `Promise.all(paths.map(nexus.fs.readText))` over
 * a few hundred tiny files transiently allocated gigabytes in the extension
 * host — the exact hazard bounded reads exist to avoid, just moved from "one
 * huge read" to "many small reads that add up huge". Sizing the INITIAL
 * buffer from the hint keeps the common case (an honest, typically small,
 * file) cheap. If the hint under-reported — the buffer fills completely
 * without hitting EOF — that's the stat-lies/growth signal the post-read
 * check exists for: grow ONCE to the full `maxBytes + 1` and keep reading, so
 * the over-cap detection property is never lost. Total allocation across both
 * buffers in that (rare) case is at most ~2× the cap, and only when the hint
 * was wrong.
 */
export async function boundedReadFile(fsPath: string, maxBytes: number, sizeHintBytes: number): Promise<Buffer> {
  let capacity = initialReadCapacity(sizeHintBytes, maxBytes);
  let buffer = Buffer.allocUnsafe(capacity);
  const handle = await nodeFs.open(fsPath, "r");
  try {
    let total = 0;
    let grownOnce = false;
    for (;;) {
      while (total < capacity) {
        const { bytesRead } = await handle.read(buffer, total, capacity - total, null);
        if (bytesRead === 0) return buffer.subarray(0, total); // EOF
        total += bytesRead;
      }
      // Buffer filled completely without hitting EOF. If we're already at the
      // full cap (or already grew once — never grow twice), that's the
      // authoritative "at least maxBytes + 1 bytes" signal — stop here.
      if (grownOnce || capacity >= maxBytes + 1) {
        return buffer.subarray(0, total);
      }
      const grown = Buffer.allocUnsafe(maxBytes + 1);
      buffer.copy(grown, 0, 0, total);
      buffer = grown;
      capacity = maxBytes + 1;
      grownOnce = true;
    }
  } finally {
    await handle.close();
  }
}

export async function scriptFsReadText(requested: unknown, ctx: ScriptFsContext): Promise<string> {
  const scope = buildScriptFsScope(ctx);
  if ("code" in scope) {
    throw fail(
      ctx,
      "readText",
      safeStringify(requested),
      "NoScriptDir",
      "This script has no folder on disk (untitled editor). Save it first — nexus.fs paths resolve against the script's own directory."
    );
  }
  if (hasBackslashOnNonFileScheme(requested, ctx.scriptUri.scheme)) {
    throw fail(
      ctx,
      "readText",
      safeStringify(requested),
      "InvalidPath",
      `backslash is not a valid path separator for a remote script location: ${safeStringify(requested)}`
    );
  }

  const resolution = resolveScriptFsPath(requested as string, scope);
  if (!resolution.ok) {
    // Pre-resolution failure — no resolved path exists yet, so the log (and
    // the thrown message) name the raw requested value.
    throw fail(
      ctx,
      "readText",
      safeStringify(requested),
      resolution.code,
      describeResolutionFailure(resolution, scope)
    );
  }
  // From here on, resolution succeeded — every failure log names the
  // RESOLVED absolute path, not the (possibly relative, possibly confusing
  // once several scripts are involved) raw requested value.
  const loggedPath = resolution.resolvedPath;

  if (ctx.scriptUri.scheme === "file") {
    return readLocalFileBounded(resolution.resolvedPath, loggedPath, ctx);
  }

  const uri = uriOf(resolution.resolvedPath, ctx.scriptUri);

  // Non-`file` schemes: `vscode.workspace.fs` is the only API surface a
  // FileSystemProvider exposes, and it has no bounded-read variant — there is
  // no syscall-level equivalent of `boundedReadFile` to drop down to for a
  // remote target. The size cap here is therefore BEST-EFFORT: it protects
  // *correctness* (a script never sees more than SCRIPT_FS_MAX_BYTES of
  // content) but not *peak extension-host memory* — a misbehaving remote
  // provider that lies about `stat.size` can still make `readFile` allocate
  // its true (oversized) body before the post-read check below rejects it.
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (err) {
    // Only a genuine "nothing is there" failure maps to FileNotFound; anything
    // else (permissions, an unavailable provider, ...) is ReadFailed — the
    // path resolved fine, the read itself is what didn't work.
    if (isNotFoundStatError(err)) {
      throw fail(ctx, "readText", loggedPath, "FileNotFound", `${loggedPath}: not found`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, "readText", loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  // Bitmask test, not `===` — same discipline as scriptScanner.ts, so a
  // symlinked directory is caught too.
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    throw fail(ctx, "readText", loggedPath, "FileNotFound", `${loggedPath}: is a directory`);
  }
  // Checked BEFORE reading so an honestly-reported multi-GB file is never
  // pulled into memory in the common case — belt, not braces, here: see the
  // post-read check below for the braces.
  if (stat.size > SCRIPT_FS_MAX_BYTES) {
    throw fail(ctx, "readText", loggedPath, "FileTooLarge", `${loggedPath}: ${stat.size} bytes exceeds the ${SCRIPT_FS_MAX_BYTES}-byte limit`, {
      sizeBytes: stat.size,
      maxBytes: SCRIPT_FS_MAX_BYTES
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, "readText", loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  // Braces: some FileSystemProviders report a stale/zero `size` from stat,
  // and `readFile` has no size limit of its own — this is the only thing
  // standing between a lying remote provider and an unbounded read (see the
  // module-level comment on `boundedReadFile` for why `file:` doesn't have
  // this problem).
  if (bytes.byteLength > SCRIPT_FS_MAX_BYTES) {
    throw fail(
      ctx,
      "readText",
      loggedPath,
      "FileTooLarge",
      `${loggedPath}: ${bytes.byteLength} bytes exceeds the ${SCRIPT_FS_MAX_BYTES}-byte limit`,
      { sizeBytes: bytes.byteLength, maxBytes: SCRIPT_FS_MAX_BYTES }
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail(ctx, "readText", loggedPath, "NotUtf8", `${loggedPath}: not valid UTF-8`);
  }

  ctx.log(`fs.readText ${loggedPath} (${bytes.byteLength} bytes)`);
  return text;
}

/**
 * `file:` scheme read path — native `node:fs/promises`, bounded at the
 * syscall level. See `boundedReadFile`'s doc comment for why this bypasses
 * `vscode.workspace.fs` entirely rather than following the module's usual
 * "everything through `vscode.workspace.fs`" convention: that API cannot
 * bound a read, and an unbounded read into the extension host is exactly the
 * hazard this function exists to close.
 */
async function readLocalFileBounded(fsPath: string, loggedPath: string, ctx: ScriptFsContext): Promise<string> {
  let stat: import("node:fs").Stats;
  try {
    stat = await nodeFs.stat(fsPath); // follows symlinks, matching decision 3's lexical-containment policy
  } catch (err) {
    if (isNotFoundStatError(err)) {
      throw fail(ctx, "readText", loggedPath, "FileNotFound", `${loggedPath}: not found`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, "readText", loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  if (stat.isDirectory()) {
    throw fail(ctx, "readText", loggedPath, "FileNotFound", `${loggedPath}: is a directory`);
  }
  // Rejects FIFOs, sockets, and character/block devices — e.g. a symlink
  // inside scope pointing at `/dev/zero`, which would otherwise hand
  // `boundedReadFile` an endless byte stream. Caught here, before ANY read is
  // attempted — `node:fs`'s `Stats.isFile()` reports the RESOLVED target's
  // type (this call is `stat`, not `lstat`), so a symlink to a device is
  // caught exactly like a direct reference to one would be.
  if (!stat.isFile()) {
    throw fail(ctx, "readText", loggedPath, "FileNotFound", `${loggedPath}: is not a regular file`);
  }
  // Checked BEFORE opening the file: when an honest stat already knows the
  // file is oversized, there is no reason to pay for even a capped open+read
  // — worst on `file:` URIs backed by a slow network mount. `stat.size` is
  // trustworthy here specifically BECAUSE we haven't read anything yet to
  // contradict it; the bounded read below (and its own post-read check) stays
  // as the belt-and-braces layer for the case stat DIDN'T catch: a lying
  // provider, or a file that grows between this stat and the read.
  if (stat.size > SCRIPT_FS_MAX_BYTES) {
    throw fail(
      ctx,
      "readText",
      loggedPath,
      "FileTooLarge",
      `${loggedPath}: ${stat.size} bytes exceeds the ${SCRIPT_FS_MAX_BYTES}-byte limit`,
      { sizeBytes: stat.size, maxBytes: SCRIPT_FS_MAX_BYTES }
    );
  }

  let bytes: Buffer;
  try {
    bytes = await boundedReadFile(fsPath, SCRIPT_FS_MAX_BYTES, stat.size);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, "readText", loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  if (bytes.byteLength > SCRIPT_FS_MAX_BYTES) {
    // `stat.size` is only trustworthy here when it AGREES that the file is
    // oversized — i.e. it wasn't the thing that lied. When it under-reported
    // (the exact "stat lies" / racing-growth hazard this function defends
    // against), `maxBytes + 1` — the one number `boundedReadFile` itself
    // guarantees — is reported instead of repeating the untrustworthy value.
    const sizeBytes = stat.size > SCRIPT_FS_MAX_BYTES ? stat.size : SCRIPT_FS_MAX_BYTES + 1;
    throw fail(
      ctx,
      "readText",
      loggedPath,
      "FileTooLarge",
      `${loggedPath}: exceeds the ${SCRIPT_FS_MAX_BYTES}-byte limit`,
      { sizeBytes, maxBytes: SCRIPT_FS_MAX_BYTES }
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail(ctx, "readText", loggedPath, "NotUtf8", `${loggedPath}: not valid UTF-8`);
  }

  ctx.log(`fs.readText ${loggedPath} (${bytes.byteLength} bytes)`);
  return text;
}

export async function scriptFsExists(requested: unknown, ctx: ScriptFsContext): Promise<boolean> {
  const scope = buildScriptFsScope(ctx);
  if ("code" in scope) {
    throw fail(
      ctx,
      "exists",
      safeStringify(requested),
      "NoScriptDir",
      "This script has no folder on disk (untitled editor). Save it first — nexus.fs paths resolve against the script's own directory."
    );
  }
  if (hasBackslashOnNonFileScheme(requested, ctx.scriptUri.scheme)) {
    throw fail(
      ctx,
      "exists",
      safeStringify(requested),
      "InvalidPath",
      `backslash is not a valid path separator for a remote script location: ${safeStringify(requested)}`
    );
  }

  const resolution = resolveScriptFsPath(requested as string, scope);
  if (!resolution.ok) {
    throw fail(
      ctx,
      "exists",
      safeStringify(requested),
      resolution.code,
      describeResolutionFailure(resolution, scope)
    );
  }

  // No read hazard here — this is a plain existence probe, so `vscode.workspace.fs.stat`
  // (uniformly, for every scheme) is fine: no body is ever pulled into memory.
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
 * `vscode.workspace.fs.stat` / `node:fs` codes (real `FileSystemError.code`,
 * and the raw Node `fs` codes some FileSystemProviders — and this repo's own
 * test mocks — let through unwrapped) that mean "nothing is there", as
 * opposed to "it's there but couldn't be read" (permissions, an unavailable
 * provider, ...). Only these map to `FileNotFound`; everything else maps to
 * `ReadFailed`, matching `ReadFailed`'s documented meaning ("stat ok but read
 * failed"). Shared by both the `file:` (`node:fs`) and non-`file:`
 * (`vscode.workspace.fs`) stat call sites.
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
  loggedPath: string,
  code: ScriptFsErrorCode,
  message: string,
  extra?: Record<string, unknown>
): Error {
  ctx.log(`fs.${method} ${loggedPath} → ${code}`);
  return makeFsError(code, message, extra);
}
