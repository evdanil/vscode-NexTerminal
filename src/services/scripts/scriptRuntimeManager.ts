import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import type { NexusCore } from "../../core/nexusCore";
import type { ActiveSession, ActiveSerialSession, SessionPtyHandle } from "../../models/config";
import type { MacroAutoTrigger, PtyOutputObserver } from "../macroAutoTrigger";
import { parseScriptHeader, type ScriptHeader } from "./scriptHeader";
import { ScriptMacroFilter } from "./scriptMacroFilter";
import { ensureWorkspaceScriptTypes, type BundledAssets } from "./scriptTypesGenerator";
import { ScriptOutputBuffer, type Match } from "./scriptOutputBuffer";
import { pickTarget, type ScriptTargetDescriptor } from "./scriptTarget";
import type {
  FailureReason,
  FinalState,
  RunState,
  RunningScriptSnapshot,
  ScriptRunEvent,
  ScriptRunOperation,
  StopReason,
  WorkerInbound,
  WorkerOutbound
} from "./scriptTypes";

/**
 * Error `code` values produced by well-behaved user scripts via the documented
 * runtime contract. These are *expected* errors and should not trigger a crash
 * toast in the UI — they're the mechanism by which scripts signal failure.
 */
const EXPECTED_ERROR_CODES = new Set(["Timeout", "ConnectionLost", "Stopped", "Cancelled"]);

export interface ScriptRuntimeManagerDependencies {
  core: NexusCore;
  macroAutoTrigger: MacroAutoTrigger;
  outputChannel: vscode.OutputChannel;
  /** Absolute path to dist/services/scripts/scriptWorker.js. */
  workerPath: string;
  /** Directory (absolute fsPath) containing bundled `nexus-scripts.d.ts` + `jsconfig.json`. */
  assetsDir?: vscode.Uri;
  /** Injection point for tests — lets them swap in a lightweight worker shim. */
  createWorker?: (workerPath: string) => WorkerLike;
}

/** Minimal surface the manager uses from the Worker — lets tests substitute. */
export interface WorkerLike {
  on(event: "message", listener: (msg: WorkerOutbound) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  postMessage(msg: WorkerInbound): void;
  terminate(): Promise<number>;
  unref(): void;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: { code: string; message: string; extra?: Record<string, unknown> }) => void;
  cancel(): void;
}

interface RunningScriptRecord {
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
  defaultTimeoutMs: number;
  worker: WorkerLike;
  pendingRpcs: Map<number, PendingRpc>;
  observerSubscription?: vscode.Disposable;
  macroFilter?: ScriptMacroFilter;
  macroFilterInitial?: { defaultAllow: boolean; allowList: string[]; denyList: string[] };
  macroFilterHandle?: vscode.Disposable;
  coreChangeSubscription?: vscode.Disposable;
  inputLockHeld: boolean;
  /** Direct PTY handle captured at run-start so cleanup can release the lock even
   *  after the session is deregistered from NexusCore (e.g. on ConnectionLost). */
  pty: SessionPtyHandle;
  writeBack: (data: string) => void;
  connectionLostSignaled: boolean;
  /** Idempotency guard — cleanupRun flips this at the very top so a racing
   *  "exit" event + ConnectionLost grace-timer can't double-dispose. */
  cleanedUp: boolean;
  /** Captured classification for the ended event (populated only on failure). */
  failureReason?: FailureReason;
  /** Context string passed to stopScript(); logged, surfaced on the ended event. */
  stopReason?: StopReason;
  endedAt?: number;
}

