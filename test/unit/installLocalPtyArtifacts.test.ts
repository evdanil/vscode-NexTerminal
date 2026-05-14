import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "installLocalPtyArtifacts.mjs");

describe("installLocalPtyArtifacts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("copies companion runtime files alongside each platform sidecar", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nexus-local-pty-artifacts-"));
    tempDirs.push(workspace);
    const sourceRoot = path.join(workspace, "artifacts");
    const winDir = path.join(sourceRoot, "win32-x64");
    await mkdir(winDir, { recursive: true });
    writeFileSync(path.join(winDir, "nexus-local-pty.exe"), "exe");
    writeFileSync(path.join(winDir, "libunwind.dll"), "dll");

    execFileSync(process.execPath, [scriptPath], {
      cwd: workspace,
      env: {
        ...process.env,
        LOCAL_PTY_ARTIFACTS_DIR: sourceRoot
      },
      stdio: "pipe"
    });

    const destDir = path.join(workspace, "dist", "native", "local-pty", "win32-x64");
    expect(readFileSync(path.join(destDir, "nexus-local-pty.exe"), "utf8")).toBe("exe");
    expect(readFileSync(path.join(destDir, "libunwind.dll"), "utf8")).toBe("dll");
  });
});
