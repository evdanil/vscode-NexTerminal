import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rules: [] as unknown,
  postedMessages: [] as Array<Record<string, unknown>>,
  html: "",
  configListener: undefined as ((event: { affectsConfiguration: (k: string) => boolean }) => void) | undefined,
  disposeListener: undefined as (() => void) | undefined
}));

vi.mock("vscode", () => ({
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue?: unknown) => (key === "rules" ? state.rules : defaultValue)),
      update: vi.fn(async () => undefined)
    })),
    onDidChangeConfiguration: vi.fn((listener: (event: { affectsConfiguration: (k: string) => boolean }) => void) => {
      state.configListener = listener;
      return { dispose: vi.fn() };
    })
  },
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: {
        set html(value: string) {
          state.html = value;
        },
        get html() {
          return state.html;
        },
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        postMessage: vi.fn((msg: Record<string, unknown>) => {
          state.postedMessages.push(msg);
          return Promise.resolve(true);
        })
      },
      onDidDispose: vi.fn((listener: () => void) => {
        state.disposeListener = listener;
        return { dispose: vi.fn() };
      }),
      reveal: vi.fn(),
      dispose: vi.fn()
    })),
    showWarningMessage: vi.fn()
  }
}));

import { HighlightRuleEditorPanel } from "../../src/ui/highlightRuleEditorPanel";
import type { HighlightRule } from "../../src/utils/highlightRuleValidation";

const IPV6_V1 =
  "\\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\\b|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\\b";

/** Open the panel and read back the rules it hands to the webview. */
function rulesShownByEditor(configured: unknown): HighlightRule[] {
  state.rules = configured;
  state.postedMessages = [];
  HighlightRuleEditorPanel.open();
  state.configListener?.({ affectsConfiguration: () => true });
  const update = state.postedMessages.find((msg) => msg.type === "rulesUpdated");
  expect(update, "editor never pushed a rulesUpdated message").toBeDefined();
  return update!.rules as HighlightRule[];
}

describe("HighlightRuleEditorPanel.readRules — known-default upgrade", () => {
  beforeEach(() => {
    // Drop the singleton so each test constructs a fresh panel.
    state.disposeListener?.();
    state.disposeListener = undefined;
    state.configListener = undefined;
    state.postedMessages = [];
  });

  // ⊘ Fails if readRules() skips the upgrade: the editor would keep showing an
  // unnamed rule with the truncating pattern.
  it("shows the canonical pattern and the shipped label for a stale v1 snapshot", () => {
    const shown = rulesShownByEditor([{ pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false }]);

    expect(shown).toHaveLength(1);
    expect(shown[0].label).toBe("IPv6 addresses");
    expect(shown[0].pattern).not.toBe(IPV6_V1);
    expect(new RegExp(shown[0].pattern, "g").exec("fe80::b3ff:fe1e:8329")?.[0]).toBe("fe80::b3ff:fe1e:8329");
  });

  it("backfills the label of a label-less default rule without touching its color", () => {
    const shown = rulesShownByEditor([{ pattern: "\\bERR(?:OR)?\\b", color: "brightGreen", flags: "gi" }]);

    expect(shown[0].label).toBe("Errors");
    expect(shown[0].color).toBe("brightGreen");
  });

  it("leaves a user's own rule and their own label alone", () => {
    const shown = rulesShownByEditor([
      { pattern: "\\bDEPLOYING\\b", color: "cyan" },
      { pattern: "\\bERR(?:OR)?\\b", color: "red", label: "My errors" }
    ]);

    expect(shown[0]).toEqual({ pattern: "\\bDEPLOYING\\b", color: "cyan" });
    expect(shown[1].label).toBe("My errors");
  });
});
