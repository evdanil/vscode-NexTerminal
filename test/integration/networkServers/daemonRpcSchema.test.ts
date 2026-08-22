/**
 * Real-process contract tests for the extension-host side of the daemon RPC
 * boundary. The fixture deliberately sends malformed stdout after readiness;
 * assertions cover the user-observable bridge behaviour, not private guards.
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { NetworkServerDaemonHost } from "../../../src/services/networkServers/daemonHost";
import { sleep } from "../../helpers/networkServerTestHelpers";

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures");
const FIXTURE = path.join(FIXTURES, "mockNetworkServerDaemonMalformed.js");

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
  child?: object;
  activeGeneration?: number;
  handleMessage(child: object, generation: number, raw: string): void;
};

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

  it("coordinates a delayed normal exit after stdout EOF without a fragile grace race", async () => {
    const host = create("stdout-eof-delayed-exit");
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    host.onDidExit((code, signal) => { exited = { code, signal }; });

    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    await expect(waitFor(() => exited)).resolves.toEqual({ code: 0, signal: null });
    expect(await waitForExit(pid!)).toBe(true);
  }, 30_000);
});
