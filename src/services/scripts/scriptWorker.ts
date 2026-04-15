/*
 * Nexus Scripts worker bootstrap.
 *
 * IMPORTANT: This file runs inside a node:worker_threads Worker, NOT the VS Code extension host.
 * DO NOT import the `vscode` module or anything that transitively imports it — workers have no
 * extension-host context and the import will crash the bundle at runtime. Every operation that
 * touches VS Code APIs (showInputBox, window.showWarningMessage, etc.) MUST round-trip through the
 * main-thread RPC handlers via `rpc(...)` below.
 *
 * The worker loads user-authored `.js` source text via the `AsyncFunction` constructor, which is
 * equivalent to wrapping the body in `(async () => { ... })()` without template-string line-number
 * games. See specs/001-scripting-support/research.md RES-01 for rationale.
 */

import { parentPort } from "node:worker_threads";
import type { WorkerInbound, WorkerOutbound } from "./scriptTypes";

if (!parentPort) {
  throw new Error("scriptWorker.ts must be loaded as a worker_threads Worker, not a standalone script.");
}

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const pending = new Map<number, PendingEntry>();
let seq = 0;

function post(message: WorkerOutbound): void {
  parentPort!.postMessage(message);
}

/**
 * Round-trip an operation to the main thread and await its result.
 * The main thread maps the `method` to a handler that actually performs the work
 * (send to PTY, scan output buffer, show a VS Code dialog, etc.).
 */
function rpc<T = unknown>(method: string, args: unknown[]): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject
    });
    post({ kind: "rpc", id, method, args });
  });
}

/** Rebuild an Error on the worker side so user try/catch sees .code / .message. */
function reviveError(info: { code: string; message: string; extra?: Record<string, unknown> }): Error {
  const err = new Error(info.message);
  Object.assign(err, { code: info.code }, info.extra ?? {});
  return err;
}

parentPort.on("message", (msg: WorkerInbound) => {
  if (msg.kind === "rpc-result") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve(msg.value);
    } else {
      entry.reject(reviveError(msg.error));
    }
    return;
  }
  if (msg.kind === "load") {
    // Populate the `session` global BEFORE the user code runs. The contract
    // (contracts/script-api.d.ts) advertises this as always available inside
    // the script body; leaving it undefined made every `session.id` / `.type`
    // access throw at runtime.
    globals.session = msg.session;
    void loadAndRun(msg.source);
    return;
  }
});

async function loadAndRun(source: string): Promise<void> {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => () => Promise<unknown>;
    const userFn = new AsyncFunction(source);
    await userFn();
    post({ kind: "complete" });
  } catch (err) {
    const e = err as { message?: string; stack?: string; code?: string };
    post({
      kind: "failed",
      error: {
        message: e?.message ?? String(err),
        stack: e?.stack,
        code: e?.code
      }
    });
  }
}

// --- Globals exposed to user scripts. Each is a thin wrapper over rpc().
// Signatures mirror specs/001-scripting-support/contracts/script-api.d.ts.
// Handlers for each method are wired on the main thread in scriptRuntimeManager.ts
// (T020 / T021 / T022 for US1; prompt/confirm/alert in US5; macros.* in US4).

const globals = globalThis as unknown as Record<string, unknown>;

globals.waitFor = (pattern: unknown, opts?: unknown) => rpc("waitFor", [pattern, opts]);
globals.expect = (pattern: unknown, opts?: unknown) => rpc("expect", [pattern, opts]);
globals.waitAny = (patterns: unknown, opts?: unknown) => rpc("waitAny", [patterns, opts]);
globals.send = (text: unknown) => rpc("send", [text]);
globals.sendLine = (text: unknown) => rpc("sendLine", [text]);
globals.sendKey = (key: unknown) => rpc("sendKey", [key]);
globals.poll = (opts: unknown) => rpc("poll", [opts]);
globals.sleep = (ms: unknown) => rpc("sleep", [ms]);
globals.tail = (n?: unknown) => rpc("tail", [n]);

// Logger — each level posts both an rpc-style log event and, for main-thread telemetry,
// an explicit "log" envelope. We keep log writes resolved locally (fire-and-forget)
// so user code doesn't need to `await log.info(...)`.
function makeLogLevel(level: "info" | "warn" | "error") {
  return (...args: unknown[]) => {
    const text = args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    post({ kind: "log", level, text });
  };
}

globals.log = {
  info: makeLogLevel("info"),
  warn: makeLogLevel("warn"),
  error: makeLogLevel("error")
};

// Prompt / confirm / alert — US5 implementation; skeletons here route via rpc.
globals.prompt = (message: unknown, opts?: unknown) => rpc("prompt", [message, opts]);
globals.confirm = (message: unknown) => rpc("confirm", [message]);
globals.alert = (message: unknown) => rpc("alert", [message]);

// Macros — US4 implementation.
globals.macros = {
  allow: (name: unknown) => rpc("macros.allow", [name]),
  deny: (name: unknown) => rpc("macros.deny", [name]),
  disableAll: () => rpc("macros.disableAll", []),
  restore: () => rpc("macros.restore", [])
};

// session metadata — populated by the main thread via the "load" message
// before user code executes. See handler above.
globals.session = undefined;

// Tell the main thread we're ready to accept a `load` message.
post({ kind: "ready" });
