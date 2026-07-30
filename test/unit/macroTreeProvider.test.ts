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
    DataTransferItem: class {
      constructor(private readonly value: string) {}
      async asString(): Promise<string> { return this.value; }
    },
    EventEmitter,
    workspace: {
      getConfiguration: vi.fn()
    }
  };
});

import { MacroTreeProvider, MacroTreeItem, VARIABLE_MARKER } from "../../src/ui/macroTreeProvider";
import { FolderTreeItem } from "../../src/ui/nexusTreeProvider";
import { MACRO_DRAG_MIME } from "../../src/ui/dndMimeTypes";
import type { TerminalMacro } from "../../src/models/terminalMacro";
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
      async clearAll() { /* no-op */ },
      // No macro in these fixtures carries a `group`, so there is nothing to derive and no
      // explicit folder to render — `getChildren()` returns macro items only and the
      // indices below line up with the fixture order.
      getFolders: () => [] as string[],
      async saveFolders() { /* no-op */ }
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

function findFolder(children: unknown[], path: string): FolderTreeItem {
  const found = (children as Array<MacroTreeItem | FolderTreeItem>).find(
    (c): c is FolderTreeItem => c instanceof FolderTreeItem && c.folderPath === path
  );
  if (!found) throw new Error(`Folder "${path}" not found among children`);
  return found;
}

function macroLabels(children: unknown[]): string[] {
  return (children as Array<MacroTreeItem | FolderTreeItem>)
    .filter((c): c is MacroTreeItem => c instanceof MacroTreeItem)
    .map((m) => m.label as string);
}

describe("MacroTreeProvider — hierarchical folders (§4.3, §4.4)", () => {
  let provider: MacroTreeProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    testStore = new InMemoryMacroStore();
    await testStore.initialize();
    setActiveMacroStore(testStore);
    provider = new MacroTreeProvider();
  });

  // The single highest-value test in this design: MacroTreeItem.index must be
  // the TRUE getMacros() index, never a per-folder ordinal. The named wrong
  // implementation — `macros.filter(m => m.group === folder).map((m, i) => ...)`
  // — would report `index: 0` here since InFolder is the FIRST match within its
  // own folder, even though its real array position is 1.
  it("MacroTreeItem.index is the true getMacros() index for a macro rendered inside a folder", async () => {
    const macros: TerminalMacro[] = [
      { name: "Root1", text: "r1" },
      { name: "InFolder", text: "f1", group: "Cisco" },
      { name: "Root2", text: "r2" }
    ];
    await testStore.save(macros);

    const rootChildren = provider.getChildren();
    const folder = findFolder(rootChildren, "Cisco");
    const folderChildren = provider.getChildren(folder) as MacroTreeItem[];

    expect(folderChildren).toHaveLength(1);
    expect(folderChildren[0].macro.name).toBe("InFolder");
    expect(folderChildren[0].index).toBe(1);
    // And the true index must resolve back to the exact same macro via getMacros().
    expect(testStore.getAll()[folderChildren[0].index].name).toBe("InFolder");
  });

  it("folders sort by naturalComparePath; macros keep array order (root)", async () => {
    const macros: TerminalMacro[] = [
      { name: "Zebra", text: "t" },
      { name: "Apple", text: "t" }
    ];
    await testStore.save(macros);
    await testStore.saveFolders(["Zeta", "Alpha"]);

    const children = provider.getChildren();
    const folderPaths = (children as Array<MacroTreeItem | FolderTreeItem>)
      .filter((c): c is FolderTreeItem => c instanceof FolderTreeItem)
      .map((f) => f.folderPath);
    expect(folderPaths).toEqual(["Alpha", "Zeta"]); // sorted, not insertion order

    // Macros are NOT name-sorted (Apple would sort before Zebra) — array order survives.
    expect(macroLabels(children)).toEqual(["Zebra", "Apple"]);
  });

  it("folders sort; macros keep array order inside a folder too", async () => {
    const macros: TerminalMacro[] = [
      { name: "Zebra", text: "t", group: "Net" },
      { name: "Apple", text: "t", group: "Net" }
    ];
    await testStore.save(macros);

    const rootChildren = provider.getChildren();
    const folder = findFolder(rootChildren, "Net");
    const folderChildren = provider.getChildren(folder);
    expect(macroLabels(folderChildren)).toEqual(["Zebra", "Apple"]);
  });

  it("assigning/renaming/removing a group leaves array order and every index unchanged", async () => {
    const macros: TerminalMacro[] = [
      { name: "A", text: "a" },
      { name: "B", text: "b" },
      { name: "C", text: "c" }
    ];
    await testStore.save(macros);
    const [a, b, c] = testStore.getAll();
    await testStore.save([{ ...a, group: "X" }, b, c]);

    const stored = testStore.getAll();
    expect(stored.map((m) => m.name)).toEqual(["A", "B", "C"]); // unchanged order
    const rootChildren = provider.getChildren();
    const rootMacros = (rootChildren as Array<MacroTreeItem | FolderTreeItem>).filter(
      (m): m is MacroTreeItem => m instanceof MacroTreeItem
    );
    expect(rootMacros.map((m) => m.index)).toEqual([1, 2]); // B, C keep their true indices
  });

  it("renders a nested folder hierarchy: parent at root, child under parent", async () => {
    await testStore.save([{ name: "M", text: "t", group: "Cisco/Routers" }]);

    const rootChildren = provider.getChildren();
    const cisco = findFolder(rootChildren, "Cisco");
    const ciscoChildren = provider.getChildren(cisco);
    const routers = findFolder(ciscoChildren, "Cisco/Routers");
    const routerChildren = provider.getChildren(routers) as MacroTreeItem[];
    expect(routerChildren).toHaveLength(1);
    expect(routerChildren[0].macro.name).toBe("M");
  });

  it("an explicit folder with zero macros persists and renders (§1.1)", async () => {
    await testStore.save([{ name: "Root", text: "t" }]);
    await testStore.saveFolders(["Empty"]);

    const children = provider.getChildren();
    expect(() => findFolder(children, "Empty")).not.toThrow();
    const empty = findFolder(children, "Empty");
    expect(provider.getChildren(empty)).toHaveLength(0);
  });

  it("a macro with a malformed group (§4.2) renders at root rather than crashing the whole view", async () => {
    const macros = [
      { name: "Bad", text: "t", group: { nope: true } as unknown as string }
    ];
    await testStore.save(macros);

    expect(() => provider.getChildren()).not.toThrow();
    expect(macroLabels(provider.getChildren())).toEqual(["Bad"]);
  });
});

