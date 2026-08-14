import { StubElement } from "./formScriptHarness";
import { renderHighlightRuleEditorHtml } from "../../src/ui/highlightRuleEditorHtml";
import type { HighlightRule } from "../../src/utils/highlightRuleValidation";

/* ────────────────────────────────────────────────────────────────────────
 * Executes the REAL rendered highlight-rule-editor script against a stub
 * DOM, built on the same `StubElement` primitive as formScriptHarness.ts
 * (see that file's header for why a stub DOM rather than a string-only test:
 * defects here live in the gap between what the row shows and what Stage
 * Rule/Apply actually writes, and a test that stops at either end cannot
 * see them).
 *
 * `baseWebviewJs()` (escapeHtml/selectCustomOption/initCustomSelects) is
 * emitted BEFORE the panel's own `(function() { ... })();` IIFE, so slicing
 * from that IIFE onward — exactly as formScriptHarness.ts's `openForm` does
 * for `renderFormHtml` — excludes those declarations from the executed
 * source. They are supplied here as `new Function(...)` parameters instead,
 * with the simplest correct stand-ins (selectCustomOption's shape copied
 * from the one openForm builds for the same reason).
 * ──────────────────────────────────────────────────────────────────────── */

export type PostedRuleEditorMessage =
  | { type: "saveRules"; rules: HighlightRule[] }
  | { type: "resetDefaults" };

