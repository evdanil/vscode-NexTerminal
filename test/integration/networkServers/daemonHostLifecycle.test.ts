/**
 * Integration tests for `NetworkServerDaemonHost`'s spawn failure handling.
 *
 * The bridge's happy path is covered by `daemonBridge.test.ts`, which drives a
 * real daemon bundle. What is exercised here is the path that leaves a process
 * behind: a child that spawns fine and then never reports ready. `launch()`
 * rejected on its timeout without killing it, so the daemon stayed alive with
 * its pipes open, `dispose()` could no longer reach it (a retry overwrites the
 * host's single `child` reference), and a `ready` it eventually emitted still
 * reached the bridge — resolving waiters that belonged to its replacement.
 *
 * Real child processes, real timers: the fixtures under `test/fixtures/` are
 * ordinary Node scripts, because the behaviour under test is process
 * lifetime, which a stub cannot represent.
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { NetworkServerDaemonHost } from "../../../src/services/networkServers/daemonHost";
import { sleep } from "../../helpers/networkServerTestHelpers";

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures");
/** The host clamps `readyTimeoutMs` to a 1s floor, so this is as short as it gets. */
const READY_TIMEOUT_MS = 1000;

/** `kill(pid, 0)` sends no signal — it only asks whether the process is still there. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

/** Reads the host's current child pid without waiting for it to be handed out. */
function childPid(host: NetworkServerDaemonHost): number | undefined {
  return (host as unknown as { child?: { pid?: number } }).child?.pid;
}

describe("NetworkServerDaemonHost — a spawn that never reports ready", () => {
  const hosts: NetworkServerDaemonHost[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
  });

  it("kills the timed-out child instead of leaving it running", async () => {
    const host = new NetworkServerDaemonHost(path.join(FIXTURES, "mockNetworkServerDaemonNeverReady.js"), {
      readyTimeoutMs: READY_TIMEOUT_MS
    });
    hosts.push(host);

    const attempt = host.ensureStarted();
    // Capture the pid while the host still holds it — after the fix it lets go.
    await sleep(250);
    const pid = childPid(host);
    expect(pid, "the fixture should have spawned").toBeTypeOf("number");

    await expect(attempt).rejects.toThrow(/did not report ready/i);
    expect(host.isRunning, "a child the host has given up on must not still count as running").toBe(false);
    expect(
      await waitForExit(pid!),
      "the abandoned daemon is unreachable by dispose() once a retry replaces it, so it must be killed here"
    ).toBe(true);
  }, 20_000);

  // dispose() and the ready-timeout path now share one teardown routine; this
  // is the half of it that was already working, kept covered so the sharing
  // cannot regress it.
  it("dispose() still takes down a child that DID come up", async () => {
    process.env.NEXUS_MOCK_READY_DELAY_MS = "20";
    try {
      const host = new NetworkServerDaemonHost(path.join(FIXTURES, "mockNetworkServerDaemonLateReady.js"), {
        readyTimeoutMs: READY_TIMEOUT_MS
      });
      hosts.push(host);
      await host.ensureStarted();
      expect(host.isReady).toBe(true);
      const pid = childPid(host);
      expect(pid).toBeTypeOf("number");

      host.dispose();
      expect(await waitForExit(pid!), "dispose must not leave a daemon holding UDP 69/67").toBe(true);
    } finally {
      delete process.env.NEXUS_MOCK_READY_DELAY_MS;
    }
  }, 20_000);

  it("cannot be marked ready afterwards by the daemon it abandoned", async () => {
    const host = new NetworkServerDaemonHost(path.join(FIXTURES, "mockNetworkServerDaemonLateReady.js"), {
      readyTimeoutMs: READY_TIMEOUT_MS
    });
    hosts.push(host);

    // The fixture announces readiness at 2s, twice the host's timeout.
    await expect(host.ensureStarted()).rejects.toThrow(/did not report ready/i);
    await sleep(2500);
    expect(
      host.isReady,
      "a `ready` from the abandoned child would resolve ready-waiters belonging to a different one"
    ).toBe(false);
  }, 20_000);
});
