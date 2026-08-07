import type { InventoryProvider } from "../../models/inventory";
import type { InventoryProviderRegistry, ProviderRegistration } from "./providerRegistry";

/**
 * EXPERIMENTAL — third-party extension integration point for registering
 * inventory sync providers with Nexus. Obtained via `vscode.extensions
 * .getExtension("<publisher>.vscode-nexterminal")?.exports`. Shape and
 * guarantees may change in a future major version; `contractVersion` is the
 * only field a consumer should branch on.
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
