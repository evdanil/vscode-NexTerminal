import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowWarningMessage = vi.fn();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn()
  },
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() }))
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => true)
    }))
  },
  env: {
    clipboard: {
      writeText: vi.fn()
    }
  },
  TerminalLocation: { Editor: 2, Panel: 1 },
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
    public dispose = vi.fn();
  }
}));

vi.mock("../../src/services/serial/serialPty", () => ({
  SerialPty: vi.fn(function () { return {}; })
}));

vi.mock("../../src/services/serial/smartSerialPty", () => ({
  SmartSerialPty: vi.fn(function () { return {}; }),
  normalizePortPath: vi.fn((p: string) => p)
}));

vi.mock("../../src/logging/sessionTranscriptLogger", () => ({
  createSessionTranscript: vi.fn(() => undefined)
}));

const mockWebviewFormPanelOpen = vi.fn();

vi.mock("../../src/ui/webviewFormPanel", () => ({
  WebviewFormPanel: {
    open: (...args: unknown[]) => mockWebviewFormPanelOpen(...args)
  }
}));

import * as vscode from "vscode";
import { formValuesToSerial, registerSerialCommands } from "../../src/commands/serialCommands";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { SerialProfile } from "../../src/models/config";
import { configMutationLock } from "../../src/services/configMutationLock";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { FormValues } from "../../src/ui/formTypes";

describe("formValuesToSerial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("normalizes valid group values", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3",
      group: "  Lab / Rack  "
    });
    expect(serial).toBeDefined();
    expect(serial!.group).toBe("Lab/Rack");
  });

  it("rejects invalid non-empty group values", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3",
      group: "/"
    });
    expect(serial).toBeUndefined();
  });

  it("defaults connection mode to standard", () => {
    const serial = formValuesToSerial({
      name: "USB Console",
      path: "COM3"
    });
    expect(serial?.mode).toBe("standard");
  });

  it("preserves smart-follow metadata on edit", () => {
    const serial = formValuesToSerial(
      {
        name: "USB Console",
        path: "COM9",
        mode: "smartFollow"
      },
      {
        id: "sp1",
        deviceHint: { serialNumber: "ABC123", vendorId: "1111" }
      }
    );
    expect(serial).toMatchObject({
      id: "sp1",
      path: "COM9",
      mode: "smartFollow",
      deviceHint: { serialNumber: "ABC123", vendorId: "1111" }
    });
  });
});

