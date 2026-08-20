/**
 * @author kanekitakitos
 *
 * Unit tests for the `section` form field (`src/ui/formHtml.ts`), added so the
 * network-server editors could be grouped into headed blocks.
 *
 * Two properties matter and neither is visible by eye. A section is a HEADING,
 * not a control: if it ever rendered a named input the webview's submit loop
 * (`for (form.elements) … values[el.name] = el.value`) would post a phantom key,
 * and `networkServerSettingUpdates` writes the keys it is handed. And its label
 * is interpolated straight into the document, so an unescaped `<` turns a
 * heading into markup — asserted with a hostile label rather than a friendly
 * one, because "Address Pool" renders identically escaped or not.
 */

import { describe, expect, it } from "vitest";
import { renderFormHtml } from "../../../src/ui/formHtml";
import type { FormDefinition } from "../../../src/ui/formTypes";

const HOSTILE_LABEL = `Boot <img src=x onerror="alert('ztp')"> & ZTP`;

function sectionForm(label: string, extra: FormDefinition["fields"] = []): FormDefinition {
  return { title: "Service Settings", fields: [{ type: "section", label }, ...extra] };
}

describe("renderFormHtml — section field", () => {
  it("renders the label inside a form-section block", () => {
    const html = renderFormHtml(sectionForm("Address Pool"));
    expect(html).toContain('<div class="form-section">Address Pool</div>');
  });

  it("escapes every HTML-significant character in the label", () => {
    const html = renderFormHtml(sectionForm(HOSTILE_LABEL));
    expect(html).toContain(
      '<div class="form-section">Boot &lt;img src=x onerror=&quot;alert(&#39;ztp&#39;)&quot;&gt; &amp; ZTP</div>'
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="alert');
  });

  it("emits no control for the section, so the submit loop posts nothing for it", () => {
    const html = renderFormHtml(sectionForm("Reservations"));
    const controls = html.match(/<(input|select|textarea)\b/g) ?? [];
    expect(controls).toEqual([]);
    expect(html).not.toContain('name="Reservations"');
    expect(html).not.toContain('id="field-');
  });

  it("keeps the surrounding real fields' controls intact", () => {
    const html = renderFormHtml(
      sectionForm("Address Pool", [{ type: "text", key: "rangeStart", label: "Pool Start", value: "10.0.0.10" }])
    );
    expect(html).toContain('<div class="form-section">Address Pool</div>');
    expect(html).toContain('name="rangeStart"');
    expect(html.match(/<input\b/g) ?? []).toHaveLength(1);
  });

  it("carries a visibleWhen condition like any other field and no `required` marker", () => {
    const html = renderFormHtml({
      title: "Service Settings",
      fields: [{ type: "section", label: "Boot / ZTP", visibleWhen: { field: "mode", value: "ztp" } }]
    });
    expect(html).toContain(
      `<div class="form-section" data-visible-when='${"[{&quot;field&quot;:&quot;mode&quot;,&quot;value&quot;:&quot;ztp&quot;}]"}'>Boot / ZTP</div>`
    );
    expect(html).not.toContain('<span class="req">');
  });

  it("renders inside the Advanced block when marked advanced", () => {
    const html = renderFormHtml({
      title: "Service Settings",
      fields: [{ type: "section", label: "Vendor Options", advanced: true }]
    });
    const advanced = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(advanced).toContain('<div class="form-section">Vendor Options</div>');
  });
});
