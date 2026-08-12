import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, write, writeSync } from "node:fs";
import * as path from "node:path";
import { normalizeLoggerRotationOptions, type LoggerRotationOptions } from "./terminalLogger";
import { createAnsiRegex } from "../utils/ansi";

// Control characters except \n, \r, \t
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// How long a chunk may sit in the in-memory queue before it reaches the file.
// Bounds worst-case loss if the extension host is killed outright (nothing
// short of a synchronous write per chunk survives that, and that write is what
// we are removing from the hot path). Every orderly exit — terminal closed,
// session disconnected, extension deactivated — flushes explicitly.
const FLUSH_INTERVAL_MS = 250;

function stripTerminalCodes(data: string): string {
  return data.replace(createAnsiRegex(), "").replace(CTRL_RE, "");
}

export interface SessionTranscript {
  write(data: string): void;
  /**
   * Write everything queued to disk now. Called on disconnect and on extension
   * deactivate, where the session may never be closed cleanly. Optional so the
   * lightweight transcript doubles used across the suite keep working.
   */
  flush?(): void;
  close(): void;
}

const NOOP_TRANSCRIPT: SessionTranscript = { write() {}, flush() {}, close() {} };

/**
 * Buffered transcript writer.
 *
 * Terminal data arrives in small chunks at high frequency; a `writeSync` per
 * chunk put a blocking syscall on the render path for every one of them.
 * Chunks are queued and drained on a timer via an asynchronous append instead.
 *
 * Two invariants the queue must not break:
 *
 * - **Ordering.** Drains are serialised through `flushChain`, so a drain that
 *   is still in flight when the next timer fires cannot interleave with it.
 * - **Rotation identity.** The queue is drained chunk by chunk against the same
 *   `currentSize + size > maxFileSizeBytes` test the synchronous writer applied
 *   per `write()` call, so a transcript rotates at exactly the same byte
 *   boundaries as before. Adjacent chunks that land in the same file are
 *   concatenated into one syscall; a batch is cut wherever a rotation falls.
 */
class FileSessionTranscript implements SessionTranscript {
  private fd: number;
  private currentSize: number;
  private closed = false;
  private queue: string[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushChain: Promise<void> = Promise.resolve();
  private draining = false;

  public constructor(
    private readonly filepath: string,
    private readonly rotation: LoggerRotationOptions
  ) {
    mkdirSync(path.dirname(filepath), { recursive: true });
    this.currentSize = this.readCurrentSize();
    this.fd = openSync(filepath, "a");
    const header = `--- Session started ${new Date().toISOString()} ---\n`;
    this.enqueue(header);
  }

  public write(data: string): void {
    if (this.closed) {
      return;
    }
    const clean = stripTerminalCodes(data);
    if (clean) {
      this.enqueue(clean);
    }
  }

  public flush(): void {
    if (this.closed) {
      return;
    }
    this.clearFlushTimer();
    if (this.draining) {
      // A drain is mid-syscall on this fd. Writing from here would interleave
      // with it; chain instead so the queued tail still lands, in order.
      this.flushChain = this.flushChain.then(() => this.drainAsync());
      return;
    }
    this.drainSync();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearFlushTimer();
    const footer = `\n--- Session ended ${new Date().toISOString()} ---\n`;
    this.queue.push(footer);
    if (this.draining) {
      // Rare: a timer drain is in flight. Finish the close behind it so the
      // file is never written to after closeSync.
      this.flushChain = this.flushChain.then(() => {
        this.drainSync();
        closeSync(this.fd);
      });
      return;
    }
    this.drainSync();
    closeSync(this.fd);
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushChain = this.flushChain.then(() => this.drainAsync());
      }, FLUSH_INTERVAL_MS);
      // Never hold the host process open for a transcript flush.
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * Split the queue into batches that each land inside one file generation,
   * applying rotation between batches. Returns the batches in write order and
   * leaves the queue empty; the caller performs the writes.
   */
  private takeBatches(): Array<{ rotateFirst: boolean; text: string }> {
    const batches: Array<{ rotateFirst: boolean; text: string }> = [];
    let current: { rotateFirst: boolean; text: string } | undefined;
    let projectedSize = this.currentSize;

    for (const chunk of this.queue) {
      const size = Buffer.byteLength(chunk, "utf8");
      const rotates = projectedSize + size > this.rotation.maxFileSizeBytes;
      if (rotates) {
        projectedSize = 0;
      }
      if (current === undefined || rotates) {
        current = { rotateFirst: rotates, text: chunk };
        batches.push(current);
      } else {
        current.text += chunk;
      }
      projectedSize += size;
    }

    this.queue = [];
    return batches;
  }

  private drainSync(): void {
    for (const batch of this.takeBatches()) {
      if (batch.rotateFirst) {
        this.rotate();
        this.currentSize = 0;
      }
      writeSync(this.fd, batch.text);
      this.currentSize += Buffer.byteLength(batch.text, "utf8");
    }
  }

  private async drainAsync(): Promise<void> {
    if (this.closed || this.queue.length === 0) {
      return;
    }
    this.draining = true;
    try {
      for (const batch of this.takeBatches()) {
        if (batch.rotateFirst) {
          this.rotate();
          this.currentSize = 0;
        }
        await this.appendAsync(batch.text);
        this.currentSize += Buffer.byteLength(batch.text, "utf8");
      }
    } catch {
      // A failed transcript write must never take down a session. The chunk is
      // dropped; subsequent writes keep trying.
    } finally {
      this.draining = false;
    }
  }

  private appendAsync(text: string): Promise<void> {
    const fd = this.fd;
    return new Promise<void>((resolve, reject) => {
      write(fd, text, (error) => (error ? reject(error) : resolve()));
    });
  }

  private readCurrentSize(): number {
    try {
      return existsSync(this.filepath) ? statSync(this.filepath).size : 0;
    } catch {
      return 0;
    }
  }

  private rotate(): void {
    closeSync(this.fd);

    if (this.rotation.maxRotatedFiles > 0) {
      for (let index = this.rotation.maxRotatedFiles; index >= 1; index -= 1) {
        const source = index === 1 ? this.filepath : `${this.filepath}.${index - 1}`;
        const target = `${this.filepath}.${index}`;
        try {
          unlinkSync(target);
        } catch {
          // target doesn't exist
        }
        try {
          renameSync(source, target);
        } catch {
          // source doesn't exist
        }
      }
    } else {
      try {
        unlinkSync(this.filepath);
      } catch {
        // file doesn't exist
      }
    }

    this.fd = openSync(this.filepath, "a");
  }
}

export function createSessionTranscript(
  logDir: string,
  profileName: string,
  enabled: boolean,
  rotationOptions?: Partial<LoggerRotationOptions>
): SessionTranscript {
  if (!enabled) {
    return NOOP_TRANSCRIPT;
  }
  try {
    const safeName = profileName.replace(/[^\w.-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${safeName}_${timestamp}.log`;
    const filepath = path.join(logDir, filename);
    return new FileSessionTranscript(filepath, normalizeLoggerRotationOptions(rotationOptions));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Nexus] Failed to create session transcript in ${logDir}: ${message}`);
    return NOOP_TRANSCRIPT;
  }
}
