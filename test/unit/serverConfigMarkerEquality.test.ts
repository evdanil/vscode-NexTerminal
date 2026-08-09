import { describe, expect, it } from "vitest";
import { mergeServerConfigFields, serverConfigsEqual } from "../../src/models/config";
import type { DetachedServerOrigin, ServerConfig } from "../../src/models/config";

/**
 * ADOPT 1 — `serverConfigsEqual` / `mergeServerConfigFields` and
 * `ServerConfig.formerlySynced`, the marker "Remove Source → Keep Servers"
 * leaves behind so a re-added source can adopt the servers it once synced
 * instead of duplicating them.
 *
 * Both functions gained `origin` handling when ownership was introduced and
 * both were left untouched when the marker was added, so a write whose ONLY
 * effect is to set or clear a marker compared as "unchanged" — which is not a
 * cosmetic gap in either place:
 *
 *   * `serverConfigsEqual` is the "is the live record still exactly what I
 *     wrote?" guard used by NexusCore.applyInventorySyncPlan's rollback and by
 *     the server edit/remove paths. Reading a marker change as "no change" is
 *     what lets those paths act on a record that moved under them.
 *   * `mergeServerConfigFields` is the rollback merge that decides, field by
 *     field, whether a rejected batch write is rolled back to `prior` or the
 *     concurrent write in `current` is kept. A field it does not know about is
 *     ALWAYS taken from `prior` — so a marker a concurrent Keep Servers just
 *     stamped is silently thrown away, and a marker a concurrent adoption just
 *     consumed is silently restored.
 *
 * Every fixture below is built so the correct and the broken implementations
 * produce visibly DIFFERENT results — a marker-only difference, never a
 * difference that some other compared field would have caught anyway.
 */

const MARKER: DetachedServerOrigin = {
  sourceId: "netbox-1",
  sourceName: "NetBox Prod",
  providerId: "netbox",
  externalId: "device:42",
  detachedAt: 1000
};

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "core-sw",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

describe("serverConfigsEqual — formerlySynced (ADOPT 1)", () => {
  it("a record carrying a marker is NOT equal to the otherwise-identical record without one (kills a comparator that ignores formerlySynced entirely)", () => {
    const kept = server({ formerlySynced: MARKER });
    const manual = server();
    // Identical in every single other field — id, name, host, port, username,
    // authType, isHidden, and both records are unowned (no `origin`). The
    // marker is the ONLY difference, and it is the whole difference between
    // "a re-added source will adopt this" and "a re-added source will
    // duplicate this". A comparator blind to it returns true here, and the
    // rollback paths built on it then treat a Keep Servers stamp — or an
    // adoption that consumed one — as a write that changed nothing.
    expect(serverConfigsEqual(kept, manual)).toBe(false);
    expect(serverConfigsEqual(manual, kept)).toBe(false);
  });

  it("two markers differing only in a MATCHING input are not equal (kills a comparator that checks presence but not contents)", () => {
    const a = server({ formerlySynced: MARKER });
    // externalId names the device this record used to be — get it wrong and
    // adoption lands the wrong device on this server, or none at all.
    expect(serverConfigsEqual(a, server({ formerlySynced: { ...MARKER, externalId: "device:99" } }))).toBe(false);
    // providerId is the clause that stops a marker left by one provider's
    // source being claimed by an entirely different kind of source.
    expect(serverConfigsEqual(a, server({ formerlySynced: { ...MARKER, providerId: "vcenter" } }))).toBe(false);
  });

  it("two markers differing only in a RECEIPT field are not equal (kills narrowing the comparison to providerId + externalId)", () => {
    const a = server({ formerlySynced: MARKER });
    // `sourceId`/`sourceName`/`detachedAt` never take part in matching, so a
    // comparator scoped to "the fields adoption reads" would skip them — but
    // they are what the UI tells the user this server came from, and a change
    // to them is still a change to the record that must not be rolled back
    // over.
    expect(serverConfigsEqual(a, server({ formerlySynced: { ...MARKER, sourceId: "netbox-2" } }))).toBe(false);
    expect(serverConfigsEqual(a, server({ formerlySynced: { ...MARKER, sourceName: "NetBox Lab" } }))).toBe(false);
    expect(serverConfigsEqual(a, server({ formerlySynced: { ...MARKER, detachedAt: 2000 } }))).toBe(false);
  });

  it("identical markers (distinct objects) still compare equal, and so do two records with no marker at all (kills a comparator that compares by reference, which would report every unchanged kept server as changed)", () => {
    expect(serverConfigsEqual(server({ formerlySynced: MARKER }), server({ formerlySynced: { ...MARKER } }))).toBe(true);
    expect(serverConfigsEqual(server(), server())).toBe(true);
  });
});

