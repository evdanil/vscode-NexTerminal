import * as vscode from "vscode";
import type { NexusCore } from "../../core/nexusCore";
import type { MacroAutoTrigger } from "../macroAutoTrigger";
import { ScriptOutputBuffer } from "./scriptOutputBuffer";
import type {
  FinalState,
  RunState,
  RunningScriptSnapshot,
  ScriptRunEvent,
  ScriptRunOperation
} from "./scriptTypes";

export interface ScriptRuntimeManagerDependencies {
  core: NexusCore;
  macroAutoTrigger: MacroAutoTrigger;
  outputChannel: vscode.OutputChannel;
  /** Absolute path to dist/services/scripts/scriptWorker.js. Injected so tests can swap it out. */
  workerPath: string;
}

/**
 * Internal record for a running script. Filled in during T023 / T024.
 * The skeleton lives here so downstream US1 tasks have a stable type to reference.
 */
export interface RunningScriptRecord {
  id: string;
  scriptName: string;
  scriptPath: string;
  sessionId: string;
  sessionName: string;
  sessionType: "ssh" | "serial";
  startedAt: number;
  state: RunState;
  currentOperation: ScriptRunOperation | null;
  outputBuffer: ScriptOutputBuffer;
  /** Disposable returned by pty.addOutputObserver — cleared on cleanup. */
  observerSubscription?: vscode.Disposable;
  /** True if @lock-input was honored for this run. */
  inputLockHeld: boolean;
  /** Disposable returned by macroAutoTrigger.pushFilter in US4. */
  macroFilterHandle?: vscode.Disposable;
  endedAt?: number;
}

export class ScriptRuntimeManager implements vscode.Disposable {
  private readonly runs = new Map<string, RunningScriptRecord>();
  private readonly _onDidChangeRun = new vscode.EventEmitter<ScriptRunEvent>();
  public readonly onDidChangeRun: vscode.Event<ScriptRunEvent> = this._onDidChangeRun.event;

  public constructor(protected readonly deps: ScriptRuntimeManagerDependencies) {}

  /**
   * Start a script run against a session.
   *
   * Implementation lives in T023 (US1). This skeleton is intentionally incomplete —
   * any caller invoking it before US1 implementation lands will receive a clear error.
   */
  public runScript(_uri: vscode.Uri, _sessionId?: string): Promise<string> {
    throw new Error("ScriptRuntimeManager.runScript is not implemented yet (wired in US1 / T023).");
  }

  /**
   * Stop the running script bound to `sessionId`. Implementation in T024 (US1).
   */
  public stopScript(_sessionId: string): Promise<void> {
    throw new Error("ScriptRuntimeManager.stopScript is not implemented yet (wired in US1 / T024).");
  }

  /**
   * Current snapshot of all runs for UI consumers (tree / status bar / codelens).
   */
  public getRuns(): RunningScriptSnapshot[] {
    return Array.from(this.runs.values(), (r) => this.toSnapshot(r));
  }

  /** Get a specific running script's descriptor, keyed by sessionId. */
  public getRunForSession(sessionId: string): RunningScriptRecord | undefined {
    return this.runs.get(sessionId);
  }

  /** Public accessor used by tests and UI components to fire events from the runtime. */
  protected emit(event: ScriptRunEvent): void {
    this._onDidChangeRun.fire(event);
  }

  protected toSnapshot(r: RunningScriptRecord): RunningScriptSnapshot {
    return {
      id: r.id,
      scriptName: r.scriptName,
      scriptPath: r.scriptPath,
      sessionId: r.sessionId,
      sessionName: r.sessionName,
      sessionType: r.sessionType,
      startedAt: r.startedAt,
      state: r.state,
      currentOperation: r.currentOperation
    };
  }

  /** Protected helper for US1 cleanup — disposes observer + macro filter + input lock in order. */
  protected cleanupRun(record: RunningScriptRecord, finalState: FinalState): void {
    record.macroFilterHandle?.dispose();
    record.macroFilterHandle = undefined;
    record.observerSubscription?.dispose();
    record.observerSubscription = undefined;
    if (record.inputLockHeld) {
      const session = this.deps.core.getActiveSessionById(record.sessionId);
      session?.pty?.setInputBlocked(false);
      record.inputLockHeld = false;
    }
    record.state = finalState;
    record.endedAt = Date.now();
    this.emit({
      kind: "ended",
      run: this.toSnapshot(record),
      finalState,
      durationMs: record.endedAt - record.startedAt
    });
    this.runs.delete(record.sessionId);
  }

  public dispose(): void {
    for (const run of this.runs.values()) {
      this.cleanupRun(run, "stopped");
    }
    this.runs.clear();
    this._onDidChangeRun.dispose();
  }
}
