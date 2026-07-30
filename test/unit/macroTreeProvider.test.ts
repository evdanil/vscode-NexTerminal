import { describe, expect, it, vi, beforeEach } from "vitest";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(function () {
    const listeners: Array<(e: unknown) => void> = [];
    return {
      event: (listener: (e: unknown) => void) => { listeners.push(listener); },
      fire: (e: unknown) => { for (const l of listeners) { l(e); } },
      _listeners: listeners
    };
  });
  return {
    TreeItem: class {
      label?: string;
      id?: string;
      description?: string;
      contextValue?: string;
      command?: unknown;
      tooltip?: string;
      iconPath?: unknown;
      collapsibleState?: number;
      constructor(label: string, collapsibleState?: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(public id: string) {} },
    EventEmitter,
    workspace: {
      getConfiguration: vi.fn()
    }
  };
});

import { MacroTreeProvider, MacroTreeItem, VARIABLE_MARKER } from "../../src/ui/macroTreeProvider";
import * as vscode from "vscode";

let testStore: InMemoryMacroStore;

describe("MacroTreeItem", () => {
  it("shows binding label when displayBinding is provided", () => {
    const macro = { name: "Hello", text: "echo hello" };
    const item = new MacroTreeItem(macro, 0, "alt+1");
    expect(item.label).toBe("[Alt+1] Hello");

    const item2 = new MacroTreeItem(macro, 1, "alt+shift+m");
    expect(item2.label).toBe("[Alt+Shift+M] Hello");

    const item3 = new MacroTreeItem(macro, 2, "ctrl+shift+5");
    expect(item3.label).toBe("[Ctrl+Shift+5] Hello");
  });

  it("shows plain name when displayBinding is undefined", () => {
    const macro = { name: "Hello", text: "echo hello" };
    const item = new MacroTreeItem(macro, 5);
    expect(item.label).toBe("Hello");
  });

  it("includes binding hint in tooltip when displayBinding is provided", () => {
    const macro = { name: "Test", text: "echo test" };
    const item = new MacroTreeItem(macro, 0, "alt+3");
    expect(item.tooltip).toBe("Test (Alt+3)\necho test");
  });

  it("no binding hint in tooltip when displayBinding is undefined", () => {
    const macro = { name: "Test", text: "echo test" };
    const item = new MacroTreeItem(macro, 0);
    expect(item.tooltip).toBe("Test\necho test");
  });

  it("truncates description at ~40 chars and replaces newlines with ↵", () => {
    const shortMacro = { name: "Short", text: "echo hi" };
    const shortItem = new MacroTreeItem(shortMacro, 0);
    expect(shortItem.description).toBe("\u2192 echo hi");

    const longMacro = { name: "Long", text: "a".repeat(50) };
    const longItem = new MacroTreeItem(longMacro, 0);
    expect(longItem.description).toBe(`\u2192 ${"a".repeat(37)}...`);

    const newlineMacro = { name: "NL", text: "line1\nline2\nline3" };
    const nlItem = new MacroTreeItem(newlineMacro, 0);
    expect(nlItem.description).toBe("\u2192 line1\u21b5line2\u21b5line3");
  });

  it("masks description for secret macros", () => {
    const macro = { name: "Secret", text: "password123", secret: true };
    const item = new MacroTreeItem(macro, 0);
    expect(item.description).toBe("\u2022\u2022\u2022\u2022\u2022");
  });

  it("shows (secret) in tooltip for secret macros", () => {
    const macro = { name: "Secret", text: "password123", secret: true };
    const item = new MacroTreeItem(macro, 0, "alt+3");
    expect(item.tooltip).toBe("Secret (Alt+3) (secret)");
  });

  it("uses lock icon for secret macros", () => {
    const macro = { name: "Secret", text: "password123", secret: true };
    const item = new MacroTreeItem(macro, 0);
    expect((item.iconPath as { id: string }).id).toBe("lock");
  });

  it("uses terminal icon for non-secret macros", () => {
    const macro = { name: "Normal", text: "echo hi" };
    const item = new MacroTreeItem(macro, 0);
    expect((item.iconPath as { id: string }).id).toBe("terminal");
  });

  it("uses zap icon for macros with active triggerPattern", () => {
    const macro = { name: "Auto", text: "yes\n", triggerPattern: "Continue\\?" };
    const item = new MacroTreeItem(macro, 0, undefined, false);
    expect((item.iconPath as { id: string }).id).toBe("zap");
    expect(item.contextValue).toBe("nexus.macro.triggered");
  });

  it("uses circle-slash icon for disabled triggers", () => {
    const macro = { name: "Auto", text: "yes\n", triggerPattern: "Continue\\?" };
    const item = new MacroTreeItem(macro, 0, undefined, true);
    expect((item.iconPath as { id: string }).id).toBe("circle-slash");
    expect(item.contextValue).toBe("nexus.macro.triggered.disabled");
  });

  it("includes trigger state in tooltip", () => {
    const macro = { name: "Auto", text: "yes\n", triggerPattern: "Continue\\?" };
    const active = new MacroTreeItem(macro, 0, undefined, false);
    expect(active.tooltip).toContain("(active)");
    const paused = new MacroTreeItem(macro, 0, undefined, true);
    expect(paused.tooltip).toContain("(paused)");
  });

  it("includes trigger interval in tooltip when configured", () => {
    const macro = { name: "Auto", text: "show\n", triggerPattern: "router#", triggerInterval: 10 };
    const item = new MacroTreeItem(macro, 0, undefined, false);
    expect(item.tooltip).toContain("every 10s");
  });

  it("sets contextValue to nexus.macro for regular items", () => {
    const item = new MacroTreeItem({ name: "Test", text: "test" }, 0);
    expect(item.contextValue).toBe("nexus.macro");
  });

  it("sets contextValue to nexus.macro.secret for secret macros", () => {
    const item = new MacroTreeItem({ name: "Pwd", text: "pass", secret: true }, 0);
    expect(item.contextValue).toBe("nexus.macro.secret");
  });

  it("sets contextValue to nexus.macro.secret.triggered for secret triggered macros", () => {
    const macro = { name: "Auto", text: "pass\n", secret: true, triggerPattern: "Password:" };
    const item = new MacroTreeItem(macro, 0, undefined, false);
    expect(item.contextValue).toBe("nexus.macro.secret.triggered");
  });

  it("sets contextValue to nexus.macro.secret.triggered.disabled for secret disabled triggered macros", () => {
    const macro = { name: "Auto", text: "pass\n", secret: true, triggerPattern: "Password:" };
    const item = new MacroTreeItem(macro, 0, undefined, true);
    expect(item.contextValue).toBe("nexus.macro.secret.triggered.disabled");
  });

  it("wires click command to nexus.macro.runItem", () => {
    const item = new MacroTreeItem({ name: "Test", text: "test" }, 5, "alt+6");
    expect(item.command).toEqual({
      command: "nexus.macro.runItem",
      title: "Run Macro",
      arguments: [item]
    });
  });

  describe("variables (§9.6, §6.3)", () => {
    it("tooltip lists the variable names actually used, as 'Prompts for:'", () => {
      const macro = {
        name: "IPMI",
        text: "ipmitool -H $host -U $username -P $password sol activate\n",
        variables: [
          { name: "host" },
          { name: "username" },
          { name: "password", secret: true },
          { name: "unused" }
        ]
      };
      const item = new MacroTreeItem(macro, 0);
      expect(item.tooltip).toContain("Prompts for: host, username, password");
      expect(item.tooltip).not.toContain("unused");
    });

    it("secret macro tooltip still hides the text, even with variables declared", () => {
      const macro = {
        name: "IPMI",
        text: "sekrit-text $host",
        secret: true,
        variables: [{ name: "host" }]
      };
      const item = new MacroTreeItem(macro, 0);
      expect(item.tooltip).not.toContain("sekrit-text");
      expect(item.tooltip).toContain("(secret)");
      expect(item.tooltip).toContain("Prompts for: host");
    });

    it("uses the symbol-parameter icon and leaves contextValue unchanged for variable macros", () => {
      const macro = { name: "IPMI", text: "$host", variables: [{ name: "host" }] };
      const item = new MacroTreeItem(macro, 0);
      expect((item.iconPath as { id: string }).id).toBe("symbol-parameter");
      expect(item.contextValue).toBe("nexus.macro");
    });

    it("uses the symbol-parameter icon for a secret variable macro but keeps the secret contextValue", () => {
      const macro = { name: "IPMI", text: "$host", secret: true, variables: [{ name: "host" }] };
      const item = new MacroTreeItem(macro, 0);
      expect((item.iconPath as { id: string }).id).toBe("symbol-parameter");
      expect(item.contextValue).toBe("nexus.macro.secret");
    });

    it("uses the plain terminal icon (not symbol-parameter) for a declared-but-unused variable — it sends immediately (§9.6 fix)", () => {
      const macro = { name: "IPMI", text: "hi", variables: [{ name: "host" }] };
      const item = new MacroTreeItem(macro, 0);
      expect((item.iconPath as { id: string }).id).toBe("terminal");
    });

    it("marks the description with the variable marker only when the macro will actually prompt", () => {
      // Bug this pins: a macro declaring `host` whose text never references
      // `$host` gets marked but sends immediately on click — the marker must
      // key off scanPlaceholders (§9.6), never off the raw `variables` shape.
      const promptingMacro = { name: "IPMI", text: "run $host", variables: [{ name: "host" }] };
      const promptingItem = new MacroTreeItem(promptingMacro, 0);
      expect(promptingItem.description).toContain(VARIABLE_MARKER.trim());

      const nonPromptingMacro = { name: "IPMI", text: "hi", variables: [{ name: "host" }] };
      const nonPromptingItem = new MacroTreeItem(nonPromptingMacro, 0);
      expect(nonPromptingItem.description).not.toContain(VARIABLE_MARKER.trim());
    });

    it("does not mark the description for a macro with no variables", () => {
      const macro = { name: "Plain", text: "hi" };
      const item = new MacroTreeItem(macro, 0);
      expect(item.description).not.toContain(VARIABLE_MARKER.trim());
    });

    it("ignores a malformed non-array variables shape (§4.2) — no crash, no marker", () => {
      const macro = { name: "Legacy", text: "hi", variables: "abc" as unknown as never };
      const item = new MacroTreeItem(macro, 0);
      expect(item.description).not.toContain(VARIABLE_MARKER.trim());
      expect(item.contextValue).toBe("nexus.macro");
    });

    it("renders a macro with BOTH triggerPattern and variables as a non-trigger macro with a suppression note (§6.3)", () => {
      const macro = {
        name: "Both",
        text: "run $host",
        triggerPattern: "foo",
        variables: [{ name: "host" }]
      };
      const item = new MacroTreeItem(macro, 0, undefined, false);
      expect((item.iconPath as { id: string }).id).toBe("symbol-parameter");
      expect(item.contextValue).toBe("nexus.macro");
      expect(item.tooltip).toContain("Auto-trigger suppressed: macro has variables");
      expect(item.tooltip).not.toContain("Auto-trigger:");
    });

    it("a normal triggered macro (no variables) is unaffected — still zap/triggered", () => {
      const macro = { name: "Auto", text: "yes\n", triggerPattern: "Continue\\?" };
      const item = new MacroTreeItem(macro, 0, undefined, false);
      expect((item.iconPath as { id: string }).id).toBe("zap");
      expect(item.contextValue).toBe("nexus.macro.triggered");
      expect(item.tooltip).not.toContain("suppressed");
    });
  });

  describe("identity conflict", () => {
    it("renders a conflicted trigger macro as a non-trigger macro with a warning icon and a remedy the user can act on", () => {
      // MacroAutoTrigger compiles no rule for an ambiguous state key, so the zap icon,
      // the Pause/Resume items and the "active"/"paused" tooltip would all be dead
      // controls — the same reasoning as §6.3 for variables. Unlike §6.3 this is corrupt
      // data rather than a design rule, so it also has to say what to do about it: a
      // macro that quietly stops firing with no explanation is its own bug.
      const macro = { id: "dup", name: "Password", text: "hunter2\n", secret: true, triggerPattern: "[Pp]assword:" };
      const item = new MacroTreeItem(macro, 0, undefined, false, true);
      expect((item.iconPath as { id: string }).id).toBe("warning");
      expect(item.contextValue).toBe("nexus.macro.secret");
      expect(item.tooltip).toContain("Auto-trigger suppressed: another macro has the same internal id");
      expect(item.tooltip).toContain("Move Up / Move Down");
      expect(item.tooltip).not.toContain("Auto-trigger:");
    });

    it("takes precedence over the variables note when both suppressions apply", () => {
      const macro = { name: "Both", text: "run $host", triggerPattern: "foo", variables: [{ name: "host" }] };
      const item = new MacroTreeItem(macro, 0, undefined, false, true);
      expect(item.tooltip).toContain("another macro has the same internal id");
      expect(item.tooltip).not.toContain("macro has variables");
    });

    it("leaves a conflicted macro that has no trigger pattern rendering exactly as before — nothing is suppressed for it", () => {
      const macro = { id: "dup", name: "Plain", text: "echo hi" };
      const item = new MacroTreeItem(macro, 0, undefined, undefined, true);
      expect((item.iconPath as { id: string }).id).toBe("terminal");
      expect(item.contextValue).toBe("nexus.macro");
      expect(item.tooltip).not.toContain("suppressed");
    });
  });
});

