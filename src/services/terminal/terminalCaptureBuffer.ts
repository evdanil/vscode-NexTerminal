import * as vscode from "vscode";
import { createAnsiRegex } from "../../utils/ansi";

const ANSI_RE = createAnsiRegex();
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const SCROLLBACK_SECTION = "terminal.integrated";
const SCROLLBACK_KEY = "scrollback";
const DEFAULT_MAX_LINES = 1000;
/**
 * Cap on the unterminated trailing line held in `pending`.
 *
 * `maxLines` bounds completed lines, but output that never emits a `\n` — a
 * full-screen program addressing the cursor (htop, watch, vim), or a `\r`-only
 * progress bar — all lands in `pending`, which had no bound at all. Every
 * `append()` re-concatenates and re-splits that string, so an unbounded
 * `pending` is both a session-lifetime memory leak and a per-chunk cost that
 * grows with it (measured: 0.6 ms per 2 KB chunk at 1 MB pending, 64 ms at
 * 64 MB). Capping it keeps `append()` flat.
 *
 * The tail is what is kept: for cursor-addressed output the most recent bytes
 * are the ones that describe the current screen, and for a progress bar they
 * are the current state. 64 KiB is far past any real terminal line while still
 * making the per-append copy trivial.
 */
const MAX_PENDING_CHARS = 65536;

export interface TerminalCaptureBufferOptions {
  maxLines?: number;
}

function readScrollbackSetting(): number {
  const value = vscode.workspace.getConfiguration(SCROLLBACK_SECTION).get<number>(SCROLLBACK_KEY);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_LINES;
}

export class TerminalCaptureBuffer {
  private lines: string[] = [];
  private pending = "";
  private maxLines: number;
  private readonly configSubscription: vscode.Disposable;

  public constructor(options: TerminalCaptureBufferOptions = {}) {
    this.maxLines = options.maxLines ?? readScrollbackSetting();
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SCROLLBACK_SECTION}.${SCROLLBACK_KEY}`)) {
        this.setMaxLines(readScrollbackSetting());
      }
    });
  }

  public append(data: string): void {
    ANSI_RE.lastIndex = 0;
    CONTROL_CHAR_RE.lastIndex = 0;
    const stripped = data.replace(ANSI_RE, "").replace(CONTROL_CHAR_RE, "");
    if (stripped.length === 0) return;
    const combined = this.pending + stripped;
    const segments = combined.split("\n");
    this.pending = this.capPending(segments.pop() ?? "");
    for (const line of segments) {
      this.lines.push(line);
    }
    this.trim();
  }

  public clear(): void {
    this.lines = [];
    this.pending = "";
  }

  public getText(): string {
    if (this.pending.length === 0) {
      return this.lines.join("\n");
    }
    if (this.lines.length === 0) {
      return this.pending;
    }
    return `${this.lines.join("\n")}\n${this.pending}`;
  }

  public lineCount(): number {
    return this.lines.length + (this.pending.length > 0 ? 1 : 0);
  }

  public setMaxLines(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.maxLines = Math.floor(n);
    this.trim();
  }

  public dispose(): void {
    this.configSubscription.dispose();
    this.clear();
  }

  /** Keep only the last MAX_PENDING_CHARS of an unterminated line. */
  private capPending(pending: string): string {
    if (pending.length <= MAX_PENDING_CHARS) {
      return pending;
    }
    const tail = pending.slice(pending.length - MAX_PENDING_CHARS);
    // Do not start the retained tail on an orphaned low surrogate — that would
    // put a lone half of an astral character at the head of getText().
    const first = tail.charCodeAt(0);
    return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
  }

  private trim(): void {
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }
}
