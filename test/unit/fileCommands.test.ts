import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import type { DirectoryEntry } from "../../src/services/sftp/sftpService";
import { browseServerFiles, registerFileCommands } from "../../src/commands/fileCommands";
import { FileTreeItem } from "../../src/ui/fileExplorerTreeProvider";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockExecuteCommand = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockWithProgress = vi.fn(async (_opts: unknown, task: (progress: { report: (arg: unknown) => void }) => Promise<void>) =>
  task({ report: vi.fn() })
);
const mockBuildUri = vi.fn((serverId: string, remotePath: string) => ({ scheme: "nexterm", serverId, remotePath }));
const mockGetConfiguration = vi.fn(() => ({ get: (_key: string, def: unknown) => def }));

function createFileTreeItem(overrides: {
  serverId?: string;
  remotePath?: string;
  entry: DirectoryEntry;
}): FileTreeItem {
  const item = {
    serverId: overrides.serverId ?? "srv-1",
    remotePath: overrides.remotePath ?? "/home",
    entry: overrides.entry,
    label: overrides.entry.name
  } as unknown as FileTreeItem;
  return Object.setPrototypeOf(item, FileTreeItem.prototype);
}

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  },
  window: {
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args),
    withProgress: (...args: unknown[]) => mockWithProgress(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showQuickPick: vi.fn(),
    showSaveDialog: vi.fn(),
    activeTextEditor: undefined as { document: { uri: { scheme: string; toString(): string } } } | undefined
  },
  workspace: {
    fs: {
      copy: vi.fn(),
      stat: vi.fn(),
      createDirectory: vi.fn(),
      delete: vi.fn()
    },
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args)
  },
  env: {
    clipboard: { writeText: vi.fn() }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, child: string) => ({ fsPath: `${base.fsPath}/${child}` })
  },
  ProgressLocation: { Notification: 15 },
  FileType: { File: 1, Directory: 2 },
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public constructor(public readonly label: string, public readonly collapsibleState?: number) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(public readonly id: string, public readonly color?: unknown) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  }
}));

vi.mock("../../src/services/sftp/nexusFileSystemProvider", () => ({
  buildUri: (...args: unknown[]) => mockBuildUri(...args as [string, string]),
  NEXTERM_SCHEME: "nexterm"
}));

function createContext(overrides?: {
  activeServerId?: string | undefined;
  rootPath?: string | undefined;
  writeFileReject?: Error;
  uploadReject?: Error;
}): CommandContext {
  const activeServerId = overrides && "activeServerId" in overrides ? overrides.activeServerId : "srv-1";
  const rootPath = overrides && "rootPath" in overrides ? overrides.rootPath : "/home";
  const writeFile = overrides?.writeFileReject
    ? vi.fn(async () => { throw overrides.writeFileReject; })
    : vi.fn(async () => {});
  const upload = overrides?.uploadReject
    ? vi.fn(async () => { throw overrides.uploadReject; })
    : vi.fn(async () => {});

  return {
    core: {} as any,
    tunnelManager: {} as any,
    serialSidecar: {} as any,
    sshFactory: {} as any,
    sshPool: {} as any,
    loggerFactory: {} as any,
    sessionLogDir: "",
    terminalsByServer: new Map(),
    sessionTerminals: new Map(),
    serialTerminals: new Map(),
    highlighter: {} as any,
    sftpService: {
      writeFile,
      upload,
      invalidateCache: vi.fn(),
      connect: vi.fn(async () => {}),
      realpath: vi.fn(async () => "/home/dev"),
      stat: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
      tryStat: vi.fn(async () => undefined),
      delete: vi.fn(),
      rename: vi.fn(),
      createDirectory: vi.fn(),
      disconnect: vi.fn()
    } as any,
    fileExplorerProvider: {
      getActiveServerId: vi.fn(() => activeServerId),
      getRootPath: vi.fn(() => rootPath),
      refresh: vi.fn(),
      setActiveServer: vi.fn(),
      setRootPath: vi.fn(),
      getHomeDir: vi.fn(),
      clearActiveServer: vi.fn(),
      isBusy: vi.fn(() => false),
      beginBusy: vi.fn(() => vi.fn())
    } as any,
    cwdSyncCoordinator: {
      notifyManualNavigation: vi.fn(),
      clearPin: vi.fn(),
      setFollowing: vi.fn(),
      resume: vi.fn(),
      getState: vi.fn(),
      notifyExplorerServerChanged: vi.fn()
    } as any
  };
}

