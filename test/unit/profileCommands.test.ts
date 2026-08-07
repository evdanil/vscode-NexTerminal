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
import { AsyncMutex, configMutationLock } from "../../src/services/configMutationLock";
import { proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("openUnifiedForm SSH submit — record+secret mutation locking (FINDING 2, P2 sibling)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback: unknown) => fallback)
    });
    mockShowQuickPick.mockReset();
    mockWebviewOpen.mockReturnValue({ dispose: vi.fn() });
    mockFormValuesToServer.mockReturnValue({ id: "srv-1" });
  });

  it("queues the add/create SSH submit's addOrUpdateServer+syncProxyPasswordSecret pair behind an in-flight locked backup capture, so the captured record and secret are a consistent pre-submit pair (kills the unlocked add-path sibling of the nexus.server.edit race)", async () => {
    const events: string[] = [];
    const ctx = {
      core: {
        getSnapshot: vi.fn(() => ({ servers: [], authProfiles: [] })),
        getAuthProfile: vi.fn(),
        addOrUpdateServer: vi.fn(async () => {
          events.push("addOrUpdateServer");
        }),
        addOrUpdateSerialProfile: vi.fn(),
        addOrUpdateLocalShellProfile: vi.fn()
      }
    } as any;
    mockSyncProxyPasswordSecret.mockImplementation(async () => {
      events.push("syncProxyPasswordSecret");
    });

    // Same call-ordering spy as test/unit/configMutationLockRace.test.ts and
    // the sibling test in test/unit/serverCommands.test.ts — logs when each
    // acquirer's body actually starts/finishes RUNNING against the REAL
    // AsyncMutex, not a bypassed test double.
    const labels = ["capture", "submit"];
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

    // Stand-in for captureBackupStateForExport's locked span — acquires the
    // lock first and blocks (gated) before its body would resolve.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const capturePromise = configMutationLock.runExclusive(async () => {
      await gate;
      return "captured";
    });

    await delay(10);
    expect(events).toEqual(["capture:start"]);

    openUnifiedForm(ctx);
    const { onSubmit } = latestFormOptions();
    const submitPromise = onSubmit({ profileType: "ssh", name: "Server", host: "example.com", username: "me" });

    // Give onSubmit's UI-free body time to reach its own
    // configMutationLock.runExclusive call — it must queue there, not run
    // addOrUpdateServer/syncProxyPasswordSecret ahead of the in-flight capture.
    await delay(10);
    expect(events).toEqual(["capture:start"]);

    releaseGate();
    await capturePromise;
    await submitPromise;

    // The submit's record write and its proxy-secret sync only ran AFTER
    // the capture's locked span fully finished, and ran back-to-back as one
    // generation within the same lock acquisition. If FINDING 2's fix were
    // reverted (this call site left unlocked), "addOrUpdateServer" and
    // "syncProxyPasswordSecret" would appear immediately after
    // "capture:start" — well before "capture:end" — since nothing would
    // make the submit wait for the capture's lock at all.
    expect(events).toEqual([
      "capture:start",
      "capture:end",
      "submit:start",
      "addOrUpdateServer",
      "syncProxyPasswordSecret",
      "submit:end"
    ]);
  });
});

