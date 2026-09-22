import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltInProviders } from "../../src/services/inventory/builtInProviders";
import { validateProviderShape } from "../../src/services/inventory/providerRegistry";

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
    expect(createBuiltInProviders().map((p) => p.id)).toEqual(["netbox", "eve-ng", "proxmox"]);
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
