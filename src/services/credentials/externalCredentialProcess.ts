import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, win32 } from "node:path";
import { validateExternalCredentialInvocation } from "../../models/authProfile";
import {
  EXTERNAL_CREDENTIAL_PROCESS_TIMEOUT_MS, EXTERNAL_CREDENTIAL_STDOUT_MAX_BYTES,
  EXTERNAL_CREDENTIAL_STDERR_MAX_BYTES, EXTERNAL_CREDENTIAL_TERMINATION_GRACE_MS,
  EXTERNAL_CREDENTIAL_STREAM_DRAIN_GRACE_MS, EXTERNAL_CREDENTIAL_CLEANUP_TIMEOUT_MS,
  EXTERNAL_CREDENTIAL_LIVENESS_INTERVAL_MS, type ExternalCredentialProcessRunner
} from "./contracts";
import { CredentialProviderError, type CredentialProviderErrorCode } from "./credentialProviderError";

type Timer = ReturnType<typeof setTimeout>;
export interface ExternalCredentialProcessDependencies {
  spawn(executable: string, args: string[], options: SpawnOptions): ChildProcess;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  tempDirectory: string;
  isExecutableFile(path: string): boolean;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  clock: { setTimeout(callback: () => void, milliseconds: number): Timer; clearTimeout(timer: Timer): void };
  limits: { timeoutMs: number; stdoutBytes: number; stderrBytes: number; terminationGraceMs: number; drainGraceMs: number; cleanupMs: number; livenessMs: number };
}
type Dependencies = Partial<Omit<ExternalCredentialProcessDependencies, "limits">> & {
  limits?: Partial<ExternalCredentialProcessDependencies["limits"]>;
};
const ignoreError = (): void => {};

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  let descriptor: number | undefined;
  const header = Buffer.alloc(4);
  try {
    accessSync(path, constants.X_OK);
    if (!statSync(path).isFile()) return false;
    descriptor = openSync(path, "r");
    const length = readSync(descriptor, header, 0, header.length, 0);
    // execvp can silently interpret headerless text with /bin/sh despite shell:false.
    // These are format checks, not identity pinning of mutable trusted local programs.
    if (platform === "win32") return length >= 2 && header[0] === 0x4d && header[1] === 0x5a;
    if (length >= 2 && header[0] === 0x23 && header[1] === 0x21) return true;
    if (length !== 4) return false;
    const magic = header.readUInt32BE();
    if (platform === "darwin") return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic);
    return magic === 0x7f454c46;
  } catch { return false; }
  finally { header.fill(0); if (descriptor !== undefined) closeSync(descriptor); }
}

