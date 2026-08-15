import * as nodeFs from "node:fs/promises";
import * as vscode from "vscode";
import { resolveScriptFsPath, safeStringify, type ScriptFsScope } from "./scriptFsScope";
import type { ScriptFsErrorCode } from "./scriptTypes";

/** Decision 7 — not configurable. */
export const SCRIPT_FS_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * How many `nexus.fs.readText` calls may have a file body in memory at once,
 * across every running script. Bounds the HOST-side (extension-host) transient
 * allocation at ~`SCRIPT_FS_MAX_CONCURRENT_READS × SCRIPT_FS_MAX_BYTES` (~16 MiB
 * at the current cap) no matter how many scripts are running or how many
 * `Promise.all(paths.map(nexus.fs.readText))` calls they issue: the size-hint
 * fix (`initialReadCapacity`) only bounds the allocation of a SINGLE read —
 * concurrent reads of files whose honest sizes are each near the cap still
 * multiply. (A script's own held RESULTS — the decoded strings it chooses to
 * keep around — live in the WORKER's heap; that's the script's own memory
 * budget to manage, not this module's problem. What this bounds is strictly
 * the main-thread-side buffer this module itself allocates per read.)
 */
export const SCRIPT_FS_MAX_CONCURRENT_READS = 4;

/**
 * Fixed (not configurable) deadline on the ADMITTED-read I/O portion of
 * `scriptFsReadText` (stat + read + decode, on BOTH the `file:` and
 * non-`file:` branches) — see `withReadDeadline`. Without this, a single
 * stalled read (a hung remote FileSystemProvider, a `file:` read against a
 * dead network mount — neither of which `node:fs`/`vscode.workspace.fs`
 * offers any cancellation for) would pin its `readSemaphore` slot forever:
 * the slot is only ever released from the `finally` in `scriptFsReadText`,
 * which never runs for a promise that never settles. Four such stalls
 * exhaust `SCRIPT_FS_MAX_CONCURRENT_READS` entirely, and every later
 * `nexus.fs.readText` call — from ANY session, not just the stalled one's —
 * queues indefinitely behind them.
 */
export const SCRIPT_FS_READ_TIMEOUT_MS = 30_000;

/**
 * Cap on DETACHED reads whose semaphore permit has already been released
 * back to the pool after a `SCRIPT_FS_READ_TIMEOUT_MS` timeout, but whose
 * underlying I/O (open handle + in-flight buffer) is still running to
 * completion in the background — see `withReadDeadline`. Releasing a timed-
 * out read's permit immediately (round 10) restores LIVENESS — a handful of
 * hung reads no longer starve every other `nexus.fs` call — but taken alone
 * it defeats the MEMORY budget `SCRIPT_FS_MAX_CONCURRENT_READS` exists to
 * enforce: a script that keeps fanning out slow reads gets a fresh batch of
 * `SCRIPT_FS_MAX_CONCURRENT_READS` admitted every `SCRIPT_FS_READ_TIMEOUT_MS`,
 * each leaving its own orphaned handle/buffer behind — an unbounded number of
 * detached operations, accumulating forever. This constant re-bounds that:
 * once `SCRIPT_FS_MAX_ORPHANED_READS` orphans are already in flight, a NEWLY
 * timed-out read's permit is held (not released) until ITS OWN orphaned work
 * finally settles — trading liveness back for memory pressure, in the same
 * direction `SCRIPT_FS_MAX_CONCURRENT_READS` already trades throughput for
 * memory pressure.
 *
 * INVARIANT this buys: host-side in-flight read buffers are bounded by
 * `SCRIPT_FS_MAX_CONCURRENT_READS + SCRIPT_FS_MAX_ORPHANED_READS` (12 at
 * current constants, ~48 MiB worst case at `SCRIPT_FS_MAX_BYTES`), while
 * liveness (a fresh, healthy read is never stuck behind a stall) survives up
 * to `SCRIPT_FS_MAX_ORPHANED_READS` simultaneous stalls — beyond that, the
 * pool DEGRADES TEMPORARILY (a new caller queues, same as before round 10
 * existed) rather than the detached-operation count growing without bound.
 * "Temporarily" — round 13: a permit-holding read that timed out while the
 * orphan pool was full doesn't just sit there forever even after orphan
 * capacity reopens; see `heldReads` / `promoteHeldReads()` below. The
 * invariant itself (bounded at `SCRIPT_FS_MAX_CONCURRENT_READS +
 * SCRIPT_FS_MAX_ORPHANED_READS` total detached operations) is unchanged by
 * promotion — it only ever converts a HELD slot into an ORPHAN slot, never
 * adds a new one.
 */
export const SCRIPT_FS_MAX_ORPHANED_READS = 8;

