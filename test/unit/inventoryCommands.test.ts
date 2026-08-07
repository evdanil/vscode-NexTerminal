import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryCommands, type InventoryRuntimeTeardown } from "../../src/commands/inventoryCommands";
import { NexusCore } from "../../src/core/nexusCore";
import type { ServerConfig } from "../../src/models/config";
import { inventorySecretKey, type InventoryProvider, type InventorySourceConfig, type InventoryTree } from "../../src/models/inventory";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockExecuteCommand = vi.fn();
const mockOpenTextDocument = vi.fn();
const mockShowTextDocument = vi.fn();

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
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    withProgress: (_opts: unknown, task: (...a: unknown[]) => unknown) => task(),
    showTextDocument: (...args: unknown[]) => mockShowTextDocument(...args)
  },
  workspace: {
    openTextDocument: (...args: unknown[]) => mockOpenTextDocument(...args)
  },
  ProgressLocation: { Notification: 15 }
}));

function makeProvider(overrides: Partial<InventoryProvider> = {}): InventoryProvider {
  return {
    id: "fake",
    label: "Fake Provider",
    configFields: [
      { id: "host", label: "Host", type: "string", required: true },
      { id: "apiToken", label: "API Token", type: "password", required: true }
    ],
    testConnection: vi.fn(async () => {}),
    fetchInventory: vi.fn(async (): Promise<InventoryTree> => ({ contractVersion: 1, devices: [] })),
    ...overrides
  };
}

function makeVault(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    })
  };
}

function makeTeardown(): InventoryRuntimeTeardown & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    teardownServerRuntime: vi.fn(async (serverId: string) => {
      calls.push(serverId);
    })
  };
}

function makeSource(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    id: "src-1",
    providerId: "fake",
    name: "My Source",
    targetFolder: "",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: {},
    secretFieldIds: [],
    ...overrides
  };
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "owned-1",
    name: "old-sw",
    host: "10.0.0.1",
    port: 22,
    username: "netops",
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

