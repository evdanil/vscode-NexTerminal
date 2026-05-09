import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import type { DirectoryEntry } from "../../src/services/sftp/sftpService";
import { registerFileCommands } from "../../src/commands/fileCommands";
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
    showSaveDialog: vi.fn()
  },
  workspace: {
    fs: {
      copy: vi.fn(),
      stat: vi.fn(),
      createDirectory: vi.fn(),
      delete: vi.fn()
    }
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
  buildUri: (...args: unknown[]) => mockBuildUri(...args as [string, string])
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
      connect: vi.fn(),
      realpath: vi.fn(),
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
      clearActiveServer: vi.fn()
    } as any
  };
}

describe("fileCommands title bar actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
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
});
