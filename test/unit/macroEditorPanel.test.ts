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
    onDidReceiveMessageHandler = undefined;
    onDidDisposeHandler = undefined;
    lastHtml = "";
  });

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
