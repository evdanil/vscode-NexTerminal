#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(repoRoot, "native", "network-server-daemon", "Cargo.toml");
const binaryPath = path.join(
  repoRoot,
  "native",
  "network-server-daemon",
  "target",
  "release",
  process.platform === "win32" ? "nexus-network-server-daemon.exe" : "nexus-network-server-daemon"
);

function commandName(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function run(command, args, options = {}) {
  const result = spawnSync(commandName(command), args, {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("cargo", [
  "build",
  "--manifest-path",
  manifestPath,
  "--release",
  "-p",
  "nexus-network-server-daemon",
]);

if (!existsSync(binaryPath)) {
  console.error(`Native network server daemon binary was not built: ${binaryPath}`);
  process.exit(1);
}

run("npx", ["vitest", "run", "test/integration/networkServers/daemonEngineParity.test.ts"], {
  env: {
    NEXUS_NETWORK_SERVERS_ENGINE: "rust",
    NEXUS_NETWORK_SERVER_DAEMON_BIN: binaryPath,
  },
});
