import type { SshConnection } from "../ssh/contracts";

export interface RemoteChangeEvent {
  serverId: string;
  dirPath: string;
}

export type WatchMode = "inotifywait" | "stat" | "none";
type StatVariant = "gnu" | "bsd";

const INOTIFY_RESTART_DELAY_MS = 5_000;
const INOTIFY_DEBOUNCE_MS = 500;
const EXEC_PROBE_TIMEOUT_MS = 5_000;
const STAT_TIMEOUT_MS = 10_000;

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
      }, EXEC_PROBE_TIMEOUT_MS);
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
  private watchGeneration = 0;

  private inotifyStream: NodeJS.ReadableStream | undefined;
  private inotifyBuffer = "";
  private readonly pendingDirs = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  private statTimer: ReturnType<typeof setInterval> | undefined;
  private lastMtime: string | undefined;

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

  public async watch(dirPath: string, pollIntervalMs: number): Promise<WatchMode> {
    const generation = ++this.watchGeneration;
    this.stopInternal();
    this.stopped = false;

    if (!this.probed) {
      await this.probe();
    }

    if (!this.isActiveGeneration(generation)) {
      return this._mode;
    }

    if (this._mode === "inotifywait") {
      await this.startInotifywait(dirPath, generation);
    } else if (this._mode === "stat") {
      this.startStatPolling(dirPath, pollIntervalMs, generation);
    }
    return this._mode;
  }

  public stop(): void {
    this.stopped = true;
    this.watchGeneration += 1;
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

  private emit(dirPath: string): void {
    const event: RemoteChangeEvent = {
      serverId: this.serverId,
      dirPath,
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
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.statTimer) {
      clearInterval(this.statTimer);
      this.statTimer = undefined;
    }
    this.pendingDirs.clear();
    this.lastMtime = undefined;
  }

  // NOTE: All exec() calls below are SSH channel exec (SshConnection.exec),
  // running commands on the REMOTE server over SSH — NOT local child_process.exec.
  // Path arguments are shell-escaped via shellEscape().

  private isActiveGeneration(generation: number): boolean {
    return !this.disposed && !this.stopped && generation === this.watchGeneration;
  }

  private normalizeDirPath(dirPath: string): string {
    if (!dirPath || dirPath === "/") {
      return "/";
    }
    return dirPath.replace(/\/+$/, "") || "/";
  }

  private queueDirChange(dirPath: string): void {
    this.pendingDirs.add(dirPath);
    this.scheduleDebounce();
  }

  private scheduleRestart(dirPath: string, generation: number): void {
    if (!this.isActiveGeneration(generation) || this.restartTimer) {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.isActiveGeneration(generation)) {
        void this.startInotifywait(dirPath, generation);
      }
    }, INOTIFY_RESTART_DELAY_MS);
  }

  private async startInotifywait(dirPath: string, generation: number): Promise<void> {
    if (!this.isActiveGeneration(generation)) {
      return;
    }

    try {
      const command = `inotifywait -m -r -q -e modify,create,delete,move --format '%w%0' --no-newline ${shellEscape(dirPath)}`;
      const stream = await this.connection.exec(command);
      if (!this.isActiveGeneration(generation)) {
        stream.destroy();
        return;
      }
      this.inotifyStream = stream as unknown as NodeJS.ReadableStream;

      stream.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        this.inotifyBuffer += text;

        // Process NUL-delimited paths so directory names may safely contain newlines or pipes.
        const entries = this.inotifyBuffer.split("\0");
        this.inotifyBuffer = entries.pop() ?? "";

        for (const entry of entries) {
          if (!entry) {
            continue;
          }
          this.queueDirChange(this.normalizeDirPath(entry));
        }
      });

      stream.on("close", () => {
        if (this.inotifyStream === (stream as unknown as NodeJS.ReadableStream)) {
          this.inotifyStream = undefined;
          this.inotifyBuffer = "";
        }
        this.scheduleRestart(dirPath, generation);
      });

      stream.on("error", () => {
        if (this.inotifyStream === (stream as unknown as NodeJS.ReadableStream)) {
          this.inotifyStream = undefined;
          this.inotifyBuffer = "";
        }
        this.scheduleRestart(dirPath, generation);
      });
    } catch {
      this.scheduleRestart(dirPath, generation);
    }
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const changedDirs = [...this.pendingDirs];
      this.pendingDirs.clear();
      for (const dirPath of changedDirs) {
        this.emit(dirPath);
      }
    }, INOTIFY_DEBOUNCE_MS);
  }

  private startStatPolling(dirPath: string, intervalMs: number, generation: number): void {
    const effectiveInterval = intervalMs > 0 ? intervalMs : 10_000;

    const check = async (): Promise<void> => {
      if (!this.isActiveGeneration(generation)) {
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
          }, STAT_TIMEOUT_MS);
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

        if (!this.isActiveGeneration(generation)) {
          return;
        }

        if (stdout && this.lastMtime !== undefined && stdout !== this.lastMtime) {
          this.emit(this.normalizeDirPath(dirPath));
        }
        this.lastMtime = stdout || this.lastMtime;
      } catch {
        // Ignore stat failures - we'll retry next interval
      }
    };

    // Do an initial check to establish the baseline mtime
    void check();
    this.statTimer = setInterval(() => {
      if (this.isActiveGeneration(generation)) {
        void check();
      }
    }, effectiveInterval);
  }
}
