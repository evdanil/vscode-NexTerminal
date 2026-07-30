import * as vscode from "vscode";
import { parseScriptHeader } from "../services/scripts/scriptHeader";
import { resolveScriptsDir } from "../services/scripts/resolveScriptsDir";
import { scanScriptsDir, SCRIPT_SCAN_MAX_ENTRIES, type ScriptScanResult } from "../services/scripts/scriptScanner";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";
import { createCoalescedInvoker, type CoalescedInvoker } from "../utils/coalescedInvoker";
import { naturalCompare, naturalComparePath } from "../utils/naturalCompare";
import { folderDisplayName, parentPath as folderParentPath } from "../utils/folderPaths";

/** §5.2 — every autosave/rescan fires the raw watcher; coalesce into one rescan. */
const SCRIPT_WATCH_DEBOUNCE_MS = 300;

export type ScriptNode =
  | { kind: "script"; uri: vscode.Uri; name: string; description: string; running: boolean; parseErrors: string[] }
  | { kind: "folder"; uri: vscode.Uri; path: string; name: string }
  | { kind: "truncated"; examined: number }
  | { kind: "placeholder"; label: string; detail?: string; command: vscode.Command; icon: string };

function scriptPlaceholders(): ScriptNode[] {
  return [
    {
      kind: "placeholder",
      label: "New Script",
      detail: "Create a starter automation script",
      command: { command: "nexus.script.new", title: "New Script" },
      icon: "new-file"
    },
    {
      kind: "placeholder",
      label: "Open Scripting Guide",
      detail: "Read the Nexus script API guide",
      command: { command: "nexus.script.openDocs", title: "Open Scripting Guide" },
      icon: "book"
    },
    {
      kind: "placeholder",
      label: "Open Script Examples",
      detail: "Browse runnable script examples",
      command: { command: "nexus.script.openExamples", title: "Open Script Examples" },
      icon: "file-code"
    }
  ];
}