describe("registerSerialCommands port collision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("routes Add Serial Profile to a dedicated serial add form", async () => {
    const ctx = {
      core: { getSnapshot: vi.fn(() => ({ serialProfiles: [], servers: [], explicitGroups: [] })) },
      serialSidecar: {} as any,
      loggerFactory: { create: vi.fn() } as any,
      macroAutoTrigger: { createObserver: vi.fn() } as any,
      sessionLogDir: "",
      serialTerminals: new Map(),
      highlighter: {} as any,
      activityIndicators: new Map()
    } as any;

    registerSerialCommands(ctx);
    const addCmd = registeredCommands.get("nexus.serial.add");
    expect(addCmd).toBeDefined();

    await addCmd!();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("nexus.profile.add", {
      addMode: "serial",
      profileType: "serial"
    });
  });

  it("blocks a new serial session when the target port is already held by another session", async () => {
    const profile = {
      id: "sp1",
      name: "USB Console",
      path: "COM3",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
      mode: "standard"
    };
    const existingTerminal = { name: "Nexus Serial: Other", show: vi.fn(), dispose: vi.fn() } as any;
    const serialTerminals = new Map();
    serialTerminals.set("existing-session", {
      terminal: existingTerminal,
      profileId: "other-profile",
      transportSessionId: "tsid-1",
      activePath: "COM3"
    });
    const ctx = {
      core: {
        getSerialProfile: vi.fn(() => profile)
      },
      serialSidecar: {} as any,
      loggerFactory: { create: vi.fn() } as any,
      macroAutoTrigger: { createObserver: vi.fn() } as any,
      sessionLogDir: "",
      serialTerminals,
      highlighter: {} as any,
      focusedTerminal: undefined,
      activityIndicators: new Map()
    } as any;

    registerSerialCommands(ctx);
    const connectCommand = registeredCommands.get("nexus.serial.connect");
    expect(connectCommand).toBeDefined();

    await connectCommand!("sp1");

    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Serial port COM3 is already in use")
    );
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Nexus Serial: Other")
    );
  });

  it("refocuses the existing terminal when connecting a serial profile that already has a session", async () => {
    const profile = {
      id: "sp1",
      name: "USB Console",
      path: "COM7",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
      mode: "standard"
    };
    const existingTerminal = { name: "Nexus Serial: USB Console", show: vi.fn(), dispose: vi.fn() } as any;
    const serialTerminals = new Map();
    serialTerminals.set("existing-session", {
      terminal: existingTerminal,
      profileId: "sp1",
      transportSessionId: "tsid-1",
      activePath: "COM7"
    });
    const ctx = {
      core: {
        getSerialProfile: vi.fn(() => profile)
      },
      serialSidecar: {} as any,
      loggerFactory: { create: vi.fn() } as any,
      macroAutoTrigger: { createObserver: vi.fn() } as any,
      sessionLogDir: "",
      serialTerminals,
      highlighter: {} as any,
      focusedTerminal: undefined,
      activityIndicators: new Map()
    } as any;

    registerSerialCommands(ctx);
    const connectCommand = registeredCommands.get("nexus.serial.connect");

    await connectCommand!("sp1");

    expect(existingTerminal.show).toHaveBeenCalledTimes(1);
    expect(ctx.focusedTerminal).toBe(existingTerminal);
    // No warning toast: refocus happens silently when the same profile is re-connected.
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it("refocuses the existing terminal when reconnecting a smart-follow profile", async () => {
    const profile = {
      id: "sp1",
      name: "USB Console",
      path: "COM7",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
      mode: "smartFollow"
    };
    const existingTerminal = { name: "Nexus Serial: USB Console [Smart Follow]", show: vi.fn(), dispose: vi.fn() } as any;
    const serialTerminals = new Map();
    serialTerminals.set("existing-session", {
      terminal: existingTerminal,
      profileId: "sp1",
      transportSessionId: "tsid-1",
      smartFollow: true,
      activePath: "COM7"
    });
    const ctx = {
      core: {
        getSerialProfile: vi.fn(() => profile)
      },
      serialSidecar: {} as any,
      loggerFactory: { create: vi.fn() } as any,
      macroAutoTrigger: { createObserver: vi.fn() } as any,
      sessionLogDir: "",
      serialTerminals,
      highlighter: {} as any,
      focusedTerminal: undefined,
      activityIndicators: new Map()
    } as any;

    registerSerialCommands(ctx);
    const connectCommand = registeredCommands.get("nexus.serial.connect");

    await connectCommand!("sp1");

    expect(existingTerminal.show).toHaveBeenCalledTimes(1);
    expect(ctx.focusedTerminal).toBe(existingTerminal);
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });
});

