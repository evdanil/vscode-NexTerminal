import { describe, expect, it } from "vitest";
import {
  deviceMatchesFilter,
  describeFilterConditions,
  filterSpecificity,
  parseTemplateFilter,
  unknownFilterKeys
} from "../../src/services/inventory/templateApply";
import type { InventoryDevice } from "../../src/models/inventory";

/**
 * DEVICE TEMPLATES (issue #48 PR-T2) — the pure matcher: parse (§2.3), specificity
 * (§3.1), and `deviceMatchesFilter` (§2.3). Fixture 20c's parse cases plus the
 * name-glob / set-valued / case-folding semantics, each built to fail against the
 * specific wrong implementation its comment names.
 */

function dev(overrides: Partial<InventoryDevice> = {}): InventoryDevice {
  return { externalId: "device:1", name: "core-sw-1", endpoints: [], ...overrides };
}

describe("parseTemplateFilter / filterSpecificity — §2.3 / §3.1 (fixture 20c)", () => {
  it("20c(a) — keys are case-folded, so `Role=switch&role=router` is ONE key with two OR values, specificity 1 (kills case-sensitive key handling)", () => {
    const parsed = parseTemplateFilter("Role=switch&role=router");
    expect([...parsed.conditions.keys()]).toEqual(["role"]);
    expect([...parsed.conditions.get("role")!].sort()).toEqual(["router", "switch"]);
    expect(parsed.specificity).toBe(1);
  });

  it("20c(b) — a filter of only `name=*` is zero conditions: catch-all at specificity 0 (kills a free rank boost from a match-everything glob)", () => {
    const parsed = parseTemplateFilter("name=*");
    expect(parsed.specificity).toBe(0);
    // ...but it still MATCHES every device (candidacy via deviceMatchesFilter).
    expect(deviceMatchesFilter(dev({ name: "anything" }), parsed)).toBe(true);
  });

  it("20c(b') — `name=*` combined with a real key keeps specificity from the real key only", () => {
    expect(filterSpecificity("name=*&role=switch")).toBe(1);
  });

  it("20c(c) — an empty value (`role=`) is surfaced in emptyValueKeys for the save layer, and can never match (kills storable dead conditions)", () => {
    const parsed = parseTemplateFilter("role=");
    expect(parsed.emptyValueKeys).toEqual(["role"]);
    expect(deviceMatchesFilter(dev({ attributes: { role: ["switch"] } }), parsed)).toBe(false);
  });

  it("20c(d) — filter key `tag` is aliased to the `tags` attribute (kills the tag/tags key mismatch, m10)", () => {
    const parsed = parseTemplateFilter("tag=core");
    expect([...parsed.conditions.keys()]).toEqual(["tags"]);
    expect(deviceMatchesFilter(dev({ attributes: { tags: ["core", "prod"] } }), parsed)).toBe(true);
  });

  it("distinct-key counting: `role=switch&role=router` is 1, `site=syd&tag=x` is 2 (kills counting conditions)", () => {
    expect(filterSpecificity("role=switch&role=router")).toBe(1);
    expect(filterSpecificity("site=syd&tag=x")).toBe(2);
  });

  it("catch-all (absent/empty/whitespace) is specificity 0 and matches everything", () => {
    for (const f of [undefined, "", "   "]) {
      const parsed = parseTemplateFilter(f);
      expect(parsed.specificity).toBe(0);
      expect(deviceMatchesFilter(dev(), parsed)).toBe(true);
    }
  });
});

describe("deviceMatchesFilter — §2.3 semantics", () => {
  it("set-valued attribute matches if ANY element matches — name OR slug (kills single-vocabulary matching)", () => {
    const d = dev({ attributes: { site: ["Sydney", "syd"] } });
    expect(deviceMatchesFilter(d, parseTemplateFilter("site=syd"))).toBe(true); // slug
    expect(deviceMatchesFilter(d, parseTemplateFilter("site=Sydney"))).toBe(true); // display name
    expect(deviceMatchesFilter(d, parseTemplateFilter("site=melbourne"))).toBe(false);
  });

  it("value comparison is case-insensitive and trimmed", () => {
    const d = dev({ attributes: { role: ["Switch"] } });
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=SWITCH"))).toBe(true);
  });

  it("AND across distinct keys, OR within a key", () => {
    const d = dev({ attributes: { role: ["switch"], site: ["syd"] } });
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=switch&site=syd"))).toBe(true);
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=switch&site=mel"))).toBe(false); // AND fails
    expect(deviceMatchesFilter(d, parseTemplateFilter("role=router&role=switch"))).toBe(true); // OR
  });

  it("a key the device has no attribute for fails the condition (the rule does not match)", () => {
    expect(deviceMatchesFilter(dev({ attributes: { role: ["switch"] } }), parseTemplateFilter("tenant=acme"))).toBe(false);
  });

  it("the reserved `name` key globs device.name — a `*` glob, anchored, no user regex", () => {
    expect(deviceMatchesFilter(dev({ name: "core-sw-1" }), parseTemplateFilter("name=core-*"))).toBe(true);
    expect(deviceMatchesFilter(dev({ name: "edge-sw-1" }), parseTemplateFilter("name=core-*"))).toBe(false);
    // A regex metacharacter in the glob is literal, never a pattern.
    expect(deviceMatchesFilter(dev({ name: "coreXsw" }), parseTemplateFilter("name=core.sw"))).toBe(false);
    expect(deviceMatchesFilter(dev({ name: "core.sw" }), parseTemplateFilter("name=core.sw"))).toBe(true);
  });
});

describe("describeFilterConditions / unknownFilterKeys — §7.2 live feedback", () => {
  it("describes conditions as 'key is v [or v] AND key is v'", () => {
    expect(describeFilterConditions(parseTemplateFilter("role=switch&site=syd"))).toBe("role is 'switch' AND site is 'syd'");
    expect(describeFilterConditions(parseTemplateFilter("role=switch&role=router"))).toBe("role is 'router' or 'switch'");
  });

  it("unknownFilterKeys flags keys outside the declared list; `name` and the `tag`→`tags` alias are always known; no list ⇒ no unknowns", () => {
    const keys = ["role", "site", "tag", "name"];
    expect(unknownFilterKeys(parseTemplateFilter("sites=syd"), keys)).toEqual(["sites"]);
    expect(unknownFilterKeys(parseTemplateFilter("tag=core&name=x"), keys)).toEqual([]);
    expect(unknownFilterKeys(parseTemplateFilter("role=switch"), keys)).toEqual([]);
    expect(unknownFilterKeys(parseTemplateFilter("whatever=1"), undefined)).toEqual([]);
  });
});
