import * as vscode from "vscode";
import { parseScriptHeader } from "./scriptHeader";
import { resolveScriptsDir } from "./resolveScriptsDir";
import { scanScriptsDir } from "./scriptScanner";
import type { ScriptTargetType } from "./scriptTypes";

interface ScriptPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

/**
 * Present a QuickPick over the user's Nexus scripts, optionally filtered by
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
 * Returns `undefined` when there are no scripts or the user dismisses the picker.
 * Surface the "no scripts" case to the user with an informational message so
 * they know where to put scripts. Delegates directory resolution to
 * `resolveScriptsDir()` so the no-workspace global-storage fallback works here
 * too.
 *
 * §5.8 — scripts nested in subdirectories are discovered too, via the same
 * bounded recursive `scanScriptsDir()` the Scripts tree view uses. Untouched,
 * this was the "picker that actually regresses": moving a script into a
 * subfolder made it silently vanish from every "Connect and Run Script…" flow
 * (`serverCommands.ts`, `serialCommands.ts`, `localShellCommands.ts`), with the
 * misleading "No Nexus scripts compatible with…" message implying none exist
 * at all. The scan is a fresh, independent call every time this runs — no
 * cache is shared with the tree view (see scriptScanner.ts's doc comment for
 * why), so this also works correctly even if the Scripts view has never been
 * revealed in this session.
 */
export async function pickScriptFromWorkspace(
  globalStoragePath: string,
  targetType?: ScriptTargetType
): Promise<vscode.Uri | undefined> {
  const dir = resolveScriptsDir(globalStoragePath);

  // A dedicated existence probe (kept separate from the recursive scan) so the
  // "no folder at all" message stays distinct from "folder exists but nothing
  // matched" — scanScriptsDir() swallows a missing root the same way it
  // swallows an empty one, which would otherwise blur that distinction.
  try {
    await vscode.workspace.fs.readDirectory(dir);
  } catch {
    void vscode.window.showInformationMessage(
      `No Nexus scripts folder at ${dir.fsPath}. Create one with "Nexus: New Nexus Script".`
    );
    return undefined;
  }

  const scan = await scanScriptsDir(dir);

  const items: ScriptPickItem[] = [];
  for (const script of scan.scripts) {
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(script.uri);
      text = new TextDecoder("utf-8").decode(bytes);
    } catch {
      continue;
    }
    const header = parseScriptHeader(text);
    if (!header.marker) continue;
    // Hide scripts whose target-type disagrees with the caller's; unrestricted
    // scripts (no @target-type) show for either flavour.
    if (targetType && header.targetType && header.targetType !== targetType) continue;
    const typeLabel = header.targetType ?? "any";
    const detail = header.description ? `[${typeLabel}] ${header.description}` : `[${typeLabel}]`;
    items.push({
      label: header.name ?? script.fileName.replace(/\.[^.]+$/, ""),
      // §5.8 — folder-relative path as description, so two same-named scripts
      // in different folders (or any script moved out of the root) are still
      // distinguishable and, critically, still visible at all.
      description: script.folderPath ?? "",
      detail,
      uri: script.uri
    });
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      targetType
        ? `No Nexus scripts compatible with ${targetType.toUpperCase()} profiles. Add one in ${dir.fsPath}.`
        : `No Nexus scripts found in ${dir.fsPath}.`
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
