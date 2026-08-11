import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import type { DirectoryEntry, SftpService } from "../services/sftp/sftpService";
import { buildUri, NEXTERM_SCHEME } from "../services/sftp/nexusFileSystemProvider";
import { ServerTreeItem } from "../ui/nexusTreeProvider";
import { FileTreeItem } from "../ui/fileExplorerTreeProvider";
import { type ConflictMode, type ConflictDecision, resolveConflict } from "../ui/conflictResolution";
import { isSafeEntryName, joinRemoteEntryPath } from "../utils/pathSafety";
import { getUNCHost, isUNCAccessError } from "../utils/networkPath";
import { offerUNCHostRemediation } from "../ui/uncRemediation";
import { naturalCompare } from "../utils/naturalCompare";
import type { CommandContext } from "./types";

const MAX_DOWNLOAD_DEPTH = 100;
const SSH_FX_NO_SUCH_FILE = 2;

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
  if (typeof arg === "string") {
    return ctx.core.getServer(arg);
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
    servers
      .slice()
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((s) => ({
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
    const remoteDir = joinRemoteEntryPath(arg.remotePath, arg.entry.name);
    if (!remoteDir) {
      return undefined;
    }
    return {
      serverId: arg.serverId,
      dirPath: remoteDir,
    };
  }
  const serverId = ctx.fileExplorerProvider.getActiveServerId();
  const dirPath = ctx.fileExplorerProvider.getRootPath();
  if (!serverId || !dirPath) {
    return undefined;
  }
  return { serverId, dirPath };
}

/**
 * Resolves the target of nexus.files.editAsRoot. From the File Explorer context menu
 * `arg` is a FileTreeItem; from the command palette (or a keybinding) there is no
 * tree item at all, so this falls back to whatever nexterm:// document is active —
 * the case a user staring at VS Code's generic read-only error most needs, since
 * they have no tree item in hand at all.
 */
function resolveEditAsRootTarget(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof FileTreeItem) {
    if (arg.entry.isDirectory) {
      return undefined;
    }
    // FileTreeItem.remotePath is the containing directory, not the file — same as
    // nexus.files.open, the full path must be joined with the entry name first.
    const filePath = joinRemoteEntryPath(arg.remotePath, arg.entry.name);
    return filePath ? buildUri(arg.serverId, filePath) : undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return activeUri?.scheme === NEXTERM_SCHEME ? activeUri : undefined;
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

/**
 * Hosts VS Code's UNC restriction blocked during one operation, mapped to a
 * representative blocked path per host (the remediation flow re-probes it).
 * Collected rather than toasted per item: one cause affecting a 200-file
 * directory transfer must produce one actionable message, not 200.
 */
type BlockedUNCHosts = Map<string, string>;

interface DownloadSummary {
  downloaded: number;
  skipped: number;
  conflicts: number;
  failed: number;
  canceled: boolean;
  canceledCount: number;
  blockedUNCHosts: BlockedUNCHosts;
}

interface UploadSummary {
  uploaded: number;
  skipped: number;
  conflicts: number;
  failed: number;
  canceled: number;
  blockedUNCHosts: BlockedUNCHosts;
}

/**
 * Reports a local-side transfer failure. A UNC policy block is recorded for the
 * one deferred remediation prompt instead of producing a generic "Failed to
 * download …" toast that tells the user nothing about the actual cause; any
 * other error keeps the generic per-item message.
 */
function reportTransferFailure(
  blockedUNCHosts: BlockedUNCHosts,
  localPath: string,
  error: unknown,
  buildMessage: (message: string) => string
): void {
  if (isUNCAccessError(error)) {
    const host = getUNCHost(localPath);
    if (host) {
      if (!blockedUNCHosts.has(host)) {
        blockedUNCHosts.set(host, localPath);
      }
      return;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(buildMessage(message));
}

async function offerCollectedUNCRemediation(
  blockedUNCHosts: BlockedUNCHosts,
  diagnostics?: (line: string) => void
): Promise<void> {
  for (const [host, probePath] of blockedUNCHosts) {
    await offerUNCHostRemediation(host, probePath, diagnostics);
  }
}

interface DownloadItem {
  item: FileTreeItem;
  remotePath: string;
}

interface DeleteItem {
  item: FileTreeItem;
  remotePath: string;
}

function dedupeDownloadItems(items: FileTreeItem[]): DownloadItem[] {
  const normalized = items
    .filter((item) => item.label !== ".")
    .map((item) => ({
      item,
      remotePath: joinRemoteEntryPath(item.remotePath, item.entry.name)
    }))
    .filter((item): item is { item: FileTreeItem; remotePath: string } => item.remotePath !== undefined)
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

function dedupeDeleteItems(items: FileTreeItem[]): DeleteItem[] {
  const normalized = items
    .filter((item) => item.label !== ".")
    .map((item) => ({
      item,
      remotePath: joinRemoteEntryPath(item.remotePath, item.entry.name)
    }))
    .filter((item): item is { item: FileTreeItem; remotePath: string } => item.remotePath !== undefined)
    .sort((a, b) => a.remotePath.localeCompare(b.remotePath));

  const result: DeleteItem[] = [];
  for (const candidate of normalized) {
    if (result.some((existing) =>
      candidate.item.serverId === existing.item.serverId && (
        candidate.remotePath === existing.remotePath ||
        candidate.remotePath.startsWith(`${existing.remotePath}/`)
      )
    )) {
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

async function resolveUploadConflict(
  targetLabel: string,
  conflictState: { mode: ConflictMode },
  summary: UploadSummary
): Promise<ConflictDecision> {
  summary.conflicts += 1;
  return resolveConflict(`Remote target "${targetLabel}" already exists. Choose an action.`, conflictState);
}

async function tryLocalStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
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

async function tryRemoteDestinationStat(
  sftp: SftpService,
  serverId: string,
  remotePath: string
): Promise<DirectoryEntry | undefined> {
  try {
    return await sftp.stat(serverId, remotePath);
  } catch (error) {
    if (isStrictMissingPathError(error)) {
      return undefined;
    }
    throw error;
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
        summary.canceledCount += 1;
        return;
      }
      if (decision === "skip") {
        summary.skipped += 1;
        return;
      }
    }
    // If overwriting and types differ, remove the existing entry first
    if (isDirectory !== ((existing.type & vscode.FileType.Directory) !== 0)) {
      try {
        await vscode.workspace.fs.delete(localUri, { recursive: true, useTrash: false });
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to prepare local target "${path.basename(localUri.fsPath)}": ${message}`);
        return;
      }
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
      reportTransferFailure(
        summary.blockedUNCHosts,
        localUri.fsPath,
        error,
        (message) => `Failed to download "${path.basename(localUri.fsPath)}": ${message}`
      );
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

  try {
    await vscode.workspace.fs.createDirectory(localDir);
  } catch (error) {
    summary.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Failed to create local directory "${path.basename(localDir.fsPath)}": ${message}`);
    return;
  }

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
    const childRemote = joinRemoteEntryPath(remoteDir, entry.name);
    if (!childRemote) {
      summary.skipped += 1;
      continue;
    }
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
            summary.canceledCount += 1;
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
        reportTransferFailure(
          summary.blockedUNCHosts,
          childLocal.fsPath,
          error,
          (message) => `Failed to download "${entry.name}": ${message}`
        );
      }
    }
  }
}

/**
 * Shared "Go to Path" prompt: input box (defaulted to `defaultValue`) → validate
 * with `sftp.stat` → re-root on success. Used by the `nexus.files.goToPath`
 * command itself (no-arg / palette invocation) and reused verbatim by
 * `nexus.files.syncFromTerminal`'s resolution-ladder fallback (cwdSyncCommands.ts)
 * so the two paths never drift.
 *
 * Returns the path that was actually applied on success, `undefined` otherwise
 * (dismissed box, non-directory target, or SFTP error) — callers use this to
 * decide whether a "first successful sync" nudge should fire.
 *
 * This is manual navigation by construction (the user is typing/confirming an
 * absolute path), so it always pins directory-sync (§8.3) via
 * `notifyManualNavigation()` on success — including when reached from the
 * `syncFromTerminal` fallback, where a corrected/typed path is exactly the kind
 * of user intent §8.3 defines as "manual navigation".
 */
export async function promptGoToPath(ctx: CommandContext, defaultValue: string): Promise<string | undefined> {
  const activeId = ctx.fileExplorerProvider.getActiveServerId();
  if (!activeId) {
    return undefined;
  }
  const inputPath = await vscode.window.showInputBox({
    title: "Go to Path",
    prompt: "Enter absolute remote path",
    value: defaultValue,
  });
  if (!inputPath) {
    return undefined;
  }
  try {
    const entry = await ctx.sftpService.stat(activeId, inputPath);
    if (!entry.isDirectory) {
      vscode.window.showWarningMessage("Path is not a directory.");
      return undefined;
    }
    // Re-check immediately before committing: the explorer's active server
    // must still be the one this path was validated against. Both awaits
    // above are open-ended — the input box waits on the user, and the stat
    // call on the network — so the explorer can switch servers (a different
    // server browsed, or `clearActiveServer()` from the auto-disconnect path
    // in extension.ts) while they are in flight. Mirrors the same guard in
    // `validateAndApply` (cwdSyncCommands.ts).
    if (ctx.fileExplorerProvider.getActiveServerId() !== activeId) {
      ctx.cwdSyncOutputChannel?.appendLine(
        `[cwdSync] goToPath: discarding navigation to ${inputPath} — explorer switched servers (was ${activeId}, now ${ctx.fileExplorerProvider.getActiveServerId() ?? "<none>"})`
      );
      vscode.window.showWarningMessage(
        "Cannot navigate to path: the File Explorer switched to a different server."
      );
      return undefined;
    }
    ctx.sftpService.invalidateCache(activeId, inputPath);
    ctx.fileExplorerProvider.setRootPath(inputPath);
    ctx.cwdSyncCoordinator?.notifyManualNavigation();
    return inputPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Cannot navigate to path: ${message}`);
    return undefined;
  }
}

export async function browseServerFiles(ctx: CommandContext, server: ServerConfig): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting SFTP to ${server.name}...` },
      async () => {
        await ctx.sftpService.connect(server);
        const homeDir = await ctx.sftpService.realpath(server.id, ".");
        ctx.fileExplorerProvider.setActiveServer(server, homeDir);
        // §8.3: the pin clears automatically on an explorer server change,
        // and the newly active server's focused-session record (if any)
        // should be re-evaluated rather than waiting for some later event.
        ctx.cwdSyncCoordinator?.notifyExplorerServerChanged();
      }
    );
    await vscode.commands.executeCommand("nexusFileExplorer.focus");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to browse files on ${server.name}: ${message}`);
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

    await browseServerFiles(ctx, server);
  });

  const open = vscode.commands.registerCommand("nexus.files.open", async (arg?: unknown) => {
    if (arg instanceof FileTreeItem && !arg.entry.isDirectory) {
      const remotePath = joinRemoteEntryPath(arg.remotePath, arg.entry.name);
      if (!remotePath) {
        return;
      }
      const uri = buildUri(arg.serverId, remotePath);
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
    const conflictState: { mode: ConflictMode } = { mode: "ask" };
    const summary: UploadSummary = {
      uploaded: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
      canceled: 0,
      blockedUNCHosts: new Map()
    };

    // This command uploads directly via ctx.sftpService rather than through the
    // provider's own upload path, so isBusy() would otherwise not see it in flight.
    // Wrapped at the outermost operation (not per file) so a multi-file selection
    // counts as one busy span — currentRootPath is the fallback write target this
    // command itself falls back to, and an auto-follow re-root mid-upload would
    // redirect where later files in the batch land.
    const endBusy = ctx.fileExplorerProvider.beginBusy();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Uploading files..." },
        async (progress) => {
          for (const file of files) {
            if (summary.canceled > 0) {
              break;
            }
            // Platform-default basename by design (see the drag-drop path): on
            // Windows the default IS win32, so a UNC source yields a clean
            // "file.txt". The guard the drag-drop path has always had was
            // missing here, so a backslash-bearing name could be posix-joined
            // straight into the remote path.
            const fileName = path.basename(file.fsPath);
            if (!isSafeEntryName(fileName)) {
              summary.failed += 1;
              vscode.window.showErrorMessage(`Cannot upload "${fileName}": name contains unsupported characters.`);
              continue;
            }
            progress.report({ message: fileName });
            const remoteDest = path.posix.join(target.dirPath, fileName);

            let existingRemote;
            try {
              existingRemote = await tryRemoteDestinationStat(ctx.sftpService, target.serverId, remoteDest);
            } catch (error) {
              summary.failed += 1;
              const message = error instanceof Error ? error.message : String(error);
              vscode.window.showErrorMessage(`Failed to check remote target "${fileName}": ${message}`);
              continue;
            }

            if (existingRemote) {
              const decision = await resolveUploadConflict(fileName, conflictState, summary);
              if (decision === "cancel") {
                summary.canceled += 1;
                break;
              }
              if (decision === "skip") {
                summary.skipped += 1;
                continue;
              }
            }

            try {
              await ctx.sftpService.upload(target.serverId, file.fsPath, remoteDest);
              summary.uploaded += 1;
            } catch (error) {
              summary.failed += 1;
              reportTransferFailure(
                summary.blockedUNCHosts,
                file.fsPath,
                error,
                (message) => `Failed to upload "${fileName}": ${message}`
              );
            }
          }
        }
      );
    } finally {
      endBusy();
    }

    // Outside the busy span: the remediation flow blocks on a modal for as long
    // as the user takes to answer it.
    await offerCollectedUNCRemediation(summary.blockedUNCHosts, ctx.sshDiagnostics);

    if (summary.uploaded > 0) {
      ctx.sftpService.invalidateCache(target.serverId, target.dirPath);
      ctx.fileExplorerProvider.refresh();
    }

    const detail = `uploaded ${summary.uploaded}, skipped ${summary.skipped}, conflicts ${summary.conflicts}, failed ${summary.failed}, canceled ${summary.canceled}`;
    if (summary.canceled > 0) {
      vscode.window.showWarningMessage(`Upload canceled (${detail}).`);
      return;
    }
    if (summary.skipped > 0 || summary.conflicts > 0 || summary.failed > 0) {
      vscode.window.showWarningMessage(`Upload completed with issues (${detail}).`);
      return;
    }
    vscode.window.showInformationMessage(`Uploaded ${summary.uploaded} item${summary.uploaded === 1 ? "" : "s"}.`);
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

      const remoteFile = joinRemoteEntryPath(item.remotePath, item.entry.name);
      if (!remoteFile) {
        return;
      }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Downloading ${item.entry.name}...` },
          async () => {
            await ctx.sftpService.download(item.serverId, remoteFile, dest.fsPath);
          }
        );
        vscode.window.showInformationMessage(`Downloaded ${item.entry.name}`);
      } catch (error) {
        if (isUNCAccessError(error)) {
          const host = getUNCHost(dest.fsPath);
          if (host) {
            await offerUNCHostRemediation(host, dest.fsPath, ctx.sshDiagnostics);
            return;
          }
        }
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
      canceled: false,
      canceledCount: 0,
      blockedUNCHosts: new Map()
    };

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${items.length} selected item${items.length === 1 ? "" : "s"}...`,
        cancellable: false
      },
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
          try {
            await downloadItemToLocal(
              ctx.sftpService, item.serverId, remotePath, item.entry.isDirectory,
              destinationUri, conflictState, summary
            );
          } catch (error) {
            summary.failed += 1;
            reportTransferFailure(
              summary.blockedUNCHosts,
              destinationUri.fsPath,
              error,
              (message) => `Failed to download "${item.entry.name}": ${message}`
            );
          }
        }
      }
    );

    await offerCollectedUNCRemediation(summary.blockedUNCHosts, ctx.sshDiagnostics);

    const detail = `downloaded ${summary.downloaded}, skipped ${summary.skipped}, conflicts ${summary.conflicts}, failed ${summary.failed}, canceled ${summary.canceledCount}`;
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
    const items = dedupeDeleteItems(resolveSelectedItems(arg, allSelected));
    if (items.length === 0) {
      return;
    }

    if (items.length === 1) {
      const { item, remotePath } = items[0];
      const label = item.entry.isDirectory ? "directory" : "file";
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${label} "${item.entry.name}"?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") {
        return;
      }
      const summary = { deleted: 0, failed: 0 };
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Deleting...", cancellable: false },
          async (progress) => {
            progress.report({ message: item.entry.name });
            await ctx.sftpService.delete(item.serverId, remotePath);
            summary.deleted += 1;
          }
        );
        ctx.fileExplorerProvider.refresh();
        vscode.window.showInformationMessage(`Deleted ${item.entry.name}.`);
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to delete "${item.entry.name}": ${message}`);
        vscode.window.showWarningMessage(`Delete completed with issues (deleted ${summary.deleted}, failed ${summary.failed}).`);
      }
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
    const summary = { deleted: 0, failed: 0 };
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Deleting...", cancellable: false },
      async (progress) => {
        for (const { item, remotePath } of items) {
          progress.report({ message: item.entry.name });
          try {
            await ctx.sftpService.delete(item.serverId, remotePath);
            summary.deleted += 1;
          } catch (error) {
            summary.failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to delete "${item.entry.name}": ${message}`);
          }
        }
      }
    );
    if (summary.deleted > 0) {
      ctx.fileExplorerProvider.refresh();
    }
    if (summary.failed > 0) {
      vscode.window.showWarningMessage(`Delete completed with issues (deleted ${summary.deleted}, failed ${summary.failed}).`);
      return;
    }
    vscode.window.showInformationMessage(`Deleted ${summary.deleted} items.`);
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
    const oldPath = joinRemoteEntryPath(arg.remotePath, arg.entry.name);
    const newPath = joinRemoteEntryPath(arg.remotePath, newName);
    if (!oldPath || !newPath) {
      return;
    }
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
      // String-arg invocation covers both a direct re-root (rare) and the
      // synthetic `..` `ParentDirItem` row, whose `command` dispatches here
      // with `arguments: [parentPath]` (fileExplorerTreeProvider.ts) — so the
      // `..` row's manual-navigation pin (§8.3) is covered by this branch,
      // no separate wiring needed there.
      ctx.sftpService.invalidateCache(activeId, arg);
      ctx.fileExplorerProvider.setRootPath(arg);
      ctx.cwdSyncCoordinator?.notifyManualNavigation();
      return;
    }

    const currentRoot = ctx.fileExplorerProvider.getRootPath() ?? "/";
    await promptGoToPath(ctx, currentRoot);
  });

  const goHome = vscode.commands.registerCommand("nexus.files.goHome", () => {
    const homeDir = ctx.fileExplorerProvider.getHomeDir();
    if (homeDir) {
      ctx.fileExplorerProvider.setRootPath(homeDir);
      ctx.cwdSyncCoordinator?.notifyManualNavigation();
    }
  });

  const copyPath = vscode.commands.registerCommand("nexus.files.copyPath", async (arg?: unknown, allSelected?: unknown) => {
    const items = resolveSelectedItems(arg, allSelected);
    if (items.length === 0) {
      return;
    }
    const paths = items
      .map((item) => joinRemoteEntryPath(item.remotePath, item.entry.name))
      .filter((remotePath): remotePath is string => remotePath !== undefined);
    if (paths.length === 0) {
      return;
    }
    await vscode.env.clipboard.writeText(paths.join("\n"));
    vscode.window.showInformationMessage(
      paths.length === 1
        ? `Copied: ${paths[0]}`
        : `Copied ${paths.length} remote paths`
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
      // SftpService.disconnect() itself emits no event: for a pooled lease it only
      // starts an idle timer (or, with nexus.ssh.multiplexing.idleTimeout: 0, never
      // even that), so the pool's own "disconnected" teardown listener in
      // extension.ts can't be relied on to fire here. Clear directly as well so a
      // cached sudo password and any elevated marks don't outlive this disconnect.
      ctx.elevationBroker?.clearCachedPassword?.(activeId);
      ctx.fileSystemProvider?.clearElevatedForServer(activeId);
    }
    ctx.fileExplorerProvider.clearActiveServer();
    // §8.3: the pin clears automatically on an explorer server change.
    ctx.cwdSyncCoordinator?.notifyExplorerServerChanged();
  });

  const editAsRoot = vscode.commands.registerCommand("nexus.files.editAsRoot", async (arg?: unknown) => {
    if (!ctx.fileSystemProvider) {
      return;
    }
    const uri = resolveEditAsRootTarget(arg);
    if (!uri) {
      return;
    }
    const sudoEnabled = vscode.workspace.getConfiguration("nexus.sftp").get<boolean>("sudo.enabled", true);
    if (!sudoEnabled) {
      const choice = await vscode.window.showWarningMessage(
        "Elevated saves are disabled (nexus.sftp.sudo.enabled is off).",
        "Open Settings"
      );
      if (choice === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "nexus.sftp.sudo.enabled");
      }
      return;
    }
    ctx.fileSystemProvider.markElevated(uri);
    await vscode.commands.executeCommand("vscode.open", uri);
  });

  return [browse, open, createFile, upload, download, deleteCmd, rename, createDir, goToPath, goHome, copyPath, refresh, disconnect, editAsRoot];
}
