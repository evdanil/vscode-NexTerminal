import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import * as path from "node:path";

export interface SessionLogger {
  log(line: string): void;
  close(): void;
}

class FileSessionLogger implements SessionLogger {
  public constructor(private readonly stream: WriteStream) {}

  public log(line: string): void {
    this.stream.write(`${new Date().toISOString()} ${line}\n`);
  }

  public close(): void {
    this.stream.end();
  }
}

export class TerminalLoggerFactory {
  public constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  public create(kind: "terminal" | "tunnel", id: string): SessionLogger {
    const safeId = id.replace(/[^\w.-]/g, "_");
    const filename = `${kind}-${safeId}-${Date.now()}.log`;
    const filepath = path.join(this.baseDir, filename);
    const stream = createWriteStream(filepath, { flags: "a" });
    return new FileSessionLogger(stream);
  }
}
