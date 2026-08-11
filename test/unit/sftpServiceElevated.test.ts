import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
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
// Composed over a real EventEmitter: SftpService attaches 'error'/'close'
// listeners to the SFTP channel so a fatal protocol error is contained instead
// of throwing through ssh2's socket-data stack.
function createMockSftp() {
  return Object.assign(new EventEmitter(), {
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
  });
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

/**
 * How the staged write is answered. Modelled on ssh2 1.17.0
 * `lib/protocol/SFTP.js`, verified by driving the real `WriteStream` through a
 * stubbed SFTP on the Node 20 the extension host runs.
 */
type FakeWriteBehaviour =
  /** Server ACKs the WRITE, then the handle closes cleanly. */
  | { kind: "accept" }
  /** `_write` (:3970): `this.destroy()` WITHOUT the error, and only THEN `cb(er)`. */
  | { kind: "refuse"; error: Error }
  /** The WRITE is never answered at all, yet the handle still closes cleanly. */
  | { kind: "silent" }
  /** Nothing is ever answered — a wedged channel, for the timeout path. */
  | { kind: "stall" };

/**
 * A double for ssh2's SFTP WriteStream, modelling how it REPORTS each outcome.
 *
 * The load-bearing detail: an accepted write and a refused one emit the exact same
 * event — a single 'close'. On refusal `_write` destroys the stream without the
 * error, so node's `errorOrDestroy` never emits 'error', while `closeStream`
 * (:3807) still emits 'close' because the SSH_FXP_CLOSE itself succeeded. Only the
 * `write(chunk, cb)` callback tells the two apart, which is what makes the
 * refused-write test below non-vacuous.
 *
 * 'finish' is deliberately never emitted, on any path: `_final` (:3887) calls
 * `destroy()` BEFORE its callback, so node's `needFinish()` is false and
 * `writableFinished` stays false even after a write that moved every byte.
 */
function createFakeWriteStream(behaviour: FakeWriteBehaviour = { kind: "accept" }) {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const emitted: string[] = [];
  const written: Buffer[] = [];
  let destroyed = false;

  const emit = (event: string, arg?: Error): void => {
    emitted.push(event);
    for (const handler of handlers.get(event) ?? []) {
      handler(arg);
    }
  };
  /** closeStream (:3807): 'close' is emitted only when the close carried no error. */
  const closeStream = (error?: Error): void => {
    if (destroyed) {
      return; // node's destroy() is a no-op once the stream is destroyed
    }
    destroyed = true;
    queueMicrotask(() => emit(error ? "error" : "close", error));
  };

  const stream = {
    emitted,
    written,
    on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return stream;
    }),
    write: vi.fn((chunk: Buffer, callback: (error?: Error | null) => void) => {
      queueMicrotask(() => {
        if (behaviour.kind === "stall" || behaviour.kind === "silent") {
          return; // WRITE sent, reply never comes
        }
        if (behaviour.kind === "refuse") {
          closeStream();
          callback(behaviour.error);
          return;
        }
        written.push(chunk);
        callback(null);
      });
      return true;
    }),
    end: vi.fn(() => {
      // _final → destroy() → closeStream, one hop behind the write reply: the real
      // stream only finalizes once the write it is waiting on has come back.
      queueMicrotask(() => {
        if (behaviour.kind !== "stall") {
          closeStream();
        }
      });
      return stream;
    }),
    destroy: vi.fn((error?: Error) => {
      closeStream(error);
      return stream;
    }),
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
    // No password supplied here — this is the non-interactive optimistic attempt
    // (Codex round 6 finding 2), so sudo gets -n, not -S.
    expect(capturedCommand).toContain("sudo -n -p ''");
    // Existence is decided by the remote shell, not a pre-resolved boolean — the
    // command is identical whether the caller thinks the target exists or not.
    expect(capturedCommand).toBe(buildSudoInstallCommand(expectedTempPath, "/etc/hosts", undefined, false));
  });

  it("does not probe the target's existence before staging: closing that window is the point (Codex round 4 finding A — even the in-shell `[ -e ]` check still raced the redirect; umask alone decides the outcome now)", async () => {
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
    expect(capturedCommand).not.toContain("[ -e");
    expect(capturedCommand).toMatch(/umask \d+; cat < .*\/etc\/hosts/);
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

  it("defaults the shell umask to 022 (createMode 644) when the caller supplies no createMode (the shell — not a pre-resolved stat — decides at install time whether the file is created at all)", async () => {
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
    expect(capturedCommand).toContain("umask 22");
  });

  it("uses the caller-supplied createMode instead of 644 to derive the shell umask (P3: preserves a vanished target's prior mode)", async () => {
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

    expect(capturedCommand).toContain("umask 26");
    expect(capturedCommand).not.toContain("umask 22");
  });

  // THE defect on this path, and it bites harder here than on an ordinary save:
  // the staged file is handed to sudo, which moves it over a root-owned target,
  // and nothing anywhere on the path verifies its size. A staging write the server
  // refused emitted 'close' and nothing else — the same single event a clean write
  // emits — so 'close' as the success signal meant sudo overwrote /etc/hosts with
  // an empty file and the save was reported as having worked.
  it("a staging write the server refuses fails the save instead of sudo-installing a truncated file", async () => {
    const writeStream = createFakeWriteStream({
      kind: "refuse",
      error: Object.assign(new Error("No space left on device"), { code: 4 }),
    });
    sftp.createWriteStream.mockReturnValue(writeStream);
    let unlinkedPath: string | undefined;
    sftp.unlink.mockImplementation((remotePath: string, cb: (err?: Error) => void) => {
      unlinkedPath = remotePath;
      cb();
    });
    // A sudo install that WOULD succeed if it were ever reached: without it the
    // flip-check would fail on an unstubbed exec rather than on the save being
    // reported as having worked.
    const execStream = createExecStream();
    (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(execStream);

    const promise = service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));
    await flush();
    execStream.emit("close", 0);

    await expect(promise).rejects.toThrow(/rejected the write \(No space left on device\)/);

    // The stream emitted the success-shaped event trace anyway — that is the
    // point, and the reason a 'close' listener could not tell the difference.
    expect(writeStream.emitted).toEqual(["close"]);
    expect(writeStream.written).toHaveLength(0);
    // Decisive: sudo must never run, or a truncated temp file lands on the target.
    expect(connection.exec).not.toHaveBeenCalled();
    // ...and the staged file is still cleaned up.
    expect(unlinkedPath).toBe(expectedTempPath);
  });

  // The inverse invariant, stated on its own: a clean SSH_FXP_CLOSE is evidence
  // about the HANDLE, never about the data. Unreachable through ssh2's own paths,
  // and deliberately so — an unexplained close must fail loudly rather than be
  // assumed to have written something.
  it("a handle that closes cleanly without the data ever being acknowledged is a failure, not a save", async () => {
    const writeStream = createFakeWriteStream({ kind: "silent" });
    sftp.createWriteStream.mockReturnValue(writeStream);
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());
    const execStream = createExecStream();
    (connection.exec as ReturnType<typeof vi.fn>).mockResolvedValue(execStream);

    const promise = service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));
    await flush();
    execStream.emit("close", 0);

    await expect(promise).rejects.toThrow(/closed before the server acknowledged the data/);

    expect(writeStream.emitted).toEqual(["close"]);
    expect(connection.exec).not.toHaveBeenCalled();
  });

  // A wedged channel must still be reported as the timeout it is — the
  // acknowledgement gate above must not swallow it into a generic "did not
  // complete", which would hide that the write was aborted rather than refused.
  it("a staging write that is never answered fails as a timeout", async () => {
    (service as any).commandTimeoutMs = 50;
    const writeStream = createFakeWriteStream({ kind: "stall" });
    sftp.createWriteStream.mockReturnValue(writeStream);
    let unlinkedPath: string | undefined;
    sftp.unlink.mockImplementation((remotePath: string, cb: (err?: Error) => void) => {
      unlinkedPath = remotePath;
      cb();
    });

    await expect(service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"))).rejects.toThrow(
      "SFTP writeFile timed out"
    );

    expect(writeStream.destroy).toHaveBeenCalledWith(expect.any(Error));
    expect(connection.exec).not.toHaveBeenCalled();
    expect(unlinkedPath).toBe(expectedTempPath);
  });

  it("writeFileElevated installs via sudo using the operation timeout, not the default command timeout", async () => {
    sftp.createWriteStream.mockReturnValue(createFakeWriteStream());
    sftp.unlink.mockImplementation((_remotePath: string, cb: (err?: Error) => void) => cb());
    const execSpy = vi.spyOn(service as any, "execCommand").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await service.writeFileElevated("srv-1", "/etc/hosts", Buffer.from("hi"));

    const operationTimeoutMs = (service as any).operationTimeoutMs;
    expect(execSpy).toHaveBeenCalledWith(
      "srv-1",
      expect.stringContaining("sudo -n -p ''"),
      operationTimeoutMs,
      undefined
    );
  });
});
