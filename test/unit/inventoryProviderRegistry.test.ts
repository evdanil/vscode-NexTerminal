import { describe, expect, it, vi } from "vitest";
import { InventoryProviderRegistry, validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { MAX_INVENTORY_INSTANCE_KEY_LENGTH, computeProviderFingerprint, resolveProviderInstanceKey } from "../../src/models/inventory";
import type { InventoryConfigField, InventoryProvider } from "../../src/models/inventory";
import { createNetboxProvider } from "../../src/services/inventory/providers/netboxProvider";
import { knownKeysList, parseTemplateFilter, unknownFilterKeys } from "../../src/services/inventory/templateApply";
import { inventorySourceFormDefinition, savedFilterTarget } from "../../src/ui/formDefinitions";
import { renderFormHtml } from "../../src/ui/formHtml";

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

/**
 * attributeKeys AS THE REGISTRY KEEPS IT (issue #163 item 2, PR #188 review). The
 * shape check passing proves only that every INDEXED entry is a string. The
 * consumers do more with the list than index it — `knownKeysList` calls `some`
 * and spreads it, `unknownFilterKeys` calls `map` — and on the provider's own
 * array each of those runs code the provider controls. So the registry keeps a
 * copy, and these pin that the copy is a plain array holding exactly the entries
 * that were checked.
 */
describe("InventoryProviderRegistry attributeKeysOf", () => {
  // Every entry is a string, so the shape check passes all three.
  const ownMethodsNotCallable = (): string[] => {
    const keys = ["role", "site"];
    Object.defineProperty(keys, "map", { value: undefined });
    Object.defineProperty(keys, "some", { value: undefined });
    return keys;
  };
  class YieldsANumber extends Array<string> {}
  Object.defineProperty(YieldsANumber.prototype, Symbol.iterator, {
    value: function* () {
      yield 42;
    }
  });
  const subclassWithHostileIterator = (): string[] => {
    const keys = new YieldsANumber();
    keys.push("role", "site");
    return keys;
  };
  const entryAnswersTwice = (): string[] => {
    const keys = ["role", "site"];
    let reads = 0;
    Object.defineProperty(keys, 1, { get: () => (reads++ === 0 ? "site" : 42), enumerable: true, configurable: true });
    return keys;
  };

  it.each([
    ["own `map` and `some` that are not callable", ownMethodsNotCallable],
    ["an Array subclass whose iterator yields a number", subclassWithHostileIterator],
    ["an entry that answers a string when read once and a number after", entryAnswersTwice]
  ])(
    "keeps a plain frozen copy of attributeKeys with %s, holding exactly the entries it checked (⊘ keeping the provider's array; ⊘ `[...keys]` / `Array.from(keys)`, which run its iterator; ⊘ `keys.slice()`, which builds the subclass again; ⊘ checking and copying in two reads)",
    (_label, make) => {
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ attributeKeys: make() }));

      const stored = registry.attributeKeysOf("netbox")!;
      expect(Array.isArray(stored)).toBe(true);
      expect(Object.getPrototypeOf(stored)).toBe(Array.prototype);
      expect(Object.getOwnPropertyNames(stored)).toEqual(["0", "1", "length"]); // no own `map`, `some` or accessor
      expect(Object.isFrozen(stored)).toBe(true);
      expect(stored[0]).toBe("role");
      expect(stored[1]).toBe("site");
      // ...so the consumers that threw on the provider's own array take it.
      expect(knownKeysList(stored)).toBe("role, site, name");
      expect(unknownFilterKeys(parseTemplateFilter("rack=1&role=x"), stored)).toEqual(["rack"]);
    }
  );

  it("is the list as it stood at registration, whatever the provider does to its array afterwards (⊘ keeping the provider's array, which a later `push(42)` reaches)", () => {
    const registry = new InventoryProviderRegistry();
    const keys = ["role"];
    registry.register(makeProvider({ attributeKeys: keys }));

    keys.push(42 as never);
    keys[0] = "zone";

    expect(registry.attributeKeysOf("netbox")).toEqual(["role"]);
  });

  it("answers undefined for a provider that declares no list, and for an id no provider holds, including once disposed (⊘ `?? []`, which turns 'no list to check against' into 'only `name` is known'; ⊘ a copy that outlives its registration)", () => {
    const registry = new InventoryProviderRegistry();
    registry.register(makeProvider({ id: "no-list" }));
    const withList = registry.register(makeProvider({ id: "with-list", attributeKeys: ["role"] }));
    expect(registry.attributeKeysOf("no-list")).toBeUndefined();
    expect(registry.attributeKeysOf("unknown")).toBeUndefined();
    expect(registry.attributeKeysOf("with-list")).toEqual(["role"]);

    withList.dispose();

    expect(registry.attributeKeysOf("with-list")).toBeUndefined();
  });
});

