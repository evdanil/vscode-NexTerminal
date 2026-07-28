/**
 * promptPathHeuristic — extract a directory candidate from a rendered,
 * ANSI-stripped prompt line (S2, §4).
 *
 * Pure string in / candidate out. This module MUST NOT import `vscode`.
 * Never throws — any unexpected shape simply yields `undefined` ("no
 * candidate"), which the caller (§4/S2) treats as "fall back to the
 * prefilled Go-to-Path box", never as a wrong guess (R3).
 *
 * Recognised at minimum (§10):
 *  - Debian/Ubuntu default bash `\u@\h:\w\$ ` — e.g. `user@host:/var/log$ `
 *    or `user@host:~/work$ ` (the `\w` form — a real path, possibly `~`-relative).
 *  - Root's `#` terminator instead of `$`.
 *  - A trailing space after the terminator, or none.
 *  - The bracketed Fedora/RHEL form `[user@host log]$ ` (bash's `\W` — a
 *    *basename only*). This is intentionally NOT resolvable from the prompt
 *    text alone (no way to recover the parent directory), so it always
 *    returns `undefined` — that "no candidate" outcome is deliberate and
 *    covered by a dedicated test, not an accidental non-match.
 *
 * A prompt line that has trailing text after the terminator (the user is
 * mid-typing a command) is deliberately NOT matched — matching a stale or
 * unrelated fragment would risk a wrong-directory guess (R3). Use
 * `extractLatestPromptPath` to search backward through scrollback for the
 * most recent line that is a *bare* prompt.
 */

import * as path from "node:path";

/** NUL + all C0 control characters, including the newline family. */
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

/**
 * Debian/Ubuntu default `\u@\h:\w\$ ` prompt: `user@host:<path>$ ` or
 * `user@host:<path># ` (root), optional trailing whitespace, nothing after
 * the terminator. `<path>` may be `~`, `~/relative`, or an absolute path.
 */
const DEBIAN_PROMPT_RE = /^\s*[^\s@]+@[^\s:]+:([^\s]+?)\s*([$#])\s*$/;

/**
 * Fedora/RHEL bracketed `\W` prompt: `[user@host basename]$ ` /
 * `[root@host basename]# `. The captured directory is a basename only —
 * not resolvable to an absolute path without additional context — so a
 * match here always yields `undefined`.
 */
const BRACKET_PROMPT_RE = /^\s*\[[^\s@]+@[^\s\]]+\s+[^\s\]]+\]\s*[$#]\s*$/;

/**
 * Extract an absolute POSIX directory candidate from a single rendered
 * prompt line, or `undefined` if none can be resolved.
 *
 * @param line - one ANSI-stripped line of terminal output.
 * @param homeDir - the session's home directory (from `sftp.realpath(".")`),
 *   or `undefined` if it is not yet known. Required to expand a leading `~`;
 *   a `~`-relative prompt with an unknown home directory yields `undefined`
 *   rather than a guess.
 */
export function extractPromptPath(line: string, homeDir: string | undefined): string | undefined {
  try {
    if (typeof line !== "string" || line.length === 0) return undefined;

    if (BRACKET_PROMPT_RE.test(line)) {
      // Recognised prompt shape, but `\W` gives a basename only — explicitly
      // not resolvable on its own (see module header).
      return undefined;
    }

    const match = DEBIAN_PROMPT_RE.exec(line);
    if (!match) return undefined;

    const rawPath = match[1];
    const expanded = expandHome(rawPath, homeDir);
    if (!expanded) return undefined;

    return normalizeAbsolutePosixPath(expanded);
  } catch {
    return undefined;
  }
}

/**
 * Pull the most recent prompt-looking line out of a multi-line scrollback
 * blob (e.g. `TerminalCaptureBuffer.getText()`), searching from the end so
 * that a currently-in-progress command line (which will not match a bare
 * prompt pattern) does not shadow the last genuine prompt.
 */
export function extractLatestPromptPath(blob: string, homeDir: string | undefined): string | undefined {
  try {
    if (typeof blob !== "string" || blob.length === 0) return undefined;

    const lines = blob.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = extractPromptPath(lines[i], homeDir);
      if (candidate) return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function expandHome(rawPath: string, homeDir: string | undefined): string | undefined {
  if (rawPath === "~") {
    return homeDir;
  }
  if (rawPath.startsWith("~/")) {
    if (!homeDir) return undefined;
    const base = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
    return `${base}/${rawPath.slice(2)}`;
  }
  return rawPath;
}

/** Same shape of check as `osc7Parser.ts`'s local `normalizeRemoteDir`-alike. */
function normalizeAbsolutePosixPath(candidate: string): string | undefined {
  if (!candidate || candidate.includes("\0") || CONTROL_CHAR_RE.test(candidate)) return undefined;
  const normalized = path.posix.normalize(candidate);
  if (!normalized.startsWith("/")) return undefined;
  return normalized;
}
