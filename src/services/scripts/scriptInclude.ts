/**
 * Main-thread policy for `nexus.include()` — resolution, containment, module
 * identity, cycles and limits. The worker evaluates modules; it never decides
 * which file a specifier means.
 *
 * TRUST MODEL. The worker is UNTRUSTED: user code shares its global scope with
 * the API surface and can overwrite anything in it, so nothing that arrives
 * over the RPC wire is a capability. Concretely, the `chain` argument is
 * DIAGNOSTIC INPUT, NOT TRUST INPUT: it selects a resolution base, supplies the
 * cycle/depth diagnosis, and nothing else. Every id in it is re-looked-up in
 * THIS module's own `moduleId → record` map on every call (an unknown id is
 * `IncludeInternal`, never a fallback), and every path it produces still passes
 * the unchanged two-root containment check (`scriptFsScope.ts`). So the worst a
 * forged chain can do is measure a relative path from one of the run's OWN
 * already-resolved, already-contained directories instead of another — and then
 * be contained again anyway.
 *
 * NO-DEADLOCK INVARIANT (A-F9): an include chain never holds more than ONE read
 * permit at a time. A permit is held only across the single file read inside
 * `scriptFsReadSource`, and is released before the source is returned — module
 * EVALUATION (which is where a nested `include()` happens, as a separate RPC)
 * always runs with no permit held. Since `readSlots` has 4 permits and an
 * include chain can be 16 deep, holding a permit across evaluation would
 * deadlock a chain deeper than the pool at the 5th level; the integration
 * fixture nests deeper than the pool on purpose so that mistake cannot pass.
 *
 * REFUSAL ORDERING. `scriptIncludeLoad` runs a fixed 11-step ladder, and the
 * order is load-bearing in two directions: no step performs I/O before it must
 * (the cheap structural refusals — chain, depth, containment, extension, cycle
 * — all happen before the file is opened, and the module cap is checked before
 * the read rather than after it, so a run that has exhausted its budget never
 * spends a read slot to be told so; the source-byte budget is checked in both
 * places, cheaply before the read when nothing is left at all and
 * authoritatively after it, where the module's size is finally known), and
 * EVERY refusal writes its audit line
 * before it throws, so the Output Channel records the refusal even though the
 * error itself is on its way to a `catch` block that may swallow it.
 */
import { parseScriptHeader } from "./scriptHeader";
import {
  buildScriptFsScope,
  resolveScriptFsTarget,
  scriptFsReadSource,
  type ScriptFsContext
} from "./scriptFs";
import { isLexicallyWithin, scriptFsDirname, type ScriptFsPlatform } from "./scriptFsScope";
import {
  SCRIPT_INCLUDE_ROOT_ID,
  type IncludeLoadResult,
  type ScriptIncludeErrorCode
} from "./scriptTypes";

export { SCRIPT_INCLUDE_ROOT_ID };

/**
 * Longest include chain, counted in modules below the entry script. Past any
 * real layering — and this is not a stack bound (every level is an `await`),
 * it is a runaway-chain tripwire that fires early and says why.
 */
export const SCRIPT_INCLUDE_MAX_DEPTH = 16;

/**
 * Most DISTINCT modules one run may load. Counts modules, not include calls —
 * a poll loop that calls `include()` on every tick loads one module and may
 * call it a million times.
 *
 * WHY A CAP AT ALL (A-F2): not to bound a main-side source cache — main
 * deliberately retains no module source (see `IncludeModuleRecord`). It is
 * protocol sanity (a run that has minted 64 module ids has stopped doing what
 * this feature is for) plus worker-heap pressure: every delivered module lands
 * in the worker as a retained UTF-16 string plus its evaluated exports, inside
 * that isolate's own `maxOldGenerationSizeMb: 192` budget, and a worker that
 * hits it dies with an allocation failure rather than a diagnosable error.
 * Counting modules is not by itself enough to keep that from happening — see
 * `SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES`, which bounds the bytes.
 */
