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
  "nexus.server.copyInfo",
  "nexus.server.duplicate",
  "nexus.server.rename",
  "nexus.tunnel.add",
  "nexus.tunnel.edit",
  "nexus.tunnel.remove",
  "nexus.tunnel.start",
  "nexus.tunnel.stop",
  "nexus.tunnel.restart",
  "nexus.tunnel.copyInfo",
  "nexus.tunnel.duplicate",
  "nexus.serial.add",
  "nexus.serial.edit",
  "nexus.serial.remove",
  "nexus.serial.listPorts",
  "nexus.serial.connect",
  "nexus.serial.disconnect",
  "nexus.serial.copyInfo",
  "nexus.serial.duplicate",
  "nexus.serial.rename",
  "nexus.serial.sendBreak",
  "nexus.group.connect",
  "nexus.group.disconnect",
  "nexus.group.rename",
  "nexus.settings.openPanel",
  "nexus.settings.openJson",
  "nexus.settings.openLogDir",
  "nexus.settings.resetAll",
  "nexus.tunnel.openBrowser",
  "nexus.profile.add",
  "nexus.group.add",
  "nexus.group.remove",
  "nexus.config.export",
  "nexus.config.export.backup",
  "nexus.config.import",
  "nexus.config.completeReset",
  "nexus.macro.editor",
  "nexus.macro.add",
  "nexus.macro.edit",
  "nexus.macro.remove",
  "nexus.macro.run",
  "nexus.macro.slot",
  "nexus.macro.runBinding",
  "nexus.macro.moveUp",
  "nexus.macro.moveDown",
  "nexus.macro.assignSlot",
  "nexus.macro.runItem",
  "nexus.files.browse",
  "nexus.files.open",
  "nexus.files.upload",
  "nexus.files.download",
  "nexus.files.delete",
  "nexus.files.rename",
  "nexus.files.createDir",
  "nexus.files.createFile",
  "nexus.files.goToPath",
  "nexus.files.goHome",
  "nexus.files.copyPath",
  "nexus.files.refresh",
  "nexus.files.disconnect",
  "nexus.terminal.appearance"
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
  const fileExplorerView = vscode.window.createTreeView("nexusFileExplorer", {
    treeDataProvider: new StaticTreeProvider("Nexus file explorer requires desktop VS Code"),
    showCollapseAll: false
  });
  const commandRegistrations = unsupportedCommands.map((commandId) =>
    vscode.commands.registerCommand(commandId, () => {
      void vscode.window.showWarningMessage(
        "Nexus runtime features are unavailable in the web extension host. Use desktop VS Code."
      );
    })
  );

  context.subscriptions.push(commandCenterView, tunnelsView, fileExplorerView, ...commandRegistrations);
}

export function deactivate(): void {}
