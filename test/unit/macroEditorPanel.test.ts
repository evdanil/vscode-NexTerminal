import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
let onDidReceiveMessageHandler: ((msg: Record<string, unknown>) => void) | undefined;
let onDidDisposeHandler: (() => void) | undefined;
let lastHtml = "";

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: {
        set html(value: string) {
          lastHtml = value;
        },
        get html() {
          return lastHtml;
        },
        onDidReceiveMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
          onDidReceiveMessageHandler = handler;
          return { dispose: vi.fn() };
        }),
        postMessage: (...args: unknown[]) => mockPostMessage(...args)
      },
      onDidDispose: vi.fn((handler: () => void) => {
        onDidDisposeHandler = handler;
        return { dispose: vi.fn() };
      }),
      reveal: vi.fn(),
      dispose: vi.fn()
    })),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args)
  },
  ViewColumn: { Active: 1 },
  ConfigurationTarget: { Global: 1 },
  commands: { executeCommand: vi.fn() }
}));

vi.mock("node:crypto", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:crypto")>();
  return {
    ...orig,
    randomBytes: (n: number) => Buffer.alloc(n, "a")
  };
});

import type { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import type { TerminalMacro } from "../../src/models/terminalMacro";

// macroSettings holds module-level `activeStore`; resetModules() between cases
// clears it, so both the store wiring and the panel must come from the SAME
// freshly-imported module graph. These are populated by `harness()`.
let store: InMemoryMacroStore;
let getMacros: () => TerminalMacro[];

async function harness(macros: TerminalMacro[]): Promise<void> {
  vi.resetModules();
  const macroSettings = await import("../../src/macroSettings");
  const { InMemoryMacroStore } = await import("../../src/storage/inMemoryMacroStore");
  store = new InMemoryMacroStore();
  await store.initialize();
  // save() assigns ids to entries that lack one
  if (macros.length > 0) {
    await store.save(macros);
  }
  macroSettings.setActiveMacroStore(store);
  getMacros = macroSettings.getMacros;
}

async function openPanel(index?: number) {
  const { MacroEditorPanel } = await import("../../src/ui/macroEditorPanel");
  MacroEditorPanel.open(index);
  return { sendMessage: onDidReceiveMessageHandler! };
}

describe("MacroEditorPanel id-keyed save/delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `vi.clearAllMocks()` clears CALLS but keeps implementations, so a
    // mockImplementation that performs a concurrent store write (see the
    // staleness cases below) would otherwise leak into every later test in
    // this file.
    mockShowWarningMessage.mockReset();
    onDidReceiveMessageHandler = undefined;
    onDidDisposeHandler = undefined;
    lastHtml = "";
  });

  /**
   * The Folder input's rendered value, read back out of the HTML the panel
   * produced. Tests post THIS back as `group`, exactly as the webview's
   * `group: folderVal || null` does — so a renderer that shows the wrong thing
   * and a save handler that mishandles it are both in scope, instead of the
   * test hard-coding what it wishes the webview had sent.
   */
  function renderedFolderValue(): string {
    const match = /<input type="text" id="macro-folder" value="([^"]*)"/.exec(lastHtml);
    return match ? match[1] : "";
  }

  it("save by id targets the correct macro after an external reorder", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;

    // Panel was opened on Beta (render-time index 1)
    const { sendMessage } = await openPanel(1);

    // External reorder: Beta is now at index 0
    await store.save([before[1], before[0]]);

    // Save carries the stale render-time index 1 but the stable Beta id
    await sendMessage({
      type: "save",
      index: 1,
      id: betaId,
      name: "Beta-edited",
      text: "b2",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null
    });

    const after = getMacros();
    const beta = after.find((m) => m.id === betaId);
    const alpha = after.find((m) => m.id === before[0].id);
    expect(beta?.name).toBe("Beta-edited");
    expect(beta?.text).toBe("b2");
    // Alpha must be untouched — the stale index 1 now points at Alpha
    expect(alpha?.name).toBe("Alpha");
    expect(alpha?.text).toBe("a");
  });

  it("save with a stale id (macro deleted externally) does not write or overwrite another macro", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;

    const { sendMessage } = await openPanel(1);

    // Beta deleted externally; only Alpha remains
    await store.save([before[0]]);

    await sendMessage({
      type: "save",
      index: 1,
      id: betaId,
      name: "Beta-edited",
      text: "b2",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null
    });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Alpha");
    expect(after[0].text).toBe("a");
    // No "saved" ack — the save was rejected
    expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  describe("duplicate macro ids (a list that predates the unique-id invariant)", () => {
    // The editor resolves its target by id, so two macros sharing one make "which macro
    // did the user open" unanswerable. InMemoryMacroStore re-keys duplicates on save, so
    // this needs a store that surfaces persisted state verbatim — which is exactly what
    // VscodeMacroStore.reloadFromState() now does, having stopped repairing ids on load.
    async function harnessWithDuplicateIds(): Promise<{
      macros: TerminalMacro[];
      sendMessage: (msg: Record<string, unknown>) => void;
    }> {
      vi.resetModules();
      const macroSettings = await import("../../src/macroSettings");
      const macros: TerminalMacro[] = [
        { id: "dup", name: "Alpha", text: "a" },
        { id: "dup", name: "Beta", text: "b" }
      ];
      macroSettings.setActiveMacroStore({
        async initialize() { /* no-op */ },
        getAll: () => macros.map((m) => ({ ...m })),
        async save(next: TerminalMacro[]) {
          macros.splice(0, macros.length, ...next.map((m) => ({ ...m })));
        },
        onDidChange: () => () => { /* no-op */ },
        async clearAll() { macros.length = 0; },
        // Neither fixture macro carries a `group`, so the editor's folder datalist is
        // empty and the ambiguity behaviour under test is unaffected.
        getFolders: () => [] as string[],
        async saveFolders() { /* no-op */ }
      } as unknown as Parameters<typeof macroSettings.setActiveMacroStore>[0]);
      const { MacroEditorPanel } = await import("../../src/ui/macroEditorPanel");
      MacroEditorPanel.open(1); // opened on Beta
      return { macros, sendMessage: onDidReceiveMessageHandler! };
    }

    it("refuses to save rather than write the edited macro over its twin", async () => {
      const { macros, sendMessage } = await harnessWithDuplicateIds();

      await sendMessage({
        type: "save",
        index: 1,
        id: "dup",
        name: "Beta-edited",
        text: "b2",
        secret: false,
        keybinding: null,
        triggerPattern: null,
        triggerCooldown: 3,
        triggerInterval: null,
        triggerInitiallyDisabled: false,
        triggerScope: "all-terminals",
        triggerProfileId: null
      });

      // Taking the first match would have turned Alpha into "Beta-edited", silently
      // destroying it — and the id conflict makes that the FIRST macro, not the one the
      // user was looking at.
      expect(macros.map((m) => m.name)).toEqual(["Alpha", "Beta"]);
      expect(macros.map((m) => m.text)).toEqual(["a", "b"]);
      expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("same internal id")
      );
    });

    it("refuses to delete rather than remove the wrong macro", async () => {
      const { macros, sendMessage } = await harnessWithDuplicateIds();

      await sendMessage({ type: "delete", index: 1, id: "dup" });

      expect(macros.map((m) => m.name)).toEqual(["Alpha", "Beta"]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("same internal id")
      );
    });
  });

  it("delete by id removes the correct macro after an external reorder", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;
    const alphaId = before[0].id!;
    mockShowWarningMessage.mockResolvedValue("Delete");

    const { sendMessage } = await openPanel(1);

    // External reorder: Beta now at index 0
    await store.save([before[1], before[0]]);

    // Delete carries the stale render-time index 1 but the stable Beta id
    await sendMessage({ type: "delete", index: 1, id: betaId });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(alphaId);
    expect(after[0].name).toBe("Alpha");
  });

  it("delete with a stale id (already deleted externally) does not remove another macro", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;
    mockShowWarningMessage.mockResolvedValue("Delete");

    const { sendMessage } = await openPanel(1);

    // Beta deleted externally
    await store.save([before[0]]);

    await sendMessage({ type: "delete", index: 1, id: betaId });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Alpha");
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it("creating a new macro (null id) appends and assigns an id", async () => {
    await harness([]);
    const { sendMessage } = await openPanel();

    await sendMessage({
      type: "save",
      index: null,
      id: null,
      name: "Fresh",
      text: "f",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null
    });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Fresh");
    expect(typeof after[0].id).toBe("string");
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
  });

  function baseSaveMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "save",
      index: null,
      id: null,
      name: "Test",
      text: "run $host",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null,
      variables: [],
      ...overrides
    };
  }

  describe("variables validation (§9.4) and persistence (§9.5)", () => {
    it("rejects an invalid variable name on the correct row", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ variables: [{ name: "9bad" }] }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variable",
        row: 0,
        message: expect.stringContaining("not a valid variable name")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects a duplicate variable name on the second row", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ variables: [{ name: "host" }, { name: "host" }] }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variable",
        row: 1,
        message: expect.stringContaining("Duplicate variable name")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects more than the max variables as an array-level error, not a row error", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();
      const variables = Array.from({ length: 11 }, (_, i) => ({ name: `v${i}` }));

      await sendMessage(baseSaveMsg({ variables }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variables",
        message: expect.stringContaining("at most 10 variables")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects a masked variable with a non-empty default", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({
        variables: [{ name: "password", secret: true, default: "hunter2" }]
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variable",
        row: 0,
        message: expect.stringContaining("masked and cannot have a default value")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects a macro declaring both variables and a trigger pattern, on the trigger field", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({
        triggerPattern: "foo",
        variables: [{ name: "host" }]
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("prompt for input or auto-trigger")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("persists a valid variables array, dropping empty label/default fields", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({
        variables: [
          { name: "host", label: "Host" },
          { name: "password", secret: true }
        ]
      }));

      const after = getMacros();
      expect(after).toHaveLength(1);
      expect(after[0].variables).toEqual([
        { name: "host", label: "Host" },
        { name: "password", secret: true }
      ]);
    });

    it("clearing all variable rows actually clears the stored array, not resurrected via the spread (§9.5)", async () => {
      await harness([
        { name: "IPMI", text: "run $host", variables: [{ name: "host" }] }
      ]);
      const before = getMacros();
      const macroId = before[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        text: "run $host",
        variables: []
      }));

      const after = getMacros();
      expect(after).toHaveLength(1);
      expect(after[0].variables).toBeUndefined();
      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
    });
  });

  describe("hidden variable declarations block a suppressed-trigger save (Fix B)", () => {
    it("rejects a save that would un-suppress a trigger hidden behind malformed variable declarations", async () => {
      // The stored macro carries an invalid-named declaration that
      // getValidMacroVariables() filters out before the editor builds its rows — the
      // editor renders zero variable rows for it, but MacroAutoTrigger still keys
      // suppression on the raw (non-empty) array. Before Fix B, opening this macro
      // and pressing Save (submitting zero variables, trigger unchanged) deleted the
      // array and left the trigger live: the secret text would start auto-sending on
      // any output matching "Password:".
      await harness([
        {
          id: "hidden-1",
          name: "Password",
          text: "hunter2\n",
          secret: true,
          triggerPattern: "[Pp]assword:",
          variables: [{ name: "2bad" }]
        }
      ]);
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: "hidden-1",
        name: "Password",
        text: "hunter2\n",
        secret: true,
        triggerPattern: "[Pp]assword:",
        variables: []
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("malformed variable declarations")
      });
      expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });

      // Nothing was mutated — the save was rejected before saveMacros() ran.
      const after = getMacros();
      expect(after[0].triggerPattern).toBe("[Pp]assword:");
      expect(after[0].variables).toEqual([{ name: "2bad" }]);
    });

    it("allows clearing hidden malformed declarations when no trigger is being saved", async () => {
      await harness([
        {
          id: "hidden-2",
          name: "Cmd",
          text: "run\n",
          variables: [{ name: "2bad" }]
        }
      ]);
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: "hidden-2",
        name: "Cmd",
        text: "run\n",
        triggerPattern: null,
        variables: []
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
      const after = getMacros();
      expect(after[0].variables).toBeUndefined();
      expect(after[0].triggerPattern).toBeUndefined();
    });

    it("hidden declarations plus an incoming variables payload hits the ordinary variables/trigger conflict, not the new hidden-declaration message", async () => {
      await harness([
        {
          id: "hidden-3",
          name: "Password",
          text: "hunter2\n",
          secret: true,
          triggerPattern: "[Pp]assword:",
          variables: [{ name: "2bad" }]
        }
      ]);
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: "hidden-3",
        name: "Password",
        text: "hunter2\n",
        secret: true,
        triggerPattern: "[Pp]assword:",
        variables: [{ name: "host" }]
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("prompt for input or auto-trigger")
      });
      expect(mockPostMessage).not.toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("malformed variable declarations")
      });
      expect(getMacros()[0].triggerPattern).toBe("[Pp]assword:");
    });
  });

  describe("Folder field round-trip (§4.11)", () => {
    it("persists a valid folder on a new macro", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ group: "Cisco/Routers" }));

      expect(getMacros()[0].group).toBe("Cisco/Routers");
      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
    });

    it("null/absent group persists as no group at all", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ group: null }));

      expect(getMacros()[0].group).toBeUndefined();
    });

    it("clearing a previously-set group on an existing macro actually removes it (not resurrected via the spread)", async () => {
      await harness([{ name: "M", text: "t", group: "Cisco" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({ index: 0, id: macroId, group: null }));

      expect(getMacros()[0].group).toBeUndefined();
    });

    it("rejects a path-traversal group and does not persist the macro", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ group: "../secrets" }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "folder",
        message: expect.stringContaining("Invalid folder path")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("a name-only save PRESERVES a stored-but-unrenderable folder path byte-for-byte, and shows it so it can be corrected", async () => {
      // The most ordinary write path there is: open a macro whose stored group
      // is `Cisco\Routers` (a Windows separator, typed into settings.json and
      // absorbed verbatim), change ONLY the name, Save. The editor used to
      // sanitize that group to an empty Folder field, the webview posted
      // `group: null`, and the host deleted it — making §4.9.3's "kept
      // byte-for-byte and shown at the root until you correct it" false, on the
      // one surface where correcting it is supposed to happen.
      await harness([{ name: "Old", text: "x", group: "Cisco\\Routers" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      // Half one: there is now something to correct.
      expect(renderedFolderValue()).toBe("Cisco\\Routers");

      // Half two: leaving it alone keeps it. The payload is whatever the
      // webview would actually have sent for that rendered field.
      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        name: "New",
        text: "x",
        group: renderedFolderValue() || null
      }));

      const after = getMacros();
      expect(after[0].name).toBe("New");
      expect(after[0].group).toBe("Cisco\\Routers");
      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
    });

    it("EDITING an unrenderable folder path is validated like any other input — untouched means preserved, touched means decide", async () => {
      await harness([{ name: "Old", text: "x", group: "Cisco\\Routers" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        name: "New",
        text: "x",
        group: "Cisco\\Routers\\Old" // the user typed into the field
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "folder",
        message: expect.stringContaining("Invalid folder path")
      });
      expect(getMacros()[0].name).toBe("Old"); // nothing saved
      expect(getMacros()[0].group).toBe("Cisco\\Routers");
    });

    it("correcting an unrenderable folder path in the field is what actually rewrites it", async () => {
      await harness([{ name: "Old", text: "x", group: "Cisco\\Routers" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({ index: 0, id: macroId, name: "Old", text: "x", group: "Cisco/Routers" }));

      expect(getMacros()[0].group).toBe("Cisco/Routers");
    });

    it("a pathological multi-megabyte stored group never reaches the DOM, and survives a name-only save", async () => {
      // §4.2's stress case, reachable from a hand-edited settings.json through
      // the legacy-absorption path. Rendering it raw would ship 8 MB into the
      // webview on every render; deleting it would be the same data loss as
      // above. Neither: the field stays blank with a notice, and the value is
      // preserved.
      const huge = "X".repeat(8_000_000);
      await harness([{ name: "Old", text: "x", group: huge }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      expect(renderedFolderValue()).toBe("");
      expect(lastHtml.length).toBeLessThan(1_000_000);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        name: "New",
        text: "x",
        group: renderedFolderValue() || null
      }));

      expect(getMacros()[0].name).toBe("New");
      expect(getMacros()[0].group).toBe(huge);
    });

    it("addToFolder's seed (openNew({ group })) round-trips into the rendered HTML, and a save with no folder change persists that seeded value", async () => {
      await harness([]);
      const { MacroEditorPanel } = await import("../../src/ui/macroEditorPanel");
      MacroEditorPanel.openNew({ group: "Cisco" });
      expect(lastHtml).toContain('<input type="text" id="macro-folder" value="Cisco"');

      await onDidReceiveMessageHandler!(baseSaveMsg({ group: "Cisco" }));

      expect(getMacros()[0].group).toBe("Cisco");
    });
  });

  /**
   * The Macro Editor was the 4th and 5th instance of the shape `mutateMacroById`
   * exists to kill: snapshot `getMacros()`, resolve by id, then hold that
   * snapshot and index across an await and write the whole array back.
   *
   * The awaits are real dialogs, and the writer that overlaps them is in the
   * SAME window — `confirmBindingWarnings` is a plain non-modal
   * `showWarningMessage` (macroSettings.ts), so the window stays fully
   * interactive while its toast is up, and `{ modal: true }` on the delete
   * confirmation blocks only the user's input, never the extension host's async
   * work.
   */
  describe("writes re-resolve against a freshly read array, never a pre-dialog snapshot", () => {
    it("a macro dragged into a folder while the NON-modal binding warning is up is not silently reverted", async () => {
      // The review's exact journey: editor open on M, assign ctrl+shift+f,
      // Save → "is a common VS Code shortcut / Use Anyway" toast appears →
      // while it is up the user drags another macro into a folder → Use Anyway.
      await harness([
        { name: "M", text: "m" },
        { name: "Other", text: "o" }
      ]);
      const [edited, other] = getMacros();
      const { sendMessage } = await openPanel(0);

      mockShowWarningMessage.mockImplementation(async () => {
        await store.save(
          getMacros().map((m) => (m.id === other.id ? { ...m, group: "Cisco" } : m))
        );
        return "Use Anyway";
      });

      await sendMessage(baseSaveMsg({
        index: 0,
        id: edited.id,
        name: "M",
        text: "m2",
        keybinding: "ctrl+shift+f"
      }));

      const after = getMacros();
      expect(mockShowWarningMessage).toHaveBeenCalled(); // the toast really fired
      expect(after.find((m) => m.id === other.id)?.group).toBe("Cisco"); // the drag survived
      expect(after.find((m) => m.id === edited.id)?.text).toBe("m2"); // ...and the save applied
      expect(after.find((m) => m.id === edited.id)?.keybinding).toBe("ctrl+shift+f");
    });

    it("a macro DELETED while the non-modal binding warning is up is not resurrected by the save", async () => {
      // The other half of writing back a stale array: it does not just revert
      // edits, it puts deleted records back.
      await harness([
        { name: "M", text: "m" },
        { name: "Doomed", text: "d" }
      ]);
      const [edited, doomed] = getMacros();
      const { sendMessage } = await openPanel(0);

      mockShowWarningMessage.mockImplementation(async () => {
        await store.save(getMacros().filter((m) => m.id !== doomed.id));
        return "Use Anyway";
      });

      await sendMessage(baseSaveMsg({
        index: 0,
        id: edited.id,
        name: "M",
        text: "m2",
        keybinding: "ctrl+shift+f"
      }));

      expect(getMacros().map((m) => m.name)).toEqual(["M"]);
    });

    it("a macro saved while the delete confirmation is open is not discarded", async () => {
      await harness([
        { name: "Alpha", text: "a" },
        { name: "Beta", text: "b" }
      ]);
      const betaId = getMacros()[1].id!;
      const { sendMessage } = await openPanel(1);

      mockShowWarningMessage.mockImplementation(async () => {
        await store.save([...getMacros(), { name: "Gamma", text: "g" }]);
        return "Delete";
      });

      await sendMessage({ type: "delete", index: 1, id: betaId });

      expect(getMacros().map((m) => m.name)).toEqual(["Alpha", "Gamma"]);
    });
  });

  it("subscribes to the store and re-renders on external change; disposes the subscription", async () => {
    await harness([{ name: "Alpha", text: "a" }]);
    await openPanel(0);
    const initialHtml = lastHtml;
    expect(initialHtml).toContain("Alpha");

    // External rename should refresh the panel HTML
    const current = getMacros();
    await store.save([{ ...current[0], name: "Renamed" }]);
    expect(lastHtml).toContain("Renamed");

    // Dispose removes the subscription — later store changes must not re-render
    onDidDisposeHandler!();
    const htmlAtDispose = lastHtml;
    await store.save([{ name: "After Dispose", text: "z" }]);
    expect(lastHtml).toBe(htmlAtDispose);
  });
});
