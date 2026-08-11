import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SFTPWrapper } from "ssh2";

import { SftpService } from "../../src/services/sftp/sftpService";
import type { SshConnection, SshFactory } from "../../src/services/ssh/contracts";
import type { ServerConfig } from "../../src/models/config";

/**
 * REAL FILESYSTEM. Everything else in the SFTP suite mocks `node:fs`, which is
 * exactly why the symlink defect this file guards survived: a mock cannot model
 * the difference between `stat` (follows the link) and `lstat` (does not), nor
 * what `open(path,'a')` does to a link's missing target. Only the remote side
 * is a double here; the destination is a genuine path in a temp directory.
 */

const testServer: ServerConfig = {
  id: "srv-1",
  name: "Test Server",
  host: "example.com",
  port: 22,
  username: "dev",
  authType: "password",
  isHidden: false
};

type MockSftp = EventEmitter & {
  stat: ReturnType<typeof vi.fn>;
  fastGet: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function createMockSftp(): MockSftp {
  return Object.assign(new EventEmitter(), {
    stat: vi.fn(),
    fastGet: vi.fn(),
    end: vi.fn()
  }) as MockSftp;
}

function createFactory(sftp: MockSftp): SshFactory {
  const connection: SshConnection = {
    openShell: vi.fn(),
    openDirectTcp: vi.fn(),
    openSftp: vi.fn(async () => sftp as unknown as SFTPWrapper),
    exec: vi.fn(),
    requestForwardIn: vi.fn(),
    cancelForwardIn: vi.fn(),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    getBanner: vi.fn(() => undefined),
    dispose: vi.fn()
  } as unknown as SshConnection;
  return { connect: vi.fn(async () => connection) } as unknown as SshFactory;
}

describe("SFTP download destination (real filesystem)", () => {
  let workDir: string;
  let sftp: MockSftp;
  let service: SftpService;

  beforeEach(async () => {
    workDir = await fsp.mkdtemp(path.join(tmpdir(), "nexus-sftp-dest-"));
    sftp = createMockSftp();
    service = new SftpService(createFactory(sftp));
    await service.connect(testServer);
    // A healthy, size-planned remote file for every case below.
    sftp.stat.mockImplementation((_p: string, cb: Function) =>
      cb(null, { mode: 0o100644, size: 4096, mtime: 1700000000 })
    );
  });

  afterEach(async () => {
    service.disconnect("srv-1");
    await fsp.rm(workDir, { recursive: true, force: true });
  });

  it("T4g — a failed download leaves a DANGLING symlink destination exactly as it found it", async () => {
    const link = path.join(workDir, "link-to-nowhere");
    const target = path.join(workDir, "absent-target.bin");
    await fsp.symlink(target, link);

    // The transfer fails after the pre-flight, which is the only moment the old
    // placeholder cleanup ever ran.
    sftp.fastGet.mockImplementation((_r: string, _l: string, _o: unknown, cb: Function) =>
      cb(new Error("connection lost"))
    );

    await expect(service.download("srv-1", "/remote/f.bin", link)).rejects.toThrow("connection lost");

    // The user's symlink is still a symlink, still pointing where it did. The
    // pre-flight that opened with 'a' resolved the link, created the target,
    // then — seeing a zero-length file where `stat` had reported ENOENT —
    // unlinked the LINK, destroying it and stranding the target it had made.
    const after = await fsp.lstat(link);
    expect(after.isSymbolicLink()).toBe(true);
    expect(await fsp.readlink(link)).toBe(target);
    await expect(fsp.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("T4h — a download into a path that did not exist creates nothing before ssh2 does", async () => {
    const dest = path.join(workDir, "brand-new.bin");
    // Sampled at the ONE instant that distinguishes "never created" from
    // "created, then cleaned up": ssh2 has been handed the transfer and has not
    // yet opened anything itself. A pre-flight that opens with 'a' has a
    // zero-byte file sitting here by now; a pre-flight that only reads metadata
    // does not. Asserting on the end state alone cannot tell the two apart —
    // the placeholder implementation deleted its own file and looked identical.
    let existedWhenSsh2TookOver: boolean | undefined;
    sftp.fastGet.mockImplementation(async (_r: string, _l: string, _o: unknown, cb: Function) => {
      existedWhenSsh2TookOver = await fsp
        .lstat(dest)
        .then(() => true)
        .catch(() => false);
      cb(new Error("connection lost"));
    });

    await expect(service.download("srv-1", "/remote/f.bin", dest)).rejects.toThrow("connection lost");

    expect(existedWhenSsh2TookOver).toBe(false);
    // And nothing is left behind either, without a cleanup step whose
    // stat-then-unlink TOCTOU could delete somebody else's bytes.
    await expect(fsp.lstat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Guards the ORIGINAL defect rather than the placeholder one: a pre-flight
  // that opened with 'w' emptied this file before ssh2 had so much as asked the
  // server for the remote one. Swap `lstat` for `fsp.open(localPath, "w")` and
  // this test fails; the 'a' placeholder passes it, which is why the symlink
  // case above exists separately.
  it("T4i — a failed download leaves an EXISTING destination byte-for-byte intact", async () => {
    const dest = path.join(workDir, "precious.bin");
    await fsp.writeFile(dest, "the user's only copy");
    sftp.fastGet.mockImplementation((_r: string, _l: string, _o: unknown, cb: Function) =>
      cb(new Error("connection lost"))
    );

    await expect(service.download("srv-1", "/remote/f.bin", dest)).rejects.toThrow("connection lost");

    expect(await fsp.readFile(dest, "utf8")).toBe("the user's only copy");
  });
});
