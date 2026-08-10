import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// managementListPanel imports vscode (for the panel class); the pure resolver +
// html do not touch it, but the module-level import must resolve. A minimal stub
// is enough — no test here constructs the panel class.
vi.mock("vscode", () => ({
  window: { createWebviewPanel: vi.fn() },
  commands: { executeCommand: vi.fn() },
  ViewColumn: { Active: -1 }
}));

const { renderManagementListHtml } = await import("../../src/ui/managementListHtml");
const { resolveManagementMessage, ManagementListPanel } = await import("../../src/ui/managementListPanel");
const vscodeMock = (await import("vscode")) as unknown as {
  window: { createWebviewPanel: ReturnType<typeof vi.fn> };
  commands: { executeCommand: ReturnType<typeof vi.fn> };
};
import type { ManagementListView, ManagementRow } from "../../src/ui/managementListHtml";
import type { ManagementListDescriptor } from "../../src/ui/managementListPanel";
import type { NexusCore } from "../../src/core/nexusCore";

const NONCE = "N0NCE";

function templatesView(overrides: Partial<ManagementListView> = {}): ManagementListView {
  return {
    title: "Device Templates",
    nounSingular: "device template",
    primaryLabel: "New Device Template",
    emptyState: "No device templates yet — apply shared settings.",
    rows: [{ id: "t1", name: "Core Routers", description: "Sets: Proxy, Auth Profile", actions: ["edit", "delete"] }],
    ...overrides
  };
}

function inventoryView(overrides: Partial<ManagementListView> = {}): ManagementListView {
  return {
    title: "Inventory Sources",
    nounSingular: "inventory source",
    primaryLabel: "New Inventory Source…",
    emptyState: "No inventory sources yet — add one.",
    rows: [{ id: "s1", name: "Prod NetBox", description: "NetBox — synced 3h ago", actions: ["sync", "edit", "rules", "remove"] }],
    ...overrides
  };
}

