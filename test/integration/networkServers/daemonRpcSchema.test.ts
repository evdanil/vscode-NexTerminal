/**
 * Real-process contract tests for the extension-host side of the daemon RPC
 * boundary. The fixture deliberately sends malformed stdout after readiness;
 * assertions cover the user-observable bridge behaviour, not private guards.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { NetworkServerDaemonHost } from "../../../src/services/networkServers/daemonHost";
import { sleep } from "../../helpers/networkServerTestHelpers";

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures");
const FIXTURE = path.join(FIXTURES, "mockNetworkServerDaemonMalformed.js");
const MAX_DAEMON_RPC_IN_FLIGHT = 16;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return false;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error("timed out waiting for expected host state");
}

function childPid(host: NetworkServerDaemonHost): number | undefined {
  return (host as unknown as { child?: { pid?: number } }).child?.pid;
}

type HostInternals = {
  child?: {
    readonly pid?: number;
    readonly stdin?: NodeJS.WritableStream;
    readonly stdout?: NodeJS.ReadableStream;
    readonly stderr?: NodeJS.ReadableStream;
    emit(event: string | symbol, ...args: unknown[]): boolean;
  };
  activeGeneration?: number;
  pending?: Map<number, unknown>;
  handleMessage(child: HostInternals["child"] & object, generation: number, raw: string): void;
};

function blockHostEventLoop(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    // The busy loop deliberately prevents queued child-process callbacks from
    // running until after the conservative stdout-EOF deadline has elapsed.
  }
}

describe("NetworkServerDaemonHost — closed daemon stdout contract", () => {
  const hosts: NetworkServerDaemonHost[] = [];
  const pids = new Set<number>();

  afterEach(async () => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const pid of pids) {
      if (isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
      }
      await waitForExit(pid);
    }
    pids.clear();
    delete process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE;
  });

  function create(mode: string): NetworkServerDaemonHost {
    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = mode;
    const host = new NetworkServerDaemonHost(FIXTURE, { rpcTimeoutMs: 2_000, readyTimeoutMs: 1_000 });
    hosts.push(host);
    return host;
  }

  async function expectProtocolFailureThenCleanRestart(
    mode: string,
    request: (host: NetworkServerDaemonHost) => Promise<unknown> = (host) => host.listServers(),
    observe?: (host: NetworkServerDaemonHost) => void,
  ): Promise<void> {
    const host = create(mode);
    const statusEvents: unknown[] = [];
    const connections: unknown[] = [];
    host.onDidChangeStatus((event) => statusEvents.push(event));
    host.onDidConnection((_id, event) => connections.push(event));

    await host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid, `${mode} fixture should have a child pid`).toBeTypeOf("number");
    pids.add(failedPid!);
    observe?.(host);

    await expect(request(host)).rejects.toThrow(/Daemon protocol error/);
    expect(host.isReady, `${mode} must not leave its generation ready`).toBe(false);
    expect(statusEvents, `${mode} must not reach a status listener`).toEqual([]);
    expect(connections, `${mode} must not reach a connection listener`).toEqual([]);
    expect(await waitForExit(failedPid!), `${mode} child must be reaped`).toBe(true);

    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const cleanPid = childPid(host);
    expect(cleanPid).toBeTypeOf("number");
    expect(cleanPid).not.toBe(failedPid);
    pids.add(cleanPid!);
    await expect(host.listServers()).resolves.toHaveLength(2);
  }

  it.each([
    "invalid-json",
    "oversized-stdout",
    "null-status-event",
    "invalid-connection",
    "unknown-event",
    "result-and-error",
    "wrong-result",
    "stdout-eof",
  ])("rejects current-child %s without delivering its valid-looking follow-up", async (mode) => {
    await expectProtocolFailureThenCleanRestart(mode);
  }, 30_000);

  it.each([
    ["wrong-get-status", (host: NetworkServerDaemonHost) => host.getStatus("tftp")],
    ["wrong-runtime", (host: NetworkServerDaemonHost) => host.getServiceRuntime("dhcp")],
    ["wrong-lifecycle", (host: NetworkServerDaemonHost) => host.startServer("tftp")],
    ["wrong-cancel", (host: NetworkServerDaemonHost) => host.cancelTransfer("tftp", "127.0.0.1:1069")],
    ["wrong-configure", (host: NetworkServerDaemonHost) => host.configure({ tftp: { port: 69 } })],
    ["wrong-list", (host: NetworkServerDaemonHost) => host.listServers()],
  ] as const)("rejects a valid-looking %s response correlated to a different request", async (mode, request) => {
    await expectProtocolFailureThenCleanRestart(mode, request);
  }, 30_000);

  it("rejects malformed ready without setting ready and allows a clean generation", async () => {
    const host = create("malformed-ready");
    const readyAttempt = host.ensureStarted();
    await sleep(25);
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);

    await expect(readyAttempt).rejects.toThrow(/Daemon protocol error/);
    expect(host.isReady).toBe(false);
    expect(await waitForExit(failedPid!)).toBe(true);

    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const cleanPid = childPid(host);
    expect(cleanPid).toBeTypeOf("number");
    expect(cleanPid).not.toBe(failedPid);
    pids.add(cleanPid!);
    await expect(host.listServers()).resolves.toHaveLength(2);
  }, 30_000);

  it("logs and ignores well-formed duplicate and unknown response ids", async () => {
    const host = create("duplicate-unknown");
    const logs: Array<{ id: string; level: string; message: string }> = [];
    host.onDidLog((id, level, message) => logs.push({ id, level, message }));

    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    await expect(host.listServers()).resolves.toHaveLength(2);
    await sleep(50);

    expect(host.isReady).toBe(true);
    expect(isAlive(pid!)).toBe(true);
    expect(logs.filter((entry) => /unknown request id/i.test(entry.message))).toHaveLength(2);
    await expect(host.listServers()).resolves.toHaveLength(2);
  }, 30_000);

  it("isolates throwing user listeners so later listeners and the healthy child continue", async () => {
    const host = create("clean");
    const internals = host as unknown as HostInternals;
    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    const child = internals.child!;
    const generation = internals.activeGeneration!;
    const delivered: string[] = [];

    host.onDidChangeStatus(() => { throw new Error("status listener exploded"); });
    host.onDidChangeStatus(() => delivered.push("status"));
    host.onDidUpdateRuntime(() => { throw new Error("runtime listener exploded"); });
    host.onDidUpdateRuntime(() => delivered.push("runtime"));
    host.onDidConnection(() => { throw new Error("connection listener exploded"); });
    host.onDidConnection(() => delivered.push("connection"));
    host.onDidLog(() => { throw new Error("log listener exploded"); });
    host.onDidLog(() => delivered.push("log"));

    expect(() => internals.handleMessage(child, generation, JSON.stringify({
      event: "statusChange", data: { id: "tftp", status: "running" },
    }))).not.toThrow();
    expect(() => internals.handleMessage(child, generation, JSON.stringify({
      event: "runtimeUpdate", data: { id: "tftp" },
    }))).not.toThrow();
    expect(() => internals.handleMessage(child, generation, JSON.stringify({
      event: "connection", data: { id: "tftp", connection: { phase: "started", summary: "started" } },
    }))).not.toThrow();
    expect(() => internals.handleMessage(child, generation, JSON.stringify({
      event: "log", data: { id: "daemon", level: "info", message: "still healthy" },
    }))).not.toThrow();

    expect(delivered).toEqual(["status", "runtime", "connection", "log"]);
    expect(host.isReady).toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);
  }, 30_000);

  it("owns a ready child stdin terminal failure, rejects it once, and restarts cleanly", async () => {
    const host = create("stdin-terminal");
    await host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);
    const pending = host.listServers();
    const stdin = (host as unknown as { child?: { stdin?: NodeJS.WritableStream } }).child?.stdin;
    expect(stdin).toBeDefined();
    stdin!.emit("error", new Error("forced ready-pipe failure"));

    await expect(pending).rejects.toThrow(/daemon stdin|transport error/i);
    await expect(waitFor(() => host.isReady ? undefined : true, 3_000)).resolves.toBe(true);
    expect(await waitForExit(failedPid!)).toBe(true);

    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const cleanPid = childPid(host);
    expect(cleanPid).toBeTypeOf("number");
    expect(cleanPid).not.toBe(failedPid);
    pids.add(cleanPid!);
    await expect(host.listServers()).resolves.toHaveLength(2);
  }, 30_000);

  it("owns an idle ready-pipe error before a request can use the stale generation", async () => {
    const host = create("clean");
    await host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);
    const stdin = (host as unknown as { child?: { stdin?: NodeJS.WritableStream } }).child?.stdin;
    expect(stdin).toBeDefined();
    stdin!.emit("error", new Error("forced idle ready-pipe failure"));

    await expect(waitFor(() => host.isReady ? undefined : true, 3_000)).resolves.toBe(true);
    expect(await waitForExit(failedPid!)).toBe(true);
    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const cleanPid = childPid(host);
    expect(cleanPid).toBeTypeOf("number");
    expect(cleanPid).not.toBe(failedPid);
    pids.add(cleanPid!);
  }, 30_000);

  it.each([
    ["synchronous throw", (stdin: NodeJS.WritableStream) => {
      const original = stdin.write.bind(stdin);
      (stdin as unknown as { write: typeof stdin.write }).write = (() => {
        throw new Error("forced synchronous write failure");
      }) as typeof stdin.write;
      return () => { (stdin as unknown as { write: typeof stdin.write }).write = original; };
    }],
    ["write callback error", (stdin: NodeJS.WritableStream) => {
      const original = stdin.write.bind(stdin);
      (stdin as unknown as { write: typeof stdin.write }).write = ((_chunk, callback) => {
        queueMicrotask(() => callback?.(new Error("forced write callback failure")));
        return true;
      }) as typeof stdin.write;
      return () => { (stdin as unknown as { write: typeof stdin.write }).write = original; };
    }],
  ] as const)("owns a daemon stdin %s across every pending request", async (_name, replaceWrite) => {
    const host = create("stdin-terminal");
    await host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);
    const stdin = (host as unknown as { child?: { stdin?: NodeJS.WritableStream } }).child?.stdin;
    expect(stdin).toBeDefined();
    const restore = replaceWrite(stdin!);
    try {
      await expect(host.listServers()).rejects.toThrow(/transport error/i);
      await expect(waitFor(() => host.isReady ? undefined : true, 3_000)).resolves.toBe(true);
      expect(await waitForExit(failedPid!)).toBe(true);
    } finally {
      restore();
    }
  }, 30_000);

  it("rolls request ids at the safe-integer boundary without corrupting the child protocol", async () => {
    const host = create("clean");
    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    (host as unknown as { nextId: number }).nextId = Number.MAX_SAFE_INTEGER;

    await expect(host.listServers()).resolves.toHaveLength(2);
    await expect(host.listServers()).resolves.toHaveLength(2);
    expect(host.isReady).toBe(true);
  }, 30_000);

  it("skips still-pending ids when a rollover allocation wraps", async () => {
    const host = create("hold-first-list");
    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    const internals = host as unknown as { nextId: number };
    internals.nextId = 1;
    const held = host.listServers().catch((error: unknown) => error);
    internals.nextId = Number.MAX_SAFE_INTEGER;

    await expect(host.listServers()).resolves.toHaveLength(2);
    await expect(host.listServers()).resolves.toHaveLength(2);
    expect(host.isReady).toBe(true);
    host.dispose();
    await expect(held).resolves.toBeInstanceOf(Error);
  }, 30_000);

  it("rejects host overload before allocating or writing beyond the pending admission limit", async () => {
    const host = create("hold-all-list");
    const internals = host as unknown as HostInternals & { nextId: number };
    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);

    const accepted = Array.from(
      { length: MAX_DAEMON_RPC_IN_FLIGHT },
      () => host.listServers().then(() => undefined, (error: unknown) => error),
    );
    try {
      await expect(waitFor(() => internals.pending?.size === MAX_DAEMON_RPC_IN_FLIGHT ? true : undefined)).resolves.toBe(true);
      const nextIdBeforeOverload = internals.nextId;

      expect(internals.child?.stdin?.listenerCount("error")).toBe(1);

      const overload = await host.listServers().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(overload).toMatchObject({ name: "SERVER_BUSY" });
      expect(internals.pending?.size).toBe(MAX_DAEMON_RPC_IN_FLIGHT);
      expect(internals.nextId).toBe(nextIdBeforeOverload);
    } finally {
      host.dispose();
      await Promise.all(accepted);
    }
  }, 30_000);

  it("ignores a delayed stdout callback from the reaped generation after a clean restart", async () => {
    const host = create("invalid-json");
    const internals = host as unknown as HostInternals;
    await host.ensureStarted();
    const staleChild = internals.child;
    const staleGeneration = internals.activeGeneration;
    const stalePid = childPid(host);
    expect(staleChild).toBeDefined();
    expect(staleGeneration).toBeTypeOf("number");
    expect(stalePid).toBeTypeOf("number");
    pids.add(stalePid!);

    await expect(host.listServers()).rejects.toThrow(/Daemon protocol error/);
    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const cleanPid = childPid(host);
    expect(cleanPid).toBeTypeOf("number");
    expect(cleanPid).not.toBe(stalePid);
    pids.add(cleanPid!);

    const statusEvents: unknown[] = [];
    host.onDidChangeStatus((event) => statusEvents.push(event));
    internals.handleMessage(staleChild!, staleGeneration!, JSON.stringify({
      event: "statusChange",
      data: { id: "tftp", status: "running" },
    }));

    expect(statusEvents).toEqual([]);
    await expect(host.listServers()).resolves.toHaveLength(2);
  }, 30_000);

  it("reports a child that exits normally instead of misclassifying its stdout EOF as protocol corruption", async () => {
    const host = create("exit-cleanly");
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    host.onDidExit(() => { throw new Error("exit listener exploded"); });
    host.onDidExit((code, signal) => { exited = { code, signal }; });

    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    await expect(waitFor(() => exited)).resolves.toEqual({ code: 0, signal: null });
    expect(host.isReady).toBe(false);
    expect(await waitForExit(pid!)).toBe(true);
  }, 30_000);

  it("gives a queued clean exit a poll/check turn after a stalled stdout-EOF deadline", async () => {
    const host = create("stdout-eof-delayed-exit");
    const protocolFailure = vi.spyOn(host as unknown as {
      failChildProtocol(child: object, generation: number, reason: string): void;
    }, "failChildProtocol");
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    host.onDidExit((code, signal) => { exited = { code, signal }; });

    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);

    // The fixture closes stdout at 20 ms and exits 125 ms later. Let the
    // host observe EOF and arm its conservative deadline, then hold the host
    // loop past that deadline while the child exits externally. Before the
    // fix, the expired timer runs before the queued child exit callback and
    // falsely tears this generation down as a protocol failure.
    await sleep(60);
    blockHostEventLoop(1_100);

    await expect(waitFor(() => exited)).resolves.toEqual({ code: 0, signal: null });
    expect(protocolFailure).not.toHaveBeenCalled();
    expect((host as unknown as { stdoutEofTimers: Map<object, unknown> }).stdoutEofTimers.size).toBe(0);
    expect(await waitForExit(pid!)).toBe(true);
  }, 30_000);

  it("keeps each exited child's terminal stdio guards through close without touching a replacement", async () => {
    const host = create("clean");
    const internals = host as unknown as HostInternals;
    await host.ensureStarted();
    const stale = internals.child!;
    const stalePid = stale.pid;
    const initialStdoutEndListeners = stale.stdout?.listenerCount("end") ?? 0;
    expect(stalePid).toBeTypeOf("number");
    pids.add(stalePid!);
    expect(stale.stdout?.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(stale.stderr?.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(stale.stdin?.listenerCount("error")).toBeGreaterThanOrEqual(1);

    // Model Node's real exit-before-close ordering: protocol/data listeners
    // detach at exit, but terminal stream errors are still legal until close.
    stale.emit("exit", 0, null);
    expect(stale.stdout?.listenerCount("data")).toBe(0);
    expect(stale.stdout?.listenerCount("end")).toBeLessThan(initialStdoutEndListeners);
    expect(stale.stdout?.listenerCount("error")).toBe(1);
    expect(stale.stderr?.listenerCount("error")).toBe(1);
    expect(stale.stdin?.listenerCount("error")).toBe(1);

    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const replacementPid = childPid(host);
    expect(replacementPid).toBeTypeOf("number");
    expect(replacementPid).not.toBe(stalePid);
    pids.add(replacementPid!);

    expect(() => {
      stale.stdout!.emit("error", new Error("late stdout EPIPE"));
      stale.stderr!.emit("error", new Error("late stderr EPIPE"));
      stale.stdin!.emit("error", new Error("late stdin EPIPE"));
    }).not.toThrow();
    expect(host.isReady).toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);

    stale.emit("close", 0, null);
    expect(stale.stdout?.listenerCount("error")).toBe(0);
    expect(stale.stderr?.listenerCount("error")).toBe(0);
    expect(stale.stdin?.listenerCount("error")).toBe(0);
  }, 30_000);

  it("consumes a buffered-write EPIPE after termination until the exact child closes", async () => {
    const host = create("late-stdio");
    const internals = host as unknown as HostInternals;
    await host.ensureStarted();
    const child = internals.child!;
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);

    const pending = host.listServers();
    await expect(waitFor(() => internals.pending?.size === 1 ? true : undefined)).resolves.toBe(true);
    host.dispose();
    await expect(pending).rejects.toThrow(/disposed/i);

    expect(child.stdout?.listenerCount("error")).toBe(1);
    expect(child.stderr?.listenerCount("error")).toBe(1);
    expect(child.stdin?.listenerCount("error")).toBe(1);
    expect(() => {
      child.stdout!.emit("error", new Error("late stdout EPIPE"));
      child.stderr!.emit("error", new Error("late stderr EPIPE"));
      child.stdin!.emit("error", new Error("late buffered-write EPIPE"));
    }).not.toThrow();

    child.emit("close", null, "SIGTERM");
    expect(child.stdout?.listenerCount("error")).toBe(0);
    expect(child.stderr?.listenerCount("error")).toBe(0);
    expect(child.stdin?.listenerCount("error")).toBe(0);
  }, 30_000);
});
