import * as vscode from "vscode";
import { parseScriptHeader } from "./scriptHeader";

interface ScriptPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

/**
 * Present a QuickPick over the workspace's Nexus scripts, optionally filtered by
 * the `@target-type` JSDoc tag. Used by the "Run with script…" actions on server
 * and serial profile items.
 *
 * Behaviour:
 *   - A script with no `@target-type` is compatible with any target.
 *   - A script with a matching `@target-type` shows normally.
 *   - A script whose `@target-type` *disagrees* with the caller's type is hidden
 *     — no point offering an SSH-only script when the user is trying to run
 *     something against a serial profile.
 *
 * Returns `undefined` when there are no scripts, the workspace isn't open, or
 * the user dismisses the picker. Surface the "no scripts" case to the user with
 * an informational message so they know where to put scripts.
 */
export async function pickScriptFromWorkspace(
  targetType?: "ssh" | "serial"
): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showInformationMessage(
      "Open a folder to store your Nexus scripts, then try again."
    );
    return undefined;
  }

  const scriptsPath = vscode.workspace
    .getConfiguration("nexus.scripts")
    .get<string>("path", ".nexus/scripts");
  const dir = vscode.Uri.joinPath(folder.uri, scriptsPath);

  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    void vscode.window.showInformationMessage(
      `No Nexus scripts folder at ${scriptsPath}. Create one with "Nexus: New Nexus Script".`
    );
    return undefined;
  }

  const items: ScriptPickItem[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith(".js")) continue;
    const uri = vscode.Uri.joinPath(dir, name);
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = new TextDecoder("utf-8").decode(bytes);
    } catch {
      continue;
    }
    const header = parseScriptHeader(text);
    if (!header.marker) continue;
    // Hide scripts whose target-type disagrees with the caller's; unrestricted
    // scripts (no @target-type) show for either flavour.
    if (targetType && header.targetType && header.targetType !== targetType) continue;
    items.push({
      label: header.name ?? name.replace(/\.[^.]+$/, ""),
      description: header.targetType ?? "any",
      detail: header.description,
      uri
    });
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      targetType
        ? `No Nexus scripts compatible with ${targetType.toUpperCase()} profiles. Add one in ${scriptsPath}.`
        : `No Nexus scripts found in ${scriptsPath}.`
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Pick a Nexus script to run on this profile",
    matchOnDescription: true,
    matchOnDetail: true
  });
  return picked?.uri;
}
