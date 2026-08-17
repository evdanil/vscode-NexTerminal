import * as vscode from "vscode";
import { parseScriptHeader } from "./scriptHeader";
import { resolveScriptsDir } from "./resolveScriptsDir";
import { scanScriptsDir, SCRIPT_SCAN_MAX_DEPTH } from "./scriptScanner";
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
/**
 * Display form of a target type for the "nothing matched" message. `.toUpperCase()`
 * reads fine for SSH but shouts for the word-shaped ones ("TELNET", "LOCAL").
 */
function friendlyPickerTargetType(type: ScriptTargetType): string {
  if (type === "ssh") return "SSH";
  if (type === "telnet") return "Telnet";
  if (type === "serial") return "Serial";
  return "Local Shell";
}

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

  // §5.3 requires truncation to be ANNOUNCED, never silent — the Scripts tree
  // pins a warning row for it. Without the same signal here, hitting a cap
  // produced the single most misleading sentence this module has ("No Nexus
  // scripts compatible with SSH profiles"), asserting that nothing exists when
  // the scan simply stopped looking. Both branches below carry it: the empty
  // case must not claim emptiness, and a partial list must not look complete.
  const truncationNote = scan.truncated
    ? `The scan stopped after examining ${scan.examined} entries, so some scripts may be hidden — point "nexus.scripts.path" at a tighter folder.`
    : scan.depthTruncated
      ? `Folders nested more than ${SCRIPT_SCAN_MAX_DEPTH} levels deep were not searched, so some scripts may be hidden.`
      : "";

  if (items.length === 0) {
    const base = targetType
      ? `No Nexus scripts compatible with ${friendlyPickerTargetType(targetType)} profiles. Add one in ${dir.fsPath}.`
      : `No Nexus scripts found in ${dir.fsPath}.`;
    void vscode.window.showInformationMessage(truncationNote ? `${base} ${truncationNote}` : base);
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: truncationNote
      ? `Pick a Nexus script to run on this profile — ${truncationNote}`
      : "Pick a Nexus script to run on this profile",
    matchOnDescription: true,
    matchOnDetail: true
  });
  return picked?.uri;
}
