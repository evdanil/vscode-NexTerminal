import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reset All must clear the highlighting rules array too (v2.8.187).
 *
 * `nexus.terminal.highlighting.rules` is not in SETTINGS_META, so before this
 * change "Reset all Nexus settings to their defaults" left a user's saved rule
 * snapshot in place — the one thing most likely to be shadowing the shipped
 * defaults. These tests drive the three real call sites, not resetSettings().
 */
const state = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  updates: [] as Array<{ section: string; key: string; value: unknown; target: unknown }>,
  warningAnswer: "Reset" as string | undefined,
  messageListener: undefined as ((msg: Record<string, unknown>) => void) | undefined,
  panelDispose: undefined as (() => void) | undefined
}));

vi.mock("vscode", () => {
  const makeConfig = (section: string) => ({
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
    inspect: vi.fn(() => undefined),
    update: vi.fn(async (key: string, value: unknown, target: unknown) => {
      state.updates.push({ section, key, value, target });
    })
  });
  return {
    ViewColumn: { Active: -1 },
    ConfigurationTarget: { Global: 1 },
    FileType: { File: 1, Directory: 2 },
    Uri: { file: (p: string) => ({ fsPath: p }), joinPath: (b: { fsPath: string }, ...r: string[]) => ({ fsPath: [b.fsPath, ...r].join("/") }) },
    workspace: {
      workspaceFolders: [],
      getConfiguration: vi.fn((section: string) => makeConfig(section)),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      fs: { stat: vi.fn() }
    },
    window: {
      showWarningMessage: vi.fn(async () => state.warningAnswer),
      showInformationMessage: vi.fn(),
      showOpenDialog: vi.fn(),
      createWebviewPanel: vi.fn(() => ({
        webview: {
          html: "",
          onDidReceiveMessage: vi.fn((listener: (msg: Record<string, unknown>) => void) => {
            state.messageListener = listener;
            return { dispose: vi.fn() };
          }),
          postMessage: vi.fn(() => Promise.resolve(true))
        },
        onDidDispose: vi.fn((listener: () => void) => {
          state.panelDispose = listener;
          return { dispose: vi.fn() };
        }),
        reveal: vi.fn(),
        dispose: vi.fn()
      }))
    },
    commands: {
      registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
        state.commands.set(id, handler);
        return { dispose: vi.fn() };
      }),
      executeCommand: vi.fn()
    },
    env: { openExternal: vi.fn() }
  };
});

import { registerSettingsCommands } from "../../src/commands/settingsCommands";
import { SettingsPanel } from "../../src/ui/settingsPanel";

const RULES_KEY = { section: "nexus.terminal.highlighting", key: "rules" };

function clearedRulesKey(): boolean {
  return state.updates.some(
    (u) => u.section === RULES_KEY.section && u.key === RULES_KEY.key && u.value === undefined && u.target === 1
  );
}

async function sendPanelMessage(msg: Record<string, unknown>): Promise<void> {
  state.panelDispose?.();
  state.panelDispose = undefined;
  state.messageListener = undefined;
  SettingsPanel.open();
  await state.messageListener?.(msg);
  // handleMessage is async and fired without await from the listener wrapper.
  await new Promise((resolve) => setImmediate(resolve));
}

describe("Reset All covers the highlighting rules array", () => {
  beforeEach(() => {
    state.updates = [];
    state.warningAnswer = "Reset";
    state.commands.clear();
  });

  it("nexus.settings.resetAll clears nexus.terminal.highlighting.rules", async () => {
    registerSettingsCommands(() => "/logs");
    await state.commands.get("nexus.settings.resetAll")!();

    expect(clearedRulesKey()).toBe(true);
  });

  it("nexus.settings.resetAll clears nothing when the user cancels", async () => {
    state.warningAnswer = undefined;
    registerSettingsCommands(() => "/logs");
    await state.commands.get("nexus.settings.resetAll")!();

    expect(state.updates).toEqual([]);
  });

  it("the settings panel's resetAll clears the rules too", async () => {
    await sendPanelMessage({ type: "resetAll" });
    expect(clearedRulesKey()).toBe(true);
  });

  it("the settings panel's terminal-category reset clears the rules", async () => {
    await sendPanelMessage({ type: "resetCategory", category: "terminal" });
    expect(clearedRulesKey()).toBe(true);
  });

  // ⊘ Discriminator against wiring the extra key into every category reset.
  it("a non-terminal category reset does NOT clear the rules", async () => {
    await sendPanelMessage({ type: "resetCategory", category: "ssh" });
    expect(state.updates.length).toBeGreaterThan(0);
    expect(clearedRulesKey()).toBe(false);
  });

  // ⊘ A category-less message must not fall through to "reset everything".
  it("a resetCategory message with no category clears nothing at all", async () => {
    await sendPanelMessage({ type: "resetCategory" });
    expect(state.updates).toEqual([]);
  });
});
