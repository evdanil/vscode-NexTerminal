import { access, chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const sourceRoot = process.env.NETWORK_SERVER_DAEMON_ARTIFACTS_DIR ?? "native/network-server-daemon-artifacts";
const destRoot = "dist/native/network-server-daemon";
const requiredPlatforms = [
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64"
];
const requireAll =
  process.env.NETWORK_SERVER_DAEMON_REQUIRE_ALL === "1" || process.argv.includes("--require-all");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyPlatformArtifact(platformKey) {
  const binaryName = platformKey.startsWith("win32-")
    ? "nexus-network-server-daemon.exe"
    : "nexus-network-server-daemon";
  const source = path.join(sourceRoot, platformKey, binaryName);
  if (!(await exists(source))) {
    return false;
  }

  const destinationDir = path.join(destRoot, platformKey);
  await mkdir(destinationDir, { recursive: true });

  const entries = await readdir(path.join(sourceRoot, platformKey), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    const sourceFile = path.join(sourceRoot, platformKey, filename);
    const destination = path.join(destinationDir, filename);
    await copyFile(sourceFile, destination);
    if (!platformKey.startsWith("win32-") && filename === binaryName) {
      await chmod(destination, 0o755);
    }
  }
  return true;
}

async function main() {
  if (!(await exists(sourceRoot))) {
    if (requireAll) {
      throw new Error(`Network server daemon artifacts directory not found: ${sourceRoot}`);
    }
    console.log("No network server daemon artifacts found; skipping native daemon copy.");
    return;
  }

  const platformKeys = await readdir(sourceRoot);
  const copied = [];
  for (const platformKey of platformKeys) {
    if (await copyPlatformArtifact(platformKey)) {
      copied.push(platformKey);
    }
  }

  if (requireAll) {
    const missing = requiredPlatforms.filter((platformKey) => !copied.includes(platformKey));
    if (missing.length > 0) {
      throw new Error(`Missing network server daemon artifacts: ${missing.join(", ")}`);
    }
  }

  console.log(
    `Installed network server daemon artifacts: ${copied.length > 0 ? copied.join(", ") : "none"}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