/** Trusted local programs only: process groups cannot contain hostile escaped descendants. */
export function createExternalCredentialProcessRunner(overrides: Dependencies = {}): ExternalCredentialProcessRunner {
  const deps: ExternalCredentialProcessDependencies = {
    spawn, platform: process.platform, environment: process.env, tempDirectory: tmpdir(),
    isExecutableFile: (path) => isExecutableFile(path, overrides.platform ?? process.platform),
    killGroup: (pid, signal) => { process.kill(-pid, signal); },
    clock: { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout },
    ...overrides,
    limits: {
      timeoutMs: EXTERNAL_CREDENTIAL_PROCESS_TIMEOUT_MS, stdoutBytes: EXTERNAL_CREDENTIAL_STDOUT_MAX_BYTES,
      stderrBytes: EXTERNAL_CREDENTIAL_STDERR_MAX_BYTES, terminationGraceMs: EXTERNAL_CREDENTIAL_TERMINATION_GRACE_MS,
      drainGraceMs: EXTERNAL_CREDENTIAL_STREAM_DRAIN_GRACE_MS, cleanupMs: EXTERNAL_CREDENTIAL_CLEANUP_TIMEOUT_MS,
      livenessMs: EXTERNAL_CREDENTIAL_LIVENESS_INTERVAL_MS, ...overrides.limits
    }
  };
  return (invocation, method, context) => new Promise<Buffer>((resolve, reject) => {
    const stale = (): CredentialProviderErrorCode | undefined => context.signal.aborted ? "cancelled" : !context.isCurrent() ? "configuration-changed" : undefined;
    const initial = stale();
    if (initial) { reject(new CredentialProviderError(initial)); return; }
    const absolute = deps.platform === "win32" ? win32.isAbsolute : isAbsolute;
    try {
      if (!validateExternalCredentialInvocation(invocation) || !absolute(invocation.executable) ||
        (deps.platform === "win32" && /\.(?:bat|cmd)$/iu.test(invocation.executable)) || !deps.isExecutableFile(invocation.executable)) {
        reject(new CredentialProviderError("spawn-failed")); return;
      }
    } catch { reject(new CredentialProviderError("spawn-failed")); return; }
    const beforeSpawn = stale();
    if (beforeSpawn) { reject(new CredentialProviderError(beforeSpawn)); return; }

    let child: ChildProcess;
    try {
      child = deps.spawn(invocation.executable, [...invocation.args, method === "password" ? "--pass" : "--pkey"], {
        shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: deps.platform !== "win32",
        cwd: deps.tempDirectory, env: deps.environment
      });
    } catch { reject(new CredentialProviderError("spawn-failed")); return; }

    let settled = false;
    let failure: CredentialProviderError | undefined;
    let exited = false;
    let closed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks: Buffer[] = [];
    const timers = new Set<Timer>();
    let helper: ChildProcess | undefined;
    let helperExited = false;
    const schedule = (callback: () => void, delay: number): void => {
      const timer = deps.clock.setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
    };
    const wipe = (): void => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const stopHelper = (): void => {
      if (!helper) return;
      if (!helperExited) { try { helper.kill("SIGKILL"); } catch { /* Errors never contain safe provider context. */ } }
      helper.unref(); helper = undefined;
    };
    const destroyPipes = (): void => {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    };
    const finish = (error?: CredentialProviderError): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) deps.clock.clearTimeout(timer);
      timers.clear(); context.signal.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout); child.stderr?.removeListener("data", onStderr);
      child.stdout?.removeListener("error", onError); child.stderr?.removeListener("error", onError);
      child.stdout?.on("error", ignoreError); child.stderr?.on("error", ignoreError);
      child.removeListener("exit", onExit); child.removeListener("close", onClose); child.removeListener("error", onError);
      // A failed kill may leave a child pending reaping. Never retain output or expose a late error.
      child.on("error", ignoreError);
      stopHelper(); destroyPipes();
      if (error) { wipe(); child.unref(); reject(error); }
      else {
        const output = Buffer.concat(chunks, stdoutBytes);
        wipe(); resolve(output); // Ownership transfers to the resolver, which wipes after parsing.
      }
    };
    const hasPid = (): boolean => Number.isSafeInteger(child.pid) && child.pid! > 0;
    const signalOwned = (signal: NodeJS.Signals): void => {
      if (!hasPid() || (exited && closed)) return;
      if (deps.platform !== "win32") {
        try { deps.killGroup(child.pid!, signal); } catch { /* Cleanup status comes from observed exit, never kill's return. */ }
        return;
      }
      // After observed parent exit its PID could be reused; never target it or run another tree helper.
      if (exited) return;
      if (signal === "SIGKILL") {
        try { child.kill("SIGKILL"); } catch { /* The cleanup deadline remains authoritative. */ }
        return;
      }
      const root = deps.environment.SystemRoot;
      if (!root || !win32.isAbsolute(root) || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(root)) return;
      const executable = win32.join(root, "System32", "taskkill.exe");
      try {
        if (!validateExternalCredentialInvocation({ executable, args: [] }) || !deps.isExecutableFile(executable) || exited) return;
        helper = deps.spawn(executable, ["/PID", String(child.pid), "/T", "/F"], {
          shell: false, windowsHide: true, stdio: "ignore", cwd: deps.tempDirectory, env: deps.environment
        });
        helper.on("error", ignoreError);
        helper.once("exit", () => { helperExited = true; });
        schedule(stopHelper, deps.limits.terminationGraceMs);
      } catch { /* No shell fallback, and helper failures must not disclose raw errors. */ }
    };
    const fail = (code: CredentialProviderErrorCode, numericExit?: number): void => {
      if (failure || settled) return;
      failure = new CredentialProviderError(code, numericExit);
      wipe();
      // Signal before destroying pipes: pipe ownership still proves the group is ours after parent exit.
      signalOwned("SIGTERM"); destroyPipes();
      if (!hasPid() || (exited && closed)) { finish(failure); return; }
      schedule(() => { if (!settled) signalOwned("SIGKILL"); }, deps.limits.terminationGraceMs);
      schedule(() => finish(exited ? failure : new CredentialProviderError("cleanup-failed")), deps.limits.cleanupMs);
    };
    const onAbort = (): void => fail("cancelled");
    const collect = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (settled || failure) { chunk.fill(0); return; }
      const size = stream === "stdout" ? stdoutBytes : stderrBytes;
      const bound = stream === "stdout" ? deps.limits.stdoutBytes : deps.limits.stderrBytes;
      if (chunk.length > bound - size) { chunk.fill(0); fail("output-too-large"); return; }
      if (stream === "stdout" && chunk.length > 0) { stdoutBytes += chunk.length; chunks.push(Buffer.from(chunk)); }
      else stderrBytes += chunk.length;
      chunk.fill(0);
    };
    const onStdout = (chunk: Buffer): void => collect(chunk, "stdout");
    const onStderr = (chunk: Buffer): void => collect(chunk, "stderr");
    const onError = (): void => fail("spawn-failed");
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exited = true; exitCode = code; exitSignal = signal;
      if (failure) return;
      if (code !== 0 || signal !== null) { fail("exited", code ?? undefined); return; }
      schedule(() => { if (!closed) fail("exited"); }, deps.limits.drainGraceMs);
    };
    const onClose = (): void => {
      closed = true;
      if (failure) { finish(failure); return; }
      const changed = stale();
      if (changed) { fail(changed); return; }
      if (!exited || exitCode !== 0 || exitSignal !== null) { fail("exited", exitCode ?? undefined); return; }
      finish();
    };
    child.on("error", onError); child.on("exit", onExit); child.on("close", onClose);
    child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
    child.stdout?.on("error", onError); child.stderr?.on("error", onError);
    context.signal.addEventListener("abort", onAbort, { once: true });
    schedule(() => fail("timed-out"), deps.limits.timeoutMs);
    const checkCurrent = (): void => {
      if (settled || failure) return;
      const changed = stale();
      if (changed) fail(changed);
      else schedule(checkCurrent, deps.limits.livenessMs);
    };
    checkCurrent();
  });
}

export const runExternalCredentialProcess: ExternalCredentialProcessRunner = createExternalCredentialProcessRunner();
