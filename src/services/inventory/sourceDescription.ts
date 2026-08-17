import type { InventorySourceConfig } from "../../models/inventory";
import type { InventoryProviderRegistry } from "./providerRegistry";

/**
 * How an inventory source describes itself in a list — "EVE-NG — synced 3h
 * ago". Lives here, free of any `vscode` import, because TWO surfaces render
 * it: the Manage Inventory Sources panel (commands/inventoryCommands.ts) and
 * the Settings tree's per-source rows (ui/settingsTreeProvider.ts). Two
 * independently-written descriptions of the same record would drift, and the
 * user would reasonably read the difference as meaning something.
 *
 * The phrase is RELATIVE and therefore ages with wall-clock time; a surface
 * that keeps it on screen has to re-render it periodically (the management
 * panel's `refreshWhileVisible`, the tree's core-change refresh).
 */
export function formatLastSync(source: Pick<InventorySourceConfig, "lastSyncAt">, now: number = Date.now()): string {
  if (!source.lastSyncAt) return "never synced";
  const minutes = Math.floor((now - source.lastSyncAt) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.floor(hours / 24)}d ago`;
}

/**
 * `{provider label} — {last sync}`. The label falls back to the RAW
 * `providerId` when the registry cannot resolve it: a source whose provider
 * extension is not installed (or has been disabled) must still be visible and
 * removable, and the id is the only honest thing left to call it.
 */
export function sourceDescription(
  source: Pick<InventorySourceConfig, "providerId" | "lastSyncAt">,
  registry: Pick<InventoryProviderRegistry, "get"> | undefined
): string {
  const providerLabel = registry?.get(source.providerId)?.label ?? source.providerId;
  return `${providerLabel} — ${formatLastSync(source)}`;
}
