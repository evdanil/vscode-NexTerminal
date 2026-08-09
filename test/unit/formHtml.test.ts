import { describe, expect, it } from "vitest";
import { renderFormHtml, sortFilterableOptions } from "../../src/ui/formHtml";
import type { FormDefinition } from "../../src/ui/formTypes";
import { inventorySourceFormDefinition, serverFormDefinition, tunnelFormDefinition } from "../../src/ui/formDefinitions";
import type { AuthProfile } from "../../src/models/config";
import { authProfileOwnedCredentials } from "../../src/models/config";

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

  it("omits the step attribute for a number field that doesn't set one (no-behavior-change guard)", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "number", key: "port", label: "Port", min: 1, max: 65535, value: 22 }]
    };
    const html = renderFormHtml(definition);
    expect(html).not.toContain("step=");
  });

  it("renders step=\"any\" on a number field that opts in, allowing fractional values past native validation", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "number", key: "pollInterval", label: "Poll Interval", value: 0.5, step: "any" }]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain('step="any"');
    expect(html).toContain('value="0.5"');
  });

  it("renders password fields with password input type", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "password", key: "proxyPassword", label: "Proxy Password", placeholder: "Secret" }]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain('type="password"');
    expect(html).toContain('id="field-proxyPassword"');
    expect(html).toContain('autocomplete="new-password"');
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
          required: true,
          placeholder: "Pick or type...",
          value: "Dev"
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("custom-combobox");
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('name="group"');
    expect(html).toContain("required");
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

  it("renders conditional visibility on the test button", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "select",
          key: "profileType",
          label: "Type",
          options: [
            { label: "SSH", value: "ssh" },
            { label: "Local Shell", value: "localShell" }
          ],
          value: "ssh"
        }
      ],
      testable: true,
      testableWhen: { field: "profileType", value: ["ssh"] }
    };
    const html = renderFormHtml(definition);
    expect(html).toContain('id="test-btn"');
    expect(html).toContain(".actions button[data-visible-when]");
    expect(html).toContain("group.disabled = !visible");
    expect(html).toContain('&quot;field&quot;:&quot;profileType&quot;');
    expect(html).toContain('&quot;value&quot;:[&quot;ssh&quot;]');
  });

  it("groups advanced fields behind a details summary", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        { type: "text", key: "host", label: "Host", required: true },
        { type: "checkbox", key: "multiplexing", label: "Enable multiplexing", advanced: true },
        { type: "combobox", key: "group", label: "Folder", suggestions: [], advanced: true }
      ]
    };
    const html = renderFormHtml(definition);
    const hostIndex = html.indexOf('id="field-host"');
    const detailsIndex = html.indexOf('<details class="advanced-fields">');
    const summaryIndex = html.indexOf("<summary>Advanced options</summary>");
    const multiplexingIndex = html.indexOf('id="field-multiplexing"');
    const groupIndex = html.indexOf('id="field-group"');

    expect(detailsIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(detailsIndex);
    expect(hostIndex).toBeGreaterThan(-1);
    expect(hostIndex).toBeLessThan(detailsIndex);
    expect(multiplexingIndex).toBeGreaterThan(summaryIndex);
    expect(groupIndex).toBeGreaterThan(summaryIndex);
  });

  it("keeps advanced fields subject to visibleWhen attributes", () => {
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
          key: "proxyHost",
          label: "Proxy Host",
          advanced: true,
          visibleWhen: { field: "profileType", value: "ssh" }
        }
      ]
    };
    const html = renderFormHtml(definition);
    const detailsIndex = html.indexOf('<details class="advanced-fields">');
    const proxyIndex = html.indexOf('id="field-proxyHost"');

    expect(proxyIndex).toBeGreaterThan(detailsIndex);
    expect(html).toContain("data-visible-when=");
    expect(html).toContain('&quot;field&quot;:&quot;profileType&quot;');
    expect(html).toContain('&quot;value&quot;:&quot;ssh&quot;');
  });

  it("includes CSS for advanced field grouping", () => {
    const html = renderFormHtml({
      title: "Test",
      fields: [{ type: "text", key: "notes", label: "Notes", advanced: true }]
    });

    expect(html).toContain(".advanced-fields");
    expect(html).toContain(".advanced-fields summary");
    expect(html).toContain(".advanced-fields .form-group");
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

  it("updateVisibility disables hidden inputs to prevent constraint validation", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        { type: "text", key: "x", label: "X", visibleWhen: { field: "y", value: "z" } }
      ]
    };
    const html = renderFormHtml(definition);
    // When hiding, must set disabled = true so min/max constraints don't block submission
    expect(html).toContain("inputs[ii].disabled = true");
    // When showing, must re-enable
    expect(html).toContain("inputs[ii].disabled = false");
  });

  it("submit handler skips disabled fields so hidden values are not posted", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "text", key: "x", label: "X" }]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("if (el.disabled) continue;");
  });

  it("renders autofill-enabled selects and posts autofill messages", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          options: [
            { label: "(None)", value: "" },
            { label: "Prod", value: "ap1" }
          ],
          value: "",
          autofill: true
        }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain('data-autofill="true"');
    expect(html).toContain("type: 'autofill'");
    expect(html).toContain('if (msg.type === "fillFields")');
  });

  it("keeps profile-managed field values submittable by using readonly instead of disabling inputs", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          options: [
            { label: "(None)", value: "" },
            { label: "Prod", value: "ap1" }
          ],
          value: "ap1",
          autofill: true
        },
        { type: "text", key: "username", label: "Username", value: "root" },
        {
          type: "select",
          key: "authType",
          label: "Authentication",
          options: [
            { label: "Password", value: "password" },
            { label: "Private Key", value: "key" }
          ],
          value: "password"
        },
        { type: "file", key: "keyPath", label: "Private Key File", value: "/tmp/id_rsa" }
      ]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("if (input.type === \"hidden\") continue;");
    expect(html).toContain("input.readOnly = locked || input.dataset.baseReadonly === \"true\";");
    expect(html).toContain("button.disabled = locked || button.dataset.baseDisabled === \"true\";");
    expect(html).toContain("trigger.style.pointerEvents = \"none\"");
  });

  /**
   * REVIEW FINDING (P2) — field ownership is TRACKED (which keys the current
   * autofill supplied), never inferred from what the field happens to hold.
   * Exercised by running the real functions out of the rendered script against
   * a stub DOM (same extract-and-invoke idiom as macroEditorHtml.test.ts),
   * because a string assertion cannot tell whether the guard actually keeps a
   * field editable.
   */
  describe("profile-managed field locking — tracked ownership, not the field's current value", () => {
    interface StubElement {
      tagName: string;
      type?: string;
      value?: string;
      readOnly: boolean;
      disabled?: boolean;
      dataset: Record<string, string | undefined>;
      style: Record<string, string>;
      closest?: (selector: string) => unknown;
    }

    /** Slices one top-level function out of the rendered script by brace depth. */
    function extractFunctionSource(html: string, signature: string): string {
      const start = html.indexOf(signature);
      expect(start).toBeGreaterThan(-1);
      let depth = 0;
      let end = -1;
      for (let i = html.indexOf("{", start); i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      expect(end).toBeGreaterThan(start);
      return html.slice(start, end + 1);
    }

    function extractUpdateProfileManagedFields(
      html: string
    ): (doc: unknown, filledKeys: Record<string, boolean>) => void {
      const source = extractFunctionSource(html, "function updateProfileManagedFields()");
      // `document` and `profileFilledKeys` are the only two things the
      // extracted function reads from its closure, so both are injected as
      // factory parameters — and the second one IS the signal under test.
      const factory = new Function(
        "document",
        "profileFilledKeys",
        `${source}\nreturn updateProfileManagedFields;`
      ) as (doc: unknown, filledKeys: Record<string, boolean>) => () => void;
      return (doc, filledKeys) => factory(doc, filledKeys)();
    }

    function extractSeededProfileFilledKeys(html: string): (doc: unknown) => Record<string, boolean> {
      const source = extractFunctionSource(html, "function seededProfileFilledKeys()");
      const factory = new Function("document", `${source}\nreturn seededProfileFilledKeys;`) as (
        doc: unknown
      ) => () => Record<string, boolean>;
      return (doc: unknown) => factory(doc)();
    }

    function extractSeededProfileDisplacedValues(html: string): (doc: unknown) => Record<string, string> {
      const source = extractFunctionSource(html, "function seededProfileDisplacedValues()");
      const factory = new Function("document", `${source}\nreturn seededProfileDisplacedValues;`) as (
        doc: unknown
      ) => () => Record<string, string>;
      return (doc: unknown) => factory(doc)();
    }

    function extractFilledKeysFromValues(html: string): (values: Record<string, unknown>) => Record<string, boolean> {
      const source = extractFunctionSource(html, "function filledKeysFromValues(values)");
      const factory = new Function(`${source}\nreturn filledKeysFromValues;`) as () => (
        values: Record<string, unknown>
      ) => Record<string, boolean>;
      return factory();
    }

    function extractFillAnswersCurrentSelection(
      html: string
    ): (form: unknown, msg: { key: string; value?: string }) => boolean {
      const source = extractFunctionSource(html, "function fillAnswersCurrentSelection(msg)");
      // `form` is the only thing it reads from its closure — deliberately, so
      // the comparison is against the live control rather than a copy of the
      // selection this script would have to keep in step.
      const factory = new Function("form", `${source}\nreturn fillAnswersCurrentSelection;`) as (
        form: unknown
      ) => (msg: { key: string; value?: string }) => boolean;
      return (form, msg) => factory(form)(msg);
    }

    /**
     * One managed field ("defaultUsername") in its own .form-group, plus the
     * Auth Profile select's hidden input that decides `isLinked`. `button`
     * models the Browse/Clear pair a file-typed managed field (keyPath) carries
     * in the same group.
     */
    function makeDom(opts: { linkedProfileId: string; fieldValue: string }) {
      const field: StubElement = {
        tagName: "INPUT",
        type: "text",
        value: opts.fieldValue,
        readOnly: false,
        dataset: {},
        style: {}
      };
      const button: StubElement = {
        tagName: "BUTTON",
        readOnly: false,
        disabled: false,
        dataset: {},
        style: {}
      };
      const group = {
        querySelectorAll: (selector: string): StubElement[] =>
          selector === "input, textarea" ? [field] : selector === "button" ? [button] : [],
        querySelector: (): unknown => null
      };
      field.closest = (selector: string) => (selector === ".form-group" ? group : null);
      const profileWrapper = {
        querySelector: (): unknown => ({ value: opts.linkedProfileId })
      };
      const document = {
        getElementById: (id: string): unknown => {
          if (id === "field-authProfileId") return profileWrapper;
          if (id === "field-defaultUsername") return field;
          return null;
        }
      };
      return { document, field, button };
    }

    const run = renderFormHtml({ title: "Test", fields: [] });

    it("locks a managed field the current autofill supplied", () => {
      const update = extractUpdateProfileManagedFields(run);
      const { document, field, button } = makeDom({ linkedProfileId: "ap1", fieldValue: "labuser" });
      update(document, { defaultUsername: true });
      expect(field.readOnly).toBe(true);
      expect(field.style.opacity).toBe("0.6");
      expect(button.disabled).toBe(true);
    });

    it("leaves a PREFILLED managed field editable when the linked profile supplied nothing for it (kills inferring ownership from the field's current value: on Edit the record prefills it and on Add mostCommonUsername does, so a value test locks the user's own fallback under a blank-username profile — the very field authProfileUsernameMirror declined to touch — and it can never be changed while that profile stays selected)", () => {
      const update = extractUpdateProfileManagedFields(run);
      const { document, field, button } = makeDom({ linkedProfileId: "ap1", fieldValue: "labuser" });
      update(document, {});
      expect(field.readOnly).toBe(false);
      expect(field.style.opacity).toBe("");
      expect(button.disabled).toBe(false);
    });

    it("leaves a managed field the linked profile left EMPTY editable (kills locking on `isLinked` alone, which freezes a required field the mirror never filled — an imported profile with a whitespace-only username, or a key profile with no key path — leaving the user nothing to correct and Save permanently refused)", () => {
      const update = extractUpdateProfileManagedFields(run);
      const { document, field, button } = makeDom({ linkedProfileId: "ap1", fieldValue: "" });
      update(document, {});
      expect(field.readOnly).toBe(false);
      expect(field.style.opacity).toBe("");
      expect(button.disabled).toBe(false);
    });

    it("keeps a field the profile DID supply locked even once its value is cleared (kills re-adding a \"the field holds something\" conjunct: emptying a mirrored field does not hand ownership back, and unlocking it there would let a value be typed that the save overwrites from the profile anyway)", () => {
      const update = extractUpdateProfileManagedFields(run);
      const { document, field } = makeDom({ linkedProfileId: "ap1", fieldValue: "" });
      update(document, { defaultUsername: true });
      expect(field.readOnly).toBe(true);
    });

    it("never locks an unlinked field, however filled (kills dropping the isLinked half of the condition)", () => {
      const update = extractUpdateProfileManagedFields(run);
      const { document, field, button } = makeDom({ linkedProfileId: "", fieldValue: "hand-typed" });
      update(document, { defaultUsername: true });
      expect(field.readOnly).toBe(false);
      expect(button.disabled).toBe(false);
    });

    it("still honours a field's own baseline readonly/disabled state when unlocked (kills using the computed lock to UNLOCK a natively read-only field, e.g. the file input behind Browse)", () => {
      const update = extractUpdateProfileManagedFields(run);
      const { document, field, button } = makeDom({ linkedProfileId: "ap1", fieldValue: "" });
      field.readOnly = true;
      button.disabled = true;
      update(document, {});
      expect(field.readOnly).toBe(true);
      expect(button.disabled).toBe(true);
    });

    /** The initial-render entry point: ownership before any autofill has run. */
    function makeSeedDom(autofillFilled: string | undefined) {
      return {
        getElementById: (id: string): unknown =>
          id === "field-authProfileId" ? { dataset: { autofillFilled } } : null
      };
    }

    /** The same entry point for the restore half. */
    function makeDisplacedSeedDom(autofillDisplaced: string | undefined) {
      return {
        getElementById: (id: string): unknown =>
          id === "field-authProfileId" ? { dataset: { autofillDisplaced } } : null
      };
    }

    it("seeds the restore record from the select's data-autofill-displaced attribute (kills starting a pre-linked form with an empty one: the render's substitution then has nothing behind it and unlinking cannot undo it)", () => {
      const seed = extractSeededProfileDisplacedValues(run);
      expect(seed(makeDisplacedSeedDom('{"username":"stored-user","authType":"password","keyPath":"/stored/key"}'))).toEqual({
        username: "stored-user",
        authType: "password",
        keyPath: "/stored/key"
      });
    });

    it("seeds nothing when the render displaced nothing (no attribute), and survives a malformed or wrongly-typed one (kills an unguarded JSON.parse taking the form script down, and kills writing a non-string straight into a control's value)", () => {
      const seed = extractSeededProfileDisplacedValues(run);
      expect(seed(makeDisplacedSeedDom(undefined))).toEqual({});
      expect(seed(makeDisplacedSeedDom("{not json"))).toEqual({});
      expect(seed(makeDisplacedSeedDom('["username"]'))).toEqual({});
      expect(seed(makeDisplacedSeedDom('{"username":"ok","authType":7,"keyPath":null}'))).toEqual({ username: "ok" });
    });

    it("seeds ownership from the select's data-autofill-filled attribute (kills leaving the initial render with no record at all, which unlocks every mirrored field on Edit until the profile is re-picked)", () => {
      const seed = extractSeededProfileFilledKeys(run);
      expect(seed(makeSeedDom('["username","authType","defaultUsername"]'))).toEqual({
        username: true,
        authType: true,
        defaultUsername: true
      });
    });

    it("seeds nothing when the selected profile fills nothing (no attribute rendered)", () => {
      const seed = extractSeededProfileFilledKeys(run);
      expect(seed(makeSeedDom(undefined))).toEqual({});
    });

    it("survives a malformed seed attribute (kills an unguarded JSON.parse taking the whole form script down)", () => {
      const seed = extractSeededProfileFilledKeys(run);
      expect(seed(makeSeedDom("{not json"))).toEqual({});
    });

    it("records exactly the keys a fill response supplied", () => {
      const record = extractFilledKeysFromValues(run);
      expect(record({ defaultUsername: "labuser" })).toEqual({ defaultUsername: true });
      expect(record({})).toEqual({});
    });

    it("does not record a key whose supplied value is blank (kills trusting the payload verbatim: the server and unified profile forms' mirrors send profile.username unfiltered, so an imported whitespace-only username would lock a required field onto a value no login can use)", () => {
      const record = extractFilledKeysFromValues(run);
      expect(record({ username: "   ", authType: "password" })).toEqual({ authType: true });
    });

    /**
     * REVIEW FINDING (P2) — an autofill is a round trip, so the answer can
     * describe an option the user has already left. Only the echoed id can tell
     * the two apart, and the comparison is against the CONTROL: whatever the
     * user last selected is in there, whether they got to it by clicking an
     * option, by (None), or through an inline-created one.
     */
    it("accepts an answer for the option that is selected right now", () => {
      const answers = extractFillAnswersCurrentSelection(run);
      const form = { elements: { authProfileId: { value: "ap1" } } };
      expect(answers(form, { key: "authProfileId", value: "ap1" })).toBe(true);
    });

    it("refuses one for a profile the form has moved away from — another profile, or (None) (kills applying a late answer to a selection it does not describe: those fields have just been unlocked and handed the user's own values back, and an unlinked save keeps whatever is submitted)", () => {
      const answers = extractFillAnswersCurrentSelection(run);
      expect(answers({ elements: { authProfileId: { value: "ap2" } } }, { key: "authProfileId", value: "ap1" })).toBe(false);
      expect(answers({ elements: { authProfileId: { value: "" } } }, { key: "authProfileId", value: "ap1" })).toBe(false);
      // An answer carrying no id at all cannot be correlated, so it is refused
      // rather than trusted (kills reading a missing echo as "close enough").
      expect(answers({ elements: { authProfileId: { value: "ap1" } } }, { key: "authProfileId" })).toBe(false);
    });

    it("accepts an answer for a key this form does not render (kills correlating against a control that is not there: one managed-key list serves every form, and a lookup for another form's select is an expected miss, not a stale answer)", () => {
      const answers = extractFillAnswersCurrentSelection(run);
      expect(answers({ elements: {} }, { key: "someOtherSelect", value: "whatever" })).toBe(true);
    });

    /**
     * REVIEW FINDING (P2) — the webview keeps its OWN copy of the ownership
     * rule, because it cannot import the TypeScript one: `filledKeysFromValues`
     * is a hand-written mirror of `authProfileOwnedCredentials`
     * (models/config.ts). This is the explicit cross-check on that duplication:
     * a payload built from the shared rule — which is exactly what the two
     * mirrors send (`authProfileCredentialMirror` in serverCommands.ts,
     * `authProfileUsernameMirror` in inventoryCommands.ts, each tested against
     * the rule on their own side) — must produce the same record the render
     * seeded from `authProfileFilledKeys` (ui/formDefinitions.ts). If either
     * copy drifts, one of these profiles disagrees.
     */
    it("rebuilds exactly the ownership record the render seeded, for a payload shaped by the shared rule (the explicit cross-check on the webview's hand-written copy of it)", () => {
      const record = extractFilledKeysFromValues(run);
      const seed = extractSeededProfileFilledKeys(run);
      const profiles: AuthProfile[] = [
        { id: "c1", name: "Password", username: "root", authType: "password" },
        { id: "c2", name: "Key", username: "root", authType: "key", keyPath: "/keys/id" },
        { id: "c3", name: "Imported blank", username: "   ", authType: "password" },
        { id: "c4", name: "Keyless key", username: "root", authType: "key" },
        { id: "c5", name: "Padded", username: "  bob  ", authType: "key", keyPath: "   " }
      ];

      for (const profile of profiles) {
        // The payload the mirrors send: the owned credentials, verbatim.
        const owned = authProfileOwnedCredentials(profile);
        // The seed the render emits for the same profile, via the server form's
        // authProfileId select.
        const definition = serverFormDefinition(
          { id: "s1", name: "S", host: "h", port: 22, username: "stored", authType: "password", isHidden: false, authProfileId: profile.id },
          [],
          false,
          [],
          [profile]
        );
        const select = definition.fields.find(
          (f): f is Extract<typeof f, { type: "select" }> => "key" in f && f.key === "authProfileId" && f.type === "select"
        )!;
        const seeded = seed(makeSeedDom(JSON.stringify(select.autofillFilledKeys)));
        // `defaultUsername` is the inventory source form's alias for the same
        // username key; the server form's payload never carries it.
        delete seeded.defaultUsername;

        expect(record(owned as Record<string, unknown>), `webview record for ${profile.name}`).toEqual(seeded);
      }
    });
  });

  it("releases the previous profile when a different one is picked (kills carrying the previous profile's keys across a selection: they stay locked through the whole round trip, and forever if the new profile fills nothing — and kills unlocking them while leaving that profile's VALUES behind, which is the transition half, exercised end to end in authProfileSwitchTransition.test.ts)", () => {
    const html = renderFormHtml({ title: "Test", fields: [] });
    // Slice the user-click callback out so the addSelectOption handler's own
    // release cannot satisfy this assertion.
    const start = html.indexOf("initCustomSelects(function(wrapper, opt) {");
    const end = html.indexOf("initCustomComboboxes();");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(html.slice(start, end)).toContain("releaseProfileOwnedFields();");
  });

  it("releases in one order: values back first, then ownership dropped, then the lock and visibility re-settled (kills re-evaluating the lock before the values are back, which paints the old profile's value into an unlocked field)", () => {
    const html = renderFormHtml({ title: "Test", fields: [] });
    const start = html.indexOf("function releaseProfileOwnedFields()");
    expect(start).toBeGreaterThan(-1);
    const block = html.slice(start, html.indexOf("function applyFillFields(msg)"));
    const restoreIndex = block.indexOf("setFieldValue(key, profileDisplacedValues[key]);");
    const forgetIndex = block.indexOf("profileDisplacedValues = {};");
    const disownIndex = block.indexOf("profileFilledKeys = {};");
    const relockIndex = block.indexOf("updateProfileManagedFields();");
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(forgetIndex).toBeGreaterThan(restoreIndex);
    expect(disownIndex).toBeGreaterThan(restoreIndex);
    expect(relockIndex).toBeGreaterThan(disownIndex);
    expect(block.indexOf("updateVisibility();")).toBeGreaterThan(disownIndex);
  });

  it("attributes a fillFields answer to the auth profile select by the echoed key (kills recording another autofill-capable select's answer as the profile's, and kills never recording at all)", () => {
    const html = renderFormHtml({ title: "Test", fields: [] });
    const start = html.indexOf("function applyFillFields(msg)");
    const end = html.indexOf("function parseVisibleWhen(raw)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = html.slice(start, end);
    expect(block).toContain('var isProfileFill = msg.key === "authProfileId";');
    expect(block).toContain("var nextFilledKeys = isProfileFill ? filledKeysFromValues(fillValues) : null;");
    expect(block).toContain("profileFilledKeys = nextFilledKeys;");
    // …and the message listener delegates to it rather than keeping a second
    // copy of the rule inline.
    const listenerStart = html.indexOf('if (msg.type === "fillFields")');
    const listenerEnd = html.indexOf('if (msg.type === "validationError")');
    expect(listenerStart).toBeGreaterThan(-1);
    expect(html.slice(listenerStart, listenerEnd)).toContain("applyFillFields(msg);");
  });

  it("consults the staleness guard before applying any part of an answer (kills a guard that exists but is never called, and kills writing values or seizing ownership first)", () => {
    const html = renderFormHtml({ title: "Test", fields: [] });
    const start = html.indexOf("function applyFillFields(msg)");
    expect(start).toBeGreaterThan(-1);
    const block = html.slice(start, html.indexOf("function parseVisibleWhen(raw)"));
    const guardIndex = block.indexOf("if (!fillAnswersCurrentSelection(msg)) {");
    expect(guardIndex).toBeGreaterThan(-1);
    // Values and ownership both follow it — a partially applied stale answer
    // would leave one profile's values sitting under another's lock.
    expect(block.indexOf("setFieldValue(fk, fillValues[fk]);")).toBeGreaterThan(guardIndex);
    expect(block.indexOf("profileFilledKeys = nextFilledKeys;")).toBeGreaterThan(guardIndex);
  });

  it("records what a managed field held before the profile's fill overwrites it (kills writing the profile's value first, which records the profile's own value as the thing to hand back)", () => {
    const html = renderFormHtml({ title: "Test", fields: [] });
    const start = html.indexOf("function applyFillFields(msg)");
    const block = html.slice(start, html.indexOf("function parseVisibleWhen(raw)"));
    const rememberIndex = block.indexOf("rememberDisplacedValue(fk);");
    const writeIndex = block.indexOf("setFieldValue(fk, fillValues[fk]);");
    expect(rememberIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(rememberIndex);
  });

  it("locks Default SSH Username alongside the server form's credential fields while a profile is linked", () => {
    const html = renderFormHtml({ title: "Test", fields: [] });
    // The loop skips keys a form doesn't render, so one shared list serves both
    // the server form (username/authType/keyPath) and the inventory source form
    // (defaultUsername). Without "defaultUsername" the source form's mirrored
    // username would never lock or dim.
    expect(html).toContain('var managedKeys = ["username", "authType", "keyPath", "defaultUsername"];');
  });

  it("makes an injected select option autofill and re-lock exactly like a user click", () => {
    const html = renderFormHtml({ title: "Test", fields: [] });
    const start = html.indexOf('if (msg.type === "addSelectOption")');
    const end = html.indexOf('if (msg.type === "fillFields")');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // Slice the handler out so the user-click path's own autofill/lock calls
    // (in the initCustomSelects callback, earlier in the script) cannot satisfy
    // these assertions.
    const block = html.slice(start, end);
    const selectIndex = block.indexOf("selectCustomOption(wrapper, msg.value);");
    expect(selectIndex).toBeGreaterThan(-1);
    expect(block).toContain("wrapper.dataset.autofill === 'true'");
    expect(block).toContain("vscode.postMessage({ type: 'autofill', key: wrapper.dataset.name, value: msg.value });");
    expect(block).toContain("if (wrapper.dataset.name === 'authProfileId') {");
    expect(block.indexOf("type: 'autofill'")).toBeGreaterThan(selectIndex);
    // The release is the re-lock (it ends by re-evaluating both the lock and
    // visibility): an inline-created profile owns nothing until its own fill
    // answers, and the profile it replaces hands back what it displaced —
    // exactly like one picked from the list.
    expect(block.indexOf("releaseProfileOwnedFields();")).toBeGreaterThan(selectIndex);
  });

  it("renders the initially selected profile's filled keys onto the Auth Profile select (kills leaving the render-time seed off, which is the only thing the webview can know before the first autofill)", () => {
    const html = renderFormHtml({
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          options: [
            { label: "(None)", value: "" },
            { label: "Prod", value: "ap1" }
          ],
          value: "ap1",
          autofill: true,
          autofillFilledKeys: ["username", "authType"]
        }
      ]
    });
    expect(html).toContain("data-autofill-filled='[&quot;username&quot;,&quot;authType&quot;]'");
  });

  it("omits the seed attribute entirely when the selected profile fills nothing", () => {
    const html = renderFormHtml({
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          options: [{ label: "(None)", value: "" }],
          value: "",
          autofill: true,
          autofillFilledKeys: []
        }
      ]
    });
    // The attribute itself, not the script comment that names it.
    expect(html).not.toContain("data-autofill-filled='");
  });

  /**
   * REVIEW FINDING (P1) — the render's other seed. Where a form opens with a
   * profile already selected, the descriptors already carry that profile's
   * values, so the first overwrite happened before the script ran and no fill
   * can record it. This attribute is the only way the webview learns what to
   * put back when the link is dropped.
   */
  it("renders what the initially selected profile's values displaced (kills seeding the render's values without seeding their originals: unlinking leaves the profile's credentials in unlocked fields with nothing behind them, and the save stores them onto the record as its own)", () => {
    const html = renderFormHtml({
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          options: [
            { label: "(None)", value: "" },
            { label: "Prod", value: "ap1" }
          ],
          value: "ap1",
          autofill: true,
          autofillFilledKeys: ["username", "authType"],
          autofillDisplacedValues: { username: "stored-user", authType: "password" }
        }
      ]
    });
    expect(html).toContain(
      "data-autofill-displaced='{&quot;username&quot;:&quot;stored-user&quot;,&quot;authType&quot;:&quot;password&quot;}'"
    );
  });

  it("escapes the displaced values it embeds, which are record data and can carry quotes (kills interpolating them raw into a single-quoted attribute: a key path containing an apostrophe would close the attribute and inject markup into the form)", () => {
    const html = renderFormHtml({
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          options: [{ label: "Prod", value: "ap1" }],
          value: "ap1",
          autofill: true,
          autofillDisplacedValues: { keyPath: "/home/o'brien/id_rsa" }
        }
      ]
    });
    expect(html).not.toContain("/home/o'brien/id_rsa");
    expect(html).toContain("&#39;brien");
  });

  it("omits the displaced attribute entirely when the render displaced nothing", () => {
    const html = renderFormHtml({
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          options: [{ label: "(None)", value: "" }],
          value: "",
          autofill: true,
          autofillFilledKeys: [],
          autofillDisplacedValues: {}
        }
      ]
    });
    expect(html).not.toContain("data-autofill-displaced='");
  });

  it("renders a dangling seeded auth profile id as an empty hidden value, not just an empty label", () => {
    const definition = inventorySourceFormDefinition(
      {
        id: "fake",
        label: "Fake Provider",
        configFields: [],
        testConnection: async () => undefined,
        fetchInventory: async () => ({ nodes: [] }) as never
      },
      {
        id: "src1",
        providerId: "fake",
        name: "Fake",
        targetFolder: "",
        prunePolicy: "orphan",
        defaultUsername: "labuser",
        config: {},
        secretFieldIds: [],
        authProfileId: "ghost"
      },
      undefined,
      [{ id: "p1", name: "Lab credentials", username: "labuser", authType: "password" }]
    );
    const html = renderFormHtml(definition);
    // Display and submit must agree. An unsanitized seed renders the (None)
    // label (options[0] fallback) but keeps "ghost" as the posted value.
    expect(html).toContain('<input type="hidden" name="authProfileId" value="" />');
    expect(html).not.toContain("ghost");
  });

  it("guards visibleWhen JSON parsing to avoid script breakage", () => {
    const definition: FormDefinition = {
      title: "Test",
      fields: [{ type: "text", key: "x", label: "X", visibleWhen: { field: "y", value: "z" } }]
    };
    const html = renderFormHtml(definition);
    expect(html).toContain("function parseVisibleWhen");
    expect(html).toContain("try {");
    expect(html).toContain("catch (_error)");
  });
});

