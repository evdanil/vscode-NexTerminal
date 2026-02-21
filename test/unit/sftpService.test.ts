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
});
