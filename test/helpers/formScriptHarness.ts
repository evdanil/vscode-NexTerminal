import { expect } from "vitest";
import { renderFormHtml } from "../../src/ui/formHtml";
import type { ExtensionMessage, FormDefinition, FormMessage, FormValues } from "../../src/ui/formTypes";

/* ────────────────────────────────────────────────────────────────────────
 * A stub DOM, just wide enough to run the REAL rendered form script.
 *
 * WHY IT EXISTS — every defect in the auth-profile family has lived precisely
 * in the gap between what the webview showed and what the save path stored, so
 * a test that stops at either end cannot see it. The script under test is the
 * real one, sliced verbatim out of `renderFormHtml`'s output and executed, and
 * each caller supplies the real other end: the real mirrors answer the
 * autofills, and the real persist path takes the submission (see
 * authProfileSwitchTransition.test.ts for the server form, and
 * inventoryCommands.test.ts, which drives the real `nexus.inventory.*` commands
 * through it). Only the DOM is a stand-in (vitest runs `environment: "node"`
 * and jsdom is not a dependency — the same constraint macroEditorHtml.test.ts
 * records), and it is built from the same `FormDefinition` the renderer is
 * handed, mirroring `renderField`'s structure (ids, names, group nesting, the
 * file input's baseline `readonly`).
 * ──────────────────────────────────────────────────────────────────────── */

type DomEvent = { preventDefault: () => void; target?: StubElement };
type DomListener = (event?: DomEvent) => void;

export class StubElement {
  public readonly children: StubElement[] = [];
  public parentElement: StubElement | undefined;
  public readonly dataset: Record<string, string | undefined> = {};
  public readonly style: Record<string, string> = {};
  public value = "";
  public checked = false;
  public required = false;
  public disabled = false;
  public readOnly = false;
  public textContent = "";
  public title: string | undefined;
  public type: string | undefined;
  public name: string | undefined;
  /** Only ever set on the <form> stub; the script reads `form.elements`. */
  public elements: Record<string, StubElement | number> | undefined;
  private readonly classes: Set<string>;
  private readonly listeners = new Map<string, DomListener[]>();

  private innerHTMLValue = "";

  public constructor(public readonly tagName: string, classNames: string[] = []) {
    this.classes = new Set(classNames);
  }

  /**
   * Real callers only ever assign `innerHTML = ""` to clear a container before
   * re-rendering it (see `renderRulesList()`'s `list.innerHTML = "";`). That is
   * the one case reproduced here — mirroring the browser's side effect of
   * actually detaching the existing children — rather than a general HTML
   * parser.
   */
  public get innerHTML(): string {
    return this.innerHTMLValue;
  }

  public set innerHTML(value: string) {
    this.innerHTMLValue = value;
    if (value === "") {
      for (const child of this.children) {
        child.parentElement = undefined;
      }
      this.children.length = 0;
    }
  }

  /**
   * Additive: existing callers all use `classList.add`/`.remove`/`.toggle`,
   * which already mutate `classes` directly. This exists because
   * `renderRulesList()`'s `row.className = "rule-row" + (...)` — a plain DOM
   * `className` assignment — needs the same Set to back it, or `classList`
   * silently disagrees with what `className` was just set to.
   */
  public get className(): string {
    return Array.from(this.classes).join(" ");
  }

  public set className(value: string) {
    this.classes.clear();
    for (const cls of value.split(/\s+/).filter(Boolean)) {
      this.classes.add(cls);
    }
  }

