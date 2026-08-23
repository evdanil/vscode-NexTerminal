// Stages one cross-built network-server daemon binary for upload from CI.
//
// The mirror of `collectLocalPtyArtifact.mjs`, for the same reason and with the
// same shape: the release workflow builds this daemon on a native runner per
// platform, and each run uploads exactly one platform's directory. The build job
// then downloads them all into `native/network-server-daemon-artifacts/`, which
// is where `installNetworkServerDaemonArtifacts.mjs` expects to find them.
import { access, chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

function binaryNameForPlatform(platformKey) {
  return platformKey.startsWith("win32-")
    ? "nexus-network-server-daemon.exe"
    : "nexus-network-server-daemon";
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collect(target, platformKey) {
  if (!target || !platformKey) {
    throw new Error(
      "Usage: node scripts/collectNetworkServerDaemonArtifact.mjs <rust-target> <platform-key>"
    );
  }

  const binaryName = binaryNameForPlatform(platformKey);
  const releaseDir = path.join(
    "native",
    "network-server-daemon",
    "target",
    target,
    "release"
  );
  const sourceBinary = path.join(releaseDir, binaryName);
  if (!(await exists(sourceBinary))) {
    throw new Error(`Network server daemon binary not found: ${sourceBinary}`);
  }

  const destinationDir = path.join("network-server-daemon-dist", platformKey);
  await mkdir(destinationDir, { recursive: true });
  await copyFile(sourceBinary, path.join(destinationDir, binaryName));
  if (!platformKey.startsWith("win32-")) {
    // The execute bit does not survive the artifact round trip on its own.
    await chmod(path.join(destinationDir, binaryName), 0o755);
  }

  // MSVC links the CRT dynamically by default, and a future dependency could
  // bring its own DLL. Copying whatever the release directory holds costs
  // nothing when there is nothing to copy, and avoids shipping a binary that
  // cannot start.
  if (platformKey.startsWith("win32-")) {
    const entries = await readdir(releaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".dll")) continue;
      await copyFile(
        path.join(releaseDir, entry.name),
        path.join(destinationDir, entry.name)
      );
    }
  }

  console.log(`Collected network server daemon artifact: ${platformKey}`);
}

collect(process.argv[2], process.argv[3]).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
