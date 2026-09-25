import type { InventoryConfigField, InventoryConfigFieldType, InventoryProvider } from "../../models/inventory";

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
  checkProviderShape(provider);
}

/** The data members the registry keeps a copy of, each exactly as it was checked. */
interface CheckedProviderData {
  readonly configFields: readonly InventoryConfigField[];
  readonly attributeKeys: readonly string[] | undefined;
}

/**
 * `validateProviderShape`'s checks, returning the copies of `configFields` and
 * `attributeKeys` the registry keeps (`copyConfigFields`, `copyAttributeKeys`), so
 * that `register()` reads each member once and stores exactly what was checked.
 */
function checkProviderShape(provider: unknown): CheckedProviderData {
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
  const configFields = copyConfigFields(obj.configFields);
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
  // TEMPLATE-RULE FILTER KEYS (issue #163) — the twin of the clauses above, for
  // the one optional member that is data rather than a function. `attributeKeys`
  // is OPTIONAL (a provider that declares no list has its filters checked
  // against none), but a present value that is not an array of strings IS an
  // error, named here: `unknownFilterKeys` and `knownKeysList`
  // (templateApply.ts) iterate it and call string methods on every entry, so a
  // `"role,site"` or a `[1]` that survived registration would throw TypeError out
  // of Edit Template Rules before the Rule Filter box could open, far from the
  // registration that caused it.
  //
  // DELIBERATELY ACCEPTED: a blank or whitespace-only entry, and a duplicate.
  // Neither throws anywhere — a blank key matches nothing and `knownKeysList`
  // leaves it out of every list it builds, and a duplicate is one entry in the
  // matcher's Set (and at worst a repeated word in that list) — so refusing the
  // provider's whole registration, sync and all, would cost far more than the entry.
  return { configFields, attributeKeys: copyAttributeKeys(obj.attributeKeys) };
}

/**
 * `configFields` as the registry keeps it: a frozen plain array of frozen plain
 * field objects, a select's `options` included, holding only the members
 * `InventoryConfigField` declares. Throws, naming the entry's index or the
 * field's id, on anything a consumer could not take.
 *
 * WHY A COPY (issue #195) — `copyAttributeKeys`' reason, with more riding on it.
 * Every consumer calls the list's methods: the source form's `some`, `find` and
 * `flatMap`, the collection parse's `for…of`, the sync's required-secret loop,
 * and `computeProviderFingerprint`'s `map`, which runs on every path that spends
 * a source's credentials. On the provider's own array each of those is code the
 * provider controls, and the array, its field objects and each select's
 * `options` are data it can change after this check. So a list that passed here
 * could still throw out of the form or the fingerprint later, far from the
 * registration that caused it, and a provider could change the fields a user had
 * confirmed without registering again.
 *
 * WHAT IT KEEPS, and why no more: the members `InventoryConfigField` declares,
 * each one checked below, and a select's options as `{ label, value }`. Any
 * other member of an option is dropped because the form renders an option's
 * `description` and `fillValue` through `escapeHtml` when present, and a
 * non-select field's stray `options` is dropped because nothing reads it. The
 * checks therefore cover exactly what the copy holds.
 *
 * HOW: `copyAttributeKeys`' rules at every level — one pass by index over
 * `length` read once, and each entry, each member and each option read once and
 * checked as it is copied. That function says why not spread, `Array.from`,
 * `slice` or a check loop followed by a separate copy.
 */