export const SCRIPT_INCLUDE_MAX_MODULES = 64;

/**
 * Most module SOURCE one run may load in total, summed over every module whose
 * source was delivered. Counts bytes, not files — and, like the module cap,
 * counts each module once however many times it is included.
 *
 * WHY THE COUNT CAP ALONE WAS NOT ENOUGH: the two limits bound different
 * things, and only this one bounds memory. Per-file size is governed by
 * `ctx.maxBytes` (`nexus.scripts.maxReadSizeMb`, 1–16 MiB, default 4 MiB), so
 * 64 modules at the ceiling is ~1 GiB of source — ~2 GiB once the worker holds
 * it as UTF-16 — against that isolate's `maxOldGenerationSizeMb: 192`. A run
 * that included many large-but-individually-legal modules therefore died with a
 * worker allocation crash BEFORE the 64th module was ever reached, i.e. a
 * supported configuration failing with a crash instead of the documented typed
 * error. Delivered source is retained for the life of the run (V8 keeps
 * function source for lazy compilation and `toString`), so it cannot be
 * modelled as transient.
 *
 * WHY 48 MiB: as UTF-16 that is ≈96 MiB of worker heap — deliberately about
 * HALF the worker's own 192 MiB, leaving the other half for what the script
 * actually computes. Same posture as the rest of this feature's amendments (see
 * A-F2 above): the worker's heap cap is the BACKSTOP, and a limit like this one
 * exists so supported usage never has to reach it — a refusal names the budget,
 * an allocation failure names nothing.
 */
export const SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES = 48 * 1024 * 1024; // 48 MiB

/**
 * One loaded module, main-side.
 *
 * DELIBERATELY NO `source` FIELD (A-F2). The wire protocol delivers a module's
 * source exactly once — a repeat include answers `cached: true` with no source,
 * and a `cached: true` the worker has no entry for is a protocol violation, not
 * a resend — so retaining the text buys nothing and would pin up to
 * `SCRIPT_INCLUDE_MAX_MODULES × ctx.maxBytes` (1 GiB at the 16 MiB ceiling) in
 * the extension host for the life of the run. For the same reason there is no
 * `delivered` flag: a record EXISTS if and only if its source was delivered, in
 * the same tick, so a separate flag could only ever go stale.
 */
export interface IncludeModuleRecord {
  /** Opaque, per-run. `#root` for the entry script, then `m1`, `m2`, … */
  id: string;
  /** Absolute, contained, in the run's own path flavour. */
  resolvedPath: string;
  /** `resolvedPath` folded the way the filesystem folds it — the identity key. */
  cacheKey: string;
  /** Where this file's own relative paths resolve from. `undefined` only for an untitled entry script. */
  dirPath: string | undefined;
  /** Human label for stacks and audit lines, e.g. `lib/helpers.js`. */
  displayName: string;
}

/** One run's include bookkeeping. Created at run start, dies with the run. */
export interface ScriptIncludeState {
  byId: Map<string, IncludeModuleRecord>;
  byKey: Map<string, IncludeModuleRecord>;
  /**
   * Loads whose read is in flight, keyed by cache key. Populated BEFORE the
   * first await so that concurrent includes of the same not-yet-loaded file
   * (`Promise.all`, or two libraries reaching one helper) coalesce into one
   * read and one module id — without it, both would miss the cache, both would
   * read, and the worker would evaluate one file twice under two ids, handing
   * out two different exports objects for the same path. Entries are removed
   * when the load settles: a REFUSED load is never remembered (A-F4 — only
   * modules whose source was delivered are once-per-run).
   */
  pending: Map<string, Promise<IncludeModuleRecord>>;
  nextId: number;
  /**
   * Bytes of module source DELIVERED so far this run, against
   * `SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES`. Charged once per module, when its
   * record is minted — a refused load charges nothing (A-F4) and a cache hit
   * charges nothing (the protocol sends the source once). Never decremented:
   * the worker retains every module for the life of the run, so neither does
   * this.
   */
  totalSourceBytes: number;
  /** Path semantics for this run, from `buildScriptFsScope`. */
  platform: ScriptFsPlatform;
}

