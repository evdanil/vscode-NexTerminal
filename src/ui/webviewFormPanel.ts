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
    private readonly onBrowse?: (key: string) => Promise<string | undefined>
  ) {
    this.panel = vscode.window.createWebviewPanel(
      `nexus.form.${formId}`,
      definition.title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );

    this.panel.webview.html = renderFormHtml(definition);

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
      options.onBrowse
    );
    WebviewFormPanel.activePanels.set(formId, instance);
    return instance;
  }

  public sendValidationErrors(errors: Record<string, string>): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: "validationError", errors });
    }
  }

  public dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }
}