describe("fileCommands title bar actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("browseServerFiles connects SFTP and focuses the Nexus File Explorer", async () => {
    const ctx = createContext();
    const server = {
      id: "srv-1",
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password" as const,
      isHidden: false
    };

    await browseServerFiles(ctx, server);

    expect(ctx.sftpService.connect).toHaveBeenCalledWith(server);
    expect(ctx.sftpService.realpath).toHaveBeenCalledWith("srv-1", ".");
    expect(ctx.fileExplorerProvider.setActiveServer).toHaveBeenCalledWith(server, "/home/dev");
    expect(mockExecuteCommand).toHaveBeenCalledWith("nexusFileExplorer.focus");
    // §8.3: the pin clears automatically on an explorer server change, and
    // the coordinator must re-evaluate the newly active server.
    expect(ctx.cwdSyncCoordinator!.notifyExplorerServerChanged).toHaveBeenCalledTimes(1);
  });

  it("browseServerFiles tolerates a missing cwdSyncCoordinator", async () => {
    const ctx = createContext();
    delete (ctx as any).cwdSyncCoordinator;
    const server = {
      id: "srv-1",
      name: "Server 1",
      host: "example.com",
      port: 22,
      username: "dev",
      authType: "password" as const,
      isHidden: false
    };

    await expect(browseServerFiles(ctx, server)).resolves.toBeUndefined();
  });

  it("createFile falls back to active root directory when no tree item is passed", async () => {
    const ctx = createContext();
    mockShowInputBox.mockResolvedValue("new.txt");
    registerFileCommands(ctx);

    const createFile = registeredCommands.get("nexus.files.createFile");
    expect(createFile).toBeDefined();
    await createFile!(undefined);

    expect(ctx.sftpService.writeFile).toHaveBeenCalledWith("srv-1", "/home/new.txt", expect.any(Buffer));
    expect(ctx.sftpService.invalidateCache).toHaveBeenCalledWith("srv-1", "/home");
    expect(ctx.fileExplorerProvider.refresh).toHaveBeenCalled();
    expect(mockBuildUri).toHaveBeenCalledWith("srv-1", "/home/new.txt");
    expect(mockExecuteCommand).toHaveBeenCalledWith("vscode.open", expect.objectContaining({
      serverId: "srv-1",
      remotePath: "/home/new.txt"
    }));
  });

  it("upload falls back to active root directory when no tree item is passed", async () => {
    const ctx = createContext();
    mockShowOpenDialog.mockResolvedValue([
      { fsPath: "/tmp/a.txt" },
      { fsPath: "/tmp/b.txt" }
    ]);
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    expect(upload).toBeDefined();
    await upload!(undefined);

    expect(ctx.sftpService.upload).toHaveBeenCalledWith("srv-1", "/tmp/a.txt", "/home/a.txt");
    expect(ctx.sftpService.upload).toHaveBeenCalledWith("srv-1", "/tmp/b.txt", "/home/b.txt");
    expect(ctx.sftpService.invalidateCache).toHaveBeenCalledWith("srv-1", "/home");
    expect(ctx.fileExplorerProvider.refresh).toHaveBeenCalled();
  });

  it("createFile surfaces SFTP errors to the user", async () => {
    const ctx = createContext({ writeFileReject: new Error("permission denied") });
    mockShowInputBox.mockResolvedValue("new.txt");
    registerFileCommands(ctx);

    const createFile = registeredCommands.get("nexus.files.createFile");
    await createFile!(undefined);

    expect(mockShowErrorMessage).toHaveBeenCalledWith('Failed to create file "new.txt": permission denied');
  });

  it("upload surfaces SFTP errors to the user", async () => {
    const ctx = createContext({ uploadReject: new Error("upload blocked") });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/tmp/a.txt" }]);
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await upload!(undefined);

    expect(mockShowErrorMessage).toHaveBeenCalledWith('Failed to upload "a.txt": upload blocked');
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Upload completed with issues (uploaded 0, skipped 0, conflicts 0, failed 1, canceled 0).");
  });

  it("upload marks the provider busy for the whole batch and always releases it, including on failure (§5.1/§7.4)", async () => {
    const ctx = createContext({ uploadReject: new Error("upload blocked") });
    const release = vi.fn();
    (ctx.fileExplorerProvider.beginBusy as any).mockReturnValue(release);
    mockShowOpenDialog.mockResolvedValue([
      { fsPath: "/tmp/a.txt" },
      { fsPath: "/tmp/b.txt" }
    ]);
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await upload!(undefined);

    // One busy span for the whole batch, not one per file.
    expect(ctx.fileExplorerProvider.beginBusy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("upload releases the busy span even when withProgress itself throws", async () => {
    const ctx = createContext();
    const release = vi.fn();
    (ctx.fileExplorerProvider.beginBusy as any).mockReturnValue(release);
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/tmp/a.txt" }]);
    mockWithProgress.mockImplementationOnce(async () => {
      throw new Error("progress blew up");
    });
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await expect(upload!(undefined)).rejects.toThrow("progress blew up");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("upload overwrites an existing remote file when requested", async () => {
    const ctx = createContext();
    ctx.sftpService.stat = vi.fn(async () => ({
      name: "a.txt",
      isDirectory: false,
      isSymlink: false,
      size: 12,
      modifiedAt: 1700000000,
      permissions: 0o644,
    }));
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/tmp/a.txt" }]);
    mockShowWarningMessage.mockResolvedValue("Overwrite");
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await upload!(undefined);

    expect(ctx.sftpService.stat).toHaveBeenCalledWith("srv-1", "/home/a.txt");
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Remote target "a.txt" already exists. Choose an action.',
      "Overwrite",
      "Skip",
      "Overwrite All",
      "Skip All",
      "Cancel"
    );
    expect(ctx.sftpService.upload).toHaveBeenCalledWith("srv-1", "/tmp/a.txt", "/home/a.txt");
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Upload completed with issues (uploaded 1, skipped 0, conflicts 1, failed 0, canceled 0).");
  });

  it("upload skips an existing remote file when requested", async () => {
    const ctx = createContext();
    ctx.sftpService.stat = vi.fn(async () => ({
      name: "a.txt",
      isDirectory: false,
      isSymlink: false,
      size: 12,
      modifiedAt: 1700000000,
      permissions: 0o644,
    }));
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/tmp/a.txt" }]);
    mockShowWarningMessage.mockResolvedValue("Skip");
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await upload!(undefined);

    expect(ctx.sftpService.upload).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Upload completed with issues (uploaded 0, skipped 1, conflicts 1, failed 0, canceled 0).");
  });

  it("upload cancels after an existing remote file conflict", async () => {
    const ctx = createContext();
    ctx.sftpService.stat = vi.fn(async () => ({
      name: "a.txt",
      isDirectory: false,
      isSymlink: false,
      size: 12,
      modifiedAt: 1700000000,
      permissions: 0o644,
    }));
    mockShowOpenDialog.mockResolvedValue([
      { fsPath: "/tmp/a.txt" },
      { fsPath: "/tmp/b.txt" }
    ]);
    mockShowWarningMessage.mockResolvedValue("Cancel");
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await upload!(undefined);

    expect(ctx.sftpService.upload).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Upload canceled (uploaded 0, skipped 0, conflicts 1, failed 0, canceled 1).");
  });

  it("upload treats non-missing remote stat failures as failed items and continues", async () => {
    const ctx = createContext();
    ctx.sftpService.stat = vi.fn(async (_serverId: string, remotePath: string) => {
      if (remotePath.endsWith("/a.txt")) {
        throw new Error("permission denied");
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    mockShowOpenDialog.mockResolvedValue([
      { fsPath: "/tmp/a.txt" },
      { fsPath: "/tmp/b.txt" }
    ]);
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await upload!(undefined);

    expect(ctx.sftpService.upload).toHaveBeenCalledTimes(1);
    expect(ctx.sftpService.upload).toHaveBeenCalledWith("srv-1", "/tmp/b.txt", "/home/b.txt");
    expect(ctx.sftpService.upload).not.toHaveBeenCalledWith("srv-1", "/tmp/a.txt", "/home/a.txt");
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Failed to check remote target "a.txt": permission denied');
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Upload completed with issues (uploaded 1, skipped 0, conflicts 0, failed 1, canceled 0).");
  });

  it("upload treats non-missing stat codes as failures even when the message says not found", async () => {
    const ctx = createContext();
    ctx.sftpService.stat = vi.fn(async () => {
      throw Object.assign(new Error("permission denied (not found)"), { code: "EACCES" });
    });
    ctx.sftpService.tryStat = vi.fn(async () => undefined);
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/tmp/a.txt" }]);
    registerFileCommands(ctx);

    const upload = registeredCommands.get("nexus.files.upload");
    await upload!(undefined);

    expect(ctx.sftpService.stat).toHaveBeenCalledWith("srv-1", "/home/a.txt");
    expect(ctx.sftpService.upload).not.toHaveBeenCalled();
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Failed to check remote target "a.txt": permission denied (not found)');
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Upload completed with issues (uploaded 0, skipped 0, conflicts 0, failed 1, canceled 0).");
  });

  it("returns early when no active server/root is available", async () => {
    const ctx = createContext({ activeServerId: undefined, rootPath: undefined });
    registerFileCommands(ctx);

    const createFile = registeredCommands.get("nexus.files.createFile");
    await createFile!(undefined);

    expect(mockShowInputBox).not.toHaveBeenCalled();
    expect(ctx.sftpService.writeFile).not.toHaveBeenCalled();
  });

  it("single delete refreshes explorer after success", async () => {
    const ctx = createContext();
    const item = createFileTreeItem({
      entry: {
        name: "file.txt",
        isDirectory: false,
        isSymlink: false,
        size: 128,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowWarningMessage.mockResolvedValue("Delete");
    registerFileCommands(ctx);

    const deleteCommand = registeredCommands.get("nexus.files.delete");
    expect(deleteCommand).toBeDefined();
    await deleteCommand!(item);

    expect(mockShowWarningMessage).toHaveBeenCalledWith(`Delete file "file.txt"?`, { modal: true }, "Delete");
    expect(ctx.sftpService.delete).toHaveBeenCalledWith("srv-1", "/home/file.txt");
    expect(ctx.fileExplorerProvider.refresh).toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Deleted file.txt.");
  });

  it("single delete shows an error when service deletion fails", async () => {
    const ctx = createContext();
    const item = createFileTreeItem({
      entry: {
        name: "bad.txt",
        isDirectory: false,
        isSymlink: false,
        size: 128,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowWarningMessage.mockResolvedValue("Delete");
    ctx.sftpService.delete = vi.fn(async () => {
      throw new Error("delete failed");
    });
    registerFileCommands(ctx);

    const deleteCommand = registeredCommands.get("nexus.files.delete");
    expect(deleteCommand).toBeDefined();
    await deleteCommand!(item);

    expect(mockShowErrorMessage).toHaveBeenCalledWith("Failed to delete \"bad.txt\": delete failed");
    expect(ctx.fileExplorerProvider.refresh).not.toHaveBeenCalled();
  });

  it("single directory delete reports progress while deleting", async () => {
    const ctx = createContext();
    const item = createFileTreeItem({
      entry: {
        name: "subdir",
        isDirectory: true,
        isSymlink: false,
        size: 4096,
        modifiedAt: 1700000000,
        permissions: 0o755,
      },
    });
    const progress = { report: vi.fn() };
    mockShowWarningMessage.mockResolvedValue("Delete");
    mockWithProgress.mockImplementationOnce(async (_opts: unknown, task: (progress: { report: (arg: unknown) => void }) => Promise<void>) =>
      task(progress)
    );
    registerFileCommands(ctx);

    const deleteCommand = registeredCommands.get("nexus.files.delete");
    expect(deleteCommand).toBeDefined();
    await deleteCommand!(item);

    expect(mockWithProgress).toHaveBeenCalledWith(
      { location: 15, title: "Deleting...", cancellable: false },
      expect.any(Function)
    );
    expect(progress.report).toHaveBeenCalledWith({ message: "subdir" });
    expect(ctx.sftpService.delete).toHaveBeenCalledWith("srv-1", "/home/subdir");
    expect(ctx.fileExplorerProvider.refresh).toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Deleted subdir.");
  });

  it("multi-delete dedupes parent directories and preserves colon-containing paths", async () => {
    const ctx = createContext();
    const parent = createFileTreeItem({
      serverId: "srv-1",
      remotePath: "/remote:drive",
      entry: {
        name: "project",
        isDirectory: true,
        isSymlink: false,
        size: 4096,
        modifiedAt: 1700000000,
        permissions: 0o755,
      },
    });
    const child = createFileTreeItem({
      serverId: "srv-1",
      remotePath: "/remote:drive/project",
      entry: {
        name: "file.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowWarningMessage.mockResolvedValue("Delete");
    ctx.sftpService.delete = vi.fn(async () => {});
    registerFileCommands(ctx);

    const deleteCommand = registeredCommands.get("nexus.files.delete");
    expect(deleteCommand).toBeDefined();
    await deleteCommand!(undefined, [parent, child]);

    expect(ctx.sftpService.delete).toHaveBeenCalledTimes(1);
    expect(ctx.sftpService.delete).toHaveBeenCalledWith("srv-1", "/remote:drive/project");
    expect(ctx.fileExplorerProvider.refresh).toHaveBeenCalled();
  });

  it("multi-delete shows a warning summary when one item fails", async () => {
    const ctx = createContext();
    const first = createFileTreeItem({
      entry: {
        name: "ok.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    const second = createFileTreeItem({
      entry: {
        name: "bad.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowWarningMessage.mockResolvedValue("Delete");
    ctx.sftpService.delete = vi.fn(async (_serverId: string, remotePath: string) => {
      if (remotePath.endsWith("/bad.txt")) {
        throw new Error("permission denied");
      }
    });
    registerFileCommands(ctx);

    const deleteCommand = registeredCommands.get("nexus.files.delete");
    expect(deleteCommand).toBeDefined();
    await deleteCommand!(undefined, [first, second]);

    expect(ctx.sftpService.delete).toHaveBeenCalledTimes(2);
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Failed to delete "bad.txt": permission denied');
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Delete completed with issues (deleted 1, failed 1).");
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith("Deleted 2 items.");
    expect(ctx.fileExplorerProvider.refresh).toHaveBeenCalled();
  });

  it("multi-download includes selected count in progress title", async () => {
    const ctx = createContext();
    const first = createFileTreeItem({
      entry: {
        name: "a.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    const second = createFileTreeItem({
      entry: {
        name: "b.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/downloads" }]);
    const vscode = await import("vscode");
    vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    ctx.sftpService.download = vi.fn(async () => {});
    registerFileCommands(ctx);

    const download = registeredCommands.get("nexus.files.download");
    expect(download).toBeDefined();
    await download!(undefined, [first, second]);

    expect(mockWithProgress).toHaveBeenCalledWith(
      { location: 15, title: "Downloading 2 selected items...", cancellable: false },
      expect.any(Function)
    );
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Downloaded 2 items.");
  });

  it("multi-download warning detail includes skipped, failed, and canceled counts", async () => {
    const ctx = createContext();
    const first = createFileTreeItem({
      entry: {
        name: "a.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    const second = createFileTreeItem({
      entry: {
        name: "b.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/downloads" }]);
    mockShowWarningMessage.mockResolvedValue("Cancel");
    const vscode = await import("vscode");
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({ type: 1 } as any);
    ctx.sftpService.download = vi.fn(async () => {});
    registerFileCommands(ctx);

    const download = registeredCommands.get("nexus.files.download");
    expect(download).toBeDefined();
    await download!(undefined, [first, second]);

    expect(ctx.sftpService.download).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Download canceled (downloaded 0, skipped 0, conflicts 1, failed 0, canceled 1).");
  });

  it("multi-download reports local directory creation failures and continues later items", async () => {
    const ctx = createContext();
    const first = createFileTreeItem({
      entry: {
        name: "dir",
        isDirectory: true,
        isSymlink: false,
        size: 4096,
        modifiedAt: 1700000000,
        permissions: 0o755,
      },
    });
    const second = createFileTreeItem({
      entry: {
        name: "later.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/downloads" }]);
    const vscode = await import("vscode");
    vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    vi.mocked(vscode.workspace.fs.createDirectory).mockRejectedValue(new Error("mkdir failed"));
    ctx.sftpService.download = vi.fn(async () => {});
    registerFileCommands(ctx);

    const download = registeredCommands.get("nexus.files.download");
    expect(download).toBeDefined();
    await download!(undefined, [first, second]);

    expect(ctx.sftpService.download).toHaveBeenCalledTimes(1);
    expect(ctx.sftpService.download).toHaveBeenCalledWith("srv-1", "/home/later.txt", "/downloads/later.txt");
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Failed to create local directory "dir": mkdir failed');
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Download completed with issues (downloaded 1, skipped 0, conflicts 0, failed 1, canceled 0).");
  });

  it("multi-download reports local overwrite cleanup failures and continues later items", async () => {
    const ctx = createContext();
    const first = createFileTreeItem({
      entry: {
        name: "a.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    const second = createFileTreeItem({
      entry: {
        name: "b.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/downloads" }]);
    mockShowWarningMessage.mockResolvedValue("Overwrite");
    const vscode = await import("vscode");
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri: any) => {
      if (uri.fsPath.endsWith("/a.txt")) {
        return { type: 2 } as any;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    vi.mocked(vscode.workspace.fs.delete).mockRejectedValue(new Error("local delete failed"));
    ctx.sftpService.download = vi.fn(async () => {});
    registerFileCommands(ctx);

    const download = registeredCommands.get("nexus.files.download");
    expect(download).toBeDefined();
    await download!(undefined, [first, second]);

    expect(ctx.sftpService.download).toHaveBeenCalledTimes(1);
    expect(ctx.sftpService.download).toHaveBeenCalledWith("srv-1", "/home/b.txt", "/downloads/b.txt");
    expect(ctx.sftpService.download).not.toHaveBeenCalledWith("srv-1", "/home/a.txt", "/downloads/a.txt");
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Failed to prepare local target "a.txt": local delete failed');
    expect(mockShowWarningMessage).toHaveBeenCalledWith("Download completed with issues (downloaded 1, skipped 0, conflicts 1, failed 1, canceled 0).");
  });

  it("copyPath ignores unsafe remote entry names instead of copying undefined", async () => {
    const vscode = await import("vscode");
    const ctx = createContext();
    const item = createFileTreeItem({
      entry: {
        name: "../bad.txt",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      },
    });
    registerFileCommands(ctx);

    const copyPath = registeredCommands.get("nexus.files.copyPath");
    expect(copyPath).toBeDefined();
    await copyPath!(item);

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("offers the connected-server QuickPick in natural (numeric) name order", async () => {
    const vscode = await import("vscode");
    const ctx = createContext();
    ctx.core = {
      getSnapshot: () => ({
        activeSessions: [{ serverId: "s10" }, { serverId: "s2" }, { serverId: "s1" }],
        servers: [
          { id: "s10", name: "A10", host: "h", port: 22, username: "u", authType: "password", isHidden: false },
          { id: "s2", name: "A2", host: "h", port: 22, username: "u", authType: "password", isHidden: false },
          { id: "s1", name: "A1", host: "h", port: 22, username: "u", authType: "password", isHidden: false }
        ]
      })
    } as any;
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    registerFileCommands(ctx);

    const browse = registeredCommands.get("nexus.files.browse");
    expect(browse).toBeDefined();
    await browse!();

    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as Array<{ label: string }>;
    expect(items.map((item) => item.label)).toEqual(["A1", "A2", "A10"]);
  });

  describe("goToPath / goHome refresh regression guards (§5.5)", () => {
    it("goToPath with a string arg equal to the current root path still invalidates the cache and calls setRootPath", async () => {
      const ctx = createContext({ rootPath: "/home" });
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");
      expect(goToPath).toBeDefined();

      await goToPath!("/home");

      expect(ctx.sftpService.invalidateCache).toHaveBeenCalledWith("srv-1", "/home");
      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledWith("/home");
    });

    it("goToPath via the input box still calls setRootPath when the entered path equals the current root", async () => {
      const ctx = createContext({ rootPath: "/home" });
      mockShowInputBox.mockResolvedValue("/home");
      ctx.sftpService.stat = vi.fn(async () => ({
        name: "home",
        isDirectory: true,
        isSymlink: false,
        size: 0,
        modifiedAt: 1700000000,
        permissions: 0o755,
      }));
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");
      expect(goToPath).toBeDefined();

      await goToPath!(undefined);

      expect(ctx.sftpService.invalidateCache).toHaveBeenCalledWith("srv-1", "/home");
      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledWith("/home");
    });

    it("goHome still calls setRootPath even when already at the home directory", async () => {
      const ctx = createContext({ rootPath: "/home/dev" });
      (ctx.fileExplorerProvider.getHomeDir as any).mockReturnValue("/home/dev");
      registerFileCommands(ctx);
      const goHome = registeredCommands.get("nexus.files.goHome");
      expect(goHome).toBeDefined();

      goHome!();

      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledWith("/home/dev");
    });
  });

  describe("promptGoToPath commit-time re-check (§5.4 hole f)", () => {
    function directoryStat() {
      return {
        name: "log",
        isDirectory: true,
        isSymlink: false,
        size: 0,
        modifiedAt: 1700000000,
        permissions: 0o755,
      };
    }

    it("discards the navigation when the explorer's active server changes during the awaits (cross-server race)", async () => {
      const ctx = createContext({ rootPath: "/home" });
      mockShowInputBox.mockResolvedValue("/var/log");
      ctx.sftpService.stat = vi.fn(async () => {
        // The user (or an auto-disconnect) switches the explorer to another
        // server while the stat call is still in flight.
        (ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue("srv-2");
        return directoryStat();
      });
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");

      await goToPath!(undefined);

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).not.toHaveBeenCalled();
    });

    it("discards the navigation when the explorer is torn down during the awaits (no active server left)", async () => {
      const ctx = createContext({ rootPath: "/home" });
      mockShowInputBox.mockResolvedValue("/var/log");
      ctx.sftpService.stat = vi.fn(async () => {
        (ctx.fileExplorerProvider.getActiveServerId as any).mockReturnValue(undefined);
        return directoryStat();
      });
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");

      await goToPath!(undefined);

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).not.toHaveBeenCalled();
    });

    it("still commits when the explorer's active server is unchanged by the time the awaits resolve", async () => {
      const ctx = createContext({ rootPath: "/home" });
      mockShowInputBox.mockResolvedValue("/var/log");
      ctx.sftpService.stat = vi.fn(async () => directoryStat());
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");

      await goToPath!(undefined);

      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledWith("/var/log");
      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).toHaveBeenCalledTimes(1);
    });
  });

  describe("manual navigation pins directory sync (§8.3)", () => {
    it("goToPath with a string arg (the .. ParentDirItem row) notifies manual navigation", async () => {
      const ctx = createContext({ rootPath: "/home" });
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");

      await goToPath!("/home/parent");

      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).toHaveBeenCalledTimes(1);
    });

    it("goToPath via the input box notifies manual navigation on a successful navigation", async () => {
      const ctx = createContext({ rootPath: "/home" });
      mockShowInputBox.mockResolvedValue("/var/log");
      ctx.sftpService.stat = vi.fn(async () => ({
        name: "log",
        isDirectory: true,
        isSymlink: false,
        size: 0,
        modifiedAt: 1700000000,
        permissions: 0o755,
      }));
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");

      await goToPath!(undefined);

      expect(ctx.fileExplorerProvider.setRootPath).toHaveBeenCalledWith("/var/log");
      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).toHaveBeenCalledTimes(1);
    });

    it("goToPath via the input box does NOT notify manual navigation when the box is dismissed", async () => {
      const ctx = createContext({ rootPath: "/home" });
      mockShowInputBox.mockResolvedValue(undefined);
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");

      await goToPath!(undefined);

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).not.toHaveBeenCalled();
    });

    it("goToPath via the input box does NOT notify manual navigation when the target is not a directory", async () => {
      const ctx = createContext({ rootPath: "/home" });
      mockShowInputBox.mockResolvedValue("/etc/hosts");
      ctx.sftpService.stat = vi.fn(async () => ({
        name: "hosts",
        isDirectory: false,
        isSymlink: false,
        size: 10,
        modifiedAt: 1700000000,
        permissions: 0o644,
      }));
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");

      await goToPath!(undefined);

      expect(ctx.fileExplorerProvider.setRootPath).not.toHaveBeenCalled();
      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).not.toHaveBeenCalled();
    });

    it("goHome notifies manual navigation", async () => {
      const ctx = createContext({ rootPath: "/var/log" });
      (ctx.fileExplorerProvider.getHomeDir as any).mockReturnValue("/home/dev");
      registerFileCommands(ctx);
      const goHome = registeredCommands.get("nexus.files.goHome");

      goHome!();

      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).toHaveBeenCalledTimes(1);
    });

    it("goHome does not notify manual navigation when there is no known home directory", async () => {
      const ctx = createContext({ rootPath: "/var/log" });
      (ctx.fileExplorerProvider.getHomeDir as any).mockReturnValue(undefined);
      registerFileCommands(ctx);
      const goHome = registeredCommands.get("nexus.files.goHome");

      goHome!();

      expect(ctx.cwdSyncCoordinator!.notifyManualNavigation).not.toHaveBeenCalled();
    });

    it("tolerates a missing cwdSyncCoordinator (optional field)", async () => {
      const ctx = createContext({ rootPath: "/home" });
      delete (ctx as any).cwdSyncCoordinator;
      registerFileCommands(ctx);
      const goToPath = registeredCommands.get("nexus.files.goToPath");
      const goHome = registeredCommands.get("nexus.files.goHome");
      (ctx.fileExplorerProvider.getHomeDir as any).mockReturnValue("/home/dev");

      await expect(goToPath!("/home/parent")).resolves.toBeUndefined();
      expect(() => goHome!()).not.toThrow();
    });
  });

  describe("disconnect command (P2)", () => {
    it("clears the cached sudo password and elevated marks for the active server, alongside the SFTP disconnect", async () => {
      const ctx = createContext({ activeServerId: "srv-1" });
      const clearCachedPassword = vi.fn();
      const clearElevatedForServer = vi.fn();
      (ctx as any).elevationBroker = { clearCachedPassword };
      (ctx as any).fileSystemProvider = { clearElevatedForServer, markElevated: vi.fn() };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.disconnect")!;

      handler();

      expect(ctx.sftpService.disconnect).toHaveBeenCalledWith("srv-1");
      expect(clearCachedPassword).toHaveBeenCalledWith("srv-1");
      expect(clearElevatedForServer).toHaveBeenCalledWith("srv-1");
      expect(ctx.fileExplorerProvider.clearActiveServer).toHaveBeenCalled();
      // §8.3: the pin clears automatically on an explorer server change.
      expect(ctx.cwdSyncCoordinator!.notifyExplorerServerChanged).toHaveBeenCalledTimes(1);
    });

    it("tolerates a missing cwdSyncCoordinator", async () => {
      const ctx = createContext({ activeServerId: "srv-1" });
      delete (ctx as any).cwdSyncCoordinator;
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.disconnect")!;

      expect(() => handler()).not.toThrow();
      expect(ctx.fileExplorerProvider.clearActiveServer).toHaveBeenCalled();
    });

    it("does nothing sudo-related when there is no active server", async () => {
      const ctx = createContext({ activeServerId: undefined });
      const clearCachedPassword = vi.fn();
      const clearElevatedForServer = vi.fn();
      (ctx as any).elevationBroker = { clearCachedPassword };
      (ctx as any).fileSystemProvider = { clearElevatedForServer, markElevated: vi.fn() };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.disconnect")!;

      handler();

      expect(clearCachedPassword).not.toHaveBeenCalled();
      expect(clearElevatedForServer).not.toHaveBeenCalled();
      expect(ctx.fileExplorerProvider.clearActiveServer).toHaveBeenCalled();
    });

    it("tolerates a missing elevationBroker/fileSystemProvider (e.g. web extension fallback)", async () => {
      const ctx = createContext({ activeServerId: "srv-1" }); // both left unset
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.disconnect")!;

      expect(() => handler()).not.toThrow();
      expect(ctx.sftpService.disconnect).toHaveBeenCalledWith("srv-1");
    });
  });

  describe("editAsRoot command", () => {
    beforeEach(() => {
      mockGetConfiguration.mockReturnValue({ get: (_key: string, def: unknown) => def });
    });

    function fileItem(overrides?: { serverId?: string; remotePath?: string }): FileTreeItem {
      return createFileTreeItem({
        serverId: overrides?.serverId,
        remotePath: overrides?.remotePath ?? "/etc",
        entry: {
          name: "hosts",
          isDirectory: false,
          isSymlink: false,
          size: 10,
          modifiedAt: 1700000000,
          permissions: 0o644,
        },
      });
    }

    it("registers nexus.files.editAsRoot", () => {
      const ctx = createContext();
      (ctx as any).fileSystemProvider = { markElevated: vi.fn() };
      registerFileCommands(ctx);

      expect(registeredCommands.has("nexus.files.editAsRoot")).toBe(true);
    });

    it("marks the URI elevated and opens it", async () => {
      const markElevated = vi.fn();
      const ctx = createContext();
      (ctx as any).fileSystemProvider = { markElevated };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.editAsRoot")!;

      await handler(fileItem());

      // FileTreeItem.remotePath is the containing directory, not the file — the
      // path must be joined with the entry name before building the URI.
      expect(mockBuildUri).toHaveBeenCalledWith("srv-1", "/etc/hosts");
      expect(markElevated).toHaveBeenCalledTimes(1);
      expect(mockExecuteCommand).toHaveBeenCalledWith("vscode.open", expect.anything());
    });

    it("reports that elevated saves are disabled, with an Open Settings button (P5), when nexus.sftp.sudo.enabled is false", async () => {
      mockGetConfiguration.mockReturnValue({
        get: (key: string, def: unknown) => (key === "sudo.enabled" ? false : def),
      });
      mockShowWarningMessage.mockResolvedValue(undefined);
      const markElevated = vi.fn();
      const ctx = createContext();
      (ctx as any).fileSystemProvider = { markElevated };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.editAsRoot")!;

      await handler(fileItem());

      expect(markElevated).not.toHaveBeenCalled();
      expect(mockExecuteCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        "Elevated saves are disabled (nexus.sftp.sudo.enabled is off).",
        "Open Settings"
      );
    });

    it("opens the sudo.enabled setting when the disabled warning's Open Settings button is clicked (P5)", async () => {
      mockGetConfiguration.mockReturnValue({
        get: (key: string, def: unknown) => (key === "sudo.enabled" ? false : def),
      });
      mockShowWarningMessage.mockResolvedValue("Open Settings");
      const ctx = createContext();
      (ctx as any).fileSystemProvider = { markElevated: vi.fn() };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.editAsRoot")!;

      await handler(fileItem());

      expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.openSettings", "nexus.sftp.sudo.enabled");
    });

    it("falls back to the active editor's nexterm:// document when invoked with no tree item (P6: palette invocation)", async () => {
      const vscode = await import("vscode");
      const markElevated = vi.fn();
      const ctx = createContext();
      (ctx as any).fileSystemProvider = { markElevated };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.editAsRoot")!;
      const activeUri = { scheme: "nexterm", toString: () => "nexterm://srv-1/etc/hosts" };
      (vscode.window as any).activeTextEditor = { document: { uri: activeUri } };

      await handler();

      expect(markElevated).toHaveBeenCalledWith(activeUri);
      expect(mockExecuteCommand).toHaveBeenCalledWith("vscode.open", activeUri);

      (vscode.window as any).activeTextEditor = undefined;
    });

    it("does not fall back to a non-nexterm active editor (e.g. a local file)", async () => {
      const vscode = await import("vscode");
      const markElevated = vi.fn();
      const ctx = createContext();
      (ctx as any).fileSystemProvider = { markElevated };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.editAsRoot")!;
      (vscode.window as any).activeTextEditor = {
        document: { uri: { scheme: "file", toString: () => "file:///etc/hosts" } }
      };

      await handler();

      expect(markElevated).not.toHaveBeenCalled();
      expect(mockExecuteCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());

      (vscode.window as any).activeTextEditor = undefined;
    });

    it("does nothing when no fileSystemProvider is wired", async () => {
      const ctx = createContext(); // fileSystemProvider left unset (optional field)
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.editAsRoot")!;

      await expect(handler(fileItem())).resolves.toBeUndefined();
      expect(mockExecuteCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
    });

    it("ignores non-FileTreeItem and directory arguments", async () => {
      const markElevated = vi.fn();
      const ctx = createContext();
      (ctx as any).fileSystemProvider = { markElevated };
      registerFileCommands(ctx);
      const handler = registeredCommands.get("nexus.files.editAsRoot")!;

      await handler(undefined);
      const dirItem = createFileTreeItem({
        entry: { name: "subdir", isDirectory: true, isSymlink: false, size: 0, modifiedAt: 0, permissions: 0o755 },
      });
      await handler(dirItem);

      expect(markElevated).not.toHaveBeenCalled();
      expect(mockExecuteCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
    });
  });
});
