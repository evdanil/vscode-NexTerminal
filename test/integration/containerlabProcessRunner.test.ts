import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContainerlabProcessRunner } from "../../src/services/inventory/containerlabProcessRunner";
import type { ContainerlabCommand, ContainerlabRunContext } from "../../src/services/inventory/containerlabRuntimeContracts";

const FIXTURE = join(__dirname, "..", "fixtures", "containerlab", "runner-fixture.cjs");
const OUTPUT_LIMIT = 8 * 1024 * 1024;

function context(options: Partial<ContainerlabRunContext> = {}): ContainerlabRunContext {
  return {
    interaction: "noninteractive",
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
    isCurrent: () => true,
    ...options
  };
}

function fixtureCommand(args: readonly string[], env: Readonly<Record<string, string>> = {}): ContainerlabCommand {
  return { executable: process.execPath, args: [FIXTURE, ...args], env, cwd: "/" };
}

async function waitForFile(file: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(file);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
}

describe("Containerlab local process runner", () => {
  it("passes a literal argv, fixed cwd, and only the command environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-containerlab-runner-"));
    try {
      const marker = join(root, "must-not-exist");
      const hostile = `$(touch ${marker})`;
      const result = await createContainerlabProcessRunner().run(
        fixtureCommand([`--mode=environment`, `--literal=${hostile}`], { PATH: "/usr/bin", LANG: "C.UTF-8" }),
        context()
      );
      expect(result.stdout, `fixture=${FIXTURE} stderr=${result.stderr}`).not.toBe("");
      const observed = JSON.parse(result.stdout) as { argv: string[]; cwd: string; env: Record<string, string> };
      expect(observed.argv).toContain(`--literal=${hostile}`);
      expect(observed.cwd).toBe("/");
      expect(observed.env).toEqual({ PATH: "/usr/bin", LANG: "C.UTF-8" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects signal termination and nonzero exit status", async () => {
    const runner = createContainerlabProcessRunner();
    await expect(runner.run(fixtureCommand(["--mode=signal", "--signal=SIGKILL"]), context()))
      .rejects.toThrow(/signal|terminated/i);
    await expect(runner.run(fixtureCommand(["--mode=exit", "--code=7"]), context()))
      .rejects.toThrow(/exit|code/i);
  });

  it("enforces the combined stdout and stderr byte limit even when exit is zero", async () => {
    await expect(createContainerlabProcessRunner().run(
      fixtureCommand(["--mode=output", `--stdout=${OUTPUT_LIMIT}`, "--stderr=1"]),
      context()
    )).rejects.toThrow(/output.*limit/i);
  });

  it("cancels the direct command and waits for its cooperating helper to exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-containerlab-cancel-"));
    const parentExit = join(root, "parent-exit");
    const childExit = join(root, "child-exit");
    const readyFile = join(root, "ready.json");
    const parentExitedFile = join(root, "parent-exited");
    const childExitedFile = join(root, "child-exited");
    const controller = new AbortController();
    const started = Date.now();
    let fixturePids: { parentPid: number; helperPid: number } | undefined;
    let run: Promise<unknown> | undefined;
    let runSettled = false;
    try {
      run = createContainerlabProcessRunner().run(
        fixtureCommand([
          "--mode=child", "--delay=30000", `--exit-file=${parentExit}`, `--child-exit-file=${childExit}`,
          `--ready-file=${readyFile}`, `--parent-exited-file=${parentExitedFile}`, `--child-exited-file=${childExitedFile}`
        ]),
        context({ signal: controller.signal, deadline: started + 5_000 })
      );

      if (!await waitForFile(readyFile)) {
        controller.abort(new Error("fixture helper readiness timed out"));
        await expect(run).rejects.toThrow(/cancel/i);
        runSettled = true;
        throw new Error("fixture helper did not report readiness");
      }
      fixturePids = JSON.parse(readFileSync(readyFile, "utf8")) as { parentPid: number; helperPid: number };
      expect(Number.isInteger(fixturePids.parentPid)).toBe(true);
      expect(Number.isInteger(fixturePids.helperPid)).toBe(true);

      controller.abort(new Error("test cancelled"));
      await expect(run).rejects.toThrow(/cancel/i);
      runSettled = true;
      expect(await waitForProcessExit(fixturePids.parentPid)).toBe(true);
      expect(await waitForProcessExit(fixturePids.helperPid)).toBe(true);
      expect(await waitForFile(parentExit)).toBe(true);
      expect(await waitForFile(childExit)).toBe(true);
      expect(readFileSync(parentExit, "utf8")).toBe(`${fixturePids.parentPid}:SIGTERM`);
      expect(readFileSync(childExit, "utf8")).toBe(String(fixturePids.helperPid));
      expect(await waitForFile(parentExitedFile)).toBe(true);
      expect(await waitForFile(childExitedFile)).toBe(true);
      expect(readFileSync(parentExitedFile, "utf8")).toBe(String(fixturePids.parentPid));
      expect(readFileSync(childExitedFile, "utf8")).toBe(String(fixturePids.helperPid));
    } finally {
      if (run && !runSettled) {
        controller.abort(new Error("test fixture cleanup"));
        await run.catch(() => undefined);
      }
      if (fixturePids && !existsSync(childExitedFile)) {
        try {
          process.kill(fixturePids.helperPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an already-expired deadline before starting a subprocess", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-containerlab-expired-"));
    const marker = join(root, "started");
    try {
      await expect(createContainerlabProcessRunner().run(
        fixtureCommand(["--mode=environment", `--literal=${marker}`]),
        context({ deadline: Date.now() - 1 })
      )).rejects.toThrow(/timed out|deadline/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
