import { describe, expect, it, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { SftpService } from "../../src/services/sftp/sftpService";
import { buildSudoInstallCommand, buildTempStagePath } from "../../src/services/sftp/elevatedWrite";
import type { SshConnection, SshFactory } from "../../src/services/ssh/contracts";
import type { ServerConfig } from "../../src/models/config";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => "test-token" };
});

const testServer: ServerConfig = {
  id: "srv-1",
  name: "Test Server",
  host: "example.com",
  port: 22,
  username: "dev",
  authType: "password",
  isHidden: false,
};

// No `chmod` entry here: the elevated write path sets the temp file's mode at
// SSH_FXP_OPEN time via createWriteStream's `mode` option, not a separate chmod call.
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

/** A fake SFTP write stream whose "close" listener fires synchronously from end(). */
function createFakeWriteStream() {
  let closeHandler: (() => void) | undefined;
  const stream = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "close") {
        closeHandler = handler;
      }
      return stream;
    }),
    end: vi.fn(() => {
      closeHandler?.();
    }),
    destroy: vi.fn(),
  };
  return stream;
}

function createExecStream(): PassThrough & { stderr: PassThrough } {
  // emitClose/autoDestroy: false — matches ssh2's own WriteStream guard (SFTP.js). A
  // bare PassThrough auto-emits "close" ~1 tick after end(), but a real ssh2 exec
  // channel's "close" instead reflects the remote process's exit-status message,
  // independent of when the local writable side is ended. execCommand always ends
  // the stream now (sudo -S needs EOF to fail fast on a stale probe), so without this
  // the fixture's own auto-close would race the exit code these tests emit manually.
  const options = { emitClose: false, autoDestroy: false };
  const stdout = new PassThrough(options);
  const stderr = new PassThrough(options);
  return Object.assign(stdout, { stderr });
}

