import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import { buildUri } from "../services/sftp/nexusFileSystemProvider";
import { ServerTreeItem } from "../ui/nexusTreeProvider";
import { FileTreeItem } from "../ui/fileExplorerTreeProvider";
import type { CommandContext } from "./types";

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

function resolveSelectedItems(arg: unknown, allSelected: unknown): FileTreeItem[] {
  if (Array.isArray(allSelected) && allSelected.length > 0) {
    return allSelected.filter((item): item is FileTreeItem => item instanceof FileTreeItem);
  }
  if (arg instanceof FileTreeItem) {
    return [arg];
  }
  return [];
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
    if (!(arg instanceof FileTreeItem) || !arg.entry.isDirectory) {
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
    const parentPath = path.posix.join(arg.remotePath, arg.entry.name);
    const newFilePath = path.posix.join(parentPath, name);
    await ctx.sftpService.writeFile(arg.serverId, newFilePath, Buffer.alloc(0));
    ctx.sftpService.invalidateCache(arg.serverId, parentPath);
    ctx.fileExplorerProvider.refresh();
    const uri = buildUri(arg.serverId, newFilePath);
    await vscode.commands.executeCommand("vscode.open", uri);
  });

  const upload = vscode.commands.registerCommand("nexus.files.upload", async (arg?: unknown) => {
    if (!(arg instanceof FileTreeItem) || !arg.entry.isDirectory) {
      return;
    }
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      title: "Select files to upload",
    });
    if (!files || files.length === 0) {
      return;
    }
    const targetDir = path.posix.join(arg.remotePath, arg.entry.name);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Uploading files..." },
      async (progress) => {
        for (const file of files) {
          const fileName = path.basename(file.fsPath);
          progress.report({ message: fileName });
          const remoteDest = path.posix.join(targetDir, fileName);
          await ctx.sftpService.upload(arg.serverId, file.fsPath, remoteDest);
        }
      }
    );
    ctx.sftpService.invalidateCache(arg.serverId, targetDir);
    ctx.fileExplorerProvider.refresh();
  });

  const download = vscode.commands.registerCommand("nexus.files.download", async (arg?: unknown, allSelected?: unknown) => {
    const items = resolveSelectedItems(arg, allSelected).filter((i) => !i.entry.isDirectory);
    if (items.length === 0) {
      return;
    }

    if (items.length === 1) {
      const item = items[0];
      const dest = await vscode.window.showSaveDialog({
        title: "Save file as",
        defaultUri: vscode.Uri.file(item.entry.name),
      });
      if (!dest) {
        return;
      }
      const remoteFile = path.posix.join(item.remotePath, item.entry.name);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${item.entry.name}...` },
        async () => {
          await ctx.sftpService.download(item.serverId, remoteFile, dest.fsPath);
        }
      );
      vscode.window.showInformationMessage(`Downloaded ${item.entry.name}`);
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
    const destDir = folder[0].fsPath;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Downloading files...", cancellable: false },
      async (progress) => {
        for (const item of items) {
          progress.report({ message: item.entry.name });
          const remoteFile = path.posix.join(item.remotePath, item.entry.name);
          const localDest = path.join(destDir, item.entry.name);
          await ctx.sftpService.download(item.serverId, remoteFile, localDest);
        }
      }
    );
    vscode.window.showInformationMessage(`Downloaded ${items.length} files`);
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
    if (!(arg instanceof FileTreeItem) || !arg.entry.isDirectory) {
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
    const parentPath = path.posix.join(arg.remotePath, arg.entry.name);
    const newDirPath = path.posix.join(parentPath, name);
    await ctx.sftpService.createDirectory(arg.serverId, newDirPath);
    ctx.sftpService.invalidateCache(arg.serverId, parentPath);
    ctx.fileExplorerProvider.refresh();
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