describe("serial test connection command", () => {
  const profile = {
    id: "sp1",
    name: "USB Console",
    path: "COM3",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    mode: "standard"
  };

  function makeTestCtx(overrides: { profiles?: any[]; ports?: any[] } = {}) {
    const profiles = overrides.profiles ?? [profile];
    return {
      core: {
        getSerialProfile: vi.fn((id: string) => profiles.find((p) => p.id === id)),
        getSnapshot: vi.fn(() => ({
          servers: [],
          tunnels: [],
          serialProfiles: profiles,
          activeSessions: [],
          activeSerialSessions: [],
          activeTunnels: [],
          remoteTunnels: [],
          explicitGroups: [],
          authProfiles: [],
          activitySessionIds: new Set(),
          focusedSessionId: undefined
        }))
      },
      serialSidecar: {
        listPorts: vi.fn(async () => overrides.ports ?? [])
      },
      loggerFactory: { create: vi.fn() } as any,
      macroAutoTrigger: { createObserver: vi.fn() } as any,
      sessionLogDir: "",
      serialTerminals: new Map(),
      highlighter: {} as any,
      focusedTerminal: undefined,
      activityIndicators: new Map()
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("reports success when the configured serial path is present", async () => {
    const ctx = makeTestCtx({ ports: [{ path: "COM3", manufacturer: "Acme" }] });

    registerSerialCommands(ctx);
    await registeredCommands.get("nexus.serial.testConnection")!("sp1");

    expect(ctx.serialSidecar.listPorts).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Connection test succeeded for USB Console: COM3 is available."
    );
  });

  it("warns when the configured serial path is missing", async () => {
    const ctx = makeTestCtx({ ports: [{ path: "COM4", manufacturer: "Acme" }] });

    registerSerialCommands(ctx);
    await registeredCommands.get("nexus.serial.testConnection")!("sp1");

    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      "Serial port COM3 is not available. Scan Serial Ports or check the cable and OS permissions.",
      "Scan Serial Ports"
    );
  });

  it("reports saved-path status for smart-follow profiles without claiming a missing hardware hint matched", async () => {
    const ctx = makeTestCtx({
      profiles: [{ ...profile, mode: "smartFollow" }],
      ports: [{ path: "COM3", manufacturer: "Acme" }]
    });

    registerSerialCommands(ctx);
    await registeredCommands.get("nexus.serial.testConnection")!("sp1");

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Smart Follow test for USB Console: saved path COM3 is available. No hardware hint is saved yet."
    );
  });

  it("shows a warning and does not scan ports when no serial profiles exist", async () => {
    const ctx = makeTestCtx({ profiles: [], ports: [{ path: "COM3" }] });

    registerSerialCommands(ctx);
    await registeredCommands.get("nexus.serial.testConnection")!();

    expect(mockShowWarningMessage).toHaveBeenCalledWith("No Nexus serial profiles configured");
    expect(ctx.serialSidecar.listPorts).not.toHaveBeenCalled();
  });
});

describe("serial terminal tab visual differentiation", () => {
  const baseProfile = {
    id: "sp1",
    name: "USB Console",
    path: "COM3",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false
  };

  function makeSerialCtx() {
    return {
      core: { getSerialProfile: vi.fn(() => ({ ...baseProfile, mode: "standard" })), registerSerialSession: vi.fn(), markSessionActivity: vi.fn() },
      serialSidecar: {} as any,
      loggerFactory: { create: vi.fn() } as any,
      macroAutoTrigger: { createObserver: vi.fn(() => ({})), bindObserverToSession: vi.fn() } as any,
      sessionLogDir: "",
      serialTerminals: new Map(),
      highlighter: {} as any,
      focusedTerminal: undefined,
      activityIndicators: new Map(),
      terminalRegistry: undefined
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("creates standard serial terminal with plug icon and cyan color", async () => {
    const ctx = makeSerialCtx();
    registerSerialCommands(ctx);
    await registeredCommands.get("nexus.serial.connect")!("sp1");
    expect(vscode.window.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        iconPath: expect.objectContaining({ id: "plug" }),
        color: expect.objectContaining({ id: "terminal.ansiCyan" })
      })
    );
  });

  it("creates smart-follow serial terminal with sync icon and cyan color", async () => {
    const ctx = makeSerialCtx();
    ctx.core.getSerialProfile = vi.fn(() => ({ ...baseProfile, mode: "smartFollow" }));
    registerSerialCommands(ctx);
    await registeredCommands.get("nexus.serial.connect")!("sp1");
    expect(vscode.window.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        iconPath: expect.objectContaining({ id: "sync" }),
        color: expect.objectContaining({ id: "terminal.ansiCyan" })
      })
    );
  });
});

/** Two macrotask turns — enough for every mocked prompt to settle and the command to park. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Parks INSIDE the lock until released — the "already in the critical section,
 * still awaiting its I/O" phase these races need to be pinned against rather
 * than raced for (copied from test/unit/authProfileCommands.test.ts).
 */
function gatedLockedWrite(
  lock: { runExclusive: <T>(fn: () => Promise<T>) => Promise<T> },
  write: () => Promise<void>
): { done: Promise<void>; release: () => void } {
  const gate = deferred<void>();
  const done = lock.runExclusive(async () => {
    await gate.promise;
    await write();
  });
  return { done, release: () => gate.resolve() };
}

