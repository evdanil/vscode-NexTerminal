import { describe, expect, it } from "vitest";
import {
  inventorySourceFormDefinition,
  deviceTemplateSelectRepresentable,
  resolveSubmittedTemplateRules,
  DEVICE_TEMPLATE_CREATE_SENTINEL
} from "../../src/ui/formDefinitions";
import type { FormDefinition, FormFieldDescriptor, FormValues } from "../../src/ui/formTypes";
import type { InventoryProvider, InventorySourceConfig, TemplateRule } from "../../src/models/inventory";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1b, §7.2) — the source form's single "Device
 * Template" select and its non-representable-rule-set fallback (UX-M3). Fixtures
 * 27 & 28 of §10, each built to FAIL against the specific wrong guard it names.
 */

const provider: InventoryProvider = {
  id: "netbox",
  label: "NetBox",
  configFields: [],
  testConnection: async () => undefined,
  fetchInventory: async () => ({ contractVersion: 1, devices: [] })
};

const TEMPLATES: DeviceTemplateProfile[] = [
  { id: "tpl-A", name: "Switch defaults", fields: {} },
  { id: "tpl-B", name: "Core auth", fields: {} }
];

function source(rules?: TemplateRule[]): InventorySourceConfig {
  return {
    id: "src-1",
    providerId: "netbox",
    name: "NetBox prod",
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: {},
    secretFieldIds: [],
    templateRules: rules
  };
}

function field(def: FormDefinition, key: string): FormFieldDescriptor | undefined {
  return def.fields.find((f) => "key" in f && f.key === key);
}

/** A "full submit" of the form: every keyed control's value. An html field
 *  contributes NO key, exactly as the webview's submit loop skips it. */
function fullSubmit(def: FormDefinition): FormValues {
  const values: FormValues = {};
  for (const f of def.fields) {
    if (!("key" in f)) {
      continue;
    }
    if (f.type === "checkbox") {
      values[f.key] = f.value ?? false;
    } else if (f.type === "select") {
      values[f.key] = f.value ?? f.options[0]?.value ?? "";
    } else if ("value" in f) {
      values[f.key] = (f.value as string | number | undefined) ?? "";
    } else {
      values[f.key] = "";
    }
  }
  return values;
}

describe("device template source form — selectRepresentable guard (§7.2)", () => {
  it("is representable for zero rules and for exactly one catch-all rule", () => {
    expect(deviceTemplateSelectRepresentable(undefined)).toBe(true);
    expect(deviceTemplateSelectRepresentable([])).toBe(true);
    expect(deviceTemplateSelectRepresentable([{ id: "r1", templateId: "tpl-A" }])).toBe(true);
    expect(deviceTemplateSelectRepresentable([{ id: "r1", filter: "", templateId: "tpl-A" }])).toBe(true);
    expect(deviceTemplateSelectRepresentable([{ id: "r1", filter: "   ", templateId: "tpl-A" }])).toBe(true);
  });

  it("is NOT representable for a filtered rule (even a syntactic name=* glob) or >1 rule", () => {
    // SYNTACTIC, not parse-based: name=* parses to zero conditions but is a
    // non-empty string, so it takes the fallback.
    expect(deviceTemplateSelectRepresentable([{ id: "r1", filter: "name=*", templateId: "tpl-A" }])).toBe(false);
    expect(deviceTemplateSelectRepresentable([{ id: "r1", filter: "role=switch", templateId: "tpl-A" }])).toBe(false);
    expect(
      deviceTemplateSelectRepresentable([
        { id: "r1", templateId: "tpl-A" },
        { id: "r2", templateId: "tpl-B" }
      ])
    ).toBe(false);
  });
});

