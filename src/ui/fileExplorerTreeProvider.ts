import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import type { DirectoryEntry } from "../services/sftp/sftpService";
import type { SftpService } from "../services/sftp/sftpService";
import { buildUri } from "../services/sftp/nexusFileSystemProvider";
import { isSafeEntryName } from "../utils/pathSafety";
import { type ConflictMode, type ConflictDecision, resolveConflict } from "./conflictResolution";

const FILE_DRAG_MIME = "application/vnd.nexus.fileitem";
const URI_LIST_MIME = "text/uri-list";
const FILES_MIME = "files";
const MAX_UPLOAD_DEPTH = 100;
const MOVE_COPY_OPTIONS = [
  { label: "Move", value: "move" as const },
  { label: "Copy", value: "copy" as const }
];

interface DraggedFilePayloadItem {
  serverId: string;
  remotePath: string;
  name: string;
  isDirectory: boolean;
}

interface ValidDraggedItem extends DraggedFilePayloadItem {
  oldPath: string;
  newPath: string;
}


interface UploadSummary {
  uploaded: number;
  skipped: number;
  conflicts: number;
  canceled: boolean;
}

function normalizeRemoteDir(remotePath: string): string | undefined {
  if (!remotePath || remotePath.includes("\0")) {
    return undefined;
  }
  const normalized = path.posix.normalize(remotePath);
  if (!normalized.startsWith("/")) {
    return undefined;
  }
  return normalized;
}

function parseDraggedPayload(raw: string): DraggedFilePayloadItem[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const items: DraggedFilePayloadItem[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const candidate = item as Partial<DraggedFilePayloadItem>;
    if (
      typeof candidate.serverId !== "string" ||
      typeof candidate.remotePath !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.isDirectory !== "boolean"
    ) {
      continue;
    }
    items.push({
      serverId: candidate.serverId,
      remotePath: candidate.remotePath,
      name: candidate.name,
      isDirectory: candidate.isDirectory
    });
  }
  return items;
}

