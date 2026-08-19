import * as nodeFs from "node:fs/promises";
import * as vscode from "vscode";
import { ReadSlotScheduler } from "./readSlotScheduler";
import { resolveScriptFsPathFrom, safeStringify, type ScriptFsScope } from "./scriptFsScope";
import type { ScriptFsErrorCode } from "./scriptTypes";

/**
 * Which entry point an audit line (and a refusal) is filed under.
 *
 * `include` is `nexus.include()`'s source read: the same reader, the same pool,
 * the same cap — a different verb, because the Output Channel must not tell a
 * script's author they called `nexus.fs.readText` when they wrote
 * `nexus.include`. It is deliberately NOT `fs.include`: include is not part of
 * the `nexus.fs` namespace.
 */
type ScriptFsAuditMethod = "readText" | "exists" | "include";

/** The verb an audit line is filed under. See `ScriptFsAuditMethod`. */
function auditVerb(method: ScriptFsAuditMethod): string {
  return method === "include" ? "include" : `fs.${method}`;
}

/**
 * How many `nexus.fs.readText` calls may have a file body in memory at once,
 * across every running script. Bounds the HOST-side (extension-host) transient
 * allocation at ~`SCRIPT_FS_MAX_CONCURRENT_READS × SCRIPT_FS_MAX_BYTES_CEILING`
 * (64 MiB; 16 MiB at the default 4 MiB cap). Quoted against the CEILING, not
 * `ctx.maxBytes`: the cap is snapshotted per run while this pool is
 * host-global, so the only figure that holds across a mix of runs with
 * different snapshots is the ceiling (see `maxReadSize.ts`). Holds no matter
 * how many scripts are running or how many
 * `Promise.all(paths.map(nexus.fs.readText))` calls they issue: the size hint
 * `initialReadCapacity` derives only bounds the allocation of a SINGLE read —
 * concurrent reads of files whose honest sizes are each near the cap still
 * multiply. (A script's own held RESULTS — the decoded strings it chooses to
 * keep around — live in the WORKER's heap; that's the script's own memory
 * budget to manage, not this module's problem. What this bounds is strictly
 * the main-thread-side buffer this module itself allocates per read.)
 *
 * GLOBAL, not per-run: a host-memory budget is a property of the host, so one
 * script cannot fan out past it by virtue of being the only one running.
 */
export const SCRIPT_FS_MAX_CONCURRENT_READS = 4;

/**
 * Fixed (not configurable) deadline on every `nexus.fs` call — the WHOLE call,
 * not just its I/O (see `readSlotScheduler.ts`'s invariant 6): the wait for a
 * read slot is inside the bound too, because the documented guarantee is made
 * to the SCRIPT ("a nexus.fs call never blocks longer than 30 seconds") and a
 * script cannot tell the two waits apart.
 *
 * Neither `node:fs/promises` nor `vscode.workspace.fs` offers any way to
 * cancel an in-flight call, so a hung remote FileSystemProvider or a `file:`
 * read against a dead network mount produces a promise that simply never
 * settles. Each entry point needs the deadline for its own reason:
 *
 *  - `scriptFsReadText`'s admitted read would otherwise pin its permit
 *    forever, and `SCRIPT_FS_MAX_CONCURRENT_READS` such stalls would make
 *    every later `nexus.fs.readText` — from ANY session, not just the stalled
 *    one's — queue indefinitely behind them.
 *  - a QUEUED `scriptFsReadText` needs it for the residue of that same hazard:
 *    once the orphan budget is full the pool stops handing timed-out permits
 *    back (`SCRIPT_FS_MAX_ORPHANED_READS`), so a fully degraded pool has no
 *    free permit and no prospect of one — a newcomer would wait forever on a
 *    queue that is bounded by nothing else.
 *  - `scriptFsExists`'s `stat` runs on its own pool (see
 *    `SCRIPT_FS_MAX_CONCURRENT_STATS`), so it needs the deadline twice over:
 *    the SCRIPT is what hangs first — `await nexus.fs.exists(...)` would
 *    never return, stalling the run until its max-runtime kill — and a
 *    degraded probe pool would then queue newcomers behind permits held by
 *    stats nothing will ever retire, exactly as a degraded read pool does.
 */
export const SCRIPT_FS_READ_TIMEOUT_MS = 30_000;

