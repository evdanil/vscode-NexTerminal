import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "collectLocalPtyArtifact.mjs");

describe("collectLocalPtyArtifact", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("copies the primary sidecar and Windows runtime DLL companions", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nexus-local-pty-collect-"));
    tempDirs.push(workspace);
    const releaseDir = path.join(workspace, "native", "local-pty", "target", "x86_64-pc-windows-gnullvm", "release");
    await mkdir(releaseDir, { recursive: true });
    writeFileSync(path.join(releaseDir, "nexus-local-pty.exe"), "exe");
    writeFileSync(path.join(releaseDir, "libunwind.dll"), "dll");

    execFileSync(process.execPath, [scriptPath, "x86_64-pc-windows-gnullvm", "win32-x64"], {
      cwd: workspace,
      stdio: "pipe"
    });

    const destDir = path.join(workspace, "local-pty-dist", "win32-x64");
    expect(readFileSync(path.join(destDir, "nexus-local-pty.exe"), "utf8")).toBe("exe");
    expect(readFileSync(path.join(destDir, "libunwind.dll"), "utf8")).toBe("dll");
  });
});
