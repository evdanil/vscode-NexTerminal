import * as vscode from "vscode";
import { NEXTERM_SCHEME, type NexusFileSystemProvider } from "./nexusFileSystemProvider";

function readSudoEnabled(): boolean {
  return vscode.workspace.getConfiguration("nexus.sftp").get<boolean>("sudo.enabled", true);
}

/**
 * Nudges a user who opened a non-writable nexterm:// file toward Edit as Root: VS
 * Code's own "Cannot edit in read-only editor" gives no hint that Nexus can help, and
 * this is the case that needs the hint most. Fires at most once per URI per session —
 * `hinted` is only populated once a genuinely read-only file was found, so a writable
 * file never consumes its one shot and a file that later becomes read-only can still
 * be hinted the first time that's observed.
 */
export function registerEditAsRootHint(fileSystemProvider: NexusFileSystemProvider): vscode.Disposable {
  const hinted = new Set<string>();
  return vscode.workspace.onDidOpenTextDocument(async (doc) => {
    if (doc.uri.scheme !== NEXTERM_SCHEME || !readSudoEnabled()) {
      return;
    }
    const key = doc.uri.toString();
    if (hinted.has(key) || fileSystemProvider.isElevated(doc.uri)) {
      return;
    }
    let stat: vscode.FileStat;
    try {
      stat = await fileSystemProvider.stat(doc.uri);
    } catch {
      return;
    }
    if (stat.permissions !== vscode.FilePermission.Readonly) {
      return;
    }
    hinted.add(key);
    const choice = await vscode.window.showInformationMessage(
      "This file is read-only on the remote host. Use Edit as Root (sudo) to modify it.",
      "Edit as Root"
    );
    if (choice === "Edit as Root") {
      fileSystemProvider.markElevated(doc.uri);
      await vscode.commands.executeCommand("vscode.open", doc.uri);
    }
  });
}