/**
 * configFields AS THE REGISTRY KEEPS IT (issue #195) — `attributeKeys`' gap, with
 * more consumers: the Add/Edit Source form, the collection parse, the sync's
 * required-secret loop, and the trust-model fingerprint that runs on every path
 * that spends a source's credentials. The check used to walk the list with
 * `for…of` and then keep the provider's own array, so the check and the consumers
 * could see different lists, and the consumers ran methods the provider controls.
 * These pin that the registry keeps a deep, frozen, plain copy holding exactly
 * what was checked, and that every consumer outside the command layer takes it
 * (the command layer's are pinned in inventoryCommands.test.ts).
 */
describe("InventoryProviderRegistry configFieldsOf", () => {
  const host = (): InventoryConfigField => ({ id: "host", label: "Host", type: "string", required: true, placeholder: "netbox.example.com" });
  const token = (): InventoryConfigField => ({ id: "apiToken", label: "API Token", type: "password", required: true, description: "A read-only token." });
  const family = (): InventoryConfigField => ({
    id: "family",
    label: "Family",
    type: "select",
    options: [
      { label: "Auto", value: "auto" },
      { label: "IPv4", value: "v4" }
    ]
  });
  /** The three fields as a well-behaved provider would have declared them. */
  const EXPECTED: InventoryConfigField[] = [host(), token(), family()];

  /** Array subclasses whose iterator disagrees with their indices. */
  class IteratesToNull extends Array<unknown> {}
  Object.defineProperty(IteratesToNull.prototype, Symbol.iterator, {
    value: function* () {
      yield null;
    }
  });
  class IteratesToAValidField extends Array<unknown> {}
  Object.defineProperty(IteratesToAValidField.prototype, Symbol.iterator, {
    value: function* () {
      yield host();
    }
  });

  /**
   * Every consumer outside the command layer, over the copy. Each of them threw on
   * at least one of the provider arrays below, and the fingerprint comparison
   * proves the copy is exactly what was checked, not merely something that does
   * not throw.
   */
  function expectConsumersTakeTheCopy(registry: InventoryProviderRegistry, provider: InventoryProvider): void {
    const configFields = registry.configFieldsOf(provider);
    // Member for member. `family()` declares no `required`, so this is also what
    // catches a copy that adds `required: false`, which the fingerprint below
    // normalises away.
    expect(configFields).toEqual(EXPECTED);
    expect(computeProviderFingerprint({ label: provider.label, configFields })).toBe(
      computeProviderFingerprint({ label: provider.label, configFields: EXPECTED })
    );
    expect(() => renderFormHtml(inventorySourceFormDefinition({ label: provider.label, configFields }))).not.toThrow();
    expect(() => savedFilterTarget(configFields)).not.toThrow();
  }

  /** Plain arrays and objects all the way down, frozen, with no accessor left to answer twice. */
  function expectPlainFrozenCopy(stored: readonly InventoryConfigField[]): void {
    const indexNames = (list: readonly unknown[]): string[] => [...Array(list.length).keys()].map(String).concat("length");
    expect(Object.getPrototypeOf(stored)).toBe(Array.prototype);
    expect(Object.getOwnPropertyNames(stored)).toEqual(indexNames(stored)); // no own `map`, `some` or accessor
    expect(Object.isFrozen(stored)).toBe(true);
    for (const field of stored) {
      expect(Object.getPrototypeOf(field)).toBe(Object.prototype);
      expect(Object.isFrozen(field)).toBe(true);
      for (const key of Object.keys(field)) {
        expect(Object.getOwnPropertyDescriptor(field, key)).toHaveProperty("value");
      }
      if (field.options !== undefined) {
        expect(Object.getPrototypeOf(field.options)).toBe(Array.prototype);
        expect(Object.getOwnPropertyNames(field.options)).toEqual(indexNames(field.options));
        expect(Object.isFrozen(field.options)).toBe(true);
        for (const option of field.options) {
          expect(Object.getPrototypeOf(option)).toBe(Object.prototype);
          expect(Object.isFrozen(option)).toBe(true);
          // Exactly the contract's two members: anything else an option carries
          // never reaches the form, which renders an option's `description` and
          // `fillValue` through `escapeHtml` when present.
          expect(Object.keys(option).sort()).toEqual(["label", "value"]);
        }
      }
    }
  }

  const ownMethodsNotCallable = (): unknown[] => {
    const fields = [host(), token(), family()];
    for (const name of ["map", "some", "find", "filter", "flatMap", "forEach"]) {
      Object.defineProperty(fields, name, { value: undefined });
    }
    return fields;
  };
  const subclassIteratingToNull = (): unknown[] => {
    const fields = new IteratesToNull();
    fields.push(host(), token(), family());
    return fields;
  };
  const entryAnswersTwice = (): unknown[] => {
    const fields: unknown[] = [host(), token(), family()];
    const checked = fields[1];
    let reads = 0;
    Object.defineProperty(fields, 1, { get: () => (reads++ === 0 ? checked : null), enumerable: true, configurable: true });
    return fields;
  };
  const memberAnswersTwice = (): unknown[] => {
    const answering = token();
    let reads = 0;
    Object.defineProperty(answering, "label", { get: () => (reads++ === 0 ? "API Token" : 42), enumerable: true });
    return [host(), answering, family()];
  };
  const optionsWithOwnMethodsNotCallable = (): unknown[] => {
    const select = family();
    for (const name of ["map", "some", "find"]) {
      Object.defineProperty(select.options, name, { value: undefined });
    }
    return [host(), token(), select];
  };
  const optionsSubclassIteratingToNull = (): unknown[] => {
    const options = new IteratesToNull();
    options.push({ label: "Auto", value: "auto" }, { label: "IPv4", value: "v4" });
    return [host(), token(), { ...family(), options }];
  };
  const optionAnswersTwice = (): unknown[] => {
    const select = family();
    const checked = select.options![0];
    let reads = 0;
    Object.defineProperty(select.options, 0, { get: () => (reads++ === 0 ? checked : null), enumerable: true, configurable: true });
    return [host(), token(), select];
  };
  const optionMembersOutsideTheContract = (): unknown[] => [
    host(),
    token(),
    { ...family(), options: [{ label: "Auto", value: "auto", description: 42, fillValue: 7 }, { label: "IPv4", value: "v4" }] }
  ];

  it.each([
    ["own `map`, `some`, `find`, `filter`, `flatMap` and `forEach` that are not callable", ownMethodsNotCallable],
    ["an Array subclass whose iterator yields null while its indices hold the fields", subclassIteratingToNull],
    ["an entry that answers a field when read once and null after", entryAnswersTwice],
    ["a field whose label answers a string when read once and a number after", memberAnswersTwice],
    ["select options with own `map`, `some` and `find` that are not callable", optionsWithOwnMethodsNotCallable],
    ["select options in an Array subclass whose iterator yields null", optionsSubclassIteratingToNull],
    ["a select option that answers an option when read once and null after", optionAnswersTwice],
    ["a select option carrying a non-string `description` and `fillValue`", optionMembersOutsideTheContract]
  ])(
    "registers configFields with %s and keeps a plain frozen copy of exactly what it checked, which every consumer takes (⊘ keeping the provider's array; ⊘ `[...fields]` / `Array.from(fields)`, which run its iterator; ⊘ `fields.slice()`, which builds the subclass again; ⊘ checking and copying in two reads; ⊘ a shallow copy that keeps the provider's `options`)",
    (_label, make) => {
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({ configFields: make() as InventoryConfigField[] });
      registry.register(provider);

      expectPlainFrozenCopy(registry.configFieldsOf(provider));
      expectConsumersTakeTheCopy(registry, provider);
    }
  );

  const subclassIteratingValidOverANull = (): unknown[] => {
    const fields = new IteratesToAValidField();
    fields.push(host(), null);
    return fields;
  };
  const sparse = (): unknown[] => {
    const fields: unknown[] = [host()];
    fields[2] = token();
    return fields;
  };
  it.each([
    [
      "an Array subclass whose iterator yields a valid field while index 1 holds null",
      "the `for…of` check, which passes it and leaves `.map` to throw out of the fingerprint on every credential-bearing path",
      subclassIteratingValidOverANull
    ],
    [
      "a sparse array with a hole at index 1",
      "a refusal that names no entry, as the `for…of` check's \"entries must be objects\" did; ⊘ a walk that skips holes, such as `forEach`, which registers it",
      sparse
    ]
  ])(
    "refuses configFields that is %s, naming the entry's index (⊘ %s)",
    (_label, _killed, make) => {
      const registry = new InventoryProviderRegistry();
      expect(() => registry.register(makeProvider({ configFields: make() as InventoryConfigField[] }))).toThrow(
        "Inventory provider configFields entry 1 must be an object."
      );
      expect(registry.get("netbox")).toBeUndefined();
    }
  );

  it("refuses select options whose iterator yields valid options while an index holds null, naming the field (⊘ the `for…of` check over `options`)", () => {
    const options: unknown[] = [{ label: "Auto", value: "auto" }, null];
    Object.defineProperty(options, Symbol.iterator, {
      value: function* () {
        yield { label: "Auto", value: "auto" };
      }
    });
    expect(() => validateProviderShape(makeProvider({ configFields: [{ ...family(), options: options as never }] }))).toThrow(
      /"family".*invalid select option/
    );
  });

  it("is the list as it stood at registration: a push, a replaced entry, or an edit to a field or an option afterwards reaches no consumer (⊘ keeping the provider's array; ⊘ a shallow copy that keeps the provider's field objects or its `options`)", () => {
    const registry = new InventoryProviderRegistry();
    const fields = [host(), token(), family()];
    const provider = makeProvider({ configFields: fields });
    registry.register(provider);

    const [, tokenField, selectField] = fields;
    fields.push(null as never);
    fields[0] = { id: "late", label: "Late", type: "password", required: true };
    (tokenField as { label: unknown }).label = 42;
    selectField.options!.push(null as never);
    (selectField.options![0] as { label: unknown }).label = 42;

    expectConsumersTakeTheCopy(registry, provider);
  });

  it("belongs to the provider OBJECT, not to its id: a flow still holding a provider that was disposed and replaced under the same id reads that provider's own fields (⊘ looking the copy up by id, which answers that flow — an open form, a pending modal — with the replacement's fields, so a fingerprint mixes one registrant's label with another's fields, or with nothing at all)", () => {
    const registry = new InventoryProviderRegistry();
    const original = makeProvider({ configFields: [host()] });
    const registration = registry.register(original);
    registration.dispose();
    const replacement = makeProvider({ configFields: [token()] });
    registry.register(replacement);

    expect(registry.configFieldsOf(original)).toEqual([host()]);
    expect(registry.configFieldsOf(replacement)).toEqual([token()]);
  });

  it("throws for a provider this registry never accepted, including one refused as a duplicate (⊘ `?? []`, which would render a form with no provider fields and fingerprint an empty shape)", () => {
    const registry = new InventoryProviderRegistry();
    registry.register(makeProvider());
    const duplicate = makeProvider({ configFields: [token()] });
    expect(() => registry.register(duplicate)).toThrow(/already registered/i);

    expect(() => registry.configFieldsOf(duplicate)).toThrow('Inventory provider "netbox" was never registered with this registry.');
    expect(() => registry.configFieldsOf(makeProvider())).toThrow('Inventory provider "netbox" was never registered with this registry.');
  });
});

