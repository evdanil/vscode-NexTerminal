import * as path from "node:path";
import * as vscode from "vscode";
import type { SftpService, DirectoryEntry } from "./sftpService";
import { isSafeEntryName } from "../../utils/pathSafety";

export const NEXTERM_SCHEME = "nexterm";

function getMaxFileSize(): number {
  return vscode.workspace.getConfiguration("nexus.sftp").get<number>("maxOpenFileSizeMB", 5) * 1024 * 1024;
}
const MAX_COPY_DEPTH = 100;

export function buildUri(serverId: string, remotePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: NEXTERM_SCHEME, authority: serverId, path: remotePath });
}

function parseUri(uri: vscode.Uri): { serverId: string; remotePath: string } {
  return { serverId: uri.authority, remotePath: uri.path };
}

function toFileType(entry: DirectoryEntry): vscode.FileType {
  if (entry.isSymlink) {
    return entry.isDirectory
      ? vscode.FileType.SymbolicLink | vscode.FileType.Directory
      : vscode.FileType.SymbolicLink | vscode.FileType.File;
  }
  return entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File;
}

export class NexusFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  public constructor(private readonly sftp: SftpService) {}

  public watch(): vscode.Disposable {
    // Remote watch not feasible over SFTP — no-op
    return new vscode.Disposable(() => {});
  }

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { serverId, remotePath } = parseUri(uri);
    const entry = await this.sftp.stat(serverId, remotePath);
    return {
      type: toFileType(entry),
      ctime: entry.modifiedAt * 1000,
      mtime: entry.modifiedAt * 1000,
      size: entry.size,
      permissions: (entry.permissions & 0o200) === 0 ? vscode.FilePermission.Readonly : undefined,
    };
  }

  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { serverId, remotePath } = parseUri(uri);
    const entries = await this.sftp.readDirectory(serverId, remotePath);
    return entries.map((e) => [e.name, toFileType(e)]);
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { serverId, remotePath } = parseUri(uri);
    const maxSize = getMaxFileSize();
    const entry = await this.sftp.stat(serverId, remotePath);
    if (entry.size > maxSize) {
      const limitMB = Math.round(maxSize / 1024 / 1024);
      throw vscode.FileSystemError.Unavailable(
        `File too large (${Math.round(entry.size / 1024 / 1024)}MB). Maximum is ${limitMB}MB — change nexus.sftp.maxOpenFileSizeMB to increase.`
      );
    }
    return this.sftp.readFile(serverId, remotePath, maxSize);
  }

  public async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    await this.sftp.writeFile(serverId, remotePath, Buffer.from(content));
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    // Use lstat so symlinks are never followed for deletion decisions
    const entry = await this.sftp.lstat(serverId, remotePath);
    if (entry.isSymlink) {
      // Always unlink symlinks directly — never recurse into their targets
      await this.sftp.delete(serverId, remotePath, false);
    } else if (entry.isDirectory && !options.recursive) {
      throw vscode.FileSystemError.NoPermissions("Directory is not empty (use recursive delete)");
    } else {
      await this.sftp.delete(serverId, remotePath, entry.isDirectory);
    }
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const oldParsed = parseUri(oldUri);
    const newParsed = parseUri(newUri);
    if (oldParsed.serverId !== newParsed.serverId) {
      throw vscode.FileSystemError.NoPermissions("Cannot rename across servers");
    }
    await this.sftp.rename(oldParsed.serverId, oldParsed.remotePath, newParsed.remotePath);
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  public async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (source.scheme !== NEXTERM_SCHEME) {
      throw vscode.FileSystemError.NoPermissions("Only nexterm:// sources are supported");
    }

    if (destination.scheme === NEXTERM_SCHEME) {
      const sourceParsed = parseUri(source);
      const destinationParsed = parseUri(destination);
      if (sourceParsed.serverId !== destinationParsed.serverId) {
        throw vscode.FileSystemError.NoPermissions("Cannot copy across servers");
      }

      const sourceEntry = await this.sftp.lstat(sourceParsed.serverId, sourceParsed.remotePath);
      const destinationEntry = await this.sftp.tryLstat(destinationParsed.serverId, destinationParsed.remotePath);
      if (destinationEntry) {
        if (!options.overwrite) {
          throw vscode.FileSystemError.FileExists(`Destination already exists: ${destination.path}`);
        }
        if (sourceEntry.isDirectory !== destinationEntry.isDirectory) {
          throw vscode.FileSystemError.NoPermissions("Cannot overwrite file with directory or directory with file");
        }
      }

      await this.sftp.copyRemote(
        sourceParsed.serverId,
        sourceParsed.remotePath,
        destinationParsed.remotePath,
        sourceEntry.isDirectory
      );
      this.onDidChangeFileEmitter.fire([{
        type: destinationEntry ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri: destination
      }]);
      return;
    }

    if (destination.scheme === "file") {
      const existedBefore = await this.tryLocalStat(destination);
      await this.copyRemoteToLocal(source, destination, options.overwrite);
      this.onDidChangeFileEmitter.fire([{
        type: existedBefore ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri: destination
      }]);
      return;
    }

    throw vscode.FileSystemError.NoPermissions(`Unsupported destination scheme: ${destination.scheme}`);
  }

  public async createDirectory(uri: vscode.Uri): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    await this.sftp.createDirectory(serverId, remotePath);
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  private async copyRemoteToLocal(source: vscode.Uri, destination: vscode.Uri, overwrite: boolean): Promise<void> {
    const { serverId, remotePath } = parseUri(source);
    const sourceEntry = await this.sftp.lstat(serverId, remotePath);
    if (sourceEntry.isSymlink) {
      throw vscode.FileSystemError.NoPermissions("Copying symlinks is not supported");
    }

    if (sourceEntry.isDirectory) {
      await this.ensureLocalDirectoryDestination(destination, overwrite);
      await this.copyRemoteDirectoryToLocal(serverId, remotePath, destination, overwrite, 0);
      return;
    }

    await this.ensureLocalFileDestination(destination, overwrite);
    await this.sftp.download(serverId, remotePath, destination.fsPath);
  }

  private async copyRemoteDirectoryToLocal(
    serverId: string,
    remoteDir: string,
    localDir: vscode.Uri,
    overwrite: boolean,
    depth: number
  ): Promise<void> {
    if (depth > MAX_COPY_DEPTH) {
      throw vscode.FileSystemError.NoPermissions(
        `Copy aborted: directory nesting exceeds ${MAX_COPY_DEPTH} levels`
      );
    }

    const entries = await this.sftp.readDirectory(serverId, remoteDir);
    for (const entry of entries) {
      if (entry.isSymlink) {
        continue;
      }
      if (!isSafeEntryName(entry.name)) {
        continue;
      }

      const remoteChild = path.posix.join(remoteDir, entry.name);
      const localChild = vscode.Uri.joinPath(localDir, entry.name);
      if (entry.isDirectory) {
        await this.ensureLocalDirectoryDestination(localChild, overwrite);
        await this.copyRemoteDirectoryToLocal(serverId, remoteChild, localChild, overwrite, depth + 1);
      } else {
        await this.ensureLocalFileDestination(localChild, overwrite);
        await this.sftp.download(serverId, remoteChild, localChild.fsPath);
      }
    }
  }

  private async ensureLocalDirectoryDestination(destination: vscode.Uri, overwrite: boolean): Promise<void> {
    const destinationStat = await this.tryLocalStat(destination);
    if (!destinationStat) {
      await vscode.workspace.fs.createDirectory(destination);
      return;
    }
    if ((destinationStat.type & vscode.FileType.Directory) !== 0) {
      return;
    }
    if (!overwrite) {
      throw vscode.FileSystemError.FileExists(`Destination already exists: ${destination.fsPath}`);
    }
    await vscode.workspace.fs.delete(destination, { recursive: true, useTrash: false });
    await vscode.workspace.fs.createDirectory(destination);
  }

  private async ensureLocalFileDestination(destination: vscode.Uri, overwrite: boolean): Promise<void> {
    await this.ensureLocalParentDirectory(destination);
    const destinationStat = await this.tryLocalStat(destination);
    if (!destinationStat) {
      return;
    }
    if (!overwrite) {
      throw vscode.FileSystemError.FileExists(`Destination already exists: ${destination.fsPath}`);
    }
    if ((destinationStat.type & vscode.FileType.Directory) !== 0) {
      await vscode.workspace.fs.delete(destination, { recursive: true, useTrash: false });
    }
  }

  private async ensureLocalParentDirectory(uri: vscode.Uri): Promise<void> {
    const parent = vscode.Uri.file(path.dirname(uri.fsPath));
    await vscode.workspace.fs.createDirectory(parent);
  }

  private async tryLocalStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
  }
}