describe("renderManagementListHtml", () => {
  it("renders each row's name and description ESCAPED (user/provider-supplied)", () => {
    const html = renderManagementListHtml(
      templatesView({ rows: [{ id: "t1", name: `<b>"Core"</b>`, description: "a & b <x>", actions: ["edit", "delete"] }] }),
      NONCE
    );
    expect(html).toContain("&lt;b&gt;&quot;Core&quot;&lt;/b&gt;");
    expect(html).toContain("a &amp; b &lt;x&gt;");
    // The raw, unescaped forms must NOT appear.
    expect(html).not.toContain("<b>\"Core\"</b>");
  });

  // Locate an ACTION-cluster button (they carry aria-label; the name button does
  // not), so the ordering checks never match the name button's data-action="edit".
  function actionIdx(html: string, action: string): number {
    return html.indexOf(`data-action="${action}" data-id=`, html.indexOf('class="btn-secondary mgmt-action'));
  }

  it("renders the per-kind action buttons for device templates (edit, then destructive delete LAST)", () => {
    const html = renderManagementListHtml(templatesView(), NONCE);
    const editIdx = actionIdx(html, "edit");
    const deleteIdx = actionIdx(html, "delete");
    expect(editIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    // Destructive last: delete renders after edit, and carries the gap class.
    expect(deleteIdx).toBeGreaterThan(editIdx);
    expect(html).toContain('class="btn-secondary mgmt-action mgmt-destructive" data-action="delete"');
  });

  it("renders the four inventory actions in order with remove LAST and gapped", () => {
    const html = renderManagementListHtml(inventoryView(), NONCE);
    const order = ["sync", "edit", "rules", "remove"].map((a) => actionIdx(html, a));
    expect(order.every((i) => i > -1)).toBe(true);
    // Strictly increasing → rendered in that order, remove last.
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
    expect(html).toContain('class="btn-secondary mgmt-action mgmt-destructive" data-action="remove"');
  });

  it("gives every per-row action button an aria-label NAMING the record", () => {
    expect(renderManagementListHtml(templatesView(), NONCE)).toContain('aria-label="Delete device template Core Routers"');
    const inv = renderManagementListHtml(inventoryView(), NONCE);
    expect(inv).toContain('aria-label="Sync inventory source Prod NetBox now"');
    expect(inv).toContain('aria-label="Remove inventory source Prod NetBox"');
    expect(inv).toContain('aria-label="Edit template rules for inventory source Prod NetBox"');
  });

  it("renders the empty state (role=status) with a working New button when there are no rows — same render path", () => {
    const html = renderManagementListHtml(templatesView({ rows: [] }), NONCE);
    expect(html).toContain('class="mgmt-empty" role="status"');
    expect(html).toContain("No device templates yet — apply shared settings.");
    // The primary New button is present in the empty state too.
    expect(html).toContain("mgmt-new-btn");
    // No list rows.
    expect(html).not.toContain('class="mgmt-row"');
  });

  // Extract the inner text of the single <script> slot, so the "no command name"
  // assertion tests the PROTOCOL the script speaks, not incidental record text
  // elsewhere in the document (P2-7b — a record named "nexus.example.com" must
  // not trip a document-wide `not.toContain("nexus.")`).
  function scriptSlot(html: string): string {
    const start = html.indexOf("<script");
    const openEnd = html.indexOf(">", start);
    const closeStart = html.indexOf("</script>", openEnd);
    return html.slice(openEnd + 1, closeStart);
  }

  it("posts ONLY closed action keys — never a command name, scoped to the <script> slot (P0-3, P2-7b)", () => {
    const html = renderManagementListHtml(inventoryView(), NONCE);
    const script = scriptSlot(html);
    // The script posts the closed protocol.
    expect(script).toContain('type: "new"');
    expect(script).toContain('type: "action"');
    // No command id ever crosses the webview boundary — asserted against the
    // SCRIPT only, so a record whose name/description happens to contain "nexus."
    // (a hostname, say) cannot make this pass or fail incidentally.
    expect(script).not.toContain("nexus.");
    expect(script).not.toContain("commandId");
    expect(script).not.toContain("executeCommand");
  });

  it("a record named like a command id does NOT defeat the scoped protocol check (P2-7b — the old document-wide assertion would false-positive)", () => {
    const html = renderManagementListHtml(
      inventoryView({ rows: [{ id: "s1", name: "nexus.example.com", description: "NetBox — nexus.core", actions: ["sync", "edit", "rules", "remove"] }] }),
      NONCE
    );
    // The record text legitimately carries "nexus." in the BODY…
    expect(html).toContain("nexus.example.com");
    // …but the script slot still names no command.
    expect(scriptSlot(html)).not.toContain("nexus.");
  });

  it("escapes a HOSTILE id in every attribute context — no raw quote breakout (P2-7a)", () => {
    const hostile = 't1" onclick=alert(1)';
    const html = renderManagementListHtml(
      templatesView({ rows: [{ id: hostile, name: "Core", description: "d", actions: ["edit", "delete"] }] }),
      NONCE
    );
    // The id lands in several data-id attributes (the <li>, the name button, and
    // each action button) plus the post() payload; every one must be escaped.
    expect(html).toContain("t1&quot; onclick=alert(1)");
    // The raw, unescaped id must NOT appear in any attribute — i.e. no `data-id="t1"`
    // followed by a live `onclick` breakout.
    expect(html).not.toContain('data-id="t1" onclick');
    expect(html).not.toContain('t1" onclick=alert(1)');
  });

  it("the name is a real <button> that fires edit (row-click default, Tab/Enter reachable)", () => {
    const html = renderManagementListHtml(templatesView(), NONCE);
    expect(html).toContain('<button type="button" class="mgmt-name" data-action="edit" data-id="t1"');
  });
});

// A fake device-templates descriptor: rows drive snapshot validation, commandFor is
// the per-kind map under test.
function fakeTemplatesDescriptor(rows: ManagementRow[]): ManagementListDescriptor {
  return {
    viewType: "nexus.deviceTemplatesPanel",
    title: "Device Templates",
    nounSingular: "device template",
    primaryLabel: "New Device Template",
    emptyState: "—",
    list: () => rows,
    signature: () => "",
    commandFor: (action) =>
      action === "new" ? "nexus.deviceTemplate.add" : action === "delete" ? "nexus.deviceTemplate.delete" : "nexus.deviceTemplate.edit"
  };
}

describe("resolveManagementMessage — host action mapping (validate id in snapshot, map key→command)", () => {
  const rows: ManagementRow[] = [{ id: "t1", name: "Core", description: "d", actions: ["edit", "delete"] }];

  it("maps {type:'new'} to the create command with no id", () => {
    expect(resolveManagementMessage(fakeTemplatesDescriptor(rows), { type: "new" })).toEqual({
      type: "dispatch",
      command: "nexus.deviceTemplate.add"
    });
  });

  it("a valid edit id dispatches the edit command WITH the id", () => {
    expect(resolveManagementMessage(fakeTemplatesDescriptor(rows), { type: "action", action: "edit", id: "t1" })).toEqual({
      type: "dispatch",
      command: "nexus.deviceTemplate.edit",
      id: "t1"
    });
  });

  it("a valid delete id dispatches the delete command WITH the id", () => {
    expect(resolveManagementMessage(fakeTemplatesDescriptor(rows), { type: "action", action: "delete", id: "t1" })).toEqual({
      type: "dispatch",
      command: "nexus.deviceTemplate.delete",
      id: "t1"
    });
  });

  it("an id NOT in the snapshot resolves to 'stale' — never a dispatch", () => {
    // Falsification: a resolver that skipped snapshot validation would dispatch.
    expect(resolveManagementMessage(fakeTemplatesDescriptor(rows), { type: "action", action: "edit", id: "ghost" })).toEqual({
      type: "stale"
    });
  });

  it("an action the row does not offer is ignored (undefined)", () => {
    // The device-template row offers only edit/delete — a 'sync' key is inert.
    expect(resolveManagementMessage(fakeTemplatesDescriptor(rows), { type: "action", action: "sync", id: "t1" })).toBeUndefined();
  });

  it("malformed messages (unknown action, missing id, non-object) are ignored", () => {
    const d = fakeTemplatesDescriptor(rows);
    expect(resolveManagementMessage(d, { type: "action", action: "bogus", id: "t1" })).toBeUndefined();
    expect(resolveManagementMessage(d, { type: "action", action: "edit" })).toBeUndefined();
    expect(resolveManagementMessage(d, { type: "wat" })).toBeUndefined();
    expect(resolveManagementMessage(d, null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P1-2 — the PANEL CLASS security boundary. `resolveManagementMessage` above is
// pure; these drive `ManagementListPanel` end to end (its captured
// `onDidReceiveMessage` handler → `vscode.commands.executeCommand`) so a host
// rewritten to trust the webview (`executeCommand(msg.command, msg.id)`) is
// actually caught. A fake webview panel captures the message/viewState/dispose
// handlers and the `html` setter; a fake core records onDidChange subscriptions.
// ---------------------------------------------------------------------------
interface CapturedPanel {
  viewType: string;
  title: string;
  htmlSetCount: number;
  revealCount: number;
  messageHandler?: (msg: unknown) => void;
  viewStateHandler?: (e: { webviewPanel: { visible: boolean } }) => void;
  disposeHandler?: () => void;
  fireDispose: () => void;
}

const createdPanels: CapturedPanel[] = [];

function installWebviewPanelFactory(): void {
  vscodeMock.window.createWebviewPanel.mockImplementation((viewType: string, title: string) => {
    const p: CapturedPanel & { webview: unknown; reveal: () => void; onDidChangeViewState: unknown; onDidDispose: unknown; dispose: () => void } =
      {
        viewType,
        title,
        htmlSetCount: 0,
        revealCount: 0,
        webview: {
          _html: "",
          onDidReceiveMessage(cb: (m: unknown) => void) {
            p.messageHandler = cb;
            return { dispose() {} };
          },
          get html(): string {
            return (this as { _html: string })._html;
          },
          set html(v: string) {
            (this as { _html: string })._html = v;
            p.htmlSetCount++;
          }
        },
        reveal() {
          p.revealCount++;
        },
        onDidChangeViewState(cb: (e: { webviewPanel: { visible: boolean } }) => void) {
          p.viewStateHandler = cb;
          return { dispose() {} };
        },
        onDidDispose(cb: () => void) {
          p.disposeHandler = cb;
          return { dispose() {} };
        },
        dispose() {
          p.fireDispose();
        },
        fireDispose() {
          if (p.disposeHandler) p.disposeHandler();
        }
      };
    createdPanels.push(p);
    return p;
  });
}

function makeFakeCore(): { onDidChange: (cb: () => void) => () => void; fire: () => void; listenerCount: () => number } {
  const listeners: Array<() => void> = [];
  return {
    onDidChange(cb: () => void) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    fire() {
      listeners.slice().forEach((cb) => cb());
    },
    listenerCount() {
      return listeners.length;
    }
  };
}

function panelDescriptor(overrides: Partial<ManagementListDescriptor> = {}): ManagementListDescriptor {
  return {
    viewType: "nexus.deviceTemplatesPanel",
    title: "Device Templates",
    nounSingular: "device template",
    primaryLabel: "New Device Template",
    emptyState: "—",
    list: () => [{ id: "t1", name: "Core", description: "d", actions: ["edit", "delete"] }],
    signature: () => "sig",
    commandFor: (action) =>
      action === "new" ? "nexus.deviceTemplate.add" : action === "delete" ? "nexus.deviceTemplate.delete" : "nexus.deviceTemplate.edit",
    ...overrides
  };
}

const asCore = (c: ReturnType<typeof makeFakeCore>): NexusCore => c as unknown as NexusCore;

describe("ManagementListPanel — host message boundary (handleMessage → executeCommand)", () => {
  beforeEach(() => {
    createdPanels.length = 0;
    vscodeMock.window.createWebviewPanel.mockReset();
    vscodeMock.commands.executeCommand.mockReset();
    installWebviewPanelFactory();
  });

  afterEach(() => {
    // Dispose everything so the class's static singleton map is emptied between
    // tests (onDidDispose deletes the instance by viewType).
    for (const p of createdPanels) p.fireDispose();
  });

  it("(a) a live edit action dispatches the MAPPED command WITH the id — never a webview-named command", () => {
    const core = makeFakeCore();
    ManagementListPanel.open(asCore(core), panelDescriptor());
    const panel = createdPanels[0];
    panel.messageHandler!({ type: "action", action: "edit", id: "t1" });
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("nexus.deviceTemplate.edit", "t1");
  });

  it("(b) a ghost id dispatches NOTHING and triggers a stale re-render", () => {
    const core = makeFakeCore();
    ManagementListPanel.open(asCore(core), panelDescriptor());
    const panel = createdPanels[0];
    const before = panel.htmlSetCount; // 1 (constructor render)
    panel.messageHandler!({ type: "action", action: "edit", id: "ghost" });
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    expect(panel.htmlSetCount).toBe(before + 1); // re-rendered (stale)
  });

  it("(c) an injected `command` field is IGNORED — only the mapped command fires (falsifies a trust-the-webview host)", () => {
    const core = makeFakeCore();
    ManagementListPanel.open(asCore(core), panelDescriptor());
    const panel = createdPanels[0];
    panel.messageHandler!({
      type: "action",
      action: "edit",
      id: "t1",
      command: "workbench.action.terminal.sendSequence"
    });
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("nexus.deviceTemplate.edit", "t1");
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence");
  });

  it("(d) re-opening the same descriptor reveals the singleton — one createWebviewPanel, one reveal", () => {
    const core = makeFakeCore();
    const desc = panelDescriptor();
    ManagementListPanel.open(asCore(core), desc);
    ManagementListPanel.open(asCore(core), desc);
    expect(vscodeMock.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].revealCount).toBe(1);
  });

  it("(P2-5) re-invoking open re-renders the existing panel before revealing (stale relative timestamps)", () => {
    const core = makeFakeCore();
    const desc = panelDescriptor();
    ManagementListPanel.open(asCore(core), desc);
    const panel = createdPanels[0];
    const before = panel.htmlSetCount; // 1
    ManagementListPanel.open(asCore(core), desc);
    // Falsification: a reveal-only open (no `existing.render()`) leaves this at `before`.
    expect(panel.htmlSetCount).toBe(before + 1);
    expect(panel.revealCount).toBe(1);
  });

  it("(e) opening both kinds yields two independent instances (no cross-kind clobber)", () => {
    const core = makeFakeCore();
    ManagementListPanel.open(asCore(core), panelDescriptor({ viewType: "nexus.deviceTemplatesPanel", title: "Device Templates" }));
    ManagementListPanel.open(asCore(core), panelDescriptor({ viewType: "nexus.inventorySourcesPanel", title: "Inventory Sources" }));
    expect(vscodeMock.window.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(createdPanels.map((p) => p.viewType)).toEqual(["nexus.deviceTemplatesPanel", "nexus.inventorySourcesPanel"]);
    expect(createdPanels.every((p) => p.revealCount === 0)).toBe(true);
  });

  it("(f) onDidDispose unsubscribes the core.onDidChange handler — no leaked re-render after dispose", () => {
    const core = makeFakeCore();
    ManagementListPanel.open(asCore(core), panelDescriptor());
    const panel = createdPanels[0];
    expect(core.listenerCount()).toBe(1);
    panel.fireDispose();
    // Falsification: an onDidDispose that skips `this.unsubscribe()` leaves the
    // handler registered — this count stays 1, and a later core.fire() below
    // would drive a render on a disposed panel.
    expect(core.listenerCount()).toBe(0);
    const after = panel.htmlSetCount;
    core.fire();
    expect(panel.htmlSetCount).toBe(after); // no re-render
  });
});
