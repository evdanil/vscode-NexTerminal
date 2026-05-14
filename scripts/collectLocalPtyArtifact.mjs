import { access, chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

function binaryNameForPlatform(platformKey) {
  return platformKey.startsWith("win32-") ? "nexus-local-pty.exe" : "nexus-local-pty";
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
    throw new Error("Usage: node scripts/collectLocalPtyArtifact.mjs <rust-target> <platform-key>");
  }

  const binaryName = binaryNameForPlatform(platformKey);
  const releaseDir = path.join("native", "local-pty", "target", target, "release");
  const sourceBinary = path.join(releaseDir, binaryName);
  if (!(await exists(sourceBinary))) {
    throw new Error(`Local PTY binary not found: ${sourceBinary}`);
  }

  const destinationDir = path.join("local-pty-dist", platformKey);
  await mkdir(destinationDir, { recursive: true });
  await copyFile(sourceBinary, path.join(destinationDir, binaryName));
  if (!platformKey.startsWith("win32-")) {
    await chmod(path.join(destinationDir, binaryName), 0o755);
  }

  if (platformKey.startsWith("win32-")) {
    const entries = await readdir(releaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".dll")) continue;
      await copyFile(path.join(releaseDir, entry.name), path.join(destinationDir, entry.name));
    }
  }

  console.log(`Collected Local PTY artifact: ${platformKey}`);
}

collect(process.argv[2], process.argv[3]).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
