import { access, readdir, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import type { SshConnection } from "./contracts";

export interface KeyPairInfo {
  name: string;
  publicKeyPath: string;
  privateKeyPath: string;
}

// Ordered by preference: ed25519 first. Iteration order = sort order.
const KEY_PREFIXES = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];
const KEY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PUBLIC_KEY_PATTERN = /^(?<type>ssh-(?:ed25519|rsa)|ecdsa-sha2-[A-Za-z0-9-]+)\s+(?<base64>[A-Za-z0-9+/=]+)(?:\s+[^\r\n]*)?$/;
const SSH_KEYGEN_TIMEOUT_MS = 30_000;

export function defaultSshDir(): string {
  return path.join(os.homedir(), ".ssh");
}

export async function findLocalKeyPairs(sshDir: string): Promise<KeyPairInfo[]> {
  let entries: string[];
  try {
    entries = (await readdir(sshDir)).map(String);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  const fileSet = new Set(entries);
  const pairs: KeyPairInfo[] = [];

  for (const prefix of KEY_PREFIXES) {
    if (fileSet.has(prefix) && fileSet.has(`${prefix}.pub`)) {
      pairs.push({
        name: prefix,
        privateKeyPath: path.join(sshDir, prefix),
        publicKeyPath: path.join(sshDir, `${prefix}.pub`),
      });
    }
  }

  return pairs;
}

export interface GenerateKeyPairOptions {
  sshDir: string;
  name: string;
  passphrase: string;
}

export interface GeneratedKeyPairPaths {
  publicKeyPath: string;
  privateKeyPath: string;
}

function findSshKeygen(): string {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe";
  }
  return "ssh-keygen";
}

function normalizeKeyName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Key name cannot be empty");
  }
  if (!KEY_NAME_PATTERN.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error("Key name contains invalid characters");
  }
  return trimmed;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// ssh-keygen reads passphrases from /dev/tty, not stdin, so we must use the -N flag.
async function runSshKeygen(binary: string, keyPath: string, passphrase: string): Promise<void> {
  const args = ["-q", "-t", "ed25519", "-f", keyPath, "-N", passphrase, "-C", "nexus-terminal"];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error("ssh-keygen timed out"));
    }, SSH_KEYGEN_TIMEOUT_MS);

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    child.on("error", (error) => {
      finish(new Error(`Failed to run ssh-keygen: ${error.message}`));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        finish();
        return;
      }
      finish(new Error(`ssh-keygen failed: ${(stderr || `exit code ${exitCode ?? "unknown"}`).trim()}`));
    });
  });
}

export async function generateKeyPair(options: GenerateKeyPairOptions): Promise<GeneratedKeyPairPaths> {
  if (/[\r\n]/.test(options.passphrase)) {
    throw new Error("Passphrase cannot contain newlines");
  }
  const sshDir = path.resolve(options.sshDir);
  const keyName = normalizeKeyName(options.name);
  await mkdir(sshDir, { recursive: true, mode: 0o700 });

  const keyPath = path.join(sshDir, keyName);
  const publicKeyPath = `${keyPath}.pub`;
  if ((await pathExists(keyPath)) || (await pathExists(publicKeyPath))) {
    throw new Error(`Key already exists: ${keyName}`);
  }

  await runSshKeygen(findSshKeygen(), keyPath, options.passphrase);

  return { publicKeyPath, privateKeyPath: keyPath };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a command on a remote SSH connection and collect stdout, stderr, and exit code.
 * Note: This uses SshConnection.exec() (SSH channel), not child_process.exec().
 */
export async function execRemoteCommand(connection: SshConnection, command: string): Promise<ExecResult> {
  const stream = await connection.exec(command);
  return new Promise<ExecResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let exitCode: number | undefined;
    const appendChunk = (target: Buffer[], chunk: Buffer | string): void => {
      target.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    };

    stream.on("data", (chunk: Buffer | string) => appendChunk(stdoutChunks, chunk));
    const stderrStream = (stream as any).stderr;
    if (stderrStream && typeof stderrStream.on === "function") {
      stderrStream.on("data", (chunk: Buffer | string) => appendChunk(stderrChunks, chunk));
    }

    stream.on("exit", (code: number | null | undefined) => {
      if (typeof code === "number") {
        exitCode = code;
      }
    });

    stream.on("close", (code?: number | null) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: exitCode ?? (typeof code === "number" ? code : 1),
      });
    });

    stream.on("error", reject);
  });
}

export interface DeployResult {
  alreadyDeployed: boolean;
}

/**
 * Deploy an SSH public key to the remote server's authorized_keys file.
 * Uses SshConnection.exec() for remote commands (not child_process).
 * The grep -F pattern and heredoc delimiter are safe: public keys contain only
 * alphanumeric chars, spaces, +, and /.
 */
export async function deployPublicKeyToRemote(
  connection: SshConnection,
  publicKeyContent: string,
): Promise<DeployResult> {
  const trimmedKey = publicKeyContent.trim();
  if (!trimmedKey) {
    throw new Error("Public key content is empty");
  }
  if (/[\r\n]/.test(trimmedKey)) {
    throw new Error("Public key must be a single line");
  }
  const parsed = PUBLIC_KEY_PATTERN.exec(trimmedKey);
  if (!parsed?.groups?.type || !parsed.groups.base64) {
    throw new Error("Public key format is invalid");
  }

  // Extract type+base64 for matching (ignore comment)
  const matchPattern = `${parsed.groups.type} ${parsed.groups.base64}`;

  // Validate match pattern contains only safe characters for shell interpolation
  if (!/^[A-Za-z0-9+/= @._-]+$/.test(matchPattern)) {
    throw new Error("Public key contains unexpected characters");
  }

  // Create .ssh dir with correct permissions
  const mkdirResult = await execRemoteCommand(
    connection,
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
  );
  if (mkdirResult.exitCode !== 0) {
    throw new Error(`Failed to create remote .ssh directory: ${mkdirResult.stderr}`);
  }

  // Check if key already exists (match on type+base64, ignore comment)
  const grepResult = await execRemoteCommand(
    connection,
    `grep -F '${matchPattern}' ~/.ssh/authorized_keys 2>/dev/null`,
  );
  if (grepResult.exitCode === 0 && grepResult.stdout.trim().length > 0) {
    return { alreadyDeployed: true };
  }

  // Append key using heredoc (single-quoted delimiter prevents shell expansion)
  const appendResult = await execRemoteCommand(
    connection,
    `cat >> ~/.ssh/authorized_keys << 'NEXUS_KEY_EOF'\n${trimmedKey}\nNEXUS_KEY_EOF\nchmod 600 ~/.ssh/authorized_keys`,
  );
  if (appendResult.exitCode !== 0) {
    throw new Error(`Failed to deploy key: ${appendResult.stderr}`);
  }

  return { alreadyDeployed: false };
}
