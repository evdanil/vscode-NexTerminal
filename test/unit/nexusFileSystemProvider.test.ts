import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(function () {
    const listeners: Array<(e: unknown) => void> = [];
    return {
      event: (listener: (e: unknown) => void) => { listeners.push(listener); },
      fire: (e: unknown) => { for (const l of listeners) { l(e); } },
      _listeners: listeners
    };
  });
  // toString() matters here: NexusFileSystemProvider keys its elevated/declined
  // URI sets on uri.toString(). A real vscode.Uri stringifies distinctly per URI;
  // without this the mock would collapse every URI to the same "[object Object]"
  // key and elevation state would leak across unrelated files.
  return {
    Uri: {
      from: vi.fn((components: { scheme: string; authority: string; path: string }) => ({
        scheme: components.scheme,
        authority: components.authority,
        path: components.path,
        fsPath: components.path,
        toString: () => `${components.scheme}://${components.authority}${components.path}`,
      })),
      file: vi.fn((filePath: string) => ({
        scheme: "file",
        authority: "",
        path: filePath,
        fsPath: filePath,
        toString: () => `file://${filePath}`,
      })),
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
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 2, Created: 1, Deleted: 3 },
    FilePermission: { Readonly: 1 },
    FileSystemError: {
      Unavailable: (msg: string) => new Error(msg),
      NoPermissions: (msg: string) => new Error(msg),
      FileExists: (msg: string) => new Error(msg),
    },
    workspace: {
      fs: {
        stat: vi.fn(),
        createDirectory: vi.fn(),
        delete: vi.fn(),
      },
      getConfiguration: vi.fn(() => ({ get: (_key: string, def: unknown) => def })),
      onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
    Disposable: class { constructor(private cb: () => void) {} dispose() { this.cb(); } },
    EventEmitter,
  };
});

import { NexusFileSystemProvider, buildUri, NEXTERM_SCHEME } from "../../src/services/sftp/nexusFileSystemProvider";
import type { DirectoryEntry } from "../../src/services/sftp/sftpService";
import { SftpService } from "../../src/services/sftp/sftpService";
import type { SshConnection, SshFactory } from "../../src/services/ssh/contracts";
import { createMockSftpService } from "../helpers/mockSftpService";
import type { ServerConfig } from "../../src/models/config";

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

function missingRemoteError(message = "No such file"): Error & { code: number } {
  return Object.assign(new Error(message), { code: 2 });
}

function permissionDeniedError(message = "Permission denied"): Error & { code: number } {
  return Object.assign(new Error(message), { code: 3 }); // SSH_FX_PERMISSION_DENIED
}

function createMockSftp() {
  return {
    readdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    realpath: vi.fn(),
    fastGet: vi.fn(),
    fastPut: vi.fn(),
    end: vi.fn(),
  };
}

function createMockConnection(sftp: ReturnType<typeof createMockSftp>): SshConnection {
  return {
    openShell: vi.fn(),
    openDirectTcp: vi.fn(),
    openSftp: vi.fn(async () => sftp as any),
    exec: vi.fn(),
    requestForwardIn: vi.fn(),
    cancelForwardIn: vi.fn(),
    onTcpConnection: vi.fn().mockReturnValue(() => {}),
    onClose: vi.fn().mockReturnValue(() => {}),
    getBanner: vi.fn().mockReturnValue(undefined),
    dispose: vi.fn(),
  };
}

function createMockFactory(connection: SshConnection): SshFactory {
  return {
    connect: vi.fn(async () => connection),
  };
}

