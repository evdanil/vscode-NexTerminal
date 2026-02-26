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

vi.mock("../../src/ui/formHtml", () => ({
  renderFormHtml: vi.fn(() => "<html></html>")
}));

vi.mock("vscode", () => ({
  window: {
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

    await expect(
      Promise.resolve(messageHandler!({ type: "submit", values: {} }))
    ).rejects.toThrow("save failed");
    expect(panelDispose).not.toHaveBeenCalled();

    await expect(
      Promise.resolve(messageHandler!({ type: "submit", values: {} }))
    ).resolves.toBeUndefined();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(panelDispose).toHaveBeenCalledTimes(1);
  });
});