/** The option data-values, in the exact order they appear in the rendered
 *  dropdown. Options carry `data-value`; the filter input and hidden input do
 *  not, so this reads the option order alone. */
function renderedOptionOrder(html: string): string[] {
  const out: string[] = [];
  const re = /class="custom-select-option[^"]*" data-value="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    out.push(match[1]);
  }
  return out;
}

describe("sortFilterableOptions — pin sentinels, locale-sort the rest", () => {
  it("pins (None)/empty and __create__ at the top in declared order, sorts the rest case-insensitively (falsifies a case-sensitive/code-unit sort, which puts Zeta before alpha)", () => {
    const ordered = sortFilterableOptions([
      { label: "Zeta", value: "z" },
      { label: "alpha", value: "a" },
      { label: "(None)", value: "" },
      { label: "Create new…", value: "__create__x" }
    ]);
    expect(ordered.map((o) => o.value)).toEqual(["", "__create__x", "a", "z"]);
    // The load-bearing case-insensitivity: a code-unit sort (uppercase Z=90 <
    // lowercase a=97) would order these ["", "__create__x", "z", "a"].
    const alphaIdx = ordered.findIndex((o) => o.value === "a");
    const zetaIdx = ordered.findIndex((o) => o.value === "z");
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("reads the pin rule from the VALUE, not a hardcoded label — a reworded empty-value sentinel still pins", () => {
    const ordered = sortFilterableOptions([
      { label: "web-server-1", value: "s1" },
      { label: "(Select jump host)", value: "" },
      { label: "app-server-1", value: "s2" }
    ]);
    // The differently-worded sentinel (value "") leads despite sorting after
    // the real labels alphabetically.
    expect(ordered[0].value).toBe("");
    expect(ordered.slice(1).map((o) => o.label)).toEqual(["app-server-1", "web-server-1"]);
  });

  it("keeps two pinned sentinels in their DECLARED order, not sorted among themselves", () => {
    const ordered = sortFilterableOptions([
      { label: "Create new…", value: "__create__x" },
      { label: "(None)", value: "" }
    ]);
    // Declared __create__ before (None) — preserved, no reordering of pins.
    expect(ordered.map((o) => o.value)).toEqual(["__create__x", ""]);
  });
});

describe("renderFormHtml — filterable select", () => {
  const filterableDef: FormDefinition = {
    title: "Test",
    fields: [
      {
        type: "select",
        key: "proxyJumpHostId",
        label: "Jump Host Server",
        filterable: true,
        options: [
          { label: "Zeta host", value: "z" },
          { label: "alpha host", value: "a" },
          { label: "(Select jump host)", value: "" }
        ],
        value: ""
      }
    ]
  };

  it("emits a filter input with placeholder, aria-label and no name (so it is never submitted)", () => {
    const html = renderFormHtml(filterableDef);
    expect(html).toContain('class="custom-select-filter"');
    expect(html).toContain('placeholder="Type to filter…"');
    expect(html).toContain('aria-label="Filter Jump Host Server options"');
    // The filter input must carry no name — otherwise the submit loop would
    // post the filter text as a form value.
    const filterMatch = html.match(/<input type="text" class="custom-select-filter"[^>]*>/);
    expect(filterMatch).not.toBeNull();
    expect(filterMatch![0]).not.toContain("name=");
  });

  it("marks the wrapper filterable and renders the No matches row hidden", () => {
    const html = renderFormHtml(filterableDef);
    expect(html).toContain('class="custom-select filterable"');
    expect(html).toContain('<div class="custom-select-no-matches" style="display: none;">No matches</div>');
  });

  it("renders options sorted with the empty-value sentinel pinned (falsifies dropping the sort: declared order z,a,'' would render unchanged)", () => {
    const html = renderFormHtml(filterableDef);
    expect(renderedOptionOrder(html)).toEqual(["", "a", "z"]);
  });

  it("filters against label AND description via the option's full text (client rule lives in initCustomSelects)", () => {
    // The rendered dropdown carries the description text the client filter reads.
    const html = renderFormHtml({
      title: "Test",
      fields: [
        {
          type: "select",
          key: "authProfileId",
          label: "Auth Profile",
          filterable: true,
          options: [
            { label: "Prod", value: "p1", description: "root@prod" },
            { label: "(None)", value: "" }
          ],
          value: ""
        }
      ]
    });
    expect(html).toContain("root@prod");
  });
});

describe("renderFormHtml — non-filterable select is unchanged (default guard)", () => {
  const baseFields = (filterable: boolean): FormDefinition => ({
    title: "Test",
    fields: [
      {
        type: "select",
        key: "mode",
        label: "Mode",
        filterable: filterable || undefined,
        options: [
          { label: "Zeta", value: "z" },
          { label: "alpha", value: "a" }
        ],
        value: "z"
      }
    ]
  });

  it("emits no filter input and no filterable class when the flag is absent", () => {
    const html = renderFormHtml(baseFields(false));
    // Assert on the MARKUP form (class="…"), not bare substrings — the embedded
    // client script legitimately references `.custom-select-filter` as a
    // selector whether or not any select on the page is filterable.
    expect(html).not.toContain('class="custom-select-filter"');
    expect(html).not.toContain('class="custom-select-no-matches"');
    expect(html).toContain('class="custom-select"');
    expect(html).not.toContain('class="custom-select filterable"');
  });

  it("leaves a non-filterable select's options in DECLARED order (no sort applied)", () => {
    const html = renderFormHtml(baseFields(false));
    // Declared order preserved — the sort is filterable-only.
    expect(renderedOptionOrder(html)).toEqual(["z", "a"]);
  });

  it("renders byte-for-byte the pre-PR-F1 markup for a plain select (filterable branch cannot leak into the default)", () => {
    const html = renderFormHtml(baseFields(false));
    expect(html).toContain(`<div class="custom-select" id="field-mode" data-name="mode">
    <input type="hidden" name="mode" value="z" />
    <div class="custom-select-trigger" tabindex="0">
      <span class="custom-select-text">Zeta</span>
    </div>
    <div class="custom-select-dropdown">`);
  });
});

describe("renderFormHtml — filterable client wiring is present in the emitted script", () => {
  // The filter BEHAVIOR lives in initCustomSelects (webviewScripts.ts), which
  // the form-script harness stubs out — so these are smoke checks that the
  // wiring ships, not behavior tests. The behavior gap is noted in the commit.
  const html = renderFormHtml({ title: "Test", fields: [] });

  it("detects filterable selects by the filter input and always keeps the create affordance visible while filtering", () => {
    expect(html).toContain("var filterInput = wrapper.querySelector('.custom-select-filter');");
    expect(html).toContain("var show = isCreateOption(opt) ? true : match;");
  });

  it("wires keyboard nav on the filter input (Arrow highlight, Enter select, Esc close)", () => {
    expect(html).toContain("filterInput.addEventListener('keydown'");
    expect(html).toContain("if (target) chooseOption(target);");
    expect(html).toContain("setCustomSelectOpen(wrapper, false);");
  });

  it("shows the No matches row only when no real option matches and no create affordance exists", () => {
    expect(html).toContain("noMatches.style.display = (realVisible === 0 && !hasCreateOption) ? '' : 'none';");
  });
});
