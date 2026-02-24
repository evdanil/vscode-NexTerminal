import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(() => {
    const listeners: Array<(e: unknown) => void> = [];
    return {
      event: (listener: (e: unknown) => void) => { listeners.push(listener); },
      fire: (e: unknown) => { for (const l of listeners) { l(e); } },
      _listeners: listeners
    };
  });
  return {
    TreeItem: class {
      label?: string;
      id?: string;
      description?: string;
      contextValue?: string;
      command?: unknown;
      tooltip?: string;
      iconPath?: unknown;
      resourceUri?: unknown;
      collapsibleState?: number;
      constructor(label: string, collapsibleState?: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: Object.assign(
      class { constructor(public id: string) {} },
      {
        File: { id: "file" },
        Folder: { id: "folder" },
      }
    ),
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: {
      from: vi.fn((components: { scheme: string; authority: string; path: string }) => ({
        scheme: components.scheme,
        authority: components.authority,
        path: components.path,
        fsPath: components.path,
        toString: () => `${components.scheme}://${components.authority}${components.path}`,
      })),
      parse: vi.fn((value: string) => {
        const parsed = new URL(value);
        return {
          scheme: parsed.protocol.replace(":", ""),
          authority: parsed.host,
          path: parsed.pathname,
          fsPath: parsed.pathname,
          toString: () => value,
        };
      }),
      joinPath: vi.fn((base: { scheme: string; authority: string; path: string; fsPath: string }, ...segments: string[]) => {
        const basePath = base.path.endsWith("/") ? base.path.slice(0, -1) : base.path;
        const joinedPath = `${basePath}/${segments.join("/")}`.replace(/\/+/g, "/");
        return {
          scheme: base.scheme,
          authority: base.authority,
          path: joinedPath,
          fsPath: joinedPath,
          toString: () => `${base.scheme}://${base.authority}${joinedPath}`,
        };
      }),
      file: vi.fn((filePath: string) => ({
        scheme: "file",
        authority: "",
        path: filePath,
        fsPath: filePath,
        toString: () => `file://${filePath}`,
      })),
    },
    DataTransferItem: class {
      constructor(public value: string, private file?: { uri?: unknown }) {}
      asString() { return Promise.resolve(this.value); }
      asFile() { return this.file; }
    },
    window: {
      showErrorMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      withProgress: vi.fn(async (_opts, task) => task({ report: vi.fn() })),
    },
    ProgressLocation: { Notification: 15 },
    workspace: {
      fs: {
        stat: vi.fn(),
        readDirectory: vi.fn(),
      },
    },
    EventEmitter,
  };
});

import { FileExplorerTreeProvider, FileExplorerServerItem, FileTreeItem, ParentDirItem } from "../../src/ui/fileExplorerTreeProvider";
import type { DirectoryEntry } from "../../src/services/sftp/sftpService";
import type { ServerConfig } from "../../src/models/config";
import { createMockSftpService } from "../helpers/mockSftpService";

const testServer: ServerConfig = {
  id: "srv-1",
  name: "Test Server",
  host: "example.com",
  port: 22,
  username: "dev",
  authType: "password",
  isHidden: false,
};

const fileEntry: DirectoryEntry = {
  name: "file.txt",
  isDirectory: false,
  isSymlink: false,
  size: 1024,
  modifiedAt: 1700000000,
  permissions: 0o644,
};

const dirEntry: DirectoryEntry = {
  name: "subdir",
  isDirectory: true,
  isSymlink: false,
  size: 4096,
  modifiedAt: 1700000001,
  permissions: 0o755,
};

