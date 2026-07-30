import * as vscode from "vscode";
import { parseScriptHeader } from "../services/scripts/scriptHeader";
import { resolveScriptsDir } from "../services/scripts/resolveScriptsDir";
import { scanScriptsDir, SCRIPT_SCAN_MAX_ENTRIES, SCRIPT_SCAN_MAX_DEPTH, type ScriptScanResult } from "../services/scripts/scriptScanner";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";
import { createCoalescedInvoker, type CoalescedInvoker } from "../utils/coalescedInvoker";
import { naturalCompare, naturalComparePath } from "../utils/naturalCompare";
import { folderDisplayName, parentPath as folderParentPath } from "../utils/folderPaths";

/** §5.2 — every autosave/rescan fires the raw watcher; coalesce into one rescan. */
const SCRIPT_WATCH_DEBOUNCE_MS = 300;

/**
 * How long to wait before repainting after `getChildren()` gave up on a
 * generation race (see the "scanning" node). Deliberately a REPAINT, not a
 * `refresh()`: refreshing would bump the generation and start yet another
 * scan, which is precisely the condition that starved the render in the first
 * place.
 */
const SCRIPT_STARVED_REPAINT_MS = 300;

export type ScriptNode =
  | { kind: "script"; uri: vscode.Uri; name: string; description: string; running: boolean; parseErrors: string[] }
  | { kind: "folder"; uri: vscode.Uri; path: string; name: string }
  | { kind: "truncated"; examined: number }
  // Fix 6 — a distinct node from "truncated": that one means the entry-count
  // budget stopped the WHOLE scan; this one means one specific branch was cut
  // off at the depth cap while the rest of the tree scanned normally. Design
  // §5.3 requires truncation to always be announced, never silent.
  | { kind: "depthTruncated" }
  // The tree gave up trying to render a settled generation (see
  // `MAX_CHILDREN_RESTARTS`). Rendering the superseded scan instead — a
  // directory that is no longer the configured one — trades a hang for a
  // quieter wrong answer, so the escape hatch says what happened rather than
  // showing stale contents.
  | { kind: "scanning" }
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
  /** Repaint-only (never rescan) retry after a starved render — see SCRIPT_STARVED_REPAINT_MS. */
  private readonly starvedRepaint: CoalescedInvoker;

  // §5.1 — one recursive scan per refresh, shared by every getChildren() call
  // for that render pass. `generation` guards against an overlapping older
  // scan resolving after a newer one and clobbering the tree with stale data.
  private generation = 0;
  private scanPromise?: Promise<ScriptScanResult>;

  // Fix 5 — bounds the `getCurrentScan()` retry loop: a scan slower than the
  // debounced refresh interval, superseded every cycle, would otherwise keep
  // this loop pending forever (each iteration re-awaits whatever is newest,
  // and if refreshes keep landing faster than a scan completes, the
  // generation comparison never settles). Past this many misses, accept the
  // most recent result even though a fresher scan may still be in flight —
  // tagged with the generation IT actually belongs to, never the (by then
  // newer) `this.generation`, so the cache-poisoning bug this fix also closes
  // can't be reintroduced through the escape hatch.
  private static readonly MAX_SCAN_RETRIES = 5;
  // Bounds `getChildren()`'s own restart-on-stale-generation loop (see
  // below) so a sustained refresh storm crossing every readFile await cannot
  // spin without end.
  //
  // Exhausting it does NOT mean "render the stale scan": that was the first
  // version of this escape hatch and it traded a hang for a quieter wrong
  // answer — the tree showing a directory that is no longer the configured
  // one, with nothing to correct it. Exhaustion returns the "scanning" node
  // and schedules a repaint instead, so the only two outcomes are a correct
  // tree or an honest "not showing you anything yet".
  private static readonly MAX_CHILDREN_RESTARTS = 5;

  // Fix 3 — `hasMarkedScriptBelowRoot()` re-reads (and header-parses) every
  // non-root script in the scan. VS Code can call `getChildren(undefined)`
  // more than once for the same render (e.g. reveal/selection churn) without
  // a new scan ever starting, which previously repeated that full read on
  // each call. Memoised per generation: a result computed for the CURRENT
  // scan generation is reused rather than re-reading the filesystem; a new
  // scan (bumping `generation`) naturally invalidates it.
  //
  // Fix 5 — the generation this cache is tagged with is always the value
  // EXPLICITLY PASSED IN by the caller (the generation the scan it read
  // belongs to), never `this.generation` re-read after this method's own
  // `readFile` awaits. Re-reading `this.generation` at that point was the
  // poisoning bug: a refresh landing during those awaits bumps
  // `this.generation` before this method finishes, so the OLD generation's
  // result would get stamped onto the NEW generation's cache entry.
  private markedBelowRootCache?: { generation: number; result: boolean };

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
    this.starvedRepaint = createCoalescedInvoker(
      () => this._onDidChangeTreeData.fire(),
      SCRIPT_STARVED_REPAINT_MS
    );
    this.ensureWatcher();
  }

  public dispose(): void {
    this.watcher?.dispose();
    this.managerListener.dispose();
    this.configListener.dispose();
    this.debouncedRefresh.dispose();
    this.starvedRepaint.dispose();
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
   * Awaits the CURRENT-generation scan, never a stale one (§5.1), and returns
   * the generation it actually belongs to alongside it. If the scan this call
   * started awaiting resolves after a newer scan has since started
   * (`this.generation` moved on while we awaited), loop and await whatever is
   * now current instead of returning the stale result — bounded (Fix 5) so a
   * refresh storm faster than scan completion can't leave this pending
   * forever.
   */
  private async getCurrentScan(): Promise<{ generation: number; scan: ScriptScanResult }> {
    if (!this.scanPromise) {
      this.startScan();
    }
    for (let attempt = 0; ; attempt++) {
      const gen = this.generation;
      const promise = this.scanPromise!;
      const result = await promise;
      if (gen === this.generation || attempt >= ScriptTreeProvider.MAX_SCAN_RETRIES) {
        // Fix 5 — tag with `gen` (the generation THIS result belongs to),
        // never `this.generation`: past the retry budget, `gen` may still be
        // stale relative to `this.generation`, and the caller (`getChildren`)
        // is the one that decides whether to accept or restart against a
        // mismatch — fabricating a fresher generation here would silently
        // reintroduce the poisoning this fix closes.
        return { generation: gen, scan: result };
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

    if (node.kind === "scanning") {
      // Deliberately NO `id`: unlike the two truncation nodes (root-only and
      // singular), a sustained refresh storm starves every expanded folder's
      // `getChildren()` at once, and a duplicate TreeItem id makes VS Code
      // reject the whole render. contextValue is its own string, outside both
      // script-menu equality checks, so no script menu leaks onto it.
      const item = new vscode.TreeItem("Scanning scripts…", vscode.TreeItemCollapsibleState.None);
      item.tooltip =
        "The scripts folder is changing faster than it can be listed, so the previous contents are not shown (they may be from a folder that is no longer configured). This refreshes itself once the folder settles.";
      item.iconPath = new vscode.ThemeIcon("sync~spin");
      item.contextValue = "nexus.script.scanning";
      item.command = { command: "nexus.script.refresh", title: "Refresh Scripts" };
      return item;
    }

    if (node.kind === "depthTruncated") {
      // Fix 6 — distinct node/message from "truncated" above: this one fires
      // when a folder beyond SCRIPT_SCAN_MAX_DEPTH was found and listed but
      // never descended into, which previously happened with no signal at
      // all. contextValue is its own string, outside both script-menu
      // equality checks, same reasoning as the entry-truncation node.
      const item = new vscode.TreeItem(
        `Some folders are nested deeper than ${SCRIPT_SCAN_MAX_DEPTH} levels — scripts inside may be hidden`,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = "nexus-script-depth-truncated";
      item.tooltip = `A folder more than ${SCRIPT_SCAN_MAX_DEPTH} levels deep was found but not scanned, so scripts inside it (and any of its own subfolders) are not shown. Move it closer to the scripts root to see them.`;
      item.iconPath = new vscode.ThemeIcon("warning");
      item.contextValue = "nexus.script.depthTruncated";
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
   *
   * Fix 5 — the scan's generation token is captured once at the top and
   * checked again at the bottom, AFTER every `readFile` await in between
   * (the per-script header reads, and `hasMarkedScriptBelowRoot()`'s own read
   * loop): a refresh can land during any of those awaits, and rendering the
   * result as current at that point would paint a superseded generation with
   * nothing to correct it until an unrelated event fires. Restart against
   * whatever is now current instead — bounded by `MAX_CHILDREN_RESTARTS`, and
   * a superseded tree is NEVER returned: exhausting the budget yields the
   * "scanning" node plus a scheduled repaint.
   */
  public async getChildren(element?: ScriptNode): Promise<ScriptNode[]> {
    if (element && element.kind !== "folder") {
      return [];
    }
    const targetPath = element?.kind === "folder" ? element.path : undefined;

    for (let attempt = 0; ; attempt++) {
      const { generation, scan } = await this.getCurrentScan();

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
        if (scriptNodes.length === 0 && !(await this.hasMarkedScriptBelowRoot(scan, generation))) {
          children.push(...scriptPlaceholders());
        }
        if (scan.depthTruncated) {
          // Fix 6 — pinned at root, distinct from (and rendered ahead of) the
          // entry-cap node below only when both happen to fire together.
          children.unshift({ kind: "depthTruncated" });
        }
        if (scan.truncated) {
          // §5.3 — pinned FIRST at root, ahead of everything else.
          children.unshift({ kind: "truncated", examined: scan.examined });
        }
      }

      if (this.generation === generation) {
        return children;
      }
      if (attempt >= ScriptTreeProvider.MAX_CHILDREN_RESTARTS) {
        // Out of restarts and still behind. `children` here was built from a
        // superseded scan — after a `nexus.scripts.path` change that is a
        // listing of a directory nobody watches any more, which is exactly the
        // wrong answer this whole generation mechanism exists to prevent.
        // Returning it "to avoid a hang" would just make the wrong answer
        // quiet. Say what is happening instead, and repaint (never rescan —
        // see SCRIPT_STARVED_REPAINT_MS) so the tree corrects itself the
        // moment the storm stops, with no user action required.
        this.starvedRepaint.schedule();
        return [{ kind: "scanning" }];
      }
      // A refresh landed during the awaits above — restart against whatever
      // is now current rather than returning a superseded generation's tree.
    }
  }

  /**
   * Tree-wide check for §5.6: is there a marked script anywhere below the
   * root? Memoised per scan generation (Fix 3) — without this, every root
   * `getChildren()` call that finds zero root-level scripts re-reads and
   * re-parses every non-root script in the tree, on top of the per-folder
   * reads `getChildren()` already does as each folder renders.
   *
   * Fix 5 — `generation` is the token the CALLER captured for `scan`, and is
   * exactly what gets written into the cache. Re-reading `this.generation`
   * after this method's own `readFile` awaits (the pre-fix behaviour) is the
   * poisoning bug: a refresh crossing those awaits bumps `this.generation`
   * before this method returns, which would stamp an OLD generation's result
   * onto the NEW generation's cache entry.
   */
  private async hasMarkedScriptBelowRoot(scan: ScriptScanResult, generation: number): Promise<boolean> {
    if (this.markedBelowRootCache && this.markedBelowRootCache.generation === generation) {
      return this.markedBelowRootCache.result;
    }
    let found = false;
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
        found = true;
        break;
      }
    }
    this.markedBelowRootCache = { generation, result: found };
    return found;
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
