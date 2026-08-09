import { describe, expect, it } from "vitest";
import { deviceTemplateFormDefinition, serverFormDefinition } from "../../src/ui/formDefinitions";
import { TEMPLATE_FIELD_SHORT_LABELS, templateAppliedFields } from "../../src/services/inventory/templateApply";
import type { FormDefinition, FormFieldDescriptor } from "../../src/ui/formTypes";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import type { AuthProfile, ProxyConfig, ServerConfig } from "../../src/models/config";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1b, §7.1) — the tri-state editor + the two
 * builder parameter extensions (proxyFields `advanced` override, and
 * authProfileSelectField `key`/`autofill`), tested against the existing form
 * framework. The wrong implementation each guard names is in its title.
 */

function field(def: FormDefinition, key: string): FormFieldDescriptor | undefined {
  return def.fields.find((f) => "key" in f && f.key === key);
}

const P: ProxyConfig = { type: "socks5", host: "10.0.0.9", port: 1080 };

describe("deviceTemplateFormDefinition — tri-state wiring (§7.1)", () => {
  it("each field's value control is gated on its companion mode select (fill|override)", () => {
    const def = deviceTemplateFormDefinition();
    // The proxy control block is gated on mode_proxy.
    expect(field(def, "proxyType")?.visibleWhen).toEqual({ field: "mode_proxy", value: ["fill", "override"] });
    expect(field(def, "authProfileId")?.visibleWhen).toEqual({ field: "mode_authProfileId", value: ["fill", "override"] });
    expect(field(def, "multiplexing")?.visibleWhen).toEqual({ field: "mode_multiplexing", value: ["fill", "override"] });
    expect(field(def, "legacyAlgorithms")?.visibleWhen).toEqual({ field: "mode_legacyAlgorithms", value: ["fill", "override"] });
    expect(field(def, "logSession")?.visibleWhen).toEqual({ field: "mode_logSession", value: ["fill", "override"] });
  });

  it("each mode select offers the three verbatim options and defaults to Not set", () => {
    const def = deviceTemplateFormDefinition();
    const mode = field(def, "mode_proxy") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(mode.value).toBe("none");
    expect(mode.options).toEqual([
      { label: "Not set", value: "none" },
      { label: "Fill — only where nothing is set", value: "fill" },
      { label: "Override — replace source and sync values", value: "override" }
    ]);
    // Shared hint (verbatim) on a value-field mode select.
    expect(mode.hint).toBe(
      "Fill writes this value only where the field isn't configured yet. Override also replaces values the source or an earlier sync supplied. Neither mode ever changes a value you set yourself — your own edits always win."
    );
    // Auth-field mode select carries the auth-specific hint (verbatim).
    const authMode = field(def, "mode_authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(authMode.hint).toBe(
      "Fill links this profile only on servers whose SSH login was never configured by hand. Override also moves servers a sync previously linked — but never a link you chose yourself."
    );
  });

  it("carries the editor intro block with the three invariants, and an override pre-emption line gated on override", () => {
    const def = deviceTemplateFormDefinition();
    const intro = def.fields.find((f) => f.type === "html" && f.content.includes("A device template applies these settings to servers synced from inventory"));
    expect(intro).toBeDefined();
    expect((intro as Extract<FormFieldDescriptor, { type: "html" }>).content).toContain("your own edits win");
    expect((intro as Extract<FormFieldDescriptor, { type: "html" }>).content).toContain("clearing a template-applied value opts that server out");
    expect((intro as Extract<FormFieldDescriptor, { type: "html" }>).content).toContain("changes apply on each source's next sync");

    const preemption = def.fields.find(
      (f) => f.type === "html" && f.content.includes("count as hand-configured and are kept") && f.visibleWhen !== undefined
    ) as Extract<FormFieldDescriptor, { type: "html" }> | undefined;
    expect(preemption).toBeDefined();
    expect(preemption!.visibleWhen).toEqual({ field: "mode_proxy", value: "override" });
  });

  it("seeds mode selects and value controls from an existing template on Edit", () => {
    const seed: DeviceTemplateProfile = {
      id: "t1",
      name: "Branch defaults",
      fields: {
        proxy: { mode: "override", value: P },
        authProfileId: { mode: "fill", value: "prof-1" },
        multiplexing: { mode: "override", value: false }
      }
    };
    const def = deviceTemplateFormDefinition(seed, [], [{ id: "prof-1", name: "P1", username: "u", authType: "agent" } as AuthProfile]);
    expect(def.title).toBe("Edit Device Template");
    expect((field(def, "name") as Extract<FormFieldDescriptor, { type: "text" }>).value).toBe("Branch defaults");
    expect((field(def, "mode_proxy") as Extract<FormFieldDescriptor, { type: "select" }>).value).toBe("override");
    expect((field(def, "mode_authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>).value).toBe("fill");
    expect((field(def, "authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>).value).toBe("prof-1");
    expect((field(def, "mode_multiplexing") as Extract<FormFieldDescriptor, { type: "select" }>).value).toBe("override");
    expect((field(def, "multiplexing") as Extract<FormFieldDescriptor, { type: "checkbox" }>).value).toBe(false);
    // A field the template says nothing about defaults to "none".
    expect((field(def, "mode_logSession") as Extract<FormFieldDescriptor, { type: "select" }>).value).toBe("none");
  });
});

describe("builder parameter extensions (UX-M4/m13)", () => {
  it("proxyFields `advanced` override: the template editor's proxy controls are NOT advanced; the server form's ARE (default preserved)", () => {
    const editor = deviceTemplateFormDefinition();
    expect(field(editor, "proxyType")?.advanced).toBe(false);
    expect(field(editor, "proxyJumpHostId")?.advanced).toBe(false);

    const server = serverFormDefinition({ id: "s1", name: "s", host: "h", port: 22, username: "u", authType: "agent" });
    expect(field(server, "proxyType")?.advanced).toBe(true);
  });

  it("authProfileSelectField `autofill` override: the editor's auth select has autofill OFF and no lock/mirror seeds; the server form's has it ON", () => {
    const editor = deviceTemplateFormDefinition();
    const editorAuth = field(editor, "authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(editorAuth.key).toBe("authProfileId"); // the `key` option resolves to the template's own field key
    expect(editorAuth.autofill).toBe(false);
    expect(editorAuth.autofillFilledKeys).toBeUndefined();
    expect(editorAuth.autofillDisplacedValues).toBeUndefined();
    expect(editorAuth.advanced).toBe(false);

    const server = serverFormDefinition({ id: "s1", name: "s", host: "h", port: 22, username: "u", authType: "agent" });
    const serverAuth = field(server, "authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(serverAuth.autofill).toBe(true);
  });

  it("P2 — the editor's auth select SUPPRESSES the dead 'Create new auth profile…' option; the server form keeps it", () => {
    const editor = deviceTemplateFormDefinition();
    const editorAuth = field(editor, "authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(editorAuth.options.some((o) => o.value === "__create__authProfile")).toBe(false);

    const server = serverFormDefinition({ id: "s1", name: "s", host: "h", port: 22, username: "u", authType: "agent" });
    const serverAuth = field(server, "authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(serverAuth.options.some((o) => o.value === "__create__authProfile")).toBe(true);
  });

  it("P8 — the auth-select hint drops the rung-3 'matching' cascade leak", () => {
    const editor = deviceTemplateFormDefinition();
    const editorAuth = field(editor, "authProfileId") as Extract<FormFieldDescriptor, { type: "select" }>;
    expect(editorAuth.hint).not.toContain("matching servers");
    expect(editorAuth.hint).toContain("the servers it applies to");
  });

  it("Fix C (PR #62 Codex round 2) — proxyFields `includePasswords: false`: the template editor OMITS both proxy-password inputs; the server form keeps them", () => {
    // The template editor renders proxy controls but NOT the two password fields:
    // `parseDeviceTemplateFormValues` calls only `formValuesToProxy`, which
    // discards proxy passwords (§5.3 — templates carry no secrets), so a rendered
    // password input would silently throw away whatever the user typed. Against
    // 5cdc83e the shared `proxyFields` always emitted both, so both finds are
    // defined and this test fails on the two `toBeUndefined` assertions.
    const editor = deviceTemplateFormDefinition();
    expect(field(editor, "proxySocks5Password")).toBeUndefined();
    expect(field(editor, "proxyHttpPassword")).toBeUndefined();
    // The proxy host/username controls are still there — only the password
    // controls are dropped, so the proxy is still fully templatable.
    expect(field(editor, "proxySocks5Host")).toBeDefined();
    expect(field(editor, "proxySocks5Username")).toBeDefined();
    // The omitted password is replaced by a per-server hint on the username field.
    const socks5User = field(editor, "proxySocks5Username") as Extract<FormFieldDescriptor, { type: "text" }>;
    expect(socks5User.hint).toContain("Proxy passwords aren't stored in templates");

    // The server form is untouched: both password controls remain.
    const server = serverFormDefinition({ id: "s1", name: "s", host: "h", port: 22, username: "u", authType: "agent" });
    expect(field(server, "proxySocks5Password")).toBeDefined();
    expect(field(server, "proxyHttpPassword")).toBeDefined();
  });
});

describe("shared short-label map (§7.3/§7.4)", () => {
  it("spells every templatable field one way, and the tooltip helper reads from that same map", () => {
    expect(TEMPLATE_FIELD_SHORT_LABELS).toEqual({
      proxy: "Proxy",
      authProfileId: "Auth Profile",
      multiplexing: "Multiplexing",
      legacyAlgorithms: "Legacy Algorithms",
      logSession: "Session Logging"
    });
    // templateAppliedFields returns the fields still carrying a template value,
    // and the tooltip renders them through the SAME map (proved by the labels).
    const server: ServerConfig = {
      id: "s",
      name: "n",
      host: "h",
      port: 22,
      username: "u",
      authType: "agent",
      proxy: P,
      multiplexing: true,
      origin: { sourceId: "src", externalId: "d", templated: { proxy: P, multiplexing: true } }
    };
    const applied = templateAppliedFields(server);
    expect(applied).toEqual(["proxy", "multiplexing"]);
    expect(applied.map((f) => TEMPLATE_FIELD_SHORT_LABELS[f])).toEqual(["Proxy", "Multiplexing"]);
  });

  it("a hand-edited field (cur != stamp) drops out of the applied set (the 'your edits override' signal)", () => {
    const server: ServerConfig = {
      id: "s",
      name: "n",
      host: "h",
      port: 22,
      username: "u",
      authType: "agent",
      proxy: { type: "socks5", host: "changed", port: 1 }, // hand-edited away from the stamp
      origin: { sourceId: "src", externalId: "d", templated: { proxy: P } }
    };
    expect(templateAppliedFields(server)).toEqual([]);
  });
});
