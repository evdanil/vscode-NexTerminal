import { describe, expect, it } from "vitest";
import {
  buildRuleListItems,
  filterFeedback,
  saveOverlapWarnings,
  templateSetsLabels
} from "../../src/services/inventory/templateRulesView";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import type { ProxyConfig } from "../../src/models/config";
import type { TemplateRule } from "../../src/models/inventory";

/**
 * DEVICE TEMPLATES (issue #48 PR-T2, §7.2) — the "Edit Template Rules…" QuickPick
 * flow's pure view/validation logic: three-slot list rows, the implicit floor row,
 * live filter feedback severities, and the save-time possible-overlap warnings
 * (fixture 20d). Each built to fail against the specific wrong implementation.
 */

const P_A: ProxyConfig = { type: "socks5", host: "10.9.9.1", port: 1080 };
const P_B: ProxyConfig = { type: "socks5", host: "10.9.9.2", port: 1080 };

function template(fields: DeviceTemplateProfile["fields"], id = "t1", name = "T"): DeviceTemplateProfile {
  return { id, name, fields };
}
function rule(templateId: string, filter: string | undefined, id: string): TemplateRule {
  return { id, templateId, filter };
}
const NETBOX_KEYS = ["role", "site", "location", "rack", "tenant", "status", "platform", "tag", "name"];

describe("buildRuleListItems — three-slot rows + implicit floor (§7.2 UX-S1/S4)", () => {
  it("renders three-slot rows sorted by specificity descending, filter / → template / Specificity + Sets", () => {
    const tById = new Map([
      ["t-broad", template({ proxy: { mode: "override", value: P_A } }, "t-broad", "Broad")],
      ["t-narrow", template({ authProfileId: { mode: "override", value: "A" }, proxy: { mode: "fill", value: P_B } }, "t-narrow", "Narrow")]
    ]);
    const rules = [rule("t-broad", "role=switch", "r1"), rule("t-narrow", "role=switch&site=syd", "r2")];
    const items = buildRuleListItems({ authProfileId: undefined }, rules, tById, () => undefined);
    expect(items.map((i) => i.label)).toEqual(["role=switch&site=syd", "role=switch"]); // spec 2 before spec 1
    expect(items[0].description).toBe("→ Narrow");
    expect(items[0].detail).toBe("Specificity 2  •  Sets: Auth Profile, Proxy");
    expect(items[1].detail).toBe("Specificity 1  •  Sets: Proxy");
    expect(items.every((i) => i.floor !== true)).toBe(true);
  });

  it("a catch-all rule reads '(all devices)'; a dangling template reads '(missing template)' but still lists (removable)", () => {
    const tById = new Map<string, DeviceTemplateProfile>();
    const items = buildRuleListItems({ authProfileId: undefined }, [rule("gone", undefined, "r1")], tById, () => undefined);
    expect(items[0].label).toBe("(all devices)");
    expect(items[0].description).toBe("→ (missing template)");
    expect(items[0].ruleId).toBe("r1");
  });

  it("UX-S4 — when the source has an auth profile, the last row is the actionable floor row routing to editSource (floor:true, no ruleId)", () => {
    const items = buildRuleListItems({ authProfileId: "A" }, [], new Map(), (id) => (id === "A" ? "Datacenter root" : undefined));
    const floor = items[items.length - 1];
    expect(floor.floor).toBe(true);
    expect(floor.ruleId).toBeUndefined();
    expect(floor.label).toBe("(all devices — source default)");
    expect(floor.description).toBe('→ auth profile "Datacenter root"');
    expect(floor.detail).toBe("Fill • Overridden by any rule that sets Auth Profile");
  });

  it("no floor row when the source carries no auth profile", () => {
    const items = buildRuleListItems({ authProfileId: undefined }, [], new Map(), () => undefined);
    expect(items).toHaveLength(0);
  });
});

describe("templateSetsLabels", () => {
  it("lists the set fields by short label, alphabetically", () => {
    expect(templateSetsLabels(template({ proxy: { mode: "fill", value: P_A }, authProfileId: { mode: "fill", value: "A" } }))).toEqual([
      "Auth Profile",
      "Proxy"
    ]);
    expect(templateSetsLabels(template({}))).toEqual([]);
  });
});

