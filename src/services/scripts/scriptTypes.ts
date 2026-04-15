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
  sessionType: "ssh" | "serial";
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
  type: "ssh" | "serial";
  name: string;
  targetId: string;
}

/** IPC frame sent from main → worker. */
export type WorkerInbound =
  | { kind: "load"; source: string; session: ScriptSessionMetadata }
  | { kind: "rpc-result"; id: number; ok: true; value: unknown }
  | { kind: "rpc-result"; id: number; ok: false; error: { code: string; message: string; extra?: Record<string, unknown> } };

/** IPC frame sent from worker → main. */
export type WorkerOutbound =
  | { kind: "ready" }
  | { kind: "rpc"; id: number; method: string; args: unknown[] }
  | { kind: "log"; level: "info" | "warn" | "error"; text: string }
  | { kind: "complete" }
  | { kind: "failed"; error: { message: string; stack?: string; code?: string } };

export class ScriptRuntimeError extends Error {
  public constructor(message: string, public readonly code: string, public readonly extra?: Record<string, unknown>) {
    super(message);
    this.name = "ScriptRuntimeError";
  }
}
