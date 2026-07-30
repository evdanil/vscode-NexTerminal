import { describe, expect, it, vi, beforeEach } from "vitest";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { getMacros, setActiveMacroStore } from "../../src/macroSettings";

// Fix 8 — the real folder commands (registerMacroCommands) are exercised by
// the rewritten "assigning/renaming/removing" test below, so registration
// plumbing and a handful of dialog mocks join the tree-only mock this file
// already had. `macroBindingHelpers` / `macroBindings` stay UNMOCKED (real,
// pure, no `vscode` import) — several existing MacroTreeProvider tests above
// depend on their real formatting behaviour, so stubbing them here would
// break those rather than only affecting the new command-driven test.
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowInputBox = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();

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
    },
    commands: {
      registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
        registeredCommands.set(id, handler);
        return { dispose: vi.fn() };
      }),
      executeCommand: vi.fn()
    },
    window: {
      showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
      showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
      showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
      showInformationMessage: vi.fn(),
      setStatusBarMessage: vi.fn()
    },
    env: {
      openExternal: vi.fn(),
      clipboard: { readText: vi.fn(), writeText: vi.fn() }
    },
    Uri: { parse: (value: string) => ({ toString: () => value, value }) },
    InputBoxValidationSeverity: { Warning: 2 }
  };
});

// MacroEditorPanel and runMacro are unused by the folder commands this file
// invokes (moveToFolder / renameFolder / removeFolder) — stubbed only so
// importing registerMacroCommands doesn't pull in the real webview panel.
vi.mock("../../src/ui/macroEditorPanel", () => ({
  MacroEditorPanel: {
    open: vi.fn(),
    openNew: vi.fn(),
    setProfileProvider: vi.fn()
  }
}));

vi.mock("../../src/commands/macroVariablePrompt", () => ({
  runMacro: vi.fn()
}));

