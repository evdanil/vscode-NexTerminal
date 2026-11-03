import { describe, expect, it } from "vitest";
import { openForm } from "../helpers/formScriptHarness";
import { highlightProfileSelectField } from "../../src/ui/highlightProfileForm";

const initial = { enabled: true, legacy: false, defaultProfileId: "old", profiles: [
  { id: "old", name: "Old", rules: [] }
] };

describe("highlight profile choices in an open form", () => {
  it("refreshes added, renamed and deleted profiles without changing the draft or selection", () => {
    const form = openForm({ title: "Edit", fields: [
      { type: "text", key: "name", label: "Name", value: "before" },
      highlightProfileSelectField(initial, "old")
    ] });
    form.typeFocused("name", "unfinished name");
    form.deliver({ type: "highlightProfilesChanged", revision: 1, options: [
      { value: "", label: "Use global default (New default)" },
      { value: "__none__", label: "None" },
      { value: "profile:old", label: "Renamed" },
      { value: "profile:new", label: "New" }
    ], hint: "Updated" });
    expect(form.value("name")).toBe("unfinished name");
    expect(form.value("highlightProfileId")).toBe("profile:old");
    expect(form.selectLabel("highlightProfileId")).toBe("Renamed");
    form.choose("highlightProfileId", "profile:new");
    form.deliver({ type: "highlightProfilesChanged", revision: 2, options: [
      { value: "", label: "Use global default (None)" }, { value: "__none__", label: "None" }
    ], hint: "Updated" });
    expect(form.value("highlightProfileId")).toBe("profile:new");
    expect(form.selectLabel("highlightProfileId")).toContain("Missing profile: new");
    expect(form.submit()).toMatchObject({ name: "unfinished name", highlightProfileId: "profile:new" });
  });

  it("ignores an older catalog message that arrives after a newer one", () => {
    const form = openForm({ title: "Edit", fields: [highlightProfileSelectField(initial)] });
    form.deliver({ type: "highlightProfilesChanged", revision: 2, options: [
      { value: "", label: "Use global default (New)" }, { value: "__none__", label: "None" },
      { value: "profile:new", label: "New" }
    ], hint: "New" });
    form.deliver({ type: "highlightProfilesChanged", revision: 1, options: [
      { value: "", label: "Use global default (Old)" }, { value: "__none__", label: "None" },
      { value: "profile:old", label: "Old" }
    ], hint: "Old" });
    expect(form.selectLabel("highlightProfileId")).toBe("Use global default (New)");
    form.choose("highlightProfileId", "profile:new");
    expect(form.submit().highlightProfileId).toBe("profile:new");
  });

  it("does not rewrite an already submitted selection when the catalog changes", () => {
    const form = openForm({ title: "Edit", fields: [highlightProfileSelectField(initial, "old")] });
    const submitted = form.submit();
    form.deliver({ type: "highlightProfilesChanged", revision: 3, options: [
      { value: "", label: "Use global default (None)" }, { value: "__none__", label: "None" },
      { value: "profile:new", label: "New" }
    ], hint: "Updated" });
    expect(submitted.highlightProfileId).toBe("profile:old");
    expect(form.value("highlightProfileId")).toBe("profile:old");
  });

  it.each(["", "__none__"])("retains the %j sentinel through a catalog update", (value) => {
    const form = openForm({ title: "Edit", fields: [highlightProfileSelectField(initial)] });
    form.choose("highlightProfileId", value);
    form.deliver({ type: "highlightProfilesChanged", revision: 4, options: [
      { value: "", label: "Use global default (None)" },
      { value: "__none__", label: "None" },
      { value: "profile:new", label: "New" }
    ], hint: "Updated" });
    expect(form.selectLabel("highlightProfileId")).toBe(value === "" ? "Use global default (None)" : "None");
    expect(form.submit().highlightProfileId).toBe(value);
  });
});
