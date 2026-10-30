import { describe, expect, it } from "vitest";
import { renderAuthProfileEditorHtml } from "../../src/ui/authProfileEditorHtml";
import { baseWebviewJs } from "../../src/ui/shared/webviewScripts";
import { StubElement } from "../helpers/formScriptHarness";

function select(id: string) {
  const html = renderAuthProfileEditorHtml([], null, "nonce");
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf('</div>\n    </div>', start);
  const markup = html.slice(start, end);
  const wrapper = new StubElement("DIV", ["custom-select"]);
  wrapper.dataset.selectOnly = /data-select-only="true"/.test(markup) ? "true" : undefined;
  const input = wrapper.append(new StubElement("INPUT")); input.type = "hidden";
  Object.assign(input, { dispatchEvent: (event: Event) => input.dispatch(event.type) });
  input.value = /<input[^>]*value="([^"]*)"/.exec(markup)![1];
  const triggerMarkup = /<div class="custom-select-trigger"[^>]*>/.exec(markup)![0];
  const trigger = wrapper.append(new StubElement("DIV", ["custom-select-trigger"]));
  for (const [, key, value] of triggerMarkup.matchAll(/(role|aria-[a-z-]+)="([^"]*)"/g)) trigger.setAttribute(key, value);
  const text = trigger.append(new StubElement("SPAN", ["custom-select-text"]));
  const dropdown = wrapper.append(new StubElement("DIV", ["custom-select-dropdown"]));
  for (const match of markup.matchAll(/<div class="custom-select-option([^\"]*)"([^>]*)>([^<]*)<\/div>/g)) {
    const option = dropdown.append(new StubElement("DIV", ["custom-select-option", ...match[1].split(" ").filter(Boolean)]));
    option.dataset.value = /data-value="([^"]*)"/.exec(match[2])![1]; option.textContent = match[3];
    Object.assign(option, { id: /\bid="([^"]*)"/.exec(match[2])?.[1] });
    if (option.classList.contains("selected")) text.textContent = option.textContent;
  }
  const document = { addEventListener() {}, querySelectorAll: (selector: string) => selector === ".custom-select" ? [wrapper] : [] };
  new Function("document", baseWebviewJs() + "\ninitCustomSelects();")(document);
  return { markup, wrapper, trigger, input, text, dropdown };
}

describe("auth editor select-only accessibility", () => {
  it.each(["external-method-selector", "authtype-selector"])("exposes %s as a labelled combobox with an owned listbox", (id) => {
    const h = select(id);
    expect(h.trigger.getAttribute("role")).toBe("combobox");
    expect(h.trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(h.trigger.getAttribute("aria-expanded")).toBe("false");
    const popup = h.trigger.getAttribute("aria-controls"); expect(popup).toBeTruthy();
    expect(h.markup).toContain(`id="${popup}" role="listbox"`);
    expect(h.markup).toContain('role="option" aria-selected="true"');
  });
  it("keeps focus on the trigger, announces active options, commits Enter and cancels Escape", () => {
    const h = select("external-method-selector");
    h.trigger.dispatchKey("keydown", "ArrowDown");
    expect(h.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(h.trigger.getAttribute("aria-activedescendant")).toBe("external-method-option-password");
    h.trigger.dispatchKey("keydown", "End");
    expect(h.trigger.getAttribute("aria-activedescendant")).toBe("external-method-option-key");
    expect(h.input.value).toBe("password");
    h.trigger.dispatchKey("keydown", "Enter");
    expect(h.input.value).toBe("key"); expect(h.text.textContent).toBe("Private Key");
    expect(h.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(h.trigger.getAttribute("aria-activedescendant")).toBeNull();
    h.trigger.dispatchKey("keydown", "ArrowUp"); h.trigger.dispatchKey("keydown", "Home");
    expect(h.trigger.getAttribute("aria-activedescendant")).toBe("external-method-option-password");
    h.trigger.dispatchKey("keydown", "Escape"); expect(h.input.value).toBe("key");
  });
});