describe("inventoryCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  describe("nexus.inventory.addSource", () => {
    async function runAddSourceHappyPath(): Promise<{ core: NexusCore; vault: ReturnType<typeof makeVault>; provider: InventoryProvider }> {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      mockShowInputBox
        .mockResolvedValueOnce("My NetBox") // name
        .mockResolvedValueOnce("Infra") // target folder
        .mockResolvedValueOnce("admin") // default username
        .mockResolvedValueOnce("netbox.local") // host field
        .mockResolvedValueOnce("secret-token"); // apiToken field
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" }); // prune policy
      mockShowInformationMessage.mockResolvedValueOnce(undefined); // no "Sync Now" click

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      return { core, vault, provider };
    }

    it("stores the password field under inventory-source-{id}-apiToken, keeps it out of config, and records secretFieldIds (kills secrets-in-config / wrong key)", async () => {
      const { core, vault } = await runAddSourceHappyPath();

      const snapshot = core.getSnapshot();
      expect(snapshot.inventorySources).toHaveLength(1);
      const source = snapshot.inventorySources[0];
      expect(source.secretFieldIds).toEqual(["apiToken"]);
      expect(source.config).toEqual({ host: "netbox.local" });
      expect((source.config as Record<string, unknown>).apiToken).toBeUndefined();

      expect(vault.store).toHaveBeenCalledWith(inventorySecretKey(source.id, "apiToken"), "secret-token");
      expect(await vault.get(inventorySecretKey(source.id, "apiToken"))).toBe("secret-token");
    });

    it("testConnection failure + Save Anyway persists the source and its secrets", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        testConnection: vi.fn(async () => {
          throw new Error("boom");
        })
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      mockShowInputBox
        .mockResolvedValueOnce("My NetBox")
        .mockResolvedValueOnce("Infra")
        .mockResolvedValueOnce("admin")
        .mockResolvedValueOnce("netbox.local")
        .mockResolvedValueOnce("secret-token");
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });
      mockShowErrorMessage.mockResolvedValueOnce("Save Anyway");
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();

      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      expect(vault.store).toHaveBeenCalled();
    });

    it("testConnection failure + Cancel persists nothing and leaves the vault empty (kills saving before the gate)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        testConnection: vi.fn(async () => {
          throw new Error("boom");
        })
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      mockShowInputBox
        .mockResolvedValueOnce("My NetBox")
        .mockResolvedValueOnce("Infra")
        .mockResolvedValueOnce("admin")
        .mockResolvedValueOnce("netbox.local")
        .mockResolvedValueOnce("secret-token");
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });
      mockShowErrorMessage.mockResolvedValueOnce("Cancel");

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();

      expect(core.getSnapshot().inventorySources).toHaveLength(0);
      expect(vault.store).not.toHaveBeenCalled();
    });

    it("F18 — a vault that throws on store aborts before the source is created (no partial source)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = {
        get: vi.fn(async () => undefined),
        store: vi.fn(async () => {
          throw new Error("keychain unavailable");
        }),
        delete: vi.fn(async () => {})
      };
      registerInventoryCommands(core, registry, vault, makeTeardown());

      mockShowInputBox
        .mockResolvedValueOnce("My NetBox")
        .mockResolvedValueOnce("Infra")
        .mockResolvedValueOnce("admin")
        .mockResolvedValueOnce("netbox.local")
        .mockResolvedValueOnce("secret-token");
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();

      expect(core.getSnapshot().inventorySources).toHaveLength(0);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("keychain"));
    });
  });

  describe("nexus.inventory.editSource", () => {
    it("F7 — a blank secret field keeps the previously saved vault value AND hydrates it into the testConnection call (kills blank overwriting the token)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] }));
      await vault.store(inventorySecretKey("src-1", "apiToken"), "old-token");

      mockShowInputBox
        .mockResolvedValueOnce("My Source") // name
        .mockResolvedValueOnce("Infra") // targetFolder
        .mockResolvedValueOnce("admin") // defaultUsername
        .mockResolvedValueOnce("netbox.local") // host
        .mockResolvedValueOnce(""); // apiToken left blank -> keep saved value
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("old-token");
      expect(provider.testConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ apiToken: "old-token" }));
    });
  });

  describe("nexus.inventory.removeSource", () => {
    it("Delete Servers: owned servers, their vault keys, and the source's own secrets are all removed; teardown runs for each deleted server (kills keep-deleting / leaving inventory-source-* secrets)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({
        [inventorySecretKey("src-1", "apiToken")]: "tok",
        [passwordSecretKey("owned-1")]: "pw",
        [passphraseSecretKey("owned-1")]: "pp",
        [proxyPasswordSecretKey("owned-1")]: "proxpw"
      });
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Delete Servers");

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await cmd();

      expect(teardown.calls).toEqual(["owned-1"]);
      expect(core.getSnapshot().servers).toHaveLength(0);
      expect(core.getSnapshot().inventorySources).toHaveLength(0);
      expect(await vault.get(passwordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passphraseSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBeUndefined();
    });

    it("Keep Servers: origin is stripped and the server survives; the source record and its own secrets are removed (kills keep-still-deleting)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await cmd();

      expect(teardown.calls).toEqual([]);
      const server = core.getServer("owned-1");
      expect(server).toBeDefined();
      expect(server?.origin).toBeUndefined();
      expect(core.getSnapshot().inventorySources).toHaveLength(0);
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBeUndefined();
    });

    it("dismissing the confirm modal removes nothing", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await cmd();

      expect(core.getSnapshot().servers).toHaveLength(1);
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
    });

    it("F4 — removeSource refuses while the source is mid-sync (warns, mutates nothing)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      let resolveFetch!: (tree: InventoryTree) => void;
      const provider = makeProvider({
        fetchInventory: vi.fn(() => new Promise<InventoryTree>((resolve) => (resolveFetch = resolve)))
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      const syncCmd = registeredCommands.get("nexus.inventory.syncNow")!;
      const syncPromise = syncCmd("src-1");

      const removeCmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await removeCmd();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("currently syncing"));
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      expect(core.getSnapshot().servers).toHaveLength(1);

      resolveFetch({ contractVersion: 1, devices: [] });
      await syncPromise;
    });
  });

  describe("nexus.inventory.syncNow", () => {
    it("prune 'delete' tears down and removes only the pruned server, applies the plan, and cleans up only its vault secrets (F1 — teardown runs before apply)", async () => {
      const survivor = makeServer({
        id: "owned-2",
        name: "core-sw",
        host: "10.0.0.2",
        group: "Infra",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        group: "Infra",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([survivor, pruned]);
      const core = new NexusCore(repo);
      await core.initialize();

      const callOrder: string[] = [];
      const originalApply = core.applyInventorySyncPlan.bind(core);
      vi.spyOn(core, "applyInventorySyncPlan").mockImplementation(async (application) => {
        callOrder.push("apply");
        return originalApply(application);
      });

      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:2", name: "core-sw", endpoints: [{ kind: "ssh", host: "10.0.0.2", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault({
        [passwordSecretKey("owned-1")]: "pw1",
        [passphraseSecretKey("owned-1")]: "pp1",
        [proxyPasswordSecretKey("owned-1")]: "proxy1",
        [passwordSecretKey("owned-2")]: "pw2",
        [passphraseSecretKey("owned-2")]: "pp2",
        [proxyPasswordSecretKey("owned-2")]: "proxy2"
      });
      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          callOrder.push(`teardown:${serverId}`);
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(teardown.teardownServerRuntime).toHaveBeenCalledTimes(1);
      expect(teardown.teardownServerRuntime).toHaveBeenCalledWith("owned-1");
      expect(callOrder).toEqual(["teardown:owned-1", "apply"]);

      const snapshot = core.getSnapshot();
      expect(snapshot.servers.map((s) => s.id)).toEqual(["owned-2"]);

      expect(await vault.get(passwordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passphraseSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passwordSecretKey("owned-2"))).toBe("pw2");
      expect(await vault.get(passphraseSecretKey("owned-2"))).toBe("pp2");
      expect(await vault.get(proxyPasswordSecretKey("owned-2"))).toBe("proxy2");
    });

    it("re-entrancy: a second sync on the same source while the first is fetching warns and never fetches twice (kills a missing guard)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      let resolveFetch!: (tree: InventoryTree) => void;
      const provider = makeProvider({
        fetchInventory: vi.fn(() => new Promise<InventoryTree>((resolve) => (resolveFetch = resolve)))
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      const first = cmd("src-1");
      const second = cmd("src-1");
      await second;

      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("already syncing"));
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);

      resolveFetch({ contractVersion: 1, devices: [] });
      await first;
    });

    it("dismissing the confirm modal applies nothing (kills apply-before-modal)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:1", name: "new-sw", endpoints: [{ kind: "ssh", host: "10.0.0.5", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowInformationMessage.mockResolvedValueOnce(undefined); // dismiss

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(core.getSnapshot().servers).toHaveLength(0);
    });

    it("F3 — recomputes against a fresh snapshot right before applying: a manual edit made while the modal is open survives (kills applying stale plan data)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:1", name: "old-sw", endpoints: [{ kind: "ssh", host: "10.0.0.9", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowInformationMessage.mockImplementationOnce(async () => {
        // Simulate a manual edit landing while the confirm modal is open.
        await core.addOrUpdateServer({ ...core.getServer("owned-1")!, logSession: true });
        return "Apply";
      });

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(core.getServer("owned-1")?.logSession).toBe(true);
      expect(core.getServer("owned-1")?.host).toBe("10.0.0.9");
    });

    it("nothing-to-do still bumps lastSyncAt without a confirm modal", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(core.getInventorySource("src-1")?.lastSyncAt).toBeDefined();
      expect(mockShowInformationMessage).toHaveBeenCalled(); // toast, not a modal confirm
    });

    it("missing saved credential aborts with an error pointing at editSource", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] })); // vault never seeded

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Edit the source"));
      expect(provider.fetchInventory).not.toHaveBeenCalled();
    });

    it("(FIX 3) the confirm modal aggregates manual-duplicate matches into a single count line (kills omitting the aggregate line from the modal)", async () => {
      const manual = makeServer({ id: "manual-1", name: "hand-added", host: "10.0.0.5", port: 22 });
      const repo = new InMemoryConfigRepository([manual]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:1", name: "new-sw", endpoints: [{ kind: "ssh", host: "10.0.0.5", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      // The manual-duplicate match also produces a per-device warning, so the
      // post-apply "N warnings during sync" toast fires too.
      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      const [, options] = mockShowInformationMessage.mock.calls[0] as [string, { detail: string }];
      expect(options.detail).toContain("1 device matches existing manual servers and will be added as duplicates.");
    });

    it("(F16) the prune-delete confirm modal surfaces the SSH jump-host dependents count (kills dropping countJumpHostDependents from the modal)", async () => {
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const dependent = makeServer({
        id: "dependent-1",
        name: "jump-user",
        host: "10.0.0.50",
        proxy: { type: "ssh", jumpHostId: "owned-1" }
      });
      const repo = new InMemoryConfigRepository([pruned, dependent]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({ fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] })) });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      const [, options] = mockShowInformationMessage.mock.calls[0] as [string, { detail: string }];
      expect(options.detail).toContain("1 other server");
      expect(options.detail.toLowerCase()).toContain("jump host");
      // Singular subject-verb agreement (kills "1 other server use..." — should be "uses").
      expect(options.detail).toContain("1 other server uses these as SSH jump hosts.");
    });

    it("(F8) a provider returning a malformed inventory tree surfaces a protocol error and leaves core state unchanged (kills removing validateInventoryTree from syncNow)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({ devices: null }) as unknown as InventoryTree)
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      const beforeSnapshot = core.getSnapshot();

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Unexpected response"));
      expect(core.getSnapshot().servers).toEqual(beforeSnapshot.servers);
      expect(core.getInventorySource("src-1")?.lastSyncAt).toBeUndefined();
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });
  });
});
