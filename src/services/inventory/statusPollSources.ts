import type { InventorySourceConfig } from "../../models/inventory";
import type { InventoryStatusPollSource } from "./inventoryStatusPoll";
import { EVE_NG_PROVIDER_ID, readEveNgStatusPollSeconds } from "./providers/eveNgProvider";
import { PROXMOX_PROVIDER_ID, readProxmoxStatusPollSeconds } from "./providers/proxmoxProvider";

/**
 * WHO GETS POLLED — the providerId → poll-interval reader map. A provider
 * takes part in the live status poll by declaring a reader here; the field id,
 * the bounds, and the clamping all stay inside the provider's own module.
 *
 * WHY a map of readers rather than a filter on the config field: the field id
 * happens to be shared, but membership is the PROVIDER's decision. A NetBox
 * source from a hand-edited backup can carry `statusPollSeconds` without its
 * provider ever declaring the field — keying on the config key would arm a
 * poll against a provider that has no status to fetch.
 *
 * Kept `vscode`-free so extension.ts (which no unit test can import) can
 * delegate its `getSources` here and the wiring itself stays unit-testable —
 * the poll-wiring test that used to live beside the scheduler built its own
 * replica of this mapping and so passed with or without the real one.
 */
const STATUS_POLL_READERS: Record<string, (config: InventorySourceConfig["config"]) => number> = {
  [EVE_NG_PROVIDER_ID]: readEveNgStatusPollSeconds,
  [PROXMOX_PROVIDER_ID]: readProxmoxStatusPollSeconds
};

/**
 * Maps the snapshot's inventory sources onto the poll's source list: one entry
 * per source whose provider declares a poll-interval reader, in snapshot
 * order. A source whose interval is 0 (or absent — the readers read that as 0)
 * is KEPT at `intervalSeconds: 0`: "off" is the scheduler's contract to
 * enforce, not the mapper's, and dropping the entry here would lose the
 * disarm-on-zero transition the scheduler re-evaluates on every change.
 */
export function statusPollSources(sources: readonly InventorySourceConfig[]): InventoryStatusPollSource[] {
  const polled: InventoryStatusPollSource[] = [];
  for (const source of sources) {
    const reader = STATUS_POLL_READERS[source.providerId];
    if (!reader) {
      continue;
    }
    polled.push({
      id: source.id,
      intervalSeconds: reader(source.config),
      // The record's `revision` is the scheduler's incarnation marker — see
      // InventoryStatusPollSource's doc for why it must be forwarded.
      incarnation: source.revision
    });
  }
  return polled;
}
