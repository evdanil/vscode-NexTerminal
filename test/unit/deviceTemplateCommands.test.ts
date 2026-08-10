import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { ProxyConfig, ServerConfig } from "../../src/models/config";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { FormValues } from "../../src/ui/formTypes";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockWithProgress = vi.fn();
const mockExecuteCommand = vi.fn();
const formPanelOpens: Array<{ formId: string; options: { onSubmit: (v: FormValues) => Promise<void> | void } }> = [];

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  },
  window: {
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    withProgress: (...args: unknown[]) => mockWithProgress(...args)
  },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
  TreeItem: class {
    public id?: string;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public iconPath?: unknown;
    public command?: unknown;
    public constructor(public readonly label: string, public readonly collapsibleState?: number) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(public readonly id: string, public readonly color?: unknown) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  },
  ProgressLocation: { Notification: 15 }
}));

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: {
    open: (formId: string, _definition: unknown, options: { onSubmit: (v: FormValues) => Promise<void> | void }) => {
      formPanelOpens.push({ formId, options });
      return { addSelectOption: vi.fn(), onDidDispose: vi.fn(), dispose: vi.fn() };
    }
  }
}));

// Imported AFTER the mocks so the command module binds to them.
const { registerDeviceTemplateCommands, parseDeviceTemplateFormValues, applyPlanWrites } = await import("../../src/commands/deviceTemplateCommands");
const { FolderTreeItem } = await import("../../src/ui/nexusTreeProvider");
const { proxyPasswordSecretKey } = await import("../../src/services/ssh/silentAuth");
const { planManualTemplateApply } = await import("../../src/services/inventory/templateApply");

const P: ProxyConfig = { type: "socks5", host: "10.0.0.9", port: 1080 };

function makeCore(): NexusCore {
  return new NexusCore(new InMemoryConfigRepository());
}

function ctxFor(core: NexusCore): CommandContext {
  return { core } as unknown as CommandContext;
}

const stubRegistry = { get: () => undefined } as unknown as Parameters<typeof registerDeviceTemplateCommands>[1];

function register(core: NexusCore): void {
  registeredCommands.clear();
  registerDeviceTemplateCommands(ctxFor(core), stubRegistry);
}

/**
 * A minimal in-memory SecretVault that records the delete order (and, per key,
 * the server's proxy at delete time) so Fix A can assert the stale secret is
 * DELETED before the new proxy publishes. `failDeleteFor` makes one key's delete
 * throw (the fail-closed-abort variant).
 */
function makeVault(
  core: NexusCore,
  initial: Record<string, string> = {},
  opts: { failDeleteFor?: string } = {}
) {
  const store = new Map(Object.entries(initial));
  const deleted: string[] = [];
  const proxyAtDelete = new Map<string, unknown>();
  return {
    async get(key: string): Promise<string | undefined> {
      return store.get(key);
    },
    async store(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      if (key.startsWith("proxy-password-")) {
        const serverId = key.slice("proxy-password-".length);
        proxyAtDelete.set(key, core.getServer(serverId)?.proxy);
      }
      if (opts.failDeleteFor === key) {
        throw new Error("vault delete failed");
      }
      deleted.push(key);
      store.delete(key);
    },
    _store: store,
    _deleted: deleted,
    _proxyAtDelete: proxyAtDelete
  };
}

function registerWithVault(core: NexusCore, vault: unknown): void {
  registeredCommands.clear();
  registerDeviceTemplateCommands({ core, secretVault: vault } as unknown as CommandContext, stubRegistry);
}

beforeEach(() => {
  registeredCommands.clear();
  formPanelOpens.length = 0;
  mockShowQuickPick.mockReset();
  mockShowInputBox.mockReset();
  mockShowWarningMessage.mockReset();
  mockShowInformationMessage.mockReset();
  mockWithProgress.mockReset();
  mockExecuteCommand.mockReset();
  mockWithProgress.mockImplementation((_opts: unknown, task: () => Promise<void>) => task());
});

describe("parseDeviceTemplateFormValues (§7.1 tri-state → model)", () => {
  it("reads only fields whose mode is fill/override, dropping 'none'", () => {
    const values: FormValues = {
      name: "Branch defaults",
      mode_proxy: "override",
      proxyType: "socks5",
      proxySocks5Host: "10.0.0.9",
      proxySocks5Port: 1080,
      mode_authProfileId: "fill",
      authProfileId: "prof-1",
      mode_multiplexing: "none", // dropped
      multiplexing: true,
      mode_legacyAlgorithms: "override",
      legacyAlgorithms: true,
      mode_logSession: "none"
    };
    const t = parseDeviceTemplateFormValues(values);
    expect(t.name).toBe("Branch defaults");
    expect(t.fields.proxy).toEqual({ mode: "override", value: { type: "socks5", host: "10.0.0.9", port: 1080 } });
    expect(t.fields.authProfileId).toEqual({ mode: "fill", value: "prof-1" });
    expect(t.fields.multiplexing).toBeUndefined(); // mode none
    expect(t.fields.legacyAlgorithms).toEqual({ mode: "override", value: true });
    expect(t.fields.logSession).toBeUndefined();
  });

  it("rejects an empty name", () => {
    expect(() => parseDeviceTemplateFormValues({ name: "  " })).toThrow(/Name is required/);
  });

  it("PR-T3 — the two IPMI id references round-trip fill / override / unset", () => {
    const t = parseDeviceTemplateFormValues({
      name: "T",
      mode_ipmiAuthProfileId: "fill",
      ipmiAuthProfileId: "pa-1",
      mode_ipmiGatewayServerId: "override",
      ipmiGatewayServerId: "gw-1"
    });
    expect(t.fields.ipmiAuthProfileId).toEqual({ mode: "fill", value: "pa-1" });
    expect(t.fields.ipmiGatewayServerId).toEqual({ mode: "override", value: "gw-1" });

    const unset = parseDeviceTemplateFormValues({
      name: "T",
      mode_ipmiAuthProfileId: "none", // value present but mode none → dropped
      ipmiAuthProfileId: "pa-1",
      mode_ipmiGatewayServerId: "none"
    });
    expect(unset.fields.ipmiAuthProfileId).toBeUndefined();
    expect(unset.fields.ipmiGatewayServerId).toBeUndefined();

    // The __create__ sentinel / (None) reads as "no value" → rejects when a mode is chosen.
    expect(() =>
      parseDeviceTemplateFormValues({ name: "T", mode_ipmiAuthProfileId: "fill", ipmiAuthProfileId: "__create__authProfile" })
    ).toThrow(/IPMI Auth Profile mode is set to Fill but no value is configured/);
  });

  it("P3 — a field whose mode is fill/override but has no usable value is REJECTED, not silently dropped", () => {
    // Auth mode set but left on (None)/create sentinel → reject (the pre-fix code
    // returned a template with the auth field silently dropped).
    expect(() => parseDeviceTemplateFormValues({ name: "T", mode_authProfileId: "fill", authProfileId: "" })).toThrow(
      /Auth Profile mode is set to Fill but no value is configured/
    );
    // Override proxy with proxyType "none" → the value resolves to undefined → reject.
    expect(() =>
      parseDeviceTemplateFormValues({ name: "T", mode_proxy: "override", proxyType: "none" })
    ).toThrow(/Proxy mode is set to Override but no value is configured/);
  });
});

