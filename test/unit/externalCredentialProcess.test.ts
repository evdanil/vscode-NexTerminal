import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalCredentialProcessRunner } from "../../src/services/credentials/externalCredentialProcess";

function child(pid = 123) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
    kill: vi.fn(() => true), unref: vi.fn(), exitCode: null, signalCode: null }) as unknown as ChildProcess;
}
function setup(platform: NodeJS.Platform = "linux") {
  vi.useFakeTimers();
  const process = child();
  const helper = child(456);
  const spawn = vi.fn().mockReturnValueOnce(process).mockReturnValue(helper);
  const killGroup = vi.fn();
  const isExecutableFile = vi.fn(() => true);
  const controller = new AbortController();
  let current = true;
  const run = createExternalCredentialProcessRunner({ spawn, platform, killGroup, isExecutableFile,
    environment: { SystemRoot: "C:\\Windows", TEST: "inherited" }, tempDirectory: "/tmp/provider-test" });
  const start = (method: "password" | "key" = "password") => run({ executable: platform === "win32" ? "C:\\Tools\\provider.exe" : "/usr/bin/provider", args: ["a b", "x\"y", "a\\b"] }, method,
    { signal: controller.signal, isCurrent: () => current });
  const close = (code: number | null = 0, signal: string | null = null) => {
    process.emit("exit", code, signal); process.emit("close", code, signal);
  };
  return { process, helper, spawn, killGroup, isExecutableFile, controller, start, close, run, invalidate: () => { current = false; } };
}
afterEach(() => vi.useRealTimers());