describe("MacroTreeProvider drag and drop (§4.9)", () => {
  let provider: MacroTreeProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    testStore = new InMemoryMacroStore();
    await testStore.initialize();
    setActiveMacroStore(testStore);
    provider = new MacroTreeProvider();
  });

  function makeDataTransfer(entries: Record<string, unknown> = {}) {
    const map = new Map<string, unknown>(Object.entries(entries));
    return {
      set: (mime: string, item: unknown) => { map.set(mime, item); },
      get: (mime: string) => map.get(mime)
    };
  }

  it("handleDrag serializes the dragged macro's stable id, never an index", async () => {
    await testStore.save([{ id: "fixed-id", name: "M", text: "t" }]);
    const item = provider.getChildren()[0] as MacroTreeItem;
    const dataTransfer = makeDataTransfer();

    await provider.handleDrag([item], dataTransfer as unknown as vscode.DataTransfer);

    const stored = dataTransfer.get(MACRO_DRAG_MIME) as { asString: () => Promise<string> } | undefined;
    expect(stored).toBeDefined();
    await expect(stored!.asString()).resolves.toBe("fixed-id");
  });

  it("folders are not draggable — handleDrag on a folder source sets no payload", async () => {
    await testStore.save([{ name: "M", text: "t", group: "Cisco" }]);
    const folder = findFolder(provider.getChildren(), "Cisco");
    const dataTransfer = makeDataTransfer();

    await provider.handleDrag([folder], dataTransfer as unknown as vscode.DataTransfer);

    expect(dataTransfer.get(MACRO_DRAG_MIME)).toBeUndefined();
  });

  it("drop onto a folder sets the dragged macro's group", async () => {
    await testStore.save([{ id: "m1", name: "M", text: "t" }]);
    await testStore.saveFolders(["Cisco"]);
    const folder = findFolder(provider.getChildren(), "Cisco");
    const dataTransfer = makeDataTransfer({ [MACRO_DRAG_MIME]: new vscode.DataTransferItem("m1") });

    await provider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    expect(testStore.getAll().find((m) => m.id === "m1")?.group).toBe("Cisco");
  });

  it("drop onto root (target undefined) clears the dragged macro's group", async () => {
    await testStore.save([{ id: "m1", name: "M", text: "t", group: "Cisco" }]);
    const dataTransfer = makeDataTransfer({ [MACRO_DRAG_MIME]: new vscode.DataTransferItem("m1") });

    await provider.handleDrop(undefined, dataTransfer as unknown as vscode.DataTransfer);

    expect(testStore.getAll().find((m) => m.id === "m1")?.group).toBeUndefined();
  });

  it("drop onto another macro row targets that macro's own folder", async () => {
    await testStore.save([
      { id: "dragged", name: "Dragged", text: "t" },
      { id: "target", name: "Target", text: "t", group: "Juniper" }
    ]);
    const juniperFolder = findFolder(provider.getChildren(), "Juniper");
    const targetMacroItem = (provider.getChildren(juniperFolder) as MacroTreeItem[])[0];
    const dataTransfer = makeDataTransfer({ [MACRO_DRAG_MIME]: new vscode.DataTransferItem("dragged") });

    await provider.handleDrop(targetMacroItem, dataTransfer as unknown as vscode.DataTransfer);

    expect(testStore.getAll().find((m) => m.id === "dragged")?.group).toBe("Juniper");
  });

  it("a foreign MIME payload (no macro MIME entry) is rejected — no mutation", async () => {
    // Fix 4(a) — the macro must start WITH a group and drop onto ROOT, so a
    // leaking payload would visibly CLEAR it. The prior fixture (no group,
    // drop onto root) made "rejected" and "processed" produce the identical
    // `undefined` outcome — deleting the `if (!transferItem) return;` guard
    // still passed.
    await testStore.save([{ id: "m1", name: "M", text: "t", group: "Cisco" }]);
    const dataTransfer = makeDataTransfer({ "application/vnd.nexus.item": "{}" });

    await provider.handleDrop(undefined, dataTransfer as unknown as vscode.DataTransfer);

    expect(testStore.getAll().find((m) => m.id === "m1")?.group).toBe("Cisco");
    expect(testStore.getAll()).toHaveLength(1);
  });

  it("an unknown macro id in the payload is a no-op", async () => {
    // Fix 4(b) — two macros in DIFFERENT folders; assert the one NOT named by
    // the payload is untouched. The prior fixture had only one macro, so a
    // `findIndex(...)` replaced by a hardcoded `0` would still have targeted
    // (and left unchanged) the same, only macro — this version would catch
    // that mutant, since a hardcoded 0 now targets "m1" instead of no one.
    await testStore.save([
      { id: "m1", name: "M1", text: "t", group: "Cisco" },
      { id: "m2", name: "M2", text: "t", group: "Juniper" }
    ]);
    const dataTransfer = makeDataTransfer({ [MACRO_DRAG_MIME]: new vscode.DataTransferItem("does-not-exist") });

    await provider.handleDrop(undefined, dataTransfer as unknown as vscode.DataTransfer);

    const macros = testStore.getAll();
    expect(macros.find((m) => m.id === "m1")?.group).toBe("Cisco");
    expect(macros.find((m) => m.id === "m2")?.group).toBe("Juniper");
  });
});

