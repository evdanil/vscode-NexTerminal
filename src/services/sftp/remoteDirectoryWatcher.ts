import type { SshConnection } from "../ssh/contracts";

export interface RemoteChangeEvent {
  serverId: string;
  dirPath: string;
}

type WatchMode = "inotifywait" | "stat" | "none";
type StatVariant = "gnu" | "bsd";

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function execProbe(connection: SshConnection, command: string): Promise<boolean> {
  try {
    // NOTE: connection.exec() is SSH channel exec (remote server), NOT child_process.exec.
    const stream = await connection.exec(command);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stream.destroy();
          resolve(false);
        }
      }, 5_000);
      stream.on("close", (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(code === 0);
        }
      });
      stream.on("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
  } catch {
    return false;
  }
}

export class RemoteDirectoryWatcher {
  private _mode: WatchMode = "none";
  private statVariant: StatVariant = "gnu";
  private probed = false;
  private disposed = false;
  private stopped = false;

  private inotifyStream: NodeJS.ReadableStream | undefined;
  private inotifyBuffer = "";
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private statTimer: ReturnType<typeof setInterval> | undefined;
  private lastMtime: string | undefined;

  private watchedDir: string | undefined;

  private readonly listeners: Array<(event: RemoteChangeEvent) => void> = [];

  public constructor(
    private readonly connection: SshConnection,
    private readonly serverId: string
  ) {}

  public get mode(): WatchMode {
    return this._mode;
  }

  public async probe(): Promise<WatchMode> {
    if (this.probed) {
      return this._mode;
    }
    this.probed = true;

    if (await execProbe(this.connection, "command -v inotifywait")) {
      this._mode = "inotifywait";
      return this._mode;
    }

    if (await execProbe(this.connection, "stat -c '%Y' /")) {
      this._mode = "stat";
      this.statVariant = "gnu";
      return this._mode;
    }

    if (await execProbe(this.connection, "stat -f '%m' /")) {
      this._mode = "stat";
      this.statVariant = "bsd";
      return this._mode;
    }

    this._mode = "none";
    return this._mode;
  }

  public async watch(dirPath: string, pollIntervalMs: number): Promise<void> {
    this.stopInternal();
    this.stopped = false;
    this.watchedDir = dirPath;

    if (!this.probed) {
      await this.probe();
    }

    if (this._mode === "inotifywait") {
      await this.startInotifywait(dirPath);
    } else if (this._mode === "stat") {
      this.startStatPolling(dirPath, pollIntervalMs);
    }
  }

  public stop(): void {
    this.stopped = true;
    this.stopInternal();
  }

  public dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.length = 0;
  }

  public onDidChange(listener: (event: RemoteChangeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private emit(): void {
    if (!this.watchedDir) {
      return;
    }
    const event: RemoteChangeEvent = {
      serverId: this.serverId,
      dirPath: this.watchedDir,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private stopInternal(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.inotifyStream) {
      (this.inotifyStream as unknown as { destroy(): void }).destroy();
      this.inotifyStream = undefined;
      this.inotifyBuffer = "";
    }
    if (this.statTimer) {
      clearInterval(this.statTimer);
      this.statTimer = undefined;
    }
    this.lastMtime = undefined;
  }

  // NOTE: All exec() calls below are SSH channel exec (SshConnection.exec),
  // running commands on the REMOTE server over SSH — NOT local child_process.exec.
  // Path arguments are shell-escaped via shellEscape().

  private async startInotifywait(dirPath: string): Promise<void> {
    if (this.disposed || this.stopped) {
      return;
    }

    try {
      const command = `inotifywait -m -q -e modify,create,delete,move --format '%e %f' ${shellEscape(dirPath)}`;
      const stream = await this.connection.exec(command);
      if (this.disposed || this.stopped) {
        stream.destroy();
        return;
      }
      this.inotifyStream = stream as unknown as NodeJS.ReadableStream;

      stream.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        this.inotifyBuffer += text;

        // Process complete lines
        const lines = this.inotifyBuffer.split("\n");
        this.inotifyBuffer = lines.pop() ?? "";

        if (lines.length > 0) {
          this.scheduleDebounce();
        }
      });

      stream.on("close", () => {
        this.inotifyStream = undefined;
        this.inotifyBuffer = "";
        if (!this.disposed && !this.stopped) {
          setTimeout(() => {
            void this.startInotifywait(dirPath);
          }, 5_000);
        }
      });

      stream.on("error", () => {
        this.inotifyStream = undefined;
        this.inotifyBuffer = "";
        if (!this.disposed && !this.stopped) {
          setTimeout(() => {
            void this.startInotifywait(dirPath);
          }, 5_000);
        }
      });
    } catch {
      if (!this.disposed && !this.stopped) {
        setTimeout(() => {
          void this.startInotifywait(dirPath);
        }, 5_000);
      }
    }
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.emit();
    }, 500);
  }

  private startStatPolling(dirPath: string, intervalMs: number): void {
    const effectiveInterval = intervalMs > 0 ? intervalMs : 10_000;

    const check = async (): Promise<void> => {
      if (this.disposed || this.stopped) {
        return;
      }
      try {
        const flag = this.statVariant === "gnu" ? "-c '%Y'" : "-f '%m'";
        const command = `stat ${flag} ${shellEscape(dirPath)}`;
        const stream = await this.connection.exec(command);
        const stdout = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              stream.destroy();
              resolve("");
            }
          }, 10_000);
          stream.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          stream.on("close", () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(Buffer.concat(chunks).toString("utf-8").trim());
            }
          });
          stream.on("error", () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve("");
            }
          });
        });

        if (stdout && this.lastMtime !== undefined && stdout !== this.lastMtime) {
          this.emit();
        }
        this.lastMtime = stdout || this.lastMtime;
      } catch {
        // Ignore stat failures — we'll retry next interval
      }
    };

    // Do an initial check to establish the baseline mtime
    void check();
    this.statTimer = setInterval(() => void check(), effectiveInterval);
  }
}