describe("device template CRUD commands", () => {
  it("nexus.deviceTemplate.add opens the editor and its submit persists a new template", async () => {
    const core = makeCore();
    register(core);
    await registeredCommands.get("nexus.deviceTemplate.add")!();
    expect(formPanelOpens).toHaveLength(1);
    expect(formPanelOpens[0].formId).toBe("device-template-add");

    await formPanelOpens[0].options.onSubmit({
      name: "Switch defaults",
      mode_logSession: "fill",
      logSession: false
    });
    const templates = core.getSnapshot().deviceTemplates;
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Switch defaults");
    expect(templates[0].fields.logSession).toEqual({ mode: "fill", value: false });
  });

  it("nexus.deviceTemplate.manage shows the constructive empty-state (never a dead-end) when there are no templates", async () => {
    const core = makeCore();
    register(core);
    mockShowInformationMessage.mockResolvedValue(undefined);
    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("No device templates yet. A device template applies shared settings"),
      "New Device Template"
    );
  });

  it("nexus.deviceTemplate.manage lists templates and opens the editor for the chosen one", async () => {
    const core = makeCore();
    const seed: DeviceTemplateProfile = { id: "t1", name: "Core", fields: { multiplexing: { mode: "override", value: true } } };
    await core.addOrUpdateDeviceTemplate(seed);
    register(core);
    mockShowQuickPick.mockResolvedValue({ label: "Core", action: "edit", template: core.getSnapshot().deviceTemplates[0] });
    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    expect(mockShowQuickPick).toHaveBeenCalled();
    const editOpen = formPanelOpens.find((o) => o.formId.startsWith("device-template-edit-"));
    expect(editOpen).toBeDefined();
  });

  it("U3 — the manage hub can DELETE a template: confirm modal (values kept), then removeDeviceTemplate", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: { multiplexing: { mode: "override", value: true } } });
    // A source that references the template — its rule must be cleared on delete.
    await core.addOrUpdateInventorySource({
      id: "src-1",
      providerId: "netbox",
      name: "NetBox",
      targetFolder: "NetBox",
      prunePolicy: "orphan",
      defaultUsername: "admin",
      config: {},
      secretFieldIds: [],
      templateRules: [{ id: "r", templateId: "t1" }]
    });
    register(core);
    // First pick: the delete entry. Second pick: the template to delete.
    mockShowQuickPick
      .mockResolvedValueOnce({ label: "$(trash) Delete a Device Template…", action: "delete", template: undefined })
      .mockResolvedValueOnce({ label: "Core", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Delete");

    await registeredCommands.get("nexus.deviceTemplate.manage")!();

    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Delete device template "Core"?',
      expect.objectContaining({ modal: true, detail: expect.stringContaining("Values and stamps already applied to servers are kept") }),
      "Delete"
    );
    expect(core.getSnapshot().deviceTemplates).toHaveLength(0);
    // The referencing rule was cleared (§6.2).
    expect(core.getInventorySource("src-1")!.templateRules).toEqual([]);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Device template "Core" deleted.');
  });

  it("U3 — cancelling the delete confirm keeps the template", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: {} });
    register(core);
    mockShowQuickPick
      .mockResolvedValueOnce({ label: "$(trash) Delete a Device Template…", action: "delete", template: undefined })
      .mockResolvedValueOnce({ label: "Core", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue(undefined); // dismissed

    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    expect(core.getSnapshot().deviceTemplates).toHaveLength(1);
  });
});

describe("U1 — save toast + Sync Affected Sources (§6.1 UX-S8)", () => {
  it("shows the verbatim saved toast with a Sync button when a source references the template, and syncing runs syncNow per source", async () => {
    const core = makeCore();
    await core.addOrUpdateInventorySource({
      id: "src-1",
      providerId: "netbox",
      name: "NetBox",
      targetFolder: "NetBox",
      prunePolicy: "orphan",
      defaultUsername: "admin",
      config: {},
      secretFieldIds: [],
      templateRules: [{ id: "r", templateId: "t1" }]
    });
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Switch defaults", fields: { logSession: { mode: "fill", value: true } } });
    register(core);
    // Edit the referenced template.
    mockShowQuickPick.mockResolvedValue({ label: "Switch defaults", action: "edit", template: core.getSnapshot().deviceTemplates[0] });
    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    const editOpen = formPanelOpens.find((o) => o.formId.startsWith("device-template-edit-"))!;

    mockShowInformationMessage.mockResolvedValue("Sync Affected Sources");
    await editOpen.options.onSubmit({ name: "Switch defaults", mode_logSession: "fill", logSession: true });

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Device template "Switch defaults" saved. Changes apply on each source\'s next sync.',
      "Sync Affected Sources"
    );
    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.inventory.syncNow", "src-1");
  });

  it("a template referenced by NOTHING shows the saved toast without the Sync button", async () => {
    const core = makeCore();
    register(core);
    await registeredCommands.get("nexus.deviceTemplate.add")!();
    mockShowInformationMessage.mockResolvedValue(undefined);
    await formPanelOpens[0].options.onSubmit({ name: "Lonely", mode_logSession: "fill", logSession: true });

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Device template "Lonely" saved. Changes apply on each source\'s next sync.'
    );
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("nexus.inventory.syncNow", expect.anything());
  });
});

describe("nexus.deviceTemplate.applyToFolder (§7.4)", () => {
  it("shows the consent modal, applies on confirm, and CLEARS the written field's stamp", async () => {
    const core = makeCore();
    // A synced server whose proxy was template-applied (cur === stamp).
    const server: ServerConfig = {
      id: "srv-1",
      name: "sw",
      host: "h",
      port: 22,
      username: "admin",
      authType: "agent",
      group: "DC",
      proxy: P,
      origin: { sourceId: "src", externalId: "d", templated: { proxy: P } }
    };
    await core.addOrUpdateServer(server);
    const template: DeviceTemplateProfile = { id: "t1", name: "Reproxy", fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.0.0.2", port: 1080 } } } };
    await core.addOrUpdateDeviceTemplate(template);
    register(core);

    mockShowQuickPick.mockResolvedValue({ label: "Reproxy", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Apply");

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    // P7 — the headline names the template + folder in `message`; the per-field
    // plan lines + the verbatim ownership sentence go into `detail` (U2 slot).
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Apply device template "Reproxy" to "DC"?',
      {
        modal: true,
        detail: expect.stringContaining("Values applied here count as your own edits — future inventory syncs will not change them.")
      },
      "Apply"
    );
    // The write landed and the stamp was cleared (§7.4 ownership rule).
    const after = core.getServer("srv-1")!;
    expect(after.proxy).toEqual({ type: "socks5", host: "10.0.0.2", port: 1080 });
    expect(after.origin?.templated?.proxy).toBeUndefined();
  });

  it("B1 — ABORTS without writing when folder membership changes under the lock (re-derived plan diverges)", async () => {
    const core = makeCore();
    const s1: ServerConfig = { id: "srv-1", name: "a", host: "h", port: 22, username: "admin", authType: "agent", group: "DC" };
    await core.addOrUpdateServer(s1);
    const template: DeviceTemplateProfile = {
      id: "t1",
      name: "Mpx",
      fields: { multiplexing: { mode: "override", value: true } }
    };
    await core.addOrUpdateDeviceTemplate(template);
    register(core);

    mockShowQuickPick.mockResolvedValue({ label: "Mpx", template: core.getSnapshot().deviceTemplates[0] });
    // While the modal is "open" (before the caller returns "Apply"), a second
    // server joins the folder — so the set the user consented to (1 server)
    // diverges from what the lock re-derives (2 servers).
    mockShowWarningMessage.mockImplementation(async () => {
      await core.addOrUpdateServer({ id: "srv-2", name: "b", host: "h2", port: 22, username: "admin", authType: "agent", group: "DC" });
      return "Apply";
    });

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    // NOTHING was written — neither the disclosed server nor the newcomer.
    expect(core.getServer("srv-1")!.multiplexing).toBeUndefined();
    expect(core.getServer("srv-2")!.multiplexing).toBeUndefined();
    // The user is told nothing changed and to re-run.
    expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('The servers in "DC" changed while the confirmation was open — nothing was applied.')
    );
    // The success toast never fired.
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("Applied device template"));
  });

  it("B1 — a MATCHING re-derived plan still applies (the guard does not over-refuse)", async () => {
    const core = makeCore();
    const s1: ServerConfig = { id: "srv-1", name: "a", host: "h", port: 22, username: "admin", authType: "agent", group: "DC" };
    await core.addOrUpdateServer(s1);
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Mpx", fields: { multiplexing: { mode: "override", value: true } } });
    register(core);
    mockShowQuickPick.mockResolvedValue({ label: "Mpx", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Apply"); // no concurrent change

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    expect(core.getServer("srv-1")!.multiplexing).toBe(true);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Applied device template "Mpx" to 1 server.');
  });

  it("B1 lesser sibling — template deleted mid-modal names the deletion, does not report '0 servers'", async () => {
    const core = makeCore();
    await core.addOrUpdateServer({ id: "srv-1", name: "a", host: "h", port: 22, username: "admin", authType: "agent", group: "DC" });
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Mpx", fields: { multiplexing: { mode: "override", value: true } } });
    register(core);
    const picked = core.getSnapshot().deviceTemplates[0];
    mockShowQuickPick.mockResolvedValue({ label: "Mpx", template: picked });
    mockShowWarningMessage.mockImplementation(async () => {
      await core.removeDeviceTemplate("t1"); // deleted while the modal is open
      return "Apply";
    });

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    expect(core.getServer("srv-1")!.multiplexing).toBeUndefined();
    expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("The template was deleted while the confirmation was open — nothing was applied.")
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("Applied device template"));
  });

  it("1a — ABORTS on a VALUE-ONLY template edit under the open modal (PR #62 Codex round 1, P1 #1)", async () => {
    // Codex round 1 P1 #1: the existing detail comparator (buildConsentModalDetail)
    // encodes counts/modes, never field VALUES — so a template edited IN PLACE to a
    // new value that keeps its fields/modes identical renders the SAME detail and
    // slips the guard. The revision check is the only thing that catches it.
    const core = makeCore();
    const server: ServerConfig = {
      id: "srv-1",
      name: "sw",
      host: "h",
      port: 22,
      username: "admin",
      authType: "agent",
      group: "DC",
      proxy: P, // { host: 10.0.0.9 } — the pre-existing, undisclosed baseline
      origin: { sourceId: "src", externalId: "d", templated: { proxy: P } }
    };
    await core.addOrUpdateServer(server);
    // Template proxy OVERRIDE value A (host .2) — what the modal is rendered from.
    await core.addOrUpdateDeviceTemplate({
      id: "t1",
      name: "Reproxy",
      fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.0.0.2", port: 1080 } } }
    });
    register(core);
    const picked = core.getSnapshot().deviceTemplates[0];
    mockShowQuickPick.mockResolvedValue({ label: "Reproxy", template: picked });
    // While the modal is open, edit the template IN PLACE to a value-only change:
    // proxy override B (host .99). Same field, same mode → buildConsentModalDetail
    // is byte-identical, so the server-set and detail guards both pass; only the
    // fresh revision differs.
    mockShowWarningMessage.mockImplementation(async () => {
      await core.addOrUpdateDeviceTemplate({
        id: "t1",
        name: "Reproxy",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.0.0.99", port: 1080 } } }
      });
      return "Apply";
    });

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    // NOTHING written — the server keeps its baseline proxy P. Against b247d32 the
    // identical detail passes the guard and B (host .99) is applied as a permanent
    // hand edit the user never saw.
    expect(core.getServer("srv-1")!.proxy).toEqual(P);
    expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('The device template "Reproxy" was edited while the confirmation was open — nothing was applied.')
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("Applied device template"));
  });

  it("P6 — the zero-template apply state is a MODAL offering New Device Template", async () => {
    const core = makeCore();
    register(core);
    mockShowInformationMessage.mockResolvedValue(undefined);
    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("No device templates yet."),
      { modal: true },
      "New Device Template"
    );
  });

  it("does nothing when the folder has no matching servers", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { logSession: { mode: "fill", value: true } } });
    register(core);
    mockShowQuickPick.mockResolvedValue({ label: "T", template: core.getSnapshot().deviceTemplates[0] });
    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("EMPTY", "EMPTY"));
    expect(mockShowInformationMessage).toHaveBeenCalledWith("No servers in this folder.");
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });
});

