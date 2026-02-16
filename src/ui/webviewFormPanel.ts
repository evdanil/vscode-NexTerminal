import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { renderFormHtml } from "./formHtml";
import type { FormDefinition, FormMessage, FormValues } from "./formTypes";

export class WebviewFormPanel {
  private static activePanels = new Map<string, WebviewFormPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    private readonly formId: string,
    definition: FormDefinition,
    private readonly onSubmit: (values: FormValues) => void,
    private readonly onCancel: () => void,
    private readonly onBrowse?: (key: string) => Promise<string | undefined>,
    private readonly onScan?: (key: string) => Promise<string | undefined>,
    private readonly onCreateInline?: (key: string) => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      `nexus.form.${formId}`,
      definition.title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );

    const nonce = randomBytes(16).toString("base64");
    this.panel.webview.html = renderFormHtml(definition, nonce);

    this.panel.webview.onDidReceiveMessage(async (message: FormMessage) => {
      if (message.type === "submit") {
        this.onSubmit(message.values);
        this.dispose();
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
        this.onCreateInline(message.key);
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      WebviewFormPanel.activePanels.delete(formId);
    });
  }

  public static open(
    formId: string,
    definition: FormDefinition,
    options: {
      onSubmit: (values: FormValues) => void;
      onCancel?: () => void;
      onBrowse?: (key: string) => Promise<string | undefined>;
      onScan?: (key: string) => Promise<string | undefined>;
      onCreateInline?: (key: string) => void;
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
      options.onCreateInline
    );
    WebviewFormPanel.activePanels.set(formId, instance);
    return instance;
  }

  public addSelectOption(key: string, value: string, label: string): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: "addSelectOption", key, value, label });
    }
  }

  public dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }
}