function parseUriList(raw: string): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  for (const line of lines) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    try {
      uris.push(vscode.Uri.parse(line, true));
    } catch {
      // Ignore malformed URI entries from foreign drag sources.
    }
  }
  return uris;
}

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
    const uri = buildUri(serverId, fullPath);
    this.resourceUri = uri;

    if (entry.isDirectory) {
      this.contextValue = "nexus.fileExplorer.dir";
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      this.contextValue = "nexus.fileExplorer.file";
      this.iconPath = vscode.ThemeIcon.File;
      const maxOpenBytes = vscode.workspace.getConfiguration("nexus.sftp").get<number>("maxOpenFileSizeMB", 5) * 1024 * 1024;
      if (entry.size <= maxOpenBytes) {
        this.command = {
          command: "vscode.open",
          title: "Open File",
          arguments: [uri],
        };
      }
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
  public readonly dragMimeTypes = [FILE_DRAG_MIME, URI_LIST_MIME];
  public readonly dropMimeTypes = [FILE_DRAG_MIME, URI_LIST_MIME, FILES_MIME];

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileExplorerItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private activeServerId: string | undefined;
  private activeServerConfig: ServerConfig | undefined;
  private homeDir: string | undefined;
  private currentRootPath: string | undefined;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollIntervalMs = 0;
  private isViewVisible = false;
  private refreshInFlight = false;

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

    this.refreshInFlight = true;
    try {
      return await this.getChildrenInner(element);
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async getChildrenInner(element?: FileExplorerItem): Promise<FileExplorerItem[]> {
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

    const uris = items.map((item) => {
      const fullPath = path.posix.join(item.remotePath, item.entry.name);
      return buildUri(item.serverId, fullPath).toString();
    });
    dataTransfer.set(
      URI_LIST_MIME,
      new vscode.DataTransferItem(uris.join("\r\n"))
    );
  }

  public async handleDrop(
    target: FileExplorerItem | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    if (!this.activeServerId || !this.currentRootPath) {
      return;
    }

    const targetDirNormalized = this.resolveTargetDirectory(target);
    if (!targetDirNormalized) {
      return;
    }

    const internalTransferItem = dataTransfer.get(FILE_DRAG_MIME);
    if (internalTransferItem) {
      await this.handleInternalDrop(internalTransferItem, targetDirNormalized);
      return;
    }

    await this.handleExternalDrop(dataTransfer, targetDirNormalized);
  }

  public dispose(): void {
    this.stopPolling();
  }

  private resolveTargetDirectory(target: FileExplorerItem | undefined): string | undefined {
    let targetDir: string;
    if (target instanceof FileTreeItem) {
      targetDir = target.entry.isDirectory
        ? path.posix.join(target.remotePath, target.entry.name)
        : target.remotePath;
    } else if (target instanceof ParentDirItem) {
      targetDir = target.parentPath;
    } else if (this.currentRootPath) {
      targetDir = this.currentRootPath;
    } else {
      return undefined;
    }
    return normalizeRemoteDir(targetDir);
  }

  private async handleInternalDrop(transferItem: vscode.DataTransferItem, targetDirNormalized: string): Promise<void> {
    if (!this.activeServerId) {
      return;
    }

    let items: DraggedFilePayloadItem[];
    try {
      items = parseDraggedPayload(await transferItem.asString());
    } catch {
      return;
    }

    // Filter valid items: same server, sane names, no path traversal, no self-moves.
    const validItems: ValidDraggedItem[] = items.flatMap((item) => {
      if (item.serverId !== this.activeServerId) {
        return [];
      }
      if (!isSafeEntryName(item.name)) {
        return [];
      }
      const sourceDirNormalized = normalizeRemoteDir(item.remotePath);
      if (!sourceDirNormalized) {
        return [];
      }
      const oldPath = path.posix.normalize(path.posix.join(sourceDirNormalized, item.name));
      const sourcePrefix = sourceDirNormalized === "/" ? "/" : `${sourceDirNormalized}/`;
      if (!oldPath.startsWith(sourcePrefix)) {
        return [];
      }
      const newPath = path.posix.normalize(path.posix.join(targetDirNormalized, item.name));
      if (oldPath === newPath) {
        return [];
      }
      if (item.isDirectory && (newPath + "/").startsWith(oldPath + "/")) {
        return [];
      }
      return [{ ...item, oldPath, newPath }];
    });

    if (validItems.length === 0) {
      return;
    }

    const choice = await vscode.window.showQuickPick(
      MOVE_COPY_OPTIONS,
      { placeHolder: "Move or copy the selected items?" }
    );
    if (!choice) {
      return;
    }
    const operation = choice.value;

    for (const item of validItems) {
      try {
        if (operation === "move") {
          await this.sftp.rename(this.activeServerId, item.oldPath, item.newPath);
          this.sftp.invalidateCache(this.activeServerId, item.remotePath);
        } else {
          await this.sftp.copyRemote(this.activeServerId, item.oldPath, item.newPath, item.isDirectory);
        }
      } catch (err: unknown) {
        const verb = operation === "move" ? "move" : "copy";
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to ${verb} ${item.name}: ${message}`);
      }
    }

    this.sftp.invalidateCache(this.activeServerId, targetDirNormalized);
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  private async handleExternalDrop(dataTransfer: vscode.DataTransfer, targetDirNormalized: string): Promise<void> {
    if (!this.activeServerId) {
      return;
    }

    const { localUris, unsupportedCount } = await this.collectDroppedLocalUris(dataTransfer);
    if (localUris.length === 0) {
      if (unsupportedCount > 0) {
        void vscode.window.showWarningMessage("Only local files can be uploaded. Non-file URIs were ignored.");
      }
      return;
    }

    const summary: UploadSummary = {
      uploaded: 0,
      skipped: unsupportedCount,
      conflicts: 0,
      canceled: false
    };
    const conflictState: { mode: ConflictMode } = { mode: "ask" };
    const serverId = this.activeServerId;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Uploading dropped items..." },
      async (progress) => {
        for (const uri of localUris) {
          if (summary.canceled) {
            break;
          }
          const rootName = path.basename(uri.fsPath);
          if (!isSafeEntryName(rootName)) {
            summary.skipped += 1;
            continue;
          }
          const remoteDest = path.posix.join(targetDirNormalized, rootName);
          await this.uploadLocalUri(serverId, uri, remoteDest, progress, conflictState, summary);
        }
      }
    );

    if (summary.uploaded > 0) {
      this.sftp.invalidateCache(serverId, targetDirNormalized);
      this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    const detail = `uploaded ${summary.uploaded}, skipped ${summary.skipped}, conflicts ${summary.conflicts}`;
    if (summary.canceled) {
      void vscode.window.showWarningMessage(`Upload canceled (${detail}).`);
      return;
    }
    if (summary.skipped > 0 || summary.conflicts > 0) {
      void vscode.window.showWarningMessage(`Upload completed with skips (${detail}).`);
      return;
    }
    if (summary.uploaded > 0) {
      void vscode.window.showInformationMessage(`Upload completed (${detail}).`);
    }
  }

  private async collectDroppedLocalUris(dataTransfer: vscode.DataTransfer): Promise<{ localUris: vscode.Uri[]; unsupportedCount: number }> {
    const allUris: vscode.Uri[] = [];

    const uriListItem = dataTransfer.get(URI_LIST_MIME);
    if (uriListItem) {
      try {
        allUris.push(...parseUriList(await uriListItem.asString()));
      } catch {
        // Ignore malformed uri-list payloads from external sources.
      }
    }

    allUris.push(...this.collectFileUrisFromDataTransfer(dataTransfer));

    const uniqueLocalUris = new Map<string, vscode.Uri>();
    let unsupportedCount = 0;
    for (const uri of allUris) {
      if (uri.scheme !== "file") {
        unsupportedCount += 1;
        continue;
      }
      const key = process.platform === "win32"
        ? path.normalize(uri.fsPath).toLowerCase()
        : path.normalize(uri.fsPath);
      if (!uniqueLocalUris.has(key)) {
        uniqueLocalUris.set(key, uri);
      }
    }

    return { localUris: [...uniqueLocalUris.values()], unsupportedCount };
  }

  private collectFileUrisFromDataTransfer(dataTransfer: vscode.DataTransfer): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    const seenItems = new Set<vscode.DataTransferItem>();
    const addFromItem = (item: vscode.DataTransferItem | undefined): void => {
      if (!item || seenItems.has(item)) {
        return;
      }
      seenItems.add(item);
      const file = item.asFile();
      if (file?.uri) {
        uris.push(file.uri);
      }
    };

    addFromItem(dataTransfer.get(FILES_MIME));
    if (typeof dataTransfer.forEach === "function") {
      dataTransfer.forEach((item) => {
        addFromItem(item);
      });
    }

    return uris;
  }

  private async uploadLocalUri(
    serverId: string,
    localUri: vscode.Uri,
    remoteDest: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    conflictState: { mode: ConflictMode },
    summary: UploadSummary
  ): Promise<void> {
    let localStat: vscode.FileStat;
    try {
      localStat = await vscode.workspace.fs.stat(localUri);
    } catch {
      summary.skipped += 1;
      return;
    }

    if ((localStat.type & vscode.FileType.SymbolicLink) !== 0) {
      summary.skipped += 1;
      return;
    }

    if ((localStat.type & vscode.FileType.Directory) !== 0) {
      await this.uploadLocalDirectory(serverId, localUri, remoteDest, progress, conflictState, summary, 0);
      return;
    }

    await this.uploadLocalFile(serverId, localUri, remoteDest, progress, conflictState, summary);
  }

  private async uploadLocalDirectory(
    serverId: string,
    localUri: vscode.Uri,
    remoteDir: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    conflictState: { mode: ConflictMode },
    summary: UploadSummary,
    depth: number
  ): Promise<void> {
    if (summary.canceled) {
      return;
    }
    if (depth > MAX_UPLOAD_DEPTH) {
      summary.skipped += 1;
      void vscode.window.showWarningMessage(`Skipping "${localUri.fsPath}" because directory nesting exceeds ${MAX_UPLOAD_DEPTH} levels.`);
      return;
    }

    const canContinue = await this.ensureRemoteDirectory(serverId, remoteDir, summary);
    if (!canContinue) {
      return;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(localUri);
    } catch {
      summary.skipped += 1;
      return;
    }

    for (const [name, fileType] of entries) {
      if (summary.canceled) {
        return;
      }
      if (!isSafeEntryName(name)) {
        summary.skipped += 1;
        continue;
      }
      if ((fileType & vscode.FileType.SymbolicLink) !== 0) {
        summary.skipped += 1;
        continue;
      }

      const childLocal = vscode.Uri.joinPath(localUri, name);
      const childRemote = path.posix.join(remoteDir, name);
      if ((fileType & vscode.FileType.Directory) !== 0) {
        await this.uploadLocalDirectory(serverId, childLocal, childRemote, progress, conflictState, summary, depth + 1);
      } else if ((fileType & vscode.FileType.File) !== 0) {
        await this.uploadLocalFile(serverId, childLocal, childRemote, progress, conflictState, summary);
      }
    }
  }

  private async uploadLocalFile(
    serverId: string,
    localUri: vscode.Uri,
    remotePath: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    conflictState: { mode: ConflictMode },
    summary: UploadSummary
  ): Promise<void> {
    if (summary.canceled) {
      return;
    }

    const decision = await this.resolveUploadDecision(serverId, remotePath, conflictState, summary);
    if (decision === "cancel") {
      summary.canceled = true;
      return;
    }
    if (decision === "skip") {
      summary.skipped += 1;
      return;
    }

    progress.report({ message: path.basename(localUri.fsPath) });
    try {
      await this.sftp.upload(serverId, localUri.fsPath, remotePath);
      summary.uploaded += 1;
    } catch (err: unknown) {
      summary.skipped += 1;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to upload "${path.basename(localUri.fsPath)}": ${message}`);
    }
  }

  private async ensureRemoteDirectory(serverId: string, remoteDir: string, summary: UploadSummary): Promise<boolean> {
    const existing = await this.sftp.tryStat(serverId, remoteDir);
    if (existing) {
      if (existing.isDirectory) {
        return true;
      }
      summary.conflicts += 1;
      summary.skipped += 1;
      void vscode.window.showWarningMessage(`Skipping "${remoteDir}" because destination exists as a file.`);
      return false;
    }

    try {
      await this.sftp.createDirectory(serverId, remoteDir);
      return true;
    } catch (err: unknown) {
      summary.skipped += 1;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to create remote directory "${remoteDir}": ${message}`);
      return false;
    }
  }

  private async resolveUploadDecision(
    serverId: string,
    remotePath: string,
    conflictState: { mode: ConflictMode },
    summary: UploadSummary
  ): Promise<ConflictDecision> {
    const existing = await this.sftp.tryStat(serverId, remotePath);
    if (!existing) {
      return "overwrite";
    }

    summary.conflicts += 1;
    if (existing.isDirectory) {
      void vscode.window.showWarningMessage(`Skipping "${remotePath}" because destination is a directory.`);
      return "skip";
    }

    return resolveConflict(`Remote file "${remotePath}" already exists. Choose an action.`, conflictState);
  }

  private updatePolling(): void {
    this.stopPolling();
    if (this.isViewVisible && this.activeServerId && this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        if (!this.refreshInFlight) {
          this.refresh();
        }
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
