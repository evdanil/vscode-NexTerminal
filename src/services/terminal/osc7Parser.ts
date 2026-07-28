/**
 * Osc7Parser — chunk-boundary-safe scanner that *extracts* `ESC ] 7 ; <uri> ST`
 * (OSC 7, "report cwd") sequences from ssh2 output, where ST is either
 * `ESC \` (two bytes) or `BEL` (one byte).
 *
 * Unlike `OscContextFilter` (which strips OSC 3008 and returns the remaining
 * passthrough text), this parser does not modify or return passthrough text
 * at all — it is a side-channel observer that reports the OSC 7 payloads it
 * finds and lets every byte flow downstream untouched. The carry/partial-
 * sequence bookkeeping is modelled directly on `oscContextFilter.ts`: a
 * trailing partial that could still become a complete sequence is buffered
 * across `feed()` calls, capped at `MAX_CARRY` so a malformed/never-closed
 * sequence cannot make this hold memory forever.
 *
 * This module MUST NOT import `vscode` (§5.1) — it runs inside the ssh2
 * `data` handler and must be usable from a plain unit test.
 *
 * **Total by construction (§6.6):** every parse step that can throw on
 * attacker-controlled bytes — `new URL()` on malformed input, `decodeURIComponent`
 * on a malformed percent-escape — is wrapped in try/catch. A sequence that
 * fails validation at any step simply contributes no match; `feed()` itself
 * never throws.
 */

import * as path from "node:path";

const OPEN = "\x1b]7;";
const BEL = "\x07";
const ESC = "\x1b";

/** Maximum bytes held in carry before we abandon the in-flight sequence. */
const MAX_CARRY = 4096;

/** Decoded-path length cap (§7.1 step 5). */
const MAX_PATH_LENGTH = 4096;

/** NUL + all C0 control characters, including the newline family. */
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

/**
 * A validated OSC 7 report.
 *
 * `path` is an absolute, percent-decoded, `path.posix.normalize`d POSIX path.
 * `authority` is `new URL(...).hostname` — already lowercased by the URL
 * parser, empty string for `file:///…` or the WHATWG-special-cased
 * `file://localhost/…`. The tracker uses a change in `authority` between
 * reports for the same session as a staleness signal (§7.1/§7.5): it is a
 * heuristic, not a security boundary, since an attacker controls this value
 * too — see the module-level validation comments in `cwdTracker.ts`.
 */
export interface Osc7Match {
  path: string;
  authority: string;
}

export class Osc7Parser {
  private carry = "";

  /**
   * Feed a chunk of already-received terminal output. Returns any complete,
   * validated OSC 7 paths found in this chunk (in order); an empty array if
   * none were found or none validated. Never throws.
   */
  public feed(chunk: string): Osc7Match[] {
    let buf = this.carry + chunk;
    this.carry = "";

    const matches: Osc7Match[] = [];

    while (true) {
      const opIdx = buf.indexOf(OPEN);

      if (opIdx === -1) {
        // No opener found — check for an ambiguous trailing prefix.
        const tail = trailingOpenPrefix(buf);
        if (tail > 0) {
          this.carry = buf.slice(buf.length - tail);
        }
        break;
      }

      // Discard everything before the opener — we only ever report the
      // sequence's payload, never passthrough text.
      buf = buf.slice(opIdx); // buf now starts with OPEN

      const result = findTerminator(buf, OPEN.length);

      if (result.kind === "found") {
        const payload = buf.slice(OPEN.length, result.termStart);
        buf = buf.slice(result.end);
        const match = safeParsePayload(payload);
        if (match) matches.push(match);
        continue;
      }

      if (result.kind === "stray-esc") {
        // A bare ESC inside the potential sequence that is NOT followed by \
        // and is not at the very end of buf. Resume scanning from it — it
        // may itself be the start of the next sequence.
        buf = buf.slice(result.strayEscIndex);
        continue;
      }

      // result.kind === "incomplete" — no terminator found before end-of-buf.
      // Hold the entire remainder as carry.
      this.carry = buf;
      buf = "";
      break;
    }

    // Cap: never buffer more than MAX_CARRY (abandon the in-flight sequence).
    if (this.carry.length > MAX_CARRY) {
      this.carry = "";
    }

    return matches;
  }

  /** Drop any buffered partial (call on stream teardown / disconnect). */
  public reset(): void {
    this.carry = "";
  }
}

// ─── Payload validation (§7.1) ───────────────────────────────────────────────

