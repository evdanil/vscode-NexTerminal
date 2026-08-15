import * as path from "node:path";
import * as vscode from "vscode";

const DEFAULT_RELATIVE_PATH = ".nexus/scripts";

/**
 * True if `configured` is absolute under EITHER path convention —
 * deliberately not `path.isAbsolute` (which resolves to whichever
 * convention matches THIS process's `process.platform`). An absolute
 * `nexus.scripts.path` value describes a location on the machine the
 * SCRIPTS actually live on — over Remote-SSH that's the remote host, which
 * can run a different OS than wherever this particular check happens to
 * execute (notably: this repo's own POSIX test suite, verifying a
 * Windows-drive-absolute value like `C:\scripts`). Checking both
 * conventions makes "is this absolute" a property of the STRING, not of the
 * local host.
 */
function isAbsoluteAnyPlatform(configured: string): boolean {
  return path.win32.isAbsolute(configured) || path.posix.isAbsolute(configured);
}

/**
 * Converts a possibly-win32 absolute path into the POSIX form `vscode.Uri`
 * uses for `.path` on every non-`file` scheme (scriptFs.ts's decision 5:
 * `.path` is always POSIX there, regardless of what OS the remote host
 * actually runs — `vscode-remote:` URIs are POSIX-pathed even when SSH'd
 * into a Windows box). A drive-absolute path (`C:\scripts`, `C:/scripts`)
 * becomes `/C:/scripts`; anything already `/`-rooted just gets its
 * separators normalized (a backslash is a valid POSIX filename character,
 * but `configured` here is a Windows-or-POSIX absolute path, never an
 * already-POSIX one that happens to contain a literal backslash).
 */
function toRemoteUriPath(configured: string): string {
  const normalized = configured.replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized;
}

export function resolveScriptsDir(globalStoragePath: string): vscode.Uri {
  const configured = vscode.workspace
    .getConfiguration("nexus.scripts")
    .get<string>("path", DEFAULT_RELATIVE_PATH);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;

  if (isAbsoluteAnyPlatform(configured)) {
    // Remote workspace (root scheme is `vscode-remote:` or similar, not
    // `file:`): `Uri.file(configured)` would silently build a LOCAL `file:`
    // URI for a path that only makes sense on the REMOTE host.
    // `buildScriptFsScope`'s scheme/authority guard then correctly refuses
    // to unify that with the remote script's own scope, and the configured
    // root silently drops out of the union — a documented absolute-path
    // configuration breaks on remote (fails closed, not a hole, but still
    // wrong). Rebase onto the workspace root's OWN scheme+authority instead
    // — everything else about the URI (query, fragment) is reset, matching
    // a fresh root rather than inheriting the workspace folder's own.
    if (root && root.scheme !== "file") {
      return root.with({ path: toRemoteUriPath(configured), query: "", fragment: "" });
    }
    // Local (`file:`) workspace, or no workspace at all — unchanged.
    return vscode.Uri.file(configured);
  }

  if (root) {
    return vscode.Uri.joinPath(root, configured);
  }

  return vscode.Uri.file(path.join(globalStoragePath, "scripts"));
}
