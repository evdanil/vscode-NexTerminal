import * as vscode from "vscode";
import { flattenProviderText } from "../models/inventory";
import { isHighlightProfileSelection } from "../utils/highlightProfileValidation";
import { renderHighlightRuleEditorHtml } from "./highlightRuleEditorHtml";
import { createWebviewNonce } from "./shared/webviewNonce";
import { readHighlightEditorState, saveHighlightEditorCatalog } from "./highlightProfileEditorStore";

export class HighlightRuleEditorPanel {
  private static instance: HighlightRuleEditorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private readonly configListener: vscode.Disposable;
  private readonly confirmedDeletions = new Map<string, { saved: number; live: number; revision: string }>();

  private constructor(private readonly countReferences: (id: string) => { saved: number; live: number }) {
    this.panel = vscode.window.createWebviewPanel(
      "nexus.highlightRuleEditor", "Highlight Profiles", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!this.disposed && event.affectsConfiguration("nexus.terminal.highlighting")) {
        void this.panel.webview.postMessage({ type: "catalogUpdated", state: readHighlightEditorState() });
      }
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.configListener.dispose();
      HighlightRuleEditorPanel.instance = undefined;
    });
  }

  public static open(countReferences: (id: string) => { saved: number; live: number } = () => ({ saved: 0, live: 0 })): void {
    if (HighlightRuleEditorPanel.instance) {
      HighlightRuleEditorPanel.instance.panel.reveal();
      return;
    }
    HighlightRuleEditorPanel.instance = new HighlightRuleEditorPanel(countReferences);
  }

  private render(): void {
    const state = readHighlightEditorState();
    this.panel.webview.html = renderHighlightRuleEditorHtml([], createWebviewNonce(), state);
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return;
    const request = msg as Record<string, unknown>;
    if (request.type === "openHighlightingSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@id:nexus.terminal.highlighting.enabled");
    } else if (request.type === "openHighlightSettingsJson") {
      const command = request.scope === "user" ? "workbench.action.openSettingsJson"
        : request.scope === "workspace" ? "workbench.action.openWorkspaceSettingsFile" : undefined;
      if (command) await vscode.commands.executeCommand(command);
    } else if (request.type === "cancelCatalogDraft") {
      this.confirmedDeletions.clear();
    } else if (request.type === "saveCatalog") {
      const state = readHighlightEditorState();
      if (state.revision === request.revision && Array.isArray(request.profiles)) {
        const retained = new Set(request.profiles.flatMap((item: unknown) => typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []));
        for (const profile of state.catalog.profiles) {
          if (retained.has(profile.id)) continue;
          const approved = this.confirmedDeletions.get(profile.id);
          if (!approved || approved.revision !== state.revision) {
            void this.panel.webview.postMessage({ type: "catalogSaveResult", ok: false, message: "Please confirm each profile deletion before saving." });
            return;
          }
          const counts = this.countReferences(profile.id);
          if (counts.saved !== approved.saved || counts.live !== approved.live) {
            const name = flattenProviderText(profile.name).slice(0, 100);
            const confirm = await vscode.window.showWarningMessage(
              `References to "${name}" changed: ${counts.saved} saved connections and ${counts.live} live sessions. Delete this profile?`,
              { modal: true }, "Delete"
            );
            if (confirm !== "Delete") {
              void this.panel.webview.postMessage({ type: "catalogSaveResult", ok: false, message: "Deletion was not confirmed. Your draft is unchanged." });
              return;
            }
          }
        }
      }
      const result = await saveHighlightEditorCatalog(request.profiles, request.defaultProfileId, request.revision);
      if (this.disposed) return;
      if (result.ok) this.confirmedDeletions.clear();
      void this.panel.webview.postMessage(result.ok
        ? { type: "catalogSaveResult", ok: true, revision: result.state.revision }
        : { type: "catalogSaveResult", ok: false, message: result.message });
    } else if (request.type === "confirmDeleteProfile") {
      if (typeof request.profileId !== "string" || !isHighlightProfileSelection(request.profileId)) return;
      const id = request.profileId;
      const state = readHighlightEditorState();
      const savedName = state.catalog.profiles.find((profile) => profile.id === id)?.name;
      const name = flattenProviderText(savedName ?? (typeof request.profileName === "string" ? request.profileName : "this profile")).slice(0, 100);
      const counts = this.countReferences(id);
      const confirm = await vscode.window.showWarningMessage(
        `Delete highlight profile "${name}"? It is selected by ${counts.saved} saved connections and ${counts.live} live sessions. Their selection will become unavailable.`,
        { modal: true }, "Delete"
      );
      if (confirm === "Delete") this.confirmedDeletions.set(id, { ...counts, revision: state.revision });
      if (!this.disposed) void this.panel.webview.postMessage({ type: "confirmDeleteProfileResult", profileId: id, confirmed: confirm === "Delete" });
    }
  }
}
