import { normalizeFolderPath } from "./folderPaths";
import type { ImportedSession, ImportParseResult } from "./mobaxtermParser";

export interface InventoryParseOptions {
  defaultUsername?: string;
  defaultPort?: number; // defaults to 22
  defaultFolder?: string; // prefix applied to every row's folder
}

export interface InventoryParseIssue {
  line: number;
  text: string;
  reason: string;
}

export interface InventoryParseResult extends ImportParseResult {
  issues: InventoryParseIssue[];
  /** true when at least one row resolved without an explicit username */
  needsDefaultUsername: boolean;
  /** count of rows that resolved without an explicit username (0 when needsDefaultUsername is false) */
  missingUsernameCount: number;
  /** rows dropped past the MAX_DATA_ROWS cap (0 when the input was not truncated) */
  truncatedCount: number;
}

type HeaderRole = "host" | "name" | "username" | "port" | "folder";
type DelimiterKind = "," | "\t" | "ws";

interface Row {
  line: number;
  text: string;
}

interface PositionalFields {
  host: string;
  name: string;
  username: string;
  port: string;
  folder: string;
}

interface HostShorthand {
  host: string;
  username?: string;
  port?: number;
  /**
   * Raw text after a trailing colon that looked like an attempted port but failed
   * isPortLike (out of range or non-numeric); also set for any non-empty text
   * trailing a bracketed IPv6 literal's closing `]` that isn't a `:port` at all
   * (e.g. "[::1]junk"). Only set when the host side is unambiguous — a bare,
   * unsuffixed host (bracketed or not) is left untouched. Surfaced by the caller
   * as an invalid-port issue instead of silently folding "host:garbage" (or
   * "[ipv6]garbage") into HOST_RE's colon-tolerant hostname grammar (which
   * exists only to permit literal IPv6 addresses).
   */
  invalidPortSuffix?: string;
}

interface HeaderDetection {
  map: Partial<Record<HeaderRole, number>>;
  /**
   * True when the only signal for header detection was a single column whose
   * sole field is an exact host-alias match (e.g. a lone "hostname" row) — this
   * is equally consistent with a real device literally named that. Surfaced to
   * the caller as an issue rather than silently dropping the row.
   */
  ambiguousSingleColumn: boolean;
}

export const MAX_DATA_ROWS = 5000;
const MAX_HOST_LENGTH = 253;
const MAX_NAME_LENGTH = 128;
// Header detection + the "look like data" veto below need at least one extra
// row beyond the cap to still tell "truncated" from "exactly at the cap", and
// one more to allow for the header itself — never used for the actual data.
const ROW_COLLECTION_LIMIT = MAX_DATA_ROWS + 2;
const HOST_RE = /^[A-Za-z0-9._:\-[\]%_]+$/;

const HEADER_ROLES: HeaderRole[] = ["host", "name", "username", "port", "folder"];

const HEADER_ALIASES: Record<HeaderRole, string[]> = {
  host: ["host", "hostname", "address", "ip", "ipaddress", "mgmtip"],
  name: ["name", "label", "device", "devicename", "alias"],
  username: ["user", "username", "login"],
  port: ["port", "sshport"],
  folder: ["folder", "group", "site", "location"]
};

function isPortLike(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return false;
  }
  const n = parseInt(trimmed, 10);
  return n >= 1 && n <= 65_535;
}

/** Quote-aware split: a `"` starting an otherwise-empty field opens quoting; `""` unescapes to `"`. */
function splitCsvLike(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' && current.trim() === "") {
      current = "";
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function pickDelimiter(lineText: string): DelimiterKind {
  if (lineText.includes(",")) {
    return ",";
  }
  if (lineText.includes("\t")) {
    return "\t";
  }
  return "ws";
}

function cleanField(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function splitFields(lineText: string, delimiter: DelimiterKind): string[] {
  if (delimiter === "ws") {
    // Two-or-more whitespace chars act as a column separator; a lone space stays
    // inside a field so "First Last" survives as one name column.
    return lineText.split(/\s{2,}/);
  }
  if (delimiter === "\t") {
    // Tab-aligned exports pad columns with runs of tabs; collapse them like the
    // whitespace delimiter does. Unlike commas, a run of tabs is never meant to
    // encode an empty field.
    return lineText.split(/\t+/);
  }
  return splitCsvLike(lineText, delimiter);
}

function normalizeHeaderToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "");
}

