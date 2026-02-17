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
    Uri: {
      from: vi.fn((components: { scheme: string; authority: string; path: string }) => ({
        scheme: components.scheme,
        authority: components.authority,
        path: components.path,
      })),
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 2, Created: 1, Deleted: 3 },
    FilePermission: { Readonly: 1 },
    FileSystemError: {
      Unavailable: (msg: string) => new Error(msg),
    },
    Disposable: class { constructor(private cb: () => void) {} dispose() { this.cb(); } },
    EventEmitter,
  };
});

import { NexusFileSystemProvider, buildUri, NEXTERM_SCHEME } from "../../src/services/sftp/nexusFileSystemProvider";
import type { SftpService, DirectoryEntry } from "../../src/services/sftp/sftpService";

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

const fileEntry: DirectoryEntry = {
  name: "test.txt",
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

describe("NexusFileSystemProvider", () => {
  let sftp: ReturnType<typeof createMockSftpService>;
  let provider: NexusFileSystemProvider;

  beforeEach(() => {
    sftp = createMockSftpService();
    provider = new NexusFileSystemProvider(sftp);
  });

  it("buildUri creates correct nexterm:// URI", () => {
    const uri = buildUri("srv-1", "/home/dev/file.txt");
    expect(uri.scheme).toBe(NEXTERM_SCHEME);
    expect(uri.authority).toBe("srv-1");
    expect(uri.path).toBe("/home/dev/file.txt");
  });

  it("stat returns FileStat for files", async () => {
    (sftp.stat as any).mockResolvedValue(fileEntry);

    const uri = buildUri("srv-1", "/home/dev/test.txt");
    const stat = await provider.stat(uri);

    expect(stat.size).toBe(1024);
    expect(stat.mtime).toBe(1700000000 * 1000);
    // FileType.File = 1
    expect(stat.type).toBe(1);
  });

  it("stat returns FileStat for directories", async () => {
    (sftp.stat as any).mockResolvedValue(dirEntry);

    const uri = buildUri("srv-1", "/home/dev/subdir");
    const stat = await provider.stat(uri);

    // FileType.Directory = 2
    expect(stat.type).toBe(2);
  });

  it("stat marks readonly files", async () => {
    const readonlyEntry: DirectoryEntry = { ...fileEntry, permissions: 0o444 };
    (sftp.stat as any).mockResolvedValue(readonlyEntry);

    const uri = buildUri("srv-1", "/home/dev/readonly.txt");
    const stat = await provider.stat(uri);

    // FilePermission.Readonly = 1
    expect(stat.permissions).toBe(1);
  });

  it("readDirectory returns name-type pairs", async () => {
    (sftp.readDirectory as any).mockResolvedValue([fileEntry, dirEntry]);

    const uri = buildUri("srv-1", "/home/dev");
    const result = await provider.readDirectory(uri);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(["test.txt", 1]); // FileType.File
    expect(result[1]).toEqual(["subdir", 2]); // FileType.Directory
  });

  it("readFile checks size limit and returns content", async () => {
    (sftp.stat as any).mockResolvedValue(fileEntry);
    const content = Buffer.from("hello world");
    (sftp.readFile as any).mockResolvedValue(content);

    const uri = buildUri("srv-1", "/home/dev/test.txt");
    const result = await provider.readFile(uri);

    expect(result).toEqual(content);
  });

  it("readFile rejects files over 50MB", async () => {
    const largeEntry: DirectoryEntry = { ...fileEntry, size: 60 * 1024 * 1024 };
    (sftp.stat as any).mockResolvedValue(largeEntry);

    const uri = buildUri("srv-1", "/home/dev/large.bin");
    await expect(provider.readFile(uri)).rejects.toThrow(/too large/i);
  });

  it("writeFile delegates and fires change event", async () => {
    (sftp.writeFile as any).mockResolvedValue(undefined);

    const events: any[] = [];
    provider.onDidChangeFile((e) => events.push(...e));

    const uri = buildUri("srv-1", "/home/dev/test.txt");
    await provider.writeFile(uri, new Uint8Array([1, 2, 3]));

    expect(sftp.writeFile).toHaveBeenCalledWith("srv-1", "/home/dev/test.txt", expect.any(Buffer));
    expect(events).toHaveLength(1);
    // FileChangeType.Changed = 2
    expect(events[0].type).toBe(2);
  });

  it("delete delegates and fires delete event", async () => {
    (sftp.stat as any).mockResolvedValue(fileEntry);
    (sftp.delete as any).mockResolvedValue(undefined);

    const events: any[] = [];
    provider.onDidChangeFile((e) => events.push(...e));

    const uri = buildUri("srv-1", "/home/dev/test.txt");
    await provider.delete(uri, { recursive: false });

    expect(sftp.delete).toHaveBeenCalledWith("srv-1", "/home/dev/test.txt", false);
    // FileChangeType.Deleted = 3
    expect(events[0].type).toBe(3);
  });

  it("rename delegates and fires events for old and new URIs", async () => {
    (sftp.rename as any).mockResolvedValue(undefined);

    const events: any[] = [];
    provider.onDidChangeFile((e) => events.push(...e));

    const oldUri = buildUri("srv-1", "/home/dev/old.txt");
    const newUri = buildUri("srv-1", "/home/dev/new.txt");
    await provider.rename(oldUri, newUri);

    expect(sftp.rename).toHaveBeenCalledWith("srv-1", "/home/dev/old.txt", "/home/dev/new.txt");
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(3); // Deleted
    expect(events[1].type).toBe(1); // Created
  });

  it("createDirectory delegates and fires create event", async () => {
    (sftp.createDirectory as any).mockResolvedValue(undefined);

    const events: any[] = [];
    provider.onDidChangeFile((e) => events.push(...e));

    const uri = buildUri("srv-1", "/home/dev/newdir");
    await provider.createDirectory(uri);

    expect(sftp.createDirectory).toHaveBeenCalledWith("srv-1", "/home/dev/newdir");
    expect(events[0].type).toBe(1); // Created
  });

  it("watch returns a no-op disposable", () => {
    const uri = buildUri("srv-1", "/home");
    const disposable = provider.watch(uri);
    expect(disposable).toBeDefined();
    expect(() => disposable.dispose()).not.toThrow();
  });
});