function copyConfigFields(value: unknown): readonly InventoryConfigField[] {
  if (!Array.isArray(value)) {
    throw new Error("Inventory provider configFields must be an array.");
  }
  const length = value.length;
  const fields: InventoryConfigField[] = [];
  const seenFieldIds = new Set<string>();
  for (let i = 0; i < length; i++) {
    const entry: unknown = value[i];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Inventory provider configFields entry ${i} must be an object.`);
    }
    const f = entry as Record<string, unknown>;
    const id = f.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Inventory provider configFields entry ${i} must have a non-empty id.`);
    }
    const label = f.label;
    if (typeof label !== "string" || label.length === 0) {
      throw new Error(`Inventory provider configFields entry "${id}" must have a non-empty label.`);
    }
    const type = f.type;
    if (typeof type !== "string" || !VALID_FIELD_TYPES.has(type as InventoryConfigFieldType)) {
      throw new Error(`Inventory provider configFields entry "${id}" has an invalid type "${String(type)}".`);
    }
    const field: InventoryConfigField = { id, label, type: type as InventoryConfigFieldType };
    // ISSUE #187 — the source form renders both through `escapeHtml`, which
    // calls `replaceAll` on its argument, so a number here made the Add/Edit
    // Source form throw as it rendered.
    for (const member of ["placeholder", "description"] as const) {
      const text = f[member];
      if (text !== undefined) {
        if (typeof text !== "string") {
          throw new Error(`Inventory provider configFields entry "${id}" has a non-string ${member}.`);
        }
        field[member] = text;
      }
    }
    // ISSUE #187 — read as truthy flags by the form and the collection parse,
    // so `advanced: "no"` filed a field under Advanced options and
    // `required: "no"` made it mandatory, with nothing naming the schema.
    //
    // REVIEW D2 — `integer` fails the same silent way: `integer: "yes"`
    // constrains a field the provider never meant to constrain, and `integer: 0`
    // leaves one it did mean to constrain wide open.
    for (const member of ["required", "advanced", "integer"] as const) {
      const flag = f[member];
      if (flag !== undefined) {
        if (typeof flag !== "boolean") {
          throw new Error(`Inventory provider configFields entry "${id}" has a non-boolean ${member} flag.`);
        }
        field[member] = flag;
      }
    }
    // MINOR-14 (EVE-NG review) — `defaultValue` is part of the field contract
    // (the Add form seeds a boolean field from it). A non-boolean value would be
    // silently coerced by the form's `=== true` read, so a documented default of
    // "yes" becomes an unchecked box — reject it at the boundary.
    const defaultValue = f.defaultValue;
    if (defaultValue !== undefined) {
      if (typeof defaultValue !== "boolean") {
        throw new Error(`Inventory provider configFields entry "${id}" has a non-boolean defaultValue.`);
      }
      field.defaultValue = defaultValue;
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
      const limit = f[bound];
      if (limit !== undefined) {
        if (typeof limit !== "number" || !Number.isFinite(limit)) {
          throw new Error(`Inventory provider configFields entry "${id}" has a non-finite ${bound} (a bound must be a finite number when present).`);
        }
        field[bound] = limit;
      }
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      throw new Error(`Inventory provider configFields entry "${id}" declares min ${field.min} greater than max ${field.max}, which no value can satisfy.`);
    }
    if (type === "select") {
      const rawOptions = f.options;
      const optionCount = Array.isArray(rawOptions) ? rawOptions.length : 0;
      if (optionCount === 0) {
        throw new Error(`Inventory provider configFields entry "${id}" of type "select" must declare a non-empty options array.`);
      }
      const invalidOption = `Inventory provider configFields entry "${id}" has an invalid select option (each option needs a non-empty string label and a string value).`;
      const options: { label: string; value: string }[] = [];
      for (let j = 0; j < optionCount; j++) {
        const option: unknown = (rawOptions as unknown[])[j];
        if (typeof option !== "object" || option === null) {
          throw new Error(invalidOption);
        }
        const { label: optionLabel, value: optionValue } = option as Record<string, unknown>;
        if (typeof optionLabel !== "string" || optionLabel.length === 0 || typeof optionValue !== "string") {
          throw new Error(invalidOption);
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
        if (optionValue.startsWith("__create__")) {
          throw new Error(`Inventory provider configFields entry "${id}" has a select option whose value uses the reserved "__create__" prefix.`);
        }
        options.push(Object.freeze({ label: optionLabel, value: optionValue }));
      }
      field.options = options;
      Object.freeze(options);
    }
    if (seenFieldIds.has(id)) {
      throw new Error(`Inventory provider configFields has a duplicate field id "${id}".`);
    }
    seenFieldIds.add(id);
    fields.push(Object.freeze(field));
  }
  return Object.freeze(fields);
}

/**
 * `attributeKeys` as the registry keeps it: `undefined` when the provider declares
 * none, otherwise a frozen plain array of its entries. Throws, naming the member or
 * the entry's index, on anything that is not an array of strings.
 *
 * WHY A COPY (PR #188 review). Every entry being a string at its index is all the
 * check can prove, and the consumers do more with the list than index it:
 * `knownKeysList` calls `some` and spreads it, `unknownFilterKeys` calls `map`. On
 * the provider's own array each of those is code the provider controls — an own
 * `map`, an Array subclass's iterator or methods — so a list that passed here
 * could still throw out of Edit Template Rules, or change after registration.
 * The copy's behaviour is Array.prototype's and its contents are exactly what
 * was checked.
 *
 * HOW, and why not the shorter spellings: one pass by index over `length` read
 * once, each entry read once and checked as it is copied. `[...value]` and
 * `Array.from(value)` run the provider's iterator; `value.slice()` runs its
 * `slice`, or builds its subclass again; a check loop followed by a separate copy
 * reads every entry twice, and a getter can answer differently the second time.
 * An index loop rather than `.every` also because `.every` skips the holes of a
 * sparse array, which `knownKeysList`'s spread would turn into `undefined`.
 */
