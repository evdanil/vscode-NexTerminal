import { describe, expect, it, vi, beforeEach } from "vitest";

// The drag-drop upload path reads the LOCAL side through node:fs, not
// vscode.workspace.fs — that is the fix under test (workspace.fs launders
// ERR_UNC_HOST_NOT_ALLOWED into code "Unknown", which is how a hard policy
// failure used to reach a bare `catch { skipped += 1 }`).
const { fsPromisesMock, mockConfigGet, mockConfigUpdate, mockExecuteCommand } = vi.hoisted(() => ({
  fsPromisesMock: {
    lstat: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    open: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  },
  mockConfigGet: vi.fn(),
  mockConfigUpdate: vi.fn(),
  mockExecuteCommand: vi.fn()
}));

vi.mock("node:fs", () => ({
  promises: fsPromisesMock,
  default: { promises: fsPromisesMock }
}));

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(function () {
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
        const scheme = parsed.protocol.replace(":", "");
        const authority = parsed.host;
        return {
          scheme,
          authority,
          path: parsed.pathname,
          // Real VS Code turns an authority-bearing file: URI into the UNC form
          // (`\\server\share\...` on win32). The mock produces the
          // forward-slash spelling so the POSIX `path` module used by the test
          // host parses it the same way — dropping the authority (as this mock
          // used to) makes the field bug unrepresentable.
          fsPath: authority && scheme === "file" ? `//${authority}${parsed.pathname}` : parsed.pathname,
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
      getConfiguration: vi.fn(() => ({
        get: (key: string, def: unknown) => mockConfigGet(key, def),
        update: (...args: unknown[]) => mockConfigUpdate(...args),
      })),
    },
    commands: {
      executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    EventEmitter,
  };
});

import { FileExplorerTreeProvider, FileExplorerServerItem, FileTreeItem, ParentDirItem } from "../../src/ui/fileExplorerTreeProvider";
import type { DirectoryEntry } from "../../src/services/sftp/sftpService";
import type { ServerConfig } from "../../src/models/config";
import { isSafeEntryName } from "../../src/utils/pathSafety";
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

function missingRemoteError(message = "No such file"): Error & { code: number } {
  return Object.assign(new Error(message), { code: 2 });
}

type LocalKind = "file" | "directory" | "symlink" | "other";

/** node:fs Stats double — only the three type predicates the provider consults. */
function localStat(kind: LocalKind) {
  return {
    isSymbolicLink: () => kind === "symlink",
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
  };
}

/** node:fs Dirent double for `readdir(path, { withFileTypes: true })`. */
function dirent(name: string, kind: LocalKind) {
  return { name, ...localStat(kind) };
}