/**
 * Cap on DETACHED reads: those whose permit has already gone back to the pool
 * after a `SCRIPT_FS_READ_TIMEOUT_MS` timeout, but whose underlying I/O (open
 * handle + in-flight buffer) is still running to completion in the background.
 *
 * Handing a timed-out read's permit back immediately is what keeps a handful
 * of stalls from starving every other `nexus.fs` call — but on its own it
 * defeats the memory budget `SCRIPT_FS_MAX_CONCURRENT_READS` exists to
 * enforce: a script that keeps fanning out slow reads would get a fresh batch
 * admitted every `SCRIPT_FS_READ_TIMEOUT_MS`, each leaving its own handle and
 * buffer behind, with nothing bounding the pile. Past this cap the scheduler
 * withholds a newly timed-out read's permit instead — trading liveness back
 * for memory pressure, the same direction `SCRIPT_FS_MAX_CONCURRENT_READS`
 * already trades throughput for it — and restores it as soon as detachment
 * capacity reopens.
 *
 * Net bound: host-side in-flight read buffers never exceed
 * `SCRIPT_FS_MAX_CONCURRENT_READS + SCRIPT_FS_MAX_ORPHANED_READS` (12 here) ×
 * the configured maximum — 192 MiB at the 16 MiB `SCRIPT_FS_MAX_BYTES_CEILING`;
 * at the default 4 MiB cap the worst case is 48 MiB. The bound is quoted
 * against the RANGE MAXIMUM rather than any one run's effective cap because
 * both pools are host-global while the cap is snapshotted per run (see
 * `maxReadSize.ts`), so concurrent runs can hold buffers sized by different
 * snapshots at once. Liveness survives up to `SCRIPT_FS_MAX_ORPHANED_READS`
 * simultaneous stalls. See `readSlotScheduler.ts` for how both halves are
 * enforced.
 */
export const SCRIPT_FS_MAX_ORPHANED_READS = 8;

/**
 * How many `nexus.fs.exists` probes may have a `stat` in flight at once,
 * across every running script — the read pool's counterpart for the OTHER
 * `nexus.fs` entry point, on its own scheduler instance.
 *
 * WHY A SECOND POOL RATHER THAN SHARING THE READ ONE: the read budgets exist
 * to bound host-side read BUFFERS, and a bare `stat` allocates none. Charging
 * probes to `SCRIPT_FS_MAX_CONCURRENT_READS` / `SCRIPT_FS_MAX_ORPHANED_READS`
 * would degrade the read pool to pay for memory nobody allocated, and would
 * make an existence check queue behind slow reads for no reason. Keeping the
 * two pools disjoint is the point: neither can starve the other.
 *
 * WHY A CAP AT ALL, given there is no buffer to bound: a stalled provider's
 * `stat()` never settles, and `SCRIPT_FS_READ_TIMEOUT_MS` bounds the promise
 * the CALLER waits on, not the probe behind it. Each detached probe keeps a
 * provider request pending and pins its call's captured `ScriptFsContext`
 * until it settles — which, against a hung provider, is never. Ungated, a
 * script running `Promise.all(paths.map(nexus.fs.exists))` would leave one
 * such probe per call alive after its 30-second rejection, with nothing
 * bounding the pile.
 *
 * Set well above the read pool's 4 because a probe is cheap: a healthy stat
 * takes milliseconds, so even a fan-out of hundreds only queues briefly — and
 * the deadline covers the queue too (see `SCRIPT_FS_READ_TIMEOUT_MS`), so a
 * probe that never gets a slot is bounded exactly like one whose provider
 * never answers.
 */
export const SCRIPT_FS_MAX_CONCURRENT_STATS = 8;

/**
 * Cap on DETACHED probes: `SCRIPT_FS_MAX_ORPHANED_READS`'s counterpart for the
 * probe pool, and it buys the same thing — handing a timed-out probe's permit
 * straight back keeps a handful of stalls from starving healthy `exists()`
 * calls, but on its own it would let a script fanning out probes every 30
 * seconds accumulate detached stats without limit. Past this cap the scheduler
 * withholds a newly timed-out probe's permit instead, and restores it as soon
 * as detachment capacity reopens (the same held/promotion recovery reads get).
 *
 * Net bound: at most `SCRIPT_FS_MAX_CONCURRENT_STATS +
 * SCRIPT_FS_MAX_ORPHANED_STATS` (24) provider `stat` requests are alive at
 * once, however many probes a script issues and however dead the provider is.
 */
