import { describe, expect, it } from "vitest";
import { statusPollSources } from "../../src/services/inventory/statusPollSources";
import { EVE_NG_PROVIDER_ID } from "../../src/services/inventory/providers/eveNgProvider";
import { PROXMOX_PROVIDER_ID } from "../../src/services/inventory/providers/proxmoxProvider";
import { NETBOX_PROVIDER_ID } from "../../src/services/inventory/providers/netboxProvider";
import { GNS3_PROVIDER_ID } from "../../src/services/inventory/providers/gns3Provider";
import type { InventorySourceConfig, InventorySourceValues } from "../../src/models/inventory";

/**
 * WHO GETS POLLED — the pure mapping extension.ts's status-poll `getSources`
 * delegates to. extension.ts imports `vscode`, so no unit test can import it:
 * the filter+map lives here (vscode-free) so the wiring itself is what is
 * under test. A wiring that forgets a polled provider, or that polls by
 * config key instead of provider reader, fails here.
 */
function makeSource(id: string, providerId: string, config: InventorySourceValues = {}, revision = `rev-${id}`): InventorySourceConfig {
  return {
    id,
    providerId,
    name: id,
    targetFolder: "Labs",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config,
    secretFieldIds: [],
    revision
  };
}

describe("statusPollSources", () => {
  it("maps an EVE-NG source's poll field onto its poll entry", () => {
    const sources = [makeSource("eve-1", EVE_NG_PROVIDER_ID, { statusPollSeconds: 60 })];
    expect(statusPollSources(sources)).toEqual([
      { id: "eve-1", intervalSeconds: 60, incarnation: "rev-eve-1" }
    ]);
  });

  it("maps a Proxmox source identically — a wiring that forgets the second polled provider fails here", () => {
    const sources = [makeSource("pve-1", PROXMOX_PROVIDER_ID, { statusPollSeconds: 60 })];
    expect(statusPollSources(sources)).toEqual([
      { id: "pve-1", intervalSeconds: 60, incarnation: "rev-pve-1" }
    ]);
  });

  it("maps a GNS3 source identically — a wiring that forgets the third polled provider fails here", () => {
    const sources = [makeSource("gns3-1", GNS3_PROVIDER_ID, { statusPollSeconds: 60 })];
    expect(statusPollSources(sources)).toEqual([
      { id: "gns3-1", intervalSeconds: 60, incarnation: "rev-gns3-1" }
    ]);
  });

  it("does NOT poll a NetBox source carrying statusPollSeconds in its config — polling is by provider reader, not by config key", () => {
    // NetBox has no Lab Status Poll Interval field, but a hand-edited backup
    // can carry the key on any provider. A filter keyed on the config field
    // would arm a poll against a provider that never declared one.
    const sources = [makeSource("nb-1", NETBOX_PROVIDER_ID, { statusPollSeconds: 60 })];
    expect(statusPollSources(sources)).toEqual([]);
  });

  it("keeps a source whose interval is 0 or absent, at intervalSeconds 0 — OFF is the scheduler's contract to enforce", () => {
    const sources = [
      makeSource("eve-off", EVE_NG_PROVIDER_ID, { statusPollSeconds: 0 }),
      makeSource("pve-absent", PROXMOX_PROVIDER_ID)
    ];
    expect(statusPollSources(sources)).toEqual([
      { id: "eve-off", intervalSeconds: 0, incarnation: "rev-eve-off" },
      { id: "pve-absent", intervalSeconds: 0, incarnation: "rev-pve-absent" }
    ]);
  });

  it("routes clamping through each provider's own reader: 9999 ⇒ 3600 and 1.9 ⇒ 1", () => {
    const sources = [
      makeSource("eve-hi", EVE_NG_PROVIDER_ID, { statusPollSeconds: 9999 }),
      makeSource("eve-frac", EVE_NG_PROVIDER_ID, { statusPollSeconds: 1.9 }),
      makeSource("pve-hi", PROXMOX_PROVIDER_ID, { statusPollSeconds: 9999 }),
      makeSource("pve-frac", PROXMOX_PROVIDER_ID, { statusPollSeconds: 1.9 })
    ];
    expect(statusPollSources(sources).map((s) => s.intervalSeconds)).toEqual([3600, 1, 3600, 1]);
  });
});
