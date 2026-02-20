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
    Uri: {
      from: vi.fn((components: { scheme: string; authority: string; path: string }) => ({
        scheme: components.scheme,
        authority: components.authority,
        path: components.path,
      })),
    },
    DataTransferItem: class {
      constructor(public value: string) {}
      asString() { return Promise.resolve(this.value); }
    },
    window: {
      showErrorMessage: vi.fn(),
    },
    EventEmitter,
  };
});

import { FileExplorerTreeProvider, FileExplorerServerItem, FileTreeItem, ParentDirItem } from "../../src/ui/fileExplorerTreeProvider";
import type { SftpService, DirectoryEntry } from "../../src/services/sftp/sftpService";
import type { ServerConfig } from "../../src/models/config";

function createMockSftpService(): SftpService {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(),
    readDirectory: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
    createDirectory: vi.fn(),
    realpath: vi.fn(),
    download: vi.fn(),
    upload: vi.fn(),
    invalidateCache: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

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

  beforeEach(() => {
    sftp = createMockSftpService();
    provider = new FileExplorerTreeProvider(sftp);
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
    it('has contextValue nexus.fileExplorer.dir and label "."', async () => {
      (sftp.readDirectory as any).mockResolvedValue([]);

      provider.setActiveServer(testServer, "/home/dev");
      const children = await provider.getChildren();
      const dotItem = children.find(
        (c) => c instanceof FileTreeItem && c.label === "."
      ) as FileTreeItem;

      expect(dotItem).toBeDefined();
      expect(dotItem.contextValue).toBe("nexus.fileExplorer.dir");
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

      const entry = dataTransfer.get("application/vnd.nexus.fileItem");
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

    it("handleDrop calls sftp.rename with correct paths", async () => {
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
          if (mime === "application/vnd.nexus.fileItem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(sftp.rename).toHaveBeenCalledWith(
        "srv-1",
        "/home/dev/file.txt",
        "/home/dev/subdir/file.txt"
      );
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
          if (mime === "application/vnd.nexus.fileItem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

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
          if (mime === "application/vnd.nexus.fileItem") { return transferItem; }
          return undefined;
        },
      };

      await provider.handleDrop(targetDir, mockTransfer as any);

      expect(sftp.rename).not.toHaveBeenCalled();
    });

    it("handleDrop uses parent directory when dropped on a file", async () => {
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
          if (mime === "application/vnd.nexus.fileItem") { return transferItem; }
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
      (sftp.rename as any).mockResolvedValue(undefined);
      provider.setActiveServer(testServer, "/home/dev");

      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev/subdir", name: "file.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => {
          if (mime === "application/vnd.nexus.fileItem") { return transferItem; }
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
  });
});
