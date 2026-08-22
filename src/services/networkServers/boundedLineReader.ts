/** Maximum UTF-8 payload bytes permitted in one JSON-line RPC message. */
export const MAX_RPC_LINE_BYTES = 1_048_576;

export interface BoundedLineReaderOptions {
  readonly onLine: (line: string) => void;
  /** Receives terminal framing violations; transport `error` events stay owned by the caller. */
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
  let lineBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let pendingBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let pendingBytes = 0;
  let processingBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let processing = false;
  let endQueued = false;

  const clear = (): void => {
    bufferedBytes = 0;
    pendingBytes = 0;
    endQueued = false;
  };

  const detach = (): void => {
    if (!active) return;
    active = false;
    clear();
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
  };

  const grow = (buffer: Buffer<ArrayBufferLike>, usedBytes: number, neededBytes: number): Buffer<ArrayBufferLike> => {
    if (buffer.length >= neededBytes) return buffer;
    let capacity = Math.max(64, buffer.length || 1);
    while (capacity < neededBytes) capacity = Math.max(neededBytes, capacity * 2);
    const grown = Buffer.allocUnsafeSlow(capacity);
    if (usedBytes > 0) buffer.copy(grown, 0, 0, usedBytes);
    return grown;
  };

  const appendLine = (chunk: Buffer, start: number, end: number): boolean => {
    const length = end - start;
    if (bufferedBytes + length > maxBytes) {
      rejectOversize();
      return false;
    }
    if (length === 0) return true;
    lineBuffer = grow(lineBuffer, bufferedBytes, bufferedBytes + length);
    chunk.copy(lineBuffer, bufferedBytes, start, end);
    bufferedBytes += length;
    return true;
  };

  const appendString = (value: string): boolean => {
    const length = Buffer.byteLength(value, "utf8");
    if (bufferedBytes + length > maxBytes) {
      rejectOversize();
      return false;
    }
    if (length === 0) return true;
    lineBuffer = grow(lineBuffer, bufferedBytes, bufferedBytes + length);
    lineBuffer.write(value, bufferedBytes, length, "utf8");
    bufferedBytes += length;
    return true;
  };

  const takeLine = (stripTrailingCarriageReturn: boolean): string => {
    const end = stripTrailingCarriageReturn && bufferedBytes > 0 && lineBuffer[bufferedBytes - 1] === 0x0d
      ? bufferedBytes - 1
      : bufferedBytes;
    const line = lineBuffer.toString("utf8", 0, end);
    bufferedBytes = 0;
    return line;
  };

  const rejectOversize = (): void => {
    if (!active) return;
    detach();
    // `detach()` precedes the callback so a reentrant source write is ignored.
    onError(new Error(`RPC line exceeds ${maxBytes} bytes.`));
  };

  const deliverLine = (line: string): void => {
    try {
      onLine(line);
    } catch (error) {
      detach();
      throw error;
    }
  };

  const processBufferData = (chunk: Buffer, inputBytes?: number): void => {
    if (!active) return;
    const chunkBytes = inputBytes ?? chunk.length;
    let offset = 0;

    while (offset < chunkBytes) {
      const foundNewline = chunk.indexOf(0x0a, offset);
      const newline = foundNewline >= chunkBytes ? -1 : foundNewline;
      const end = newline === -1 ? chunkBytes : newline;
      if (!appendLine(chunk, offset, end)) return;

      if (newline === -1) return;

      deliverLine(takeLine(true));
      if (!active) return;
      offset = newline + 1;
    }
  };

  const processStringData = (value: string): void => {
    if (!active) return;
    let offset = 0;

    while (offset < value.length) {
      const newline = value.indexOf("\n", offset);
      const end = newline === -1 ? value.length : newline;
      if (!appendString(value.slice(offset, end))) return;

      if (newline === -1) return;

      deliverLine(takeLine(true));
      if (!active) return;
      offset = newline + 1;
    }
  };

  const processEnd = (): void => {
    if (!active) return;
    const finalLine = bufferedBytes === 0 ? undefined : takeLine(false);
    detach();
    if (finalLine !== undefined) deliverLine(finalLine);
  };

  const drain = (): void => {
    if (processing || !active) return;
    processing = true;
    try {
      while (active) {
        if (pendingBytes > 0) {
          const nextBuffer = pendingBuffer;
          const nextBytes = pendingBytes;
          pendingBuffer = processingBuffer;
          pendingBytes = 0;
          processingBuffer = nextBuffer;
          processBufferData(processingBuffer, nextBytes);
          continue;
        }
        if (endQueued) processEnd();
        break;
      }
    } finally {
      processing = false;
    }
  };

  const onData = (value: Buffer | string): void => {
    if (!active || endQueued) return;
    const isBuffer = Buffer.isBuffer(value);
    const length = isBuffer ? value.length : Buffer.byteLength(value, "utf8");
    if (length === 0) return;
    if (!processing) {
      processing = true;
      try {
        if (isBuffer) processBufferData(value);
        else processStringData(value);
      } finally {
        processing = false;
      }
      drain();
      return;
    }
    if (pendingBytes + length > maxBytes) {
      rejectOversize();
      return;
    }
    pendingBuffer = grow(pendingBuffer, pendingBytes, pendingBytes + length);
    if (isBuffer) value.copy(pendingBuffer, pendingBytes, 0, length);
    else pendingBuffer.write(value, pendingBytes, length, "utf8");
    pendingBytes += length;
  };

  const onEnd = (): void => {
    if (!active || endQueued) return;
    endQueued = true;
    drain();
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return detach;
}