/** Wraps the entire validation pipeline so a throw at any step yields "no match". */
function safeParsePayload(raw: string): Osc7Match | undefined {
  try {
    return parsePayload(raw);
  } catch {
    return undefined;
  }
}

function parsePayload(raw: string): Osc7Match | undefined {
  // Step 1 (payload extraction) already happened: OPEN is the literal
  // "\x1b]7;", so everything between it and ST is "everything after the
  // first ';'" by construction — a later literal ';' in the URI is part of
  // the payload, exactly as required.

  // Step 2: must parse as a URL with scheme file:. Note WHATWG rejects a
  // port in a file: URL — `new URL("file://localhost:22/tmp")` throws — so
  // that case is correctly rejected right here, not by a hostname check.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:") return undefined;

  // Step 3: `.pathname` is still percent-encoded. Do NOT use
  // `vscode.Uri.parse` here even in a caller — it decodes, and decoding
  // twice turns `%252e%252e%252f` into `../`.
  const encodedPath = url.pathname;

  // Step 4: decode exactly once.
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    // Malformed percent-escape (e.g. "%zz") — reject, never throw outward.
    return undefined;
  }

  // Step 5: reject NUL / C0 / newline; cap length.
  if (decoded.length > MAX_PATH_LENGTH) return undefined;
  if (CONTROL_CHAR_RE.test(decoded)) return undefined;

  // Steps 6-7: normalize, require a leading '/', and reject anything a
  // normalizeRemoteDir-style check would reject (empty, NUL, non-absolute
  // after normalize). Reimplemented locally rather than imported from
  // fileExplorerTreeProvider.ts, which pulls in `vscode` — this module must
  // stay vscode-free.
  const normalized = normalizeAbsolutePosixPath(decoded);
  if (!normalized) return undefined;

  return { path: normalized, authority: url.hostname };
}

/**
 * Local reimplementation of fileExplorerTreeProvider.ts's `normalizeRemoteDir`
 * (reject empty/NUL, `path.posix.normalize`, require a leading `/`). Kept in
 * this module instead of imported because that file imports `vscode`.
 */
function normalizeAbsolutePosixPath(candidate: string): string | undefined {
  if (!candidate || candidate.includes("\0")) return undefined;
  const normalized = path.posix.normalize(candidate);
  if (!normalized.startsWith("/")) return undefined;
  return normalized;
}

// ─── Internal scanning helpers (mirrors oscContextFilter.ts) ────────────────

type TerminatorResult =
  | { kind: "found"; termStart: number; end: number }
  | { kind: "stray-esc"; strayEscIndex: number }
  | { kind: "incomplete" };

/**
 * Search `buf` starting at `from` for a valid OSC terminator (BEL or ESC \).
 * The region before `from` is the OPEN literal; we're scanning the payload.
 */
function findTerminator(buf: string, from: number): TerminatorResult {
  for (let i = from; i < buf.length; i++) {
    const ch = buf[i];

    if (ch === BEL) {
      // BEL terminates the sequence.
      return { kind: "found", termStart: i, end: i + 1 };
    }

    if (ch === ESC) {
      if (i + 1 < buf.length) {
        if (buf[i + 1] === "\\") {
          // ESC \ — the canonical ST.
          return { kind: "found", termStart: i, end: i + 2 };
        }
        // ESC followed by something other than \ — this is a stray escape
        // that interrupts the OSC; strip up to (not including) this ESC.
        return { kind: "stray-esc", strayEscIndex: i };
      }
      // ESC is the very last byte of buf — could still be the start of ST.
      // Hold everything (incomplete).
      return { kind: "incomplete" };
    }
  }

  // Reached end of buf with no terminator.
  return { kind: "incomplete" };
}

/**
 * Return the length of a trailing substring of `buf` that is a genuine
 * non-empty prefix of OPEN beginning with ESC.
 *
 * "Genuine prefix" means the string matches OPEN character-for-character from
 * position 0. If any character has already diverged from OPEN, we return 0 —
 * diverged sequences must not be held beyond one additional chunk.
 */
function trailingOpenPrefix(buf: string): number {
  const maxLen = Math.min(buf.length, OPEN.length - 1);

  for (let len = maxLen; len >= 1; len--) {
    const candidate = buf.slice(buf.length - len);
    if (candidate[0] !== ESC) continue; // must start with ESC
    if (OPEN.startsWith(candidate)) {
      return len;
    }
  }

  return 0;
}