export class ScriptTreeProvider implements vscode.TreeDataProvider<ScriptNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
  private watcher?: vscode.FileSystemWatcher;
  private watchedDir?: string;
  private readonly managerListener: vscode.Disposable;
  private readonly configListener: vscode.Disposable;
  private readonly debouncedRefresh: CoalescedInvoker;

  // §5.1 — one recursive scan per refresh, shared by every getChildren() call
  // for that render pass. `generation` guards against an overlapping older
  // scan resolving after a newer one and clobbering the tree with stale data.
  private generation = 0;
  private scanPromise?: Promise<ScriptScanResult>;

  public constructor(
    private readonly manager: ScriptRuntimeManager,
    private readonly globalStoragePath: string
  ) {
    // Only refresh on events that change the tree's visible state (running badge,
    // context value). onDidChangeRun also fires on every log/operationBegin/
    // operationEnd — refreshing on those would cause the sidebar to flash many
    // times per second for a chatty script, which looks like the whole Nexus
    // panel is reloading.
    this.managerListener = this.manager.onDidChangeRun((event) => {
      if (event.kind === "started" || event.kind === "ended") {
        this.refresh();
      }
    });
    // Re-read the scripts directory whenever the user changes the setting —
    // otherwise the tree keeps listing files from the previous folder and the
    // watcher stays bound to it.
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nexus.scripts.path")) {
        this.refresh();
      }
    });
    this.debouncedRefresh = createCoalescedInvoker(() => this.refresh(), SCRIPT_WATCH_DEBOUNCE_MS);
    this.ensureWatcher();
  }

  public dispose(): void {
    this.watcher?.dispose();
    this.managerListener.dispose();
    this.configListener.dispose();
    this.debouncedRefresh.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Immediate refresh — rebuilds the watcher if the configured directory
   * changed, kicks off a fresh scan (bumping `generation`), and repaints.
   * Config changes and the `nexus.script.refresh` button call this directly;
   * raw filesystem watcher events go through `debouncedRefresh` instead so a
   * burst of saves collapses into one rescan (§5.2).
   */
  public refresh(): void {
    this.ensureWatcher();
    this.startScan();
    this._onDidChangeTreeData.fire();
  }

  private startScan(): Promise<ScriptScanResult> {
    this.generation += 1;
    const dir = resolveScriptsDir(this.globalStoragePath);
    const promise = scanScriptsDir(dir);
    this.scanPromise = promise;
    return promise;
  }

  /**
   * Awaits the CURRENT-generation scan, never a stale one (§5.1). If the scan
   * this call started awaiting resolves after a newer scan has since started
   * (`this.generation` moved on while we awaited), loop and await whatever is
   * now current instead of returning the stale result.
   */
  private async getCurrentScan(): Promise<ScriptScanResult> {
    if (!this.scanPromise) {
      this.startScan();
    }
    for (;;) {
      const gen = this.generation;
      const promise = this.scanPromise!;
      const result = await promise;
      if (gen === this.generation) {
        return result;
      }
      // A newer scan started while this one was in flight — discard this
      // stale result and pick up whatever refresh() most recently kicked off.
    }
  }

  public getTreeItem(node: ScriptNode): vscode.TreeItem {
    if (node.kind === "placeholder") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.detail;
      item.contextValue = "nexus.script.placeholder";
      item.command = node.command;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }

    if (node.kind === "folder") {
      // §5.5 — stable id (folder-relative path) so expansion survives the
      // frequent refreshes a debounced watcher + generation-guarded rescan
      // produce; resourceUri set for file-decoration/theming.
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `scriptFolder:${node.path}`;
      item.resourceUri = node.uri;
      item.contextValue = "nexus.scriptFolder";
      item.tooltip = node.path;
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }

    if (node.kind === "truncated") {
      // §5.3 — pinned first at root by getChildren(); contextValue is outside
      // both script-menu equality checks (`nexus.script.file` /
      // `nexus.script.running`), so no script context menu leaks onto it.
      const item = new vscode.TreeItem(
        `Stopped after ${SCRIPT_SCAN_MAX_ENTRIES} entries — some scripts may be hidden`,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = "nexus-script-truncated";
      item.tooltip = `Examined ${node.examined} entries before stopping. Some folders or scripts under the configured scripts path may not be shown — narrow nexus.scripts.path to a smaller directory.`;
      item.iconPath = new vscode.ThemeIcon("warning");
      item.contextValue = "nexus.script.truncated";
      item.command = {
        command: "workbench.action.openSettings",
        title: "Open Nexus Scripts Path Setting",
        arguments: ["nexus.scripts.path"]
      };
      return item;
    }

    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = `script:${node.uri.fsPath}`;
    // Only the running badge appears inline — the description goes in the
    // hover tooltip (set below) so the row doesn't get cluttered with
    // "name — long description" text for every script.
    item.description = node.running ? "● running" : "";
    item.tooltip = node.parseErrors.length > 0
      ? `Header errors:\n${node.parseErrors.join("\n")}`
      : node.description || node.uri.fsPath;
    item.resourceUri = node.uri;
    item.contextValue = node.running ? "nexus.script.running" : "nexus.script.file";
    item.iconPath = node.parseErrors.length > 0
      ? new vscode.ThemeIcon("warning")
      : node.running
        ? new vscode.ThemeIcon("sync~spin")
        : new vscode.ThemeIcon("file-code");
    // No default click-to-open action — clicking a script used to pop the
    // editor immediately, which users reported as noisy when they just
    // wanted to Run / Stop from the sidebar. Open the file via the
    // right-click "Edit" menu entry (nexus.script.edit) instead.
    return item;
  }

  /**
   * §5.1/§5.4 — hierarchical: folders render whether or not they contain
   * scripts, sorted before scripts, both by natural compare. The truncation
   * node (§5.3) and onboarding placeholders (§5.6) are root-only.
   */
  public async getChildren(element?: ScriptNode): Promise<ScriptNode[]> {
    if (element && element.kind !== "folder") {
      return [];
    }
    const scan = await this.getCurrentScan();
    const targetPath = element?.kind === "folder" ? element.path : undefined;

    const childFolders: ScriptNode[] = scan.folders
      .filter((f) => folderParentPath(f.path) === targetPath)
      .sort((a, b) => naturalComparePath(a.path, b.path))
      .map((f) => ({ kind: "folder" as const, uri: f.uri, path: f.path, name: folderDisplayName(f.path) }));

    const runningPaths = new Set(this.manager.getRuns().map((r) => r.scriptPath));
    const scriptsHere = scan.scripts.filter((s) => s.folderPath === targetPath);
    const scriptNodes: Array<Extract<ScriptNode, { kind: "script" }>> = [];
    for (const s of scriptsHere) {
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(s.uri);
        text = new TextDecoder("utf-8").decode(bytes);
      } catch {
        continue;
      }
      const header = parseScriptHeader(text);
      if (!header.marker) continue;
      scriptNodes.push({
        kind: "script",
        uri: s.uri,
        name: header.name ?? s.fileName.replace(/\.[^.]+$/, ""),
        description: header.description ?? "",
        running: runningPaths.has(s.uri.fsPath),
        parseErrors: header.parseErrors
      });
    }
    scriptNodes.sort((a, b) => naturalCompare(a.name, b.name));

    const children: ScriptNode[] = [...childFolders, ...scriptNodes];

    if (targetPath === undefined) {
      // §5.6 — placeholders render only when there are no MARKED scripts
      // anywhere in the tree, root only. Checked cheaply: skip entirely once
      // a root-level script already qualified above.
      if (scriptNodes.length === 0 && !(await this.hasMarkedScriptBelowRoot(scan))) {
        children.push(...scriptPlaceholders());
      }
      if (scan.truncated) {
        // §5.3 — pinned FIRST at root, ahead of folders/scripts/placeholders.
        children.unshift({ kind: "truncated", examined: scan.examined });
      }
    }

    return children;
  }

  /** Tree-wide check for §5.6: is there a marked script anywhere below the root? */
  private async hasMarkedScriptBelowRoot(scan: ScriptScanResult): Promise<boolean> {
    for (const s of scan.scripts) {
      if (s.folderPath === undefined) continue; // already accounted for by the caller
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(s.uri);
        text = new TextDecoder("utf-8").decode(bytes);
      } catch {
        continue;
      }
      if (parseScriptHeader(text).marker) {
        return true;
      }
    }
    return false;
  }

  private ensureWatcher(): void {
    const dir = resolveScriptsDir(this.globalStoragePath);
    // Rebuild when the target directory changes — the setting may have been
    // updated mid-session, in which case the existing watcher is still bound
    // to the old folder and will never fire for the new one.
    if (this.watcher && this.watchedDir === dir.fsPath) return;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.watchedDir = dir.fsPath;
    // §5.2 — "**/*.js" never fires for a directory rename/delete: a directory
    // event carries the directory's own path, which can't match a *.js glob.
    // Watch everything and rely on getChildren()'s own filtering; a burst of
    // events (e.g. an autosave storm) is coalesced by debouncedRefresh.
    const pattern = new vscode.RelativePattern(dir, "**/*");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onEvent = () => this.debouncedRefresh.schedule();
    this.watcher.onDidCreate(onEvent);
    this.watcher.onDidChange(onEvent);
    this.watcher.onDidDelete(onEvent);
  }
}
