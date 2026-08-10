import { describe, expect, it, vi } from "vitest";

// managementListPanel imports vscode (for the panel class); the pure resolver +
// html do not touch it, but the module-level import must resolve. A minimal stub
// is enough — no test here constructs the panel class.
vi.mock("vscode", () => ({
  window: { createWebviewPanel: vi.fn() },
  commands: { executeCommand: vi.fn() },
  ViewColumn: { Active: -1 }
}));

const { renderManagementListHtml } = await import("../../src/ui/managementListHtml");
const { resolveManagementMessage } = await import("../../src/ui/managementListPanel");
import type { ManagementListView, ManagementRow } from "../../src/ui/managementListHtml";
import type { ManagementListDescriptor } from "../../src/ui/managementListPanel";

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

  it("posts ONLY closed action keys — never a command name (P0-3)", () => {
    const html = renderManagementListHtml(inventoryView(), NONCE);
    // The script posts the closed protocol.
    expect(html).toContain('type: "new"');
    expect(html).toContain('type: "action"');
    // No command id ever crosses the webview boundary.
    expect(html).not.toContain("nexus.");
    expect(html).not.toContain("commandId");
    expect(html).not.toContain("executeCommand");
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
