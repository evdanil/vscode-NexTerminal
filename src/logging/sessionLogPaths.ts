import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { expandLogDirectoryEnvironment, normalizeTranscriptRelativePath } from "./transcriptPathTemplate";

export function resolveSessionLogDirectory(configured: string, fallback: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (!configured) return fallback;
  try {
    return path.resolve(expandLogDirectoryEnvironment(configured, environment));
  } catch (error) {
    console.error(`[Nexus] nexus.logging.sessionLogDirectory: ${error instanceof Error ? error.message : String(error)} Using the default session log directory.`);
    return fallback;
  }
}

function ensureChildDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  try {
    mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Choose a log subfolder that is a directory, not a symbolic link.");
  }
  return directory;
}

function identity(value: string): string { return value.normalize("NFC").toLowerCase(); }

export interface ReservedTranscriptFile { filepath: string; fd: number; release(): void }

/** A family reservation survives the gap between rotating a basename and reopening it. */
export function reserveTranscriptFile(root: string, relativePath: string): ReservedTranscriptFile {
  const relative = normalizeTranscriptRelativePath(relativePath);
  mkdirSync(root, { recursive: true });
  const canonicalRoot = realpathSync(root);
  const parts = relative.split("/");
  const filename = parts.pop()!;
  let parent = canonicalRoot;
  for (const part of parts) parent = ensureChildDirectory(parent, part);
  // Different configured roots may lead to the same target directory. Ownership
  // belongs beside that target so all windows use the same reservation namespace.
  const reservationDir = ensureChildDirectory(parent, ".nexus-transcript-reservations");
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length);

  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const name = attempt === 1 ? filename : `${stem}-${attempt}${extension}`;
    const key = createHash("sha256").update(identity(name)).digest("hex");
    const marker = path.join(reservationDir, `${key}.lock`);
    let markerFd: number;
    try {
      markerFd = openSync(marker, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    closeSync(markerFd);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try { unlinkSync(marker); } catch { /* A stale marker safely forces a different filename. */ }
    };
    const filepath = path.join(parent, name);
    try {
      const existing = new Set(readdirSync(parent).map(identity));
      const familyExists = existing.has(identity(name)) || Array.from({ length: 99 }, (_, i) => `${name}.${i + 1}`).some((entry) => existing.has(identity(entry)));
      if (familyExists) {
        release();
        continue;
      }
      return { filepath, fd: openSync(filepath, "ax"), release };
    } catch (error) {
      release();
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("No unused transcript filename found. Include date/time tokens in the path template or choose another log directory.");
}