/**
 * Count of currently-detached (permit already released, I/O still running)
 * timed-out reads. Global — see `readSemaphore`'s doc comment for why a
 * host-memory budget is per-host, not per-run.
 */
let orphanedReads = 0;

/**
 * FIFO of reads that timed out while the orphan pool was already full (the
 * "beyond capacity" branch in `withReadDeadline`) and are therefore still
 * HOLDING their semaphore permit, bound to their own hung `work`. Round 13:
 * without this list, once the ORIGINAL orphans that filled the pool
 * eventually settle — freeing orphan capacity — these permit-holding reads
 * have no way to notice; they'd sit on their held permit until their OWN
 * (possibly never-settling) work finishes, leaving the pool fully degraded
 * (every new call queues) even though `orphanedReads` has dropped back to 0.
 * `promoteHeldReads()` drains this list, oldest-first, whenever room opens
 * up — converting a HELD permit into an ORPHAN (permit handed back to the
 * pool, the read's own hung work now counted against
 * `SCRIPT_FS_MAX_ORPHANED_READS` instead), never adding a new detached slot.
 */
const heldReads: Array<{ promoted: boolean; release: () => void }> = [];

/**
 * Promotes as many `heldReads` entries into orphans as there's currently
 * room for — called everywhere `orphanedReads` is decremented, since a
 * decrement is the only thing that can ever open up room. Each promotion:
 * removes the entry from `heldReads` and flips `promoted` to `true` (this,
 * plus the fact the entry's own `work.finally` handler in `withReadDeadline`
 * reads that flag exactly once when `work` finally settles, is what keeps
 * the eventual release/decrement exactly-once despite the flag being
 * flipped from OUTSIDE that handler — no separate "already handled" guard
 * needed), increments `orphanedReads`, and calls the entry's own `release`
 * — handing the permit back to the pool immediately, exactly as if this read
 * had taken the "under capacity" branch directly instead of having to wait
 * behind a full orphan pool first.
 */
function promoteHeldReads(): void {
  while (orphanedReads < SCRIPT_FS_MAX_ORPHANED_READS && heldReads.length > 0) {
    const entry = heldReads.shift()!;
    entry.promoted = true;
    orphanedReads++;
    entry.release();
  }
}

/**
 * Tiny FIFO async semaphore — the classic promise-queue pattern, no deps.
 * `acquire()` resolves once a slot is free (immediately if one already is,
 * otherwise once an earlier waiter's slot is `release()`d, in queue order).
 * The caller MUST `release()` exactly once per `acquire()` — normally from a
 * `finally`, so a throw can't leak the slot forever. Exported for direct unit
 * tests; scoped to a single module-level instance below (see
 * `SCRIPT_FS_MAX_CONCURRENT_READS`'s doc comment for why GLOBAL, not per-run).
 */
export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

export function createSemaphore(limit: number): Semaphore {
  let available = limit;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (available > 0) {
        available--;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => queue.push(resolve));
    },
    release(): void {
      const next = queue.shift();
      // Hand the slot straight to the next FIFO waiter rather than
      // incrementing `available` and letting it race a fresh `acquire()` —
      // this is what makes queueing order (FIFO) actually meaningful.
      if (next) next();
      else available++;
    }
  };
}

/** Global — a host-memory budget is per-host, not per-run. See the doc comment on `SCRIPT_FS_MAX_CONCURRENT_READS`. */
const readSemaphore = createSemaphore(SCRIPT_FS_MAX_CONCURRENT_READS);

export interface ScriptFsContext {
  scriptUri: vscode.Uri;
  /** undefined ⇢ untitled: script ⇢ every nexus.fs call throws NoScriptDir. */
  scriptDirUri: vscode.Uri | undefined;
  /** Snapshotted at run start — config changes never touch an in-flight run. */
  scriptsRootUri: vscode.Uri | undefined;
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

  // Cheap early-out: the run already ended (this call didn't even reach the
  // semaphore yet) — don't bother queueing behind slow reads for a session
  // nobody's watching anymore.
  if (ctx.isAborted()) {
    throw makeAbortedError(ctx, "readText", loggedPath);
  }