describe("FileExplorerTreeProvider", () => {
  let sftp: ReturnType<typeof createMockSftpService>;
  let provider: FileExplorerTreeProvider;

  beforeEach(async () => {
    sftp = createMockSftpService();
    provider = new FileExplorerTreeProvider(sftp);
    const vscode = await import("vscode");
    (vscode.window.showQuickPick as any).mockReset();
    (vscode.window.showErrorMessage as any).mockReset();
    (vscode.window.showWarningMessage as any).mockReset();
    (vscode.window.showInformationMessage as any).mockReset();
    (vscode.window.withProgress as any).mockReset();
    (vscode.window.withProgress as any).mockImplementation(async (_opts: unknown, task: any) => task({ report: vi.fn() }));
    (vscode.workspace.fs.stat as any).mockReset();
    (vscode.workspace.fs.readDirectory as any).mockReset();
  });

  it("returns empty children when no active server", async () => {
    const children = await provider.getChildren();
    expect(children).toEqual([]);
  });

  it("returns server header and entries when active server is set", async () => {
    (sftp.readDirectory as any).mockResolvedValue([fileEntry, dirEntry]);

    provider.setActiveServer(testServer, "/home/dev");
    const children = await provider.getChildren();

    expect(children).toHaveLength(5); // header + parentDir + "." + 2 entries
    expect(children[0]).toBeInstanceOf(FileExplorerServerItem);
    expect(children[1]).toBeInstanceOf(ParentDirItem);
    expect(children[2]).toBeInstanceOf(FileTreeItem);
    expect((children[2] as FileTreeItem).label).toBe(".");
    expect(children[3]).toBeInstanceOf(FileTreeItem);
    expect(children[4]).toBeInstanceOf(FileTreeItem);
  });

  it("omits ParentDirItem when root is /", async () => {
    (sftp.readDirectory as any).mockResolvedValue([fileEntry]);

    provider.setActiveServer(testServer, "/");
    const children = await provider.getChildren();

    expect(children).toHaveLength(3); // header + "." + 1 entry, no parentDir
    expect(children[0]).toBeInstanceOf(FileExplorerServerItem);
    expect(children[1]).toBeInstanceOf(FileTreeItem);
    expect((children[1] as FileTreeItem).label).toBe(".");
    expect(children[2]).toBeInstanceOf(FileTreeItem);
  });

  it("sorts directories before files", async () => {
    (sftp.readDirectory as any).mockResolvedValue([fileEntry, dirEntry]);

    provider.setActiveServer(testServer, "/home/dev");
    const children = await provider.getChildren();

    // Skip server header + parentDir + "." items
    const items = children.filter((c) => c instanceof FileTreeItem && c.label !== ".") as FileTreeItem[];
    expect(items[0].entry.isDirectory).toBe(true);
    expect(items[1].entry.isDirectory).toBe(false);
  });

  it("sorts alphabetically within same type", async () => {
    const entries: DirectoryEntry[] = [
      { ...fileEntry, name: "zebra.txt" },
      { ...fileEntry, name: "alpha.txt" },
      { ...dirEntry, name: "bravo" },
      { ...dirEntry, name: "able" },
    ];
    (sftp.readDirectory as any).mockResolvedValue(entries);

    provider.setActiveServer(testServer, "/home/dev");
    const children = await provider.getChildren();
    const items = children.filter((c) => c instanceof FileTreeItem && c.label !== ".") as FileTreeItem[];

    expect(items[0].entry.name).toBe("able");
    expect(items[1].entry.name).toBe("bravo");
    expect(items[2].entry.name).toBe("alpha.txt");
    expect(items[3].entry.name).toBe("zebra.txt");
  });

  it("expands directory items into child entries", async () => {
    const childEntries: DirectoryEntry[] = [
      { ...fileEntry, name: "nested.txt" },
    ];
    (sftp.readDirectory as any).mockResolvedValue(childEntries);

    provider.setActiveServer(testServer, "/home/dev");

    const dirItem = new FileTreeItem("srv-1", "/home/dev", dirEntry);
    const children = await provider.getChildren(dirItem);

    expect(children).toHaveLength(1);
    expect((children[0] as FileTreeItem).entry.name).toBe("nested.txt");
  });

  it("returns empty for non-directory items", async () => {
    provider.setActiveServer(testServer, "/home/dev");

    const fileItem = new FileTreeItem("srv-1", "/home/dev", fileEntry);
    const children = await provider.getChildren(fileItem);

    expect(children).toEqual([]);
  });

  it("clears active server", async () => {
    provider.setActiveServer(testServer, "/home/dev");
    provider.clearActiveServer();

    expect(provider.getActiveServerId()).toBeUndefined();
    const children = await provider.getChildren();
    expect(children).toEqual([]);
  });

  it("getActiveServerId returns the active server id", () => {
    expect(provider.getActiveServerId()).toBeUndefined();
    provider.setActiveServer(testServer, "/home/dev");
    expect(provider.getActiveServerId()).toBe("srv-1");
  });

  it("fires onDidChangeTreeData when setting active server", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.setActiveServer(testServer, "/home/dev");
    expect(listener).toHaveBeenCalled();
  });

  it("fires onDidChangeTreeData on refresh", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.refresh();
    expect(listener).toHaveBeenCalled();
  });

  it("file items have correct contextValue", () => {
    const fileItem = new FileTreeItem("srv-1", "/home/dev", fileEntry);
    expect(fileItem.contextValue).toBe("nexus.fileExplorer.file");
  });

  it("directory items have correct contextValue", () => {
    const dirItem = new FileTreeItem("srv-1", "/home/dev", dirEntry);
    expect(dirItem.contextValue).toBe("nexus.fileExplorer.dir");
  });

  it("file items have a command to open via nexterm:// URI", () => {
    const item = new FileTreeItem("srv-1", "/home/dev", fileEntry);
    expect(item.command).toBeDefined();
    expect(item.command!.command).toBe("vscode.open");
    expect(item.resourceUri).toBeDefined();
    expect(item.resourceUri!.scheme).toBe("nexterm");
    expect(item.resourceUri!.authority).toBe("srv-1");
    expect(item.resourceUri!.path).toBe("/home/dev/file.txt");
  });

  it("directory items expose nexterm:// resourceUri", () => {
    const item = new FileTreeItem("srv-1", "/home/dev", dirEntry);
    expect(item.resourceUri).toBeDefined();
    expect(item.resourceUri!.scheme).toBe("nexterm");
    expect(item.resourceUri!.path).toBe("/home/dev/subdir");
    expect(item.command).toBeUndefined();
  });

  it("declares external and internal drop mime types", () => {
    expect(provider.dragMimeTypes).toEqual(["application/vnd.nexus.fileitem", "text/uri-list"]);
    expect(provider.dropMimeTypes).toEqual(["application/vnd.nexus.fileitem", "text/uri-list", "files"]);
  });

  it("handles readDirectory errors gracefully", async () => {
    (sftp.readDirectory as any).mockRejectedValue(new Error("permission denied"));

    provider.setActiveServer(testServer, "/home/dev");
    const children = await provider.getChildren();

    // Should have server header + parentDir + "." + empty directory (error caught)
    expect(children).toHaveLength(3); // header + parentDir + "."
  });

  it("setRootPath changes the root directory", async () => {
    (sftp.readDirectory as any).mockResolvedValue([fileEntry]);

    provider.setActiveServer(testServer, "/home/dev");
    provider.setRootPath("/etc");
    expect(provider.getRootPath()).toBe("/etc");

    const children = await provider.getChildren();
    const parentItem = children.find((c) => c instanceof ParentDirItem) as ParentDirItem;
    expect(parentItem).toBeDefined();
    expect(parentItem.parentPath).toBe("/");
  });

  it("getHomeDir returns the original home directory", () => {
    provider.setActiveServer(testServer, "/home/dev");
    expect(provider.getHomeDir()).toBe("/home/dev");
    provider.setRootPath("/etc");
    expect(provider.getHomeDir()).toBe("/home/dev");
  });

  describe('"." current directory item', () => {
    it('has contextValue nexus.fileExplorer.currentDir and label "."', async () => {
      (sftp.readDirectory as any).mockResolvedValue([]);

      provider.setActiveServer(testServer, "/home/dev");
      const children = await provider.getChildren();
      const dotItem = children.find(
        (c) => c instanceof FileTreeItem && c.label === "."
      ) as FileTreeItem;

      expect(dotItem).toBeDefined();
      expect(dotItem.contextValue).toBe("nexus.fileExplorer.currentDir");
      expect(dotItem.label).toBe(".");
      expect(dotItem.tooltip).toBe("/home/dev");
      expect(dotItem.description).toBe("/home/dev");
      expect(dotItem.collapsibleState).toBe(0); // None
    });

    it('resolves correctly at root "/"', async () => {
      (sftp.readDirectory as any).mockResolvedValue([]);

      provider.setActiveServer(testServer, "/");
      const children = await provider.getChildren();
      const dotItem = children.find(
        (c) => c instanceof FileTreeItem && c.label === "."
      ) as FileTreeItem;

      expect(dotItem).toBeDefined();
      expect(dotItem.tooltip).toBe("/");
      // path.posix.join("/", "") === "/" — so commands resolve to "/"
      const path = await import("node:path");
      expect(path.posix.join(dotItem.remotePath, dotItem.entry.name)).toBe("/");
    });
  });

  describe("drag and drop", () => {
    it("handleDrag serializes FileTreeItem data correctly", async () => {
      const item = new FileTreeItem("srv-1", "/home/dev", fileEntry);
      const dataTransfer = new Map<string, { value: string }>();
      const mockTransfer = {
        set: (mime: string, transferItem: { value: string }) => {
          dataTransfer.set(mime, transferItem);
        },
      };

      await provider.handleDrag([item], mockTransfer as any);

      const entry = dataTransfer.get("application/vnd.nexus.fileitem");
      expect(entry).toBeDefined();
      const parsed = JSON.parse(entry!.value);
      expect(parsed).toEqual([
        { serverId: "srv-1", remotePath: "/home/dev", name: "file.txt", isDirectory: false },
      ]);
    });

    it('handleDrag skips "." items', async () => {
      (sftp.readDirectory as any).mockResolvedValue([]);
      provider.setActiveServer(testServer, "/home/dev");
      const children = await provider.getChildren();
      const dotItem = children.find(
        (c) => c instanceof FileTreeItem && c.label === "."
      )!;

      const dataTransfer = new Map<string, unknown>();
      const mockTransfer = {
        set: (mime: string, transferItem: unknown) => {
          dataTransfer.set(mime, transferItem);
        },
      };

      await provider.handleDrag([dotItem], mockTransfer as any);
      expect(dataTransfer.size).toBe(0);
    });

    it("handleDrop shows QuickPick; Move calls sftp.rename", async () => {
      const vscode = await import("vscode");
      (vscode.window.showQuickPick as any).mockResolvedValue({ label: "Move", value: "move" });
      (sftp.rename as any).mockResolvedValue(undefined);
      provider.setActiveServer(testServer, "/home/dev");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev", name: "file.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(sftp.rename).toHaveBeenCalledWith(
        "srv-1",
        "/home/dev/file.txt",
        "/home/dev/subdir/file.txt"
      );
    });

    it("handleDrop shows QuickPick; Copy calls sftp.copyRemote", async () => {
      const vscode = await import("vscode");
      (vscode.window.showQuickPick as any).mockResolvedValue({ label: "Copy", value: "copy" });
      (sftp.copyRemote as any).mockResolvedValue(undefined);
      provider.setActiveServer(testServer, "/home/dev");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev", name: "file.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(sftp.copyRemote).toHaveBeenCalledWith(
        "srv-1",
        "/home/dev/file.txt",
        "/home/dev/subdir/file.txt",
        false
      );
    });

    it("handleDrop does nothing when user cancels QuickPick", async () => {
      const vscode = await import("vscode");
      (vscode.window.showQuickPick as any).mockResolvedValue(undefined);
      provider.setActiveServer(testServer, "/home/dev");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev", name: "file.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(sftp.rename).not.toHaveBeenCalled();
      expect(sftp.copyRemote).not.toHaveBeenCalled();
    });

    it("handleDrop skips move when source === target", async () => {
      provider.setActiveServer(testServer, "/home/dev");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev/subdir", name: "file.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      // No valid items, so QuickPick should not be shown
      const vscode = await import("vscode");
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(sftp.rename).not.toHaveBeenCalled();
    });

    it("handleDrop skips moving a directory into itself", async () => {
      provider.setActiveServer(testServer, "/home/dev");

      // Target is the same directory being dragged
      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev", name: "subdir", isDirectory: true },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      const vscode = await import("vscode");
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(sftp.rename).not.toHaveBeenCalled();
    });

    it("handleDrop uses parent directory when dropped on a file", async () => {
      const vscode = await import("vscode");
      (vscode.window.showQuickPick as any).mockResolvedValue({ label: "Move", value: "move" });
      (sftp.rename as any).mockResolvedValue(undefined);
      provider.setActiveServer(testServer, "/home/dev");

      const targetFile = new FileTreeItem("srv-1", "/home/dev/subdir", fileEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev", name: "other.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetFile, mockTransfer as any);

      expect(sftp.rename).toHaveBeenCalledWith(
        "srv-1",
        "/home/dev/other.txt",
        "/home/dev/subdir/other.txt"
      );
    });

    it("handleDrop uses currentRootPath when dropped on undefined", async () => {
      const vscode = await import("vscode");
      (vscode.window.showQuickPick as any).mockResolvedValue({ label: "Move", value: "move" });
      (sftp.rename as any).mockResolvedValue(undefined);
      provider.setActiveServer(testServer, "/home/dev");

      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev/subdir", name: "file.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(undefined, mockTransfer as any);

      expect(sftp.rename).toHaveBeenCalledWith(
        "srv-1",
        "/home/dev/subdir/file.txt",
        "/home/dev/file.txt"
      );
    });

    it("handleDrop rejects forged payload names with path separators", async () => {
      provider.setActiveServer(testServer, "/home/dev");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev", name: "/etc/passwd", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileitem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      const vscode = await import("vscode");
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(sftp.rename).not.toHaveBeenCalled();
      expect(sftp.copyRemote).not.toHaveBeenCalled();
    });

    it("handleDrop uploads local file from text/uri-list", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.File });
      (sftp.stat as any).mockRejectedValue(new Error("missing"));
      (sftp.upload as any).mockResolvedValue(undefined);

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/local.txt");
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "text/uri-list") { return uriListItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(sftp.upload).toHaveBeenCalledWith(
        "srv-1",
        "/tmp/local.txt",
        "/home/dev/subdir/local.txt"
      );
    });

    it("handleDrop uploads dropped local directory recursively", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory });
      (vscode.workspace.fs.readDirectory as any).mockResolvedValue([
        ["nested.txt", vscode.FileType.File],
      ]);
      (sftp.stat as any).mockRejectedValue(new Error("missing"));
      (sftp.createDirectory as any).mockResolvedValue(undefined);
      (sftp.upload as any).mockResolvedValue(undefined);

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/mydir");
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "text/uri-list") { return uriListItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(sftp.createDirectory).toHaveBeenCalledWith("srv-1", "/home/dev/subdir/mydir");
      expect(sftp.upload).toHaveBeenCalledWith(
        "srv-1",
        "/tmp/mydir/nested.txt",
        "/home/dev/subdir/mydir/nested.txt"
      );
    });

    it("handleDrop enforces max upload depth for local directories", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory });
      (vscode.workspace.fs.readDirectory as any).mockResolvedValue([
        ["nested", vscode.FileType.Directory],
      ]);
      (sftp.stat as any).mockRejectedValue(new Error("missing"));
      (sftp.createDirectory as any).mockResolvedValue(undefined);

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/deep");
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "text/uri-list") { return uriListItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("directory nesting exceeds 100 levels")
      );
      expect(sftp.upload).not.toHaveBeenCalled();
    });

    it("handleDrop supports skip-all conflict decision", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory });
      (vscode.workspace.fs.readDirectory as any).mockResolvedValue([
        ["one.txt", vscode.FileType.File],
        ["two.txt", vscode.FileType.File],
      ]);
      (sftp.createDirectory as any).mockResolvedValue(undefined);
      (sftp.stat as any).mockImplementation(async (_serverId: string, remotePath: string) => {
        if (remotePath.endsWith("/mydir")) {
          throw new Error("missing");
        }
        return { ...fileEntry, name: "existing.txt", isDirectory: false };
      });
      (vscode.window.showWarningMessage as any).mockResolvedValue("Skip All");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/mydir");
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "text/uri-list") { return uriListItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      const conflictPrompts = (vscode.window.showWarningMessage as any).mock.calls
        .filter((args: unknown[]) => typeof args[0] === "string" && args[0].includes("already exists"));
      expect(conflictPrompts).toHaveLength(1);
      expect(sftp.upload).not.toHaveBeenCalled();
    });

    it("handleDrop ignores unsupported uri schemes from external sources", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("nexterm://srv-1/home/dev/file.txt");
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "text/uri-list") { return uriListItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(sftp.upload).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });

    it("handleDrag sets text/uri-list with nexterm:// URIs", async () => {
      const item = new FileTreeItem("srv-1", "/home/dev", fileEntry);
      const dataTransfer = new Map<string, { value: string }>();
      const mockTransfer = {
        set: (mime: string, transferItem: { value: string }) => {
          dataTransfer.set(mime, transferItem);
        },
      };

      await provider.handleDrag([item], mockTransfer as any);

      const uriList = dataTransfer.get("text/uri-list");
      expect(uriList).toBeDefined();
      expect(uriList!.value).toContain("nexterm");
      expect(uriList!.value).toContain("/home/dev/file.txt");
    });
  });
});
