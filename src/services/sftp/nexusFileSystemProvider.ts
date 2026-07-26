import * as path from "node:path";
import * as vscode from "vscode";
import type { SftpService, DirectoryEntry } from "./sftpService";
import { isSafeEntryName, joinRemoteEntryPath } from "../../utils/pathSafety";
import { readBoundedNumber } from "../../utils/boundedConfig";
import { isPermissionDeniedError } from "./elevatedWrite";

export const NEXTERM_SCHEME = "nexterm";

/**
 * Owns the password UI and the sudo write for a permission-denied save. Kept out of
 * this provider so it stays UI-agnostic and unit-testable without a real vscode host.
 */
export interface ElevationBroker {
  /** Returns true if the elevated write completed; false if the user declined. */
  saveElevated(serverId: string, remotePath: string, content: Buffer): Promise<boolean>;
  /** Ask the user whether to retry the failed save with sudo. */
  confirmElevation(remotePath: string): Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getMaxFileSize(): number {
  return readBoundedNumber("nexus.sftp", "maxOpenFileSizeMB", 5, 1, 200) * 1024 * 1024;
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

export class NexusFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.onDidChangeFileEmitter.event;
  private readonly elevatedUris = new Set<string>();
  // Tracks URIs where the user has already said "no" to the sudo offer, so autosave
  // (files.autoSave: afterDelay) re-entering writeFile on the same permission-denied
  // file doesn't pop a modal on every retry. Cleared on document close or editAsRoot.
  private readonly declinedUris = new Set<string>();
  private readonly closeListener: vscode.Disposable;

  public constructor(
    private readonly sftp: SftpService,
    private readonly elevation?: ElevationBroker
  ) {
    this.closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === NEXTERM_SCHEME) {
        this.declinedUris.delete(doc.uri.toString());
      }
    });
  }

  public dispose(): void {
    this.closeListener.dispose();
  }

  public watch(): vscode.Disposable {
    // Remote watch not feasible over SFTP — no-op
    return new vscode.Disposable(() => {});
  }

  /** Marks a URI as sudo-writable: stat drops Readonly and writeFile routes to the elevated path. */
  public markElevated(uri: vscode.Uri): void {
    const key = uri.toString();
    this.elevatedUris.add(key);
    this.declinedUris.delete(key); // explicit "Edit as Root" re-arms a previously declined offer
    // For a file already open (the 0444 proactive case), VS Code has cached
    // FilePermission.Readonly in the text model; dropping it in stat() only takes
    // effect once the model re-resolves. A Changed event on a non-dirty model
    // triggers that re-resolve (re-stat -> readonly cleared) without a reopen.
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  public clearElevated(uri: vscode.Uri): void {
    this.elevatedUris.delete(uri.toString());
  }

  public isElevated(uri: vscode.Uri): boolean {
    return this.elevatedUris.has(uri.toString());
  }

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { serverId, remotePath } = parseUri(uri);
    const entry = await this.sftp.stat(serverId, remotePath);
    const readonly = (entry.permissions & 0o200) === 0 && !this.isElevated(uri);
    return {
      type: toFileType(entry),
      ctime: entry.modifiedAt * 1000,
      mtime: entry.modifiedAt * 1000,
      size: entry.size,
      permissions: readonly ? vscode.FilePermission.Readonly : undefined,
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

  // Deliberately a modal prompt inside writeFile, not a fail-then-notify pattern:
  // VS Code applies no timeout to FileSystemProvider.writeFile, saves to a single
  // resource are sequentialized (a second Ctrl+S joins the pending save rather than
  // double-firing), and the editor stays dirty until this promise settles. Failing
  // the save instead would stack VS Code's own "Failed to save" dialog on top of ours.
  public async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    const buffer = Buffer.from(content);

    if (this.isElevated(uri)) {
      await this.performElevatedSave(serverId, remotePath, buffer, uri);
      return;
    }

    try {
      await this.sftp.writeFile(serverId, remotePath, buffer);
    } catch (error) {
      if (!this.elevation || !isPermissionDeniedError(error)) {
        throw error;
      }
      const key = uri.toString();
      if (this.declinedUris.has(key)) {
        throw vscode.FileSystemError.NoPermissions(errorMessage(error));
      }
      const accepted = await this.elevation.confirmElevation(remotePath);
      if (!accepted) {
        this.declinedUris.add(key);
        throw vscode.FileSystemError.NoPermissions(errorMessage(error));
      }
      this.markElevated(uri);
      await this.performElevatedSave(serverId, remotePath, buffer, uri);
      return;
    }
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  private async performElevatedSave(
    serverId: string,
    remotePath: string,
    content: Buffer,
    uri: vscode.Uri
  ): Promise<void> {
    if (!this.elevation) {
      throw vscode.FileSystemError.NoPermissions(
        `Elevated save of ${remotePath} requires sudo support, which is not configured.`
      );
    }
    const completed = await this.elevation.saveElevated(serverId, remotePath, content);
    if (!completed) {
      throw vscode.FileSystemError.NoPermissions(`Elevated save of ${remotePath} was not completed.`);
    }
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    // Use lstat so symlinks are never followed for deletion decisions
    const entry = await this.sftp.lstat(serverId, remotePath);
    if (entry.isSymlink) {
      // Always unlink symlinks directly — never recurse into their targets
      await this.sftp.delete(serverId, remotePath, options);
    } else if (entry.isDirectory && !options.recursive) {
      throw vscode.FileSystemError.NoPermissions("Directory is not empty (use recursive delete)");
    } else {
      await this.sftp.delete(serverId, remotePath, options);
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

      const remoteChild = joinRemoteEntryPath(remoteDir, entry.name);
      if (!remoteChild) {
        continue;
      }
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
