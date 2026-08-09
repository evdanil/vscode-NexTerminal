import { describe, expect, it } from "vitest";
import { InventoryProviderRegistry, validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { MAX_INVENTORY_INSTANCE_KEY_LENGTH, resolveProviderInstanceKey } from "../../src/models/inventory";
import type { InventoryProvider } from "../../src/models/inventory";

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
});
