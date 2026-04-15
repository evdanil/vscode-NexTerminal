import { createAnsiRegex } from "../../utils/ansi";

export interface Match {
  text: string;
  groups: string[];
  before: string;
  /** Absolute writeHead position just past the end of the match — for advanceCursor. */
  endPosition: number;
}

export interface ScanOptions {
  /** Characters of pre-cursor output to include in the scan window. */
  lookback?: number;
}

export interface ScriptOutputBufferOptions {
  capacity?: number;
}

const DEFAULT_CAPACITY = 65_536;
const DEFAULT_FIRST_LOOKBACK = 1_024;

export class ScriptOutputBuffer {
  private readonly capacity: number;
  private text = "";
  /** Total characters ever appended (monotonic). */
  public writeHead = 0;
  /** Total-text position the next scan starts from. */
  public cursor = 0;
  private firstScan = true;
  private readonly subscribers = new Set<() => void>();

  public constructor(opts: ScriptOutputBufferOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
  }

  public append(raw: string): void {
    const stripped = raw.replace(createAnsiRegex(), "");
    if (stripped.length === 0) return;
    this.text += stripped;
    this.writeHead += stripped.length;
    if (this.text.length > this.capacity) {
      this.text = this.text.slice(this.text.length - this.capacity);
    }
    for (const cb of this.subscribers) cb();
  }

  public scan(pattern: string | RegExp, opts: ScanOptions = {}): Match | null {
    const defaultLookback = this.firstScan ? DEFAULT_FIRST_LOOKBACK : 0;
    const lookback = opts.lookback ?? defaultLookback;
    this.firstScan = false;

    const bufferStartPosition = this.writeHead - this.text.length;
    const desiredStartPosition = Math.max(
      bufferStartPosition,
      Math.max(0, this.cursor - lookback)
    );
    const offsetInText = desiredStartPosition - bufferStartPosition;
    const window = this.text.slice(offsetInText);
    if (window.length === 0) return null;

    const regex =
      typeof pattern === "string"
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        : pattern;
    const m = window.match(regex);
    if (!m || m.index === undefined) return null;

    const matchStart = desiredStartPosition + m.index;
    const matchEnd = matchStart + m[0].length;
    return {
      text: m[0],
      groups: m.slice(1).map((g) => g ?? ""),
      before: window.slice(0, m.index),
      endPosition: matchEnd
    };
  }

  public advanceCursor(to: number): void {
    if (to > this.cursor) this.cursor = to;
  }

  /**
   * Return the last `n` characters of stripped buffered output (ANSI already removed).
   * Caps at the live buffer length. Useful for error-diagnostic dumps when a
   * `waitFor` returns null and the script wants to see what *did* arrive.
   */
  public tail(n: number): string {
    if (n <= 0) return "";
    if (n >= this.text.length) return this.text;
    return this.text.slice(-n);
  }

  public subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }
}
