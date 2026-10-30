import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createExternalCredentialProcessRunner } from "../../src/services/credentials/externalCredentialProcess";

async function fixture(mode: string, check: (result: Buffer | Error, pids: number[], observation: { parentExited: boolean; pipesOpenAtExit: boolean }) => void | Promise<void>, timeoutMs = 1500, cancelWhenReady = false) {
  const directory = mkdtempSync(join(tmpdir(), "nexus-credential-test-"));
  const control = join(directory, "pids");
  try {
    const observation = { parentExited: false, pipesOpenAtExit: false };
    let providerSpawned = false;
    const controller = new AbortController();
    const runner = createExternalCredentialProcessRunner({ limits: { timeoutMs }, spawn: (executable, args, options) => {
      const child = spawn(executable, args, options);
      if (!providerSpawned) {
        providerSpawned = true;
        // Fixture readiness proves cancellation happens after a real child starts.
        if (cancelWhenReady) child.stderr!.once("data", () => controller.abort());
        child.once("exit", () => {
          observation.parentExited = true;
          observation.pipesOpenAtExit = !!child.stdout && !child.stdout.destroyed && !child.stdout.readableEnded;
        });
      }
      return child;
    } });
    const result = await runner({ executable: process.execPath, args: [resolve(__dirname, "../fixtures/externalCredentials/provider.cjs"), mode, control] }, "password",
      { signal: controller.signal, isCurrent: () => true }).catch((error: Error) => error);
    try {
      const pids = readFileSync(control, "utf8").trim().split("\n").map(Number);
      await check(result, pids, observation);
    } finally { if (Buffer.isBuffer(result)) result.fill(0); }
  } finally {
    // Fixture control files contain only synthetic PIDs, never credentials.
    let pids: number[] = [];
    try { pids = readFileSync(control, "utf8").trim().split("\n").map(Number); } catch { /* Spawn can fail before control exists. */ }
    for (const pid of pids.reverse()) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        if (process.platform === "win32") execFileSync(join(process.env.SystemRoot!, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 1000, windowsHide: true });
        else process.kill(pid, "SIGKILL");
      } catch { /* The runner normally already reaped these processes. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("real external credential process", () => {
  it.each(["valid", "delayed"])("returns %s output with ownership transferred", async mode => {
    await fixture(mode, result => { expect(Buffer.isBuffer(result)).toBe(true); expect(result.toString()).toBe('{"version":1,"username":"fixture","password":"synthetic-value"}'); });
  });
  it("leaves malformed protocol bytes for the parser", async () => { await fixture("malformed", result => expect(result.toString()).toBe("{invalid")); });
  it.each(["large-stdout", "large-stderr"])("rejects %s", async mode => { await fixture(mode, result => expect(result).toMatchObject({ code: "output-too-large" })); });
  it("does not disclose stderr on nonzero exit", async () => { await fixture("nonzero", result => { expect(result).toMatchObject({ code: "exited", exitCode: 7 }); expect(String(result)).not.toContain("SECRET_CANARY"); }); });
  it.each(["hang", "waiting"])("bounds %s and terminates cooperative processes", async mode => {
    await fixture(mode, async (result, pids) => {
      expect(result).toMatchObject({ code: "timed-out" }); expect(pids.length).toBe(mode === "waiting" ? 2 : 1);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          // Linux CI may use a PID 1 that leaves reparented zombies unreaped.
          if (process.platform === "linux" && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
          return true;
        } catch { return false; }
      };
      for (let i = 0; i < 25 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(pids.filter(alive)).toEqual([]);
    }, 1500);
  });
  it("cancels a running real child and observes its termination", async () => {
    await fixture("cancel-ready", (result, pids, observation) => {
      expect(result).toMatchObject({ code: "cancelled" });
      expect(pids).toHaveLength(1);
      expect(observation.parentExited).toBe(true);
      expect(() => process.kill(pids[0], 0)).toThrow();
    }, 1500, true);
  });
  it.each(["inherited", "escaped"])("rejects %s pipes after parent exit without accepting partial output", async mode => {
    await fixture(mode, (result, pids, observation) => {
      expect(pids).toHaveLength(2);
      expect(observation).toEqual({ parentExited: true, pipesOpenAtExit: true });
      expect(result).toMatchObject({ code: "exited" });
      if (process.platform === "win32") {
        // The runner must leave the exited parent's PID alone; fixture cleanup owns the survivor.
        expect(() => process.kill(pids[0], 0)).toThrow();
        expect(() => process.kill(pids[1], 0)).not.toThrow();
      }
    });
  });
  it.skipIf(process.platform === "win32")("rejects headerless text without executing its shell side effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-credential-header-"));
    const executable = join(directory, "provider"); const marker = join(directory, "executed");
    try {
      writeFileSync(executable, 'touch "$1"\n', { mode: 0o700 });
      const run = createExternalCredentialProcessRunner();
      await expect(run({ executable, args: [marker] }, "password", { signal: new AbortController().signal, isCurrent: () => true })).rejects.toMatchObject({ code: "spawn-failed" });
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === "win32")("allows an explicitly declared POSIX shebang interpreter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-credential-shebang-"));
    const executable = join(directory, "provider");
    try {
      writeFileSync(executable, '#!/bin/sh\nprintf fixture-response\n', { mode: 0o700 });
      const result = await createExternalCredentialProcessRunner()({ executable, args: [] }, "password", { signal: new AbortController().signal, isCurrent: () => true });
      try { expect(result.toString()).toBe("fixture-response"); } finally { result.fill(0); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("rejects a real missing executable and directory", async () => {
    const run = createExternalCredentialProcessRunner();
    for (const executable of [join(tmpdir(), "nexus-missing-provider"), tmpdir()]) {
      await expect(run({ executable, args: [] }, "password", { signal: new AbortController().signal, isCurrent: () => true })).rejects.toMatchObject({ code: "spawn-failed" });
    }
  });
});
