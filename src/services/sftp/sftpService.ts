import * as path from "node:path";
import { createReadStream, promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SFTPWrapper, FileEntry, Stats, TransferOptions } from "ssh2";
import type { ServerConfig } from "../../models/config";
import { clamp, normalizeBoundedNumber as normalizeConfigValue } from "../../utils/helpers";
import { shellEscape } from "../../utils/shellEscape";
import { isSafeEntryName, joinRemoteEntryPath } from "../../utils/pathSafety";
import { resolveTransferTuning } from "../../utils/networkPath";
import type { SshConnection, SshFactory } from "../ssh/contracts";
import { RemoteDirectoryWatcher, type RemoteChangeEvent, type WatchMode } from "./remoteDirectoryWatcher";
import {
  buildTempStagePath,
  runElevatedInstall,
  type ElevatedExec,
} from "./elevatedWrite";

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
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_DELETE_DEPTH = 100;
const MAX_DELETE_OPS = 10_000;
const SSH_FX_NO_SUCH_FILE = 2;
const SSH_FX_PERMISSION_DENIED = 3;

/**
 * Ceiling on how many bytes of a single file may be held in the extension
 * host's heap at once. Only the "claimed-zero" transfer paths buffer at all —
 * a file whose stat reports 0 bytes cannot be size-planned, so it has to be
 * read to EOF to find out what is really there. Without a cap, a remote
 * `/dev/zero`, a pseudo-file that never EOFs, or an appliance file that
 * mis-reports its size exhausts the heap, and an extension-host OOM takes down
 * every terminal session — the exact failure class this transfer work exists to
 * eliminate. The idle timeout bounds TIME, not MEMORY.
 *
 * Backed by `nexus.sftp.maxOpenFileSizeMB`, which already governs the other
 * whole-file-into-memory path (opening a remote file in the editor). Same
 * resource, same unit, one dial.
 */
const MAX_IN_MEMORY_TRANSFER_SETTING = "nexus.sftp.maxOpenFileSizeMB";
const DEFAULT_MAX_IN_MEMORY_TRANSFER_BYTES = 5 * 1024 * 1024;
const MIN_MAX_IN_MEMORY_TRANSFER_BYTES = 1024 * 1024;
const MAX_MAX_IN_MEMORY_TRANSFER_BYTES = 200 * 1024 * 1024;

