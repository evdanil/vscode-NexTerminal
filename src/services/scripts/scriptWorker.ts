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
import {
  DEFAULT_ASYNC_FUNCTION_LINE_OFFSET,
  ScriptModuleLoader,
  compileScriptUnit,
  evaluateScriptModule,
  humanizeStack,
  measureAsyncFunctionLineOffset
} from "./scriptModuleLoader";
import { SCRIPT_INCLUDE_ROOT_ID, type IncludeLoadResult, type WorkerInbound, type WorkerOutbound } from "./scriptTypes";

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
    try {
      post({ kind: "rpc", id, method, args });
    } catch (err) {
      // `postMessage` structured-clones `args` and throws SYNCHRONOUSLY
      // (DataCloneError) for a non-cloneable value (a Symbol, a function,
      // ...) — before any `rpc-result` was ever going to arrive. Without this
      // catch, the `pending.set(id, ...)` entry above leaks forever (nothing
      // will ever call its resolve/reject) and the caller sees a raw
      // DataCloneError instead of whichever typed error the RPC method would
      // have produced. Generic — protects every `rpc()` caller, not just
      // `nexus.fs` (which additionally sanitizes its own argument before
      // reaching here; see `sanitizeFsPath` below — this is the backstop for
      // every method that doesn't).
      pending.delete(id);
      reject(err);
    }
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
    void loadAndRun(msg.source, msg.displayName);
    return;
  }
});

/**
 * How many lines V8's AsyncFunction wrapper adds — measured once, kept here so
 * the SYNCHRONOUS log path (`log.error(err)`) can rewrite a stack without
 * awaiting. The probe is started at worker startup, long before user code can
 * throw; until it settles this holds the documented default, which is the same
 * number the probe reports on every V8 measured so far.
 */
let asyncFunctionLineOffset = DEFAULT_ASYNC_FUNCTION_LINE_OFFSET;
void measureAsyncFunctionLineOffset().then((measured) => {
  asyncFunctionLineOffset = measured;
});

