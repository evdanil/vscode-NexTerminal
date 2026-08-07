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

    it("FINDING 2 — an optional password field left blank is omitted from secretFieldIds and never written to the vault (kills recording every password field regardless of whether it was stored)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        configFields: [
          { id: "host", label: "Host", type: "string", required: true },
          { id: "apiToken", label: "API Token", type: "password", required: true },
          { id: "extraToken", label: "Extra Token", type: "password", required: false }
        ]
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      mockShowInputBox
        .mockResolvedValueOnce("My NetBox") // name
        .mockResolvedValueOnce("Infra") // target folder
        .mockResolvedValueOnce("admin") // default username
        .mockResolvedValueOnce("netbox.local") // host field
        .mockResolvedValueOnce("secret-token") // apiToken field
        .mockResolvedValueOnce(""); // extraToken left blank (optional)
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();

      const source = core.getSnapshot().inventorySources[0];
      expect(source.secretFieldIds).toEqual(["apiToken"]);
      expect(vault.store).not.toHaveBeenCalledWith(inventorySecretKey(source.id, "extraToken"), expect.anything());
      expect(await vault.get(inventorySecretKey(source.id, "extraToken"))).toBeUndefined();
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

    it("FINDING 1 — core.addOrUpdateInventorySource rejecting after secrets were stored rolls back the vault keys just written (kills orphaned inventory-source-* secrets)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      vi.spyOn(core, "addOrUpdateInventorySource").mockRejectedValueOnce(new Error("disk full"));
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault();
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
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("was not created"));

      // The key stored during this run must have been deleted again — no
      // inventory-source-* key survives for a source that was never created.
      expect(vault.store).toHaveBeenCalledTimes(1);
      const [storedKey] = (vault.store as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(vault.delete).toHaveBeenCalledWith(storedKey);
      expect(await vault.get(storedKey)).toBeUndefined();
    });

    it("FINDING B — a second field's store rejecting after an earlier one succeeded rolls back that earlier key too (kills partial-write orphaning)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        configFields: [
          { id: "host", label: "Host", type: "string", required: true },
          { id: "field1", label: "Field 1", type: "password", required: true },
          { id: "field2", label: "Field 2", type: "password", required: true }
        ]
      });
      registry.register(provider);
      const backingStore = new Map<string, string>();
      let storeCallCount = 0;
      const vault = {
        get: vi.fn(async (key: string) => backingStore.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          storeCallCount++;
          if (storeCallCount === 2) {
            throw new Error("keychain unavailable");
          }
          backingStore.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          backingStore.delete(key);
        })
      };
      registerInventoryCommands(core, registry, vault, makeTeardown());

      mockShowInputBox
        .mockResolvedValueOnce("My NetBox") // name
        .mockResolvedValueOnce("Infra") // targetFolder
        .mockResolvedValueOnce("admin") // defaultUsername
        .mockResolvedValueOnce("netbox.local") // host
        .mockResolvedValueOnce("value1") // field1 -> store succeeds (call 1)
        .mockResolvedValueOnce("value2"); // field2 -> store rejects (call 2)
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();

      expect(core.getSnapshot().inventorySources).toHaveLength(0);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("keychain"));

      // If the fix were reverted (catch returns without deleting earlier
      // keys), field1's key would still be present here even though the
      // source was never created.
      const [field1Key] = (vault.store as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(vault.delete).toHaveBeenCalledWith(field1Key);
      expect(backingStore.size).toBe(0);
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

    it("FINDING 3 — a vault key whose password field was dropped from the provider schema is deleted at save time; a still-schema-valid kept secret survives (kills orphaning stale vault entries)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      // Current schema only has apiToken — "extra" no longer exists on this provider.
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken", "extra"] })
      );
      await vault.store(inventorySecretKey("src-1", "apiToken"), "old-token");
      await vault.store(inventorySecretKey("src-1", "extra"), "leftover-token");

      mockShowInputBox
        .mockResolvedValueOnce("My Source") // name
        .mockResolvedValueOnce("Infra") // targetFolder
        .mockResolvedValueOnce("admin") // defaultUsername
        .mockResolvedValueOnce("netbox.local") // host
        .mockResolvedValueOnce(""); // apiToken left blank -> keep saved value
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(await vault.get(inventorySecretKey("src-1", "extra"))).toBeUndefined();
      expect(vault.delete).toHaveBeenCalledWith(inventorySecretKey("src-1", "extra"));
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("old-token");
      expect(core.getInventorySource("src-1")?.secretFieldIds).toEqual(["apiToken"]);
    });

    it("FINDING 1 — core.addOrUpdateInventorySource rejecting leaves pre-existing secrets untouched (no stale-key cleanup before persist) and rolls back only the brand-new key (kills cleanup-before-persist / missing rollback)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      // Current schema: host, apiToken, extraToken. "legacyToken" existed on an
      // older schema version and is no longer a field at all — it's the stale
      // key that a (buggy) cleanup-before-persist would wrongly delete even
      // though the update never actually took effect.
      const provider = makeProvider({
        configFields: [
          { id: "host", label: "Host", type: "string", required: true },
          { id: "apiToken", label: "API Token", type: "password", required: true },
          { id: "extraToken", label: "Extra Token", type: "password", required: false }
        ]
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken", "legacyToken"] })
      );
      await vault.store(inventorySecretKey("src-1", "apiToken"), "old-token");
      await vault.store(inventorySecretKey("src-1", "legacyToken"), "legacy-value");

      vi.spyOn(core, "addOrUpdateInventorySource").mockRejectedValueOnce(new Error("disk full"));

      mockShowInputBox
        .mockResolvedValueOnce("My Source") // name
        .mockResolvedValueOnce("Infra") // targetFolder
        .mockResolvedValueOnce("admin") // defaultUsername
        .mockResolvedValueOnce("netbox.local") // host
        .mockResolvedValueOnce("") // apiToken left blank -> keep saved value
        .mockResolvedValueOnce("new-extra"); // extraToken: brand-new secret this run
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("was not applied"));

      // Persist failed -> the source record (and its secretFieldIds) must be unchanged.
      expect(core.getInventorySource("src-1")?.secretFieldIds).toEqual(["apiToken", "legacyToken"]);

      // Pre-existing keys survive: apiToken untouched (never re-stored), and
      // legacyToken's stale-cleanup must not have run before the failed persist.
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("old-token");
      expect(await vault.get(inventorySecretKey("src-1", "legacyToken"))).toBe("legacy-value");

      // The brand-new key written this run (not in the old secretFieldIds) is rolled back.
      expect(await vault.get(inventorySecretKey("src-1", "extraToken"))).toBeUndefined();
    });

    it("FINDING C — a persist rejection restores the PRE-EDIT value of a re-entered (overwritten) secret, not just delete-only rollback of newly-added keys (kills delete-only rollback)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider(); // host (string) + apiToken (password, required)
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] })
      );
      await vault.store(inventorySecretKey("src-1", "apiToken"), "old-tok");

      vi.spyOn(core, "addOrUpdateInventorySource").mockRejectedValueOnce(new Error("disk full"));

      mockShowInputBox
        .mockResolvedValueOnce("My Source") // name
        .mockResolvedValueOnce("Infra") // targetFolder
        .mockResolvedValueOnce("admin") // defaultUsername
        .mockResolvedValueOnce("netbox.local") // host
        .mockResolvedValueOnce("new-tok"); // apiToken RE-ENTERED — overwrites the old value
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("was not applied"));

      // If the fix were reverted (rollback only deletes newly-ADDED keys),
      // apiToken — which already existed before this edit — would be left at
      // "new-tok" even though the source record itself reverted to old.
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("old-tok");
    });

    it("ITEM 3 — a second field's store rejecting mid-loop (persist never even attempted) rolls back the earlier field's overwritten value and the later field's brand-new key (kills partial-edit-write)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        configFields: [
          { id: "host", label: "Host", type: "string", required: true },
          { id: "field1", label: "Field 1", type: "password", required: true },
          { id: "field2", label: "Field 2", type: "password", required: false }
        ]
      });
      registry.register(provider);
      const backingStore = new Map<string, string>([[inventorySecretKey("src-1", "field1"), "old1"]]);
      let storeCallCount = 0;
      const vault = {
        get: vi.fn(async (key: string) => backingStore.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          storeCallCount++;
          if (storeCallCount === 2) {
            throw new Error("keychain unavailable");
          }
          backingStore.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          backingStore.delete(key);
        })
      };
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["field1"] })
      );

      mockShowInputBox
        .mockResolvedValueOnce("My Source") // name
        .mockResolvedValueOnce("Infra") // targetFolder
        .mockResolvedValueOnce("admin") // defaultUsername
        .mockResolvedValueOnce("netbox.local") // host
        .mockResolvedValueOnce("new1") // field1 (existing) re-entered -> store call 1, succeeds
        .mockResolvedValueOnce("new2"); // field2 (new) -> store call 2, rejects
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("keychain"));
      // The source record was never persisted (the loop failed before reaching that step).
      expect(core.getInventorySource("src-1")?.secretFieldIds).toEqual(["field1"]);

      // If ITEM 3 were reverted (catch just returns, no rollback), field1
      // would be left at "new1" (the mid-loop overwrite) and field2 would
      // leak whatever partial state store() left behind — here it's simply
      // absent because the mocked store rejected before writing, but a real
      // keychain could easily leave a partial/garbage entry. Both must be
      // restored to their pre-run state.
      expect(await vault.get(inventorySecretKey("src-1", "field1"))).toBe("old1");
      expect(await vault.get(inventorySecretKey("src-1", "field2"))).toBeUndefined();
    });

    it("ITEM 4 — the source record changing (e.g. a configCommands import/reset, which bypasses inFlightSourceIds) before the persist aborts the edit and rolls back this run's vault writes (kills last-writer-wins)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        testConnection: vi.fn(async () => {
          // Simulate a configCommands importMergeReplace/completeReset landing
          // while editSource is still mid-flow — those flows mutate the
          // source directly and never consult inFlightSourceIds.
          await core.addOrUpdateInventorySource(makeSource({ name: "Imported", targetFolder: "Different" }));
        })
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ name: "My Source", targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: [] })
      );

      mockShowInputBox
        .mockResolvedValueOnce("My Source") // name
        .mockResolvedValueOnce("Infra") // targetFolder
        .mockResolvedValueOnce("admin") // defaultUsername
        .mockResolvedValueOnce("netbox.local") // host
        .mockResolvedValueOnce("new-token"); // apiToken (brand new)
      mockShowQuickPick.mockResolvedValueOnce({ value: "orphan" });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("reopen Edit Source"));

      // If ITEM 4 were reverted (persist straight after the store loop, no
      // re-read), this stale `updated` — built from the pick-time record —
      // would have overwritten the imported source, and the imported
      // source's own vault keys would then be at risk from stale-key
      // cleanup. The imported record must survive completely untouched.
      expect(core.getInventorySource("src-1")?.name).toBe("Imported");
      expect(core.getInventorySource("src-1")?.targetFolder).toBe("Different");

      // This run's brand-new vault write must be rolled back too.
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBeUndefined();
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

    it("ITEM 6 — the source record changing while the confirm modal is open aborts with a friendly removal-specific error and leaves nothing partially removed (kills an unhandled rejection / partial removal)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({
        [inventorySecretKey("src-1", "apiToken")]: "tok",
        [passwordSecretKey("owned-1")]: "pw"
      });
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockImplementationOnce(async () => {
        // Simulate a source config race landing while this confirm modal is
        // open (e.g. a replace-mode config import) — the pick-time `source`
        // used as expectedSource below is now stale, so
        // applyInventorySyncPlan's own atomic check throws.
        await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Different", secretFieldIds: ["apiToken"] }));
        return "Delete Servers";
      });

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      // If ITEM 6 were reverted (no try/catch around applyInventorySyncPlan),
      // this call would reject instead of resolving.
      await expect(cmd()).resolves.toBeUndefined();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("try again"));
      // No partial removal: the server, its own secrets, and the source
      // record's secrets/record must all still be present.
      expect(core.getSnapshot().servers).toHaveLength(1);
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      expect(await vault.get(passwordSecretKey("owned-1"))).toBe("pw");
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("tok");
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
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
        [proxyPasswordSecretKey("owned-2")]: "proxy2",
        [inventorySecretKey("src-1", "apiToken")]: "tok"
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
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

    it("ITEM 2 — a server edited from inside a teardown callback survives the apply: the plan is recomputed AFTER teardown, immediately before applyInventorySyncPlan (kills a stale-upsert apply computed before the teardown/vault-check awaits)", async () => {
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
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        // device:1 absent -> prune "delete"; device:2 present with a NEW host -> "update".
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:2", name: "core-sw", endpoints: [{ kind: "ssh", host: "10.0.0.99", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          if (serverId === "owned-1") {
            // Manual edit landing DURING teardown — after the pre-teardown
            // recompute already ran, before the (stale, reverted-behavior)
            // apply would have fired.
            await core.addOrUpdateServer({ ...core.getServer("owned-2")!, logSession: true });
          }
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(teardown.teardownServerRuntime).toHaveBeenCalledWith("owned-1");
      // The pruned server is still gone.
      expect(core.getServer("owned-1")).toBeUndefined();
      // The survivor picked up BOTH the inventory-driven update (new host)
      // AND the edit made during teardown. If ITEM 2 were reverted (apply
      // uses the plan/application computed BEFORE the teardown loop), the
      // edit made inside the teardown callback would be silently reverted by
      // the stale upsert — logSession would be undefined here.
      expect(core.getServer("owned-2")?.host).toBe("10.0.0.99");
      expect(core.getServer("owned-2")?.logSession).toBe(true);
    });

    it("FINDING 2 — the source record itself changing (not just servers) while the modal is open aborts the apply (kills a presence-only re-check)", async () => {
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowInformationMessage.mockImplementationOnce(async () => {
        // Simulate a replace-mode config import racing the sync: same source id,
        // but the record itself now has a different targetFolder — the plan/tree
        // computed under the OLD record must not be applied against this one.
        await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Different" }));
        return "Apply";
      });

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(core.getSnapshot().servers).toHaveLength(0);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("configuration changed"));
      // The source record itself was still updated by the race (targetFolder
      // change went through) — only the stale apply was blocked.
      expect(core.getInventorySource("src-1")?.targetFolder).toBe("Different");
    });

    it("FINDING D — a credential rotation between fetch and apply aborts without applying, even though the source record's other fields are unchanged (kills a config-only/id-only comparison that ignores secret VALUES)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "old-tok" });
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => {
          // Simulate the credential being rotated (e.g. via editSource) while
          // this fetch was in flight — providerId/targetFolder/config/
          // secretFieldIds on the source record itself never change, so the
          // FINDING 2 config-comparison check alone would let this through.
          await vault.store(inventorySecretKey("src-1", "apiToken"), "new-tok");
          return {
            contractVersion: 1,
            devices: [{ externalId: "device:1", name: "new-sw", endpoints: [{ kind: "ssh", host: "10.0.0.5", port: 22 }] }]
          };
        })
      });
      registry.register(provider);
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // If the fix were reverted, the tree fetched under "old-tok" would have
      // been applied as though it came from "new-tok" — the device would have
      // been added.
      expect(core.getSnapshot().servers).toHaveLength(0);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("credentials changed"));
    });

    it("FINDING E — the source record being replaced during the teardown awaits (after the post-modal fast-fail check already passed) still aborts the apply (kills the residual window an outside-core check can't close)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] })) // device gone -> prune "delete"
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      const teardown = {
        teardownServerRuntime: vi.fn(async () => {
          // Simulate a replace-mode config import landing DURING the teardown
          // await — strictly after syncNow's own freshSource/sourceConfigUnchanged
          // fast-fail check already passed. Only a check evaluated atomically
          // with the mutation (inside applyInventorySyncPlan itself) can still
          // catch this.
          await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Different", prunePolicy: "delete" }));
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // If the fix were reverted to an exists-only check in
      // applyInventorySyncPlan, this stale apply (computed against the OLD
      // targetFolder/prunePolicy record) would have gone through and deleted
      // the owned server.
      expect(core.getSnapshot().servers.map((s) => s.id)).toEqual(["owned-1"]);
      expect(teardown.teardownServerRuntime).toHaveBeenCalledTimes(1);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("configuration changed"));
    });

    it("nothing-to-do still bumps lastSyncAt without a confirm modal", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(core.getInventorySource("src-1")?.lastSyncAt).toBeDefined();
      expect(mockShowInformationMessage).toHaveBeenCalled(); // toast, not a modal confirm
    });

    it("ITEM 5 — a rejected applyInventorySyncPlan on the nothing-to-do fast path surfaces a friendly error instead of an unhandled rejection", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      vi.spyOn(core, "applyInventorySyncPlan").mockRejectedValueOnce(new Error("disk full"));

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      // If ITEM 5 were reverted (no try/catch on this path), this call would
      // reject instead of resolving.
      await expect(cmd("src-1")).resolves.toBeUndefined();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Inventory sync failed"));
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
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

    it("FINDING 2 — a provider schema upgrade adding a new required password field aborts the sync even though the stored source's secretFieldIds predates it (kills a check driven by stored secretFieldIds instead of the provider's current schema)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        configFields: [
          { id: "host", label: "Host", type: "string", required: true },
          { id: "apiToken", label: "API Token", type: "password", required: true }
        ]
      });
      registry.register(provider);
      const vault = makeVault(); // apiToken never stored
      registerInventoryCommands(core, registry, vault, makeTeardown());
      // Simulates a source saved BEFORE the provider required apiToken: its stored
      // secretFieldIds does not mention it at all (not even as a stale/skipped id).
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: [] }));

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("apiToken"));
      expect(provider.fetchInventory).not.toHaveBeenCalled();
    });

    it("FINDING 2 — a missing secret for an optional (non-required) password field does not block the sync; the provider runs and receives secrets without that key (kills the guard erroring on any missing secret)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        configFields: [
          { id: "host", label: "Host", type: "string", required: true },
          { id: "apiToken", label: "API Token", type: "password", required: true },
          { id: "extraToken", label: "Extra Token", type: "password", required: false }
        ],
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
      });
      registry.register(provider);
      // Vault only has apiToken — extraToken was never stored, yet secretFieldIds
      // still names it (mirrors data saved before FIX 1, or a since-cleared key).
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken", "extraToken"] }));

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(mockShowErrorMessage).not.toHaveBeenCalled();
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
      const [, passedSecrets] = (provider.fetchInventory as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(passedSecrets).toEqual({ apiToken: "tok" });
      expect(Object.prototype.hasOwnProperty.call(passedSecrets, "extraToken")).toBe(false);
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
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
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
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