describe("openUnifiedForm SSH submit — create rollback on secret-storage failure (FINDING 1, P2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback: unknown) => fallback)
    });
    mockShowQuickPick.mockReset();
    mockWebviewOpen.mockReturnValue({ dispose: vi.fn() });
    mockFormValuesToServer.mockReturnValue({ id: "srv-new", name: "New Server" });
  });

  it("removes the just-created server and cleans up any partial proxy secret when syncProxyPasswordSecret rejects, and surfaces the failure (kills persisted-without-secret leftover that would duplicate on retry)", async () => {
    const servers = new Map<string, { id: string; name: string }>();
    const secrets = new Map<string, string>();
    const addOrUpdateServer = vi.fn(async (server: { id: string; name: string }) => {
      servers.set(server.id, server);
    });
    const removeServer = vi.fn(async (id: string) => {
      servers.delete(id);
    });
    const secretDelete = vi.fn(async (key: string) => {
      secrets.delete(key);
    });
    const ctx = {
      core: {
        getSnapshot: vi.fn(() => ({ servers: [], authProfiles: [] })),
        getAuthProfile: vi.fn(),
        addOrUpdateServer,
        removeServer,
        addOrUpdateSerialProfile: vi.fn(),
        addOrUpdateLocalShellProfile: vi.fn()
      },
      secretVault: {
        get: vi.fn(),
        store: vi.fn(),
        delete: secretDelete
      }
    } as any;

    mockSyncProxyPasswordSecret.mockImplementation(async () => {
      throw new Error("keychain unavailable");
    });

    openUnifiedForm(ctx);
    const { onSubmit } = latestFormOptions();

    await expect(
      onSubmit({ profileType: "ssh", name: "New Server", host: "example.com", username: "me" })
    ).rejects.toThrow(/server was not created/i);

    // Kill check: a wrong implementation that only surfaces the failure
    // without rolling back would leave "srv-new" sitting in core — this
    // fails against that implementation because the record would still be
    // present here.
    expect(addOrUpdateServer).toHaveBeenCalledTimes(1);
    expect(removeServer).toHaveBeenCalledWith("srv-new");
    expect(servers.has("srv-new")).toBe(false);
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-new"));
    expect(secrets.has(proxyPasswordSecretKey("srv-new"))).toBe(false);
  });

  it("(FINDING 2, P2) reports that the partially created server could not be removed, instead of claiming it was never created, when removeServer's own rollback persist rejects", async () => {
    const servers = new Map<string, { id: string; name: string }>();
    const secrets = new Map<string, string>();
    const addOrUpdateServer = vi.fn(async (server: { id: string; name: string }) => {
      servers.set(server.id, server);
    });
    // removeServer's in-memory delete would normally happen before its
    // persist call rejects (mirroring NexusCore.removeServer: delete from
    // the Map, THEN await repository.saveServers) — but from this call
    // site's point of view all that matters is that the call rejects, so
    // the record in `servers` here stands untouched, matching "the record
    // is still on disk after a reload".
    const removeServer = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    const secretDelete = vi.fn(async (key: string) => {
      secrets.delete(key);
    });
    const ctx = {
      core: {
        getSnapshot: vi.fn(() => ({ servers: [], authProfiles: [] })),
        getAuthProfile: vi.fn(),
        addOrUpdateServer,
        removeServer,
        addOrUpdateSerialProfile: vi.fn(),
        addOrUpdateLocalShellProfile: vi.fn()
      },
      secretVault: {
        get: vi.fn(),
        store: vi.fn(),
        delete: secretDelete
      }
    } as any;

    mockSyncProxyPasswordSecret.mockImplementation(async () => {
      throw new Error("keychain unavailable");
    });

    openUnifiedForm(ctx);
    const { onSubmit } = latestFormOptions();

    // Kill check: a wrong implementation (the original code, which ignores
    // the removeServer rejection with a bare best-effort catch and always
    // throws the generic "was not created" message) would satisfy a
    // `/was not created/i` assertion — that message lies about the outcome
    // when removeServer failed. This test instead pins the exact
    // could-not-be-removed wording, which the reverted implementation never
    // produces (it has no removeFailed branch at all), so it fails against
    // that prior behavior.
    let caught: unknown;
    try {
      await onSubmit({ profileType: "ssh", name: "New Server", host: "example.com", username: "me" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Could not store proxy credentials for "New Server" and the partially created server could not be removed — delete it manually if it appears.'
    );
    expect((caught as Error).message).not.toMatch(/the server was not created/i);

    expect(removeServer).toHaveBeenCalledWith("srv-new");
    // The secret delete stays best-effort regardless of the removeServer
    // outcome.
    expect(secretDelete).toHaveBeenCalledWith(proxyPasswordSecretKey("srv-new"));
  });

  it("(FINDINGS 2+3, P2) restores the displaced owner's auto-open flag when the newly created server's flag rollback removes it, after a failed secret write (kills owner-left-cleared, create variant)", async () => {
    // A hand-rolled stand-in for NexusCore's server map that mirrors
    // addOrUpdateServer's real single-owner enforcement for
    // openFileExplorerOnFirstConnect (src/core/nexusCore.ts): enabling the
    // flag on the server being written clears it from whichever other
    // server currently holds it. Without replicating that here, "Server B"
    // would never actually get cleared in the first place and this test
    // would pass even without the fix under review.
    const servers = new Map<string, { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }>([
      ["srv-b", { id: "srv-b", name: "Server B", openFileExplorerOnFirstConnect: true }]
    ]);
    const secrets = new Map<string, string>();
    const addOrUpdateServer = vi.fn(async (server: { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }) => {
      if (server.openFileExplorerOnFirstConnect) {
        for (const [id, existing] of servers.entries()) {
          if (id !== server.id && existing.openFileExplorerOnFirstConnect) {
            servers.set(id, { ...existing, openFileExplorerOnFirstConnect: undefined });
          }
        }
      }
      servers.set(server.id, server);
    });
    const removeServer = vi.fn(async (id: string) => {
      servers.delete(id);
    });
    const secretDelete = vi.fn(async (key: string) => {
      secrets.delete(key);
    });
    const ctx = {
      core: {
        getSnapshot: vi.fn(() => ({ servers: [...servers.values()], authProfiles: [] })),
        getAuthProfile: vi.fn(),
        addOrUpdateServer,
        removeServer,
        addOrUpdateSerialProfile: vi.fn(),
        addOrUpdateLocalShellProfile: vi.fn()
      },
      secretVault: {
        get: vi.fn(),
        store: vi.fn(),
        delete: secretDelete
      }
    } as any;

    mockFormValuesToServer.mockReturnValue({ id: "srv-new", name: "New Server", openFileExplorerOnFirstConnect: true });
    mockSyncProxyPasswordSecret.mockImplementation(async () => {
      throw new Error("keychain unavailable");
    });

    openUnifiedForm(ctx);
    const { onSubmit } = latestFormOptions();

    await expect(
      onSubmit({
        profileType: "ssh",
        name: "New Server",
        host: "example.com",
        username: "me",
        openFileExplorerOnFirstConnect: true
      })
    ).rejects.toThrow(/server was not created/i);

    // The newly created (and now rolled-back) server is gone.
    expect(servers.has("srv-new")).toBe(false);

    // Kill check: without capturing/restoring the displaced owner, "Server
    // B" stays cleared here — addOrUpdateServer("srv-new") clears its flag
    // as a side effect of enforcing single ownership, and the pre-fix
    // rollback only ever removed the just-created record, never touching
    // the server it displaced. This assertion fails against that
    // implementation because Server B's flag would read undefined instead
    // of true.
    const finalB = servers.get("srv-b");
    expect(finalB?.openFileExplorerOnFirstConnect).toBe(true);
  });

  it("(FINDING 2, P2) renaming the displaced owner while the proxy-secret write is still pending still restores its auto-open flag, merged onto the concurrent rename rather than skipped outright (kills all-or-nothing displaced-owner restore, create variant)", async () => {
    // Same hand-rolled single-owner-enforcing stand-in as the sibling test
    // above.
    const servers = new Map<string, { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }>([
      ["srv-b", { id: "srv-b", name: "Server B", openFileExplorerOnFirstConnect: true }]
    ]);
    const secrets = new Map<string, string>();
    const addOrUpdateServer = vi.fn(async (server: { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }) => {
      if (server.openFileExplorerOnFirstConnect) {
        for (const [id, existing] of servers.entries()) {
          if (id !== server.id && existing.openFileExplorerOnFirstConnect) {
            servers.set(id, { ...existing, openFileExplorerOnFirstConnect: undefined });
          }
        }
      }
      servers.set(server.id, server);
    });
    const removeServer = vi.fn(async (id: string) => {
      servers.delete(id);
    });
    const secretDelete = vi.fn(async (key: string) => {
      secrets.delete(key);
    });
    const ctx = {
      core: {
        getSnapshot: vi.fn(() => ({ servers: [...servers.values()], authProfiles: [] })),
        getAuthProfile: vi.fn(),
        addOrUpdateServer,
        removeServer,
        addOrUpdateSerialProfile: vi.fn(),
        addOrUpdateLocalShellProfile: vi.fn()
      },
      secretVault: {
        get: vi.fn(),
        store: vi.fn(),
        delete: secretDelete
      }
    } as any;

    mockFormValuesToServer.mockReturnValue({ id: "srv-new", name: "New Server", openFileExplorerOnFirstConnect: true });

    // Gate the proxy-secret write so a concurrent rename of the displaced
    // owner (B) can commit while it's still pending.
    let rejectSecretWrite!: (err: unknown) => void;
    mockSyncProxyPasswordSecret.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    openUnifiedForm(ctx);
    const { onSubmit } = latestFormOptions();

    const submitPromise = onSubmit({
      profileType: "ssh",
      name: "New Server",
      host: "example.com",
      username: "me",
      openFileExplorerOnFirstConnect: true
    });

    // Let addOrUpdateServer("srv-new") land — displacing B's flag — and let
    // syncProxyPasswordSecret reach the gated write.
    await delay(10);

    // Simulate nexus.server.rename committing against B (the displaced
    // owner) while the secret write is still pending.
    const currentB = servers.get("srv-b")!;
    servers.set("srv-b", { ...currentB, name: "Renamed B" });

    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(submitPromise).rejects.toThrow(/server was not created/i);

    // The newly created (and now rolled-back) server is gone.
    expect(servers.has("srv-new")).toBe(false);

    // Kill check: a whole-record-equality (all-or-nothing) implementation
    // detects the name divergence and skips restoring B's flag entirely —
    // B's flag would read undefined instead of true. The fix restores ONLY
    // the flag onto B's CURRENT (renamed) record instead.
    const finalB = servers.get("srv-b");
    expect(finalB?.name).toBe("Renamed B");
    expect(finalB?.openFileExplorerOnFirstConnect).toBe(true);
  });

  it("(FINDING 1, P2) the displaced owner's EXACT-MATCH (unchanged) restore path also skips when another server concurrently claimed the flag while the secret write was still pending (kills exact-match-path blind restore, create variant)", async () => {
    // Same hand-rolled single-owner-enforcing stand-in as the sibling tests
    // above, plus an uninvolved third server (C) that a concurrent command
    // will claim the flag on.
    const servers = new Map<string, { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }>([
      ["srv-b", { id: "srv-b", name: "Server B", openFileExplorerOnFirstConnect: true }],
      ["srv-c", { id: "srv-c", name: "Server C" }]
    ]);
    const secrets = new Map<string, string>();
    const addOrUpdateServer = vi.fn(async (server: { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }) => {
      if (server.openFileExplorerOnFirstConnect) {
        for (const [id, existing] of servers.entries()) {
          if (id !== server.id && existing.openFileExplorerOnFirstConnect) {
            servers.set(id, { ...existing, openFileExplorerOnFirstConnect: undefined });
          }
        }
      }
      servers.set(server.id, server);
    });
    const removeServer = vi.fn(async (id: string) => {
      servers.delete(id);
    });
    const secretDelete = vi.fn(async (key: string) => {
      secrets.delete(key);
    });
    const ctx = {
      core: {
        getSnapshot: vi.fn(() => ({ servers: [...servers.values()], authProfiles: [] })),
        getAuthProfile: vi.fn(),
        addOrUpdateServer,
        removeServer,
        addOrUpdateSerialProfile: vi.fn(),
        addOrUpdateLocalShellProfile: vi.fn()
      },
      secretVault: {
        get: vi.fn(),
        store: vi.fn(),
        delete: secretDelete
      }
    } as any;

    mockFormValuesToServer.mockReturnValue({ id: "srv-new", name: "New Server", openFileExplorerOnFirstConnect: true });

    // Gate the proxy-secret write so a concurrent command can enable the
    // flag on C while it's still pending. B (the displaced owner) itself is
    // never touched — its live record stays byte-for-byte what
    // addOrUpdateServer("srv-new") left it, so the rollback's equality
    // check takes the EXACT-MATCH branch, not the divergent/merge branch.
    let rejectSecretWrite!: (err: unknown) => void;
    mockSyncProxyPasswordSecret.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectSecretWrite = reject; })
    );

    openUnifiedForm(ctx);
    const { onSubmit } = latestFormOptions();

    const submitPromise = onSubmit({
      profileType: "ssh",
      name: "New Server",
      host: "example.com",
      username: "me",
      openFileExplorerOnFirstConnect: true
    });

    // Let addOrUpdateServer("srv-new") land — displacing B's flag — and let
    // syncProxyPasswordSecret reach the gated write.
    await delay(10);

    // Simulate a concurrent command enabling the flag on C while this
    // submission's secret write is still pending. Single-owner enforcement
    // only clears whoever CURRENTLY holds the flag (no one, at this point —
    // B was already cleared), so this cleanly hands the flag to C without
    // touching B.
    await addOrUpdateServer({ ...servers.get("srv-c")!, openFileExplorerOnFirstConnect: true });

    rejectSecretWrite(new Error("keychain unavailable"));

    await expect(submitPromise).rejects.toThrow(/server was not created/i);

    // The newly created (and now rolled-back) server is gone.
    expect(servers.has("srv-new")).toBe(false);

    // Kill check: the pre-fix exact-match branch restores B's flag
    // UNCONDITIONALLY (its currentFlagOwner check only ever guarded the
    // divergent/else branch) — that call would itself clear C's flag via
    // addOrUpdateServer's single-owner enforcement, leaving C cleared and B
    // wrongly restored. The fix hoists the currentFlagOwner check so it
    // guards the exact-match branch too: C, the CURRENT flag owner, keeps
    // it, and B's restore is skipped entirely.
    const finalB = servers.get("srv-b");
    const finalC = servers.get("srv-c");
    expect(finalC?.openFileExplorerOnFirstConnect).toBe(true);
    expect(finalB?.openFileExplorerOnFirstConnect).toBeUndefined();
  });

  it("(FINDINGS 2+3, P2 — sanity) a successful create that enables the flag leaves the previous owner cleared, as intended (unchanged existing behavior)", async () => {
    const servers = new Map<string, { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }>([
      ["srv-b", { id: "srv-b", name: "Server B", openFileExplorerOnFirstConnect: true }]
    ]);
    const addOrUpdateServer = vi.fn(async (server: { id: string; name: string; openFileExplorerOnFirstConnect?: boolean }) => {
      if (server.openFileExplorerOnFirstConnect) {
        for (const [id, existing] of servers.entries()) {
          if (id !== server.id && existing.openFileExplorerOnFirstConnect) {
            servers.set(id, { ...existing, openFileExplorerOnFirstConnect: undefined });
          }
        }
      }
      servers.set(server.id, server);
    });
    const ctx = {
      core: {
        getSnapshot: vi.fn(() => ({ servers: [...servers.values()], authProfiles: [] })),
        getAuthProfile: vi.fn(),
        addOrUpdateServer,
        removeServer: vi.fn(),
        addOrUpdateSerialProfile: vi.fn(),
        addOrUpdateLocalShellProfile: vi.fn()
      },
      secretVault: {
        get: vi.fn(),
        store: vi.fn(),
        delete: vi.fn()
      }
    } as any;

    mockFormValuesToServer.mockReturnValue({ id: "srv-new", name: "New Server", openFileExplorerOnFirstConnect: true });
    mockSyncProxyPasswordSecret.mockImplementation(async () => {});

    openUnifiedForm(ctx);
    const { onSubmit } = latestFormOptions();

    await onSubmit({
      profileType: "ssh",
      name: "New Server",
      host: "example.com",
      username: "me",
      openFileExplorerOnFirstConnect: true
    });

    expect(servers.get("srv-new")?.openFileExplorerOnFirstConnect).toBe(true);
    expect(servers.get("srv-b")?.openFileExplorerOnFirstConnect).toBeUndefined();
  });
});
