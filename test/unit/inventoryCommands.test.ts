import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptionCandidateKeys,
  adoptionPairKeys,
  authProfileSwitchIds,
  describePlanDetail,
  planDetailDrift,
  planWarningsBuffer,
  registerInventoryCommands,
  type InventoryRuntimeTeardown
} from "../../src/commands/inventoryCommands";
import { InventorySourceRemovalMismatchError, NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import {
  computeProviderFingerprint,
  inventorySecretKey,
  type InventoryProvider,
  type InventorySourceConfig,
  type InventorySourceValues,
  type InventoryTree
} from "../../src/models/inventory";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import { ORPHAN_FOLDER_NAME, type InventorySyncPlan } from "../../src/services/inventory/syncEngine";
import { configMutationLock } from "../../src/services/configMutationLock";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { MAX_FOLDER_DEPTH } from "../../src/utils/folderPaths";
import type { FormDefinition, FormValues } from "../../src/ui/formTypes";
import { openForm } from "../helpers/formScriptHarness";

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
const mockAuthProfileEditorOpenNew = vi.fn();

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
  ProgressLocation: { Notification: 15 },
  // Real enum values (Separator = -1, Default = 0) so the hub's separator row
  // is asserted against the same constant VS Code renders on.
  QuickPickItemKind: { Separator: -1, Default: 0 }
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

// The inline auth-profile controller opens the real singleton editor panel,
// which builds a live vscode.WebviewPanel. Stubbed so the inline-creation
// round trip (createInline -> editor opens -> new profile injected into the
// still-open source form) can be driven end to end without a webview.
vi.mock("../../src/ui/authProfileEditorPanel", () => ({
  AuthProfileEditorPanel: {
    openNew: (...args: unknown[]) => mockAuthProfileEditorOpenNew(...args),
    open: vi.fn()
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
  onCreateInline?: (key: string) => void;
  onAutofill?: (key: string, value: string) => Promise<Record<string, string> | undefined>;
} {
  const call = mockWebviewOpen.mock.results.at(-1);
  const callArgs = mockWebviewOpen.mock.calls.at(-1);
  expect(callArgs).toBeDefined();
  const handlers = callArgs![2] as {
    onSubmit: (values: FormValues) => Promise<void>;
    onTest?: (values: FormValues) => Promise<void>;
    onCreateInline?: (key: string) => void;
    onAutofill?: (key: string, value: string) => Promise<Record<string, string> | undefined>;
  };
  return {
    formId: callArgs![0] as string,
    definition: callArgs![1] as FormDefinition,
    panel: call!.value as FakePanel,
    onSubmit: handlers.onSubmit,
    onTest: handlers.onTest,
    onCreateInline: handlers.onCreateInline,
    onAutofill: handlers.onAutofill
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
    // REVIEW FINDING (P1, cross-instance adoption) — the fake provider names its
    // DEPLOYMENT the way the real NetBox one does: from its own non-secret
    // config, here the `host` field declared above. Sources built by
    // `makeSource` carry no host, so they all resolve to one shared instance
    // ("fake://default"), which is what makes every existing single-source test
    // read as "one deployment, removed and re-added". A test that needs two
    // deployments gives its sources different `config.host` values, and one that
    // needs a provider with no instance identity overrides this with
    // `instanceKey: undefined`.
    instanceKey: (config: InventorySourceValues) => `fake://${String(config.host ?? "default")}`,
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

// A synthetic plan for the pure rendering/drift helpers (describePlanDetail,
// planWarningsBuffer, planDetailDrift). Those three are functions of a plan
// alone, and several of the shapes they must render — an identity swap between
// two otherwise-identical plans, a nameless auth switch — are unreachable or
// prohibitively awkward to stage through a provider fetch. Centralised in ONE
// place so a future field on InventorySyncPlan is a one-line fix here rather
// than a hunt through every literal in this file.
function makeSyncPlan(overrides: Partial<InventorySyncPlan> = {}): InventorySyncPlan {
  return {
    sourceId: "src-1",
    syncedAt: 1,
    adds: [],
    updates: [],
    prunes: [],
    unchangedCount: 0,
    folders: [],
    warnings: [],
    hiddenPruneCount: 0,
    manualDuplicateCount: 0,
    adoptionCandidates: [],
    ...overrides
  };
}

// The four busy refusals, verbatim (against makeSource()'s "My Source").
// Asserted as EXACT strings, never by substring, because the bug these pin is
// a wording bug: the busy marker used to be a bare Set, so an open Edit Source
// form and an in-flight removal both reported themselves as a running sync.
// A "some warning appeared" assertion passes against that exact lie.
const BUSY_SYNC_FROM_SYNC = '"My Source" is already syncing.';
const BUSY_SYNC_FROM_OTHER = '"My Source" is currently syncing — try again once the sync finishes.';
const BUSY_EDIT = '"My Source" is open in Edit Source — close that tab, then try again.';
const BUSY_REMOVE = '"My Source" is currently being removed — try again once the removal finishes.';

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

    it("REVIEW FINDING 2 (P2) — a rejecting vault.get during the Test button's kept-secret hydration is caught and shown as a keychain failure, never an unhandled rejection (kills the escaping await)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      // Simulate a SecretStorage backend failure (e.g. the OS keychain is
      // locked/unavailable) for exactly the hydration read handleFormTest
      // performs for a blank, previously-saved secret field.
      vault.get.mockRejectedValueOnce(new Error("keychain locked"));
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] }));

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { onTest } = latestFormCall();

      const values: FormValues = {
        name: "My Source",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "" // left blank -> triggers vault hydration
      };

      // If the rejection escaped handleFormTest unhandled, this await itself
      // would reject (or the test would fail via an unhandled-rejection
      // reporter) instead of resolving normally with the failure surfaced
      // through the UI.
      await expect(onTest!(values)).resolves.toBeUndefined();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Could not read saved credentials from the system keychain")
      );
      // The hydration failure must abort before ever calling the provider's
      // testConnection with a possibly-incomplete secret set.
      expect(provider.testConnection).not.toHaveBeenCalled();
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
      // would open a second form here instead. The refusal names the open
      // tab: no sync is running, so the pre-fix "currently syncing" wording
      // was a straight falsehood.
      await cmd();
      expect(mockShowWarningMessage).toHaveBeenCalledWith(BUSY_EDIT);
      expect(mockWebviewOpen).toHaveBeenCalledTimes(1);

      // Closing the form (Cancel, or WebviewFormPanel's own post-submit
      // dispose) releases the guard — the wrong implementation (no
      // onDidDispose release wiring) would still refuse here.
      panel.fireDispose();
      mockShowWarningMessage.mockClear();
      await cmd();
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_EDIT);
      expect(mockWebviewOpen).toHaveBeenCalledTimes(2);
    });

    it("in-flight guard — a Cancel/dispose that arrives WHILE Save's own persist is still in flight must not release the marker until persistence settles (kills onDidDispose releasing inFlightSourceIds instantly instead of waiting on the pending onSubmit — a concurrent Sync Now must be refused for the whole window, not just released the moment the panel closes)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", config: { host: "netbox.local" } }));

      // Gate persistUpdatedInventorySource's own persist call
      // (core.addOrUpdateInventorySource) on a controllable promise, so the
      // test can pause a Save exactly at the half-updated window the review
      // finding describes: this run's re-entered vault secret already
      // written (persistUpdatedInventorySource stores secrets BEFORE
      // persisting the record — see its own FINDING 1 comment), the config
      // record not yet persisted.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const originalAddOrUpdate = core.addOrUpdateInventorySource.bind(core);
      const addOrUpdateSpy = vi.spyOn(core, "addOrUpdateInventorySource").mockImplementation(async (source: InventorySourceConfig) => {
        await gate;
        return originalAddOrUpdate(source);
      });

      const cmd = registeredCommands.get("nexus.inventory.editSource")!;
      await cmd();
      const { panel, onSubmit } = latestFormCall();

      // Save — deliberately not awaited here: it's gated mid-persist.
      const submitPromise = onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "new-secret"
      });
      let submitSettled = false;
      void submitPromise
        .finally(() => {
          submitSettled = true;
        })
        .catch(() => {
          // This is a second, test-local observer of submitPromise, purely
          // for the `submitSettled` flag below — the real assertion on
          // success/failure happens via `await submitPromise` further down.
          // Without this, a rejection would also surface as an unhandled
          // rejection from THIS chain.
        });

      // Let Save run up to (and into) the gated persist call.
      await vi.waitFor(() => {
        expect(addOrUpdateSpy).toHaveBeenCalled();
      });
      expect(submitSettled).toBe(false);
      // Confirms the half-updated window is real: the vault write for the
      // re-entered secret already landed even though the config record has
      // not — this is exactly the state a concurrent Sync Now must not be
      // able to observe.
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("new-secret");

      // The user cancels/closes the panel WHILE Save is still pending on the
      // gate — this is the onDidDispose firing the review finding is about.
      panel.fireDispose();

      // Give a wrong (instant-release) implementation every chance to have
      // already deleted the marker: several microtask turns pass, still with
      // the persist gate held closed the whole time.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(submitSettled).toBe(false);

      // THE KILL — a bounded microtask flush, not an unbounded `await`: with
      // the CORRECT fix, the marker is still held, so this Sync Now is
      // refused synchronously at the busy check (zero internal awaits on
      // that path — see syncNow's own "Marked busy synchronously" comment)
      // and settles within a handful of microtasks, never reaching
      // fetchInventory. Reverting the fix (instant release on dispose) lets
      // this Sync Now sail past the busy check instead: it reads the
      // mid-persist vault secret and calls fetchInventory with it, then
      // stalls on configMutationLock — still held by the gated
      // persistUpdatedInventorySource — so it would NOT settle within this
      // same bounded window (an unbounded `await` here would instead hang
      // the whole test out to the runner's timeout).
      const syncCmd = registeredCommands.get("nexus.inventory.syncNow")!;
      const syncPromise = syncCmd("src-1");
      let syncSettled = false;
      void syncPromise
        .finally(() => {
          syncSettled = true;
        })
        .catch(() => {
          // Second, test-local observer — see the submitPromise comment above.
        });
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(syncSettled).toBe(true);
      // The marker is held by the still-open (mid-save) Edit form, so the
      // refusal names that form — not a sync, which is exactly what is NOT
      // happening here.
      expect(mockShowWarningMessage).toHaveBeenCalledWith(BUSY_EDIT);
      expect(provider.fetchInventory).not.toHaveBeenCalled();

      // Let the gated persist complete, and drain both promises so nothing
      // dangles past this test (relevant if this test were ever run against
      // a reverted fix, where syncPromise is still queued on
      // configMutationLock at this point).
      releaseGate();
      await submitPromise;
      await syncPromise;
      expect(submitSettled).toBe(true);

      // Once persistence has actually settled, the marker IS released — a
      // subsequent Sync Now proceeds normally.
      mockShowWarningMessage.mockClear();
      await syncCmd("src-1");
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_EDIT);
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
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
      // — every later editSource for this exact source id would be refused as
      // open in an Edit Source tab that does not exist, forever.
      await cmd();
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_EDIT);
      expect(mockWebviewOpen).toHaveBeenCalledTimes(2);
    });

    it("REVIEW FINDING 2 (P2) — the busy marker is claimed BEFORE the fingerprint-mismatch modal, not after: a concurrent Sync Now while the modal is still pending is refused as busy (kills the late-claim race)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ config: { host: "netbox.local" }, secretFieldIds: ["apiToken"], providerFingerprint: "stale-fingerprint" })
      );

      // Controllable: the fingerprint-mismatch modal (an `{modal: true}` call)
      // stays pending until resolveModal is invoked; any OTHER
      // showWarningMessage call (e.g. the busy refusals, all fire-and-forget)
      // resolves immediately — they're never awaited by their callers anyway.
      let resolveModal!: (choice: string | undefined) => void;
      const modalChoice = new Promise<string | undefined>((resolve) => (resolveModal = resolve));
      mockShowWarningMessage.mockImplementation((...args: unknown[]) => {
        const isModal = typeof args[1] === "object" && args[1] !== null && (args[1] as { modal?: boolean }).modal === true;
        return isModal ? modalChoice : Promise.resolve(undefined);
      });

      const editCmd = registeredCommands.get("nexus.inventory.editSource")!;
      const editPromise = editCmd();
      // Flush microtasks: pickInventorySource's own `await` resolves, then
      // editSource runs synchronously (busy-check, claim, provider lookup)
      // straight into checkProviderFingerprint's `await showWarningMessage`,
      // which suspends on our still-pending `modalChoice`.
      await Promise.resolve();
      await Promise.resolve();

      // The OLD (wrong) implementation claims the marker only AFTER this
      // await resolves — at this point in time it would still be unclaimed,
      // and the concurrent Sync Now below would sail straight through the
      // busy check, past its OWN `await checkProviderFingerprint`, and hang
      // on the very same still-pending `modalChoice` (since the source's
      // fingerprint is stale for syncNow too). Detect that without actually
      // waiting out a timeout: a busy-refused Sync Now takes zero internal
      // awaits (see its "Marked busy synchronously right after the last
      // check above" comment) and settles within a couple of microtasks; a
      // wrongly-admitted one stays pending, still awaiting `modalChoice`,
      // past that same flush.
      const syncCmd = registeredCommands.get("nexus.inventory.syncNow")!;
      let syncSettled = false;
      const syncPromise = syncCmd("src-1").finally(() => {
        syncSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(syncSettled).toBe(true);
      // Held by editSource (which is parked on its fingerprint modal), so the
      // refusal names the edit, not a sync.
      expect(mockShowWarningMessage).toHaveBeenCalledWith(BUSY_EDIT);
      expect(provider.fetchInventory).not.toHaveBeenCalled();

      // Clean up: let the still-open edit modal (and, if the assertions
      // above already failed, the still-pending sync too) resolve so nothing
      // is left dangling past the end of the test.
      resolveModal(undefined);
      await Promise.all([editPromise, syncPromise]);
    });

    it("REVIEW FINDING 2 (P2) — Cancel at the fingerprint-mismatch modal releases the busy marker; a subsequent Sync Now is not refused as busy", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider({
        fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: [] }))
      });
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(
        makeSource({ config: { host: "netbox.local" }, secretFieldIds: ["apiToken"], providerFingerprint: "stale-fingerprint" })
      );

      // editSource's own modal: Cancel.
      mockShowWarningMessage.mockResolvedValueOnce("Cancel");
      const editCmd = registeredCommands.get("nexus.inventory.editSource")!;
      await editCmd();
      expect(mockWebviewOpen).not.toHaveBeenCalled();

      // If Cancel left the marker claimed (e.g. releaseInFlight only wired
      // for the open()-throw/dispose paths, not this one), the sync below
      // would be refused as still open in Edit Source and never reach
      // fetchInventory.
      mockShowWarningMessage.mockResolvedValueOnce("Continue"); // syncNow's own fingerprint check (still stale)
      const syncCmd = registeredCommands.get("nexus.inventory.syncNow")!;
      await syncCmd("src-1");

      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_EDIT);
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
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

      // A sync really IS in flight here, so the sync wording is the truthful
      // one — the fix must not have made every refusal name an edit instead.
      expect(mockShowWarningMessage).toHaveBeenCalledWith(BUSY_SYNC_FROM_OTHER);
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

    // -------- Codex round 9 (P1, SECURITY) — the inventory apply clears a stale
    // per-server proxy-password when a template moves the proxy identity AWAY from
    // the SOCKS5/HTTP endpoint that secret belongs to. Otherwise ProxySshFactory
    // would send the old proxy's password to the NEW endpoint (a credential leak
    // to the wrong host). --------

    // A template-OWNED socks5 proxy → X on the owned server (stamp === value, so an
    // override can MOVE it — a truly hand-set/unstamped proxy is row-7 protected).
    // The stored proxy-password was saved on-connect for endpoint X.
    function ownedWithTemplateProxyX(): ServerConfig {
      return makeServer({
        id: "owned-1",
        host: "10.0.0.1",
        origin: {
          sourceId: "src-1",
          externalId: "device:1",
          syncedAt: 1,
          templated: { proxy: { type: "socks5", host: "10.9.9.1", port: 1080, username: "puser" } }
        },
        proxy: { type: "socks5", host: "10.9.9.1", port: 1080, username: "puser" }
      });
    }
    const deviceMappingOwned1 = () => ({
      contractVersion: 1 as const,
      devices: [{ externalId: "device:1", name: "old-sw", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] }]
    });

    it("(round 9, SECURITY) an applied template override that MOVES a server's SOCKS5 proxy to a DIFFERENT socks5 endpoint clears the stale proxy-password-{id} — otherwise ProxySshFactory sends the old proxy's password to the new host (kills retaining the secret across a proxy-identity change)", async () => {
      const repo = new InMemoryConfigRepository([ownedWithTemplateProxyX()]);
      const core = new NexusCore(repo);
      await core.initialize();
      // The template edit: move the proxy to a DIFFERENT socks5 endpoint (host Y).
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));
      const vault = makeVault({
        [proxyPasswordSecretKey("owned-1")]: "old-proxy-pw",
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The record's proxy moved X → Y...
      expect(core.getServer("owned-1")?.proxy).toEqual({ type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" });
      // ...so the password saved for X is stale and MUST be cleared. Against
      // e2553fe the apply never touched the secret → the old X password would be
      // sent to Y.
      expect(vault.delete).toHaveBeenCalledWith(proxyPasswordSecretKey("owned-1"));
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBeUndefined();
    });

    it("(round 9, SECURITY) an applied template override that changes a SOCKS5 proxy to an SSH jump-host proxy clears the stale proxy-password-{id} (the ssh proxy never uses it)", async () => {
      const bastion = makeServer({ id: "bastion-1", name: "bastion", host: "10.0.0.9", port: 22 }); // hand-added → a survivor
      const repo = new InMemoryConfigRepository([ownedWithTemplateProxyX(), bastion]);
      const core = new NexusCore(repo);
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "ssh", jumpHostId: "bastion-1" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));
      const vault = makeVault({
        [proxyPasswordSecretKey("owned-1")]: "old-proxy-pw",
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(core.getServer("owned-1")?.proxy).toEqual({ type: "ssh", jumpHostId: "bastion-1" });
      expect(vault.delete).toHaveBeenCalledWith(proxyPasswordSecretKey("owned-1"));
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBeUndefined();
    });

    it("(round 9, SECURITY — over-clear guard) an update that KEEPS the SAME socks5 host+port+username (a rename, proxy unchanged) does NOT clear the still-valid proxy-password-{id}", async () => {
      // Hand-set socks5 X, no template moving it; a device rename forces an update
      // whose proxy is carried unchanged → same endpoint → secret KEPT.
      const owned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 },
        proxy: { type: "socks5", host: "10.9.9.1", port: 1080, username: "puser" }
      });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(
        makeProvider({
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [{ externalId: "device:1", name: "renamed-sw", endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 22 }] }]
          }))
        })
      );
      const vault = makeVault({
        [proxyPasswordSecretKey("owned-1")]: "still-valid-pw",
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(core.getServer("owned-1")?.name).toBe("renamed-sw"); // the update landed
      expect(core.getServer("owned-1")?.proxy).toEqual({ type: "socks5", host: "10.9.9.1", port: 1080, username: "puser" }); // proxy unchanged
      expect(vault.delete).not.toHaveBeenCalledWith(proxyPasswordSecretKey("owned-1")); // secret KEPT
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBe("still-valid-pw");
    });

    it("(round 9, SECURITY — no-op guard) an update on an SSH-proxied server (ssh↔ssh, no socks5/http before) performs no proxy-secret operation", async () => {
      const bastion = makeServer({ id: "bastion-1", name: "bastion", host: "10.0.0.9", port: 22 });
      const owned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 },
        proxy: { type: "ssh", jumpHostId: "bastion-1" } // ssh proxy — carries no password
      });
      const repo = new InMemoryConfigRepository([owned, bastion]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(
        makeProvider({
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [{ externalId: "device:1", name: "renamed-sw", endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 22 }] }]
          }))
        })
      );
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(core.getServer("owned-1")?.name).toBe("renamed-sw"); // update landed
      expect(vault.delete).not.toHaveBeenCalledWith(proxyPasswordSecretKey("owned-1")); // no proxy-secret op
    });

    // -------- Codex round 10 (P1, SECURITY) — the stale proxy-password clear must
    // run BEFORE applyInventorySyncPlan publishes the new proxy (nexus.server.connect
    // does NOT take configMutationLock, so an after-apply clear leaves a leak window),
    // must FAIL CLOSED on a delete error (abort the sync, don't swallow), and must
    // RESTORE the captured secret if the apply throws (old proxy still live). --------

    // Sets up the standard "template moves owned-1's socks5 proxy X→Y" scenario the
    // round-9 tests use, then returns the wired-up pieces so each round-10 test can
    // vary the vault / apply behaviour. A confirm-modal ("Apply") run drives the
    // in-lock confirmed apply site (the one that actually carries a proxy update).
    async function setupProxyMoveScenario(): Promise<{ core: NexusCore; registry: InventoryProviderRegistry }> {
      const repo = new InMemoryConfigRepository([ownedWithTemplateProxyX()]);
      const core = new NexusCore(repo);
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));
      return { core, registry };
    }

    it("(round 10, SECURITY — ordering) the stale proxy-password DELETE happens BEFORE applyInventorySyncPlan publishes the new proxy — falsifies the round-9 after-apply clear (connect never takes the lock, so an after-apply clear leaks the old password to the new endpoint)", async () => {
      const { core, registry } = await setupProxyMoveScenario();
      const proxyKey = proxyPasswordSecretKey("owned-1");

      const callOrder: string[] = [];
      const store = new Map<string, string>([
        [proxyKey, "old-proxy-pw"],
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      const vault = {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          if (k === proxyKey) callOrder.push("delete");
          store.delete(k);
        })
      };
      // Log the apply relative to the delete, then call the real method through.
      const applyReal = core.applyInventorySyncPlan.bind(core);
      vi.spyOn(core, "applyInventorySyncPlan").mockImplementation(async (application) => {
        callOrder.push("apply");
        return applyReal(application);
      });

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The new proxy IS published (Y)...
      expect(core.getServer("owned-1")?.proxy).toEqual({ type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" });
      // ...but only AFTER the stale secret was deleted. Against bc4df87 the clear ran
      // after apply → order would be ["apply", "delete"].
      expect(callOrder).toEqual(["delete", "apply"]);
      expect(await vault.get(proxyKey)).toBeUndefined();
    });

    it("(round 10, SECURITY — delete fails CLOSED) a vault.delete throw for the stale proxy key ABORTS the sync (applyInventorySyncPlan never called, new proxy never published) and RESTORES the captured secret — falsifies the round-9 best-effort swallow", async () => {
      const { core, registry } = await setupProxyMoveScenario();
      const proxyKey = proxyPasswordSecretKey("owned-1");

      const store = new Map<string, string>([
        [proxyKey, "old-proxy-pw"],
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      const vault = {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          if (k === proxyKey) throw new Error("vault delete failed"); // throws WITHOUT mutating the store
          store.delete(k);
        })
      };
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // Fail closed: the proxy change was never published — the record still points
      // at the OLD endpoint X. Against bc4df87 the delete ran (and swallowed) AFTER a
      // committed apply, so the proxy would already be Y here.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getServer("owned-1")?.proxy).toEqual({ type: "socks5", host: "10.9.9.1", port: 1080, username: "puser" });
      // The captured secret is restored — the still-live old proxy keeps its password.
      expect(vault.store).toHaveBeenCalledWith(proxyKey, "old-proxy-pw");
      expect(await vault.get(proxyKey)).toBe("old-proxy-pw");
      expect(mockShowErrorMessage).toHaveBeenCalled();
    });

    it("(round 10, SECURITY — apply fails, restore) delete succeeds but applyInventorySyncPlan throws → the captured secret is RESTORED (old proxy config is still live and needs its password) and the failure surfaces", async () => {
      const { core, registry } = await setupProxyMoveScenario();
      const proxyKey = proxyPasswordSecretKey("owned-1");

      const store = new Map<string, string>([
        [proxyKey, "old-proxy-pw"],
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      const vault = {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          store.delete(k);
        })
      };
      vi.spyOn(core, "applyInventorySyncPlan").mockRejectedValue(new Error("apply boom"));

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The secret was deleted before the (failing) apply, then put back on failure.
      expect(vault.delete).toHaveBeenCalledWith(proxyKey);
      expect(vault.store).toHaveBeenCalledWith(proxyKey, "old-proxy-pw");
      expect(await vault.get(proxyKey)).toBe("old-proxy-pw");
      expect(mockShowErrorMessage).toHaveBeenCalled();
    });

    it("(round 10, SECURITY — happy path) delete succeeds and apply succeeds → the stale secret is gone, the new proxy is live, and nothing is restored", async () => {
      const { core, registry } = await setupProxyMoveScenario();
      const proxyKey = proxyPasswordSecretKey("owned-1");
      const vault = makeVault({
        [proxyKey]: "old-proxy-pw",
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(core.getServer("owned-1")?.proxy).toEqual({ type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" });
      expect(vault.delete).toHaveBeenCalledWith(proxyKey);
      expect(await vault.get(proxyKey)).toBeUndefined();
      // No restore on the success path.
      expect(vault.store).not.toHaveBeenCalledWith(proxyKey, expect.anything());
    });

    // -------- Codex round 11 (P1, SECURITY) — the WHICH-secrets predicate must
    // trigger on EITHER side being a password-bearing (socks5/http) endpoint, not
    // just `before`. A legacy backup restores an exported proxy-password-{id}
    // WITHOUT requiring the server to currently carry a socks5/http proxy
    // (configCommands.ts), so an ORPHANED entry can sit under an undefined/ssh
    // proxy; a template assigning a NEW authenticated endpoint would otherwise skip
    // the clear (before isn't password-bearing) and send the orphan to it. --------

    // Owned server whose proxy is UNSET and unstamped — an override template writes
    // it (matrix row 1). The orphaned proxy-password-{id} is a legacy-backup relic.
    function ownedWithNoProxy(): ServerConfig {
      return makeServer({
        id: "owned-1",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
    }

    it("(round 11, SECURITY — orphan) a template assigning a NEW socks5 proxy to a server whose before.proxy is UNDEFINED clears an ORPHANED proxy-password-{id} BEFORE the apply publishes — otherwise the orphan is sent to the new endpoint (kills the before-only predicate)", async () => {
      const repo = new InMemoryConfigRepository([ownedWithNoProxy()]);
      const core = new NexusCore(repo);
      await core.initialize();
      // The template assigns an authenticated socks5 endpoint Y to a server that
      // had NO proxy before — before.proxy is undefined, after.proxy is bearing.
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));

      const proxyKey = proxyPasswordSecretKey("owned-1");
      const callOrder: string[] = [];
      const store = new Map<string, string>([
        [proxyKey, "orphan-pw"], // legacy-backup orphan, no current socks5/http proxy behind it
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      const vault = {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          if (k === proxyKey) callOrder.push("delete");
          store.delete(k);
        })
      };
      const applyReal = core.applyInventorySyncPlan.bind(core);
      vi.spyOn(core, "applyInventorySyncPlan").mockImplementation(async (application) => {
        callOrder.push("apply");
        return applyReal(application);
      });

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The new authenticated proxy IS published (Y)...
      expect(core.getServer("owned-1")?.proxy).toEqual({ type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" });
      // ...but only AFTER the orphaned secret was deleted. Against 2c9d009 the
      // before-only predicate early-returns (before.proxy is undefined) → no
      // delete → order would be ["apply"] and the orphan "orphan-pw" would survive
      // to be sent to Y on the next connect.
      expect(callOrder).toEqual(["delete", "apply"]);
      expect(vault.delete).toHaveBeenCalledWith(proxyKey);
      expect(await vault.get(proxyKey)).toBeUndefined();
    });

    it("(round 11, SECURITY — orphan, delete fails CLOSED) a vault.delete throw for the orphaned proxy key ABORTS the sync (applyInventorySyncPlan never called, new proxy never published) and RESTORES the orphan", async () => {
      const repo = new InMemoryConfigRepository([ownedWithNoProxy()]);
      const core = new NexusCore(repo);
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));

      const proxyKey = proxyPasswordSecretKey("owned-1");
      const store = new Map<string, string>([
        [proxyKey, "orphan-pw"],
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      const vault = {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          if (k === proxyKey) throw new Error("vault delete failed"); // throws WITHOUT mutating the store
          store.delete(k);
        })
      };
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // Fail closed: the new proxy was never published — the record still has no proxy.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getServer("owned-1")?.proxy).toBeUndefined();
      // The captured orphan is restored (best-effort) so the pass is atomic.
      expect(vault.store).toHaveBeenCalledWith(proxyKey, "orphan-pw");
      expect(await vault.get(proxyKey)).toBe("orphan-pw");
      expect(mockShowErrorMessage).toHaveBeenCalled();
    });

    it("(round 11, SECURITY — over-clear guard) an ssh↔ssh update (device renamed, jump host unchanged) leaves an orphaned proxy-password-{id} ALONE — neither side is password-bearing, so an ssh proxy never sends it (kills clearing on any stored secret regardless of proxy kind)", async () => {
      const bastion = makeServer({ id: "bastion-1", name: "bastion", host: "10.0.0.9", port: 22 });
      const owned = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 },
        proxy: { type: "ssh", jumpHostId: "bastion-1" } // ssh proxy — carries no password
      });
      const repo = new InMemoryConfigRepository([owned, bastion]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(
        makeProvider({
          // Rename forces an UPDATE (before.proxy ssh, after.proxy ssh carried unchanged).
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [{ externalId: "device:1", name: "renamed-sw", endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 22 }] }]
          }))
        })
      );
      const vault = makeVault({
        [proxyPasswordSecretKey("owned-1")]: "orphan-pw", // orphan under an ssh proxy
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(core.getServer("owned-1")?.name).toBe("renamed-sw"); // the update landed
      expect(vault.delete).not.toHaveBeenCalledWith(proxyPasswordSecretKey("owned-1")); // orphan KEPT
      expect(await vault.get(proxyPasswordSecretKey("owned-1"))).toBe("orphan-pw");
    });

    // -------- Codex round 12 (P1, SECURITY) — the fail-closed pre-apply clear must
    // scan the plan's ADDS as well as its updates. Deterministic server ids are
    // REUSED; a device delete-pruned with a FAILED best-effort proxy-password delete
    // can reappear as an ADD under the SAME id with the orphaned password still in
    // the vault. A template can add it with a NEW authenticated socks5/http endpoint,
    // and the first connect would send the orphan there. An add has no prior proxy,
    // so its `before` is treated as undefined → the round-11 EITHER-side rule fires
    // exactly when the add's proxy is password-bearing. --------

    // The id the ADD path mints for device:1 under src-1 — the same deterministic id
    // a prior delete-prune would have used, so an orphaned secret can sit under it.
    const addId = () => deterministicServerId("src-1", "device:1");

    it("(round 12, SECURITY — orphan on ADD) a sync that ADDS device:1 (empty repo) with a template socks5 proxy Y clears an ORPHANED proxy-password-{addId} BEFORE the apply publishes — otherwise the orphan (from an earlier delete-prune whose best-effort delete failed) is sent to Y (kills scanning only updates, never adds)", async () => {
      const repo = new InMemoryConfigRepository([]); // no owned server → device:1 is an ADD
      const core = new NexusCore(repo);
      await core.initialize();
      // The template assigns an authenticated socks5 endpoint Y to the fresh add.
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));

      const proxyKey = proxyPasswordSecretKey(addId());
      const callOrder: string[] = [];
      const store = new Map<string, string>([
        [proxyKey, "orphan-pw"], // relic of an earlier delete-prune whose best-effort delete failed
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      const vault = {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          if (k === proxyKey) callOrder.push("delete");
          store.delete(k);
        })
      };
      const applyReal = core.applyInventorySyncPlan.bind(core);
      vi.spyOn(core, "applyInventorySyncPlan").mockImplementation(async (application) => {
        callOrder.push("apply");
        return applyReal(application);
      });

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The add IS published with proxy Y...
      expect(core.getServer(addId())?.proxy).toEqual({ type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" });
      // ...but only AFTER the orphaned secret was deleted. Against 64ea893 the helper
      // scanned only updates → the add's orphan was never touched → order would be
      // ["apply"] and "orphan-pw" would survive to be sent to Y on the next connect.
      expect(callOrder).toEqual(["delete", "apply"]);
      expect(vault.delete).toHaveBeenCalledWith(proxyKey);
      expect(await vault.get(proxyKey)).toBeUndefined();
    });

    it("(round 12, SECURITY — orphan on ADD, delete fails CLOSED) a vault.delete throw for the add's orphaned proxy key ABORTS the sync (applyInventorySyncPlan never called, the add never published) and RESTORES the orphan", async () => {
      const repo = new InMemoryConfigRepository([]);
      const core = new NexusCore(repo);
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));

      const proxyKey = proxyPasswordSecretKey(addId());
      const store = new Map<string, string>([
        [proxyKey, "orphan-pw"],
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      const vault = {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          if (k === proxyKey) throw new Error("vault delete failed"); // throws WITHOUT mutating the store
          store.delete(k);
        })
      };
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // Fail closed: the add was never published — no server exists under the id.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getServer(addId())).toBeUndefined();
      // The captured orphan is restored (best-effort) so the pass is atomic.
      expect(vault.store).toHaveBeenCalledWith(proxyKey, "orphan-pw");
      expect(await vault.get(proxyKey)).toBe("orphan-pw");
      expect(mockShowErrorMessage).toHaveBeenCalled();
    });

    it("(round 12, SECURITY — no-op guard) an ADD with a socks5 proxy but NO stored secret under its id captures nothing (delete of the empty key is harmless, nothing is ever restored)", async () => {
      const repo = new InMemoryConfigRepository([]);
      const core = new NexusCore(repo);
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));

      const proxyKey = proxyPasswordSecretKey(addId());
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" }); // no proxy secret

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The add landed with proxy Y, and since there was no orphan to capture,
      // nothing was ever stored back into the proxy key.
      expect(core.getServer(addId())?.proxy).toEqual({ type: "socks5", host: "10.9.9.2", port: 1080, username: "puser" });
      expect(vault.store).not.toHaveBeenCalledWith(proxyKey, expect.anything());
    });

    it("(round 12, SECURITY — over-clear guard) an ADD with an SSH jump-host proxy leaves an orphaned proxy-password-{addId} ALONE — neither side is password-bearing, so an ssh proxy never sends it (a later template→socks change is the update path's job)", async () => {
      const bastion = makeServer({ id: "bastion-1", name: "bastion", host: "10.0.0.9", port: 22 }); // hand-added survivor
      const repo = new InMemoryConfigRepository([bastion]);
      const core = new NexusCore(repo);
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({
        id: "tmpl-1",
        name: "T",
        fields: { proxy: { mode: "override", value: { type: "ssh", jumpHostId: "bastion-1" } } }
      });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: vi.fn(async () => deviceMappingOwned1()) }));

      const proxyKey = proxyPasswordSecretKey(addId());
      const vault = makeVault({
        [proxyKey]: "orphan-pw", // orphan under what becomes an ssh-proxied add
        [inventorySecretKey("src-1", "apiToken")]: "tok"
      });

      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(core.getServer(addId())?.proxy).toEqual({ type: "ssh", jumpHostId: "bastion-1" }); // the add landed
      expect(vault.delete).not.toHaveBeenCalledWith(proxyKey); // orphan KEPT — ssh never sends it
      expect(await vault.get(proxyKey)).toBe("orphan-pw");
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
      // REVIEW FINDING 1 (P2, folder-GC ownership) — GC now only reclaims a
      // folder that appears in THIS source's own `managedFolders` (what its
      // own prior sync's `folders` list named); seed it here too, mirroring
      // the explicitGroups seed just above, so "Infra/RackA" is recognized
      // as this source's own abandoned folder rather than an unowned one
      // that a no-op/first sync would now correctly leave untouched.
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", prunePolicy: "orphan", managedFolders: ["Infra/RackA"] }));

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

      expect(mockShowWarningMessage).toHaveBeenCalledWith(BUSY_SYNC_FROM_SYNC);
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
        // REVIEW FINDING (P1, adoption instance identity) — the origin already
        // carries the instance this source's provider reports, because this test
        // needs the pre-removal plan to be genuinely EMPTY (see below) and a
        // missing instance stamp is a change the sync would write, i.e. an update
        // that takes syncNow off the fast path this test is about.
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, syncedInstanceKey: "fake://default" }
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

  describe("inventory source auth profile", () => {
    const LAB_PROFILE: AuthProfile = { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" };

    /** Lets a detached (`void (async () => …)()`) post-save toast settle. */
    const flushDetached = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    async function makeHarness(
      options: {
        servers?: ServerConfig[];
        profiles?: AuthProfile[];
        source?: Partial<InventorySourceConfig>;
        provider?: Partial<InventoryProvider>;
      } = {}
    ): Promise<{ core: NexusCore; provider: InventoryProvider; vault: ReturnType<typeof makeVault> }> {
      const core = new NexusCore(new InMemoryConfigRepository(options.servers ?? []));
      await core.initialize();
      for (const profile of options.profiles ?? []) {
        await core.addOrUpdateAuthProfile(profile);
      }
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider(options.provider);
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      if (options.source) {
        await core.addOrUpdateInventorySource(
          makeSource({ targetFolder: "Infra", secretFieldIds: ["apiToken"], config: { host: "netbox.local" }, ...options.source })
        );
      }
      return { core, provider, vault };
    }

    function ownedServer(overrides: Partial<ServerConfig> & { id: string; externalId: string }): ServerConfig {
      const { externalId, ...rest } = overrides;
      // username defaults to makeSource()'s defaultUsername ("admin"), NOT
      // makeServer()'s "netops": the retro-apply rule adopts only servers still
      // carrying everything the add path stamped, the source's default username
      // included. A server whose username differs reads as hand-edited and is
      // deliberately left alone — see the hand-edited-username test below.
      // REVIEW FINDING (P1, adoption instance identity) — `syncedInstanceKey`
      // matches what `makeProvider`'s `instanceKey` reports for `makeHarness`'s
      // source config (`host: "netbox.local"`), i.e. these servers are already
      // stamped with the deployment they were synced from. Omitting it would make
      // EVERY server in this block an update on every sync (the stamp would be
      // computed for the first time), which is a real behaviour — the backfill
      // for servers synced by an older build — but not the one these auth-profile
      // tests are about: it inflates the "N servers will be updated" counts they
      // assert on and takes the fast-path tests off the fast path.
      return makeServer({
        username: "admin",
        origin: { sourceId: "src-1", externalId, syncedAt: 1, syncedInstanceKey: "fake://netbox.local" },
        ...rest
      });
    }

    function modalCalls(): Array<[string, { detail: string }]> {
      return mockShowInformationMessage.mock.calls.filter(
        (call) => typeof call[1] === "object" && call[1] !== null && (call[1] as { modal?: boolean }).modal === true
      ) as Array<[string, { detail: string }]>;
    }

    it("addSource persists the selected Auth Profile id onto the source record (kills parseSourceFormValues / persistNewInventorySource dropping the field)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        authProfileId: "p1",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      // Without the parse+persist wiring this reads `undefined`: the select is
      // rendered, the user picks a profile, and Save silently discards it.
      expect(core.getSnapshot().inventorySources[0].authProfileId).toBe("p1");
    });

    it("the select's (None) option persists as undefined, never the raw empty string (kills storing \"\" as an id that then reads as a dangling reference)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        authProfileId: "",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      // A stored "" would fail validateInventorySource's non-empty-string
      // shape check, count as a config change against `undefined` in
      // sourceConfigUnchanged, and make computeSyncPlan warn about a dangling
      // profile on every single sync.
      expect(core.getSnapshot().inventorySources[0].authProfileId).toBeUndefined();
    });

    it("addSource refuses to save a profile deleted while the form sat open, and rolls back its vault write (kills persisting a dangling reference on the one path that has no record to revision-guard)", async () => {
      const { core, vault } = await makeHarness({ profiles: [LAB_PROFILE] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();

      // The profile the still-open form's select points at is deleted
      // elsewhere (AuthProfileEditorPanel -> NexusCore.removeAuthProfile).
      // Nothing references it yet, so removeAuthProfile clears nothing and
      // there is no record here to carry a bumped revision anyway.
      await core.removeAuthProfile("p1");

      await expect(
        onSubmit({
          name: "My NetBox",
          targetFolder: "Infra",
          authProfileId: "p1",
          defaultUsername: "labuser",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "secret-token"
        })
      ).rejects.toThrow(/The selected auth profile no longer exists/);

      // Without the pre-persist re-resolve the source IS created, carrying an
      // id that resolves to nothing — and every later sync of it silently
      // falls back to the default username with SSH agent auth.
      expect(core.getSnapshot().inventorySources).toEqual([]);

      // Vault-first means the API token was already written by the time the
      // rejection lands; with no source record to enumerate it, an un-rolled-
      // back key would be orphaned forever.
      const storedKey = vault.store.mock.calls.at(-1)?.[0] as string | undefined;
      expect(storedKey).toBeDefined();
      expect(await vault.get(storedKey!)).toBeUndefined();
    });

    it("editSource refuses to switch onto a profile deleted while the form sat open, even though the ITEM 4 revision guard cannot see it (kills leaning on removeAuthProfile's re-revisioning, which only touches sources ALREADY referencing the profile)", async () => {
      const otherProfile: AuthProfile = { id: "p2", name: "Other", username: "otheruser", authType: "password" };
      const { core, vault } = await makeHarness({ profiles: [LAB_PROFILE, otherProfile], source: { authProfileId: "p1" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();

      const revisionBefore = core.getInventorySource("src-1")!.revision;
      // p2 — the profile the user picked in the open form, which this source
      // is NOT yet linked to — is deleted elsewhere.
      await core.removeAuthProfile("p2");
      // Precisely why ITEM 4 can't catch this one: the source never referenced
      // p2, so removeAuthProfile leaves its revision (and every other field)
      // alone and the drift guard sees no drift at all.
      expect(core.getInventorySource("src-1")!.revision).toBe(revisionBefore);

      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          authProfileId: "p2",
          defaultUsername: "labuser",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "new-token"
        })
      ).rejects.toThrow(/The selected auth profile no longer exists/);

      // The record must be left exactly as the user last saved it — still on
      // p1. Neither switched to a dangling p2 nor silently cleared to (None):
      // both would hand this source's next sync the default username plus SSH
      // agent auth without ever saying so.
      expect(core.getInventorySource("src-1")?.authProfileId).toBe("p1");
      expect(core.getInventorySource("src-1")?.revision).toBe(revisionBefore);

      // This run's re-entered secret is restored to its pre-run value, same as
      // every other rejection inside this critical section.
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("tok");
    });

    it("a profile that still exists saves normally even when a DIFFERENT profile was just deleted (kills a re-check that rejects on any deletion, or that resolves against the option list captured when the form opened)", async () => {
      const otherProfile: AuthProfile = { id: "p2", name: "Other", username: "otheruser", authType: "password" };
      const { core } = await makeHarness({ profiles: [LAB_PROFILE, otherProfile] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();

      await core.removeAuthProfile("p2");

      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        authProfileId: "p1",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      expect(core.getSnapshot().inventorySources[0].authProfileId).toBe("p1");
    });

    it("clearing to (None) still saves when the profile the form offered has since been deleted (kills a re-check that fires on the empty selection instead of only on a chosen id)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE], source: {} });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();

      // Deleting a profile this source never referenced leaves its revision
      // untouched, so the ITEM 4 guard stays out of the way and the save
      // reaches the auth-profile re-check with `undefined` in hand.
      await core.removeAuthProfile("p1");

      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        authProfileId: "",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      // `undefined` is a deliberate answer, not a stale reference — a lookup
      // that skips the "was anything even chosen" guard resolves it to
      // "missing" and blocks a save the user is entitled to.
      expect(core.getInventorySource("src-1")?.authProfileId).toBeUndefined();
      await flushDetached();
      expect(mockShowInformationMessage.mock.calls.map((call) => call[0])).toEqual(['Inventory source "My Source" updated.']);
    });

    /**
     * REVIEW FINDING (P1) — the second reason a selected profile cannot be
     * honoured, refused by the same persist-time re-resolve as the first.
     *
     * A `key` profile with no key file is a shape the profile editor accepts on
     * purpose (it is the shared-passphrase, per-server-key-file pattern), but no
     * server an inventory sync produces can supply the missing half: the add
     * path writes `authType: "agent"` with no `keyPath`, and retro-apply adopts
     * only servers still carrying exactly that. The profile forces
     * `authType: "key"` at connect time, so `buildConnectConfig` rejects every
     * one of them with "Missing keyPath" — the fleet-wide unusability the whole
     * feature exists to end, arriving through the Auth Profile select.
     */
    const KEYLESS_KEY_PROFILE: AuthProfile = { id: "pk", name: "Shared Key", username: "keyuser", authType: "key" };
    // Pinned verbatim — this is the "Save failed: …" banner text.
    const KEYLESS_KEY_REJECTION =
      'The auth profile "Shared Key" uses private key authentication but has no key file. Servers synced from this source have no key of their own, so none of them could connect. Add a key file to that profile, or choose another.';

    it("addSource refuses to link a key profile that carries no key file, and rolls back its vault write (kills a persist-time check that only asks whether the profile still EXISTS)", async () => {
      const { core, vault } = await makeHarness({ profiles: [LAB_PROFILE, KEYLESS_KEY_PROFILE] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My NetBox",
          targetFolder: "Infra",
          authProfileId: "pk",
          defaultUsername: "keyuser",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "secret-token"
        })
      ).rejects.toThrow(KEYLESS_KEY_REJECTION);

      // The profile resolves perfectly well, so an existence-only check creates
      // this source — and every device it ever syncs arrives unable to connect.
      expect(core.getSnapshot().inventorySources).toEqual([]);
      // Same vault-first rollback the missing-profile rejection owes.
      const storedKey = vault.store.mock.calls.at(-1)?.[0] as string | undefined;
      expect(storedKey).toBeDefined();
      expect(await vault.get(storedKey!)).toBeUndefined();
    });

    it("editSource refuses to switch a source onto a key profile that carries no key file, leaving the record on its previous profile (kills covering only the add path)", async () => {
      const { core, vault } = await makeHarness({
        profiles: [LAB_PROFILE, KEYLESS_KEY_PROFILE],
        source: { authProfileId: "p1" }
      });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();

      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          authProfileId: "pk",
          defaultUsername: "keyuser",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "new-token"
        })
      ).rejects.toThrow(KEYLESS_KEY_REJECTION);

      expect(core.getInventorySource("src-1")?.authProfileId).toBe("p1");
      // This run's re-entered secret is restored, same as every other rejection
      // inside that critical section.
      expect(await vault.get(inventorySecretKey("src-1", "apiToken"))).toBe("tok");
    });

    it("a key profile that DOES carry a key file links normally (kills rejecting every key profile rather than the keyless ones)", async () => {
      const keyProfile: AuthProfile = { ...KEYLESS_KEY_PROFILE, keyPath: "/keys/id_ed25519" };
      const { core } = await makeHarness({ profiles: [LAB_PROFILE, keyProfile] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();

      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        authProfileId: "pk",
        defaultUsername: "keyuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      expect(core.getSnapshot().inventorySources[0].authProfileId).toBe("pk");
    });

    it("a source whose linked profile LOST its key file after linking syncs without stamping it — new servers connect, an already-working agent server is left alone, and the plan says why (kills relying on the form check alone, which no later profile edit passes through)", async () => {
      // The form check cannot govern this: the pairing was legal when it was
      // made. Only the engine sees the profile as it is at sync time.
      const { core } = await makeHarness({
        profiles: [KEYLESS_KEY_PROFILE],
        source: { targetFolder: "", authProfileId: "pk" },
        servers: [ownedServer({ id: "owned-1", externalId: "device:1", name: "sw1", host: "10.0.0.1" })],
        provider: {
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [
              { externalId: "device:1", name: "sw1", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] },
              { externalId: "device:2", name: "sw2", endpoints: [{ kind: "ssh" as const, host: "10.0.0.2", port: 22 }] }
            ]
          }))
        }
      });

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined); // the post-apply "N warnings" toast
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const added = core.getServer(deterministicServerId("src-1", "device:2"));
      expect(added?.authProfileId).toBeUndefined();
      expect(added?.authType).toBe("agent");
      // Retro-apply must not fire either: owned-1 is exactly the server the rule
      // adopts, and adopting it here would take a server that connects today and
      // make it unable to connect at all.
      expect(core.getServer("owned-1")?.authProfileId).toBeUndefined();
      expect(core.getServer("owned-1")?.authType).toBe("agent");

      const detail = modalCalls()[0][1].detail;
      expect(detail).not.toContain("will switch to auth profile");
      expect(detail).toContain("1 warning");
    });

    /**
     * REVIEW FINDING (P2) — the mirror that fills Default SSH Username from the
     * selected profile is an async webview round trip (onAutofill). Save can win
     * that race, and then the form posts the NEW authProfileId next to the
     * PREVIOUS defaultUsername. Every payload below reproduces exactly that:
     * `authProfileId: "p1"` (LAB_PROFILE, username "labuser") alongside the
     * stale "admin" the field still held.
     *
     * Both persist helpers used to write the posted username verbatim — the
     * existence re-check only proves the id resolves, never that the two agree —
     * leaving a linked source whose locked fallback username disagreed with its
     * own profile, invisibly (reopening the form re-renders the mirror, showing
     * the profile's username over a record holding a different one).
     */
    it("addSource stores the RESOLVED PROFILE's username as the fallback, not the stale one posted alongside it (kills persisting the submitted defaultUsername verbatim when Save beats the autofill round trip)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        authProfileId: "p1",
        defaultUsername: "admin", // stale — the mirror had not landed yet
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      const created = core.getSnapshot().inventorySources[0];
      expect(created.authProfileId).toBe("p1");
      expect(created.defaultUsername).toBe("labuser");
    });

    it("editSource stores the RESOLVED PROFILE's username too (kills fixing only the create path)", async () => {
      // Starts unlinked on "admin" — the state a user is in when they pick a
      // profile for the first time and click Save immediately.
      const { core } = await makeHarness({ profiles: [LAB_PROFILE], source: { defaultUsername: "admin" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        authProfileId: "p1",
        defaultUsername: "admin", // stale
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      const updated = core.getInventorySource("src-1")!;
      expect(updated.authProfileId).toBe("p1");
      expect(updated.defaultUsername).toBe("labuser");
    });

    it("an UNLINKED save keeps the username the user typed (kills a derivation that reaches past the `(None)` answer — e.g. to the previously linked profile — or blanks the field)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE], source: { authProfileId: "p1", defaultUsername: "labuser" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        authProfileId: "", // (None) — the field is unlocked and hand-typed again
        defaultUsername: "hand-typed",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      const updated = core.getInventorySource("src-1")!;
      expect(updated.authProfileId).toBeUndefined();
      expect(updated.defaultUsername).toBe("hand-typed");
    });

    it("a profile whose username is whitespace-only falls back to the submitted username when Save beats the mirror (kills storing an unusable/empty defaultUsername that validateInventorySource drops the whole record for)", async () => {
      // Only reachable through an imported backup: the profile editor trims and
      // refuses a blank username, but validateAuthProfile only checks length.
      //
      // This posts authProfileId next to a username the mirror never touched —
      // i.e. Save clicked before the autofill round trip returned, the same
      // race the two tests above cover. The mirror-completed path is covered
      // separately below (see the selection -> autofill -> submit tests), which
      // is what the form flow actually produces.
      const blankish: AuthProfile = { id: "p3", name: "Imported", username: "   ", authType: "agent" };
      const { core } = await makeHarness({ profiles: [blankish] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        authProfileId: "p3",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token"
      });

      const created = core.getSnapshot().inventorySources[0];
      expect(created.authProfileId).toBe("p3");
      // Neither the untrimmed "   " nor the "" a bare trim would produce: the
      // former is a username no SSH login can use, the latter fails
      // validateInventorySource and takes the whole record down at next load.
      expect(created.defaultUsername).toBe("admin");
    });

    /**
     * FINDING 2 (P2) — drives the path the USER drives, not the one the
     * persist helper happens to accept: pick a profile in the Auth Profile
     * select (`onAutofill`), let the mirror land on the form's fields exactly
     * as the webview's `fillFields` handler writes them (`el.value =
     * fillValues[fk]`, key by key, leaving untouched keys alone), then Save.
     *
     * Posting a hand-built payload straight into `onSubmit` cannot show
     * whether the form can produce that payload at all — which is the whole
     * defect here: the mirror used to write a whitespace username into a field
     * that is both required and, once linked, read-only, so
     * `parseSourceFormValues` rejected the save and the profile could not be
     * linked through the form no matter what the persist helper would have
     * done with it.
     */
    async function selectProfileThenSubmit(values: FormValues, profileId: string): Promise<void> {
      const { onAutofill, onSubmit } = latestFormCall();
      const mirrored = await onAutofill!("authProfileId", profileId);
      await onSubmit({ ...values, authProfileId: profileId, ...(mirrored ?? {}) });
    }

    const BASE_ADD_VALUES: FormValues = {
      name: "My NetBox",
      targetFolder: "Infra",
      defaultUsername: "admin",
      prunePolicy: "orphan",
      cfg_host: "netbox.local",
      cfg_apiToken: "secret-token"
    };

    it("(FINDING 2, P2) selecting an imported profile whose username is whitespace-only leaves the user's own username in the form, so the save the user drives actually goes through (kills a mirror that writes whitespace into the required, read-only field and makes the profile unlinkable)", async () => {
      const blankish: AuthProfile = { id: "p3", name: "Imported", username: "   ", authType: "agent" };
      const { core } = await makeHarness({ profiles: [blankish] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      // Mirroring "   " here makes this call REJECT with "Default SSH Username
      // is required" — the user's dead end, reproduced.
      await selectProfileThenSubmit(BASE_ADD_VALUES, "p3");

      const created = core.getSnapshot().inventorySources[0];
      expect(created.authProfileId).toBe("p3");
      expect(created.defaultUsername).toBe("admin");
    });

    it("(FINDING 2, P2) the same holds on the edit form (kills fixing only the add form's mirror)", async () => {
      const blankish: AuthProfile = { id: "p3", name: "Imported", username: "   ", authType: "agent" };
      const { core } = await makeHarness({ profiles: [blankish], source: { defaultUsername: "admin" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      await selectProfileThenSubmit(
        { name: "My Source", targetFolder: "Infra", defaultUsername: "admin", prunePolicy: "orphan", cfg_host: "netbox.local", cfg_apiToken: "" },
        "p3"
      );

      const updated = core.getInventorySource("src-1")!;
      expect(updated.authProfileId).toBe("p3");
      expect(updated.defaultUsername).toBe("admin");
    });

    it("(FINDING 2, P2) a blank-username profile still ANSWERS the autofill with an empty payload, while an id that resolves to nothing answers not at all (kills collapsing the two onto `undefined`, which suppresses the fillFields round trip and leaves the form's lock never re-evaluated)", async () => {
      const blankish: AuthProfile = { id: "p3", name: "Imported", username: "   ", authType: "agent" };
      await makeHarness({ profiles: [LAB_PROFILE, blankish] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onAutofill } = latestFormCall();

      // WebviewFormPanel posts `fillFields` for any truthy result and skips it
      // entirely for `undefined`; only the empty object re-runs the webview's
      // lock evaluation without writing a value.
      expect(await onAutofill!("authProfileId", "p3")).toEqual({});
      expect(await onAutofill!("authProfileId", "no-such-profile")).toBeUndefined();
    });

    it("(FINDING 2, P2) the mirror posts the profile's TRIMMED username, so what the field shows is what the record stores (kills mirroring a padded value the saved source then quietly disagrees with)", async () => {
      const padded: AuthProfile = { id: "p4", name: "Padded", username: "  labuser  ", authType: "agent" };
      const { core } = await makeHarness({ profiles: [padded] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onAutofill } = latestFormCall();
      expect(await onAutofill!("authProfileId", "p4")).toEqual({ defaultUsername: "labuser" });

      await selectProfileThenSubmit(BASE_ADD_VALUES, "p4");
      const created = core.getSnapshot().inventorySources[0];
      // fallbackUsernameForSource trims too, so an untrimmed mirror would show
      // "  labuser  " over a record holding "labuser".
      expect(created.defaultUsername).toBe("labuser");
    });

    /* ── the form the user actually sees, running its real script ─────────
     *
     * REVIEW FINDING (P2) — both defects below are "the form displayed one
     * thing and Save stored another", so neither end alone can see them: the
     * hand-built `onSubmit` payloads above prove what the persist helper does
     * with a submission, never that the form can produce that submission. These
     * open the REAL rendered form over the definition the command handed
     * WebviewFormPanel (`openForm`, test/helpers/formScriptHarness.ts), drive
     * it, and submit exactly what it posts into the command's own onSubmit —
     * so the oracle is the persisted record and the comparand is what the field
     * was showing.
     */
    it("Edit Source opens showing the LINKED PROFILE's current username, and an untouched Save stores exactly what it showed (kills seeding the field from the stored record: the profile's username is what fallbackUsernameForSource persists, so a profile renamed since the last save left the form displaying one username, locked, while Save quietly wrote another)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        // What the last save stored — the profile's username AT THAT TIME.
        source: { authProfileId: "p1", defaultUsername: "labuser" }
      });
      // …and the profile's username is changed afterwards, in the profile
      // editor, while the source record keeps the older fallback.
      await core.addOrUpdateAuthProfile({ ...LAB_PROFILE, username: "renamed-labuser" });

      await registeredCommands.get("nexus.inventory.editSource")!("src-1");
      const { definition, onSubmit } = latestFormCall();
      const harness = openForm(definition);

      // The field is locked, so this is the ONLY value the user could save.
      expect(harness.locked("defaultUsername")).toBe(true);
      expect(harness.value("defaultUsername")).toBe("renamed-labuser");

      await onSubmit(harness.submit());

      const updated = core.getInventorySource("src-1")!;
      expect(updated.authProfileId).toBe("p1");
      expect(updated.defaultUsername).toBe("renamed-labuser");
      // The invariant, stated directly: a locked field and the record behind it
      // cannot disagree.
      expect(updated.defaultUsername).toBe(harness.value("defaultUsername"));
    });

    it("and setting that same form back to (None) hands the SOURCE's stored fallback back, which is what Save then stores (kills rendering the profile's username without seeding the restore: unlinking would leave it in the unlocked field and the source would adopt the username of a profile it is no longer using)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { authProfileId: "p1", defaultUsername: "source-own-account" }
      });

      await registeredCommands.get("nexus.inventory.editSource")!("src-1");
      const { definition, onSubmit } = latestFormCall();
      const harness = openForm(definition);
      expect(harness.value("defaultUsername")).toBe("labuser");

      harness.choose("authProfileId", "");
      expect(harness.value("defaultUsername")).toBe("source-own-account");
      expect(harness.locked("defaultUsername")).toBe(false);

      await onSubmit(harness.submit());

      const updated = core.getInventorySource("src-1")!;
      expect(updated.authProfileId).toBeUndefined();
      expect(updated.defaultUsername).toBe("source-own-account");
    });

    it("discards an autofill answer that lands after the profile was deselected (kills applying a fillFields payload without checking which profile it describes: the release has already handed the source's own username back, and an unlinked save stores whatever the form submits)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { defaultUsername: "source-own-account" }
      });

      await registeredCommands.get("nexus.inventory.editSource")!("src-1");
      const { definition, onAutofill, onSubmit } = latestFormCall();
      const harness = openForm(definition);

      // The round trip is GATED, not raced: the request is posted…
      harness.choose("authProfileId", "p1");
      const requested = [...harness.posted].reverse().find((msg) => msg.type === "autofill");
      expect(requested?.type).toBe("autofill");
      const requestedId = requested!.type === "autofill" ? requested.value : "";
      // …the extension composes its real answer…
      const answer = await onAutofill!("authProfileId", requestedId);
      expect(answer).toEqual({ defaultUsername: "labuser" });
      // …the user reaches (None) before it can be delivered…
      harness.choose("authProfileId", "");
      // …and only now does it arrive, exactly as WebviewFormPanel posts it.
      harness.deliver({ type: "fillFields", key: "authProfileId", value: requestedId, values: answer! });

      expect(harness.value("defaultUsername")).toBe("source-own-account");
      expect(harness.locked("defaultUsername")).toBe(false);

      await onSubmit(harness.submit());

      const updated = core.getInventorySource("src-1")!;
      expect(updated.authProfileId).toBeUndefined();
      expect(updated.defaultUsername).toBe("source-own-account");
    });

    /* ── the profile moves while the form sits open ──────────────────────────
     *
     * REVIEW FINDING (P2) — `fallbackUsernameForSource` derives Default SSH
     * Username from the LIVE profile, so a username edited in the Auth Profile
     * Editor while a source form sits open is persisted without ever having
     * been on screen — in a field the profile had LOCKED, so the user could not
     * have corrected it. Nothing else catches it: a profile edit revises no
     * source record, so the edit path's ITEM 4 drift comparison passes
     * untouched and saving any unrelated field carries the new username in.
     *
     * The oracle in each of these is the PERSISTED SOURCE RECORD measured
     * against what the form was displaying — never the refusal on its own.
     */
    it("editSource refuses to save when the linked profile's username changed under the open form, and the record keeps the username the form is still showing (kills leaning on the ITEM 4 drift guard, which a profile edit never trips: renaming the source was enough to replace its fallback username with one no screen ever displayed)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { authProfileId: "p1", defaultUsername: "labuser" }
      });

      await registeredCommands.get("nexus.inventory.editSource")!("src-1");
      const { definition, onSubmit } = latestFormCall();
      const harness = openForm(definition);
      // What the user is looking at — and cannot edit, the profile owns it.
      expect(harness.locked("defaultUsername")).toBe(true);
      expect(harness.value("defaultUsername")).toBe("labuser");

      // The profile is edited elsewhere (AuthProfileEditorPanel) meanwhile.
      const revisionBefore = core.getInventorySource("src-1")!.revision;
      await core.addOrUpdateAuthProfile({ ...LAB_PROFILE, username: "svc-account" });
      // …which leaves the source record — revision included — untouched, so
      // there is no drift for the ITEM 4 comparison to find. This guard is the
      // only one that can see it.
      expect(core.getInventorySource("src-1")!.revision).toBe(revisionBefore);
      expect(core.getInventorySource("src-1")!.defaultUsername).toBe("labuser");

      // …and the user changes something else entirely, then saves.
      harness.type("name", "Renamed source");
      const failure = await onSubmit(harness.submit()).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );

      // THE ORACLE, asserted before the message: the persisted record against
      // what the field was showing. Unguarded this reads "svc-account" — the
      // username every server the source syncs is stamped with, and the one
      // they all fall back to if the profile is ever removed, chosen by nobody.
      const stored = core.getInventorySource("src-1")!;
      expect(stored.defaultUsername).toBe("labuser");
      expect(stored.defaultUsername).toBe(harness.value("defaultUsername"));
      // The unrelated edit does not ride in on the back of it either.
      expect(stored.name).toBe("My Source");
      // And the user is told which profile moved, and the one action that fixes it.
      expect(failure).toContain('The auth profile "Lab credentials" changed the username it supplies while this form was open');
      expect(failure).toContain("Re-select it in the Auth Profile list");
    });

    it("addSource refuses the same drift, on the path with no stored record to compare anything against (kills a guard that only the edit path carries: on Add, the mirror's answer is the ONLY account of what the form displayed)", async () => {
      const { core, vault } = await makeHarness({ profiles: [LAB_PROFILE] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onAutofill, onSubmit } = latestFormCall();
      // The user picks the profile and the mirror lands — "labuser", locked.
      const mirrored = await onAutofill!("authProfileId", "p1");
      expect(mirrored).toEqual({ defaultUsername: "labuser" });

      await core.addOrUpdateAuthProfile({ ...LAB_PROFILE, username: "svc-account" });

      const failure = await onSubmit({ ...BASE_ADD_VALUES, authProfileId: "p1", ...mirrored! }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );

      // Unguarded, the source IS created — holding "svc-account" behind a form
      // that showed "labuser".
      expect(core.getSnapshot().inventorySources.map((s) => s.defaultUsername)).toEqual([]);
      expect(failure).toContain("changed the username it supplies while this form was open");
      // And the vault-first write is rolled back, as every sibling refusal in
      // this critical section owes.
      const storedKey = vault.store.mock.calls.at(-1)?.[0] as string | undefined;
      expect(storedKey).toBeDefined();
      expect(await vault.get(storedKey!)).toBeUndefined();
    });

    it("addSource refuses when a profile that supplied NO username gains one under the open form, keeping the fallback the user typed (kills comparing only the two usernames a profile happens to have: the field was unlocked and holding the user's own value, and the save would have swapped the profile's in)", async () => {
      // Whitespace-only — reachable through an imported backup, and the one
      // shape that leaves Default SSH Username unlocked under a live link.
      const blankish: AuthProfile = { id: "p3", name: "Imported", username: "   ", authType: "agent" };
      const { core } = await makeHarness({ profiles: [blankish], servers: [makeServer({ username: "admin" })] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { definition, onAutofill, onSubmit } = latestFormCall();
      const harness = openForm(definition);
      harness.type("targetFolder", "Infra"); // an empty one asks for a second Save first
      harness.type("cfg_host", "netbox.local");
      harness.type("cfg_apiToken", "secret-token");

      harness.choose("authProfileId", "p3");
      const answer = await onAutofill!("authProfileId", "p3");
      harness.deliver({ type: "fillFields", key: "authProfileId", value: "p3", values: answer! });
      // The profile fills nothing, so this is the user's own fallback (seeded
      // from mostCommonUsername), still editable.
      expect(harness.locked("defaultUsername")).toBe(false);
      expect(harness.value("defaultUsername")).toBe("admin");

      // The imported profile is given a real username in the profile editor.
      await core.addOrUpdateAuthProfile({ ...blankish, username: "svc-account" });

      const failure = await onSubmit(harness.submit()).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );

      // Unguarded, `fallbackUsernameForSource` now prefers the profile's, and
      // the source is created on "svc-account" over the "admin" the user typed
      // and is still looking at.
      expect(core.getSnapshot().inventorySources.map((s) => s.defaultUsername)).toEqual([]);
      expect(failure).toContain('The auth profile "Imported" changed the username it supplies');
    });

    it("editSource refuses when the linked profile STOPS supplying a username, and re-selecting it — what the message asks for — clears the refusal (kills firing only where the live profile still has a username to compare: the field is left locked against a profile that no longer fills it, and only the re-select runs the release that could unlock it)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { authProfileId: "p1", defaultUsername: "labuser" }
      });

      await registeredCommands.get("nexus.inventory.editSource")!("src-1");
      const { definition, onAutofill, onSubmit } = latestFormCall();
      const harness = openForm(definition);
      expect(harness.locked("defaultUsername")).toBe(true);

      // A restored backup can carry a whitespace username (validateAuthProfile
      // only checks length); THE ONE RULE reads that as supplying none, so what
      // the locked field on screen claims about this profile is now false.
      await core.addOrUpdateAuthProfile({ ...LAB_PROFILE, username: "   " });

      await expect(onSubmit(harness.submit())).rejects.toThrow(/changed the username it supplies/);

      // Not a dead end: the one action the message names re-stamps what the
      // form is showing, and the same save then goes through.
      expect(await onAutofill!("authProfileId", "p1")).toEqual({});
      await onSubmit(harness.submit());

      const stored = core.getInventorySource("src-1")!;
      expect(stored.authProfileId).toBe("p1");
      // The profile supplies none, so the source keeps its own fallback — the
      // blank-profile branch of fallbackUsernameForSource, reached through the
      // form rather than through a raced mirror.
      expect(stored.defaultUsername).toBe("labuser");
    });

    it("a profile edit that changes nothing this save writes still saves (kills reusing the server form's authProfileOwnershipSignature here: a source record takes the profile's USERNAME and nothing else, so the authentication type that signature carries moving under the form is not drift and refusing it would refuse a correct save)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { authProfileId: "p1", defaultUsername: "labuser" }
      });

      await registeredCommands.get("nexus.inventory.editSource")!("src-1");
      const { definition, onSubmit } = latestFormCall();
      const harness = openForm(definition);
      expect(harness.value("defaultUsername")).toBe("labuser");

      // Renamed, and switched from password to SSH agent: a linked SOURCE
      // stores neither, so the form on screen still describes this save
      // exactly. (On the server form the same edit is drift — it decides which
      // credential control is rendered at all.)
      await core.addOrUpdateAuthProfile({ ...LAB_PROFILE, name: "Lab (agent)", authType: "agent" });

      harness.type("name", "Renamed source");
      await onSubmit(harness.submit());

      const stored = core.getInventorySource("src-1")!;
      expect(stored.name).toBe("Renamed source");
      expect(stored.authProfileId).toBe("p1");
      expect(stored.defaultUsername).toBe("labuser");
    });

    it("addSource wires inline auth-profile creation end to end and an autofill that mirrors ONLY defaultUsername (kills the server form's {username, authType, keyPath} payload, an unwired onAutofill, and a controller that is never attached to the panel)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE] });

      await registeredCommands.get("nexus.inventory.addSource")!();
      const { definition, onCreateInline, onAutofill, panel } = latestFormCall();

      // The form was built from the LIVE profile snapshot.
      const select = definition.fields.find((f) => "key" in f && f.key === "authProfileId") as
        | { options?: Array<{ value: string }> }
        | undefined;
      expect(select?.options?.map((o) => o.value)).toContain("p1");

      // toEqual, not toMatchObject: the server form's payload
      // ({ username, authType, keyPath }) must NOT be what this form returns —
      // none of those keys exist here, so mirroring them would silently do
      // nothing and leave Default SSH Username stale and unlocked.
      expect(await onAutofill!("authProfileId", "p1")).toEqual({ defaultUsername: "labuser" });
      expect(await onAutofill!("authProfileId", "no-such-profile")).toBeUndefined();

      // Inline creation round trip: the sentinel option opens the editor, and
      // the profile created there is injected back into the still-open form.
      // Both halves depend on attachPanel having been called — without it the
      // controller has no panel and handleCreateInline no-ops.
      onCreateInline!("authProfileId");
      expect(mockAuthProfileEditorOpenNew).toHaveBeenCalled();
      await core.addOrUpdateAuthProfile({ id: "p2", name: "Inline", username: "inline-user", authType: "agent" });
      expect(panel.addSelectOption).toHaveBeenCalledWith("authProfileId", "p2", expect.stringContaining("Inline"));
    });

    it("editSource wires the same inline creation and defaultUsername-only autofill (kills wiring only the add form)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE], source: { authProfileId: "p1" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { definition, onCreateInline, onAutofill, panel } = latestFormCall();

      const select = definition.fields.find((f) => "key" in f && f.key === "authProfileId") as
        | { value?: string; options?: Array<{ value: string }> }
        | undefined;
      expect(select?.value).toBe("p1");

      expect(await onAutofill!("authProfileId", "p1")).toEqual({ defaultUsername: "labuser" });

      onCreateInline!("authProfileId");
      expect(mockAuthProfileEditorOpenNew).toHaveBeenCalled();
      await core.addOrUpdateAuthProfile({ id: "p2", name: "Inline", username: "inline-user", authType: "agent" });
      expect(panel.addSelectOption).toHaveBeenCalledWith("authProfileId", "p2", expect.stringContaining("Inline"));
    });

    it("edit toast — setting a profile appends the switch sentence and offers Sync Now, which syncs THAT source (kills a suffix with no button and a button pointed at the wrong source)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE], source: {} });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();

      mockShowInformationMessage.mockResolvedValueOnce("Sync Now");
      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        authProfileId: "p1",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      expect(core.getInventorySource("src-1")?.authProfileId).toBe("p1");
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        'Inventory source "My Source" updated. Servers still on the sync default switch to it on the next sync.',
        "Sync Now"
      );
      await flushDetached();
      expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.inventory.syncNow", "src-1");
    });

    it("edit toast — switching from profile A to profile B promises only what the retro-apply rule actually does (kills \"Synced servers switch to the new auth profile\", which the very next sync contradicts with \"nothing to change\")", async () => {
      const otherProfile: AuthProfile = { id: "p2", name: "Other", username: "otheruser", authType: "password" };
      await makeHarness({ profiles: [LAB_PROFILE, otherProfile], source: { authProfileId: "p1" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();

      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        authProfileId: "p2",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      await flushDetached();
      // Servers already carrying A are never re-stamped (UX §4), so a sentence
      // saying "synced servers switch to the new auth profile" would be a
      // promise the next sync breaks. The shipped sentence is true here (only
      // servers still on the sync default move) and true on a first set.
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        'Inventory source "My Source" updated. Servers still on the sync default switch to it on the next sync.',
        "Sync Now"
      );
    });

    it("edit toast — re-saving the SAME profile adds no suffix and no Sync Now button (kills an unconditional suffix that advertises a sync changing nothing)", async () => {
      await makeHarness({ profiles: [LAB_PROFILE], source: { authProfileId: "p1" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();

      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        authProfileId: "p1",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      await flushDetached();
      expect(mockShowInformationMessage.mock.calls.map((call) => call[0])).toEqual(['Inventory source "My Source" updated.']);
      // A one-argument call is a buttonless toast; the suffix variant passes
      // "Sync Now" as a second argument.
      expect(mockShowInformationMessage.mock.calls[0]).toHaveLength(1);
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it("edit toast — clearing the profile to (None) adds no suffix and no Sync Now button (kills advertising a sync for a change the retro-apply rule deliberately never makes)", async () => {
      const { core } = await makeHarness({ profiles: [LAB_PROFILE], source: { authProfileId: "p1" } });

      await registeredCommands.get("nexus.inventory.editSource")!();
      const { onSubmit } = latestFormCall();

      await onSubmit({
        name: "My Source",
        targetFolder: "Infra",
        authProfileId: "",
        defaultUsername: "labuser",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: ""
      });

      // The clear itself must still persist — this is not a no-op save.
      expect(core.getInventorySource("src-1")?.authProfileId).toBeUndefined();
      await flushDetached();
      expect(mockShowInformationMessage.mock.calls.map((call) => call[0])).toEqual(['Inventory source "My Source" updated.']);
      expect(mockShowInformationMessage.mock.calls[0]).toHaveLength(1);
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it("the confirm modal counts ONLY the updates whose auth profile actually changes, on the line directly under \"N servers will be updated.\" (kills a missing line, a count taken from every update, and a line rendered somewhere else in the detail)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { targetFolder: "", authProfileId: "p1" },
        servers: [
          // Two servers on the untouched add-path default: name/host/port/group
          // already match their device exactly, so the retro-apply stamp is the
          // ONLY thing that can turn either into an update.
          ownedServer({ id: "owned-1", externalId: "device:1", name: "sw1", host: "10.0.0.1" }),
          ownedServer({ id: "owned-2", externalId: "device:2", name: "sw2", host: "10.0.0.2" }),
          // Hand-linked to another profile: an update (its name drifted) that
          // must NOT be counted as a switch.
          ownedServer({ id: "owned-3", externalId: "device:3", name: "stale-name", host: "10.0.0.3", authProfileId: "q" })
        ],
        provider: {
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [
              { externalId: "device:1", name: "sw1", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] },
              { externalId: "device:2", name: "sw2", endpoints: [{ kind: "ssh" as const, host: "10.0.0.2", port: 22 }] },
              { externalId: "device:3", name: "sw3", endpoints: [{ kind: "ssh" as const, host: "10.0.0.3", port: 22 }] }
            ]
          }))
        }
      });

      // Dismiss the modal — this test is only about what it says.
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const [, options] = modalCalls()[0];
      const lines = options.detail.split("\n");
      const updatedIndex = lines.indexOf("3 servers will be updated.");
      expect(updatedIndex).toBeGreaterThanOrEqual(0);
      expect(lines[updatedIndex + 1]).toBe('2 servers will switch to auth profile "Lab credentials".');
      // Nothing was applied — owned-3 keeps the profile it was hand-linked to.
      expect(core.getServer("owned-3")?.authProfileId).toBe("q");
    });

    it("the modal's Show Warnings buffer names EVERY switching server, not a sample, and the button is offered even when the plan has no other warning (kills a count-only disclosure a fleet-wide switch cannot be inspected from, and the count-plus-three-examples idiom that cannot answer 'is MY server in this list')", async () => {
      // Five, deliberately: more than the three a pushSkipSummary-style
      // "(e.g. …)" parenthetical would show, so a truncating implementation
      // visibly loses names here.
      const devices = [1, 2, 3, 4, 5].map((n) => ({
        externalId: `device:${n}`,
        name: `sw${n}`,
        endpoints: [{ kind: "ssh" as const, host: `10.0.0.${n}`, port: 22 }]
      }));
      await makeHarness({
        profiles: [LAB_PROFILE],
        source: { targetFolder: "", authProfileId: "p1" },
        // Five servers on the untouched add-path default: name/host/port/group
        // already match their device, so the retro-apply stamp is the only
        // thing turning any of them into an update.
        servers: devices.map((d, i) => ownedServer({ id: `owned-${i + 1}`, externalId: d.externalId, name: d.name, host: d.endpoints[0].host })),
        provider: { fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices })) }
      });

      mockShowInformationMessage.mockResolvedValueOnce("Show Warnings");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const modalCall = mockShowInformationMessage.mock.calls.find(
        (call) => typeof call[1] === "object" && call[1] !== null && (call[1] as { modal?: boolean }).modal === true
      )!;
      // This plan carries NO engine warnings, so a button keyed on
      // plan.warnings.length would be "Apply" alone and the names would be
      // unreachable in exactly the case they exist for.
      expect(modalCall.slice(2)).toEqual(["Apply", "Show Warnings"]);

      const [openArgs] = mockOpenTextDocument.mock.calls as Array<[{ content: string }]>;
      // Whole-buffer equality: a counted heading followed by one indented,
      // quoted name per switching server — ALL of them. A sampled rendering
      // ("(e.g. …)") fails on both the heading's shape and the two missing
      // names; a list that dropped the count fails on the heading.
      expect(openArgs[0].content).toBe(
        [
          '5 servers will switch to auth profile "Lab credentials":',
          '  "sw1"',
          '  "sw2"',
          '  "sw3"',
          '  "sw4"',
          '  "sw5"'
        ].join("\n")
      );
    });

    /**
     * REVIEW FINDING (P1) — the engine's AUTH 2b unlink, seen from the command
     * layer. It is a credential mutation on existing servers, so it travels the
     * same disclosure route as the adoption it reverses: a counted line in the
     * modal and every affected server named behind Show Warnings.
     *
     * The two `not.toContain` assertions are the point. Before the split, an
     * unlink satisfied `before.authProfileId !== after.authProfileId` and was
     * rendered by the SWITCH branch — the modal told the user their servers were
     * about to start using the very profile the plan was taking away from them.
     */
    function previouslyLinkedHarness(): Promise<{ core: NexusCore; provider: InventoryProvider; vault: ReturnType<typeof makeVault> }> {
      const devices = [1, 2].map((n) => ({
        externalId: `device:${n}`,
        name: `sw${n}`,
        endpoints: [{ kind: "ssh" as const, host: `10.0.0.${n}`, port: 22 }]
      }));
      return makeHarness({
        profiles: [KEYLESS_KEY_PROFILE],
        source: { targetFolder: "", authProfileId: "pk" },
        // Exactly what an earlier sync left behind while the profile still had a
        // key file: the link, plus the stamp recording that the SYNC made it.
        servers: devices.map((d, i) =>
          ownedServer({
            id: `owned-${i + 1}`,
            externalId: d.externalId,
            name: d.name,
            host: d.endpoints[0].host,
            authProfileId: "pk",
            origin: { sourceId: "src-1", externalId: d.externalId, syncedAt: 1, syncedAuthProfileId: "pk" }
          })
        ),
        provider: { fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices })) }
      });
    }

    it("(REVIEW FINDING, P1) the confirm modal discloses an UNLINK as an unlink, and Apply performs it (kills rendering it through the switch branch, which claims the opposite of what the plan does)", async () => {
      const { core } = await previouslyLinkedHarness();

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const [, options] = modalCalls()[0];
      expect(options.detail).toContain(
        '2 servers will stop using auth profile "Shared Key" and revert to their own stored credentials.'
      );
      expect(options.detail).not.toContain("will switch to");
      // And it is a real change, applied — not a line the modal renders about
      // nothing. Both halves of the record go: the link and the sync's stamp.
      expect(core.getServer("owned-1")?.authProfileId).toBeUndefined();
      expect(core.getServer("owned-2")?.authProfileId).toBeUndefined();
      expect(core.getServer("owned-1")?.origin?.syncedAuthProfileId).toBeUndefined();
    });

    it("(REVIEW FINDING, P1) Show Warnings names every server being unlinked, under its own heading (kills a count-only disclosure, and kills reusing the switch heading)", async () => {
      await previouslyLinkedHarness();

      mockShowInformationMessage.mockResolvedValueOnce("Show Warnings");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const [openArgs] = mockOpenTextDocument.mock.calls as Array<[{ content: string }]>;
      const lines = openArgs[0].content.split("\n");
      expect(lines).toContain('2 servers will stop using auth profile "Shared Key" and revert to their own stored credentials:');
      expect(lines).toContain('  "sw1"');
      expect(lines).toContain('  "sw2"');
      expect(openArgs[0].content).not.toContain("will switch to");
      // The engine's own explanation of WHY sits in the same buffer.
      expect(openArgs[0].content).toContain("uses private key authentication but has no key file");
    });

    it("describePlanDetail renders a NAMELESS switch line rather than none when the caller loses the profile name (kills the silent drop that would slip the stamps past the modal with no disclosure at all)", () => {
      function planWithSwitches(count: number): InventorySyncPlan {
        const updates = Array.from({ length: count }, (_, i) => {
          const before = ownedServer({ id: `owned-${i}`, externalId: `device:${i}`, name: `sw${i}` });
          return { before, after: { ...before, authProfileId: "p1" } };
        });
        return makeSyncPlan({ updates });
      }

      // Unreachable through syncNow — every call site pairs a plan with the
      // resolution it was computed from. It is the CONSISTENTLY broken future
      // caller this guards: no name to the modal render and none to either
      // drift render renders identical texts, so planDetailDrift sees no drift
      // and the stamps would apply with nothing said. The line has to survive
      // on its own.
      expect(describePlanDetail(planWithSwitches(2), [], undefined)).toContain("2 servers will switch to a different auth profile.");
      expect(describePlanDetail(planWithSwitches(1), [], undefined)).toContain("1 server will switch to a different auth profile.");
      // The named form is untouched by the fallback.
      expect(describePlanDetail(planWithSwitches(2), [], "Lab credentials")).toContain(
        '2 servers will switch to auth profile "Lab credentials".'
      );

      // REVIEW FINDING (P1) — the unlink line carries the same nameless
      // fallback, exercised directly for the same reason: it is unreachable
      // through syncNow (an unlink only happens for a profile that resolves, so
      // the name is always in hand), and a guard nobody can run is a guard
      // nobody can prove still works.
      function planWithClears(count: number): InventorySyncPlan {
        const plan = planWithSwitches(count);
        return {
          ...plan,
          updates: plan.updates.map((u) => ({ before: { ...u.before, authProfileId: "p1" }, after: { ...u.after, authProfileId: undefined } }))
        };
      }

      expect(describePlanDetail(planWithClears(2), [], undefined)).toContain(
        "2 servers will stop using their auth profile and revert to their own stored credentials."
      );
      expect(describePlanDetail(planWithClears(1), [], undefined)).toContain(
        "1 server will stop using their auth profile and revert to their own stored credentials."
      );
      // An unlink must never be rendered by the switch branch — that line claims
      // the opposite of what the plan does.
      expect(describePlanDetail(planWithClears(2), [], "Lab credentials")).not.toContain("will switch to");
    });

    // ROUND 8 (P1) — the switch/clear lines and the drift signature must name
    // the ACTUAL target each planned update writes (`after.authProfileId`), not
    // the single source-level profile. A catch-all template can set a profile B
    // that differs from the source's A, and the engine writes B.
    describe("Codex round 8 (P1) — the auth-switch line names each update's REAL target profile, not the source-level one", () => {
      const B_PROFILE: AuthProfile = { id: "p2", name: "Datacenter creds", username: "dcuser", authType: "password" };
      const C_PROFILE: AuthProfile = { id: "p3", name: "Edge creds", username: "edgeuser", authType: "password" };
      // Two distinct profile ids that resolve to the SAME display name — the case
      // only the target-id-in-signature guard can tell apart, not the text.
      const B_TWIN: AuthProfile = { id: "p2b", name: "Datacenter creds", username: "dcuser2", authType: "password" };
      const profilesById = new Map<string, AuthProfile>([
        ["p1", LAB_PROFILE],
        ["p2", B_PROFILE],
        ["p2b", B_TWIN],
        ["p3", C_PROFILE]
      ]);

      function switchTo(profileId: string | undefined, count: number): InventorySyncPlan {
        const updates = Array.from({ length: count }, (_, i) => {
          const before = ownedServer({ id: `owned-${i}`, externalId: `device:${i}`, name: `sw${i}` });
          return { before, after: { ...before, authProfileId: profileId } };
        });
        return makeSyncPlan({ updates });
      }

      it("names the template's target B, not the source-level A, when the plan writes B onto every switch (kills rendering the source's profile name)", () => {
        const detail = describePlanDetail(switchTo("p2", 2), [], undefined, profilesById);
        expect(detail).toContain('2 servers will switch to auth profile "Datacenter creds".');
        expect(detail).not.toContain("Lab credentials");
      });

      it("regression: source-level A with no template (every switch writes A) still names A", () => {
        expect(describePlanDetail(switchTo("p1", 1), [], undefined, profilesById)).toContain(
          '1 server will switch to auth profile "Lab credentials".'
        );
      });

      it("a target id that resolves to no profile renders the nameless fallback, and a mixed plan renders one line per distinct target", () => {
        expect(describePlanDetail(switchTo("gone", 1), [], undefined, profilesById)).toContain(
          "1 server will switch to a different auth profile."
        );
        // One switch to B, one to a dangling id → two lines: the named target and
        // the nameless fallback, one per distinct target.
        const before0 = ownedServer({ id: "owned-0", externalId: "device:0", name: "sw0" });
        const before1 = ownedServer({ id: "owned-1", externalId: "device:1", name: "sw1" });
        const mixed = makeSyncPlan({
          updates: [
            { before: before0, after: { ...before0, authProfileId: "p2" } },
            { before: before1, after: { ...before1, authProfileId: "gone" } }
          ]
        });
        const mixedDetail = describePlanDetail(mixed, [], undefined, profilesById);
        expect(mixedDetail).toContain('1 server will switch to auth profile "Datacenter creds".');
        expect(mixedDetail).toContain("1 server will switch to a different auth profile.");
      });

      it("the confirm modal (through syncNow) names the TEMPLATE'S target B, not the source's A — a catch-all override template on a source linked to A (kills the modal claiming 'switch to A' while the plan applies B)", async () => {
        const { core } = await makeHarness({
          profiles: [LAB_PROFILE, B_PROFILE],
          source: {
            targetFolder: "",
            authProfileId: "p1",
            templateRules: [{ id: "rule-1", templateId: "tmpl-1" }]
          },
          servers: [
            ownedServer({ id: "owned-1", externalId: "device:1", name: "sw1", host: "10.0.0.1" }),
            ownedServer({ id: "owned-2", externalId: "device:2", name: "sw2", host: "10.0.0.2" })
          ],
          provider: {
            fetchInventory: vi.fn(async () => ({
              contractVersion: 1,
              devices: [
                { externalId: "device:1", name: "sw1", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] },
                { externalId: "device:2", name: "sw2", endpoints: [{ kind: "ssh" as const, host: "10.0.0.2", port: 22 }] }
              ]
            }))
          }
        });
        // A catch-all template that OVERRIDES the auth link to B (p2), beating the
        // source-level A (p1) the servers would otherwise retro-apply.
        await core.addOrUpdateDeviceTemplate({
          id: "tmpl-1",
          name: "DC override",
          fields: { authProfileId: { mode: "override", value: "p2" } }
        });

        await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

        const [, options] = modalCalls()[0];
        expect(options.detail).toContain('2 servers will switch to auth profile "Datacenter creds".');
        // The now-wrong source-level name must NOT appear.
        expect(options.detail).not.toContain("Lab credentials");
      });

      it("planDetailDrift reports drift when the target changes B→C between renders, same count and same server ids (kills a signature that ignores the actual target — a B→C template change while the modal is open would evade drift)", () => {
        const planB = switchTo("p2", 2);
        const planC = switchTo("p3", 2); // same server ids, different target
        const shownDetail = describePlanDetail(planB, [], undefined, profilesById);
        const shown = {
          detail: shownDetail,
          deleteIds: new Set<string>(),
          authSwitchIds: authProfileSwitchIds(planB),
          adoptionPairs: adoptionPairKeys(planB)
        };
        expect(planDetailDrift(shown, planC, [], undefined, profilesById).drift).toBe(true);
        // Control: the SAME captured tuple re-based on planC's own signature does
        // not drift, so the assertion above is about the target change and nothing
        // incidental.
        const rebased = {
          detail: describePlanDetail(planC, [], undefined, profilesById),
          deleteIds: new Set<string>(),
          authSwitchIds: authProfileSwitchIds(planC),
          adoptionPairs: adoptionPairKeys(planC)
        };
        expect(planDetailDrift(rebased, planC, [], undefined, profilesById).drift).toBe(false);
      });

      it("planDetailDrift still catches a target change when the two profiles share a NAME (kills relying on the rendered text alone — the target ids are in the signature)", () => {
        const planB = switchTo("p2", 2);
        const planTwin = switchTo("p2b", 2); // distinct id, SAME name "Datacenter creds"
        // The rendered text is byte-identical — the non-vacuity check.
        expect(describePlanDetail(planTwin, [], undefined, profilesById)).toBe(
          describePlanDetail(planB, [], undefined, profilesById)
        );
        const shown = {
          detail: describePlanDetail(planB, [], undefined, profilesById),
          deleteIds: new Set<string>(),
          authSwitchIds: authProfileSwitchIds(planB),
          adoptionPairs: adoptionPairKeys(planB)
        };
        expect(planDetailDrift(shown, planTwin, [], undefined, profilesById).drift).toBe(true);
      });
    });

    it("syncNow retro-applies the source's profile to a server still on the bare agent default: the confirm modal appears (not the nothing-to-change fast path) and Apply stamps the link (kills a caller that never resolves/passes authProfile into computeSyncPlan)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { targetFolder: "", authProfileId: "p1" },
        servers: [ownedServer({ id: "owned-1", externalId: "device:1", name: "sw1", host: "10.0.0.1" })],
        provider: {
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [{ externalId: "device:1", name: "sw1", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] }]
          }))
        }
      });

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // Without the plumbing the plan is empty, syncNow takes the "nothing to
      // change" fast path, and no modal is ever shown.
      const shown = modalCalls();
      expect(shown).toHaveLength(1);
      expect(shown[0][1].detail).toContain("1 server will be updated.");
      expect(shown[0][1].detail).toContain('1 server will switch to auth profile "Lab credentials".');

      const updated = core.getServer("owned-1");
      expect(updated?.authProfileId).toBe("p1");
      // Linked, never copied: the record keeps its own credential fields —
      // the profile's own username is "labuser", which must NOT appear here.
      expect(updated?.authType).toBe("agent");
      expect(updated?.username).toBe("admin");
    });

    it("a profile renamed while the confirm modal is open re-confirms under the NEW name (kills resolving the profile once at sync start and reusing that name for the drift render)", async () => {
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE],
        source: { targetFolder: "", authProfileId: "p1" },
        servers: [ownedServer({ id: "owned-1", externalId: "device:1", name: "sw1", host: "10.0.0.1" })],
        provider: {
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [{ externalId: "device:1", name: "sw1", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] }]
          }))
        }
      });

      mockShowInformationMessage
        // The rename lands WHILE the first modal is open. It changes nothing
        // computeSyncPlan itself returns — same source, same servers, same
        // profile id, so the plan is byte-identical — only the name the modal
        // renders moves. A resolve-once implementation therefore sees no drift
        // and applies straight away under the stale name.
        .mockImplementationOnce(async () => {
          await core.addOrUpdateAuthProfile({ ...LAB_PROFILE, name: "Renamed" });
          return "Apply";
        })
        .mockResolvedValueOnce("Apply");

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modalCalls();
      expect(shown).toHaveLength(2);
      expect(shown[0][1].detail).toContain('1 server will switch to auth profile "Lab credentials".');
      expect(shown[1][1].detail).toContain('1 server will switch to auth profile "Renamed".');
      expect(core.getServer("owned-1")?.authProfileId).toBe("p1");
    });

    it("REVIEW FINDING (P2) — a mid-modal swap of WHICH server is eligible for retro-apply re-confirms, even though both plans render byte-identical detail and delete nothing (kills a drift check that compares only the rendered text and the delete-id set)", async () => {
      const otherProfile: AuthProfile = { id: "p2", name: "Other", username: "otheruser", authType: "password" };
      const { core } = await makeHarness({
        profiles: [LAB_PROFILE, otherProfile],
        source: { targetFolder: "", authProfileId: "p1" },
        servers: [
          // sw1 is eligible right now: no profile, agent auth, no key path,
          // still on the username the sync stamped.
          ownedServer({ id: "owned-1", externalId: "device:1", name: "sw1", host: "10.0.0.1" }),
          // sw2 is not: it already carries a link, which is a DECIDED state.
          ownedServer({ id: "owned-2", externalId: "device:2", name: "sw2", host: "10.0.0.2", authProfileId: "p2" })
        ],
        provider: {
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [
              { externalId: "device:1", name: "sw1", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] },
              { externalId: "device:2", name: "sw2", endpoints: [{ kind: "ssh" as const, host: "10.0.0.2", port: 22 }] }
            ]
          }))
        }
      });

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        // Both edits land WHILE the first modal is open, and they EXCHANGE the
        // two servers' eligibility rather than changing how many are eligible:
        // sw1 gains a hand-set link (decided — retro-apply must leave it), sw2
        // has its link cleared (indistinguishable from never-configured —
        // retro-apply adopts it). Every number describePlanDetail renders is
        // untouched: 0 added, 1 updated, 1 switching, 1 unchanged, 0 pruned, 0
        // warnings. Only the IDENTITY of the switching server moves — the very
        // thing the modal's Show Warnings buffer discloses by name.
        .mockImplementationOnce(async () => {
          await core.addOrUpdateServer({ ...core.getServer("owned-1")!, authProfileId: "p2" });
          await core.addOrUpdateServer({ ...core.getServer("owned-2")!, authProfileId: undefined });
          return "Apply";
        })
        .mockResolvedValueOnce(undefined); // cancel the reconfirmation modal

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modalCalls();
      expect(shown).toHaveLength(2);
      // THE FIXTURE'S NON-VACUITY, asserted rather than assumed: the two modals
      // are byte-identical, so nothing a text comparison can see has moved, and
      // neither plan deletes anything, so the delete-id set has not moved
      // either. Drift can only be detected from the switch-id set.
      expect(shown[1][1].detail).toBe(shown[0][1].detail);
      expect(shown[0][1].detail).toContain("1 server will be updated.");
      expect(shown[0][1].detail).toContain('1 server will switch to auth profile "Lab credentials".');
      expect(shown[0][1].detail).toContain("1 server is unchanged.");
      expect(shown[0][1].detail).not.toContain("will be deleted");

      // Without the switch-id comparison the fresh plan applies unseen and
      // stamps "Lab credentials" onto owned-2 — a server that never appeared in
      // the Show Warnings list behind the modal the user confirmed, which named
      // owned-1 and only owned-1.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getServer("owned-1")?.authProfileId).toBe("p2");
      expect(core.getServer("owned-2")?.authProfileId).toBeUndefined();
    });

    it("a dangling authProfileId surfaces the exact dangling-profile warning through the modal's Show Warnings buffer (kills a caller that fabricates a resolution for an id nothing resolves)", async () => {
      await makeHarness({
        source: { targetFolder: "", authProfileId: "ghost" },
        provider: {
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [{ externalId: "device:9", name: "new-sw", endpoints: [{ kind: "ssh" as const, host: "10.0.0.9", port: 22 }] }]
          }))
        }
      });

      mockShowInformationMessage.mockResolvedValueOnce("Show Warnings");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const [openArgs] = mockOpenTextDocument.mock.calls as Array<[{ content: string }]>;
      expect(openArgs[0].content).toContain(
        'The auth profile for "My Source" no longer exists — synced servers use the default username with SSH agent authentication. Edit the source to choose another profile.'
      );
    });

    it("a dangling authProfileId adds servers UNLINKED — the dead id is never stamped through as if it had resolved (kills passing source.authProfileId along without a live lookup)", async () => {
      const { core } = await makeHarness({
        source: { targetFolder: "", authProfileId: "ghost" },
        provider: {
          fetchInventory: vi.fn(async () => ({
            contractVersion: 1,
            devices: [{ externalId: "device:9", name: "new-sw", endpoints: [{ kind: "ssh" as const, host: "10.0.0.9", port: 22 }] }]
          }))
        }
      });

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      // The dangling warning also fires the post-apply "N warnings" toast.
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].authProfileId).toBeUndefined();
      // Pre-feature fallback, field for field.
      expect(servers[0].authType).toBe("agent");
      expect(servers[0].username).toBe("admin");
    });
  });

  // Adopt-on-add, command-layer half: the plan-preview line, the Show Warnings
  // pair list, and the adoption id-set the drift comparator captures.
  //
  // Driven with synthetic plans rather than through syncNow, deliberately: an
  // adoption is an ORDINARY `updates` entry — one whose `before` carries no
  // origin — and that is the entire contract these three renderers are written
  // against. Building it by hand is what lets the drift test below stage the one
  // case that matters (two plans that differ ONLY in which server they adopt),
  // which no fixture can produce through a fetch because both plans render the
  // same text by construction.
  describe("adopt-on-add rendering and drift", () => {
    // The canonical adoptee: a survivor of Remove Source → Keep Servers, i.e. a
    // record a removed inventory source synced and the user chose to keep, its
    // `origin` stripped by that removal. Deliberately skewed away from anything
    // this sync's add path could have produced — a name the user changed and the
    // device is about to overwrite, a hand-picked username, password auth — so a
    // renderer that reads a field off `after` where it owes the user `before`
    // shows up as one of these.
    //
    // It carries no marker field of its own here on purpose: nothing in the
    // command layer reads one. Eligibility is decided entirely inside
    // computeSyncPlan, and everything these three renderers need is already in
    // the update pair the engine emits.
    function keptServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
      return makeServer({
        id: "kept-1",
        name: "old-lab-switch",
        host: "10.0.0.11",
        port: 22,
        username: "handpicked",
        authType: "password",
        ...overrides
      });
    }

    /**
     * One adoption entry, in the shape computeSyncPlan produces: the adoptee's
     * own record (id and credentials intact) wearing the device's name and this
     * source's origin. `before.origin === undefined` is what makes it an
     * adoption rather than an ordinary update.
     */
    function adoption(
      before: ServerConfig,
      device: { name: string; externalId?: string }
    ): { before: ServerConfig; after: ServerConfig } {
      return {
        before,
        after: {
          ...before,
          name: device.name,
          origin: { sourceId: "src-1", externalId: device.externalId ?? "device:1", syncedAt: 1 }
        }
      };
    }

    /** An ORDINARY owned update — the population every adoption rendering must exclude. */
    function ownedUpdate(id: string, overrides: Partial<ServerConfig> = {}): { before: ServerConfig; after: ServerConfig } {
      const before = makeServer({
        id,
        name: `${id}-old`,
        host: "10.0.0.99",
        origin: { sourceId: "src-1", externalId: `device:${id}`, syncedAt: 1 }
      });
      return { before, after: { ...before, name: `${id}-new`, ...overrides } };
    }

    it("the preview annotates the adopted SUBSET of the updated servers, directly under the updates line and above the auth-switch line (kills rendering plan.updates.length — which would claim the source is taking over servers it already owns — and kills the annotation floating away from the line it qualifies)", () => {
      const plan = makeSyncPlan({
        updates: [
          adoption(keptServer(), { name: "core-sw-01" }),
          adoption(keptServer({ id: "kept-2", name: "spare-rtr", host: "10.0.0.12" }), {
            name: "core-sw-02",
            externalId: "device:2"
          }),
          // Owned, and simultaneously an auth switch: the third line of the
          // trio, so the ordering assertion below has all three to order.
          ownedUpdate("owned-1", { authProfileId: "p1" })
        ]
      });

      const detail = describePlanDetail(plan, [], "Lab credentials");
      const lines = detail.split("\n");
      const updatesLine = "3 servers will be updated.";
      // FUTURE tense, like every sibling line and like this plan's own pair-list
      // heading behind Show Warnings — the line used to read "are being
      // adopted", describing the plan as already in flight.
      const adoptionLine =
        "2 of the updated servers will be adopted by this source — they were kept from a removed inventory source, and they keep their saved credentials.";
      const switchLine = '1 server will switch to auth profile "Lab credentials".';

      expect(lines).toContain(updatesLine);
      // TWO of the three updates, not three: the count is the origin-less subset.
      expect(lines).toContain(adoptionLine);
      expect(lines).toContain(switchLine);
      // Directly under the line it qualifies — a subset annotation that has
      // drifted away from its parent line reads as an independent claim about
      // some other population.
      expect(lines.indexOf(adoptionLine)).toBe(lines.indexOf(updatesLine) + 1);
      // Above the auth-switch line, which can name the very same servers: the
      // ownership change first, then what it does to their credentials.
      expect(lines.indexOf(switchLine)).toBeGreaterThan(lines.indexOf(adoptionLine));
    });

    it("the adoption line is singular for one adopted server, drops the subset qualifier when there is no wider set, and is absent from a plan that adopts nothing (kills plural-only copy, kills '1 of the updated servers' over a lone update — which sends the reader looking for the others — and kills rendering it over ordinary owned updates or over the Add-Separately duplicates path)", () => {
      // The ONLY update in the plan: there is no subset to be part of, so the
      // line points at the line above it instead of counting into it.
      const lone = makeSyncPlan({ updates: [adoption(keptServer(), { name: "core-sw-01" })] });
      const loneLines = describePlanDetail(lone, [], undefined).split("\n");
      expect(loneLines).toContain("1 server will be updated.");
      expect(loneLines).toContain(
        "The updated server will be adopted by this source — it was kept from a removed inventory source, and it keeps its saved credentials."
      );

      // One adoption among several updates: the qualifier is back, because now
      // it is telling the user that the other update is not an adoption.
      const oneOfTwo = makeSyncPlan({ updates: [adoption(keptServer(), { name: "core-sw-01" }), ownedUpdate("owned-1")] });
      const oneOfTwoLines = describePlanDetail(oneOfTwo, [], undefined).split("\n");
      expect(oneOfTwoLines).toContain("2 servers will be updated.");
      expect(oneOfTwoLines).toContain(
        "1 of the updated servers will be adopted by this source — it was kept from a removed inventory source, and it keeps its saved credentials."
      );

      const ownedOnly = makeSyncPlan({ updates: [ownedUpdate("owned-1"), ownedUpdate("owned-2")] });
      const ownedDetail = describePlanDetail(ownedOnly, [], undefined);
      expect(ownedDetail).toContain("2 servers will be updated.");
      expect(ownedDetail).not.toContain("will be adopted by this source");

      // A plan that adopts nothing but does collide by address: the pre-existing
      // manual-duplicate line, unchanged by this feature and now describing a
      // wholly separate population (a hand-made server at the same address is
      // never adoptable). Its line renders; the adoption line must not.
      const declined = makeSyncPlan({
        adds: [makeServer({ id: "new-1", name: "core-sw-01", host: "10.0.0.11" })],
        manualDuplicateCount: 1
      });
      const declinedDetail = describePlanDetail(declined, [], undefined);
      expect(declinedDetail).toContain("1 device matches existing manual servers and will be added as duplicates.");
      expect(declinedDetail).not.toContain("will be adopted by this source");
    });

    it("an adoption whose username the inventory overwrites says so, and only then (kills the copy's silent overpromise: 'it keeps its saved credentials' while the engine writes the endpoint's username over a hand-picked one — unreachable with today's providers, reachable through the public provider API)", () => {
      // Two adoptions, one of which the endpoint supplies a username for. The
      // engine writes it (syncEngine.ts, and the comment there says why that is
      // right); the disclosure is what keeps the promise above it honest.
      const overwritten = adoption(keptServer(), { name: "core-sw-01" });
      const plan = makeSyncPlan({
        updates: [
          { before: overwritten.before, after: { ...overwritten.after, username: "netbox-svc" } },
          adoption(keptServer({ id: "kept-2", name: "spare-rtr", host: "10.0.0.12" }), { name: "core-sw-02", externalId: "device:2" })
        ]
      });

      const lines = describePlanDetail(plan, [], undefined).split("\n");
      const adoptionLine =
        "2 of the updated servers will be adopted by this source — they were kept from a removed inventory source, and they keep their saved credentials.";
      const usernameLine = "1 adopted server will also take the username the inventory reports, replacing the one stored on it.";
      expect(lines).toContain(adoptionLine);
      // ONE of the two, and directly under the promise it qualifies.
      expect(lines).toContain(usernameLine);
      expect(lines.indexOf(usernameLine)).toBe(lines.indexOf(adoptionLine) + 1);

      // The ordinary case — no endpoint username anywhere — says nothing extra.
      const untouched = makeSyncPlan({ updates: [adoption(keptServer(), { name: "core-sw-01" })] });
      expect(describePlanDetail(untouched, [], undefined)).not.toContain("take the username");
      // Nor does a plain owned update whose username the source rewrote: that
      // is not an adoption, and the promise this line qualifies was never made
      // about it.
      const ownedRename = makeSyncPlan({ updates: [ownedUpdate("owned-1", { username: "netbox-svc" })] });
      expect(describePlanDetail(ownedRename, [], undefined)).not.toContain("take the username");
    });

    it("Show Warnings names every adopted pair — the tree's name AND the device it is being reclaimed by, with the address that record will carry — and marks a hidden adoptee (kills a count-only disclosure, kills reading both names off `after` so a hand-rename goes invisible, kills a missing or stray (hidden) marker)", () => {
      const plan = makeSyncPlan({
        warnings: ["Device \"core-sw-03\" has no usable SSH endpoint."],
        updates: [
          // Renamed by hand: "old-lab-switch" is the only name the user can find
          // in their tree, and the only one an `after`-only list would drop.
          adoption(keptServer(), { name: "core-sw-01" }),
          adoption(keptServer({ id: "kept-2", name: "spare-rtr", host: "10.0.0.12", port: 2222, isHidden: true }), {
            name: "dist-rtr-01",
            externalId: "device:2"
          }),
          ownedUpdate("owned-1")
        ]
      });

      const buffer = planWarningsBuffer(plan, undefined);

      expect(buffer).toContain(
        "2 servers kept from a removed inventory source will be adopted by this source (each keeps its saved credentials):"
      );
      expect(buffer).toContain('  "old-lab-switch" — device "core-sw-01" (10.0.0.11:22)');
      expect(buffer).toContain('  "spare-rtr" — device "dist-rtr-01" (10.0.0.12:2222) (hidden)');
      // The visible one carries no marker, and the owned update is not a pair.
      expect(buffer).not.toContain('  "old-lab-switch" — device "core-sw-01" (10.0.0.11:22) (hidden)');
      expect(buffer.some((line) => line.includes("owned-1"))).toBe(false);
      // The engine's own warnings still lead the buffer.
      expect(buffer[0]).toBe("Device \"core-sw-03\" has no usable SSH endpoint.");
    });

    it("the pair list carries the singular heading and sits ABOVE the auth-switch list that names the same server (kills plural-only copy, and kills disclosing a credential change before the ownership change that causes it)", () => {
      // The same-plan retro-apply shape: adopted AND linked to the source's
      // profile, so this one server appears in both lists.
      const before = keptServer({ authType: "agent", username: "admin" });
      const adopted = adoption(before, { name: "core-sw-01" });
      const plan = makeSyncPlan({ updates: [{ before, after: { ...adopted.after, authProfileId: "p1" } }] });

      const buffer = planWarningsBuffer(plan, "Lab credentials");
      const headingIndex = buffer.indexOf(
        "1 server kept from a removed inventory source will be adopted by this source (it keeps its saved credentials):"
      );
      const switchIndex = buffer.indexOf('1 server will switch to auth profile "Lab credentials":');

      expect(headingIndex).toBeGreaterThanOrEqual(0);
      expect(switchIndex).toBeGreaterThan(headingIndex);
      expect(buffer).toContain('  "old-lab-switch" — device "core-sw-01" (10.0.0.11:22)');
      // The switch list's own line for the same server, still by its tree name.
      expect(buffer.indexOf('  "old-lab-switch"')).toBeGreaterThan(switchIndex);
    });

    it("a mid-modal swap of WHICH server is adopted drifts, though both plans render byte-identical detail and identical delete/auth-switch sets (kills a comparator without adoptionIds: the swapped-in server would be taken over — origin, prune policy, rename and all — under consent collected for a different record)", () => {
      const planFor = (id: string, name: string) =>
        makeSyncPlan({ updates: [adoption(keptServer({ id, name }), { name: "core-sw-01" })] });
      const planA = planFor("kept-A", "kept-a");
      const planB = planFor("kept-B", "kept-b");

      const detailA = describePlanDetail(planA, [], undefined);
      const detailB = describePlanDetail(planB, [], undefined);
      // THE non-vacuity assertion: the consent text the user actually reads
      // cannot tell these two plans apart, so the text comparison inside
      // planDetailDrift can never be what catches this.
      expect(detailB).toBe(detailA);

      // Neither plan deletes anything or moves any auth profile, so the two
      // pre-existing id-set comparisons are equal-to-equal as well.
      const shown = {
        detail: detailA,
        deleteIds: new Set<string>(),
        authSwitchIds: new Set<string>(),
        adoptionPairs: adoptionPairKeys(planA)
      };

      expect(planDetailDrift(shown, planB, [], undefined).drift).toBe(true);
      // Control — the SAME captured tuple with only the adoption pairs swapped
      // to planB's. If this also reported drift, the assertion above would prove
      // nothing about the adoption set.
      expect(planDetailDrift({ ...shown, adoptionPairs: adoptionPairKeys(planB) }, planB, [], undefined).drift).toBe(false);
    });

    it("a mid-modal swap of WHICH DEVICE adopts one server drifts, though both plans adopt THE SAME record, render byte-identical detail, and carry identical delete/auth-switch sets AND identical adoptee ids (kills a captured set of adoptee ids alone: consent names a PAIR — 'server X — device A' — and this swap re-points X at device B, renaming and re-addressing it onto a machine the user was never shown, while A quietly becomes an add)", () => {
      // One record, two claimants. A restore-from-backup landing while the
      // preview is open can rewrite kept-1's marker AND its address onto
      // device:2's endpoint, at which point device:2 adopts it and device:1
      // falls back to an add — the counts, and therefore every line of the
      // rendered detail, are unchanged.
      const planFor = (externalId: string, host: string) => {
        const before = keptServer({ host });
        return makeSyncPlan({
          updates: [{ before, after: { ...before, name: "core-sw-01", origin: { sourceId: "src-1", externalId, syncedAt: 1 } } }]
        });
      };
      const planA = planFor("device:1", "10.0.0.11");
      const planB = planFor("device:2", "10.0.0.12");

      const detailA = describePlanDetail(planA, [], undefined);
      expect(describePlanDetail(planB, [], undefined)).toBe(detailA);
      // THE non-vacuity assertion: the adoptee is the same record in both plans,
      // so a captured set of `before.id` — what this used to be — is equal to
      // equal and reports nothing. Only the device differs.
      expect(new Set(planA.updates.map((u) => u.before.id))).toEqual(new Set(planB.updates.map((u) => u.before.id)));
      expect(planA.updates[0].after.origin?.externalId).not.toBe(planB.updates[0].after.origin?.externalId);

      const shown = {
        detail: detailA,
        deleteIds: new Set<string>(),
        authSwitchIds: new Set<string>(),
        adoptionPairs: adoptionPairKeys(planA)
      };
      expect(planDetailDrift(shown, planB, [], undefined).drift).toBe(true);
      // Control, as above: with planB's own pairs captured there is no drift, so
      // the assertion above is about the pairing and nothing else.
      expect(planDetailDrift({ ...shown, adoptionPairs: adoptionPairKeys(planB) }, planB, [], undefined).drift).toBe(false);
    });

    it("the captured adoption keys are exactly the origin-less updates, each paired with the device claiming it (kills capturing every update, which would re-confirm on ordinary owned churn, and kills a key that carries only one half of the pair)", () => {
      const plan = makeSyncPlan({
        updates: [adoption(keptServer(), { name: "core-sw-01" }), ownedUpdate("owned-1"), ownedUpdate("owned-2")]
      });
      const [key] = [...adoptionPairKeys(plan)];
      expect(adoptionPairKeys(plan).size).toBe(1);
      // Both halves present, joined by a character the first half — a server id —
      // can never contain, so the boundary holds whatever a provider puts in an
      // externalId.
      expect(key.split("\u0000")).toEqual(["kept-1", "device:1"]);
      expect(adoptionPairKeys(makeSyncPlan({ updates: [ownedUpdate("owned-1")] })).size).toBe(0);
    });

    it("the captured CANDIDATE keys name a pairing exactly as the adopted-pair keys do — same key, same halves — so the question's captured consent and the preview's drift comparison can never disagree about what a pairing IS (kills a candidate capture keyed on the device name or on the adoptee alone, and kills reusing adoptionPairKeys for the question: an unanswered plan adopts nothing)", () => {
      const candidate = { deviceName: "core-sw-01", externalId: "device:1", serverId: "kept-1", separateAddBlocked: false };

      // An "adopt" run's plan carries BOTH shapes of the same fact: the
      // candidate the question was put about, and the update it became. Where
      // both are defined they must be the same set — that is what lets the two
      // guards compare different MOMENTS without ever disagreeing about the
      // thing they compare. The ordinary owned update is in here to prove the
      // candidate derivation is not just "every update" either.
      const adopting = makeSyncPlan({
        updates: [adoption(keptServer(), { name: "core-sw-01" }), ownedUpdate("owned-1")],
        adoptionCandidates: [candidate]
      });
      expect(adoptionCandidateKeys(adopting)).toEqual(adoptionPairKeys(adopting));

      const [key] = [...adoptionCandidateKeys(adopting)];
      // The DEVICE NAME is not part of the key, deliberately: it is what the
      // question renders, and two different candidate sets can carry identical
      // names (a replaced kept record still claimed by the same device). A key
      // built out of what was rendered would wave that swap through.
      expect(key).not.toContain("core-sw-01");

      // THE REASON THIS DERIVATION EXISTS. The plan the question is asked from
      // is computed before there is an answer, so it adopts nothing: the pair
      // set is empty exactly where the question needs a capture. Reusing
      // adoptionPairKeys there would capture the empty set and compare it
      // against every later plan's empty set — a guard that passes always.
      const unanswered = makeSyncPlan({ adoptionCandidates: [candidate] });
      expect(adoptionPairKeys(unanswered).size).toBe(0);
      expect(adoptionCandidateKeys(unanswered).size).toBe(1);
      expect(adoptionCandidateKeys(makeSyncPlan({ updates: [ownedUpdate("owned-1")] })).size).toBe(0);
    });
  });

  // Adopt-on-add, end to end: the question syncNow asks, the answer it threads
  // into every recompute of the run, and the "Keep Servers" marker without which
  // there would be nothing to adopt.
  //
  // THE TRAP THESE TESTS ARE BUILT AROUND: an adopted server and a
  // duplicate-added one look almost the same field by field, so every outcome
  // here is asserted on the server COUNT and the surviving ID. A fixture that
  // only checked "a server exists with the device's name" passes against the
  // very bug this feature exists to fix — the duplicate-add leaves the original
  // record sitting right next to the new one. The kept server is therefore
  // deliberately skewed away from anything the add path could mint: a
  // hand-chosen id, a name the user changed, password auth, a hand-picked
  // username.
  describe("adopt-on-add — the question, the answer, and the Keep Servers marker", () => {
    const DEVICE_1 = {
      externalId: "device:1",
      name: "core-sw-01",
      endpoints: [{ kind: "ssh" as const, host: "10.0.0.11", port: 22 }]
    };
    const DEVICE_2 = {
      externalId: "device:2",
      name: "dist-rtr-01",
      endpoints: [{ kind: "ssh" as const, host: "10.0.0.12", port: 22 }]
    };
    /** What the ADD path mints for DEVICE_1 under "src-1" — the id an adoption must NOT produce. */
    const ADD_PATH_ID = deterministicServerId("src-1", "device:1");

    // Count-correct: the title used to be plural over a single candidate.
    const QUESTION = 'Adopt 1 server kept from a removed inventory source into "My Source"?';
    const PREVIEW = 'Apply inventory sync from "My Source"?';
    const ADOPTION_LINE_SINGULAR =
      "The updated server will be adopted by this source — it was kept from a removed inventory source, and it keeps its saved credentials.";

    /**
     * REVIEW FINDING (P1, cross-instance adoption) — what `makeProvider`'s
     * `instanceKey` returns for a source built by `makeSource` (whose `config`
     * carries no `host`). Every marker below records it, so this block reads as
     * "one deployment throughout" unless a test says otherwise.
     */
    const DEFAULT_INSTANCE = "fake://default";

    /** The receipt "Keep Servers" leaves behind: this device, this provider, this INSTANCE of it, a source that is gone. */
    function keptMarker(overrides: Partial<NonNullable<ServerConfig["formerlySynced"]>> = {}): NonNullable<ServerConfig["formerlySynced"]> {
      return {
        sourceId: "old-src",
        sourceName: "My Source (removed)",
        providerId: "fake",
        instanceKey: DEFAULT_INSTANCE,
        externalId: "device:1",
        detachedAt: 900,
        ...overrides
      };
    }

    /** The canonical adoptee — kept from a previous sync of DEVICE_1, renamed by hand since. */
    function keptServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
      return makeServer({
        id: "kept-1",
        name: "old-lab-switch",
        host: "10.0.0.11",
        port: 22,
        username: "handpicked",
        authType: "password",
        formerlySynced: keptMarker(),
        ...overrides
      });
    }

    async function harness(
      options: {
        servers?: ServerConfig[];
        devices?: InventoryTree["devices"];
        sources?: Array<Partial<InventorySourceConfig>>;
        /** REVIEW FINDING (P1) — for the one test that needs a provider naming no instance at all. */
        provider?: Partial<InventoryProvider>;
        /** REVIEW FINDING (P2, detached auth opt-outs) — sources that carry a profile need it to actually resolve. */
        profiles?: AuthProfile[];
        /**
         * REVIEW FINDING (P1, re-ask when adoption candidates change) — a hook
         * called before each vault `get` resolves. The in-lock credential
         * re-check (syncNow's FINDING D block) is the last await before the
         * final recompute, and the only vault read that happens after the
         * preview has been answered — so a hook that waits for that answer lands
         * its edit inside that window on every run rather than usually racing it.
         */
        onSecretRead?: () => void | Promise<void>;
      } = {}
    ): Promise<{ core: NexusCore }> {
      const core = new NexusCore(new InMemoryConfigRepository(options.servers ?? [keptServer()]));
      await core.initialize();
      for (const profile of options.profiles ?? []) {
        await core.addOrUpdateAuthProfile(profile);
      }
      const registry = new InventoryProviderRegistry();
      registry.register(
        makeProvider({
          fetchInventory: vi.fn(async () => ({ contractVersion: 1, devices: options.devices ?? [DEVICE_1] })),
          ...options.provider
        })
      );
      const sources = options.sources ?? [{}];
      const vault = makeVault(Object.fromEntries(sources.map((s) => [inventorySecretKey(s.id ?? "src-1", "apiToken"), "tok"])));
      if (options.onSecretRead) {
        const hook = options.onSecretRead;
        const inner = vault.get;
        vault.get = vi.fn(async (key: string) => {
          await hook();
          return inner(key);
        });
      }
      registerInventoryCommands(core, registry, vault, makeTeardown());
      for (const overrides of sources) {
        await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"], ...overrides }));
      }
      return { core };
    }

    // Several tests below deliberately queue an answer the GUARDED run never
    // reaches — that is what lets them prove the unguarded run would have gone
    // on to apply. The root `vi.clearAllMocks()` does not drain a
    // `mockResolvedValueOnce` queue (it clears calls, not the implementation
    // queue), so an unconsumed answer would be handed to the next test's first
    // modal and quietly answer a question it was never written for.
    afterEach(() => {
      mockShowInformationMessage.mockReset();
    });

    /** Every MODAL showInformationMessage call, in order — the question and the preview(s), never the closing toasts. */
    function modals(): Array<[string, { detail: string }, ...string[]]> {
      return mockShowInformationMessage.mock.calls.filter(
        (call) => typeof call[1] === "object" && call[1] !== null && (call[1] as { modal?: boolean }).modal === true
      ) as Array<[string, { detail: string }, ...string[]]>;
    }

    it("Adopt Existing reclaims the kept record IN PLACE — one server afterwards, still `kept-1`, now owned by this source, credentials intact (kills the duplicate add this feature exists to remove, and kills an adoption that mints the add path's id)", async () => {
      const { core } = await harness();
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage.mockResolvedValueOnce("Adopt Existing").mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      // Exactly two: the question, then the preview. A third would mean a
      // recompute the answer never reached — the plan would have drifted
      // (adds↔updates) and the loop re-shown the modal.
      expect(shown).toHaveLength(2);

      expect(shown[0][0]).toBe(QUESTION);
      // EXACT, line by line, because every clause here is doing consent work:
      // the device name sits beside "1 device" (attached to "a server you kept"
      // it read as the SERVER's name — the one pairing the user cannot see yet);
      // the population is named the one way the whole feature names it; the
      // prune consequence is disclosed HERE, at the moment of the decision,
      // rather than arriving months later as an anonymous deletion count; and
      // Add Separately no longer promises adjacency the target folder breaks.
      expect(shown[0][1].detail.split("\n")).toEqual([
        '1 device ("core-sw-01") was previously synced onto a server you kept from a removed inventory source.',
        'Adopt Existing re-links that server to "My Source" instead of adding a copy — it keeps its saved credentials and settings, and this source takes over its name, address and folder from now on. This source\'s Removed-Device Policy applies to it too, so a source set to Delete removes it, and its saved credentials, if the device later disappears from the source.',
        "Add Separately leaves that server untouched and adds the device as a separate new server.",
        "Nothing changes until you choose Apply on the sync preview."
      ]);
      expect(shown[0].slice(2)).toEqual(["Adopt Existing", "Add Separately"]);

      // The preview describes an UPDATE, and says which population it is about.
      expect(shown[1][0]).toBe(PREVIEW);
      expect(shown[1][1].detail).toContain("1 server will be updated.");
      expect(shown[1][1].detail).toContain(ADOPTION_LINE_SINGULAR);
      expect(shown[1][1].detail).not.toContain("will be added");

      // THE PASS/FAIL LINE for the whole feature: one server, and it is the one
      // that was already there. A duplicate-add implementation leaves `kept-1`
      // untouched beside a second record — every field check below would then
      // pass against the WRONG server without these two assertions.
      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe("kept-1");
      expect(servers[0].id).not.toBe(ADD_PATH_ID);

      expect(servers[0].origin?.sourceId).toBe("src-1");
      expect(servers[0].origin?.externalId).toBe("device:1");
      // The source takes over the name; the credentials are not touched, and the
      // marker is spent (a now-owned server must stop advertising itself).
      expect(servers[0].name).toBe("core-sw-01");
      expect(servers[0].authType).toBe("password");
      expect(servers[0].username).toBe("handpicked");
      expect(servers[0].formerlySynced).toBeUndefined();
      expect(applySpy).toHaveBeenCalledTimes(1);
    });

    it("Add Separately adds the device beside the kept server and leaves it exactly as it was, marker included (kills an implementation that ignores the answer, and kills rendering the adoption line over a plan that adopts nothing)", async () => {
      const { core } = await harness();

      mockShowInformationMessage.mockResolvedValueOnce("Add Separately").mockResolvedValueOnce("Apply");
      // The address collision still warns, so the post-apply warnings toast fires.
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[1][1].detail).toContain("1 server will be added.");
      expect(shown[1][1].detail).toContain("1 device matches existing manual servers and will be added as duplicates.");
      expect(shown[1][1].detail).not.toContain("being adopted by this source");

      // Two servers, by id: the kept one and a brand-new one under the add
      // path's deterministic id. Declining is today's behavior, preserved.
      expect([...core.getSnapshot().servers].map((s) => s.id).sort()).toEqual(["kept-1", ADD_PATH_ID].sort());
      const kept = core.getServer("kept-1")!;
      expect(kept.origin).toBeUndefined();
      expect(kept.name).toBe("old-lab-switch");
      // The offer must still stand next run — declining once is not a decision
      // about every future sync.
      expect(kept.formerlySynced?.externalId).toBe("device:1");
    });

    it("a device whose kept server has MOVED raises no question — and the sync says so instead of duplicating in silence (kills gating that explanation on the adopt answer: this shape is never a candidate, so the question is never asked, so the answer can never be given — the pre-fix run produced a duplicate with no warning, no Show Warnings button, and nothing anywhere to explain it)", async () => {
      // The re-IP'd lab: the marker still names device:1, but the record was
      // re-addressed while the source was gone, so identity matches and
      // corroboration does not.
      const { core } = await harness({ servers: [keptServer({ host: "10.9.9.9" })] });
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage.mockResolvedValueOnce("Show Warnings");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      // No question: there is nothing adoption could take, so the preview is the
      // first thing the user sees.
      expect(shown).toHaveLength(1);
      expect(shown[0][0]).toBe(PREVIEW);
      // The button itself is the finding: the plan carries a warning at all.
      // Before the fix this run produced NO engine warning — the address no
      // longer collides, so not even the duplicate notice fired — and the modal
      // offered "Apply" alone.
      expect(shown[0].slice(2)).toEqual(["Apply", "Show Warnings"]);
      expect(shown[0][1].detail).toContain("1 warning — choose Show Warnings to review.");

      const [openArgs] = mockOpenTextDocument.mock.calls as Array<[{ content: string }]>;
      expect(openArgs[0].content.split("\n")).toContain(
        'Device "core-sw-01" was previously synced onto server "old-lab-switch", but that server is now at 10.9.9.9:22 and the device is at 10.0.0.11:22 — it will be added as a new server instead.'
      );
      // Reviewing is not consenting: nothing applied, the record untouched.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getServer("kept-1")?.name).toBe("old-lab-switch");
    });

    it("declining the question does NOT silence the refusal for a device the question never mentioned — the answer covers the servers it named, and only those (kills suppressing the refusals per-plan on Add Separately: the question counts CLEAN CANDIDATES, and neither shape that produces a refusal is one, so declining could only ever quiet devices the user was told nothing about)", async () => {
      // THE MIXED RUN, which is the only way `decline` and a refusal can meet:
      // device:1 is a clean candidate — that is what raises the question at all
      // — while device:2's kept server has moved, so it is the shape the
      // previous test explains and the question could not have covered it. The
      // user is shown "1 device (core-sw-01)" and answers about THAT.
      const { core } = await harness({
        devices: [DEVICE_1, DEVICE_2],
        servers: [
          keptServer(),
          keptServer({ id: "kept-2", name: "spare-rtr", host: "10.9.9.9", formerlySynced: keptMarker({ externalId: "device:2" }) })
        ]
      });
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage.mockResolvedValueOnce("Add Separately").mockResolvedValueOnce("Show Warnings");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[0][0]).toBe(QUESTION);
      // The question named ONE device — proof that dist-rtr-01 was never part of
      // what the user answered.
      expect(shown[0][1].detail).toContain('1 device ("core-sw-01")');
      // TWO warnings now: the duplicate notice for the device the user decided
      // about, and the explanation for the one they did not. The pre-fix run
      // rendered "1 warning" here and added dist-rtr-01 as an unexplained
      // duplicate.
      expect(shown[1][1].detail).toContain("2 warnings — choose Show Warnings to review.");
      const [openArgs] = mockOpenTextDocument.mock.calls as Array<[{ content: string }]>;
      const lines = openArgs[0].content.split("\n");
      expect(lines).toContain('Device "core-sw-01" matches existing server "old-lab-switch" (10.0.0.11:22) — will be added as a duplicate.');
      expect(lines).toContain(
        'Device "dist-rtr-01" was previously synced onto server "spare-rtr", but that server is now at 10.9.9.9:22 and the device is at 10.0.0.12:22 — it will be added as a new server instead.'
      );
      // The device the user DID answer about gets no adoption commentary — that
      // half of the old behaviour is right and stays.
      expect(lines.some((line) => line.includes("core-sw-01") && line.includes("previously synced onto"))).toBe(false);
      expect(applySpy).not.toHaveBeenCalled();
    });

    it("a declined run applies in ONE preview and leaves every kept record untouched, both the device the question named and the one it did not (kills treating a dismissal-shaped answer as Adopt, and kills a preview that drifts against the recompute under it — the modal would re-show until the mismatch cap aborted a sync nothing was wrong with)", async () => {
      const { core } = await harness({
        devices: [DEVICE_1, DEVICE_2],
        servers: [
          keptServer(),
          keptServer({ id: "kept-2", name: "spare-rtr", host: "10.9.9.9", formerlySynced: keptMarker({ externalId: "device:2" }) })
        ]
      });

      mockShowInformationMessage.mockResolvedValueOnce("Add Separately").mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // TWO modals: the question and ONE preview. A third means the plan the
      // preview rendered and the plan the in-lock recompute produced disagreed —
      // the drift comparator sends the user back through the same preview until
      // the mismatch cap aborts the run.
      expect(modals()).toHaveLength(2);
      // Both kept records untouched, both devices added beside them.
      expect([...core.getSnapshot().servers].map((s) => s.id).sort()).toEqual(
        ["kept-1", "kept-2", ADD_PATH_ID, deterministicServerId("src-1", "device:2")].sort()
      );
      expect(core.getServer("kept-1")?.origin).toBeUndefined();
      expect(core.getServer("kept-2")?.origin).toBeUndefined();
    });

    it("Esc on the question ABORTS the sync — no preview, nothing applied (kills defaulting a dismissal to either answer, which re-introduces the silent path the question exists to remove)", async () => {
      const { core } = await harness();
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // Exactly ONE modal: the question. Defaulting to "Add Separately" would
      // show the preview next (2 calls, then an add); defaulting to "Adopt
      // Existing" likewise, with the record taken over.
      expect(modals()).toHaveLength(1);
      expect(modals()[0][0]).toBe(QUESTION);
      expect(applySpy).not.toHaveBeenCalled();

      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe("kept-1");
      expect(servers[0].origin).toBeUndefined();
      expect(servers[0].name).toBe("old-lab-switch");
    });

    it("a server the user built by hand at the device's exact address raises NO question — the preview is the first thing shown (kills the rejected address-match design at the one place the user would meet it: hand-made servers must never be offered to a source)", async () => {
      const { core } = await harness({ servers: [keptServer({ formerlySynced: undefined })] });

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(1);
      expect(shown[0][0]).toBe(PREVIEW);
      // And the outcome is today's: a duplicate add, the user's record untouched.
      expect([...core.getSnapshot().servers].map((s) => s.id).sort()).toEqual(["kept-1", ADD_PATH_ID].sort());
      expect(core.getServer("kept-1")?.name).toBe("old-lab-switch");
    });

    it("a marker left by a DIFFERENT provider's source raises no question either (kills a provider-blind marker lookup — externalId is provider-scoped, so two products' \"device:1\" are different machines)", async () => {
      const { core } = await harness({
        servers: [keptServer({ formerlySynced: keptMarker({ providerId: "some-other-provider" }) })]
      });

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(1);
      expect(shown[0][0]).toBe(PREVIEW);
      expect(core.getSnapshot().servers).toHaveLength(2);
    });

    it("the answer reaches the recomputes inside the retry loop: a plan that drifts mid-preview is RE-SHOWN still adopting, and applies as an adoption (kills a recompute computed without the flag — the preview would flip back to an add, and the run would loop to the mismatch cap instead of applying)", async () => {
      const { core } = await harness({ devices: [DEVICE_1, DEVICE_2] });

      mockShowInformationMessage
        .mockResolvedValueOnce("Adopt Existing")
        // Lands WHILE the first preview is open, and drifts the plan by a route
        // that has nothing to do with adoption: a hand-added server appears at
        // DEVICE_2's address, so the manual-duplicate line joins the detail.
        // That forces the loop around a second time — which is the only way to
        // observe what the in-lock recompute actually computed.
        .mockImplementationOnce(async () => {
          await core.addOrUpdateServer(makeServer({ id: "manual-2", name: "hand-made", host: "10.0.0.12", port: 22 }));
          return "Apply";
        })
        .mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(3);
      expect(shown[0][0]).toBe(QUESTION);
      // The re-shown preview carries the new duplicate line (proving the loop
      // really went round) AND still adopts (proving the answer survived into
      // the recompute that produced it).
      expect(shown[2][1].detail).toContain("1 device matches existing manual servers and will be added as duplicates.");
      expect(shown[2][1].detail).toContain(ADOPTION_LINE_SINGULAR);
      expect(shown[2][1].detail).toContain("1 server will be updated.");

      // Three servers: the reclaimed record (its own id), the new one for
      // DEVICE_2, and the hand-added server that caused the drift. A flag-less
      // recompute applies FOUR — `kept-1` untouched beside two adds.
      const servers = core.getSnapshot().servers;
      expect([...servers].map((s) => s.id).sort()).toEqual(["kept-1", "manual-2", deterministicServerId("src-1", "device:2")].sort());
      expect(core.getServer("kept-1")?.origin?.sourceId).toBe("src-1");
      expect(core.getServer("kept-1")?.name).toBe("core-sw-01");
    });

    it("Show Warnings names every adopted pair by BOTH names, and is offered even though the adopting plan carries no engine warning at all (kills a count-only disclosure of an ownership change, and kills keying the button on plan.warnings)", async () => {
      const { core } = await harness({
        devices: [DEVICE_1, DEVICE_2],
        servers: [
          keptServer(),
          keptServer({
            id: "kept-2",
            name: "spare-rtr",
            host: "10.0.0.12",
            isHidden: true,
            formerlySynced: keptMarker({ externalId: "device:2" })
          })
        ]
      });
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage.mockResolvedValueOnce("Adopt Existing").mockResolvedValueOnce("Show Warnings");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(2);
      // The plural question, count-correct in the title and carrying the same
      // prune disclosure the singular one does — the two are written out
      // separately, so both have to be pinned.
      expect(shown[0][0]).toBe('Adopt 2 servers kept from a removed inventory source into "My Source"?');
      expect(shown[0][1].detail.split("\n")).toEqual([
        '2 devices (e.g. "core-sw-01", "dist-rtr-01") were previously synced onto servers you kept from a removed inventory source.',
        'Adopt Existing re-links those servers to "My Source" instead of adding copies — each keeps its saved credentials and settings, and this source takes over its name, address and folder from now on. This source\'s Removed-Device Policy applies to them too, so a source set to Delete removes any one of them, and its saved credentials, if its device later disappears from the source.',
        "Add Separately leaves those servers untouched and adds each device as a separate new server.",
        "Nothing changes until you choose Apply on the sync preview."
      ]);
      // Both devices adopt, so the plan has NO engine warnings — a button keyed
      // on plan.warnings.length would be "Apply" alone and the pair list would
      // be unreachable in exactly the case it exists for.
      expect(shown[1].slice(2)).toEqual(["Apply", "Show Warnings"]);

      const [openArgs] = mockOpenTextDocument.mock.calls as Array<[{ content: string }]>;
      const lines = openArgs[0].content.split("\n");
      expect(lines).toContain("2 servers kept from a removed inventory source will be adopted by this source (each keeps its saved credentials):");
      // The tree name FIRST: "old-lab-switch" is the only name the user can
      // find today, and the only one an `after`-only list would drop.
      expect(lines).toContain('  "old-lab-switch" — device "core-sw-01" (10.0.0.11:22)');
      expect(lines).toContain('  "spare-rtr" — device "dist-rtr-01" (10.0.0.12:22) (hidden)');
      expect(lines).not.toContain('  "old-lab-switch" — device "core-sw-01" (10.0.0.11:22) (hidden)');

      // Show Warnings ends the command — reviewing is not consenting.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getServer("kept-1")?.origin).toBeUndefined();
    });

    it("Remove Source → Keep Servers stamps each kept server with the device IT was mapped to (kills the strip-only removal that makes re-adding the source duplicate the whole fleet, and kills a stamp that copies one device's id onto every record)", async () => {
      const { core } = await harness({
        servers: [
          makeServer({
            id: "owned-1",
            name: "sw1",
            host: "10.0.0.11",
            origin: { sourceId: "src-1", externalId: "device:7", syncedAt: 1, syncedInstanceKey: DEFAULT_INSTANCE }
          }),
          makeServer({
            id: "owned-2",
            name: "sw2",
            host: "10.0.0.12",
            origin: { sourceId: "src-1", externalId: "device:8", syncedAt: 1, syncedInstanceKey: DEFAULT_INSTANCE }
          })
        ]
      });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");

      const first = core.getServer("owned-1")!;
      // The strip is unchanged — that half stays non-negotiable.
      expect(first.origin).toBeUndefined();
      expect(first.formerlySynced).toEqual({
        sourceId: "src-1",
        sourceName: "My Source",
        providerId: "fake",
        // REVIEW FINDING (P1, cross-instance adoption), fed by REVIEW FINDING
        // (P1, the instance guard fed from the wrong place) — copied off each
        // server's own `origin.syncedInstanceKey`, which is the only record of
        // the deployment its `externalId` came from once `source.config` is
        // deleted with the source a line later. `toEqual` (not a subset check) is
        // what makes an omission visible here.
        instanceKey: DEFAULT_INSTANCE,
        externalId: "device:7",
        detachedAt: expect.any(Number)
      });
      // Per-server, from that server's OWN origin.
      expect(core.getServer("owned-2")?.formerlySynced?.externalId).toBe("device:8");
      expect(core.getServer("owned-2")?.origin).toBeUndefined();
    });

    it("ROUND TRIP — Keep Servers, hand-rename, re-add the source under a new id: the same record is offered and reclaimed, never duplicated (kills a marker written in a shape the sync engine cannot match, which every isolated half of this feature would still pass)", async () => {
      const { core } = await harness({
        servers: [
          makeServer({
            id: "owned-1",
            name: "core-sw-01",
            host: "10.0.0.11",
            port: 22,
            username: "labuser",
            authType: "password",
            // Synced from netbox-a, which is what the removal copies into the
            // marker and what makes src-2 (pointed at the same deployment)
            // eligible to reclaim it.
            origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, syncedInstanceKey: "fake://netbox-a" }
          })
        ],
        // Both incarnations exist from the start; the removal below takes the
        // first one out, exactly as re-adding after a removal would.
        //
        // REVIEW FINDING (P1, cross-instance adoption) — both are pointed at the
        // SAME deployment, spelled out rather than left to the fixture default,
        // because that is now the thing making this round trip work: the source
        // id changes (src-1 -> src-2) and the instance key does not, which is
        // exactly the asymmetry the feature depends on.
        sources: [
          { config: { host: "netbox-a" } },
          { id: "src-2", name: "My Source B", config: { host: "netbox-a" } }
        ]
      });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");
      // Renamed by hand while unmanaged — so "the device's name is back" is an
      // observable consequence of the adoption rather than a coincidence.
      await core.addOrUpdateServer({ ...core.getServer("owned-1")!, name: "renamed-by-hand" });

      mockShowInformationMessage.mockResolvedValueOnce("Adopt Existing").mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-2");

      const shown = modals();
      expect(shown).toHaveLength(2);
      // The marker written by the removal above is what raises this question at
      // all: written wrong (or not at all), call 0 is the preview and this fails.
      expect(shown[0][0]).toBe('Adopt 1 server kept from a removed inventory source into "My Source B"?');
      expect(shown[0][1].detail).toContain('1 device ("core-sw-01")');

      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe("owned-1");
      expect(servers[0].id).not.toBe(deterministicServerId("src-2", "device:1"));
      expect(servers[0].origin?.sourceId).toBe("src-2");
      expect(servers[0].name).toBe("core-sw-01");
      expect(servers[0].formerlySynced).toBeUndefined();
    });

    it("CROSS-INSTANCE ROUND TRIP — a second deployment of the SAME provider is never offered the first one's kept server, and never takes it (kills the providerId-only identity check end to end: the marker, the question and the apply all agree)", async () => {
      // The whole reported scenario, driven through the real commands: a lab
      // instance beside a production one. Both are "fake" providers, both report
      // "device:1", and the kept record sits at exactly the address the second
      // instance's device reports — the coincidence a homelab reproduces on the
      // first try, since NetBox numbers devices from 1 and 10.0.0.11 is nobody's
      // idea of a unique address.
      const { core } = await harness({
        sources: [
          { config: { host: "netbox-prod" } },
          { id: "src-2", name: "Lab NetBox", config: { host: "netbox-lab" } }
        ],
        servers: [
          makeServer({
            id: "owned-1",
            name: "core-sw-01",
            host: "10.0.0.11",
            port: 22,
            username: "labuser",
            authType: "password",
            // Synced from production, recorded on the record itself.
            origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, syncedInstanceKey: "fake://netbox-prod" }
          })
        ]
      });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");
      // The marker records WHICH deployment kept it — this is what the sync
      // below has to disagree with.
      expect(core.getServer("owned-1")?.formerlySynced?.instanceKey).toBe("fake://netbox-prod");

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");
      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-2");

      const shown = modals();
      // ONE modal, and it is the preview: the question is never raised, because
      // a question the user answers "Adopt" to is a transfer as surely as a
      // silent one — the modal cannot say which deployment the record came from.
      expect(shown).toHaveLength(1);
      expect(shown[0][0]).toBe('Apply inventory sync from "Lab NetBox"?');
      expect(shown[0][1].detail).not.toContain("adopted by this source");

      // Two servers: the untouched record kept from production, and the lab
      // instance's own new one. The pre-fix build applied ONE — `owned-1`
      // re-homed onto src-2, at which point the lab source's Removed-Device
      // Policy governed a production server and its saved credentials.
      const servers = core.getSnapshot().servers;
      expect([...servers].map((s) => s.id).sort()).toEqual(["owned-1", deterministicServerId("src-2", "device:1")].sort());
      const keptFromProd = core.getServer("owned-1")!;
      expect(keptFromProd.origin).toBeUndefined();
      expect(keptFromProd.username).toBe("labuser");
      expect(keptFromProd.formerlySynced?.instanceKey).toBe("fake://netbox-prod");
      expect(applySpy).toHaveBeenCalledTimes(1);
    });

    it("REPOINTED-BEFORE-REMOVAL — a source edited to point at a SECOND deployment and then removed with Keep Servers stamps the deployment its servers were actually SYNCED from, and a source at the second deployment does not adopt them (kills deriving the marker from the source's current config, which hands the servers of instance A to a source of instance B — the instance guard fed from the wrong place)", async () => {
      // THE WINDOW THIS LIVES IN: Edit Source can be repointed at any time, and
      // until a sync against the new deployment succeeds the owned servers'
      // externalIds are still the OLD deployment's. Removing in that window used
      // to stamp every marker with the new deployment's key, so the instance
      // guard — real, and correct as written — was simply fed the wrong value.
      const { core } = await harness({
        sources: [
          { config: { host: "netbox-a" } },
          { id: "src-2", name: "Lab NetBox", config: { host: "netbox-b" } }
        ],
        servers: [
          makeServer({
            id: "owned-1",
            name: "core-sw-01",
            host: "10.0.0.11",
            port: 22,
            username: "prod-account",
            authType: "password",
            // What a real sync against netbox-a stamped: device:1 is netbox-a's
            // device:1, and this is the only record of that fact.
            origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, syncedInstanceKey: "fake://netbox-a" }
          })
        ]
      });

      // The repoint. No sync follows it — that is the entire point.
      const repointed = core.getInventorySource("src-1")!;
      await core.addOrUpdateInventorySource({ ...repointed, config: { host: "netbox-b" } });
      expect(core.getInventorySource("src-1")?.config).toEqual({ host: "netbox-b" });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");

      // THE KILLER ASSERTION. A build that re-derives from `source.config` writes
      // "fake://netbox-b" here, and every consequence below follows from it.
      expect(core.getServer("owned-1")?.formerlySynced?.instanceKey).toBe("fake://netbox-a");
      expect(core.getServer("owned-1")?.formerlySynced?.instanceKey).not.toBe("fake://netbox-b");

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");
      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-2");

      // ONE modal, and it is the preview: the netbox-b source is never even
      // OFFERED the netbox-a record, because an adoption the user approves is as
      // much a transfer as a silent one.
      const shown = modals();
      expect(shown).toHaveLength(1);
      expect(shown[0][0]).toBe('Apply inventory sync from "Lab NetBox"?');
      expect(shown[0][1].detail).not.toContain("adopted by this source");

      // Two servers: the untouched netbox-a record and netbox-b's own new one.
      // The pre-fix build applied ONE — owned-1 re-homed onto src-2, after which
      // the lab source's Removed-Device Policy governed a production server and
      // its saved credentials.
      const servers = core.getSnapshot().servers;
      expect([...servers].map((s) => s.id).sort()).toEqual(["owned-1", deterministicServerId("src-2", "device:1")].sort());
      const keptFromA = core.getServer("owned-1")!;
      expect(keptFromA.origin).toBeUndefined();
      expect(keptFromA.username).toBe("prod-account");
      expect(applySpy).toHaveBeenCalledTimes(1);
    });

    it("Keep Servers carries the source's OWN auth-profile link record into the marker (kills a detach that drops `syncedAuthProfileId`, after which an adopted server's sync-applied profile can never be taken back off)", async () => {
      const { core } = await harness({
        servers: [
          makeServer({
            id: "owned-1",
            name: "sw1",
            host: "10.0.0.11",
            authProfileId: "p1",
            origin: {
              sourceId: "src-1",
              externalId: "device:1",
              syncedAt: 1,
              syncedInstanceKey: DEFAULT_INSTANCE,
              // The sync's own record that IT applied p1.
              syncedAuthProfileId: "p1"
            }
          }),
          // The near-miss beside it: identical link, but the USER made it, so
          // there is no receipt to carry and none must be invented.
          makeServer({
            id: "owned-2",
            name: "sw2",
            host: "10.0.0.12",
            authProfileId: "p1",
            origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1, syncedInstanceKey: DEFAULT_INSTANCE }
          })
        ]
      });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");

      // The link itself stays on both records — a detach removes ownership, not
      // credentials.
      expect(core.getServer("owned-1")?.authProfileId).toBe("p1");
      expect(core.getServer("owned-2")?.authProfileId).toBe("p1");
      // Only the sync's own link leaves a receipt.
      expect(core.getServer("owned-1")?.formerlySynced?.syncedAuthProfileId).toBe("p1");
      expect(core.getServer("owned-2")?.formerlySynced).not.toHaveProperty("syncedAuthProfileId");
    });

    it("Keep Servers carries the source's OWN out-of-band address record into the marker (PR-A REVIEW FINDING — kills a detach that drops `syncedIpmiHost`, after which an adopted server's sync-written BMC address reads as hand-typed and no later sync can follow the BMC when NetBox re-addresses it)", async () => {
      const { core } = await harness({
        servers: [
          makeServer({
            id: "owned-1",
            name: "sw1",
            host: "10.0.0.11",
            ipmiHost: "10.9.9.9",
            origin: {
              sourceId: "src-1",
              externalId: "device:1",
              syncedAt: 1,
              syncedInstanceKey: DEFAULT_INSTANCE,
              // The sync's own record that IT wrote 10.9.9.9.
              syncedIpmiHost: "10.9.9.9"
            }
          }),
          // The near-miss beside it: the same address in the same field, but the
          // USER typed it, so there is no receipt to carry and none must be
          // invented from the record's own value.
          makeServer({
            id: "owned-2",
            name: "sw2",
            host: "10.0.0.12",
            ipmiHost: "10.9.9.9",
            origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1, syncedInstanceKey: DEFAULT_INSTANCE }
          })
        ]
      });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");

      // The address itself stays on both records — a detach removes ownership,
      // not configuration.
      expect(core.getServer("owned-1")?.ipmiHost).toBe("10.9.9.9");
      expect(core.getServer("owned-2")?.ipmiHost).toBe("10.9.9.9");
      // Only the sync's own write leaves a receipt.
      expect(core.getServer("owned-1")?.formerlySynced?.syncedIpmiHost).toBe("10.9.9.9");
      expect(core.getServer("owned-2")?.formerlySynced).not.toHaveProperty("syncedIpmiHost");
    });

    it("a provider that reports no instance at all writes a receipt-only marker and adopts nothing (kills stamping an instance key the provider never supplied, and kills falling back to the provider id when it has none)", async () => {
      const { core } = await harness({
        provider: { instanceKey: undefined },
        sources: [{}, { id: "src-2", name: "My Source B" }],
        servers: [
          makeServer({
            id: "owned-1",
            name: "core-sw-01",
            host: "10.0.0.11",
            port: 22,
            origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
          })
        ]
      });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");
      // The receipt still exists — the UI can still say where this server came
      // from — but it names no instance, so it is not an adoption key.
      const marker = core.getServer("owned-1")?.formerlySynced;
      expect(marker?.sourceName).toBe("My Source");
      expect(marker?.externalId).toBe("device:1");
      expect(marker).not.toHaveProperty("instanceKey");

      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-2");

      // No question, and a duplicate add rather than a reclaim — the deliberate
      // cost of a provider that cannot say which deployment it is talking to.
      expect(modals()).toHaveLength(1);
      expect([...core.getSnapshot().servers].map((s) => s.id).sort()).toEqual(
        ["owned-1", deterministicServerId("src-2", "device:1")].sort()
      );
      expect(core.getServer("owned-1")?.origin).toBeUndefined();
    });

    it("RESTORED ID-PRESERVING BACKUP — the question is asked and the adoption applies, on a plan whose add/update/prune counts are all ZERO (kills the no-op fast path swallowing the one run whose only work IS the question: the kept server already holds the id this device's add would need, so the engine plans nothing, the fast path applied an empty plan and returned, and the restored source could never reclaim its own servers — with the collision guard's adoptee exemption sitting there unreachable)", async () => {
      // THE RESTORE, exactly: the kept record still carries the id the sync that
      // created it minted (`deterministicServerId("src-1", "device:1")`), and the
      // restored source record kept its own id, so the two meet head-on.
      const { core } = await harness({ servers: [keptServer({ id: ADD_PATH_ID })] });
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      // No warning-toast mock: an adopting plan carries no engine warning at
      // all, so nothing here may reach `showWarningMessage`.
      mockShowInformationMessage.mockResolvedValueOnce("Adopt Existing").mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // THE FINDING. Pre-fix there were NO modals at all: the counts were empty,
      // so the sync reported "nothing to change" and returned before the question
      // could be put.
      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[0][0]).toBe(QUESTION);
      expect(shown[1][0]).toBe(PREVIEW);
      expect(shown[1][1].detail).toContain("1 server will be updated.");
      expect(shown[1][1].detail).toContain(ADOPTION_LINE_SINGULAR);

      // AND IT ACTUALLY RECLAIMS — a test that stopped at "a candidate is
      // reported" would have passed against the pre-fix build while the user
      // still had no way to reach it. One server, the one that was already
      // there, now owned by this source and with its marker spent.
      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe(ADD_PATH_ID);
      expect(servers[0].origin?.sourceId).toBe("src-1");
      expect(servers[0].origin?.externalId).toBe("device:1");
      expect(servers[0].name).toBe("core-sw-01");
      expect(servers[0].username).toBe("handpicked");
      expect(servers[0].formerlySynced).toBeUndefined();
      expect(applySpy).toHaveBeenCalledTimes(1);
    });

    // REVIEW FINDING (P2, "avoid promising a separate add when the ID is
    // occupied") — the three shapes of the decline line. The fast-path fix above
    // is what made this copy reachable: a restored ID-preserving backup now DOES
    // reach the question, and the sentence it read there ("adds the device as a
    // separate new server") described something the engine cannot do — its
    // collision fall-through skips the device, so the user chose an add, got
    // nothing, and had one line behind Show Warnings to work out why.
    //
    // Each test below asserts the WHOLE detail, line by line, plus the buttons.
    // Asserting a substring of the changed line would let the other three lines
    // rot silently, and asserting "a modal was shown" would pass against the very
    // copy this finding is about.
    it("ALL BLOCKED — the question promises no add at all and names the button for what it does, and choosing it really does leave the kept server untouched and add nothing (kills the blanket 'adds the device as a separate new server': that is exactly what does NOT happen when the adoptee already holds the id, and it is the state a restored ID-preserving backup lands in)", async () => {
      const { core } = await harness({ servers: [keptServer({ id: ADD_PATH_ID })] });
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage.mockResolvedValueOnce("Don't Adopt").mockResolvedValueOnce("Apply");
      // The blocked device's own warning survives the apply, so the post-apply
      // warnings toast fires.
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[0][0]).toBe(QUESTION);
      expect(shown[0][1].detail.split("\n")).toEqual([
        '1 device ("core-sw-01") was previously synced onto a server you kept from a removed inventory source.',
        'Adopt Existing re-links that server to "My Source" instead of adding a copy — it keeps its saved credentials and settings, and this source takes over its name, address and folder from now on. This source\'s Removed-Device Policy applies to it too, so a source set to Delete removes it, and its saved credentials, if the device later disappears from the source.',
        // THE FINDING, in one line. It states the outcome (adds nothing), the
        // reason, and it does so in the engine's own words — the sentence found
        // later behind Show Warnings describes the same situation, not a second
        // one.
        "Don't Adopt leaves that server untouched and adds nothing: it still uses the id a new server for this device would need, so the device is skipped rather than added separately.",
        "Nothing changes until you choose Apply on the sync preview."
      ]);
      // And the BUTTON, which is an action label: "Add Separately" over a body
      // reading "adds nothing" is the same false promise one line higher up.
      expect(shown[0].slice(2)).toEqual(["Adopt Existing", "Don't Adopt"]);

      // THE OUTCOME THE COPY NOW DESCRIBES, applied for real rather than
      // abandoned at Show Warnings: one server, the one that was already there,
      // still un-owned and still advertising itself for adoption next run. A
      // second record here would mean the old copy had been true and the fix
      // aimed at the wrong half.
      expect(applySpy).toHaveBeenCalledTimes(1);
      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe(ADD_PATH_ID);
      expect(servers[0].name).toBe("old-lab-switch");
      expect(servers[0].username).toBe("handpicked");
      expect(servers[0].origin).toBeUndefined();
      expect(servers[0].formerlySynced?.externalId).toBe("device:1");
    });

    it("ALL BLOCKED, plural — the same promise withdrawn for a whole set (kills reusing the singular sentence, whose 'it still uses the id' names no server when there are two of them)", async () => {
      const { core } = await harness({
        devices: [DEVICE_1, DEVICE_2],
        servers: [
          keptServer({ id: ADD_PATH_ID }),
          keptServer({
            id: deterministicServerId("src-1", "device:2"),
            name: "spare-rtr",
            host: "10.0.0.12",
            formerlySynced: keptMarker({ externalId: "device:2" })
          })
        ]
      });

      mockShowInformationMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown[0][0]).toBe('Adopt 2 servers kept from a removed inventory source into "My Source"?');
      expect(shown[0][1].detail.split("\n")).toEqual([
        '2 devices (e.g. "core-sw-01", "dist-rtr-01") were previously synced onto servers you kept from a removed inventory source.',
        'Adopt Existing re-links those servers to "My Source" instead of adding copies — each keeps its saved credentials and settings, and this source takes over its name, address and folder from now on. This source\'s Removed-Device Policy applies to them too, so a source set to Delete removes any one of them, and its saved credentials, if its device later disappears from the source.',
        "Don't Adopt leaves those servers untouched and adds nothing: each still uses the id a new server for its device would need, so every one of these devices is skipped rather than added separately.",
        "Nothing changes until you choose Apply on the sync preview."
      ]);
      expect(shown[0].slice(2)).toEqual(["Adopt Existing", "Don't Adopt"]);
    });

    it("MIXED — the question names the ONE device that cannot be added beside its server while still promising the add for the other, and the run then does exactly that (kills a fix that treats any blocked candidate as all of them: 'adds nothing' would be false about dist-rtr-01, which really is added — and kills leaving the blanket promise in place, which is false about core-sw-01, which really is not)", async () => {
      const { core } = await harness({
        devices: [DEVICE_1, DEVICE_2],
        servers: [
          // Blocked: this record already holds the id an add for device:1 would
          // mint — the restored-backup shape.
          keptServer({ id: ADD_PATH_ID }),
          // Clean: a hand-chosen id, so nothing stands in the way of the add.
          keptServer({ id: "kept-2", name: "spare-rtr", host: "10.0.0.12", formerlySynced: keptMarker({ externalId: "device:2" }) })
        ]
      });

      mockShowInformationMessage.mockResolvedValueOnce("Add Separately").mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[0][0]).toBe('Adopt 2 servers kept from a removed inventory source into "My Source"?');
      expect(shown[0][1].detail.split("\n")).toEqual([
        '2 devices (e.g. "core-sw-01", "dist-rtr-01") were previously synced onto servers you kept from a removed inventory source.',
        'Adopt Existing re-links those servers to "My Source" instead of adding copies — each keeps its saved credentials and settings, and this source takes over its name, address and folder from now on. This source\'s Removed-Device Policy applies to them too, so a source set to Delete removes any one of them, and its saved credentials, if its device later disappears from the source.',
        // NAMED, not averaged: one device of the two is the exception, and the
        // user is told which. A count alone ("1 of them") would leave them
        // choosing without knowing which server they are about to lose the add
        // for. One name is the whole list, so it is not an "e.g.".
        'Add Separately leaves those servers untouched and adds each device as a separate new server — except 1 device ("core-sw-01"), whose kept server still uses the id a new server for it would need, so that device is skipped rather than added separately.',
        "Nothing changes until you choose Apply on the sync preview."
      ]);
      // The label stands here — it is true of dist-rtr-01, and the detail names
      // the exception. A third label would be a third thing to learn for no gain.
      expect(shown[0].slice(2)).toEqual(["Adopt Existing", "Add Separately"]);

      // AND THE RUN DOES EXACTLY WHAT THE SENTENCE SAID. Three servers: both kept
      // records untouched, and ONE new one — device:2's. device:1 produced
      // nothing, which is the whole reason the sentence had to be written.
      expect([...core.getSnapshot().servers].map((s) => s.id).sort()).toEqual(
        [ADD_PATH_ID, "kept-2", deterministicServerId("src-1", "device:2")].sort()
      );
      expect(core.getServer(ADD_PATH_ID)?.origin).toBeUndefined();
      expect(core.getServer(ADD_PATH_ID)?.name).toBe("old-lab-switch");
      expect(core.getServer("kept-2")?.origin).toBeUndefined();
      expect(core.getServer(deterministicServerId("src-1", "device:2"))?.name).toBe("dist-rtr-01");
    });

    it("MIXED, plural exception — two blocked among three are named as examples under the same cap and 'e.g.' the count line uses (kills a singular exception clause bolted on for the one-blocked case: 'whose kept server still uses the id' names one server for two devices)", async () => {
      const DEVICE_3 = {
        externalId: "device:3",
        name: "edge-fw-01",
        endpoints: [{ kind: "ssh" as const, host: "10.0.0.13", port: 22 }]
      };
      const { core } = await harness({
        devices: [DEVICE_1, DEVICE_2, DEVICE_3],
        servers: [
          keptServer({ id: ADD_PATH_ID }),
          keptServer({
            id: deterministicServerId("src-1", "device:2"),
            name: "spare-rtr",
            host: "10.0.0.12",
            formerlySynced: keptMarker({ externalId: "device:2" })
          }),
          keptServer({ id: "kept-3", name: "old-fw", host: "10.0.0.13", formerlySynced: keptMarker({ externalId: "device:3" }) })
        ]
      });
      expect(core.getSnapshot().servers).toHaveLength(3);

      mockShowInformationMessage.mockResolvedValueOnce(undefined);
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const detail = modals()[0][1].detail.split("\n");
      expect(detail[0]).toBe('3 devices (e.g. "core-sw-01", "dist-rtr-01", "edge-fw-01") were previously synced onto servers you kept from a removed inventory source.');
      expect(detail[2]).toBe(
        'Add Separately leaves those servers untouched and adds each device as a separate new server — except 2 devices (e.g. "core-sw-01", "dist-rtr-01"), whose kept servers still use the ids new servers for them would need, so those devices are skipped rather than added separately.'
      );
      expect(modals()[0].slice(2)).toEqual(["Adopt Existing", "Add Separately"]);
    });

    it("RESTORED BACKUP, declined — the run reaches the preview and Show Warnings carries the engine's explanation, so the answer given before the run and the account given after it agree (kills a fix that only unblocks the Adopt branch: the decline cannot add this device either, and the sentence saying why has to survive to the warnings)", async () => {
      const { core } = await harness({ servers: [keptServer({ id: ADD_PATH_ID })] });
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      // "Don't Adopt", not "Add Separately": every candidate in this run is
      // blocked, so that is the label the question actually renders (see the
      // detail-text test above). A run answering the OTHER string would be
      // dismissing the modal, and the assertions below would then be about Esc.
      mockShowInformationMessage.mockResolvedValueOnce("Don't Adopt").mockResolvedValueOnce("Show Warnings");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[0][0]).toBe(QUESTION);
      // The preview is honest about a plan that does nothing, and offers the one
      // button that leads to the reason.
      expect(shown[1][0]).toBe(PREVIEW);
      expect(shown[1][1].detail).toContain("1 warning — choose Show Warnings to review.");
      expect(shown[1].slice(2)).toEqual(["Apply", "Show Warnings"]);

      const [openArgs] = mockOpenTextDocument.mock.calls as Array<[{ content: string }]>;
      expect(openArgs[0].content.split("\n")).toContain(
        'Device "core-sw-01" (device:1) was previously synced onto server "old-lab-switch", which still uses the id a new server for this device would need — so it is skipped rather than added separately. Sync again and choose Adopt Existing to reclaim that server.'
      );

      // Nothing applied (Show Warnings ends the command), and above all no second
      // record under an id that is already in use.
      expect(applySpy).not.toHaveBeenCalled();
      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].origin).toBeUndefined();
      expect(servers[0].formerlySynced?.externalId).toBe("device:1");
    });

    it("THE SECOND GATE — a candidate that appears only in the fast path's in-lock recompute is asked about too, not applied away (kills fixing the outer count check alone: the recompute exists because a queued mutation can land between the two, and the write that lands can be the config import that CREATES the adoptee)", async () => {
      // Pre-lock the plan is genuinely empty AND has no candidate: device:1 maps
      // to an owned server that is already exactly what the sync would write.
      const owned = makeServer({
        id: "owned-1",
        name: "core-sw-01",
        host: "10.0.0.11",
        port: 22,
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, syncedInstanceKey: DEFAULT_INSTANCE }
      });
      const { core } = await harness({ servers: [owned] });

      let releaseImport!: () => void;
      const importGate = new Promise<void>((resolve) => {
        releaseImport = resolve;
      });
      // A locked mutation queued AHEAD of syncNow's fast-path lock acquisition —
      // an ID-preserving restore replacing the owned record with the kept one it
      // was before the source was removed. After it lands the fresh recompute
      // finds a candidate whose add is blocked by its own adoptee's id, i.e. a
      // count-empty plan carrying a question.
      const importPromise = configMutationLock.runExclusive(async () => {
        await importGate;
        await core.removeServer("owned-1");
        await core.addOrUpdateServer(keptServer({ id: ADD_PATH_ID }));
      });

      mockShowInformationMessage.mockResolvedValueOnce("Adopt Existing").mockResolvedValueOnce("Apply");
      const syncPromise = registeredCommands.get("nexus.inventory.syncNow")!("src-1");
      // Let syncNow reach (and queue behind) its fast-path lock acquisition.
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseImport();
      await importPromise;
      await syncPromise;

      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[0][0]).toBe(QUESTION);
      // Never the fast path's toast: the recompute found something to ask about.
      expect(mockShowInformationMessage.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("nothing to change"))).toBe(false);

      const servers = core.getSnapshot().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0].id).toBe(ADD_PATH_ID);
      expect(servers[0].origin?.sourceId).toBe("src-1");
      expect(servers[0].name).toBe("core-sw-01");
    });

    it("REVIEW FINDING (P2) — an auth-profile link the user cleared BEFORE the source was removed is still cleared after the adoption, while the kept server beside it that was never linked adopts the profile as usual (kills a retro-apply predicate blind to the marker: the receipt is preserved across the detach and then ignored, so the same opt-out is honoured forever if made after the adoption and silently reversed if made before it)", async () => {
      const LAB_PROFILE: AuthProfile = { id: "p1", name: "Lab credentials", username: "labuser", authType: "password" };
      const { core } = await harness({
        profiles: [LAB_PROFILE],
        devices: [DEVICE_1, DEVICE_2],
        // Both incarnations of the source, both carrying the profile: the second
        // is the one re-added after the removal below.
        sources: [
          { authProfileId: "p1", defaultUsername: "labuser" },
          { id: "src-2", name: "My Source B", authProfileId: "p1", defaultUsername: "labuser" }
        ],
        servers: [
          // THE OPT-OUT, made while the source still owned the server: the sync
          // had applied p1 (the origin stamp says so) and the user set Auth
          // Profile back to (None). Every other retro-apply clause still passes —
          // agent auth, no key of its own, and the username the sync stamped —
          // so the receipt is the only thing that can refuse the re-link.
          makeServer({
            id: "owned-1",
            name: "core-sw-01",
            host: "10.0.0.11",
            port: 22,
            username: "labuser",
            authType: "agent",
            authProfileId: undefined,
            origin: {
              sourceId: "src-1",
              externalId: "device:1",
              syncedAt: 1,
              syncedInstanceKey: DEFAULT_INSTANCE,
              syncedUsername: "labuser",
              syncedAuthProfileId: "p1"
            }
          }),
          // THE CONTROL, identical but for the one field: no sync ever put a
          // profile on this record, so nothing here is an opt-out and the
          // adoption must link the source's profile exactly as it always has.
          makeServer({
            id: "owned-2",
            name: "dist-rtr-01",
            host: "10.0.0.12",
            port: 22,
            username: "labuser",
            authType: "agent",
            authProfileId: undefined,
            origin: {
              sourceId: "src-1",
              externalId: "device:2",
              syncedAt: 1,
              syncedInstanceKey: DEFAULT_INSTANCE,
              syncedUsername: "labuser"
            }
          })
        ]
      });

      mockShowWarningMessage.mockResolvedValueOnce("Keep Servers");
      await registeredCommands.get("nexus.inventory.removeSource")!("src-1");
      // The persisted receipt this whole finding is about — preserved by the
      // detach, and until now read by nothing on the adoption path.
      expect(core.getServer("owned-1")?.formerlySynced?.syncedAuthProfileId).toBe("p1");
      expect(core.getServer("owned-1")?.authProfileId).toBeUndefined();
      expect(core.getServer("owned-2")?.formerlySynced).not.toHaveProperty("syncedAuthProfileId");

      mockShowInformationMessage.mockResolvedValueOnce("Adopt Existing").mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-2");

      const shown = modals();
      expect(shown).toHaveLength(2);
      expect(shown[0][0]).toBe('Adopt 2 servers kept from a removed inventory source into "My Source B"?');
      // ONE switch disclosed, not two: the preview counts what the plan actually
      // writes, so the opted-out server is not in it.
      expect(shown[1][1].detail).toContain('1 server will switch to auth profile "Lab credentials".');

      // THE ASSERTION THE FINDING TURNS ON, read off the persisted record.
      const optedOut = core.getServer("owned-1")!;
      expect(optedOut.origin?.sourceId).toBe("src-2");
      expect(optedOut.authProfileId).toBeUndefined();
      // The receipt moves into the new origin, so the next ordinary sync reads
      // the same opt-out without the marker the adoption has spent.
      expect(optedOut.origin?.syncedAuthProfileId).toBe("p1");
      expect(optedOut.formerlySynced).toBeUndefined();

      const control = core.getServer("owned-2")!;
      expect(control.origin?.sourceId).toBe("src-2");
      expect(control.authProfileId).toBe("p1");
      expect(control.origin?.syncedAuthProfileId).toBe("p1");
    });

    // REVIEW FINDING (P1) — RE-ASK WHEN THE CANDIDATES CHANGE.
    //
    // The question is a consent moment of its own: the user agrees to hand a
    // NAMED SET of servers to this source, and every plan computed from that
    // answer must still be about that set. `planDetailDrift` cannot supply this.
    // Its baseline rolls forward with the preview and only starts existing once
    // the preview does — which is one recompute AFTER the answer is first spent.
    //
    // Every test below is a SAME-COUNT swap, because a count check would catch
    // anything else: one candidate before, one candidate after, and the run must
    // not adopt the one that arrived. Each stages the change through a modal
    // implementation or a vault-read hook, so it lands inside the window every
    // time rather than usually racing it, and each asserts the PERSISTED result.
    const STALE_ANSWER_REFUSAL =
      'The servers "My Source" offered to adopt are no longer the ones you were asked about — sync aborted, run Sync Now again.';

    /** The record that replaces the adoptee mid-question: another survivor of the same removal, at the same address, claiming the same device. */
    function restoredAdoptee(): ServerConfig {
      return keptServer({ id: "kept-9", name: "restored-lab-switch", username: "restored" });
    }

    /** The first line of the question's `detail` — the only part of it that names anything the two candidate sets could differ on. */
    const QUESTION_FIRST_LINE = '1 device ("core-sw-01") was previously synced onto a server you kept from a removed inventory source.';

    it("a same-count swap of WHICH kept record is eligible, landing while the question is open, aborts instead of spending the answer on the record that replaced it (kills capturing the question's device names, its rendered text, or its count: both sets are one device named \"core-sw-01\", so nothing the question showed can tell them apart)", async () => {
      const { core } = await harness();
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        // The replacement lands WHILE the question is open — a replace-mode
        // config import, or a restore from backup, swapping the kept record for
        // another survivor of the same removal at the same address, still
        // claiming device:1. One candidate before, one candidate after.
        .mockImplementationOnce(async () => {
          await core.removeServer("kept-1");
          await core.addOrUpdateServer(restoredAdoptee());
          return "Adopt Existing";
        })
        // Queued so the UNGUARDED path can actually reach the apply: without an
        // answer waiting here the preview would collect `undefined` and return,
        // leaving the state untouched for a reason that proves nothing.
        .mockResolvedValueOnce("Apply");

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      // The question, and nothing after it: the preview the "Apply" above was
      // queued for is never reached.
      expect(shown).toHaveLength(1);
      expect(shown[0][0]).toBe(QUESTION);
      expect(shown[0][1].detail.split("\n")[0]).toBe(QUESTION_FIRST_LINE);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(STALE_ANSWER_REFUSAL);

      // THE PASS/FAIL LINE: kept-9 is exactly as the swap left it. Unguarded,
      // this run renames it "core-sw-01", stamps src-1's origin on it — and with
      // it this source's Removed-Device Policy, `delete` included — spends its
      // Keep Servers marker, and keeps its saved credentials pointed at a record
      // now owned by a source the user never offered it to.
      expect(applySpy).not.toHaveBeenCalled();
      const restored = core.getServer("kept-9")!;
      expect(restored.name).toBe("restored-lab-switch");
      expect(restored.origin).toBeUndefined();
      expect(restored.formerlySynced?.externalId).toBe("device:1");
      // Nor did the run fall back to Add Separately: it ended.
      expect(core.getSnapshot().servers.map((s) => s.id)).toEqual(["kept-9"]);
    });

    it("the swapped-in record raises the same question, word for word, and is adopted when the question is actually asked about IT (fixture non-vacuity for the swap above: the two candidate sets are indistinguishable in everything the user is shown, and the swapped-in set is otherwise a perfectly ordinary adoption)", async () => {
      const { core } = await harness({ servers: [restoredAdoptee()] });

      mockShowInformationMessage.mockResolvedValueOnce("Adopt Existing").mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      const shown = modals();
      // Same title (which carries the count) and same first line (which carries
      // the device names) as the run above — the rest of the copy is static and
      // names only the source. A guard comparing what the question RENDERED
      // therefore sees two identical questions.
      expect(shown[0][0]).toBe(QUESTION);
      expect(shown[0][1].detail.split("\n")[0]).toBe(QUESTION_FIRST_LINE);
      expect(shown[1][1].detail).toContain("1 server will be updated.");
      expect(shown[1][1].detail).toContain(ADOPTION_LINE_SINGULAR);
      // And the harm the guard prevents, shown happening when it is consented
      // to: this is precisely what the aborted run above would have done.
      const restored = core.getServer("kept-9")!;
      expect(restored.name).toBe("core-sw-01");
      expect(restored.origin?.sourceId).toBe("src-1");
      expect(restored.formerlySynced).toBeUndefined();
    });

    it("a same-count swap of WHICH DEVICE claims the kept record, landing while the question is open, aborts instead of re-pointing that record at a machine the user was never shown (kills capturing adoptee server ids alone: the record is `kept-1` before and after)", async () => {
      const { core } = await harness({ devices: [DEVICE_1, DEVICE_2] });
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        .mockImplementationOnce(async () => {
          // The marker and the address move together onto device:2 — a restore
          // of an older backup. kept-1 is still the one and only adoptee; the
          // device coming to claim it is not the one the question named.
          await core.addOrUpdateServer({
            ...core.getServer("kept-1")!,
            host: "10.0.0.12",
            formerlySynced: keptMarker({ externalId: "device:2" })
          });
          return "Adopt Existing";
        })
        .mockResolvedValueOnce("Apply");

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(modals()).toHaveLength(1);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(STALE_ANSWER_REFUSAL);

      // Unguarded, kept-1 is adopted BY DEVICE:2 — renamed "dist-rtr-01",
      // re-addressed and re-foldered onto a machine that was never mentioned,
      // while core-sw-01 (the device the question DID name) becomes an add.
      expect(applySpy).not.toHaveBeenCalled();
      const kept = core.getServer("kept-1")!;
      expect(kept.name).toBe("old-lab-switch");
      expect(kept.origin).toBeUndefined();
      expect(kept.formerlySynced?.externalId).toBe("device:2");
      expect(core.getSnapshot().servers).toHaveLength(1);
    });

    it("the same swap landing while the PREVIEW is open aborts inside the lock instead of re-showing and applying the new set on the next pass (kills guarding only the recompute that follows the answer: planDetailDrift re-bases on the swapped-in pairs, so the second preview and the plan under it agree with each other — and with nothing the user was asked)", async () => {
      const { core } = await harness();
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        .mockResolvedValueOnce("Adopt Existing")
        // Answered about kept-1, then the record is replaced while the preview
        // that was rendered for kept-1 is on screen.
        .mockImplementationOnce(async () => {
          await core.removeServer("kept-1");
          await core.addOrUpdateServer(restoredAdoptee());
          return "Apply";
        })
        // The re-confirmation the drift comparator puts up when it notices the
        // pair change. Answering it "Apply" is exactly what makes an
        // answer-guarded-once implementation apply the set nobody was asked
        // about — the drift check has re-based on it by then.
        .mockResolvedValueOnce("Apply");

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(mockShowErrorMessage).toHaveBeenCalledWith(STALE_ANSWER_REFUSAL);
      expect(applySpy).not.toHaveBeenCalled();
      const restored = core.getServer("kept-9")!;
      expect(restored.name).toBe("restored-lab-switch");
      expect(restored.origin).toBeUndefined();
      expect(core.getSnapshot().servers.map((s) => s.id)).toEqual(["kept-9"]);
    });

    it("a swap landing in the last window of all — after the credential re-check, on the plan that is actually applied — ends the run there rather than re-confirming into the same refusal one modal later (kills leaving the final recompute unguarded: it is the plan applyInventorySyncPlan receives)", async () => {
      let live: NexusCore | undefined;
      let previewAnswered = false;
      let swapped = false;
      const { core } = await harness({
        // The vault reads before the fetch all happen while the preview is still
        // unanswered; the FIRST read after it is answered is the in-lock
        // credential re-check — the last await before the plan that is applied.
        // Gating on that puts the swap inside that window on every run.
        onSecretRead: async () => {
          if (!previewAnswered || swapped || live === undefined) return;
          swapped = true;
          await live.removeServer("kept-1");
          await live.addOrUpdateServer(restoredAdoptee());
        }
      });
      live = core;
      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");

      mockShowInformationMessage
        .mockResolvedValueOnce("Adopt Existing")
        .mockImplementationOnce(async () => {
          previewAnswered = true;
          return "Apply";
        })
        // Queued for the re-confirmation an unguarded final recompute would
        // produce: the drift comparator sees the pair change and re-shows.
        .mockResolvedValueOnce("Apply");

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The question and ONE preview. Without the guard on the final recompute
      // the run instead re-confirms and only refuses on the pass after that —
      // three modals for a decision that was already invalid, having torn down
      // runtime state for the plan it was about to apply.
      expect(modals()).toHaveLength(2);
      expect(mockShowErrorMessage).toHaveBeenCalledWith(STALE_ANSWER_REFUSAL);
      expect(applySpy).not.toHaveBeenCalled();
      const restored = core.getServer("kept-9")!;
      expect(restored.name).toBe("restored-lab-switch");
      expect(restored.origin).toBeUndefined();
    });

    it("a candidate that appears when the question was NEVER asked does not abort the sync — there is no answer to be stale, and nothing can be adopted without one (kills capturing an empty set on a run with no question: it would refuse ordinary syncs that meet a kept server mid-flight)", async () => {
      const { core } = await harness({ servers: [] });

      mockShowInformationMessage
        // No candidates at plan time, so no question — the preview is the first
        // modal. The kept server arrives while it is open, which makes device:1
        // a candidate for every recompute from here on.
        .mockImplementationOnce(async () => {
          await core.addOrUpdateServer(keptServer());
          return "Apply";
        })
        // The duplicate line the newly-arrived record adds to the plan is drift,
        // so the preview re-shows; this confirms the plan that is applied.
        .mockResolvedValueOnce("Apply");
      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      expect(mockShowErrorMessage).not.toHaveBeenCalled();
      // Today's accepted behaviour, unchanged: with no answer in the run nothing
      // is adopted, so the device is added beside the record that turned up and
      // the kept server is left exactly as it arrived.
      expect([...core.getSnapshot().servers].map((s) => s.id).sort()).toEqual(["kept-1", ADD_PATH_ID].sort());
      const kept = core.getServer("kept-1")!;
      expect(kept.origin).toBeUndefined();
      expect(kept.name).toBe("old-lab-switch");
      expect(kept.formerlySynced?.externalId).toBe("device:1");
    });
  });

  // The busy-marker refusal wording. One marker is shared by three claimants
  // (syncNow, editSource's open form, removeSource's confirm-and-mutate run)
  // and it used to be a bare Set<string>, so every refusal was worded as an
  // in-flight sync regardless of who actually held it. Reported by the repo
  // owner: an Edit Source tab left open made Sync Now insist the source was
  // "currently syncing", and the only way to discover the truth was to close
  // the tab and watch the problem vanish.
  //
  // Every test below asserts the EXACT sentence at EVERY reporting site, for
  // each holder in turn: a substring/"some warning appeared" assertion cannot
  // tell the fixed code from the lie it replaced.
  describe("PR #62 Codex round 1 — TOCTOU / stale-reference guards", () => {
    // MECHANISM 2 (P2 #3) — source save with a device-template id deleted while
    // the form was open. The deletion sweep (removeDeviceTemplate) only clears
    // rules a source ALREADY persists, so a rule this save is writing for the
    // first time slips through as a dangling id; re-resolving under the persist
    // lock is what rejects it.
    it("2a (add) — REJECTS a submitted catch-all rule whose template was deleted while the Add form was open; no dangling rule persisted", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Branch", fields: {} });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();
      // Deleted while the form sits open.
      await core.removeDeviceTemplate("t1");
      await expect(
        onSubmit({
          name: "My NetBox",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "secret-token",
          deviceTemplateId: "t1"
        })
      ).rejects.toThrow(/device template no longer exists/i);
      // Against b247d32 the source persists carrying templateRules:[{templateId:"t1"}]
      // — a dangling rule the sync engine later skips. The fixed path persists
      // nothing at all.
      expect(core.getSnapshot().inventorySources).toHaveLength(0);
    });

    it("2a (edit) — REJECTS a rule newly pointed at a template deleted mid-edit; the source keeps no dangling rule", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Branch", fields: {} });
      // The source does NOT initially reference t1 — so removeDeviceTemplate's
      // sweep never touches it (it would otherwise trip the ITEM 4 guard); the
      // dangling reference is the one this edit is newly adding.
      await core.addOrUpdateInventorySource(makeSource({ targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] }));
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await registeredCommands.get("nexus.inventory.editSource")!("src-1");
      const { onSubmit } = latestFormCall();
      await core.removeDeviceTemplate("t1"); // deleted while the Edit form is open
      await expect(
        onSubmit({
          name: "My Source",
          targetFolder: "Infra",
          defaultUsername: "admin",
          prunePolicy: "orphan",
          cfg_host: "netbox.local",
          cfg_apiToken: "",
          deviceTemplateId: "t1"
        })
      ).rejects.toThrow(/device template no longer exists/i);
      const persisted = core.getInventorySource("src-1")!;
      // Against b247d32 the update persists a catch-all rule naming the vanished
      // t1; the fixed path leaves the source with no such rule.
      expect((persisted.templateRules ?? []).some((r) => r.templateId === "t1")).toBe(false);
    });

    it("2a sibling — a LIVE template id persists the catch-all rule normally (guard not over-firing)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({ id: "t1", name: "Branch", fields: {} });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      const vault = makeVault();
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await registeredCommands.get("nexus.inventory.addSource")!();
      const { onSubmit } = latestFormCall();
      await onSubmit({
        name: "My NetBox",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        cfg_host: "netbox.local",
        cfg_apiToken: "secret-token",
        deviceTemplateId: "t1"
      });
      const persisted = core.getSnapshot().inventorySources[0];
      expect(persisted.templateRules).toEqual([expect.objectContaining({ templateId: "t1" })]);
    });

    // MECHANISM 1 (P1 #2) — a referenced template edited to new VALUES between the
    // sync preview and the in-lock confirm. describePlanDetail renders only the
    // plan's SHAPE (counts, switch/adoption identities), so a value-only template
    // edit is invisible to planDetailDrift; the referenced-template revision
    // snapshot is what aborts it.
    function proxyAt(host: string) {
      return { type: "socks5" as const, host, port: 1080 };
    }
    function renamedFetch(): InventoryProvider["fetchInventory"] {
      // A device RENAME forces a non-empty update, so the plan reaches the preview
      // modal (a pure proxy no-op would take the fast path and never preview).
      return vi.fn(async () => ({
        contractVersion: 1 as const,
        devices: [{ externalId: "device:1", name: "renamed-sw", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] }]
      }));
    }
    function ownedProxied(): ServerConfig {
      return makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, templated: { proxy: proxyAt("10.9.9.1") } },
        proxy: proxyAt("10.9.9.1") // template-applied baseline A
      });
    }

    it("1b — a referenced template edited to new VALUES while the preview is open ABORTS the apply; nothing written", async () => {
      const core = new NexusCore(new InMemoryConfigRepository([ownedProxied()]));
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({ id: "tmpl-1", name: "T", fields: { proxy: { mode: "override", value: proxyAt("10.9.9.1") } } });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: renamedFetch() }));
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      // While the preview modal is open, edit tmpl-1 IN PLACE to proxy B (host
      // .2). Same field, same mode → describePlanDetail is byte-identical ("1
      // server will be updated"), so planDetailDrift cannot see it.
      mockShowInformationMessage.mockImplementationOnce(async () => {
        await core.addOrUpdateDeviceTemplate({ id: "tmpl-1", name: "T", fields: { proxy: { mode: "override", value: proxyAt("10.9.9.2") } } });
        return "Apply";
      });
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // NOTHING applied: the rename did not land and the proxy stays A. Against
      // b247d32 the in-lock recompute silently writes proxy B (host .2) — the
      // value the user never previewed.
      expect(core.getServer("owned-1")?.name).toBe("old-sw");
      expect(core.getServer("owned-1")?.proxy).toEqual(proxyAt("10.9.9.1"));
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("changed while the sync preview was open"));
    });

    it("1b sibling — an UNCHANGED referenced template applies as previewed (guard not over-firing)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository([ownedProxied()]));
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({ id: "tmpl-1", name: "T", fields: { proxy: { mode: "override", value: proxyAt("10.9.9.1") } } });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({ fetchInventory: renamedFetch() }));
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      mockShowInformationMessage.mockResolvedValueOnce("Apply"); // no mid-preview edit
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The rename landed — the sync applied normally.
      expect(core.getServer("owned-1")?.name).toBe("renamed-sw");
    });

    // MECHANISM 1 — TEMPLATE-REVISION TWIN OF GUARD SITE 3. The ~3818 early-out
    // check runs BEFORE the awaited teardown loop / vault re-read; device-template
    // saves do NOT take configMutationLock, so a value-only template edit can land
    // in exactly that window, after the early check has already passed. This test
    // drives the edit through the teardown callback (the same mid-await seam the
    // ITEM 2 test uses) and asserts the FINAL-site recheck aborts before apply.
    it("1b final-site — a referenced template edited to new VALUES DURING the teardown await window (after the early ~3818 check passed) ABORTS the apply at the final site; applyInventorySyncPlan is never called and nothing is written", async () => {
      const updated = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, templated: { proxy: proxyAt("10.9.9.1") } },
        proxy: proxyAt("10.9.9.1") // template-applied baseline A
      });
      const pruned = makeServer({
        id: "owned-2",
        name: "gone-sw",
        host: "10.0.0.2",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const core = new NexusCore(new InMemoryConfigRepository([updated, pruned]));
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({ id: "tmpl-1", name: "T", fields: { proxy: { mode: "override", value: proxyAt("10.9.9.1") } } });
      const registry = new InventoryProviderRegistry();
      // device:1 present + RENAMED -> update (reaches preview); device:2 absent -> prune "delete" -> teardown fires (the await window).
      registry.register(makeProvider({
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1 as const,
          devices: [{ externalId: "device:1", name: "renamed-sw", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] }]
        }))
      }));
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      // The seam: when the pruned server's runtime is torn down (an awaited hop
      // AFTER the early ~3818 revision check has already passed), edit tmpl-1 IN
      // PLACE to proxy B (host .2). Same field/mode → describePlanDetail stays
      // byte-identical, so finalDrift cannot see it; only the final-site revision
      // recheck can.
      const teardown = {
        teardownServerRuntime: vi.fn(async (serverId: string) => {
          if (serverId === "owned-2") {
            await core.addOrUpdateDeviceTemplate({ id: "tmpl-1", name: "T", fields: { proxy: { mode: "override", value: proxyAt("10.9.9.2") } } });
          }
        })
      };
      registerInventoryCommands(core, registry, vault, teardown);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete", templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");
      mockShowInformationMessage.mockResolvedValueOnce("Apply"); // no mid-PREVIEW edit — the early check passes
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // Aborted at the final site: applyInventorySyncPlan never ran, so NOTHING
      // was written — the rename did not land and the proxy stays A. Against
      // d0c8fa1 the final recompute folds in proxy B (host .2) and applies it,
      // and the pruned server is deleted.
      expect(applySpy).not.toHaveBeenCalled();
      expect(core.getServer("owned-1")?.name).toBe("old-sw");
      expect(core.getServer("owned-1")?.proxy).toEqual(proxyAt("10.9.9.1"));
      expect(core.getServer("owned-2")).toBeDefined();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("changed while the sync preview was open"));
    });

    it("1b final-site sibling — no template edit during the teardown window applies as previewed (final-site guard not over-firing)", async () => {
      const updated = makeServer({
        id: "owned-1",
        name: "old-sw",
        host: "10.0.0.1",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1, templated: { proxy: proxyAt("10.9.9.1") } },
        proxy: proxyAt("10.9.9.1")
      });
      const pruned = makeServer({
        id: "owned-2",
        name: "gone-sw",
        host: "10.0.0.2",
        origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 }
      });
      const core = new NexusCore(new InMemoryConfigRepository([updated, pruned]));
      await core.initialize();
      await core.addOrUpdateDeviceTemplate({ id: "tmpl-1", name: "T", fields: { proxy: { mode: "override", value: proxyAt("10.9.9.1") } } });
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider({
        fetchInventory: vi.fn(async () => ({
          contractVersion: 1 as const,
          devices: [{ externalId: "device:1", name: "renamed-sw", endpoints: [{ kind: "ssh" as const, host: "10.0.0.1", port: 22 }] }]
        }))
      }));
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown()); // teardown makes no edit
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete", templateRules: [{ id: "r1", templateId: "tmpl-1" }] }));

      const applySpy = vi.spyOn(core, "applyInventorySyncPlan");
      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      await registeredCommands.get("nexus.inventory.syncNow")!("src-1");

      // The sync applied normally: the rename landed and the pruned server is gone.
      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(core.getServer("owned-1")?.name).toBe("renamed-sw");
      expect(core.getServer("owned-2")).toBeUndefined();
    });
  });

  describe("busy-marker refusals name the real holder", () => {
    async function setupBusyFixture(fetchInventory?: InventoryProvider["fetchInventory"]): Promise<{
      core: NexusCore;
      provider: InventoryProvider;
      syncCmd: (...args: unknown[]) => Promise<void>;
      editCmd: (...args: unknown[]) => Promise<void>;
      removeCmd: (...args: unknown[]) => Promise<void>;
    }> {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider(fetchInventory ? { fetchInventory } : {});
      registry.register(provider);
      const vault = makeVault({ [inventorySecretKey("src-1", "apiToken")]: "tok" });
      registerInventoryCommands(core, registry, vault, makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));
      return {
        core,
        provider,
        syncCmd: registeredCommands.get("nexus.inventory.syncNow")! as (...args: unknown[]) => Promise<void>,
        editCmd: registeredCommands.get("nexus.inventory.editSource")! as (...args: unknown[]) => Promise<void>,
        removeCmd: registeredCommands.get("nexus.inventory.removeSource")! as (...args: unknown[]) => Promise<void>
      };
    }

    /** Every message the three commands passed to showWarningMessage as their sole argument. */
    function singleArgWarnings(): string[] {
      return mockShowWarningMessage.mock.calls.filter((call) => call.length === 1).map((call) => String(call[0]));
    }

    it("holder = a running sync: syncNow says already syncing, editSource and removeSource say to wait for it (kills a fix that renders every refusal as the edit/removal wording, and the syncNow/other phrasing swap)", async () => {
      let resolveFetch!: (tree: InventoryTree) => void;
      const { core, provider, syncCmd, editCmd, removeCmd } = await setupBusyFixture(
        vi.fn(() => new Promise<InventoryTree>((resolve) => (resolveFetch = resolve)))
      );

      // Claimed as "sync" and parked inside fetchInventory (a few awaited
      // hops in: the fingerprint gate, then the vault reads).
      const syncPromise = syncCmd("src-1");
      await vi.waitFor(() => {
        expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
      });
      mockShowWarningMessage.mockClear();

      await syncCmd("src-1");
      await editCmd("src-1");
      await removeCmd("src-1");

      // This is the ONE holder for which "syncing" is true, so all three
      // sentences must still say so — and syncNow's keeps its own phrasing
      // (the user asked for the thing already running).
      expect(singleArgWarnings()).toEqual([BUSY_SYNC_FROM_SYNC, BUSY_SYNC_FROM_OTHER, BUSY_SYNC_FROM_OTHER]);
      // None of them started work: no second fetch, no form, no removal.
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
      expect(mockWebviewOpen).not.toHaveBeenCalled();
      expect(core.getSnapshot().inventorySources).toHaveLength(1);

      resolveFetch({ contractVersion: 1, devices: [] });
      await syncPromise;
    });

    it("holder = an open Edit Source form: all three commands name the open tab and none claims a sync is running (kills the reported bug — the shared Set reported this holder as an in-flight sync)", async () => {
      const { core, provider, syncCmd, editCmd, removeCmd } = await setupBusyFixture();

      // Claimed as "edit" for as long as the form stays open (F4). Nothing is
      // syncing: fetchInventory has never been called.
      await editCmd("src-1");
      const { panel } = latestFormCall();
      expect(mockWebviewOpen).toHaveBeenCalledTimes(1);
      mockShowWarningMessage.mockClear();

      await syncCmd("src-1");
      await removeCmd("src-1");
      await editCmd("src-1");

      expect(singleArgWarnings()).toEqual([BUSY_EDIT, BUSY_EDIT, BUSY_EDIT]);
      // The pre-fix wording, spelled out so a regression to it is unmissable:
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_SYNC_FROM_SYNC);
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_SYNC_FROM_OTHER);
      for (const message of singleArgWarnings()) {
        expect(message).not.toMatch(/sync/i);
      }
      // Refused, not merely mis-worded: no fetch, no second form, no removal.
      expect(provider.fetchInventory).not.toHaveBeenCalled();
      expect(mockWebviewOpen).toHaveBeenCalledTimes(1);
      expect(core.getSnapshot().inventorySources).toHaveLength(1);

      // The instruction the sentence gives has to be the one that works:
      // closing that tab frees the source.
      panel.fireDispose();
      mockShowWarningMessage.mockClear();
      await syncCmd("src-1");
      expect(singleArgWarnings()).toEqual([]);
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
    });

    it("holder = a removal awaiting its confirm modal: all three commands say the source is being removed (kills a two-member reason enum that has to file removeSource under 'sync' or 'edit')", async () => {
      const { core, provider, syncCmd, editCmd, removeCmd } = await setupBusyFixture();

      // The confirm modal stays open, holding the marker; every other
      // showWarningMessage (i.e. the busy refusals, all fire-and-forget)
      // resolves immediately.
      let resolveConfirm!: (choice: string | undefined) => void;
      const confirmChoice = new Promise<string | undefined>((resolve) => (resolveConfirm = resolve));
      mockShowWarningMessage.mockImplementation((...args: unknown[]) => {
        const isModal = typeof args[1] === "object" && args[1] !== null && (args[1] as { modal?: boolean }).modal === true;
        return isModal ? confirmChoice : Promise.resolve(undefined);
      });

      const removePromise = removeCmd("src-1");
      await Promise.resolve();
      const modalCalls = (): number =>
        mockShowWarningMessage.mock.calls.filter(
          (call) => typeof call[1] === "object" && call[1] !== null && (call[1] as { modal?: boolean }).modal === true
        ).length;
      expect(modalCalls()).toBe(1);

      await syncCmd("src-1");
      await editCmd("src-1");
      await removeCmd("src-1");

      expect(singleArgWarnings()).toEqual([BUSY_REMOVE, BUSY_REMOVE, BUSY_REMOVE]);
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_SYNC_FROM_SYNC);
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_SYNC_FROM_OTHER);
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_EDIT);
      expect(provider.fetchInventory).not.toHaveBeenCalled();
      expect(mockWebviewOpen).not.toHaveBeenCalled();
      // The second removeSource was refused before it could open a modal of
      // its own — one confirm dialog, still exactly one.
      expect(modalCalls()).toBe(1);

      // Dismissing the modal aborts the removal and releases the marker.
      resolveConfirm(undefined);
      await removePromise;
      expect(core.getSnapshot().inventorySources).toHaveLength(1);
      mockShowWarningMessage.mockClear();
      await syncCmd("src-1");
      expect(singleArgWarnings()).toEqual([]);
      expect(provider.fetchInventory).toHaveBeenCalledTimes(1);
    });

    it("editSource's provider-missing abort still releases the marker — a source whose provider extension was disabled is not left permanently 'open in Edit Source' (kills dropping releaseInFlight from that early return)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      // Deliberately empty: the extension that registered "fake" is disabled.
      const registry = new InventoryProviderRegistry();
      registerInventoryCommands(core, registry, makeVault(), makeTeardown());
      await core.addOrUpdateInventorySource(makeSource());

      const editCmd = registeredCommands.get("nexus.inventory.editSource")! as (...args: unknown[]) => Promise<void>;
      await editCmd("src-1");
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Inventory provider "fake" is not available'));
      expect(mockWebviewOpen).not.toHaveBeenCalled();

      // The extension comes back. Without the release on that abort the marker
      // is stranded, and every later command reports a source held open by an
      // Edit Source tab that never existed — the F6 failure mode, on a second
      // early-return path.
      registry.register(makeProvider());
      await editCmd("src-1");
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(BUSY_EDIT);
      expect(mockWebviewOpen).toHaveBeenCalledTimes(1);
    });
  });

  // T6 — the Settings-tree hub. Every level-2 row routes through
  // vscode.commands.executeCommand WITH the source id, so each of the four
  // existing race-guarded flows runs unchanged and no picker is shown twice.
  describe("nexus.inventory.manage — Settings-tree hub", () => {
    interface HubItem {
      label: string;
      description?: string;
      kind?: number;
    }
    interface HubOptions {
      title?: string;
      placeHolder?: string;
    }

    function quickPickCall(index: number): { items: HubItem[]; options: HubOptions } {
      const call = mockShowQuickPick.mock.calls[index] as [HubItem[], HubOptions];
      expect(call).toBeDefined();
      return { items: call[0], options: call[1] };
    }

    async function setupHub(sources: InventorySourceConfig[]): Promise<NexusCore> {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      registerInventoryCommands(core, registry, makeVault(), makeTeardown());
      for (const source of sources) {
        await core.addOrUpdateInventorySource(source);
      }
      return core;
    }

    it("level 1 lists every source with its sourceDescription() line, then a separator and the add row", async () => {
      await setupHub([
        makeSource({ id: "src-1", name: "Alpha" }),
        makeSource({ id: "src-2", name: "Beta", lastSyncAt: Date.now() })
      ]);
      mockShowQuickPick.mockResolvedValueOnce(undefined); // dismissed

      await registeredCommands.get("nexus.inventory.manage")!();

      expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
      const { items, options } = quickPickCall(0);
      expect(options).toEqual({ title: "Inventory Sources", placeHolder: "Choose a source to sync, edit, or remove" });
      expect(items.map((item) => item.label)).toEqual(["Alpha", "Beta", "", "$(add) Add Inventory Source…"]);
      // Reused verbatim from pickInventorySource's row description — provider
      // label plus the relative last-sync phrasing.
      expect(items[0].description).toBe("Fake Provider — never synced");
      expect(items[1].description).toBe("Fake Provider — synced just now");
      expect(items[2].kind).toBe(-1); // QuickPickItemKind.Separator
      expect(items[3].kind).toBeUndefined();
      // Dismissing level 1 is a cancel, not an implicit "add".
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it("picking a source shows the three action rows titled with the source name", async () => {
      await setupHub([makeSource({ id: "src-1", name: "Alpha" }), makeSource({ id: "src-2", name: "Beta" })]);
      mockShowQuickPick
        .mockImplementationOnce(async (items: HubItem[]) => items.find((item) => item.label === "Beta"))
        .mockResolvedValueOnce(undefined);

      await registeredCommands.get("nexus.inventory.manage")!();

      expect(mockShowQuickPick).toHaveBeenCalledTimes(2);
      const { items, options } = quickPickCall(1);
      expect(options.title).toBe("Beta");
      expect(items.map((item) => [item.label, item.description])).toEqual([
        ["$(sync) Sync Now", "Fetch devices and preview changes"],
        ["$(edit) Edit…", "Change settings, credentials, or the auth profile"],
        ["$(trash) Remove…", "Choose what happens to its synced servers"]
      ]);
    });

    it.each([
      ["$(sync) Sync Now", "nexus.inventory.syncNow"],
      ["$(edit) Edit…", "nexus.inventory.editSource"],
      ["$(trash) Remove…", "nexus.inventory.removeSource"]
    ])("routing %s executes %s with the picked source id (kills a hub that drops the id and re-picks downstream)", async (rowLabel, commandId) => {
      await setupHub([makeSource({ id: "src-1", name: "Alpha" }), makeSource({ id: "src-2", name: "Beta" })]);
      mockShowQuickPick
        .mockImplementationOnce(async (items: HubItem[]) => items.find((item) => item.label === "Beta"))
        .mockImplementationOnce(async (items: HubItem[]) => items.find((item) => item.label === rowLabel));

      await registeredCommands.get("nexus.inventory.manage")!();

      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      expect(mockExecuteCommand).toHaveBeenCalledWith(commandId, "src-2");
    });

    it("empty state offers only the add row with the in-picker placeholder and never the pickInventorySource warning toast", async () => {
      await setupHub([]);
      mockShowQuickPick.mockImplementationOnce(async (items: HubItem[]) => items[0]);

      await registeredCommands.get("nexus.inventory.manage")!();

      expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
      const { items, options } = quickPickCall(0);
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe("$(add) Add Inventory Source…");
      // No trailing period: its sibling ("Choose a source to sync, edit, or
      // remove") has none, and two placeholders on the same picker punctuating
      // differently is the inconsistency this asserts against.
      expect(options.placeHolder).toBe("No inventory sources yet — add one to sync servers from your infrastructure");
      expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.inventory.addSource");
      // M2d's "No inventory sources configured. Add one first." belongs to the
      // direct-command paths only — inside a picker the add row IS the affordance.
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("dismissing level 2 executes nothing", async () => {
      await setupHub([makeSource({ id: "src-1", name: "Alpha" })]);
      mockShowQuickPick
        .mockImplementationOnce(async (items: HubItem[]) => items.find((item) => item.label === "Alpha"))
        .mockResolvedValueOnce(undefined);

      await registeredCommands.get("nexus.inventory.manage")!();

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });
  });

  // T6 — editSource/removeSource gain syncNow's optional-id-with-picker-fallback
  // pattern so the hub's rows land straight on the chosen source.
  describe("inventory command source-id arguments", () => {
    async function setupTwoSources(): Promise<NexusCore> {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      registry.register(makeProvider());
      registerInventoryCommands(core, registry, makeVault(), makeTeardown());
      await core.addOrUpdateInventorySource(makeSource({ id: "src-1", name: "Alpha" }));
      await core.addOrUpdateInventorySource(makeSource({ id: "src-2", name: "Beta" }));
      return core;
    }

    it("editSource(sourceId) skips the picker and opens the form seeded from exactly that source", async () => {
      await setupTwoSources();

      await registeredCommands.get("nexus.inventory.editSource")!("src-2");

      // Two sources means pickInventorySource cannot auto-select — an
      // arg-ignoring editSource would show the picker here (and, with the
      // default undefined resolution, never open a form at all).
      expect(mockShowQuickPick).not.toHaveBeenCalled();
      const { definition } = latestFormCall();
      const nameField = definition.fields.find((field) => field.key === "name") as { value?: string };
      expect(nameField.value).toBe("Beta");
    });

    it("editSource(unknownId) reports the source is gone without falling back to the picker", async () => {
      await setupTwoSources();

      await registeredCommands.get("nexus.inventory.editSource")!("src-gone");

      expect(mockShowErrorMessage).toHaveBeenCalledWith("That inventory source no longer exists.");
      expect(mockShowQuickPick).not.toHaveBeenCalled();
      expect(mockWebviewOpen).not.toHaveBeenCalled();
    });

    it("removeSource(sourceId) skips the picker and confirms against exactly that source", async () => {
      await setupTwoSources();
      mockShowWarningMessage.mockResolvedValueOnce(undefined); // dismiss the confirm

      await registeredCommands.get("nexus.inventory.removeSource")!("src-2");

      expect(mockShowQuickPick).not.toHaveBeenCalled();
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Remove inventory source "Beta"?',
        expect.objectContaining({ modal: true }),
        "Remove"
      );
    });

    it("removeSource(unknownId) reports the source is gone without falling back to the picker", async () => {
      await setupTwoSources();

      await registeredCommands.get("nexus.inventory.removeSource")!("src-gone");

      expect(mockShowErrorMessage).toHaveBeenCalledWith("That inventory source no longer exists.");
      expect(mockShowQuickPick).not.toHaveBeenCalled();
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it.each(["nexus.inventory.editSource", "nexus.inventory.removeSource"])(
      "%s falls back to the picker for a non-string argument (menu/tree context objects must not be read as ids)",
      async (commandId) => {
        await setupTwoSources();
        mockShowQuickPick.mockResolvedValueOnce(undefined);

        await registeredCommands.get(commandId)!({ contextValue: "nexus.server" });

        expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
        expect(mockShowErrorMessage).not.toHaveBeenCalled();
      }
    );
  });
});
