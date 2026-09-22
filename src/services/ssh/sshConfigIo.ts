import * as vscode from "vscode";
import type { SshConfigIo } from "../../utils/sshConfigParser";

/**
 * The `SshConfigIo` the ssh-config importer runs on, built from
 * `vscode.workspace.fs` so the walk works over whatever filesystem provider
 * holds the file (including a remote workspace), not just `node:fs`.
 *
 * Two contracts to keep, both from `SshConfigIo`'s own doc comment: neither
 * method may throw — a missing or unreadable file is `undefined`/`[]`, which
 * the resolver already reports as an issue and a counter — and `readDir`
 * returns basenames only.
 *
 * SIZE IS GUARDED HERE, not only at the dialog. The dialog's stat-first check
 * covers the file the user PICKED; every `Include` the walk then follows is a
 * file nobody chose, on a path the config itself names. Statting before reading
 * keeps the whole walk under the same ceiling, one file at a time, without ever
 * decoding an oversized one.
 */
export function createSshConfigIo(maxBytes: number): SshConfigIo {
  return {
    async readFile(filePath: string): Promise<string | undefined> {
      try {
        const uri = vscode.Uri.file(filePath);
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          // `Include ~/.ssh/config.d/*` can match a directory; reading one
          // would throw, and a directory is not config text anyway.
          return undefined;
        }
        if (stat.size > maxBytes) {
          return undefined;
        }
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        return undefined;
      }
    },
    async readDir(dir: string): Promise<string[]> {
      try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        return entries.map(([name]) => name);
      } catch {
        return [];
      }
    }
  };
}
