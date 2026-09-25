import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltInProviders } from "../../src/services/inventory/builtInProviders";
import { InventoryProviderRegistry, validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { computeProviderFingerprint } from "../../src/models/inventory";

/**
 * The guard on the two ways a built-in provider has actually failed to ship
 * here: registered but unnamed (Proxmox, in the add-source title), and named
 * but unregistered (Proxmox again, for twenty-odd commits — feature-complete
 * and unreachable because the `register()` line was missing).
 *
 * `createBuiltInProviders()` is importable without a `vscode` mock, which is
 * why these can be real runtime assertions rather than the source-text regexes
 * the registration check used to need.
 */
describe("built-in inventory providers", () => {
  it("declares exactly the shipped providers, in add-source picker order (⊘ a set comparison would pass on a reorder, and order is what the user sees first)", () => {
    expect(createBuiltInProviders().map((p) => p.id)).toEqual(["netbox", "eve-ng", "proxmox", "gns3"]);
  });

  it("gives every provider a non-empty label, which is the ONLY string every list, row and description renders it by", () => {
    for (const provider of createBuiltInProviders()) {
      expect(provider.label.length).toBeGreaterThan(0);
    }
  });

  it("returns providers the registry will actually accept (kills a malformed configFields shape reaching users as a failed activation)", () => {
    for (const provider of createBuiltInProviders()) {
      expect(() => validateProviderShape(provider)).not.toThrow();
    }
  });

  /**
   * THE REGISTRY'S COPY CHANGES NO BUILT-IN FINGERPRINT (issue #195). Every path
   * that spends a source's credentials now fingerprints the copy of `configFields`
   * the registry took at registration, not the provider's own array, and every
   * source a user has saved carries a stamp taken the old way. A copy that
   * dropped, added, normalised or reordered anything the hash reads would ask
   * every user of that provider to confirm its credentials again, and would stop
   * live status for all of their sources until they did.
   *
   * The literals are the values the builds before the copy stamped. They also
   * pin the built-in shapes themselves: changing a field a built-in declares is
   * exactly that re-confirmation for its users, so update a literal only on
   * purpose.
   */
  it("fingerprints the registry's copy of each built-in's configFields exactly as the provider's own array was fingerprinted before (⊘ a copy that drops a select's options or reorders fields; ⊘ one that drops a member the hash ignores)", () => {
    const registry = new InventoryProviderRegistry();
    const fingerprints: Record<string, string> = {};
    for (const provider of createBuiltInProviders()) {
      registry.register(provider);
      const configFields = registry.configFieldsOf(provider);
      // Member for member, which the literals below cannot be: a copy that drops
      // a member the hash ignores (`placeholder`, `description`, `advanced`)
      // keeps every fingerprint and is caught only here. It cannot catch a copy
      // that ADDS `required: false`, because every built-in field declares
      // `required`; the registry's own copy tests catch that one.
      expect(configFields).toEqual(provider.configFields);
      fingerprints[provider.id] = computeProviderFingerprint({ label: provider.label, configFields });
    }
    expect(fingerprints).toEqual({
      netbox: "dc9a66a54bad3a2f",
      "eve-ng": "5f83d2655fc19c02",
      proxmox: "b3dd29d387e21afd",
      gns3: "1e603c982fd7d0bb"
    });
  });

  it("hands back independent instances per call, so one caller cannot mutate another's provider objects", () => {
    const [first] = createBuiltInProviders();
    const [second] = createBuiltInProviders();
    expect(first).not.toBe(second);
  });

  /**
   * `extension.ts` imports `vscode` at module scope, so reading its source is
   * still the cheapest seam for "activate() actually wires this up". Only the
   * loop needs pinning now — WHICH providers exist is asserted above, against
   * the real array.
   */
  describe("activation wiring", () => {
    const source = readFileSync(path.resolve(__dirname, "..", "..", "src", "extension.ts"), "utf8");

    it("registers every built-in provider by iterating the shared array (⊘ importing the array without looping would satisfy a name check)", () => {
      expect(source).toMatch(/for \(const provider of createBuiltInProviders\(\)\) \{/);
      expect(source).toMatch(/inventoryProviderRegistry\.register\(provider\);/);
    });

    it("⊘ names no individual provider factory in activate(), so adding one cannot require an edit here", () => {
      expect(source).not.toMatch(/inventoryProviderRegistry\.register\(create\w+Provider\(\)\)/);
    });
  });
});
