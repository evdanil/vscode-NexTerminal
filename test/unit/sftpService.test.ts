import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Controllable node:fs promises. SftpService now does its local-side IO here —
// the pre-flight open/stat that keeps a bad local path off ssh2's socket-callback
// stack, and the post-transfer size verification.
const { fsPromisesMock, fsCreateReadStream } = vi.hoisted(() => ({
  fsPromisesMock: {
    stat: vi.fn(),
    open: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  },
  // The claimed-zero upload branch reads the local source through a bounded
  // stream, not fsp.readFile — an unbounded readFile is how /dev/zero reaches
  // the extension host's heap.
  fsCreateReadStream: vi.fn()
}));

vi.mock("node:fs", () => ({
  promises: fsPromisesMock,
  createReadStream: (...args: unknown[]) => fsCreateReadStream(...args),
  default: { promises: fsPromisesMock, createReadStream: (...args: unknown[]) => fsCreateReadStream(...args) }
}));

import { SftpService } from "../../src/services/sftp/sftpService";
import { SshConnectionPool } from "../../src/services/ssh/sshConnectionPool";
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

type MockSftp = EventEmitter & {
  readdir: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  lstat: ReturnType<typeof vi.fn>;
  createReadStream: ReturnType<typeof vi.fn>;
  createWriteStream: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  rmdir: ReturnType<typeof vi.fn>;
  realpath: ReturnType<typeof vi.fn>;
  fastGet: ReturnType<typeof vi.fn>;
  fastPut: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

// Composed over a REAL EventEmitter (not an arrow-function class mock — vitest 4
// breaks those) so Node's own throw-on-unlistened-'error' semantics apply. That
// is precisely the production failure being fixed: without a listener the throw
// happens synchronously inside ssh2's packet handler, on the socket 'data' stack.
function createMockSftp(): MockSftp {
  return Object.assign(new EventEmitter(), {
    readdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    realpath: vi.fn(),
    fastGet: vi.fn(),
    fastPut: vi.fn(),
    end: vi.fn(),
  }) as MockSftp;
}

function remoteStatsOfSize(size: number) {
  return { mode: 0o100644, size, mtime: 1700000000 };
}

/** Write stream double for `writeFileWithTimeout` (registers 'close'/'error', then `end(chunk)`). */
function createMockWriteStream() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const written: Buffer[] = [];
  const stream = {
    on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      handlers.set(event, handler);
      return stream;
    }),
    destroy: vi.fn(),
    end: vi.fn((chunk: Buffer) => {
      written.push(chunk);
      handlers.get("close")?.();
    }),
    written
  };
  return stream;
}

/**
 * A remote filesystem double that models the MODE side-effects of ssh2's two
 * whole-file write paths. Verified against ssh2 1.17.0 `lib/protocol/SFTP.js`:
 *
 * - `createWriteStream(path, opts)` → `WriteStream.prototype.open()` sends
 *   SSH_FXP_OPEN carrying `mode` (default 0o666) AND then issues an
 *   UNCONDITIONAL `fchmod(handle, mode)` — on every open, existing file or not.
 *   So this path rewrites the mode of a file it overwrites.
 * - `writeFile(path, data, { flag })` with no `mode` → `open(path, flag,
 *   undefined, cb)`, i.e. SSH_FXP_OPEN with NO attrs, and no chmod anywhere.
 *   The server applies its default-and-umask when creating; an existing file
 *   keeps whatever mode it had. This is byte-for-byte what `fastPut` does.
 *
 * Without modelling the fchmod, a mode-preservation assertion is vacuous: the
 * mock would report the mode it was seeded with no matter which path ran.
 */
function installRemoteWriteModel(sftp: MockSftp, serverCreateMode = 0o644) {
  const modes = new Map<string, number>();
  const writes: Array<{ path: string; data: Buffer; options?: { mode?: number; flag?: string } }> = [];

  sftp.createWriteStream.mockImplementation((remotePath: string, options?: { mode?: number }) => {
    // open()'s `mode` attr applies only on create; the fchmod that follows it
    // applies always — so the effective mode is the same either way.
    modes.set(remotePath, options?.mode ?? 0o666);
    return createMockWriteStream();
  });

  sftp.writeFile.mockImplementation((
    remotePath: string,
    data: Buffer,
    options: { mode?: number; flag?: string } | undefined,
    callback: (error?: Error | null) => void
  ) => {
    if (!modes.has(remotePath)) {
      modes.set(remotePath, options?.mode ?? serverCreateMode);
    }
    writes.push({ path: remotePath, data, options });
    queueMicrotask(() => callback(null));
  });

  return { modes, writes };
}

/** Read stream double for `readFileWithTimeout` (registers 'data'/'end'/'error'). */
function createMockReadStream(chunks: Buffer[]) {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const stream = {
    on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return stream;
    }),
    destroy: vi.fn()
  };
  // Deferred: readFileWithTimeout registers all three handlers synchronously
  // right after createStream() returns.
  queueMicrotask(() => {
    for (const chunk of chunks) {
      for (const handler of handlers.get("data") ?? []) {
        handler(chunk);
      }
    }
    for (const handler of handlers.get("end") ?? []) {
      handler();
    }
  });
  return stream;
}

function uncAccessError(host = "192.168.2.10"): Error & { code: string } {
  return Object.assign(new Error(`UNC host '${host}' access is not allowed`), {
    code: "ERR_UNC_HOST_NOT_ALLOWED"
  });
}