describe("fixture 27 — a lone FILTERED rule is not editable through the select", () => {
  it("renders the read-only fallback, hides the select, and a full submit leaves templateRules byte-identical", () => {
    const rules: TemplateRule[] = [{ id: "r1", filter: "role=switch", templateId: "tpl-A" }];
    const def = inventorySourceFormDefinition(provider, source(rules), undefined, [], TEMPLATES);

    // The select must be ABSENT (replaced by the read-only fallback line).
    expect(field(def, "deviceTemplateId")).toBeUndefined();
    const fallback = def.fields.find((f) => f.type === "html" && f.content.includes("A filtered template rule is configured for this source"));
    expect(fallback).toBeDefined();

    // A full submit of that form carries NO deviceTemplateId key, so the rules
    // are left untouched — the SURVIVING filter is the assertion (the count is 1
    // either way, so a count-only assertion is vacuous against exactly this bug).
    const submitted = fullSubmit(def);
    expect("deviceTemplateId" in submitted).toBe(false);
    const next = resolveSubmittedTemplateRules(submitted, rules);
    expect(next).toBeUndefined(); // undefined = keep existing, byte-identical
    // And the record that would be persisted keeps the filter verbatim.
    const persisted = next ?? rules;
    expect(persisted).toEqual([{ id: "r1", filter: "role=switch", templateId: "tpl-A" }]);
    expect(persisted[0].filter).toBe("role=switch");
  });
});

describe("fixture 28 — representable shapes round-trip", () => {
  it("zero rules → select shown; choosing T writes one catch-all rule", () => {
    const def = inventorySourceFormDefinition(provider, source([]), undefined, [], TEMPLATES);
    const select = field(def, "deviceTemplateId");
    expect(select?.type).toBe("select");

    const next = resolveSubmittedTemplateRules({ deviceTemplateId: "tpl-A" }, []);
    expect(next).toHaveLength(1);
    expect(next![0].templateId).toBe("tpl-A");
    expect(next![0].filter).toBeUndefined(); // catch-all
  });

  it("one catch-all rule → select shown pre-selected; clearing removes the rule", () => {
    const rules: TemplateRule[] = [{ id: "r1", templateId: "tpl-B" }];
    const def = inventorySourceFormDefinition(provider, source(rules), undefined, [], TEMPLATES);
    const select = field(def, "deviceTemplateId");
    expect(select?.type).toBe("select");
    expect((select as Extract<FormFieldDescriptor, { type: "select" }>).value).toBe("tpl-B");

    // Clearing (None) removes the catch-all rule.
    expect(resolveSubmittedTemplateRules({ deviceTemplateId: "" }, rules)).toEqual([]);
    // Reusing the same rule id when re-choosing a template (no id churn).
    const rechosen = resolveSubmittedTemplateRules({ deviceTemplateId: "tpl-A" }, rules);
    expect(rechosen).toEqual([{ id: "r1", templateId: "tpl-A" }]);
  });

  it("filter:\"\" / whitespace → treated as catch-all, select shown pre-selected", () => {
    const def = inventorySourceFormDefinition(provider, source([{ id: "r1", filter: "  ", templateId: "tpl-A" }]), undefined, [], TEMPLATES);
    const select = field(def, "deviceTemplateId");
    expect(select?.type).toBe("select");
    expect((select as Extract<FormFieldDescriptor, { type: "select" }>).value).toBe("tpl-A");
  });

  it("a name=* rule → fallback (syntactic guard), and two rules → fallback with plural copy", () => {
    const glob = inventorySourceFormDefinition(provider, source([{ id: "r1", filter: "name=*", templateId: "tpl-A" }]), undefined, [], TEMPLATES);
    expect(field(glob, "deviceTemplateId")).toBeUndefined();

    const two = inventorySourceFormDefinition(
      provider,
      source([
        { id: "r1", templateId: "tpl-A" },
        { id: "r2", templateId: "tpl-B" }
      ]),
      undefined,
      [],
      TEMPLATES
    );
    expect(field(two, "deviceTemplateId")).toBeUndefined();
    const plural = two.fields.find((f) => f.type === "html" && f.content.includes("2 template rules are configured for this source"));
    expect(plural).toBeDefined();
  });

  it("the create sentinel is never persisted as a real selection", () => {
    expect(resolveSubmittedTemplateRules({ deviceTemplateId: DEVICE_TEMPLATE_CREATE_SENTINEL }, [])).toBeUndefined();
  });
});
