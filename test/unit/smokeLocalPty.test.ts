import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "smokeLocalPty.mjs");

describe("smokeLocalPty", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("answers terminal cursor-position queries from Windows shells", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nexus-local-pty-smoke-"));
    tempDirs.push(workspace);
    const sidecarPath = path.join(workspace, "fake-sidecar.mjs");
    writeFileSync(sidecarPath, `#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";

const marker = "NEXUS_SMOKE_OK";
let sawCursorResponse = false;
const rl = createInterface({ input: process.stdin });

function emit(frame) {
  process.stdout.write(JSON.stringify(frame) + "\\n");
}

rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "spawn") {
    emit({ type: "ready" });
    emit({ type: "data", data: Buffer.from("\\x1b[6n", "utf8").toString("base64") });
  } else if (frame.type === "input") {
    const text = Buffer.from(frame.data, "base64").toString("utf8");
    if (text === "\\x1b[1;1R") {
      sawCursorResponse = true;
      emit({ type: "data", data: Buffer.from(marker, "utf8").toString("base64") });
      emit({ type: "exit", code: 0 });
      process.exit(0);
    }
  }
});

setTimeout(() => {
  if (!sawCursorResponse) {
    process.stderr.write("missing cursor-position response\\n");
    process.exit(2);
  }
}, 1000);
`);
    chmodSync(sidecarPath, 0o755);

    execFileSync(process.execPath, [scriptPath, sidecarPath], {
      cwd: repoRoot,
      stdio: "pipe"
    });
  });
});