describe("MacroTreeProvider collapse state (§4.10)", () => {
  it("folders default expanded", async () => {
    testStore = new InMemoryMacroStore();
    await testStore.initialize();
    setActiveMacroStore(testStore);
    await testStore.save([{ name: "M", text: "t", group: "Cisco" }]);
    const provider = new MacroTreeProvider();

    const folder = findFolder(provider.getChildren(), "Cisco");
    expect(folder.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it("collapseFolder/expandFolder/getCollapsedFolders/loadCollapsedFolders round-trip", async () => {
    testStore = new InMemoryMacroStore();
    await testStore.initialize();
    setActiveMacroStore(testStore);
    await testStore.save([{ name: "M", text: "t", group: "Cisco" }]);
    const provider = new MacroTreeProvider();

    provider.collapseFolder("Cisco");
    expect(provider.getCollapsedFolders()).toEqual(["Cisco"]);
    let folder = findFolder(provider.getChildren(), "Cisco");
    expect(folder.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);

    provider.expandFolder("Cisco");
    expect(provider.getCollapsedFolders()).toEqual([]);
    folder = findFolder(provider.getChildren(), "Cisco");
    expect(folder.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);

    provider.loadCollapsedFolders(["Cisco"]);
    expect(provider.getCollapsedFolders()).toEqual(["Cisco"]);
  });
});
