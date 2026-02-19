import * as vscode from "vscode";

interface CategoryDescriptor {
  id: string;
  label: string;
  icon: string;
  category: string;
}

const CATEGORIES: CategoryDescriptor[] = [
  { id: "appearance", label: "Terminal Appearance", icon: "paintcan", category: "" },
  { id: "logging", label: "Logging", icon: "output", category: "logging" },
  { id: "ssh", label: "SSH & Tunnels", icon: "plug", category: "ssh" },
  { id: "terminal", label: "Terminal Behavior", icon: "terminal", category: "terminal" }
];

export class SettingsCategoryItem extends vscode.TreeItem {
  public constructor(
    public readonly descriptor: CategoryDescriptor
  ) {
    super(descriptor.label, vscode.TreeItemCollapsibleState.None);
    this.id = `settings-category:${descriptor.id}`;
    this.iconPath = new vscode.ThemeIcon(descriptor.icon);
    this.contextValue = "nexus.settingsCategory";
    if (descriptor.id === "appearance") {
      this.command = {
        command: "nexus.terminal.appearance",
        title: "Terminal Appearance"
      };
      this.tooltip = "Click to customize terminal colors and fonts";
    } else {
      this.command = {
        command: "nexus.settings.openPanel",
        title: "Open Settings",
        arguments: [descriptor.category]
      };
      this.tooltip = `Click to open ${descriptor.label} settings`;
    }
  }
}

export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingsCategoryItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SettingsCategoryItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: SettingsCategoryItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): SettingsCategoryItem[] {
    return CATEGORIES.map((cat) => new SettingsCategoryItem(cat));
  }
}