describe("filterFeedback — live InputBox severities (§7.2 UX-S2)", () => {
  it("valid filter → Info with the describe + specificity", () => {
    const fb = filterFeedback("role=switch&site=syd", NETBOX_KEYS);
    expect(fb.severity).toBe("info");
    expect(fb.blocking).toBe(false);
    expect(fb.message).toBe("Matches devices where role is 'switch' AND site is 'syd' — specificity 2");
  });

  it("empty value (role=) → BLOCKING warning (§2.3)", () => {
    const fb = filterFeedback("role=", NETBOX_KEYS);
    expect(fb.severity).toBe("warning");
    expect(fb.blocking).toBe(true);
  });

  it("unknown key → non-blocking warning naming the key and the known list (§2.2 verbatim)", () => {
    const fb = filterFeedback("sites=syd", NETBOX_KEYS);
    expect(fb.severity).toBe("warning");
    expect(fb.blocking).toBe(false);
    expect(fb.message).toContain("Key 'sites' is not one this source's provider reports");
    expect(fb.message).toContain("Known keys: role, site");
  });

  it("bare name=* → Info zero-specificity note (§2.3 m9b)", () => {
    const fb = filterFeedback("name=*", NETBOX_KEYS);
    expect(fb.severity).toBe("info");
    expect(fb.message).toBe("`name=*` matches every device — it adds no specificity.");
  });

  it("empty filter → Info catch-all", () => {
    expect(filterFeedback("", NETBOX_KEYS).message).toBe("Matches every device (catch-all).");
  });

  it("no declared attributeKeys ⇒ no unknown-key warning", () => {
    expect(filterFeedback("whatever=1", undefined).severity).toBe("info");
  });
});

describe("saveOverlapWarnings — possible overlap, no disjointness proof (fixture 20d)", () => {
  const proxyA = template({ proxy: { mode: "override", value: P_A } }, "ta", "A");
  const proxyB = template({ proxy: { mode: "override", value: P_B } }, "tb", "B");
  const tById = new Map([["ta", proxyA], ["tb", proxyB]]);

  it("20d(a) — role=switch vs role=server (differing proxy) WARNS — the proof's own motivating example (kills the withdrawn disjointness proof)", () => {
    const w = saveOverlapWarnings([rule("ta", "role=switch", "r1"), rule("tb", "role=server", "r2")], tById);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("`role=switch`");
    expect(w[0]).toContain("`role=server`");
    expect(w[0]).toContain("both set Proxy");
    // The copy is CONDITIONAL — it never asserts overlap.
    expect(w[0]).toContain("If a device matches both");
  });

  it("20d(b) — site=Sydney vs site=syd WARNS (the pair that makes the proof unsound — same devices, non-intersecting literals)", () => {
    const w = saveOverlapWarnings([rule("ta", "site=Sydney", "r1"), rule("tb", "site=syd", "r2")], tById);
    expect(w).toHaveLength(1);
  });

  it("20d(c) — role=switch vs site=syd WARNS", () => {
    const w = saveOverlapWarnings([rule("ta", "role=switch", "r1"), rule("tb", "site=syd", "r2")], tById);
    expect(w).toHaveLength(1);
  });

  it("20d(d) — identical {mode,value} on every shared field → NO warning (the one sound suppression)", () => {
    const same = new Map([["ta", proxyA], ["tb2", template({ proxy: { mode: "override", value: P_A } }, "tb2", "B")]]);
    const w = saveOverlapWarnings([rule("ta", "role=switch", "r1"), rule("tb2", "site=syd", "r2")], same);
    expect(w).toHaveLength(0);
  });

  it("20d(e) — unequal specificity OR no shared field → NO warning", () => {
    // unequal specificity
    expect(saveOverlapWarnings([rule("ta", "role=switch", "r1"), rule("tb", "role=switch&site=syd", "r2")], tById)).toHaveLength(0);
    // no shared field
    const auth = template({ authProfileId: { mode: "override", value: "A" } }, "tauth", "Auth");
    const m = new Map([["ta", proxyA], ["tauth", auth]]);
    expect(saveOverlapWarnings([rule("ta", "role=switch", "r1"), rule("tauth", "site=syd", "r2")], m)).toHaveLength(0);
  });
});