  // Gate the actual read (both branches — the non-file branch materializes
  // up to the cap via workspace.fs.readFile too) on the global concurrency
  // semaphore. Everything above this point is pure validation — no I/O, no
  // allocation — so it stays ungated; gating it would just make an
  // already-doomed InvalidPath/NoScriptDir call wait behind slow reads for
  // nothing. `readJson` is worker-side JSON.parse over exactly one
  // `fs.readText` RPC call, so it never nests a second acquire inside this
  // one — verified: there is no other gated call anywhere in this module.
  await readSemaphore.acquire();
  // Check AGAIN, immediately: this is the case the early-out above can't
  // catch — the run was alive when this call queued, but died while it sat
  // parked on the semaphore (the module-global semaphore doesn't know or
  // care about individual runs). Release in the SAME tick, before any I/O —
  // an admitted-but-now-orphaned read must never perform its read, write the
  // normal audit line, or try to post its result to a worker that's already
  // gone (dispatchRpc's `postMessage` tolerates that fine, but there's no
  // reason to do the work at all).
  if (ctx.isAborted()) {
    readSemaphore.release();
    throw makeAbortedError(ctx, "readText", loggedPath);
  }
  // `withReadDeadline` OWNS permit release for every path from here on
  // (normal settle, timeout with orphan capacity to spare, timeout beyond
  // capacity) — see its doc comment. No `finally { readSemaphore.release() }`
  // wrapper here: that would be a SECOND release path, and the whole point of
  // round 11's restructuring is exactly-once release, not two `finally`
  // blocks that could both fire.
  if (ctx.scriptUri.scheme === "file") {
    return await withReadDeadline(
      (guardedCtx) => readLocalFileBounded(resolution.resolvedPath, loggedPath, guardedCtx),
      readSemaphore.release,
      ctx,
      loggedPath
    );
  }

  const uri = uriOf(resolution.resolvedPath, ctx.scriptUri);
  return await withReadDeadline(
    (guardedCtx) => readRemoteFileBounded(uri, loggedPath, guardedCtx),
    readSemaphore.release,
    ctx,
    loggedPath
  );
}

/**
 * Races the I/O portion of an admitted read (`work` — stat + read + decode,
 * already in flight on either branch by the time this is called) against a
 * fixed `SCRIPT_FS_READ_TIMEOUT_MS` deadline, and OWNS `release` (in
 * production, `readSemaphore.release`) for every path out of this function —
 * exactly once, never split across two `finally` blocks that could both
 * fire. The CALLER always gets its `ReadFailed` "timed out" rejection at the
 * deadline, unchanged from round 10 — a script must never block on a dead
 * provider. What round 11 changes is what happens to the permit and the
 * orphaned `work` promise itself once that deadline fires:
 *
 *  - Common case (`orphanedReads` under `SCRIPT_FS_MAX_ORPHANED_READS`): the
 *    permit is released IMMEDIATELY — liveness preserved, exactly like round
 *    10 — `work` is tracked as one more orphan, and its eventual settlement
 *    (however long that takes, if ever) just decrements the orphan counter;
 *    its actual result/error is discarded either way (the `.catch(() => {})`
 *    exists ONLY to keep that discard from surfacing as an unhandled
 *    rejection — `work` itself is still always observed by `Promise.race`
 *    below, so `work` proper is never unhandled, only the NEW promise
 *    `work.finally(...)` returns needs this).
 *  - Pathological case (`SCRIPT_FS_MAX_ORPHANED_READS` orphans already in
 *    flight): the permit is NOT released now — it goes on the `heldReads`
 *    FIFO instead. From there, ONE of two things eventually happens: either
 *    THIS read's own `work` settles first (unchanged from round 11 — release
 *    runs, exactly once, and the entry removes itself from `heldReads`), or
 *    — round 13 — orphan capacity reopens first (an earlier orphan settles)
 *    and `promoteHeldReads()` promotes this entry: the permit is released
 *    RIGHT THEN (recovering liveness) while this read's still-hung `work`
 *    now occupies an orphan slot instead, so when `work` finally does settle
 *    it decrements the orphan counter rather than releasing a permit a
 *    second time. Either way the pool degrades only as long as it has to
 *    (new callers queue, same as pre-round-10 behavior, while ALL
 *    `SCRIPT_FS_MAX_ORPHANED_READS + SCRIPT_FS_MAX_CONCURRENT_READS` slots
 *    are genuinely occupied) rather than the detached-operation count
 *    growing without bound OR the pool staying degraded longer than that.
 *
 * `work` itself is still never cancelled — neither `node:fs/promises` nor
 * `vscode.workspace.fs` offers a way to abort an in-flight call — so the
 * underlying I/O keeps running to completion (or forever) detached from this
 * call regardless of which branch above fires; see `SCRIPT_FS_MAX_ORPHANED_READS`'s
 * doc comment for the bound this now puts on how much of that can pile up.
 *
 * ROUND 12 — audit output belongs ONLY to the branch that actually wins the
 * race. Without this, a detached `work` continuation that settles AFTER its
 * own deadline already fired would still write its own audit line — either a
 * success byte-count (`readLocalFileBounded`/`readRemoteFileBounded`'s own
 * `ctx.log`) or a SECOND failure line (via `fail()`) — for a call whose
 * result was already discarded, producing a contradictory entry (sometimes
 * after the run's own `end` line). `workFactory` receives a `ctx` whose
 * `log` is wrapped to no-op once `raceState.deadlineWon` flips — set as the
 * very first thing the deadline callback does, before it even logs its OWN
 * `ReadFailed` line (that line uses the UNGUARDED `ctx` passed into this
 * function, since the deadline branch is always the one allowed to log).
 * `fail()` routes through whatever `ctx` it's given, so a late failure
 * inside `work` (which only ever sees the GUARDED `ctx`) is suppressed the
 * same way a late success is — the error object is still constructed and
 * still rejects `work`, it just never logs. On the normal (work-wins) path
 * `raceState.deadlineWon` never flips, so the guard is a pure passthrough —
 * zero behavior change.
 */
