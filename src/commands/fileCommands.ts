import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import type { SftpService } from "../services/sftp/sftpService";
import { buildUri } from "../services/sftp/nexusFileSystemProvider";
import { ServerTreeItem } from "../ui/nexusTreeProvider";
import { FileTreeItem } from "../ui/fileExplorerTreeProvider";
import { type ConflictMode, type ConflictDecision, resolveConflict } from "../ui/conflictResolution";
import { isSafeEntryName } from "../utils/pathSafety";
import type { CommandContext } from "./types";

const MAX_DOWNLOAD_DEPTH = 100;

function validateFilename(value: string): string | undefined {
  if (!value) {
    return "Name cannot be empty";
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    return "Name must not contain path separators or null characters";
  }
  if (value === "." || value === "..") {
    return "Name must not be '.' or '..'";
  }
  return undefined;
}

function toServerFromArg(
  ctx: CommandContext,
  arg: unknown
): ServerConfig | undefined {
  if (arg instanceof ServerTreeItem) {
    return arg.server;
  }
  return undefined;
}

async function pickConnectedServer(ctx: CommandContext): Promise<ServerConfig | undefined> {
  const snapshot = ctx.core.getSnapshot();
  const connectedServerIds = new Set(snapshot.activeSessions.map((s) => s.serverId));
  const servers = snapshot.servers.filter((s) => connectedServerIds.has(s.id));
  if (servers.length === 0) {
    vscode.window.showWarningMessage("No connected servers. Connect to a server first.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    servers.map((s) => ({
      label: s.name,
      description: `${s.username}@${s.host}:${s.port}`,
      server: s,
    })),
    { title: "Select server to browse files" }
  );
  return pick?.server;
}

function resolveTargetDirectory(
  ctx: CommandContext,
  arg: unknown
): { serverId: string; dirPath: string } | undefined {
  if (arg instanceof FileTreeItem && arg.entry.isDirectory) {
    return {
      serverId: arg.serverId,
      dirPath: path.posix.join(arg.remotePath, arg.entry.name),
    };
  }
  const serverId = ctx.fileExplorerProvider.getActiveServerId();
  const dirPath = ctx.fileExplorerProvider.getRootPath();
  if (!serverId || !dirPath) {
    return undefined;
  }
  return { serverId, dirPath };
}

function resolveSelectedItems(arg: unknown, allSelected: unknown): FileTreeItem[] {
  if (Array.isArray(allSelected) && allSelected.length > 0) {
    return allSelected.filter((item): item is FileTreeItem => item instanceof FileTreeItem);
  }
  if (arg instanceof FileTreeItem) {
    return [arg];
  }
  return [];
}

interface DownloadSummary {
  downloaded: number;
  skipped: number;
  conflicts: number;
  failed: number;
  canceled: boolean;
}

interface DownloadItem {
  item: FileTreeItem;
  remotePath: string;
}

function dedupeDownloadItems(items: FileTreeItem[]): DownloadItem[] {
  const normalized = items
    .filter((item) => item.label !== ".")
    .map((item) => ({ item, remotePath: path.posix.join(item.remotePath, item.entry.name) }))
    .sort((a, b) => a.remotePath.localeCompare(b.remotePath));

  const result: DownloadItem[] = [];
  for (const candidate of normalized) {
    if (result.some((existing) => candidate.remotePath === existing.remotePath || candidate.remotePath.startsWith(`${existing.remotePath}/`))) {
      continue;
    }
    result.push(candidate);
  }
  return result;
}

async function resolveDownloadConflict(
  targetLabel: string,
  conflictState: { mode: ConflictMode },
  summary: DownloadSummary
): Promise<ConflictDecision> {
  summary.conflicts += 1;
  return resolveConflict(`Local target "${targetLabel}" already exists. Choose an action.`, conflictState);
}

async function tryLocalStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