describe("2b — template save rejects a vanished auth-profile reference (PR #62 Codex round 1, P2 #4)", () => {
  it("REJECTS (form kept open) when fields.authProfileId names a profile deleted while the editor was open — nothing persisted", async () => {
    const core = makeCore();
    await core.addOrUpdateAuthProfile({ id: "prof-1", name: "Prod", username: "svc", authType: "agent" });
    register(core);
    await registeredCommands.get("nexus.deviceTemplate.add")!();
    // The profile is deleted while the editor sits open.
    await core.removeAuthProfile("prof-1");
    // onSubmit rejects (WebviewFormPanel surfaces the message and keeps the form
    // open, exactly like readTemplateField's "no value" reject) and NOTHING is
    // persisted. Against b247d32 the save writes a template whose
    // fields.authProfileId dangles — later dropped with a warning at apply time,
    // silent to the author here.
    await expect(
      formPanelOpens[0].options.onSubmit({ name: "Linked", mode_authProfileId: "fill", authProfileId: "prof-1" })
    ).rejects.toThrow(/auth profile no longer exists/i);
    expect(core.getSnapshot().deviceTemplates).toHaveLength(0);
  });

  it("sibling — a LIVE auth-profile id persists normally (guard not over-firing)", async () => {
    const core = makeCore();
    await core.addOrUpdateAuthProfile({ id: "prof-1", name: "Prod", username: "svc", authType: "agent" });
    register(core);
    await registeredCommands.get("nexus.deviceTemplate.add")!();
    mockShowInformationMessage.mockResolvedValue(undefined);
    await formPanelOpens[0].options.onSubmit({ name: "Linked", mode_authProfileId: "fill", authProfileId: "prof-1" });
    const templates = core.getSnapshot().deviceTemplates;
    expect(templates).toHaveLength(1);
    expect(templates[0].fields.authProfileId).toEqual({ mode: "fill", value: "prof-1" });
  });

  it("(PR-T3) REJECTS (form kept open) when fields.ipmiAuthProfileId names a profile deleted while the editor was open — nothing persisted", async () => {
    const core = makeCore();
    await core.addOrUpdateAuthProfile({ id: "prof-1", name: "BMC", username: "adm", authType: "agent" });
    register(core);
    await registeredCommands.get("nexus.deviceTemplate.add")!();
    // The IPMI auth profile is deleted while the editor sits open — the second
    // cross-record reference the save must revalidate against live core.
    await core.removeAuthProfile("prof-1");
    await expect(
      formPanelOpens[0].options.onSubmit({ name: "Linked", mode_ipmiAuthProfileId: "fill", ipmiAuthProfileId: "prof-1" })
    ).rejects.toThrow(/IPMI auth profile no longer exists/i);
    expect(core.getSnapshot().deviceTemplates).toHaveLength(0);
  });

  it("(PR-T3) sibling — a LIVE ipmiAuthProfileId persists normally (guard not over-firing)", async () => {
    const core = makeCore();
    await core.addOrUpdateAuthProfile({ id: "prof-1", name: "BMC", username: "adm", authType: "agent" });
    register(core);
    await registeredCommands.get("nexus.deviceTemplate.add")!();
    mockShowInformationMessage.mockResolvedValue(undefined);
    await formPanelOpens[0].options.onSubmit({ name: "Linked", mode_ipmiAuthProfileId: "fill", ipmiAuthProfileId: "prof-1" });
    const templates = core.getSnapshot().deviceTemplates;
    expect(templates).toHaveLength(1);
    expect(templates[0].fields.ipmiAuthProfileId).toEqual({ mode: "fill", value: "prof-1" });
  });
});

