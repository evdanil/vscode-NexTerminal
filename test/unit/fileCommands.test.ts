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
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showSaveDialog: vi.fn()
  },
  workspace: {
    fs: { copy: vi.fn() }
  },
  env: {
    clipboard: { writeText: vi.fn() }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, child: string) => ({ fsPath: `${base.fsPath}/${child}` })
  },
  ProgressLocation: { Notification: 15 },
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
      stat: vi.fn(),
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

    expect(mockShowErrorMessage).toHaveBeenCalledWith("Failed to upload: upload blocked");
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
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
