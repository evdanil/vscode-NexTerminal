import * as vscode from "vscode";
import type { SftpService, DirectoryEntry } from "./sftpService";

export const NEXTERM_SCHEME = "nexterm";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

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
    const entry = await this.sftp.stat(serverId, remotePath);
    if (entry.size > MAX_FILE_SIZE) {
      throw vscode.FileSystemError.Unavailable(`File too large (${Math.round(entry.size / 1024 / 1024)}MB). Maximum is 50MB.`);
    }
    return this.sftp.readFile(serverId, remotePath);
  }

  public async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    await this.sftp.writeFile(serverId, remotePath, Buffer.from(content));
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    const entry = await this.sftp.stat(serverId, remotePath);
    await this.sftp.delete(serverId, remotePath, entry.isDirectory);
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const oldParsed = parseUri(oldUri);
    const newParsed = parseUri(newUri);
    await this.sftp.rename(oldParsed.serverId, oldParsed.remotePath, newParsed.remotePath);
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  public async createDirectory(uri: vscode.Uri): Promise<void> {
    const { serverId, remotePath } = parseUri(uri);
    await this.sftp.createDirectory(serverId, remotePath);
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }
}