describe("mergeServerConfigFields — formerlySynced (ADOPT 1)", () => {
  it("keeps a marker a CONCURRENT Remove Source → Keep Servers stamped, instead of reverting to prior's absence (kills leaving formerlySynced out of the merge)", () => {
    // prior: the record before the (now-rejected) batch write — no marker.
    // batchSnapshot: what this batch wrote — a rename, and still no marker.
    // current: what the live record holds now — a concurrent Keep Servers
    // stamped the marker in place. The marker is the ONLY thing separating
    // batchSnapshot from current, so nothing else can make this pass.
    const prior = server();
    const batchSnapshot = server({ name: "renamed-by-batch" });
    const current = server({ name: "renamed-by-batch", formerlySynced: MARKER });

    const merged = mergeServerConfigFields(prior, batchSnapshot, current);

    // A merge that does not know about the field always takes prior's value,
    // leaving this undefined — the user removed the source with "Keep
    // Servers", the marker was written, and a rollback for an unrelated
    // rejected write quietly erased it. The server can never be adopted
    // again, and nothing reports it.
    expect(merged.formerlySynced).toEqual(MARKER);
    // The marker is COPIED, not aliased — the merge hands back a detached
    // record, matching how `origin` and `proxy` are treated.
    expect(merged.formerlySynced).not.toBe(current.formerlySynced);
    // ...while the rejected batch's own field still falls back to prior.
    expect(merged.name).toBe("core-sw");
  });

  it("keeps the CLEARED marker when a concurrent adoption consumed it, instead of restoring prior's (kills the same blind spot in the other direction)", () => {
    // The mirror case: the record had a marker, and a sync adopted it while
    // this batch's write was in flight — adoption trades the marker for real
    // ownership. Restoring prior's marker would leave a record carrying BOTH
    // an origin and a stale marker.
    const adoptedOrigin = { sourceId: "netbox-2", externalId: "device:42", syncedAt: 5000 };
    const prior = server({ formerlySynced: MARKER });
    const batchSnapshot = server({ name: "renamed-by-batch", formerlySynced: MARKER });
    const current = server({ name: "renamed-by-batch", origin: adoptedOrigin });

    const merged = mergeServerConfigFields(prior, batchSnapshot, current);

    expect(merged.formerlySynced).toBeUndefined();
    // The concurrent adoption's ownership is kept too (the existing `origin`
    // rule), so the merged record is coherent rather than half-adopted.
    expect(merged.origin).toEqual(adoptedOrigin);
    expect(merged.name).toBe("core-sw");
  });

  it("rolls the batch's OWN marker write back to prior when nothing concurrent touched it (the merge's default half, asserted so the fix above can't be mistaken for 'always keep current')", () => {
    // batchSnapshot === current for the marker: no concurrent write happened,
    // so this batch's rejected stamp must be discarded like every other field
    // it wrote. Paired with the two tests above, this pins the merge to
    // "concurrent change wins, rejected batch write loses" rather than to
    // either blanket rule.
    const prior = server();
    const batchSnapshot = server({ name: "renamed-by-batch", formerlySynced: MARKER });
    const current = server({ name: "renamed-by-batch", formerlySynced: { ...MARKER } });

    const merged = mergeServerConfigFields(prior, batchSnapshot, current);

    expect(merged.formerlySynced).toBeUndefined();
    expect(merged.name).toBe("core-sw");
  });
});
