import { describe, expect, it, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SshConnection } from "../../src/services/ssh/contracts";

// Mock fs/promises before importing module under test
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { access, readdir, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { findLocalKeyPairs, generateKeyPair, execRemoteCommand, deployPublicKeyToRemote } from "../../src/services/ssh/deploySshKey";

function makeEnoentError(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function mockSshKeygenProcess(exitCode: number, stderr = ""): {
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as any;
  child.stderr = new PassThrough();
  const kill = vi.fn();
  child.kill = kill;
  vi.mocked(spawn).mockReturnValue(child);

  process.nextTick(() => {
    if (stderr) {
      child.stderr.push(stderr);
    }
    child.stderr.push(null);
    child.emit("close", exitCode);
  });

  return { kill };
}

describe("findLocalKeyPairs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("discovers ed25519 and rsa key pairs", async () => {
    vi.mocked(readdir).mockResolvedValue([
      "id_ed25519", "id_ed25519.pub",
      "id_rsa", "id_rsa.pub",
      "known_hosts", "config",
    ] as any);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("id_ed25519");
    expect(result[0].publicKeyPath).toBe(path.join("/home/user/.ssh", "id_ed25519.pub"));
    expect(result[1].name).toBe("id_rsa");
  });

  it("returns empty array when .ssh dir does not exist", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(readdir).mockRejectedValue(err);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result).toEqual([]);
  });

  it("sorts ed25519 keys first", async () => {
    vi.mocked(readdir).mockResolvedValue([
      "id_rsa", "id_rsa.pub",
      "id_ecdsa", "id_ecdsa.pub",
      "id_ed25519", "id_ed25519.pub",
    ] as any);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result[0].name).toBe("id_ed25519");
  });

  it("re-throws non-ENOENT errors", async () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.mocked(readdir).mockRejectedValue(err);

    await expect(findLocalKeyPairs("/home/user/.ssh")).rejects.toThrow("EACCES");
  });

  it("only returns pairs where both private and .pub exist", async () => {
    vi.mocked(readdir).mockResolvedValue([
      "id_ed25519",       // no .pub
      "id_rsa.pub",       // no private
      "id_ecdsa", "id_ecdsa.pub",
    ] as any);

    const result = await findLocalKeyPairs("/home/user/.ssh");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("id_ecdsa");
  });
});

describe("generateKeyPair", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access).mockRejectedValue(makeEnoentError());
  });

  it("passes passphrase via -N flag", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    mockSshKeygenProcess(0);

    const result = await generateKeyPair({
      sshDir: "/home/user/.ssh",
      name: "id_ed25519",
      passphrase: "my-secret",
    });

    const resolvedSshDir = path.resolve("/home/user/.ssh");
    const resolvedKeyPath = path.join(resolvedSshDir, "id_ed25519");
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ["-q", "-t", "ed25519", "-f", resolvedKeyPath, "-N", "my-secret", "-C", "nexus-terminal"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    expect(result.privateKeyPath).toBe(resolvedKeyPath);
    expect(result.publicKeyPath).toBe(`${resolvedKeyPath}.pub`);
  });

  it("passes empty -N flag for no passphrase", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    mockSshKeygenProcess(0);

    await generateKeyPair({
      sshDir: "/home/user/.ssh",
      name: "id_ed25519",
      passphrase: "",
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["-N", ""]),
      expect.any(Object),
    );
  });

  it("creates .ssh directory with mode 700 if missing", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    mockSshKeygenProcess(0);

    await generateKeyPair({
      sshDir: "/home/user/.ssh",
      name: "id_ed25519",
      passphrase: "",
    });

    expect(mkdir).toHaveBeenCalledWith(path.resolve("/home/user/.ssh"), { recursive: true, mode: 0o700 });
  });

  it("throws when key name is invalid", async () => {
    await expect(
      generateKeyPair({ sshDir: "/home/user/.ssh", name: "../bad", passphrase: "" })
    ).rejects.toThrow("invalid characters");
  });

  it("throws when passphrase contains newlines", async () => {
    await expect(
      generateKeyPair({ sshDir: "/home/user/.ssh", name: "id_ed25519", passphrase: "line1\nline2" })
    ).rejects.toThrow("Passphrase cannot contain newlines");
  });

  it("throws when key path already exists", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(access).mockResolvedValue(undefined);

    await expect(
      generateKeyPair({ sshDir: "/home/user/.ssh", name: "id_ed25519", passphrase: "" })
    ).rejects.toThrow("Key already exists");
  });

  it("throws on ssh-keygen non-zero exit", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    mockSshKeygenProcess(1, "permission denied");

    await expect(
      generateKeyPair({ sshDir: "/home/user/.ssh", name: "id_ed25519", passphrase: "" })
    ).rejects.toThrow("ssh-keygen failed");
  });
});