function createMockConnection(sftp: MockSftp): SshConnection {
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

function missingPathError(message = "No such file"): Error & { code: number } {
  return Object.assign(new Error(message), { code: 2 });
}

type MockExecStream = EventEmitter & { destroy: ReturnType<typeof vi.fn> };

function createExecStream(): MockExecStream {
  const stream = new EventEmitter() as MockExecStream;
  stream.destroy = vi.fn();
  return stream;
}

describe("SftpService", () => {
  let sftp: MockSftp;
  let connection: SshConnection;
  let factory: SshFactory;
  let service: SftpService;
  let diagnostics: ReturnType<typeof vi.fn>;

  const diagnosticsText = (): string => diagnostics.mock.calls.map((args) => String(args[0])).join("\n");

  beforeEach(() => {
    sftp = createMockSftp();
    connection = createMockConnection(sftp);
    factory = createMockFactory(connection);
    diagnostics = vi.fn();
    service = new SftpService(factory, undefined, diagnostics);

    fsPromisesMock.stat.mockReset();
    fsPromisesMock.open.mockReset();
    fsPromisesMock.readFile.mockReset();
    fsPromisesMock.writeFile.mockReset();
    fsCreateReadStream.mockReset();
    // Benign defaults; individual transfer tests override them.
    fsPromisesMock.stat.mockResolvedValue({ size: 1024 });
    fsPromisesMock.open.mockResolvedValue({ close: vi.fn(async () => {}) });
    fsPromisesMock.readFile.mockResolvedValue(Buffer.alloc(0));
    fsPromisesMock.writeFile.mockResolvedValue(undefined);
    fsCreateReadStream.mockImplementation(() => createMockReadStream([]));
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

  it("enforces a lower cache size immediately after config updates", async () => {
    await service.connect(testServer);

    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, []);
    });

    for (let index = 0; index < 11; index += 1) {
      await service.readDirectory("srv-1", `/dir-${index}`);
    }

    service.updateConfig({
      cacheTtlMs: 10_000,
      maxCacheEntries: 10,
      commandTimeoutMs: 300_000,
      maxDeleteDepth: 100,
      maxDeleteOps: 10_000
    });

    await service.readDirectory("srv-1", "/dir-10");
    await service.readDirectory("srv-1", "/dir-0");

    expect(sftp.readdir).toHaveBeenCalledTimes(12);
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

  it("tryStat returns undefined only for missing paths", async () => {
    await service.connect(testServer);

    sftp.stat.mockImplementation((_path: string, cb: Function) => {
      cb(missingPathError());
    });
    await expect(service.tryStat("srv-1", "/missing")).resolves.toBeUndefined();

    sftp.stat.mockImplementation((_path: string, cb: Function) => {
      cb(new Error("permission denied"));
    });
    await expect(service.tryStat("srv-1", "/denied")).rejects.toThrow("permission denied");
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

  it("delete uses fresh lstat and unlinks symlinks", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((_path: string, cb: Function) => {
      cb(null, { mode: 0o120777, size: 30, mtime: 1700000000 });
    });
    sftp.unlink.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await service.delete("srv-1", "/home/dev/link");

    expect(sftp.lstat).toHaveBeenCalledWith("/home/dev/link", expect.any(Function));
    expect(sftp.unlink).toHaveBeenCalledWith("/home/dev/link", expect.any(Function));
    expect(sftp.rmdir).not.toHaveBeenCalled();
  });

  it("delete uses a fresh directory listing for recursive deletes", async () => {
    await service.connect(testServer);

    let readdirCallCount = 0;
    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      if (pathName === "/home/dev/stale.txt") {
        cb(missingPathError("missing stale"));
        return;
      }
      if (pathName === "/home/dev/live.txt") {
        cb(null, { mode: 0o100644, size: 111, mtime: 1700000000 });
        return;
      }
      cb(new Error(`unexpected path: ${pathName}`));
    });
    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      readdirCallCount += 1;
      cb(null, [
        { filename: "stale.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
        { filename: "live.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
      ]);
    });
    sftp.unlink.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });
    sftp.rmdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await service.readDirectory("srv-1", "/home/dev");

    await service.delete("srv-1", "/home/dev");

    expect(readdirCallCount).toBe(2);
    expect(sftp.unlink).toHaveBeenCalledWith("/home/dev/live.txt", expect.any(Function));
    expect(sftp.unlink).not.toHaveBeenCalledWith("/home/dev/stale.txt", expect.any(Function));
  });

  it("delete enforces non-recursive policy from fresh lstat", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(null, { mode: 0o100644, size: 111, mtime: 1700000000 });
    });

    await expect(service.delete("srv-1", "/home/dev", { recursive: false })).rejects.toThrow(/not empty/i);

    expect(sftp.readdir).not.toHaveBeenCalled();
    expect(sftp.unlink).not.toHaveBeenCalled();
    expect(sftp.rmdir).not.toHaveBeenCalled();
  });

  it("delete rechecks child entries before descending", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      if (pathName === "/home/dev/link") {
        cb(null, { mode: 0o120777, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(new Error(`unexpected path: ${pathName}`));
    });
    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [{ filename: "link", attrs: { mode: 0o040755, size: 4096, mtime: 1700000000 } }]);
    });
    sftp.unlink.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });
    sftp.rmdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await service.delete("srv-1", "/home/dev");

    expect(sftp.lstat).toHaveBeenNthCalledWith(1, "/home/dev", expect.any(Function));
    expect(sftp.lstat).toHaveBeenNthCalledWith(2, "/home/dev/link", expect.any(Function));
    expect(sftp.readdir).toHaveBeenCalledWith("/home/dev", expect.any(Function));
    expect(sftp.readdir).not.toHaveBeenCalledWith("/home/dev/link", expect.any(Function));
    expect(sftp.unlink).toHaveBeenCalledWith("/home/dev/link", expect.any(Function));
  });

  it("delete aborts recursive traversal on unsafe child names", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(null, { mode: 0o100644, size: 111, mtime: 1700000000 });
    });
    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [{ filename: "../../evil", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } }]);
    });

    await expect(service.delete("srv-1", "/home/dev")).rejects.toThrow(/unsafe entry name/);
    expect(sftp.rmdir).not.toHaveBeenCalled();
  });

  it("delete ignores missing child entries during recursive deletes", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(null, { mode: 0o100644, size: 111, mtime: 1700000000 });
    });
    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [
        { filename: "gone.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
        { filename: "keep.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
      ]);
    });
    sftp.unlink.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev/gone.txt") {
        cb(missingPathError("gone"));
        return;
      }
      cb(null);
    });
    sftp.rmdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await expect(service.delete("srv-1", "/home/dev")).resolves.toBeUndefined();
    expect(sftp.unlink).toHaveBeenCalledTimes(2);
    expect(sftp.rmdir).toHaveBeenCalledWith("/home/dev", expect.any(Function));
  });

  it("delete propagates non-missing errors", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(null, { mode: 0o100644, size: 111, mtime: 1700000000 });
    });
    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [
        { filename: "denied.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
      ]);
    });
    const deniedError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    sftp.unlink.mockImplementation((_path: string, cb: Function) => {
      cb(deniedError);
    });
    sftp.rmdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await expect(service.delete("srv-1", "/home/dev")).rejects.toThrow("permission denied");
    expect(sftp.rmdir).not.toHaveBeenCalled();
  });

  it("delete propagates EACCES errors even when message contains not found", async () => {
    await service.connect(testServer);

    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(null, { mode: 0o100644, size: 111, mtime: 1700000000 });
    });
    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, [
        { filename: "denied.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
      ]);
    });
    sftp.unlink.mockImplementation((_path: string, cb: Function) => {
      cb(Object.assign(new Error("permission denied (not found)"), { code: "EACCES" }));
    });
    sftp.rmdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await expect(service.delete("srv-1", "/home/dev")).rejects.toThrow("not found");
    expect(sftp.rmdir).not.toHaveBeenCalled();
  });

  it("delete invalidates parent and subtree cache after recursive delete", async () => {
    await service.connect(testServer);

    sftp.readdir.mockImplementation((_path: string, cb: Function) => {
      cb(null, []);
    });
    sftp.lstat.mockImplementation((_path: string, cb: Function) => {
      cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
    });
    sftp.unlink.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });
    sftp.rmdir.mockImplementation((_path: string, cb: Function) => {
      cb(null);
    });

    await service.readDirectory("srv-1", "/home/dev");
    await service.readDirectory("srv-1", "/home/dev/sub");
    await service.delete("srv-1", "/home/dev");
    await service.readDirectory("srv-1", "/home/dev");
    await service.readDirectory("srv-1", "/home/dev/sub");

    expect(sftp.readdir).toHaveBeenCalledTimes(5);
  });

  it("delete invalidates parent and subtree cache after partial recursive delete failure", async () => {
    await service.connect(testServer);

    let deleting = false;
    sftp.readdir.mockImplementation((remotePath: string, cb: Function) => {
      if (deleting && remotePath === "/home/dev") {
        cb(null, [
          { filename: "removed.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
          { filename: "denied.txt", attrs: { mode: 0o100644, size: 111, mtime: 1700000000 } },
        ]);
        return;
      }
      cb(null, []);
    });
    sftp.lstat.mockImplementation((pathName: string, cb: Function) => {
      if (pathName === "/home/dev") {
        cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000 });
        return;
      }
      cb(null, { mode: 0o100644, size: 111, mtime: 1700000000 });
    });
    sftp.unlink.mockImplementation((remotePath: string, cb: Function) => {
      if (remotePath.endsWith("/denied.txt")) {
        cb(Object.assign(new Error("permission denied"), { code: "EACCES" }));
        return;
      }
      cb(null);
    });

    await service.readDirectory("srv-1", "/home/dev");
    await service.readDirectory("srv-1", "/home/dev/sub");
    deleting = true;

    await expect(service.delete("srv-1", "/home/dev")).rejects.toThrow("permission denied");

    deleting = false;
    await service.readDirectory("srv-1", "/home/dev");
    await service.readDirectory("srv-1", "/home/dev/sub");

    expect(sftp.readdir).toHaveBeenCalledTimes(5);
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

  it("readFile times out and destroys the stream", async () => {
    await service.connect(testServer);
    (service as any).commandTimeoutMs = 50;

    const mockStream = {
      on: vi.fn(() => mockStream),
      destroy: vi.fn(),
    };
    sftp.createReadStream.mockReturnValue(mockStream);

    await expect(service.readFile("srv-1", "/hung")).rejects.toThrow("SFTP readFile timed out");
    expect(mockStream.destroy).toHaveBeenCalled();
  });

  // There is deliberately no `destroy()` assertion here any more. writeFile now
  // goes through `sftp.writeFile`, which hands back no stream to destroy — the
  // accepted cost of never widening the file's mode. The old destroy() only sent
  // SSH_FXP_CLOSE down the very channel that is wedged in this scenario, and
  // fastPut/fastGet already time out with no cancellation handle at all.
  it("writeFile times out when the server never answers", async () => {
    await service.connect(testServer);
    (service as any).commandTimeoutMs = 50;

    sftp.writeFile.mockImplementation(() => {
      /* never calls back — a wedged SFTP channel */
    });

    await expect(service.writeFile("srv-1", "/hung.txt", Buffer.from("data"))).rejects.toThrow("SFTP writeFile timed out");
    expect(sftp.writeFile).toHaveBeenCalledWith(
      "/hung.txt",
      Buffer.from("data"),
      { flag: "w" },
      expect.any(Function)
    );
  });

  // The editor-save mirror of the upload-path T8a/T8b pair below. Same ssh2
  // defect, second caller: `NexusFileSystemProvider.writeFile` on Ctrl+S, and the
  // File Explorer's New File command.
  it("saving over an existing remote file leaves its permissions alone", async () => {
    await service.connect(testServer);
    const remote = installRemoteWriteModel(sftp);
    // A secret the owner alone may read — an SSH key, a credentials file.
    remote.modes.set("/remote/id_rsa", 0o600);

    await expect(service.writeFile("srv-1", "/remote/id_rsa", Buffer.from("key"))).resolves.toBeUndefined();

    // ssh2's createWriteStream fchmods every open to its `mode` (0o666 by
    // default) BEFORE any data flows, which would have made this world-readable
    // AND world-writable on every save — including a save that then failed.
    expect(remote.modes.get("/remote/id_rsa")).toBe(0o600);
    expect(sftp.createWriteStream).not.toHaveBeenCalled();
  });

  it("saving a new remote file passes no mode attr, leaving the server's umask in charge", async () => {
    await service.connect(testServer);
    const remote = installRemoteWriteModel(sftp, 0o644);

    await expect(service.writeFile("srv-1", "/remote/fresh.txt", Buffer.from("hello"))).resolves.toBeUndefined();

    // An explicit mode would be applied by the fchmod AFTER the server's umask
    // has filtered the open attrs, so 0o666 lands verbatim as 0o666.
    expect(remote.writes).toHaveLength(1);
    expect(remote.writes[0].options?.mode).toBeUndefined();
    expect(remote.writes[0].data).toEqual(Buffer.from("hello"));
    expect(remote.modes.get("/remote/fresh.txt")).toBe(0o644);
  });

  it("the File Explorer's New File command does not create a world-writable file", async () => {
    await service.connect(testServer);
    const remote = installRemoteWriteModel(sftp, 0o644);

    // Exactly the call fileCommands.ts's nexus.files.createFile makes.
    await expect(service.writeFile("srv-1", "/remote/notes.txt", Buffer.alloc(0))).resolves.toBeUndefined();

    expect(remote.modes.get("/remote/notes.txt")).toBe(0o644);
    expect(sftp.createWriteStream).not.toHaveBeenCalled();
  });

  it("allows uploads to exceed the timeout while transfer progress continues", async () => {
    vi.useFakeTimers();
    try {
      await service.connect(testServer);
      (service as any).commandTimeoutMs = 50;
      fsPromisesMock.stat.mockResolvedValue({ size: 8_000_000_000 });
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(8_000_000_000)));

      let step: ((total: number, nb: number, fsize: number) => void) | undefined;
      let complete: ((error?: Error) => void) | undefined;

      sftp.fastPut.mockImplementation((
        _localPath: string,
        _remotePath: string,
        options: { step?: (total: number, nb: number, fsize: number) => void },
        callback: (error?: Error) => void
      ) => {
        step = options.step;
        complete = callback;
      });

      const uploadPromise = service.upload("srv-1", "/tmp/big.bin", "/remote/big.bin");
      // The local pre-stat resolves before any remote work starts.
      await vi.advanceTimersByTimeAsync(0);

      expect(sftp.fastPut).toHaveBeenCalledWith(
        "/tmp/big.bin",
        "/remote/big.bin",
        expect.objectContaining({
          step: expect.any(Function),
          fileSize: 8_000_000_000,
          concurrency: 64,
          chunkSize: 32768
        }),
        expect.any(Function)
      );

      await vi.advanceTimersByTimeAsync(40);
      step?.(32_768, 32_768, 8_000_000_000);
      await vi.advanceTimersByTimeAsync(40);
      step?.(65_536, 32_768, 8_000_000_000);
      await vi.advanceTimersByTimeAsync(40);
      complete?.();

      await expect(uploadPromise).resolves.toBeUndefined();
      expect(sftp.end).not.toHaveBeenCalled();
      expect(connection.dispose).not.toHaveBeenCalled();
      expect(service.isConnected("srv-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows downloads to exceed the timeout while transfer progress continues", async () => {
    vi.useFakeTimers();
    try {
      await service.connect(testServer);
      (service as any).commandTimeoutMs = 50;
      fsPromisesMock.stat.mockResolvedValue({ size: 8_000_000_000 });
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(8_000_000_000)));

      let step: ((total: number, nb: number, fsize: number) => void) | undefined;
      let complete: ((error?: Error) => void) | undefined;

      sftp.fastGet.mockImplementation((
        _remotePath: string,
        _localPath: string,
        options: { step?: (total: number, nb: number, fsize: number) => void },
        callback: (error?: Error) => void
      ) => {
        step = options.step;
        complete = callback;
      });

      const downloadPromise = service.download("srv-1", "/remote/big.bin", "/tmp/big.bin");
      // Pre-flight open of the destination + remote stat both settle first.
      await vi.advanceTimersByTimeAsync(0);

      expect(fsPromisesMock.open).toHaveBeenCalledWith("/tmp/big.bin", "w");
      expect(sftp.fastGet).toHaveBeenCalledWith(
        "/remote/big.bin",
        "/tmp/big.bin",
        expect.objectContaining({
          step: expect.any(Function),
          fileSize: 8_000_000_000,
          concurrency: 64,
          chunkSize: 32768
        }),
        expect.any(Function)
      );

      await vi.advanceTimersByTimeAsync(40);
      step?.(32_768, 32_768, 8_000_000_000);
      await vi.advanceTimersByTimeAsync(40);
      step?.(65_536, 32_768, 8_000_000_000);
      await vi.advanceTimersByTimeAsync(40);
      complete?.();

      await expect(downloadPromise).resolves.toBeUndefined();
      expect(sftp.end).not.toHaveBeenCalled();
      expect(connection.dispose).not.toHaveBeenCalled();
      expect(service.isConnected("srv-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out stalled uploads, disconnects the session, and ignores late completion", async () => {
    vi.useFakeTimers();
    try {
      await service.connect(testServer);
      (service as any).commandTimeoutMs = 50;
      fsPromisesMock.stat.mockResolvedValue({ size: 4096 });

      let complete: ((error?: Error) => void) | undefined;
      sftp.fastPut.mockImplementation((
        _localPath: string,
        _remotePath: string,
        _options: { step?: (total: number, nb: number, fsize: number) => void },
        callback: (error?: Error) => void
      ) => {
        complete = callback;
      });

      const uploadPromise = service.upload("srv-1", "/tmp/stalled.bin", "/remote/stalled.bin");
      const rejection = expect(uploadPromise).rejects.toThrow("SFTP upload timed out");

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60);
      await rejection;

      expect(sftp.end).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected("srv-1")).toBe(false);

      complete?.();

      expect(sftp.end).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected("srv-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose disconnects all sessions", async () => {
    await service.connect(testServer);
    service.dispose();

    expect(sftp.end).toHaveBeenCalled();
    expect(connection.dispose).toHaveBeenCalled();
    expect(service.isConnected("srv-1")).toBe(false);
  });

  it("invalidates only the changed cache subtree when a remote watch event arrives", async () => {
    vi.useFakeTimers();
    try {
      const watchStream = createExecStream();
      (connection.exec as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
        if (command === "command -v inotifywait") {
          const probeStream = createExecStream();
          setTimeout(() => probeStream.emit("close", 0), 0);
          return probeStream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
        }
        return watchStream as unknown as Awaited<ReturnType<SshConnection["exec"]>>;
      });

      await service.connect(testServer);

      sftp.readdir.mockImplementation((_path: string, cb: Function) => {
        cb(null, [{ filename: "file.txt", attrs: { mode: 0o100644, size: 100, mtime: 1700000000 } }]);
      });

      await service.readDirectory("srv-1", "/home/dev");
      await service.readDirectory("srv-1", "/home/dev/subdir");
      await service.readDirectory("srv-1", "/home/dev/other");

      const watchPromise = service.startWatching("srv-1", "/home/dev", 1_000);
      await vi.advanceTimersByTimeAsync(0);
      await watchPromise;
      watchStream.emit("data", Buffer.from("/home/dev/subdir/\n"));
      await vi.advanceTimersByTimeAsync(500);

      await service.readDirectory("srv-1", "/home/dev");
      await service.readDirectory("srv-1", "/home/dev/subdir");
      await service.readDirectory("srv-1", "/home/dev/other");

      expect(sftp.readdir).toHaveBeenCalledTimes(4);
      expect(sftp.readdir).toHaveBeenNthCalledWith(4, "/home/dev/subdir", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  describe("SFTP channel fault containment (C1)", () => {
    it("T1 — a fatal SFTP channel error is contained, cleaned up, and logged", async () => {
      await service.connect(testServer);

      // With no 'error' listener Node throws ERR_UNHANDLED_ERROR synchronously
      // inside ssh2's packet handler, i.e. on the net.Socket 'data' stack, which
      // tears down the shared Client and every terminal tab with it.
      expect(() =>
        sftp.emit("error", Object.assign(new Error("Malformed packet"), { level: "sftp-protocol" }))
      ).not.toThrow();

      expect(service.isConnected("srv-1")).toBe(false);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(diagnosticsText()).toContain("Malformed packet");
    });

    it("T2 — a closed SFTP channel drops the session instead of leaving it mapped", async () => {
      await service.connect(testServer);

      sftp.emit("close");

      expect(service.isConnected("srv-1")).toBe(false);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
    });

    it("T3 — teardown is idempotent: an explicit disconnect followed by the channel's own close disposes once", async () => {
      await service.connect(testServer);

      service.disconnect("srv-1");
      expect(() => sftp.emit("close")).not.toThrow();

      // A second dispose() would release a pool lease we no longer hold, i.e.
      // decrement the refcount on a connection other tabs are still using.
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(sftp.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("local pre-flight and verified transfers (C3)", () => {
    it("T4 — the local destination is opened on our stack, so ssh2 never opens it from its own socket callback", async () => {
      await service.connect(testServer);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(100)));
      fsPromisesMock.open.mockRejectedValueOnce(uncAccessError());

      await expect(
        service.download("srv-1", "/remote/f.bin", "\\\\192.168.2.10\\share\\f.bin")
      ).rejects.toMatchObject({ code: "ERR_UNC_HOST_NOT_ALLOWED" });

      // The whole point: ssh2 must never get the chance to open this path from
      // inside its own socket-data callback.
      expect(sftp.fastGet).not.toHaveBeenCalled();
      // The remote side is validated FIRST (this is also ssh2's own ordering);
      // the local 'w' open happens immediately before fastGet, not before it.
      expect(sftp.stat).toHaveBeenCalledTimes(1);
      expect(fsPromisesMock.open).toHaveBeenCalledWith("\\\\192.168.2.10\\share\\f.bin", "w");
    });

    it("T4b — a download whose remote file cannot be stat'd never touches the existing local file", async () => {
      await service.connect(testServer);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(missingPathError("No such file")));

      await expect(service.download("srv-1", "/remote/gone.bin", "/tmp/precious.bin")).rejects.toThrow(
        /no such file/i
      );

      // The old order truncated the destination before asking the server
      // anything, so a vanished remote file destroyed the user's local copy —
      // or left an empty file standing in for one that never existed.
      expect(fsPromisesMock.open).not.toHaveBeenCalled();
      expect(fsPromisesMock.writeFile).not.toHaveBeenCalled();
      expect(sftp.fastGet).not.toHaveBeenCalled();
    });

    it("T5 — an upload pre-stat failure propagates with err.code intact", async () => {
      await service.connect(testServer);
      fsPromisesMock.stat.mockRejectedValueOnce(uncAccessError());

      await expect(
        service.upload("srv-1", "\\\\192.168.2.10\\share\\f.bin", "/remote/f.bin")
      ).rejects.toMatchObject({ code: "ERR_UNC_HOST_NOT_ALLOWED" });

      expect(sftp.fastPut).not.toHaveBeenCalled();
    });

    it("T6 — an upload whose remote size does not match the source is reported as failed", async () => {
      await service.connect(testServer);
      fsPromisesMock.stat.mockResolvedValue({ size: 5 });
      sftp.fastPut.mockImplementation((_l: string, _r: string, _o: unknown, cb: Function) => cb());
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(0)));

      await expect(service.upload("srv-1", "/tmp/five.txt", "/remote/five.txt")).rejects.toThrow(
        /verification failed/
      );
      expect(diagnosticsText()).toContain("FAILED");
    });

    it("T7 — a source whose stat claims zero bytes is streamed to EOF, not size-planned", async () => {
      await service.connect(testServer);
      fsPromisesMock.stat.mockResolvedValue({ size: 0 });
      fsCreateReadStream.mockImplementation(() => createMockReadStream([Buffer.from("actual")]));
      const remote = installRemoteWriteModel(sftp);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(6)));

      await expect(service.upload("srv-1", "/proc/lying", "/remote/lying")).resolves.toBeUndefined();

      // fastPut with a planned size of 0 is ssh2's silent-success branch.
      expect(sftp.fastPut).not.toHaveBeenCalled();
      expect(fsCreateReadStream).toHaveBeenCalledWith("/proc/lying");
      expect(remote.writes.map((w) => w.data)).toEqual([Buffer.from("actual")]);
    });

    it("T8 — a genuinely empty file still uploads successfully as an empty remote file", async () => {
      await service.connect(testServer);
      fsPromisesMock.stat.mockResolvedValue({ size: 0 });
      fsCreateReadStream.mockImplementation(() => createMockReadStream([]));
      const remote = installRemoteWriteModel(sftp);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(0)));

      await expect(service.upload("srv-1", "/tmp/empty.txt", "/remote/empty.txt")).resolves.toBeUndefined();

      expect(remote.writes).toEqual([
        { path: "/remote/empty.txt", data: Buffer.alloc(0), options: { flag: "w" } }
      ]);
    });

    it("T8a — an upload over an existing remote file leaves its permissions alone", async () => {
      await service.connect(testServer);
      fsPromisesMock.stat.mockResolvedValue({ size: 0 });
      fsCreateReadStream.mockImplementation(() => createMockReadStream([]));
      const remote = installRemoteWriteModel(sftp);
      // A secret the owner alone may read — an SSH key, a credentials file.
      remote.modes.set("/remote/id_rsa", 0o600);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(0)));

      await expect(service.upload("srv-1", "/tmp/empty.txt", "/remote/id_rsa")).resolves.toBeUndefined();

      // ssh2's createWriteStream fchmods every open to its `mode` (0o666 by
      // default), which would have made this world-readable AND world-writable.
      expect(remote.modes.get("/remote/id_rsa")).toBe(0o600);
      expect(sftp.createWriteStream).not.toHaveBeenCalled();
    });

    it("T8b — a newly created remote file is opened with no mode attr, leaving the server's umask in charge", async () => {
      await service.connect(testServer);
      fsPromisesMock.stat.mockResolvedValue({ size: 0 });
      fsCreateReadStream.mockImplementation(() => createMockReadStream([]));
      const remote = installRemoteWriteModel(sftp, 0o644);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(0)));

      await expect(service.upload("srv-1", "/tmp/empty.txt", "/remote/fresh.txt")).resolves.toBeUndefined();

      // Passing any explicit mode here would defeat the server's umask on
      // create, which fastPut (open with no attrs) never does.
      expect(remote.writes[0].options?.mode).toBeUndefined();
      expect(remote.modes.get("/remote/fresh.txt")).toBe(0o644);
    });

    it("T8c — a claimed-zero upload that keeps producing bytes is capped, naming the limit and the setting", async () => {
      await service.connect(testServer);
      (service as any).maxInMemoryTransferBytes = 1024;
      fsPromisesMock.stat.mockResolvedValue({ size: 0 });
      // /dev/zero: stats as 0, streams forever.
      fsCreateReadStream.mockImplementation(() => createMockReadStream([Buffer.alloc(4096)]));
      installRemoteWriteModel(sftp);
      // Present so that an UNBOUNDED implementation completes cleanly rather
      // than hanging on the verification stat — the flip-check must fail on the
      // missing cap, not on a fixture timeout.
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(4096)));

      await expect(service.upload("srv-1", "/dev/zero", "/remote/zero")).rejects.toThrow(
        /exceeds maximum size.*nexus\.sftp\.maxOpenFileSizeMB/s
      );
      expect(sftp.writeFile).not.toHaveBeenCalled();
    });

    it("T8d — a claimed-zero download that keeps producing bytes is capped and writes nothing locally", async () => {
      await service.connect(testServer);
      (service as any).maxInMemoryTransferBytes = 1024;
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(0)));
      sftp.createReadStream.mockImplementation(() => createMockReadStream([Buffer.alloc(4096)]));

      await expect(service.download("srv-1", "/dev/zero", "/tmp/zero")).rejects.toThrow(
        /exceeds maximum size.*nexus\.sftp\.maxOpenFileSizeMB/s
      );
      // Bounding TIME (the idle timeout) never bounded MEMORY; an extension-host
      // OOM takes every terminal session with it.
      expect(fsPromisesMock.writeFile).not.toHaveBeenCalled();
    });

    it("T8e — the in-memory cap is configurable and clamped", async () => {
      const configured = new SftpService(factory, {
        cacheTtlMs: 10_000,
        maxCacheEntries: 500,
        maxInMemoryTransferBytes: 20 * 1024 * 1024
      });
      expect((configured as any).maxInMemoryTransferBytes).toBe(20 * 1024 * 1024);

      configured.updateConfig({
        cacheTtlMs: 10_000,
        maxCacheEntries: 500,
        maxInMemoryTransferBytes: 5_000 * 1024 * 1024
      });
      expect((configured as any).maxInMemoryTransferBytes).toBe(200 * 1024 * 1024);
    });

    it("T9a — a download whose local size does not match the remote is reported as failed", async () => {
      await service.connect(testServer);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(5)));
      sftp.fastGet.mockImplementation((_r: string, _l: string, _o: unknown, cb: Function) => cb());
      fsPromisesMock.stat.mockResolvedValue({ size: 0 });

      await expect(service.download("srv-1", "/remote/five.txt", "/tmp/five.txt")).rejects.toThrow(
        /verification failed/
      );
    });

    it("T9b — a remote file whose stat claims zero bytes is streamed to EOF, not size-planned", async () => {
      await service.connect(testServer);
      sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(0)));
      sftp.createReadStream.mockImplementation(() => createMockReadStream([Buffer.from("actual")]));
      fsPromisesMock.stat.mockResolvedValue({ size: 6 });

      await expect(service.download("srv-1", "/proc/lying", "/tmp/lying")).resolves.toBeUndefined();

      expect(sftp.fastGet).not.toHaveBeenCalled();
      expect(fsPromisesMock.writeFile).toHaveBeenCalledWith("/tmp/lying", Buffer.from("actual"));
    });

    it("T10 — a Windows network source gets the throttled pipelining profile; a local disk keeps ssh2's default", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        await service.connect(testServer);
        fsPromisesMock.stat.mockResolvedValue({ size: 100 });
        sftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(100)));
        sftp.fastPut.mockImplementation((_l: string, _r: string, _o: unknown, cb: Function) => cb());

        await service.upload("srv-1", "\\\\nas\\share\\big.bin", "/remote/big.bin");
        expect(sftp.fastPut).toHaveBeenLastCalledWith(
          "\\\\nas\\share\\big.bin",
          "/remote/big.bin",
          expect.objectContaining({ concurrency: 8, chunkSize: 32768 }),
          expect.any(Function)
        );

        await service.upload("srv-1", "C:\\big.bin", "/remote/big.bin");
        expect(sftp.fastPut).toHaveBeenLastCalledWith(
          "C:\\big.bin",
          "/remote/big.bin",
          expect.objectContaining({ concurrency: 64, chunkSize: 32768 }),
          expect.any(Function)
        );
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    });
  });

  describe("T15 — blast-radius contract: a failed transfer never takes the shared connection down", () => {
    function createPooledFixture() {
      const innerSftp = createMockSftp();
      const innerConnection = createMockConnection(innerSftp);
      (innerConnection.openShell as ReturnType<typeof vi.fn>).mockResolvedValue({} as never);
      const pool = new SshConnectionPool(createMockFactory(innerConnection), {
        enabled: true,
        idleTimeoutMs: 60_000
      });
      return { innerSftp, innerConnection, pool };
    }

    // NOTE ON SCOPE: T15a covers the idle-timeout teardown ONLY. It says nothing
    // about the S2 mechanism (the local open that used to run on ssh2's socket
    // stack) — T15c does that. What T15a freezes is that the timeout path
    // releases the SFTP lease via `connection.dispose()` and never reaches for
    // `pool.disconnect()`, which would end a Client terminal tabs still hold.
    it("T15a — the idle-timeout teardown releases only the SFTP lease, not the pooled client a terminal holds", async () => {
      vi.useFakeTimers();
      const { innerSftp, innerConnection, pool } = createPooledFixture();
      try {
        const pooledService = new SftpService(pool);
        await pooledService.connect(testServer);
        // A second lease standing in for an open terminal tab.
        const terminalLease = await pool.connect(testServer);
        (pooledService as any).commandTimeoutMs = 50;
        fsPromisesMock.stat.mockResolvedValue({ size: 4096 });
        innerSftp.fastPut.mockImplementation(() => {
          /* never calls back — the stalled-SMB case */
        });

        const uploadPromise = pooledService.upload("srv-1", "/tmp/stalled.bin", "/remote/stalled.bin");
        const rejection = expect(uploadPromise).rejects.toThrow("SFTP upload timed out");
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60);
        await rejection;

        expect(pooledService.isConnected("srv-1")).toBe(false);
        // The SFTP lease was released; the underlying Client must survive.
        expect(innerConnection.dispose).not.toHaveBeenCalled();
        await expect(terminalLease.openShell()).resolves.toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("T15b — a fatal SFTP channel error drops only the SFTP session, not the terminal's lease", async () => {
      const { innerSftp, innerConnection, pool } = createPooledFixture();
      const pooledService = new SftpService(pool);
      await pooledService.connect(testServer);
      const terminalLease = await pool.connect(testServer);

      expect(() => innerSftp.emit("error", new Error("Malformed packet"))).not.toThrow();

      expect(pooledService.isConnected("srv-1")).toBe(false);
      expect(innerConnection.dispose).not.toHaveBeenCalled();
      await expect(terminalLease.openShell()).resolves.toBeDefined();
    });

    it("T15c — S2: a download into a blocked UNC destination fails as a rejection, and ssh2 never opens the path itself", async () => {
      const { innerSftp, innerConnection, pool } = createPooledFixture();
      const pooledService = new SftpService(pool);
      await pooledService.connect(testServer);
      const terminalLease = await pool.connect(testServer);

      innerSftp.stat.mockImplementation((_path: string, cb: Function) => cb(null, remoteStatsOfSize(100)));
      fsPromisesMock.open.mockRejectedValueOnce(uncAccessError("192.168.2.10"));
      // Stands in for what ssh2 really does: `fastGet` opens the local
      // destination from inside its remote open/fstat callback, which runs on
      // the net.Socket 'data' stack — so this throw would unwind the protocol
      // parser and destroy the Client every terminal tab multiplexes onto.
      innerSftp.fastGet.mockImplementation(() => {
        throw uncAccessError("192.168.2.10");
      });

      await expect(
        pooledService.download("srv-1", "/remote/f.bin", "\\\\192.168.2.10\\share\\f.bin")
      ).rejects.toMatchObject({ code: "ERR_UNC_HOST_NOT_ALLOWED" });

      // The load-bearing assertion: the pre-flight took the fault, so ssh2 was
      // never handed the path at all.
      expect(innerSftp.fastGet).not.toHaveBeenCalled();
      // A bad LOCAL path is not an SFTP fault — the session must survive it.
      expect(pooledService.isConnected("srv-1")).toBe(true);
      expect(innerConnection.dispose).not.toHaveBeenCalled();
      await expect(terminalLease.openShell()).resolves.toBeDefined();
    });

    it("T15d — a client-wide close releases the SFTP pool lease exactly once", async () => {
      const { innerSftp, innerConnection, pool } = createPooledFixture();
      let clientClose: (() => void) | undefined;
      (innerConnection.onClose as ReturnType<typeof vi.fn>).mockImplementation((listener: () => void) => {
        const previous = clientClose;
        clientClose = () => {
          previous?.();
          listener();
        };
        return () => {
          /* the pool's own unsubscribe is not exercised here */
        };
      });

      const pooledService = new SftpService(pool);
      await pooledService.connect(testServer);
      const terminalLease = await pool.connect(testServer);

      // The whole SSH client dropped (network loss, server restart).
      clientClose?.();

      expect(pooledService.isConnected("srv-1")).toBe(false);
      // Before the fix this only deleted the map entry: `connection.dispose()`
      // never ran, so the pool held the SFTP refcount forever and the entry
      // could never reach orphan cleanup once the terminals released theirs.
      terminalLease.dispose();
      expect(innerConnection.dispose).toHaveBeenCalledTimes(1);

      // …and never twice: a second decrement would end a Client other tabs hold.
      innerSftp.emit("close");
      pooledService.disconnect("srv-1");
      expect(innerConnection.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("execCommand (private, tested via copyRemote)", () => {
    const tick = () => new Promise((r) => process.nextTick(r));

    it("collects stdout/stderr/exitCode through copyRemote", async () => {
      const { PassThrough } = await import("node:stream");
      // emitClose/autoDestroy: false everywhere in this file's exec-stream doubles,
      // matching ssh2's own WriteStream guard (SFTP.js) — a bare PassThrough
      // auto-emits "close" ~1 tick after end(), but a real ssh2 exec channel's
      // "close" instead reflects the remote process's exit-status message,
      // independent of when the local writable side is ended. execCommand always
      // ends the stream's stdin now (sudo -S needs EOF to fail fast rather than
      // hang); without this option the fixture's own auto-close would race the
      // exit code these tests emit manually below.
      const stdout = new PassThrough({ emitClose: false, autoDestroy: false });
      const stderr = new PassThrough({ emitClose: false, autoDestroy: false });
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
      const stdout = new PassThrough({ emitClose: false, autoDestroy: false });
      const stderr = new PassThrough({ emitClose: false, autoDestroy: false });
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
      const stdout = new PassThrough({ emitClose: false, autoDestroy: false });
      const stderr = new PassThrough({ emitClose: false, autoDestroy: false });
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
      const stdout = new PassThrough({ emitClose: false, autoDestroy: false });
      const stderr = new PassThrough({ emitClose: false, autoDestroy: false });
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
      const stdout = new PassThrough({ emitClose: false, autoDestroy: false });
      const stderr = new PassThrough({ emitClose: false, autoDestroy: false });
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
      const stdout = new PassThrough({ emitClose: false, autoDestroy: false });
      const stderr = new PassThrough({ emitClose: false, autoDestroy: false });
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
      const stdout = new PassThrough({ emitClose: false, autoDestroy: false });
      const stderr = new PassThrough({ emitClose: false, autoDestroy: false });
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
