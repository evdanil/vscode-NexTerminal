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
}

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
  | { kind: "ended"; run: RunningScriptSnapshot; finalState: FinalState; durationMs: number };

/** IPC frame sent from main → worker. */
export type WorkerInbound =
  | { kind: "load"; source: string }
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
