import { describe, expect, it } from "vitest";
import { InventoryProviderRegistry, validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { MAX_INVENTORY_INSTANCE_KEY_LENGTH, resolveProviderInstanceKey } from "../../src/models/inventory";
import type { InventoryProvider } from "../../src/models/inventory";
import { createNetboxProvider } from "../../src/services/inventory/providers/netboxProvider";

function makeProvider(overrides: Partial<InventoryProvider> = {}): InventoryProvider {
  return {
    id: "netbox",
    label: "NetBox",
    configFields: [{ id: "baseUrl", label: "Base URL", type: "string" }],
    testConnection: async () => {},
    fetchInventory: async () => ({ contractVersion: 1, devices: [] }),
    ...overrides
  };
}

describe("InventoryProviderRegistry", () => {
  it("throws on duplicate id, and the first registration is still resolvable (kills last-write-wins)", () => {
    const registry = new InventoryProviderRegistry();
    const first = makeProvider({ label: "First" });
    const second = makeProvider({ label: "Second" });
    registry.register(first);
    expect(() => registry.register(second)).toThrow(/already registered/i);
    expect(registry.get("netbox")?.label).toBe("First");
  });

  it("dispose removes the registration; a fresh register with the same id then succeeds; double-dispose is a no-op (kills delete-by-reference / tombstone)", () => {
    const registry = new InventoryProviderRegistry();
    const provider = makeProvider();
    const registration = registry.register(provider);
    expect(registry.get("netbox")).toBe(provider);

    registration.dispose();
    expect(registry.get("netbox")).toBeUndefined();

    const replacement = makeProvider({ label: "Replacement" });
    expect(() => registry.register(replacement)).not.toThrow();
    expect(registry.get("netbox")).toBe(replacement);

    // A stale dispose() on the first registration must not evict the
    // replacement that now legitimately owns the id.
    expect(() => registration.dispose()).not.toThrow();
    expect(registry.get("netbox")).toBe(replacement);
  });

  it("disposing provider A does not remove provider B that happens to share A's label (kills keying on label)", () => {
    const registry = new InventoryProviderRegistry();
    const a = makeProvider({ id: "provider-a", label: "Shared Label" });
    const b = makeProvider({ id: "provider-b", label: "Shared Label" });
    const regA = registry.register(a);
    registry.register(b);

    regA.dispose();

    expect(registry.get("provider-a")).toBeUndefined();
    expect(registry.get("provider-b")).toBe(b);
  });

  it("list() returns providers in stable registration order", () => {
    const registry = new InventoryProviderRegistry();
    const a = makeProvider({ id: "provider-a" });
    const b = makeProvider({ id: "provider-b" });
    const c = makeProvider({ id: "provider-c" });
    registry.register(a);
    registry.register(b);
    registry.register(c);
    expect(registry.list().map((p) => p.id)).toEqual(["provider-a", "provider-b", "provider-c"]);
  });
});

describe("validateProviderShape", () => {
  it("accepts a well-formed provider", () => {
    expect(() => validateProviderShape(makeProvider())).not.toThrow();
  });

  it("rejects a missing fetchInventory with a distinct message (kills vacuous validation)", () => {
    const bad = makeProvider();
    // @ts-expect-error deliberately malformed for the test
    delete bad.fetchInventory;
    expect(() => validateProviderShape(bad)).toThrow(/fetchInventory/);
  });

  it("rejects a missing testConnection with a distinct message", () => {
    const bad = makeProvider();
    // @ts-expect-error deliberately malformed for the test
    delete bad.testConnection;
    expect(() => validateProviderShape(bad)).toThrow(/testConnection/);
  });

  it("rejects a configFields entry with a bad type value, with a distinct message", () => {
    const bad = makeProvider({ configFields: [{ id: "x", label: "X", type: "not-a-real-type" as never }] });
    expect(() => validateProviderShape(bad)).toThrow(/invalid type/);
  });

  it("rejects duplicate field ids within configFields, with a distinct message", () => {
    const bad = makeProvider({
      configFields: [
        { id: "dup", label: "One", type: "string" },
        { id: "dup", label: "Two", type: "string" }
      ]
    });
    expect(() => validateProviderShape(bad)).toThrow(/duplicate field id/i);
  });

  it("rejects an empty or malformed provider id", () => {
    expect(() => validateProviderShape(makeProvider({ id: "" }))).toThrow(/id/i);
    expect(() => validateProviderShape(makeProvider({ id: "not valid!" }))).toThrow(/id/i);
  });

  it("rejects a missing label", () => {
    expect(() => validateProviderShape(makeProvider({ label: "" }))).toThrow(/label/i);
  });

  it("accepts a provider with NO instanceKey — it is optional, and its absence only costs adoption (kills making it required, which would break every provider written before it existed)", () => {
    const provider = makeProvider();
    expect(provider.instanceKey).toBeUndefined();
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("rejects a non-function instanceKey loudly (kills a silent degrade for a typo'd `instanceKey: \"...\"`, which is indistinguishable at runtime from a provider that never declared one — and the symptom, adoption quietly never firing, only shows up after a user has already removed a source with Keep Servers)", () => {
    expect(() => validateProviderShape(makeProvider({ instanceKey: "https://netbox.example.com" as never }))).toThrow(/instanceKey/);
    expect(() => validateProviderShape(makeProvider({ instanceKey: 42 as never }))).toThrow(/instanceKey/);
  });

  // fetchStatus provider capability (Phase 2) — the twin of the instanceKey
  // clause. OPTIONAL, so absence is not an error (NetBox never implements it); a
  // non-function value under that name IS an error, loudly, for the same reason
  // instanceKey's is: a typo'd `fetchStatus: {...}` would otherwise be
  // indistinguishable at runtime from a provider that never declared one, and the
  // symptom (status silently never refreshing) is invisible until a user wonders
  // why their running labs are not highlighted.
  it("accepts a provider with NO fetchStatus — it is optional (kills making it required, which would break every provider that only supplies inventory)", () => {
    const provider = makeProvider();
    expect(provider.fetchStatus).toBeUndefined();
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("accepts a provider WITH a function fetchStatus", () => {
    const provider = makeProvider({ fetchStatus: async () => ({ contractVersion: 1, statuses: {} }) });
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("rejects a non-function fetchStatus loudly (kills a silent degrade for a typo'd `fetchStatus` that is not callable)", () => {
    expect(() => validateProviderShape(makeProvider({ fetchStatus: "http://eve" as never }))).toThrow(/fetchStatus/);
    expect(() => validateProviderShape(makeProvider({ fetchStatus: 42 as never }))).toThrow(/fetchStatus/);
  });

  // controlNode provider capability (Phase 4) — the twin of the fetchStatus
  // clause. OPTIONAL (only EVE-NG implements node control); a non-function value
  // under that name IS an error, loudly, for the same reason fetchStatus's is: a
  // typo'd `controlNode` would otherwise be indistinguishable at runtime from a
  // provider that never declared one, and the symptom (Start/Stop silently doing
  // nothing) is invisible until a user wonders why a node never boots.
  it("accepts a provider with NO controlNode — it is optional (kills making it required, which would break every provider that offers no node control)", () => {
    const provider = makeProvider();
    expect(provider.controlNode).toBeUndefined();
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("accepts a provider WITH a function controlNode", () => {
    const provider = makeProvider({ controlNode: async () => {} });
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("rejects a non-function controlNode loudly (kills a silent degrade for a typo'd `controlNode` that is not callable)", () => {
    expect(() => validateProviderShape(makeProvider({ controlNode: "start" as never }))).toThrow(/controlNode/);
    expect(() => validateProviderShape(makeProvider({ controlNode: 42 as never }))).toThrow(/controlNode/);
  });

  // MINOR-14 (EVE-NG review) — `InventoryConfigField.defaultValue` is part of
  // the field contract now, so a malformed one must be caught at the
  // registration boundary rather than silently coerced when the Add form reads
  // it as `defaultValue === true`.
  it("rejects a non-boolean defaultValue (⊘ a string/number defaultValue reaches the form and is coerced, so a documented default of \"yes\" silently becomes unchecked)", () => {
    expect(() =>
      validateProviderShape(makeProvider({ configFields: [{ id: "flag", label: "Flag", type: "boolean", defaultValue: "yes" as never }] }))
    ).toThrow(/"flag".*non-boolean defaultValue/i);
    expect(() =>
      validateProviderShape(makeProvider({ configFields: [{ id: "flag", label: "Flag", type: "boolean", defaultValue: 1 as never }] }))
    ).toThrow(/"flag".*non-boolean defaultValue/i);
  });

  it("accepts a boolean field with a real boolean defaultValue, and one with none", () => {
    expect(() =>
      validateProviderShape(makeProvider({ configFields: [{ id: "flag", label: "Flag", type: "boolean", defaultValue: true }] }))
    ).not.toThrow();
    expect(() =>
      validateProviderShape(makeProvider({ configFields: [{ id: "flag", label: "Flag", type: "boolean" }] }))
    ).not.toThrow();
  });

  /**
   * REVIEW D2 — `integer` is the third member of the same family as
   * `defaultValue` and `min`/`max`, on the same public boundary, and it fails
   * the same silent way: the collection-side check reads it as a truthy/falsy
   * flag, so `integer: "yes"` constrains a field the provider never meant to
   * constrain and `integer: 0` leaves one it did mean to constrain wide open —
   * with nothing anywhere saying the schema is at fault.
   */
  it("rejects a non-boolean `integer` (\u2298 a truthy string silently constrains a field the provider never meant to, and a falsy non-boolean silently leaves one unconstrained)", () => {
    for (const bad of ["yes" as never, 1 as never, 0 as never, null as never]) {
      expect(() =>
        validateProviderShape(makeProvider({ configFields: [{ id: "poll", label: "Poll", type: "number", integer: bad }] }))
      ).toThrow(/"poll".*integer/i);
    }
    expect(() =>
      validateProviderShape(makeProvider({ configFields: [{ id: "poll", label: "Poll", type: "number", integer: true }] }))
    ).not.toThrow();
    expect(() =>
      validateProviderShape(makeProvider({ configFields: [{ id: "poll", label: "Poll", type: "number" }] }))
    ).not.toThrow();
  });

  /**
   * REVIEW L3 — the same boundary that already rejects a non-boolean
   * `defaultValue` for exactly this class of typo said nothing about `min`/`max`,
   * and this is a PUBLIC API third-party providers register through.
   *
   * Two malformed shapes, both silent today:
   *  - `min > max` declares a field NO value can ever save — the collection-side
   *    re-check rejects everything, and the rendered input's native bounds do the
   *    same, so the source simply cannot be created and nothing says why;
   *  - a NON-NUMBER (or NaN) `min` makes that re-check silently INERT — `numeric
   *    < min` is false when `min` is NaN, so the bound the provider documented is
   *    not enforced at all — while still rendering into the HTML `min` attribute,
   *    where the browser reads it as no bound either.
   */
  it("rejects a min greater than its max (⊘ a transposed pair declares a field no value can ever save, and the user only ever sees the save refused)", () => {
    expect(() =>
      validateProviderShape(makeProvider({ configFields: [{ id: "poll", label: "Poll", type: "number", min: 3600, max: 0 }] }))
    ).toThrow(/"poll".*min.*max/i);
  });

  it("rejects a non-numeric or non-finite min/max (⊘ a NaN or string bound makes the collection-side re-check inert — `numeric < min` is false against NaN — while still rendering as the input's min attribute)", () => {
    for (const bad of ["0" as never, Number.NaN, Number.POSITIVE_INFINITY, null as never]) {
      expect(() =>
        validateProviderShape(makeProvider({ configFields: [{ id: "poll", label: "Poll", type: "number", min: bad }] }))
      ).toThrow(/"poll".*min/i);
      expect(() =>
        validateProviderShape(makeProvider({ configFields: [{ id: "poll", label: "Poll", type: "number", max: bad }] }))
      ).toThrow(/"poll".*max/i);
    }
  });

  it("accepts every well-formed bound: both, either alone, neither, and an equal pair (a single permitted value is odd but coherent)", () => {
    const ok = (field: Record<string, unknown>): void => {
      expect(() =>
        validateProviderShape(makeProvider({ configFields: [{ id: "poll", label: "Poll", type: "number", ...field } as never] }))
      ).not.toThrow();
    };
    ok({ min: 0, max: 3600 });
    ok({ min: 0 });
    ok({ max: 3600 });
    ok({});
    ok({ min: 5, max: 5 });
    ok({ min: -10, max: 0 }); // negative bounds are a provider's business
  });

  // SELECT OPTIONS VALIDATION (PR #64 Codex review round 1, P2 — issue #48 PR-E).
  // `type:"select"` reached VALID_FIELD_TYPES without any check on `options`, so a
  // third-party provider could register a select with no/empty/malformed options —
  // yielding an empty, unsavable required control, or malformed members that throw
  // inside renderFormHtml's escaping. Each case below registers SILENTLY against the
  // pre-fix boundary (the assertion that it throws is red there), and throws with the
  // fix. `value:""` is a legitimate sentinel and must stay accepted.
  it("rejects a select field that OMITS options (kills accepting an empty, unsavable dropdown at the registration boundary)", () => {
    const bad = makeProvider({ configFields: [{ id: "family", label: "Family", type: "select" }] });
    expect(() => validateProviderShape(bad)).toThrow(/"family".*select.*non-empty options array/i);
  });

  it("rejects a select field with an EMPTY options array", () => {
    const bad = makeProvider({ configFields: [{ id: "family", label: "Family", type: "select", options: [] }] });
    expect(() => validateProviderShape(bad)).toThrow(/"family".*select.*non-empty options array/i);
  });

  it("rejects a select option whose label is an empty string (only label must be non-empty)", () => {
    const bad = makeProvider({ configFields: [{ id: "family", label: "Family", type: "select", options: [{ label: "", value: "auto" }] }] });
    expect(() => validateProviderShape(bad)).toThrow(/"family".*invalid select option/i);
  });

  it("rejects a select option whose value is not a string — a number or undefined (kills a malformed member reaching renderFormHtml's escaping)", () => {
    const numeric = makeProvider({ configFields: [{ id: "family", label: "Family", type: "select", options: [{ label: "Auto", value: 1 as never }] }] });
    expect(() => validateProviderShape(numeric)).toThrow(/"family".*invalid select option/i);
    const missing = makeProvider({ configFields: [{ id: "family", label: "Family", type: "select", options: [{ label: "Auto" } as never] }] });
    expect(() => validateProviderShape(missing)).toThrow(/"family".*invalid select option/i);
  });

  it("accepts a well-formed select, INCLUDING an option with value:\"\" (a legitimate none/default sentinel)", () => {
    const ok = makeProvider({
      configFields: [{
        id: "family",
        label: "Family",
        type: "select",
        options: [
          { label: "None", value: "" },
          { label: "IPv4", value: "prefer-ipv4" }
        ]
      }]
    });
    expect(() => validateProviderShape(ok)).not.toThrow();
  });

  it("accepts the built-in NetBox provider, whose primaryIpFamily select declares proper options (kills a rule that would reject a legitimate shipped select)", () => {
    const netbox = createNetboxProvider();
    expect(() => validateProviderShape(netbox)).not.toThrow();
    expect(() => new InventoryProviderRegistry().register(netbox)).not.toThrow();
  });

  // RESERVED `__create__` SENTINEL PREFIX (PR #64 Codex review round 3, P2 — issue
  // #48 PR-E). The webview treats ANY select option whose value starts with
  // `__create__` as an inline-create sentinel (isCreateOption) — the click handler
  // returns WITHOUT selecting it. Provider selects have no inline-create handler,
  // so such an option is impossible to choose or persist (silently inert). Both
  // cases below register SILENTLY against 36c24eb (the assertion that they throw is
  // red there) and throw with the fix.
  it("rejects a select option whose value starts with the reserved __create__ prefix (kills accepting a silently un-selectable sentinel-shadowed option)", () => {
    const bad = makeProvider({ configFields: [{ id: "family", label: "Family", type: "select", options: [{ label: "Create…", value: "__create__foo" }] }] });
    expect(() => validateProviderShape(bad)).toThrow(/"family".*reserved.*__create__.*prefix/i);
  });

  it("rejects a select option whose value is exactly \"__create__\" (the bare reserved prefix)", () => {
    const bad = makeProvider({ configFields: [{ id: "family", label: "Family", type: "select", options: [{ label: "Create", value: "__create__" }] }] });
    expect(() => validateProviderShape(bad)).toThrow(/"family".*reserved.*__create__.*prefix/i);
    expect(() => new InventoryProviderRegistry().register(bad)).toThrow(/reserved.*__create__/i);
  });

  it("still accepts ordinary select option values, including value:\"\" (only the __create__ prefix is reserved)", () => {
    const ok = makeProvider({
      configFields: [{
        id: "family",
        label: "Family",
        type: "select",
        options: [
          { label: "None", value: "" },
          { label: "Auto", value: "auto" },
          { label: "Create-ish", value: "create__notReserved" }
        ]
      }]
    });
    expect(() => validateProviderShape(ok)).not.toThrow();
    expect(() => new InventoryProviderRegistry().register(ok)).not.toThrow();
  });
});

/**
 * Lives beside the shape validation because both answer one question about the
 * provider contract — what a third-party registrant may hand Nexus, and what
 * Nexus does with it. REVIEW FINDING (P1, cross-instance adoption): every answer
 * this function accepts is PERSISTED on kept servers and later decides whether a
 * source may take one over, so "degrades to undefined" is the only safe verdict
 * for anything it cannot fully vouch for — undefined means no adoption, never a
 * looser match.
 */
describe("resolveProviderInstanceKey", () => {
  it("returns the provider's key, trimmed, and passes ONLY the non-secret config (kills reading the key from anywhere the vault can reach)", () => {
    const seen: unknown[] = [];
    const key = resolveProviderInstanceKey(
      {
        instanceKey: (config) => {
          seen.push(config);
          return "  https://netbox.example.com  ";
        }
      },
      { baseUrl: "https://netbox.example.com" }
    );
    expect(key).toBe("https://netbox.example.com");
    expect(seen).toEqual([{ baseUrl: "https://netbox.example.com" }]);
    // The signature is the enforcement: there is no second parameter a provider
    // could read secrets from.
    expect(seen[0]).not.toHaveProperty("apiToken");
  });

  it("degrades to undefined for a provider that declares no instanceKey at all (kills throwing on the common case — most providers will never implement it)", () => {
    expect(resolveProviderInstanceKey({}, { baseUrl: "https://netbox.example.com" })).toBeUndefined();
  });

  it("degrades to undefined when the provider THROWS rather than letting the exception escape (kills an unguarded call: this runs on the remove-source path, where a throw would abort a removal the user has already confirmed)", () => {
    expect(
      resolveProviderInstanceKey(
        {
          instanceKey: () => {
            throw new Error("provider blew up");
          }
        },
        {}
      )
    ).toBeUndefined();
  });

  it("degrades to undefined for every unusable answer — non-string, empty, blank, over-long, or control-character-bearing (kills persisting a key that would compare equal to another provider's empty one, or that would forge lines in a plan warning)", () => {
    const cases: Array<unknown> = [
      42,
      null,
      undefined,
      {},
      "",
      "   ",
      "x".repeat(MAX_INVENTORY_INSTANCE_KEY_LENGTH + 1),
      "https://netbox\nInjected: a second line",
      "https://netbox\u001b[2K"
    ];
    for (const answer of cases) {
      expect(resolveProviderInstanceKey({ instanceKey: () => answer as string | undefined }, {})).toBeUndefined();
    }
    // The boundary itself is accepted — the cap is a cap, not an off-by-one.
    const atLimit = "x".repeat(MAX_INVENTORY_INSTANCE_KEY_LENGTH);
    expect(resolveProviderInstanceKey({ instanceKey: () => atLimit }, {})).toBe(atLimit);
  });

  it("two blank answers do not become one shared key (kills accepting the empty string, which would pool every sloppy provider's kept servers into one instance)", () => {
    expect(resolveProviderInstanceKey({ instanceKey: () => "" }, { baseUrl: "a" })).toBeUndefined();
    expect(resolveProviderInstanceKey({ instanceKey: () => "" }, { baseUrl: "b" })).toBeUndefined();
  });

  /**
   * REVIEW FINDING (P2, defensive copy) — the same boundary rule `cloneForProvider`
   * enforces for `fetchInventory` / `testConnection` (commands/inventoryCommands.ts),
   * applied to the third place a provider is handed a config.
   *
   * WHY IT MATTERS HERE SPECIFICALLY: every caller passes a LIVE object — the
   * `config` sitting on an InventorySourceConfig inside NexusCore. Because
   * InventorySourceValues is all primitives, an in-place normalization by a
   * third-party provider mutates the STORED record with no revision bump behind
   * it, so `sourceConfigUnchanged` still calls the record the same incarnation and
   * the apply persists the mutation while the tree it applies was fetched from
   * the pre-mutation config.
   *
   * BOTH ASSERTIONS ARE LOAD-BEARING. The identity check alone would pass against
   * a shallow `{...config}` that a nested value could still escape; the
   * unchanged-original check alone would pass against a provider that happens not
   * to mutate on this run. Together they pin "the provider cannot reach the
   * caller's object", which is the property.
   */
  it("hands the provider a COPY of the config, so an instanceKey that normalizes its argument in place cannot mutate stored source state (kills passing source.config straight through, where the mutation lands in globalState with no revision bump to notice it)", () => {
    const live = { baseUrl: "HTTPS://NetBox.Example.COM/", port: 443 };
    const seen: unknown[] = [];
    const key = resolveProviderInstanceKey(
      {
        instanceKey: (config) => {
          seen.push(config);
          // The shape of third-party normalization this guards against: helpful,
          // plausible, and destructive to the caller's record.
          config.baseUrl = String(config.baseUrl).toLowerCase().replace(/\/$/, "");
          return String(config.baseUrl);
        }
      },
      live
    );

    expect(key).toBe("https://netbox.example.com");
    // Not the caller's object.
    expect(seen[0]).not.toBe(live);
    // And the caller's object is untouched by what the provider did to its copy.
    expect(live).toEqual({ baseUrl: "HTTPS://NetBox.Example.COM/", port: 443 });
  });

  it("degrades to undefined when the config cannot be cloned at all, rather than throwing into a sync or a source removal (kills cloning outside the guarded call)", () => {
    // Only a hand-edited globalState row can put a function here — the type says
    // string | number | boolean — but the cost of being wrong is a TypeError
    // thrown after an inventory fetch, or mid-removal, so the clone lives inside
    // the same try the provider call does.
    const uncloneable = { baseUrl: (() => "nope") as unknown as string };
    expect(resolveProviderInstanceKey({ instanceKey: () => "https://netbox.example.com" }, uncloneable)).toBeUndefined();
  });
});
