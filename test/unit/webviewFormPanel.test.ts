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

    // The third argument is the form's own value snapshot. A message that
    // carries none forwards `undefined` rather than an empty object, so a
    // handler can tell "the webview sent nothing" from "the form is empty".
    expect(onAutofill).toHaveBeenCalledWith("authProfileId", "ap1", undefined);
    // `key` echoes the request: the webview tracks which managed fields the
    // AUTH PROFILE select filled, and must not read another autofill-capable
    // select's answer as the profile's (kills dropping the echo).
    //
    // REVIEW FINDING (P2) — and `value` echoes WHICH option was asked about, so
    // the webview can drop an answer the user has already moved past. Asserted
    // as an exact object, never toMatchObject: an answer that reaches the
    // webview without the id it was composed for cannot be correlated against
    // the current selection at all, and formHtml's
    // `fillAnswersCurrentSelection` refuses it — so dropping this echo does not
    // merely weaken the guard, it stops every autofill from applying.
    expect(postMessage).toHaveBeenCalledWith({
      type: "fillFields",
      key: "authProfileId",
      value: "ap1",
      values: { username: "root", authType: "key" }
    });
  });

  it("does not post fillFields when autofill returns undefined", async () => {
    const onSubmit = vi.fn();
    const onAutofill = vi.fn().mockResolvedValue(undefined);

    WebviewFormPanel.open("panel-autofill-empty", { title: "Autofill", fields: [] }, { onSubmit, onAutofill });
    expect(messageHandler).toBeDefined();

    await Promise.resolve(messageHandler!({ type: "autofill", key: "authProfileId", value: "ap1" }));

    expect(onAutofill).toHaveBeenCalledWith("authProfileId", "ap1", undefined);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "fillFields" }));
    // REVIEW FINDING (P1) — but the request IS answered. The webview disables
    // Save for the length of the round trip, and an answer that fills nothing
    // (a /32, a profile that supplies no usable value) is still the end of that
    // round trip. Without this terminator the button stays disabled for the
    // life of the panel, because no fillFields is coming.
    expect(postMessage).toHaveBeenCalledWith({
      type: "autofillSettled",
      key: "authProfileId",
      value: "ap1"
    });
  });

  it("answers an autofill whose handler THROWS, so a failed round trip cannot leave Save disabled forever", async () => {
    const onSubmit = vi.fn();
    const onAutofill = vi.fn().mockRejectedValue(new Error("vault read failed"));

    WebviewFormPanel.open("panel-autofill-throws", { title: "Autofill", fields: [] }, { onSubmit, onAutofill });
    expect(messageHandler).toBeDefined();

    await expect(
      Promise.resolve(messageHandler!({ type: "autofill", key: "cidr", value: "10.0.0.0/24" }))
    ).rejects.toThrow("vault read failed");

    // The rejection still propagates (that is unchanged), but the terminator
    // goes out first — a `finally`, not a success-path post.
    expect(postMessage).toHaveBeenCalledWith({ type: "autofillSettled", key: "cidr", value: "10.0.0.0/24" });
  });

  it("answers an autofill on a panel that wired no onAutofill at all", async () => {
    const onSubmit = vi.fn();

    WebviewFormPanel.open("panel-autofill-unwired", { title: "Autofill", fields: [] }, { onSubmit });
    expect(messageHandler).toBeDefined();

    await Promise.resolve(messageHandler!({ type: "autofill", key: "cidr", value: "10.0.0.0/24" }));

    // No form does this today, but the failure mode if one ever did is a Save
    // button that never comes back — silent, and only in that one form.
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "fillFields" }));
    expect(postMessage).toHaveBeenCalledWith({ type: "autofillSettled", key: "cidr", value: "10.0.0.0/24" });
  });

  it("posts the terminator AFTER the fill it accompanies", async () => {
    const onSubmit = vi.fn();
    const onAutofill = vi.fn().mockResolvedValue({ subnet: "255.255.255.0" });

    WebviewFormPanel.open("panel-autofill-order", { title: "Autofill", fields: [] }, { onSubmit, onAutofill });
    await Promise.resolve(messageHandler!({ type: "autofill", key: "cidr", value: "10.0.0.0/24" }));

    // Order is the whole point: a submit the webview deferred is flushed by the
    // terminator, and must be collected over the FILLED fields. Reversed, the
    // held Save would go out carrying the values the fill was about to replace
    // — the exact loss the hold exists to prevent.
    // `postMessage` is declared with no parameters (it only ever needs to
    // resolve), so read the recorded arguments through `unknown`.
    const types = (postMessage.mock.calls as unknown as Array<[{ type: string }]>).map((call) => call[0].type);
    expect(types.indexOf("fillFields")).toBeGreaterThan(-1);
    expect(types.indexOf("autofillSettled")).toBeGreaterThan(types.indexOf("fillFields"));
  });

  it("forwards the autofill message's form-value snapshot to the handler", async () => {
    const onSubmit = vi.fn();
    const onAutofill = vi.fn().mockResolvedValue({ subnet: "255.255.255.0" });

    WebviewFormPanel.open("panel-autofill-values", { title: "Autofill", fields: [] }, { onSubmit, onAutofill });
    expect(messageHandler).toBeDefined();

    // The DHCP editor's CIDR row cannot decide what it may overwrite without
    // this: a gateway the user typed has to survive, and only one a previous
    // derivation wrote may be replaced. Dropping `values` on the floor here
    // makes every such answer look like it is filling a blank form, which is
    // precisely the "clobber a hand-set value" bug the payload exists to stop.
    await Promise.resolve(
      messageHandler!({
        type: "autofill",
        key: "cidr",
        value: "10.0.0.0/24",
        values: { gateway: "10.0.0.9", rangeStart: "192.168.2.10" }
      })
    );

    expect(onAutofill).toHaveBeenCalledWith("cidr", "10.0.0.0/24", {
      gateway: "10.0.0.9",
      rangeStart: "192.168.2.10"
    });
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
