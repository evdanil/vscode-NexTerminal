import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import * as path from "node:path";
import { createAnsiRegex } from "../utils/ansi";

// Control characters except \n, \r, \t
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripTerminalCodes(data: string): string {
  return data.replace(createAnsiRegex(), "").replace(CTRL_RE, "");
}

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
    const clean = stripTerminalCodes(data);
    if (clean) {
      writeSync(this.fd, clean);
    }
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
  try {
    const safeName = profileName.replace(/[^\w.-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${safeName}_${timestamp}.log`;
    const filepath = path.join(logDir, filename);
    return new FileSessionTranscript(filepath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Nexus] Failed to create session transcript in ${logDir}: ${message}`);
    return NOOP_TRANSCRIPT;
  }
}