describe("Fix A (PR #62 Codex round 2, SECURITY) — manual apply clears the stale proxy-password before publishing the new proxy", () => {
  // An authenticated SOCKS5 endpoint X the server's proxy-password was entered for.
  const X: ProxyConfig = { type: "socks5", host: "10.9.9.1", port: 1080, username: "u" };
  // A DIFFERENT authenticated endpoint Y the override moves the proxy to.
  const Y: ProxyConfig = { type: "socks5", host: "10.9.9.2", port: 1080, username: "u" };

  async function seedProxyServer(core: NexusCore): Promise<void> {
    await core.addOrUpdateServer({
      id: "srv-1",
      name: "sw",
      host: "h",
      port: 22,
      username: "admin",
      authType: "agent",
      group: "DC",
      proxy: X,
      origin: { sourceId: "src", externalId: "d", templated: { proxy: X } }
    });
  }

  it("DELETES proxy-password-{id} BEFORE the write publishes when an override moves the proxy to a different endpoint", async () => {
    const core = makeCore();
    await seedProxyServer(core);
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Reproxy", fields: { proxy: { mode: "override", value: Y } } });
    const key = proxyPasswordSecretKey("srv-1");
    const vault = makeVault(core, { [key]: "topsecret" });
    registerWithVault(core, vault);

    mockShowQuickPick.mockResolvedValue({ label: "Reproxy", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Apply");
    mockShowInformationMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    // The stale secret was deleted (against 5cdc83e it survives → the old proxy's
    // password would be sent to the new endpoint Y).
    expect(vault._deleted).toContain(key);
    expect(vault._store.has(key)).toBe(false);
    // Delete-BEFORE-publish: at the moment of deletion the server still carried the
    // OLD proxy X — proving the clear ran before applyPlanWrites published Y.
    expect(vault._proxyAtDelete.get(key)).toEqual(X);
    // And the new proxy did publish.
    expect(core.getServer("srv-1")!.proxy).toEqual(Y);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Applied device template "Reproxy" to 1 server.');
  });

  it("fail-closed — a delete failure ABORTS the apply: nothing published, secret intact, house 'run again' message", async () => {
    const core = makeCore();
    await seedProxyServer(core);
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Reproxy", fields: { proxy: { mode: "override", value: Y } } });
    const key = proxyPasswordSecretKey("srv-1");
    const vault = makeVault(core, { [key]: "topsecret" }, { failDeleteFor: key });
    registerWithVault(core, vault);

    mockShowQuickPick.mockResolvedValue({ label: "Reproxy", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Apply");

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    // The proxy change was NEVER published — the server keeps X (against 5cdc83e it
    // becomes Y regardless, leaking the old password to the new endpoint).
    expect(core.getServer("srv-1")!.proxy).toEqual(X);
    // The secret is still present (the helper restored what it captured on abort).
    expect(vault._store.get(key)).toBe("topsecret");
    expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Could not securely update the proxy settings")
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("Applied device template"));
  });

  it("does NOT over-clear — an override to the SAME authenticated endpoint keeps the secret", async () => {
    const core = makeCore();
    await seedProxyServer(core);
    // Override to the SAME endpoint X (same type/host/port/username) — the stored
    // password still applies, so it must be kept.
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "SameProxy", fields: { proxy: { mode: "override", value: X } } });
    const key = proxyPasswordSecretKey("srv-1");
    const vault = makeVault(core, { [key]: "topsecret" });
    registerWithVault(core, vault);

    mockShowQuickPick.mockResolvedValue({ label: "SameProxy", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Apply");
    mockShowInformationMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    expect(vault._deleted).not.toContain(key);
    expect(vault._store.get(key)).toBe("topsecret");
  });
});

describe("Fix A′ (PR #62 Codex round 3, SECURITY) — restore-on-apply-failure is per-server CONDITIONAL, not blanket", () => {
  // Authenticated SOCKS5 endpoint X each server's proxy-password was entered for.
  const X: ProxyConfig = { type: "socks5", host: "10.9.9.1", port: 1080, username: "u" };
  // A DIFFERENT authenticated endpoint Y the override moves the proxy to.
  const Y: ProxyConfig = { type: "socks5", host: "10.9.9.2", port: 1080, username: "u" };

  async function seedTwoProxyServers(core: NexusCore): Promise<void> {
    for (const id of ["srv-1", "srv-2"]) {
      await core.addOrUpdateServer({
        id,
        name: id,
        host: `h-${id}`,
        port: 22,
        username: "admin",
        authType: "agent",
        group: "DC",
        proxy: X,
        origin: { sourceId: "src", externalId: id, templated: { proxy: X } }
      });
    }
  }

  /**
   * Runs the manual apply against a two-server folder where `applyPlanWrites`'
   * per-server loop fails on its Nth `addOrUpdateServer` call. Returns the ids in
   * the order the loop processed them: `committed` are the ones written before the
   * failure (now on the NEW proxy Y), `failed` is the one whose write threw (still
   * on the OLD proxy X). Installs the failing spy AFTER seeding so it counts only
   * the apply loop's calls.
   */
  async function applyWithFailureOnCall(
    core: NexusCore,
    vault: unknown,
    failOnCall: number
  ): Promise<{ committed: string[]; failed?: string }> {
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Reproxy", fields: { proxy: { mode: "override", value: Y } } });
    registerWithVault(core, vault);
    mockShowQuickPick.mockResolvedValue({ label: "Reproxy", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Apply");
    mockShowInformationMessage.mockResolvedValue(undefined);

    const original = core.addOrUpdateServer.bind(core);
    const committed: string[] = [];
    let failed: string | undefined;
    let calls = 0;
    vi.spyOn(core, "addOrUpdateServer").mockImplementation(async (server: ServerConfig) => {
      calls++;
      if (calls === failOnCall) {
        // The boundary server: its own whole-array save is the one that rejects, so
        // NOTHING of its write commits — it stays on the OLD proxy X.
        failed = server.id;
        throw new Error(`saveServers rejected on call ${failOnCall}`);
      }
      committed.push(server.id);
      return original(server);
    });

    await expect(
      registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"))
    ).rejects.toThrow(/saveServers rejected/);

    vi.restoreAllMocks();
    return { committed, failed };
  }

  it("partial-commit leak — server committed on the NEW proxy must NOT be re-armed with the OLD endpoint's secret", async () => {
    const core = makeCore();
    await seedTwoProxyServers(core);
    const k1 = proxyPasswordSecretKey("srv-1");
    const k2 = proxyPasswordSecretKey("srv-2");
    const vault = makeVault(core, { [k1]: "secret-1", [k2]: "secret-2" });

    // Fail on the SECOND apply call: the first server commits to Y, the second stays on X.
    const { committed, failed } = await applyWithFailureOnCall(core, vault, 2);
    expect(committed).toHaveLength(1);
    expect(failed).toBeDefined();
    const committedId = committed[0];
    const failedId = failed!;
    const committedKey = proxyPasswordSecretKey(committedId);
    const failedKey = proxyPasswordSecretKey(failedId);

    // The committed server is now on the NEW proxy Y in the live core...
    expect(core.getServer(committedId)!.proxy).toEqual(Y);
    // ...so its stale secret MUST stay deleted — re-arming it would send the OLD
    // proxy's password to the NEW endpoint. Against a7bcc22's blanket restore this
    // key is put back → this assertion FAILS (the leak the fix closes).
    expect((vault as ReturnType<typeof makeVault>)._store.has(committedKey)).toBe(false);

    // The failed server never left the OLD proxy X, so its secret IS legitimately
    // restored — the old proxy still needs it.
    const secretByKey: Record<string, string> = { [k1]: "secret-1", [k2]: "secret-2" };
    expect(core.getServer(failedId)!.proxy).toEqual(X);
    expect((vault as ReturnType<typeof makeVault>)._store.get(failedKey)).toBe(secretByKey[failedKey]);
  });

  it("full success — both servers land on the NEW proxy, NEITHER secret is restored", async () => {
    const core = makeCore();
    await seedTwoProxyServers(core);
    const k1 = proxyPasswordSecretKey("srv-1");
    const k2 = proxyPasswordSecretKey("srv-2");
    const vault = makeVault(core, { [k1]: "secret-1", [k2]: "secret-2" });

    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Reproxy", fields: { proxy: { mode: "override", value: Y } } });
    registerWithVault(core, vault);
    mockShowQuickPick.mockResolvedValue({ label: "Reproxy", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Apply");
    mockShowInformationMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.deviceTemplate.applyToFolder")!(new FolderTreeItem("DC", "DC"));

    expect(core.getServer("srv-1")!.proxy).toEqual(Y);
    expect(core.getServer("srv-2")!.proxy).toEqual(Y);
    // Both cleared, no restore — guards against over-restoring a fully-applied plan.
    expect(vault._store.has(k1)).toBe(false);
    expect(vault._store.has(k2)).toBe(false);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Applied device template "Reproxy" to 2 servers.');
  });

  it("full failure — the FIRST server's write throws, nothing commits, BOTH secrets restored", async () => {
    const core = makeCore();
    await seedTwoProxyServers(core);
    const k1 = proxyPasswordSecretKey("srv-1");
    const k2 = proxyPasswordSecretKey("srv-2");
    const vault = makeVault(core, { [k1]: "secret-1", [k2]: "secret-2" });

    // Fail on the FIRST apply call: no server ever commits, both stay on X.
    const { committed } = await applyWithFailureOnCall(core, vault, 1);
    expect(committed).toHaveLength(0);

    expect(core.getServer("srv-1")!.proxy).toEqual(X);
    expect(core.getServer("srv-2")!.proxy).toEqual(X);
    // Both still on the OLD endpoint X → both secrets restored. Guards against the
    // filter dropping a legitimately-needed restore.
    expect(vault._store.get(k1)).toBe("secret-1");
    expect(vault._store.get(k2)).toBe("secret-2");
  });
});

describe("Fix B (PR #62 Codex round 2) — edit save re-resolves the seeded template and refuses a deleted/stale record", () => {
  async function openEdit(core: NexusCore): Promise<{ onSubmit: (v: FormValues) => Promise<void> | void }> {
    register(core);
    mockShowQuickPick.mockResolvedValue({ label: "Core", action: "edit", template: core.getSnapshot().deviceTemplates[0] });
    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    const editOpen = formPanelOpens.find((o) => o.formId.startsWith("device-template-edit-"))!;
    return editOpen.options;
  }

  it("DELETED while the editor was open → Save rejected, template NOT resurrected", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: { logSession: { mode: "fill", value: true } } });
    const edit = await openEdit(core);
    // The template is deleted while the editor sits open.
    await core.removeDeviceTemplate("t1");
    // Against 5cdc83e, onSubmit re-creates the record (addOrUpdateDeviceTemplate
    // upserts by id) — a resurrected template detached from the swept source rules,
    // with no error. The guard rejects and keeps the form open.
    await expect(edit.onSubmit({ name: "Core", mode_logSession: "fill", logSession: true })).rejects.toThrow(
      /deleted while the editor was open/i
    );
    expect(core.getDeviceTemplate("t1")).toBeUndefined();
    expect(core.getSnapshot().deviceTemplates).toHaveLength(0);
  });

  it("CHANGED elsewhere (revision moved) → Save rejected as a stale edit", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: { logSession: { mode: "fill", value: true } } });
    const edit = await openEdit(core);
    // Someone edits the SAME template elsewhere → a fresh revision.
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: { logSession: { mode: "override", value: false } } });
    const revisionBefore = core.getDeviceTemplate("t1")!.revision;
    await expect(edit.onSubmit({ name: "Core", mode_logSession: "fill", logSession: true })).rejects.toThrow(
      /changed elsewhere while the editor was open/i
    );
    // The concurrent edit is NOT clobbered — the record still holds the other edit.
    expect(core.getDeviceTemplate("t1")!.revision).toBe(revisionBefore);
    expect(core.getDeviceTemplate("t1")!.fields.logSession).toEqual({ mode: "override", value: false });
  });

  it("sibling — a normal edit (unchanged revision) saves through", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: { logSession: { mode: "fill", value: true } } });
    const edit = await openEdit(core);
    mockShowInformationMessage.mockResolvedValue(undefined);
    await edit.onSubmit({ name: "Renamed", mode_logSession: "override", logSession: false });
    const live = core.getDeviceTemplate("t1")!;
    expect(live.name).toBe("Renamed");
    expect(live.fields.logSession).toEqual({ mode: "override", value: false });
  });

  it("sibling — Add-mode (no seed) is unaffected: it still saves a brand-new template", async () => {
    const core = makeCore();
    register(core);
    await registeredCommands.get("nexus.deviceTemplate.add")!();
    mockShowInformationMessage.mockResolvedValue(undefined);
    await formPanelOpens[0].options.onSubmit({ name: "Fresh", mode_logSession: "fill", logSession: true });
    expect(core.getSnapshot().deviceTemplates).toHaveLength(1);
    expect(core.getSnapshot().deviceTemplates[0].name).toBe("Fresh");
  });
});

