import { describe, expect, it } from "vitest";
import type { HighlightCatalog, HighlightProfileSelection } from "../../src/models/highlightProfile";
import {
  encodeHighlightProfileSelection, highlightProfileSelectField, parseHighlightProfileFormValue
} from "../../src/ui/highlightProfileForm";
import {
  serverFormDefinition, serialFormDefinition, localShellFormDefinition, localServerFormDefinition,
  unifiedProfileFormDefinition, type UnifiedProfileAddMode
} from "../../src/ui/formDefinitions";
import type { FormDefinition } from "../../src/ui/formTypes";
import { openForm } from "../helpers/formScriptHarness";

const catalog: HighlightCatalog = {
  profiles: [
    { id: "linux", name: "Linux", rules: [] },
    { id: "__none__", name: "Literal sentinel ID", rules: [] },
    { id: "profile:nested", name: "Prefixed ID", rules: [] }
  ],
  defaultProfileId: "linux", enabled: true, legacy: false
};

function selectionField(definition: FormDefinition) {
  const fields = definition.fields.filter((field) => "key" in field && field.key === "highlightProfileId");
  expect(fields).toHaveLength(1);
  const field = fields[0];
  if (field.type !== "select") throw new Error("Expected highlight select");
  return field;
}

describe("saved highlight profile form values", () => {
  it.each([
    [undefined, ""], [null, "__none__"], ["linux", "profile:linux"],
    ["__none__", "profile:__none__"], ["profile:nested", "profile:profile:nested"]
  ] as Array<[HighlightProfileSelection, string]>)("round-trips %j without sentinel collisions", (selection, encoded) => {
    expect(encodeHighlightProfileSelection(selection)).toBe(encoded);
    expect(parseHighlightProfileFormValue(encoded, "previous")).toBe(selection);
  });

  it("preserves the live value when an older or partial form omits the field", () => {
    expect(parseHighlightProfileFormValue(undefined, "live")).toBe("live");
    expect(parseHighlightProfileFormValue(undefined, null)).toBeNull();
    expect(parseHighlightProfileFormValue(undefined)).toBeUndefined();
    expect(parseHighlightProfileFormValue("", "live")).toBeUndefined();
  });

  it.each([false, 42, "unencoded", "profile:", `profile:${"x".repeat(101)}`])(
    "rejects malformed form selection %j instead of clearing it", (value) => {
      expect(() => parseHighlightProfileFormValue(value, "saved")).toThrow(/highlight profile/i);
    }
  );

  it("shows independent inheritance, none and named choices, retaining a missing ID", () => {
    const field = highlightProfileSelectField(catalog, "deleted");
    expect(field.value).toBe("profile:deleted");
    expect(field.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "", label: "Use global default (Linux)" }),
      expect.objectContaining({ value: "__none__", label: "None" }),
      expect.objectContaining({ value: "profile:linux", label: "Linux" }),
      expect.objectContaining({ value: "profile:deleted", label: expect.stringMatching(/missing.*deleted.*no highlighting/i) })
    ]));
    expect(parseHighlightProfileFormValue(field.value)).toBe("deleted");
  });

  it("distinguishes a None default from a missing default and explains the master switch", () => {
    expect(highlightProfileSelectField({ ...catalog, defaultProfileId: null }).options[0].label).toBe("Use global default (None)");
    const missing = highlightProfileSelectField({ ...catalog, defaultProfileId: "lost" });
    expect(missing.options[0].label).toMatch(/missing.*lost/i);
    expect(missing.hint).toContain("nexus.terminal.highlighting.defaultProfile");
    expect(missing.hint).toContain("Workspace Settings (JSON)");
    expect(missing.hint).not.toContain("Nexus: Edit Highlighting Rules");
    const offHint = highlightProfileSelectField({ ...catalog, enabled: false }).hint ?? "";
    expect(offHint).toContain("current settings");
    expect(offHint).not.toMatch(/off globally/i);
  });

  it("offers the manager when the catalog is valid", () => {
    const hint = highlightProfileSelectField(catalog).hint;
    expect(hint).toContain("Nexus: Edit Highlighting Rules");
  });

  it.each(["Invalid catalog", "The default highlight profile must be a profile ID or null."])(
    "gives actionable settings JSON recovery for %s without advertising the manager", (error) => {
      const hint = highlightProfileSelectField({ ...catalog, validationError: error }).hint;
      expect(hint).toContain("nexus.terminal.highlighting.profiles");
      expect(hint).toContain("nexus.terminal.highlighting.defaultProfile");
      expect(hint).toContain("User Settings (JSON)");
      expect(hint).toContain("Workspace Settings (JSON)");
      expect(hint).toContain("Folder Settings (JSON)");
      expect(hint).not.toContain("Nexus: Edit Highlighting Rules");
    }
  );

});

