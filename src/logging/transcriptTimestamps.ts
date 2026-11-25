export type TranscriptTimestampMode = "local" | "utc" | "off";

/** Keep malformed hand-edited settings from silently disabling the default. */
export function normalizeTranscriptTimestampMode(value: unknown): TranscriptTimestampMode {
  return value === "utc" || value === "off" ? value : "local";
}

function timestampPrefix(mode: "local" | "utc"): string {
  const now = new Date();
  if (mode === "utc") {
    return `${now.toISOString().replace("T", " ")} `;
  }
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const offset = now.getTimezoneOffset();
  const magnitude = Math.abs(offset);
  const zone = `${offset <= 0 ? "+" : "-"}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`;
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}${zone} `;
}

/**
 * Prefix at receipt rather than drain time. Only line-boundary state is kept:
 * a prompt or an arbitrarily long unterminated line must never wait in memory
 * for a newline. A run of CRs with an optional LF is one boundary even when
 * split between writes: firmware that prints CRLF through a driver that expands
 * LF again sends CR CR LF, and a stamp inside the run would add a false line.
 */
export class TranscriptLineTimestamps {
  private atLineStart = true;
  private afterCarriageReturn = false;

  public constructor(private readonly mode: TranscriptTimestampMode) {}

  public format(text: string): string {
    if (this.mode === "off" || !text) return text;
    const mode = this.mode;
    let prefix: string | undefined;
    const stamp = (): string => prefix ??= timestampPrefix(mode);
    const parts: string[] = [];
    let start = this.afterCarriageReturn ? /^\r*\n?/.exec(text)![0].length : 0;
    if (start > 0) parts.push(text.slice(0, start));
    this.afterCarriageReturn = text.endsWith("\r");

    // Output is untrusted: the LF must stay optional, because a required one
    // (`\r+\n`) makes a long run without it retry from every CR.
    const endings = /\r+\n?|\n/g;
    endings.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(text)) !== null) {
      const end = endings.lastIndex;
      if (this.atLineStart) parts.push(stamp());
      parts.push(text.slice(start, end));
      this.atLineStart = true;
      start = end;
    }
    if (start < text.length) {
      if (this.atLineStart) parts.push(stamp());
      parts.push(text.slice(start));
      this.atLineStart = false;
    }
    return parts.join("");
  }

  /** A new transport cannot continue the old one's CR run, but an open line stays open. */
  public endCarriageReturnRun(): void {
    this.afterCarriageReturn = false;
  }
}
