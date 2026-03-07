import * as path from "node:path";
import type { SFTPWrapper, FileEntry, Stats } from "ssh2";
import type { ServerConfig } from "../../models/config";
import { clamp } from "../../utils/helpers";
import type { SshConnection, SshFactory } from "../ssh/contracts";

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  permissions: number;
}

interface SftpSession {
  connection: SshConnection;
  sftp: SFTPWrapper;
}

interface CacheEntry {
  entries: DirectoryEntry[];
  fetchedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 500;
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const MAX_DELETE_DEPTH = 100;
const MAX_DELETE_OPS = 10_000;

function normalizeConfigValue(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(Math.floor(value), min, max)
    : fallback;
}

function toDirectoryEntry(entry: FileEntry): DirectoryEntry {
  const attrs = entry.attrs;
  return {
    name: entry.filename,
    isDirectory: (attrs.mode! & 0o170000) === 0o040000,
    isSymlink: (attrs.mode! & 0o170000) === 0o120000,
    size: attrs.size,
    modifiedAt: attrs.mtime,
    permissions: attrs.mode! & 0o7777,
  };
}

function statsToDirectoryEntry(name: string, stats: Stats): DirectoryEntry {
  return {
    name,
    isDirectory: (stats.mode & 0o170000) === 0o040000,
    isSymlink: (stats.mode & 0o170000) === 0o120000,
    size: stats.size,
    modifiedAt: stats.mtime,
    permissions: stats.mode & 0o7777,
  };
}

function parentDir(remotePath: string): string {
  return path.posix.dirname(remotePath);
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function toBufferChunk(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function assertValidExecPath(remotePath: string, label: "source" | "destination"): void {
  if (!remotePath || remotePath.includes("\0") || remotePath.includes("\r") || remotePath.includes("\n")) {
    throw new Error(`Invalid remote ${label} path`);
  }
}

function cacheKey(serverId: string, remotePath: string): string {
  return `${serverId}:${remotePath}`;
}

export interface SftpServiceConfig {
  cacheTtlMs: number;
  maxCacheEntries: number;
  commandTimeoutMs?: number;
  maxDeleteDepth?: number;
  maxDeleteOps?: number;
}

export class SftpService {
  private readonly sessions = new Map<string, SftpSession>();
  private readonly dirCache = new Map<string, CacheEntry>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly pending = new Map<string, Promise<void>>();
  private cacheTtlMs: number;
  private maxCacheEntries: number;
  private commandTimeoutMs: number;
  private maxDeleteDepth: number;
  private maxDeleteOps: number;

  public constructor(private readonly sshFactory: SshFactory, config?: SftpServiceConfig) {
    this.cacheTtlMs = normalizeConfigValue(config?.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 300_000);
    this.maxCacheEntries = normalizeConfigValue(config?.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 10, 5_000);
    this.commandTimeoutMs = normalizeConfigValue(config?.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 10_000, 3_600_000);
    this.maxDeleteDepth = normalizeConfigValue(config?.maxDeleteDepth, MAX_DELETE_DEPTH, 10, 500);
    this.maxDeleteOps = normalizeConfigValue(config?.maxDeleteOps, MAX_DELETE_OPS, 100, 100_000);
  }

  public updateConfig(config: SftpServiceConfig): void {
    this.cacheTtlMs = normalizeConfigValue(config.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 300_000);
    this.maxCacheEntries = normalizeConfigValue(config.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 10, 5_000);
    if (config.commandTimeoutMs != null) {
      this.commandTimeoutMs = normalizeConfigValue(config.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 10_000, 3_600_000);
    }
    if (config.maxDeleteDepth != null) {
      this.maxDeleteDepth = normalizeConfigValue(config.maxDeleteDepth, MAX_DELETE_DEPTH, 10, 500);
    }
    if (config.maxDeleteOps != null) {
      this.maxDeleteOps = normalizeConfigValue(config.maxDeleteOps, MAX_DELETE_OPS, 100, 100_000);
    }
    this.evictCacheIfNeeded();
  }

  public async connect(server: ServerConfig): Promise<void> {
    if (this.sessions.has(server.id)) {
      return;
    }
    const existing = this.pending.get(server.id);
    if (existing) {
      return existing;
    }
    const promise = this.doConnect(server).finally(() => this.pending.delete(server.id));
    this.pending.set(server.id, promise);
    return promise;
  }

  public disconnect(serverId: string): void {
    const session = this.sessions.get(serverId);
    if (!session) {
      return;
    }
    session.sftp.end();
    session.connection.dispose();
    this.cleanupSession(serverId);
  }

  public isConnected(serverId: string): boolean {
    return this.sessions.has(serverId);
  }

  public async readDirectory(serverId: string, remotePath: string): Promise<DirectoryEntry[]> {
    const key = cacheKey(serverId, remotePath);
    const cached = this.dirCache.get(key);
    if (cached && this.cacheTtlMs > 0 && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.entries;
    }

    const sftp = this.getSftp(serverId);
    const entries = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(remotePath, (error, list) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(list);
      });
    });

    const result = entries
      .filter((e) => e.filename !== "." && e.filename !== "..")
      .map(toDirectoryEntry);

    this.dirCache.set(key, { entries: result, fetchedAt: Date.now() });
    this.evictCacheIfNeeded();
    return result;
  }

