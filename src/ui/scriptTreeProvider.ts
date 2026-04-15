import * as vscode from "vscode";
import { parseScriptHeader } from "../services/scripts/scriptHeader";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";

export type ScriptNode =
  | { kind: "script"; uri: vscode.Uri; name: string; description: string; running: boolean; parseErrors: string[] }
  | { kind: "placeholder"; label: string; detail?: string };

export class ScriptTreeProvider implements vscode.TreeDataProvider<ScriptNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
  private watcher?: vscode.FileSystemWatcher;
  private readonly managerListener: vscode.Disposable;

  public constructor(private readonly manager: ScriptRuntimeManager) {
    this.managerListener = this.manager.onDidChangeRun(() => this.refresh());
    this.ensureWatcher();
  }

  public dispose(): void {
    this.watcher?.dispose();
    this.managerListener.dispose();
    this._onDidChangeTreeData.dispose();
  }

  public refresh(): void {
    this.ensureWatcher();
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(node: ScriptNode): vscode.TreeItem {
    if (node.kind === "placeholder") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.detail;
      item.contextValue = "nexus.script.placeholder";
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
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
    if (node.parseErrors.length === 0) {
      item.command = {
        title: "Open",
        command: "vscode.open",
        arguments: [node.uri]
      };
    }
    return item;
  }

  public async getChildren(): Promise<ScriptNode[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [{ kind: "placeholder", label: "Open a folder to author scripts" }];
    }
    const scriptsPath = vscode.workspace
      .getConfiguration("nexus.scripts")
      .get<string>("path", ".nexus/scripts");
    const root = folders[0].uri;
    const dir = vscode.Uri.joinPath(root, scriptsPath);

    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [{ kind: "placeholder", label: "No scripts found", detail: scriptsPath }];
    }

    const runningPaths = new Set(this.manager.getRuns().map((r) => r.scriptPath));
    const nodes: ScriptNode[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      if (!name.endsWith(".js")) continue;
      const fileUri = vscode.Uri.joinPath(dir, name);
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        text = new TextDecoder("utf-8").decode(bytes);
      } catch {
        continue;
      }
      const header = parseScriptHeader(text);
      if (!header.marker) continue;
      nodes.push({
        kind: "script",
        uri: fileUri,
        name: header.name ?? name.replace(/\.[^.]+$/, ""),
        description: header.description ?? "",
        running: runningPaths.has(fileUri.fsPath),
        parseErrors: header.parseErrors
      });
    }

    if (nodes.length === 0) {
      return [{ kind: "placeholder", label: "No scripts found", detail: scriptsPath }];
    }
    return nodes;
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const scriptsPath = vscode.workspace
      .getConfiguration("nexus.scripts")
      .get<string>("path", ".nexus/scripts");
    const pattern = new vscode.RelativePattern(folders[0], `${scriptsPath}/**/*.js`);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate(() => this._onDidChangeTreeData.fire());
    this.watcher.onDidChange(() => this._onDidChangeTreeData.fire());
    this.watcher.onDidDelete(() => this._onDidChangeTreeData.fire());
  }
}
