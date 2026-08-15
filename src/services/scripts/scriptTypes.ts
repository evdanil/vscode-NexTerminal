/**
 * Shared types for the Nexus Scripts subsystem.
 *
 * Pure types — no vscode imports so this file is safe for the worker bundle too.
 */

export type RunState =
  | "starting"
  | "running"
  | "completed"
  | "stopped"
  | "failed"
  | "connection-lost";

export type FinalState = Exclude<RunState, "starting" | "running">;

export type ScriptTargetType = "ssh" | "serial" | "local";

export interface ScriptRunOperation {
  kind: "wait" | "poll" | "prompt" | "sleep";
  label: string;
  startedAt: number;
}

export interface RunningScriptSnapshot {
  id: string;
  scriptName: string;
  scriptPath: string;
  sessionId: string;
  sessionName: string;
  sessionType: ScriptTargetType;
  startedAt: number;
  state: RunState;
  currentOperation: ScriptRunOperation | null;
  /** Whether the script requested `@lock-input` and the lock is currently held. */
  inputLockHeld: boolean;
}

/**
 * Categorises why a failed script ended, for UI filtering.
 *   - "worker-crash"  — the Worker thread itself errored (native crash, allocation, etc.).
 *   - "script-error"  — user code threw an uncaught exception that isn't a well-known
 *                       runtime code (i.e. looks like a bug or syntax error).
 *   - "expected"      — user code threw one of the well-known codes the API documents
 *                       (Timeout / ConnectionLost / Stopped / Cancelled). Surfacing
 *                       a toast for these would be noise.
 */
export type FailureReason = "worker-crash" | "script-error" | "expected";

/**
 * Reasons the host may pass to `stopScript(sessionId, reason?)` for logging /
 * telemetry. Not part of the runtime state machine — scripts still end in `stopped`.
 */
export type StopReason = "user-requested" | "max-runtime-exceeded" | "extension-deactivating";

export type ScriptRunEvent =
  | { kind: "started"; run: RunningScriptSnapshot }
  | {
      kind: "operationBegin";
      run: RunningScriptSnapshot;
      op: { kind: ScriptRunOperation["kind"]; label: string };
    }
  | {
      kind: "operationEnd";
      run: RunningScriptSnapshot;
      result: "matched" | "timeout" | "user-input" | "tick" | "elapsed";
    }
  | {
      kind: "log";
      run: RunningScriptSnapshot;
      level: "info" | "warn" | "error";
      text: string;
    }
  | {
      kind: "ended";
      run: RunningScriptSnapshot;
      finalState: FinalState;
      durationMs: number;
      /** Only populated when `finalState === "failed"`. Lets the UI filter toasts. */
      failureReason?: FailureReason;
      /** Free-form context passed by the stop caller (e.g. "max-runtime-exceeded"). */
      stopReason?: StopReason;
    };

/**
 * Read-only metadata about the session a script is bound to. Exposed as the
 * `session` global in user scripts — see contracts/script-api.d.ts.
 */
export interface ScriptSessionMetadata {
  id: string;
  type: ScriptTargetType;
  name: string;
  targetId: string;
}

/**
 * Error codes thrown by the `nexus.fs` API. Deliberately NOT in
 * `EXPECTED_ERROR_CODES` (`scriptRuntimeManager.ts`) — an uncaught one means the
 * script's assumptions about its environment are wrong (missing fixture, bad
 * path literal, wrong encoding), the same "bug in the script" class that
 * classification set exists to toast.
 */
export type ScriptFsErrorCode =
  | "FileNotFound" // stat failed, or target is a directory
  | "PathOutsideScope" // lexical containment refused
  | "FileTooLarge" // over the run's effective cap — nexus.scripts.maxReadSizeMb (extra: { sizeBytes, maxBytes })
  | "NotUtf8" // bytes are not valid UTF-8
  | "NoScriptDir" // untitled: script — no on-disk location
  | "InvalidPath" // empty / non-string / NUL / drive-relative
  | "ReadFailed" // stat ok but read failed (permissions, provider error)
  | "InvalidJson"; // worker-side readJson parse failure (never crosses the RPC wire)

