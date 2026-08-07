import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryCommands, type InventoryRuntimeTeardown } from "../../src/commands/inventoryCommands";
import { InventorySourceRemovalMismatchError, NexusCore } from "../../src/core/nexusCore";
import type { ServerConfig } from "../../src/models/config";
import {
  computeProviderFingerprint,
  inventorySecretKey,
  type InventoryProvider,
  type InventorySourceConfig,
  type InventoryTree
} from "../../src/models/inventory";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";
import { ORPHAN_FOLDER_NAME } from "../../src/services/inventory/syncEngine";
import { configMutationLock } from "../../src/services/configMutationLock";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { MAX_FOLDER_DEPTH } from "../../src/utils/folderPaths";
import type { FormDefinition, FormValues } from "../../src/ui/formTypes";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockExecuteCommand = vi.fn();
const mockOpenTextDocument = vi.fn();
const mockShowTextDocument = vi.fn();
const mockWebviewOpen = vi.fn();

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

// Mirrors profileCommands.test.ts's idiom for driving a WebviewFormPanel-based
// command: capture the (formId, definition, options) triple WebviewFormPanel.open
// was called with, and invoke onSubmit/onTest directly rather than going through
// a real webview. The fake panel returned here supports onDidDispose so
// editSource's in-flight-guard release (fired on both successful submit and
// Cancel in the real WebviewFormPanel) can be exercised/verified by tests that
// care about it.
vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: {
    open: (...args: unknown[]) => mockWebviewOpen(...args)
  }
}));

interface FakePanel {
  dispose: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  addSelectOption: ReturnType<typeof vi.fn>;
  fireDispose: () => void;
}

function makeFakePanel(): FakePanel {
  const listeners: Array<() => void> = [];
  return {
    dispose: vi.fn(),
    onDidDispose: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    }),
    addSelectOption: vi.fn(),
    fireDispose: () => {
      for (const listener of listeners) listener();
    }
  };
}