export const SCRIPT_FS_MAX_ORPHANED_STATS = 16;

function createReadSlotScheduler(): ReadSlotScheduler {
  return new ReadSlotScheduler({
    maxConcurrent: SCRIPT_FS_MAX_CONCURRENT_READS,
    deadlineMs: SCRIPT_FS_READ_TIMEOUT_MS,
    maxOrphaned: SCRIPT_FS_MAX_ORPHANED_READS
  });
}

function createStatSlotScheduler(): ReadSlotScheduler {
  return new ReadSlotScheduler({
    maxConcurrent: SCRIPT_FS_MAX_CONCURRENT_STATS,
    deadlineMs: SCRIPT_FS_READ_TIMEOUT_MS,
    maxOrphaned: SCRIPT_FS_MAX_ORPHANED_STATS
  });
}

/** One per host, for the reason `SCRIPT_FS_MAX_CONCURRENT_READS` is global. */
let readSlots = createReadSlotScheduler();
/** The probe pool — same machine, own budgets. See `SCRIPT_FS_MAX_CONCURRENT_STATS`. */
let statSlots = createStatSlotScheduler();

/**
 * Installs a fresh scheduler for BOTH pools and hands them back. Exists so a
 * test can start from a known-empty machine and inspect it directly: detached
 * work outlives the call that started it by design, so without this a read (or
 * a probe) left in flight by one test would charge its capacity against every
 * test after it. Both are reset together because both are module-global and
 * both can be left charged by a single test.
 */
export function resetScriptFsSchedulers(): { readSlots: ReadSlotScheduler; statSlots: ReadSlotScheduler } {
  readSlots = createReadSlotScheduler();
  statSlots = createStatSlotScheduler();
  return { readSlots, statSlots };
}

