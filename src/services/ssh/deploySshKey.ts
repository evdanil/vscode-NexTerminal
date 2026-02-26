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

const KEY_PREFIXES = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

function keySortOrder(name: string): number {
  const idx = KEY_PREFIXES.indexOf(name);
  return idx >= 0 ? idx : KEY_PREFIXES.length;
}

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

  pairs.sort((a, b) => keySortOrder(a.name) - keySortOrder(b.name));
  return pairs;
}
