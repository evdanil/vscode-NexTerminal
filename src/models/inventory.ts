export const INVENTORY_CONTRACT_VERSION = 1 as const;

export type InventoryEndpointKind = "ssh" | "redfish" | "url" | "ipmi-sol";

/**
 * One way to reach a device. Phase 1 only maps the FIRST endpoint with
 * kind === "ssh"; all other kinds (and extra ssh endpoints) are accepted,
 * preserved on the tree, and otherwise unused.
 */
export interface InventoryEndpoint {
  kind: InventoryEndpointKind;
  host: string; // hostname or IP, no CIDR suffix
  port?: number; // ssh default 22
  username?: string; // if set, the SOURCE owns username on the mapped server
  attributes?: Record<string, string | number | boolean>; // future kinds; ignored Phase 1
}

export interface InventoryDevice {
  externalId: string; // REQUIRED, stable across syncs, unique within one source
  name: string;
  folderPath?: string; // slash path RELATIVE to source targetFolder; ""/undefined = at targetFolder
  endpoints: InventoryEndpoint[];
}

export interface InventoryTree {
  contractVersion: 1;
  devices: InventoryDevice[];
  warnings?: string[]; // provider-side notices surfaced in plan summary
  // FIX 2 — set by a provider when it stopped collecting early because it hit
  // its own hard cap (not because the source ran out of devices). When true,
  // computeSyncPlan skips the prune phase entirely: a capped fetch must never
  // be mistaken for "these devices no longer exist at the source".
  truncated?: boolean;
}

export type InventoryConfigFieldType = "string" | "password" | "number" | "boolean";

export interface InventoryConfigField {
  id: string;
  label: string;
  type: InventoryConfigFieldType;
  required?: boolean;
  placeholder?: string;
  description?: string;
}

export type InventorySourceValues = Record<string, string | number | boolean>; // secrets NEVER here
export type InventorySourceSecrets = Record<string, string>; // from SecretStorage

export interface InventoryProvider {
  id: string; // e.g. "netbox"; unique in registry
  label: string;
  configFields: InventoryConfigField[];
  testConnection(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void>;
  fetchInventory(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryTree>;
}

export type InventoryErrorKind = "auth" | "network" | "protocol";

export class InventoryProviderError extends Error {
  public constructor(
    public readonly kind: InventoryErrorKind,
    message: string
  ) {
    super(message);
    this.name = "InventoryProviderError";
  }
}

export type InventoryPrunePolicy = "delete" | "orphan" | "keep";

export interface InventorySourceConfig {
  id: string; // randomUUID at creation
  providerId: string;
  name: string; // user-facing
  targetFolder: string; // normalized, or "" for root (allowed, discouraged)
  prunePolicy: InventoryPrunePolicy; // default "orphan"
  defaultUsername: string; // fallback SSH username applied AT ADD TIME only
  config: InventorySourceValues; // non-secret provider config
  secretFieldIds: string[]; // password-type field ids captured at save time (for cleanup/backup independence from provider registration)
  lastSyncAt?: number;
}

export function inventorySecretKey(sourceId: string, fieldId: string): string {
  return `inventory-source-${sourceId}-${fieldId}`;
}

/**
 * Exported (not just used by sourceConfigUnchanged below) because
 * inventoryCommands.ts's syncNow also uses it directly to compare the vault
 * secret values captured at fetch time against a re-read taken immediately
 * before apply (FINDING D) — InventorySourceSecrets is structurally a
 * Record<string, string>, a subtype of InventorySourceValues, so this
 * comparator works for both.
 */
export function inventorySourceValuesEqual(a: InventorySourceValues, b: InventorySourceValues): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

function secretFieldIdsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * FINDINGS D/E — compares exactly the InventorySourceConfig fields that feed
 * computeSyncPlan/planToApplication (and the fetchInventory config; secret
 * VALUES are compared separately against the vault — see
 * inventoryCommands.ts's post-teardown check, which core cannot perform
 * itself since it has no vault access). A source record that differs on any
 * of these must not have a tree fetched under the OLD config applied against
 * it, even though its id still exists — e.g. a replace-mode config import can
 * delete and recreate the same source id with an entirely different provider
 * config while a sync is mid-flight.
 *
 * Lives here (not in commands or core) so both `NexusCore.applyInventorySyncPlan`
 * (the atomic, pre-mutation guard) and `inventoryCommands.ts`'s earlier
 * fast-fail checks share one comparator — core must not import from commands.
 */
export function sourceConfigUnchanged(a: InventorySourceConfig, b: InventorySourceConfig): boolean {
  return (
    a.providerId === b.providerId &&
    a.targetFolder === b.targetFolder &&
    a.prunePolicy === b.prunePolicy &&
    a.defaultUsername === b.defaultUsername &&
    inventorySourceValuesEqual(a.config, b.config) &&
    secretFieldIdsEqual(a.secretFieldIds, b.secretFieldIds)
  );
}