function latestFormCall(): {
  formId: string;
  definition: FormDefinition;
  panel: FakePanel;
  onSubmit: (values: FormValues) => Promise<void>;
  onTest?: (values: FormValues) => Promise<void>;
} {
  const call = mockWebviewOpen.mock.results.at(-1);
  const callArgs = mockWebviewOpen.mock.calls.at(-1);
  expect(callArgs).toBeDefined();
  const handlers = callArgs![2] as {
    onSubmit: (values: FormValues) => Promise<void>;
    onTest?: (values: FormValues) => Promise<void>;
  };
  return {
    formId: callArgs![0] as string,
    definition: callArgs![1] as FormDefinition,
    panel: call!.value as FakePanel,
    onSubmit: handlers.onSubmit,
    onTest: handlers.onTest
  };
}

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
    mockWebviewOpen.mockImplementation(() => makeFakePanel());
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

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd(); // single provider -> promptProviderPick auto-skips the picker and opens the form directly

      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

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

    it("(ITEM A) stamps providerFingerprint from the chosen provider at creation (kills a source created with no fingerprint at all)", async () => {
      const { core, provider } = await runAddSourceHappyPath();

      const source = core.getSnapshot().inventorySources[0];
      expect(source.providerFingerprint).toBe(computeProviderFingerprint(provider));
    });

    it("Save persists the source WITHOUT ever calling provider.testConnection — Test is voluntary and no longer gates Save (kills the old forced-test-before-save / Save Anyway prompt)", async () => {
      const { core, provider } = await runAddSourceHappyPath();

      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      expect(provider.testConnection).not.toHaveBeenCalled();
    });

    it("the Test button invokes provider.testConnection with the form's current field values (including secrets), independent of Save (kills wiring the button to nothing / to the wrong values)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onTest } = latestFormCall();
      expect(onTest).toBeDefined();

      await onTest!({
        name: "My NetBox",
        targetFolder: "",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      expect(provider.testConnection).toHaveBeenCalledWith({ host: "netbox.local" }, { apiToken: "secret-token" });
      // Testing alone must never persist anything.
      expect(core.getSnapshot().inventorySources).toHaveLength(0);
    });

    it("a Test button failure is reported and persists nothing — no Save Anyway gate exists anymore", async () => {
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

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onTest } = latestFormCall();

      await onTest!({
        name: "My NetBox",
        targetFolder: "",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("boom"));
      expect(core.getSnapshot().inventorySources).toHaveLength(0);
    });

    it("field mapping — provider configFields map to the matching form field type: string->text, password->password, number->number, boolean->checkbox", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        configFields: [
          { id: "host", label: "Host", type: "string", required: true },
          { id: "apiToken", label: "API Token", type: "password", required: true },
          { id: "port", label: "Port", type: "number", required: false },
          { id: "verifyTls", label: "Verify TLS", type: "boolean", required: false }
        ]
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { definition } = latestFormCall();

      const byKey = (key: string) => definition.fields.find((f) => "key" in f && f.key === key);
      expect(byKey("cfg_host")).toEqual(expect.objectContaining({ type: "text" }));
      expect(byKey("cfg_apiToken")).toEqual(expect.objectContaining({ type: "password" }));
      expect(byKey("cfg_port")).toEqual(expect.objectContaining({ type: "number" }));
      expect(byKey("cfg_verifyTls")).toEqual(expect.objectContaining({ type: "checkbox" }));
    });

    it("titles the form with the provider label and prefills Default SSH Username with mostCommonUsername", async () => {
      const owned = [
        makeServer({ id: "s1", username: "opsuser" }),
        makeServer({ id: "s2", username: "opsuser" }),
        makeServer({ id: "s3", username: "other" })
      ];
      const core = new NexusCore(new InMemoryConfigRepository(owned));
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({ label: "NetBox" });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { definition } = latestFormCall();

      expect(definition.title).toBe("Add Inventory Source (NetBox)");
      const usernameField = definition.fields.find((f) => "key" in f && f.key === "defaultUsername");
      expect(usernameField).toEqual(expect.objectContaining({ value: "opsuser" }));
    });

    it("required-field validation — a missing required provider field rejects onSubmit and persists nothing (defense-in-depth behind the form's own HTML `required` attribute, kills silently persisting an incomplete source)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My NetBox",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "",
          cfg_apiToken: "secret-token"
        })
      ).rejects.toThrow(/Host is required/);

      expect(core.getSnapshot().inventorySources).toHaveLength(0);
      expect(vault.store).not.toHaveBeenCalled();
    });

    it("top-level target folder — declining the confirmation leaves the source unsaved; confirming with Continue saves it at the top level (kills silently skipping the confirmation)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      const values: FormValues = {
        name: "My NetBox",
        targetFolder: "",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      };

      mockShowWarningMessage.mockResolvedValueOnce(undefined); // declined
      await expect(onSubmit(values)).rejects.toThrow(/Enter a target folder/);
      expect(core.getSnapshot().inventorySources).toHaveLength(0);

      mockShowWarningMessage.mockResolvedValueOnce("Continue");
      await onSubmit(values);
      expect(core.getSnapshot().inventorySources[0].targetFolder).toBe("");
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

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token",
        cfg_extraToken: "" // left blank (optional)
      });

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

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My NetBox",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "secret-token"
        })
      ).rejects.toThrow(/keychain/);

      expect(core.getSnapshot().inventorySources).toHaveLength(0);
    });

    it("FINDING 1 — core.addOrUpdateInventorySource rejecting after secrets were stored rolls back the vault keys just written (kills orphaned inventory-source-* secrets)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      vi.spyOn(core, "addOrUpdateInventorySource").mockRejectedValueOnce(new Error("disk full"));
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My NetBox",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "secret-token"
        })
      ).rejects.toThrow(/was not created/);

      expect(core.getSnapshot().inventorySources).toHaveLength(0);

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

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      // field1's store succeeds (call 1), field2's store rejects (call 2) —
      // provider.configFields order drives the store loop's iteration order.
      await expect(
        onSubmit({
          name: "My NetBox",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_field1: "value1",
          cfg_field2: "value2"
        })
      ).rejects.toThrow(/keychain/);

      expect(core.getSnapshot().inventorySources).toHaveLength(0);

      // If the fix were reverted (catch returns without deleting earlier
      // keys), field1's key would still be present here even though the
      // source was never created.
      const [field1Key] = (vault.store as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(vault.delete).toHaveBeenCalledWith(field1Key);
      expect(backingStore.size).toBe(0);
    });

    it("multiple registered providers show the provider picker first; picking one opens that provider's form", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const providerA = makeProvider({ id: "fake-a", label: "Provider A" });
      const providerB = makeProvider({ id: "fake-b", label: "Provider B" });
      registry.register(providerA);
      registry.register(providerB);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      mockShowQuickPick.mockResolvedValueOnce({ label: providerA.label, provider: providerA });

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();

      expect(mockShowQuickPick).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "Select Inventory Provider" }));
      const { definition } = latestFormCall();
      expect(definition.title).toBe("Add Inventory Source (Provider A)");
    });

    it("F1 — onSubmit resolves as soon as the source is persisted, even when the follow-up toast's thenable never settles (kills the awaited-toast hang that swallows every later Save)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      // Mirrors a real VS Code information toast auto-hiding without the
      // user ever clicking a button: its returned thenable never settles.
      mockShowInformationMessage.mockReturnValueOnce(new Promise(() => {}));

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      const onSubmitPromise = onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      const TIMEOUT = Symbol("timeout");
      const winner = await Promise.race([
        onSubmitPromise.then(() => "resolved" as const),
        new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 50))
      ]);

      // If F1 were reverted (onSubmit awaits the toast directly instead of
      // running it detached), onSubmitPromise would still be pending here —
      // the never-resolving toast keeps it stuck forever, so
      // WebviewFormPanel never disposes the panel and every later Save is
      // swallowed by submitInFlight.
      expect(winner).toBe("resolved");
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
    });

    it("F2 — a provider config field id that collides with a reserved top-level key (\"name\") keeps BOTH values distinct instead of one clobbering the other (kills last-write-wins key collision)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        configFields: [{ id: "name", label: "Instance Name", type: "string", required: true }]
      });
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());

      const cmd = registeredCommands.get("nexus.inventory.addSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await onSubmit({
        name: "My Source", // the SOURCE's own Name field
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_name: "netbox-instance-1" // the PROVIDER field also id'd "name"
      });

      const source = core.getSnapshot().inventorySources[0];
      // If F2 were reverted (both form fields share the raw "name" key), one
      // of these two assertions fails — whichever value was assigned last
      // into the single flat FormValues object wins and the other is either
      // missing or silently overwritten with the wrong value.
      expect(source.name).toBe("My Source");
      expect(source.config).toEqual({ name: "netbox-instance-1" });
    });
  });

  describe("nexus.inventory.editSource", () => {
    it("F7 — a blank secret field keeps the previously saved vault value on Save, AND the Test button hydrates it from the vault before calling testConnection (kills blank overwriting the token)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] }));
      await vault.store(inventorySecretKey("src-1", "apiToken"), "old-token");

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd(); // exactly one source -> pickInventorySource auto-selects it
      const { onSubmit, onTest } = latestFormCall();

      const values: FormValues = {
        name: "My Source",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "" // left blank -> keep saved value
      };

      await onTest!(values);
      expect(provider.testConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ apiToken: "old-token" }));

      await onSubmit(values);
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("old-token");
    });

    it("F3 — a mismatched providerFingerprint shows the same Continue/Cancel gate syncNow uses BEFORE the form opens; Cancel aborts editing with no vault read and no form (kills ungated Test-button secret hydration)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "old-token" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ config: { host: "netbox.local" }, secretFieldIds: ["apiToken"], providerFingerprint: "stale-fingerprint" })
      );

      // Default mock resolution (undefined — no button clicked) counts as
      // Cancel/dismiss, mirroring syncNow's own "choice !== 'Continue'" gate.
      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("looks different from when"),
        expect.objectContaining({ modal: true }),
        "Continue",
        "Cancel"
      );
      // If F3 were reverted (no gate before WebviewFormPanel.open), the form
      // would open unconditionally here regardless of the mismatch.
      expect(mockWebviewOpen).not.toHaveBeenCalled();
      // The Edit form's Test button hydrates kept secrets straight from the
      // vault (F7) — with the gate correctly aborting before the form ever
      // opens, that hydration path never runs and vault.get is never called
      // for this source's credentials.
      expect(vault.get).not.toHaveBeenCalled();
    });

    it("F3 — an unchanged (or never-stamped) providerFingerprint opens the edit form without any confirmation modal", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "old-token" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({
          config: { host: "netbox.local" },
          secretFieldIds: ["apiToken"],
          providerFingerprint: computeProviderFingerprint(provider)
        })
      );

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
      expect(mockWebviewOpen).toHaveBeenCalledTimes(1);
    });

    it("edit form prefill — Name/Target Folder/Default Username/Prune Policy and provider config fields are prefilled from the source; a saved password field is optional with a 'keep' placeholder (kills a blank-slate edit form)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({
          name: "My NetBox",
          targetFolder: "Infra",
          defaultUsername: "opsuser",
          prunePolicy: "delete",
          config: { host: "netbox.local" },
          secretFieldIds: ["apiToken"]
        })
      );

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { definition } = latestFormCall();

      expect(definition.title).toBe("Edit Inventory Source (Fake Provider)");
      const byKey = (key: string) => definition.fields.find((f) => "key" in f && f.key === key);
      expect(byKey("name")).toEqual(expect.objectContaining({ value: "My NetBox" }));
      expect(byKey("targetFolder")).toEqual(expect.objectContaining({ value: "Infra" }));
      expect(byKey("defaultUsername")).toEqual(expect.objectContaining({ value: "opsuser" }));
      expect(byKey("prunePolicy")).toEqual(expect.objectContaining({ value: "delete" }));
      expect(byKey("cfg_host")).toEqual(expect.objectContaining({ type: "text", value: "netbox.local" }));
      expect(byKey("cfg_apiToken")).toEqual(
        expect.objectContaining({ type: "password", required: false, placeholder: "Leave empty to keep the saved value" })
      );
    });

    it("(ITEM A) restamps providerFingerprint on every save, even when it was already stamped differently (kills a save that leaves a stale fingerprint in place)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ config: { host: "netbox.local" }, secretFieldIds: ["apiToken"], providerFingerprint: "stale-fingerprint" })
      );
      await vault.store(inventorySecretKey("src-1", "apiToken"), "old-token");

      // F3 — a stale fingerprint now gates the form open itself; Continue
      // through that confirmation to reach the form and exercise Save's own
      // unconditional restamp (this test's actual subject).
      mockShowWarningMessage.mockResolvedValueOnce("Continue");
      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      const updated = core.getInventorySource("src-1")!;
      expect(updated.providerFingerprint).toBe(computeProviderFingerprint(provider));
      expect(updated.providerFingerprint).not.toBe("stale-fingerprint");
    });

    it("in-flight guard — editSource marks the source busy while the form is open and releases it when the form closes, whether by Save or Cancel (kills leaking the busy flag / never marking it busy at all)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { panel } = latestFormCall();
      expect(mockWebviewOpen).toHaveBeenCalledTimes(1);

      // A second edit attempt while the first form is still open must refuse
      // — the wrong implementation (no busy flag while the form is open)
      // would open a second form here instead.
      await cmd();
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("currently syncing"));
      expect(mockWebviewOpen).toHaveBeenCalledTimes(1);

      // Closing the form (Cancel, or WebviewFormPanel's own post-submit
      // dispose) releases the guard — the wrong implementation (no
      // onDidDispose release wiring) would still refuse here.
      panel.fireDispose();
      mockShowWarningMessage.mockClear();
      await cmd();
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining("currently syncing"));
      expect(mockWebviewOpen).toHaveBeenCalledTimes(2);
    });

    it("F6 — WebviewFormPanel.open throwing surfaces the error but does not leave the source stuck busy (kills a busy-flag leak on open() failure)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockWebviewOpen.mockImplementationOnce(() => {
        throw new Error("webview init failed");
      });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await expect(cmd()).rejects.toThrow(/webview init failed/);

      // If F6 were reverted (no try/catch around WebviewFormPanel.open), the
      // busy flag set just before the throwing call would never be released
      // — every later editSource for this exact source id would be refused
      // with "currently syncing" forever.
      await cmd();
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining("currently syncing"));
      expect(mockWebviewOpen).toHaveBeenCalledTimes(2);
    });

    it("required-field validation — a missing required field rejects onSubmit and persists nothing", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] }));
      await vault.store(inventorySecretKey("src-1", "apiToken"), "old-token");

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          defaultUsername: "", // blank
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: ""
        })
      ).rejects.toThrow(/Default SSH Username is required/);

      expect(core.getInventorySource("src-1")?.defaultUsername).toBe("admin");
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

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "" // left blank -> keep saved value
      });

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

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "", // left blank -> keep saved value
          cfg_extraToken: "new-extra" // brand-new secret this run
        })
      ).rejects.toThrow(/was not applied/);

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

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "new-tok" // RE-ENTERED — overwrites the old value
        })
      ).rejects.toThrow(/was not applied/);

      // If the fix were reverted (rollback only deletes newly-ADDED keys),
      // apiToken — which already existed before this edit — would be left at
      // "new-tok" even though the source record itself reverted to old.
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("old-tok");
    });

    it("FINDING 1 (P2, rollback-classification review) — a field declared in secretFieldIds but ACTUALLY ABSENT from the vault (declared-but-absent) is classified as newly-written by actual vault state, so a persist rejection deletes the re-entered value instead of leaving it stuck (kills declared-means-existing classification)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider(); // host (string) + apiToken (password, required)
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      // secretFieldIds DECLARES apiToken as existing, but the vault key was
      // never actually stored — e.g. after a restore that warned about a
      // missing credential. This is the "declared-but-absent" case.
      await core.addOrUpdateInventorySource(
        makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] })
      );
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBeUndefined();

      vi.spyOn(core, "addOrUpdateInventorySource").mockRejectedValueOnce(new Error("disk full"));

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "new-tok" // re-entered — vault had nothing to overwrite
        })
      ).rejects.toThrow(/was not applied/);

      // If the fix were reverted (classification by secretFieldIds
      // membership instead of actual vault.get result), apiToken would be
      // classified "existing" — captured nothing to restore (correct) AND
      // never pushed to newlyWrittenFieldIds (incorrect) — so the freshly
      // stored "new-tok" would survive the rollback undeleted. The fix must
      // delete it, restoring the true pre-edit absence.
      expect(vault.delete).toHaveBeenCalledWith(inventorySecretKey("src-1", "apiToken"));
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBeUndefined();
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

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      // field1 (existing) re-entered -> store call 1, succeeds; field2 (new) -> store call 2, rejects.
      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_field1: "new1",
          cfg_field2: "new2"
        })
      ).rejects.toThrow(/keychain/);

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

    it("ITEM 4 — the source record changing (e.g. a configCommands import/reset, which bypasses inFlightSourceIds) before Save is clicked aborts the edit and rolls back this run's vault writes (kills last-writer-wins)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ name: "My Source", targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: [] })
      );

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onSubmit } = latestFormCall();

      // Simulate a configCommands importMergeReplace/completeReset landing
      // while the edit form is still open — those flows mutate the source
      // directly and never consult inFlightSourceIds. Unlike the old wizard
      // (where this could only land during testConnection's forced await),
      // the form can sit open indefinitely, so this window is now the whole
      // time between opening the form and the user clicking Save.
      await core.addOrUpdateInventorySource(makeSource({ name: "Imported", targetFolder: "Different" }));

      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "new-token" // brand new
        })
      ).rejects.toThrow(/reopen Edit Source/);

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

    it("(FINDING 3 / FINDING 4 / FINDING 5) Delete Servers: a taken-over server (same id, same origin.sourceId, but its content changed underneath the removal) SURVIVES the disposition, is counted as skipped, keeps its vault secrets, and is never handed to teardown — while a genuinely-owned server is still fully removed (kills stale-list cleanup, sourceId-only delete validation, and teardown-before-validation)", async () => {
      const removed = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const takenOver = makeServer({
        id: "owned-2",
        name: "core-sw",
        host: "10.0.0.2",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([removed, takenOver]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({
        [inventorySecretKey("src-1", "apiToken")]: "tok",
        [passwordSecretKey("owned-1")]: "pw1",
        [passphraseSecretKey("owned-1")]: "pp1",
        [proxyPasswordSecretKey("owned-1")]: "proxy1",
        [passwordSecretKey("owned-2")]: "pw2",
        [passphraseSecretKey("owned-2")]: "pp2",
        [proxyPasswordSecretKey("owned-2")]: "proxy2"
      });
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      // A concurrent import lands while the confirm modal is open: it
      // re-maps "owned-2" to a DIFFERENT device (still owned by src-1 — the
      // ownership-only check a reverted FINDING 4 would rely on stays
      // satisfied) between the pre-modal `owned` snapshot and the
      // disposition apply below.
      mockShowWarningMessage.mockImplementationOnce(async () => {
        await core.addOrUpdateServer({ ...takenOver, host: "10.0.0.99" });
        return "Delete Servers";
      });

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await cmd();

      // FINDING 4 — the taken-over server survives with its NEW content;
      // the stale delete entry for it was skipped, not honored.
      const survivor = core.getServer("owned-2");
      expect(survivor).toBeDefined();
      expect(survivor?.host).toBe("10.0.0.99");
      expect(survivor?.origin?.sourceId).toBe("src-1");

      // The genuinely-owned server is still fully removed.
      expect(core.getServer("owned-1")).toBeUndefined();
      expect(core.getSnapshot().inventorySources).toHaveLength(0);

      // FINDING 5 — teardown was invoked ONLY for the id actually removed;
      // if the old teardown-before-apply ordering were still in effect, this
      // would include "owned-2" even though it survives.
      expect(teardown.calls).toEqual(["owned-1"]);

      // FINDING 3 — vault cleanup was limited to the id actually removed;
      // the survivor's own password/passphrase/proxy secrets must still be
      // exactly what they were.
      expect(await vault.get(passwordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passphraseSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passwordSecretKey("owned-2"))).toBe("pw2");
      expect(await vault.get(passphraseSecretKey("owned-2"))).toBe("pp2");
      expect(await vault.get(proxyPasswordSecretKey("owned-2"))).toBe("proxy2");

      // The skip is surfaced to the user rather than silently dropped.
      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/1 server.*changed during removal/i));
    });

    it("(FINDING 2, review) Delete Servers: a server re-created (e.g. by nexus.server.edit, which never takes configMutationLock) while the post-apply teardown/cleanup loop is still running keeps its vault credentials — the cleanup loop must recheck server absence per id, not just trust the apply's removedServerIds list (kills unconditional post-apply secret deletion)", async () => {
      const first = makeServer({
        id: "owned-1",
        name: "old-sw-1",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const second = makeServer({
        id: "owned-2",
        name: "old-sw-2",
        host: "10.0.0.2",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([first, second]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({
        [inventorySecretKey("src-1", "apiToken")]: "tok",
        [passwordSecretKey("owned-1")]: "pw1",
        [passphraseSecretKey("owned-1")]: "pp1",
        [proxyPasswordSecretKey("owned-1")]: "proxy1",
        [passwordSecretKey("owned-2")]: "pw2",
        [passphraseSecretKey("owned-2")]: "pp2",
        [proxyPasswordSecretKey("owned-2")]: "proxy2"
      });
      const teardown = {
        // Simulate the race the finding describes: an unlocked
        // nexus.server.edit re-adds "owned-2" (upsert semantics) during the
        // window applyInventorySyncPlan's disposition is still settling —
        // teardownServerRuntime runs for every id in removedServerIds AFTER
        // the apply already resolved, so hooking it here lands the re-add
        // squarely inside that window, before the secret-cleanup loop below
        // reaches "owned-2".
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          if (serverId === "owned-1") {
            await core.addOrUpdateServer({ ...second, name: "core-sw-2 (recreated)" });
          }
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Delete Servers");

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await cmd();

      // "owned-2" is back (re-created mid-flow) — its credentials must
      // survive; a reverted fix would delete them here unconditionally
      // because applyInventorySyncPlan's removedServerIds still lists it.
      expect(core.getServer("owned-2")).toBeDefined();
      expect(await vault.get(passwordSecretKey("owned-2"))).toBe("pw2");
      expect(await vault.get(passphraseSecretKey("owned-2"))).toBe("pp2");
      expect(await vault.get(proxyPasswordSecretKey("owned-2"))).toBe("proxy2");

      // "owned-1" was never re-created — it's genuinely gone, credentials included.
      expect(core.getServer("owned-1")).toBeUndefined();
      expect(await vault.get(passwordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passphraseSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBeUndefined();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringMatching(/1 re-created server.*kept.*credentials/i)
      );
    });

    it("(round 22 finding) Delete Servers: a server re-added (e.g. by nexus.server.edit, which never takes configMutationLock) right as applyInventorySyncPlan resolves is skipped by the post-apply teardown loop, but teardown still runs for the other removed id (kills an unconditional post-apply teardown sweep that would kill the recreated server's live terminals/tunnels/pool)", async () => {
      const first = makeServer({
        id: "owned-1",
        name: "old-sw-1",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const second = makeServer({
        id: "owned-2",
        name: "old-sw-2",
        host: "10.0.0.2",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([first, second]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });

      // Simulate the race the finding describes: nexus.server.edit re-adds
      // "owned-1" (upsert semantics, no configMutationLock) in the window
      // right after applyInventorySyncPlan's disposition commits, before the
      // post-apply teardown loop's iteration for it runs.
      const originalApply = core.applyInventorySyncPlan.bind(core);
      vi.spyOn(core, "applyInventorySyncPlan").mockImplementation(async (application) => {
        const result = await originalApply(application);
        await core.addOrUpdateServer({ ...first, name: "old-sw-1 (recreated)" });
        return result;
      });

      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Delete Servers");

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await cmd();

      // "owned-1" is back (re-created right as the apply resolved) — the
      // teardown loop must re-check core.getServer("owned-1") and skip it
      // because it's live again. "owned-2" was never recreated, so teardown
      // still runs for it. If the fix were reverted to an unconditional
      // teardown sweep over removedServerIds, "owned-1" would appear here
      // too, killing the recreated server's live terminals/tunnels/pool.
      expect(teardown.calls).toEqual(["owned-2"]);

      expect(core.getServer("owned-1")).toBeDefined();
      expect(core.getServer("owned-2")).toBeUndefined();

      // The recreated id is counted once in the closing report, sharing the
      // same "re-created server(s)" tally the credential-cleanup loop uses.
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringMatching(/1 re-created server.*kept.*credentials/i)
      );
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

    it("(REVIEW FINDING 3, updated for the REORDER) a rejected removeInventorySource restores the source record AND the vault credentials that were deleted before the record removal was attempted — and, since disposition now runs AFTER record removal, the owned server is never touched either (kills restore-record-without-credentials; keeps the round-10 spirit that a failed removal leaves a fully-functional source)", async () => {
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

      // REORDER — record removal now happens BEFORE server disposition, so
      // it's the FIRST saveInventorySources call (there is no earlier
      // applyInventorySyncPlan call to consume call #1 anymore). Rejecting
      // it makes core.removeInventorySource itself reject (core rolls the
      // record back in memory; see NexusCore.removeInventorySource) — and
      // the "Keep Servers" disposition apply that would have been call #2
      // must never even be attempted.
      const originalSaveInventorySources = repo.saveInventorySources.bind(repo);
      let saveInventorySourcesCallCount = 0;
      vi.spyOn(repo, "saveInventorySources").mockImplementation(async (sources) => {
        saveInventorySourcesCallCount++;
        if (saveInventorySourcesCallCount === 1) {
          throw new Error("disk full");
        }
        return originalSaveInventorySources(sources);
      });

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await expect(cmd()).resolves.toBeUndefined();

      // If FINDING 3's fix were reverted (vault keys deleted and never
      // restored), the source record would still come back via core's own
      // rollback here — but its credentials would be gone forever, leaving a
      // live source that can never sync again.
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("tok");
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("intact"));
      expect(mockShowInformationMessage).not.toHaveBeenCalled();

      // REORDER (kills disposition-before-removal ordering) — if the old
      // phase order were still in effect, "Keep Servers" disposition would
      // have run FIRST and already stripped the server's origin before the
      // (still-failing) record removal was even attempted. Under the fixed
      // order, disposition never runs at all here.
      expect(saveInventorySourcesCallCount).toBe(1);
      expect(core.getServer("owned-1")?.origin?.sourceId).toBe("src-1");
      expect(teardown.calls).toEqual([]);
    });

    it("(FINDING 2) a mid-loop vault.delete rejection for a multi-secret source restores every captured value, leaves the record present, and leaves owned servers untouched (kills a partial-credential exit — the delete loop must be one guarded unit)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(
        makeProvider({
          configFields: [
            { id: "host", label: "Host", type: "string", required: true },
            { id: "field1", label: "Field 1", type: "password", required: true },
            { id: "field2", label: "Field 2", type: "password", required: true }
          ]
        })
      );
      const backingStore = new Map<string, string>([
        [inventorySecretKey("src-1", "field1"), "tok1"],
        [inventorySecretKey("src-1", "field2"), "tok2"]
      ]);
      let deleteCallCount = 0;
      const vault = {
        get: vi.fn(async (key: string) => backingStore.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          backingStore.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          deleteCallCount++;
          if (deleteCallCount === 2) {
            // Second secret's delete rejects — field1's key was already
            // removed by the first (successful) call in this same loop.
            throw new Error("keychain unavailable");
          }
          backingStore.delete(key);
        })
      };
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["field1", "field2"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Delete Servers");

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await expect(cmd()).resolves.toBeUndefined();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Could not remove source credentials"));
      expect(mockShowInformationMessage).not.toHaveBeenCalled();

      // If FINDING 2's fix were reverted (the loop runs unguarded, or the
      // catch doesn't restore ALL captured values), field1's key — deleted
      // successfully before field2's rejection — would be permanently gone
      // even though the source and its record are still fully live here.
      expect(backingStore.get(inventorySecretKey("src-1", "field1"))).toBe("tok1");
      expect(backingStore.get(inventorySecretKey("src-1", "field2"))).toBe("tok2");

      // The record removal step must never even have been attempted.
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      expect(core.getInventorySource("src-1")?.secretFieldIds).toEqual(["field1", "field2"]);

      // Server disposition (teardown + applyInventorySyncPlan) must never
      // have been attempted either — the server is untouched.
      expect(teardown.calls).toEqual([]);
      expect(core.getSnapshot().servers).toHaveLength(1);
      expect(core.getServer("owned-1")?.origin?.sourceId).toBe("src-1");
    });

    it("(FINDING 1 / REORDER) a rejected removeInventorySource leaves owned servers completely untouched — still present, still owning their origin, teardown never invoked (kills disposition-before-removal ordering, where a failed record removal used to leave a live source that could no longer manage anything)", async () => {
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

      vi.spyOn(core, "removeInventorySource").mockRejectedValueOnce(new Error("disk full"));

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await expect(cmd()).resolves.toBeUndefined();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("intact"));
      expect(mockShowInformationMessage).not.toHaveBeenCalled();

      // Credentials restored (round-10 spirit: a failed removal leaves a
      // fully-functional source).
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("tok");

      // FINDING 1 — the actual kill assertion: under the OLD phase order,
      // "Delete Servers" disposition (teardown + applyInventorySyncPlan
      // removeServerIds) ran BEFORE removeInventorySource, so by the time
      // removeInventorySource rejected here, "owned-1" and its secrets would
      // already have been deleted for good — leaving a live, restored source
      // that owns nothing. Under the fixed order, disposition is never even
      // attempted once record removal has failed.
      expect(teardown.calls).toEqual([]);
      expect(core.getSnapshot().servers).toHaveLength(1);
      expect(core.getServer("owned-1")?.origin?.sourceId).toBe("src-1");
      expect(await vault.get(passwordSecretKey("owned-1"))).toBe("pw");
      expect(await vault.get(passphraseSecretKey("owned-1"))).toBe("pp");
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBe("proxpw");
    });

    it("(FINDING 1 / FINDING 2) a replace-mode import recreating the source id DURING the awaited vault deletes aborts removeInventorySource — the replacement record survives, its (deleted) credential slot is NOT restored to the old value, and disposition never runs (kills an unconditional delete of the replacement record, and kills a stale-secret restore over a replacement)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());

      const backingStore = new Map<string, string>([[inventorySecretKey("src-1", "apiToken"), "tok"]]);
      const vault = {
        get: vi.fn(async (key: string) => backingStore.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          backingStore.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          backingStore.delete(key);
          if (key === inventorySecretKey("src-1", "apiToken")) {
            // A replace-mode import recreates the SAME source id — with a
            // different targetFolder — while this delete is still in flight,
            // i.e. exactly the window between removeSource's own vault
            // deletes and its later removeInventorySource call.
            await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Different", secretFieldIds: ["apiToken"] }));
          }
        })
      };
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await expect(cmd()).resolves.toBeUndefined();

      // If FINDING 1's fix were reverted (removeInventorySource deletes
      // unconditionally, ignoring the pick-time `expected`), the
      // REPLACEMENT record ("Different") would be gone here instead of
      // surviving — the bug this test exists to kill.
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      expect(core.getInventorySource("src-1")?.targetFolder).toBe("Different");

      // FINDING 2 — captured secrets (read from the OLD, now-dead
      // incarnation) are NOT restored: inventorySecretKey is keyed by
      // sourceId+fieldId only, so writing the old "tok" value back into this
      // same vault key would land on whatever the REPLACEMENT record (which
      // declares this exact field id in its own secretFieldIds) actually
      // owns there. The key is left exactly as the delete loop left it —
      // deleted — rather than resurrecting a dead incarnation's value.
      expect(backingStore.get(inventorySecretKey("src-1", "apiToken"))).toBeUndefined();
      expect(vault.store).not.toHaveBeenCalled();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/changed while removing.*preserved/i));
      expect(mockShowInformationMessage).not.toHaveBeenCalled();

      // Disposition never runs — the owned server (still pointing at the
      // now-stale pick-time source) is completely untouched.
      expect(teardown.calls).toEqual([]);
      expect(core.getServer("owned-1")?.origin?.sourceId).toBe("src-1");
    });

    it("(FINDING 2) an InventorySourceRemovalMismatchError at record removal never restores the OLD captured secret — a replacement's freshly-imported credential written under the same field id must survive untouched (kills stale-secret restore over a replacement)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      // The OLD (about-to-be-removed) incarnation's credential — this is
      // what removeSource's capturedSecrets step reads before the delete
      // loop runs.
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      // Simulate a replace-mode import discovering the mismatch: exactly
      // when core.removeInventorySource is invoked, the replacement writes
      // its OWN fresh credential into the SAME vault key (inventorySecretKey
      // is keyed by sourceId+fieldId only, not by revision — both
      // incarnations share it) and the identity check then throws.
      vi.spyOn(core, "removeInventorySource").mockImplementationOnce(async () => {
        await vault.store(inventorySecretKey("src-1", "apiToken"), "replacements-fresh-token");
        throw new InventorySourceRemovalMismatchError("src-1");
      });

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await expect(cmd()).resolves.toBeUndefined();

      // If FINDING 2's fix were reverted (restore runs unconditionally on
      // ANY removeInventorySource rejection, mismatch included), the catch
      // block would write the OLD captured value ("tok") back into
      // inventory-source-src-1-apiToken — clobbering the replacement's fresh
      // token that was just written above.
      expect(vault.store).not.toHaveBeenCalledWith(inventorySecretKey("src-1", "apiToken"), "tok");
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("replacements-fresh-token");
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/changed while removing.*preserved/i));
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
      expect(teardown.calls).toEqual([]);
    });

    it("(FINDING 3) a mid-loop vault.delete rejection whose credential restore ALSO fails reports the credentials as un-restorable, not 'nothing was changed' (kills a false-coherence claim)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(
        makeProvider({
          configFields: [
            { id: "host", label: "Host", type: "string", required: true },
            { id: "field1", label: "Field 1", type: "password", required: true },
            { id: "field2", label: "Field 2", type: "password", required: true }
          ]
        })
      );
      const backingStore = new Map<string, string>([
        [inventorySecretKey("src-1", "field1"), "tok1"],
        [inventorySecretKey("src-1", "field2"), "tok2"]
      ]);
      let deleteCallCount = 0;
      const vault = {
        get: vi.fn(async (key: string) => backingStore.get(key)),
        store: vi.fn(async () => {
          throw new Error("keychain locked");
        }),
        delete: vi.fn(async (key: string) => {
          deleteCallCount++;
          if (deleteCallCount === 2) {
            throw new Error("keychain unavailable");
          }
          backingStore.delete(key);
        })
      };
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["field1", "field2"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Delete Servers");

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await expect(cmd()).resolves.toBeUndefined();

      // If FINDING 3's fix were reverted (restore rejections swallowed by
      // `.catch(() => undefined)`), this would still claim "nothing was
      // changed" even though field1's restore (vault.store) also failed —
      // its credential is actually gone.
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/could not be restored.*re-enter.*Edit Source/i));
      expect(mockShowErrorMessage).not.toHaveBeenCalledWith(expect.stringContaining("nothing was changed"));
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    it("(FINDING 3) a failed record removal whose credential restore ALSO fails reports the credentials as un-restorable, not that the source is 'intact' (kills a false-coherence claim on the record-removal path)", async () => {
      const owned = makeServer({ origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 } });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const backingStore = new Map<string, string>([[inventorySecretKey("src-1", "apiToken"), "tok"]]);
      const vault = {
        get: vi.fn(async (key: string) => backingStore.get(key)),
        store: vi.fn(async () => {
          throw new Error("keychain locked");
        }),
        delete: vi.fn(async (key: string) => {
          backingStore.delete(key);
        })
      };
      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

      mockShowWarningMessage.mockResolvedValueOnce("Delete Servers");
      vi.spyOn(core, "removeInventorySource").mockRejectedValueOnce(new Error("disk full"));

      const cmd = registeredCommands.get("nexus.inventory.removeSource")!;
      await expect(cmd()).resolves.toBeUndefined();

      // If FINDING 3's fix were reverted, this would still claim the source
      // "is intact" even though the credential restore above also failed —
      // the vault key is actually gone, not "with its credentials" as claimed.
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/could not be restored.*re-enter.*Edit Source/i));
      expect(mockShowErrorMessage).not.toHaveBeenCalledWith(expect.stringContaining("intact"));
      expect(backingStore.get(inventorySecretKey("src-1", "apiToken"))).toBeUndefined();
      expect(teardown.calls).toEqual([]);
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

  describe("nexus.inventory.syncNow — provider trust fingerprint (ITEM A)", () => {
    it("a changed fingerprint shows a MODAL warning naming the provider and the source, and Cancel aborts BEFORE any vault.get for this source (kills silent secret handover to a re-registered provider)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ name: "My Source", secretFieldIds: ["apiToken"], providerFingerprint: "stale-fingerprint" })
      );

      mockShowWarningMessage.mockResolvedValueOnce(undefined); // dismiss/Cancel

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Provider "fake" looks different from when "My Source" was configured'),
        { modal: true },
        "Continue",
        "Cancel"
      );
      // The kill test: without the fix, the required-secret check (or the
      // secrets-loading loop) below would call vault.get regardless of the
      // modal's outcome — silently handing the mismatched provider the
      // source's saved credentials. Cancel must prevent every one of them.
      expect(vault.get).not.toHaveBeenCalled();
      expect(provider.fetchInventory).not.toHaveBeenCalled();
      // Nothing was restamped either — the source is untouched.
      expect(core.getInventorySource("src-1")?.providerFingerprint).toBe("stale-fingerprint");
    });

    it("Continue proceeds with the sync AND restamps the fingerprint — the NEXT sync no longer shows the modal", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ name: "My Source", secretFieldIds: ["apiToken"], providerFingerprint: "stale-fingerprint" })
      );

      mockShowWarningMessage.mockResolvedValueOnce("Continue");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // The sync actually proceeded — secrets were read and the provider was called.
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
      expect(vault.get).toHaveBeenCalledWith(inventorySecretKey("src-1", "apiToken"));
      // And the fingerprint is now current.
      expect(core.getInventorySource("src-1")?.providerFingerprint).toBe(computeProviderFingerprint(provider));

      // Second sync: no modal this time, since the stamped fingerprint now matches.
      mockShowWarningMessage.mockClear();
      await cmd("src-1");
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("a fingerprint that already matches the current provider shows no modal", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ secretFieldIds: ["apiToken"], providerFingerprint: computeProviderFingerprint(provider) })
      );

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
    });

    it("a legacy source with NO stamped fingerprint shows no modal and is stamped silently after its first successful sync", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      // No providerFingerprint at all — as a source saved before ITEM A existed would be.
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));
      expect(core.getInventorySource("src-1")?.providerFingerprint).toBeUndefined();

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
      expect(core.getInventorySource("src-1")?.providerFingerprint).toBe(computeProviderFingerprint(provider));
    });

    it("F5 — a source replaced (different targetFolder) in the gap between the sync committing and the best-effort restamp's own separate lock is left unstamped (kills stamping whoever currently holds the id)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      // No providerFingerprint stamped yet -> this sync silently attempts to
      // stamp one afterward, with no confirm modal in the way.
      await core.addOrUpdateInventorySource(makeSource({ name: "My Source", secretFieldIds: ["apiToken"] }));

      // The empty-plan fast path takes exactly two configMutationLock
      // acquisitions: (1) the sync's own apply, (2) the restamp's own
      // separate acquisition. Inject the "concurrent edit" replacement right
      // as the SECOND acquisition starts — after the sync has fully
      // committed, before restamp's own read of "current".
      let runExclusiveCallCount = 0;
      const originalRunExclusive = configMutationLock.runExclusive.bind(configMutationLock);
      const runExclusiveSpy = vi.spyOn(configMutationLock, "runExclusive").mockImplementation(async (fn: () => Promise<unknown>) => {
        runExclusiveCallCount++;
        if (runExclusiveCallCount === 2) {
          await core.addOrUpdateInventorySource({ ...core.getInventorySource("src-1")!, targetFolder: "Different" });
        }
        return originalRunExclusive(fn as () => Promise<unknown>);
      });

      try {
        const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
        await cmd("src-1");
      } finally {
        runExclusiveSpy.mockRestore();
      }

      const current = core.getInventorySource("src-1")!;
      expect(current.targetFolder).toBe("Different"); // the replacement survived, untouched by the sync
      // If F5 were reverted (restamp stamps whatever record currently holds
      // the id, with no drift check against the incarnation the sync
      // actually ran against), providerFingerprint would be set here despite
      // the record having been replaced mid-flow.
      expect(current.providerFingerprint).toBeUndefined();
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

      // FINDING 1 (P2, reconnect-during-prune review) — teardown now runs for
      // "owned-1" TWICE: once in the pre-apply loop (as before) and once more
      // in the post-apply second pass (see that finding's dedicated test
      // below for the reconnect scenario this second pass exists to catch).
      expect(teardown.teardownServerRuntime).toHaveBeenCalledTimes(2);
      expect(teardown.teardownServerRuntime).toHaveBeenCalledWith("owned-1", expect.any(Function));
      expect(callOrder).toEqual(["teardown:owned-1", "apply", "teardown:owned-1"]);

      const snapshot = core.getSnapshot();
      expect(snapshot.servers.map((s) => s.id)).toEqual(["owned-2"]);

      expect(await vault.get(passwordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passphraseSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passwordSecretKey("owned-2"))).toBe("pw2");
      expect(await vault.get(passphraseSecretKey("owned-2"))).toBe("pp2");
      expect(await vault.get(proxyPasswordSecretKey("owned-2"))).toBe("proxy2");
    });

    it("(ITEM B) a rack rename that empties its old folder appends the empty-folder count to the completion toast", async () => {
      const owned = makeServer({
        id: "owned-1",
        name: "sw1",
        host: "10.0.0.1",
        group: "Infra/RackA",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      // Seed NexusCore's explicit-groups list directly (the 4th constructor
      // arg), exactly as a prior real sync would have left it — the server's
      // own `.group` alone does not register an explicit folder.
      const repo = new InMemoryConfigRepository([owned], [], [], ["Infra", "Infra/RackA"]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        // Same device, renamed rack -> "RackB" this time.
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:1", name: "sw1", folderPath: "RackB", endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", prunePolicy: "orphan" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      expect(core.getServer("owned-1")?.group).toBe("Infra/RackB");
      expect(core.getSnapshot().explicitGroups).not.toContain("Infra/RackA");
      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining("1 empty folder removed."));
    });

    it("ROUND 24 FIX (P1, pre-apply-shouldAbort review) — the pre-apply sweep disconnects the pooled SSH connection for a delete candidate, not just its terminals/tunnels (kills the always-true `() => core.getServer(id) !== undefined` predicate: pre-apply, every removal candidate still exists in core by construction, so that predicate is unconditionally true and would silently make teardownServerRuntime skip sshPool.disconnect on every pre-apply call)", async () => {
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([pruned]);
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
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] })) // device gone -> prune "delete"
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });

      // Realistic stand-in for the real teardownServerRuntime (see
      // serverCommands.ts): honors the exact `shouldAbort` contract that
      // function documents — its final step, disconnecting the pooled SSH
      // connection, is skipped iff `shouldAbort()` returns true. That's the
      // one piece of the real function's behavior the bug in
      // inventoryCommands.ts's pre-apply call site actually breaks; the
      // plain `vi.fn` stand-ins used elsewhere in this file swallow the
      // `shouldAbort` argument entirely and can't observe it.
      const disconnectCalls: string[] = [];
      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string, shouldAbort?: () => boolean) => {
          callOrder.push(`teardown:${serverId}`);
          if (shouldAbort?.()) return;
          disconnectCalls.push(serverId);
          callOrder.push(`disconnect:${serverId}`);
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // The pre-apply sweep's teardown call for "owned-1" must disconnect the
      // pooled connection BEFORE applyInventorySyncPlan ever runs. Against
      // the reverted (buggy) call site —
      // `teardown.teardownServerRuntime(id, () => core.getServer(id) !== undefined)`
      // — "owned-1" is still present in core at the moment the pre-apply
      // sweep runs (the apply hasn't happened yet), so that predicate is
      // unconditionally true there and the disconnect never fires from this
      // sweep — only later, from the post-apply sweep, once the record is
      // actually gone. That failure mode is exactly what this assertion
      // catches: the first "disconnect:owned-1" would land AFTER "apply" in
      // callOrder instead of before it.
      expect(disconnectCalls).toContain("owned-1");
      const firstDisconnectIndex = callOrder.indexOf("disconnect:owned-1");
      const applyIndex = callOrder.indexOf("apply");
      expect(firstDisconnectIndex).toBeGreaterThanOrEqual(0);
      expect(firstDisconnectIndex).toBeLessThan(applyIndex);
    });

    it("FINDING 1 (P2, reconnect-during-prune review) — a reconnect landing in the window between the pre-apply teardown and the apply gets caught by a second best-effort teardown pass run AFTER the apply resolves, over the ids the apply actually removed (kills a single-pass teardown that lets such a reconnect survive the delete-prune)", async () => {
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([pruned]);
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
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] })) // device gone -> prune "delete"
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });

      // Simulate the race the finding describes: nexus.server.connect
      // deliberately doesn't take configMutationLock, so a reconnect can land
      // in the awaited window between the pre-apply teardown call for
      // "owned-1" and applyInventorySyncPlan actually deleting its record —
      // registering a fresh session as if a new terminal had just been
      // opened against the about-to-be-deleted server. Hooked on the FIRST
      // teardown call only, so it fires before "apply", not on the (later)
      // second pass.
      let reconnectSimulated = false;
      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          callOrder.push(`teardown:${serverId}`);
          if (serverId === "owned-1" && !reconnectSimulated) {
            reconnectSimulated = true;
            core.registerSession({ id: "sess-reconnect", serverId: "owned-1", terminalName: "Nexus (SSH): old-sw", startedAt: Date.now() });
          }
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // Spy call ordering proves teardown ran for "owned-1" BEFORE apply (the
      // pre-existing pass) and AGAIN AFTER apply resolved (the new second
      // pass this finding adds) — catching the reconnect that landed in
      // between. If the fix were reverted to a single pre-apply pass, this
      // would be ["teardown:owned-1", "apply"] and the length-2 assertion
      // below would fail.
      expect(callOrder).toEqual(["teardown:owned-1", "apply", "teardown:owned-1"]);
      expect(teardown.teardownServerRuntime).toHaveBeenCalledTimes(2);
      expect(core.getServer("owned-1")).toBeUndefined();
    });

    it("FINDING 1 (P2, second-sweep-abort review) — a server re-added (e.g. by nexus.server.edit, which never takes configMutationLock) while applyInventorySyncPlan's saves are still settling is skipped by the post-apply teardown sweep, but teardown still runs for another removed id (kills an unconditional post-apply sweep that would kill the recreated server's live terminals/tunnels/pool)", async () => {
      const prunedA = makeServer({
        id: "owned-1",
        name: "sw-a",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const prunedB = makeServer({
        id: "owned-2",
        name: "sw-b",
        host: "10.0.0.2",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([prunedA, prunedB]);
      const core = new NexusCore(repo);
      await core.initialize();

      // Simulate the race the finding describes: nexus.server.edit re-adds
      // "owned-1" (upsert semantics, no configMutationLock) right as
      // applyInventorySyncPlan's own saves settle — after the pre-apply
      // teardown loop already ran for it, before the post-apply second
      // sweep's iteration for it runs. "owned-2" is untouched by the race.
      const originalApply = core.applyInventorySyncPlan.bind(core);
      vi.spyOn(core, "applyInventorySyncPlan").mockImplementation(async (application) => {
        const result = await originalApply(application);
        await core.addOrUpdateServer({ ...prunedA, name: "sw-a (recreated)" });
        return result;
      });

      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] })) // both devices gone -> prune "delete"
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });

      const callCounts: Record<string, number> = {};
      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          callCounts[serverId] = (callCounts[serverId] ?? 0) + 1;
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // "owned-1" is torn down ONCE (the pre-apply pass) — the post-apply
      // sweep must re-check core.getServer("owned-1") and skip it because
      // it's live again. "owned-2" is torn down TWICE (pre-apply pass, then
      // the post-apply sweep again, same as the dedicated reconnect-race
      // test above) because it was never recreated. If the fix were reverted
      // to an unconditional post-apply sweep, "owned-1" would show 2 calls
      // here too, killing the recreated server's live terminals/tunnels.
      expect(callCounts["owned-1"]).toBe(1);
      expect(callCounts["owned-2"]).toBe(2);
      expect(teardown.teardownServerRuntime).toHaveBeenCalledTimes(3);

      expect(core.getServer("owned-1")).toBeDefined();
      expect(core.getServer("owned-2")).toBeUndefined();

      // The recreated id is folded into the same "re-created server(s)"
      // count the credential-cleanup loop already reports — counted once,
      // not twice, even though both loops independently notice it's live.
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringMatching(/^Inventory sync from ".*" complete:.*1 re-created server.*kept its credentials\.$/)
      );
    });

    it("FINDING 2 (P2, second-sweep-abort review) — a teardown rejection (e.g. a tunnel stop failing) for one removed id does not abort the sweep: another removed id still gets torn down, pruned-secret cleanup still runs for both, and the closing report mentions incomplete cleanup (kills abort-on-first-teardown-failure)", async () => {
      const prunedA = makeServer({
        id: "owned-1",
        name: "sw-a",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const prunedB = makeServer({
        id: "owned-2",
        name: "sw-b",
        host: "10.0.0.2",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([prunedA, prunedB]);
      const core = new NexusCore(repo);
      await core.initialize();

      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] })) // both devices gone -> prune "delete"
      });
      registry.register(provider);
      const vault = makeVault({
        [passwordSecretKey("owned-1")]: "pw1",
        [passwordSecretKey("owned-2")]: "pw2",
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });

      // "owned-1" always rejects teardown (both the pre-apply pass and the
      // post-apply sweep); "owned-2" always succeeds. A reverted fix (a bare
      // `await teardown.teardownServerRuntime(id)` with no try/catch) would
      // let the FIRST rejection propagate out of the post-apply sweep,
      // skipping "owned-2"'s post-apply teardown, the entire pruned-secret
      // cleanup loop below it, and the normal success message — surfacing
      // instead as an unhandled command rejection.
      const teardownCalls: string[] = [];
      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          teardownCalls.push(serverId);
          if (serverId === "owned-1") throw new Error("tunnel stop failed");
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // Both records are gone regardless of the teardown rejection — the
      // deletion already committed before the post-apply sweep ran.
      expect(core.getSnapshot().servers).toHaveLength(0);

      // "owned-2" was torn down in both passes despite "owned-1" rejecting
      // right before/after it each time — proves the sweep continued.
      expect(teardownCalls.filter((id) => id === "owned-2")).toHaveLength(2);
      expect(teardownCalls.filter((id) => id === "owned-1")).toHaveLength(2);

      // Pruned-secret cleanup still ran for BOTH ids — a reverted fix would
      // have thrown out of the post-apply sweep before ever reaching this
      // loop, leaving both credentials in place.
      expect(await vault.get(passwordSecretKey("owned-1"))).toBeUndefined();
      expect(await vault.get(passwordSecretKey("owned-2"))).toBeUndefined();

      // The closing report still fires (not swallowed by an unhandled
      // rejection) and calls out the incomplete runtime cleanup by name.
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringMatching(/^Inventory sync from ".*" complete:.*Runtime cleanup incomplete for 1 server — close its terminal manually\.$/)
      );
    });

    it("(FINDING 2, review) a pruned server re-created (e.g. by nexus.server.edit, which never takes configMutationLock) while applyInventorySyncPlan's saves are still settling keeps its vault credentials — the post-apply cleanup loop must recheck server absence per id (kills unconditional pruned-secret cleanup)", async () => {
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        group: "Infra",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([pruned]);
      const core = new NexusCore(repo);
      await core.initialize();

      // Simulate the race the finding describes: applyInventorySyncPlan's
      // own saves are what a concurrent, lock-free nexus.server.edit races
      // against. Re-add "owned-1" (upsert semantics) right as that call
      // settles — the cleanup loop below runs immediately afterward and must
      // not just trust the plan's "this id was pruned" designation.
      const originalApply = core.applyInventorySyncPlan.bind(core);
      vi.spyOn(core, "applyInventorySyncPlan").mockImplementation(async (application) => {
        const result = await originalApply(application);
        await core.addOrUpdateServer({ ...pruned, name: "old-sw (recreated)" });
        return result;
      });

      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
      });
      registry.register(provider);
      const vault = makeVault({
        [passwordSecretKey("owned-1")]: "pw1",
        [passphraseSecretKey("owned-1")]: "pp1",
        [proxyPasswordSecretKey("owned-1")]: "proxy1",
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", prunePolicy: "delete" }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // "owned-1" is back (re-created mid-flow) — its credentials must
      // survive; a reverted fix would delete them here unconditionally
      // because the plan still designates it as pruned.
      expect(core.getServer("owned-1")).toBeDefined();
      expect(await vault.get(passwordSecretKey("owned-1"))).toBe("pw1");
      expect(await vault.get(passphraseSecretKey("owned-1"))).toBe("pp1");
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBe("proxy1");

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringMatching(/1 re-created server.*kept.*credentials/i)
      );
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
      // F3 — checkProviderFingerprint (shared with editSource's own pre-open
      // gate) adds one more `await` hop on `first`'s path to fetchInventory
      // versus `second`'s own (zero-internal-await) busy-check-and-return —
      // flush one more microtask so `first` has had the same chance to reach
      // its own first await-on-vault-read that it always had before that hop
      // existed.
      await Promise.resolve();

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

      expect(teardown.teardownServerRuntime).toHaveBeenCalledWith("owned-1", expect.any(Function));
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

    it("FINDING 1 — a concurrent mutation that only shows up in the post-teardown final recompute re-shows the confirmation modal instead of applying it unseen; canceling the second modal applies nothing (kills apply-without-reconfirm)", async () => {
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([pruned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        // device:1 is gone from the tree -> prune "delete". No other devices.
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });

      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          if (serverId === "owned-1") {
            // Simulate a concurrent import landing an owned server that the
            // fetched tree never mentions — invisible to the plan the user
            // just confirmed, but the post-teardown final recompute will see
            // it as another "delete" prune (device:2 is also absent).
            await core.addOrUpdateServer(
              makeServer({
                id: "owned-2",
                name: "new-owned",
                host: "10.0.0.2",
                origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
              })
            );
          }
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        .mockResolvedValueOnce("Apply") // first confirm
        .mockResolvedValueOnce(undefined); // cancel the reconfirmation modal

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // The modal was shown a SECOND time, with the updated (2-delete) plan.
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(2);
      const secondCallDetail = (mockShowInformationMessage.mock.calls[1]?.[1] as { detail?: string } | undefined)?.detail;
      expect(secondCallDetail).toContain("2 servers will be deleted");

      // If the fix were reverted (the post-teardown final recompute applied
      // unseen instead of looping back to reconfirm), applyInventorySyncPlan
      // would have been called once here and owned-2 would be gone.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getSnapshot().servers.map((s) => s.id).sort()).toEqual(["owned-1", "owned-2"]);
    });

    it("FINDING 3 — a manual server landing on a planned add's host:port during the post-teardown recompute re-shows the confirmation modal with the duplicates line, even though raw add/update/prune/unchanged counts are identical (kills a counts-only plan-drift comparator that misses manualDuplicateCount)", async () => {
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([pruned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        // device:1 is gone from the tree -> prune "delete". device:2 is a
        // brand-new device -> a planned add at 10.0.0.9:22, with no manual
        // server colliding yet at the time the first modal is shown.
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:2", name: "web1", endpoints: [{ kind: "ssh", host: "10.0.0.9", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });

      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          if (serverId === "owned-1") {
            // Simulate a manual (non-owned) server hand-added at exactly the
            // planned add's host:port DURING the teardown await — invisible
            // to the plan the user just confirmed. The add/update/prune/
            // unchanged counts are untouched by this (the add still happens,
            // just flagged as a duplicate); only manualDuplicateCount (and,
            // as a side effect of the collision warning, warnings.length)
            // moves.
            await core.addOrUpdateServer(
              makeServer({ id: "manual-1", name: "hand-added", host: "10.0.0.9", port: 22 })
            );
          }
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        .mockResolvedValueOnce("Apply") // first confirm — no duplicate visible yet
        .mockResolvedValueOnce(undefined); // cancel the reconfirmation modal

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // The modal was shown a SECOND time, now with the duplicate-add line —
      // the raw counts (1 added, 1 deleted) are unchanged from the first
      // modal, so a counts-only comparator would have applied this unseen.
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(2);
      const firstCallDetail = (mockShowInformationMessage.mock.calls[0]?.[1] as { detail?: string } | undefined)?.detail;
      const secondCallDetail = (mockShowInformationMessage.mock.calls[1]?.[1] as { detail?: string } | undefined)?.detail;
      expect(firstCallDetail).not.toContain("will be added as duplicates");
      expect(secondCallDetail).toContain("1 server will be added.");
      expect(secondCallDetail).toContain("1 server will be deleted");
      expect(secondCallDetail).toContain("will be added as duplicates");

      // If FINDING 3's fix were reverted (planCountsEqual comparing only raw
      // counts), this identical-counts drift would have gone unnoticed and
      // applyInventorySyncPlan would have been called once here, silently
      // adding device:2 as a duplicate of manual-1 without ever showing the
      // duplicates line for THIS plan.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getSnapshot().servers.map((s) => s.id).sort()).toEqual(["manual-1", "owned-1"]);
    });

    it("FINDING 1 (P2, jump-host-dependents-drift review) — a server edited to proxy through a planned deletion during the teardown hook re-shows the confirmation modal with the dependents line, even though every individually-compared count (adds/updates/prunes/unchanged/manualDuplicateCount/hiddenPruneCount/warnings.length) is identical (kills a comparator that never looked at describePlanDetail's jump-host line)", async () => {
      const pruned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const bystander = makeServer({ id: "bystander-1", name: "bystander", host: "10.0.0.50" });
      const repo = new InMemoryConfigRepository([pruned, bystander]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        // device:1 is gone from the tree -> prune "delete". No other devices.
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });

      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          if (serverId === "owned-1") {
            // Simulate a concurrent edit landing DURING the teardown await —
            // invisible to the plan the user just confirmed. The bystander
            // server is reconfigured to proxy through the about-to-be-deleted
            // "owned-1": this changes nothing computeSyncPlan itself returns
            // (adds/updates/prunes/unchangedCount/manualDuplicateCount/
            // hiddenPruneCount/warnings all untouched — the plan doesn't even
            // look at proxy config), only the jump-host-dependents line
            // describePlanDetail renders from `allServers` moves.
            await core.addOrUpdateServer({ ...bystander, proxy: { type: "ssh", jumpHostId: "owned-1" } });
          }
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete" }));

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        .mockResolvedValueOnce("Apply") // first confirm — no dependents visible yet
        .mockResolvedValueOnce(undefined); // cancel the reconfirmation modal

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // The modal was shown a SECOND time, now with the jump-host dependents
      // line — the raw counts (1 deleted, 0 unchanged) are identical between
      // both modals, so a counts-only comparator would have applied this
      // unseen.
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(2);
      const firstCallDetail = (mockShowInformationMessage.mock.calls[0]?.[1] as { detail?: string } | undefined)?.detail;
      const secondCallDetail = (mockShowInformationMessage.mock.calls[1]?.[1] as { detail?: string } | undefined)?.detail;
      expect(firstCallDetail).not.toContain("jump host");
      expect(firstCallDetail).toContain("1 server will be deleted");
      expect(secondCallDetail).toContain("1 server will be deleted");
      expect(secondCallDetail?.toLowerCase()).toContain("jump host");
      expect(secondCallDetail).toContain("1 other server uses this server as an SSH jump host.");

      // If FINDING 1's fix were reverted (a comparator built only from
      // adds/updates/prunes counts, unchangedCount, manualDuplicateCount,
      // hiddenPruneCount, and warnings.length — never the rendered detail
      // text or anything derived from `allServers`), this identical-counts
      // drift would have gone unnoticed and applyInventorySyncPlan would
      // have been called once here, deleting owned-1 without ever showing
      // the dependents warning for THIS plan.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getSnapshot().servers.map((s) => s.id).sort()).toEqual(["bystander-1", "owned-1"]);
    });

    it("FINDING 2 (P2, fast-path-stale-recompute review) — a locked server removal deleting an owned server, queued ahead of syncNow's fast-path lock acquisition, is picked up by a fresh in-lock recompute: the sync does NOT report nothing-to-do, and the confirm modal appears with the recomputed (non-empty) plan instead (kills applying a stale pre-lock empty plan without recomputing)", async () => {
      const owned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        port: 22,
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        // The tree still reports device:1, matching "owned-1" exactly — the
        // plan computed against the CURRENT (pre-removal) server list is
        // genuinely empty (unchanged), so syncNow takes the fast path.
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1,
          devices: [{ externalId: "device:1", name: "old-sw", endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 22 }] }]
        }))
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      let releaseRemoval!: () => void;
      const removalGate = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });

      // Simulates a locked mutation (e.g. nexus.server.remove, which also
      // serializes through the SAME configMutationLock singleton) queued
      // AHEAD of syncNow's own fast-path lock acquisition below: this call
      // is made first, so it sits at the head of the lock's FIFO queue.
      const removalPromise = configMutationLock.runExclusive(async () => {
        await removalGate;
        await core.removeServer("owned-1");
      });

      mockShowInformationMessage.mockResolvedValueOnce("Apply");

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      const syncPromise = cmd("src-1");

      // Let syncNow run all the way up to (and queue behind, on the shared
      // lock) its fast-path lock acquisition — everything before that point
      // (secret checks, the progress-wrapped fetch, the initial pre-lock
      // computeSyncPlan call) needs no lock and completes on its own.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Release the queued removal — it deletes "owned-1", then frees the
      // lock for syncNow's fast path to finally acquire it and recompute.
      releaseRemoval();
      await removalPromise;
      await syncPromise;

      // Never the stale "nothing to do" toast: the fresh in-lock recompute
      // (with "owned-1" gone) finds device:1 unmatched, i.e. a genuine add.
      expect(
        mockShowInformationMessage.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("nothing to do"))
      ).toBe(false);
      const modalCall = mockShowInformationMessage.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("Apply inventory sync")
      );
      expect(modalCall).toBeDefined();
      const detail = (modalCall?.[1] as { detail?: string } | undefined)?.detail;
      expect(detail).toContain("1 server will be added.");

      // The recomputed (non-empty) plan was actually applied after the user
      // confirmed it — the device is re-created as a fresh add, proving this
      // wasn't a no-op.
      expect(core.getSnapshot().servers.filter((s) => s.origin?.sourceId === "src-1")).toHaveLength(1);
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

    describe("describePlanDetail orphan-line destination (targetFolder at MAX_FOLDER_DEPTH)", () => {
      function modalDetail(): string | undefined {
        const modalCall = mockShowInformationMessage.mock.calls.find(
          ([msg]) => typeof msg === "string" && msg.includes("Apply inventory sync")
        );
        return (modalCall?.[1] as { detail?: string } | undefined)?.detail;
      }

      it("FIX (orphan-line mis-rendered fallback depth) — a targetFolder already at MAX_FOLDER_DEPTH shows the ACTUAL destination computeSyncPlan's fallback used (the target folder itself), not the recomputed target/_orphaned path it could not create (kills the modal misstating where servers actually land)", async () => {
        // MAX_FOLDER_DEPTH segments — one more level ("<deepFolder>/_orphaned")
        // exceeds the limit, so normalizeFolderPath rejects it and syncEngine's
        // fallback (FIX 6) leaves the orphan's `after.group` at deepFolder itself.
        const deepFolder = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => `L${i + 1}`).join("/");
        const pruned = makeServer({
          id: "owned-1",
          name: "old-sw",
          host: "10.0.0.1",
          group: deepFolder,
          origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
        });
        const repo = new InMemoryConfigRepository([pruned]);
        const core = new NexusCore(repo);
        await core.initialize();
        const registry = new InventoryProviderRegistry();
        const provider = makeProvider({
          // device:1 absent from the fetched tree -> prune "orphan".
          fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
        });
        registry.register(provider);
        const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
        registerInventoryCommands(core, registry, vault, makeTeardown());
        await core.addOrUpdateInventorySource(makeSource({ targetFolder: deepFolder, prunePolicy: "orphan" }));

        mockShowInformationMessage.mockResolvedValueOnce("Apply");
        // The engine's own orphan-fallback warning fires a separate toast —
        // unrelated to the fix under test, just needs a resolved promise.
        mockShowWarningMessage.mockResolvedValueOnce(undefined);

        const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
        await cmd("src-1");

        const detail = modalDetail();
        // The engine's own fallback destination — this is where the server is
        // ACTUALLY moved.
        expect(detail).toContain(`will be moved to "${deepFolder}"`);
        // If this fix were reverted (recomputing `${targetFolder}/${ORPHAN_FOLDER_NAME}`
        // regardless of what computeSyncPlan actually did), the modal would
        // instead claim this path — which the engine explicitly could not
        // create and never used.
        expect(detail).not.toContain(`${deepFolder}/${ORPHAN_FOLDER_NAME}`);
        expect(core.getServer("owned-1")?.group).toBe(deepFolder);
      });

      it("normal-depth targetFolder still names the real target/_orphaned destination", async () => {
        const pruned = makeServer({
          id: "owned-1",
          name: "old-sw",
          host: "10.0.0.1",
          group: "Infra",
          origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
        });
        const repo = new InMemoryConfigRepository([pruned]);
        const core = new NexusCore(repo);
        await core.initialize();
        const registry = new InventoryProviderRegistry();
        const provider = makeProvider({
          fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
        });
        registry.register(provider);
        const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
        registerInventoryCommands(core, registry, vault, makeTeardown());
        await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", prunePolicy: "orphan" }));

        mockShowInformationMessage.mockResolvedValueOnce("Apply");

        const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
        await cmd("src-1");

        const detail = modalDetail();
        expect(detail).toContain(`will be moved to "Infra/${ORPHAN_FOLDER_NAME}"`);
        expect(core.getServer("owned-1")?.group).toBe(`Infra/${ORPHAN_FOLDER_NAME}`);
      });

      it("a root targetFolder (\"\") orphans to the top-level _orphaned folder — quoted, not rendered as the top level", async () => {
        const pruned = makeServer({
          id: "owned-1",
          name: "old-sw",
          host: "10.0.0.1",
          origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
        });
        const repo = new InMemoryConfigRepository([pruned]);
        const core = new NexusCore(repo);
        await core.initialize();
        const registry = new InventoryProviderRegistry();
        const provider = makeProvider({
          fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
        });
        registry.register(provider);
        const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
        registerInventoryCommands(core, registry, vault, makeTeardown());
        await core.addOrUpdateInventorySource(makeSource({ targetFolder: "", prunePolicy: "orphan" }));

        mockShowInformationMessage.mockResolvedValueOnce("Apply");

        const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
        await cmd("src-1");

        const detail = modalDetail();
        // computeSyncPlan normalizes the root-target candidate ("_orphaned"
        // alone) successfully, so `after.group` is the literal folder name —
        // never undefined — and the line renders the quoted path, not the
        // "moved to the top level" wording reserved for a genuinely undefined
        // destination.
        expect(detail).toContain(`will be moved to "${ORPHAN_FOLDER_NAME}"`);
        expect(detail).not.toContain("the top level");
        expect(core.getServer("owned-1")?.group).toBe(ORPHAN_FOLDER_NAME);
      });
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

    it("FINDING 2 (P2, defensive-copy review) — a provider that mutates its config argument in place does not corrupt the stored source record (kills passing the live config object straight through to fetchInventory)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async (config) => {
          // A misbehaving third-party provider mutating the config object it
          // was handed, as if it were free to treat it as scratch space.
          (config as Record<string, unknown>).baseUrl = "mutated";
          return { contractVersion: 1, devices: [] };
        })
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      // NexusCore.addOrUpdateInventorySource only shallow-copies the source
      // record itself — the nested `config` object is stored by the exact
      // same reference the caller passed in, so this is genuinely the live
      // object syncNow will later read as `source.config`.
      await core.addOrUpdateInventorySource(makeSource({ config: { baseUrl: "https://original.example" } }));

      const cmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await cmd("src-1");

      // If the fix were reverted (provider.fetchInventory(source.config,
      // secrets) passing the live object straight through instead of a
      // structuredClone), the provider's in-place mutation above would be
      // visible here too — the stored record and the corrupted copy are the
      // same object.
      expect(core.getInventorySource("src-1")?.config.baseUrl).toBe("https://original.example");
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

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("edit the source"));
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

      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("API Token"));
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
      expect(options.detail).toContain("1 other server uses this server as an SSH jump host.");
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
