export type TranscriptLineEndingMode = "preserve" | "lf";

export function normalizeTranscriptLineEndingMode(value: unknown): TranscriptLineEndingMode {
  return value === "lf" ? "lf" : "preserve";
}

/** CRLF can cross receive chunks and disk drains; a lone CR must still survive. */
export class TranscriptLineEndings {
  private pendingCarriageReturn = false;

  public constructor(private readonly mode: TranscriptLineEndingMode) {}

  public format(text: string): string {
    if (this.mode === "preserve" || !text) return text;
    const prefix = this.pendingCarriageReturn && !text.startsWith("\n") ? "\r" : "";
    this.pendingCarriageReturn = text.endsWith("\r");
    const complete = this.pendingCarriageReturn ? text.slice(0, -1) : text;
    return prefix + complete.replace(/\r\n/g, "\n");
  }

  /** End a transport or transcript without discarding its undecided last byte. */
  public finish(): string {
    const tail = this.pendingCarriageReturn ? "\r" : "";
    this.pendingCarriageReturn = false;
    return tail;
  }
}
