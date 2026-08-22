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

  async function expectProtocolFailureThenCleanRestart(mode: string, observe?: (host: NetworkServerDaemonHost) => void): Promise<void> {
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

    await expect(host.listServers()).rejects.toThrow(/Daemon protocol error/);
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
    host.onDidExit((code, signal) => { exited = { code, signal }; });

    await host.ensureStarted();
    const pid = childPid(host);
    expect(pid).toBeTypeOf("number");
    pids.add(pid!);
    await expect(waitFor(() => exited)).resolves.toEqual({ code: 0, signal: null });
    expect(host.isReady).toBe(false);
    expect(await waitForExit(pid!)).toBe(true);
  }, 30_000);
});
