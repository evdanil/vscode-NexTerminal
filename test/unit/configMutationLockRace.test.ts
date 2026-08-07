/**
 * Integration coverage for the round-14 fix: a shared AsyncMutex
 * (configMutationLock) serializes config-level mutation flows
 * (configCommands' replace-mode import / complete reset) against
 * inventory command critical sections (inventoryCommands' addSource /
 * editSource / removeSource / syncNow).
 *
 * Unlike test/unit/configMutationLock.test.ts (pure unit tests of the mutex
 * itself), these tests drive the REAL production command handlers from
 * both modules against a single shared NexusCore/vault, proving the actual
 * call sites in configCommands.ts and inventoryCommands.ts serialize
 * through the SAME singleton — not just that the mutex class works in
 * isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryCommands, type InventoryRuntimeTeardown } from "../../src/commands/inventoryCommands";
import { captureBackupStateForExport, registerConfigCommands } from "../../src/commands/configCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { inventorySecretKey, type InventoryProvider, type InventorySourceConfig, type InventoryTree } from "../../src/models/inventory";
import type { ServerConfig } from "../../src/models/config";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { AsyncMutex, configMutationLock } from "../../src/services/configMutationLock";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";
import { passwordSecretKey, passphraseSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import type { FormDefinition, FormValues } from "../../src/ui/formTypes";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockExecuteCommand = vi.fn();
const mockOpenTextDocument = vi.fn();
const mockShowTextDocument = vi.fn();
const mockReadFile = vi.fn();
const mockWithProgress = vi.fn();
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
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args),
    showTextDocument: (...args: unknown[]) => mockShowTextDocument(...args),
    withProgress: (opts: unknown, task: (...a: unknown[]) => unknown) => {
      mockWithProgress(opts);
      return task();
    }
  },
  workspace: {
    fs: {
      readFile: (...args: unknown[]) => mockReadFile(...args)
    },
    openTextDocument: (...args: unknown[]) => mockOpenTextDocument(...args),
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({
      get: () => undefined,
      inspect: () => ({ defaultValue: undefined, globalValue: undefined }),
      update: vi.fn()
    }))
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: "file" })
  },
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 }
}));

// Mirrors test/unit/inventoryCommands.test.ts's idiom for driving a
// WebviewFormPanel-based command (editSource no longer runs a sequential
// prompt wizard — it opens a webview form and mutates on submit): capture the
// (formId, definition, options) triple WebviewFormPanel.open was called with,
// and invoke onSubmit directly rather than going through a real webview.
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

function makeTeardown(): InventoryRuntimeTeardown {
  return { teardownServerRuntime: vi.fn(async () => {}) };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("configMutationLock — real call-site serialization", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockWebviewOpen.mockImplementation(() => makeFakePanel());
    const store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);
  });

  it("ordering: removeSource's critical section (a slow vault.delete) fully completes before a concurrent replace-mode import's mutation phase begins — both go through the SAME configMutationLock singleton (kills unserialized interleaving between inventoryCommands and configCommands)", async () => {
    const core = new NexusCore(new InMemoryConfigRepository());
    await core.initialize();
    const registry = new InventoryProviderRegistry();
    registry.register(makeProvider());

    const backingStore = new Map<string, string>([[inventorySecretKey("src-1", "apiToken"), "tok"]]);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const vault = {
      get: vi.fn(async (key: string) => backingStore.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        backingStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        if (key === inventorySecretKey("src-1", "apiToken")) {
          // The controllable slow delete: removeSource's own critical
          // section blocks here until the test releases it.
          await deleteGate;
        }
        backingStore.delete(key);
      })
    };

    registerInventoryCommands(core, registry, vault, makeTeardown());
    registerConfigCommands(core, vault);
    await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

    // Spy on the SHARED singleton's runExclusive to log when each acquirer's
    // body actually starts/finishes RUNNING (not merely when it's called) —
    // while still delegating to the real AsyncMutex implementation, so the
    // genuine production locking behavior is exercised, not a test double.
    const events: string[] = [];
    const labels = ["removal", "import"];
    let nextLabel = 0;
    const realRunExclusive = AsyncMutex.prototype.runExclusive;
    vi.spyOn(configMutationLock, "runExclusive").mockImplementation(function (
      this: AsyncMutex,
      fn: () => Promise<unknown>
    ) {
      const label = labels[nextLabel] ?? `call-${nextLabel}`;
      nextLabel++;
      return realRunExclusive.call(this, async () => {
        events.push(`${label}:start`);
        try {
          return await fn();
        } finally {
          events.push(`${label}:end`);
        }
      });
    } as typeof configMutationLock.runExclusive);

    // No owned servers -> removeSource's confirm modal has a single "Remove" button.
    mockShowWarningMessage.mockResolvedValueOnce("Remove");
    const removeCmd = registeredCommands.get("nexus.inventory.removeSource")!;
    const removePromise = removeCmd();

    // Let removeSource run up to (and block inside) the slow vault.delete —
    // it acquires the lock and calls it BEFORE this test invokes the import.
    await delay(10);
    expect(events).toEqual(["removal:start"]);

    // Now start a replace-mode import while removeSource's critical section
    // is still in flight (stuck on deleteGate). It should queue on the SAME
    // lock rather than run its mutation phase immediately.
    const importPayload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      servers: [],
      inventorySources: [
        {
          id: "src-2",
          providerId: "fake",
          name: "Imported Source",
          targetFolder: "",
          prunePolicy: "orphan",
          defaultUsername: "admin",
          config: {},
          secretFieldIds: []
        }
      ]
    };
    mockShowQuickPick
      .mockResolvedValueOnce({ value: "nexusExport" }) // import chooser
      .mockResolvedValueOnce({ value: "replace" }); // Import Mode
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/x/export.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(JSON.stringify(importPayload), "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    const importPromise = importCmd();

    // Give the import's UI-only prefix (quick picks, file read) time to run
    // all the way up to its own configMutationLock.runExclusive call — it
    // must queue there, NOT start executing, while removal still holds it.
    await delay(10);
    expect(events).toEqual(["removal:start"]);

    // Release removeSource's slow delete — its critical section can now
    // finish and release the lock for the queued import.
    releaseDelete();
    await removePromise;
    await importPromise;

    // The import's mutation body never started until removal's had fully
    // finished. If the fix were reverted (both call sites mutate directly
    // without going through configMutationLock, or the mock above bypassed
    // the real mutex instead of delegating to it), "import:start" would
    // appear before "removal:end" here.
    expect(events).toEqual(["removal:start", "removal:end", "import:start", "import:end"]);

    // End-state sanity: because import's replace-mode wipe observed
    // removal's ALREADY-COMPLETED state, src-1 is gone (removed by
    // removeSource) and only the freshly-imported src-2 remains — no
    // collision or corruption from a mid-removal read.
    const finalSources = core.getSnapshot().inventorySources;
    expect(finalSources.map((s) => s.id)).toEqual(["src-2"]);
    expect(backingStore.has(inventorySecretKey("src-1", "apiToken"))).toBe(false);
  });

  it("syncNow does not hold the config mutation lock while its confirmation modal is open — another flow can acquire it immediately (kills lock-held-across-UI)", async () => {
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
    const vault = {
      get: vi.fn(async (key: string) => (key === inventorySecretKey("src-1", "apiToken") ? "tok" : undefined)),
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {})
    };
    registerInventoryCommands(core, registry, vault, makeTeardown());
    await core.addOrUpdateInventorySource(makeSource({ secretFieldIds: ["apiToken"] }));

    let resolveModal!: (value: string | undefined) => void;
    const modalShown = new Promise<void>((resolveShown) => {
      mockShowInformationMessage.mockImplementationOnce(() => {
        resolveShown();
        return new Promise<string | undefined>((resolve) => {
          resolveModal = resolve;
        });
      });
    });

    const syncCmd = registeredCommands.get("nexus.inventory.syncNow")!;
    const syncPromise = syncCmd("src-1");

    // Wait until syncNow's confirm modal is actually up (unresolved).
    await modalShown;

    // While the modal sits open, a separate acquirer must be able to take
    // the lock right away — it must not be held across interactive UI.
    const otherAcquired = await Promise.race([
      configMutationLock.runExclusive(async () => "acquired" as const),
      delay(50).then(() => "timed-out" as const)
    ]);
    expect(otherAcquired).toBe("acquired");

    // Dismiss the still-open modal so the command settles cleanly.
    resolveModal(undefined);
    await syncPromise;
  });

  describe("captureBackupStateForExport (FINDING 1 — backup-export review)", () => {
    it("a concurrent editSource mutation queues behind the in-flight locked capture, so the captured source record and its secret are a consistent pre-edit pair (kills the unlocked torn capture: old config paired with a new token)", async () => {
      const core = new NexusCore(new InMemoryConfigRepository());
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      const provider = makeProvider();
      registry.register(provider);

      const backingStore = new Map<string, string>([[inventorySecretKey("src-1", "apiToken"), "old-token"]]);
      // Gates the FIRST vault.get for this source's secret — i.e. the read
      // captureInventorySourcesForBackup itself does inside the lock. A
      // second read of the same key (editSource's own pre-overwrite
      // "previousValue" read, once it's finally allowed to run) passes
      // straight through — it only matters that it happens strictly AFTER
      // capture's lock section, which the assertions below confirm.
      let gateArmed = true;
      let releaseGet!: () => void;
      const getGate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      const vault = {
        get: vi.fn(async (key: string) => {
          if (gateArmed && key === inventorySecretKey("src-1", "apiToken")) {
            gateArmed = false;
            await getGate;
          }
          return backingStore.get(key);
        }),
        store: vi.fn(async (key: string, value: string) => {
          backingStore.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          backingStore.delete(key);
        })
      };

      registerInventoryCommands(core, registry, vault, makeTeardown());
      registerConfigCommands(core, vault);
      await core.addOrUpdateInventorySource(
        makeSource({ name: "NetBox", targetFolder: "Infra", config: { host: "netbox.local" }, secretFieldIds: ["apiToken"] })
      );

      // Same call-ordering spy as the test above — logs when each acquirer's
      // body actually starts/finishes running against the REAL shared mutex.
      const events: string[] = [];
      const labels = ["capture", "edit"];
      let nextLabel = 0;
      const realRunExclusive = AsyncMutex.prototype.runExclusive;
      vi.spyOn(configMutationLock, "runExclusive").mockImplementation(function (
        this: AsyncMutex,
        fn: () => Promise<unknown>
      ) {
        const label = labels[nextLabel] ?? `call-${nextLabel}`;
        nextLabel++;
        return realRunExclusive.call(this, async () => {
          events.push(`${label}:start`);
          try {
            return await fn();
          } finally {
            events.push(`${label}:end`);
          }
        });
      } as typeof configMutationLock.runExclusive);

      // Start the locked capture — it acquires the lock immediately, takes
      // its fresh snapshot, and blocks inside the gated vault.get for the
      // source's secret.
      const capturePromise = captureBackupStateForExport(core, vault);

      await delay(10);
      expect(events).toEqual(["capture:start"]);

      // Now open editSource's form and submit it with values that rename the
      // source AND rotate its token — while the capture is still mid-flight.
      // editSource no longer runs a sequential prompt wizard: it opens a
      // webview form (pickInventorySource auto-selects the single registered
      // source, no UI) and only touches configMutationLock once onSubmit
      // runs — mirrors test/unit/inventoryCommands.test.ts's WebviewFormPanel
      // entry point.
      const editCmd = registeredCommands.get("nexus.inventory.editSource")!;
      await editCmd();
      const { onSubmit } = latestFormCall();

      const editPromise = onSubmit({
        name: "Renamed Source",
        targetFolder: "Infra",
        defaultUsername: "admin",
        prunePolicy: "orphan",
        host: "netbox.local",
        apiToken: "new-token" // rotated
      });

      // Give onSubmit's UI-only prefix (form-value parsing, none of which
      // touches configMutationLock since targetFolder is non-blank here) time
      // to run all the way up to its own runExclusive call — it must queue
      // there, not run its store ahead of the still-in-flight capture.
      await delay(10);
      expect(events).toEqual(["capture:start"]);
      expect(core.getInventorySource("src-1")?.name).toBe("NetBox");
      expect(backingStore.get(inventorySecretKey("src-1", "apiToken"))).toBe("old-token");

      // Release the capture's gated read — its critical section can now
      // finish and hand the lock to the queued edit.
      releaseGet();
      const captured = await capturePromise;
      await editPromise;

      expect(events).toEqual(["capture:start", "capture:end", "edit:start", "edit:end"]);

      // The captured pair is CONSISTENT: the source record captured is the
      // pre-edit one ("NetBox"/"netbox.local"), and the secret captured
      // alongside it is that SAME generation's token ("old-token") — never
      // the pre-edit record paired with the post-edit token. A reverted fix
      // (capturing the snapshot up front, then reading secrets with no lock
      // held) would let editSource's mutation complete fully during the
      // gated read, so releasing the gate would hand back "new-token"
      // instead — a torn pairing this assertion catches.
      expect(captured.inventorySources).toHaveLength(1);
      expect(captured.inventorySources[0].name).toBe("NetBox");
      expect(captured.inventorySourceSecrets["src-1"]?.apiToken).toBe("old-token");

      // The edit itself was never blocked forever — once the lock freed up
      // it proceeded and took effect.
      expect(core.getInventorySource("src-1")?.name).toBe("Renamed Source");
      expect(backingStore.get(inventorySecretKey("src-1", "apiToken"))).toBe("new-token");
    });

    it("a syncNow prune-'delete' mutation (which deletes a server record AND its vault password) queues behind an in-flight locked capture, so the captured server record and its password are a consistent pre-sync pair (kills the round-15 fix's narrow scope, which left server records + secrets reading outside the lock)", async () => {
      // "owned-1" is owned by inventory source "src-1" and will be pruned
      // ("delete" policy) once the source's next fetch comes back without it.
      const owned = makeServer({
        id: "owned-1",
        name: "old-sw",
        origin: { sourceId: "src-1", externalId: "device:1", syncedAt: 1 }
      });
      const repo = new InMemoryConfigRepository([owned]);
      const core = new NexusCore(repo);
      await core.initialize();
      const registry = new InventoryProviderRegistry();
      // Empty fetch — the previously-synced "owned-1" is no longer reported,
      // so the plan prunes it under the source's "delete" policy.
      const provider = makeProvider({
        fetchInventory: vi.fn(async (): Promise<InventoryTree> => ({ contractVersion: 1, devices: [] }))
      });
      registry.register(provider);

      const backingStore = new Map<string, string>([
        [passwordSecretKey("owned-1"), "pw1"],
        [inventorySecretKey("src-1", "apiToken"), "tok"]
      ]);
      // Gates the FIRST vault.get for "owned-1"'s password — i.e. the read
      // captureBackupStateForExport's own server-secret loop does inside the
      // lock. Every other vault.get (the source-secret pre-check reads
      // syncNow does before ever touching the lock, the passphrase/proxy
      // reads for the same server, syncNow's own credential-drift re-read
      // inside ITS OWN later lock span) passes straight through.
      let gateArmed = true;
      let releaseGet!: () => void;
      const getGate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      const vault = {
        get: vi.fn(async (key: string) => {
          if (gateArmed && key === passwordSecretKey("owned-1")) {
            gateArmed = false;
            await getGate;
          }
          return backingStore.get(key);
        }),
        store: vi.fn(async (key: string, value: string) => {
          backingStore.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          backingStore.delete(key);
        })
      };

      const teardown = makeTeardown();
      registerInventoryCommands(core, registry, vault, teardown);
      registerConfigCommands(core, vault);
      await core.addOrUpdateInventorySource(makeSource({ prunePolicy: "delete", secretFieldIds: ["apiToken"] }));

      // Same call-ordering spy as the tests above.
      const events: string[] = [];
      const labels = ["capture", "syncNow"];
      let nextLabel = 0;
      const realRunExclusive = AsyncMutex.prototype.runExclusive;
      vi.spyOn(configMutationLock, "runExclusive").mockImplementation(function (
        this: AsyncMutex,
        fn: () => Promise<unknown>
      ) {
        const label = labels[nextLabel] ?? `call-${nextLabel}`;
        nextLabel++;
        return realRunExclusive.call(this, async () => {
          events.push(`${label}:start`);
          try {
            return await fn();
          } finally {
            events.push(`${label}:end`);
          }
        });
      } as typeof configMutationLock.runExclusive);

      // Start the locked capture — it acquires the lock immediately, takes
      // its fresh snapshot (including "owned-1"), and blocks inside the
      // gated vault.get for "owned-1"'s password.
      const capturePromise = captureBackupStateForExport(core, vault);

      await delay(10);
      expect(events).toEqual(["capture:start"]);

      // Now start a full syncNow run — its own vault reads (the source's
      // apiToken, for the required-secret check and for fetchInventory) and
      // its confirm modal all happen BEFORE it ever touches
      // configMutationLock, so none of that is blocked by the capture's
      // gate. Only its post-confirmation mutation phase (teardown + apply +
      // pruned-secret vault.delete, all inside its own runExclusive span)
      // must queue behind the still-in-flight capture.
      mockShowInformationMessage.mockResolvedValueOnce("Apply");
      const syncCmd = registeredCommands.get("nexus.inventory.syncNow")!;
      const syncPromise = syncCmd("src-1");

      await delay(10);
      expect(events).toEqual(["capture:start"]);
      expect(core.getServer("owned-1")).toBeDefined();
      expect(backingStore.get(passwordSecretKey("owned-1"))).toBe("pw1");

      // Release the capture's gated read — its critical section can now
      // finish and hand the lock to the queued syncNow mutation.
      releaseGet();
      const captured = await capturePromise;
      await syncPromise;

      expect(events).toEqual(["capture:start", "capture:end", "syncNow:start", "syncNow:end"]);

      // The captured pair is CONSISTENT: the server record captured is the
      // pre-sync one (still owning its origin), and the password captured
      // alongside it is that SAME pre-sync generation's credential ("pw1")
      // — never a pre-sync record paired with an already-wiped credential.
      // A reverted fix (server records/secrets read directly in
      // exportBackup with no lock, or captured in a SEPARATE, narrower lock
      // span than the one protecting the snapshot) would let syncNow's
      // prune-delete mutation — including its own vault.delete of this
      // exact key — complete fully during the gated read, so releasing the
      // gate would hand back `undefined` instead of "pw1": a server record
      // with no password, the torn pairing this assertion catches.
      expect(captured.servers).toHaveLength(1);
      expect(captured.servers[0].id).toBe("owned-1");
      expect(captured.servers[0].origin?.sourceId).toBe("src-1");
      expect(captured.serverSecrets.passwords["owned-1"]).toBe("pw1");

      // syncNow itself was never blocked forever — once the lock freed up it
      // proceeded and took effect: the server is pruned and its password
      // gone from the live vault, even though the capture above still holds
      // the earlier, consistent generation.
      expect(teardown.teardownServerRuntime).toHaveBeenCalledWith("owned-1", expect.any(Function));
      expect(core.getServer("owned-1")).toBeUndefined();
      expect(backingStore.get(passwordSecretKey("owned-1"))).toBeUndefined();
    });
  });
});
