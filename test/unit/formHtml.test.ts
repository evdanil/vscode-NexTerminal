import { describe, expect, it } from "vitest";
import { renderFormHtml } from "../../src/ui/formHtml";
import type { FormDefinition } from "../../src/ui/formTypes";

describe("renderFormHtml", () => {
  it("renders text fields with labels", () => {
    const definition: FormDefinition = {
      title: "Test Form",
      fields: [
        { type: "text", key: "name", label: "Name", required: true, value: "hello" }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("Test Form");
    expect(html).toContain('id="field-name"');
    expect(html).toContain("Name");
    expect(html).toContain("required");
  });

  it("renders select fields with options", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "select",
          key: "mode",
          label: "Mode",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" }
          ],
          value: "b"
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("<select");
    expect(html).toContain("Option A");
    expect(html).toContain("Option B");
    expect(html).toContain("selected");
  });

  it("renders checkbox fields", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "checkbox", key: "flag", label: "Enable", value: true }]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("renders number fields with min/max", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "number", key: "port", label: "Port", min: 1, max: 65535, value: 22 }]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="65535"');
  });

  it("renders file fields with browse button", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "file", key: "keyPath", label: "Key File", value: "/home/.ssh/id_rsa" }]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("Browse");
    expect(html).toContain('id="field-keyPath"');
  });

  it("includes submit and cancel buttons", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: []
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("Save");
    expect(html).toContain("Cancel");
  });

  it("includes vscode api script", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: []
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("acquireVsCodeApi");
  });
});
