import * as vscode from "vscode";
import { createAnsiRegex } from "../../utils/ansi";

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const SCROLLBACK_SECTION = "terminal.integrated";
const SCROLLBACK_KEY = "scrollback";
const DEFAULT_MAX_LINES = 1000;

export interface TerminalCaptureBufferOptions {
  maxLines?: number;
}

function readScrollbackSetting(): number {
  const value = vscode.workspace.getConfiguration(SCROLLBACK_SECTION).get<number>(SCROLLBACK_KEY);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_LINES;
}

export class TerminalCaptureBuffer {
  private lines: string[] = [];
  private pending = "";
  private maxLines: number;
  private readonly configSubscription: vscode.Disposable;

  public constructor(options: TerminalCaptureBufferOptions = {}) {
    this.maxLines = options.maxLines ?? readScrollbackSetting();
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SCROLLBACK_SECTION}.${SCROLLBACK_KEY}`)) {
        this.setMaxLines(readScrollbackSetting());
      }
    });
  }

  public append(data: string): void {
    const stripped = data.replace(createAnsiRegex(), "").replace(CONTROL_CHAR_RE, "");
    if (stripped.length === 0) return;
    const combined = this.pending + stripped;
    const segments = combined.split("\n");
    this.pending = segments.pop() ?? "";
    for (const line of segments) {
      this.lines.push(line);
    }
    this.trim();
  }

  public clear(): void {
    this.lines = [];
    this.pending = "";
  }

  public getText(): string {
    if (this.pending.length === 0) {
      return this.lines.join("\n");
    }
    if (this.lines.length === 0) {
      return this.pending;
    }
    return `${this.lines.join("\n")}\n${this.pending}`;
  }

  public lineCount(): number {
    return this.lines.length + (this.pending.length > 0 ? 1 : 0);
  }

  public setMaxLines(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.maxLines = Math.floor(n);
    this.trim();
  }

  public dispose(): void {
    this.configSubscription.dispose();
    this.clear();
  }

  private trim(): void {
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }
}
