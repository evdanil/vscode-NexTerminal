import { describe, expect, it, vi, beforeEach } from "vitest";

/** Files that exist on the pretend filesystem, by fsPath. */
const existing = new Set<string>();
/** Every `renameFile` that reached `applyEdit`, oldest first. */
const renames: Array<{ from: string; to: string; overwrite: boolean | undefined }> = [];
/** Set to false to make `applyEdit` report a refusal without throwing. */
let applyEditResult = true;
/** Set to true to make `applyEdit` throw instead of returning. */
let applyEditThrows = false;

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const joined = [base.fsPath, ...parts].join("/");
      return { fsPath: joined, scheme: "file", path: joined, toString: () => joined };
    }
  },
  WorkspaceEdit: class MockWorkspaceEdit {
    public pending: Array<{ from: string; to: string; overwrite: boolean | undefined }> = [];
    public renameFile(
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ): void {
      this.pending.push({ from: from.fsPath, to: to.fsPath, overwrite: options?.overwrite });
    }
  },
  workspace: {
    fs: {
      stat: vi.fn(async (uri: { fsPath: string }) => {
        if (!existing.has(uri.fsPath)) throw new Error(`ENOENT: ${uri.fsPath}`);
        return { type: 1, ctime: 0, mtime: 0, size: 1 };
      })
    },
    applyEdit: vi.fn(async (edit: { pending: Array<{ from: string; to: string; overwrite: boolean | undefined }> }) => {
      if (applyEditThrows) throw new Error("applyEdit exploded");
      if (!applyEditResult) return false;
      for (const op of edit.pending) {
        existing.delete(op.from);
        existing.add(op.to);
        renames.push(op);
      }
      return true;
    })
  }
}));

import * as vscode from "vscode";
import {
  moveScriptIntoFolder,
  type ScriptMoveResult
} from "../../../src/services/scripts/moveScripts";

const ROOT = "/ws/.nexus/scripts";

function uri(p: string): vscode.Uri {
  return vscode.Uri.file(p);
}

async function move(
  source: string,
  targetDir: string,
  running: string[] = [],
  root: string = ROOT
): Promise<ScriptMoveResult> {
  return moveScriptIntoFolder(uri(source), uri(targetDir), new Set(running), uri(root));
}

// Containment (isLexicallyWithin) has its own full matrix in
// test/unit/scripts/scriptFsScope.test.ts — moveScripts.ts now delegates to
// it (Amendment A / DRY) rather than carrying its own copy. The refusal case
// below ("refuses a source outside the scripts root") is the integration
// point: it pins that moveScriptIntoFolder actually wires the shared
// function up, not just that the function itself works.

describe("moveScriptIntoFolder", () => {
  beforeEach(() => {
    existing.clear();
    renames.length = 0;
    applyEditResult = true;
    applyEditThrows = false;
  });

  it("renames the file into the target folder", async () => {
    existing.add(`${ROOT}/probe.js`);

    const result = await move(`${ROOT}/probe.js`, `${ROOT}/cisco`);

    expect(result).toEqual({ kind: "moved" });
    expect(renames).toEqual([
      { from: `${ROOT}/probe.js`, to: `${ROOT}/cisco/probe.js`, overwrite: false }
    ]);
  });

  it("moves a script back out to the root", async () => {
    existing.add(`${ROOT}/cisco/probe.js`);

    const result = await move(`${ROOT}/cisco/probe.js`, ROOT);

    expect(result.kind).toBe("moved");
    expect(renames[0].to).toBe(`${ROOT}/probe.js`);
  });

  it("REFUSES to move a running script, and says to stop it first", async () => {
    // The runtime keys a run by its script's path, and so does the tree row's
    // Stop. Moving it would leave the run keyed to a path nothing renders: no
    // running badge, no Stop, still running. Reverting this check makes the
    // rename go through, which is what this asserts against.
    existing.add(`${ROOT}/probe.js`);

    const result = await move(`${ROOT}/probe.js`, `${ROOT}/cisco`, [`${ROOT}/probe.js`]);

    expect(renames).toEqual([]);
    expect(result).toEqual({
      kind: "refused",
      message: 'Could not move "probe.js" — it is running. Stop it first, then move it.'
    });
  });

  it("REFUSES a name collision rather than overwriting the script already there", async () => {
    existing.add(`${ROOT}/probe.js`);
    existing.add(`${ROOT}/cisco/probe.js`); // the one that would be destroyed

    const result = await move(`${ROOT}/probe.js`, `${ROOT}/cisco`);

    expect(renames).toEqual([]);
    // Both files still there — the check is what makes that true.
    expect(existing.has(`${ROOT}/probe.js`)).toBe(true);
    expect(existing.has(`${ROOT}/cisco/probe.js`)).toBe(true);
    expect(result).toEqual({
      kind: "refused",
      message: 'Could not move "probe.js" — a file with that name is already in the target folder.'
    });
  });

  it("refuses a source outside the scripts root", async () => {
    existing.add("/etc/passwd");

    const result = await move("/etc/passwd", `${ROOT}/cisco`);

    expect(renames).toEqual([]);
    expect(result).toEqual({
      kind: "refused",
      message: 'Could not move "passwd" — it is not inside the Nexus scripts folder.'
    });
  });

  it("is UNCHANGED, not refused, for a script already in the target folder", async () => {
    // Nothing went wrong. A "could not move" toast for dropping a script where
    // it already is would be noise on the single most likely misfire of the
    // gesture — so this is a distinct result the caller says nothing about.
    existing.add(`${ROOT}/cisco/probe.js`);

    const result = await move(`${ROOT}/cisco/probe.js`, `${ROOT}/cisco`);

    expect(result).toEqual({ kind: "unchanged" });
    expect(renames).toEqual([]);
  });

  it("reports a rename the editor refused instead of calling it moved", async () => {
    existing.add(`${ROOT}/probe.js`);
    applyEditResult = false;

    const result = await move(`${ROOT}/probe.js`, `${ROOT}/cisco`);

    expect(result).toEqual({ kind: "refused", message: 'Could not move "probe.js".' });
  });

  it("reports a rename that threw instead of letting it escape the drop handler", async () => {
    // `handleDrop` is invoked by VS Code; an exception out of it surfaces as an
    // unhandled rejection with no user-facing explanation of what happened.
    existing.add(`${ROOT}/probe.js`);
    applyEditThrows = true;

    const result = await move(`${ROOT}/probe.js`, `${ROOT}/cisco`);

    expect(result).toEqual({ kind: "refused", message: 'Could not move "probe.js".' });
  });

  it("never asks for overwrite, even when the destination is free", async () => {
    existing.add(`${ROOT}/probe.js`);

    await move(`${ROOT}/probe.js`, `${ROOT}/cisco`);

    expect(renames[0].overwrite).toBe(false);
  });
});
