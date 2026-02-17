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

  const download = vscode.commands.registerCommand("nexus.files.download", async (arg?: unknown) => {
    if (!(arg instanceof FileTreeItem) || arg.entry.isDirectory) {
      return;
    }
    const defaultName = arg.entry.name;
    const dest = await vscode.window.showSaveDialog({
      title: "Save file as",
      defaultUri: vscode.Uri.file(defaultName),
    });
    if (!dest) {
      return;
    }
    const remoteFile = path.posix.join(arg.remotePath, arg.entry.name);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${arg.entry.name}...` },
      async () => {
        await ctx.sftpService.download(arg.serverId, remoteFile, dest.fsPath);
      }
    );
    vscode.window.showInformationMessage(`Downloaded ${arg.entry.name}`);
  });

  const deleteCmd = vscode.commands.registerCommand("nexus.files.delete", async (arg?: unknown) => {
    if (!(arg instanceof FileTreeItem)) {
      return;
    }
    const label = arg.entry.isDirectory ? "directory" : "file";
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${label} "${arg.entry.name}"?`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") {
      return;
    }
    const fullPath = path.posix.join(arg.remotePath, arg.entry.name);
    await ctx.sftpService.delete(arg.serverId, fullPath, arg.entry.isDirectory);
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

  return [browse, open, upload, download, deleteCmd, rename, createDir, refresh, disconnect];
}