function createTimeoutError(label: string, timeoutMs: number): Error {
  return new Error(`SFTP ${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * ssh2's SFTP WriteStream, typed for what this file asks of it: `write(chunk, cb)`
 * and `end()` come from `NodeJS.WritableStream`; `destroy(error)` has to be widened
 * because `@types/ssh2` narrows `destroy()` to zero arguments while ssh2 leaves
 * node's own `Writable.prototype.destroy(error, cb)` in place on every Node version
 * this extension runs on — and passing the error is what suppresses the misleading
 * 'close' that a bare `destroy()` would emit after an aborted write.
 */
type SftpWriteStream = NodeJS.WritableStream & {
  destroy(error?: Error): void;
};

function withTimeout<T>(
  label: string,
  timeoutMs: number,
  executor: (resolve: (value: T) => void, reject: (reason: unknown) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const rejectOnce = (reason: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(reason);
    };
    const timer = setTimeout(() => {
      rejectOnce(createTimeoutError(label, timeoutMs));
    }, timeoutMs);
    try {
      executor(resolveOnce, rejectOnce);
    } catch (error) {
      rejectOnce(error);
    }
  });
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: number | string; message?: string };
  if (candidate.code === SSH_FX_NO_SUCH_FILE || candidate.code === "ENOENT") {
    return true;
  }
  return typeof candidate.message === "string" && /\b(no such file|not found)\b/i.test(candidate.message);
}

function isStrictMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: number | string };
  return (
    candidate.code === SSH_FX_NO_SUCH_FILE ||
    candidate.code === "2" ||
    candidate.code === "ENOENT"
  );
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

function formatSeconds(elapsedMs: number): string {
  return (elapsedMs / 1000).toFixed(1);
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
  operationTimeoutMs?: number;
  maxDeleteDepth?: number;
  maxDeleteOps?: number;
  /** See `MAX_IN_MEMORY_TRANSFER_SETTING`. Sourced from `nexus.sftp.maxOpenFileSizeMB`. */
  maxInMemoryTransferBytes?: number;
}

export class SftpService {
  private readonly sessions = new Map<string, SftpSession>();
  private readonly dirCache = new Map<string, CacheEntry>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, RemoteDirectoryWatcher>();
  private readonly changeListeners: Array<(event: RemoteChangeEvent) => void> = [];
  private cacheTtlMs: number;
  private maxCacheEntries: number;
  private commandTimeoutMs: number;
  private operationTimeoutMs: number;
  private maxDeleteDepth: number;
  private maxDeleteOps: number;
  private maxInMemoryTransferBytes: number;

  public constructor(
    private readonly sshFactory: SshFactory,
    config?: SftpServiceConfig,
    private readonly diagnostics?: (line: string) => void
  ) {
    this.cacheTtlMs = normalizeConfigValue(config?.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 300_000);
    this.maxCacheEntries = normalizeConfigValue(config?.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 10, 5_000);
    this.commandTimeoutMs = normalizeConfigValue(config?.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 10_000, 3_600_000);
    this.operationTimeoutMs = normalizeConfigValue(config?.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 5_000, 300_000);
    this.maxDeleteDepth = normalizeConfigValue(config?.maxDeleteDepth, MAX_DELETE_DEPTH, 10, 500);
    this.maxDeleteOps = normalizeConfigValue(config?.maxDeleteOps, MAX_DELETE_OPS, 100, 100_000);
    this.maxInMemoryTransferBytes = normalizeConfigValue(
      config?.maxInMemoryTransferBytes,
      DEFAULT_MAX_IN_MEMORY_TRANSFER_BYTES,
      MIN_MAX_IN_MEMORY_TRANSFER_BYTES,
      MAX_MAX_IN_MEMORY_TRANSFER_BYTES
    );
  }

  public updateConfig(config: SftpServiceConfig): void {
    this.cacheTtlMs = normalizeConfigValue(config.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 300_000);
    this.maxCacheEntries = normalizeConfigValue(config.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 10, 5_000);
    if (config.commandTimeoutMs != null) {
      this.commandTimeoutMs = normalizeConfigValue(config.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 10_000, 3_600_000);
    }
    if (config.operationTimeoutMs != null) {
      this.operationTimeoutMs = normalizeConfigValue(config.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 5_000, 300_000);
    }
    if (config.maxDeleteDepth != null) {
      this.maxDeleteDepth = normalizeConfigValue(config.maxDeleteDepth, MAX_DELETE_DEPTH, 10, 500);
    }
    if (config.maxDeleteOps != null) {
      this.maxDeleteOps = normalizeConfigValue(config.maxDeleteOps, MAX_DELETE_OPS, 100, 100_000);
    }
    if (config.maxInMemoryTransferBytes != null) {
      this.maxInMemoryTransferBytes = normalizeConfigValue(
        config.maxInMemoryTransferBytes,
        DEFAULT_MAX_IN_MEMORY_TRANSFER_BYTES,
        MIN_MAX_IN_MEMORY_TRANSFER_BYTES,
        MAX_MAX_IN_MEMORY_TRANSFER_BYTES
      );
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
    this.teardownSession(serverId, session, "disconnect requested");
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

    const result = await this.readDirectoryUncached(serverId, remotePath);

    this.dirCache.set(key, { entries: result, fetchedAt: Date.now() });
    this.evictCacheIfNeeded();
    return result;
  }

  public async stat(serverId: string, remotePath: string): Promise<DirectoryEntry> {
    const sftp = this.getSftp(serverId);
    const stats = await withTimeout<Stats>("stat", this.operationTimeoutMs, (resolve, reject) => {
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
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private readFileWithTimeout(
    maxSize: number | undefined,
    timeoutMs: number,
    createStream: () => NodeJS.ReadableStream & { destroy(error?: Error): void }
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let settled = false;
      const fail = (reason: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(reason);
      };
      const succeed = (value: Buffer): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const error = createTimeoutError("readFile", timeoutMs);
        stream.destroy(error);
        fail(error);
      }, timeoutMs);

      const stream = createStream();
      stream.on("data", (chunk: Buffer | string) => {
        const buffer = toBufferChunk(chunk);
        totalSize += buffer.length;
        if (maxSize !== undefined && totalSize > maxSize) {
          stream.destroy();
          fail(
            new Error(
              `File exceeds maximum size of ${Math.round(maxSize / 1024 / 1024)}MB ` +
                `(raise ${MAX_IN_MEMORY_TRANSFER_SETTING} to allow more)`
            )
          );
          return;
        }
        chunks.push(buffer);
      });
      stream.on("end", () => succeed(Buffer.concat(chunks)));
      stream.on("error", fail);
    });
  }

  /**
   * Pushes a buffer through an ssh2 SFTP WriteStream, resolving ONLY once the
   * server has acknowledged every byte AND closed the handle cleanly.
   *
   * The success signal cannot be the 'close' event on its own, and that is the
   * whole point of this helper. Verified against ssh2 1.17.0
   * (`lib/protocol/SFTP.js`) driven through a stubbed SFTP on the Node 20 the
   * extension host runs: a REFUSED write and a fully SUCCESSFUL one emit exactly
   * the same thing — one 'close', nothing else.
   *  - `WriteStream.prototype._write` (:3970) answers a rejected SSH_FXP_WRITE
   *    with `this.destroy()` — WITHOUT the error — and only THEN `cb(er)`. Node's
   *    `errorOrDestroy` short-circuits on the already-destroyed stream, so no
   *    'error' is ever emitted. `_writev` (:3993) is identical.
   *  - `closeStream` (:3807) emits 'close' whenever the SSH_FXP_CLOSE itself
   *    succeeded, which it does: the handle closes fine, it just has nothing (or
   *    a truncated prefix) in it. So the old `on("close", succeed)` reported
   *    ENOSPC, an over-quota home directory, or an appliance refusing the path as
   *    a completed write.
   *
   * 'finish' cannot be the gate either, tempting as it looks. `_final` (:3887)
   * calls `this.destroy()` BEFORE its callback, and node's `needFinish()` requires
   * `!state.destroyed`, so 'finish' NEVER fires on this stream — not on the
   * refused path, and not on the successful one either (`writableFinished` is
   * false even after a write that moved every byte). Gating on it would fail every
   * elevated save. `end(content, cb)` is unusable for the same reason: that
   * `destroy()` drains the end-callbacks through `errorBuffer`, so on a SUCCESSFUL
   * write the callback fires with `ERR_STREAM_DESTROYED: Cannot call end after a
   * stream was destroyed`.
   *
   * What does report truthfully is the per-write callback of `write(chunk, cb)`.
   * Node routes a failed write through `onwriteError`, which invokes that callback
   * with the server's own error before the destroyed state can swallow it (ssh2
   * carries the SSH_FXP_STATUS message through, so it reads "No space left on
   * device" rather than a bare code), and invokes it with no argument only once
   * `SFTP.prototype.write` has seen every split chunk of the buffer acknowledged.
   * Both halves are then required for success: the bytes ACKed, and a clean
   * 'close' — a server that defers ENOSPC to SSH_FXP_CLOSE reports it there, and a
   * failing close arrives as 'error' rather than 'close'.
   *
   * This matters most for its caller. `writeFileElevated` sudo-moves the staged
   * file over a privileged target with no size verification anywhere on the path,
   * so a promise resolved here is the only thing between a refused write and an
   * /etc file overwritten with a truncated one.
   */
  private writeFileWithTimeout(
    timeoutMs: number,
    content: Buffer,
    createStream: () => SftpWriteStream
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let bytesAcknowledged = false;
      const fail = (reason: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(reason);
      };
      const succeed = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const error = createTimeoutError("writeFile", timeoutMs);
        stream.destroy(error);
        fail(error);
      }, timeoutMs);

      const stream = createStream();
      stream.on("close", () => {
        if (bytesAcknowledged) {
          succeed();
          return;
        }
        // The handle closed cleanly without the write ever being acknowledged or
        // reported as failed. Unreachable through ssh2's own paths, which is
        // exactly why it must not be assumed success: nothing downstream checks
        // the staged file's size.
        fail(new Error("SFTP writeFile failed: the file was closed before the server acknowledged the data"));
      });
      stream.on("error", fail);
      stream.write(content, (error) => {
        if (error) {
          fail(new Error(`SFTP writeFile failed: the server rejected the write (${error.message})`));
          return;
        }
        bytesAcknowledged = true;
      });
      stream.end();
    });
  }

  public async lstat(serverId: string, remotePath: string): Promise<DirectoryEntry> {
    const sftp = this.getSftp(serverId);
    const stats = await withTimeout<Stats>("lstat", this.operationTimeoutMs, (resolve, reject) => {
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
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async readFile(serverId: string, remotePath: string, maxSize?: number): Promise<Buffer> {
    const sftp = this.getSftp(serverId);
    return this.readFileWithTimeout(
      maxSize,
      this.commandTimeoutMs,
      () => sftp.createReadStream(remotePath) as NodeJS.ReadableStream & { destroy(error?: Error): void }
    );
  }

  /**
   * The whole-file write behind an editor save (`NexusFileSystemProvider.writeFile`)
   * and the File Explorer's New File command.
   *
   * Routed through `putBufferPreservingMode` for the reason documented there:
   * ssh2's `createWriteStream` fchmods every open to its `mode` — 0o666 when the
   * caller passes none — so saving over a 0600 file (an SSH private key, a
   * credentials file) silently made it world-readable AND world-writable. That
   * happened at OPEN time, before a single byte moved, so even a save that then
   * failed had already widened the file; and a newly created file landed at
   * exactly 0666, the follow-up fchmod defeating the server's umask.
   *
   * Note there is no post-write size verification on this path, unlike
   * `upload()`/`download()`. That is precisely why the helper's error reporting
   * has to be exact: nothing downstream would catch a write that silently moved
   * no bytes.
   */
  public async writeFile(serverId: string, remotePath: string, content: Buffer): Promise<void> {
    const session = this.getSession(serverId);
    await this.putBufferPreservingMode(serverId, session, remotePath, content);
    this.invalidateCache(serverId, parentDir(remotePath));
  }

  /**
   * Writes content to a root-owned (or otherwise permission-denied) remote file by
   * staging it to a user-writable /tmp path over SFTP, then moving it into place with
   * sudo over an SSH exec channel. Whether the target already exists is never
   * resolved here via an up-front `stat` — this staging upload can be slow, and a
   * stat done before it started would leave a window where the target is deleted or
   * log-rotated before the install runs. See `buildSudoInstallCommand` for how the
   * install itself now avoids that race without an existence check at all.
   *
   * If the target has vanished since it was last read (log rotation, a concurrent
   * delete), this recreates it: `options.createMode` — the mode the caller last
   * observed via stat/readFile — governs the umask used for that recreate instead of
   * a hardcoded 644, so a recreate can't silently widen a root-owned file's
   * permissions.
   */
  public async writeFileElevated(
    serverId: string,
    remotePath: string,
    content: Buffer,
    options?: { password?: string; createMode?: number }
  ): Promise<void> {
    const session = this.getSession(serverId);
    const tempPath = buildTempStagePath(randomUUID());

    try {
      await this.writeFileWithTimeout(
        this.commandTimeoutMs,
        content,
        () =>
          // An explicit 0600 is REQUIRED here: ssh2's createWriteStream both
          // opens with `mode` and fchmods to it (see putBufferPreservingMode),
          // so the default 0666 would leave the staged content readable AND
          // writable by every local user on the remote host for the whole
          // upload window. Narrowing rather than widening, and the target is a
          // freshly-named temp path we own, so the fchmod is wanted here.
          session.sftp.createWriteStream(tempPath, { mode: 0o600 }) as SftpWriteStream
      );
      await runElevatedInstall(this.makeElevatedExec(serverId), {
        tempPath,
        targetPath: remotePath,
        password: options?.password,
        createMode: options?.createMode,
      });
    } finally {
      try {
        await this.unlink(session.sftp, tempPath);
      } catch {
        // Best-effort cleanup: a failed removal of the staged temp file must not
        // mask the primary write/elevation error.
      }
    }
    this.invalidateCache(serverId, parentDir(remotePath));
  }

  private makeElevatedExec(serverId: string): ElevatedExec {
    // Elevation exec calls use operationTimeoutMs (30s default), not the much longer
    // commandTimeoutMs (300s default): a wedged sudo must fail fast rather than block
    // an interactive save for minutes.
    return (command, stdin) => this.execCommand(serverId, command, this.operationTimeoutMs, stdin);
  }

  public async delete(
    serverId: string,
    remotePath: string,
    options: { recursive?: boolean } = {}
  ): Promise<void> {
    const sftp = this.getSftp(serverId);
    const recursive = options.recursive !== false;
    const parentPath = parentDir(remotePath);
    try {
      const entry = await this.lstat(serverId, remotePath);
      if (entry.isSymlink || !entry.isDirectory) {
        await this.unlink(sftp, remotePath);
      } else if (!recursive) {
        throw new Error("Directory is not empty (use recursive delete)");
      } else {
        await this.deleteRecursive(sftp, serverId, remotePath, 0, { count: 0 });
      }
    } finally {
      this.invalidateCache(serverId, parentPath);
      this.invalidateCacheTree(serverId, remotePath);
    }
  }

  private async unlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    await withTimeout<void>("unlink", this.operationTimeoutMs, (resolve, reject) => {
      sftp.unlink(remotePath, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async readDirectoryUncached(serverId: string, remotePath: string): Promise<DirectoryEntry[]> {
    const sftp = this.getSftp(serverId);
    const entries = await withTimeout<FileEntry[]>(
      "readdir",
      this.operationTimeoutMs,
      (resolve, reject) => {
        sftp.readdir(remotePath, (error, list) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(list);
        });
      }
    );

    return entries
      .filter((e) => e.filename !== "." && e.filename !== "..")
      .map(toDirectoryEntry);
  }

  public async rename(serverId: string, oldPath: string, newPath: string): Promise<void> {
    const sftp = this.getSftp(serverId);
    await withTimeout<void>("rename", this.operationTimeoutMs, (resolve, reject) => {
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
    await withTimeout<void>("mkdir", this.operationTimeoutMs, (resolve, reject) => {
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
    return withTimeout<string>("realpath", this.operationTimeoutMs, (resolve, reject) => {
      sftp.realpath(remotePath, (error, absPath) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(absPath);
      });
    });
  }

  private async execCommand(
    serverId: string,
    command: string,
    timeoutMs?: number,
    stdin?: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

      // `sudo -S` reads the password from stdin and needs EOF to stop waiting;
      // closing stdin unconditionally is a no-op for commands that ignore it (e.g.
      // copyRemote's `cp`).
      if (stdin !== undefined) {
        stream.write(stdin);
      }
      stream.end();
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

  /**
   * Downloads `remotePath` into `localPath`.
   *
   * THIS METHOD NEITHER CREATES NOR TRUNCATES THE DESTINATION. Both are left
   * entirely to ssh2, which already does them at the only safe moment:
   * `fastXfer` (SFTP.js) runs `src.open(srcPath,'r')` -> fstat and opens `dst`
   * with `'w'` INSIDE that callback, so the local file is created or emptied
   * only once the remote file is known to be open and readable. An early
   * version of this method opened the local file with `'w'` up front and cost
   * the user their existing local copy whenever the remote had vanished, was
   * unreadable, or the connection was down; moving that open after our own
   * `stat()` narrowed the window but did not close it — a file deleted or
   * rotated between our `stat()` and ssh2's `open()` still left a truncated
   * local file behind. A later version opened with `'a'`: non-truncating, but
   * still CREATING, so a failed download had to delete its own placeholder
   * afterwards — and that cleanup could not reliably tell a file it had just
   * made from one that was already there (a DANGLING SYMLINK stats as ENOENT,
   * so `'a'` created its target and the cleanup then unlinked the user's
   * symlink). Probing without creating removes the whole class of problem:
   * there is nothing left to undo.
   *
   * The pre-flight therefore exists for ONE reason, and it touches no file at
   * all: containment of SYNCHRONOUS throws. See
   * `assertLocalDestinationReachable`.
   *
   * The remote `stat()` still comes first, mirroring ssh2's own ordering: work
   * on the local side is pointless when the remote file is already gone.
   *
   * The claimed-zero branch needs no pre-flight at all: `fsp.writeFile` is our
   * own local write, on our own stack, and it runs only after the remote bytes
   * are already in hand — so a failed remote read leaves the local file intact.
   *
   * Errors from the pre-flight propagate UNWRAPPED — callers match on
   * `err.code` (see `isUNCAccessError`), never on message text.
   */
  public async download(serverId: string, remotePath: string, localPath: string): Promise<void> {
    const session = this.getSession(serverId);
    const startedAt = Date.now();

    try {
      const remoteEntry = await this.stat(serverId, remotePath);
      let expectedBytes: number;
      if (remoteEntry.size === 0) {
        // A remote stat of 0 is not trustworthy (procfs, sysfs, some appliances
        // report 0 for readable files), and ssh2's size-planned path treats
        // `fsize <= 0` as "done" and calls back with NO error — a green toast
        // over an empty file. Read to EOF instead and transfer what is actually
        // there; a genuinely empty file still round-trips as an empty file.
        // Bounded: an unknown-size read into the extension host's heap without a
        // ceiling is an OOM waiting for /dev/zero.
        const content = await this.readFileWithTimeout(
          this.maxInMemoryTransferBytes,
          this.commandTimeoutMs,
          () => session.sftp.createReadStream(remotePath) as NodeJS.ReadableStream & { destroy(error?: Error): void }
        );
        expectedBytes = content.length;
        await fsp.writeFile(localPath, content);
      } else {
        expectedBytes = remoteEntry.size;
        await this.assertLocalDestinationReachable(localPath);
        await this.runTransferWithIdleTimeout(serverId, session, "download", (options, callback) => {
          session.sftp.fastGet(
            remotePath,
            localPath,
            { ...options, ...resolveTransferTuning(localPath), fileSize: remoteEntry.size },
            callback
          );
        });
      }
      await this.verifyTransferredSize("download", localPath, expectedBytes, async () => (await fsp.stat(localPath)).size);
      this.diagnostics?.(
        `[sftp] download ${serverId}:${remotePath} -> ${localPath}: ${expectedBytes} bytes OK (${formatSeconds(Date.now() - startedAt)}s)`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics?.(`[sftp] download ${serverId}:${remotePath} -> ${localPath} FAILED: ${message}`);
      throw error;
    }
  }

  /**
   * Uploads `localPath` to `remotePath`.
   *
   * The pre-stat doubles as the local-side pre-flight (UNC policy, permissions,
   * existence all fail here, on our stack, with the true `err.code`) and as the
   * size ssh2 plans the transfer with — passing it explicitly makes ssh2's
   * `fsize <= 0` "success with no bytes moved" branch structurally unreachable.
   *
   * Known unchanged ssh2 edge: a source file that SHRINKS mid-transfer can spin
   * fastXfer's short-read loop until the idle timeout fires. That is pre-existing
   * behavior; passing `fileSize` does not widen the exposure (ssh2 would have
   * fstat'd the same size itself).
   */
  public async upload(serverId: string, localPath: string, remotePath: string): Promise<void> {
    const session = this.getSession(serverId);
    const startedAt = Date.now();

    const localSize = (await fsp.stat(localPath)).size;

    try {
      let expectedBytes: number;
      if (localSize === 0) {
        // See download(): a claimed-zero source is read to EOF rather than
        // size-planned, so a lying stat transfers the real bytes instead of
        // producing a truthful-looking empty upload. Streamed through the same
        // bounded reader as the remote side — a plain `fsp.readFile` here would
        // happily pull /dev/zero into the extension host's heap.
        const content = await this.readFileWithTimeout(
          this.maxInMemoryTransferBytes,
          this.commandTimeoutMs,
          () => createReadStream(localPath)
        );
        expectedBytes = content.length;
        await this.putBufferPreservingMode(serverId, session, remotePath, content);
      } else {
        expectedBytes = localSize;
        await this.runTransferWithIdleTimeout(serverId, session, "upload", (options, callback) => {
          session.sftp.fastPut(
            localPath,
            remotePath,
            { ...options, ...resolveTransferTuning(localPath), fileSize: localSize },
            callback
          );
        });
      }
      await this.verifyTransferredSize("upload", remotePath, expectedBytes, async () =>
        (await this.stat(serverId, remotePath)).size
      );
      this.diagnostics?.(
        `[sftp] upload ${localPath} -> ${serverId}:${remotePath}: ${expectedBytes} bytes OK (${formatSeconds(Date.now() - startedAt)}s)`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics?.(`[sftp] upload ${localPath} -> ${serverId}:${remotePath} FAILED: ${message}`);
      throw error;
    } finally {
      // A failed or partial upload has still mutated the remote directory, so
      // the listing cache is stale either way.
      this.invalidateCache(serverId, parentDir(remotePath));
    }
  }

  /**
   * Pre-flight probe of a download destination, performed on OUR stack so
   * Node's synchronous path validation becomes a rejection here instead of a
   * throw inside ssh2's socket-data callback. See `download()`.
   *
   * WHAT IT CONTAINS. ssh2 opens the destination from inside the remote
   * callback chain, which runs on the `net.Socket` 'data' stack, so a
   * synchronous throw from Node's path validation there unwinds the ssh2
   * protocol parser and destroys the `ssh2.Client` that every terminal tab
   * multiplexes onto. That validation is `getValidatedPath` -> `validatePath`,
   * which every `fs` entry point — sync, callback and promise alike — runs as
   * its FIRST statement, before the binding call; it raises
   * `ERR_UNC_HOST_NOT_ALLOWED` (VS Code's `security.restrictUNCAccess`, whose
   * host check Microsoft's Electron/Node patch adds inside `validatePath`
   * itself), `ERR_INVALID_ARG_VALUE` for embedded null bytes and
   * `ERR_INVALID_ARG_TYPE` for a non-string path. Running any `fs` call on the
   * path first turns that whole class of fault into an ordinary rejection.
   *
   * WHY `lstat`, AND WHY NOTHING IS CREATED. The validation above is
   * pre-syscall, so a bare metadata read trips it exactly as an `open` would —
   * `upload()`'s pre-stat and the UNC remediation re-probe already depend on
   * that. Because the check runs before the syscall, a blocked host reports
   * `ERR_UNC_HOST_NOT_ALLOWED` whether or not the destination exists; the file
   * never has to be created for the containment to work. `lstat` and not
   * `stat`: it must not follow symlinks, or a dangling symlink here reports
   * ENOENT and every conclusion drawn from that is about the wrong inode.
   * Creating and truncating stay with ssh2's own `dst.open(dstPath,'w')`,
   * which runs only after the remote open and fstat have succeeded.
   *
   * ENOENT — "nothing there yet" — is the normal case for a download and is
   * the ONE error swallowed. Everything else propagates UNWRAPPED so callers
   * can match on `err.code` (see `isUNCAccessError`).
   *
   * ACCEPTED TRADE: an `lstat` needs only search permission on the parent, so
   * destination-side faults that only a write reveals — `EACCES` on the
   * directory, `EROFS`, `EISDIR` — no longer surface from the pre-flight.
   * They go back to being ordinary async rejections delivered through ssh2's
   * callback. That is not an S2 regression, because only SYNCHRONOUS throws
   * unwind the protocol parser and those faults are reported asynchronously by
   * the filesystem; the cost is plainly less immediate error clarity, paid to
   * keep this method from ever creating a file it might have to delete.
   */
  private async assertLocalDestinationReachable(localPath: string): Promise<void> {
    try {
      await fsp.lstat(localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  /**
   * Writes a whole buffer to `remotePath` WITHOUT touching the file's mode, and
   * reports the outcome truthfully.
   *
   * NOT `createWriteStream`, on either of the two shapes that were tried.
   *
   * `createWriteStream(remotePath)` plain: ssh2's WriteStream sends SSH_FXP_OPEN
   * with its `mode` attr AND then issues an unconditional `fchmod(handle, mode)`
   * on every open (SFTP.js `WriteStream.prototype.open`), falling back to
   * `chmod(path, mode)` if the server refuses fchmod. With the default mode of
   * 0o666 that silently widens an existing remote file to world-readable and
   * world-writable, and on a NEW file it also defeats the server's umask —
   * neither of which `fastPut` does, so the size-planned and claimed-zero
   * branches of `upload()` would disagree about permissions.
   *
   * `createWriteStream(remotePath, { handle })` — opening the handle ourselves so
   * the WriteStream skips `open()`, and with it the fchmod — fixed the mode but
   * introduced something worse, and is what this now reverses:
   *
   *  1. A FAILED WRITE REPORTED SUCCESS. `WriteStream.prototype._write`
   *     (SFTP.js:3970) reacts to a rejected SSH_FXP_WRITE with
   *     `if (this.autoClose) this.destroy();` — `destroy()` with NO error — and
   *     only then `cb(er)`. Because the stream is already destroyed by the time
   *     that callback runs, node's `errorOrDestroy` short-circuits and never
   *     emits 'error'; `closeStream` then sees no error and emits 'close'. A
   *     success listener on 'close' therefore fires for a write that moved no
   *     bytes — ENOSPC, an over-quota mailbox, an appliance refusing the path.
   *     `_writev` (:3993) has the identical shape. Verified empirically on the
   *     Node 20 the extension host runs.
   *  2. THE OVERFLOW CHAIN OUTLIVED THE STREAM. `SFTP.prototype.write` (:442)
   *     splits a buffer over `_maxWriteLen` and continues from inside its own
   *     request callback with the captured handle, so `destroy()` cannot stop it.
   *     If the server recycled that opaque handle value for a retry's OPEN, a
   *     stale WRITE could land on the retry's file.
   *
   * `sftp.writeFile(path, content, { flag: "w" }, cb)` has neither problem. It is
   * mode-preserving for the same reason the injected handle was — an options
   * OBJECT with no `mode` leaves `options.mode` undefined, so
   * `open(path, flag, undefined, cb)` sends SSH_FXP_OPEN with no ATTRS and
   * nothing chmods anywhere — and, decisively, it reports failure through a
   * CALLBACK rather than through stream events: `writeAll` (:2393) answers a
   * rejected write with `sftp.close(handle, () => callback(writeErr))`, so the
   * error reaches us on every path. That is the property this path needs above
   * all others, because `writeFile()` above has no post-write size check to fall
   * back on. The options object is not optional: OMITTING it makes ssh2 default
   * `mode` to 0o666 and the widening returns.
   *
   * Cancellation is then the same mechanism `fastPut`/`fastGet` already use.
   * `writeFile` exposes no handle, so on timeout the SFTP SESSION is torn down
   * (`teardownSession`, exactly as `abortTimedOutTransfer` does): `sftp.end()`
   * closes the channel, ssh2's `cleanupRequests` (:2723) errors every pending
   * request so the in-flight `writeAll` chain terminates instead of dribbling on,
   * and any retry runs on a fresh session with its own handle space — which is
   * also what makes the recycled-handle race of (2) unreachable.
   *
   * The cost is real and accepted: teardown drops the SFTP session the File
   * Explorer shares, so the next browse reconnects. That is proportionate for a
   * save that has already been stalled for `commandTimeoutMs` — the session is
   * demonstrably not serving anyone at that point — and it releases the pool
   * lease rather than leaking it, which a bare `cleanupSession()` would not.
   * Terminal sessions leasing the same `ssh2.Client` are unaffected.
   */
  private putBufferPreservingMode(
    serverId: string,
    session: SftpSession,
    remotePath: string,
    content: Buffer
  ): Promise<void> {
    const timeoutMs = this.commandTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (reason?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (reason) {
          reject(reason);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        // Settle BEFORE tearing down: `cleanupRequests` errors the pending
        // request, which reaches writeAll's callback below, and the caller must
        // see the timeout rather than ssh2's 'No response from server'.
        settle(createTimeoutError("writeFile", timeoutMs));
        this.teardownSession(serverId, session, "whole-file write timed out");
      }, timeoutMs);

      try {
        session.sftp.writeFile(remotePath, content, { flag: "w" }, (error) => {
          settle(error ?? undefined);
        });
      } catch (error) {
        settle(error);
      }
    });
  }

  /**
   * Post-transfer size check. SIZE ONLY — this catches truncation and the
   * zero-byte "success" that ssh2 could previously report, not corruption. The
   * baseline is the exact byte count the transfer was planned with, so a
   * mismatch means the destination does not hold what we sent.
   */
  private async verifyTransferredSize(
    label: "upload" | "download",
    targetPath: string,
    expectedBytes: number,
    readActualSize: () => Promise<number>
  ): Promise<void> {
    let actualBytes: number;
    try {
      actualBytes = await readActualSize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SFTP ${label} completed but verification failed: ${message}`);
    }
    if (actualBytes !== expectedBytes) {
      const side = label === "upload" ? "remote" : "local";
      throw new Error(
        `SFTP ${label} verification failed for "${targetPath}": expected ${expectedBytes} bytes, ${side} reports ${actualBytes}`
      );
    }
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

  private invalidateCacheTree(serverId: string, remotePath: string): void {
    const exactKey = cacheKey(serverId, remotePath);
    const childPrefix = remotePath === "/"
      ? `${serverId}:/`
      : `${exactKey}/`;

    for (const key of this.dirCache.keys()) {
      if (key === exactKey || key.startsWith(childPrefix)) {
        this.dirCache.delete(key);
      }
    }
  }

  public onRemoteChange(listener: (event: RemoteChangeEvent) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const index = this.changeListeners.indexOf(listener);
      if (index >= 0) {
        this.changeListeners.splice(index, 1);
      }
    };
  }

  public async startWatching(serverId: string, dirPath: string, pollIntervalMs: number): Promise<WatchMode | undefined> {
    const session = this.sessions.get(serverId);
    if (!session) {
      return undefined;
    }

    let watcher = this.watchers.get(serverId);
    if (!watcher) {
      watcher = new RemoteDirectoryWatcher(session.connection, serverId);
      watcher.onDidChange((event) => {
        this.invalidateCacheTree(event.serverId, event.dirPath);
        for (const listener of this.changeListeners) {
          listener(event);
        }
      });
      this.watchers.set(serverId, watcher);
    }

    return watcher.watch(dirPath, pollIntervalMs);
  }

  public stopWatching(serverId: string): void {
    const watcher = this.watchers.get(serverId);
    if (watcher) {
      watcher.dispose();
      this.watchers.delete(serverId);
    }
  }

  public getWatchMode(serverId: string): WatchMode | undefined {
    return this.watchers.get(serverId)?.mode;
  }

  public dispose(): void {
    for (const serverId of [...this.sessions.keys()]) {
      this.disconnect(serverId);
    }
    for (const [serverId, watcher] of this.watchers) {
      watcher.dispose();
    }
    this.watchers.clear();
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
    const session: SftpSession = { connection, sftp };
    this.sessions.set(server.id, session);
    // Without these two listeners a fatal SFTP protocol error (ssh2's
    // `doFatalSFTPError`) reaches an unlistened EventEmitter, so Node throws
    // ERR_UNHANDLED_ERROR *synchronously inside* the SFTP packet handler — which
    // runs on the ssh2 CHANNEL_DATA / `net.Socket` 'data' stack. That exception
    // unwinds the protocol parser and tears down the shared `ssh2.Client`, i.e.
    // every terminal tab multiplexed onto this server drops at once. Listening
    // turns the same fault into a contained session teardown.
    sftp.on("error", (error: Error) => {
      this.teardownSession(server.id, session, `SFTP channel error: ${error.message}`);
    });
    sftp.on("close", () => {
      this.teardownSession(server.id, session, "SFTP channel closed");
    });
    // Full teardown, not a bare cleanupSession(): dropping only the map entry
    // left `connection.dispose()` uncalled, so the pool kept this session's
    // SFTP refcount forever and the entry could never reach orphan cleanup once
    // the terminal leases released. Re-entry is safe — cleanupSession() drops
    // the mapping and unsubscribes this very listener before `sftp.end()` runs,
    // so the identity guard short-circuits the follow-on 'close', and
    // PooledSshConnection.dispose() carries its own `disposed` guard on top.
    const unsub = connection.onClose(() => {
      this.teardownSession(server.id, session, "SSH connection closed");
    });
    this.unsubscribers.set(server.id, unsub);
  }

  private getSession(serverId: string): SftpSession {
    const session = this.sessions.get(serverId);
    if (!session) {
      throw new Error(`No SFTP session for server ${serverId}`);
    }
    return session;
  }

  private getSftp(serverId: string): SFTPWrapper {
    return this.getSession(serverId).sftp;
  }

  private runTransferWithIdleTimeout(
    serverId: string,
    session: SftpSession,
    label: "download" | "upload",
    executor: (options: TransferOptions, callback: (error?: Error | null) => void) => void
  ): Promise<void> {
    const timeoutMs = this.commandTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        resolve();
      };

      const rejectOnce = (reason: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        reject(reason);
      };

      const armTimer = (): void => {
        clearTimer();
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimer();
          // ssh2 fastGet/fastPut does not expose a cancellation handle. Tear down
          // the SFTP session so a stalled transfer cannot continue silently.
          this.abortTimedOutTransfer(serverId, session);
          reject(createTimeoutError(label, timeoutMs));
        }, timeoutMs);
      };

      armTimer();
      try {
        executor({
          step: () => {
            if (!settled) {
              armTimer();
            }
          }
        }, (error) => {
          if (error) {
            rejectOnce(error);
            return;
          }
          resolveOnce();
        });
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  private abortTimedOutTransfer(serverId: string, session: SftpSession): void {
    this.teardownSession(serverId, session, "transfer idle timeout");
  }

  /**
   * The single teardown path for an SFTP session — reached from `disconnect()`,
   * from a stalled-transfer abort, from the `'error'`/`'close'` listeners on the
   * SFTP channel (C1), and from the underlying client's own close.
   *
   * Idempotent by session identity: `sftp.end()` makes ssh2 emit `'close'`, which
   * re-enters here, and a re-entrant `connection.dispose()` would release a pool
   * lease we no longer hold. The mapping is therefore dropped BEFORE `end()` so
   * the identity guard short-circuits the re-entry.
   *
   * `connection.dispose()` is a refcount decrement under multiplexing
   * (`sshConnectionPool.ts`), so this releases only the SFTP lease — terminals
   * leasing the same `ssh2.Client` are unaffected. Operators who want hard
   * isolation for transfers already have per-server `multiplexing: false` (or the
   * global `nexus.ssh.multiplexing.enabled`); no separate transfer connection is
   * opened here, because that would cost a full auth round-trip (a second MFA
   * push) per transfer session.
   */
  private teardownSession(serverId: string, session: SftpSession, reason: string): void {
    if (this.sessions.get(serverId) !== session) {
      return;
    }
    this.cleanupSession(serverId);
    try {
      session.sftp.end();
    } catch {
      // Ignore teardown errors; the session state is already cleared above.
    }
    try {
      session.connection.dispose();
    } catch {
      // Ignore teardown errors; the session state is already cleared above.
    }
    this.diagnostics?.(
      `[sftp] ${serverId}: ${reason} — SFTP session closed; terminal sessions are not affected`
    );
  }

  private cleanupSession(serverId: string): void {
    this.stopWatching(serverId);
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
    const entries = await this.readDirectoryUncached(serverId, dirPath);
    for (const entry of entries) {
      if (!isSafeEntryName(entry.name)) {
        throw new Error(`Delete aborted: unsafe entry name "${entry.name}" at "${dirPath}"`);
      }
      if (++ops.count > this.maxDeleteOps) {
        throw new Error(`Delete aborted: more than ${this.maxDeleteOps} items`);
      }
      const fullPath = joinRemoteEntryPath(dirPath, entry.name);
      if (!fullPath) {
        throw new Error(`Delete aborted: unsafe entry name "${entry.name}" at "${dirPath}"`);
      }

      let childEntry: DirectoryEntry;
      try {
        childEntry = await this.lstat(serverId, fullPath);
      } catch (error) {
        if (isStrictMissingPathError(error)) {
          continue;
        }
        throw error;
      }

      try {
        if (childEntry.isDirectory && !childEntry.isSymlink) {
          await this.deleteRecursive(sftp, serverId, fullPath, depth + 1, ops);
        } else {
          await this.unlink(sftp, fullPath);
        }
      } catch (error) {
        if (isStrictMissingPathError(error)) {
          continue;
        }
        throw error;
      }
    }

    try {
      await withTimeout<void>("rmdir", this.operationTimeoutMs, (resolve, reject) => {
        sftp.rmdir(dirPath, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } catch (error) {
      if (!isStrictMissingPathError(error)) {
        throw error;
      }
    }
  }
}
