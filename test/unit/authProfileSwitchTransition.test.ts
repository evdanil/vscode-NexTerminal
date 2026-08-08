import { describe, expect, it, vi } from "vitest";
import { renderFormHtml } from "../../src/ui/formHtml";
import { inventorySourceFormDefinition, serverFormDefinition } from "../../src/ui/formDefinitions";
import type { ExtensionMessage, FormDefinition, FormMessage, FormValues } from "../../src/ui/formTypes";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { authProfileOwnedCredentials } from "../../src/models/config";
import type { InventoryProvider } from "../../src/models/inventory";
import {
  authProfileCredentialMirror,
  formValuesToServer,
  preserveLinkedServerCredentials
} from "../../src/commands/serverCommands";
import { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import type { PasswordPrompt, SecretVault, SshConnection, SshConnector } from "../../src/services/ssh/contracts";

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn()
  },
  window: {
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    withProgress: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
    activeTerminal: undefined as unknown
  },
  env: { clipboard: { writeText: vi.fn() } },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) }))
  },
  Uri: { file: (path: string) => ({ fsPath: path, scheme: "file" }) },
  ProgressLocation: { Notification: 15 },
  TerminalLocation: { Editor: 2, Panel: 1 },
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(
      public readonly id: string,
      public readonly color?: unknown
    ) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  }
}));

/* ────────────────────────────────────────────────────────────────────────
 * A stub DOM, just wide enough to run the REAL rendered form script.
 *
 * REVIEW FINDING (P2) — the bug this file guards lived precisely in the gap
 * between what the webview showed and what the save path stored, so a test
 * that stops at either end cannot see it. The script under test is the real
 * one, sliced verbatim out of `renderFormHtml`'s output and executed; the
 * autofill answers are the real `authProfileCredentialMirror`; the save is the
 * real `formValuesToServer` + `preserveLinkedServerCredentials`; the
 * connection is the real `SilentAuthSshFactory`. Only the DOM is a stand-in
 * (vitest runs `environment: "node"` and jsdom is not a dependency — the same
 * constraint macroEditorHtml.test.ts records), and it is built from the same
 * `FormDefinition` the renderer is handed, mirroring `renderField`'s structure
 * (ids, names, group nesting, the file input's baseline `readonly`).
 * ──────────────────────────────────────────────────────────────────────── */

type DomListener = (event?: { preventDefault: () => void }) => void;

class StubElement {
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
  public type: string | undefined;
  public name: string | undefined;
  /** Only ever set on the <form> stub; the script reads `form.elements`. */
  public elements: Record<string, StubElement | number> | undefined;
  private readonly classes: Set<string>;
  private readonly listeners = new Map<string, DomListener[]>();