/**
 * Seed a run's include state with the entry script as `#root`, so the very
 * first `include()` has a resolution base and the cycle check has a first hop
 * to name.
 */
export function createScriptIncludeState(ctx: ScriptFsContext): ScriptIncludeState {
  const scope = buildScriptFsScope(ctx);
  // An untitled: script has no directory at all. It still gets a `#root`
  // record — every include then refuses with the inherited NoScriptDir, which
  // `resolveScriptFsTarget` raises before any base is consulted.
  const platform: ScriptFsPlatform = "code" in scope ? "posix" : scope.platform;
  const resolvedPath = pathOfUri(ctx.scriptUri);
  const dirPath = "code" in scope ? undefined : scope.scriptDirPath;
  const root: IncludeModuleRecord = {
    id: SCRIPT_INCLUDE_ROOT_ID,
    resolvedPath,
    cacheKey: includeCacheKeyFor(resolvedPath, platform),
    dirPath,
    displayName: includeDisplayName(resolvedPath, ctx, platform)
  };
  return {
    byId: new Map([[root.id, root]]),
    byKey: new Map([[root.cacheKey, root]]),
    pending: new Map(),
    nextId: 1,
    totalSourceBytes: 0,
    platform
  };
}

/**
 * The identity of a file for caching and cycle detection: its resolved path,
 * case-folded exactly where the PLATFORM folds it. win32 is case-insensitive,
 * so `./Lib.js` and `./lib.js` are one module there and two on posix — matching
 * `isLexicallyWithin`'s own win32 folding. Identity is LEXICAL, deliberately:
 * the whole containment layer works on paths and never consults the disk
 * (`scriptFsScope.ts`), and the cache/cycle steps of the include ladder are
 * I/O-free on purpose. The honest cost, stated in the docs, is that two
 * spellings the DISK considers one file can be two modules here — the body
 * runs twice, exports are two objects. Three ways to get there: a
 * case-insensitive posix volume (macOS APFS's default — posix folding keeps
 * them distinct); a remote-Windows host (non-`file:` schemes are forced to
 * posix by `buildScriptFsScope`, a Uri carries no way to know the far host's
 * OS); two symlinked paths to one file (symlinks are followed, never
 * resolved). A stat/realpath-based canonical identity would collapse all
 * three, but it would put I/O (and a TOCTOU window) inside the identity
 * check, and inode identity does not exist on non-`file:` providers at all —
 * the double-evaluation is self-harm-only (containment, budgets and the
 * per-file cap all still hold, and both spellings still count against the
 * module and byte limits), so lexical stays. Write one spelling per file.
 */