async function downloadItemToLocal(
  sftp: SftpService,
  serverId: string,
  remotePath: string,
  isDirectory: boolean,
  localUri: vscode.Uri,
  conflictState: { mode: ConflictMode },
  summary: DownloadSummary
): Promise<void> {
  if (summary.canceled) {
    return;
  }

  const existing = await tryLocalStat(localUri);
  if (existing) {
    if (conflictState.mode !== "overwrite") {
      const decision = await resolveDownloadConflict(localUri.fsPath, conflictState, summary);
      if (decision === "cancel") {
        summary.canceled = true;
        return;
      }
      if (decision === "skip") {
        summary.skipped += 1;
        return;
      }
    }
    // If overwriting and types differ, remove the existing entry first
    if (isDirectory !== ((existing.type & vscode.FileType.Directory) !== 0)) {
      await vscode.workspace.fs.delete(localUri, { recursive: true, useTrash: false });
    }
  }

  if (isDirectory) {
    await downloadDirectoryToLocal(sftp, serverId, remotePath, localUri, conflictState, summary, 0);
  } else {
    try {
      await sftp.download(serverId, remotePath, localUri.fsPath);
      summary.downloaded += 1;
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to download "${path.basename(localUri.fsPath)}": ${message}`);
    }
  }
}

async function downloadDirectoryToLocal(
  sftp: SftpService,
  serverId: string,
  remoteDir: string,
  localDir: vscode.Uri,
  conflictState: { mode: ConflictMode },
  summary: DownloadSummary,
  depth: number
): Promise<void> {
  if (depth > MAX_DOWNLOAD_DEPTH) {
    summary.failed += 1;
    void vscode.window.showErrorMessage(`Download aborted: directory nesting exceeds ${MAX_DOWNLOAD_DEPTH} levels`);
    return;
  }

  await vscode.workspace.fs.createDirectory(localDir);

  let entries;
  try {
    entries = await sftp.readDirectory(serverId, remoteDir);
  } catch (error) {
    summary.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Failed to list "${remoteDir}": ${message}`);
    return;
  }

  for (const entry of entries) {
    if (summary.canceled) {
      return;
    }
    if (entry.isSymlink || !isSafeEntryName(entry.name)) {
      continue;
    }
    const childRemote = path.posix.join(remoteDir, entry.name);
    const childLocal = vscode.Uri.joinPath(localDir, entry.name);
    if (entry.isDirectory) {
      await downloadDirectoryToLocal(sftp, serverId, childRemote, childLocal, conflictState, summary, depth + 1);
    } else {
      const existing = await tryLocalStat(childLocal);
      if (existing) {
        if (conflictState.mode !== "overwrite") {
          const decision = await resolveDownloadConflict(childLocal.fsPath, conflictState, summary);
          if (decision === "cancel") {
            summary.canceled = true;
            return;
          }
          if (decision === "skip") {
            summary.skipped += 1;
            continue;
          }
        }
      }
      try {
        await sftp.download(serverId, childRemote, childLocal.fsPath);
        summary.downloaded += 1;
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to download "${entry.name}": ${message}`);
      }
    }
  }
}

export function registerFileCommands(ctx: CommandContext): vscode.Disposable[] {
  const browse = vscode.commands.registerCommand("nexus.files.browse", async (arg?: unknown) => {
    let server = toServerFromArg(ctx, arg);
    if (!server) {
      server = await pickConnectedServer(ctx);
    }
    if (!server) {
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting SFTP to ${server.name}...` },
        async () => {
          await ctx.sftpService.connect(server);
          const homeDir = await ctx.sftpService.realpath(server.id, ".");
          ctx.fileExplorerProvider.setActiveServer(server, homeDir);
        }
      );
      await vscode.commands.executeCommand("nexusFileExplorer.focus");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to browse files on ${server.name}: ${message}`);
    }
  });

  const open = vscode.commands.registerCommand("nexus.files.open", async (arg?: unknown) => {
    if (arg instanceof FileTreeItem && !arg.entry.isDirectory) {
      const uri = buildUri(arg.serverId, path.posix.join(arg.remotePath, arg.entry.name));
      await vscode.commands.executeCommand("vscode.open", uri);
    }
  });

  const createFile = vscode.commands.registerCommand("nexus.files.createFile", async (arg?: unknown) => {
    const target = resolveTargetDirectory(ctx, arg);
    if (!target) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "New File",
      prompt: "Enter file name",
      validateInput: validateFilename,
    });
    if (!name) {
      return;
    }
    try {
      const newFilePath = path.posix.join(target.dirPath, name);
      await ctx.sftpService.writeFile(target.serverId, newFilePath, Buffer.alloc(0));
      ctx.sftpService.invalidateCache(target.serverId, target.dirPath);
      ctx.fileExplorerProvider.refresh();
      const uri = buildUri(target.serverId, newFilePath);
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to create file "${name}": ${message}`);
    }
  });

  const upload = vscode.commands.registerCommand("nexus.files.upload", async (arg?: unknown) => {
    const target = resolveTargetDirectory(ctx, arg);
    if (!target) {
      return;
    }
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      title: "Select files to upload",
    });
    if (!files || files.length === 0) {
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Uploading files..." },
        async (progress) => {
          for (const file of files) {
            const fileName = path.basename(file.fsPath);
            progress.report({ message: fileName });
            const remoteDest = path.posix.join(target.dirPath, fileName);
            await ctx.sftpService.upload(target.serverId, file.fsPath, remoteDest);
          }
        }
      );
      ctx.sftpService.invalidateCache(target.serverId, target.dirPath);
      ctx.fileExplorerProvider.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to upload: ${message}`);
    }
  });

  const download = vscode.commands.registerCommand("nexus.files.download", async (arg?: unknown, allSelected?: unknown) => {
    const items = dedupeDownloadItems(resolveSelectedItems(arg, allSelected));
    if (items.length === 0) {
      return;
    }

    if (items.length === 1 && !items[0].item.entry.isDirectory) {
      const item = items[0].item;
      const dest = await vscode.window.showSaveDialog({
        title: "Save file as",
        defaultUri: vscode.Uri.file(item.entry.name),
      });
      if (!dest) {
        return;
      }

      const remoteFile = path.posix.join(item.remotePath, item.entry.name);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Downloading ${item.entry.name}...` },
          async () => {
            await ctx.sftpService.download(item.serverId, remoteFile, dest.fsPath);
          }
        );
        vscode.window.showInformationMessage(`Downloaded ${item.entry.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to download "${item.entry.name}": ${message}`);
      }
      return;
    }

    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Select folder to download files into",
    });
    if (!folder || folder.length === 0) {
      return;
    }

    const destRoot = folder[0];
    const conflictState: { mode: ConflictMode } = { mode: "ask" };
    const summary: DownloadSummary = {
      downloaded: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
      canceled: false
    };

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Downloading files...", cancellable: false },
      async (progress) => {
        for (const { item, remotePath } of items) {
          if (summary.canceled) {
            break;
          }
          if (!isSafeEntryName(item.entry.name)) {
            summary.skipped += 1;
            continue;
          }
          progress.report({ message: item.entry.name });

          const destinationUri = vscode.Uri.joinPath(destRoot, item.entry.name);
          await downloadItemToLocal(
            ctx.sftpService, item.serverId, remotePath, item.entry.isDirectory,
            destinationUri, conflictState, summary
          );
        }
      }
    );

    const detail = `downloaded ${summary.downloaded}, skipped ${summary.skipped}, conflicts ${summary.conflicts}, failed ${summary.failed}`;
    if (summary.canceled) {
      vscode.window.showWarningMessage(`Download canceled (${detail}).`);
      return;
    }
    if (summary.skipped > 0 || summary.conflicts > 0 || summary.failed > 0) {
      vscode.window.showWarningMessage(`Download completed with issues (${detail}).`);
      return;
    }
    vscode.window.showInformationMessage(`Downloaded ${summary.downloaded} item${summary.downloaded === 1 ? "" : "s"}.`);
  });

  const deleteCmd = vscode.commands.registerCommand("nexus.files.delete", async (arg?: unknown, allSelected?: unknown) => {
    const items = resolveSelectedItems(arg, allSelected);
    if (items.length === 0) {
      return;
    }

    if (items.length === 1) {
      const item = items[0];
      const label = item.entry.isDirectory ? "directory" : "file";
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${label} "${item.entry.name}"?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") {
        return;
      }
      const fullPath = path.posix.join(item.remotePath, item.entry.name);
      await ctx.sftpService.delete(item.serverId, fullPath, item.entry.isDirectory);
      ctx.fileExplorerProvider.refresh();
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete ${items.length} selected items?`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") {
      return;
    }
    const dirsToInvalidate = new Set<string>();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Deleting...", cancellable: false },
      async (progress) => {
        for (const item of items) {
          progress.report({ message: item.entry.name });
          const fullPath = path.posix.join(item.remotePath, item.entry.name);
          try {
            await ctx.sftpService.delete(item.serverId, fullPath, item.entry.isDirectory);
            dirsToInvalidate.add(`${item.serverId}:${item.remotePath}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to delete "${item.entry.name}": ${message}`);
          }
        }
      }
    );
    for (const key of dirsToInvalidate) {
      const [serverId, dirPath] = key.split(":", 2);
      ctx.sftpService.invalidateCache(serverId, dirPath);
    }
    ctx.fileExplorerProvider.refresh();
  });

  const rename = vscode.commands.registerCommand("nexus.files.rename", async (arg?: unknown) => {
    if (!(arg instanceof FileTreeItem)) {
      return;
    }
    const newName = await vscode.window.showInputBox({
      title: "Rename",
      value: arg.entry.name,
      prompt: "Enter new name",
      validateInput: validateFilename,
    });
    if (!newName || newName === arg.entry.name) {
      return;
    }
    const oldPath = path.posix.join(arg.remotePath, arg.entry.name);
    const newPath = path.posix.join(arg.remotePath, newName);
    await ctx.sftpService.rename(arg.serverId, oldPath, newPath);
    ctx.fileExplorerProvider.refresh();
  });

  const createDir = vscode.commands.registerCommand("nexus.files.createDir", async (arg?: unknown) => {
    const target = resolveTargetDirectory(ctx, arg);
    if (!target) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "New Directory",
      prompt: "Enter directory name",
      validateInput: validateFilename,
    });
    if (!name) {
      return;
    }
    try {
      const newDirPath = path.posix.join(target.dirPath, name);
      await ctx.sftpService.createDirectory(target.serverId, newDirPath);
      ctx.sftpService.invalidateCache(target.serverId, target.dirPath);
      ctx.fileExplorerProvider.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to create directory "${name}": ${message}`);
    }
  });

  const goToPath = vscode.commands.registerCommand("nexus.files.goToPath", async (arg?: unknown) => {
    const activeId = ctx.fileExplorerProvider.getActiveServerId();
    if (!activeId) {
      return;
    }

    if (typeof arg === "string") {
      ctx.sftpService.invalidateCache(activeId, arg);
      ctx.fileExplorerProvider.setRootPath(arg);
      return;
    }

    const currentRoot = ctx.fileExplorerProvider.getRootPath() ?? "/";
    const inputPath = await vscode.window.showInputBox({
      title: "Go to Path",
      prompt: "Enter absolute remote path",
      value: currentRoot,
    });
    if (!inputPath) {
      return;
    }
    try {
      const entry = await ctx.sftpService.stat(activeId, inputPath);
      if (!entry.isDirectory) {
        vscode.window.showWarningMessage("Path is not a directory.");
        return;
      }
      ctx.sftpService.invalidateCache(activeId, inputPath);
      ctx.fileExplorerProvider.setRootPath(inputPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Cannot navigate to path: ${message}`);
    }
  });

  const goHome = vscode.commands.registerCommand("nexus.files.goHome", () => {
    const homeDir = ctx.fileExplorerProvider.getHomeDir();
    if (homeDir) {
      ctx.fileExplorerProvider.setRootPath(homeDir);
    }
  });

  const copyPath = vscode.commands.registerCommand("nexus.files.copyPath", async (arg?: unknown, allSelected?: unknown) => {
    const items = resolveSelectedItems(arg, allSelected);
    if (items.length === 0) {
      return;
    }
    const paths = items.map((item) => path.posix.join(item.remotePath, item.entry.name));
    await vscode.env.clipboard.writeText(paths.join("\n"));
    vscode.window.showInformationMessage(
      items.length === 1
        ? `Copied: ${paths[0]}`
        : `Copied ${items.length} remote paths`
    );
  });

  const refresh = vscode.commands.registerCommand("nexus.files.refresh", () => {
    const activeId = ctx.fileExplorerProvider.getActiveServerId();
    if (activeId) {
      ctx.sftpService.invalidateCache(activeId);
    }
    ctx.fileExplorerProvider.refresh();
  });

  const disconnect = vscode.commands.registerCommand("nexus.files.disconnect", () => {
    const activeId = ctx.fileExplorerProvider.getActiveServerId();
    if (activeId) {
      ctx.sftpService.disconnect(activeId);
    }
    ctx.fileExplorerProvider.clearActiveServer();
  });

  return [browse, open, createFile, upload, download, deleteCmd, rename, createDir, goToPath, goHome, copyPath, refresh, disconnect];
}
