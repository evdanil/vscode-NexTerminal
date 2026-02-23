import { XMLParser, XMLValidator } from "fast-xml-parser";
import { normalizeFolderPath } from "./folderPaths";
import type { ImportedSession, ImportParseResult } from "./mobaxtermParser";

export type { ImportedSession, ImportParseResult };

export interface SecureCrtFileEntry {
  name: string;
  folder: string;
  content: string;
}

interface SecureCrtXmlNamedEntry {
  "@_name"?: string;
  "#text"?: string | number;
}

interface SecureCrtXmlKeyNode {
  "@_name"?: string;
  key?: SecureCrtXmlKeyNode | SecureCrtXmlKeyNode[];
  string?: SecureCrtXmlNamedEntry | SecureCrtXmlNamedEntry[];
  dword?: SecureCrtXmlNamedEntry | SecureCrtXmlNamedEntry[];
}

interface SecureCrtXmlRoot {
  VanDyke?: {
    key?: SecureCrtXmlKeyNode | SecureCrtXmlKeyNode[];
  };
}

// Stateless between parse() calls; safe to reuse as a module singleton.
const secureCrtXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: false
});

function normalizePort(rawPort: number | undefined): number {
  if (rawPort === undefined) {
    return 22;
  }
  return Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65_535 ? rawPort : 22;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readNamedEntry(entries: SecureCrtXmlNamedEntry | SecureCrtXmlNamedEntry[] | undefined, name: string): string | undefined {
  for (const entry of toArray(entries)) {
    if (entry["@_name"] !== name) {
      continue;
    }
    const raw = entry["#text"];
    if (typeof raw === "string") {
      return raw;
    }
    if (typeof raw === "number") {
      return `${raw}`;
    }
    return "";
  }
  return undefined;
}

function normalizeXmlFolder(folderSegments: string[]): string {
  if (folderSegments.length === 0) {
    return "";
  }
  const limited = folderSegments.slice(0, 3).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  if (limited.length === 0) {
    return "";
  }
  return normalizeFolderPath(limited.join("/")) ?? "";
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

  const port = normalizePort(dwords.get("[SSH2] Port"));
  const username = (fields.get("Username") ?? "").trim() || "user";
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

/**
 * Parse a SecureCRT XML export (`SecureCRTSessions.xml`).
 *
 * Traverses `<key name="Sessions">` recursively and imports entries where:
 * - `dword[name="Is Session"]` is `1`
 * - `string[name="Protocol Name"]` starts with `SSH`
 * - `string[name="Hostname"]` is non-empty
 */
export function parseSecureCrtXmlExport(xmlText: string): ImportParseResult {
  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    throw new Error("Invalid XML format");
  }

  const root = secureCrtXmlParser.parse(xmlText) as SecureCrtXmlRoot;
  const topKeys = toArray(root.VanDyke?.key);
  const sessionsRoot = topKeys.find((node) => node["@_name"] === "Sessions");
  if (!sessionsRoot) {
    return { sessions: [], skippedCount: 0, folders: [] };
  }

  const sessions: ImportedSession[] = [];
  let skippedCount = 0;
  const folderSet = new Set<string>();

  function walk(node: SecureCrtXmlKeyNode, pathSegments: string[], depth = 0): void {
    if (depth > 50) return;
    const nodeName = (node["@_name"] ?? "").trim();
    const currentPath = nodeName.length > 0 ? [...pathSegments, nodeName] : pathSegments;

    const isSession = (readNamedEntry(node.dword, "Is Session") ?? "").trim() === "1";
    if (isSession) {
      const protocol = (readNamedEntry(node.string, "Protocol Name") ?? "").trim();
      const host = (readNamedEntry(node.string, "Hostname") ?? "").trim();
      if (!protocol.startsWith("SSH") || !host) {
        skippedCount++;
      } else {
        // XML stores ports as decimal text (unlike .ini files which use hex DWORDs)
        const rawPort = Number.parseInt((readNamedEntry(node.dword, "[SSH2] Port") ?? "").trim(), 10);
        const port = normalizePort(Number.isFinite(rawPort) ? rawPort : undefined);
        const username = (readNamedEntry(node.string, "Username") ?? "").trim() || "user";
        const folder = normalizeXmlFolder(currentPath.slice(0, -1));
        const sessionName = nodeName || host;
        sessions.push({ name: sessionName, host, port, username, folder });
        if (folder) {
          folderSet.add(folder);
        }
      }
    }

    for (const child of toArray(node.key)) {
      walk(child, currentPath, depth + 1);
    }
  }

  for (const child of toArray(sessionsRoot.key)) {
    walk(child, [], 0);
  }

  return {
    sessions,
    skippedCount,
    folders: [...folderSet].sort()
  };
}
