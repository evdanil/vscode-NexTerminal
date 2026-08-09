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
 * reinstalled/updated version of one) register the same `id`, a source would
 * silently start syncing against the new registrant — Nexus performs no
 * publisher/identity check, because VS Code exposes no caller identity for
 * `registerInventoryProvider` at all. Because `fetchInventory`/`testConnection`
 * receive the source's decrypted secrets (e.g. API tokens) as plain
 * arguments, only register providers for ids you trust, and be aware that
 * any extension enabled in the same VS Code instance can claim an id first.
 *
 * Mitigation (honest, not a real identity check): each inventory source
 * stores a `providerFingerprint` — a hash of the registered provider's
 * OBSERVABLE shape (its `label` and `configFields`) taken at the moment the
 * source was created or last edited (see `computeProviderFingerprint()` in
 * `models/inventory.ts`). Before reading any of the source's saved
 * credentials, `syncNow` recomputes that fingerprint against the CURRENT
 * registrant for the source's `providerId` and, on a mismatch, shows a modal
 * asking the user to confirm handing that registrant the saved credentials
 * (Cancel aborts before any secret is read). This only detects that the
 * registrant's declared shape changed — a replacement provider that happens
 * to declare an identical label/configFields (or a user who clicks through
 * the warning) is indistinguishable from the original. It closes the SILENT
 * handover, not the trust boundary itself.
 *
 * ADOPT-ON-ADD AND `instanceKey` (REVIEW FINDING, P1): a provider that does not
 * implement the optional `instanceKey(config)` method gets no adoption — a
 * server kept when one of its sources was removed is added again as a new server
 * rather than reclaimed. That is a deliberate refusal, not an oversight. Nexus
 * cannot tell two DEPLOYMENTS of one provider apart on its own
 * (`InventoryDevice.externalId` is unique only within one of them), and the
 * fallback — treating the provider id as the instance identity — is what let one
 * deployment's device claim another deployment's kept server, stored credentials
 * included. Implementing `instanceKey` opts a provider back in; see its contract
 * in `models/inventory.ts`, in particular that the key is persisted and exported
 * in backups and must therefore never carry a secret.
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