describe("Fix C (PR #62 Codex round 5) — template save/delete serialize under configMutationLock", () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function referencingSource(id: string, templateId: string, ruleId: string): Parameters<NexusCore["addOrUpdateInventorySource"]>[0] {
    return {
      id,
      providerId: "netbox",
      name: id,
      targetFolder: "NetBox",
      prunePolicy: "orphan",
      defaultUsername: "admin",
      config: {},
      secretFieldIds: [],
      templateRules: [{ id: ruleId, templateId }]
    };
  }

  it("a concurrent editor Save + delete of the SAME template aborts the delete (round-6 revision guard) and never tears disk state", async () => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: { logSession: { mode: "fill", value: true } } });
    await core.addOrUpdateInventorySource(referencingSource("src-1", "t1", "r1"));
    register(core);

    // Open the EDIT editor for T (consumes one quickPick) and capture its onSubmit.
    mockShowQuickPick.mockResolvedValueOnce({ label: "Core", action: "edit", template: core.getSnapshot().deviceTemplates[0] });
    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    const editOnSubmit = formPanelOpens.find((o) => o.formId.startsWith("device-template-edit-"))!.options.onSubmit;

    // Delete flow mocks: manage → delete entry → pick T → confirm "Delete".
    mockShowQuickPick
      .mockResolvedValueOnce({ label: "$(trash) Delete a Device Template…", action: "delete", template: undefined })
      .mockResolvedValueOnce({ label: "Core", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Delete");
    mockShowInformationMessage.mockResolvedValue(undefined);

    // Gate ONLY the first saveDeviceTemplates after install — the Save's whole-array
    // persist. Held open, a lock-free delete can sweep T between install and release;
    // when the Save's captured [incl T] snapshot then lands LAST it would resurrect T.
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    const realSave = repo.saveDeviceTemplates.bind(repo);
    let saveCalls = 0;
    vi.spyOn(repo, "saveDeviceTemplates").mockImplementation(async (templates) => {
      saveCalls++;
      if (saveCalls === 1) {
        await gate;
      }
      return realSave(templates);
    });

    // Kick off the Save; let it install T in memory and park at the gated persist.
    const saveP = editOnSubmit({ name: "Core", mode_logSession: "fill", logSession: true });
    await tick();
    // Kick off the delete. Lock-free (fb07263): removeDeviceTemplate runs now,
    // sweeping T and its rule and persisting [without T] immediately. Locked (fix):
    // it queues behind the Save's held lock and does nothing until the Save completes.
    const deleteP = registeredCommands.get("nexus.deviceTemplate.manage")!();
    await tick();
    // Release the Save's persist LAST.
    releaseGate();
    await Promise.all([saveP, deleteP]);
    vi.restoreAllMocks();

    // DISK is the authority — reload a fresh core.
    const reloaded = new NexusCore(repo);
    await reloaded.initialize();
    // Round-6 revision guard (PR #62 round 6) — the delete picked T at its pre-Save
    // revision; the concurrent Save re-minted the revision under the serialized lock.
    // The delete's in-lock revalidation now sees the moved revision and ABORTS rather
    // than removing an incarnation the confirmation never showed. T therefore survives
    // (as the Save's incarnation) and its referencing rule stays intact.
    // Against fb07263 (lock-free, no revision guard) the delete swept T and its rule,
    // then the Save's late [incl T] persist resurrected T while the rule stayed swept —
    // a torn state (rule []). The rule assertion below is what discriminates the two.
    expect(reloaded.getDeviceTemplate("t1")).toBeDefined();
    expect(reloaded.getInventorySource("src-1")!.templateRules).toEqual([{ id: "r1", templateId: "t1" }]);
  });

  it("delete ABORTS when the referencing-source set changed under the open confirm modal (removeDeviceTemplate not called)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: {} });
    await core.addOrUpdateInventorySource(referencingSource("src-1", "t1", "r1"));
    register(core);
    const removeSpy = vi.spyOn(core, "removeDeviceTemplate");
    mockShowQuickPick
      .mockResolvedValueOnce({ label: "$(trash) Delete a Device Template…", action: "delete", template: undefined })
      .mockResolvedValueOnce({ label: "Core", template: core.getSnapshot().deviceTemplates[0] });
    // While the confirm modal is open, a SECOND source starts referencing T — the
    // referencing set the disclosure was built from ([src-1]) diverges.
    mockShowWarningMessage.mockImplementationOnce(async () => {
      await core.addOrUpdateInventorySource(referencingSource("src-2", "t1", "r2"));
      return "Delete";
    });

    await registeredCommands.get("nexus.deviceTemplate.manage")!();

    // Against fb07263 (no revalidation) removeDeviceTemplate runs and sweeps BOTH
    // sources against a stale disclosure. The guard aborts instead.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(core.getDeviceTemplate("t1")).toBeDefined();
    expect(core.getInventorySource("src-1")!.templateRules).toEqual([{ id: "r1", templateId: "t1" }]);
    expect(core.getInventorySource("src-2")!.templateRules).toEqual([{ id: "r2", templateId: "t1" }]);
    expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("changed while the confirmation was open — nothing was deleted")
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("deleted."));
    removeSpy.mockRestore();
  });

  it("delete ABORTS when the picked template is edited (revision moves) under the open confirm modal (removeDeviceTemplate not called)", async () => {
    // Fix (PR #62 Codex round 6) — the delete-side twin of the round-2 edit-save
    // revision guard. An editor Save (a rename here) that completes while the confirm
    // modal sits open leaves a newly-edited incarnation of the SAME id; the existence
    // check waves it through and the delete would sweep an edit the confirmation never
    // showed. Referencing set is unchanged, so ONLY the revision guard catches this.
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: {} });
    await core.addOrUpdateInventorySource(referencingSource("src-1", "t1", "r1"));
    register(core);
    const removeSpy = vi.spyOn(core, "removeDeviceTemplate");
    const picked = core.getSnapshot().deviceTemplates[0];
    mockShowQuickPick
      .mockResolvedValueOnce({ label: "$(trash) Delete a Device Template…", action: "delete", template: undefined })
      .mockResolvedValueOnce({ label: "Core", template: picked });
    // While the confirm modal is open, the SAME template is renamed elsewhere — a
    // fresh revision, but the referencing set ([src-1]) is untouched.
    mockShowWarningMessage.mockImplementationOnce(async () => {
      await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Renamed", fields: {} });
      return "Delete";
    });

    await registeredCommands.get("nexus.deviceTemplate.manage")!();

    // Against 1190e5d (existence-only revalidation) removeDeviceTemplate runs and
    // deletes the renamed incarnation. The revision guard aborts instead.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(core.getDeviceTemplate("t1")).toBeDefined();
    expect(core.getDeviceTemplate("t1")!.name).toBe("Renamed");
    expect(core.getInventorySource("src-1")!.templateRules).toEqual([{ id: "r1", templateId: "t1" }]);
    expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("changed while the confirmation was open — nothing was deleted")
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("deleted."));
    removeSpy.mockRestore();
  });

  it("sibling — an UNCHANGED referencing set deletes normally (guard does not over-refuse)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: {} });
    await core.addOrUpdateInventorySource(referencingSource("src-1", "t1", "r1"));
    register(core);
    mockShowQuickPick
      .mockResolvedValueOnce({ label: "$(trash) Delete a Device Template…", action: "delete", template: undefined })
      .mockResolvedValueOnce({ label: "Core", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockResolvedValue("Delete"); // no concurrent change
    mockShowInformationMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.deviceTemplate.manage")!();

    expect(core.getDeviceTemplate("t1")).toBeUndefined();
    expect(core.getInventorySource("src-1")!.templateRules).toEqual([]);
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Device template "Core" deleted.');
  });

  it("lesser sibling — the template removed mid-modal aborts with the change message, not a misleading 'deleted' toast", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: {} });
    register(core);
    mockShowQuickPick
      .mockResolvedValueOnce({ label: "$(trash) Delete a Device Template…", action: "delete", template: undefined })
      .mockResolvedValueOnce({ label: "Core", template: core.getSnapshot().deviceTemplates[0] });
    mockShowWarningMessage.mockImplementationOnce(async () => {
      await core.removeDeviceTemplate("t1"); // vanished while the modal was open
      return "Delete";
    });

    await registeredCommands.get("nexus.deviceTemplate.manage")!();

    expect(mockShowWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("changed while the confirmation was open — nothing was deleted")
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("deleted."));
  });

  it("editor Save whose in-lock revision check fails still throws out through runExclusive (form stays open)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Core", fields: { logSession: { mode: "fill", value: true } } });
    register(core);
    mockShowQuickPick.mockResolvedValueOnce({ label: "Core", action: "edit", template: core.getSnapshot().deviceTemplates[0] });
    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    const editOnSubmit = formPanelOpens.find((o) => o.formId.startsWith("device-template-edit-"))!.options.onSubmit;
    // Deleted while the editor sat open — the in-lock revalidation must reject and the
    // rejection must propagate out of runExclusive (a swallowed error would resolve).
    await core.removeDeviceTemplate("t1");
    await expect(editOnSubmit({ name: "Core", mode_logSession: "fill", logSession: true })).rejects.toThrow(
      /deleted while the editor was open/i
    );
    expect(core.getSnapshot().deviceTemplates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §7.2 (PR-T2) — "Edit Template Rules…" QuickPick flow orchestration. The pure
// list/feedback/overlap logic lives in templateRulesView.test.ts; these lock the
// vscode wiring: three-slot rows, the floor row routing to editSource, and
// add/remove persistence.
// ---------------------------------------------------------------------------
describe("Edit Template Rules… flow (§7.2)", () => {
  const PROXY: ProxyConfig = { type: "socks5", host: "10.9.9.1", port: 1080 };
  const regWith = (keys?: string[]) =>
    ({ get: () => (keys ? { attributeKeys: keys } : undefined) }) as unknown as Parameters<typeof registerDeviceTemplateCommands>[1];
  function registerWithRegistry(core: NexusCore, registry: Parameters<typeof registerDeviceTemplateCommands>[1]): void {
    registeredCommands.clear();
    registerDeviceTemplateCommands(ctxFor(core), registry);
  }
  async function seedSource(core: NexusCore, overrides: Record<string, unknown> = {}): Promise<void> {
    await core.addOrUpdateInventorySource({
      id: "src-1",
      providerId: "netbox",
      name: "NetBox",
      targetFolder: "",
      prunePolicy: "orphan",
      defaultUsername: "admin",
      config: {},
      secretFieldIds: [],
      ...overrides
    } as never);
  }
  const editRules = () => registeredCommands.get("nexus.deviceTemplate.editRules")!("src-1");

  it("the implicit floor row routes to editSource (UX-S4)", async () => {
    const core = makeCore();
    await seedSource(core, { authProfileId: "A" });
    registerWithRegistry(core, regWith());
    mockShowQuickPick.mockImplementationOnce(async (items: Array<{ floor?: boolean }>) => items.find((i) => i.floor));

    await editRules();

    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.inventory.editSource", "src-1");
  });

  it("Add rule… picks a template, takes a filter, and persists ONE rule (list → add → template → filter → exit)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core);
    registerWithRegistry(core, regWith(["role", "site", "name"]));
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ add?: boolean }>) => items.find((i) => i.add))
      .mockImplementationOnce(async (items: Array<{ template?: { id: string } }>) => items.find((i) => i.template?.id === "t1"))
      .mockResolvedValueOnce(undefined);
    mockShowInputBox.mockResolvedValueOnce("role=switch");

    await editRules();

    const rules = core.getInventorySource("src-1")!.templateRules!;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ templateId: "t1", filter: "role=switch" });
  });

  it("renders three-slot rows for an existing rule and REMOVES it (list → pick rule → remove → exit)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core, { templateRules: [{ id: "r1", templateId: "t1", filter: "role=switch" }] });
    registerWithRegistry(core, regWith());
    let listItems: Array<{ label: string; description?: string; detail?: string; ruleId?: string }> = [];
    mockShowQuickPick
      .mockImplementationOnce(async (items: typeof listItems) => {
        listItems = items;
        return items.find((i) => i.ruleId === "r1");
      })
      .mockImplementationOnce(async (items: Array<{ act?: string }>) => items.find((i) => i.act === "remove"))
      .mockResolvedValueOnce(undefined);

    await editRules();

    const row = listItems.find((i) => i.ruleId === "r1")!;
    expect(row.label).toBe("role=switch"); // slot 1 — filter
    expect(row.description).toBe("→ T"); // slot 2 — → template
    expect(row.detail).toContain("Specificity 1"); // slot 3 — specificity + sets
    expect(row.detail).toContain("Sets: Proxy");
    expect(core.getInventorySource("src-1")!.templateRules).toBeUndefined(); // removed
  });

  it("U1 — Editing a rule marks its CURRENT template and sorts it first in the template picker (kills the no-op `picked:` that shows no current value, letting a mis-pick silently rewire the rule)", async () => {
    const core = makeCore();
    // Two templates; `bravo` sorts AFTER `alpha` by name but is the rule's current one.
    await core.addOrUpdateDeviceTemplate({ id: "t-alpha", name: "Alpha", fields: { proxy: { mode: "override", value: PROXY } } });
    await core.addOrUpdateDeviceTemplate({ id: "t-bravo", name: "Bravo", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core, { templateRules: [{ id: "r1", templateId: "t-bravo", filter: "role=switch" }] });
    registerWithRegistry(core, regWith());
    let templateItems: Array<{ label: string; description?: string; template?: { id: string } }> = [];
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ ruleId?: string }>) => items.find((i) => i.ruleId === "r1"))
      .mockImplementationOnce(async (items: Array<{ act?: string }>) => items.find((i) => i.act === "edit"))
      .mockImplementationOnce(async (items: typeof templateItems) => {
        templateItems = items;
        return undefined; // inspect the rows, then abort — no rewire
      })
      .mockResolvedValueOnce(undefined); // loop → exit

    await editRules();

    const templateRows = templateItems.filter((i) => i.template !== undefined);
    // The current template (Bravo) is FIRST despite sorting after Alpha by name...
    expect(templateRows[0].template!.id).toBe("t-bravo");
    // ...and is visibly marked as current.
    expect(templateRows[0].label).toContain("Bravo");
    expect(templateRows[0].label).toContain("$(check)");
    expect(templateRows[0].description).toContain("current");
    // The non-current row carries no marker.
    const alphaRow = templateRows.find((i) => i.template!.id === "t-alpha")!;
    expect(alphaRow.label).not.toContain("$(check)");
    // Aborting the pick left the rule untouched.
    expect(core.getInventorySource("src-1")!.templateRules).toEqual([{ id: "r1", templateId: "t-bravo", filter: "role=switch" }]);
  });

  it("U2 — the save-time unknown-key warning carries the actionable 'Known keys: …' clause (kills the truncated toast that omits §2.2's remedy)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core);
    registerWithRegistry(core, regWith(["role", "site", "name"]));
    mockShowWarningMessage.mockResolvedValue(undefined);
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ add?: boolean }>) => items.find((i) => i.add))
      .mockImplementationOnce(async (items: Array<{ template?: { id: string } }>) => items.find((i) => i.template?.id === "t1"))
      .mockResolvedValueOnce(undefined); // loop → exit
    mockShowInputBox.mockResolvedValueOnce("sites=syd"); // 'sites' is unknown (known are role/site/name)

    await editRules();

    const warned = mockShowWarningMessage.mock.calls.map((c) => String(c[0]));
    const keyWarn = warned.find((w) => w.includes("is not one this source's provider reports"));
    expect(keyWarn).toBeDefined();
    expect(keyWarn).toContain("Known keys: role, site, name");
  });

  it("M3 — a concurrent rule added in another window between the picker and the save is PRESERVED, not clobbered (resolve-under-lock delta; kills the wholesale overwrite from the pre-QuickPick snapshot)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core, { templateRules: [{ id: "r1", templateId: "t1", filter: "role=switch" }] });
    registerWithRegistry(core, regWith(["role", "site", "name"]));
    mockShowWarningMessage.mockResolvedValue(undefined);
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ add?: boolean }>) => items.find((i) => i.add))
      .mockImplementationOnce(async (items: Array<{ template?: { id: string } }>) => items.find((i) => i.template?.id === "t1"))
      .mockResolvedValueOnce(undefined); // loop → exit
    // The filter InputBox stands in for the unbounded wait during which ANOTHER
    // window edits the same source, adding r2. The old code snapshotted templateRules
    // BEFORE this and overwrote wholesale, dropping r2.
    mockShowInputBox.mockImplementationOnce(async () => {
      const fresh = core.getInventorySource("src-1")!;
      await core.addOrUpdateInventorySource({ ...fresh, templateRules: [...(fresh.templateRules ?? []), { id: "r2", templateId: "t1", filter: "site=syd" }] });
      return "role=router"; // the new rule this flow is adding
    });

    await editRules();

    const rules = core.getInventorySource("src-1")!.templateRules!;
    expect(rules).toHaveLength(3); // r1, the concurrent r2, and this flow's new rule — none clobbered
    expect(rules.some((r) => r.id === "r1" && r.filter === "role=switch")).toBe(true); // original untouched
    expect(rules.some((r) => r.id === "r2" && r.filter === "site=syd")).toBe(true); // concurrent edit survived
    expect(rules.some((r) => r.filter === "role=router")).toBe(true); // this flow's add landed
  });

  it("M4 (Codex round 1 #1) — editing rule R while another window concurrently changes R's OWN filter DIVERGES: nothing is saved and R keeps the concurrent value, not this editor's stale write", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core, { templateRules: [{ id: "r1", templateId: "t1", filter: "role=switch" }] });
    registerWithRegistry(core, regWith(["role", "site", "name"]));
    mockShowWarningMessage.mockResolvedValue(undefined);
    // list → pick r1, action → edit, template → t1 (unchanged), loop → exit.
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ ruleId?: string }>) => items.find((i) => i.ruleId === "r1"))
      .mockImplementationOnce(async (items: Array<{ act?: string }>) => items.find((i) => i.act === "edit"))
      .mockImplementationOnce(async (items: Array<{ template?: { id: string } }>) => items.find((i) => i.template?.id === "t1"))
      .mockResolvedValueOnce(undefined); // loop → exit
    // During the filter InputBox, another window changes r1's OWN filter to site=nyc.
    // The existence-only check (1bc6dd8) still finds r1 by id and clobbers it with
    // this editor's newRule (role=router). The content check must DIVERGE instead.
    mockShowInputBox.mockImplementationOnce(async () => {
      const fresh = core.getInventorySource("src-1")!;
      await core.addOrUpdateInventorySource({
        ...fresh,
        templateRules: (fresh.templateRules ?? []).map((r) => (r.id === "r1" ? { ...r, filter: "site=nyc" } : r))
      });
      return "role=router"; // this editor's (now stale) intended write
    });

    await editRules();

    const rules = core.getInventorySource("src-1")!.templateRules!;
    expect(rules).toHaveLength(1);
    // The concurrent edit is preserved; this editor's stale write did NOT land.
    expect(rules.find((r) => r.id === "r1")!.filter).toBe("site=nyc");
    expect(rules.some((r) => r.filter === "role=router")).toBe(false);
    // The house "changed in another window" warning fired.
    const warned = mockShowWarningMessage.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes("changed in another window"))).toBe(true);
  });

  it("M4b (Codex round 1 #1 sibling) — editing rule R while another window changes a DIFFERENT rule still COMMUTES: R's edit lands and the other rule keeps its concurrent value", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core, {
      templateRules: [
        { id: "r1", templateId: "t1", filter: "role=switch" },
        { id: "r2", templateId: "t1", filter: "site=syd" }
      ]
    });
    registerWithRegistry(core, regWith(["role", "site", "name"]));
    mockShowWarningMessage.mockResolvedValue(undefined);
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ ruleId?: string }>) => items.find((i) => i.ruleId === "r1"))
      .mockImplementationOnce(async (items: Array<{ act?: string }>) => items.find((i) => i.act === "edit"))
      .mockImplementationOnce(async (items: Array<{ template?: { id: string } }>) => items.find((i) => i.template?.id === "t1"))
      .mockResolvedValueOnce(undefined); // loop → exit
    // Concurrent change to the OTHER rule (r2) — must NOT block r1's edit.
    mockShowInputBox.mockImplementationOnce(async () => {
      const fresh = core.getInventorySource("src-1")!;
      await core.addOrUpdateInventorySource({
        ...fresh,
        templateRules: (fresh.templateRules ?? []).map((r) => (r.id === "r2" ? { ...r, filter: "site=nyc" } : r))
      });
      return "role=router";
    });

    await editRules();

    const rules = core.getInventorySource("src-1")!.templateRules!;
    expect(rules.find((r) => r.id === "r1")!.filter).toBe("role=router"); // this edit landed
    expect(rules.find((r) => r.id === "r2")!.filter).toBe("site=nyc"); // concurrent edit preserved
    const warned = mockShowWarningMessage.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes("changed in another window"))).toBe(false);
  });

  it("M5 (Codex round 2 #2) — a template DELETED between the picker and the save is re-resolved UNDER THE LOCK: the dangling rule is NOT persisted and the flow diverges (kills the persist that leaves a rule pointing at a missing template, silently skipped on every future sync)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core);
    registerWithRegistry(core, regWith(["role", "site", "name"]));
    mockShowWarningMessage.mockResolvedValue(undefined);
    // list → add, template → t1, loop → exit.
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ add?: boolean }>) => items.find((i) => i.add))
      .mockImplementationOnce(async (items: Array<{ template?: { id: string } }>) => items.find((i) => i.template?.id === "t1"))
      .mockResolvedValueOnce(undefined); // loop → exit
    // During the filter InputBox, t1's deletion sweep runs. Existence-only save
    // (553875d) persisted a rule pointing at the now-missing t1; the resolve-under-lock
    // check must refuse and diverge instead.
    mockShowInputBox.mockImplementationOnce(async () => {
      await core.removeDeviceTemplate("t1");
      return "role=switch";
    });

    await editRules();

    // No dangling rule persisted.
    expect(core.getInventorySource("src-1")!.templateRules).toBeUndefined();
    // The house "changed in another window" divergence warning fired.
    const warned = mockShowWarningMessage.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes("changed in another window"))).toBe(true);
  });

  it("M5b (Codex round 2 #2 sibling) — a template still present at save time persists the rule normally (the resolve-under-lock check does not over-refuse)", async () => {
    const core = makeCore();
    await core.addOrUpdateDeviceTemplate({ id: "t1", name: "T", fields: { proxy: { mode: "override", value: PROXY } } });
    await seedSource(core);
    registerWithRegistry(core, regWith(["role", "site", "name"]));
    mockShowWarningMessage.mockResolvedValue(undefined);
    mockShowQuickPick
      .mockImplementationOnce(async (items: Array<{ add?: boolean }>) => items.find((i) => i.add))
      .mockImplementationOnce(async (items: Array<{ template?: { id: string } }>) => items.find((i) => i.template?.id === "t1"))
      .mockResolvedValueOnce(undefined); // loop → exit
    mockShowInputBox.mockResolvedValueOnce("role=switch");

    await editRules();

    const rules = core.getInventorySource("src-1")!.templateRules!;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ templateId: "t1", filter: "role=switch" });
  });
});