/** The confirmation modal call, told apart from a bare refusal by its `{ modal: true }` options. */
function modalCalls(): unknown[][] {
  return mockShowWarningMessage.mock.calls.filter((call) => {
    const options = call[1];
    return typeof options === "object" && options !== null && (options as { modal?: boolean }).modal === true;
  });
}

/** Every non-modal warning — the refusals this fix introduces. */
function refusals(): string[] {
  return mockShowWarningMessage.mock.calls.filter((call) => call.length === 1).map((call) => String(call[0]));
}

function makeSerialProfile(overrides: Partial<SerialProfile> = {}): SerialProfile {
  return {
    id: "sp1",
    name: "USB Console",
    path: "COM3",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    mode: "standard",
    ...overrides
  };
}

/**
 * REMOVE-MUTATION-RACE FAMILY — nexus.serial.remove named a profile sampled
 * before its confirmation modal and then disposed its terminals and deleted it
 * by id from that pre-modal copy: no lock, no presence re-check, no revalidation
 * of what had been disclosed.
 *
 * Every concurrent operation below is GATED — it parks in a deferred modal or
 * inside the lock and is released by the test — so it is guaranteed to land in
 * the window under test rather than usually winning a race. Each assertion is on
 * PERSISTED state (the repository behind NexusCore), not on a modal having been
 * shown.
 */
