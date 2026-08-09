import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { ProxyConfig, ServerConfig } from "../../src/models/config";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { FormValues } from "../../src/ui/formTypes";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
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
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    withProgress: (...args: unknown[]) => mockWithProgress(...args)
  },
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
const { registerDeviceTemplateCommands, parseDeviceTemplateFormValues } = await import("../../src/commands/deviceTemplateCommands");
const { FolderTreeItem } = await import("../../src/ui/nexusTreeProvider");
const { proxyPasswordSecretKey } = await import("../../src/services/ssh/silentAuth");

const P: ProxyConfig = { type: "socks5", host: "10.0.0.9", port: 1080 };

function makeCore(): NexusCore {
  return new NexusCore(new InMemoryConfigRepository());
}

function ctxFor(core: NexusCore): CommandContext {
  return { core } as unknown as CommandContext;
}

function register(core: NexusCore): void {
  registeredCommands.clear();
  registerDeviceTemplateCommands(ctxFor(core));
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
  registerDeviceTemplateCommands({ core, secretVault: vault } as unknown as CommandContext);
}

beforeEach(() => {
  registeredCommands.clear();
  formPanelOpens.length = 0;
  mockShowQuickPick.mockReset();
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
