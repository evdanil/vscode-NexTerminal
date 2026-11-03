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
 * for a newline. CRLF remains one boundary even when split between writes.
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
    let start = 0;
    if (this.afterCarriageReturn && text.startsWith("\n")) {
      parts.push("\n");
      start = 1;
    }
    this.afterCarriageReturn = false;

    const endings = /\r\n|\r|\n/g;
    endings.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(text)) !== null) {
      const end = endings.lastIndex;
      if (this.atLineStart) parts.push(stamp());
      parts.push(text.slice(start, end));
      this.atLineStart = true;
      this.afterCarriageReturn = match[0] === "\r";
      start = end;
    }
    if (start < text.length) {
      if (this.atLineStart) parts.push(stamp());
      parts.push(text.slice(start));
      this.atLineStart = false;
      this.afterCarriageReturn = false;
    }
    return parts.join("");
  }
}
