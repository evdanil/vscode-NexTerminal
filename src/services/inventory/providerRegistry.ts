import type { InventoryConfigFieldType, InventoryProvider } from "../../models/inventory";

/** vscode.Disposable-shaped without importing vscode — this module runs in tests without the API. */
export interface ProviderRegistration {
  dispose(): void;
}

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
