import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormDefinition, FormValues } from "../../src/ui/formTypes";

const mockExecuteCommand = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowQuickPick = vi.fn();
const mockGetConfiguration = vi.fn();
const mockWebviewOpen = vi.fn();
const mockFormValuesToServer = vi.fn();
const mockFormValuesToSerial = vi.fn();
const mockFormValuesToLocalShell = vi.fn();
const mockCollectGroups = vi.fn(() => []);
const mockSyncProxyPasswordSecret = vi.fn();
const mockBrowseForKey = vi.fn();
const mockScanForPort = vi.fn();
const mockInlineAuthProfile = {
  handleCreateInline: vi.fn(),
  attachPanel: vi.fn()
};

vi.mock("vscode", () => ({
  commands: {
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() }))
  },
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showInformationMessage: vi.fn()
  },
  workspace: {
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args)
  },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(public readonly id: string) {}
  }
}));

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: {
    open: (...args: unknown[]) => mockWebviewOpen(...args)
  }
}));

vi.mock("../../src/commands/serverCommands", () => ({
  browseForKey: (...args: unknown[]) => mockBrowseForKey(...args),
  collectGroups: (...args: unknown[]) => mockCollectGroups(...args),
  formValuesToServer: (...args: unknown[]) => mockFormValuesToServer(...args),
  syncProxyPasswordSecret: (...args: unknown[]) => mockSyncProxyPasswordSecret(...args)
}));

vi.mock("../../src/commands/serialCommands", () => ({
  formValuesToSerial: (...args: unknown[]) => mockFormValuesToSerial(...args),
  scanForPort: (...args: unknown[]) => mockScanForPort(...args)
}));

vi.mock("../../src/commands/localShellCommands", () => ({
  formValuesToLocalShell: (...args: unknown[]) => mockFormValuesToLocalShell(...args),
  getConfiguredVscodeTerminalProfileNames: () => ["PowerShell", "Ubuntu"]
}));

vi.mock("../../src/commands/inlineAuthProfileCreation", () => ({
  createInlineAuthProfileCreation: () => mockInlineAuthProfile
}));

import { openUnifiedForm, registerProfileCommands } from "../../src/commands/profileCommands";
import { LocalShellProfileTreeItem } from "../../src/ui/nexusTreeProvider";

function makeCtx() {
  return {
    core: {
      getSnapshot: vi.fn(() => ({
        servers: [{ id: "server-1", name: "Server" }],
        authProfiles: []
      })),
      getAuthProfile: vi.fn(),
      addOrUpdateServer: vi.fn(),
      addOrUpdateSerialProfile: vi.fn(),
      addOrUpdateLocalShellProfile: vi.fn()
    }
  } as any;
}

function latestFormOptions(): {
  definition: FormDefinition;
  onSubmit: (values: FormValues) => Promise<void>;
  onTest: (values: FormValues) => Promise<void>;
} {
  const call = mockWebviewOpen.mock.calls.at(-1);
  expect(call).toBeDefined();
  const handlers = call![2] as {
    onSubmit: (values: FormValues) => Promise<void>;
    onTest: (values: FormValues) => Promise<void>;
  };
  return {
    definition: call![1] as FormDefinition,
    onSubmit: handlers.onSubmit,
    onTest: handlers.onTest
  };
}

describe("openUnifiedForm test action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback: unknown) => fallback)
    });
    mockShowQuickPick.mockReset();
    mockWebviewOpen.mockReturnValue({ dispose: vi.fn() });
    mockFormValuesToServer.mockReturnValue({ id: "draft-server" });
    mockFormValuesToSerial.mockReturnValue({ id: "draft-serial" });
    mockFormValuesToLocalShell.mockReturnValue({ id: "draft-local" });
  });

  it("does not open or register unsaved Local Shell drafts from the generic form test action", async () => {
    openUnifiedForm(makeCtx());
    const { definition, onTest } = latestFormOptions();

    expect(definition.testable).toBe(true);
    expect(definition.testableWhen).toEqual({ field: "profileType", value: ["ssh", "serial"] });

    await onTest({
      profileType: "localShell",
      name: "Draft Local",
      launchMode: "custom",
      shellPath: "/bin/bash"
    });

    expect(mockExecuteCommand).not.toHaveBeenCalledWith("nexus.localShell.connect", expect.anything());
  });

  it("does not render a Test Connection button for the direct Local Shell form", () => {
    openUnifiedForm(makeCtx(), { addMode: "localShell", profileType: "localShell" });
    const { definition } = latestFormOptions();

    expect(definition.testable).toBe(false);
    expect(definition.testableWhen).toBeUndefined();
  });

  it("populates Local Shell VS Code profile suggestions from terminal settings", () => {
    mockGetConfiguration.mockImplementation((section: string) => ({
      get: vi.fn((key: string, fallback: unknown) => {
        if (section === "terminal.integrated" && key === "profiles.linux") {
          return {
            PowerShell: { path: "pwsh" },
            Ubuntu: { path: "wsl.exe", args: ["-d", "Ubuntu"] }
          };
        }
        return fallback;
      })
    }));

    openUnifiedForm(makeCtx(), { addMode: "localShell", profileType: "localShell" });
    const { definition } = latestFormOptions();
    const profileNameField = definition.fields.find(
      (field) => "key" in field && field.key === "vscodeProfileName"
    );

    expect(profileNameField).toEqual(expect.objectContaining({
      type: "combobox",
      suggestions: ["PowerShell", "Ubuntu"]
    }));
  });

  it("keeps the form open by throwing when Local Shell submit data is invalid", async () => {
    mockFormValuesToLocalShell.mockReturnValueOnce(undefined);
    openUnifiedForm(makeCtx(), { addMode: "localShell", profileType: "localShell" });
    const { onSubmit } = latestFormOptions();

    await expect(onSubmit({
      profileType: "localShell",
      name: "Draft Local",
      launchMode: "custom"
    })).rejects.toThrow(/required local shell fields/i);
  });

  it("preserves SSH and Serial test actions from the generic form", async () => {
    openUnifiedForm(makeCtx());
    const { onTest } = latestFormOptions();

    await onTest({ profileType: "ssh", name: "Server", host: "example.com", username: "me" });
    await onTest({ profileType: "serial", name: "Serial", path: "COM1" });

    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.server.testConnection", { server: { id: "draft-server" } });
    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.serial.testConnection", { profile: { id: "draft-serial" } });
  });

  it("offers Open and Run Script for Local Shell profile quick actions without Test Connection", async () => {
    const profile = { id: "local-1", name: "Dev", launchMode: "custom", shellPath: "/bin/bash" };
    const item = new LocalShellProfileTreeItem(profile as any, false);
    mockShowQuickPick.mockResolvedValueOnce({ label: "Open and Run Script", command: "nexus.localShell.runWithScript" });
    registerProfileCommands(makeCtx());

    await (vi.mocked((await import("vscode")).commands.registerCommand).mock.calls.find(
      ([command]) => command === "nexus.profile.actions"
    )?.[1] as (arg: unknown) => Promise<void>)(item);

    const picks = mockShowQuickPick.mock.calls[0][0] as Array<{ label: string }>;
    expect(picks.map((pick) => pick.label)).toContain("Open and Run Script");
    expect(picks.map((pick) => pick.label)).not.toContain("Test Connection");
    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.localShell.runWithScript", item);
  });
});