describe("nexus.serial.remove — the disclosure is re-checked under the lock (REMOVE-MUTATION-RACE FAMILY)", () => {
  async function fixture(profiles: SerialProfile[]): Promise<{
    core: NexusCore;
    repo: InMemoryConfigRepository;
    dispose: ReturnType<typeof vi.fn>;
    serialTerminals: Map<string, { terminal: { dispose: () => void }; profileId: string }>;
  }> {
    const repo = new InMemoryConfigRepository([], [], profiles);
    const core = new NexusCore(repo);
    await core.initialize();
    const dispose = vi.fn();
    const serialTerminals = new Map<string, { terminal: { dispose: () => void }; profileId: string }>();
    serialTerminals.set("session-1", { terminal: { dispose }, profileId: "sp1" });
    const ctx = {
      core,
      serialTerminals,
      serialSidecar: {},
      loggerFactory: { create: vi.fn() },
      macroAutoTrigger: { createObserver: vi.fn() },
      sessionLogDir: "",
      highlighter: {},
      activityIndicators: new Map()
    } as unknown as CommandContext;
    registerSerialCommands(ctx);
    return { core, repo, dispose, serialTerminals };
  }

  function removeSerial(id: string): Promise<unknown> {
    const cmd = registeredCommands.get("nexus.serial.remove");
    expect(cmd).toBeDefined();
    return Promise.resolve(cmd!(id));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
  });

  it("removes the profile — disposing its session terminal and persisting the deletion — when nothing changed while the confirmation was open", async () => {
    const { repo, dispose, serialTerminals } = await fixture([
      makeSerialProfile(),
      makeSerialProfile({ id: "sp2", name: "Lab Console" })
    ]);
    mockShowWarningMessage.mockResolvedValue("Remove");

    await removeSerial("sp1");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(serialTerminals.size).toBe(0);
    expect((await repo.getSerialProfiles()).map((p) => p.id)).toEqual(["sp2"]);
    expect(refusals()).toEqual([]);
  });

  it("refuses when the profile was renamed while the confirmation was open, rather than deleting a profile under a name the user never agreed to (kills a presence-only re-check)", async () => {
    const { core, repo, dispose } = await fixture([makeSerialProfile()]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeSerial("sp1");
    await settle();
    expect(modalCalls()[0][0]).toBe('Remove serial profile "USB Console" and disconnect all sessions?');

    // Still present under the same id — a presence-only guard sees "yes, still
    // there" and deletes the renamed record, terminals and all.
    await core.addOrUpdateSerialProfile({ ...core.getSerialProfile("sp1")!, name: "Rack 4 Console" });

    modal.resolve("Remove");
    await run;

    expect((await repo.getSerialProfiles()).map((p) => p.name)).toEqual(["Rack 4 Console"]);
    expect(dispose).not.toHaveBeenCalled();
    // Quoted by the name the MODAL used, not the new one.
    expect(refusals()).toEqual([
      'Serial profile "USB Console" changed while the confirmation was open — nothing was removed. ' +
        "Remove it again to review the current details."
    ]);
  });

  it("reports that the profile was already removed, and does not mistake that for a changed disclosure, when it was deleted while the confirmation was open (kills re-rendering the disclosure off a record that is no longer there)", async () => {
    const { core, repo, dispose } = await fixture([
      makeSerialProfile(),
      makeSerialProfile({ id: "sp2", name: "Lab Console" })
    ]);

    const modal = deferred<string>();
    mockShowWarningMessage.mockReturnValueOnce(modal.promise);
    const run = removeSerial("sp1");
    await settle();

    // A replace-mode import's wipe (configCommands' importMergeReplaceLocked
    // deletes every existing profile by id) lands while the modal sits open.
    await core.removeSerialProfile("sp1");

    modal.resolve("Remove");
    // The presence re-check has to come FIRST inside the lock: a disclosure
    // re-render that assumes the record is still there dereferences
    // `undefined.name` and rejects this promise with a TypeError.
    await expect(run).resolves.toBeUndefined();

    expect(dispose).not.toHaveBeenCalled();
    expect((await repo.getSerialProfiles()).map((p) => p.id)).toEqual(["sp2"]);
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
      'Serial profile "USB Console" was already removed.'
    );
    expect(refusals()).toEqual([]);
  });

  it("queues its whole mutation behind an in-flight locked section and refuses when that section renamed the profile (kills the lock-free dispose+delete, which commits before any concurrent holder can)", async () => {
    const { core, repo, dispose } = await fixture([makeSerialProfile()]);
    mockShowWarningMessage.mockResolvedValue("Remove");

    // A replace-mode import / complete reset stand-in: already inside the lock,
    // still awaiting its own I/O.
    const gated = gatedLockedWrite(configMutationLock, async () => {
      await core.addOrUpdateSerialProfile({ ...core.getSerialProfile("sp1")!, name: "Rack 4 Console" });
    });
    await settle();

    const run = removeSerial("sp1");
    await settle();

    // THE KILL. The modal has already answered, so a lock-free implementation has
    // finished disposing and deleting by now — before the holder it should be
    // queued behind has even started its body.
    expect(modalCalls()).toHaveLength(1);
    expect((await repo.getSerialProfiles()).map((p) => p.id)).toEqual(["sp1"]);
    expect(dispose).not.toHaveBeenCalled();

    gated.release();
    await gated.done;
    await run;

    expect((await repo.getSerialProfiles()).map((p) => p.name)).toEqual(["Rack 4 Console"]);
    expect(dispose).not.toHaveBeenCalled();
    expect(refusals()).toEqual([
      'Serial profile "USB Console" changed while the confirmation was open — nothing was removed. ' +
        "Remove it again to review the current details."
    ]);
  });

  describe("nexus.serial.rename re-resolves under the lock (issue #108)", () => {
    function renameSerial(arg: unknown): Promise<unknown> {
      const cmd = registeredCommands.get("nexus.serial.rename");
      expect(cmd).toBeDefined();
      return Promise.resolve(cmd!(arg));
    }

    it("does not revert a concurrent edit's other fields", async () => {
      // The rename captures the profile, then awaits an input box. While that box
      // is open, an edit changes the baud rate. The rename must apply ONLY the
      // name, to the CURRENT record — not write back the snapshot it captured
      // before the prompt, which silently undoes the edit.
      const { core } = await fixture([makeSerialProfile({ baudRate: 9600 })]);

      const prompt = deferred<string>();
      vi.mocked(vscode.window.showInputBox).mockReturnValue(prompt.promise as never);

      const renaming = renameSerial({ profile: core.getSerialProfile("sp1") });
      await core.addOrUpdateSerialProfile({ ...core.getSerialProfile("sp1")!, baudRate: 115200 });

      prompt.resolve("Lab Bench");
      await renaming;

      const after = core.getSerialProfile("sp1")!;
      expect(after.name).toBe("Lab Bench");
      // Load-bearing: 9600 here means the rename reverted the edit.
      expect(after.baudRate).toBe(115200);
    });

    it("does not resurrect a profile removed during the prompt", async () => {
      const { core } = await fixture([makeSerialProfile()]);

      const prompt = deferred<string>();
      vi.mocked(vscode.window.showInputBox).mockReturnValue(prompt.promise as never);

      const renaming = renameSerial({ profile: core.getSerialProfile("sp1") });
      await core.removeSerialProfile("sp1");

      prompt.resolve("Lab Bench");
      await renaming;

      expect(core.getSerialProfile("sp1")).toBeUndefined();
    });

    it("bails when a concurrent rename moved the name (#84 P2-1)", async () => {
      // The prompt started from "USB Console". Something else renamed it to
      // "Bench" while the box was open, so this prompt's decision was made
      // against a name that no longer exists — writing it would overwrite the
      // newer rename.
      const { core } = await fixture([makeSerialProfile()]);

      const prompt = deferred<string>();
      vi.mocked(vscode.window.showInputBox).mockReturnValue(prompt.promise as never);

      const renaming = renameSerial({ profile: core.getSerialProfile("sp1") });
      await core.addOrUpdateSerialProfile({ ...core.getSerialProfile("sp1")!, name: "Bench" });

      prompt.resolve("Lab Bench");
      await renaming;

      expect(core.getSerialProfile("sp1")!.name).toBe("Bench");
    });
  });

  describe("nexus.serial.edit re-resolves under the lock (issue #108 followups)", () => {
    /**
     * Drives the edit form open, then returns the onSubmit callback the real
     * WebviewFormPanel would invoke on Save. WebviewFormPanel itself is
     * mocked (module-level `mockWebviewFormPanelOpen`) — its real
     * implementation talks to `vscode.window.createWebviewPanel`, which this
     * file's vscode mock doesn't provide.
     */
    async function editSerial(arg: unknown): Promise<(values: FormValues) => Promise<void>> {
      const cmd = registeredCommands.get("nexus.serial.edit");
      expect(cmd).toBeDefined();
      await cmd!(arg);
      const call = mockWebviewFormPanelOpen.mock.calls.at(-1);
      expect(call).toBeDefined();
      const options = call![2] as { onSubmit: (values: FormValues) => Promise<void> };
      return options.onSubmit;
    }

    it("does not revert a deviceHint set concurrently while the form was open (kills writing the pre-form snapshot's deviceHint)", async () => {
      // formValuesToSerial has no form field for deviceHint — it always carries
      // it over from whatever `existing` it's handed. The edit form captures
      // `existing` BEFORE opening, so if Smart Follow (or anything else) updates
      // deviceHint while the form sits open, submitting with the STALE
      // pre-form snapshot silently reverts that concurrent change.
      const { core } = await fixture([
        makeSerialProfile({ mode: "smartFollow", deviceHint: { manufacturer: "Old Co" } })
      ]);

      const onSubmit = await editSerial("sp1");

      // Concurrent change while the form sat open — e.g. Smart Follow's
      // onResolvedPort updating the saved hardware hint.
      await core.addOrUpdateSerialProfile({
        ...core.getSerialProfile("sp1")!,
        deviceHint: { manufacturer: "New Co", serialNumber: "SN-42" }
      });

      // Submit with unrelated changes — no deviceHint field exists on the form.
      await onSubmit({
        name: "USB Console",
        path: "COM3",
        baudRate: "9600",
        dataBits: "8",
        stopBits: "1",
        parity: "none"
      } as unknown as FormValues);

      const after = core.getSerialProfile("sp1")!;
      // Load-bearing: "Old Co" here means the submit reverted the concurrent change.
      expect(after.deviceHint).toEqual({ manufacturer: "New Co", serialNumber: "SN-42" });
      expect(after.baudRate).toBe(9600);
    });

    it("throws and saves nothing when the profile was removed while the form was open", async () => {
      const { core } = await fixture([makeSerialProfile()]);

      const onSubmit = await editSerial("sp1");

      await core.removeSerialProfile("sp1");

      await expect(
        onSubmit({
          name: "USB Console",
          path: "COM3",
          baudRate: "9600",
          dataBits: "8",
          stopBits: "1",
          parity: "none"
        } as unknown as FormValues)
      ).rejects.toThrow('Serial profile "USB Console" was removed while this form was open. Nothing was saved.');

      expect(core.getSerialProfile("sp1")).toBeUndefined();
    });
  });
});
