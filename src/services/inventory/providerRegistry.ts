import type { InventoryConfigFieldType, InventoryProvider } from "../../models/inventory";

/** vscode.Disposable-shaped without importing vscode — this module runs in tests without the API. */
export interface ProviderRegistration {
  dispose(): void;
}

/**
 * Notified after the set of registered providers changes. No payload: every
 * consumer answers its question by READING the registry (a capability probe, a
 * label lookup) at the moment it paints, so the id that moved tells them
 * nothing they do not re-derive anyway — and handing one over would only invite
 * a consumer to cache what it should be asking for.
 */
export type ProviderRegistryListener = () => void;

const VALID_FIELD_TYPES: ReadonlySet<InventoryConfigFieldType> = new Set(["string", "password", "number", "boolean", "select"]);
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
    // MINOR-14 (EVE-NG review) — `defaultValue` is part of the field contract
    // (the Add form seeds a boolean field from it). A non-boolean value would be
    // silently coerced by the form's `=== true` read, so a documented default of
    // "yes" becomes an unchecked box — reject it at the boundary.
    if (f.defaultValue !== undefined && typeof f.defaultValue !== "boolean") {
      throw new Error(`Inventory provider configFields entry "${f.id}" has a non-boolean defaultValue.`);
    }
    // REVIEW L3 — the twin of the `defaultValue` clause above, for the same
    // class of typo and on the same public boundary. Checked for EVERY field
    // type, exactly as `defaultValue` is: a bound is ignored on a non-number
    // field, but a malformed one there is still a typo worth naming rather than
    // a shape worth accepting.
    //
    // Two things go wrong silently without this. A NON-FINITE bound makes the
    // collection-side re-check in `formValuesToProviderConfig` INERT — `numeric
    // < min` is false when `min` is NaN, so the bound the provider documented is
    // not enforced anywhere — while still rendering into the input's native
    // `min`/`max` attribute, where the browser reads it as no bound either. And
    // a TRANSPOSED pair declares a field no value can ever satisfy: every save
    // is refused, by both layers, with nothing to say the schema is at fault.
    for (const bound of ["min", "max"] as const) {
      if (f[bound] !== undefined && (typeof f[bound] !== "number" || !Number.isFinite(f[bound]))) {
        throw new Error(`Inventory provider configFields entry "${f.id}" has a non-finite ${bound} (a bound must be a finite number when present).`);
      }
    }
    // REVIEW D2 — the third member of the `defaultValue` / `min`-`max` family,
    // on the same public boundary and failing the same silent way: the
    // collection-side check reads this as a truthy flag, so `integer: "yes"`
    // constrains a field the provider never meant to constrain, and `integer: 0`
    // leaves one it did mean to constrain wide open — with nothing naming the
    // schema either way.
    if (f.integer !== undefined && typeof f.integer !== "boolean") {
      throw new Error(`Inventory provider configFields entry "${f.id}" has a non-boolean integer flag.`);
    }
    if (typeof f.min === "number" && typeof f.max === "number" && f.min > f.max) {
      throw new Error(`Inventory provider configFields entry "${f.id}" declares min ${f.min} greater than max ${f.max}, which no value can satisfy.`);
    }
    if (f.type === "select") {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        throw new Error(`Inventory provider configFields entry "${f.id}" of type "select" must declare a non-empty options array.`);
      }
      for (const opt of f.options) {
        if (typeof opt !== "object" || opt === null
            || typeof (opt as { label?: unknown }).label !== "string" || (opt as { label: string }).label.length === 0
            || typeof (opt as { value?: unknown }).value !== "string") {
          throw new Error(`Inventory provider configFields entry "${f.id}" has an invalid select option (each option needs a non-empty string label and a string value).`);
        }
        // RESERVED SENTINEL NAMESPACE (PR #64 Codex review round 3, P2 — issue #48
        // PR-E). The webview treats ANY select option whose value starts with
        // `__create__` as an inline-create sentinel (isCreateOption in
        // ui/shared/webviewScripts.ts / filterableSelectLogic.ts) — the click
        // handler returns without selecting it. Provider `type:"select"` fields
        // have no inline-create handler, so such an option is impossible to choose
        // or persist (silently inert). Reject it at the registration boundary.
        // Empty-string value (the "(None)" sentinel) is still allowed — only the
        // reserved prefix is off-limits.
        if ((opt as { value: string }).value.startsWith("__create__")) {
          throw new Error(`Inventory provider configFields entry "${f.id}" has a select option whose value uses the reserved "__create__" prefix.`);
        }
      }
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
  // REVIEW FINDING (P1, cross-instance adoption) — `instanceKey` is OPTIONAL, so
  // absence is not an error: a provider without it simply gets no adoption (see
  // the method's contract in models/inventory.ts). A non-function value under
  // that name IS an error, and loudly rather than silently: everything else a
  // provider can get wrong about this method degrades quietly inside
  // `resolveProviderInstanceKey`, which would make a typo'd `instanceKey: "..."`
  // (a string, not a function) look exactly like a provider that never declared
  // one — and the symptom, adoption never firing, is invisible until a user has
  // already removed a source with Keep Servers.
  if (obj.instanceKey !== undefined && typeof obj.instanceKey !== "function") {
    throw new Error("Inventory provider instanceKey must be a function when present.");
  }
  // LIVE STATUS (Phase 2) — the twin of the instanceKey clause. `fetchStatus` is
  // OPTIONAL (a provider that only supplies inventory has none), but a
  // non-function value under that name is an error, loudly rather than silently:
  // a typo'd `fetchStatus` would otherwise be indistinguishable at runtime from a
  // provider that never declared one, and the symptom — status refresh quietly
  // never firing — is invisible until a user wonders why running labs are not
  // highlighted.
  if (obj.fetchStatus !== undefined && typeof obj.fetchStatus !== "function") {
    throw new Error("Inventory provider fetchStatus must be a function when present.");
  }
  // NODE CONTROL (Phase 4) — the twin of the fetchStatus clause. `controlNode`
  // is OPTIONAL (only EVE-NG implements node start/stop), but a non-function
  // value under that name is an error, loudly rather than silently: a typo'd
  // `controlNode` would otherwise be indistinguishable at runtime from a
  // provider that never declared one, and the symptom — Start/Stop quietly doing
  // nothing — is invisible until a user wonders why a node never boots.
  if (obj.controlNode !== undefined && typeof obj.controlNode !== "function") {
    throw new Error("Inventory provider controlNode must be a function when present.");
  }
  // CONTROL MENU GATE — the twin of the controlNode clause. `canControlNode` is
  // OPTIONAL (a provider whose whole device set is controllable declares
  // nothing; absence means the tree's menu gate answers yes for every row), but
  // a non-function value under that name IS an error, loudly rather than
  // silently: a typo'd `canControlNode` would otherwise be indistinguishable at
  // runtime from a provider that never declared one — except this one does not
  // fail quietly, because the gate invokes the member DURING TREE RENDER, so
  // the symptom of letting it through would be a TypeError on every repaint of
  // a row instead of a clear verdict here, at registration.
  if (obj.canControlNode !== undefined && typeof obj.canControlNode !== "function") {
    throw new Error("Inventory provider canControlNode must be a function when present.");
  }
  // WEB CONSOLE — the twin of the canControlNode clause, and it matters for the
  // same reason: the member's PRESENCE is what stamps the tree marker that
  // surfaces the Open Web Console entry, so a typo'd `webConsoleUrl` carrying a
  // non-function value would show the entry on every row of that provider and
  // then throw TypeError when one is clicked. Named here, at registration,
  // rather than in a click the user cannot connect back to the registration.
  if (obj.webConsoleUrl !== undefined && typeof obj.webConsoleUrl !== "function") {
    throw new Error("Inventory provider webConsoleUrl must be a function when present.");
  }
  // WEB CONSOLE MENU GATE — the twin of the canControlNode clause, and it fails
  // the same loud way for the same reason. `canWebConsole` is OPTIONAL (absence
  // means no device gate: every device of a web-console-capable provider
  // qualifies), but a non-function value under that name IS an error: the gate
  // INVOKES the member during tree render, so a typo'd `canWebConsole` that
  // survived registration would throw TypeError on every repaint of a row
  // instead of being named here, once, at registration.
  if (obj.canWebConsole !== undefined && typeof obj.canWebConsole !== "function") {
    throw new Error("Inventory provider canWebConsole must be a function when present.");
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
  private readonly listeners = new Set<ProviderRegistryListener>();

  /**
   * Fires after a provider is registered, and after a registration that still
   * owned its id is disposed.
   *
   * WHY THE REGISTRY HAS AN EVENT AT ALL. Its consumers are painting surfaces:
   * the Command Center stamps its node-control and web-console markers from
   * capability probes that read this registry as each row is built, and the
   * Settings tree resolves a source's provider LABEL the same way. Registration
   * is not confined to activation — a third-party provider registers whenever
   * its own extension activates, which can be minutes after those surfaces last
   * painted — and nothing in a registration touches NexusCore, which is the only
   * thing that otherwise repaints them. Without a signal here the rows keep the
   * answers they were painted with, and the menu entries those markers gate
   * (Start Node / Stop Node / Open Web Console) are hidden from the palette
   * because each one names a row — so there is no second way to reach them.
   * Disposal is the same staleness pointing the other way: a marker left
   * stamped on a row whose capability has gone.
   *
   * SHAPE — `NexusCore.onDidChange`'s: subscribe, get an unsubscribe function
   * back. Not a `vscode.EventEmitter`, because this module must stay importable
   * without the VS Code API.
   */
  public onDidChange(listener: ProviderRegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public register(provider: InventoryProvider): ProviderRegistration {
    validateProviderShape(provider);
    if (this.providers.has(provider.id)) {
      throw new Error(`An inventory provider with id "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
    // AFTER the map write, so a listener that repaints from the registry sees
    // the provider it was just told about. A rejected registration (duplicate
    // id, bad shape) throws above and never reaches here — nothing changed, so
    // nothing repaints.
    this.emitChanged();
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
          // Inside the guard: a stale dispose evicts nothing, and an event for
          // it would announce a removal that did not happen.
          this.emitChanged();
        }
      }
    };
  }

  /**
   * Swallow-and-log, the repo-wide convention for observer dispatch (see
   * `NexusCore.emitChanged` and `ptyObserverHub.notifyOutput`). It matters more
   * here than usual: the listeners are UI repaints and the emitter runs inside
   * a third party's `register()` call, so one throwing consumer must neither
   * fail somebody else's registration nor starve the surfaces after it.
   */
  private emitChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[Nexus] inventory provider registry onDidChange listener threw; the registry change stands and other listeners still run:", error);
      }
    }
  }

  public get(id: string): InventoryProvider | undefined {
    return this.providers.get(id);
  }

  public list(): InventoryProvider[] {
    return [...this.providers.values()];
  }
}
