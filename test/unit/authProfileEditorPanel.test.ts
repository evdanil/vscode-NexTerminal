import { beforeEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile } from "../../src/models/config";
import { authProfilePasswordSecretKey } from "../../src/services/ssh/silentAuth";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

// --- vscode mock state ---
const mockPostMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowOpenDialog = vi.fn();
let onDidReceiveMessageHandler: ((msg: Record<string, unknown>) => void) | undefined;
let onDidDisposeHandler: (() => void) | undefined;

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: "",
        onDidReceiveMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
          onDidReceiveMessageHandler = handler;
          return { dispose: vi.fn() };
        }),
        postMessage: (...args: unknown[]) => mockPostMessage(...args)
      },
      onDidDispose: vi.fn((handler: () => void) => {
        onDidDisposeHandler = handler;
        return { dispose: vi.fn() };
      }),
      reveal: vi.fn(),
      dispose: vi.fn()
    })),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args)
  },
  ViewColumn: { Active: 1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  }
}));

vi.mock("node:crypto", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:crypto")>();
  return {
    ...orig,
    randomBytes: (n: number) => Buffer.alloc(n, "a")
  };
});

function makeVault(initialSecrets: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialSecrets));
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    store: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); })
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

async function makeCore(authProfiles: AuthProfile[] = []) {
  const repo = new InMemoryConfigRepository([], [], [], [], authProfiles);
  const core = new NexusCore(repo);
  await core.initialize();
  return core;
}

describe("AuthProfileEditorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDidReceiveMessageHandler = undefined;
    onDidDisposeHandler = undefined;
    // Reset the singleton between tests
    vi.resetModules();
  });

  async function openPanel(
    authProfiles: AuthProfile[] = [],
    secrets: Record<string, string> = {},
    openNew = false
  ) {
    const core = await makeCore(authProfiles);
    const vault = makeVault(secrets);
    // Fresh import to get clean singleton state
    const { AuthProfileEditorPanel } = await import("../../src/ui/authProfileEditorPanel");
    if (openNew) {
      AuthProfileEditorPanel.openNew(core, vault);
    } else {
      AuthProfileEditorPanel.open(core, vault);
    }
    return { core, vault, sendMessage: onDidReceiveMessageHandler! };
  }

  it("save new profile creates auth profile and stores password", async () => {
    const { core, vault, sendMessage } = await openPanel([], {}, true);

    await sendMessage({
      type: "save",
      id: null as unknown as string,
      name: "New Profile",
      username: "admin",
      authType: "password",
      password: "secret123",
      keyPath: ""
    });

    const profiles = core.getSnapshot().authProfiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("New Profile");
    expect(profiles[0].username).toBe("admin");
    expect(profiles[0].authType).toBe("password");
    expect(vault.store).toHaveBeenCalledWith(
      authProfilePasswordSecretKey(profiles[0].id),
      "secret123"
    );
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
  });

  it("save existing profile keeps password when blank", async () => {
    const profile = makeAuthProfile({ id: "ap1", authType: "password" });
    const { core, vault, sendMessage } = await openPanel(
      [profile],
      { [authProfilePasswordSecretKey("ap1")]: "existing-pw" }
    );

    await sendMessage({
      type: "save",
      id: "ap1",
      name: "Updated Name",
      username: "root",
      authType: "password",
      password: "",
      keyPath: ""
    });

    expect(core.getAuthProfile("ap1")?.name).toBe("Updated Name");
    // Password was blank — should NOT have been deleted or stored
    expect(vault.store).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it("save with authType switch from password to key deletes vault secret", async () => {
    const profile = makeAuthProfile({ id: "ap1", authType: "password" });
    const { core, vault, sendMessage } = await openPanel(
      [profile],
      { [authProfilePasswordSecretKey("ap1")]: "old-pw" }
    );

    await sendMessage({
      type: "save",
      id: "ap1",
      name: "Prod Auth",
      username: "root",
      authType: "key",
      password: "",
      keyPath: "/keys/id_ed25519"
    });

    expect(core.getAuthProfile("ap1")?.authType).toBe("key");
    expect(core.getAuthProfile("ap1")?.keyPath).toBe("/keys/id_ed25519");
    expect(vault.delete).toHaveBeenCalledWith(authProfilePasswordSecretKey("ap1"));
  });

  it("delete profile removes from core and vault after confirmation", async () => {
    const profile = makeAuthProfile({ id: "ap1" });
    const { core, vault, sendMessage } = await openPanel([profile]);

    mockShowWarningMessage.mockResolvedValue("Delete");

    await sendMessage({ type: "delete", id: "ap1" });

    expect(core.getAuthProfile("ap1")).toBeUndefined();
    expect(vault.delete).toHaveBeenCalledWith(authProfilePasswordSecretKey("ap1"));
  });

  it("delete profile does nothing if user cancels", async () => {
    const profile = makeAuthProfile({ id: "ap1" });
    const { core, vault, sendMessage } = await openPanel([profile]);

    mockShowWarningMessage.mockResolvedValue(undefined);

    await sendMessage({ type: "delete", id: "ap1" });

    expect(core.getAuthProfile("ap1")).toBeDefined();
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it("browse message opens file dialog and posts result back", async () => {
    const { sendMessage } = await openPanel();

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/home/user/.ssh/id_ed25519" }]);

    await sendMessage({ type: "browse" });

    expect(mockShowOpenDialog).toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "browseResult",
      path: "/home/user/.ssh/id_ed25519"
    });
  });
});
