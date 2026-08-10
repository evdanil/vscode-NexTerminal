import { escapeHtml } from "./shared/escapeHtml";
import { baseWebviewCss } from "./shared/webviewStyles";
import { renderWebviewDocument } from "./shared/webviewDocument";

/**
 * The closed set of per-row actions a management list can offer. The webview
 * NEVER names the command to run (P0-3) — it posts one of these keys and the
 * HOST maps key → command per panel kind. `edit` doubles as the row-click /
 * name-button default.
 */
export type ManagementActionKey = "edit" | "delete" | "sync" | "rules" | "remove";

/** One record rendered as a list row. `actions` is ordered as it renders — the
 * destructive action (delete/remove) LAST, so the render can drop a gap in front
 * of it without re-sorting. */
export interface ManagementRow {
  id: string;
  name: string;
  description: string;
  actions: ManagementActionKey[];
}

/** Everything `renderManagementListHtml` needs — the presentation projection of a
 * `ManagementListDescriptor` (see managementListPanel.ts). */
export interface ManagementListView {
  /** Collection name in the sticky header `<h2>`. */
  title: string;
  /** The singular noun woven into every per-row action's aria-label, e.g.
   * "device template" / "inventory source". */
  nounSingular: string;
  /** The primary "New …" button label (ellipsis only when a picker follows). */
  primaryLabel: string;
  /** Constructive empty-state copy (em-dash fragment form). */
  emptyState: string;
  /** Rows, already sorted `naturalCompare(name)` by the descriptor. */
  rows: ManagementRow[];
}

interface ActionMeta {
  label: string;
  destructive: boolean;
  aria: (noun: string, name: string) => string;
}

/**
 * Per-action button metadata. The `aria` builder names the record so a
 * screen-reader user hears the target of every button ("Delete device template
 * Core Routers", "Sync inventory source Prod NetBox now"). `destructive`
 * (delete/remove) is rendered LAST with a leading gap.
 */
const ACTION_META: Record<ManagementActionKey, ActionMeta> = {
  edit: { label: "Edit", destructive: false, aria: (n, name) => `Edit ${n} ${name}` },
  delete: { label: "Delete", destructive: true, aria: (n, name) => `Delete ${n} ${name}` },
  sync: { label: "Sync", destructive: false, aria: (n, name) => `Sync ${n} ${name} now` },
  rules: { label: "Rules", destructive: false, aria: (n, name) => `Edit template rules for ${n} ${name}` },
  remove: { label: "Remove", destructive: true, aria: (n, name) => `Remove ${n} ${name}` }
};

function renderActionButton(action: ManagementActionKey, row: ManagementRow, noun: string): string {
  const meta = ACTION_META[action];
  const cls = `btn-secondary mgmt-action${meta.destructive ? " mgmt-destructive" : ""}`;
  return (
    `<button type="button" class="${cls}" data-action="${action}" data-id="${escapeHtml(row.id)}" ` +
    `aria-label="${escapeHtml(meta.aria(noun, row.name))}">${escapeHtml(meta.label)}</button>`
  );
}

function renderRow(row: ManagementRow, noun: string): string {
  const actionsHtml = row.actions.map((a) => renderActionButton(a, row, noun)).join("\n          ");
  // The name is itself a real <button> that fires `edit` (row-click default), so
  // it is Tab-reachable and Enter-activatable; its accessible name is the record
  // name. `title` carries the full text for the ellipsized single line.
  return `<li class="mgmt-row" data-id="${escapeHtml(row.id)}">
        <div class="mgmt-row-main">
          <button type="button" class="mgmt-name" data-action="edit" data-id="${escapeHtml(row.id)}" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</button>
          <div class="mgmt-actions">
            ${actionsHtml}
          </div>
        </div>
        <div class="mgmt-desc" title="${escapeHtml(row.description)}">${escapeHtml(row.description)}</div>
      </li>`;
}

/**
 * Renders a management list panel through the shared webview toolkit
 * (`renderWebviewDocument` + `baseWebviewCss`), so its chrome is indistinguishable
 * from the Auth Profiles editor and the form editors. The empty state is produced
 * by the SAME function (not a separate path), so deleting the last record lands on
 * it live. All record text is `escapeHtml`-escaped (names/descriptions are
 * user/provider-supplied). The webview posts only `{type:"new"}` /
 * `{type:"action", action, id}` — never a command name.
 */