describe("NexusFileSystemProvider", () => {
  let sftp: ReturnType<typeof createMockSftpService>;
  let provider: NexusFileSystemProvider;

  beforeEach(async () => {
    sftp = createMockSftpService();
    provider = new NexusFileSystemProvider(sftp);
    const vscode = await import("vscode");
    (vscode.workspace.fs.stat as any).mockReset();
    (vscode.workspace.fs.createDirectory as any).mockReset();
    (vscode.workspace.fs.delete as any).mockReset();
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

  it("readFile rejects files over configured max size", async () => {
    const largeEntry: DirectoryEntry = { ...fileEntry, size: 6 * 1024 * 1024 };
    (sftp.stat as any).mockResolvedValue(largeEntry);

    const uri = buildUri("srv-1", "/home/dev/large.bin");
    await expect(provider.readFile(uri)).rejects.toThrow(/too large/i);
  });

  it("readFile respects custom maxOpenFileSizeMB setting", async () => {
    const vscode = await import("vscode");
    (vscode.workspace.getConfiguration as any).mockReturnValue({ get: (_key: string, _def: unknown) => 10 });

    const entry7MB: DirectoryEntry = { ...fileEntry, size: 7 * 1024 * 1024 };
    (sftp.stat as any).mockResolvedValue(entry7MB);
    const content = Buffer.from("ok");
    (sftp.readFile as any).mockResolvedValue(content);

    const uri = buildUri("srv-1", "/home/dev/medium.bin");
    const result = await provider.readFile(uri);
    expect(result).toEqual(content);

    // Restore default mock
    (vscode.workspace.getConfiguration as any).mockReturnValue({ get: (_key: string, def: unknown) => def });
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

  describe("elevated (sudo) saves", () => {
    let broker: { confirmElevation: ReturnType<typeof vi.fn>; saveElevated: ReturnType<typeof vi.fn> };
    let providerWithBroker: NexusFileSystemProvider;

    beforeEach(() => {
      broker = {
        confirmElevation: vi.fn(async () => true),
        saveElevated: vi.fn(async () => true),
      };
      providerWithBroker = new NexusFileSystemProvider(sftp, broker);
    });

    it("stat drops the readonly permission for URIs marked elevated", async () => {
      const readonlyEntry: DirectoryEntry = { ...fileEntry, permissions: 0o444 };
      (sftp.stat as any).mockResolvedValue(readonlyEntry);
      const uri = buildUri("srv-1", "/etc/readonly.conf");

      providerWithBroker.markElevated(uri);
      const stat = await providerWithBroker.stat(uri);

      expect(stat.permissions).toBeUndefined();
    });

    it("markElevated fires a Changed event so an already-open readonly editor re-resolves", () => {
      const events: any[] = [];
      providerWithBroker.onDidChangeFile((e) => events.push(...e));
      const uri = buildUri("srv-1", "/etc/readonly.conf");

      providerWithBroker.markElevated(uri);

      expect(events).toEqual([{ type: 2, uri }]); // FileChangeType.Changed = 2
    });

    it("writeFile offers elevation when the plain save is denied", async () => {
      (sftp.writeFile as any).mockRejectedValue(permissionDeniedError());
      const uri = buildUri("srv-1", "/etc/hosts");

      await providerWithBroker.writeFile(uri, new Uint8Array([1]));

      expect(broker.confirmElevation).toHaveBeenCalledWith("/etc/hosts");
      expect(broker.saveElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer));
      expect(providerWithBroker.isElevated(uri)).toBe(true);
    });

    it("writeFile's elevated branch fires a Changed event on success, like the normal branch", async () => {
      (sftp.writeFile as any).mockRejectedValue(permissionDeniedError());
      const events: any[] = [];
      providerWithBroker.onDidChangeFile((e) => events.push(...e));
      const uri = buildUri("srv-1", "/etc/hosts");

      await providerWithBroker.writeFile(uri, new Uint8Array([1]));

      // One Changed from markElevated (re-resolve trigger), one from the successful save.
      expect(events.filter((e) => e.type === 2)).toHaveLength(2);
    });

    it("writeFile rethrows NoPermissions when the user declines elevation", async () => {
      (sftp.writeFile as any).mockRejectedValue(permissionDeniedError());
      broker.confirmElevation.mockResolvedValue(false);
      const uri = buildUri("srv-1", "/etc/hosts");

      await expect(providerWithBroker.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();

      expect(broker.saveElevated).not.toHaveBeenCalled();
      expect(providerWithBroker.isElevated(uri)).toBe(false);
    });

    it("writeFile goes straight to the elevated path for an elevated URI", async () => {
      const uri = buildUri("srv-1", "/etc/hosts");
      providerWithBroker.markElevated(uri);

      await providerWithBroker.writeFile(uri, new Uint8Array([1]));

      expect(sftp.writeFile).not.toHaveBeenCalled();
      expect(broker.saveElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer));
    });

    it("writeFile keeps its original behaviour when no ElevationBroker is injected", async () => {
      const deniedError = permissionDeniedError();
      (sftp.writeFile as any).mockRejectedValue(deniedError);
      const uri = buildUri("srv-1", "/etc/hosts");

      // `provider` (outer beforeEach) was constructed with no broker argument.
      await expect(provider.writeFile(uri, new Uint8Array([1]))).rejects.toBe(deniedError);
    });

    it("does not offer elevation for non-permission-denied errors", async () => {
      (sftp.writeFile as any).mockRejectedValue(new Error("ECONNRESET"));
      const uri = buildUri("srv-1", "/etc/hosts");

      await expect(providerWithBroker.writeFile(uri, new Uint8Array([1]))).rejects.toThrow("ECONNRESET");
      expect(broker.confirmElevation).not.toHaveBeenCalled();
    });

    it("prompts exactly once across repeated denied saves after a decline (autosave storm)", async () => {
      (sftp.writeFile as any).mockRejectedValue(permissionDeniedError());
      broker.confirmElevation.mockResolvedValue(false);
      const uri = buildUri("srv-1", "/etc/hosts");

      await expect(providerWithBroker.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();
      await expect(providerWithBroker.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();
      await expect(providerWithBroker.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();

      expect(broker.confirmElevation).toHaveBeenCalledTimes(1);
    });

    it("editAsRoot (markElevated) re-arms the offer after a decline", async () => {
      (sftp.writeFile as any).mockRejectedValue(permissionDeniedError());
      broker.confirmElevation.mockResolvedValue(false);
      const uri = buildUri("srv-1", "/etc/hosts");

      await expect(providerWithBroker.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();
      expect(broker.confirmElevation).toHaveBeenCalledTimes(1);

      // Simulates the nexus.files.editAsRoot command handler.
      providerWithBroker.markElevated(uri);
      await providerWithBroker.writeFile(uri, new Uint8Array([1]));
      expect(broker.saveElevated).toHaveBeenCalledWith("srv-1", "/etc/hosts", expect.any(Buffer));
      expect(broker.confirmElevation).toHaveBeenCalledTimes(1); // straight to elevated path, no re-prompt

      // Proves decline memory was actually reset (not just bypassed while elevated):
      // clear elevation, deny again, and the offer must reappear.
      providerWithBroker.clearElevated(uri);
      (sftp.writeFile as any).mockRejectedValue(permissionDeniedError());
      await expect(providerWithBroker.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();
      expect(broker.confirmElevation).toHaveBeenCalledTimes(2);
    });

    it("clearElevated stops routing writeFile through the elevated path", async () => {
      (sftp.writeFile as any).mockResolvedValue(undefined);
      const uri = buildUri("srv-1", "/etc/hosts");
      providerWithBroker.markElevated(uri);
      providerWithBroker.clearElevated(uri);

      await providerWithBroker.writeFile(uri, new Uint8Array([1]));

      expect(sftp.writeFile).toHaveBeenCalled();
      expect(broker.saveElevated).not.toHaveBeenCalled();
    });

    it("closing the document clears decline memory", async () => {
      const vscode = await import("vscode");
      let closeHandler: ((doc: { uri: { scheme: string; toString(): string } }) => void) | undefined;
      (vscode.workspace.onDidCloseTextDocument as any).mockImplementationOnce((cb: any) => {
        closeHandler = cb;
        return { dispose: vi.fn() };
      });
      const p = new NexusFileSystemProvider(sftp, broker);
      (sftp.writeFile as any).mockRejectedValue(permissionDeniedError());
      broker.confirmElevation.mockResolvedValue(false);
      const uri = buildUri("srv-1", "/etc/hosts");

      await expect(p.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();
      expect(broker.confirmElevation).toHaveBeenCalledTimes(1);

      closeHandler!({ uri: { scheme: NEXTERM_SCHEME, toString: () => uri.toString() } });

      await expect(p.writeFile(uri, new Uint8Array([1]))).rejects.toThrow();
      expect(broker.confirmElevation).toHaveBeenCalledTimes(2);
    });

    it("dispose() cleans up the onDidCloseTextDocument subscription", async () => {
      const vscode = await import("vscode");
      const disposeSpy = vi.fn();
      (vscode.workspace.onDidCloseTextDocument as any).mockReturnValueOnce({ dispose: disposeSpy });
      const p = new NexusFileSystemProvider(sftp, broker);

      p.dispose();

      expect(disposeSpy).toHaveBeenCalled();
    });
  });

  it("delete uses lstat and fires delete event", async () => {
    (sftp.lstat as any).mockResolvedValue(fileEntry);
    (sftp.delete as any).mockResolvedValue(undefined);

    const events: any[] = [];
    provider.onDidChangeFile((e) => events.push(...e));

    const uri = buildUri("srv-1", "/home/dev/test.txt");
    await provider.delete(uri, { recursive: false });

    expect(sftp.lstat).toHaveBeenCalledWith("srv-1", "/home/dev/test.txt");
    expect(sftp.delete).toHaveBeenCalledWith("srv-1", "/home/dev/test.txt", { recursive: false });
    // FileChangeType.Deleted = 3
    expect(events[0].type).toBe(3);
  });

  it("delete symlinks via unlink, never recurse into targets", async () => {
    const symlinkDir: DirectoryEntry = { ...dirEntry, isSymlink: true };
    (sftp.lstat as any).mockResolvedValue(symlinkDir);
    (sftp.delete as any).mockResolvedValue(undefined);

    const uri = buildUri("srv-1", "/home/dev/link");
    await provider.delete(uri, { recursive: true });

    // Should delete as file (not directory), even though target is a directory
    expect(sftp.delete).toHaveBeenCalledWith("srv-1", "/home/dev/link", { recursive: true });
  });

  it("delete rejects non-recursive directory delete", async () => {
    (sftp.lstat as any).mockResolvedValue(dirEntry);

    const uri = buildUri("srv-1", "/home/dev/subdir");
    await expect(provider.delete(uri, { recursive: false })).rejects.toThrow(/not empty/i);
  });

  it("delete forwards recursive option through to SFTP service", async () => {
    (sftp.lstat as any).mockResolvedValue(fileEntry);
    (sftp.delete as any).mockResolvedValue(undefined);

    const uri = buildUri("srv-1", "/home/dev/test.txt");
    await provider.delete(uri, { recursive: false });

    expect(sftp.delete).toHaveBeenCalledWith("srv-1", "/home/dev/test.txt", { recursive: false });
  });

  it("delete rejects when provider-observed file became directory before service recursive check", async () => {
    const sftpWrapper = createMockSftp();
    const connection = createMockConnection(sftpWrapper);
    const factory = createMockFactory(connection);
    const service = new SftpService(factory);
    await service.connect(testServer);

    let lstatCalls = 0;
    sftpWrapper.lstat.mockImplementation((remotePath: string, cb: Function) => {
      lstatCalls += 1;
      if (remotePath === "/home/dev/race") {
        if (lstatCalls === 1) {
          cb(null, { mode: 0o100644, size: 64, mtime: 1700000000 });
          return;
        }
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(new Error(`unexpected path ${remotePath}`));
    });
    sftpWrapper.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, []);
    });
    sftpWrapper.rmdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });
    sftpWrapper.unlink.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    const providerWithService = new NexusFileSystemProvider(service);
    const uri = buildUri("srv-1", "/home/dev/race");

    await expect(providerWithService.delete(uri, { recursive: false })).rejects.toThrow(/not empty/i);

    expect(sftpWrapper.lstat).toHaveBeenCalledTimes(2);
    expect(sftpWrapper.rmdir).not.toHaveBeenCalled();
    expect(sftpWrapper.unlink).not.toHaveBeenCalled();
    expect(sftpWrapper.readdir).not.toHaveBeenCalled();

    service.disconnect("srv-1");
  });

  it("rename rejects cross-server operations", async () => {
    const oldUri = buildUri("srv-1", "/home/dev/old.txt");
    const newUri = buildUri("srv-2", "/home/dev/new.txt");
    await expect(provider.rename(oldUri, newUri)).rejects.toThrow(/across servers/i);
  });

  it("readFile passes maxSize to sftp service", async () => {
    (sftp.stat as any).mockResolvedValue(fileEntry);
    const content = Buffer.from("hello world");
    (sftp.readFile as any).mockResolvedValue(content);

    const uri = buildUri("srv-1", "/home/dev/test.txt");
    await provider.readFile(uri);

    // readFile should be called with maxSize = default 5MB
    expect(sftp.readFile).toHaveBeenCalledWith("srv-1", "/home/dev/test.txt", 5 * 1024 * 1024);
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

  it("copy delegates nexterm->nexterm to copyRemote", async () => {
    (sftp.lstat as any).mockImplementation(async (_serverId: string, remotePath: string) => {
      if (remotePath === "/home/dev/a.txt") {
        return fileEntry;
      }
      throw missingRemoteError();
    });
    (sftp.copyRemote as any).mockResolvedValue(undefined);

    const events: any[] = [];
    provider.onDidChangeFile((e) => events.push(...e));

    const source = buildUri("srv-1", "/home/dev/a.txt");
    const destination = buildUri("srv-1", "/home/dev/b.txt");
    await provider.copy(source, destination, { overwrite: false });

    expect(sftp.copyRemote).toHaveBeenCalledWith("srv-1", "/home/dev/a.txt", "/home/dev/b.txt", false);
    expect(events[0].type).toBe(1); // Created
  });

  it("copy supports nexterm->file file copy", async () => {
    const vscode = await import("vscode");
    (sftp.lstat as any).mockResolvedValue(fileEntry);
    (vscode.workspace.fs.stat as any).mockRejectedValue(new Error("missing"));
    (vscode.workspace.fs.createDirectory as any).mockResolvedValue(undefined);
    (sftp.download as any).mockResolvedValue(undefined);

    const source = buildUri("srv-1", "/home/dev/a.txt");
    const destination = vscode.Uri.file("/tmp/out.txt");
    await provider.copy(source, destination, { overwrite: false });

    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "/tmp" }));
    expect(sftp.download).toHaveBeenCalledWith("srv-1", "/home/dev/a.txt", "/tmp/out.txt");
  });

  it("copy supports nexterm->file recursive directory copy", async () => {
    const vscode = await import("vscode");
    (sftp.lstat as any).mockResolvedValue(dirEntry);
    (vscode.workspace.fs.stat as any).mockRejectedValue(new Error("missing"));
    (vscode.workspace.fs.createDirectory as any).mockResolvedValue(undefined);
    (sftp.readDirectory as any).mockImplementation(async (_serverId: string, remotePath: string) => {
      if (remotePath === "/home/dev/subdir") {
        return [{ ...fileEntry, name: "nested.txt" }];
      }
      return [];
    });
    (sftp.download as any).mockResolvedValue(undefined);

    const source = buildUri("srv-1", "/home/dev/subdir");
    const destination = vscode.Uri.file("/tmp/outdir");
    await provider.copy(source, destination, { overwrite: false });

    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "/tmp/outdir" }));
    expect(sftp.download).toHaveBeenCalledWith("srv-1", "/home/dev/subdir/nested.txt", "/tmp/outdir/nested.txt");
  });

  it("copy skips malicious entry names during nexterm->file recursive copy", async () => {
    const vscode = await import("vscode");
    (sftp.lstat as any).mockResolvedValue(dirEntry);
    (vscode.workspace.fs.stat as any).mockRejectedValue(new Error("missing"));
    (vscode.workspace.fs.createDirectory as any).mockResolvedValue(undefined);
    (sftp.readDirectory as any).mockImplementation(async (_serverId: string, remotePath: string) => {
      if (remotePath === "/home/dev/subdir") {
        return [
          { ...fileEntry, name: "safe.txt" },
          { ...fileEntry, name: "../../etc/malicious" },
          { ...fileEntry, name: "has/slash" },
          { ...fileEntry, name: ".." },
          { ...fileEntry, name: "ok.txt" },
        ];
      }
      return [];
    });
    (sftp.download as any).mockResolvedValue(undefined);

    const source = buildUri("srv-1", "/home/dev/subdir");
    const destination = vscode.Uri.file("/tmp/outdir");
    await provider.copy(source, destination, { overwrite: false });

    expect(sftp.download).toHaveBeenCalledTimes(2);
    expect(sftp.download).toHaveBeenCalledWith("srv-1", "/home/dev/subdir/safe.txt", "/tmp/outdir/safe.txt");
    expect(sftp.download).toHaveBeenCalledWith("srv-1", "/home/dev/subdir/ok.txt", "/tmp/outdir/ok.txt");
  });

  it("copy enforces max depth for nexterm->file recursive directory copy", async () => {
    const vscode = await import("vscode");
    (sftp.lstat as any).mockResolvedValue(dirEntry);
    (vscode.workspace.fs.stat as any).mockRejectedValue(new Error("missing"));
    (vscode.workspace.fs.createDirectory as any).mockResolvedValue(undefined);
    (sftp.readDirectory as any).mockResolvedValue([{ ...dirEntry, name: "nested" }]);

    const source = buildUri("srv-1", "/home/dev/subdir");
    const destination = vscode.Uri.file("/tmp/outdir");
    await expect(provider.copy(source, destination, { overwrite: false })).rejects.toThrow(/exceeds 100 levels/i);
  });

  it("copy rejects nexterm->nexterm across servers", async () => {
    const source = buildUri("srv-1", "/home/dev/a.txt");
    const destination = buildUri("srv-2", "/home/dev/b.txt");
    await expect(provider.copy(source, destination, { overwrite: false })).rejects.toThrow(/across servers/i);
  });

  it("copy rejects unsupported destination schemes", async () => {
    const vscode = await import("vscode");
    const source = buildUri("srv-1", "/home/dev/a.txt");
    const destination = vscode.Uri.from({ scheme: "http", authority: "example.com", path: "/x" });
    await expect(provider.copy(source, destination, { overwrite: false })).rejects.toThrow(/unsupported destination scheme/i);
  });

  it("watch returns a no-op disposable", () => {
    const uri = buildUri("srv-1", "/home");
    const disposable = provider.watch(uri);
    expect(disposable).toBeDefined();
    expect(() => disposable.dispose()).not.toThrow();
  });
});
