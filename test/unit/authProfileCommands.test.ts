import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { authProfilePasswordSecretKey, passwordSecretKey } from "../../src/services/ssh/silentAuth";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { registerAuthProfileCommands } from "../../src/commands/authProfileCommands";
import { FolderTreeItem, ServerTreeItem } from "../../src/ui/nexusTreeProvider";
import { WebviewFormPanel } from "../../src/ui/webviewFormPanel";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockWithProgress = vi.fn();
const openPanel = vi.fn();

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
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(
      public readonly id: string,
      public readonly color?: unknown
    ) {}
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
    open: (...args: unknown[]) => openPanel(...args)
  }
}));

vi.mock("../../src/commands/serverCommands", () => ({
  browseForKey: vi.fn(async () => undefined)
}));

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "old-user",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

function makeAuthProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: "ap1",
    name: "Prod Auth",
    username: "root",
    authType: "password",
    ...overrides
  };
}

async function setupContext(options?: {
  servers?: ServerConfig[];
  authProfiles?: AuthProfile[];
  withVault?: boolean;
  initialSecrets?: Record<string, string>;
}): Promise<{
  ctx: CommandContext;
  core: NexusCore;
  vault:
    | {
        get: ReturnType<typeof vi.fn>;
        store: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
      }
    | undefined;
}> {
  const repo = new InMemoryConfigRepository(
    options?.servers ?? [],
    [],
    [],
    [],
    options?.authProfiles ?? []
  );
  const core = new NexusCore(repo);
  await core.initialize();

  const secretState = new Map<string, string>(Object.entries(options?.initialSecrets ?? {}));
  const vault = options?.withVault === false
    ? undefined
    : {
        get: vi.fn(async (key: string) => secretState.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secretState.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secretState.delete(key);
        })
      };

  const ctx: CommandContext = {
    core,
    tunnelManager: {} as any,
    serialSidecar: {} as any,
    sshFactory: {} as any,
    sshPool: {} as any,
    loggerFactory: {} as any,
    sessionLogDir: "",
    terminalsByServer: new Map() as any,
    sessionTerminals: new Map() as any,
    serialTerminals: new Map() as any,
    highlighter: {} as any,
    sftpService: {} as any,
    fileExplorerProvider: {} as any,
    secretVault: vault as any,
    registrySync: undefined
  };

  return { ctx, core, vault };
}

describe("authProfileCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockWithProgress.mockImplementation(async (_opts: unknown, task: () => Promise<void>) => task());
  });

  it("applies auth profile to folder even when secretVault is unavailable", async () => {
    const { ctx, core } = await setupContext({
      withVault: false,
      servers: [makeServer({ id: "s1", group: "Prod" }), makeServer({ id: "s2", group: "Other", username: "stay" })],
      authProfiles: [makeAuthProfile({ id: "ap1", username: "new-user", authType: "key", keyPath: "/keys/id_ed25519" })]
    });
    registerAuthProfileCommands(ctx);

    mockShowQuickPick.mockResolvedValue({ profile: core.getAuthProfile("ap1") });
    mockShowWarningMessage.mockResolvedValue("Apply");

    const cmd = registeredCommands.get("nexus.authProfile.applyToFolder");
    expect(cmd).toBeDefined();
    await cmd!(new FolderTreeItem("Prod"));

    expect(core.getServer("s1")?.username).toBe("new-user");
    expect(core.getServer("s1")?.authType).toBe("key");
    expect(core.getServer("s1")?.keyPath).toBe("/keys/id_ed25519");
    expect(core.getServer("s2")?.username).toBe("stay");
  });

  it("manage edit deletes stored profile secret when switching to non-password auth", async () => {
    const profile = makeAuthProfile({ id: "ap1", authType: "password" });
    const { ctx, core, vault } = await setupContext({
      authProfiles: [profile],
      withVault: true,
      initialSecrets: { [authProfilePasswordSecretKey("ap1")]: "old-secret" }
    });
    registerAuthProfileCommands(ctx);

    mockShowQuickPick.mockResolvedValue({ action: "edit", profile });
    const manage = registeredCommands.get("nexus.authProfile.manage");
    expect(manage).toBeDefined();
    await manage!();

    expect(openPanel).toHaveBeenCalled();
    const options = openPanel.mock.calls[0][2];
    await options.onSubmit({
      name: "Prod Auth",
      username: "root",
      authType: "key",
      keyPath: "/keys/id_ed25519"
    });

    expect(vault?.delete).toHaveBeenCalledWith(authProfilePasswordSecretKey("ap1"));
    expect(core.getAuthProfile("ap1")?.authType).toBe("key");
  });

  it("manage delete removes auth profile secret from vault", async () => {
    const profile = makeAuthProfile({ id: "ap1" });
    const { ctx, core, vault } = await setupContext({
      authProfiles: [profile],
      withVault: true
    });
    registerAuthProfileCommands(ctx);

    mockShowQuickPick.mockResolvedValue({ action: "delete", profile });
    mockShowWarningMessage.mockResolvedValue("Delete");

    const manage = registeredCommands.get("nexus.authProfile.manage");
    expect(manage).toBeDefined();
    await manage!();

    expect(vault?.delete).toHaveBeenCalledWith(authProfilePasswordSecretKey("ap1"));
    expect(core.getAuthProfile("ap1")).toBeUndefined();
  });

  it("applyToServer copies profile password into server password secret", async () => {
    const profile = makeAuthProfile({ id: "ap1", username: "deploy", authType: "password" });
    const server = makeServer({ id: "s1", username: "old" });
    const { ctx, core, vault } = await setupContext({
      servers: [server],
      authProfiles: [profile],
      withVault: true,
      initialSecrets: { [authProfilePasswordSecretKey("ap1")]: "profile-pass" }
    });
    registerAuthProfileCommands(ctx);

    mockShowQuickPick.mockResolvedValue({ profile });

    const applyToServer = registeredCommands.get("nexus.authProfile.applyToServer");
    expect(applyToServer).toBeDefined();
    await applyToServer!(new ServerTreeItem(server));

    expect(core.getServer("s1")?.username).toBe("deploy");
    expect(core.getServer("s1")?.authType).toBe("password");
    expect(vault?.store).toHaveBeenCalledWith(passwordSecretKey("s1"), "profile-pass");
  });
});
