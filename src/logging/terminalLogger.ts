import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import * as path from "node:path";
import { clamp } from "../utils/helpers";

export interface SessionLogger {
  /** Lifecycle events — connect, disconnect, errors. Always written. */
  log(line: string): void;
  /**
   * Per-chunk terminal data trace. Written ONLY when the opt-in
   * `nexus.logging.terminalOutputTrace` setting is on; a no-op otherwise.
   *
   * Two reasons this is gated rather than unconditional. It is on the hot path
   * for every byte a session receives, and each call is a synchronous
   * `writeSync` — under kernel writeback pressure a single one can stall the
   * extension host for tens of milliseconds, and it roughly doubles the write
   * volume of a busy session. And because the trace is verbatim session data,
   * it persists everything the terminal saw — including echoed secrets — as
   * plaintext on disk.
   *
   * Optional so that the lightweight `{ log, close }` doubles used across the
   * suite keep working; a real logger always implements it.
   */
  logOutput?(line: string): void;
  close(): void;
}

export interface LoggerRotationOptions {
  maxFileSizeBytes: number;
  maxRotatedFiles: number;
}

export const DEFAULT_ROTATION_OPTIONS: LoggerRotationOptions = {
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxRotatedFiles: 1
};

export function normalizeLoggerRotationOptions(options?: Partial<LoggerRotationOptions>): LoggerRotationOptions {
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_ROTATION_OPTIONS.maxFileSizeBytes;
  const maxRotatedFiles = options?.maxRotatedFiles ?? DEFAULT_ROTATION_OPTIONS.maxRotatedFiles;
  return {
    maxFileSizeBytes: clamp(Math.floor(maxFileSizeBytes), 1, 1024 * 1024 * 1024),
    maxRotatedFiles: clamp(Math.floor(maxRotatedFiles), 0, 99)
  };
}

export type LoggerRotationOptionsProvider = () => Partial<LoggerRotationOptions> | undefined;

/**
 * Reads the current value of the opt-in per-chunk data trace. Supplied by the
 * caller (extension host) so this module stays free of a `vscode` import, and
 * read per call so toggling the setting takes effect on already-open sessions.
 * Implementations are expected to be a cached-flag read, not a settings lookup.
 */
export type OutputTraceProvider = () => boolean;

class RotatingFileSessionLogger implements SessionLogger {
  private fd: number;
  private currentSize: number;
  private closed = false;

  public constructor(
    private readonly filepath: string,
    private readonly rotation: LoggerRotationOptions,
    private readonly outputTraceEnabled: OutputTraceProvider = () => false
  ) {
    this.currentSize = this.readCurrentSize();
    this.fd = openSync(filepath, "a");
  }

  public logOutput(line: string): void {
    if (!this.outputTraceEnabled()) {
      return;
    }
    this.log(line);
  }

  public log(line: string): void {
    if (this.closed) {
      return;
    }
    const entry = `${new Date().toISOString()} ${line}\n`;
    const entrySize = Buffer.byteLength(entry, "utf8");
    if (this.currentSize + entrySize > this.rotation.maxFileSizeBytes) {
      this.rotate();
      this.currentSize = 0;
    }
    writeSync(this.fd, entry);
    this.currentSize += entrySize;
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    closeSync(this.fd);
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
          // target doesn't exist — fine
        }
        try {
          renameSync(source, target);
        } catch {
          // source doesn't exist — fine
        }
      }
    } else {
      try {
        unlinkSync(this.filepath);
      } catch {
        // file doesn't exist — fine
      }
    }

    this.fd = openSync(this.filepath, "a");
  }
}

export class TerminalLoggerFactory {
  private readonly rotationProvider: LoggerRotationOptionsProvider;
  private readonly outputTraceProvider: OutputTraceProvider;

  public constructor(
    baseDir: string,
    options?: Partial<LoggerRotationOptions> | LoggerRotationOptionsProvider,
    outputTraceProvider?: OutputTraceProvider
  ) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    this.rotationProvider = typeof options === "function" ? options : () => options;
    // Default OFF: a caller that does not opt in never pays for the trace.
    this.outputTraceProvider = outputTraceProvider ?? (() => false);
  }

  private readonly baseDir: string;

  public getRotationOptions(): LoggerRotationOptions {
    return normalizeLoggerRotationOptions(this.rotationProvider());
  }

  public create(kind: "terminal" | "tunnel", id: string): SessionLogger {
    const safeId = id.replace(/[^\w.-]/g, "_");
    const filename = `${kind}-${safeId}.log`;
    const filepath = path.join(this.baseDir, filename);
    return new RotatingFileSessionLogger(filepath, this.getRotationOptions(), this.outputTraceProvider);
  }
}
