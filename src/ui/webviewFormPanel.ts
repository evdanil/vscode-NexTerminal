import * as vscode from "vscode";
import { renderFormHtml } from "./formHtml";
import type { FormDefinition, FormMessage, FormValues } from "./formTypes";
import { createWebviewNonce } from "./shared/webviewNonce";

export class WebviewFormPanel {
  private static activePanels = new Map<string, WebviewFormPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private submitInFlight = false;
  private readonly disposeListeners = new Set<() => void>();

  private constructor(
    private readonly formId: string,
    definition: FormDefinition,
    private readonly onSubmit: (values: FormValues) => void | Promise<void>,
    private readonly onCancel: () => void,
    private readonly onBrowse?: (key: string) => Promise<string | undefined>,
    private readonly onScan?: (key: string) => Promise<string | undefined>,
    private readonly onCreateInline?: (key: string, values?: FormValues) => void,
    private readonly onAutofill?: (
      key: string,
      value: string,
      values?: FormValues,
      previousValue?: string
    ) => Promise<Record<string, string> | undefined>,
    private readonly onTest?: (values: FormValues) => void | Promise<void>
  ) {
    this.panel = vscode.window.createWebviewPanel(
      `nexus.form.${formId}`,
      definition.title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const nonce = createWebviewNonce();
    this.panel.webview.html = renderFormHtml(definition, nonce);

    this.panel.webview.onDidReceiveMessage(async (message: FormMessage) => {
      if (message.type === "submit") {
        if (this.submitInFlight || this.disposed) {
          return;
        }
        this.submitInFlight = true;
        try {
          await Promise.resolve(this.onSubmit(message.values));
          this.dispose();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Save failed: ${msg}`);
        } finally {
          this.submitInFlight = false;
        }
        return;
      }
      if (message.type === "cancel") {
        this.onCancel();
        this.dispose();
        return;
      }
      if (message.type === "browse" && this.onBrowse) {
        const result = await this.onBrowse(message.key);
        if (result && !this.disposed) {
          void this.panel.webview.postMessage({ type: "browseResult", key: message.key, path: result });
        }
      }
      if (message.type === "scan" && this.onScan) {
        const result = await this.onScan(message.key);
        if (result && !this.disposed) {
          void this.panel.webview.postMessage({ type: "browseResult", key: message.key, path: result });
        }
      }
      if (message.type === "createInline" && this.onCreateInline) {
        this.onCreateInline(message.key, message.values);
      }
      if (message.type === "autofill") {
        // `message.values` is the form's own snapshot at the moment the
        // autofill fired. Handlers that answer from the chosen id alone (the
        // auth-profile and device-template mirrors) simply do not declare the
        // parameter; the DHCP editor needs it to decide which fields its
        // derivation is allowed to overwrite.
        //
        // `message.previousValue` is threaded the same way and is a SEPARATE
        // fact from the snapshot rather than a slice of it: a select applies
        // its new option to the DOM before this request is posted, so the
        // snapshot already carries the new value under that key and the value
        // it replaced survives nowhere else. Forwarded verbatim, `undefined`
        // included (a text commit sends none) — this layer never invents one.
        //
        // REVIEW FINDING (P1) — the `finally` is the contract the webview
        // holds Save against: every request is answered exactly once, whether
        // it filled anything, filled nothing, or threw. A form that renders an
        // autofill-capable control but wires no `onAutofill` (none does today)
        // is answered here too, rather than leaving its Save button disabled
        // for the life of the panel.
        //
        // REVIEW FINDING (P2) — `requestId` is the webview's own correlation
        // handle and is echoed back verbatim on BOTH answers. It is captured
        // here rather than read off `message` at each post site so that the two
        // answers to one request can never carry different ids, and it is
        // deliberately opaque to this layer: no `onAutofill` handler is told
        // about it, because none of them has any reason to care which request
        // it is answering.
        const requestId = message.requestId;
        try {
          const result = this.onAutofill
            ? await this.onAutofill(message.key, message.value, message.values, message.previousValue)
            : undefined;
          if (result && !this.disposed) {
            // `key` travels back with the values: the webview tracks which keys
            // the AUTH PROFILE select filled (formHtml's profileFilledKeys), and
            // must not let another autofill-capable select's answer be mistaken
            // for the profile's.
            //
            // REVIEW FINDING (P2) — and `value` travels back with it, so the
            // webview can tell WHICH option this answer was composed for. This
            // await is a round trip the user can outrun: selecting a profile and
            // then `(None)` (or a different profile) before it returns left the
            // late answer being applied to a selection it does not describe,
            // putting a deselected profile's credentials into fields the release
            // had just unlocked — which the save path then stores as the user's
            // own. Answering with the id makes that answer discardable rather
            // than merely unlikely.
            void this.panel.webview.postMessage({
              type: "fillFields",
              key: message.key,
              value: message.value,
              values: result,
              requestId
            });
          }
        } finally {
          // Posted after the fill, so a submit the webview deferred is flushed
          // over the filled values rather than the ones it was holding.
          if (!this.disposed) {
            void this.panel.webview.postMessage({
              type: "autofillSettled",
              key: message.key,
              value: message.value,
              requestId
            });
          }
        }
      }
      if (message.type === "test" && this.onTest) {
        // REVIEW FINDING 2 (P2) — mirrors the `submit` handler's try/catch
        // above: an onTest implementation that lets a rejection escape (e.g.
        // a vault/SecretStorage read, or a forwarded command execution) must
        // never become an unhandled promise rejection inside this
        // fire-and-forget onDidReceiveMessage callback. Individual onTest
        // implementations are expected to report their own failures through
        // a more specific UI (see inventoryCommands.ts's handleFormTest), so
        // this is a last-resort safety net, not the primary failure path —
        // it only fires for an onTest that itself forgot to catch something.
        try {
          await Promise.resolve(this.onTest(message.values));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Test failed: ${msg}`);
        }
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      for (const listener of this.disposeListeners) {
        try {
          listener();
        } catch {
          // Never block panel cleanup on listener failures.
        }
      }
      this.disposeListeners.clear();
      WebviewFormPanel.activePanels.delete(formId);
    });
  }

  public static open(
    formId: string,
    definition: FormDefinition,
    options: {
      onSubmit: (values: FormValues) => void | Promise<void>;
      onCancel?: () => void;
      onBrowse?: (key: string) => Promise<string | undefined>;
      onScan?: (key: string) => Promise<string | undefined>;
      onCreateInline?: (key: string, values?: FormValues) => void;
      onAutofill?: (
        key: string,
        value: string,
        values?: FormValues,
        previousValue?: string
      ) => Promise<Record<string, string> | undefined>;
      onTest?: (values: FormValues) => void | Promise<void>;
    }
  ): WebviewFormPanel {
    const existing = WebviewFormPanel.activePanels.get(formId);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const instance = new WebviewFormPanel(
      formId,
      definition,
      options.onSubmit,
      options.onCancel ?? (() => {}),
      options.onBrowse,
      options.onScan,
      options.onCreateInline,
      options.onAutofill,
      options.onTest
    );
    WebviewFormPanel.activePanels.set(formId, instance);
    return instance;
  }

  /**
   * `fillValue` (FIX B, PR #64 Codex round 2) — the injected option's raw
   * synchronous-fill value for a `fillTarget` select (e.g. a just-saved filter's
   * query string). Optional and additive: inline-create callers that fill nothing
   * (auth profile, device template) omit it, and the webview only acts on it for a
   * select declaring a `fillTarget`.
   */
  public addSelectOption(key: string, value: string, label: string, description?: string, fillValue?: string): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: "addSelectOption", key, value, label, description, fillValue });
    }
  }

  public onDidDispose(listener: () => void): vscode.Disposable {
    if (this.disposed) {
      listener();
      return { dispose: () => {} };
    }
    this.disposeListeners.add(listener);
    return {
      dispose: () => {
        this.disposeListeners.delete(listener);
      }
    };
  }

  public dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }
}
