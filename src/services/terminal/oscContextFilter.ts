/**
 * OscContextFilter — strips OSC 3008 "systemd context" escape sequences.
 *
 * Ubuntu 26.04 / systemd 258 emits, before every prompt:
 *   ESC ] 3008 ; <payload> ST
 * where ST is either ESC \ (two bytes) or BEL (one byte).
 *
 * The sequence may arrive split across multiple SSH read chunks. This class
 * buffers a trailing partial across calls so that split sequences are always
 * removed completely and no garbage leaks into the terminal renderer.
 *
 * Other OSC types (0, 2, 7, 8, 9, 133 …) are passed through untouched.
 * CSI sequences and plain text pass through with zero modification.
 */

const OPEN = "\x1b]3008;";
const BEL = "\x07";
const ESC = "\x1b";

/** Maximum bytes held in carry before we abandon and emit as-is. */
const MAX_CARRY = 4096;

export class OscContextFilter {
  private carry = "";

  /**
   * Filter `input`, removing any complete OSC 3008 sequences and buffering
   * any trailing partial that could still become one.  Returns the filtered
   * text that is safe to pass downstream.
   */
  public filter(input: string): string {
    let buf = this.carry + input;
    this.carry = "";

    let output = "";

    while (true) {
      const opIdx = buf.indexOf(OPEN);

      if (opIdx === -1) {
        // No opener found — check for an ambiguous trailing prefix
        const tail = trailingOpenPrefix(buf);
        if (tail > 0) {
          output += buf.slice(0, buf.length - tail);
          this.carry = buf.slice(buf.length - tail);
        } else {
          output += buf;
        }
        break;
      }

      // Emit everything before the opener
      output += buf.slice(0, opIdx);
      buf = buf.slice(opIdx); // buf now starts with OPEN

      // Search for the terminator after the opener
      const searchFrom = OPEN.length;
      const result = findTerminator(buf, searchFrom);

      if (result.kind === "found") {
        // Drop the whole sequence [0, terminatorEnd)
        buf = buf.slice(result.end);
        continue;
      }

      if (result.kind === "stray-esc") {
        // A bare ESC inside the potential sequence that is NOT followed by \
        // and is not at the very end of buf. Strip up to (but not including) the stray ESC.
        buf = buf.slice(result.strayEscIndex);
        continue;
      }

      // result.kind === "incomplete" — no terminator found before end-of-buf
      // Hold the entire remainder as carry
      this.carry = buf;
      buf = "";
      break;
    }

    // Cap: never buffer more than MAX_CARRY
    if (this.carry.length > MAX_CARRY) {
      output += this.carry;
      this.carry = "";
    }

    return output;
  }

  /**
   * Drop any buffered partial (call on stream teardown).
   */
  public reset(): void {
    this.carry = "";
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

type TerminatorResult =
  | { kind: "found"; end: number }
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
      // BEL terminates the sequence
      return { kind: "found", end: i + 1 };
    }

    if (ch === ESC) {
      if (i + 1 < buf.length) {
        if (buf[i + 1] === "\\") {
          // ESC \ — the canonical ST
          return { kind: "found", end: i + 2 };
        }
        // ESC followed by something other than \ — this is a stray escape
        // that interrupts the OSC; strip up to (not including) this ESC.
        return { kind: "stray-esc", strayEscIndex: i };
      }
      // ESC is the very last byte of buf — could still be the start of ST
      // Hold everything (incomplete)
      return { kind: "incomplete" };
    }
  }

  // Reached end of buf with no terminator
  return { kind: "incomplete" };
}

/**
 * Return the length of a trailing substring of `buf` that is a genuine
 * non-empty prefix of OPEN beginning with ESC.
 *
 * "Genuine prefix" means the string matches OPEN character-for-character from
 * position 0.  If any character has already diverged from OPEN (e.g. the
 * sequence is \x1b]0;title) we return 0 — diverged sequences must not be held
 * beyond one additional chunk.
 */
function trailingOpenPrefix(buf: string): number {
  // Walk backward from the end looking for the longest possible prefix of OPEN
  // that ends at buf's last character and starts with ESC.
  //
  // The longest candidate is min(buf.length, OPEN.length - 1) characters.
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