async function loadAndRun(source: string, displayName: string): Promise<void> {
  try {
    // Compiled with NO parameters, exactly as in Phase 1 — see
    // `compileScriptUnit`'s doc comment for why the entry script must keep
    // shadowing `nexus`/`module`/`exports` legally. The appended sourceURL is
    // the only change on the wire, and it is what makes the entry script's own
    // frames name the file instead of `<anonymous>`.
    const userFn = compileScriptUnit(source, displayName, "entry");
    await userFn();
    post({ kind: "complete" });
  } catch (err) {
    const e = err as { message?: string; stack?: string; code?: string };
    // Awaited (rather than using the cached value) so the ONE place whose
    // numbers a user reads out of the Output Channel and the toast is never
    // measured against a stale default.
    const offset = await measureAsyncFunctionLineOffset();
    post({
      kind: "failed",
      error: {
        message: e?.message ?? String(err),
        stack: humanizeStack(e?.stack, offset),
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
    const text = args.map(renderLogArgument).join(" ");
    post({ kind: "log", level, text });
  };
}

/**
 * Render one `log.*` argument.
 *
 * An Error is special-cased because `JSON.stringify(new Error("boom"))` is
 * `"{}"` — `message` and `stack` are non-enumerable — so the overwhelmingly
 * common `catch (err) { log.error(err) }` used to write a literal `{}` into the
 * Output Channel: the one line whose whole purpose is to say what went wrong,
 * saying nothing at all. Errors now render as their (line-corrected) stack, or
 * their message when they carry no stack.
 */
function renderLogArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const stack = typeof value.stack === "string" ? humanizeStack(value.stack, asyncFunctionLineOffset) : undefined;
    return stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

// nexus.fs — read-only file access, scoped + logged on the main thread.
// readJson is deliberately worker-side JSON.parse over the readText RPC so a
// parse failure carries a stack local to the script's own execution context.
//
// The worker does NOT receive the script directory, and the `load` message
// above is unchanged: (a) resolution must live where enforcement lives — a
// worker-side resolve would make the RPC carry a pre-resolved absolute path,
// turning the main-thread check into re-validation of attacker-influencable
// input for zero gain; (b) user code shares the worker's global scope with
// the API surface and can overwrite any global — worker-held scope data is
// untrusted by construction; (c) main-thread-only resolution means one
// containment implementation, one test matrix, one audit point.
/**
 * `nexus.fs.*` accepts `path: unknown` — a script can pass a Symbol or a
 * function just as easily as a string. Those aren't structured-cloneable, so
 * posting one as an RPC arg would hit the DataCloneError guard in `rpc()`
 * above: a generic Error, no typed `InvalidPath` code, and no refusal ever
 * reaches the main-thread audit log (nothing there ever received the call).
 * Sanitize BEFORE posting:
 *  - a string passes through untouched (the overwhelmingly common case, zero
 *    overhead);
 *  - any other cloneable value (e.g. a BigInt — main-thread validation
 *    already types those as InvalidPath, see scriptFsScope.ts's
 *    `resolveScriptFsPath`) passes through too, unchanged, probed via
 *    `structuredClone` (a Node global, same algorithm `postMessage` itself
 *    uses — if THIS throws, `postMessage` would have thrown identically);
 *  - a genuinely non-cloneable value is replaced with a plain, cloneable
 *    stand-in object carrying a best-effort description. The stand-in is
 *    deliberately NOT a string — a Symbol must never masquerade as a
 *    legitimate filename — so the main thread's existing
 *    `typeof requested !== "string"` check rejects it with InvalidPath
 *    through the ordinary path: typed error AND audit line, both restored.
 */
function sanitizeFsPath(p: unknown): unknown {
  if (typeof p === "string") return p;
  try {
    structuredClone(p);
    return p;
  } catch {
    return { __nonCloneable: describeNonCloneable(p) };
  }
}

function describeNonCloneable(p: unknown): string {
  try {
    return String(p);
  } catch {
    // A hostile custom toString()/valueOf()/[Symbol.toPrimitive] can throw.
    try {
      return Object.prototype.toString.call(p);
    } catch {
      // ...and so can THIS, for a Proxy whose `get` trap throws — reading
      // Symbol.toStringTag goes through the trap. The description chain must
      // never throw (a throw here escapes as the trap's error instead of the
      // typed InvalidPath), so the last resort is a constant.
      return "[unrepresentable value]";
    }
  }
}

/**
 * The module table for this run. Main decides WHICH file a specifier means;
 * this only remembers what main already decided, so one module is evaluated
 * once however many files include it.
 */
const moduleLoader = new ScriptModuleLoader({
  load: (specifier, chain) => rpc<IncludeLoadResult>("include.load", [sanitizeFsPath(specifier), chain]),
  evaluate: (source, displayName, chain) => evaluateScriptModule(source, displayName, makeNexusFacade(chain))
});

/**
 * The `nexus` object one compiled unit sees. Every unit gets its OWN, bound to
 * the chain that reaches it — which is the entire mechanism behind "a relative
 * path always resolves against the file it is written in":
 *
 *  - for an included module the facade arrives as a PARAMETER, so it is
 *    lexically scoped to that file and still correct inside a callback that
 *    runs long after the body finished (a dynamic "current module" stack would
 *    be wrong for exactly that case, and every async module is that case);
 *  - for the entry script it is installed on the global, because the entry
 *    script must keep compiling with no parameters (see `compileScriptUnit`).
 *
 * A ROOT-level `nexus.fs` call is byte-identical on the wire to Phase 1's — no
 * module-id argument at all — so every existing main-thread path and every
 * existing test exercises the unchanged code.
 */
function makeNexusFacade(chain: string[]): unknown {
  const owner = chain.length > 0 ? chain[chain.length - 1] : SCRIPT_INCLUDE_ROOT_ID;
  const fsArgs = (p: unknown): unknown[] =>
    owner === SCRIPT_INCLUDE_ROOT_ID ? [sanitizeFsPath(p)] : [sanitizeFsPath(p), owner];
  return {
    fs: {
      readText: (p: unknown) => rpc<string>("fs.readText", fsArgs(p)),
      readJson: async (p: unknown) => {
        const text = await rpc<string>("fs.readText", fsArgs(p));
        try {
          return JSON.parse(text) as unknown;
        } catch (err) {
          const e = new SyntaxError(
            `nexus.fs.readJson(${JSON.stringify(String(p))}): ${(err as Error).message}`
          );
          Object.assign(e, { code: "InvalidJson" });
          throw e;
        }
      },
      exists: (p: unknown) => rpc<boolean>("fs.exists", fsArgs(p))
    },
    include: (p: unknown) => moduleLoader.include(chain, sanitizeFsPath(p))
  };
}

globals.nexus = makeNexusFacade([SCRIPT_INCLUDE_ROOT_ID]);

// Tell the main thread we're ready to accept a `load` message.
post({ kind: "ready" });