function mockConnection(responses: Array<{ stdout: string; stderr?: string; exitCode: number }>): SshConnection {
  let callIdx = 0;
  return {
    exec: vi.fn(async () => {
      const resp = responses[callIdx++] ?? { stdout: "", stderr: "", exitCode: 0 };
      const stream = new PassThrough() as any;
      stream.stderr = new PassThrough();
      process.nextTick(() => {
        stream.push(resp.stdout);
        stream.push(null);
        if (resp.stderr) {
          stream.stderr.push(resp.stderr);
        }
        stream.stderr.push(null);
        stream.emit("exit", resp.exitCode);
      });
      return stream;
    }),
    openShell: vi.fn(),
    openDirectTcp: vi.fn(),
    openSftp: vi.fn(),
    requestForwardIn: vi.fn(),
    cancelForwardIn: vi.fn(),
    onTcpConnection: vi.fn().mockReturnValue(() => {}),
    onClose: vi.fn().mockReturnValue(() => {}),
    getBanner: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("execRemoteCommand", () => {
  it("collects stdout, stderr, and exit code", async () => {
    const conn = mockConnection([{ stdout: "hello\n", stderr: "warn\n", exitCode: 0 }]);
    const result = await execRemoteCommand(conn, "echo hello");
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exit code", async () => {
    const conn = mockConnection([{ stdout: "", exitCode: 1 }]);
    const result = await execRemoteCommand(conn, "false");
    expect(result.exitCode).toBe(1);
  });
});

describe("deployPublicKeyToRemote", () => {
  it("creates .ssh dir and appends key", async () => {
    const conn = mockConnection([
      { stdout: "", exitCode: 0 },  // mkdir
      { stdout: "", exitCode: 1 },  // grep (not found)
      { stdout: "", exitCode: 0 },  // append
    ]);

    const result = await deployPublicKeyToRemote(conn, "ssh-ed25519 AAAA comment");
    expect(result.alreadyDeployed).toBe(false);
    expect(conn.exec).toHaveBeenCalledTimes(3);
  });

  it("detects already-deployed key", async () => {
    const conn = mockConnection([
      { stdout: "", exitCode: 0 },  // mkdir
      { stdout: "ssh-ed25519 AAAA comment", exitCode: 0 },  // grep (found)
    ]);

    const result = await deployPublicKeyToRemote(conn, "ssh-ed25519 AAAA comment");
    expect(result.alreadyDeployed).toBe(true);
    expect(conn.exec).toHaveBeenCalledTimes(2);
  });

  it("throws when mkdir fails", async () => {
    const conn = mockConnection([
      { stdout: "", stderr: "permission denied", exitCode: 1 },
    ]);

    await expect(deployPublicKeyToRemote(conn, "ssh-ed25519 AAAA comment"))
      .rejects.toThrow();
  });

  it("throws when append fails", async () => {
    const conn = mockConnection([
      { stdout: "", exitCode: 0 },  // mkdir
      { stdout: "", exitCode: 1 },  // grep (not found)
      { stdout: "", stderr: "disk full", exitCode: 1 },  // append
    ]);

    await expect(deployPublicKeyToRemote(conn, "ssh-ed25519 AAAA comment"))
      .rejects.toThrow("Failed to deploy key");
  });

  it("throws on empty public key content", async () => {
    const conn = mockConnection([]);
    await expect(deployPublicKeyToRemote(conn, "")).rejects.toThrow("Public key content is empty");
    await expect(deployPublicKeyToRemote(conn, "   ")).rejects.toThrow("Public key content is empty");
  });

  it("rejects multi-line key content to prevent heredoc break-out", async () => {
    const conn = mockConnection([]);
    await expect(
      deployPublicKeyToRemote(conn, "ssh-ed25519 AAAA comment\nNEXUS_KEY_EOF\nrm -rf /")
    ).rejects.toThrow("single line");
  });

  it("rejects invalid public key format", async () => {
    const conn = mockConnection([]);
    await expect(deployPublicKeyToRemote(conn, "not-a-valid-public-key")).rejects.toThrow("format is invalid");
  });
});
