import { normalizeFolderPath } from "./folderPaths";
import type { ImportedSession, ImportParseResult } from "./mobaxtermParser";

export type { ImportedSession, ImportParseResult };

export interface SecureCrtFileEntry {
  name: string;
  folder: string;
  content: string;
}

/**
 * Parse a single SecureCRT `.ini` session file.
 *
 * Field formats:
 * - `S:"Key"=value`  — string
 * - `D:"Key"=hexvalue` — DWORD (hex → decimal)
 * - `Z:"Key"=hexblob` — binary (ignored)
 *
 * Returns `undefined` if the file is not an SSH session or has no hostname.
 */
export function parseSecureCrtSessionFile(
  content: string,
  name: string,
  folder: string
): ImportedSession | undefined {
  const fields = new Map<string, string>();
  const dwords = new Map<string, number>();

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(/^([SDZ]):"([^"]+)"=(.*)$/);
    if (!match) continue;

    const [, type, key, value] = match;
    if (type === "S") {
      fields.set(key, value);
    } else if (type === "D") {
      const num = parseInt(value, 16);
      if (Number.isFinite(num)) {
        dwords.set(key, num);
      }
    }
    // Z: (binary) entries are ignored
  }

  const protocol = fields.get("Protocol Name") ?? "";
  if (!protocol.startsWith("SSH")) {
    return undefined;
  }

  const host = (fields.get("Hostname") ?? "").trim();
  if (!host) {
    return undefined;
  }

  const port = dwords.get("[SSH2] Port") ?? 22;
  const username = (fields.get("Username") ?? "").trim();
  const normalizedFolder = folder ? (normalizeFolderPath(folder) ?? "") : "";

  return { name, host, port, username, folder: normalizedFolder };
}

/**
 * Parse a collection of pre-read SecureCRT session files.
 *
 * The actual filesystem walk happens in the command handler — this function
 * receives already-read file contents, making it testable without VS Code deps.
 */
export function parseSecureCrtDirectory(files: SecureCrtFileEntry[]): ImportParseResult {
  const sessions: ImportedSession[] = [];
  let skippedCount = 0;
  const folderSet = new Set<string>();

  for (const file of files) {
    const session = parseSecureCrtSessionFile(file.content, file.name, file.folder);
    if (session) {
      sessions.push(session);
      if (session.folder) {
        folderSet.add(session.folder);
      }
    } else {
      skippedCount++;
    }
  }

  return {
    sessions,
    skippedCount,
    folders: [...folderSet].sort()
  };
}
