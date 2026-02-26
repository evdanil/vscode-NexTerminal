import { readdir, mkdir, readFile } from "node:fs/promises";
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
