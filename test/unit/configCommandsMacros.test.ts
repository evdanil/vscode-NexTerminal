import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => undefined),
      inspect: vi.fn(() => ({})),
      update: vi.fn()
    }))
  },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
    withProgress: vi.fn()
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15 },
  Uri: { file: vi.fn((p: string) => ({ fsPath: p })) }
}));

import { sanitizeForSharing } from "../../src/commands/configCommands";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";

beforeEach(async () => {
  const store = new InMemoryMacroStore();
  await store.initialize();
  setActiveMacroStore(store);
});

describe("sanitizeForSharing — macros", () => {
  it("emits only non-secret macros", () => {
    const macros: TerminalMacro[] = [
      { id: "1", name: "public", text: "hello" },
      { id: "2", name: "private", text: "classified", secret: true }
    ];
    const result = sanitizeForSharing([], [], [], {}, [], macros);
    expect(result.macros.map((m) => m.name)).toEqual(["public"]);
  });

  it("reassigns fresh ids to shared macros", () => {
    const macros: TerminalMacro[] = [{ id: "stable-id", name: "p", text: "t" }];
    const result = sanitizeForSharing([], [], [], {}, [], macros);
    expect(result.macros[0].id).not.toBe("stable-id");
  });

  it("does not include macros in the settings object", () => {
    const result = sanitizeForSharing([], [], [], { "nexus.terminal.macros": [{ name: "old", text: "x" }] }, [], []);
    expect(result.settings["nexus.terminal.macros"]).toBeUndefined();
  });
});
