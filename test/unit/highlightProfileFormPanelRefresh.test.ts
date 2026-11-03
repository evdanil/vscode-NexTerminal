import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listeners: new Set<(event: { affectsConfiguration(key: string): boolean }) => void>(),
  messages: [] as unknown[],
  receive: undefined as ((msg: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
  profiles: [{ id: "old", name: "Old", rules: [] }]
}));

vi.mock("vscode", () => ({
  ViewColumn: { Active: 1 },
  commands: { executeCommand: vi.fn() },
  workspace: {
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "profiles" ? state.profiles : key === "defaultProfile" ? "old" : fallback }),
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(key: string): boolean }) => void) => {
      state.listeners.add(listener); return { dispose: () => state.listeners.delete(listener) };
    }
  },
  window: { createWebviewPanel: () => ({
    webview: { html: "", onDidReceiveMessage: (cb: (msg: unknown) => void) => { state.receive = cb; }, postMessage: (message: unknown) => { state.messages.push(message); return Promise.resolve(true); } },
    onDidDispose: (cb: () => void) => { state.dispose = cb; },
    dispose: () => state.dispose?.(), reveal: () => {}
  }) }
}));

import { WebviewFormPanel } from "../../src/ui/webviewFormPanel";
import { highlightProfileSelectField } from "../../src/ui/highlightProfileForm";

describe("open connection form profile settings updates", () => {
  beforeEach(() => { state.listeners.clear(); state.messages = []; state.profiles = [{ id: "old", name: "Old", rules: [] }]; });

  it("sends fresh choices when settings change and detaches on disposal", () => {
    const panel = WebviewFormPanel.open("highlight-refresh-test", { title: "Connection", fields: [highlightProfileSelectField()] }, { onSubmit: () => {} });
    expect(state.listeners.size).toBe(1);
    state.receive?.({ type: "highlightProfilesReady" });
    expect(state.messages).toHaveLength(1);
    const listener = [...state.listeners][0];
    listener({ affectsConfiguration: () => false });
    expect(state.messages).toHaveLength(1);
    state.profiles = [{ id: "new", name: "New", rules: [] }];
    state.listeners.forEach(listener => listener({ affectsConfiguration: key => key === "nexus.terminal.highlighting" }));
    expect(state.messages).toHaveLength(2);
    const message = state.messages[1] as { type: string; options: Array<{ label: string; value: string }> };
    expect(message.type).toBe("highlightProfilesChanged");
    expect((state.messages[0] as { revision: number }).revision).toBe(1);
    expect((state.messages[1] as { revision: number }).revision).toBe(2);
    expect(message.options).toContainEqual({ label: "New", value: "profile:new" });
    expect(message.options.some(option => option.value === "profile:old")).toBe(false);
    panel.dispose();
    expect(state.listeners.size).toBe(0);
    listener({ affectsConfiguration: () => true });
    expect(state.messages).toHaveLength(2);
  });

  it("does not subscribe unrelated forms to highlighting settings", () => {
    const panel = WebviewFormPanel.open("unrelated-refresh-test", { title: "Other", fields: [{ type: "text", key: "name", label: "Name" }] }, { onSubmit: () => {} });
    expect(state.listeners.size).toBe(0);
    panel.dispose();
  });
});