/**
 * REGISTRATION EVENT — the registry is read at PAINT TIME by capability gates
 * (the tree's node-control and web-console markers, the Settings tree's
 * provider label), so a registration that lands after a surface has painted is
 * invisible to it until something unrelated repaints. The markers gate menu
 * entries whose commands are hidden from the palette, so "until something
 * unrelated repaints" means "never, reachably". These pin the event that closes
 * that window — and the disposal half, which is the same staleness pointing the
 * other way.
 */
describe("InventoryProviderRegistry onDidChange", () => {
  it("fires once per registration (⊘ a silent register leaves every already-painted surface answering from a registry that does not know the provider)", () => {
    const registry = new InventoryProviderRegistry();
    const fired: number[] = [];
    registry.onDidChange(() => fired.push(registry.list().length));

    registry.register(makeProvider({ id: "provider-a" }));
    registry.register(makeProvider({ id: "provider-b" }));

    // One event each, and each one observed AFTER the map write — a listener
    // that repaints from the registry must see the provider it was told about,
    // not the state before it.
    expect(fired).toEqual([1, 2]);
  });

  it("does NOT fire when register() rejects a duplicate id or a bad shape (⊘ a repaint for a registration that never happened)", () => {
    const registry = new InventoryProviderRegistry();
    registry.register(makeProvider({ id: "provider-a" }));
    const listener = vi.fn();
    registry.onDidChange(listener);

    expect(() => registry.register(makeProvider({ id: "provider-a" }))).toThrow(/already registered/i);
    expect(() => registry.register({ id: "", label: "x" } as unknown as InventoryProvider)).toThrow();

    expect(listener).not.toHaveBeenCalled();
  });

  it("fires on dispose, after the provider has stopped resolving (⊘ a disposed provider's marker stays stamped on rows whose capability is gone, and the menu entry it gates leads to a 'not supported' error)", () => {
    const registry = new InventoryProviderRegistry();
    const registration = registry.register(makeProvider({ id: "provider-a" }));
    const seen: Array<InventoryProvider | undefined> = [];
    registry.onDidChange(() => seen.push(registry.get("provider-a")));

    registration.dispose();

    expect(seen).toEqual([undefined]);
  });

  it("does NOT fire for a stale dispose that evicts nothing — the replacement registration keeps the id and no repaint is claimed (⊘ an event per no-op, or worse, an event announcing a removal that did not happen)", () => {
    const registry = new InventoryProviderRegistry();
    const first = registry.register(makeProvider({ id: "provider-a" }));
    first.dispose();
    const replacement = makeProvider({ id: "provider-a", label: "Replacement" });
    registry.register(replacement);

    const listener = vi.fn();
    registry.onDidChange(listener);
    first.dispose(); // stale: the id now belongs to `replacement`

    expect(listener).not.toHaveBeenCalled();
    expect(registry.get("provider-a")).toBe(replacement);
  });

  it("stops delivering after the returned unsubscribe is called (⊘ a listener that outlives its owner repaints a disposed view for the rest of the session)", () => {
    const registry = new InventoryProviderRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.onDidChange(listener);
    registry.register(makeProvider({ id: "provider-a" }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    registry.register(makeProvider({ id: "provider-b" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener neither fails register() nor starves the listeners after it (⊘ one third-party consumer's exception aborts the registration or silences every other surface's repaint)", () => {
    const registry = new InventoryProviderRegistry();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const second = vi.fn();
      registry.onDidChange(() => {
        throw new TypeError("faulty consumer");
      });
      registry.onDidChange(second);

      const provider = makeProvider({ id: "provider-a" });
      expect(() => registry.register(provider)).not.toThrow();
      expect(registry.get("provider-a")).toBe(provider);
      expect(second).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
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

  // canControlNode provider capability — the twin of the controlNode clause.
  // OPTIONAL (a provider whose whole device set is controllable declares
  // nothing; absence means the tree's menu gate answers yes for every row), but
  // a non-function value under that name IS an error, loudly, for the same
  // reason controlNode's is — with one twist that makes the boundary check
  // matter more: the gate invokes the member DURING TREE RENDER, so a
  // non-function `canControlNode` that survived registration would surface as
  // a TypeError on every repaint instead of a clear registration-time verdict.
  it("accepts a provider with NO canControlNode — it is optional (kills making it required, which would break every provider whose whole device set is controllable)", () => {
    const provider = makeProvider();
    expect(provider.canControlNode).toBeUndefined();
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("accepts a provider WITH a function canControlNode", () => {
    const provider = makeProvider({ canControlNode: () => true });
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("rejects a non-function canControlNode loudly (kills a silent survive-at-registration for a typo'd `canControlNode` that is not callable — the menu gate invokes it during tree render, where a string value would throw TypeError on every repaint of a row)", () => {
    expect(() => validateProviderShape(makeProvider({ canControlNode: "nope" as never }))).toThrow(/canControlNode/);
    expect(() => validateProviderShape(makeProvider({ canControlNode: 42 as never }))).toThrow(/canControlNode/);
  });

  // webConsoleUrl provider capability — the twin of the canControlNode clause,
  // and it fails the same loud way for the same reason: the tree's marker gate
  // reads the member's PRESENCE during render, so a typo'd `webConsoleUrl` that
  // survived registration stamps a row with a menu entry the click cannot
  // honour — the command invokes the member, and a non-function value throws
  // TypeError mid-click instead of being named here, at registration.
  it("accepts a provider with NO webConsoleUrl — it is optional (kills making it required, which would break every provider that offers no web console)", () => {
    const provider = makeProvider();
    expect(provider.webConsoleUrl).toBeUndefined();
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("accepts a provider WITH a function webConsoleUrl", () => {
    const provider = makeProvider({ webConsoleUrl: async () => "https://pve.example.com:8006/?console=kvm" });
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("rejects a non-function webConsoleUrl loudly (kills a silent survive-at-registration for a typo'd `webConsoleUrl` that is not callable — the marker gate reads its presence at render and the command invokes it on click, so a string value shows the menu entry and throws TypeError when used)", () => {
    expect(() => validateProviderShape(makeProvider({ webConsoleUrl: "nope" as never }))).toThrow(/webConsoleUrl/);
    expect(() => validateProviderShape(makeProvider({ webConsoleUrl: 42 as never }))).toThrow(/webConsoleUrl/);
  });

  // canWebConsole provider capability — to webConsoleUrl what canControlNode is
  // to controlNode, and it fails the same loud way: the device half of the gate
  // is INVOKED during tree render, so a non-function value that survived
  // registration would throw TypeError on every repaint of a row instead of
  // being named here, once, at registration.
  it("accepts a provider with NO canWebConsole — it is optional (kills making it required, which would break every provider whose whole device set has a web console)", () => {
    const provider = makeProvider();
    expect(provider.canWebConsole).toBeUndefined();
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("accepts a provider WITH a function canWebConsole", () => {
    const provider = makeProvider({ canWebConsole: () => true });
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it("rejects a non-function canWebConsole loudly (kills a silent survive-at-registration for a typo'd `canWebConsole` that is not callable — the marker gate invokes it during tree render, where a string value would throw TypeError on every repaint of a row)", () => {
    expect(() => validateProviderShape(makeProvider({ canWebConsole: "nope" as never }))).toThrow(/canWebConsole/);
    expect(() => validateProviderShape(makeProvider({ canWebConsole: 42 as never }))).toThrow(/canWebConsole/);
  });

  // attributeKeys (issue #163 item 2) — the one optional member that is DATA, and
  // the one the registry used to let through unchecked. Every consumer
  // (`unknownFilterKeys`, `knownKeysList`) iterates it and calls string methods on
  // each entry, so a malformed list surfaced as a TypeError out of Edit Template
  // Rules, before the Rule Filter box could open, instead of here.
  it("accepts a provider with NO attributeKeys — it is optional (⊘ making it required, which would refuse every provider that declares no key list)", () => {
    const provider = makeProvider();
    expect(provider.attributeKeys).toBeUndefined();
    expect(() => validateProviderShape(provider)).not.toThrow();
  });

  it.each([
    ["a comma-joined string", "role,site"],
    ["null", null],
    ["an array-like object", { 0: "role", length: 1 }],
    ["a Set", new Set(["role"])]
  ])("rejects attributeKeys that is %s, naming the member (⊘ no clause, which hands the list to `knownKeysList` / `unknownFilterKeys`, both of which throw TypeError on it)", (_label, bad) => {
    expect(() => validateProviderShape(makeProvider({ attributeKeys: bad as never }))).toThrow(
      "Inventory provider attributeKeys must be an array of strings when present."
    );
  });

  // A hole in a sparse array reads as `undefined` once `knownKeysList` spreads the
  // list to append `name`, and throws there exactly as a stored `undefined` would — but
  // `Array.prototype.every` SKIPS holes, so a check written with it lets one through.
  const sparse: unknown[] = ["role"];
  sparse[2] = "site";
  it.each([
    ["a number", ["role", 42], 1],
    ["null", ["role", "site", null], 2],
    ["undefined", [undefined, "role"], 0],
    ["a nested array", ["role", ["site"]], 1],
    ["a hole (sparse array)", sparse, 1]
  ])("rejects an attributeKeys entry that is %s, naming the entry's index (⊘ checking only `Array.isArray`; ⊘ `.every(isString)`, which skips holes)", (_label, bad, index) => {
    expect(() => validateProviderShape(makeProvider({ attributeKeys: bad as never }))).toThrow(
      `Inventory provider attributeKeys entry ${index} must be a string.`
    );
  });

  it.each([
    ["an empty list (a provider that matches on `name` alone)", []],
    ["a list of keys", ["role", "site", "name"]],
    // Neither throws anywhere: a blank key matches nothing and `knownKeysList`
    // leaves it out, and a duplicate is one entry to the matcher's Set. Refusing
    // the provider's whole registration over one would cost far more than the entry.
    ["blank, whitespace-only and duplicate keys", ["", "   ", "role", "role", "Role"]]
  ])("accepts attributeKeys that is %s (⊘ an over-strict clause that refuses a whole provider over an entry every consumer already copes with)", (_label, keys) => {
    expect(() => validateProviderShape(makeProvider({ attributeKeys: keys }))).not.toThrow();
    // ...and the premise of accepting it: both consumers take the list as it is,
    // with no blank slot in the list a user is shown.
    expect(() => unknownFilterKeys(parseTemplateFilter("role=x"), keys)).not.toThrow();
    expect(knownKeysList(keys).split(", ")).not.toContain("");
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

  /**
   * ISSUE #187 — the four field members that had no clause. Each is read by the
   * source form: `placeholder` and `description` are rendered through
   * `escapeHtml`, which calls `replaceAll` on its argument, so a number there made
   * the Add/Edit Source form throw as it rendered; `required` and `advanced` are
   * read as truthy flags, so `advanced: "no"` filed a field under Advanced options
   * and `required: "no"` made it mandatory.
   */
  it.each([
    ["placeholder", 42, "non-string placeholder"],
    ["placeholder", null, "non-string placeholder"],
    ["description", { text: "A token." }, "non-string description"],
    ["description", 7, "non-string description"],
    ["required", "no", "non-boolean required flag"],
    ["required", 1, "non-boolean required flag"],
    ["advanced", "no", "non-boolean advanced flag"],
    ["advanced", 0, "non-boolean advanced flag"]
  ])(
    "refuses a field whose %s is %o, naming the field (⊘ no clause, which lets a number reach `escapeHtml` and throw out of the source form as it renders, or a truthy string flip a flag the provider meant off)",
    (member, value, message) => {
      expect(() =>
        validateProviderShape(makeProvider({ configFields: [{ id: "token", label: "Token", type: "string", [member]: value } as never] }))
      ).toThrow(`Inventory provider configFields entry "token" has a ${message}.`);
    }
  );

  it("accepts each of those four members when absent, and when it has its declared type (⊘ a clause that refuses the shape every built-in provider declares)", () => {
    expect(() => validateProviderShape(makeProvider({ configFields: [{ id: "token", label: "Token", type: "string" }] }))).not.toThrow();
    expect(() =>
      validateProviderShape(
        makeProvider({
          configFields: [{ id: "token", label: "Token", type: "string", placeholder: "", description: "What it is.", required: false, advanced: true }]
        })
      )
    ).not.toThrow();
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