  public constructor(public readonly tagName: string, classNames: string[] = []) {
    this.classes = new Set(classNames);
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

interface FormHarness {
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
function openForm(definition: FormDefinition): FormHarness {
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

/**
 * The extension side of the autofill round trip, as `WebviewFormPanel` runs it:
 * the real mirror answers, and `undefined` (an id that resolves to no profile)
 * suppresses the `fillFields` reply entirely.
 */
function answerAutofill(harness: FormHarness, profiles: AuthProfile[]): void {
  const autofill = [...harness.posted].reverse().find((msg) => msg.type === "autofill");
  if (!autofill || autofill.type !== "autofill") {
    throw new Error("no autofill was posted");
  }
  const values = authProfileCredentialMirror(profiles.find((p) => p.id === autofill.value));
  if (values) {
    harness.deliver({ type: "fillFields", key: autofill.key, values });
  }
}

/** Pick a profile from the list and let its mirror answer. */
function pickProfile(harness: FormHarness, profiles: AuthProfile[], profileId: string): void {
  harness.choose("authProfileId", profileId);
  if (profileId !== "") {
    answerAutofill(harness, profiles);
  }
}

/* ── the save path, verbatim from nexus.server.edit's onSubmit ───────────── */
function saveServerEdit(existing: ServerConfig, values: FormValues, profiles: AuthProfile[]): ServerConfig {
  const candidate = formValuesToServer(values, existing.id, existing.isHidden);
  if (!candidate) {
    throw new Error("the form's values were refused by formValuesToServer");
  }
  const linked = candidate.authProfileId ? profiles.find((p) => p.id === candidate.authProfileId) : undefined;
  return preserveLinkedServerCredentials(existing, candidate, linked);
}

/* ── the connect path ────────────────────────────────────────────────────── */
async function resolveForConnect(server: ServerConfig, profiles: AuthProfile[]): Promise<ServerConfig> {
  const connection = {
    openShell: vi.fn(),
    openDirectTcp: vi.fn(),
    openSftp: vi.fn(),
    exec: vi.fn(),
    requestForwardIn: vi.fn(),
    cancelForwardIn: vi.fn(),
    onTcpConnection: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    getBanner: vi.fn(() => undefined),
    dispose: vi.fn()
  } as unknown as SshConnection;
  const connector: SshConnector = { connect: vi.fn(async () => connection) };
  const vault: SecretVault = {
    get: vi.fn(async () => undefined),
    store: vi.fn(async () => {}),
    delete: vi.fn(async () => {})
  };
  // Reached only by a password server with no saved secret; answering keeps the
  // flow on the path that calls the connector, which is what this reads back.
  const prompt: PasswordPrompt = { prompt: vi.fn(async () => ({ password: "typed", save: false })) };
  const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, (id: string) =>
    profiles.find((p) => p.id === id)
  );
  await factory.connect(server);
  const call = vi.mocked(connector.connect).mock.calls[0];
  return call[0];
}

const KEY_PROFILE: AuthProfile = {
  id: "ap-key",
  name: "Datacenter key",
  username: "dcuser",
  authType: "key",
  keyPath: "/keys/datacenter_ed25519"
};
const KEYLESS_PROFILE: AuthProfile = {
  id: "ap-keyless",
  name: "Shared key (bring your own)",
  username: "shared",
  authType: "key"
};
const PASSWORD_PROFILE: AuthProfile = {
  id: "ap-pass",
  name: "Lab password",
  username: "labuser",
  authType: "password"
};
const PROFILES = [KEY_PROFILE, KEYLESS_PROFILE, PASSWORD_PROFILE];

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Core switch",
    host: "10.0.0.1",
    port: 22,
    username: "my-own-account",
    authType: "key",
    keyPath: "/home/me/.ssh/my_own_key",
    isHidden: false,
    ...overrides
  };
}

function openServerForm(server: ServerConfig, profiles: AuthProfile[] = PROFILES): FormHarness {
  return openForm(serverFormDefinition(server, [], true, [], profiles));
}

describe("an auth-profile switch hands back the values the previous profile displaced", () => {
  describe("end to end — form, persisted record, resolved connect config", () => {
    it("keeps the server's own key path when a key profile that carries none replaces one that did (THE REPORTED SCENARIO: without the restore the first profile's private key is saved onto the server as its own and used by the connection, from a field that shows it unlocked as though the user had chosen it)", async () => {
      const server = makeServer();
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");
      expect(harness.locked("keyPath")).toBe(true);

      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);

      // What the form shows: the server's own key path, editable again, because
      // the profile now linked supplies none.
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");
      expect(harness.locked("keyPath")).toBe(false);
      // …and the username IS supplied, so it stays mirrored and locked.
      expect(harness.value("username")).toBe("shared");
      expect(harness.locked("username")).toBe(true);

      // What a Save persists.
      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.authProfileId).toBe(KEYLESS_PROFILE.id);

      // What the connection then uses.
      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.keyPath).toBe("/home/me/.ssh/my_own_key");
      expect(resolved.username).toBe("shared");
      expect(resolved.authType).toBe("key");

      // The three layers agree: the field the user was left looking at is the
      // one that was stored and the one the connection dials with.
      expect(harness.value("keyPath")).toBe(persisted.keyPath);
      expect(persisted.keyPath).toBe(resolved.keyPath);
    });

    it("hands every credential back when the profile is set to (None), so an unlink cannot make the server adopt credentials it never had (kills leaving the outgoing profile's values in the now-unlinked fields: nothing downstream restores them — preserveLinkedServerCredentials only acts on a LINKED record)", async () => {
      const server = makeServer({ authType: "password", keyPath: undefined, username: "my-own-account" });
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("username")).toBe("dcuser");
      expect(harness.value("authType")).toBe("key");
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");

      harness.choose("authProfileId", "");

      expect(harness.value("username")).toBe("my-own-account");
      expect(harness.value("authType")).toBe("password");
      expect(harness.locked("username")).toBe(false);

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.authProfileId).toBeUndefined();
      expect(persisted.username).toBe("my-own-account");
      expect(persisted.authType).toBe("password");
      expect(persisted.keyPath).toBeUndefined();

      const resolved = await resolveForConnect(persisted, PROFILES);
      expect(resolved.username).toBe("my-own-account");
      expect(resolved.authType).toBe("password");
      expect(resolved.keyPath).toBeUndefined();
    });
  });

  describe("every kind of transition releases what the profile displaced", () => {
    it("releases on an inline-created profile injected into the open form, exactly as on a picked one (kills leaving the addSelectOption path resetting ownership without restoring values — the new profile's fill lands on top of the old one's leftovers)", () => {
      const server = makeServer();
      const created: AuthProfile = { id: "ap-new", name: "Just created", username: "fresh", authType: "key" };
      const profiles = [...PROFILES, created];
      const harness = openServerForm(server, PROFILES);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");

      // What `WebviewFormPanel.addSelectOption` posts after an inline create.
      harness.deliver({ type: "addSelectOption", key: "authProfileId", value: created.id, label: created.name });
      answerAutofill(harness, profiles);

      expect(harness.value("username")).toBe("fresh");
      expect(harness.locked("username")).toBe(true);
      // The created profile carries no key path, so the server's own comes back.
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");
      expect(harness.locked("keyPath")).toBe(false);

      const persisted = saveServerEdit(server, harness.submit(), profiles);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
    });

    it("hands back the value as it was immediately before the LAST fill, so an edit made between two selections survives (kills snapshotting once at form open: that restores the value the form was opened with and silently discards the browse the user did in between)", () => {
      const server = makeServer();
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");

      // A profile that supplies no key path — the field unlocks holding the
      // server's own value again.
      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/home/me/.ssh/my_own_key");

      // The user browses to a different key while the field is unlocked.
      harness.browseResult("keyPath", "/home/me/.ssh/picked_by_hand");

      // Another profile that DOES supply one, then off it again.
      pickProfile(harness, PROFILES, KEY_PROFILE.id);
      expect(harness.value("keyPath")).toBe("/keys/datacenter_ed25519");
      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);

      expect(harness.value("keyPath")).toBe("/home/me/.ssh/picked_by_hand");

      const persisted = saveServerEdit(server, harness.submit(), PROFILES);
      expect(persisted.keyPath).toBe("/home/me/.ssh/picked_by_hand");
    });

    it("restores the visible label of a custom select, not just the value the form submits (kills writing only the hidden input: the Authentication control would keep reading as the profile that is no longer selected while submitting something else)", () => {
      const harness = openServerForm(makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" }));

      expect(harness.selectLabel("authType")).toBe("Private Key");
      pickProfile(harness, PROFILES, PASSWORD_PROFILE.id);
      expect(harness.value("authType")).toBe("password");
      expect(harness.selectLabel("authType")).toBe("Password");

      harness.choose("authProfileId", "");

      expect(harness.value("authType")).toBe("key");
      expect(harness.selectLabel("authType")).toBe("Private Key");
    });

    it("re-shows a field the restored authType makes relevant again (kills leaving visibility settled on the released profile's authType — the key path control would stay hidden and its value would be dropped from the submission)", () => {
      const server = makeServer({ authType: "key", keyPath: "/home/me/.ssh/my_own_key" });
      const harness = openServerForm(server);

      // A password profile hides the key path field entirely…
      pickProfile(harness, PROFILES, PASSWORD_PROFILE.id);
      expect(harness.submit().keyPath).toBeUndefined();

      // …and going back to (None) restores authType `key`, so it comes back
      // with the server's own value and is submitted again.
      harness.choose("authProfileId", "");
      const values = harness.submit();
      expect(values.authType).toBe("key");
      expect(values.keyPath).toBe("/home/me/.ssh/my_own_key");

      const persisted = saveServerEdit(server, values, PROFILES);
      expect(persisted.keyPath).toBe("/home/me/.ssh/my_own_key");
    });

    it("does not write a key the profile supplied BLANK, which owns nothing and so would never be handed back (kills applying a fill payload verbatim: the user's own username is replaced by whitespace in an unlocked field, and the save is then refused for a required field nobody emptied)", () => {
      const server = makeServer();
      const harness = openServerForm(server);

      // A payload no current mirror sends — defence in depth against one that
      // hands the profile's username over unfiltered (an imported profile can
      // carry a whitespace-only one).
      harness.choose("authProfileId", KEY_PROFILE.id);
      harness.deliver({ type: "fillFields", key: "authProfileId", values: { username: "   ", authType: "key" } });

      expect(harness.value("username")).toBe("my-own-account");
      expect(harness.locked("username")).toBe(false);
      expect(harness.value("authType")).toBe("key");
      expect(harness.locked("authType")).toBe(true);
      expect(harness.submit().username).toBe("my-own-account");
    });

    it("leaves another autofill-capable select's answer alone — it fills, but takes no ownership and displaces nothing (kills applying the profile's rules to every fill: a foreign answer would seize the lock from the profile, and its value would then be thrown away by the next release)", () => {
      const server = makeServer();
      const harness = openServerForm(server);

      pickProfile(harness, PROFILES, KEYLESS_PROFILE.id);
      expect(harness.locked("username")).toBe(true);

      harness.deliver({ type: "fillFields", key: "someOtherSelect", values: { keyPath: "/from/another/select" } });

      // Filled as any autofill fills…
      expect(harness.value("keyPath")).toBe("/from/another/select");
      // …but the profile's ownership is untouched: it owns the username it
      // supplied, and still does not own the key path it did not.
      expect(harness.locked("keyPath")).toBe(false);
      expect(harness.locked("username")).toBe(true);

      // And nothing recorded the foreign answer as something a profile
      // displaced, so releasing the profile leaves it exactly where it is.
      harness.choose("authProfileId", "");
      expect(harness.value("keyPath")).toBe("/from/another/select");
      expect(harness.value("username")).toBe("my-own-account");
    });
  });

  describe("the inventory source form releases its one managed field too", () => {
    const provider: InventoryProvider = {
      id: "fake",
      label: "Fake Provider",
      configFields: [],
      testConnection: async () => undefined,
      fetchInventory: async () => ({ nodes: [] }) as never
    };

    /** `authProfileUsernameMirror` (inventoryCommands.ts), which is not
     *  exported — rebuilt here from the same shared rule it reads. */
    function usernameMirror(profile: AuthProfile | undefined): Record<string, string> | undefined {
      if (!profile) {
        return undefined;
      }
      const username = authProfileOwnedCredentials(profile).username;
      return username !== undefined ? { defaultUsername: username } : {};
    }

    it("hands the source's own default username back on (None) (kills leaving the profile's username in the field: with no profile linked the source save stores whatever was submitted, so the source silently adopts the username of a profile it is no longer using)", () => {
      const harness = openForm(
        inventorySourceFormDefinition(
          provider,
          {
            id: "src-1",
            providerId: "fake",
            name: "Fake",
            targetFolder: "",
            prunePolicy: "orphan",
            defaultUsername: "source-own-account",
            config: {},
            secretFieldIds: []
          },
          undefined,
          PROFILES
        )
      );

      harness.choose("authProfileId", PASSWORD_PROFILE.id);
      harness.deliver({ type: "fillFields", key: "authProfileId", values: usernameMirror(PASSWORD_PROFILE)! });
      expect(harness.value("defaultUsername")).toBe("labuser");
      expect(harness.locked("defaultUsername")).toBe(true);

      harness.choose("authProfileId", "");

      expect(harness.value("defaultUsername")).toBe("source-own-account");
      expect(harness.locked("defaultUsername")).toBe(false);
      expect(harness.submit().defaultUsername).toBe("source-own-account");
    });

    it("keeps an edit the user makes while the field is unlocked, then hands THAT back (kills a form-open snapshot on the source form as well)", () => {
      const harness = openForm(
        inventorySourceFormDefinition(provider, undefined, "most-common-account", PROFILES)
      );

      // The Add form's only "original" is the prefilled mostCommonUsername.
      expect(harness.value("defaultUsername")).toBe("most-common-account");
      harness.type("defaultUsername", "typed-by-hand");

      harness.choose("authProfileId", PASSWORD_PROFILE.id);
      harness.deliver({ type: "fillFields", key: "authProfileId", values: usernameMirror(PASSWORD_PROFILE)! });
      expect(harness.value("defaultUsername")).toBe("labuser");

      harness.choose("authProfileId", "");
      expect(harness.value("defaultUsername")).toBe("typed-by-hand");
    });
  });
});
