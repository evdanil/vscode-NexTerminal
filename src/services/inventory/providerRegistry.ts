import type { InventoryConfigFieldType, InventoryProvider } from "../../models/inventory";

/** vscode.Disposable-shaped without importing vscode — this module runs in tests without the API. */
export interface ProviderRegistration {
  dispose(): void;
}

const VALID_FIELD_TYPES: ReadonlySet<InventoryConfigFieldType> = new Set(["string", "password", "number", "boolean"]);
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Throws with a specific, distinguishing message per violation rather than a
 * generic "invalid provider" — callers (registerInventoryProvider consumers)
 * need to know exactly what's wrong with the shape they registered.
 */
export function validateProviderShape(provider: unknown): asserts provider is InventoryProvider {
  if (typeof provider !== "object" || provider === null) {
    throw new Error("Inventory provider must be an object.");
  }
  const obj = provider as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0 || !PROVIDER_ID_RE.test(obj.id)) {
    throw new Error("Inventory provider id must be a non-empty string matching /^[a-z0-9][a-z0-9-]*$/i.");
  }
  if (typeof obj.label !== "string" || obj.label.length === 0) {
    throw new Error("Inventory provider label must be a non-empty string.");
  }
  if (!Array.isArray(obj.configFields)) {
    throw new Error("Inventory provider configFields must be an array.");
  }
  const seenFieldIds = new Set<string>();
  for (const field of obj.configFields) {
    if (typeof field !== "object" || field === null) {
      throw new Error("Inventory provider configFields entries must be objects.");
    }
    const f = field as Record<string, unknown>;
    if (typeof f.id !== "string" || f.id.length === 0) {
      throw new Error("Inventory provider configFields entries must have a non-empty id.");
    }
    if (typeof f.label !== "string" || f.label.length === 0) {
      throw new Error(`Inventory provider configFields entry "${f.id}" must have a non-empty label.`);
    }
    if (typeof f.type !== "string" || !VALID_FIELD_TYPES.has(f.type as InventoryConfigFieldType)) {
      throw new Error(`Inventory provider configFields entry "${f.id}" has an invalid type "${String(f.type)}".`);
    }
    if (seenFieldIds.has(f.id)) {
      throw new Error(`Inventory provider configFields has a duplicate field id "${f.id}".`);
    }
    seenFieldIds.add(f.id);
  }
  if (typeof obj.testConnection !== "function") {
    throw new Error("Inventory provider must implement testConnection().");
  }
  if (typeof obj.fetchInventory !== "function") {
    throw new Error("Inventory provider must implement fetchInventory().");
  }
}

/**
 * In-memory registry of inventory providers, keyed by provider id. Consumers
 * (built-in NetBox provider, third-party extensions via the public API) each
 * get a disposable handle back from register(); disposing removes only their
 * own registration, keyed by identity rather than id — dispose(A) must never
 * remove a later registration B that happens to share A's id or label.
 */
export class InventoryProviderRegistry {
  private readonly providers = new Map<string, InventoryProvider>();

  public register(provider: InventoryProvider): ProviderRegistration {
    validateProviderShape(provider);
    if (this.providers.has(provider.id)) {
      throw new Error(`An inventory provider with id "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        // Only remove if this exact registration still owns the id — a
        // disposed-then-re-registered id must survive a stale dispose() call.
        if (this.providers.get(provider.id) === provider) {
          this.providers.delete(provider.id);
        }
      }
    };
  }

  public get(id: string): InventoryProvider | undefined {
    return this.providers.get(id);
  }

  public list(): InventoryProvider[] {
    return [...this.providers.values()];
  }
}
