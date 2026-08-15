import * as path from "node:path";
import * as vscode from "vscode";
import { isLexicallyWithin } from "./scriptFsScope";

/** `process.platform`, injected as `isLexicallyWithin`'s platform argument. */
const HOST_PLATFORM = process.platform === "win32" ? "win32" : "posix";

/**
 * What a drop did.
 *
 * `"unchanged"` is separate from `"refused"` on purpose: dropping a script into
 * the folder it is already in is the single most likely misfire of the gesture,
 * nothing went wrong, and a toast for it would be noise. A refusal always
 * carries the sentence to show, because a drag that silently does nothing is
 * the exact complaint this feature exists to answer.
 */
export type ScriptMoveResult =
  | { readonly kind: "moved" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly message: string };

function sameDirectory(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === "";
}

/**
 * Moves one script into `targetDir` — a single filesystem rename.
 *
 * The rename goes through a `WorkspaceEdit` rather than `workspace.fs.rename()`
 * so an editor already open on the script follows it and the move joins the
 * undo stack. Scripts are user source code that people keep open while editing;
 * a move that orphans the open editor onto a path that no longer exists is a
 * worse outcome than the simpler call is worth.
 *
 * Three refusals, each leaving the script untouched rather than guessing:
 *
 *  * **Running.** `ScriptRuntimeManager` keys a run by its script's path
 *    (`RunningScriptSnapshot.scriptPath`), and so does everything that resolves
 *    a run from a tree row — `nexus.script.stop` matches `scriptPath` against
 *    the clicked node's URI. Moving a running script leaves the run keyed to a
 *    path nothing renders any more: the row at the new path shows no running
 *    badge and offers no Stop, while the script keeps running invisibly. The
 *    alternative is teaching the runtime to re-key mid-run, which is real
 *    machinery for a convenience, so this refuses and says to stop it first.
 *  * **Name collision.** Never overwrite. A script is source code the user
 *    wrote; silently replacing one with another of the same name is
 *    unrecoverable, and `renameFile`'s own `overwrite: false` would fail with a
 *    message that does not name the folder.
 *  * **Outside the scripts root** — lexical containment, via `isLexicallyWithin`
 *    (`scriptFsScope.ts`, the single containment implementation shared with
 *    `nexus.fs`). Deliberately lexical, and the distinction is worth stating
 *    because the scanner follows symlinks. `scripts/shared -> /elsewhere/shared`
 *    is walked, so `scripts/shared/probe.js` renders in the tree with a URI
 *    built by `Uri.joinPath` — which is under the scripts root as a string
 *    while the bytes live somewhere else entirely. This check therefore
 *    guarantees "the path the tree drew is under the root", not "the file is
 *    inside the root directory", and moving such a script really does move it
 *    out of the link's target. That is the right behaviour: the row the user
 *    dragged is in the Scripts view, and a link they put there themselves is
 *    theirs to reorganise. What it is for is the case the tree never drew: a
 *    URI naming a path this view never rendered. See `handleDrop` in
 *    `scriptTreeProvider.ts` for why that cannot normally happen, and why it
 *    is checked anyway.
 */
export async function moveScriptIntoFolder(
  source: vscode.Uri,
  targetDir: vscode.Uri,
  runningPaths: ReadonlySet<string>,
  scriptsRoot: vscode.Uri
): Promise<ScriptMoveResult> {
  const name = path.basename(source.fsPath);

  if (!isLexicallyWithin(source.fsPath, scriptsRoot.fsPath, HOST_PLATFORM)) {
    return refused(`Could not move "${name}" — it is not inside the Nexus scripts folder.`);
  }
  if (runningPaths.has(source.fsPath)) {
    return refused(`Could not move "${name}" — it is running. Stop it first, then move it.`);
  }
  if (sameDirectory(path.dirname(source.fsPath), targetDir.fsPath)) {
    return { kind: "unchanged" };
  }

  const destination = vscode.Uri.joinPath(targetDir, name);
  if (await exists(destination)) {
    // On a case-INSENSITIVE filesystem this also catches `Probe.js` vs
    // `probe.js`, because the stat resolves through the same name the rename
    // would have — which is the behaviour we want, since those two would
    // collide there and coexist on a case-sensitive one.
    return refused(`Could not move "${name}" — a file with that name is already in the target folder.`);
  }

  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(source, destination, { overwrite: false });
  let applied = false;
  try {
    applied = await vscode.workspace.applyEdit(edit);
  } catch {
    applied = false;
  }
  // `handleDrop` is invoked by VS Code, so an exception escaping it surfaces as
  // an unhandled rejection with nothing said to the user. Report instead.
  return applied ? { kind: "moved" } : refused(`Could not move "${name}".`);
}

function refused(message: string): ScriptMoveResult {
  return { kind: "refused", message };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
