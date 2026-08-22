/**
 * Real-process contract tests for the extension-host side of the daemon RPC
 * boundary. The fixture deliberately sends malformed stdout after readiness;
 * assertions cover the user-observable bridge behaviour, not private guards.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { NetworkServerDaemonHost } from "../../../src/services/networkServers/daemonHost";
import { MAX_DAEMON_RPC_IN_FLIGHT } from "../../../src/services/networkServers/networkServerRpcProtocol";
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
  child?: {
    readonly pid?: number;
    readonly stdin?: NodeJS.WritableStream;
    readonly stdout?: NodeJS.ReadableStream;
    readonly stderr?: NodeJS.ReadableStream;
    emit(event: string | symbol, ...args: unknown[]): boolean;
  };
  activeGeneration?: number;
  pending?: Map<number, unknown>;
  admissions?: Set<unknown>;
  handleMessage(child: HostInternals["child"] & object, generation: number, raw: string): void;
};

type HostOwnershipInternals = HostInternals & {
  readyWaiters?: Set<unknown>;
  childWrites?: Map<unknown, unknown>;
  childIo?: Map<unknown, unknown>;
  killTimers?: Map<unknown, unknown>;
  stdoutEofTimers?: Map<unknown, unknown>;
  startAttempt?: unknown;
  nextGeneration?: number;
};

type WritableWithCallback = NodeJS.WritableStream & {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
};

function retainFalseWrites(child: NonNullable<HostInternals["child"]>): {
  readonly retained: Set<(error?: Error | null) => void>;
  readonly restore: () => void;
} {
  const stdin = child.stdin as WritableWithCallback | undefined;
  if (!stdin) throw new Error("expected mock daemon stdin");
  const original = stdin.write.bind(stdin);
  const retained = new Set<(error?: Error | null) => void>();
  stdin.write = ((_: string, callback?: (error?: Error | null) => void): boolean => {
    if (callback) retained.add(callback);
    return false;
  }) as typeof stdin.write;

  // The real writable stream drops its retained callbacks when the exact
  // child reaches close. Model that ownership in the test harness so a second
  // child generation cannot inherit the first generation's held frames.
  (child as unknown as { once(event: string, listener: () => void): void }).once("close", () => retained.clear());
  return {
    retained,
    restore: () => { stdin.write = original as typeof stdin.write; },
  };
}

function blockHostEventLoop(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    // The busy loop deliberately prevents queued child-process callbacks from
    // running until after the conservative stdout-EOF deadline has elapsed.
  }
}

function allDaemonOwnershipIsReleased(internals: HostOwnershipInternals): boolean {
  return [
    internals.pending,
    internals.admissions,
    internals.readyWaiters,
    internals.childWrites,
    internals.childIo,
    internals.killTimers,
    internals.stdoutEofTimers,
  ].every((ownership) => ownership?.size === 0) && internals.startAttempt === undefined;
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
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    host.onDidExit(() => { throw new Error("exit listener exploded"); });
    host.onDidExit((code, signal) => exits.push({ code, signal }));
    await host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);
    const stdin = (host as unknown as { child?: { stdin?: NodeJS.WritableStream } }).child?.stdin;
    expect(stdin).toBeDefined();
    stdin!.emit("error", new Error("forced idle ready-pipe failure"));

    await expect(waitFor(() => exits[0], 500)).resolves.toEqual({ code: null, signal: null });
    await expect(waitFor(() => host.isReady ? undefined : true, 3_000)).resolves.toBe(true);
    expect(await waitForExit(failedPid!)).toBe(true);
    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const cleanPid = childPid(host);
    expect(cleanPid).toBeTypeOf("number");
    expect(cleanPid).not.toBe(failedPid);
    pids.add(cleanPid!);
    await expect(host.listServers()).resolves.toHaveLength(2);
    await sleep(50);
    expect(exits).toEqual([{ code: null, signal: null }]);
  }, 30_000);

  it("emits one isolated unknown lifecycle exit for a ready protocol failure and preserves a replacement", async () => {
    const host = create("invalid-json");
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null; ready: boolean }> = [];
    host.onDidExit(() => { throw new Error("exit listener exploded"); });
    host.onDidExit((code, signal) => exits.push({ code, signal, ready: host.isReady }));

    await host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);
    await expect(host.listServers()).rejects.toThrow(/Daemon protocol error/);

    await expect(waitFor(() => exits[0], 500)).resolves.toEqual({ code: null, signal: null, ready: false });
    expect(await waitForExit(failedPid!)).toBe(true);

    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const replacementPid = childPid(host);
    expect(replacementPid).toBeTypeOf("number");
    expect(replacementPid).not.toBe(failedPid);
    pids.add(replacementPid!);
    await expect(host.listServers()).resolves.toHaveLength(2);
    await sleep(50);
    expect(exits).toEqual([{ code: null, signal: null, ready: false }]);
  }, 30_000);

  async function expectReentrantSyntheticExitReplacement(
    reenter: (host: NetworkServerDaemonHost) => Promise<unknown>,
    assertReentrantResult: (result: unknown) => void,
  ): Promise<void> {
    const host = create("invalid-json");
    const internals = host as unknown as HostOwnershipInternals;
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    let reentrant: Promise<unknown> | undefined;
    let replacementPid: number | undefined;

    host.onDidExit((code, signal) => {
      exits.push({ code, signal });
      process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
      reentrant = reenter(host);
      // Keep a rejection observed during RED from becoming an unhandled
      // promise, while retaining the original promise for the assertion.
      void reentrant.catch(() => undefined);
      replacementPid = childPid(host);
      if (replacementPid !== undefined) pids.add(replacementPid);
    });

    await host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);

    await expect(host.listServers()).rejects.toThrow(/Daemon protocol error/);
    expect(reentrant).toBeDefined();
    expect(replacementPid).toBeTypeOf("number");
    expect(replacementPid).not.toBe(failedPid);

    if (!reentrant || replacementPid === undefined) {
      throw new Error("synthetic exit listener did not start a replacement generation");
    }
    assertReentrantResult(await reentrant);
    await expect(waitFor(() => host.isReady ? true : undefined)).resolves.toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);

    // The old process closes after the reentrant replacement begins. Its
    // physical lifecycle callbacks must stay isolated from the new generation.
    expect(await waitForExit(failedPid!)).toBe(true);
    expect(host.isReady).toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);
    expect(exits).toEqual([{ code: null, signal: null }]);

    host.dispose();
    expect(await waitForExit(replacementPid)).toBe(true);
    await expect(waitFor(() => allDaemonOwnershipIsReleased(internals) ? true : undefined)).resolves.toBe(true);
  }

  it("settles a failed generation before a synthetic exit listener immediately ensures a replacement", async () => {
    await expectReentrantSyntheticExitReplacement(
      (host) => host.ensureStarted(),
      (result) => expect(result).toBeUndefined(),
    );
  }, 30_000);

  it("settles a failed generation before a synthetic exit listener immediately lists from a replacement", async () => {
    await expectReentrantSyntheticExitReplacement(
      (host) => host.listServers(),
      (result) => expect(result).toHaveLength(2),
    );
  }, 30_000);

  it("rejects a startup attempt when one bounded-reader chunk retires its generation after ready", async () => {
    const host = create("ready-then-invalid-same-chunk");
    const internals = host as unknown as HostOwnershipInternals;
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    host.onDidExit((code, signal) => exits.push({ code, signal }));

    const startup = host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);

    await expect(startup).rejects.toThrow(/startup.*retired/i);
    expect(host.isReady).toBe(false);
    expect(exits).toEqual([{ code: null, signal: null }]);
    expect(await waitForExit(failedPid!)).toBe(true);
    host.dispose();
    await expect(waitFor(() => allDaemonOwnershipIsReleased(internals) ? true : undefined)).resolves.toBe(true);
  }, 30_000);

  async function expectSameChunkStartupReplacement(
    reenter: (host: NetworkServerDaemonHost) => Promise<unknown>,
    assertReentrantResult: (result: unknown) => void,
  ): Promise<void> {
    const host = create("ready-then-invalid-same-chunk");
    const internals = host as unknown as HostOwnershipInternals;
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    let reentrant: Promise<unknown> | undefined;
    let replacementPid: number | undefined;
    let startAttemptAtExit: unknown = Symbol("unobserved startup attempt");

    host.onDidExit((code, signal) => {
      exits.push({ code, signal });
      startAttemptAtExit = internals.startAttempt;
      process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
      reentrant = reenter(host);
      void reentrant.catch(() => undefined);
      replacementPid = childPid(host);
      if (replacementPid !== undefined) pids.add(replacementPid);
    });

    const startup = host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);

    await expect(startup).rejects.toThrow(/startup.*retired/i);
    expect(reentrant).toBeDefined();
    expect(startAttemptAtExit).toBeUndefined();
    expect(replacementPid).toBeTypeOf("number");
    expect(replacementPid).not.toBe(failedPid);
    if (!reentrant || replacementPid === undefined) {
      throw new Error("synthetic exit listener did not start a replacement startup attempt");
    }

    assertReentrantResult(await reentrant);
    expect(host.isReady).toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);
    expect(await waitForExit(failedPid!)).toBe(true);
    expect(host.isReady).toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);
    expect(exits).toEqual([{ code: null, signal: null }]);

    host.dispose();
    expect(await waitForExit(replacementPid)).toBe(true);
    await expect(waitFor(() => allDaemonOwnershipIsReleased(internals) ? true : undefined)).resolves.toBe(true);
  }

  it("starts a ready replacement when a same-chunk synthetic exit listener immediately ensures", async () => {
    await expectSameChunkStartupReplacement(
      (host) => host.ensureStarted(),
      (result) => expect(result).toBeUndefined(),
    );
  }, 30_000);

  it("serves from a ready replacement when a same-chunk synthetic exit listener immediately lists", async () => {
    await expectSameChunkStartupReplacement(
      (host) => host.listServers(),
      (result) => expect(result).toHaveLength(2),
    );
  }, 30_000);

  it("invalidates a current physical startup exit before its lifecycle listener reenters", async () => {
    const host = create("exit-before-ready");
    const internals = host as unknown as HostOwnershipInternals;
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    let reentrant: Promise<void> | undefined;
    let replacementPid: number | undefined;
    let startAttemptAtExit: unknown = Symbol("unobserved startup attempt");
    host.onDidExit((code, signal) => {
      exits.push({ code, signal });
      startAttemptAtExit = internals.startAttempt;
      process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
      reentrant = host.ensureStarted();
      void reentrant.catch(() => undefined);
      replacementPid = childPid(host);
      if (replacementPid !== undefined) pids.add(replacementPid);
    });

    const startup = host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);

    await expect(startup).rejects.toThrow(/daemon exited/i);
    expect(reentrant).toBeDefined();
    expect(startAttemptAtExit).toBeUndefined();
    expect(replacementPid).toBeTypeOf("number");
    expect(replacementPid).not.toBe(failedPid);
    if (!reentrant || replacementPid === undefined) {
      throw new Error("physical exit listener did not start a replacement startup attempt");
    }
    await expect(reentrant).resolves.toBeUndefined();
    expect(await waitForExit(failedPid!)).toBe(true);
    expect(host.isReady).toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);
    expect(exits).toEqual([{ code: 0, signal: null }]);

    host.dispose();
    expect(await waitForExit(replacementPid)).toBe(true);
    await expect(waitFor(() => allDaemonOwnershipIsReleased(internals) ? true : undefined)).resolves.toBe(true);
  }, 30_000);

  it("coalesces concurrent callers onto one current startup attempt", async () => {
    const host = create("delayed-ready-hold-all");
    const internals = host as unknown as HostOwnershipInternals;
    const first = host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    const second = host.ensureStarted();

    expect(internals.nextGeneration).toBe(2);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(childPid(host)).toBe(pid);
    expect(host.isReady).toBe(true);

    host.dispose();
    expect(await waitForExit(pid!)).toBe(true);
    await expect(waitFor(() => allDaemonOwnershipIsReleased(internals) ? true : undefined)).resolves.toBe(true);
  }, 30_000);

  it("keeps a replacement startup attempt cached when an old attempt finalizes", async () => {
    const host = create("ready-then-invalid-same-chunk");
    const internals = host as unknown as HostOwnershipInternals;
    let reentrant: Promise<void> | undefined;
    let replacementPid: number | undefined;
    host.onDidExit(() => {
      process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "delayed-ready-hold-all";
      reentrant = host.ensureStarted();
      void reentrant.catch(() => undefined);
      replacementPid = childPid(host);
      if (replacementPid !== undefined) pids.add(replacementPid);
    });

    const startup = host.ensureStarted();
    const failedPid = childPid(host);
    expect(failedPid).toBeTypeOf("number");
    pids.add(failedPid!);

    try {
      await expect(startup).rejects.toThrow(/startup.*retired/i);
      expect(reentrant).toBeDefined();
      expect(replacementPid).toBeTypeOf("number");
      expect(host.isReady).toBe(false);
      if (!reentrant || replacementPid === undefined) {
        throw new Error("synthetic exit listener did not start a delayed replacement startup attempt");
      }

      const follower = host.ensureStarted();
      void follower.catch(() => undefined);
      const followerPid = childPid(host);
      if (followerPid !== undefined) pids.add(followerPid);
      expect(followerPid).toBe(replacementPid);
      expect(internals.nextGeneration).toBe(3);
      await expect(Promise.all([reentrant, follower])).resolves.toEqual([undefined, undefined]);
      expect(host.isReady).toBe(true);
    } finally {
      const currentPid = childPid(host);
      if (currentPid !== undefined) pids.add(currentPid);
      host.dispose();
    }

    expect(await waitForExit(failedPid!)).toBe(true);
    expect(await waitForExit(replacementPid!)).toBe(true);
    await expect(waitFor(() => allDaemonOwnershipIsReleased(internals) ? true : undefined)).resolves.toBe(true);
  }, 30_000);

  it("does not let a late physical exit from a retired generation reset a ready replacement", async () => {
    const host = create("late-stdio");
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    host.onDidExit((code, signal) => exits.push({ code, signal }));
    await host.ensureStarted();
    const stalePid = childPid(host);
    expect(stalePid).toBeTypeOf("number");
    pids.add(stalePid!);
    const stdin = (host as unknown as { child?: { stdin?: NodeJS.WritableStream } }).child?.stdin;
    expect(stdin).toBeDefined();

    stdin!.emit("error", new Error("retire this generation"));
    await expect(waitFor(() => exits[0], 500)).resolves.toEqual({ code: null, signal: null });

    process.env.NEXUS_MOCK_NETWORK_DAEMON_MODE = "clean";
    await host.ensureStarted();
    const replacementPid = childPid(host);
    expect(replacementPid).toBeTypeOf("number");
    expect(replacementPid).not.toBe(stalePid);
    pids.add(replacementPid!);
    await expect(host.listServers()).resolves.toHaveLength(2);

    await expect(waitForExit(stalePid!, 5_000)).resolves.toBe(true);
    expect(host.isReady).toBe(true);
    await expect(host.listServers()).resolves.toHaveLength(2);
    expect(exits).toEqual([{ code: null, signal: null }]);
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

  it("acquires the finite host admission before a cold-start flood waits for readiness", async () => {
    const host = create("delayed-ready-hold-all");
    const internals = host as unknown as HostInternals;
    const calls = Array.from({ length: 1_000 }, () => host.listServers());
    for (const call of calls.slice(0, MAX_DAEMON_RPC_IN_FLIGHT)) void call.catch(() => undefined);
    const rejected = await Promise.race([
      Promise.all(calls.slice(MAX_DAEMON_RPC_IN_FLIGHT).map(async (call) => {
        const error = await call.then(
          () => undefined,
          (reason: unknown) => reason,
        );
        return error instanceof Error ? error.name : undefined;
      })),
      sleep(250).then(() => undefined),
    ]);

    expect(rejected).toHaveLength(1_000 - MAX_DAEMON_RPC_IN_FLIGHT);
    expect(rejected).toEqual(Array.from(
      { length: 1_000 - MAX_DAEMON_RPC_IN_FLIGHT },
      () => "SERVER_BUSY",
    ));
    expect(internals.admissions?.size).toBe(MAX_DAEMON_RPC_IN_FLIGHT);

    host.dispose();
    await Promise.all(calls.map((call) => call.catch(() => undefined)));
  }, 30_000);

  it("reaps timed-out false-return writes before another generation can retain another admission batch", async () => {
    const host = create("clean");
    const internals = host as unknown as HostInternals;
    const retainedByGeneration: Array<Set<(error?: Error | null) => void>> = [];

    for (let generation = 0; generation < 3; generation += 1) {
      await host.ensureStarted();
      const child = internals.child;
      const pid = child?.pid;
      expect(child).toBeDefined();
      expect(pid).toBeTypeOf("number");
      pids.add(pid!);
      const retainedWrite = retainFalseWrites(child!);
      retainedByGeneration.push(retainedWrite.retained);
      try {
        const requests = Array.from({ length: MAX_DAEMON_RPC_IN_FLIGHT }, () => host.listServers());
        await expect(waitFor(() => internals.pending?.size === MAX_DAEMON_RPC_IN_FLIGHT ? true : undefined)).resolves.toBe(true);
        expect((child!.stdin as NodeJS.EventEmitter).listenerCount("drain")).toBe(1);
        await Promise.all(requests.map((request) => expect(request).rejects.toThrow(/timed out|transport error/i)));
        expect(await waitForExit(pid!, 5_000)).toBe(true);
        expect(retainedWrite.retained.size).toBe(0);
        expect(internals.admissions?.size).toBe(0);
      } finally {
        retainedWrite.restore();
      }
    }

    expect(retainedByGeneration.map((retained) => retained.size)).toEqual([0, 0, 0]);
    await host.ensureStarted();
    const replacementPid = childPid(host);
    expect(replacementPid).toBeTypeOf("number");
    pids.add(replacementPid!);
    await expect(host.listServers()).resolves.toHaveLength(2);
  }, 45_000);

  it("keeps a false-return write admitted until its one child-owned drain and callback both settle", async () => {
    const host = create("clean");
    const internals = host as unknown as HostInternals;
    await host.ensureStarted();
    const child = internals.child;
    const stdin = child?.stdin as WritableWithCallback | undefined;
    const pid = child?.pid;
    expect(stdin).toBeDefined();
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);

    const original = stdin!.write.bind(stdin);
    stdin!.write = ((chunk: string, callback?: (error?: Error | null) => void): boolean => {
      original(chunk, callback);
      queueMicrotask(() => (stdin as unknown as { emit(event: string): void }).emit("drain"));
      return false;
    }) as WritableWithCallback["write"];
    try {
      await expect(host.listServers()).resolves.toHaveLength(2);
      await expect(waitFor(() => internals.admissions?.size === 0 ? true : undefined)).resolves.toBe(true);
      expect(stdin!.listenerCount("drain")).toBe(0);
      expect(host.isReady).toBe(true);
    } finally {
      stdin!.write = original as WritableWithCallback["write"];
    }
  }, 30_000);

  it("does not add a post-terminal drain listener when a false-return write fails synchronously", async () => {
    const host = create("clean");
    const internals = host as unknown as HostInternals;
    await host.ensureStarted();
    const child = internals.child;
    const stdin = child?.stdin as WritableWithCallback | undefined;
    const pid = child?.pid;
    expect(stdin).toBeDefined();
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);

    const original = stdin!.write.bind(stdin);
    stdin!.write = ((_chunk: string, callback?: (error?: Error | null) => void): boolean => {
      callback?.(new Error("synchronous write callback failure"));
      return false;
    }) as WritableWithCallback["write"];
    try {
      const request = host.listServers();
      expect(stdin!.listenerCount("drain")).toBe(0);
      await expect(request).rejects.toThrow(/transport error/i);
      expect(await waitForExit(pid!)).toBe(true);
      expect(internals.admissions?.size).toBe(0);
      expect(stdin!.listenerCount("drain")).toBe(0);
    } finally {
      stdin!.write = original as WritableWithCallback["write"];
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
