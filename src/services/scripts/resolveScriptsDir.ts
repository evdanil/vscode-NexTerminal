import * as path from "node:path";
import * as vscode from "vscode";

const DEFAULT_RELATIVE_PATH = ".nexus/scripts";

export function resolveScriptsDir(globalStoragePath: string): vscode.Uri {
  const configured = vscode.workspace
    .getConfiguration("nexus.scripts")
    .get<string>("path", DEFAULT_RELATIVE_PATH);

  if (path.isAbsolute(configured)) {
    return vscode.Uri.file(configured);
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    return vscode.Uri.joinPath(root, configured);
  }

  return vscode.Uri.file(path.join(globalStoragePath, "scripts"));
}
