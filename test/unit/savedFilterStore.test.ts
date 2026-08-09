import { describe, expect, it, vi } from "vitest";
// `sanitizeForSharing` lives in configCommands, which imports `vscode` at module
// scope (used only inside functions), so a bare module stub is enough to load it.
vi.mock("vscode", () => ({}));
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { sanitizeForSharing } from "../../src/commands/configCommands";
import { savedFilterDefinitionsEqual, type SavedFilterDefinition } from "../../src/models/savedFilter";
import type { InventorySourceConfig } from "../../src/models/inventory";

/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E, backlog #1) — model comparator,
 * NexusCore CRUD + rollback + snapshot exposure, and the load-bearing invariant
 * that deleting a saved filter does NOT sweep any source's stored `config.filter`.
 */

function source(id: string, overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    id,
    providerId: "netbox",
    name: id,
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: {},
    secretFieldIds: [],
    ...overrides
  };
}

describe("savedFilterDefinitionsEqual (model comparator)", () => {
  const base: SavedFilterDefinition = { id: "f1", name: "Syd core", filter: "role=core&site=syd" };

  it("two lists with the same ids/name/filter are equal regardless of order (kills an order-sensitive comparator)", () => {
    const other: SavedFilterDefinition = { id: "f2", name: "Melb", filter: "site=melb" };
    expect(savedFilterDefinitionsEqual([base, other], [other, base])).toBe(true);
  });

  it("a differing filter string makes them unequal (kills a comparator that only checks id/name)", () => {
    expect(savedFilterDefinitionsEqual([base], [{ ...base, filter: "role=edge" }])).toBe(false);
  });

  it("a differing name makes them unequal (kills a comparator that only checks id/filter)", () => {
    expect(savedFilterDefinitionsEqual([base], [{ ...base, name: "Renamed" }])).toBe(false);
  });

  it("different lengths are unequal; absent and [] are equal", () => {
    expect(savedFilterDefinitionsEqual([base], [])).toBe(false);
    expect(savedFilterDefinitionsEqual(undefined, [])).toBe(true);
  });
});

describe("NexusCore saved-filter CRUD", () => {
  it("addOrUpdate persists, exposes on the snapshot, and getSavedFilter resolves it", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateSavedFilter({ id: "f1", name: "Syd core", filter: "role=core&site=syd" });

    expect(core.getSavedFilter("f1")).toEqual({ id: "f1", name: "Syd core", filter: "role=core&site=syd" });
    expect(core.getSnapshot().savedFilters).toEqual([{ id: "f1", name: "Syd core", filter: "role=core&site=syd" }]);
    // Persisted through to the repository (survives a reload).
    const core2 = new NexusCore(repo);
    await core2.initialize();
    expect(core2.getSavedFilter("f1")?.filter).toBe("role=core&site=syd");
  });

  it("addOrUpdate rejection restores the captured map (kills a mutate-without-rollback)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateSavedFilter({ id: "f1", name: "orig", filter: "a=1" });

    vi.spyOn(repo, "saveSavedFilters").mockRejectedValueOnce(new Error("disk full"));
    await expect(core.addOrUpdateSavedFilter({ id: "f1", name: "edited", filter: "a=2" })).rejects.toThrow("disk full");
    // The previous record is restored, not left half-edited in memory.
    expect(core.getSavedFilter("f1")).toEqual({ id: "f1", name: "orig", filter: "a=1" });
  });

  it("a rejected first-write removes the never-committed record (kills a rollback that only handles updates)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    vi.spyOn(repo, "saveSavedFilters").mockRejectedValueOnce(new Error("disk full"));
    await expect(core.addOrUpdateSavedFilter({ id: "new", name: "n", filter: "x=1" })).rejects.toThrow("disk full");
    expect(core.getSavedFilter("new")).toBeUndefined();
  });

  it("removeSavedFilter deletes the record and persists it", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateSavedFilter({ id: "f1", name: "n", filter: "x=1" });
    await core.removeSavedFilter("f1");
    expect(core.getSavedFilter("f1")).toBeUndefined();
    expect(core.getSnapshot().savedFilters).toEqual([]);
  });

  it("removeSavedFilter rejection restores the deleted record (kills a delete-without-rollback)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateSavedFilter({ id: "f1", name: "n", filter: "x=1" });
    vi.spyOn(repo, "saveSavedFilters").mockRejectedValueOnce(new Error("disk full"));
    await expect(core.removeSavedFilter("f1")).rejects.toThrow("disk full");
    expect(core.getSavedFilter("f1")).toEqual({ id: "f1", name: "n", filter: "x=1" });
  });

  it("deleting a saved filter does NOT sweep a source's stored config.filter (kills an accidental sweep)", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    // The source's own filter is an INDEPENDENT COPY of the definition's value —
    // constructed identical on purpose so a sweep keyed on value-equality would
    // visibly change it, making this fixture non-vacuous.
    await core.addOrUpdateSavedFilter({ id: "f1", name: "Syd core", filter: "role=core&site=syd" });
    await core.addOrUpdateInventorySource(source("s1", { config: { filter: "role=core&site=syd" } }));

    await core.removeSavedFilter("f1");

    expect(core.getSavedFilter("f1")).toBeUndefined();
    // The source keeps its own copy of the filter — deleting the template it was
    // copied from must never reach the source record.
    expect(core.getInventorySource("s1")!.config.filter).toBe("role=core&site=syd");
  });
});

describe("share export EXCLUDES saved filters (PR-E)", () => {
  it("sanitizeForSharing output carries no savedFilters key (kills a bundle that leaks them)", () => {
    // sanitizeForSharing takes only shareable buckets; a saved filter is
    // workspace-specific like inventory sources / device templates and must never
    // appear in a bundle shared with a stranger. It is excluded by omission — the
    // function has no savedFilters parameter — so the produced snapshot has no
    // such key at all.
    const result = sanitizeForSharing([], [], [], [], {}, [], []) as Record<string, unknown>;
    expect(result.savedFilters).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "savedFilters")).toBe(false);
  });
});
