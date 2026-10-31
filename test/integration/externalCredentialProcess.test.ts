import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createExternalCredentialProcessRunner } from "../../src/services/credentials/externalCredentialProcess";
import { createExternalCredentialApproval } from "../../src/services/credentials/externalCredentialApproval";
import { createExternalCredentialResolver } from "../../src/services/credentials/externalCredentialResolver";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";
import type { ExternalAuthProfile } from "../../src/models/authProfile";

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
  it.each(["password", "key"] as const)("passes the reviewed expanded %s arguments unchanged to a real child", async (method) => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-credential-argv-"));
    const observation = join(directory, "argv.json");
    const fixturePath = resolve(__dirname, "../fixtures/externalCredentials/context-provider.cjs");
    const keyPath = resolve(__dirname, "../fixtures/externalCredentials/openssh-ed25519-leading-zero.key");
    const profile: ExternalAuthProfile = { id: "dynamic", name: "Fleet", authType: "external", external: {
      version: 1, method, invocation: { executable: process.execPath, argumentExpansion: true,
        args: [fixturePath, observation, keyPath, "${host}", "prefix ${SessionName} suffix", "${username}", "${port}", "$${host}"] }
    } };
    let reviewed: readonly string[] | undefined;
    const approvals = createExternalCredentialApproval({ isWorkspaceTrusted: () => true,
      confirm: async (_profile, _signal, example) => { reviewed = example?.args; return true; } });
    const resolver = createExternalCredentialResolver({ approvals, run: createExternalCredentialProcessRunner(), parse: parseExternalCredentialResponse });
    const attempt = resolver.begin({ profile, signal: new AbortController().signal, interaction: "interactive", isCurrent: () => true,
      argumentContext: { host: "a host;$(printf BAD) ${username}", port: 2201, SessionName: "東京 ✓", username: "hint", profile: "Fleet", protocol: "ssh" } });
    try {
      const result = await attempt.resolve();
      const expected = [fixturePath, observation, keyPath, "a host;$(printf BAD) ${username}", "prefix 東京 ✓ suffix", "hint", "2201", "${host}"];
      expect(reviewed).toEqual(expected);
      expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual([...expected.slice(3), method === "password" ? "--pass" : "--pkey"]);
      expect(result.username).toBe("provider-user");
      expect(result.method).toBe(method);
    } finally { attempt.dispose(); resolver.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves template-looking arguments literally when expansion is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-credential-literal-"));
    const observation = join(directory, "argv.json");
    const profile: ExternalAuthProfile = { id: "literal", name: "Literal", authType: "external", external: { version: 1, method: "password", invocation: {
      executable: process.execPath, args: [resolve(__dirname, "../fixtures/externalCredentials/context-provider.cjs"), observation, "unused", "${host}", "$${username}"]
    } } };
    const resolver = createExternalCredentialResolver({ approvals: createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm: async () => true }),
      run: createExternalCredentialProcessRunner(), parse: parseExternalCredentialResponse });
    const attempt = resolver.begin({ profile, signal: new AbortController().signal, interaction: "interactive", isCurrent: () => true,
      argumentContext: { host: "different", port: 22, SessionName: "example", username: "user", profile: "Literal", protocol: "ssh" } });
    try { await attempt.resolve(); expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual(["${host}", "$${username}", "--pass"]); }
    finally { attempt.dispose(); resolver.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps a concurrent current owner's own context when the first approval owner becomes stale", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-credential-owners-"));
    const observation = join(directory, "argv.json");
    let allow!: (value: boolean) => void;
    const answer = new Promise<boolean>(resolve => { allow = resolve; });
    let questions = 0;
    const approvals = createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm: async () => { questions++; return answer; } });
    const resolver = createExternalCredentialResolver({ approvals, run: createExternalCredentialProcessRunner(), parse: parseExternalCredentialResponse });
    const profile: ExternalAuthProfile = { id: "fleet", name: "Fleet", authType: "external", external: { version: 1, method: "password", invocation: {
      executable: process.execPath, args: [resolve(__dirname, "../fixtures/externalCredentials/context-provider.cjs"), observation, "unused", "${host}"], argumentExpansion: true
    } } };
    let current = true;
    const begin = (host: string, isCurrent: () => boolean) => resolver.begin({ profile, signal: new AbortController().signal, interaction: "interactive", isCurrent,
      argumentContext: { host, port: 22, SessionName: "example", username: "user", profile: "Fleet", protocol: "ssh" } });
    const first = begin("first", () => current), second = begin("second", () => true);
    try {
      const a = first.resolve().catch((error: unknown) => error); const b = second.resolve();
      await vi.waitFor(() => expect(questions).toBe(1));
      current = false; allow(true);
      expect(await a).toMatchObject({ code: "configuration-changed" });
      expect((await b).username).toBe("provider-user");
      expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual(["second", "--pass"]);
    } finally { first.dispose(); second.dispose(); resolver.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === "win32").each([false, true])("kills an owned TERM-resistant descendant after parent exit (cancel=%s)", async cancel => {
    await fixture("stubborn-descendant", async (result, pids, observation) => {
      expect(result).toMatchObject({ code: cancel ? "cancelled" : "timed-out" });
      expect(pids).toHaveLength(2);
      expect(observation.parentExited).toBe(true);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return process.platform !== "linux" || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
        } catch { return false; }
      };
      for (let i = 0; i < 25 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(pids.filter(alive)).toEqual([]);
    }, 1500, cancel);
  });
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