export function includeCacheKeyFor(resolvedPath: string, platform: ScriptFsPlatform): string {
  return platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

/** The directory a module's relative paths resolve against. */
export function includeModuleDirOf(state: ScriptIncludeState, moduleId: unknown): string | undefined {
  return moduleRecordOf(state, moduleId).dirPath;
}

/** The human label a module is known by in stacks and audit lines. */
export function includeModuleDisplayNameOf(state: ScriptIncludeState, moduleId: unknown): string {
  return moduleRecordOf(state, moduleId).displayName;
}

function moduleRecordOf(state: ScriptIncludeState, moduleId: unknown): IncludeModuleRecord {
  const record = typeof moduleId === "string" ? state.byId.get(moduleId) : undefined;
  if (!record) {
    // Never a fallback to the entry script: an id this run never minted means
    // the worker and main disagree about the module graph, and quietly
    // resolving against some other directory would turn a protocol violation
    // into a wrong-file read.
    throw makeIncludeError(
      "IncludeInternal",
      `Unknown module id ${JSON.stringify(String(moduleId))} — this should never happen; please file an issue.`
    );
  }
  return record;
}

/**
 * Load one module for the worker: the 11-step ladder documented at the top of
 * this file. Resolves to what the worker needs (an id, a display name, and the
 * source the FIRST time), or throws a typed, already-logged refusal.
 */
export async function scriptIncludeLoad(
  requested: unknown,
  chain: unknown,
  ctx: ScriptFsContext,
  state: ScriptIncludeState
): Promise<IncludeLoadResult> {
  const label = describeRequest(requested);

  // 1. The chain must be one this run actually minted. Structural only — see
  //    the trust model above for why this is a diagnosis, not a gate.
  const parents = validateChain(chain, state, ctx, label);

  // 2. Depth, before anything is resolved or read.
  if (parents.length > SCRIPT_INCLUDE_MAX_DEPTH) {
    throw failInclude(ctx, label, "IncludeDepthExceeded", `${parents.length} > ${SCRIPT_INCLUDE_MAX_DEPTH}`, {
      message: `include depth ${parents.length} exceeds the limit of ${SCRIPT_INCLUDE_MAX_DEPTH}. Flatten the chain, or hoist the shared part into one module.`,
      extra: { depth: parents.length, maxDepth: SCRIPT_INCLUDE_MAX_DEPTH }
    });
  }

  // 3. The including file's own directory is the resolution base.
  const baseDirPath = parents[parents.length - 1].dirPath;

  // 4. Resolve + contain. Throws (and logs) the inherited nexus.fs refusals:
  //    NoScriptDir, InvalidPath, PathOutsideScope.
  const resolvedPath = resolveScriptFsTarget(requested, ctx, baseDirPath);

  // 5. `.js` only — no implicit extension, no index.js, no bare specifiers.
  if (!/\.js$/i.test(resolvedPath)) {
    throw failInclude(ctx, label, "InvalidPath", undefined, {
      code: "InvalidPath",
      message: `nexus.include() only loads .js files (got ${JSON.stringify(String(requested))}). Use nexus.fs.readText / nexus.fs.readJson for data files.`
    });
  }

  const cacheKey = includeCacheKeyFor(resolvedPath, state.platform);

  // 6. Cycle: is this file already on the chain that is asking for it?
  const cycleAt = parents.findIndex((record) => record.cacheKey === cacheKey);
  if (cycleAt !== -1) {
    const cycle = [...parents.map((record) => record.displayName), parents[cycleAt].displayName];
    const rendered = cycle.join(" → ");
    throw failInclude(ctx, label, "CircularInclude", rendered, {
      message: `Circular include: ${rendered}. Hoist the shared part into a third module that neither includes the other.`,
      extra: { cycle }
    });
  }

  // 7. Already loaded, or being loaded right now — no I/O either way.
  const known = state.byKey.get(cacheKey);
  if (known) return cachedResult(ctx, label, known);
  const inFlight = state.pending.get(cacheKey);
  if (inFlight) {
    try {
      return cachedResult(ctx, label, await inFlight);
    } catch (err) {
      // The starter's ladder logged the refusal for ITS request; this joiner's
      // request is a distinct call and the invariant above ("every refusal
      // writes its audit line before it throws") owes it a line of its own.
      ctx.log(`include ${label} → ${(err as { code?: string })?.code ?? "Error"}`);
      throw err;
    }
  }

  // 8. Distinct-module cap, checked BEFORE the read. Counts COMMITTED modules:
  //    registered ones (byKey, minus #root) plus loads still in flight
  //    (pending — each is a reservation that will register on success and is
  //    deleted in the starter's `finally` on refusal). Counting only byKey
  //    would let a single-tick `Promise.all` fan-out pass this check 80 times
  //    while byKey is still empty — steps 1-8 are synchronous, registration
  //    happens after the async read — and load every one of them.
  const committed = state.byKey.size - 1 + state.pending.size;
  if (committed >= SCRIPT_INCLUDE_MAX_MODULES) {
    throw failInclude(ctx, label, "IncludeLimitExceeded", `${SCRIPT_INCLUDE_MAX_MODULES} modules`, {
      message: `This run has already loaded ${SCRIPT_INCLUDE_MAX_MODULES} modules, the maximum.`,
      extra: { count: committed, maxModules: SCRIPT_INCLUDE_MAX_MODULES }
    });
  }

  // 8b. Source budget, cheap half: a run with NOTHING left cannot admit any
  //     module, whatever this one's size turns out to be, so it is refused here
  //     rather than after a read that could cost a slot and a whole `maxBytes`
  //     buffer. The authoritative check is in `readAndRegister`, where the size
  //     is finally known.
  if (state.totalSourceBytes >= SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES) {
    throw failSourceBudget(ctx, label, state.totalSourceBytes);
  }

  const displayName = includeDisplayName(resolvedPath, ctx, state.platform);
  const load = readAndRegister(resolvedPath, cacheKey, displayName, ctx, state, label);
  // The in-flight entry hands back only the RECORD: a concurrent caller that
  // joins a load already under way is a cache hit (`cached: true`, no source),
  // exactly like one that arrives after it finished. The source is delivered to
  // the single caller that started the read, and to nobody else.
  const shared = load.then((delivered) => delivered.record);
  // A refused load rejects `shared` as well as `load`. `load` is awaited below,
  // but `shared` is awaited only if a concurrent caller actually joined — so
  // without this no-op handler an ordinary refusal (FileNotFound, Stopped, …)
  // would surface as an UNHANDLED rejection in the extension host whenever
  // nobody happened to join. Attaching it here does not swallow anything a
  // joiner sees: a joiner awaits `shared` itself and still gets the rejection.
  shared.catch(() => {});
  state.pending.set(cacheKey, shared);
  let delivered: { record: IncludeModuleRecord; source: string };
  try {
    delivered = await load;
  } finally {
    // A refused load leaves nothing behind: refusals are re-evaluated (and
    // re-read) on every call, bounded by the read pool and the 30s deadline
    // exactly like any other nexus.fs call (A-F4).
    state.pending.delete(cacheKey);
  }
  return {
    moduleId: delivered.record.id,
    displayName: delivered.record.displayName,
    source: delivered.source,
    cached: false
  };
}

/**
 * Steps 9-11: read the source (shared read pool, run cap, UTF-8, 30s deadline),
 * refuse a marked script, then mint the record and log the success line.
 *
 * The source rides back out through the returned `IncludeLoadResult` that
 * `scriptIncludeLoad` builds around this record — it is never stored (A-F2).
 */
async function readAndRegister(
  resolvedPath: string,
  cacheKey: string,
  displayName: string,
  ctx: ScriptFsContext,
  state: ScriptIncludeState,
  label: string
): Promise<{ record: IncludeModuleRecord; source: string }> {
  // 9. The read itself. Holds exactly one read permit, released before this
  //    function returns — see the no-deadlock invariant at the top.
  const { text, byteLength } = await scriptFsReadSource(resolvedPath, ctx);

  // 10. A marked file is an entry point, not a library. Refused loudly and NOT
  //     remembered — nothing is cached, no id is minted, no header directive of
  //     the included file is ever read (only `marker` is inspected: an included
  //     file must not be able to unlock the terminal or re-enable macros behind
  //     the entry script's back).
  if (parseScriptHeader(text).marker) {
    throw failInclude(ctx, label, "IncludeIsScript", undefined, {
      message: `${displayName} is a Nexus script (@nexus-script), not a library — scripts are entry points. Remove the marker to include it, or run it on its own.`,
      extra: { module: displayName }
    });
  }

  // 10b. Source budget, authoritative half — the size is known only now, and
  //      this is the last point before the module becomes committed. The total
  //      is read HERE, not snapshotted before the read: registration runs
  //      sequentially on the event loop, so a `Promise.all` fan-out of loads
  //      whose sizes nobody knew in advance still settles one at a time through
  //      this one check, and each sees every earlier commit. (Same reasoning as
  //      the count cap's in-flight accounting at step 8, from the other end: the
  //      count can be reserved before the read, bytes cannot.) Refusing here
  //      costs one already-completed read and charges nothing — A-F4: a refused
  //      load is never remembered.
  if (state.totalSourceBytes + byteLength > SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES) {
    throw failSourceBudget(ctx, label, state.totalSourceBytes);
  }

  // 11. Mint the record and log.
  const record: IncludeModuleRecord = {
    id: `m${state.nextId++}`,
    resolvedPath,
    cacheKey,
    dirPath: scriptFsDirname(resolvedPath, state.platform),
    displayName
  };
  state.byId.set(record.id, record);
  state.byKey.set(record.cacheKey, record);
  state.totalSourceBytes += byteLength;
  ctx.log(`include ${label} → ${displayName} (${byteLength} bytes)`);
  return { record, source: text };
}

/**
 * The source-budget refusal, shared by both halves of the check so the message,
 * the extras and the audit line cannot drift apart.
 *
 * `totalBytes` is the run's COMMITTED total at the moment of refusal — the
 * bytes already delivered, never including the module being refused (which is
 * delivered to nobody). It reads the same on both halves, and matches how the
 * count cap reports `count`.
 */
function failSourceBudget(ctx: ScriptFsContext, label: string, loaded: number): Error {
  const mib = SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES / (1024 * 1024);
  return failInclude(ctx, label, "IncludeLimitExceeded", "source budget", {
    message: `This run's include budget is exhausted: ${loaded} bytes of module source already loaded, the limit is ${SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES} (${mib} MiB). Split less, or include fewer/smaller modules.`,
    extra: { totalBytes: loaded, maxTotalBytes: SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES }
  });
}

function cachedResult(ctx: ScriptFsContext, label: string, record: IncludeModuleRecord): IncludeLoadResult {
  ctx.log(`include ${label} → ${record.displayName} (cached)`);
  return { moduleId: record.id, displayName: record.displayName, cached: true };
}

/**
 * The chain, resolved to this run's own records: `#root` first, the immediate
 * parent last. Anything else is a protocol violation.
 */
function validateChain(
  chain: unknown,
  state: ScriptIncludeState,
  ctx: ScriptFsContext,
  label: string
): IncludeModuleRecord[] {
  const bad = (detail: string): Error => failInclude(ctx, label, "IncludeInternal", undefined, {
    message: `Malformed include chain (${detail}) — this should never happen; please file an issue.`
  });
  if (!Array.isArray(chain) || chain.length === 0) throw bad("not a non-empty array");
  if (chain[0] !== SCRIPT_INCLUDE_ROOT_ID) throw bad(`does not start at ${SCRIPT_INCLUDE_ROOT_ID}`);
  return chain.map((id) => {
    if (typeof id !== "string" || !state.byId.has(id)) {
      throw bad(`unknown module id ${JSON.stringify(String(id))}`);
    }
    return state.byId.get(id)!;
  });
}

/**
 * A module's human label: relative to the scripts root when it lives there,
 * otherwise relative to the entry script's own folder, otherwise the bare
 * filename. Always rendered with `/` separators so a stack frame reads the same
 * on every platform.
 */
function includeDisplayName(resolvedPath: string, ctx: ScriptFsContext, platform: ScriptFsPlatform): string {
  // Nothing here may throw: this runs at run START, and a Uri whose path could
  // not be read must cost a good label, never the run itself.
  if (resolvedPath === "") return "script";
  const scope = buildScriptFsScope(ctx);
  if ("code" in scope) return baseNameOf(resolvedPath, platform);
  const roots = [scope.scriptsRootPath, scope.scriptDirPath];
  for (const root of roots) {
    if (root !== undefined && isLexicallyWithin(resolvedPath, root, platform)) {
      const rel = relativeUnder(resolvedPath, root, platform);
      if (rel !== "") return rel;
    }
  }
  return baseNameOf(resolvedPath, platform);
}

function relativeUnder(candidate: string, root: string, platform: ScriptFsPlatform): string {
  // `isLexicallyWithin` has already established containment, so a plain string
  // slice is safe here and keeps the display name free of `..` segments.
  const sep = platform === "win32" ? /[\\/]/ : /\//;
  const candidateParts = candidate.split(sep).filter((p) => p !== "");
  const rootParts = root.split(sep).filter((p) => p !== "");
  return candidateParts.slice(rootParts.length).join("/");
}

function baseNameOf(p: string, platform: ScriptFsPlatform): string {
  const parts = p.split(platform === "win32" ? /[\\/]/ : /\//);
  return parts[parts.length - 1] || p;
}

/**
 * The entry script's own path, in the flavour `scriptFs.ts` uses for that
 * scheme (`.fsPath` for `file:`, the always-POSIX `.path` otherwise).
 *
 * Falls back to the other member, and finally to the empty string, rather than
 * propagating an `undefined` into `path.resolve` — a Uri-like object that
 * populated only one of the two (every test double in this repo, and any host
 * that hands us a plain object) must not be able to make run start throw. The
 * empty string degrades two things: the entry script's display label, and —
 * because `#root.cacheKey` derives from it — cycle detection for a module that
 * resolves back to the entry script itself (it would load as a second module
 * instead of raising `CircularInclude`). Both are unreachable with a real
 * `vscode.Uri`, which always populates `.path` AND `.fsPath`; only degenerate
 * Uri-likes land here, and for those there is no path to resolve against
 * anyway.
 */
function pathOfUri(uri: ScriptFsContext["scriptUri"]): string {
  const primary = uri.scheme === "file" ? uri.fsPath : uri.path;
  if (typeof primary === "string" && primary !== "") return primary;
  const fallback = uri.scheme === "file" ? uri.path : uri.fsPath;
  return typeof fallback === "string" ? fallback : "";
}

/** What an audit line and an error message call the thing the script asked for. */
function describeRequest(requested: unknown): string {
  return typeof requested === "string" ? requested : JSON.stringify(String(requested));
}

/**
 * Log the refusal, then build the error to throw. Same shape (and the same
 * top-level `extra` spreading contract) as `scriptFs.ts`'s `fail()`: every
 * refusal is on the record before it is thrown, because the script's own
 * `catch` may swallow it and the Output Channel is then the only trace.
 *
 * `detail`, when present, is the parenthesised half of the audit line — the
 * cycle, the depth comparison, the module count. It is deliberately part of the
 * LOG rather than reconstructed from the error: the log line is what a user
 * reads, and it should say why without them having to catch anything.
 */
function failInclude(
  ctx: ScriptFsContext,
  label: string,
  code: ScriptIncludeErrorCode | "InvalidPath",
  detail: string | undefined,
  spec: { code?: string; message: string; extra?: Record<string, unknown> }
): Error {
  ctx.log(`include ${label} → ${code}${detail ? ` (${detail})` : ""}`);
  return makeIncludeError(spec.code ?? code, spec.message, spec.extra);
}

function makeIncludeError(code: string, message: string, extra?: Record<string, unknown>): Error & { code: string } {
  // Extras go TOP-LEVEL, not nested under `.extra`: `extraFieldsOf` in
  // scriptRuntimeManager.ts hoists every own enumerable property except
  // code/message/stack/name, and the worker's `reviveError` spreads them back
  // onto the revived Error — so `err.cycle` / `err.depth` / `err.maxModules`
  // round-trip script-side exactly as the d.ts promises.
  return Object.assign(new Error(message), { code }, extra) as Error & { code: string };
}