/**
 * Detect a header row. One field matching a host alias exactly is the minimum
 * signal. With two or more alias matches across any role, that is treated as
 * decisive on its own (real device data coincidentally matching two header
 * words is vanishingly unlikely) — this lets header columns with punctuation
 * in their own name (e.g. "mgmt.ip", "ip:port") coexist with an unrecognized
 * column, without that punctuation being mistaken for a data value. With only
 * one alias match (just the host column), fall back to checking whether any
 * field looks like an actual data value (dot, @, colon, all-digit).
 */
function detectHeader(fields: string[]): HeaderDetection | undefined {
  const normalized = fields.map((f) => normalizeHeaderToken(f));

  let aliasMatchCount = 0;
  let hostAliasMatched = false;
  for (const token of normalized) {
    for (const role of HEADER_ROLES) {
      if (HEADER_ALIASES[role].includes(token)) {
        aliasMatchCount++;
        if (role === "host") {
          hostAliasMatched = true;
        }
        break;
      }
    }
  }
  if (!hostAliasMatched) {
    return undefined;
  }

  if (aliasMatchCount < 2) {
    const looksLikeDataField = fields.some((f) => {
      const trimmed = f.trim();
      return trimmed.includes(".") || trimmed.includes("@") || trimmed.includes(":") || /^\d+$/.test(trimmed);
    });
    if (looksLikeDataField) {
      return undefined;
    }
  }

  const map: Partial<Record<HeaderRole, number>> = {};
  fields.forEach((raw, idx) => {
    const token = normalizeHeaderToken(raw);
    for (const role of HEADER_ROLES) {
      if (map[role] !== undefined) {
        continue;
      }
      if (HEADER_ALIASES[role].includes(token)) {
        map[role] = idx;
        break;
      }
    }
  });
  return { map, ambiguousSingleColumn: fields.length === 1 };
}

/** Positional fallback: `host[,name[,username[,port[,folder]]]]`, tolerating `host,port` and `host,name,port`. */
function resolvePositional(fields: string[]): PositionalFields {
  const host = fields[0] ?? "";
  if (fields.length >= 5) {
    return { host, name: fields[1] ?? "", username: fields[2] ?? "", port: fields[3] ?? "", folder: fields[4] ?? "" };
  }
  if (fields.length === 4) {
    return { host, name: fields[1] ?? "", username: fields[2] ?? "", port: fields[3] ?? "", folder: "" };
  }
  if (fields.length === 3) {
    if (isPortLike(fields[2])) {
      return { host, name: fields[1] ?? "", username: "", port: fields[2], folder: "" };
    }
    return { host, name: fields[1] ?? "", username: fields[2] ?? "", port: "", folder: "" };
  }
  if (fields.length === 2) {
    if (isPortLike(fields[1])) {
      return { host, name: "", username: "", port: fields[1], folder: "" };
    }
    return { host, name: fields[1] ?? "", username: "", port: "", folder: "" };
  }
  return { host, name: "", username: "", port: "", folder: "" };
}

/**
 * Pulls `user@host:port` shorthand out of a raw host field. `[...]` around an
 * IPv6 literal is endpoint-notation input syntax only — it exists solely to
 * disambiguate the address's own colons from a trailing `:port` — so the
 * brackets are stripped here; the stored host is the bare literal a
 * hand-entered IPv6 server would use. Do not "restore" them later.
 */
function parseHostShorthand(raw: string): HostShorthand {
  let rest = raw;
  let username: string | undefined;
  const atIdx = rest.indexOf("@");
  if (atIdx > 0) {
    username = rest.slice(0, atIdx);
    rest = rest.slice(atIdx + 1);
  }
  if (rest.startsWith("[")) {
    const closeIdx = rest.indexOf("]");
    if (closeIdx !== -1) {
      const host = rest.slice(1, closeIdx);
      const remainder = rest.slice(closeIdx + 1);
      if (remainder === "") {
        return { host, username };
      }
      if (remainder.startsWith(":")) {
        const portPart = remainder.slice(1);
        if (isPortLike(portPart)) {
          return { host, username, port: parseInt(portPart, 10) };
        }
        return { host, username, invalidPortSuffix: portPart };
      }
      // Non-empty remainder that isn't even a ":port" attempt (e.g. "[::1]junk") —
      // same invalid-port treatment as a malformed numeric suffix, rather than
      // silently discarding it.
      return { host, username, invalidPortSuffix: remainder };
    }
  }
  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx > 0) {
    const hostPart = rest.slice(0, colonIdx);
    const portPart = rest.slice(colonIdx + 1);
    if (!hostPart.includes(":")) {
      if (isPortLike(portPart)) {
        return { host: hostPart, username, port: parseInt(portPart, 10) };
      }
      // Single colon, host side has no further colons: this is a malformed
      // host:port attempt, not a literal hostname — flag it rather than falling
      // through to `return { host: rest, ... }`, which HOST_RE would silently accept
      // (it allows colons so bare/bracketed IPv6 literals still pass).
      return { host: hostPart, username, invalidPortSuffix: portPart };
    }
  }
  return { host: rest, username };
}

