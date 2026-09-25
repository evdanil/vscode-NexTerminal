interface BufferedSerialData {
  sessionId: string;
  data: Buffer;
}

const MAX_BUFFERED_BYTES = 64 * 1024;
const MAX_BUFFERED_CHUNKS = 256;

/**
 * Holds only the short interval between a port emitting data and its open response.
 * The fixed cap prevents a noisy device from growing startup memory without
 * bound: overflow drops the oldest chunks; any single chunk above 64 KiB is
 * discarded rather than retained.
 */
export class SerialOpeningDataBuffer {
  private readonly entries: BufferedSerialData[] = [];
  private bufferedBytes = 0;

  public capture(sessionId: string, data: Buffer): void {
    if (data.byteLength > MAX_BUFFERED_BYTES) {
      return;
    }

    while (
      this.entries.length >= MAX_BUFFERED_CHUNKS ||
      this.bufferedBytes + data.byteLength > MAX_BUFFERED_BYTES
    ) {
      const removed = this.entries.shift();
      if (!removed) {
        break;
      }
      this.bufferedBytes -= removed.data.byteLength;
    }

    this.entries.push({ sessionId, data });
    this.bufferedBytes += data.byteLength;
  }

  public takeFor(sessionId: string): Buffer[] {
    const matching = this.entries
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.data);
    this.clear();
    return matching;
  }

  public clear(): void {
    this.entries.length = 0;
    this.bufferedBytes = 0;
  }
}