  public async stat(serverId: string, remotePath: string): Promise<DirectoryEntry> {
    const sftp = this.getSftp(serverId);
    const stats = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(remotePath, (error, stats) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stats);
      });
    });
    return statsToDirectoryEntry(path.posix.basename(remotePath), stats);
  }

  public async tryStat(serverId: string, remotePath: string): Promise<DirectoryEntry | undefined> {
    try {
      return await this.stat(serverId, remotePath);
    } catch {
      return undefined;
    }
  }

  public async lstat(serverId: string, remotePath: string): Promise<DirectoryEntry> {
    const sftp = this.getSftp(serverId);
    const stats = await new Promise<Stats>((resolve, reject) => {
      sftp.lstat(remotePath, (error, stats) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stats);
      });
    });
    return statsToDirectoryEntry(path.posix.basename(remotePath), stats);
  }

  public async tryLstat(serverId: string, remotePath: string): Promise<DirectoryEntry | undefined> {
    try {
      return await this.lstat(serverId, remotePath);
    } catch {
      return undefined;
    }
  }

  public async readFile(serverId: string, remotePath: string, maxSize?: number): Promise<Buffer> {
    const sftp = this.getSftp(serverId);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const stream = sftp.createReadStream(remotePath);
      stream.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (maxSize && totalSize > maxSize) {
          stream.destroy();
          reject(new Error(`File exceeds maximum size of ${Math.round(maxSize / 1024 / 1024)}MB`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }

  public async writeFile(serverId: string, remotePath: string, content: Buffer): Promise<void> {
    const sftp = this.getSftp(serverId);
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.on("close", () => {
        this.invalidateCache(serverId, parentDir(remotePath));
        resolve();
      });
      stream.on("error", reject);
      stream.end(content);
    });
  }

  public async delete(serverId: string, remotePath: string, isDir: boolean): Promise<void> {
    const sftp = this.getSftp(serverId);
    if (isDir) {
      await this.deleteRecursive(sftp, serverId, remotePath, 0, { count: 0 });
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(remotePath, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    this.invalidateCache(serverId, parentDir(remotePath));
  }

  public async rename(serverId: string, oldPath: string, newPath: string): Promise<void> {
    const sftp = this.getSftp(serverId);
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.invalidateCache(serverId, parentDir(oldPath));
    this.invalidateCache(serverId, parentDir(newPath));
  }

  public async createDirectory(serverId: string, remotePath: string): Promise<void> {
    const sftp = this.getSftp(serverId);
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.invalidateCache(serverId, parentDir(remotePath));
  }

  public async realpath(serverId: string, remotePath: string): Promise<string> {
    const sftp = this.getSftp(serverId);
    return new Promise<string>((resolve, reject) => {
      sftp.realpath(remotePath, (error, absPath) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(absPath);
      });
    });
  }

  private async execCommand(serverId: string, command: string, timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const effectiveTimeout = timeoutMs ?? this.commandTimeoutMs;
    const session = this.sessions.get(serverId);
    if (!session) {
      throw new Error(`No SFTP session for server ${serverId}`);
    }
    // NOTE: This is SSH channel exec (connection.exec), NOT local child_process.exec.
    // Shell escaping is handled by shellEscape() + assertValidExecPath() in the caller.
    const stream = await session.connection.exec(command);
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stream.destroy();
          reject(new Error(`Command timed out after ${effectiveTimeout}ms`));
        }
      }, effectiveTimeout);

      const onStdoutData = (chunk: Buffer | string): void => {
        stdoutChunks.push(toBufferChunk(chunk));
      };
      const onStderrData = (chunk: Buffer | string): void => {
        stderrChunks.push(toBufferChunk(chunk));
      };
      const onError = (error: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };
      const onClose = (code: number | null, signal: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const stderrText = Buffer.concat(stderrChunks).toString("utf-8");
        const signalNote = code === null ? `terminated by signal ${signal || "unknown"}` : "";
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: signalNote ? (stderrText ? `${stderrText}\n${signalNote}` : signalNote) : stderrText,
        });
      };

      stream.on("data", onStdoutData);
      const stderrStream = (stream as unknown as { stderr?: NodeJS.ReadableStream }).stderr;
      stderrStream?.on("data", onStderrData);
      stream.on("error", onError);
      stream.on("close", onClose);
    });
  }

  public async copyRemote(serverId: string, srcPath: string, destPath: string, isDirectory: boolean): Promise<void> {
    assertValidExecPath(srcPath, "source");
    assertValidExecPath(destPath, "destination");

    const flag = isDirectory ? "-R -p" : "-p";
    const command = `cp ${flag} -- ${shellEscape(srcPath)} ${shellEscape(destPath)}`;
    const result = await this.execCommand(serverId, command);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const hint = stderr ? "" : " (ensure the remote system has a POSIX-compatible `cp` command)";
      throw new Error(stderr || `cp exited with code ${result.exitCode}${hint}`);
    }
    this.invalidateCache(serverId, parentDir(destPath));
  }

  public async download(serverId: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = this.getSftp(serverId);
    return new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public async upload(serverId: string, localPath: string, remotePath: string): Promise<void> {
    const sftp = this.getSftp(serverId);
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.invalidateCache(serverId, parentDir(remotePath));
  }

  public invalidateCache(serverId: string, remotePath?: string): void {
    if (remotePath) {
      this.dirCache.delete(cacheKey(serverId, remotePath));
    } else {
      for (const key of this.dirCache.keys()) {
        if (key.startsWith(`${serverId}:`)) {
          this.dirCache.delete(key);
        }
      }
    }
  }

  public dispose(): void {
    for (const serverId of [...this.sessions.keys()]) {
      this.disconnect(serverId);
    }
  }

  private async doConnect(server: ServerConfig): Promise<void> {
    const connection = await this.sshFactory.connect(server);
    let sftp: SFTPWrapper;
    try {
      sftp = await connection.openSftp();
    } catch (error) {
      connection.dispose();
      throw error;
    }
    this.sessions.set(server.id, { connection, sftp });
    const unsub = connection.onClose(() => {
      this.cleanupSession(server.id);
    });
    this.unsubscribers.set(server.id, unsub);
  }

  private getSftp(serverId: string): SFTPWrapper {
    const session = this.sessions.get(serverId);
    if (!session) {
      throw new Error(`No SFTP session for server ${serverId}`);
    }
    return session.sftp;
  }

  private cleanupSession(serverId: string): void {
    this.sessions.delete(serverId);
    const unsub = this.unsubscribers.get(serverId);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(serverId);
    }
    this.invalidateCache(serverId);
  }

  private evictCacheIfNeeded(): void {
    while (this.dirCache.size > this.maxCacheEntries) {
      const oldest = this.dirCache.keys().next().value;
      if (!oldest) {
        return;
      }
      this.dirCache.delete(oldest);
    }
  }

  private async deleteRecursive(
    sftp: SFTPWrapper,
    serverId: string,
    dirPath: string,
    depth: number,
    ops: { count: number }
  ): Promise<void> {
    if (depth > this.maxDeleteDepth) {
      throw new Error(`Delete aborted: directory nesting exceeds ${this.maxDeleteDepth} levels`);
    }
    const entries = await this.readDirectory(serverId, dirPath);
    for (const entry of entries) {
      if (++ops.count > this.maxDeleteOps) {
        throw new Error(`Delete aborted: more than ${this.maxDeleteOps} items`);
      }
      const fullPath = path.posix.join(dirPath, entry.name);
      if (entry.isDirectory && !entry.isSymlink) {
        await this.deleteRecursive(sftp, serverId, fullPath, depth + 1, ops);
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(fullPath, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(dirPath, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
