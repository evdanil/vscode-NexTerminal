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
    private readonly onAutofill?: (key: string, value: string) => Promise<Record<string, string> | undefined>,
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
      if (message.type === "autofill" && this.onAutofill) {
        const result = await this.onAutofill(message.key, message.value);
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
            values: result
          });
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
      onAutofill?: (key: string, value: string) => Promise<Record<string, string> | undefined>;
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
