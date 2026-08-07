import type { InventoryProvider } from "../../models/inventory";
import type { InventoryProviderRegistry, ProviderRegistration } from "./providerRegistry";

/**
 * EXPERIMENTAL — third-party extension integration point for registering
 * inventory sync providers with Nexus. Obtained via `vscode.extensions
 * .getExtension("<publisher>.vscode-nexterminal")?.exports`. Shape and
 * guarantees may change in a future major version; `contractVersion` is the
 * only field a consumer should branch on.
 *
 * Trust model: provider binding is by string `id`, not by which extension
 * registered it. An inventory source only remembers the `id` it was
 * configured against; at sync time it is handed to whichever provider
 * currently holds that `id` in the registry. If two extensions (or a
 * reinstalled/updated version of one) register the same `id`, a source
 * silently starts syncing against the new registrant — Nexus performs no
 * publisher/identity check. Because `fetchInventory`/`testConnection` receive
 * the source's decrypted secrets (e.g. API tokens) as plain arguments, only
 * register providers for ids you trust, and be aware that any extension
 * enabled in the same VS Code instance can claim an id first.
 */
export interface NexusExtensionApi {
  readonly contractVersion: 1;
  /** Throws (via the registry's own validation) on a malformed provider or a duplicate id. */
  registerInventoryProvider(provider: InventoryProvider): { dispose(): void };
}

/** Wraps `registry.register` behind the frozen public shape returned from `activate()`. */
export function createNexusExtensionApi(registry: InventoryProviderRegistry): NexusExtensionApi {
  const api: NexusExtensionApi = {
    contractVersion: 1,
    registerInventoryProvider(provider: InventoryProvider): ProviderRegistration {
      return registry.register(provider);
    }
  };
  return Object.freeze(api);
}