function escapeHtmlStub(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Same shape as openForm's local reimplementation — the real selectCustomOption
// lives in baseWebviewJs() and is excluded from the sliced source (see header).
function selectCustomOptionStub(wrapper: StubElement, value: string): void {
  const hidden = wrapper.querySelector('input[type="hidden"]');
  const textEl = wrapper.querySelector(".custom-select-text");
  for (const option of wrapper.querySelectorAll(".custom-select-option")) {
    option.classList.remove("selected");
    if (option.dataset.value === value) {
      option.classList.add("selected");
      if (textEl) textEl.textContent = option.textContent;
    }
  }
  if (hidden) {
    hidden.value = value;
    hidden.dispatch("change");
    hidden.dispatch("input");
  }
}

function buildColorSelectWrapper(): { wrapper: StubElement; hidden: StubElement } {
  const wrapper = new StubElement("DIV", ["custom-select"]);
  const hidden = wrapper.append(new StubElement("INPUT"));
  hidden.type = "hidden";
  hidden.value = "red";
  const trigger = wrapper.append(new StubElement("DIV", ["custom-select-trigger"]));
  const text = trigger.append(new StubElement("SPAN", ["custom-select-text"]));
  text.textContent = "red";
  const dropdown = wrapper.append(new StubElement("DIV", ["custom-select-dropdown"]));
  for (const name of ["red", "yellow", "green", "magenta", "blue", "brightBlue", "cyan"]) {
    const opt = dropdown.append(new StubElement("DIV", ["custom-select-option"]));
    opt.dataset.value = name;
    opt.textContent = name;
  }
  return { wrapper, hidden };
}

function textInput(): StubElement {
  const el = new StubElement("INPUT");
  el.type = "text";
  return el;
}

function checkbox(checked = false): StubElement {
  const el = new StubElement("INPUT");
  el.type = "checkbox";
  el.checked = checked;
  return el;
}

function buildDom(): {
  document: unknown;
  window: { addEventListener: (type: string, handler: (event: { data: unknown }) => void) => void };
  byId: Map<string, StubElement>;
  deliverMessage: (msg: unknown) => void;
} {
  const byId = new Map<string, StubElement>();
  const set = (id: string, el: StubElement): StubElement => {
    byId.set(id, el);
    return el;
  };

  set("rules-list", new StubElement("DIV"));
  set("rules-empty-state", new StubElement("DIV"));
  set("add-rule-btn", new StubElement("BUTTON"));
  set("apply-rules-btn", new StubElement("BUTTON"));
  set("cancel-rules-btn", new StubElement("BUTTON"));
  set("rules-dirty-indicator", new StubElement("SPAN"));
  set("reset-defaults-btn", new StubElement("BUTTON"));
  set("save-error", new StubElement("DIV"));
  set("editor-section", new StubElement("DIV"));
  set("editor-title", new StubElement("H4"));
  set("edit-label", textInput());
  set("edit-description", textInput());
  set("edit-pattern", textInput());
  set("pattern-error", new StubElement("DIV"));
  set("edit-flag-g", checkbox());
  set("edit-flag-i", checkbox());
  set("edit-bold", checkbox());
  set("edit-underline", checkbox());
  set("preview-box", new StubElement("DIV"));
  set("save-rule-btn", new StubElement("BUTTON"));
  set("cancel-edit-btn", new StubElement("BUTTON"));
  set("delete-rule-btn", new StubElement("BUTTON"));

  const { wrapper, hidden } = buildColorSelectWrapper();
  set("color-select-wrapper", wrapper);
  set("edit-color", hidden);

  const document = {
    getElementById: (id: string): StubElement | null => byId.get(id) ?? null,
    querySelectorAll: (): StubElement[] => [],
    addEventListener: (): void => {},
    createElement: (tag: string): StubElement => new StubElement(tag.toUpperCase())
  };

  let messageHandler: ((event: { data: unknown }) => void) | undefined;
  const windowStub = {
    addEventListener: (type: string, handler: (event: { data: unknown }) => void): void => {
      if (type === "message") messageHandler = handler;
    }
  };

  return {
    document,
    window: windowStub,
    byId,
    deliverMessage: (msg: unknown): void => {
      if (!messageHandler) {
        throw new Error("highlight rule editor script never registered a message listener");
      }
      messageHandler({ data: msg });
    }
  };
}

export interface HighlightRuleEditorHarness {
  posted: PostedRuleEditorMessage[];
  rowCount: () => number;
  /** The `.rule-pattern` span's own text: the label when present, else the pattern. */
  rowLabel: (index: number) => string;
  /** The `.rule-pattern-secondary` child's text, or undefined when no label is set. */
  rowPatternSecondary: (index: number) => string | undefined;
  rowEnabled: (index: number) => boolean;
  /** Whether the row carries the `.rule-disabled` dimming class. */
  rowDimmed: (index: number) => boolean;
  toggleEnabled: (index: number) => void;
  clickUp: (index: number) => void;
  clickDown: (index: number) => void;
  clickEdit: (index: number) => void;
  clickDelete: (index: number) => void;
  clickAdd: () => void;
  setLabel: (value: string) => void;
  setDescription: (value: string) => void;
  setPattern: (value: string) => void;
  labelValue: () => string;
  descriptionValue: () => string;
  patternValue: () => string;
  stageRule: () => void;
  clickApply: () => void;
  editorVisible: () => boolean;
  isDirty: () => boolean;
  deliver: (msg: unknown) => void;
}

/** Executes the rendered highlight-rule-editor script (the panel IIFE) against the stub DOM. */
export function openHighlightRuleEditor(rules: HighlightRule[]): HighlightRuleEditorHarness {
  const html = renderHighlightRuleEditorHtml(rules, "nonce");
  const start = html.indexOf("(function() {");
  const end = html.indexOf("</script>");
  if (start < 0 || end < start) {
    throw new Error("could not locate the rendered highlight rule editor script");
  }
  const source = html.slice(start, end);

  const dom = buildDom();
  const posted: PostedRuleEditorMessage[] = [];

  const factory = new Function(
    "document",
    "window",
    "acquireVsCodeApi",
    "selectCustomOption",
    "initCustomSelects",
    "escapeHtml",
    source
  ) as (
    document: unknown,
    window: unknown,
    acquireVsCodeApi: () => { postMessage: (msg: PostedRuleEditorMessage) => void },
    selectCustomOption: (wrapper: StubElement, value: string) => void,
    initCustomSelects: (onOptionClick?: (wrapper: StubElement, opt: StubElement) => void) => void,
    escapeHtml: (str: string) => string
  ) => void;

  factory(
    dom.document,
    dom.window,
    () => ({ postMessage: (msg: PostedRuleEditorMessage) => posted.push(msg) }),
    selectCustomOptionStub,
    () => {},
    escapeHtmlStub
  );

  const row = (index: number): StubElement => {
    const list = dom.byId.get("rules-list")!;
    const el = list.children[index];
    if (!el) {
      throw new Error(`no rule row at index ${index}`);
    }
    return el;
  };

  const rowButton = (index: number, cls: string): StubElement => {
    const btn = row(index).querySelector(cls);
    if (!btn) {
      throw new Error(`no ${cls} on row ${index}`);
    }
    return btn;
  };

  const field = (id: string): StubElement => {
    const el = dom.byId.get(id);
    if (!el) {
      throw new Error(`no field #${id}`);
    }
    return el;
  };

  return {
    posted,
    rowCount: () => dom.byId.get("rules-list")!.children.length,
    rowLabel: (index) => row(index).querySelector(".rule-pattern")?.textContent ?? "",
    rowPatternSecondary: (index) => row(index).querySelector(".rule-pattern-secondary")?.textContent,
    rowEnabled: (index) => rowButton(index, ".rule-enabled-cb").checked,
    rowDimmed: (index) => row(index).classList.contains("rule-disabled"),
    toggleEnabled: (index) => {
      const cb = rowButton(index, ".rule-enabled-cb");
      cb.checked = !cb.checked;
      cb.bubble("change");
    },
    clickUp: (index) => rowButton(index, ".rule-up-btn").bubble("click"),
    clickDown: (index) => rowButton(index, ".rule-down-btn").bubble("click"),
    clickEdit: (index) => rowButton(index, ".rule-edit-btn").bubble("click"),
    clickDelete: (index) => rowButton(index, ".rule-delete-btn").bubble("click"),
    clickAdd: () => field("add-rule-btn").bubble("click"),
    setLabel: (value) => { field("edit-label").value = value; },
    setDescription: (value) => { field("edit-description").value = value; },
    setPattern: (value) => { field("edit-pattern").value = value; },
    labelValue: () => field("edit-label").value,
    descriptionValue: () => field("edit-description").value,
    patternValue: () => field("edit-pattern").value,
    stageRule: () => field("save-rule-btn").bubble("click"),
    clickApply: () => field("apply-rules-btn").bubble("click"),
    editorVisible: () => field("editor-section").classList.contains("visible"),
    isDirty: () => !field("apply-rules-btn").disabled,
    deliver: (msg) => dom.deliverMessage(msg)
  };
}
