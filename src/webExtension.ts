import * as vscode from "vscode";

class StaticTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  public constructor(private readonly label: string) {}

  public readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = new vscode.EventEmitter<
    vscode.TreeItem | undefined
  >().event;

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = "Desktop host required";
    item.iconPath = new vscode.ThemeIcon("info");
    return [item];
  }
}

const unsupportedCommands = [
  "nexus.refresh",
  "nexus.server.add",
  "nexus.server.edit",
  "nexus.server.remove",
  "nexus.server.connect",
  "nexus.server.disconnect",
  "nexus.tunnel.add",
  "nexus.tunnel.edit",
  "nexus.tunnel.remove",
  "nexus.tunnel.start",
  "nexus.tunnel.stop",
  "nexus.serial.add",
  "nexus.serial.edit",
  "nexus.serial.remove",
  "nexus.serial.listPorts",
  "nexus.serial.connect",
  "nexus.serial.disconnect"
];

export function activate(context: vscode.ExtensionContext): void {
  const commandCenterView = vscode.window.createTreeView("nexusCommandCenter", {
    treeDataProvider: new StaticTreeProvider("Nexus SSH requires desktop VS Code"),
    showCollapseAll: false
  });
  const tunnelsView = vscode.window.createTreeView("nexusTunnels", {
    treeDataProvider: new StaticTreeProvider("Nexus tunnels require desktop VS Code"),
    showCollapseAll: false
  });
  const commandRegistrations = unsupportedCommands.map((commandId) =>
    vscode.commands.registerCommand(commandId, () => {
      void vscode.window.showWarningMessage(
        "Nexus runtime features are unavailable in the web extension host. Use desktop VS Code."
      );
    })
  );

  context.subscriptions.push(commandCenterView, tunnelsView, ...commandRegistrations);
}

export function deactivate(): void {}