const CONTROL_KEY_BYTES: Record<string, string> = {
  "ctrl-a": "\x01", "ctrl-b": "\x02", "ctrl-c": "\x03", "ctrl-d": "\x04",
  "ctrl-e": "\x05", "ctrl-k": "\x0b", "ctrl-l": "\x0c", "ctrl-n": "\x0e",
  "ctrl-p": "\x10", "ctrl-r": "\x12", "ctrl-u": "\x15", "ctrl-w": "\x17",
  "ctrl-z": "\x1a",
  enter: "\r", esc: "\x1b", tab: "\t", space: " ", backspace: "\x7f",
  up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C",
  home: "\x1b[H", end: "\x1b[F", "page-up": "\x1b[5~", "page-down": "\x1b[6~",
  f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS",
  f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~", f8: "\x1b[19~",
  f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~"
};

export class ScriptRuntimeManager implements vscode.Disposable {
  private readonly runs = new Map<string, RunningScriptRecord>();
  private readonly _onDidChangeRun = new vscode.EventEmitter<ScriptRunEvent>();
  public readonly onDidChangeRun: vscode.Event<ScriptRunEvent> = this._onDidChangeRun.event;

  public constructor(private readonly deps: ScriptRuntimeManagerDependencies) {}

  public getRuns(): RunningScriptSnapshot[] {
    return Array.from(this.runs.values(), (r) => this.toSnapshot(r));
  }

  public async runScript(uri: vscode.Uri, sessionId?: string): Promise<string | undefined> {
    // US3: ensure IntelliSense scaffolding is in place in the workspace.
    await this.maybeSeedWorkspaceTypes();

    const source = await this.readScriptFile(uri);
    const header = parseScriptHeader(source);
    if (!header.marker) {
      void vscode.window.showErrorMessage(
        `${uri.fsPath} is not a Nexus script (missing @nexus-script marker in the leading JSDoc block).`
      );
      return undefined;
    }
    if (header.parseErrors.length > 0) {
      void vscode.window.showErrorMessage(
        `Script header has errors: ${header.parseErrors.join("; ")}`
      );
      return undefined;
    }
    const displayName = header.name ?? this.basenameWithoutExt(uri.fsPath);

    const target = sessionId
      ? this.resolveSession(sessionId)
      : await this.pickTargetForScript(displayName, header);
    if (!target) return undefined;

    if (this.runs.has(target.session.id)) {
      const existing = this.runs.get(target.session.id)!;
      const picked = await vscode.window.showWarningMessage(
        `"${existing.scriptName}" is running on ${target.session.terminalName}. Stop it and run "${displayName}"?`,
        { modal: true },
        "Stop & run"
      );
      if (picked !== "Stop & run") return undefined;
      await this.stopScript(target.session.id);
    }

    if (!target.session.pty) {
      void vscode.window.showErrorMessage(
        `Session ${target.session.terminalName} is not script-capable (no PTY handle).`
      );
      return undefined;
    }
    const pty = target.session.pty;

    const defaultTimeoutMs =
      header.defaultTimeoutMs ??
      (vscode.workspace.getConfiguration("nexus.scripts").get<number>("defaultTimeout") ?? 30_000);

    const record: RunningScriptRecord = {
      id: randomUUID(),
      scriptName: displayName,
      scriptPath: uri.fsPath,
      sessionId: target.session.id,
      sessionName: target.session.terminalName,
      sessionType: target.type,
      startedAt: Date.now(),
      state: "starting",
      currentOperation: null,
      outputBuffer: new ScriptOutputBuffer(),
      defaultTimeoutMs,
      worker: this.createWorker(),
      pendingRpcs: new Map(),
      inputLockHeld: false,
      pty,
      connectionLostSignaled: false,
      cleanedUp: false,
      writeBack: (data: string) => pty.writeProgrammatic(data)
    };

    record.observerSubscription = pty.addOutputObserver({
      onOutput: (text) => record.outputBuffer.append(text),
      pauseIntervalMacros: () => {},
      dispose: () => {}
    });

    // US4: install the macro filter for this session.
    const macroPolicy = vscode.workspace
      .getConfiguration("nexus.scripts")
      .get<string>("macroPolicy", "suspend-all");
    const defaultAllow = macroPolicy === "keep-enabled";
    const filter = new ScriptMacroFilter({
      defaultAllow,
      allowList: header.allowMacros,
      denyList: []
    });
    record.macroFilter = filter;
    record.macroFilterInitial = { defaultAllow, allowList: [...header.allowMacros], denyList: [] };
    record.macroFilterHandle = this.deps.macroAutoTrigger.pushFilter(target.session.id, filter);

    if (header.lockInput) {
      pty.setInputBlocked(true);
      record.inputLockHeld = true;
    }

    const unsubscribeCore = this.deps.core.onDidChange(() => {
      if (!this.deps.core.getActiveSessionById(target.session.id)) {
        this.handleConnectionLost(record);
      }
    });
    record.coreChangeSubscription = new vscode.Disposable(unsubscribeCore);

    record.worker.on("message", (msg: WorkerOutbound) => this.handleWorkerMessage(record, msg));
    record.worker.on("error", (err: Error) => this.handleWorkerError(record, err));
    record.worker.on("exit", (_code: number) => {
      if (record.state === "starting" || record.state === "running") {
        this.cleanupRun(record, "failed");
      }
    });

    this.runs.set(record.sessionId, record);
    record.state = "running";
    this.emit({ kind: "started", run: this.toSnapshot(record) });
    this.logEvent(record, `start (session: ${record.sessionName}, ${record.sessionType})`);
    // Seed the worker's `session` global in the same message that loads the
    // user source so it is defined before the script's first statement runs.
    record.worker.postMessage({
      kind: "load",
      source,
      session: {
        id: target.session.id,
        type: target.type,
        name: target.session.terminalName,
        targetId:
          target.type === "ssh"
            ? (target.session as ActiveSession).serverId
            : (target.session as ActiveSerialSession).profileId
      }
    });
    return record.id;
  }

  public async stopScript(sessionId: string, reason?: StopReason): Promise<void> {
    const record = this.runs.get(sessionId);
    if (!record) return;
    record.stopReason = reason ?? "user-requested";
    const graceMs = 100;
    const terminated = await Promise.race([
      record.worker.terminate().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs))
    ]);
    this.rejectAllPending(record, {
      code: "Stopped",
      message: record.stopReason === "max-runtime-exceeded"
        ? "Script stopped — max runtime exceeded"
        : "Script stopped by user"
    });
    if (!terminated) {
      this.logEvent(record, "warning: worker did not terminate within grace");
    }
    if (record.stopReason !== "user-requested") {
      this.logEvent(record, `stop reason: ${record.stopReason}`);
    }
    this.cleanupRun(record, "stopped");
  }

  public dispose(): void {
    for (const run of Array.from(this.runs.values())) {
      run.stopReason = "extension-deactivating";
      this.rejectAllPending(run, { code: "Stopped", message: "Extension deactivating" });
      void run.worker.terminate();
      this.cleanupRun(run, "stopped");
    }
    this.runs.clear();
    this._onDidChangeRun.dispose();
  }

  // ──────────────────────────── internals ────────────────────────────

  private createWorker(): WorkerLike {
    if (this.deps.createWorker) return this.deps.createWorker(this.deps.workerPath);
    const w = new Worker(this.deps.workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
      stdout: true,
      stderr: true
    });
    w.unref();
    return w as unknown as WorkerLike;
  }

  private async readScriptFile(uri: vscode.Uri): Promise<string> {
    // Prefer the live document text: (a) so untitled:// scripts work at all
    // (workspace.fs.readFile would reject), and (b) so we pick up unsaved
    // edits when the user runs from the editor CodeLens. Fall back to the
    // filesystem for scripts triggered from the tree view or palette where
    // the file may not be open.
    const openDocs = vscode.workspace.textDocuments ?? [];
    const openDoc = openDocs.find((d) => d.uri.toString() === uri.toString());
    if (openDoc) return openDoc.getText();
    if (uri.scheme === "untitled") {
      throw new Error(
        `Cannot run untitled script "${uri.toString()}" — save it first, or keep the editor open.`
      );
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder("utf-8").decode(bytes);
  }

  private async maybeSeedWorkspaceTypes(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !this.deps.assetsDir) return;
    const scriptsPath = vscode.workspace
      .getConfiguration("nexus.scripts")
      .get<string>("path", ".nexus/scripts");
    try {
      await ensureWorkspaceScriptTypes(folder.uri, scriptsPath, async () => {
        const dtsUri = vscode.Uri.joinPath(this.deps.assetsDir!, "nexus-scripts.d.ts");
        const jsconfigUri = vscode.Uri.joinPath(this.deps.assetsDir!, "jsconfig.json");
        const [dtsBytes, jsconfigBytes] = await Promise.all([
          vscode.workspace.fs.readFile(dtsUri),
          vscode.workspace.fs.readFile(jsconfigUri)
        ]);
        return {
          dts: new TextDecoder("utf-8").decode(dtsBytes),
          jsconfig: new TextDecoder("utf-8").decode(jsconfigBytes)
        } satisfies BundledAssets;
      });
    } catch (err) {
      // Seeding failures are non-fatal — scripts can still run, IntelliSense just won't seed.
      const message = err instanceof Error ? err.message : String(err);
      this.deps.outputChannel.appendLine(`[warn] failed to seed workspace script types: ${message}`);
    }
  }

  private basenameWithoutExt(fsPath: string): string {
    const name = fsPath.split(/[\\/]/).pop() ?? fsPath;
    return name.replace(/\.[^.]+$/, "");
  }

  private resolveSession(
    sessionId: string
  ): { type: "ssh" | "serial"; session: (ActiveSession | ActiveSerialSession) } | undefined {
    const snapshot = this.deps.core.getSnapshot();
    const ssh = snapshot.activeSessions.find((s) => s.id === sessionId);
    if (ssh) return { type: "ssh", session: ssh };
    const serial = snapshot.activeSerialSessions.find((s) => s.id === sessionId);
    if (serial) return { type: "serial", session: serial };
    return undefined;
  }

  private async pickTargetForScript(
    displayName: string,
    header: ScriptHeader
  ): Promise<{ type: "ssh" | "serial"; session: ActiveSession | ActiveSerialSession } | undefined> {
    const descriptor: ScriptTargetDescriptor = {
      displayName,
      targetType: header.targetType,
      targetProfile: header.targetProfile
    };
    const session = await pickTarget(descriptor, this.deps.core);
    if (!session) return undefined;
    // Classify by whether the session is in activeSessions or activeSerialSessions
    const snapshot = this.deps.core.getSnapshot();
    const kind: "ssh" | "serial" = snapshot.activeSessions.some((s) => s.id === session.id) ? "ssh" : "serial";
    return { type: kind, session };
  }

  private handleWorkerMessage(record: RunningScriptRecord, msg: WorkerOutbound): void {
    switch (msg.kind) {
      case "ready":
        // Worker ready; `load` was already sent.
        break;
      case "log":
        this.emit({ kind: "log", run: this.toSnapshot(record), level: msg.level, text: msg.text });
        this.logEvent(record, `log ${msg.level}: ${msg.text}`);
        break;
      case "complete":
        this.cleanupRun(record, record.connectionLostSignaled ? "connection-lost" : "completed");
        break;
      case "failed": {
        this.logEvent(record, `failed: ${msg.error.message}${msg.error.stack ? `\n${msg.error.stack}` : ""}`);
        // Classify for the UI — well-known runtime codes are the documented error
        // contract and shouldn't trigger a crash toast; anything else likely indicates
        // a bug in the script, a syntax error, or a module-load failure.
        if (!record.connectionLostSignaled) {
          record.failureReason =
            msg.error.code && EXPECTED_ERROR_CODES.has(msg.error.code) ? "expected" : "script-error";
        }
        this.cleanupRun(record, record.connectionLostSignaled ? "connection-lost" : "failed");
        break;
      }
      case "rpc":
        void this.dispatchRpc(record, msg.id, msg.method, msg.args);
        break;
    }
  }

  private handleWorkerError(record: RunningScriptRecord, err: Error): void {
    this.logEvent(record, `worker error: ${err.message}`);
    record.failureReason = "worker-crash";
    this.cleanupRun(record, "failed");
  }

  private async dispatchRpc(
    record: RunningScriptRecord,
    id: number,
    method: string,
    args: unknown[]
  ): Promise<void> {
    try {
      const value = await this.invokeMethod(record, method, args);
      record.worker.postMessage({ kind: "rpc-result", id, ok: true, value });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      record.worker.postMessage({
        kind: "rpc-result",
        id,
        ok: false,
        error: {
          code: e?.code ?? "UnknownError",
          message: e?.message ?? String(err),
          extra: extraFieldsOf(err)
        }
      });
    }
  }

  private async invokeMethod(
    record: RunningScriptRecord,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (method) {
      case "waitFor":
        return this.doWait(record, args[0] as string | RegExp, args[1] as WaitOpts | undefined, /*throwOnTimeout*/ false);
      case "expect":
        return this.doWait(record, args[0] as string | RegExp, args[1] as WaitOpts | undefined, /*throwOnTimeout*/ true);
      case "waitAny":
        return this.doWaitAny(record, args[0] as Array<string | RegExp>, args[1] as WaitOpts | undefined);
      case "send":
        record.writeBack(String(args[0] ?? ""));
        return undefined;
      case "sendLine":
        record.writeBack(String(args[0] ?? "") + "\r");
        return undefined;
      case "sendKey": {
        const key = String(args[0] ?? "").toLowerCase();
        const bytes = CONTROL_KEY_BYTES[key];
        if (!bytes) throw makeError("InvalidKey", `Unknown control key: ${key}`);
        record.writeBack(bytes);
        return undefined;
      }
      case "sleep":
        return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Number(args[0] ?? 0))));
      case "tail": {
        // Default 512 chars; cap negative input at 0 and huge input at the buffer's own cap.
        const requested = args[0] === undefined ? 512 : Number(args[0]);
        const n = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 512;
        return record.outputBuffer.tail(n);
      }
      case "poll":
        return this.doPoll(record, args[0] as PollOpts);
      case "prompt":
      case "confirm":
      case "alert":
        return this.doUserInteraction(record, method, args);
      case "macros.allow": {
        if (!record.macroFilter) return undefined;
        record.macroFilter.allow(args[0] as string | string[]);
        return undefined;
      }
      case "macros.deny": {
        if (!record.macroFilter) return undefined;
        record.macroFilter.deny(args[0] as string | string[]);
        return undefined;
      }
      case "macros.disableAll": {
        if (!record.macroFilter) return undefined;
        record.macroFilter.defaultAllow = false;
        record.macroFilter.clear();
        return undefined;
      }
      case "macros.restore": {
        if (!record.macroFilter || !record.macroFilterInitial) return undefined;
        record.macroFilter.defaultAllow = record.macroFilterInitial.defaultAllow;
        record.macroFilter.clear();
        for (const n of record.macroFilterInitial.allowList) record.macroFilter.allow(n);
        for (const n of record.macroFilterInitial.denyList) record.macroFilter.deny(n);
        return undefined;
      }
      default:
        throw makeError("UnknownMethod", `Unknown script RPC method: ${method}`);
    }
  }

  private async doWait(
    record: RunningScriptRecord,
    pattern: string | RegExp,
    opts: WaitOpts | undefined,
    throwOnTimeout: boolean
  ): Promise<Match | null> {
    const timeoutMs = opts?.timeout ?? record.defaultTimeoutMs;
    const patternLabel = patternToLabel(pattern);
    const opLabel = `waitFor ${patternLabel}`;
    this.beginOp(record, "wait", opLabel);
    const startedAt = Date.now();
    const m = await this.scanForMatch(record, pattern, opts?.lookback, timeoutMs);
    if (m) {
      record.outputBuffer.advanceCursor(m.endPosition);
      this.endOp(record, "matched");
      return m;
    }
    this.endOp(record, "timeout");
    if (throwOnTimeout) {
      throw makeError("Timeout", `expect timed out after ${Date.now() - startedAt}ms waiting for ${patternLabel}`, {
        pattern: patternLabel,
        timeoutMs,
        elapsedMs: Date.now() - startedAt
      });
    }
    return null;
  }

  private async doWaitAny(
    record: RunningScriptRecord,
    patterns: Array<string | RegExp>,
    opts: WaitOpts | undefined
  ): Promise<{ index: number; match: Match }> {
    const timeoutMs = opts?.timeout ?? record.defaultTimeoutMs;
    const patternLabel = patterns.map(patternToLabel).join(" | ");
    const opLabel = `waitAny ${patternLabel}`;
    this.beginOp(record, "wait", opLabel);
    const buffer = record.outputBuffer;
    const attemptAny = (): { index: number; match: Match } | null => {
      for (let i = 0; i < patterns.length; i++) {
        const m = buffer.scan(patterns[i], { lookback: opts?.lookback });
        if (m) return { index: i, match: m };
      }
      return null;
    };
    const hit = await this.scanForMatchGeneric(record, attemptAny, timeoutMs);
    if (hit) {
      buffer.advanceCursor(hit.match.endPosition);
      this.endOp(record, "matched");
      return hit;
    }
    this.endOp(record, "timeout");
    throw makeError("Timeout", `waitAny timed out after ${timeoutMs}ms waiting for ${patternLabel}`, {
      pattern: patternLabel,
      timeoutMs,
      elapsedMs: timeoutMs
    });
  }

  private async doPoll(record: RunningScriptRecord, opts: PollOpts): Promise<Match> {
    const every = Math.max(50, Number(opts?.every ?? 1000));
    const timeout = Math.max(every, Number(opts?.timeout ?? record.defaultTimeoutMs));
    const pattern = opts?.until;
    if (!pattern) throw makeError("InvalidArgs", "poll requires `until` pattern");
    const label = `poll every=${every}ms until ${patternToLabel(pattern)}`;
    this.beginOp(record, "poll", label);
    const deadline = Date.now() + timeout;
    const sendOnTick = async (): Promise<void> => {
      const s = opts?.send;
      if (typeof s === "string") record.writeBack(s);
      // Function-form for `send` is worker-side; not reachable via structured clone.
    };
    while (Date.now() < deadline) {
      await sendOnTick();
      const waitUntil = Math.min(every, deadline - Date.now());
      const m = await this.scanForMatch(record, pattern, undefined, waitUntil);
      if (m) {
        record.outputBuffer.advanceCursor(m.endPosition);
        this.endOp(record, "matched");
        return m;
      }
    }
    this.endOp(record, "timeout");
    throw makeError("Timeout", `poll timed out after ${timeout}ms waiting for ${patternToLabel(pattern)}`, {
      pattern: patternToLabel(pattern),
      timeoutMs: timeout,
      elapsedMs: timeout
    });
  }

  private async doUserInteraction(
    record: RunningScriptRecord,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const message = String(args[0] ?? "");
    this.beginOp(record, "prompt", `${method}: ${message}`);
    try {
      if (method === "prompt") {
        const opts = (args[1] ?? {}) as { default?: string; password?: boolean };
        const value = await vscode.window.showInputBox({
          prompt: message,
          value: opts.default,
          password: !!opts.password
        });
        this.endOp(record, "user-input");
        return value ?? "";
      }
      if (method === "confirm") {
        const picked = await vscode.window.showInformationMessage(
          message,
          { modal: true },
          "OK",
          "Cancel"
        );
        this.endOp(record, "user-input");
        return picked === "OK";
      }
      // alert
      await vscode.window.showInformationMessage(message, { modal: true }, "OK");
      this.endOp(record, "user-input");
      return undefined;
    } catch (err) {
      this.endOp(record, "timeout");
      throw err;
    }
  }

  /**
   * Scan a record's output buffer for a single pattern with a timeout, subscribing
   * for new output and registering in `pendingRpcs` so that Stopped / ConnectionLost
   * can cancel the wait (rather than letting the timer leak until its deadline).
   */
  private scanForMatch(
    record: RunningScriptRecord,
    pattern: string | RegExp,
    lookback: number | undefined,
    timeoutMs: number
  ): Promise<Match | null> {
    const buffer = record.outputBuffer;
    return this.scanForMatchGeneric(
      record,
      () => buffer.scan(pattern, { lookback }),
      timeoutMs
    );
  }

  /**
   * Shared scan-with-cancellation helper: runs `attempt` immediately, then re-runs
   * it on each new output event until it returns non-null, the timeout expires, or
   * the record is cancelled via `pendingRpcs` (Stop / ConnectionLost).
   */
  private scanForMatchGeneric<T>(
    record: RunningScriptRecord,
    attempt: () => T | null,
    timeoutMs: number
  ): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      const immediate = attempt();
      if (immediate !== null && immediate !== undefined) {
        resolve(immediate);
        return;
      }
      let resolved = false;
      const doResolve = (v: T | null): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        unsub();
        record.pendingRpcs.delete(rpcKey);
        resolve(v);
      };
      const doReject = (e: { code: string; message: string; extra?: Record<string, unknown> }): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        unsub();
        record.pendingRpcs.delete(rpcKey);
        reject(e);
      };
      const timer = setTimeout(() => doResolve(null), Math.max(0, timeoutMs));
      const unsub = record.outputBuffer.subscribe(() => {
        const m = attempt();
        if (m !== null && m !== undefined) doResolve(m);
      });
      const rpcKey = ++pendingIdCounter;
      record.pendingRpcs.set(rpcKey, {
        resolve: (v) => doResolve(v as T | null),
        reject: doReject,
        cancel: () => doResolve(null)
      });
    });
  }

  private beginOp(record: RunningScriptRecord, kind: ScriptRunOperation["kind"], label: string): void {
    record.currentOperation = { kind, label, startedAt: Date.now() };
    this.emit({
      kind: "operationBegin",
      run: this.toSnapshot(record),
      op: { kind, label }
    });
    this.logEvent(record, `→ ${label}`);
  }

  private endOp(record: RunningScriptRecord, result: "matched" | "timeout" | "user-input" | "tick" | "elapsed"): void {
    this.emit({ kind: "operationEnd", run: this.toSnapshot(record), result });
    this.logEvent(record, `← ${result}`);
    record.currentOperation = null;
  }

  private handleConnectionLost(record: RunningScriptRecord): void {
    if (record.connectionLostSignaled) return;
    if (record.state === "completed" || record.state === "stopped" || record.state === "failed" || record.state === "connection-lost") {
      return;
    }
    record.connectionLostSignaled = true;
    this.rejectAllPending(record, {
      code: "ConnectionLost",
      message: "Session disconnected",
      extra: { sessionId: record.sessionId }
    });
    // Give the user script a brief grace period to run its catch/finally block
    // and emit any final log messages before we force-terminate.
    const graceMs = 150;
    setTimeout(() => {
      if (!this.runs.has(record.sessionId)) return; // already cleaned up by worker "complete" / "failed"
      void record.worker.terminate();
      this.cleanupRun(record, "connection-lost");
    }, graceMs);
  }

  private rejectAllPending(
    record: RunningScriptRecord,
    error: { code: string; message: string; extra?: Record<string, unknown> }
  ): void {
    for (const entry of record.pendingRpcs.values()) {
      entry.reject(error);
    }
    record.pendingRpcs.clear();
  }

  private cleanupRun(record: RunningScriptRecord, finalState: FinalState): void {
    if (record.cleanedUp) return;
    record.cleanedUp = true;
    record.coreChangeSubscription?.dispose();
    record.observerSubscription?.dispose();
    record.macroFilterHandle?.dispose();
    if (record.inputLockHeld) {
      // Release directly via the captured PTY handle — works even after the
      // session has been deregistered from NexusCore (ConnectionLost path).
      try {
        record.pty.setInputBlocked(false);
      } catch {
        // PTY may already be torn down — safe to ignore.
      }
      record.inputLockHeld = false;
    }
    record.state = finalState;
    record.endedAt = Date.now();
    const snap = this.toSnapshot(record);
    this.emit({
      kind: "ended",
      run: snap,
      finalState,
      durationMs: record.endedAt - record.startedAt,
      failureReason: finalState === "failed" ? record.failureReason : undefined,
      stopReason: finalState === "stopped" ? record.stopReason : undefined
    });
    this.logEvent(record, `end: ${finalState} (${record.endedAt - record.startedAt}ms)`);
    this.runs.delete(record.sessionId);
  }

  private toSnapshot(r: RunningScriptRecord): RunningScriptSnapshot {
    return {
      id: r.id,
      scriptName: r.scriptName,
      scriptPath: r.scriptPath,
      sessionId: r.sessionId,
      sessionName: r.sessionName,
      sessionType: r.sessionType,
      startedAt: r.startedAt,
      state: r.state,
      currentOperation: r.currentOperation,
      inputLockHeld: r.inputLockHeld
    };
  }

  private emit(event: ScriptRunEvent): void {
    this._onDidChangeRun.fire(event);
  }

  private logEvent(record: RunningScriptRecord, text: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    this.deps.outputChannel.appendLine(
      `[${stamp}] ${record.scriptName}@${record.sessionName}  ${text}`
    );
  }
}

// ─── local helpers ───────────────────────────────────────────────────

interface WaitOpts {
  timeout?: number;
  lookback?: number;
}

interface PollOpts {
  send?: string;
  until?: string | RegExp;
  every?: number;
  timeout?: number;
}

let pendingIdCounter = 0;

function patternToLabel(p: string | RegExp): string {
  return typeof p === "string" ? JSON.stringify(p) : p.toString();
}

function makeError(
  code: string,
  message: string,
  extra?: Record<string, unknown>
): { code: string; message: string; extra?: Record<string, unknown> } & Error {
  return Object.assign(new Error(message), { code, extra });
}

function extraFieldsOf(err: unknown): Record<string, unknown> | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    let any = false;
    for (const k of Object.keys(e)) {
      if (k === "code" || k === "message" || k === "stack" || k === "name") continue;
      extra[k] = e[k];
      any = true;
    }
    if (any) return extra;
    if (e.extra && typeof e.extra === "object") return e.extra as Record<string, unknown>;
  }
  return undefined;
}
