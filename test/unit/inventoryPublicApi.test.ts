import { describe, expect, it } from "vitest";
import { createNexusExtensionApi } from "../../src/services/inventory/publicApi";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";
import type { InventoryProvider } from "../../src/models/inventory";

function makeProvider(overrides: Partial<InventoryProvider> = {}): InventoryProvider {
  return {
    id: "acme",
    label: "Acme CMDB",
    configFields: [],
    testConnection: async () => {},
    fetchInventory: async () => ({ contractVersion: 1, devices: [] }),
    ...overrides
  };
}

describe("createNexusExtensionApi", () => {
  it("exposes contractVersion 1", () => {
    const api = createNexusExtensionApi(new InventoryProviderRegistry());
    expect(api.contractVersion).toBe(1);
  });

  it("is frozen — assigning a property throws in strict mode (kills a mutable bag)", () => {
    const api = createNexusExtensionApi(new InventoryProviderRegistry());
    expect(() => {
      (api as unknown as { contractVersion: number }).contractVersion = 2;
    }).toThrow();
    expect(api.contractVersion).toBe(1);
  });

  it("registers a provider through the underlying registry — registry.get finds it (kills bypassing registry validation)", () => {
    const registry = new InventoryProviderRegistry();
    const api = createNexusExtensionApi(registry);
    const provider = makeProvider();

    api.registerInventoryProvider(provider);

    expect(registry.get("acme")).toBe(provider);
  });

  it("the returned disposable unregisters the provider", () => {
    const registry = new InventoryProviderRegistry();
    const api = createNexusExtensionApi(registry);
    const provider = makeProvider();

    const registration = api.registerInventoryProvider(provider);
    expect(registry.get("acme")).toBe(provider);

    registration.dispose();
    expect(registry.get("acme")).toBeUndefined();
  });

  it("registering a duplicate id throws, and the first registration is still resolvable", () => {
    const registry = new InventoryProviderRegistry();
    const api = createNexusExtensionApi(registry);
    const first = makeProvider();
    api.registerInventoryProvider(first);

    expect(() => api.registerInventoryProvider(makeProvider())).toThrow();
    expect(registry.get("acme")).toBe(first);
  });

  it("registering a malformed provider is rejected by the registry's own validation, not silently accepted", () => {
    const registry = new InventoryProviderRegistry();
    const api = createNexusExtensionApi(registry);

    expect(() =>
      api.registerInventoryProvider({ id: "bad", label: "Bad" } as unknown as InventoryProvider)
    ).toThrow();
    expect(registry.get("bad")).toBeUndefined();
  });
});
