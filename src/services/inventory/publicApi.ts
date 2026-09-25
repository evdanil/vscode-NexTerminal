import type { InventoryProvider } from "../../models/inventory";
import type { InventoryProviderRegistry, ProviderRegistration } from "./providerRegistry";

/**
 * EXPERIMENTAL — third-party extension integration point for registering
 * inventory sync providers with Nexus. Obtained via `vscode.extensions
 * .getExtension("<publisher>.vscode-nexterminal")?.exports`. Shape and
 * guarantees may change in a future major version; `contractVersion` is the
 * only field a consumer should branch on.
 *
 * Trust model — and this doc is where it is WRITTEN. The rule below is
 * restated nowhere else: the fingerprint field and its hash in
 * `models/inventory.ts`, the two gates in `commands/inventoryCommands.ts` and
 * every provider's config-field list carry only what is true at that site plus
 * a pointer here, so changing the rule is an edit to one comment rather than a
 * sweep that has no way of proving itself complete.
 *
 * Provider binding is by string `id`, not by which extension
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
 * OBSERVABLE shape, taken at the moment the source was created, last edited,
 * or last synced successfully (see `computeProviderFingerprint()` in
 * `models/inventory.ts`, which also explains each exclusion). WHAT IT HASHES:
 * the provider's `label`, and its `configFields` — each field's `id`, `label`,
 * `type` and `required` flag, plus a select field's `options` — in the
 * provider's own declared ORDER, so reordering the list is a new shape just as
 * renaming a field is. The `configFields` hashed are the ones the provider
 * REGISTERED with: the registry checks the list and keeps a copy of it when
 * `registerInventoryProvider` is called, and the form, the sync and this hash
 * all read that copy. An edit the provider makes to its array afterwards
 * reaches none of them. What it does NOT hash is everything that describes how a
 * value is entered rather than what the source is configured with (`advanced`,
 * `defaultValue`, `min`/`max`, `integer`, `placeholder`, `description`) and the
 * `id` itself: hashing the id would make every mismatch invisible, since a
 * different provider answering to the SAME id is the whole thing being detected.
 *
 * Every path that PASSES a source's saved credentials TO A PROVIDER recomputes
 * that fingerprint against the current registrant for the source's
 * `providerId` first, and a mismatch is never handed the secrets unasked. Reads that never reach a registrant are deliberately outside this —
 * a backup export, the post-import verification, and the rollback captures in
 * `removeSource`/`persistUpdatedInventorySource` handle the user's own data and
 * have no provider to distrust.
 *
 * ONLY A STAMPED SOURCE IS GATED, which is the limit worth knowing before
 * reading the rest as a guarantee. A source saved before the field existed
 * carries no stamp, so there is nothing to compare against and every path
 * trusts it — until its next save (an add, an edit, or its first successful
 * sync) stamps the current registrant's shape silently, with no modal, because
 * there was no prior answer to contradict. From then on it is gated like any
 * other.
 *
 * The comparison only detects that the registrant's declared shape CHANGED — a
 * replacement that happens to declare an identical label/configFields, or a
 * user who clicks through the question, is indistinguishable from the
 * original. It closes the SILENT handover, not the trust boundary itself.
 *
 * WHAT A MISMATCH DOES depends on whether a human is there to ask, and a
 * provider author should know which of their entry points is which:
 *
 *  - USER-DRIVEN paths — `fetchInventory` (Sync Inventory Now),
 *    `testConnection` (the Add/Edit form's Test button), `controlNode`
 *    (Start/Stop Node) and `webConsoleUrl` (Open Web Console) — show a modal
 *    asking the user to confirm handing that registrant the saved credentials.
 *    Cancel aborts before any secret is read, so the method is never called.
 *  - `fetchStatus` is different, and this is the part worth reading twice. It
 *    is the only entry point Nexus calls BY ITSELF and REPEATEDLY: the
 *    per-source status poll re-resolves the registrant on every tick for as
 *    long as the Command Center is open. A modal there would fire unattended
 *    and over and over, so a mismatch is REFUSED SILENTLY instead — no vault
 *    read, no call into the provider, nothing shown on a poll tick. A manual
 *    Refresh Inventory Status reports the skipped sources once.
 *  - A refusal on that path DOES NOT EXPIRE. Nothing Nexus does clears it; it
 *    ends only when the user confirms the change on one of the user-driven
 *    paths above. Until then `fetchStatus` is simply never called for that
 *    source, however long the window stays open.
 *  - A CONFIRMATION LATCHES for that window, so the status path is not left
 *    contradicting an answer the user has just given. The latch is runtime
 *    only — never persisted, never stamped onto the record — and is keyed by
 *    the exact provider shape confirmed AND the exact incarnation of the
 *    source record it was confirmed for. Re-registering the id with yet
 *    another shape, replacing the source record, or opening a new window all
 *    ask again.
 *  - TWO OF THE FOUR ALSO SETTLE IT DURABLY, and an author should not read
 *    the latch as the whole story. A successful sync and a saved Edit Source
 *    RESTAMP `providerFingerprint` with the confirmed shape, so nothing asks
 *    again until the shape changes once more — those two write the record
 *    anyway, so they have somewhere to record the answer and a user whose
 *    intent is durable. `controlNode` and `webConsoleUrl` write nothing and
 *    deliberately stamp nothing: a click made to boot a node or look at a
 *    screen is not a statement about future credential hand-offs, so the
 *    window-scoped latch is all they leave behind.
 *
 * The practical consequence for a provider author: DO NOT CHANGE `label` or
 * `configFields` casually on an id that already has sources configured against
 * it. A `configFields` change takes effect only through a new registration:
 * dispose the old registration, then register a fresh provider object with the
 * same id. The registry rejects the same provider object again, even after
 * disposal, because a form or prompt may still be holding it. Every such
 * change is a new shape. Each existing STAMPED source stops reporting live
 * status until its user has confirmed the change once — so the blast radius is
 * every source saved by a current build, which in practice is all of them.
 * ADDING A REQUIRED SECRET FIELD is worse than the
 * rest: the sync that would otherwise settle the question aborts at its
 * missing-credential check before it can restamp, so those users have to go
 * through Edit Source to enter the credential and confirm in one step. The
 * manual status warning names whichever of the two can actually finish.
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
 * in backups and share files and must therefore never carry a secret.
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