async function withReadDeadline<T>(
  workFactory: (ctx: ScriptFsContext) => Promise<T>,
  release: () => void,
  ctx: ScriptFsContext,
  loggedPath: string
): Promise<T> {
  const raceState = { deadlineWon: false };
  const guardedCtx: ScriptFsContext = {
    ...ctx,
    log: (text: string) => {
      if (!raceState.deadlineWon) {
        ctx.log(text);
      }
    }
  };
  const work = workFactory(guardedCtx);

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set the instant the deadline fires — lets the `finally` below know NOT to
  // release a second time; the timeout branch has already taken over that
  // responsibility (immediately, or deferred to `work`'s own settlement).
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // MUST be set before anything else below — a `work` continuation that
      // happens to settle in this very tick (e.g. it was already queued as a
      // microtask when the timer fired) must never win the race to log.
      raceState.deadlineWon = true;
      if (orphanedReads < SCRIPT_FS_MAX_ORPHANED_READS) {
        orphanedReads++;
        work
          .finally(() => {
            orphanedReads--;
            // A decrement is the only thing that can ever open up room to
            // promote a permit-holding read off `heldReads` — see round 13.
            promoteHeldReads();
          })
          .catch(() => {
            /* swallow — see doc comment above */
          });
        release();
      } else {
        // Beyond capacity — hold the permit, but make it PROMOTABLE: if
        // orphan capacity reopens before this read's own `work` settles,
        // `promoteHeldReads()` flips `promoted` and releases on our behalf,
        // instead of this read having to wait on its own (possibly
        // never-settling) `work`.
        const heldEntry: { promoted: boolean; release: () => void } = { promoted: false, release };
        heldReads.push(heldEntry);
        work
          .finally(() => {
            if (heldEntry.promoted) {
              // Already promoted — the permit was released back at
              // promotion time; `work` settling now just retires the orphan
              // slot it was given instead, exactly like a direct ("under
              // capacity") orphan's own decrement does.
              orphanedReads--;
              promoteHeldReads();
            } else {
              // Settled before any promotion — still sitting in `heldReads`;
              // remove itself (nothing left to promote there) and release
              // the permit exactly once, unchanged from round 11.
              const idx = heldReads.indexOf(heldEntry);
              if (idx !== -1) heldReads.splice(idx, 1);
              release();
            }
          })
          .catch(() => {
            /* swallow — see doc comment above */
          });
      }
      reject(
        fail(
          ctx,
          "readText",
          loggedPath,
          "ReadFailed",
          `${loggedPath}: timed out after ${SCRIPT_FS_READ_TIMEOUT_MS / 1000}s`
        )
      );
    }, SCRIPT_FS_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    if (!timedOut) {
      release();
    }
  }
}

/**
 * Non-`file` scheme read path — `vscode.workspace.fs` is the only API surface
 * a FileSystemProvider exposes, and it has no bounded-read variant — there is
 * no syscall-level equivalent of `boundedReadFile` to drop down to for a
 * remote target. The size cap here is therefore BEST-EFFORT: it protects
 * *correctness* (a script never sees more than SCRIPT_FS_MAX_BYTES of
 * content) but not *peak extension-host memory* — a misbehaving remote
 * provider that lies about `stat.size` can still make `readFile` allocate its
 * true (oversized) body before the post-read check below rejects it.
 */
async function readRemoteFileBounded(uri: vscode.Uri, loggedPath: string, ctx: ScriptFsContext): Promise<string> {
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

  // Not gated (no read hazard — see below), but cheap enough to skip anyway:
  // no reason to stat and log on behalf of a run that's already ended.
  if (ctx.isAborted()) {
    throw makeAbortedError(ctx, "exists", resolution.resolvedPath);
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
function makeAbortedError(ctx: ScriptFsContext, method: "readText" | "exists", loggedPath: string): Error {
  ctx.log(`fs.${method} ${loggedPath} → skipped (run stopped)`);
  return Object.assign(new Error("Script stopped — file operation skipped"), { code: "Stopped" });
}
