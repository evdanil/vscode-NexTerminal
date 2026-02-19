import * as path from "node:path";
import type { SFTPWrapper, FileEntry, Stats } from "ssh2";
import type { ServerConfig } from "../../models/config";
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

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_DELETE_DEPTH = 100;
const MAX_DELETE_OPS = 10_000;

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

function cacheKey(serverId: string, remotePath: string): string {
  return `${serverId}:${remotePath}`;
}

export class SftpService {
  private readonly sessions = new Map<string, SftpSession>();
  private readonly dirCache = new Map<string, CacheEntry>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly pending = new Map<string, Promise<void>>();

  public constructor(private readonly sshFactory: SshFactory) {}

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
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
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
    const sftp = await connection.openSftp();
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
    if (this.dirCache.size <= MAX_CACHE_ENTRIES) {
      return;
    }
    const oldest = this.dirCache.keys().next().value;
    if (oldest) {
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
    if (depth > MAX_DELETE_DEPTH) {
      throw new Error(`Delete aborted: directory nesting exceeds ${MAX_DELETE_DEPTH} levels`);
    }
    const entries = await this.readDirectory(serverId, dirPath);
    for (const entry of entries) {
      if (++ops.count > MAX_DELETE_OPS) {
        throw new Error(`Delete aborted: more than ${MAX_DELETE_OPS} items`);
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