import { MacroTreeProvider, MacroTreeItem, VARIABLE_MARKER } from "../../src/ui/macroTreeProvider";
import { FolderTreeItem } from "../../src/ui/nexusTreeProvider";
import { MACRO_DRAG_MIME } from "../../src/ui/dndMimeTypes";
import { DuplicateIdMacroStore } from "../helpers/duplicateIdMacroStore";
import { registerMacroCommands } from "../../src/commands/macroCommands";
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
    registeredCommands.clear();
    testStore = new InMemoryMacroStore();
    await testStore.initialize();
    setActiveMacroStore(testStore);
    provider = new MacroTreeProvider();
    // Fix 8 — registered so the rewritten "assigning/renaming/removing" test
    // below can drive the REAL folder commands rather than a direct
    // store.save() reassignment.
    registerMacroCommands();
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

  it("assigning/renaming/removing a group via the REAL commands leaves array order, ids, and every index unchanged", async () => {
    // Fix 8 — the previous version of this test only ever did a direct
    // `store.save()` reassignment; it never called the actual rename or
    // remove commands. An implementation that reversed the array (or
    // reindexed macros within a folder) would still have passed it, because
    // every assertion located macros by NAME rather than checking real
    // command behaviour. This version drives `moveToFolder`, `renameFolder`,
    // and `removeFolder` themselves.
    await testStore.save([
      { name: "A", text: "a" },
      { name: "B", text: "b" },
      { name: "C", text: "c" }
    ]);
    const idsBefore = testStore.getAll().map((m) => m.id);

    // 1. ASSIGN — moveToFolder on macro A (tree-item path), into a brand
    // new folder "Cisco".
    mockShowQuickPick.mockImplementationOnce(async (items: Array<{ folderKind: string }>) =>
      items.find((i) => i.folderKind === "new")
    );
    mockShowInputBox.mockResolvedValueOnce("Cisco");
    await registeredCommands.get("nexus.macro.moveToFolder")!({ macro: testStore.getAll()[0], index: 0 });
    expect(testStore.getAll().map((m) => m.name)).toEqual(["A", "B", "C"]); // still array order
    expect(testStore.getAll()[0].group).toBe("Cisco");

    // 2. RENAME — Cisco -> Juniper.
    mockShowInputBox.mockResolvedValueOnce("Juniper");
    await registeredCommands.get("nexus.macro.renameFolder")!({ folderPath: "Cisco" });
    expect(testStore.getAll()[0].group).toBe("Juniper");

    // 3. REMOVE — re-parents A back to root (Juniper is top-level).
    mockShowWarningMessage.mockResolvedValueOnce("Remove Folder");
    await registeredCommands.get("nexus.macro.removeFolder")!({ folderPath: "Juniper" });

    const stored = testStore.getAll();
    expect(stored.map((m) => m.name)).toEqual(["A", "B", "C"]); // array order survived all three commands
    expect(stored.map((m) => m.id)).toEqual(idsBefore); // same identities, same order
    expect(stored.every((m) => m.group === undefined)).toBe(true); // folder fully removed

    const rootChildren = provider.getChildren();
    const rootMacros = (rootChildren as Array<MacroTreeItem | FolderTreeItem>).filter(
      (m): m is MacroTreeItem => m instanceof MacroTreeItem
    );
    expect(rootMacros.map((m) => m.macro.name)).toEqual(["A", "B", "C"]);
    expect(rootMacros.map((m) => m.index)).toEqual([0, 1, 2]); // TRUE getMacros() indices, refreshed
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

  it("a macro whose STORED group is an unrenderable string renders at root and creates no folder — the store keeps the value, the tree never shows it", async () => {
    // The store no longer deletes an unrenderable group (that destroyed the
    // user's assignment on the next activation), so the tree is now the layer
    // that has to cope with one. `..` must never appear as a folder, the
    // 8-million-character value must never become a row, and neither may
    // knock the view over.
    await testStore.save([
      { name: "Traversal", text: "t", group: "../secrets" },
      { name: "Backslash", text: "t", group: "Cisco\\Routers" },
      { name: "Huge", text: "t", group: "X".repeat(8_000_000) },
      { name: "Grouped", text: "t", group: "Cisco" }
    ]);

    const children = provider.getChildren();

    // Exactly one folder — "Cisco", from the one macro with a usable group.
    const folders = (children as unknown[]).filter((c) => c instanceof FolderTreeItem) as FolderTreeItem[];
    expect(folders.map((f) => f.folderPath)).toEqual(["Cisco"]);
    // The three unrenderable ones sit at the root, in array order.
    expect(macroLabels(children)).toEqual(["Traversal", "Backslash", "Huge"]);
    // ...and the values are still in the store, not silently deleted.
    expect(getMacros().map((m) => m.group)).toEqual([
      "../secrets",
      "Cisco\\Routers",
      "X".repeat(8_000_000),
      "Cisco"
    ]);
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

  it("handleDrag serializes the dragged macro's stable id, the row it was dragged from, and a key to the capture it kept", async () => {
    // The id is what survives a reorder between drag and drop; the index is the
    // only thing that can separate two macros sharing an id, and it is honoured
    // by `resolveMacroTarget` only while the macro at that position still
    // carries the dragged id. Never the index alone.
    //
    // The third field is a KEY, not a fact: what was true about the id when the
    // drag started stays in the provider (`lastDragCapture`), because a drop is a
    // separate gesture and any macro write in between re-keys duplicates, which
    // would leave the drop looking at a unique id that names the twin the user did
    // NOT drag. A payload cannot carry that — see the sibling test below.
    await testStore.save([
      { id: "other-id", name: "Other", text: "t" },
      { id: "fixed-id", name: "M", text: "t" }
    ]);
    const item = provider.getChildren()[1] as MacroTreeItem;
    const dataTransfer = makeDataTransfer();

    await provider.handleDrag([item], dataTransfer as unknown as vscode.DataTransfer);

    const stored = dataTransfer.get(MACRO_DRAG_MIME) as { asString: () => Promise<string> } | undefined;
    expect(stored).toBeDefined();
    expect(JSON.parse(await stored!.asString())).toEqual({
      id: "fixed-id",
      index: 1,
      dragToken: expect.stringMatching(/^drag-\d+$/)
    });
  });

  it("the payload over a SHARED id is byte-identical in shape to one over a unique id — the witness is not in it", async () => {
    // The reason `idAmbiguous` had to go. A boolean in this MIME is the same bytes
    // whoever wrote it, so honouring `false` as "checked, and it was unique" handed
    // that claim to every producer — including a stale one. Nothing here
    // distinguishes an ambiguous drag from an unambiguous one; the difference lives
    // in `lastDragCapture`, and the drop tests below are where it shows up.
    //
    // `DuplicateIdMacroStore` because `InMemoryMacroStore.save()` re-keys
    // duplicates and so cannot hold the state under test.
    const dupStore = new DuplicateIdMacroStore([
      { id: "x", name: "First", text: "t" },
      { id: "x", name: "Second", text: "t" }
    ]);
    setActiveMacroStore(dupStore);
    const dupProvider = new MacroTreeProvider();
    const dragged = dupProvider.getChildren()[1] as MacroTreeItem;
    expect(dragged.identityConflict).toBe(true);
    const dataTransfer = makeDataTransfer();

    await dupProvider.handleDrag([dragged], dataTransfer as unknown as vscode.DataTransfer);

    const stored = dataTransfer.get(MACRO_DRAG_MIME) as { asString: () => Promise<string> };
    const payload = JSON.parse(await stored.asString());
    expect(payload).toEqual({ id: "x", index: 1, dragToken: expect.stringMatching(/^drag-\d+$/) });
    expect(Object.keys(payload).sort()).toEqual(["dragToken", "id", "index"]);
  });

  it("handleDrag reports the ROW's render-time conflict, not a fresh count taken at drag time", async () => {
    // The two can disagree, and the row is the one that is right. The tree paints
    // `[First(x), Second(x)]` with both rows flagged; a save lands (anything at all)
    // and `assignUniqueMacroIds()` re-keys Second, so the array `handleDrag` reads
    // is unambiguous. Capturing from THAT array throws away the only witness — the
    // drop then resolves "x" to First and moves the macro the user did not drag.
    const dupStore = new DuplicateIdMacroStore([
      { id: "x", name: "First", text: "t" },
      { id: "x", name: "Second", text: "t" }
    ]);
    setActiveMacroStore(dupStore);
    await dupStore.saveFolders(["Cisco"]);
    const dupProvider = new MacroTreeProvider();
    const dragged = dupProvider.getChildren()[2] as MacroTreeItem; // folder, First, Second
    expect(dragged.macro.name).toBe("Second");
    expect(dragged.identityConflict).toBe(true); // painted over the conflict

    await dupStore.save(dupStore.getAll()); // the re-key, between paint and drag
    expect(dupStore.getAll().filter((m) => m.id === "x")).toHaveLength(1);

    const dataTransfer = makeDataTransfer();
    await dupProvider.handleDrag([dragged], dataTransfer as unknown as vscode.DataTransfer);
    const folder = findFolder(dupProvider.getChildren(), "Cisco");
    await dupProvider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    // Neither twin moves: the row's flag survives the re-key, so the drop refuses
    // instead of resolving the now-unique "x" to First.
    expect(dupStore.getAll().map((m) => m.group)).toEqual([undefined, undefined]);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
  });

  it("a drop uses the capture for the id it was taken for, never for a different one", async () => {
    // The token names a GESTURE. Applying that gesture's provenance to some other
    // id would attach this view's word to a macro it never looked at — and would
    // also drag the capture's INDEX along, which is what picks a target here:
    // honouring the payload's own bare id moves Other, inheriting the capture moves
    // the row that was actually dragged.
    await testStore.save([
      { id: "first", name: "First", text: "t" },
      { id: "second", name: "Second", text: "t" },
      { id: "other", name: "Other", text: "t" }
    ]);
    await testStore.saveFolders(["Cisco"]);
    const dragged = provider.getChildren()[2] as MacroTreeItem; // folder, then macros
    expect(dragged.macro.name).toBe("Second");
    const dataTransfer = makeDataTransfer();
    await provider.handleDrag([dragged], dataTransfer as unknown as vscode.DataTransfer);
    const token = JSON.parse(
      await (dataTransfer.get(MACRO_DRAG_MIME) as { asString: () => Promise<string> }).asString()
    ).dragToken;

    // Same (valid) token, different id, no position claimed.
    const forged = makeDataTransfer({
      [MACRO_DRAG_MIME]: new vscode.DataTransferItem(JSON.stringify({ id: "other", dragToken: token }))
    });
    const folder = findFolder(provider.getChildren(), "Cisco");
    await provider.handleDrop(folder, forged as unknown as vscode.DataTransfer);

    const after = testStore.getAll();
    expect(after.find((m) => m.id === "other")?.group).toBe("Cisco");
    expect(after.find((m) => m.id === "second")?.group).toBeUndefined();
  });

  it("...and a mismatched id inherits the capture's PROVENANCE no more than its index", async () => {
    // The other half of the id check, and the half the test above cannot see.
    // `dragRefFor` returning `{ ...captured.ref, id: parsed.ref.id }` on a
    // token-only match survives every other case in this file: the payload keeps
    // its own id, so the macro it names is usually still the one that resolves.
    //
    // What it silently hands over is `idWhenCaptured`. This view checked "dragged"
    // and found it unique; it never looked at "bystander" at all. Stamping that
    // answer onto a foreign payload that CLAIMS A POSITION launders it straight
    // past rule 2b — the rule whose entire job is to refuse a producer whose
    // stated position does not check out — and it resolves by rule 3 instead.
    // Under that mutation Bystander, a macro nothing dragged and nothing named as
    // a target, is the macro that moves into Cisco.
    await testStore.save([
      { id: "bystander", name: "Bystander", text: "t" },
      { id: "dragged", name: "Dragged", text: "t" }
    ]);
    await testStore.saveFolders(["Cisco"]);
    const dragged = provider.getChildren()[2] as MacroTreeItem; // folder, Bystander, Dragged
    expect(dragged.macro.name).toBe("Dragged");
    const dataTransfer = makeDataTransfer();
    await provider.handleDrag([dragged], dataTransfer as unknown as vscode.DataTransfer);
    const token = JSON.parse(
      await (dataTransfer.get(MACRO_DRAG_MIME) as { asString: () => Promise<string> }).asString()
    ).dragToken;

    // Valid token, a DIFFERENT id, and a position that does not hold that id —
    // index 1 is the dragged macro's row, not Bystander's.
    const forged = makeDataTransfer({
      [MACRO_DRAG_MIME]: new vscode.DataTransferItem(
        JSON.stringify({ id: "bystander", index: 1, dragToken: token })
      )
    });
    const folder = findFolder(provider.getChildren(), "Cisco");
    await provider.handleDrop(folder, forged as unknown as vscode.DataTransfer);

    // Named by macro, so a failure says WHICH macro moved rather than which slot
    // changed.
    expect(testStore.getAll().filter((m) => m.group !== undefined).map((m) => m.name)).toEqual([]);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
  });

  it("a drop refuses a FOREIGN payload whose claimed position no longer holds its id", async () => {
    // `{"id":"x","index":1}` from a producer this view is not holding a capture for
    // (a bare id is still honoured; claiming a position is what changes the rules).
    // It names the second twin. A save re-keys before the drop, leaving "x" with
    // exactly one holder — First — and its stated position holding a macro with a
    // different id. Resolving by that id moves First, which the user never touched.
    // The sibling test below is the same payload with `idAmbiguous: false` added,
    // which buys it nothing: no field in a payload sets provenance.
    const dupStore = new DuplicateIdMacroStore([
      { id: "x", name: "First", text: "t" },
      { id: "x", name: "Second", text: "t" }
    ]);
    setActiveMacroStore(dupStore);
    await dupStore.saveFolders(["Cisco"]);
    const dupProvider = new MacroTreeProvider();
    await dupStore.save(dupStore.getAll()); // the re-key
    const folder = findFolder(dupProvider.getChildren(), "Cisco");
    const dataTransfer = makeDataTransfer({
      [MACRO_DRAG_MIME]: new vscode.DataTransferItem(JSON.stringify({ id: "x", index: 1 }))
    });

    await dupProvider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    expect(dupStore.getAll().map((m) => m.group)).toEqual([undefined, undefined]);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
  });

  it("...and cannot buy its way out by asserting `idAmbiguous: false`", async () => {
    // The same payload plus the one claim the previous design honoured. It reads as
    // "checked at drag time, and it was unique", which is exactly what a stale or
    // forged payload would say, and it converted the reference to `"unique"` —
    // escaping rule 2b and falling back to the sole holder of "x". Observed
    // outcome: First moved into Cisco, a macro this payload never named.
    const dupStore = new DuplicateIdMacroStore([
      { id: "x", name: "First", text: "t" },
      { id: "x", name: "Second", text: "t" }
    ]);
    setActiveMacroStore(dupStore);
    await dupStore.saveFolders(["Cisco"]);
    const dupProvider = new MacroTreeProvider();
    await dupStore.save(dupStore.getAll()); // the re-key
    const folder = findFolder(dupProvider.getChildren(), "Cisco");
    const dataTransfer = makeDataTransfer({
      [MACRO_DRAG_MIME]: new vscode.DataTransferItem(
        JSON.stringify({ id: "x", index: 1, idAmbiguous: false })
      )
    });

    await dupProvider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    expect(dupStore.getAll().map((m) => m.group)).toEqual([undefined, undefined]);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
  });

  it("a drag captured after its macro was deleted never lands on a macro that later inherits the id", async () => {
    // Rule 0's reason to exist, reached through a drag. The row is painted over
    // `Original(x)`; `Original` is deleted before the gesture starts, so the capture
    // is `"absent"` — checked, and NOTHING carried that id. A config import (or an
    // undo) then hands "x" to a macro the user has never seen, and the drop's own
    // fresh read cannot tell the impostor from the original: same id, same position.
    //
    // Serializing that capture as a boolean lost it — "absent" and "unique" both
    // wrote `false` — so the drop resolved and MOVED the imported macro. Keeping the
    // capture host-side keeps the distinction rule 0 was introduced for.
    await testStore.save([{ id: "x", name: "Original", text: "t" }]);
    await testStore.saveFolders(["Cisco"]);
    const row = provider.getChildren()[1] as MacroTreeItem; // folder first, then the macro
    expect(row.macro.name).toBe("Original");

    await testStore.save([]); // deleted between paint and drag
    const dataTransfer = makeDataTransfer();
    await provider.handleDrag([row], dataTransfer as unknown as vscode.DataTransfer);

    // The resurrection: a different macro arrives carrying the dragged id.
    await testStore.save([{ id: "x", name: "Impostor", text: "t" }]);
    const folder = findFolder(provider.getChildren(), "Cisco");

    await provider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    const after = testStore.getAll();
    expect(after.map((m) => m.name)).toEqual(["Impostor"]);
    expect(after[0].group).toBeUndefined();
    // A reference that was already gone is "missing", not "unresolvable": there is
    // nothing to tell the user to repair.
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it("...while a foreign payload whose position still checks out is honoured", async () => {
    // The counterweight: refusing every indexed foreign payload would pass the test
    // above and break the ordinary drop of one twin onto a folder.
    const dupStore = new DuplicateIdMacroStore([
      { id: "x", name: "First", text: "t" },
      { id: "x", name: "Second", text: "t" }
    ]);
    setActiveMacroStore(dupStore);
    await dupStore.saveFolders(["Cisco"]);
    const dupProvider = new MacroTreeProvider();
    const folder = findFolder(dupProvider.getChildren(), "Cisco");
    const dataTransfer = makeDataTransfer({
      [MACRO_DRAG_MIME]: new vscode.DataTransferItem(JSON.stringify({ id: "x", index: 1 }))
    });

    await dupProvider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    expect(dupStore.getAll().map((m) => m.group)).toEqual([undefined, "Cisco"]);
  });

  it("a drop refuses when the dragged id was shared at drag time and a save re-keyed the twins in between", async () => {
    // Codex's sequence, as a drag: `[Other, First(x), Second(x)]`, drag Second.
    // Anything at all saves before the drop — here, Other being moved into a
    // folder — and `assignUniqueMacroIds()` lets First KEEP `x` while Second
    // gets a fresh id. The payload's index no longer matches, and `x` now has
    // exactly one holder: First. Resolving by that unique id would move First,
    // a macro the user never touched, into the drop target.
    const dupStore = new DuplicateIdMacroStore([
      { id: "other", name: "Other", text: "t" },
      { id: "x", name: "First", text: "t" },
      { id: "x", name: "Second", text: "t" }
    ]);
    setActiveMacroStore(dupStore);
    await dupStore.saveFolders(["Cisco"]);
    const dupProvider = new MacroTreeProvider();
    const dragged = dupProvider.getChildren()[3] as MacroTreeItem; // folder, Other, First, Second
    expect((dragged as MacroTreeItem).macro.name).toBe("Second");
    const dataTransfer = makeDataTransfer();
    await dupProvider.handleDrag([dragged], dataTransfer as unknown as vscode.DataTransfer);

    // The re-keying write, between drag and drop.
    const before = dupStore.getAll();
    await dupStore.save([{ ...before[0], group: "Cisco" }, before[1], before[2]]);

    const folder = findFolder(dupProvider.getChildren(), "Cisco");
    await dupProvider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    const after = dupStore.getAll();
    expect(after.map((m) => m.group)).toEqual(["Cisco", undefined, undefined]);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
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

  it("a bare id payload (no row position) still resolves — the parse is defensive, not brittle", async () => {
    // Every drop above sends a plain id string rather than the JSON `handleDrag`
    // now writes, and they must keep working: `DataTransfer` carries whatever the
    // source put there, so a non-JSON payload is read as a bare id instead of
    // being dropped on the floor.
    await testStore.save([{ id: "m1", name: "M", text: "t" }]);
    await testStore.saveFolders(["Cisco"]);
    const folder = findFolder(provider.getChildren(), "Cisco");
    const dataTransfer = makeDataTransfer({ [MACRO_DRAG_MIME]: new vscode.DataTransferItem("m1") });

    await provider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    expect(testStore.getAll().find((m) => m.id === "m1")?.group).toBe("Cisco");
  });

  it("dropping one of two macros that share an id moves the row that was dragged, not the first match", async () => {
    // The drag payload's index is what makes this answerable at all — the id
    // names both. `DuplicateIdMacroStore` because `InMemoryMacroStore.save()`
    // re-keys duplicates and so cannot hold the state under test.
    const dupStore = new DuplicateIdMacroStore([
      { id: "x", name: "First", text: "t" },
      { id: "x", name: "Second", text: "t" }
    ]);
    setActiveMacroStore(dupStore);
    await dupStore.saveFolders(["Cisco"]);
    const dupProvider = new MacroTreeProvider();
    const folder = findFolder(dupProvider.getChildren(), "Cisco");
    const dragged = dupProvider.getChildren()[2] as MacroTreeItem; // folder first, then both macros
    const dataTransfer = makeDataTransfer();
    await dupProvider.handleDrag([dragged], dataTransfer as unknown as vscode.DataTransfer);

    await dupProvider.handleDrop(folder, dataTransfer as unknown as vscode.DataTransfer);

    const after = dupStore.getAll();
    expect(after[1].group).toBe("Cisco");
    expect(after[0].group).toBeUndefined();
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
