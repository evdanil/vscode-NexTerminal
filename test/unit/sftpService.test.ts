import { describe, expect, it, vi, beforeEach } from "vitest";
import { SftpService } from "../../src/services/sftp/sftpService";
import type { SshConnection, SshFactory } from "../../src/services/ssh/contracts";
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
    dispose: vi.fn(),
  };
}

function createMockFactory(connection: SshConnection): SshFactory {
  return {
    connect: vi.fn(async () => connection),
  };
}

describe("SftpService", () => {
  let sftp: ReturnType<typeof createMockSftp>;
  let connection: SshConnection;
  let factory: SshFactory;
  let service: SftpService;

  beforeEach(() => {
    sftp = createMockSftp();
    connection = createMockConnection(sftp);
    factory = createMockFactory(connection);
    service = new SftpService(factory);
  });

  it("connects to a server via SSH factory and opens SFTP", async () => {
    await service.connect(testServer);

    expect(factory.connect).toHaveBeenCalledWith(testServer);
    expect(connection.openSftp).toHaveBeenCalled();
    expect(service.isConnected("srv-1")).toBe(true);
  });

  it("disposes SSH connection if SFTP channel creation fails", async () => {
    const failingConnection = createMockConnection(sftp);
    (failingConnection.openSftp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("open sftp failed"));
    const failingFactory = createMockFactory(failingConnection);
    const failingService = new SftpService(failingFactory);

    await expect(failingService.connect(testServer)).rejects.toThrow("open sftp failed");
    expect(failingConnection.dispose).toHaveBeenCalled();
    expect(failingService.isConnected("srv-1")).toBe(false);
  });

  it("does not reconnect if already connected", async () => {
    await service.connect(testServer);
    await service.connect(testServer);

    expect(factory.connect).toHaveBeenCalledTimes(1);
  });

  it("disconnects and cleans up", async () => {
    await service.connect(testServer);
    service.disconnect("srv-1");

    expect(sftp.end).toHaveBeenCalled();
    expect(connection.dispose).toHaveBeenCalled();
    expect(service.isConnected("srv-1")).toBe(false);
  });

  it("disconnect is a no-op for unknown servers", () => {
    expect(() => service.disconnect("unknown")).not.toThrow();
  });

  it("throws when calling readDirectory without connection", async () => {
    await expect(service.readDirectory("srv-1", "/home")).rejects.toThrow("No SFTP session");
  });

  it("reads a directory and returns entries", async () => {
    await service.connect(testServer);

    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [
        { filename: "file.txt", attrs: { mode: 0o100644, size: 1024, mtime: 1700000000 } },
        { filename: "subdir", attrs: { mode: 0o040755, size: 4096, mtime: 1700000001 } },
        { filename: ".", attrs: { mode: 0o040755, size: 4096, mtime: 1700000001 } },
        { filename: "..", attrs: { mode: 0o040755, size: 4096, mtime: 1700000001 } },
      ]);
    });

    const entries = await service.readDirectory("srv-1", "/home/dev");

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("file.txt");
    expect(entries[0].isDirectory).toBe(false);
    expect(entries[0].size).toBe(1024);
    expect(entries[1].name).toBe("subdir");
    expect(entries[1].isDirectory).toBe(true);
  });

  it("caches directory results within TTL", async () => {
    await service.connect(testServer);

    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [{ filename: "a.txt", attrs: { mode: 0o100644, size: 100, mtime: 1700000000 } }]);
    });

    const first = await service.readDirectory("srv-1", "/home");
    const second = await service.readDirectory("srv-1", "/home");

    expect(sftp.readdir).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("invalidateCache forces re-fetch", async () => {
    await service.connect(testServer);

    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [{ filename: "a.txt", attrs: { mode: 0o100644, size: 100, mtime: 1700000000 } }]);
    });

    await service.readDirectory("srv-1", "/home");
    service.invalidateCache("srv-1", "/home");
    await service.readDirectory("srv-1", "/home");

    expect(sftp.readdir).toHaveBeenCalledTimes(2);
  });

  it("invalidateCache without path clears all cache for server", async () => {
    await service.connect(testServer);

    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, []);
    });

    await service.readDirectory("srv-1", "/a");
    await service.readDirectory("srv-1", "/b");
    service.invalidateCache("srv-1");
    await service.readDirectory("srv-1", "/a");
    await service.readDirectory("srv-1", "/b");

    expect(sftp.readdir).toHaveBeenCalledTimes(4);
  });

  it("stat resolves file stats", async () => {
    await service.connect(testServer);

    sftp.stat.mockImplementation((_path: string, cb: Function) => {
      cb(null, { mode: 0o100644, size: 2048, mtime: 1700000000 });
    });

    const entry = await service.stat("srv-1", "/home/dev/test.txt");
    expect(entry.name).toBe("test.txt");
    expect(entry.isDirectory).toBe(false);
    expect(entry.size).toBe(2048);
  });

  it("realpath resolves paths", async () => {
    await service.connect(testServer);

    sftp.realpath.mockImplementation((_path: string, cb: Function) => {
      cb(null, "/home/dev");
    });

    const result = await service.realpath("srv-1", ".");
    expect(result).toBe("/home/dev");
  });

  it("createDirectory invalidates parent cache", async () => {
    await service.connect(testServer);

    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, []);
    });
    sftp.mkdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await service.readDirectory("srv-1", "/home");
    await service.createDirectory("srv-1", "/home/newdir");
    await service.readDirectory("srv-1", "/home");

    // Should have fetched twice because cache was invalidated
    expect(sftp.readdir).toHaveBeenCalledTimes(2);
  });

  it("lstat returns entry without following symlinks", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((_path: string, cb: Function) => {
      cb(null, { mode: 0o120777, size: 30, mtime: 1700000000 });
    });

    const entry = await service.lstat("srv-1", "/home/dev/link");
    expect(entry.name).toBe("link");
    expect(entry.isSymlink).toBe(true);
  });

  it("deduplicates concurrent connect calls", async () => {
    const p1 = service.connect(testServer);
    const p2 = service.connect(testServer);
    await Promise.all([p1, p2]);

    expect(factory.connect).toHaveBeenCalledTimes(1);
  });

  it("readFile enforces streaming max size", async () => {
    await service.connect(testServer);

    const bigChunk = Buffer.alloc(60 * 1024 * 1024);
    const mockStream = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === "data") {
          setTimeout(() => handler(bigChunk), 0);
        }
        return mockStream;
      }),
      destroy: vi.fn(),
    };
    sftp.createReadStream.mockReturnValue(mockStream);

    await expect(service.readFile("srv-1", "/big", 50 * 1024 * 1024)).rejects.toThrow(/exceeds maximum size/);
    expect(mockStream.destroy).toHaveBeenCalled();
  });

  it("dispose disconnects all sessions", async () => {
    await service.connect(testServer);
    service.dispose();

    expect(sftp.end).toHaveBeenCalled();
    expect(connection.dispose).toHaveBeenCalled();
    expect(service.isConnected("srv-1")).toBe(false);
  });

  describe("execCommand (private, tested via copyRemote)", () => {
    const tick = () => new Promise((r) => process.nextTick(r));

    it("collects stdout/stderr/exitCode through copyRemote", async () => {
      const { PassThrough } = await import("node:stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stream = Object.assign(stdout, { stderr }) as any;

      (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
      await service.connect(testServer);

      const resultPromise = service.copyRemote("srv-1", "/a", "/b", false);
      await tick();

      stderr.write("cp: error\n");
      stdout.emit("close", 1);

      await expect(resultPromise).rejects.toThrow("cp: error");
    });

    it("throws when no session exists", async () => {
      await expect(service.copyRemote("srv-1", "/a", "/b", false)).rejects.toThrow("No SFTP session");
    });

    it("times out when command hangs", async () => {
      const { PassThrough } = await import("node:stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stream = Object.assign(stdout, { stderr, destroy: vi.fn() }) as any;

      (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
      await service.connect(testServer);

      // Use a very short timeout via the private method
      const resultPromise = (service as any).execCommand("srv-1", "sleep 999", 50);
      await expect(resultPromise).rejects.toThrow("Command timed out after 50ms");
      expect(stream.destroy).toHaveBeenCalled();
    });
  });

  describe("copyRemote", () => {
    const tick = () => new Promise((r) => process.nextTick(r));

    it("calls cp -p for files", async () => {
      const { PassThrough } = await import("node:stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stream = Object.assign(stdout, { stderr }) as any;

      (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
      await service.connect(testServer);

      const promise = service.copyRemote("srv-1", "/home/a.txt", "/home/b.txt", false);
      await tick();
      stdout.emit("close", 0);
      await promise;

      expect(connection.exec).toHaveBeenCalledWith("cp -p -- '/home/a.txt' '/home/b.txt'");
    });

    it("calls cp -rp for directories", async () => {
      const { PassThrough } = await import("node:stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stream = Object.assign(stdout, { stderr }) as any;

      (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
      await service.connect(testServer);

      const promise = service.copyRemote("srv-1", "/home/mydir", "/home/copy", true);
      await tick();
      stdout.emit("close", 0);
      await promise;

      expect(connection.exec).toHaveBeenCalledWith("cp -R -p -- '/home/mydir' '/home/copy'");
    });

    it("throws on non-zero exit code with stderr message", async () => {
      const { PassThrough } = await import("node:stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stream = Object.assign(stdout, { stderr }) as any;

      (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
      await service.connect(testServer);

      const promise = service.copyRemote("srv-1", "/a", "/b", false);
      await tick();
      stderr.write("cp: cannot stat '/a': No such file or directory\n");
      stdout.emit("close", 1);

      await expect(promise).rejects.toThrow("No such file or directory");
    });

    it("shell-escapes paths with single quotes", async () => {
      const { PassThrough } = await import("node:stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stream = Object.assign(stdout, { stderr }) as any;

      (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
      await service.connect(testServer);

      const promise = service.copyRemote("srv-1", "/home/it's a file", "/home/dest", false);
      await tick();
      stdout.emit("close", 0);
      await promise;

      expect(connection.exec).toHaveBeenCalledWith("cp -p -- '/home/it'\\''s a file' '/home/dest'");
    });

    it("rejects control characters in source and destination paths", async () => {
      await service.connect(testServer);

      await expect(service.copyRemote("srv-1", "/home/a\nbad", "/home/b", false)).rejects.toThrow(
        "Invalid remote source path"
      );
      await expect(service.copyRemote("srv-1", "/home/a", "/home/\rb", false)).rejects.toThrow(
        "Invalid remote destination path"
      );
    });

    it("treats signal-terminated commands as errors", async () => {
      const { PassThrough } = await import("node:stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stream = Object.assign(stdout, { stderr }) as any;

      (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
      await service.connect(testServer);

      const promise = service.copyRemote("srv-1", "/a", "/b", false);
      await tick();
      stdout.emit("close", null, "TERM");

      await expect(promise).rejects.toThrow("terminated by signal TERM");
    });
  });
});