export function renderManagementListHtml(view: ManagementListView, nonce: string): string {
  const primaryButton = `<button type="button" class="btn-primary mgmt-new-btn">${escapeHtml(view.primaryLabel)}</button>`;

  const listOrEmpty =
    view.rows.length === 0
      ? `  <div class="mgmt-empty" role="status">
    <p>${escapeHtml(view.emptyState)}</p>
    ${primaryButton}
  </div>`
      : `  <ul role="list" class="mgmt-list">
      ${view.rows.map((r) => renderRow(r, view.nounSingular)).join("\n      ")}
  </ul>`;

  return renderWebviewDocument({
    nonce,
    css: `    ${baseWebviewCss()}
    .mgmt-header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
      padding: 20px 20px 12px 20px;
      margin: -20px -20px 12px -20px;
    }
    .mgmt-header h2 {
      margin: 0;
    }
    .mgmt-header .mgmt-spacer {
      flex: 1;
    }
    .mgmt-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .mgmt-row {
      padding: 8px 4px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
      cursor: pointer;
    }
    .mgmt-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .mgmt-row-main {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .mgmt-name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 500;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      text-align: left;
      padding: 2px 0;
      cursor: pointer;
      font-family: inherit;
    }
    .mgmt-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }
    .mgmt-action {
      padding: 4px 10px;
      font-size: 12px;
    }
    .mgmt-destructive {
      margin-left: 16px;
    }
    .mgmt-desc {
      font-size: 11px;
      opacity: 0.75;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .mgmt-empty {
      text-align: center;
      padding: 32px 0;
      color: var(--vscode-descriptionForeground);
    }
    .mgmt-empty p {
      margin: 0 0 16px 0;
      line-height: 1.4;
    }
    .mgmt-name:focus-visible,
    .mgmt-action:focus-visible,
    .btn-primary:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }`,
    body: `  <div class="mgmt-header">
    <h2>${escapeHtml(view.title)}</h2>
    <div class="mgmt-spacer"></div>
    ${primaryButton}
  </div>
${listOrEmpty}
`,
    script: `    (function() {
      var vscode = acquireVsCodeApi();
      var state = vscode.getState() || {};

      function post(msg) { vscode.postMessage(msg); }

      // ── Dispatch (closed action keys only) ──────────────────────────────
      document.addEventListener("click", function(e) {
        var newBtn = e.target.closest(".mgmt-new-btn");
        if (newBtn) { post({ type: "new" }); return; }
        var actionBtn = e.target.closest("[data-action]");
        if (actionBtn) {
          // Action buttons stop the click bubbling so the row-click default
          // (edit) never double-fires with an explicit action.
          e.stopPropagation();
          post({ type: "action", action: actionBtn.getAttribute("data-action"), id: actionBtn.getAttribute("data-id") });
          return;
        }
        var row = e.target.closest(".mgmt-row");
        if (row) { post({ type: "action", action: "edit", id: row.getAttribute("data-id") }); }
      });

      // ── Scroll + focus preservation across re-renders ───────────────────
      // Child-editor saves re-render this list; keep the user's place.
      function findButton(id, action) {
        var btns = document.querySelectorAll("[data-action]");
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute("data-id") === id && btns[i].getAttribute("data-action") === action) return btns[i];
        }
        return null;
      }
      function rowIndexOf(el) {
        var row = el.closest ? el.closest(".mgmt-row") : null;
        if (!row) return -1;
        var rows = document.querySelectorAll(".mgmt-row");
        for (var i = 0; i < rows.length; i++) { if (rows[i] === row) return i; }
        return -1;
      }
      document.addEventListener("focusin", function(e) {
        var t = e.target;
        if (t.classList && t.classList.contains("mgmt-new-btn")) {
          state.focusKey = "new";
          state.focusIndex = -1;
          vscode.setState(state);
          return;
        }
        var action = t.getAttribute && t.getAttribute("data-action");
        var id = t.getAttribute && t.getAttribute("data-id");
        if (action && id) {
          state.focusKey = id + "\\n" + action;
          state.focusIndex = rowIndexOf(t);
          vscode.setState(state);
        }
      });
      window.addEventListener("scroll", function() {
        state.scrollY = window.scrollY;
        vscode.setState(state);
      });

      if (typeof state.scrollY === "number") { window.scrollTo(0, state.scrollY); }
      (function restoreFocus() {
        var key = state.focusKey;
        if (!key) return;
        if (key === "new") {
          var nb = document.querySelector(".mgmt-new-btn");
          if (nb) nb.focus();
          return;
        }
        var sep = key.indexOf("\\n");
        if (sep < 0) return;
        var id = key.slice(0, sep);
        var action = key.slice(sep + 1);
        var target = findButton(id, action);
        if (target) { target.focus(); return; }
        // Focused record was deleted → the row now at that index, else the New button.
        var rows = document.querySelectorAll(".mgmt-row");
        if (rows.length > 0) {
          var idx = typeof state.focusIndex === "number" ? state.focusIndex : 0;
          if (idx < 0) idx = 0;
          if (idx >= rows.length) idx = rows.length - 1;
          var nameBtn = rows[idx].querySelector(".mgmt-name");
          if (nameBtn) nameBtn.focus();
          return;
        }
        var nb2 = document.querySelector(".mgmt-new-btn");
        if (nb2) nb2.focus();
      })();
    })();`
  });
}
