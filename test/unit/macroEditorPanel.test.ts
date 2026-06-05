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
