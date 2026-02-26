import { readdir, mkdir } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import type { SshConnection } from "./contracts";

const execFile = promisify(execFileCb);

export interface KeyPairInfo {
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
}

// Ordered by preference: ed25519 first. Iteration order = sort order.
const KEY_PREFIXES = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

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

function findSshKeygen(): string {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe";
  }
  return "ssh-keygen";
}

export async function generateKeyPair(options: GenerateKeyPairOptions): Promise<{ publicKeyPath: string }> {
  await mkdir(options.sshDir, { recursive: true, mode: 0o700 });

  const keyPath = path.join(options.sshDir, options.name);
  const args = ["-t", "ed25519", "-f", keyPath, "-N", options.passphrase, "-C", "nexus-terminal"];

  await execFile(findSshKeygen(), args);

  return { publicKeyPath: `${keyPath}.pub` };
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

    stream.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    (stream as any).stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));

    stream.on("exit", (exitCode: number) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: exitCode ?? 1,
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

  // Extract type+base64 for matching (ignore comment)
  const keyParts = trimmedKey.split(/\s+/);
  const matchPattern = keyParts.length >= 2 ? `${keyParts[0]} ${keyParts[1]}` : trimmedKey;

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