function uncAccessError(host = "192.168.2.10"): Error & { code: string } {
  return Object.assign(new Error(`UNC host '${host}' access is not allowed`), {
    code: "ERR_UNC_HOST_NOT_ALLOWED",
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("FileExplorerTreeProvider", () => {
  let sftp: ReturnType<typeof createMockSftpService>;
  let provider: FileExplorerTreeProvider;
  let diagnostics: ReturnType<typeof vi.fn>;

  const diagnosticsText = (): string => diagnostics.mock.calls.map((args) => String(args[0])).join("\n");
  const shownMessages = (spy: unknown): string[] =>
    (spy as { mock: { calls: unknown[][] } }).mock.calls.map((args) => String(args[0]));

  beforeEach(async () => {
    sftp = createMockSftpService();
    diagnostics = vi.fn();
    provider = new FileExplorerTreeProvider(sftp, diagnostics);
    const vscode = await import("vscode");
    (vscode.window.showQuickPick as any).mockReset();
    (vscode.window.showErrorMessage as any).mockReset();
    (vscode.window.showWarningMessage as any).mockReset();
    (vscode.window.showInformationMessage as any).mockReset();
    (vscode.window.withProgress as any).mockReset();
    (vscode.window.withProgress as any).mockImplementation(async (_opts: unknown, task: any) => task({ report: vi.fn() }));
    (vscode.workspace.fs.stat as any).mockReset();
    (vscode.workspace.fs.readDirectory as any).mockReset();
    fsPromisesMock.lstat.mockReset();
    fsPromisesMock.readdir.mockReset();
    fsPromisesMock.stat.mockReset();
    fsPromisesMock.stat.mockRejectedValue(uncAccessError());
    mockConfigGet.mockReset();
    mockConfigGet.mockImplementation((_key: string, def: unknown) => def);
    mockConfigUpdate.mockReset();
    mockConfigUpdate.mockResolvedValue(undefined);
    mockExecuteCommand.mockReset();
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

  it("sorts numbered file names in numeric order, not lexicographic", async () => {
    const entries: DirectoryEntry[] = [
      { ...fileEntry, name: "file10.log" },
      { ...fileEntry, name: "file2.log" },
      { ...fileEntry, name: "file1.log" },
    ];
    (sftp.readDirectory as any).mockResolvedValue(entries);

    provider.setActiveServer(testServer, "/home/dev");
    const children = await provider.getChildren();
    const items = children.filter((c) => c instanceof FileTreeItem && c.label !== ".") as FileTreeItem[];

    expect(items.map((i) => i.entry.name)).toEqual(["file1.log", "file2.log", "file10.log"]);
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

  it("file items above max size have no open command", () => {
    const largeFile: DirectoryEntry = { ...fileEntry, size: 10 * 1024 * 1024 };
    const item = new FileTreeItem("srv-1", "/home/dev", largeFile);
    expect(item.contextValue).toBe("nexus.fileExplorer.file");
    expect(item.command).toBeUndefined();
  });

  it("file items with unsafe names do not open the parent path", () => {
    const unsafeFile: DirectoryEntry = { ...fileEntry, name: "../bad.txt" };
    const item = new FileTreeItem("srv-1", "/home/dev", unsafeFile);
    expect(item.contextValue).toBe("nexus.fileExplorer.file");
    expect(item.command).toBeUndefined();
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

  it("stops the previous server watch before switching active servers", () => {
    const secondServer: ServerConfig = { ...testServer, id: "srv-2", name: "Other Server" };

    provider.setActiveServer(testServer, "/home/dev");
    provider.setActiveServer(secondServer, "/srv/other");

    expect(sftp.stopWatching).toHaveBeenCalledWith("srv-1");
    expect(sftp.startWatching).toHaveBeenLastCalledWith("srv-2", "/srv/other", 0);
  });

  it("getHomeDir returns the original home directory", () => {
    provider.setActiveServer(testServer, "/home/dev");
    expect(provider.getHomeDir()).toBe("/home/dev");
    provider.setRootPath("/etc");
    expect(provider.getHomeDir()).toBe("/home/dev");
  });

  describe("setRootPath validation and watcher-restart policy (§5.5)", () => {
    it("rejects a non-normalizable path and leaves currentRootPath unchanged", () => {
      provider.setActiveServer(testServer, "/home/dev");
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      listener.mockClear();

      provider.setRootPath("");
      expect(provider.getRootPath()).toBe("/home/dev");

      provider.setRootPath("relative/path");
      expect(provider.getRootPath()).toBe("/home/dev");

      provider.setRootPath("/has\0null");
      expect(provider.getRootPath()).toBe("/home/dev");

      expect(listener).not.toHaveBeenCalled();
    });

    it("same-path setRootPath still fires the tree refresh but does not restart the watcher", () => {
      provider.setActiveServer(testServer, "/home/dev");
      (sftp.startWatching as any).mockClear();
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      provider.setRootPath("/home/dev");

      expect(listener).toHaveBeenCalled();
      expect(sftp.startWatching).not.toHaveBeenCalled();
    });

    it("a changed path with the default (immediate) restart behavior restarts the watcher right away", () => {
      provider.setActiveServer(testServer, "/home/dev");
      (sftp.startWatching as any).mockClear();

      provider.setRootPath("/etc");

      expect(sftp.startWatching).toHaveBeenCalledWith("srv-1", "/etc", 0);
    });

    it("{ restartWatcher: false } defers the respawn past the 2s debounce and coalesces a burst into one restart", () => {
      vi.useFakeTimers();
      try {
        provider.setActiveServer(testServer, "/home/dev");
        (sftp.startWatching as any).mockClear();

        provider.setRootPath("/var/log", { restartWatcher: false });
        provider.setRootPath("/var/log/app", { restartWatcher: false });
        provider.setRootPath("/etc", { restartWatcher: false });

        // No restart yet — still within the debounce window.
        expect(sftp.startWatching).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1999);
        expect(sftp.startWatching).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(sftp.startWatching).toHaveBeenCalledTimes(1);
        expect(sftp.startWatching).toHaveBeenCalledWith("srv-1", "/etc", 0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not restart the watcher for a deferred restart whose path was superseded before the debounce fired", () => {
      vi.useFakeTimers();
      try {
        provider.setActiveServer(testServer, "/home/dev");
        (sftp.startWatching as any).mockClear();

        provider.setRootPath("/var/log", { restartWatcher: false });
        vi.advanceTimersByTime(1000);
        // An immediate-restart navigation supersedes currentRootPath before the
        // deferred timer fires; the stale timer must not respawn a watch for /var/log.
        provider.setRootPath("/etc");
        (sftp.startWatching as any).mockClear();

        vi.advanceTimersByTime(2000);
        expect(sftp.startWatching).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending deferred watcher restart on clearActiveServer", () => {
      vi.useFakeTimers();
      try {
        provider.setActiveServer(testServer, "/home/dev");
        (sftp.startWatching as any).mockClear();

        provider.setRootPath("/var/log", { restartWatcher: false });
        provider.clearActiveServer();

        vi.advanceTimersByTime(5000);
        expect(sftp.startWatching).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending deferred watcher restart on dispose", () => {
      vi.useFakeTimers();
      try {
        provider.setActiveServer(testServer, "/home/dev");
        (sftp.startWatching as any).mockClear();

        provider.setRootPath("/var/log", { restartWatcher: false });
        provider.dispose();

        vi.advanceTimersByTime(5000);
        expect(sftp.startWatching).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending deferred watcher restart when switching active servers", () => {
      vi.useFakeTimers();
      try {
        const secondServer: ServerConfig = { ...testServer, id: "srv-2", name: "Other Server" };
        provider.setActiveServer(testServer, "/home/dev");
        provider.setRootPath("/var/log", { restartWatcher: false });
        (sftp.startWatching as any).mockClear();

        provider.setActiveServer(secondServer, "/srv/other");
        (sftp.startWatching as any).mockClear();

        vi.advanceTimersByTime(5000);
        expect(sftp.startWatching).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps polling in auto mode when only stat watching is available", async () => {
    vi.useFakeTimers();
    try {
      (sftp.getWatchMode as any).mockReturnValue("stat");

      provider.setViewVisibility(true);
      provider.setAutoRefreshInterval(1);
      const refreshSpy = vi.spyOn(provider, "refresh");

      provider.setActiveServer(testServer, "/home/dev");
      await vi.advanceTimersByTimeAsync(1000);

      expect(refreshSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling as safety net even when auto watch resolves to recursive inotify", async () => {
    vi.useFakeTimers();
    try {
      const watchReady = createDeferred<void>();
      let watchMode: string | undefined;
      (sftp.startWatching as any).mockImplementation(() => watchReady.promise);
      (sftp.getWatchMode as any).mockImplementation(() => watchMode);

      provider.setViewVisibility(true);
      provider.setAutoRefreshInterval(1);
      const refreshSpy = vi.spyOn(provider, "refresh");

      provider.setActiveServer(testServer, "/home/dev");
      await vi.advanceTimersByTimeAsync(1000);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      watchMode = "inotifywait";
      watchReady.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Polling continues as a safety net even with inotifywait active
      await vi.advanceTimersByTimeAsync(1000);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts auto watching when the refresh interval changes", () => {
    provider.setActiveServer(testServer, "/home/dev");
    provider.setAutoRefreshInterval(3);

    expect(sftp.startWatching).toHaveBeenLastCalledWith("srv-1", "/home/dev", 3000);
  });

  it("skips auto-refresh until all pending getChildren calls finish", async () => {
    vi.useFakeTimers();
    try {
      const pendingResolvers: Array<(entries: DirectoryEntry[]) => void> = [];
      (sftp.readDirectory as any).mockImplementation(() => new Promise((resolve) => pendingResolvers.push(resolve)));

      provider.setActiveServer(testServer, "/home/dev");
      provider.setViewVisibility(true);
      provider.setAutoRefreshInterval(1);

      const refreshSpy = vi.spyOn(provider, "refresh");
      const rootPromise = provider.getChildren();
      const childPromise = provider.getChildren(new FileTreeItem("srv-1", "/home/dev", dirEntry));

      await vi.advanceTimersByTimeAsync(1000);
      expect(refreshSpy).not.toHaveBeenCalled();

      pendingResolvers[0]([]);
      await rootPromise;
      await vi.advanceTimersByTimeAsync(1000);
      expect(refreshSpy).not.toHaveBeenCalled();

      pendingResolvers[1]([]);
      await childPromise;
      await vi.advanceTimersByTimeAsync(1000);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("file"));
      (sftp.stat as any).mockRejectedValue(missingRemoteError());
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
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("directory"));
      fsPromisesMock.readdir.mockResolvedValue([dirent("nested.txt", "file")]);
      (sftp.stat as any).mockRejectedValue(missingRemoteError());
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
      fsPromisesMock.lstat.mockResolvedValue(localStat("directory"));
      fsPromisesMock.readdir.mockResolvedValue([dirent("nested", "directory")]);
      (sftp.stat as any).mockRejectedValue(missingRemoteError());
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
      fsPromisesMock.lstat.mockResolvedValue(localStat("directory"));
      fsPromisesMock.readdir.mockResolvedValue([dirent("one.txt", "file"), dirent("two.txt", "file")]);
      (sftp.createDirectory as any).mockResolvedValue(undefined);
      (sftp.stat as any).mockImplementation(async (_serverId: string, remotePath: string) => {
        if (remotePath.endsWith("/mydir")) {
          throw missingRemoteError();
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

    it("handleDrop reports a failed remote destination check as a failure, counted once", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("file"));
      (sftp.stat as any).mockRejectedValue(new Error("permission denied"));

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

      expect(sftp.upload).not.toHaveBeenCalled();
      const errors = shownMessages(vscode.window.showErrorMessage);
      expect(errors.join("\n")).toContain('Failed to check remote path "/home/dev/subdir/local.txt"');
      // A rejecting remote stat is an I/O failure, not a deliberate skip — and
      // the old code counted it in BOTH buckets (once in the resolver, once in
      // the caller's `decision === "skip"` branch).
      expect(errors.join("\n")).toContain("failed 1");
      expect(errors.join("\n")).toContain("skipped 0");
    });

    it("handleDrop reports a failed remote directory check as a failure, not a skip", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("directory"));
      (sftp.stat as any).mockRejectedValue(new Error("connection reset"));

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/mydir");

      await provider.handleDrop(targetDir, {
        get: (mime: string) => (mime === "text/uri-list" ? uriListItem : undefined),
      } as any);

      const errors = shownMessages(vscode.window.showErrorMessage);
      expect(errors.join("\n")).toContain('Failed to check remote directory "/home/dev/subdir/mydir"');
      expect(errors.join("\n")).toContain("failed 1");
      // "Upload completed with skips" for a server that never answered is the
      // same lie this PR exists to remove.
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it("handleDrop reports a failed remote mkdir as a failure, not a skip", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("directory"));
      (sftp.stat as any).mockRejectedValue(missingRemoteError());
      (sftp.createDirectory as any).mockRejectedValue(new Error("read-only file system"));

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/mydir");

      await provider.handleDrop(targetDir, {
        get: (mime: string) => (mime === "text/uri-list" ? uriListItem : undefined),
      } as any);

      const errors = shownMessages(vscode.window.showErrorMessage);
      expect(errors.join("\n")).toContain('Failed to create remote directory "/home/dev/subdir/mydir"');
      expect(errors.join("\n")).toContain("failed 1");
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
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

  describe("external drop: honest reporting and UNC sources (S1)", () => {
    async function dropUriList(payload: string): Promise<void> {
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem(payload);
      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      await provider.handleDrop(targetDir, {
        get: (mime: string) => (mime === "text/uri-list" ? uriListItem : undefined),
      } as any);
    }

    it("T19 — a UNC-sourced drop is actually uploaded (the S1 regression test)", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      // Any implementation still consulting workspace.fs stays red: this is the
      // laundered error VS Code hands extensions for a blocked UNC host.
      (vscode.workspace.fs.stat as any).mockRejectedValue(
        Object.assign(new Error("UNC host 'fileserver' access is not allowed"), { code: "Unknown" })
      );
      fsPromisesMock.lstat.mockResolvedValue(localStat("file"));
      (sftp.tryStat as any).mockResolvedValue(undefined);
      (sftp.upload as any).mockResolvedValue(undefined);

      await dropUriList("file://fileserver/share/file.txt");

      expect(sftp.upload).toHaveBeenCalledWith("srv-1", "//fileserver/share/file.txt", "/home/dev/subdir/file.txt");
      expect(shownMessages(vscode.window.showInformationMessage).join("\n")).toContain("uploaded 1");
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    // SCOPE: T20 asserts a property of node:path, not of this provider — it is a
    // documentation test for design decision D8 and would stay green through any
    // change to the drop path. T19's remote-destination assertion is what
    // actually covers the behaviour.
    it("T20 — a UNC basename resolves to the entry name alone and passes the safety guard", async () => {
      const nodePath = await import("node:path");
      // Documents D8: the host's platform-default basename IS win32 on Windows,
      // so a UNC path was never the rejection site. Forcing path.win32 globally
      // would mis-split legitimate backslash-bearing names on Linux hosts.
      expect(nodePath.win32.basename("\\\\server\\share\\file.txt")).toBe("file.txt");
      expect(isSafeEntryName(nodePath.win32.basename("\\\\server\\share\\file.txt"))).toBe(true);
    });

    it("T21 — a blocked UNC source produces the actionable message, not a silent skip", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockRejectedValue(uncAccessError("192.168.2.10"));

      await dropUriList("file://192.168.2.10/share/file.txt");

      const errors = shownMessages(vscode.window.showErrorMessage);
      expect(errors.join("\n")).toContain("failed 1");
      expect(errors.join("\n")).toContain('VS Code blocked access to network host "192.168.2.10"');
      // The security setting is NEVER written without the modal consent, which
      // was not given here (the toast mock resolves undefined = dismissed).
      expect(mockConfigUpdate).not.toHaveBeenCalled();
      expect(diagnosticsText()).toContain("192.168.2.10");
      expect(sftp.upload).not.toHaveBeenCalled();
    });

    it("T21b — one blocked host spelled two ways prompts once, using the spelling first seen", async () => {
      const vscode = await import("vscode");
      const { DataTransferItem } = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockRejectedValue(uncAccessError("NAS"));

      // Deliberately NOT the uri-list route: `Uri.parse` runs through `URL`,
      // which lower-cases the authority and would make the two spellings
      // identical before the provider ever sees them — a fixture in which the
      // broken and the fixed implementation produce the same state. File items
      // carry their fsPath verbatim, which is what a Windows Explorer drag does.
      const fileItem = (fsPath: string) =>
        new DataTransferItem("", { uri: { scheme: "file", authority: "", path: fsPath, fsPath } } as any);
      const items = [fileItem("//NAS/share/a.txt"), fileItem("//nas/share/b.txt")];

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      await provider.handleDrop(targetDir, {
        get: () => undefined,
        forEach: (fn: (item: unknown) => void) => { for (const item of items) { fn(item); } },
      } as any);

      // Both spellings reached the provider…
      expect(fsPromisesMock.lstat).toHaveBeenCalledTimes(2);
      // …but Windows treats them as one host, so one consent flow, not two.
      const remediationPrompts = (vscode.window.showErrorMessage as any).mock.calls.filter(
        (args: unknown[]) => typeof args[0] === "string" && args[0].includes("blocked access to network host")
      );
      expect(remediationPrompts).toHaveLength(1);
      expect(remediationPrompts[0][0]).toContain('"NAS"');
    });

    it("T22 — a drop whose file items carry no URI is never a silent no-op", async () => {
      const vscode = await import("vscode");
      const { DataTransferItem } = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");

      // The usual shape for drags originating outside VS Code.
      const filesItem = new DataTransferItem("", { uri: undefined });
      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      await provider.handleDrop(targetDir, {
        get: (mime: string) => (mime === "files" ? filesItem : undefined),
      } as any);

      expect(shownMessages(vscode.window.showWarningMessage).join("\n")).toContain(
        "did not include usable local file paths"
      );
      expect(sftp.upload).not.toHaveBeenCalled();
    });

    it("T23 — an unreadable local item is reported, not silently skipped", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

      await dropUriList("file:///tmp/locked.txt");

      const errors = shownMessages(vscode.window.showErrorMessage);
      expect(errors.join("\n")).toContain('Cannot read local item "locked.txt"');
      expect(errors.join("\n")).toContain("failed 1");
      expect(sftp.upload).not.toHaveBeenCalled();
    });

    it("T24 — an unreadable local directory is reported, not silently skipped", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("directory"));
      fsPromisesMock.readdir.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      (sftp.tryStat as any).mockResolvedValue(undefined);
      (sftp.createDirectory as any).mockResolvedValue(undefined);

      await dropUriList("file:///tmp/locked");

      const errors = shownMessages(vscode.window.showErrorMessage);
      expect(errors.join("\n")).toContain('Cannot read local directory "locked"');
      expect(errors.join("\n")).toContain("failed 1");
    });

    it("T25 — a failed upload counts as failed and the summary is an error, not a 'completed with skips' warning", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("file"));
      (sftp.tryStat as any).mockResolvedValue(undefined);
      (sftp.upload as any).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

      await dropUriList("file:///tmp/local.txt");

      const errors = shownMessages(vscode.window.showErrorMessage);
      expect(errors.join("\n")).toContain('Failed to upload "local.txt"');
      expect(errors.join("\n")).toContain("uploaded 0");
      expect(errors.join("\n")).toContain("failed 1");
      // The old code counted this as `skipped` and showed a warning that read
      // like a partial success.
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("T26 — a malformed uri-list payload is counted and reported", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");

      await dropUriList("::not a uri::");

      expect(shownMessages(vscode.window.showWarningMessage).join("\n")).toContain(
        "did not include usable local file paths"
      );
      expect(sftp.upload).not.toHaveBeenCalled();
    });

    it("T27 — a skipped symlink is logged with its reason and counted", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("directory"));
      fsPromisesMock.readdir.mockResolvedValue([dirent("link", "symlink"), dirent("real.txt", "file")]);
      (sftp.tryStat as any).mockResolvedValue(undefined);
      (sftp.createDirectory as any).mockResolvedValue(undefined);
      (sftp.upload as any).mockResolvedValue(undefined);

      await dropUriList("file:///tmp/mydir");

      expect(diagnosticsText()).toContain("/tmp/mydir/link");
      expect(diagnosticsText()).toContain("symbolic link");
      expect(shownMessages(vscode.window.showWarningMessage).join("\n")).toContain("skipped 1");
      expect(sftp.upload).toHaveBeenCalledWith("srv-1", "/tmp/mydir/real.txt", "/home/dev/subdir/mydir/real.txt");
    });

    it("a dropped path with no usable entry name is skipped with a warning, not silently", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");

      // basename("/") === "" — isSafeEntryName rejects it; the old code took
      // this branch with no message at all.
      await dropUriList("file:///");

      expect(shownMessages(vscode.window.showWarningMessage).join("\n")).toContain(
        "name contains unsupported characters"
      );
      expect(sftp.upload).not.toHaveBeenCalled();
    });
  });

  describe("isBusy / beginBusy (§5.1, §7.4)", () => {
    it("is false with no active requests or uploads", () => {
      expect(provider.isBusy()).toBe(false);
    });

    it("is true while getChildren has a pending request and false again once it resolves", async () => {
      const deferred = createDeferred<DirectoryEntry[]>();
      (sftp.readDirectory as any).mockImplementation(() => deferred.promise);
      provider.setActiveServer(testServer, "/home/dev");

      const childrenPromise = provider.getChildren();
      expect(provider.isBusy()).toBe(true);

      deferred.resolve([]);
      await childrenPromise;
      expect(provider.isBusy()).toBe(false);
    });

    it("beginBusy()'s disposer is idempotent — calling it twice does not under-count", () => {
      const release = provider.beginBusy();
      expect(provider.isBusy()).toBe(true);
      release();
      expect(provider.isBusy()).toBe(false);
      release();
      expect(provider.isBusy()).toBe(false);
    });

    it("is true during an in-flight external-drop upload and false after it completes", async () => {
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("file"));
      (sftp.stat as any).mockRejectedValue(missingRemoteError());
      const deferred = createDeferred<void>();
      (sftp.upload as any).mockImplementation(() => deferred.promise);

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/local.txt");
      const mockTransfer = {
        get: (mime: string) => (mime === "text/uri-list" ? uriListItem : undefined),
      };

      expect(provider.isBusy()).toBe(false);
      const dropPromise = provider.handleDrop(targetDir, mockTransfer as any);
      expect(provider.isBusy()).toBe(true);

      deferred.resolve();
      await dropPromise;
      expect(provider.isBusy()).toBe(false);
    });

    it("releases the busy span even when the external-drop upload throws", async () => {
      const vscode = await import("vscode");
      provider.setActiveServer(testServer, "/home/dev");
      fsPromisesMock.lstat.mockResolvedValue(localStat("file"));
      (vscode.window.withProgress as any).mockRejectedValueOnce(new Error("boom"));

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const { DataTransferItem } = await import("vscode");
      const uriListItem = new DataTransferItem("file:///tmp/local.txt");
      const mockTransfer = {
        get: (mime: string) => (mime === "text/uri-list" ? uriListItem : undefined),
      };

      await expect(provider.handleDrop(targetDir, mockTransfer as any)).rejects.toThrow("boom");
      expect(provider.isBusy()).toBe(false);
    });

    it("is true during an in-flight internal move/copy and false after it completes", async () => {
      const vscode = await import("vscode");
      (vscode.window.showQuickPick as any).mockResolvedValue({ label: "Move", value: "move" });
      const deferred = createDeferred<void>();
      (sftp.rename as any).mockImplementation(() => deferred.promise);
      provider.setActiveServer(testServer, "/home/dev");

      const targetDir = new FileTreeItem("srv-1", "/home/dev", dirEntry);
      const payload = JSON.stringify([
        { serverId: "srv-1", remotePath: "/home/dev", name: "file.txt", isDirectory: false },
      ]);
      const { DataTransferItem } = await import("vscode");
      const transferItem = new DataTransferItem(payload);
      const mockTransfer = {
        get: (mime: string) => (mime === "application/vnd.nexus.fileitem" ? transferItem : undefined),
      };

      expect(provider.isBusy()).toBe(false);
      const dropPromise = provider.handleDrop(targetDir, mockTransfer as any);
      // Let the QuickPick microtask resolve before asserting the busy state.
      await Promise.resolve();
      await Promise.resolve();
      expect(provider.isBusy()).toBe(true);

      deferred.resolve();
      await dropPromise;
      expect(provider.isBusy()).toBe(false);
    });
  });

  describe("onDidChangeBusy (busy -> idle signal, issue #35 bug 1)", () => {
    it("fires once when getChildren's pending request resolves and the explorer goes idle", async () => {
      const deferred = createDeferred<DirectoryEntry[]>();
      (sftp.readDirectory as any).mockImplementation(() => deferred.promise);
      provider.setActiveServer(testServer, "/home/dev");

      const listener = vi.fn();
      provider.onDidChangeBusy(listener);

      const childrenPromise = provider.getChildren();
      expect(listener).not.toHaveBeenCalled(); // becoming busy must not fire the idle signal

      deferred.resolve([]);
      await childrenPromise;

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("fires once when beginBusy()'s disposer releases the last outstanding span", () => {
      const listener = vi.fn();
      provider.onDidChangeBusy(listener);

      const release = provider.beginBusy();
      expect(listener).not.toHaveBeenCalled();

      release();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does not fire again when the disposer is called a second time (idempotent release)", () => {
      const listener = vi.fn();
      provider.onDidChangeBusy(listener);

      const release = provider.beginBusy();
      release();
      expect(listener).toHaveBeenCalledTimes(1);
      release();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does not fire when one of two overlapping busy spans ends but the explorer is still busy", () => {
      const listener = vi.fn();
      provider.onDidChangeBusy(listener);

      const releaseA = provider.beginBusy();
      const releaseB = provider.beginBusy();
      releaseA();
      expect(provider.isBusy()).toBe(true);
      expect(listener).not.toHaveBeenCalled();

      releaseB();
      expect(provider.isBusy()).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe stops further notifications", () => {
      const listener = vi.fn();
      const unsubscribe = provider.onDidChangeBusy(listener);

      const release = provider.beginBusy();
      unsubscribe();
      release();

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
