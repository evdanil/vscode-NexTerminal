import * as vscode from "vscode";

interface SettingDescriptor {
  key: string;
  section: string;
  label: string;
  icon: string;
  format: (value: unknown, context?: SettingsContext) => string;
}

interface SettingsContext {
  defaultLogDir: string;
}

const SETTINGS: SettingDescriptor[] = [
  {
    key: "sessionLogDirectory",
    section: "nexus.logging",
    label: "Session Log Directory",
    icon: "folder",
    format: (v, ctx) => (typeof v === "string" && v ? v : ctx?.defaultLogDir ?? "(default)")
  },
  {
    key: "sessionTranscripts",
    section: "nexus.logging",
    label: "Session Transcripts",
    icon: "output",
    format: (v) => (v === false ? "Off" : "On")
  },
  {
    key: "maxFileSizeMb",
    section: "nexus.logging",
    label: "Max Log File Size",
    icon: "file-binary",
    format: (v) => `${typeof v === "number" ? v : 10} MB`
  },
  {
    key: "maxRotatedFiles",
    section: "nexus.logging",
    label: "Max Rotated Files",
    icon: "history",
    format: (v) => `${typeof v === "number" ? v : 1}`
  },
  {
    key: "defaultConnectionMode",
    section: "nexus.tunnel",
    label: "Default Tunnel Mode",
    icon: "git-merge",
    format: (v) => (v === "shared" ? "Shared" : "Isolated")
  },
  {
    key: "openLocation",
    section: "nexus.terminal",
    label: "Terminal Open Location",
    icon: "layout",
    format: (v) => (v === "editor" ? "Editor Tab" : "Panel")
  },
  {
    key: "enabled",
    section: "nexus.terminal.highlighting",
    label: "Terminal Highlighting",
    icon: "symbol-color",
    format: (v) => (v === false ? "Off" : "On")
  }
];

export class SettingTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly descriptor: SettingDescriptor,
    value: unknown,
    context?: SettingsContext
  ) {
    super(descriptor.label, vscode.TreeItemCollapsibleState.None);
    this.id = `setting:${descriptor.section}.${descriptor.key}`;
    this.description = descriptor.format(value, context);
    this.iconPath = new vscode.ThemeIcon(descriptor.icon);
    this.contextValue = "nexus.setting";
    this.command = {
      command: "nexus.settings.edit",
      title: "Edit Setting",
      arguments: [this]
    };
    this.tooltip = `${descriptor.label}: ${this.description}\nClick to change`;
  }
}

export class AppearanceTreeItem extends vscode.TreeItem {
  public constructor(description: string) {
    super("Terminal Appearance", vscode.TreeItemCollapsibleState.None);
    this.id = "setting:nexus.terminal.appearance";
    this.description = description;
    this.iconPath = new vscode.ThemeIcon("paintcan");
    this.contextValue = "nexus.appearance";
    this.command = {
      command: "nexus.terminal.appearance",
      title: "Terminal Appearance"
    };
    this.tooltip = `Terminal Appearance: ${description}\nClick to customize colors and fonts`;
  }
}

export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingTreeItem | AppearanceTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SettingTreeItem | AppearanceTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly defaultLogDir: string,
    private readonly getAppearanceDescription: () => string = () => "Default"
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: SettingTreeItem | AppearanceTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): (SettingTreeItem | AppearanceTreeItem)[] {
    const context: SettingsContext = { defaultLogDir: this.defaultLogDir };
    const items: (SettingTreeItem | AppearanceTreeItem)[] = [
      new AppearanceTreeItem(this.getAppearanceDescription())
    ];
    for (const desc of SETTINGS) {
      const config = vscode.workspace.getConfiguration(desc.section);
      const value = config.get(desc.key);
      items.push(new SettingTreeItem(desc, value, context));
    }
    return items;
  }
}