function firstDnsLabel(host: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host;
  }
  const dotIdx = host.indexOf(".");
  return dotIdx === -1 ? host : host.slice(0, dotIdx);
}

function joinFolderSegments(prefix: string | undefined, rowFolder: string): string {
  const segments: string[] = [];
  if (prefix && prefix.trim()) {
    segments.push(prefix.trim());
  }
  if (rowFolder && rowFolder.trim()) {
    segments.push(rowFolder.trim());
  }
  return segments.join("/");
}

/**
 * Parse a CSV export or plain hostname list into importable SSH sessions.
 *
 * Supports an optional header row (mapped by column-name aliases), a positional
 * `host[,name[,username[,port[,folder]]]]` fallback, and `user@host:port` shorthand
 * in the host field. Invalid or duplicate rows are reported as issues rather than
 * aborting the whole import.
 */
export function parseInventoryList(text: string, options: InventoryParseOptions = {}): InventoryParseResult {
  const defaultPort = options.defaultPort ?? 22;
  const defaultUsername = options.defaultUsername ?? "";

  const cleaned = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = cleaned.split("\n");

  // Collect at most ROW_COLLECTION_LIMIT rows: a paste with hundreds of
  // thousands of lines would otherwise retain every trimmed line (and its own
  // Row wrapper) just to slice it back down to MAX_DATA_ROWS a few lines later.
  // `totalNonBlankLines` is a plain counter so the true dropped-row count is
  // still exact even once we stop collecting.
  const rows: Row[] = [];
  let totalNonBlankLines = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    totalNonBlankLines++;
    if (rows.length < ROW_COLLECTION_LIMIT) {
      rows.push({ line: i + 1, text: trimmed });
    }
  }

  const sessions: ImportedSession[] = [];
  const issues: InventoryParseIssue[] = [];
  const folderSet = new Set<string>();
  const seen = new Map<string, number>();
  let skippedCount = 0;
  let needsDefaultUsername = false;
  let missingUsernameCount = 0;

  if (rows.length === 0) {
    return { sessions, skippedCount, folders: [], issues, needsDefaultUsername, missingUsernameCount, truncatedCount: 0 };
  }

  let dataRows = rows;
  let headerMap: Partial<Record<HeaderRole, number>> | undefined;
  const firstDelimiter = pickDelimiter(rows[0].text);
  const firstFields = splitFields(rows[0].text, firstDelimiter).map(cleanField);
  const detectedHeader = detectHeader(firstFields);
  if (detectedHeader) {
    headerMap = detectedHeader.map;
    dataRows = rows.slice(1);
    if (detectedHeader.ambiguousSingleColumn) {
      issues.push({
        line: rows[0].line,
        text: rows[0].text,
        reason:
          `ambiguous header row: "${rows[0].text}" matches a known host column name and was treated as a header, ` +
          "not a device; add a second column if this is meant to be a real host"
      });
    }
  }

  const headerRowCount = headerMap ? 1 : 0;
  const totalDataLineCount = totalNonBlankLines - headerRowCount;
  const truncated = totalDataLineCount > MAX_DATA_ROWS;
  const truncatedCount = truncated ? totalDataLineCount - MAX_DATA_ROWS : 0;
  const rowsToProcess = dataRows.slice(0, MAX_DATA_ROWS);

  for (const row of rowsToProcess) {
    const delimiter = pickDelimiter(row.text);
    const fields = splitFields(row.text, delimiter).map(cleanField);

    let hostRaw: string;
    let nameRaw: string;
    let usernameRaw: string;
    let portRaw: string;
    let folderRaw: string;

    if (headerMap) {
      hostRaw = headerMap.host !== undefined ? fields[headerMap.host] ?? "" : "";
      nameRaw = headerMap.name !== undefined ? fields[headerMap.name] ?? "" : "";
      usernameRaw = headerMap.username !== undefined ? fields[headerMap.username] ?? "" : "";
      portRaw = headerMap.port !== undefined ? fields[headerMap.port] ?? "" : "";
      folderRaw = headerMap.folder !== undefined ? fields[headerMap.folder] ?? "" : "";
    } else {
      const positional = resolvePositional(fields);
      hostRaw = positional.host;
      nameRaw = positional.name;
      usernameRaw = positional.username;
      portRaw = positional.port;
      folderRaw = positional.folder;
    }

    const shorthand = parseHostShorthand(hostRaw.trim());
    if (shorthand.invalidPortSuffix !== undefined) {
      issues.push({ line: row.line, text: row.text, reason: `invalid port "${shorthand.invalidPortSuffix}"` });
      skippedCount++;
      continue;
    }
    const host = shorthand.host;

    if (!host) {
      issues.push({ line: row.line, text: row.text, reason: `invalid host "${hostRaw.trim()}"` });
      skippedCount++;
      continue;
    }
    if (host.length > MAX_HOST_LENGTH) {
      issues.push({ line: row.line, text: row.text, reason: `host exceeds ${MAX_HOST_LENGTH} characters` });
      skippedCount++;
      continue;
    }
    if (!HOST_RE.test(host)) {
      issues.push({ line: row.line, text: row.text, reason: `invalid host "${hostRaw.trim()}"` });
      skippedCount++;
      continue;
    }

    const explicitPort = portRaw.trim();
    let port: number;
    if (explicitPort !== "") {
      if (!isPortLike(explicitPort)) {
        issues.push({ line: row.line, text: row.text, reason: `invalid port "${explicitPort}"` });
        skippedCount++;
        continue;
      }
      port = parseInt(explicitPort, 10);
    } else if (shorthand.port !== undefined) {
      port = shorthand.port;
    } else {
      port = defaultPort;
    }

    const explicitUsername = usernameRaw.trim();
    const hadExplicitUsername = explicitUsername !== "" || shorthand.username !== undefined;
    const username = explicitUsername || shorthand.username || defaultUsername;

    const name = nameRaw.trim() || firstDnsLabel(host);
    if (name.length > MAX_NAME_LENGTH) {
      issues.push({ line: row.line, text: row.text, reason: `name exceeds ${MAX_NAME_LENGTH} characters` });
      skippedCount++;
      continue;
    }

    const folderJoined = joinFolderSegments(options.defaultFolder, folderRaw);
    let folder = "";
    if (folderJoined) {
      const normalizedFolder = normalizeFolderPath(folderJoined);
      if (normalizedFolder === undefined) {
        issues.push({ line: row.line, text: row.text, reason: `invalid folder "${folderJoined}"` });
        skippedCount++;
        continue;
      }
      folder = normalizedFolder;
    }

    const key = `${host.toLowerCase()}|${port}|${username}`;
    const duplicateOfLine = seen.get(key);
    if (duplicateOfLine !== undefined) {
      issues.push({ line: row.line, text: row.text, reason: `duplicate of line ${duplicateOfLine}` });
      skippedCount++;
      continue;
    }
    seen.set(key, row.line);

    if (!hadExplicitUsername) {
      needsDefaultUsername = true;
      missingUsernameCount++;
    }
    if (folder) {
      folderSet.add(folder);
    }

    sessions.push({ name, host, port, username, folder });
  }

  if (truncated) {
    const firstSkippedRow = dataRows[MAX_DATA_ROWS];
    const firstSkippedLine = firstSkippedRow?.line ?? rows[rows.length - 1].line;
    issues.push({
      line: firstSkippedLine,
      text: "",
      reason: `input truncated at ${MAX_DATA_ROWS} rows (${truncatedCount} row(s) ignored)`
    });
  }

  return {
    sessions,
    skippedCount,
    folders: [...folderSet].sort(),
    issues,
    needsDefaultUsername,
    missingUsernameCount,
    truncatedCount
  };
}
