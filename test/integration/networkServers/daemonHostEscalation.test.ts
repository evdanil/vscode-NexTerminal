import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NetworkServerDaemonHost } from "../../../src/services/networkServers/daemonHost";
import { sleep } from "../../helpers/networkServerTestHelpers";

const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "mockNetworkServerDaemonIgnoresSigterm.js");
const READY_TIMEOUT_MS = 1000;

type HostInternals = {
  killTimers?: Map<object, unknown>;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return !isAlive(pid);
}

function readPids(pidFile: string): number[] {
  try {
    return fs.readFileSync(pidFile, "utf8")
      .trim()
      .split("\n")
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function waitForPid(pidFile: string, index: number, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPids(pidFile)[index];
    if (pid !== undefined) return pid;
    await sleep(25);
  }
  throw new Error(`timed out waiting for fixture generation ${index + 1} pid`);
}

async function waitForSigterm(signalFile: string, pid: number, timeoutMs = 3_000): Promise<boolean> {
  const expected = `SIGTERM:${pid}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(signalFile, "utf8").split("\n").includes(expected)) return true;
    } catch {
      // The fixture has not yet received SIGTERM.
    }
    await sleep(25);
  }
  return false;
}

async function emergencyKillAndReap(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
  }
  if (!await waitForExit(pid, 3_000)) {
    throw new Error(`emergency cleanup could not reap child ${pid}`);
  }
}

describe("NetworkServerDaemonHost — child-owned escalation", () => {
  const hosts: NetworkServerDaemonHost[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
  });

  it("keeps a timed-out generation's SIGKILL escalation after a clean replacement is disposed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-daemon-escalation-"));
    const pidFile = path.join(tempDir, "pids");
    const signalFile = path.join(tempDir, "signals");
    const previousPidFile = process.env.NEXUS_MOCK_NETWORK_DAEMON_PID_FILE;
    const previousSignalFile = process.env.NEXUS_MOCK_NETWORK_DAEMON_SIGNAL_FILE;
    let firstPid: number | undefined;
    let secondPid: number | undefined;
    const host = new NetworkServerDaemonHost(FIXTURE, { readyTimeoutMs: READY_TIMEOUT_MS });
    const internals = host as unknown as HostInternals;
    hosts.push(host);
    process.env.NEXUS_MOCK_NETWORK_DAEMON_PID_FILE = pidFile;
    process.env.NEXUS_MOCK_NETWORK_DAEMON_SIGNAL_FILE = signalFile;

    try {
      const firstStart = host.ensureStarted();
      firstPid = await waitForPid(pidFile, 0);
      await expect(firstStart).rejects.toThrow(/did not report ready/i);

      if (process.platform === "linux") {
        expect(
          await waitForSigterm(signalFile, firstPid),
          "the first fixture records SIGTERM and deliberately remains alive, so its later exit requires SIGKILL"
        ).toBe(true);
      }

      await host.ensureStarted();
      secondPid = await waitForPid(pidFile, 1);
      expect(secondPid).not.toBe(firstPid);

      host.dispose();
      host.dispose();
      expect(await waitForExit(secondPid, 3_000), "the clean replacement must be reaped after dispose").toBe(true);
      expect(
        await waitForExit(firstPid, 4_000),
        "disposing the replacement must not cancel the first generation's required SIGKILL escalation"
      ).toBe(true);
      expect(internals.killTimers?.size, "each exited child must release only its own escalation timer").toBe(0);
    } finally {
      host.dispose();
      await emergencyKillAndReap(secondPid);
      await emergencyKillAndReap(firstPid);
      if (previousPidFile === undefined) delete process.env.NEXUS_MOCK_NETWORK_DAEMON_PID_FILE;
      else process.env.NEXUS_MOCK_NETWORK_DAEMON_PID_FILE = previousPidFile;
      if (previousSignalFile === undefined) delete process.env.NEXUS_MOCK_NETWORK_DAEMON_SIGNAL_FILE;
      else process.env.NEXUS_MOCK_NETWORK_DAEMON_SIGNAL_FILE = previousSignalFile;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
