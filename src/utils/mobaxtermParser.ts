import { normalizeFolderPath } from "./folderPaths";

export interface ImportedSession {
  name: string;
  host: string;
  port: number;
  username: string;
  folder: string;
}

export interface ImportParseResult {
  sessions: ImportedSession[];
  skippedCount: number;
  folders: string[];
}

interface IniSection {
  name: string;
  entries: Map<string, string>;
}

function normalizePort(rawPort: number): number {
  return Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65_535 ? rawPort : 22;
}

/** Generic INI parser. Handles BOM, CRLF, `[section]` headers and `key=value` entries. */
export function parseIniSections(text: string): IniSection[] {
  // Strip BOM
  const cleaned = text.replace(/^\uFEFF/, "");
  // Normalize line endings
  const lines = cleaned.replace(/\r\n/g, "\n").split("\n");

  const sections: IniSection[] = [];
  let current: IniSection | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(";") || trimmed.startsWith("#")) {
      continue;
    }
    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1], entries: new Map() };
      sections.push(current);
      continue;
    }
    if (current) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        current.entries.set(key, value);
      }
    }
  }

  return sections;
}

/**
 * Parse a MobaXterm INI export and extract SSH sessions.
 *
 * Session lines live in `[Bookmarks]` and `[Bookmarks_N]` sections.
 * `SubRep` gives the folder path (backslash-separated).
 * Each numbered entry is `#109#subtype%host%port%username%...` for SSH (type 109).
 */
export function parseMobaxtermSessions(text: string): ImportParseResult {
  const sections = parseIniSections(text);
  const sessions: ImportedSession[] = [];
  let skippedCount = 0;
  const folderSet = new Set<string>();

  for (const section of sections) {
    if (!section.name.startsWith("Bookmarks")) {
      continue;
    }

    const subRep = section.entries.get("SubRep") ?? "";
    const rawFolder = subRep.replace(/\\/g, "/").trim();
    const folder = rawFolder ? (normalizeFolderPath(rawFolder) ?? "") : "";

    for (const [key, value] of section.entries) {
      // Skip metadata keys
      if (key === "SubRep" || key === "ImgNum") {
        continue;
      }

      // Match SSH type: #109#subtype%fields...
      const typeMatch = value.match(/^#(\d+)#/);
      if (!typeMatch) {
        continue;
      }
      const type = parseInt(typeMatch[1], 10);
      if (type !== 109) {
        skippedCount++;
        continue;
      }

      // Strip the type prefix and split on %
      const afterType = value.replace(/^#\d+#\d+%/, "");
      const fields = afterType.split("%");

      const host = (fields[0] ?? "").trim();
      if (!host) {
        skippedCount++;
        continue;
      }

      const rawPort = parseInt(fields[1] ?? "", 10);
      const port = normalizePort(rawPort);
      const username = (fields[2] ?? "").trim() || "user";

      if (folder) {
        folderSet.add(folder);
      }

      sessions.push({ name: key, host, port, username, folder });
    }
  }

  return {
    sessions,
    skippedCount,
    folders: [...folderSet].sort()
  };
}
