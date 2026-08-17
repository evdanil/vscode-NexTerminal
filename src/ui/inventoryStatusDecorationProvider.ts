import * as vscode from "vscode";
import type { SessionSnapshot } from "../core/contracts";

/**
 * LIVE STATUS (Phase 2) — the running-lab highlight. A `FileDecorationProvider`
 * that paints a green ▶ badge on:
 *  - a server whose inventory status is "running", and
 *  - a folder that DIRECTLY contains at least one running server (the lab
 *    folder — an EVE-NG lab maps to its own folder, so its running nodes make
 *    the lab light up).
 *
 * Decoration lookups are O(1) Set hits; the running sets are derived once per
 * snapshot in `update()` (not per `provideFileDecoration` call), and the change
 * event fires only when they actually change so the tree is not churned on every
 * unrelated snapshot.
 *
 * The tree items carry a `nexus-status:` resourceUri built by `serverStatusUri`
 * / `folderStatusUri` (set by the Command Center tree provider), which is how
 * VS Code maps a rendered row to a decoration.
 */
export const STATUS_URI_SCHEME = "nexus-status";

/** `nexus-status://server/<encoded serverId>` — the resourceUri a server row carries. */
export function serverStatusUri(serverId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: STATUS_URI_SCHEME, authority: "server", path: `/${encodeURIComponent(serverId)}` });
}

/** `nexus-status://folder/<encoded folderPath>` — the resourceUri a folder row carries. */
export function folderStatusUri(folderPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: STATUS_URI_SCHEME, authority: "folder", path: `/${encodeURIComponent(folderPath)}` });
}

export interface RunningStatus {
  runningServerIds: Set<string>;
  runningFolders: Set<string>;
}

/**
 * Derive, from a snapshot, the running server ids and the folders that directly
 * contain a running server. A server's lab folder is its own `group`, so folder
 * membership is read the same way the tree assigns a server to a folder — no
 * separate ancestry rule to drift from the tree's.
 */
export function computeRunningStatus(snapshot: SessionSnapshot): RunningStatus {
  const runningServerIds = new Set<string>();
  const runningFolders = new Set<string>();
  const status = snapshot.serverStatus;
  for (const server of snapshot.servers) {
    if (status?.get(server.id) === "running") {
      runningServerIds.add(server.id);
      if (server.group) {
        runningFolders.add(server.group);
      }
    }
  }
  return { runningServerIds, runningFolders };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export class InventoryStatusDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.emitter.event;
  private running: RunningStatus = { runningServerIds: new Set(), runningFolders: new Set() };

  /** Recompute from the snapshot; fire a full refresh only when the running set changed. */
  public update(snapshot: SessionSnapshot): void {
    const next = computeRunningStatus(snapshot);
    if (setsEqual(next.runningServerIds, this.running.runningServerIds) && setsEqual(next.runningFolders, this.running.runningFolders)) {
      return;
    }
    this.running = next;
    this.emitter.fire(undefined);
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== STATUS_URI_SCHEME) {
      return undefined;
    }
    const key = decodeURIComponent(uri.path.replace(/^\//, ""));
    if (uri.authority === "server" && this.running.runningServerIds.has(key)) {
      return makeRunningDecoration();
    }
    if (uri.authority === "folder" && this.running.runningFolders.has(key)) {
      return makeRunningDecoration();
    }
    return undefined;
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

function makeRunningDecoration(): vscode.FileDecoration {
  return new vscode.FileDecoration("▶", "Running", new vscode.ThemeColor("charts.green"));
}