  public get classList(): {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
    toggle: (name: string, force?: boolean) => void;
  } {
    const classes = this.classes;
    return {
      contains: (name: string) => classes.has(name),
      add: (name: string) => {
        classes.add(name);
      },
      remove: (name: string) => {
        classes.delete(name);
      },
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      }
    };
  }

  public append(child: StubElement): StubElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public appendChild(child: StubElement): StubElement {
    return this.append(child);
  }

  public insertBefore(child: StubElement, before: StubElement): StubElement {
    const index = this.children.indexOf(before);
    child.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }

  public querySelectorAll(selector: string): StubElement[] {
    const parts = selector.split(",").map((part) => part.trim()).filter(Boolean);
    const out: StubElement[] = [];
    for (const descendant of this.descendants()) {
      if (parts.some((part) => matchesSelector(descendant, part))) {
        out.push(descendant);
      }
    }
    return out;
  }

  public querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  public closest(selector: string): StubElement | null {
    let node: StubElement | undefined = this;
    while (node) {
      if (matchesSelector(node, selector)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /** No-op: nothing here asserts on focus, only that calling it doesn't throw. */
  public focus(): void {}

  public addEventListener(type: string, listener: DomListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  public dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  /**
   * Fires `type` starting at this element and bubbling up through
   * `parentElement` ancestors, invoking each ancestor's OWN listeners for
   * `type` with an event object whose `target` is this element — the shape a
   * delegated handler (`list.addEventListener("click", e => e.target.closest(...))`)
   * needs. Purely additive alongside `dispatch()` above: existing callers that
   * add a listener directly to the element they trigger (and ignore the event
   * argument) are unaffected.
   */
  public bubble(type: string): void {
    const event: DomEvent = { target: this, preventDefault: () => {} };
    let node: StubElement | undefined = this;
    while (node) {
      for (const listener of node.listeners.get(type) ?? []) {
        listener(event);
      }
      node = node.parentElement;
    }
  }

  private descendants(): StubElement[] {
    const out: StubElement[] = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }
}

function readAttribute(el: StubElement, name: string): string | undefined {
  if (name.startsWith("data-")) {
    const key = name.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
    return el.dataset[key];
  }
  if (name === "type") {
    return el.type;
  }
  if (name === "name") {
    return el.name;
  }
  return undefined;
}

/** Supports exactly the selector shapes the rendered script uses. */
function matchesSelector(el: StubElement, selector: string): boolean {
  const attrs: Array<{ name: string; op?: string; value?: string }> = [];
  const rest = selector.replace(/\[([a-zA-Z-]+)(?:(\^?=)"([^"]*)")?\]/g, (_match, name: string, op: string | undefined, value: string | undefined) => {
    attrs.push({ name, op, value });
    return "";
  });
  const [tag, ...classNames] = rest.split(".");
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) {
    return false;
  }
  for (const className of classNames.filter(Boolean)) {
    if (!el.classList.contains(className)) {
      return false;
    }
  }
  for (const attr of attrs) {
    const actual = readAttribute(el, attr.name);
    if (actual === undefined) {
      return false;
    }
    if (attr.value === undefined) {
      continue;
    }
    if (attr.op === "^=" ? !actual.startsWith(attr.value) : actual !== attr.value) {
      return false;
    }
  }
  return true;
}

interface FormDom {
  document: unknown;
  window: { addEventListener: (type: string, handler: (event: { data: ExtensionMessage }) => void) => void };
  form: StubElement;
  byId: Map<string, StubElement>;
  deliverMessage: (msg: ExtensionMessage) => void;
  submit: () => void;
}

/** Builds the DOM `renderField` would have produced for this definition. */
function buildFormDom(definition: FormDefinition): FormDom {
  const form = new StubElement("FORM");
  const byId = new Map<string, StubElement>();
  const controls: StubElement[] = [];

  const register = (key: string, el: StubElement): void => {
    byId.set(`field-${key}`, el);
  };

  for (const field of definition.fields) {
    if (field.type === "html") {
      const group = form.append(new StubElement("DIV", ["form-group", "form-illustration"]));
      if (field.visibleWhen) {
        group.dataset.visibleWhen = JSON.stringify(Array.isArray(field.visibleWhen) ? field.visibleWhen : [field.visibleWhen]);
      }
      continue;
    }
    if (field.type === "hidden") {
      const input = form.append(new StubElement("INPUT"));
      input.type = "hidden";
      input.name = field.key;
      input.value = field.value ?? "";
      register(field.key, input);
      controls.push(input);
      continue;
    }

    const group = form.append(new StubElement("DIV", ["form-group"]));
    if (field.visibleWhen) {
      group.dataset.visibleWhen = JSON.stringify(Array.isArray(field.visibleWhen) ? field.visibleWhen : [field.visibleWhen]);
    }

    switch (field.type) {
      case "select": {
        const wrapper = group.append(new StubElement("DIV", ["custom-select"]));
        wrapper.dataset.name = field.key;
        if (field.autofill) {
          wrapper.dataset.autofill = "true";
        }
        if (field.autofillFilledKeys && field.autofillFilledKeys.length > 0) {
          wrapper.dataset.autofillFilled = JSON.stringify(field.autofillFilledKeys);
        }
        if (field.autofillDisplacedValues && Object.keys(field.autofillDisplacedValues).length > 0) {
          wrapper.dataset.autofillDisplaced = JSON.stringify(field.autofillDisplacedValues);
        }
        const selectedValue = field.value ?? field.options[0]?.value ?? "";
        const hidden = wrapper.append(new StubElement("INPUT"));
        hidden.type = "hidden";
        hidden.name = field.key;
        hidden.value = selectedValue;
        const trigger = wrapper.append(new StubElement("DIV", ["custom-select-trigger"]));
        const text = trigger.append(new StubElement("SPAN", ["custom-select-text"]));
        text.textContent = (field.options.find((opt) => opt.value === selectedValue) ?? field.options[0])?.label ?? "";
        const dropdown = wrapper.append(new StubElement("DIV", ["custom-select-dropdown"]));
        for (const opt of field.options) {
          const option = dropdown.append(new StubElement("DIV", ["custom-select-option"]));
          option.dataset.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === selectedValue) {
            option.classList.add("selected");
          }
        }
        register(field.key, wrapper);
        controls.push(hidden);
        break;
      }
      case "file": {
        const row = group.append(new StubElement("DIV", ["file-input-row"]));
        const input = row.append(new StubElement("INPUT"));
        input.type = "text";
        input.name = field.key;
        input.value = field.value ?? "";
        // The rendered file input carries `readonly` — Browse/Clear own it.
        input.readOnly = true;
        const browse = row.append(new StubElement("BUTTON", ["browse-btn"]));
        browse.dataset.key = field.key;
        const clear = row.append(new StubElement("BUTTON", ["clear-btn"]));
        clear.dataset.key = field.key;
        register(field.key, input);
        controls.push(input);
        break;
      }
      case "checkbox": {
        const input = group.append(new StubElement("INPUT"));
        input.type = "checkbox";
        input.name = field.key;
        input.checked = field.value === true;
        register(field.key, input);
        controls.push(input);
        break;
      }
      case "number": {
        const input = group.append(new StubElement("INPUT"));
        input.type = "number";
        input.name = field.key;
        input.value = field.value === undefined ? "" : String(field.value);
        input.required = field.required === true;
        register(field.key, input);
        controls.push(input);
        break;
      }
      case "combobox": {
        const combo = group.append(new StubElement("DIV", ["custom-combobox"]));
        const input = combo.append(new StubElement("INPUT"));
        input.type = "text";
        input.name = field.key;
        input.value = field.value ?? "";
        input.required = field.required === true;
        register(field.key, input);
        controls.push(input);
        break;
      }
      case "textarea": {
        const input = group.append(new StubElement("TEXTAREA"));
        input.name = field.key;
        input.value = field.value ?? "";
        input.required = field.required === true;
        register(field.key, input);
        controls.push(input);
        break;
      }
      default: {
        const input = group.append(new StubElement("INPUT"));
        input.type = field.type === "password" ? "password" : "text";
        input.name = field.key;
        input.value = field.value ?? "";
        input.required = field.required === true;
        if (field.type === "text" && field.scannable) {
          const scan = group.append(new StubElement("BUTTON", ["scan-btn"]));
          scan.dataset.key = field.key;
        }
        register(field.key, input);
        controls.push(input);
        break;
      }
    }
    group.append(new StubElement("DIV", ["field-error"]));
  }

  const actions = form.append(new StubElement("DIV", ["actions"]));
  const saveBtn = actions.append(new StubElement("BUTTON"));
  saveBtn.type = "submit";
  const cancelBtn = actions.append(new StubElement("BUTTON"));
  byId.set("cancel-btn", cancelBtn);
  if (definition.testable) {
    const testBtn = actions.append(new StubElement("BUTTON"));
    if (definition.testableWhen) {
      testBtn.dataset.visibleWhen = JSON.stringify(
        Array.isArray(definition.testableWhen) ? definition.testableWhen : [definition.testableWhen]
      );
    }
    byId.set("test-btn", testBtn);
  }

  const elements: Record<string, StubElement | number> = { length: controls.length };
  controls.forEach((el, index) => {
    elements[String(index)] = el;
    if (el.name) {
      elements[el.name] = el;
    }
  });
  form.elements = elements;
  byId.set("nexus-form", form);

  let messageHandler: ((event: { data: ExtensionMessage }) => void) | undefined;
  let submitHandler: DomListener | undefined;
  const nativeAddEventListener = form.addEventListener.bind(form);
  form.addEventListener = (type: string, listener: DomListener): void => {
    if (type === "submit") {
      submitHandler = listener;
      return;
    }
    nativeAddEventListener(type, listener);
  };

  const document = {
    getElementById: (id: string): StubElement | null => byId.get(id) ?? null,
    querySelectorAll: (selector: string): StubElement[] => form.querySelectorAll(selector),
    addEventListener: (): void => {},
    createElement: (tag: string): StubElement => new StubElement(tag.toUpperCase())
  };

  return {
    document,
    window: {
      addEventListener: (type: string, handler: (event: { data: ExtensionMessage }) => void): void => {
        if (type === "message") {
          messageHandler = handler;
        }
      }
    },
    form,
    byId,
    deliverMessage: (msg: ExtensionMessage): void => {
      if (!messageHandler) {
        throw new Error("form script never registered a message listener");
      }
      messageHandler({ data: msg });
    },
    submit: (): void => {
      if (!submitHandler) {
        throw new Error("form script never registered a submit listener");
      }
      submitHandler({ preventDefault: () => {} });
    }
  };
}