describe("credential process runner", () => {
  it("escalates owned group cleanup before settling after parent close", async () => {
    const s = setup(); let settled = false;
    const settledAtEscalation: boolean[] = [];
    const result = s.start().catch(error => { settled = true; return error; });
    s.controller.abort();
    s.killGroup.mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") settledAtEscalation.push(settled);
    });
    s.close();
    expect(await result).toMatchObject({ code: "cancelled" });
    expect(s.killGroup.mock.calls).toEqual([[123, "SIGTERM"], [123, "SIGKILL"]]);
    expect(settledAtEscalation).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.killGroup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([["password", "--pass"], ["key", "--pkey"]] as const)("spawns literal %s argv and transfers successful bytes", async (method, flag) => {
    const s = setup(); const promise = s.start(method);
    expect(s.spawn).toHaveBeenCalledWith("/usr/bin/provider", ["a b", "x\"y", "a\\b", flag], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: true,
      cwd: "/tmp/provider-test", env: { SystemRoot: "C:\\Windows", TEST: "inherited" }
    });
    const chunk = Buffer.from("SECRET_CANARY"); s.process.stdout!.emit("data", chunk);
    s.close(); const result = await promise;
    expect(result.toString()).toBe("SECRET_CANARY"); expect(chunk.every((byte) => byte === 0)).toBe(true);
    result.fill(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("wipes retained copies after concatenation and on failure", async () => {
    const s = setup(); const promise = s.start();
    const source = Buffer.from("SECRET_CANARY"); const from = vi.spyOn(Buffer, "from");
    s.process.stdout!.emit("data", source); const retained = from.mock.results[0].value as Buffer; from.mockRestore();
    expect(retained.toString()).toBe("SECRET_CANARY"); s.close();
    const result = await promise; expect(result.toString()).toBe("SECRET_CANARY"); expect(retained.every(byte => byte === 0)).toBe(true); result.fill(0);
    const failed = setup(); const rejection = failed.start().catch(error => error);
    const other = Buffer.from("SECRET_CANARY"); const second = vi.spyOn(Buffer, "from");
    failed.process.stdout!.emit("data", other); const failedCopy = second.mock.results[0].value as Buffer; second.mockRestore();
    failed.controller.abort(); failed.close(); expect(await rejection).toMatchObject({ code: "cancelled" });
    expect(failedCopy.every(byte => byte === 0)).toBe(true);
    expect(failed.process.stdout!.listenerCount("data")).toBe(0);
    expect(() => failed.process.stdout!.emit("error", new Error("late"))).not.toThrow();
  });
  it("rejects stale configuration before spawning", async () => {
    const s = setup(); s.invalidate(); await expect(s.start()).rejects.toMatchObject({ code: "configuration-changed" });
    expect(s.spawn).not.toHaveBeenCalled();
  });
  it.each([
    { executable: "relative", args: [] }, { executable: "/x\n", args: [] },
    ...["", "a\0b", "a\nb", "a\rb", " x", "x ", "x".repeat(4097)].map(arg => ({ executable: "/bin/x", args: [arg] })),
    { executable: "/bin/x", args: Array(33).fill("x") }
  ])("rejects invalid invocation without launching", async invocation => {
    const s = setup(); await expect(s.run(invocation, "password", { signal: s.controller.signal, isCurrent: () => true })).rejects.toMatchObject({ code: "spawn-failed" });
    expect(s.spawn).not.toHaveBeenCalled();
  });
  it("rejects an absent/non-file executable", async () => {
    const s = setup(); s.isExecutableFile.mockReturnValue(false);
    await expect(s.start()).rejects.toMatchObject({ code: "spawn-failed" }); expect(s.spawn).not.toHaveBeenCalled();
  });
  it("rejects abort before spawning", async () => {
    const s = setup(); s.controller.abort("SECRET_CANARY");
    await expect(s.start()).rejects.toMatchObject({ code: "cancelled" }); expect(s.spawn).not.toHaveBeenCalled();
  });
  it("handles abort during spawn and late error without double settlement", async () => {
    const s = setup(); s.spawn.mockReset().mockReturnValue(s.helper).mockImplementationOnce(() => { s.controller.abort(); return s.process; });
    const promise = s.start().catch(error => error); s.close(); s.process.emit("error", new Error("SECRET_CANARY"));
    expect(await promise).toMatchObject({ code: "cancelled" }); expect(vi.getTimerCount()).toBe(0);
  });
  it("masks thrown spawn errors", async () => {
    const s = setup(); s.spawn.mockReset().mockImplementationOnce(() => { throw new Error("SECRET_CANARY"); });
    const error = await s.start().catch(error => error); expect(error.code).toBe("spawn-failed"); expect(error.stack).not.toContain("SECRET_CANARY");
  });
  it("handles asynchronous spawn failure with no PID", async () => {
    const s = setup(); Object.assign(s.process, { pid: undefined });
    const promise = s.start().catch(error => error); s.process.emit("error", new Error("SECRET_CANARY"));
    expect(await promise).toMatchObject({ code: "spawn-failed" }); s.process.emit("close", -2, null);
  });
  it.each([[7, null], [null, "SIGTERM"]])("rejects unsuccessful exit %s/%s without stderr", async (code, signal) => {
    const s = setup(); const promise = s.start().catch(error => error);
    const stderr = Buffer.from("SECRET_CANARY"); s.process.stderr!.emit("data", stderr); s.close(code as number | null, signal as string | null);
    const error = await promise; expect(error.code).toBe("exited"); expect(error.stack).not.toContain("SECRET_CANARY"); expect(stderr.every(byte => byte === 0)).toBe(true);
  });
  it.each([["stdout", 262144], ["stderr", 65536]] as const)("bounds %s before accepting overflow", async (stream, limit) => {
    const s = setup(); let settled = false; const promise = s.start().catch(error => { settled = true; return error; });
    const chunk = Buffer.alloc(limit, 65); s.process[stream]!.emit("data", chunk);
    expect(s.killGroup).not.toHaveBeenCalled(); s.process[stream]!.emit("data", Buffer.from("x")); s.close();
    await Promise.resolve(); expect(settled).toBe(true); expect(await promise).toMatchObject({ code: "output-too-large" }); expect(chunk.every(byte => byte === 0)).toBe(true);
  });
  it("times out at 30000 and reports a live parent at the exact cleanup bound", async () => {
    const s = setup(); let result: unknown; void s.start().catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(29999); expect(s.killGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(s.killGroup).toHaveBeenCalledWith(123, "SIGTERM");
    await vi.advanceTimersByTimeAsync(249); expect(s.killGroup).not.toHaveBeenCalledWith(123, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1); expect(s.killGroup).toHaveBeenCalledWith(123, "SIGKILL");
    await vi.advanceTimersByTimeAsync(749); expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); expect(result).toMatchObject({ code: "cleanup-failed" });
    expect(vi.getTimerCount()).toBe(0); s.process.emit("error", new Error("late")); s.close();
  });
  it("preserves timeout outcome when reaped without close", async () => {
    const s = setup(); const promise = s.start().catch(error => error);
    await vi.advanceTimersByTimeAsync(30000); s.process.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(1000); expect(await promise).toMatchObject({ code: "timed-out" });
  });
  it("rejects complete-looking output when exit pipes never close", async () => {
    const s = setup(); const promise = s.start().catch(error => error);
    s.process.stdout!.emit("data", Buffer.from('{"version":1}')); s.process.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(249); expect(s.killGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(s.killGroup).toHaveBeenCalledWith(123, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1000); expect(await promise).toMatchObject({ code: "exited" });
  });
  it("allows pipe drainage within grace", async () => {
    const s = setup(); const promise = s.start(); s.process.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(249); s.process.stdout!.emit("data", Buffer.from("ok")); s.process.emit("close", 0, null);
    expect((await promise).toString()).toBe("ok"); expect(s.killGroup).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels on configuration invalidation and checks again at delivery", async () => {
    const s = setup(); const promise = s.start().catch(error => error); s.invalidate(); s.close();
    expect(await promise).toMatchObject({ code: "configuration-changed" });
  });
  it("detects invalidation while a process is idle", async () => {
    const s = setup(); const promise = s.start().catch(error => error); s.invalidate();
    await vi.advanceTimersByTimeAsync(25); expect(s.killGroup).toHaveBeenCalledWith(123, "SIGTERM"); s.close();
    expect(await promise).toMatchObject({ code: "configuration-changed" });
  });
  it("first error wins across error/abort/close, wipes data, and clears timers", async () => {
    const s = setup(); const promise = s.start().catch(error => error); const chunk = Buffer.from("SECRET_CANARY");
    s.process.stdout!.emit("data", chunk); s.process.emit("error", new Error("SECRET_CANARY")); s.controller.abort(); s.close();
    const error = await promise; expect(error.code).toBe("spawn-failed"); expect(error.stack).not.toContain("SECRET_CANARY");
    expect(chunk.every(byte => byte === 0)).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses validated absolute Windows taskkill and bounds a hanging helper", async () => {
    const s = setup("win32"); const promise = s.start().catch(error => error); s.controller.abort();
    expect(s.spawn).toHaveBeenNthCalledWith(2, "C:\\Windows\\System32\\taskkill.exe", ["/PID", "123", "/T", "/F"], expect.objectContaining({ shell: false, windowsHide: true, stdio: "ignore" }));
    await vi.advanceTimersByTimeAsync(1000); expect(s.helper.kill).toHaveBeenCalled(); expect(await promise).toMatchObject({ code: "cleanup-failed" });
    expect(vi.getTimerCount()).toBe(0); s.close(); s.helper.emit("error", new Error("late"));
  });
  it("never taskkills an exited Windows PID even with inherited pipes", async () => {
    const s = setup("win32"); const promise = s.start().catch(error => error); s.process.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(1250); expect(await promise).toMatchObject({ code: "exited" }); expect(s.spawn).toHaveBeenCalledTimes(1); expect(s.process.kill).not.toHaveBeenCalled();
  });
  it("handles helper failure with a still-live parent", async () => {
    const s = setup("win32"); const promise = s.start().catch(error => error); s.controller.abort(); s.helper.emit("error", new Error("SECRET_CANARY"));
    await vi.advanceTimersByTimeAsync(1000); expect(await promise).toMatchObject({ code: "cleanup-failed" }); s.close();
  });
  it("refuses Windows script association and untrusted helper paths", async () => {
    const s = setup("win32"); await expect(s.run({ executable: "C:\\Tools\\provider.cmd", args: [] }, "password", { signal: s.controller.signal, isCurrent: () => true })).rejects.toMatchObject({ code: "spawn-failed" });
    expect(s.spawn).not.toHaveBeenCalled();
    const run = createExternalCredentialProcessRunner({ spawn: s.spawn, platform: "win32", isExecutableFile: () => true, environment: { SystemRoot: "relative" } });
    const promise = run({ executable: "C:\\Tools\\p.exe", args: [] }, "password", { signal: s.controller.signal, isCurrent: () => true }).catch(error => error);
    s.controller.abort(); await vi.advanceTimersByTimeAsync(1000); expect(await promise).toMatchObject({ code: "cleanup-failed" }); expect(s.spawn).toHaveBeenCalledTimes(1); s.close();
  });
});