function copyAttributeKeys(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Inventory provider attributeKeys must be an array of strings when present.");
  }
  const length = value.length;
  const keys: string[] = [];
  for (let i = 0; i < length; i++) {
    const key: unknown = value[i];
    if (typeof key !== "string") {
      throw new Error(`Inventory provider attributeKeys entry ${i} must be a string.`);
    }
    keys.push(key);
  }
  return Object.freeze(keys);
}

/** One registration: the provider, and the copy of its `attributeKeys` taken when it registered. */
interface RegisteredProvider {
  readonly provider: InventoryProvider;
  readonly attributeKeys: readonly string[] | undefined;
}

/**
 * In-memory registry of inventory providers, keyed by provider id. Consumers
 * (built-in NetBox provider, third-party extensions via the public API) each
 * get a disposable handle back from register(); disposing removes only their
 * own registration, keyed by identity rather than id — dispose(A) must never
 * remove a later registration B that happens to share A's id or label.
 */
export class InventoryProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  /** Keyed by the provider object, not its id — see `configFieldsOf`. */
  private readonly configFieldsByProvider = new WeakMap<InventoryProvider, readonly InventoryConfigField[]>();
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
    const { configFields, attributeKeys } = checkProviderShape(provider);
    const registration: RegisteredProvider = { provider, attributeKeys };
    if (this.providers.has(provider.id)) {
      throw new Error(`An inventory provider with id "${provider.id}" is already registered.`);
    }
    if (this.configFieldsByProvider.has(provider)) {
      // A flow can keep this provider object after its id is disposed. Reusing
      // it would replace the copy that flow rendered or fingerprinted.
      throw new Error(`Inventory provider object "${provider.id}" was already registered with this registry.`);
    }
    this.providers.set(provider.id, registration);
    this.configFieldsByProvider.set(provider, configFields);
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
        if (this.providers.get(provider.id) === registration) {
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
    return this.providers.get(id)?.provider;
  }

  /**
   * The `attributeKeys` of the provider holding `id`, as copied when it registered
   * (`copyAttributeKeys`): a frozen plain array, or `undefined` when that provider
   * declares no list or no provider holds the id. Read the keys here, never off
   * `get(id)` — the provider's own array is the one whose methods and iterator it
   * controls, and whose contents it can change after the check.
   */
  public attributeKeysOf(id: string): readonly string[] | undefined {
    return this.providers.get(id)?.attributeKeys;
  }

  /**
   * The `configFields` of `provider`, as copied when it registered
   * (`copyConfigFields`): a frozen plain array of frozen field objects. Read the
   * fields here, never off the provider — its own array is the one whose methods
   * and iterator it controls, and whose contents it can change after the check.
   * That includes `computeProviderFingerprint`'s input: the fingerprint hashes
   * this copy, so it describes the fields that were checked, and a provider
   * cannot change the fields a user confirmed without registering a new
   * provider object.
   *
   * KEYED BY THE PROVIDER OBJECT, NOT BY ITS ID, unlike `attributeKeysOf`,
   * because of how the consumers hold a provider. Add Source picks one and then
   * waits on a form; Edit Source, Sync, node control and the web console resolve
   * one and then wait on the trust modal. The id can be disposed or registered
   * again while they wait. A lookup by id would then answer with nothing, or with
   * the replacement's fields, so a form would be parsed against a schema other
   * than the one it rendered, and a fingerprint would combine one registrant's
   * label with another's fields. Looked up by the object, the answer is always
   * the copy taken when that provider object registered. This registry refuses
   * to register the same object again, even after disposal, because a form or
   * prompt may still hold it. The copy lasts as long as something still holds
   * the provider.
   *
   * Throws for a provider this registry never accepted. The command layer only
   * ever holds providers that `get` or `list` returned, so this is a bug in the
   * caller, and `[]` would hide it behind a form with no provider fields.
   */
  public configFieldsOf(provider: InventoryProvider): readonly InventoryConfigField[] {
    const configFields = this.configFieldsByProvider.get(provider);
    if (configFields === undefined) {
      throw new Error(`Inventory provider "${provider.id}" was never registered with this registry.`);
    }
    return configFields;
  }

  public list(): InventoryProvider[] {
    return [...this.providers.values()].map((registration) => registration.provider);
  }
}
