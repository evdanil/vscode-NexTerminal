import type { InventoryProvider } from "../../models/inventory";
import { createEveNgProvider } from "./providers/eveNgProvider";
import { createNetboxProvider } from "./providers/netboxProvider";
import { createProxmoxProvider } from "./providers/proxmoxProvider";

/**
 * THE one place a built-in inventory provider is declared. Two separate
 * consumers read it, and that is the point:
 *
 *  - `extension.ts:activate()` registers each entry, in order;
 *  - `packageContributions.test.ts` derives the set of names that
 *    `nexus.inventory.addSource`'s title and the Command Center welcome view
 *    must contain, from each provider's own `label`.
 *
 * WHY IT EXISTS. Proxmox shipped without joining the second of those. The
 * governing rule was already written down — *"the rule is not 'name no
 * provider', it is 'exclude no provider'"* — and the check that enforces it
 * already existed and already passed, because its expected list was a
 * hand-written literal that nobody extended. A user searching the Command
 * Palette for "proxmox" matched nothing and concluded the feature was absent,
 * which is the exact outcome that rule exists to prevent. A check whose input
 * is hand-maintained can only verify the entries someone remembered to add.
 * Deriving both consumers from this array is what makes forgetting impossible
 * rather than merely discouraged.
 *
 * The same history has a second half worth naming, because it is the failure
 * this array's FIRST consumer prevents: Proxmox also spent twenty-odd commits
 * feature-complete but unreachable, because the `register()` line was missing.
 * A provider added here cannot ship unregistered or unnamed.
 *
 * ORDER IS THE ADD-SOURCE PICKER'S ORDER. Append rather than insert unless you
 * intend to re-rank what users see first.
 *
 * Kept `vscode`-free — as `statusPollSources.ts` is, and for the same reason:
 * the wiring itself has to stay unit-testable without dragging the extension
 * host into a test that only wants to know which providers exist.
 */
export function createBuiltInProviders(): InventoryProvider[] {
  return [createNetboxProvider(), createEveNgProvider(), createProxmoxProvider()];
}
