/** Maximum UTF-8 payload bytes permitted in one JSON-line RPC message. */
export const MAX_RPC_LINE_BYTES = 1_048_576;

export interface BoundedLineReaderOptions {
  readonly onLine: (line: string) => void;
  readonly onError: (error: Error) => void;
  readonly maxBytes?: number;
}

/**
 * Attaches a byte-bounded JSON-line reader to a stream.
 *
 * Complete lines are decoded only after their byte payload has been bounded,
 * preserving UTF-8 code points split across stream chunks.
 */
export function attachBoundedLineReader(
  stream: NodeJS.ReadableStream,
  { onLine, onError, maxBytes = MAX_RPC_LINE_BYTES }: BoundedLineReaderOptions,
): () => void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer.");
  }

  let active = true;
  let bufferedBytes = 0;
  let fragments: Buffer[] = [];

  const clear = (): void => {
    bufferedBytes = 0;
    fragments = [];
  };

  const detach = (): void => {
    if (!active) return;
    active = false;
    clear();
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
  };

  const takeLine = (stripTrailingCarriageReturn: boolean): string => {
    const line = fragments.length === 0
      ? Buffer.alloc(0)
      : fragments.length === 1
        ? fragments[0]!
        : Buffer.concat(fragments, bufferedBytes);
    clear();
    const payload = stripTrailingCarriageReturn && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    return payload.toString("utf8");
  };

  const rejectOversize = (): void => {
    if (!active) return;
    detach();
    onError(new Error(`RPC line exceeds ${maxBytes} bytes.`));
  };

  const onData = (value: Buffer | string): void => {
    if (!active) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    let offset = 0;

    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      if (bufferedBytes + length > maxBytes) {
        rejectOversize();
        return;
      }

      if (length > 0) {
        fragments.push(chunk.subarray(offset, end));
        bufferedBytes += length;
      }

      if (newline === -1) return;

      onLine(takeLine(true));
      if (!active) return;
      offset = newline + 1;
    }
  };

  const onEnd = (): void => {
    if (!active) return;
    const finalLine = bufferedBytes === 0 ? undefined : takeLine(false);
    detach();
    if (finalLine !== undefined) onLine(finalLine);
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return detach;
}