/**
 * Error codes thrown by `nexus.include()`. Like `ScriptFsErrorCode`, these are
 * deliberately NOT in `EXPECTED_ERROR_CODES` (`scriptRuntimeManager.ts`): a
 * refused include means the script's assumptions about its own file layout are
 * wrong (a typo'd specifier, a library that grew an `@nexus-script` marker, a
 * cycle someone just introduced) — the "bug in the script" class the crash
 * toast exists for, not cooperative control flow.
 *
 * A module body that THROWS is not in this list on purpose: its own error
 * propagates unwrapped, so the stack keeps pointing at the line that threw
 * (there is deliberately no `IncludeFailed` wrapper).
 */
export type ScriptIncludeErrorCode =
  /** The requested module is already on the current include chain (extra: `cycle: string[]`). */
  | "CircularInclude"
  /** The chain is longer than `SCRIPT_INCLUDE_MAX_DEPTH` (extra: `depth`, `maxDepth`). */
  | "IncludeDepthExceeded"
  /**
   * This run already loaded `SCRIPT_INCLUDE_MAX_MODULES` distinct modules
   * (extra: `count`, `maxModules`) — or `SCRIPT_INCLUDE_MAX_TOTAL_SOURCE_BYTES`
   * of combined module source (extra: `totalBytes`, `maxTotalBytes`).
   */
  | "IncludeLimitExceeded"
  /** The module's source did not compile (worker-side; extra: `module`). */
  | "IncludeSyntaxError"
  /** The target carries an `@nexus-script` marker — it is an entry point, not a library (extra: `module`). */
  | "IncludeIsScript"
  /** Protocol violation between worker and main — "should never happen". */
  | "IncludeInternal";

/**
 * The entry script's own module id. Opaque to the worker except for this one
 * value, which it needs so a root-level `nexus.fs` call stays byte-identical on
 * the wire to Phase 1's (no module-id argument at all).
 *
 * Lives here rather than in `scriptInclude.ts` because that module imports
 * `scriptFs.ts` and therefore `vscode` — off-limits to the worker bundle.
 */
export const SCRIPT_INCLUDE_ROOT_ID = "#root";

/**
 * Main's answer to an `include.load` RPC: everything the worker needs to
 * evaluate a module, and nothing it needs to be trusted with (it never sees a
 * resolved path — resolution and containment stay where enforcement is).
 */
export interface IncludeLoadResult {
  /** Opaque, main-assigned, per-run. The worker keys its evaluated modules by this. */
  moduleId: string;
  /** Human label for `//# sourceURL` and audit lines, e.g. `lib/helpers.js`. */
  displayName: string;
  /**
   * OMITTED when `cached === true`. Main delivers a module's source exactly
   * once per run, so a diamond never re-clones up to a full cap's worth of text
   * across the worker boundary.
   */
  source?: string;
  /**
   * True when main has already delivered this module's source in this run — in
   * which case the worker is guaranteed to hold an entry for `moduleId`, and
   * treats "cached but no entry" as `IncludeInternal`.
   */
  cached: boolean;
}

/** IPC frame sent from main → worker. */
export type WorkerInbound =
  | {
      kind: "load";
      source: string;
      /** The entry script's own display name — its `//# sourceURL`, so its stack frames name the file. */
      displayName: string;
      session: ScriptSessionMetadata;
    }
  | { kind: "rpc-result"; id: number; ok: true; value: unknown }
  | { kind: "rpc-result"; id: number; ok: false; error: { code: string; message: string; extra?: Record<string, unknown> } };

/** IPC frame sent from worker → main. */
export type WorkerOutbound =
  | { kind: "ready" }
  | { kind: "rpc"; id: number; method: string; args: unknown[] }
  | { kind: "log"; level: "info" | "warn" | "error"; text: string }
  | { kind: "complete" }
  | { kind: "failed"; error: { message: string; stack?: string; code?: string } };