describe("applyPlanWrites — reference revalidation (PR-T3, PR #66 Codex round 6)", () => {
  function targetServer(): ServerConfig {
    return {
      id: "R",
      name: "Target R",
      host: "r",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      group: "DC",
      origin: { sourceId: "src", externalId: "R", syncedAt: 1 }
    };
  }

  it("SKIPS an IPMI gateway pruned since plan time (kills persisting a dangling gateway from a concurrent folder delete)", async () => {
    const core = makeCore();
    await core.addOrUpdateServer({ id: "GW", name: "Gateway", host: "g", port: 22, username: "u", authType: "agent", isHidden: false, group: "Other" });
    await core.addOrUpdateServer(targetServer());

    // Plan (computed while GW is live) sets R's IPMI gateway to GW.
    const plan = planManualTemplateApply({
      template: { id: "t", name: "T", fields: { ipmiGatewayServerId: { mode: "override", value: "GW" } } },
      servers: [core.getServer("R")!],
      sourceDefaultUsername: () => undefined,
      authProfile: () => undefined,
      hasServer: (id: string) => id === "GW" || id === "R"
    });
    expect(plan.serverWrites.find((w) => w.serverId === "R")?.ipmiGatewayServerId).toBe("GW");

    // CONCURRENT DELETION between plan and apply: GW is pruned (e.g. its folder removed).
    await core.removeServer("GW");

    const applied = await applyPlanWrites(ctxFor(core), plan);
    // R's ONLY field was the gateway; it was revalidated away, so R is not counted
    // as applied (round 11 — the count/toast must not claim an untouched server).
    expect(applied).toBe(0);
    // The now-dangling gateway must NOT be persisted. Against the pre-fix writer
    // (unconditional `next.ipmiGatewayServerId = write.ipmiGatewayServerId`) R would
    // carry the dangling "GW" and this assertion fails.
    expect(core.getServer("R")?.ipmiGatewayServerId).toBeUndefined();
    // Skipped ⇒ not recorded as hand-owned: no gateway stamp was minted.
    expect(core.getServer("R")?.origin?.templated?.ipmiGatewayServerId).toBeUndefined();
  });

  it("WRITES a gateway that still resolves at apply time (regression — the guard did not over-skip)", async () => {
    const core = makeCore();
    await core.addOrUpdateServer({ id: "GW", name: "Gateway", host: "g", port: 22, username: "u", authType: "agent", isHidden: false, group: "Other" });
    await core.addOrUpdateServer(targetServer());

    const plan = planManualTemplateApply({
      template: { id: "t", name: "T", fields: { ipmiGatewayServerId: { mode: "override", value: "GW" } } },
      servers: [core.getServer("R")!],
      sourceDefaultUsername: () => undefined,
      authProfile: () => undefined,
      hasServer: (id: string) => id === "GW" || id === "R"
    });

    // GW remains live — the reference resolves at apply time.
    const applied = await applyPlanWrites(ctxFor(core), plan);
    expect(applied).toBe(1);
    expect(core.getServer("R")?.ipmiGatewayServerId).toBe("GW");
  });
});

