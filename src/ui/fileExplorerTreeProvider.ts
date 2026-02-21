import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import type { DirectoryEntry } from "../services/sftp/sftpService";
import type { SftpService } from "../services/sftp/sftpService";
import { buildUri } from "../services/sftp/nexusFileSystemProvider";

const FILE_DRAG_MIME = "application/vnd.nexus.fileItem";

export class FileExplorerServerItem extends vscode.TreeItem {
  public constructor(server: ServerConfig) {
    super(`${server.name} (${server.username}@${server.host})`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "nexus.fileExplorer.server";
    this.iconPath = new vscode.ThemeIcon("remote-explorer");
  }
}

export class ParentDirItem extends vscode.TreeItem {
  public constructor(public readonly parentPath: string) {
    super("..", vscode.TreeItemCollapsibleState.None);
    this.contextValue = "nexus.fileExplorer.parentDir";
    this.iconPath = new vscode.ThemeIcon("arrow-up");
    this.tooltip = `Navigate up to ${parentPath}`;
    this.command = {
      command: "nexus.files.goToPath",
      title: "Go Up",
      arguments: [parentPath],
    };
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

export type FileExplorerItem = FileExplorerServerItem | ParentDirItem | FileTreeItem;

export class FileExplorerTreeProvider implements vscode.TreeDataProvider<FileExplorerItem>, vscode.TreeDragAndDropController<FileExplorerItem> {
  public readonly dragMimeTypes = [FILE_DRAG_MIME];
  public readonly dropMimeTypes = [FILE_DRAG_MIME];

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileExplorerItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private activeServerId: string | undefined;
  private activeServerConfig: ServerConfig | undefined;
  private homeDir: string | undefined;
  private currentRootPath: string | undefined;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollIntervalMs = 0;
  private isViewVisible = false;

  public constructor(private readonly sftp: SftpService) {}

  public getActiveServerId(): string | undefined {
    return this.activeServerId;
  }

  public getRootPath(): string | undefined {
    return this.currentRootPath;
  }

  public getHomeDir(): string | undefined {
    return this.homeDir;
  }

  public setActiveServer(server: ServerConfig, homeDir: string): void {
    this.activeServerId = server.id;
    this.activeServerConfig = server;
    this.homeDir = homeDir;
    this.currentRootPath = homeDir;
    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.updatePolling();
  }

  public clearActiveServer(): void {
    this.activeServerId = undefined;
    this.activeServerConfig = undefined;
    this.homeDir = undefined;
    this.currentRootPath = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
    this.updatePolling();
  }

  public setRootPath(rootPath: string): void {
    this.currentRootPath = rootPath;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public setViewVisibility(visible: boolean): void {
    this.isViewVisible = visible;
    this.updatePolling();
  }

  public setAutoRefreshInterval(seconds: number): void {
    this.pollIntervalMs = seconds * 1000;
    this.updatePolling();
  }

  public refresh(): void {
    if (this.activeServerId) {
      this.sftp.invalidateCache(this.activeServerId);
    }
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: FileExplorerItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: FileExplorerItem): Promise<FileExplorerItem[]> {
    if (!this.activeServerId || !this.activeServerConfig || !this.currentRootPath) {
      return [];
    }

    if (!element) {
      const serverItem = new FileExplorerServerItem(this.activeServerConfig);
      const items: FileExplorerItem[] = [serverItem];
      if (this.currentRootPath !== "/") {
        items.push(new ParentDirItem(path.posix.dirname(this.currentRootPath)));
      }

      // Synthetic "." item representing the current root directory
      const dotParent = path.posix.dirname(this.currentRootPath);
      const dotName = path.posix.basename(this.currentRootPath);
      const dotItem = new FileTreeItem(this.activeServerId, dotParent, {
        name: dotName || "",
        isDirectory: true,
        isSymlink: false,
        size: 0,
        modifiedAt: 0,
        permissions: 0,
      });
      dotItem.label = ".";
      dotItem.contextValue = "nexus.fileExplorer.currentDir";
      dotItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
      dotItem.tooltip = this.currentRootPath;
      dotItem.description = this.currentRootPath;
      items.push(dotItem);

      const entries = await this.loadDirectory(this.activeServerId, this.currentRootPath);
      return [...items, ...entries];
    }

    if (element instanceof FileTreeItem && element.entry.isDirectory) {
      const dirPath = path.posix.join(element.remotePath, element.entry.name);
      return this.loadDirectory(this.activeServerId, dirPath);
    }

    return [];
  }

  public async handleDrag(
    source: readonly FileExplorerItem[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const items = source.filter(
      (s): s is FileTreeItem =>
        s instanceof FileTreeItem && s.label !== "."
    );
    if (items.length === 0) {
      return;
    }
    const payload = items.map((item) => ({
      serverId: item.serverId,
      remotePath: item.remotePath,
      name: item.entry.name,
      isDirectory: item.entry.isDirectory,
    }));
    dataTransfer.set(
      FILE_DRAG_MIME,
      new vscode.DataTransferItem(JSON.stringify(payload))
    );
  }

  public async handleDrop(
    target: FileExplorerItem | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    if (!this.activeServerId || !this.currentRootPath) {
      return;
    }
    const transferItem = dataTransfer.get(FILE_DRAG_MIME);
    if (!transferItem) {
      return;
    }

    // Determine target directory
    let targetDir: string;
    if (target instanceof FileTreeItem) {
      if (target.entry.isDirectory) {
        targetDir = path.posix.join(target.remotePath, target.entry.name);
      } else {
        targetDir = target.remotePath;
      }
    } else if (target instanceof ParentDirItem) {
      targetDir = target.parentPath;
    } else {
      targetDir = this.currentRootPath;
    }

    let items: Array<{ serverId: string; remotePath: string; name: string; isDirectory: boolean }>;
    try {
      items = JSON.parse(await transferItem.asString());
    } catch {
      return;
    }

    for (const item of items) {
      if (item.serverId !== this.activeServerId) {
        continue;
      }
      const oldPath = path.posix.join(item.remotePath, item.name);
      const newPath = path.posix.join(targetDir, item.name);
      if (oldPath === newPath) {
        continue;
      }
      if (item.isDirectory && (newPath + "/").startsWith(oldPath + "/")) {
        continue;
      }
      try {
        await this.sftp.rename(this.activeServerId, oldPath, newPath);
        this.sftp.invalidateCache(this.activeServerId, item.remotePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to move ${item.name}: ${message}`);
      }
    }

    this.sftp.invalidateCache(this.activeServerId, targetDir);
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public dispose(): void {
    this.stopPolling();
  }

  private updatePolling(): void {
    this.stopPolling();
    if (this.isViewVisible && this.activeServerId && this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        this.refresh();
      }, this.pollIntervalMs);
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
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
