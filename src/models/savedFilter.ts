/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E, backlog #1) — a named, reusable
 * inventory-source Device Filter query.
 *
 * The Device Filter is already persisted on each inventory-source record
 * (`InventorySourceConfig.config.filter`, read on every fetch); what this model
 * adds is REUSE across sources — a library of named filter definitions
 * (*"Sydney core switches"* → `role=core-switch&site=syd`) that the add/edit
 * source flow can offer, so a filter typed once can be applied to another source
 * without retyping.
 *
 * A saved definition is a TEMPLATE TO COPY FROM, never a live reference: picking
 * one fills a source's own `config.filter` with an INDEPENDENT copy of the
 * string, so deleting the definition later must NOT touch any source's stored
 * filter. See `NexusCore.removeSavedFilter` (no source sweep) for the other half
 * of that contract.
 *
 * Pure model — no `vscode` import, no secrets. A filter query string is exactly
 * the same non-secret data as the source's own Device Filter field, so a saved
 * filter travels through the full backup but is EXCLUDED from the sanitized share
 * bundle, mirroring inventory sources / device templates (all workspace-specific
 * wiring with no meaning in a stranger's workspace).
 */
export interface SavedFilterDefinition {
  id: string; // randomUUID at creation
  name: string; // user-facing
  filter: string; // query-string, e.g. "role=core-switch&site=syd"; "" is allowed but discouraged
}

/**
 * Order-insensitive structural equality over the full list, used by tests and by
 * any caller that needs to detect a no-op write. Two definitions are equal iff
 * their id, name and filter all match; two lists are equal iff they name the same
 * ids each carrying the same name/filter (order irrelevant).
 */
export function savedFilterDefinitionsEqual(
  a: readonly SavedFilterDefinition[] | undefined,
  b: readonly SavedFilterDefinition[] | undefined
): boolean {
  const ar = a ?? [];
  const br = b ?? [];
  if (ar.length !== br.length) {
    return false;
  }
  const byId = new Map(br.map((f) => [f.id, f]));
  return ar.every((f) => {
    const other = byId.get(f.id);
    return other !== undefined && other.name === f.name && other.filter === f.filter;
  });
}
