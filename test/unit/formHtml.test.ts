import { describe, expect, it } from "vitest";
import { renderFormHtml } from "../../src/ui/formHtml";
import type { FormDefinition } from "../../src/ui/formTypes";
import { tunnelFormDefinition } from "../../src/ui/formDefinitions";

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
    expect(html).toContain("custom-select");
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

  it("renders combobox fields with custom dropdown", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "combobox",
          key: "group",
          label: "Group",
          suggestions: ["Dev", "Prod"],
          placeholder: "Pick or type...",
          value: "Dev"
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("custom-combobox");
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain("custom-select-option");
    expect(html).toContain("Dev");
    expect(html).toContain("Prod");
  });

  it("includes vscode api script", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: []
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("acquireVsCodeApi");
  });

  it("renders visibleWhen data attributes on fields", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "select",
          key: "profileType",
          label: "Type",
          options: [
            { label: "SSH", value: "ssh" },
            { label: "Serial", value: "serial" }
          ],
          value: "ssh"
        },
        {
          type: "text",
          key: "host",
          label: "Host",
          required: true,
          visibleWhen: { field: "profileType", value: "ssh" }
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("data-visible-when=");
    expect(html).toContain("profileType");
    expect(html).toContain("ssh");
  });

  it("includes CSS for visibleWhen hidden/visible states", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "text",
          key: "x",
          label: "X",
          visibleWhen: { field: "y", value: "z" }
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain(".form-group[data-visible-when] { display: none; }");
    expect(html).toContain(".form-group[data-visible-when].field-visible { display: block; }");
  });

  it("renders html fields with form-illustration class", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        { type: "html", content: "<svg><circle r=\"5\"/></svg>" }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("form-illustration");
    expect(html).toContain("<svg><circle r=\"5\"/></svg>");
  });

  it("renders html fields with visibleWhen data attributes", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        { type: "html", content: "<svg/>", visibleWhen: { field: "mode", value: "a" } }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("data-visible-when=");
    expect(html).toContain("mode");
    expect(html).toContain("form-illustration");
  });

  it("renders html fields correctly when CSP nonce is present", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        { type: "html", content: "<svg><circle r=\"5\"/></svg>" }
      ]
    };
    const html = renderFormHtml(definition, "test-nonce-123");
    expect(html).toContain("form-illustration");
    expect(html).toContain("<svg><circle r=\"5\"/></svg>");
    expect(html).toContain('nonce="test-nonce-123"');
    expect(html).toContain("Content-Security-Policy");
  });

  it("renders tunnel form with autoStop checkbox", () => {
    const definition = tunnelFormDefinition();
    const html = renderFormHtml(definition);
    expect(html).toContain("autoStop");
    expect(html).toContain("Auto-stop when server disconnects");
  });

  it("renders tunnel form with browserUrl field and hint", () => {
    const definition = tunnelFormDefinition();
    const html = renderFormHtml(definition);
    expect(html).toContain('id="field-browserUrl"');
    expect(html).toContain("Browser URL");
    expect(html).toContain("URL opened by the globe icon");
  });

  it("renders tunnel form with SVG illustrations using inline attributes (no style blocks)", () => {
    const definition = tunnelFormDefinition();
    const html = renderFormHtml(definition);
    // All three illustration types are wired via visibleWhen (JSON is HTML-escaped)
    expect(html).toContain('&quot;value&quot;:&quot;local&quot;');
    expect(html).toContain('&quot;value&quot;:&quot;reverse&quot;');
    expect(html).toContain('&quot;value&quot;:&quot;dynamic&quot;');
    expect(html).toContain("form-illustration");
    // SVGs use inline presentation attributes, not <style> blocks
    // (style blocks would be blocked by CSP and cause class name collisions)
    expect(html).not.toMatch(/<svg[^>]*>[\s\S]*?<style[\s\S]*?<\/style>[\s\S]*?<\/svg>/);
  });

  it("includes updateVisibility JS function", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "text",
          key: "x",
          label: "X",
          visibleWhen: { field: "y", value: "z" }
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("updateVisibility");
  });

  it("renders compound visibleWhen as JSON-encoded data attribute", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "text",
          key: "proxyHost",
          label: "Proxy Host",
          visibleWhen: [
            { field: "profileType", value: "ssh" },
            { field: "proxyType", value: "socks5" }
          ]
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("data-visible-when=");
    expect(html).toContain("profileType");
    expect(html).toContain("proxyType");
    expect(html).toContain("socks5");
  });

  it("renders single visibleWhen condition as JSON array (backward compatible)", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "text",
          key: "host",
          label: "Host",
          visibleWhen: { field: "type", value: "ssh" }
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("data-visible-when=");
    expect(html).toContain('&quot;field&quot;:&quot;type&quot;');
    expect(html).toContain('&quot;value&quot;:&quot;ssh&quot;');
  });

  it("JS updateVisibility uses JSON.parse for compound conditions", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "select",
          key: "profileType",
          label: "Profile",
          options: [
            { label: "SSH", value: "ssh" },
            { label: "Serial", value: "serial" }
          ],
          value: "ssh"
        },
        {
          type: "select",
          key: "proxyType",
          label: "Proxy",
          options: [
            { label: "None", value: "none" },
            { label: "SOCKS5", value: "socks5" }
          ],
          value: "none"
        },
        {
          type: "text",
          key: "proxyHost",
          label: "Proxy Host",
          visibleWhen: [
            { field: "profileType", value: "ssh" },
            { field: "proxyType", value: "socks5" }
          ]
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("JSON.parse");
  });
});
