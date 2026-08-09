import { describe, expect, it } from "vitest";
import { isValidDetachedServerOrigin, validateServerConfig } from "../../src/utils/validation";
import type { ServerConfig } from "../../src/models/config";

/**
 * ADOPT 1 — the shape guard for `ServerConfig.formerlySynced`, the receipt
 * "Keep Servers" leaves behind.
 *
 * WHY EVERY MEMBER IS PINNED SEPARATELY: this guard is the only thing between a
 * hand-edited backup (or a version-skewed globalState row) and the sync engine's
 * adoption rule, which hands an existing record's whole lifecycle — name,
 * address, folder, and the source's prune policy, `delete` included — to a
 * source. A guard that checked only `externalId` would let a marker with no
 * `providerId` decide an adoption with nothing scoping it to the right kind of
 * source; each case below is one such half-checked marker.
 */
describe("isValidDetachedServerOrigin", () => {
  const valid = {
    sourceId: "src-1",
    sourceName: "NetBox",
    providerId: "netbox",
    externalId: "device:1",
    detachedAt: 1700000000000
  };

  it("accepts a fully-populated marker", () => {
    expect(isValidDetachedServerOrigin(valid)).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isValidDetachedServerOrigin(null)).toBe(false);
    expect(isValidDetachedServerOrigin(undefined)).toBe(false);
    expect(isValidDetachedServerOrigin("device:1")).toBe(false);
    expect(isValidDetachedServerOrigin(42)).toBe(false);
  });

  // The engine's only writer stamps all five unconditionally, so an absent
  // member cannot have come from this extension. Optionality anywhere here
  // (`isOptionalNonEmptyString`, say) would let a partially-trusted marker
  // through — killed one member at a time.
  it.each(["sourceId", "sourceName", "providerId", "externalId", "detachedAt"])("rejects a marker missing %s", (member) => {
    const { [member]: _dropped, ...rest } = valid as Record<string, unknown>;
    expect(isValidDetachedServerOrigin(rest)).toBe(false);
  });

  // A bare `typeof === "string"` check would accept these. Empty is not a value
  // any writer produces, and an empty `externalId` would match no device while
  // an empty `providerId` would scope the marker to nothing.
  it.each(["sourceId", "sourceName", "providerId", "externalId"])("rejects an EMPTY %s, not just a missing one", (member) => {
    expect(isValidDetachedServerOrigin({ ...valid, [member]: "" })).toBe(false);
  });

  it.each(["sourceId", "sourceName", "providerId", "externalId"])("rejects a non-string %s", (member) => {
    expect(isValidDetachedServerOrigin({ ...valid, [member]: 7 })).toBe(false);
  });

  it("rejects a non-number detachedAt (kills accepting the ISO string a hand-edited backup would carry)", () => {
    expect(isValidDetachedServerOrigin({ ...valid, detachedAt: "2026-08-09T00:00:00Z" })).toBe(false);
  });

  it("accepts unknown extra members — this is a shape check, not a whitelist (kills an over-strict guard that would drop markers written by a newer build)", () => {
    expect(isValidDetachedServerOrigin({ ...valid, somethingNewer: "x" })).toBe(true);
  });

  /**
   * The two OPTIONAL members, and the asymmetry with the five above. Both are
   * copied off the server's own `origin` at detach time, so both are legitimately
   * absent — `instanceKey` when the sync recorded no deployment, and
   * `syncedAuthProfileId` (REVIEW FINDING, P1 — adoption auth provenance) when
   * the removed source had linked no profile, which is the ordinary case.
   *
   * PRESENT, each must be well-formed, because each is CONSUMED rather than
   * merely displayed: `instanceKey` is compared for equality to decide an
   * adoption (two empty strings would read as one deployment), and
   * `syncedAuthProfileId` is restored into a live origin where AUTH 2b and
   * retro-apply's opt-out compare it against a real profile id.
   */
  it.each(["instanceKey", "syncedAuthProfileId"])("accepts a marker WITHOUT %s — absence is a real state, not a malformed one", (member) => {
    expect(isValidDetachedServerOrigin(valid)).toBe(true);
    expect(isValidDetachedServerOrigin({ ...valid, [member]: undefined })).toBe(true);
  });

  it.each(["instanceKey", "syncedAuthProfileId"])("rejects a PRESENT but empty or non-string %s (kills `optional` meaning `unchecked` for a member that decides an adoption or an unlink)", (member) => {
    // Empty specifically, because two empties compare EQUAL to each other —
    // which for `instanceKey` is the exact cross-instance collision the field
    // exists to remove. Whitespace is deliberately not re-checked here, on the
    // same terms as length and control characters: those bound what this
    // extension WRITES (`resolveProviderInstanceKey` trims and rejects blank, and
    // an AuthProfile id is a UUID), and a blank key on one side can never meet a
    // blank key on the other, because no source can ever resolve to one.
    expect(isValidDetachedServerOrigin({ ...valid, [member]: "" })).toBe(false);
    expect(isValidDetachedServerOrigin({ ...valid, [member]: 7 })).toBe(false);
    expect(isValidDetachedServerOrigin({ ...valid, [member]: {} })).toBe(false);
    expect(isValidDetachedServerOrigin({ ...valid, [member]: null })).toBe(false);
  });

  it("accepts both optional members when well-formed (control — the clauses above must not be a blanket rejection)", () => {
    expect(isValidDetachedServerOrigin({ ...valid, instanceKey: "https://netbox.example.com", syncedAuthProfileId: "p1" })).toBe(true);
  });

  it("does not mutate the value it is asked to check", () => {
    const subject = { ...valid };
    const snapshot = JSON.stringify(subject);
    isValidDetachedServerOrigin(subject);
    expect(JSON.stringify(subject)).toBe(snapshot);
  });
});

describe("validateServerConfig — formerlySynced disposition (F13/FIX 5)", () => {
  const server: ServerConfig = {
    id: "s1",
    name: "sw1",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false
  };

  it("accepts a server row carrying a MALFORMED marker — the row survives, the marker is stripped one layer up (kills rejecting the whole record, which would take its group, proxy, jump-host target and sync ownership with it)", () => {
    expect(validateServerConfig({ ...server, formerlySynced: { externalId: 7 } })).toBe(true);
    expect(validateServerConfig({ ...server, formerlySynced: "nonsense" })).toBe(true);
  });

  it("accepts a server row carrying a well-formed marker", () => {
    expect(
      validateServerConfig({
        ...server,
        formerlySynced: { sourceId: "src-1", sourceName: "NetBox", providerId: "netbox", externalId: "device:1", detachedAt: 1 }
      })
    ).toBe(true);
  });

  it("still rejects a row that is broken for a reason validateServerConfig DOES own (control — the marker's leniency must not have widened anything else)", () => {
    expect(validateServerConfig({ ...server, host: "" })).toBe(false);
    expect(validateServerConfig({ ...server, keyPath: 7 })).toBe(false);
  });
});