// ============================================================================
// FALSIFICATION-CRITICAL: PR-T3 review round 9 (Codex) — FIX B. The §7.4 manual-apply
// stamp clear must also strip the written members from the DETACHED `formerlySynced`
// receipt, not only from `live.origin`. A server KEPT from a removed source carries its
// ownership receipt in `formerlySynced` (no `origin`); when a manual Override claims the
// existing value as a hand edit, the detached stamp must be cleared too — otherwise a later
// ADOPTION restores it into a live `origin` as template-owned, silently breaking the consent
// modal's "this becomes hand-owned" promise. Built to FAIL against 229730e, which clears
// only `live.origin` and leaves the detached stamp intact.
// ============================================================================
describe("applyPlanWrites — detached receipt stamp clear (PR-T3, PR #66 Codex round 9)", () => {
  /** A server KEPT from a removed source: no `origin`, a `formerlySynced` receipt whose `templated` stamps the two IPMI ids the sync last wrote. */
  function keptServer(templated: { ipmiGatewayServerId?: string; ipmiAuthProfileId?: string }, live: Partial<ServerConfig> = {}): ServerConfig {
    return {
      id: "K",
      name: "Kept",
      host: "k",
      port: 22,
      username: "u",
      authType: "agent",
      isHidden: false,
      group: "DC",
      formerlySynced: {
        sourceId: "removed-source",
        sourceName: "NetBox (removed)",
        providerId: "netbox",
        instanceKey: "https://netbox.example.com",
        externalId: "K",
        templated,
        detachedAt: 1
      },
      ...live
    };
  }

  it("CLEARS the detached gateway stamp when an Override claims the SAME gateway as a hand edit (kills clearing only live.origin — the detached stamp survives and a later adoption resurrects it as template-owned)", async () => {
    const core = makeCore();
    await core.addOrUpdateServer({ id: "X", name: "Gateway X", host: "x", port: 22, username: "u", authType: "agent", isHidden: false, group: "Other" });
    // Kept server currently points at gateway X, and its DETACHED receipt stamps X as the
    // removed source's template-owned value. No `origin` — the stamp lives only on the receipt.
    await core.addOrUpdateServer(keptServer({ ipmiGatewayServerId: "X" }, { ipmiGatewayServerId: "X" }));

    // An Override rule writes the SAME value X, deliberately claiming it as a hand edit —
    // an override always writes (even a no-op value), so `ipmiGatewayServerId` is written.
    const plan = planManualTemplateApply({
      template: { id: "t", name: "T", fields: { ipmiGatewayServerId: { mode: "override", value: "X" } } },
      servers: [core.getServer("K")!],
      sourceDefaultUsername: () => undefined,
      authProfile: () => undefined,
      hasServer: (id: string) => id === "X" || id === "K"
    });
    expect(plan.serverWrites.find((w) => w.serverId === "K")?.writtenFields).toContain("ipmiGatewayServerId");

    const applied = await applyPlanWrites(ctxFor(core), plan);
    expect(applied).toBe(1);
    const next = core.getServer("K")!;
    // The value the Override wrote is present…
    expect(next.ipmiGatewayServerId).toBe("X");
    // …and the DETACHED stamp is CLEARED — the whole point of FIX B. Against 229730e only
    // `live.origin` is cleared, so the detached stamp survives and this assertion fails.
    // The bag held only the gateway stamp, so it collapses to `undefined`.
    expect(next.formerlySynced?.templated?.ipmiGatewayServerId).toBeUndefined();
    // The receipt's REQUIRED fields are never touched — a DetachedServerOrigin never
    // collapses to `undefined`.
    expect(next.formerlySynced?.sourceId).toBe("removed-source");
    expect(next.formerlySynced?.externalId).toBe("K");
  });

  it("clears ONLY the written member — a co-stamped ipmiAuthProfileId survives when only the gateway is written (proves the clear keys off writtenFields, not a blanket wipe)", async () => {
    const core = makeCore();
    await core.addOrUpdateServer({ id: "X", name: "Gateway X", host: "x", port: 22, username: "u", authType: "agent", isHidden: false, group: "Other" });
    // Receipt stamps BOTH IPMI ids; the Override writes only the gateway.
    await core.addOrUpdateServer(keptServer({ ipmiGatewayServerId: "X", ipmiAuthProfileId: "PA" }, { ipmiGatewayServerId: "X", ipmiAuthProfileId: "PA" }));

    const plan = planManualTemplateApply({
      template: { id: "t", name: "T", fields: { ipmiGatewayServerId: { mode: "override", value: "X" } } },
      servers: [core.getServer("K")!],
      sourceDefaultUsername: () => undefined,
      authProfile: () => undefined,
      hasServer: (id: string) => id === "X" || id === "K"
    });

    const applied = await applyPlanWrites(ctxFor(core), plan);
    expect(applied).toBe(1);
    const next = core.getServer("K")!;
    expect(next.formerlySynced?.templated?.ipmiGatewayServerId).toBeUndefined(); // cleared
    expect(next.formerlySynced?.templated?.ipmiAuthProfileId).toBe("PA"); // untouched — not written
  });
});

