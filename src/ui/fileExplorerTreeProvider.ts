import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import type { DirectoryEntry } from "../services/sftp/sftpService";
import type { SftpService } from "../services/sftp/sftpService";
import { buildUri } from "../services/sftp/nexusFileSystemProvider";

export class FileExplorerServerItem extends vscode.TreeItem {
  public constructor(server: ServerConfig) {
    super(`${server.name} (${server.username}@${server.host})`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "nexus.fileExplorer.server";
    this.iconPath = new vscode.ThemeIcon("remote-explorer");
  }
}

export class FileTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly serverId: string,
    public readonly remotePath: string,
    public readonly entry: DirectoryEntry
  ) {
    super(
      entry.name,
      entry.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    const fullPath = path.posix.join(remotePath, entry.name);

    if (entry.isDirectory) {
      this.contextValue = "nexus.fileExplorer.dir";
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      this.contextValue = "nexus.fileExplorer.file";
      this.iconPath = vscode.ThemeIcon.File;
      const uri = buildUri(serverId, fullPath);
      this.resourceUri = uri;
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [uri],
      };
    }

    this.tooltip = fullPath;
    this.description = entry.isDirectory ? undefined : formatSize(entry.size);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

type FileExplorerItem = FileExplorerServerItem | FileTreeItem;

export class FileExplorerTreeProvider implements vscode.TreeDataProvider<FileExplorerItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileExplorerItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private activeServerId: string | undefined;
  private activeServerConfig: ServerConfig | undefined;
  private homeDir: string | undefined;

  public constructor(private readonly sftp: SftpService) {}

  public getActiveServerId(): string | undefined {
    return this.activeServerId;
  }

  public setActiveServer(server: ServerConfig, homeDir: string): void {
    this.activeServerId = server.id;
    this.activeServerConfig = server;
    this.homeDir = homeDir;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public clearActiveServer(): void {
    this.activeServerId = undefined;
    this.activeServerConfig = undefined;
    this.homeDir = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: FileExplorerItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: FileExplorerItem): Promise<FileExplorerItem[]> {
    if (!this.activeServerId || !this.activeServerConfig || !this.homeDir) {
      return [];
    }

    if (!element) {
      // Root: server header + home directory entries
      const serverItem = new FileExplorerServerItem(this.activeServerConfig);
      const entries = await this.loadDirectory(this.activeServerId, this.homeDir);
      return [serverItem, ...entries];
    }

    if (element instanceof FileTreeItem && element.entry.isDirectory) {
      const dirPath = path.posix.join(element.remotePath, element.entry.name);
      return this.loadDirectory(this.activeServerId, dirPath);
    }

    return [];
  }

  private async loadDirectory(serverId: string, dirPath: string): Promise<FileTreeItem[]> {
    try {
      const entries = await this.sftp.readDirectory(serverId, dirPath);
      return entries
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        })
        .map((entry) => new FileTreeItem(serverId, dirPath, entry));
    } catch {
      return [];
    }
  }
}
