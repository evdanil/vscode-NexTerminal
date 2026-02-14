import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import * as path from "node:path";

export interface SessionLogger {
  log(line: string): void;
  close(): void;
}

export interface LoggerRotationOptions {
  maxFileSizeBytes: number;
  maxRotatedFiles: number;
}

const DEFAULT_ROTATION_OPTIONS: LoggerRotationOptions = {
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxRotatedFiles: 1
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

class RotatingFileSessionLogger implements SessionLogger {
  private currentSize: number;

  public constructor(
    private readonly filepath: string,
    private readonly rotation: LoggerRotationOptions
  ) {
    this.currentSize = this.readCurrentSize();
  }

  public log(line: string): void {
    const entry = `${new Date().toISOString()} ${line}\n`;
    const entrySize = Buffer.byteLength(entry, "utf8");
    if (this.currentSize + entrySize > this.rotation.maxFileSizeBytes) {
      this.rotate();
      this.currentSize = 0;
    }
    appendFileSync(this.filepath, entry, { encoding: "utf8" });
    this.currentSize += entrySize;
  }

  public close(): void {
    return;
  }

  private readCurrentSize(): number {
    try {
      return statSync(this.filepath).size;
    } catch {
      return 0;
    }
  }

  private rotate(): void {
    if (this.rotation.maxRotatedFiles > 0) {
      for (let index = this.rotation.maxRotatedFiles; index >= 1; index -= 1) {
        const source = index === 1 ? this.filepath : `${this.filepath}.${index - 1}`;
        const target = `${this.filepath}.${index}`;
        if (existsSync(target)) {
          unlinkSync(target);
        }
        if (existsSync(source)) {
          renameSync(source, target);
        }
      }
    } else if (existsSync(this.filepath)) {
      unlinkSync(this.filepath);
    }
  }
}

export class TerminalLoggerFactory {
  private readonly rotation: LoggerRotationOptions;

  public constructor(baseDir: string, options?: Partial<LoggerRotationOptions>) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_ROTATION_OPTIONS.maxFileSizeBytes;
    const maxRotatedFiles = options?.maxRotatedFiles ?? DEFAULT_ROTATION_OPTIONS.maxRotatedFiles;
    this.rotation = {
      maxFileSizeBytes: clamp(Math.floor(maxFileSizeBytes), 1, 1024 * 1024 * 1024),
      maxRotatedFiles: clamp(Math.floor(maxRotatedFiles), 0, 99)
    };
  }

  private readonly baseDir: string;

  public create(kind: "terminal" | "tunnel", id: string): SessionLogger {
    const safeId = id.replace(/[^\w.-]/g, "_");
    const filename = `${kind}-${safeId}.log`;
    const filepath = path.join(this.baseDir, filename);
    return new RotatingFileSessionLogger(filepath, this.rotation);
  }
}