/** Drains several microtask hops — writeFileElevated chains multiple awaits (tryStat,
 * writeFileWithTimeout, execCommand) before reaching the exec call under test. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("SftpService elevated writes", () => {
  let sftp: ReturnType<typeof createMockSftp>;
  let connection: SshConnection;
  let factory: SshFactory;
  let service: SftpService;
  const expectedTempPath = buildTempStagePath("test-token");

  beforeEach(async () => {
    sftp = createMockSftp();
    connection = createMockConnection(sftp);
    factory = createMockFactory(connection);
    service = new SftpService(factory);
    await service.connect(testServer);
  });

  it("stages to /tmp with mode 0600, sudo-installs through the existing inode, then removes the temp file", async () => {
    const order: string[] = [];
    const writeStream = createFakeWriteStream();
    sftp.createWriteStream.mockImplementation((remotePath: string, options: { mode?: number }) => {
      order.push(`write:${remotePath}:${options?.mode?.toString(8)}`);
      return writeStream;
    });
    sftp.unlink.mockImplementation((remotePath: string, cb: (err?: Error) => void) => {
      order.push(`unlink:${remotePath}`);
      cb();
    });

    let capturedCommand = "";
    const execStream = createExecStream();
    (connection.exec as ReturnType<typeof vi.fn>).mockImplementation((command: string) => {
      capturedCommand = command;
      order.push("sudo-install");
      return Promise.resolve(execStream);
    });

    const promise = service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));
    await flush();
    execStream.emit("close", 0);
    await promise;

    expect(order).toEqual([`write:${expectedTempPath}:600`, "sudo-install", `unlink:${expectedTempPath}`]);
    expect(capturedCommand).toContain("sudo -S -p ''");
    // Existence is decided by the remote shell, not a pre-resolved boolean — the
    // command is identical whether the caller thinks the target exists or not.
    expect(capturedCommand).toBe(buildSudoInstallCommand(expectedTempPath, "/etc/hosts"));
  });

  it("does not probe the target's existence before staging: closing that window is the point (Codex finding 1 — the old stat-then-upload gap let a deleted/rotated target lose its chmod)", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());

    let capturedCommand = "";
    const execStream = createExecStream();
    (connection.exec as ReturnType<typeof vi.fn>).mockImplementation((command: string) => {
      capturedCommand = command;
      return Promise.resolve(execStream);
    });

    const promise = service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));
    await flush();
    execStream.emit("close", 0);
    await promise;

    expect(sftp.stat).not.toHaveBeenCalled();
    expect(sftp.lstat).not.toHaveBeenCalled();
    expect(capturedCommand).toMatch(/if \[ -e [^\]]*\/etc\/hosts[^\]]*\]; then cat < /);
  });

  it("removes the temp file even when the sudo install fails", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    let unlinkedPath: string | undefined;
    sftp.unlink.mockImplementation((remotePath: string, cb: (err?: Error) => void) => {
      unlinkedPath = remotePath;
      cb();
    });

    const execStream = createExecStream();
    (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(execStream);

    const promise = service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));
    await flush();
    execStream.stderr.write("nexus is not in the sudoers file.\n");
    execStream.emit("close", 1);

    await expect(promise).rejects.toThrow(/not permitted to run sudo/i);
    expect(unlinkedPath).toBe(expectedTempPath);
  });

  it("pipes the sudo password on stdin to the exec channel", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());

    const execStream = createExecStream();
    const writeSpy = vi.spyOn(execStream, "write");
    (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(execStream);

    const promise = service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"), { password: "s3cret" });
    await flush();
    execStream.emit("close", 0);
    await promise;

    expect(writeSpy).toHaveBeenCalledWith("s3cret\n");
  });

  it("closes the exec channel's stdin even when no password is supplied", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());

    const execStream = createExecStream();
    const writeSpy = vi.spyOn(execStream, "write");
    const endSpy = vi.spyOn(execStream, "end");
    (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(execStream);

    const promise = service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));
    await flush();
    execStream.emit("close", 0);
    await promise;

    expect(writeSpy).not.toHaveBeenCalled();
    expect(endSpy).toHaveBeenCalled();
  });

  it("defaults the create-branch chmod to 644 when the caller supplies no createMode (the shell — not a pre-resolved stat — decides at install time whether that branch even runs)", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());

    let capturedCommand = "";
    const execStream = createExecStream();
    (connection.exec as ReturnType<typeof vi.fn>).mockImplementation((command: string) => {
      capturedCommand = command;
      return Promise.resolve(execStream);
    });

    const promise = service.writeFileElevated("srv-1", "/etc/new.conf", Buffer.from("hi"));
    await flush();
    execStream.emit("close", 0);
    await promise;

    expect(sftp.stat).not.toHaveBeenCalled();
    expect(sftp.lstat).not.toHaveBeenCalled();
    expect(capturedCommand).toContain("chmod 644");
  });

  it("uses the caller-supplied createMode instead of 644 for the create branch (P3: preserves a vanished target's prior mode)", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());

    let capturedCommand = "";
    const execStream = createExecStream();
    (connection.exec as ReturnType<typeof vi.fn>).mockImplementation((command: string) => {
      capturedCommand = command;
      return Promise.resolve(execStream);
    });

    const promise = service.writeFileElevated("srv-1", "/etc/rotated.log", Buffer.from("hi"), { createMode: 0o640 });
    await flush();
    execStream.emit("close", 0);
    await promise;

    expect(capturedCommand).toContain("chmod 640");
    expect(capturedCommand).not.toContain("chmod 644");
  });

  it("probeElevation runs sudo -n -v using the operation timeout, not the default command timeout", async () => {
    const execSpy = vi.spyOn(service as any, "execCommand").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await expect(service.probeElevation("srv-1")).resolves.toEqual({ kind: "none" });

    const operationTimeoutMs = (service as any).operationTimeoutMs;
    const commandTimeoutMs = (service as any).commandTimeoutMs;
    expect(operationTimeoutMs).not.toBe(commandTimeoutMs);
    expect(execSpy).toHaveBeenCalledWith("srv-1", "sudo -n -v", operationTimeoutMs, undefined);
  });

  it("writeFileElevated installs via sudo using the operation timeout, not the default command timeout", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());
    const execSpy = vi.spyOn(service as any, "execCommand").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));

    const operationTimeoutMs = (service as any).operationTimeoutMs;
    expect(execSpy).toHaveBeenCalledWith(
      "srv-1",
      expect.stringContaining("sudo -S -p ''"),
      operationTimeoutMs,
      undefined
    );
  });
});
