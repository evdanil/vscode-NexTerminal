import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormMessage } from "../../src/ui/formTypes";
import { WebviewFormPanel } from "../../src/ui/webviewFormPanel";

let messageHandler: ((message: FormMessage) => void | Promise<void>) | undefined;
let disposeHandler: (() => void) | undefined;
const panelDispose = vi.fn(() => {
  disposeHandler?.();
});
const panelReveal = vi.fn();
const postMessage = vi.fn(async () => true);
const showErrorMessage = vi.fn();

vi.mock("../../src/ui/formHtml", () => ({
  renderFormHtml: vi.fn(() => "<html></html>")
}));

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: (...args: unknown[]) => showErrorMessage(...args),
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: "",
        onDidReceiveMessage: vi.fn((handler: (message: FormMessage) => void | Promise<void>) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        }),
        postMessage
      },
      onDidDispose: vi.fn((handler: () => void) => {
        disposeHandler = handler;
        return { dispose: vi.fn() };
      }),
      dispose: panelDispose,
      reveal: panelReveal
    }))
  },
  ViewColumn: { Active: 1 }
}));

describe("WebviewFormPanel submit handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = undefined;
    disposeHandler = undefined;
  });

  it("enforces single-flight submit while an async save is in progress", async () => {
    let resolveSubmit!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        })
    );

    WebviewFormPanel.open("panel-single-flight", { title: "Test", fields: [] }, { onSubmit });
    expect(messageHandler).toBeDefined();

    const first = Promise.resolve(messageHandler!({ type: "submit", values: {} }));
    const second = Promise.resolve(messageHandler!({ type: "submit", values: {} }));
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    resolveSubmit();
    await first;
    await second;
    expect(panelDispose).toHaveBeenCalledTimes(1);
  });

  it("allows retry after a failed submit and disposes after success", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce(undefined);

    WebviewFormPanel.open("panel-retry", { title: "Retry", fields: [] }, { onSubmit });
    expect(messageHandler).toBeDefined();

    await Promise.resolve(messageHandler!({ type: "submit", values: {} }));
    expect(showErrorMessage).toHaveBeenCalledWith("Save failed: save failed");
    expect(panelDispose).not.toHaveBeenCalled();

    await Promise.resolve(messageHandler!({ type: "submit", values: {} }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(panelDispose).toHaveBeenCalledTimes(1);
  });

  it("handles autofill messages and posts fillFields results", async () => {
    const onSubmit = vi.fn();
    const onAutofill = vi.fn().mockResolvedValue({ username: "root", authType: "key" });

    WebviewFormPanel.open("panel-autofill", { title: "Autofill", fields: [] }, { onSubmit, onAutofill });
    expect(messageHandler).toBeDefined();

    await Promise.resolve(messageHandler!({ type: "autofill", key: "authProfileId", value: "ap1" }));

    expect(onAutofill).toHaveBeenCalledWith("authProfileId", "ap1");
    expect(postMessage).toHaveBeenCalledWith({
      type: "fillFields",
      values: { username: "root", authType: "key" }
    });
  });

  it("does not post fillFields when autofill returns undefined", async () => {
    const onSubmit = vi.fn();
    const onAutofill = vi.fn().mockResolvedValue(undefined);

    WebviewFormPanel.open("panel-autofill-empty", { title: "Autofill", fields: [] }, { onSubmit, onAutofill });
    expect(messageHandler).toBeDefined();

    await Promise.resolve(messageHandler!({ type: "autofill", key: "authProfileId", value: "ap1" }));

    expect(onAutofill).toHaveBeenCalledWith("authProfileId", "ap1");
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "fillFields" }));
  });

  it("REVIEW FINDING 2 (P2) — a rejecting onTest is caught and shown as 'Test failed: ...' instead of escaping as an unhandled rejection (kills the uncaught onTest await)", async () => {
    const onSubmit = vi.fn();
    const onTest = vi.fn().mockRejectedValueOnce(new Error("vault read failed"));

    WebviewFormPanel.open("panel-test-reject", { title: "Test", fields: [] }, { onSubmit, onTest });
    expect(messageHandler).toBeDefined();

    // Without a try/catch around the onTest await, this same call would
    // reject instead of resolving — the messageHandler's own returned
    // promise would carry the rejection straight out to whatever (nothing,
    // in the real onDidReceiveMessage case) is watching it.
    await expect(Promise.resolve(messageHandler!({ type: "test", values: {} }))).resolves.toBeUndefined();

    expect(onTest).toHaveBeenCalledWith({});
    expect(showErrorMessage).toHaveBeenCalledWith("Test failed: vault read failed");
    // A failed Test must never dispose the still-open form.
    expect(panelDispose).not.toHaveBeenCalled();
  });

  it("does not show an error when onTest resolves normally", async () => {
    const onSubmit = vi.fn();
    const onTest = vi.fn().mockResolvedValue(undefined);

    WebviewFormPanel.open("panel-test-ok", { title: "Test", fields: [] }, { onSubmit, onTest });
    expect(messageHandler).toBeDefined();

    await Promise.resolve(messageHandler!({ type: "test", values: {} }));

    expect(onTest).toHaveBeenCalledWith({});
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it("supports disposal listeners for external cleanup", () => {
    const onSubmit = vi.fn();
    const panel = WebviewFormPanel.open("panel-dispose-listener", { title: "Dispose", fields: [] }, { onSubmit });
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const disposableA = panel.onDidDispose(listenerA);
    panel.onDidDispose(listenerB);
    disposableA.dispose();

    panel.dispose();

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});