describe("MacroTreeProvider", () => {
  let provider: MacroTreeProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    testStore = new InMemoryMacroStore();
    await testStore.initialize();
    setActiveMacroStore(testStore);
    provider = new MacroTreeProvider();
  });

  it("returns empty array when no macros configured", () => {
    const children = provider.getChildren();
    expect(children).toHaveLength(0);
  });

  it("displays keybinding when macro has keybinding property", async () => {
    const macros = [
      { name: "Hello", text: "echo hello", keybinding: "alt+m" },
      { name: "World", text: "echo world" }
    ];
    await testStore.save(macros);

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0].label).toBe("[Alt+M] Hello");
    expect(children[1].label).toBe("World");
  });

  it("displays legacy slot as alt+N binding", async () => {
    const macros = [
      { name: "Hello", text: "echo hello", slot: 5 },
      { name: "World", text: "echo world" }
    ];
    await testStore.save(macros);

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0].label).toBe("[Alt+5] Hello");
    expect(children[1].label).toBe("World");
  });

  it("shows no prefix when macros have no assigned shortcut", async () => {
    const macros = [
      { name: "Hello", text: "echo hello" },
      { name: "World", text: "echo world" }
    ];
    await testStore.save(macros);

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0].label).toBe("Hello");
    expect(children[1].label).toBe("World");
  });

  it("mixed: once any macro has a keybinding, unassigned ones show no prefix", async () => {
    const macros = [
      { name: "A", text: "a" },
      { name: "B", text: "b", keybinding: "alt+shift+3" },
      { name: "C", text: "c" }
    ];
    await testStore.save(macros);

    const children = provider.getChildren();
    expect(children[0].label).toBe("A");
    expect(children[1].label).toBe("[Alt+Shift+3] B");
    expect(children[2].label).toBe("C");
  });

  it("unbound macros stay unprefixed even beyond ten entries", async () => {
    const macros = Array.from({ length: 12 }, (_, i) => ({ name: `M${i}`, text: `t${i}` }));
    await testStore.save(macros);

    const children = provider.getChildren();
    expect(children[0].label).toBe("M0");
    expect(children[10].label).toBe("M10");
    expect(children[11].label).toBe("M11");
  });

  it("fires onDidChangeTreeData when refresh() is called", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.refresh();
    expect(listener).toHaveBeenCalledWith(undefined);
  });

  it("getTreeItem returns the element itself", () => {
    const item = new MacroTreeItem({ name: "Test", text: "test" }, 0);
    expect(provider.getTreeItem(item)).toBe(item);
  });

  // InMemoryMacroStore re-keys duplicates on save (the write-time invariant), so these
  // need a store that surfaces persisted state verbatim — which is what
  // VscodeMacroStore.reloadFromState() does with a duplicate that predates the invariant.
  function useRawStore(macros: Array<Record<string, unknown>>): void {
    const rawStore = {
      async initialize() { /* no-op */ },
      getAll: () => macros,
      async save() { /* no-op */ },
      onDidChange: () => () => { /* no-op */ },
      async clearAll() { /* no-op */ }
    };
    setActiveMacroStore(rawStore as unknown as Parameters<typeof setActiveMacroStore>[0]);
  }

  it("flags exactly the macros whose state key is claimed by more than one macro", async () => {
    // Without the conflict wired through getChildren(), the first two items would render
    // as live zap triggers for rules MacroAutoTrigger never compiled.
    useRawStore([
      { id: "dup", name: "A", text: "a\n", triggerPattern: "AAA" },
      { id: "dup", name: "B", text: "b\n", triggerPattern: "BBB" },
      { id: "solo", name: "C", text: "c\n", triggerPattern: "CCC" }
    ]);

    const children = new MacroTreeProvider().getChildren();
    expect((children[0].iconPath as { id: string }).id).toBe("warning");
    expect((children[1].iconPath as { id: string }).id).toBe("warning");
    expect(children[0].contextValue).toBe("nexus.macro");
    expect(children[1].contextValue).toBe("nexus.macro");

    expect((children[2].iconPath as { id: string }).id).toBe("zap");
    expect(children[2].contextValue).toBe("nexus.macro.triggered");
    expect(children[2].tooltip).not.toContain("suppressed");
  });

  it("a claim by a PATTERNLESS macro still makes the key ambiguous — measured over the whole set, not the trigger-capable subset", async () => {
    // The fixture above gives every macro a triggerPattern, so it passes just as well
    // against a provider that computes ambiguity over trigger macros only — while that
    // provider disagrees with MacroAutoTrigger.reload(), which measures over all macros
    // because `setDisabled()`/`pruneState()` accept any macro. Here the secret password
    // trigger's only rival is a plain macro with no pattern at all: narrow the set and
    // "id:dup" is claimed once, the conflict disappears, and the secret macro renders as
    // a live trigger for a rule that was never compiled — the exact dead control the
    // suppression exists to prevent.
    useRawStore([
      { id: "dup", name: "Notes", text: "show run\n" },
      { id: "dup", name: "Password", text: "", secret: true, triggerPattern: "[Pp]assword:" },
      { id: "solo", name: "C", text: "c\n", triggerPattern: "CCC" }
    ]);

    const children = new MacroTreeProvider().getChildren();

    // The secret trigger twin is suppressed and says so, with the secret (not
    // `.triggered`) contextValue so Pause/Resume never appear for it.
    expect((children[1].iconPath as { id: string }).id).toBe("warning");
    expect(children[1].contextValue).toBe("nexus.macro.secret");
    expect(children[1].tooltip).toContain("same internal id");

    // The patternless twin shares the ambiguous key but has no auto-trigger to suppress,
    // so it must NOT be decorated as broken — a warning icon there would be noise.
    expect((children[0].iconPath as { id: string }).id).toBe("terminal");
    expect(children[0].contextValue).toBe("nexus.macro");
    expect(children[0].tooltip).not.toContain("suppressed");

    expect((children[2].iconPath as { id: string }).id).toBe("zap");
    expect(children[2].contextValue).toBe("nexus.macro.triggered");
  });
});
