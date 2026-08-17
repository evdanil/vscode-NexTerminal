import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { InventoryProviderRegistry } from "../services/inventory/providerRegistry";
import { sourceDescription } from "../services/inventory/sourceDescription";
import {
  SETTINGS_META,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  CATEGORY_DESCRIPTIONS,
  formatSettingValueForTree,
  type SettingMeta
} from "./settingsMetadata";

// ----- Tree item types -----

type SettingsTreeItem =
  | SettingsCategoryItem
  | SettingsValueItem
  | SettingsLinkItem
  | DataManagementGroupItem
  | DataManagementActionItem
  | InventorySourcesGroupItem
  | InventorySourceItem;

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
    this.tooltip = CATEGORY_DESCRIPTIONS[categoryKey] ?? `Click to open ${label} settings`;
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

// nexus.config.import is the unified chooser (Nexus export, MobaXterm INI,
// SecureCRT, or a CSV/text host list) \u2014 one row covers what used to be two.
const DATA_ACTIONS: DataAction[] = [
  { label: "Backup\u2026", command: "nexus.config.export.backup", icon: "lock", tooltip: "Create an encrypted backup of all data" },
  { label: "Export for Sharing\u2026", command: "nexus.config.export", icon: "export", tooltip: "Export sanitized configuration for sharing" },
  { label: "Import\u2026", command: "nexus.config.import", icon: "cloud-download", tooltip: "Import servers or configuration \u2014 Nexus export, MobaXterm INI, SecureCRT, or a CSV/text host list" },
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

/**
 * Inventory sources used to be ONE row that opened the manage QuickPick, so
 * "which sources do I have, and when did each last sync" needed a modal to
 * answer and every per-source action was two clicks behind a picker. This
 * group renders the sources themselves, with the same four actions inline.
 *
 * PROVIDER-AGNOSTIC by construction: every row is built from the snapshot
 * record plus the registry's label lookup, with no branch on `providerId`.
 */
export class InventorySourcesGroupItem extends vscode.TreeItem {
  public readonly kind = "inventorySourcesGroup" as const;
  public constructor() {
    super("Inventory Sources", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "settings-inventory-sources";
    this.iconPath = new vscode.ThemeIcon("server-environment");
    this.contextValue = "nexus.inventorySourcesGroup";
    this.tooltip = "Add, edit, sync, and remove inventory sources";
  }
}

export class InventorySourceItem extends vscode.TreeItem {
  public readonly kind = "inventorySource" as const;
  public constructor(
    public readonly sourceId: string,
    name: string,
    description: string
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = `settings-inventory-source:${sourceId}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon("server-environment");
    // Keyed on by the four `view/item/context` inline entries in package.json.
    this.contextValue = "nexus.inventorySource";
    this.tooltip = `${name} — ${description}`;
    // A click carries the source id as the command argument, so the editor
    // opens on THIS source directly rather than re-prompting. `resolveSourceIdArg`
    // (commands/inventoryCommands.ts) accepts either form — this string, or the
    // tree item itself via its `sourceId` — so the inline menu actions, which
    // receive the item, resolve to the same source.
    this.command = { command: "nexus.inventory.editSource", title: "Edit Inventory Source", arguments: [sourceId] };
  }
}

// ----- Tree provider -----

export class SettingsTreeProvider
  implements vscode.TreeDataProvider<SettingsTreeItem>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SettingsTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly configListener: vscode.Disposable;
  /** NexusCore's onDidChange returns an unsubscribe function, not a Disposable. */
  private readonly coreListener?: () => void;
  /** MINOR-8 — the inventory-relevant slice of the last snapshot, so an unrelated core event does not re-render. */
  private lastInventorySignature: string;

  /**
   * `core` and `providerRegistry` are OPTIONAL so the provider stays
   * constructible without them (tests, and any future host that has no core
   * yet). Without a core the Inventory Sources group still renders — with just
   * its "Add Inventory Source…" row — rather than vanishing, because an empty
   * group whose one action is "add the first source" is a starting point and a
   * missing group is a dead end.
   */
  public constructor(
    private readonly core?: NexusCore,
    private readonly providerRegistry?: InventoryProviderRegistry
  ) {
    this.lastInventorySignature = this.inventorySignature();
    // MINOR-8 — `NexusCore.onDidChange` is the whole-state firehose (it fires on
    // every terminal/tunnel/session blink), but the only rows this provider
    // renders from core are the inventory sources. Re-render ONLY when that
    // slice actually changed, so an idle session with active terminals does not
    // re-run `getChildren` — a `getConfiguration` read per value row — many
    // times a second. The signature covers exactly the fields the rows show
    // (id, name, provider, last sync), so a sync's `lastSyncAt` bump refreshes
    // the "synced N ago" label while an unrelated event does not.
    this.coreListener = core?.onDidChange(() => {
      const signature = this.inventorySignature();
      if (signature === this.lastInventorySignature) {
        return;
      }
      this.lastInventorySignature = signature;
      this.onDidChangeTreeDataEmitter.fire(undefined);
    });
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      const affected = SETTINGS_META.some(
        (m) => event.affectsConfiguration(`${m.section}.${m.key}`)
      ) || event.affectsConfiguration("nexus.terminal.highlighting.rules");
      if (affected) {
        this.onDidChangeTreeDataEmitter.fire(undefined);
      }
    });
  }

  public dispose(): void {
    this.coreListener?.();
    this.configListener.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  /** MINOR-8 — exactly the inventory-source fields the rows render, as a comparable string. */
  private inventorySignature(): string {
    const sources = this.core?.getSnapshot().inventorySources ?? [];
    return JSON.stringify(sources.map((s) => [s.id, s.name, s.providerId, s.lastSyncAt ?? 0]));
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
    if (element instanceof InventorySourcesGroupItem) {
      return this.getInventorySourceItems();
    }
    return [];
  }

  private getRootItems(): SettingsTreeItem[] {
    const items: SettingsTreeItem[] = [];

    // Setting categories
    for (const cat of CATEGORY_ORDER) {
      items.push(new SettingsCategoryItem(cat));
    }

    items.push(
      new SettingsLinkItem("Macros", "nexus.macro.editor", "record-keys", "Open the macro editor")
    );
    items.push(
      // §7 UX-M6 — description changed to "reusable SSH credentials" so
      // "template" means exactly one thing (the device template) in the product.
      new SettingsLinkItem("Auth Profiles", "nexus.authProfile.manage", "key", "Create and manage reusable SSH credentials")
    );
    // Device templates settings-tree row, beside Auth Profiles (§7.1).
    items.push(
      new SettingsLinkItem("Device Templates", "nexus.deviceTemplate.manage", "layers", "Apply shared settings to servers synced from inventory")
    );
    // Inventory sources are an expandable GROUP rather than a link: a link can
    // only open the manage QuickPick, which is where the sources and their
    // per-source actions used to be hidden. `nexus.inventory.manage` is
    // deliberately left in place and unchanged — the hub is still the palette
    // route in.
    items.push(new InventorySourcesGroupItem());

    return items;
  }

  private getCategoryChildren(categoryKey: string): SettingsTreeItem[] {
    const metas = SETTINGS_META.filter((m) => m.category === categoryKey);
    const items: SettingsTreeItem[] = [];

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
    if (categoryKey === "securityData") {
      items.push(new DataManagementGroupItem());
    }
    return items;
  }

  private getInventorySourceItems(): SettingsTreeItem[] {
    const sources = this.core?.getSnapshot().inventorySources ?? [];
    const items: SettingsTreeItem[] = sources.map(
      (source) => new InventorySourceItem(source.id, source.name, sourceDescription(source, this.providerRegistry))
    );
    // Always last, always present — including when the list above is empty.
    items.push(
      new SettingsLinkItem("Add Inventory Source\u2026", "nexus.inventory.addSource", "add", "Add a new inventory source")
    );
    return items;
  }

  private getDataManagementActions(): DataManagementActionItem[] {
    return DATA_ACTIONS.map((a) => new DataManagementActionItem(a));
  }
}