export interface FormHarness {
  posted: FormMessage[];
  /** Clicks an option in a custom select, exactly as the dropdown handler does. */
  choose: (key: string, value: string) => void;
  deliver: (msg: ExtensionMessage) => void;
  submit: () => FormValues;
  value: (key: string) => string;
  locked: (key: string) => boolean;
  selectLabel: (key: string) => string;
  /** Types into a field, refusing if the form has it locked. */
  type: (key: string, value: string) => void;
  /** The Browse dialog's answer — the only way to change a file field. */
  browseResult: (key: string, path: string) => void;
}

/** Executes the rendered form script (the panel IIFE) against the stub DOM. */
export function openForm(definition: FormDefinition): FormHarness {
  const html = renderFormHtml(definition, "nonce");
  const start = html.indexOf("(function() {");
  const end = html.indexOf("</script>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const source = html.slice(start, end);

  const dom = buildFormDom(definition);
  const posted: FormMessage[] = [];
  let optionClick: ((wrapper: StubElement, option: StubElement) => void) | undefined;

  // The real `selectCustomOption` from webviewScripts.ts, including the change
  // and input events it dispatches — those are what re-run updateVisibility
  // when a restored authType changes which fields are shown at all.
  const selectCustomOption = (wrapper: StubElement, value: string): void => {
    const hidden = wrapper.querySelector('input[type="hidden"]');
    const textEl = wrapper.querySelector(".custom-select-text");
    for (const option of wrapper.querySelectorAll(".custom-select-option")) {
      option.classList.remove("selected");
      if (option.dataset.value === value) {
        option.classList.add("selected");
        if (textEl) {
          textEl.textContent = option.textContent;
        }
      }
    }
    if (hidden) {
      hidden.value = value;
      hidden.dispatch("change");
      hidden.dispatch("input");
    }
  };

  const factory = new Function(
    "document",
    "window",
    "acquireVsCodeApi",
    "selectCustomOption",
    "initCustomSelects",
    "initCustomComboboxes",
    source
  ) as (
    document: unknown,
    window: unknown,
    acquireVsCodeApi: () => { postMessage: (msg: FormMessage) => void },
    selectCustomOption: (wrapper: StubElement, value: string) => void,
    initCustomSelects: (cb: (wrapper: StubElement, option: StubElement) => void) => void,
    initCustomComboboxes: () => void
  ) => void;

  factory(
    dom.document,
    dom.window,
    () => ({ postMessage: (msg: FormMessage) => posted.push(msg) }),
    selectCustomOption,
    (cb) => {
      optionClick = cb;
    },
    () => {}
  );

  const control = (key: string): StubElement => {
    const el = dom.form.elements?.[key];
    if (!el || typeof el === "number") {
      throw new Error(`no control named ${key}`);
    }
    return el;
  };

  return {
    posted,
    choose: (key, value) => {
      const wrapper = dom.byId.get(`field-${key}`);
      if (!wrapper) {
        throw new Error(`no select ${key}`);
      }
      const option = wrapper.querySelectorAll(".custom-select-option").find((opt) => opt.dataset.value === value);
      if (!option) {
        throw new Error(`no option ${value} on ${key}`);
      }
      if (!optionClick) {
        throw new Error("form script never wired initCustomSelects");
      }
      optionClick(wrapper, option);
    },
    deliver: dom.deliverMessage,
    submit: () => {
      dom.submit();
      const last = posted[posted.length - 1];
      if (!last || last.type !== "submit") {
        throw new Error("submit did not post values");
      }
      return last.values;
    },
    value: (key) => control(key).value,
    locked: (key) => {
      const el = dom.byId.get(`field-${key}`);
      if (!el) {
        throw new Error(`no field ${key}`);
      }
      // A locked field is dimmed and read-only; the file input is read-only at
      // baseline, so opacity is what separates "locked by the profile" from
      // "Browse owns this control". A custom select is dimmed on its trigger,
      // which is also what stops it being opened.
      const dimmed = el.classList.contains("custom-select")
        ? el.querySelector(".custom-select-trigger")
        : el;
      return dimmed?.style.opacity === "0.6";
    },
    selectLabel: (key) => dom.byId.get(`field-${key}`)?.querySelector(".custom-select-text")?.textContent ?? "",
    type: (key, value) => {
      const el = control(key);
      if (el.readOnly) {
        throw new Error(`field ${key} is read-only — the user could not have typed this`);
      }
      el.value = value;
      el.dispatch("input");
      el.dispatch("change");
    },
    browseResult: (key, path) => dom.deliverMessage({ type: "browseResult", key, path })
  };
}