export interface ScriptFsContext {
  scriptUri: vscode.Uri;
  /** undefined ⇢ untitled: script ⇢ every nexus.fs call throws NoScriptDir. */
  scriptDirUri: vscode.Uri | undefined;
  /** Snapshotted at run start — config changes never touch an in-flight run. */
  scriptsRootUri: vscode.Uri | undefined;
  /**
   * The effective read cap in bytes for THIS run — `resolveScriptMaxReadBytes`
   * over `nexus.scripts.maxReadSizeMb`, snapshotted at run start exactly like
   * `scriptsRootUri` (config changes never touch an in-flight run).
   *
   * REQUIRED, deliberately not optional: an optional field would let a future
   * call site inherit `undefined` and compare every file size against `NaN` —
   * which is silently false for `>`, i.e. an unbounded read, the one outcome
   * the cap exists to prevent. Every construction site must state a number.
   */
  maxBytes: number;
  /** Record-bound `logEvent` closure — lines get the usual `[hh:mm:ss.sss] Script@Session` prefix. */
  log: (text: string) => void;
  /**
   * True once the run this call belongs to has ended OR a stop has been
   * requested for it (any final state — completed, failed, connection-lost,
   * stopped — OR the in-flight ≤100ms `stopScript` grace window before
   * cleanup actually runs). Backed by `scriptRuntimeManager.ts`'s own
   * run-cleanup idempotency flag plus its synchronously-set stop-requested
   * field, so it flips no later than the instant a stop is requested — no
   * separate bookkeeping to keep in sync.
   *
   * Exists because `SCRIPT_FS_MAX_CONCURRENT_READS`'s semaphore is GLOBAL
   * (shared across every run, by design — see its doc comment): a burst of
   * reads queued on it by a script that then gets stopped would otherwise sit
   * parked past the run's death, and as slots freed up each one would still
   * perform its I/O, write audit lines for a run nobody's watching anymore,
   * and post a result to a worker that's already gone — starving `nexus.fs`
   * for OTHER, unrelated, still-running sessions for as long as the dead
   * run's backlog takes to drain. `scriptFsReadText` checks this before
   * queueing at all, and again the instant a slot is granted, so an aborted
   * run's queued reads skip their I/O entirely instead of draining slowly.
   */
  isAborted: () => boolean;
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
 * once `readLocalFileBounded`'s own pre-read `stat.size > ctx.maxBytes`
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
 * WHY A SIZE HINT: always preallocating `maxBytes + 1` (the run's whole cap —
 * 4 MiB by default, up to 16 MiB) regardless of the real file's size meant
 * `Promise.all(paths.map(nexus.fs.readText))` over
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

/**
 * Every `nexus.fs` entry point's shared preamble: build the run's containment
 * scope, refuse the two request shapes that can never resolve safely, and
 * resolve the request against the scope — returning the absolute in-scope path
 * both entry points then use as their target AND as the value every subsequent
 * audit line names.
 *
 * Pure — no I/O, no allocation, and deliberately NOT gated on the read
 * scheduler: an already-doomed InvalidPath/NoScriptDir call has no reason to
 * wait behind slow reads to be told so.
 *
 * Every refusal here is PRE-resolution, so its log line and thrown message
 * name the RAW requested value — there is no resolved path to name yet. Past
 * this function it inverts: callers log the resolved absolute path, not the
 * (possibly relative, possibly ambiguous across several scripts) request.
 * `method` only picks the verb those refusal lines are filed under.
 *
 * `baseDirPath` is the directory a RELATIVE request resolves against, and
 * defaults to the entry script's own directory — the byte-identical Phase-1
 * behaviour. A call from inside an included module passes that module's own
 * directory instead, so "a relative path resolves against the file it is
 * written in" holds at every depth. It changes resolution ONLY: containment is
 * still the run's unchanged two-root union (see `resolveScriptFsPathFrom`).
 */
function validateAndResolve(
  requested: unknown,
  ctx: ScriptFsContext,
  method: ScriptFsAuditMethod,
  baseDirPath?: string
): string {
  const scope = buildScriptFsScope(ctx);
  if ("code" in scope) {
    throw fail(
      ctx,
      method,
      safeStringify(requested),
      "NoScriptDir",
      "This script has no folder on disk (untitled editor). Save it first — nexus.fs paths resolve against the script's own directory."
    );
  }
  if (hasBackslashOnNonFileScheme(requested, ctx.scriptUri.scheme)) {
    throw fail(
      ctx,
      method,
      safeStringify(requested),
      "InvalidPath",
      `backslash is not a valid path separator for a remote script location: ${safeStringify(requested)}`
    );
  }

  const resolution = resolveScriptFsPathFrom(requested as string, baseDirPath ?? scope.scriptDirPath, scope);
  if (!resolution.ok) {
    throw fail(ctx, method, safeStringify(requested), resolution.code, describeResolutionFailure(resolution, scope));
  }
  return resolution.resolvedPath;
}

/**
 * `validateAndResolve` for `nexus.include()` — the containment half of a module
 * load, split out so `scriptInclude.ts` can run the rest of its refusal ladder
 * (the `.js` guard, cycle detection, the module cap) against a resolved,
 * already-contained path BEFORE any I/O happens. Throws the same typed,
 * pre-logged refusals every `nexus.fs` call throws, filed under the `include`
 * verb.
 *
 * `baseDirPath` is the including file's own directory; `undefined` means the
 * entry script's (and is also what an `untitled:` run passes, where the
 * NoScriptDir refusal fires before any base is consulted).
 */
export function resolveScriptFsTarget(
  requested: unknown,
  ctx: ScriptFsContext,
  baseDirPath: string | undefined
): string {
  return validateAndResolve(requested, ctx, "include", baseDirPath);
}

export async function scriptFsReadText(
  requested: unknown,
  ctx: ScriptFsContext,
  baseDirPath?: string
): Promise<string> {
  const resolvedPath = validateAndResolve(requested, ctx, "readText", baseDirPath);

  // Cheap early-out: the run already ended (this call hasn't queued for a
  // permit yet) — don't bother waiting behind slow reads for a session
  // nobody's watching anymore.
  if (ctx.isAborted()) {
    throw makeAbortedError(ctx, "readText", resolvedPath);
  }

  // Both branches materialize up to the cap in the extension host, so both
  // are gated. Everything above this point is pure validation — no I/O, no
  // allocation — so it stays ungated. `readJson` is worker-side JSON.parse
  // over exactly one `fs.readText` RPC call, so it never nests a second
  // admission inside this one: there is no other gated call in this module.
  return (await readGated(resolvedPath, ctx, "readText")).text;
}

/**
 * The source-text read behind `nexus.include()` — the SAME reader, the SAME
 * `readSlots` pool, the same `ctx.maxBytes` cap, the same UTF-8-fatal decode
 * and the same 30-second whole-call deadline `nexus.fs.readText` gets. Takes an
 * already-resolved, already-contained path (see `resolveScriptFsTarget`),
 * because `scriptInclude.ts` needs the resolved path for cycle detection and
 * caching before it decides to read at all.
 *
 * WHY IT SHARES `readSlots` RATHER THAN OWNING A POOL: the read pool exists to
 * bound host-side read BUFFERS, and an include allocates one exactly like a
 * `readText` does. A second pool would silently double the documented
 * `(4 + 8) × cap` worst case while every existing test still passed. The cost —
 * an include can queue behind a `readText` fan-out — is bounded by the same 30
 * seconds, and is the memory budget working as intended.
 *
 * Returns the byte length alongside the text because the include audit line
 * reports the SOURCE size, and a decoded string's `.length` is UTF-16 units,
 * not bytes. Writes no success line of its own: the loader owns that line
 * (`include <request> → <display name> (N bytes)`), since only it knows the
 * display name the request resolved to.
 */
export async function scriptFsReadSource(
  resolvedPath: string,
  ctx: ScriptFsContext
): Promise<{ text: string; byteLength: number }> {
  if (ctx.isAborted()) {
    throw makeAbortedError(ctx, "include", resolvedPath);
  }
  return await readGated(resolvedPath, ctx, "include");
}

/**
 * The gated read both entry points share: pick the scheme's reader, run it
 * under a `readSlots` permit and the call deadline, and decline the permit if
 * the run died while this call sat in the FIFO.
 */
function readGated(
  resolvedPath: string,
  ctx: ScriptFsContext,
  method: "readText" | "include"
): Promise<{ text: string; byteLength: number }> {
  const read =
    ctx.scriptUri.scheme === "file"
      ? (guarded: ScriptFsContext) => readLocalFileBounded(resolvedPath, resolvedPath, guarded, method)
      : (guarded: ScriptFsContext) => readRemoteFileBounded(uriOf(resolvedPath, ctx.scriptUri), resolvedPath, guarded, method);

  return readSlots.runGated({
    label: resolvedPath,
    // The case the early-out above cannot catch: the run was alive when this
    // call queued and died while it sat in the FIFO (a host-wide scheduler
    // knows nothing about individual runs). Refusing here, in the same tick
    // the permit is granted and before any I/O, keeps an already-dead run's
    // backlog from draining slowly through slots other sessions are waiting
    // for. The scheduler hands the permit straight back.
    onAdmitted: () => {
      if (ctx.isAborted()) throw makeAbortedError(ctx, method, resolvedPath);
    },
    run: (logAllowed) => read(withGuardedLog(ctx, logAllowed)),
    timeoutError: () => readDeadlineError(ctx, method, resolvedPath)
  });
}

/**
 * A view of `ctx` whose audit line is suppressed once this call's deadline has
 * fired. Handed to the read/probe itself, never to the deadline branch: a
 * detached operation that settles after its result was already discarded must
 * not write a success line (a byte count, a `→ true`) or a second failure line
 * for a call the caller already saw fail — sometimes landing after the run's
 * own `end` line. `fail()` routes through whatever `ctx` it is given, so a
 * late failure is suppressed exactly like a late success: the error object is
 * still built and still rejects the detached work, it just never logs.
 */
function withGuardedLog(ctx: ScriptFsContext, logAllowed: () => boolean): ScriptFsContext {
  return {
    ...ctx,
    log: (text: string) => {
      if (logAllowed()) ctx.log(text);
    }
  };
}

/**
 * The rejection a caller gets when its I/O outlives `SCRIPT_FS_READ_TIMEOUT_MS`
 * — identical whether or not the run is still alive; only the audit line is
 * conditional. A run that ended while this call was in flight has no trail
 * worth appending to, exactly as `makeAbortedError` reasons for a read that
 * never started. `method` keeps an `exists()` timeout filed under `fs.exists`
 * rather than misattributed to `fs.readText`.
 */
function readDeadlineError(ctx: ScriptFsContext, method: ScriptFsAuditMethod, loggedPath: string): Error {
  const message = `${loggedPath}: timed out after ${SCRIPT_FS_READ_TIMEOUT_MS / 1000}s`;
  return ctx.isAborted() ? makeFsError("ReadFailed", message) : fail(ctx, method, loggedPath, "ReadFailed", message);
}

/**
 * Non-`file` scheme read path — `vscode.workspace.fs` is the only API surface
 * a FileSystemProvider exposes, and it has no bounded-read variant — there is
 * no syscall-level equivalent of `boundedReadFile` to drop down to for a
 * remote target. The size cap here is therefore BEST-EFFORT: it protects
 * *correctness* (a script never sees more than the run's effective cap,
 * `ctx.maxBytes`, of content) but not *peak extension-host memory* — a
 * misbehaving remote provider that lies about `stat.size` can still make
 * `readFile` allocate its true (oversized) body before the post-read check
 * below rejects it.
 */
async function readRemoteFileBounded(
  uri: vscode.Uri,
  loggedPath: string,
  ctx: ScriptFsContext,
  method: "readText" | "include"
): Promise<{ text: string; byteLength: number }> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (err) {
    // Only a genuine "nothing is there" failure maps to FileNotFound; anything
    // else (permissions, an unavailable provider, ...) is ReadFailed — the
    // path resolved fine, the read itself is what didn't work.
    if (isNotFoundStatError(err)) {
      throw fail(ctx, method, loggedPath, "FileNotFound", `${loggedPath}: not found`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, method, loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  // Bitmask test, not `===` — same discipline as scriptScanner.ts, so a
  // symlinked directory is caught too.
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    throw fail(ctx, method, loggedPath, "FileNotFound", `${loggedPath}: is a directory`);
  }
  // Checked BEFORE reading so an honestly-reported multi-GB file is never
  // pulled into memory in the common case — belt, not braces, here: see the
  // post-read check below for the braces.
  if (stat.size > ctx.maxBytes) {
    throw fail(ctx, method, loggedPath, "FileTooLarge", `${loggedPath}: ${stat.size} bytes exceeds the ${ctx.maxBytes}-byte limit`, {
      sizeBytes: stat.size,
      maxBytes: ctx.maxBytes
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, method, loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  // Braces: some FileSystemProviders report a stale/zero `size` from stat,
  // and `readFile` has no size limit of its own — this is the only thing
  // standing between a lying remote provider and an unbounded read (see the
  // module-level comment on `boundedReadFile` for why `file:` doesn't have
  // this problem).
  if (bytes.byteLength > ctx.maxBytes) {
    throw fail(
      ctx,
      method,
      loggedPath,
      "FileTooLarge",
      `${loggedPath}: ${bytes.byteLength} bytes exceeds the ${ctx.maxBytes}-byte limit`,
      { sizeBytes: bytes.byteLength, maxBytes: ctx.maxBytes }
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail(ctx, method, loggedPath, "NotUtf8", `${loggedPath}: not valid UTF-8`);
  }

  // An include read writes no line here: the loader writes the one line that
  // names both the request and the module it resolved to (see
  // `scriptFsReadSource`).
  if (method === "readText") ctx.log(`fs.readText ${loggedPath} (${bytes.byteLength} bytes)`);
  return { text, byteLength: bytes.byteLength };
}

/**
 * `file:` scheme read path — native `node:fs/promises`, bounded at the
 * syscall level. See `boundedReadFile`'s doc comment for why this bypasses
 * `vscode.workspace.fs` entirely rather than following the module's usual
 * "everything through `vscode.workspace.fs`" convention: that API cannot
 * bound a read, and an unbounded read into the extension host is exactly the
 * hazard this function exists to close.
 */
async function readLocalFileBounded(
  fsPath: string,
  loggedPath: string,
  ctx: ScriptFsContext,
  method: "readText" | "include"
): Promise<{ text: string; byteLength: number }> {
  let stat: import("node:fs").Stats;
  try {
    stat = await nodeFs.stat(fsPath); // follows symlinks, matching decision 3's lexical-containment policy
  } catch (err) {
    if (isNotFoundStatError(err)) {
      throw fail(ctx, method, loggedPath, "FileNotFound", `${loggedPath}: not found`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, method, loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  if (stat.isDirectory()) {
    throw fail(ctx, method, loggedPath, "FileNotFound", `${loggedPath}: is a directory`);
  }
  // Rejects FIFOs, sockets, and character/block devices — e.g. a symlink
  // inside scope pointing at `/dev/zero`, which would otherwise hand
  // `boundedReadFile` an endless byte stream. Caught here, before ANY read is
  // attempted — `node:fs`'s `Stats.isFile()` reports the RESOLVED target's
  // type (this call is `stat`, not `lstat`), so a symlink to a device is
  // caught exactly like a direct reference to one would be.
  if (!stat.isFile()) {
    throw fail(ctx, method, loggedPath, "FileNotFound", `${loggedPath}: is not a regular file`);
  }
  // Checked BEFORE opening the file: when an honest stat already knows the
  // file is oversized, there is no reason to pay for even a capped open+read
  // — worst on `file:` URIs backed by a slow network mount. `stat.size` is
  // trustworthy here specifically BECAUSE we haven't read anything yet to
  // contradict it; the bounded read below (and its own post-read check) stays
  // as the belt-and-braces layer for the case stat DIDN'T catch: a lying
  // provider, or a file that grows between this stat and the read.
  if (stat.size > ctx.maxBytes) {
    throw fail(
      ctx,
      method,
      loggedPath,
      "FileTooLarge",
      `${loggedPath}: ${stat.size} bytes exceeds the ${ctx.maxBytes}-byte limit`,
      { sizeBytes: stat.size, maxBytes: ctx.maxBytes }
    );
  }

  let bytes: Buffer;
  try {
    bytes = await boundedReadFile(fsPath, ctx.maxBytes, stat.size);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(ctx, method, loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
  }
  if (bytes.byteLength > ctx.maxBytes) {
    // `stat.size` is only trustworthy here when it AGREES that the file is
    // oversized — i.e. it wasn't the thing that lied. When it under-reported
    // (the exact "stat lies" / racing-growth hazard this function defends
    // against), `maxBytes + 1` — the one number `boundedReadFile` itself
    // guarantees — is reported instead of repeating the untrustworthy value.
    const sizeBytes = stat.size > ctx.maxBytes ? stat.size : ctx.maxBytes + 1;
    throw fail(
      ctx,
      method,
      loggedPath,
      "FileTooLarge",
      `${loggedPath}: exceeds the ${ctx.maxBytes}-byte limit`,
      { sizeBytes, maxBytes: ctx.maxBytes }
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail(ctx, method, loggedPath, "NotUtf8", `${loggedPath}: not valid UTF-8`);
  }

  // An include read writes no line here: the loader writes the one line that
  // names both the request and the module it resolved to (see
  // `scriptFsReadSource`).
  if (method === "readText") ctx.log(`fs.readText ${loggedPath} (${bytes.byteLength} bytes)`);
  return { text, byteLength: bytes.byteLength };
}

export async function scriptFsExists(
  requested: unknown,
  ctx: ScriptFsContext,
  baseDirPath?: string
): Promise<boolean> {
  const resolvedPath = validateAndResolve(requested, ctx, "exists", baseDirPath);

  // Cheap early-out, exactly as in `scriptFsReadText`: the run already ended
  // (this call hasn't queued for a probe permit yet) — no reason to stat and
  // log on behalf of a session nobody's watching anymore.
  if (ctx.isAborted()) {
    throw makeAbortedError(ctx, "exists", resolvedPath);
  }

  // No read hazard here — this is a plain existence probe, so
  // `vscode.workspace.fs.stat` (uniformly, for every scheme) is fine: no body
  // is ever pulled into memory.
  //
  // It DOES still need the deadline: a stalled provider's `stat()` hangs
  // exactly like its `readFile()` does. On timeout the caller gets a
  // `ReadFailed` throw, deliberately NOT `false` — "I couldn't tell" and "it
  // is definitely not there" justify opposite actions in a script, so
  // conflating them is the same class of bug as the out-of-scope-probe-
  // returns-false one guarded above.
  //
  // WHY ITS OWN POOL, and why probes must never be moved onto `readSlots`:
  // `SCRIPT_FS_MAX_CONCURRENT_READS` / `SCRIPT_FS_MAX_ORPHANED_READS` budget
  // host-side READ BUFFERS, which a bufferless `stat` never spends. Charging
  // probes there would steal capacity from the genuine buffer-holding reads
  // those caps exist for, and would make an existence check queue behind slow
  // reads for no reason at all. Keeping the two instances disjoint is what
  // makes "a stalled probe cannot starve reads, and vice versa" structural.
  //
  // WHY GATED AT ALL, given there is no buffer to bound: the deadline bounds
  // the promise the CALLER waits on, not the probe behind it — nothing can
  // cancel an in-flight `stat`. A detached probe keeps a provider request
  // pending and pins this call's captured `ctx` until it settles, which
  // against a hung provider is never; ungated, a script fanning out probes
  // would leave one such residue per call, with nothing bounding the pile.
  // So probes get their OWN budget and degrade exactly like reads do —
  // bounded at `SCRIPT_FS_MAX_CONCURRENT_STATS + SCRIPT_FS_MAX_ORPHANED_STATS`
  // live stats, with the same held/promotion recovery once capacity reopens.
  const uri = uriOf(resolvedPath, ctx.scriptUri);
  return await statSlots.runGated({
    label: resolvedPath,
    // The case the early-out above cannot catch: the run was alive when this
    // probe queued and died while it sat in the FIFO. Refusing in the same
    // tick the permit is granted, before any I/O, keeps a dead run's backlog
    // from draining through slots other sessions are waiting for.
    onAdmitted: () => {
      if (ctx.isAborted()) throw makeAbortedError(ctx, "exists", resolvedPath);
    },
    run: (logAllowed) => statExists(uri, resolvedPath, withGuardedLog(ctx, logAllowed)),
    timeoutError: () => readDeadlineError(ctx, "exists", resolvedPath)
  });
}

/**
 * The existence probe proper, run as the deadline race's `work`. Any entry
 * type — file, directory, symlink — counts; `readText` on a directory still
 * fails, but this is a plain existence probe. `ctx` here is the guarded
 * context (see `withGuardedLog`), so a late settlement after the deadline
 * already fired logs nothing — the same suppression
 * `readLocalFileBounded`/`readRemoteFileBounded` get.
 *
 * ONLY A GENUINE NOT-FOUND ANSWERS `false`. A `stat` that failed for any other
 * reason — no permission to look, an unavailable/erroring FileSystemProvider,
 * a broken transport — did not establish absence; it established that the
 * question could not be answered. That is the same "I couldn't tell" the
 * deadline already refuses to collapse into `false` (see `scriptFsExists`'s
 * comment), and it gets the same outcome: a `ReadFailed` throw carrying the
 * provider's own detail. The not-found classification is
 * `isNotFoundStatError`, shared verbatim with `readText`'s stat mapping, so
 * "the file isn't there" means exactly one thing across the whole module.
 */
async function statExists(uri: vscode.Uri, loggedPath: string, ctx: ScriptFsContext): Promise<boolean> {
  let found: boolean;
  try {
    await vscode.workspace.fs.stat(uri);
    found = true;
  } catch (err) {
    if (!isNotFoundStatError(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      throw fail(ctx, "exists", loggedPath, "ReadFailed", `${loggedPath}: ${detail}`);
    }
    found = false;
  }
  ctx.log(`fs.exists ${loggedPath} → ${found}`);
  return found;
}

function describeResolutionFailure(
  resolution: Extract<ReturnType<typeof resolveScriptFsPathFrom>, { ok: false }>,
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
  method: ScriptFsAuditMethod,
  loggedPath: string,
  code: ScriptFsErrorCode,
  message: string,
  extra?: Record<string, unknown>
): Error {
  ctx.log(`${auditVerb(method)} ${loggedPath} → ${code}`);
  return makeFsError(code, message, extra);
}

/**
 * The call's run has already ended (`ctx.isAborted()`) — skip it. `"Stopped"`
 * is not one of `nexus.fs`'s own codes (`ScriptFsErrorCode`); it's the same
 * general RPC vocabulary `scriptRuntimeManager.ts` already uses for a
 * user-requested stop (`rejectAllPending`) and is already in
 * `EXPECTED_ERROR_CODES` there — cooperative control flow, no crash toast.
 * Deliberately does NOT call `fail()`: this is not a normal refusal (no
 * `InvalidPath`/`FileTooLarge`/... classification applies), and the caller's
 * run is already gone, so the usual per-call audit line would just be noise
 * about a session nobody's watching anymore — one distinct "skipped" line
 * instead, not the normal read/refusal line shape.
 */
function makeAbortedError(ctx: ScriptFsContext, method: ScriptFsAuditMethod, loggedPath: string): Error {
  ctx.log(`${auditVerb(method)} ${loggedPath} → skipped (run stopped)`);
  return Object.assign(new Error("Script stopped — file operation skipped"), { code: "Stopped" });
}
