import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import { createWebviewNonce } from "./shared/webviewNonce";
import {
  renderManagementListHtml,
  type ManagementActionKey,
  type ManagementListView,
  type ManagementRow
} from "./managementListHtml";

/**
 * Host-side, per-kind driver for a `ManagementListPanel`. Device Templates and
 * Inventory Sources share ALL of the panel's layout/behavior by supplying one of
 * these. The panel is a thin presentation layer: it renders `list()` and, on a
 * row action, dispatches the command `commandFor(action)` returns — the SAME
 * commands today's QuickPick hubs dispatch — never a command the webview named.
 */
export interface ManagementListDescriptor {
  /** Webview type id (also the singleton key), e.g. `"nexus.deviceTemplatesPanel"`. */
  viewType: string;
  /** Collection name shown in the tab title and the in-body `<h2>`. */
  title: string;
  /** Singular noun woven into per-row action aria-labels ("device template"). */
  nounSingular: string;
  /** Primary "New …" button label. Ellipsis ONLY when a picker follows. */
  primaryLabel: string;
  /** Constructive empty-state copy (em-dash fragment form). */
  emptyState: string;
  /** Rows from the live snapshot, sorted `naturalCompare(name)`. */
  list(): ManagementRow[];
  /** A stable string derived from the records; the panel re-renders only when it
   * changes (mirrors the auth editor's signature guard). */
  signature(): string;
  /** Maps a closed action key (or `"new"`) to the command id to dispatch, per
   * kind. The HOST owns this mapping — the webview never sees a command name. */
  commandFor(action: ManagementActionKey | "new"): string;
}

/**
 * The result of validating a webview message against the live descriptor. Kept a
 * pure value (no vscode) so the host action mapping is unit-testable end to end:
 * a valid id resolves to a `dispatch`; an id no longer in the snapshot resolves
 * to `stale` (re-render, never dispatch); anything malformed resolves to
 * `undefined` (ignored).
 */
export type ManagementDispatch =
  | { type: "dispatch"; command: string; id?: string }
  | { type: "stale" }
  | undefined;

const ACTION_KEYS: ReadonlySet<string> = new Set<ManagementActionKey>(["edit", "delete", "sync", "rules", "remove"]);

/**
 * Validate + map a webview message to a host dispatch. The webview posts a CLOSED
 * action key and a record id; this maps the key → command PER KIND (via the
 * descriptor) and validates the id against the CURRENT snapshot before dispatch.
 * No `commandId` ever crosses the webview boundary.
 */
export function resolveManagementMessage(descriptor: ManagementListDescriptor, msg: unknown): ManagementDispatch {
  if (!msg || typeof msg !== "object") {
    return undefined;
  }
  const m = msg as Record<string, unknown>;
  if (m.type === "new") {
    return { type: "dispatch", command: descriptor.commandFor("new") };
  }
  if (m.type !== "action") {
    return undefined;
  }
  const action = m.action;
  const id = m.id;
  if (typeof action !== "string" || !ACTION_KEYS.has(action) || typeof id !== "string") {
    return undefined;
  }
  const key = action as ManagementActionKey;
  const row = descriptor.list().find((r) => r.id === id);
  if (!row) {
    // The record vanished (deleted elsewhere) between render and click — re-render
    // rather than dispatch. The command would own its own "no longer exists"
    // message anyway, but not dispatching keeps the list honest.
    return { type: "stale" };
  }
  if (!row.actions.includes(key)) {
    return undefined; // the row does not offer this action
  }
  return { type: "dispatch", command: descriptor.commandFor(key), id };
}

/**
 * Singleton-per-kind webview list panel. Re-invoking `open` for a viewType that is
 * already showing reveals it (never duplicates). Mirrors `AuthProfileEditorPanel`:
 * a signature-guarded `core.onDidChange` re-render, an `onDidChangeViewState`
 * freshen when it becomes visible (so relative timestamps like "synced 3h ago"
 * update), and subscription cleanup in `onDidDispose`.
 */
export class ManagementListPanel {
  private static readonly instances = new Map<string, ManagementListPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private unsubscribe: () => void = () => {};
  private lastSignature: string;

  private constructor(private readonly core: NexusCore, private readonly descriptor: ManagementListDescriptor) {
    this.lastSignature = descriptor.signature();
    this.panel = vscode.window.createWebviewPanel(descriptor.viewType, descriptor.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    this.render();
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidChangeViewState((e) => {
      // Freshen on becoming visible: relative last-sync phrasing (and any drift
      // from a change missed while hidden) is re-rendered here.
      if (e.webviewPanel.visible) {
        this.render();
      }
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.unsubscribe();
      ManagementListPanel.instances.delete(descriptor.viewType);
    });
    this.unsubscribe = core.onDidChange(() => {
      const sig = this.descriptor.signature();
      if (sig !== this.lastSignature) {
        this.lastSignature = sig;
        this.render();
      }
    });
  }

  public static open(core: NexusCore, descriptor: ManagementListDescriptor): void {
    const existing = ManagementListPanel.instances.get(descriptor.viewType);
    if (existing) {
      // Freshen before revealing: `onDidChangeViewState` fires only on a
      // visibility TRANSITION, so an explicit re-invoke while the panel is
      // already the active tab would otherwise leave relative phrasing
      // ("synced 3h ago") stale. A render is cheap and idempotent.
      existing.render();
      existing.panel.reveal();
      return;
    }
    ManagementListPanel.instances.set(descriptor.viewType, new ManagementListPanel(core, descriptor));
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const nonce = createWebviewNonce();
    this.lastSignature = this.descriptor.signature();
    const view: ManagementListView = {
      title: this.descriptor.title,
      nounSingular: this.descriptor.nounSingular,
      primaryLabel: this.descriptor.primaryLabel,
      emptyState: this.descriptor.emptyState,
      rows: this.descriptor.list()
    };
    this.panel.webview.html = renderManagementListHtml(view, nonce);
  }

  private handleMessage(msg: unknown): void {
    const result = resolveManagementMessage(this.descriptor, msg);
    if (!result) {
      return;
    }
    if (result.type === "stale") {
      this.render();
      return;
    }
    // Dispatch the SAME command the QuickPick hub dispatched — with the id when the
    // action carries one. The command owns every race guard, busy-marker, revision
    // check, drift-refusal and disposition modal; this panel adds none and weakens
    // none.
    if (result.id !== undefined) {
      void vscode.commands.executeCommand(result.command, result.id);
    } else {
      void vscode.commands.executeCommand(result.command);
    }
  }
}
