import type { Writable } from "node:stream";
import { MAX_RPC_LINE_BYTES } from "./boundedLineReader";

export interface BoundedJsonLineWriterOptions {
  /** Owns process teardown when the stdout transport becomes terminal. */
  readonly onTerminal: (error: Error) => void;
  /** Receives a fixed diagnostic when a notification is deliberately dropped. */
  readonly onNotificationDropped?: (reason: string) => void;
}

interface PendingLine {
  readonly line: string;
  readonly bytes: number;
  readonly response: boolean;
}

const RESPONSE_TOO_LARGE = {
  code: "RESPONSE_TOO_LARGE",
  message: "Daemon response exceeds the RPC line limit.",
} as const;

const NOTIFICATION_TOO_LARGE = "outbound notification exceeds the RPC line limit";
const NOTIFICATION_BACKPRESSURED = "outbound notification dropped while stdout is backpressured";
const MAX_QUEUED_OUTPUT_BYTES = MAX_RPC_LINE_BYTES * 4;
const MAX_QUEUED_OUTPUT_LINES = 16;

/** A stderr diagnostic is deliberately small and never queues behind a flood. */
export const MAX_DAEMON_DIAGNOSTIC_BYTES = 512;

function correlatedResponseId(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, "id")) return undefined;
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/**
 * Serializes daemon stdout as bounded JSON lines with one owned in-flight write.
 *
 * A small byte- and count-bounded queue sits behind the active write, so
 * memory remains bounded even if the host stops reading. Responses are never
 * dropped: a full response queue is terminal transport loss, while
 * notifications use the documented drop callback.
 */
export class BoundedJsonLineWriter {
  private active = true;
  private writing = false;
  private waitingForDrain = false;
  private writeCallbackDone = false;
  /** Invalidates post-return work from a synchronously terminal write call. */
  private writeEpoch = 0;
  private readonly queued: PendingLine[] = [];
  private queuedBytes = 0;
  private readonly onDrain = (): void => {
    this.waitingForDrain = false;
    this.finishWriteIfReady();
  };

  public constructor(
    private readonly stream: Writable,
    private readonly options: BoundedJsonLineWriterOptions,
  ) {
    stream.on("error", this.onStreamError);
    stream.on("close", this.onStreamClose);
  }

  /** Attempts to emit one closed protocol response or notification. */
  public write(value: unknown): void {
    if (!this.active) return;
    const line = this.serialize(value);
    if (!line) return;
    if (this.writing) {
      if (this.queued.length < MAX_QUEUED_OUTPUT_LINES && this.queuedBytes + line.bytes <= MAX_QUEUED_OUTPUT_BYTES) {
        this.queued.push(line);
        this.queuedBytes += line.bytes;
        return;
      }
      if (line.response) {
        this.terminal(new Error("Daemon stdout output queue exceeded its byte bound."));
      } else {
        this.dropNotification(NOTIFICATION_BACKPRESSURED);
      }
      return;
    }
    this.startWrite(line);
  }

