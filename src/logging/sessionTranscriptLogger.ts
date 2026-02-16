import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import * as path from "node:path";

export interface SessionTranscript {
  write(data: string): void;
  close(): void;
}

const NOOP_TRANSCRIPT: SessionTranscript = { write() {}, close() {} };

class FileSessionTranscript implements SessionTranscript {
  private fd: number;
  private closed = false;

  public constructor(filepath: string) {
    mkdirSync(path.dirname(filepath), { recursive: true });
    this.fd = openSync(filepath, "a");
    const header = `--- Session started ${new Date().toISOString()} ---\n`;
    writeSync(this.fd, header);
  }

  public write(data: string): void {
    if (this.closed) {
      return;
    }
    writeSync(this.fd, data);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const footer = `\n--- Session ended ${new Date().toISOString()} ---\n`;
    writeSync(this.fd, footer);
    closeSync(this.fd);
  }
}

export function createSessionTranscript(logDir: string, profileName: string, enabled: boolean): SessionTranscript {
  if (!enabled) {
    return NOOP_TRANSCRIPT;
  }
  const safeName = profileName.replace(/[^\w.-]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${safeName}_${timestamp}.log`;
  const filepath = path.join(logDir, filename);
  return new FileSessionTranscript(filepath);
}
