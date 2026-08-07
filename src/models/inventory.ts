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