  private serialize(value: unknown): PendingLine | undefined {
    const responseId = correlatedResponseId(value);
    let payload: string | undefined;
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized === "string") payload = serialized;
    } catch (error) {
      if (responseId === undefined) {
        this.dropNotification("outbound notification could not be serialized");
        return undefined;
      }
      payload = JSON.stringify({ id: responseId, error: RESPONSE_TOO_LARGE });
    }

    if (payload === undefined) {
      if (responseId === undefined) {
        this.dropNotification("outbound notification could not be serialized");
        return undefined;
      }
      payload = JSON.stringify({ id: responseId, error: RESPONSE_TOO_LARGE });
    }

    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_LINE_BYTES) {
      if (responseId === undefined) {
        this.dropNotification(NOTIFICATION_TOO_LARGE);
        return undefined;
      }
      payload = JSON.stringify({ id: responseId, error: RESPONSE_TOO_LARGE });
    }

    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_LINE_BYTES) {
      this.terminal(new Error("Daemon RESPONSE_TOO_LARGE fallback exceeded the RPC line limit."));
      return undefined;
    }
    return { line: `${payload}\n`, bytes: Buffer.byteLength(payload, "utf8"), response: responseId !== undefined };
  }

  private startWrite(line: PendingLine): void {
    if (!this.active) return;
    const epoch = ++this.writeEpoch;
    this.writing = true;
    this.waitingForDrain = false;
    this.writeCallbackDone = false;
    try {
      const accepted = this.stream.write(line.line, (error?: Error | null) => {
        if (!this.isCurrentWrite(epoch)) return;
        if (error) {
          this.terminal(error);
          return;
        }
        this.writeCallbackDone = true;
        this.finishWriteIfReady();
      });
      // A Writable may synchronously invoke the callback, emit error/close,
      // or reenter another write before returning false. Only this still-live
      // write epoch is allowed to claim drain ownership after the return.
      if (!accepted && this.isCurrentWrite(epoch)) {
        this.waitingForDrain = true;
        this.stream.once("drain", this.onDrain);
      }
    } catch (error) {
      this.terminal(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finishWriteIfReady(): void {
    if (!this.active || !this.writing || !this.writeCallbackDone || this.waitingForDrain) return;
    this.writing = false;
    const next = this.queued.shift();
    if (next) this.queuedBytes -= next.bytes;
    if (next) this.startWrite(next);
  }

  private isCurrentWrite(epoch: number): boolean {
    return this.active && this.writing && this.writeEpoch === epoch;
  }

  private readonly onStreamError = (error: Error): void => this.terminal(error);

  private readonly onStreamClose = (): void => {
    this.terminal(new Error("Daemon stdout closed."));
  };

  private terminal(error: Error): void {
    if (!this.active) return;
    this.active = false;
    this.writeEpoch += 1;
    this.writing = false;
    this.waitingForDrain = false;
    this.writeCallbackDone = false;
    this.queued.length = 0;
    this.queuedBytes = 0;
    this.stream.removeListener("drain", this.onDrain);
    try {
      this.options.onTerminal(error);
    } catch {
      // Terminal transport ownership must not be undone by a caller callback.
    }
  }

  private dropNotification(reason: string): void {
    try {
      this.options.onNotificationDropped?.(reason);
    } catch {
      // Notification diagnostics are deliberately isolated from transport state.
    }
  }
}

/**
 * Owns daemon stderr diagnostics without turning an stdout backpressure flood
 * into unbounded stderr buffering. One write remains in flight until both its
 * callback and any required drain arrive; every later diagnostic is coalesced
 * by dropping it. Terminal stderr failure is intentionally isolated from the
 * daemon shutdown authority, which is already owned by stdout/lifecycle code.
 */
export class BoundedDaemonDiagnosticWriter {
  private active = true;
  private inFlight = false;
  private waitingForDrain = false;
  private writeCallbackDone = false;
  /** Invalidates post-return work from a synchronously terminal write call. */
  private writeEpoch = 0;

  private readonly onDrain = (): void => {
    this.waitingForDrain = false;
    this.finishWriteIfReady();
  };

  private readonly onStreamError = (_error: Error): void => this.terminal();

  private readonly onStreamClose = (): void => this.terminal();

  public constructor(private readonly stream: Writable) {
    stream.on("error", this.onStreamError);
    stream.on("close", this.onStreamClose);
  }

  /** Emits one bounded diagnostic only when stderr has no retained write. */
  public write(message: string): void {
    if (!this.active || this.inFlight) return;
    const line = `${this.truncate(message, MAX_DAEMON_DIAGNOSTIC_BYTES - 1)}\n`;
    const epoch = ++this.writeEpoch;
    this.inFlight = true;
    this.waitingForDrain = false;
    this.writeCallbackDone = false;
    try {
      const accepted = this.stream.write(line, (error?: Error | null) => {
        if (!this.isCurrentWrite(epoch)) return;
        if (error) {
          this.terminal();
          return;
        }
        this.writeCallbackDone = true;
        this.finishWriteIfReady();
      });
      // See BoundedJsonLineWriter: the return value arrives after permitted
      // synchronous callback/error/close reentrancy, so terminal state wins.
      if (!accepted && this.isCurrentWrite(epoch)) {
        this.waitingForDrain = true;
        this.stream.once("drain", this.onDrain);
      }
    } catch {
      this.terminal();
    }
  }

  private finishWriteIfReady(): void {
    if (!this.active || !this.inFlight || !this.writeCallbackDone || this.waitingForDrain) return;
    this.inFlight = false;
  }

  private isCurrentWrite(epoch: number): boolean {
    return this.active && this.inFlight && this.writeEpoch === epoch;
  }

  private terminal(): void {
    if (!this.active) return;
    this.active = false;
    this.writeEpoch += 1;
    this.inFlight = false;
    this.waitingForDrain = false;
    this.writeCallbackDone = false;
    this.stream.removeListener("drain", this.onDrain);
  }

  private truncate(value: string, maxBytes: number): string {
    let bytes = 0;
    let result = "";
    for (const character of value) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (bytes + characterBytes > maxBytes) break;
      result += character;
      bytes += characterBytes;
    }
    return result;
  }
}
