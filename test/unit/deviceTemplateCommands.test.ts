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
const formPanelOpens: Array<{ formId: string; options: { onSubmit: (v: FormValues) => Promise<void> | void } }> = [];

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn()
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

beforeEach(() => {
  registeredCommands.clear();
  formPanelOpens.length = 0;
  mockShowQuickPick.mockReset();
  mockShowWarningMessage.mockReset();
  mockShowInformationMessage.mockReset();
  mockWithProgress.mockReset();
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

  it("rejects an empty name and drops an auth field left on (None)/create sentinel", () => {
    expect(() => parseDeviceTemplateFormValues({ name: "  " })).toThrow(/Name is required/);
    const t = parseDeviceTemplateFormValues({ name: "T", mode_authProfileId: "fill", authProfileId: "" });
    expect(t.fields.authProfileId).toBeUndefined();
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
    mockShowQuickPick.mockResolvedValue({ label: "Core", template: core.getSnapshot().deviceTemplates[0] });
    await registeredCommands.get("nexus.deviceTemplate.manage")!();
    expect(mockShowQuickPick).toHaveBeenCalled();
    const editOpen = formPanelOpens.find((o) => o.formId.startsWith("device-template-edit-"));
    expect(editOpen).toBeDefined();
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

    // The consent modal was shown, modal: true, with the verbatim ownership sentence.
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Values applied here count as your own edits — future inventory syncs will not change them."),
      { modal: true },
      "Apply"
    );
    // The write landed and the stamp was cleared (§7.4 ownership rule).
    const after = core.getServer("srv-1")!;
    expect(after.proxy).toEqual({ type: "socks5", host: "10.0.0.2", port: 1080 });
    expect(after.origin?.templated?.proxy).toBeUndefined();
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
