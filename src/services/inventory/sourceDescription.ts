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
 * P2-1 — the ABSOLUTE last-sync stamp for a surface that does NOT re-render on
 * a timer or on every core event. The Settings tree's refresh is gated on the
 * source record changing (MINOR-8), so a RELATIVE label there would freeze at
 * whatever age it first rendered ("synced just now" forever). This form is a
 * pure function of `lastSyncAt` — it takes no `now`, so the same record renders
 * the same string whenever the row is (re)built, and the only thing that moves
 * it is a real sync bumping `lastSyncAt`.
 *
 * Local `YYYY-MM-DD HH:MM` — compact, unambiguous, and free of the "N ago"
 * vocabulary a suppressed refresh would strand.
 */
export function formatLastSyncAbsolute(source: Pick<InventorySourceConfig, "lastSyncAt">): string {
  if (!source.lastSyncAt) return "never synced";
  const d = new Date(source.lastSyncAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `synced ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The provider label, or the raw providerId when the registry cannot resolve it (extension missing/disabled — the source must stay visible and removable). */
function providerLabelOf(providerId: string, registry: Pick<InventoryProviderRegistry, "get"> | undefined): string {
  return registry?.get(providerId)?.label ?? providerId;
}

/**
 * `{provider label} — {relative last sync}`, for a surface that re-renders while
 * visible (the Manage Inventory Sources panel's `refreshWhileVisible`).
 */
export function sourceDescription(
  source: Pick<InventorySourceConfig, "providerId" | "lastSyncAt">,
  registry: Pick<InventoryProviderRegistry, "get"> | undefined
): string {
  return `${providerLabelOf(source.providerId, registry)} — ${formatLastSync(source)}`;
}

/**
 * `{provider label} — {absolute last sync}`, for a surface whose refresh is
 * gated on the record changing (the Settings tree — see `formatLastSyncAbsolute`).
 */
export function sourceDescriptionAbsolute(
  source: Pick<InventorySourceConfig, "providerId" | "lastSyncAt">,
  registry: Pick<InventoryProviderRegistry, "get"> | undefined
): string {
  return `${providerLabelOf(source.providerId, registry)} — ${formatLastSyncAbsolute(source)}`;
}