describe("highlight selection on every saved connection form", () => {
  const factories: Array<[string, (value: HighlightProfileSelection) => FormDefinition]> = [
    ["SSH", (value) => serverFormDefinition({ id: "server", protocol: "ssh", name: "Device", host: "example.test", username: "user", highlightProfileId: value }, [], true, [], [], false, catalog)],
    ["telnet", (value) => serverFormDefinition({ id: "server", protocol: "telnet", name: "Device", host: "example.test", highlightProfileId: value }, [], true, [], [], false, catalog)],
    ["serial", (value) => serialFormDefinition({ id: "serial", name: "Console", path: "COM3", baudRate: 31250, highlightProfileId: value }, [], true, catalog)],
    ["Local Shell", (value) => localShellFormDefinition({ id: "shell", name: "Shell", launchMode: "custom", shellPath: "/bin/sh", highlightProfileId: value }, [], {}, catalog)],
    ["Local Server", (value) => localServerFormDefinition({ id: "local", name: "Server", executable: "node", highlightProfileId: value }, [], catalog)]
  ];

  it.each(factories)("renders one visible selector and preserves missing references for %s", (_name, build) => {
    const field = selectionField(build("deleted"));
    expect(field.value).toBe("profile:deleted");
    expect(field.visibleWhen).toBeUndefined();
    expect(field.options.some((option) => option.value === "profile:linux")).toBe(true);
  });

  it.each(factories)("selects a newly created highlight profile without losing the %s draft", (_name, build) => {
    const form = openForm(build("linux"));
    form.typeFocused("name", "Unsaved draft");
    form.deliver({ type: "highlightProfilesChanged", revision: 1, options: [
      { value: "", label: "Use global default (None)" },
      { value: "__none__", label: "None" },
      { value: "profile:new", label: "New profile" }
    ], hint: "Updated" });
    expect(form.value("name")).toBe("Unsaved draft");
    expect(form.value("highlightProfileId")).toBe("profile:linux");
    form.choose("highlightProfileId", "profile:new");
    expect(form.attemptNativeSubmit()).toMatchObject({ name: "Unsaved draft", highlightProfileId: "profile:new" });
  });

  it.each(factories)("submits explicit None for %s through the rendered script", (_name, build) => {
    const form = openForm(build("linux"));
    form.choose("highlightProfileId", "__none__");
    expect(form.attemptNativeSubmit()).toMatchObject({ highlightProfileId: "__none__" });
  });

  it.each(["profile", "ssh", "serial", "localShell", "localServer"] as UnifiedProfileAddMode[])(
    "keeps the selector shared and visible in unified %s mode", (mode) => {
      const definition = unifiedProfileFormDefinition({ addMode: mode }, [], true, [], [], {}, catalog);
      const field = selectionField(definition);
      expect(field.value).toBe("");
      expect(field.visibleWhen).toBeUndefined();
      expect(field.options.some((option) => option.value === "profile:linux")).toBe(true);
    }
  );

  it("refreshes the unified add form without losing an unsaved name", () => {
    const form = openForm(unifiedProfileFormDefinition({ addMode: "serial" }, [], true, [], [], {}, catalog));
    form.typeFocused("name", "New draft");
    form.deliver({ type: "highlightProfilesChanged", revision: 2, options: [
      { value: "", label: "Use global default (None)" }, { value: "__none__", label: "None" },
      { value: "profile:new", label: "New profile" }
    ], hint: "Updated" });
    form.choose("highlightProfileId", "profile:new");
    expect(form.value("name")).toBe("New draft");
    expect(form.value("highlightProfileId")).toBe("profile:new");
  });

  it("preserves custom serial baud and typed fields when switching highlight choices", () => {
    const form = openForm(serialFormDefinition({ name: "Console", path: "COM3", baudRate: 31250 }, [], true, catalog));
    form.type("name", "Renamed console");
    form.choose("highlightProfileId", "profile:linux");
    expect(form.attemptNativeSubmit()).toMatchObject({ name: "Renamed console", baudRate: "custom", customBaudRate: "31250", highlightProfileId: "profile:linux" });
  });
});
