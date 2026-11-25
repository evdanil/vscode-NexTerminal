export type TranscriptLineEndingMode = "preserve" | "lf";

export function normalizeTranscriptLineEndingMode(value: unknown): TranscriptLineEndingMode {
  return value === "lf" ? "lf" : "preserve";
}

/**
 * Output is untrusted: an unbounded hold would let a host build up a run that
 * resolves as one huge string. A real line ending needs only a few.
 */
const MAX_HELD_CARRIAGE_RETURNS = 1024;

/**
 * LF mode saves CRLF as LF, also when the device repeats the CR before the LF
 * (CR CR LF). The run can cross receive chunks and disk drains, so trailing CRs
 * are held as a count: if no LF follows, every one of them must survive. The
 * hold is bounded; CRs past it are written as received, never dropped, and a
 * later LF collapses only those not yet written.
 */
export class TranscriptLineEndings {
  private pendingCarriageReturns = 0;

  public constructor(private readonly mode: TranscriptLineEndingMode) {}

  public format(text: string): string {
    if (this.mode === "preserve" || !text) return text;
    let end = text.length;
    while (end > 0 && text[end - 1] === "\r") end -= 1;
    // Only CRs extend the held run; anything else decides it.
    const decided = end > 0 ? this.finish() + text.slice(0, end) : "";
    const run = this.pendingCarriageReturns + text.length - end;
    this.pendingCarriageReturns = Math.min(run, MAX_HELD_CARRIAGE_RETURNS);
    const complete = decided + "\r".repeat(run - this.pendingCarriageReturns);
    // Output is untrusted: `\r+\n` here, or `\r*$` for the scan above, would
    // make a long run without an LF retry from every CR.
    return complete.replace(/\r+\n?/g, (ending) => ending.endsWith("\n") ? "\n" : ending);
  }

  /** End a transport or transcript without discarding its undecided last CRs. */
  public finish(): string {
    const tail = "\r".repeat(this.pendingCarriageReturns);
    this.pendingCarriageReturns = 0;
    return tail;
  }
}
