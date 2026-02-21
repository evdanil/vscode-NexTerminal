import * as vscode from "vscode";
import {
  SETTINGS_META,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  formatSettingValueForTree,
  type SettingMeta
} from "./settingsMetadata";

// ----- Tree item types -----

type SettingsTreeItem =
  | SettingsCategoryItem
  | SettingsValueItem
  | SettingsLinkItem
  | DataManagementGroupItem
  | DataManagementActionItem;

export class SettingsCategoryItem extends vscode.TreeItem {
  public readonly kind = "category" as const;
  public constructor(public readonly categoryKey: string) {
    const label = CATEGORY_LABELS[categoryKey] ?? categoryKey;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `settings-category:${categoryKey}`;
    this.iconPath = new vscode.ThemeIcon(CATEGORY_ICONS[categoryKey] ?? "settings-gear");
    this.contextValue = "nexus.settingsCategory";
    this.command = {
      command: "nexus.settings.openPanel",
      title: `Open ${label} Settings`,
      arguments: [categoryKey]
    };
    this.tooltip = `Click to open ${label} settings`;
  }
}

export class SettingsValueItem extends vscode.TreeItem {
  public readonly kind = "value" as const;
  public constructor(
    public readonly meta: SettingMeta,
    public readonly categoryKey: string,
    formattedValue: string
  ) {
    super(`${meta.label}: ${formattedValue}`, vscode.TreeItemCollapsibleState.None);
    this.id = `settings-value:${meta.section}.${meta.key}`;
    this.contextValue = "nexus.settingsValue";
    this.tooltip = meta.description ?? meta.label;
    this.command = {
      command: "nexus.settings.openPanel",
      title: "Open Settings",
      arguments: [categoryKey]
    };
  }
}

export class SettingsLinkItem extends vscode.TreeItem {
  public readonly kind = "link" as const;
  public constructor(
    label: string,
    commandId: string,
    icon: string,
    tooltip: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `settings-link:${commandId}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "nexus.settingsLink";
    this.tooltip = tooltip;
    this.command = { command: commandId, title: label };
  }
}

export class DataManagementGroupItem extends vscode.TreeItem {
  public readonly kind = "dataGroup" as const;
  public constructor() {
    super("Data Management", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "settings-data-management";
    this.iconPath = new vscode.ThemeIcon("database");
    this.contextValue = "nexus.dataManagement";
  }
}

interface DataAction {
  label: string;
  command: string;
  icon: string;
  tooltip: string;
}

const DATA_ACTIONS: DataAction[] = [
  { label: "Backup\u2026", command: "nexus.config.export.backup", icon: "lock", tooltip: "Create an encrypted backup of all data" },
  { label: "Export for Sharing\u2026", command: "nexus.config.export", icon: "export", tooltip: "Export sanitized configuration for sharing" },
  { label: "Import\u2026", command: "nexus.config.import", icon: "import", tooltip: "Import configuration from file" },
  { label: "Reset All to Defaults", command: "nexus.settings.resetAll", icon: "discard", tooltip: "Reset all settings to their default values" },
  { label: "Delete All Data\u2026", command: "nexus.config.completeReset", icon: "warning", tooltip: "Permanently delete all data. This cannot be undone." }
];

export class DataManagementActionItem extends vscode.TreeItem {
  public readonly kind = "dataAction" as const;
  public constructor(action: DataAction) {
    super(action.label, vscode.TreeItemCollapsibleState.None);
    this.id = `settings-action:${action.command}`;
    this.iconPath = new vscode.ThemeIcon(action.icon);
    this.contextValue = "nexus.dataAction";
    this.tooltip = action.tooltip;
    this.command = { command: action.command, title: action.label };
  }
}

// ----- Tree provider -----

export class SettingsTreeProvider
  implements vscode.TreeDataProvider<SettingsTreeItem>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SettingsTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly configListener: vscode.Disposable;

  public constructor() {
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      const affected = SETTINGS_META.some(
        (m) => event.affectsConfiguration(`${m.section}.${m.key}`)
      );
      if (affected) {
        this.onDidChangeTreeDataEmitter.fire(undefined);
      }
    });
  }

  public dispose(): void {
    this.configListener.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: SettingsTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: SettingsTreeItem): SettingsTreeItem[] {
    if (!element) {
      return this.getRootItems();
    }
    if (element instanceof SettingsCategoryItem) {
      return this.getCategoryChildren(element.categoryKey);
    }
    if (element instanceof DataManagementGroupItem) {
      return this.getDataManagementActions();
    }
    return [];
  }

  private getRootItems(): SettingsTreeItem[] {
    const items: SettingsTreeItem[] = [];

    // 6 setting categories
    for (const cat of CATEGORY_ORDER) {
      items.push(new SettingsCategoryItem(cat));
    }

    // 2 link items
    items.push(
      new SettingsLinkItem("Terminal Appearance", "nexus.terminal.appearance", "paintcan", "Customize terminal colors and fonts")
    );
    items.push(
      new SettingsLinkItem("Macros", "nexus.macro.editor", "record-keys", "Open the macro editor")
    );

    // 1 data management group
    items.push(new DataManagementGroupItem());

    return items;
  }

  private getCategoryChildren(categoryKey: string): SettingsValueItem[] {
    const metas = SETTINGS_META.filter((m) => m.category === categoryKey);
    const items: SettingsValueItem[] = [];

    for (const meta of metas) {
      // Apply visibleWhen filtering
      if (meta.visibleWhen) {
        const parts = meta.visibleWhen.setting.lastIndexOf(".");
        const section = meta.visibleWhen.setting.substring(0, parts);
        const key = meta.visibleWhen.setting.substring(parts + 1);
        const config = vscode.workspace.getConfiguration(section);
        const currentValue = config.get(key);
        if (currentValue !== meta.visibleWhen.value) {
          continue;
        }
      }

      const config = vscode.workspace.getConfiguration(meta.section);
      const rawValue = config.get(meta.key);
      const formatted = formatSettingValueForTree(meta, rawValue);
      items.push(new SettingsValueItem(meta, categoryKey, formatted));
    }
    return items;
  }

  private getDataManagementActions(): DataManagementActionItem[] {
    return DATA_ACTIONS.map((a) => new DataManagementActionItem(a));
  }
}