describe("applyPlanWrites — skip a target whose only field was revalidated away (PR-T3, PR #66 Codex round 11)", () => {
  it("does NOT count/save a server whose sole written field (a gateway) is deleted before apply", async () => {
    const core = makeCore();
    await core.addOrUpdateServer({ id: "GW", name: "Gateway", host: "g", port: 22, username: "u", authType: "agent", isHidden: false, group: "Other" });
    await core.addOrUpdateServer({ id: "R", name: "Target R", host: "r", port: 22, username: "u", authType: "agent", isHidden: false, group: "DC", origin: { sourceId: "src", externalId: "R", syncedAt: 1 } });

    // Plan whose ONLY write for R is the IPMI gateway (GW live at plan time).
    const plan = planManualTemplateApply({
      template: { id: "t", name: "T", fields: { ipmiGatewayServerId: { mode: "override", value: "GW" } } },
      servers: [core.getServer("R")!],
      sourceDefaultUsername: () => undefined,
      authProfile: () => undefined,
      hasServer: (id: string) => id === "GW" || id === "R"
    });
    expect(plan.serverWrites.find((w) => w.serverId === "R")?.writtenFields).toEqual(["ipmiGatewayServerId"]);

    // GW pruned before apply → R's only field is skipped → R must NOT be counted.
    await core.removeServer("GW");
    const applied = await applyPlanWrites(ctxFor(core), plan);
    // Against the pre-fix writer this returns 1 (saved + counted an unchanged R).
    expect(applied).toBe(0);
    // R is untouched: no dangling gateway persisted, origin intact.
    expect(core.getServer("R")?.ipmiGatewayServerId).toBeUndefined();
    expect(core.getServer("R")?.origin?.templated).toBeUndefined();
  });
});
