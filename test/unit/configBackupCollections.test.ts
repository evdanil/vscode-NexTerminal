/**
 * Config-wide operations cover every persisted collection (issue #149, Codex P1
 * on PR #157): the Encrypted Backup and its import, Export for Sharing, and
 * Delete All Data, for the three collections they used to skip — Local Server
 * profiles and the saved TFTP / DHCP profiles — plus the trusted SSH host keys.
 *
 * Every test here drives the real registered command (`nexus.config.*`) against
 * a real NexusCore over an InMemoryConfigRepository; only the VS Code surface is
 * a double. The runtime teardown the commands delegate (stopping a Local Server,
 * stopping the TFTP/DHCP daemon) is observed through the `ConfigRuntimeHooks`
 * seam so each test can see WHEN it ran relative to the profile removal.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowInformationMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowSaveDialog = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockShowInputBox = vi.fn();
const mockWriteFile = vi.fn();
const mockReadFile = vi.fn();
const mockReadDirectory = vi.fn();
const mockStat = vi.fn();
const mockCreateDirectory = vi.fn();
const mockExecuteCommand = vi.fn();
const mockConfigUpdate = vi.fn();
const allMocks = [
  mockShowInformationMessage,
  mockShowErrorMessage,
  mockShowWarningMessage,
  mockShowQuickPick,
  mockShowSaveDialog,
  mockShowOpenDialog,
  mockShowInputBox,
  mockWriteFile,
  mockReadFile,
  mockReadDirectory,
  mockStat,
  mockCreateDirectory,
  mockExecuteCommand,
  mockConfigUpdate
];

vi.mock("vscode", () => ({
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  },
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showSaveDialog: (...args: unknown[]) => mockShowSaveDialog(...args),
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    withProgress: (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<void>) =>
      task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => undefined })
  },
  env: { clipboard: { readText: async () => "" } },
  workspace: {
    fs: {
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
      readDirectory: (...args: unknown[]) => mockReadDirectory(...args),
      stat: (...args: unknown[]) => mockStat(...args),
      createDirectory: (...args: unknown[]) => mockCreateDirectory(...args)
    },
    workspaceFolders: [{ uri: { fsPath: "/workspace", scheme: "file", path: "/workspace" }, name: "workspace", index: 0 }],
    getConfiguration: (section: string) => ({
      get: (_key: string, fallback?: unknown) => fallback,
      inspect: () => ({ defaultValue: undefined, globalValue: undefined, workspaceValue: undefined }),
      update: (key: string, value: unknown) => mockConfigUpdate(section, key, value)
    })
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: "file" }),
    joinPath: (base: { fsPath: string; scheme: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/").replace(/\/+/g, "/"),
      scheme: base.scheme
    })
  },
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 }
}));

/**
 * The backup cipher runs for real, with only its 210,000-iteration key
 * derivation swapped for a fast one: that derivation put a test that encrypts
 * and decrypts a few times over the unit timeout, and it has its own suite
 * (`configCrypto.test.ts`). What THIS file asserts is which half of the file a
 * value lands in and that the seal refuses an edited file — the helper keeps
 * AES-GCM, the wrong-password refusal and the seal real.
 */
vi.mock("node:crypto", async (importOriginal) =>
  (await import("../helpers/fastBackupKdf")).withFastPbkdf2(await importOriginal<typeof import("node:crypto")>())
);

import type * as vscode from "vscode";
import { registerConfigCommands, isValidExport, type ConfigRuntimeHooks } from "../../src/commands/configCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";
import { decrypt, encrypt } from "../../src/utils/configCrypto";
import type { SecretVault } from "../../src/services/ssh/contracts";
import type { LocalServerConfig } from "../../src/models/localServer";
import type { DhcpConfigProfile, TftpConfigProfile } from "../../src/models/networkServerProfile";
import type { LocalShellProfile, ServerConfig } from "../../src/models/config";

const KNOWN_HOSTS_KEY = "nexus.ssh.knownHostFingerprints.v1";
const PASSWORD = "backup-pass-1";

class MockVault implements SecretVault {
  private readonly secrets = new Map<string, string>();
  async get(key: string) { return this.secrets.get(key); }
  async store(key: string, value: string) { this.secrets.set(key, value); }
  async delete(key: string) { this.secrets.delete(key); }
}

/** A fingerprint in exactly the shape VscodeHostKeyVerifier writes. */
function fp(seed: string): string {
  return `SHA256:${createHash("sha256").update(seed).digest("base64").replace(/=+$/u, "")}`;
}

function makeLocalServer(overrides: Partial<LocalServerConfig> = {}): LocalServerConfig {
  return {
    id: "ls-1",
    name: "API",
    executable: "node",
    args: ["server.js", "--port", "8080"],
    cwd: "/srv/api",
    env: { API_TOKEN: "s3cr3t-token-value", NODE_OPTIONS: null },
    group: "Backends",
    autoRestart: true,
    maxAutoRestarts: 3,
    description: "Local API",
    ...overrides
  };
}

function makeTftp(overrides: Partial<TftpConfigProfile> = {}): TftpConfigProfile {
  return {
    id: "tftp-1",
    kind: "tftp",
    name: "Bench TFTP",
    config: { root: "/srv/tftp", port: 69, allowWrite: false, interface: "192.168.2.1" },
    ...overrides
  };
}

function makeDhcp(overrides: Partial<DhcpConfigProfile> = {}): DhcpConfigProfile {
  return {
    id: "dhcp-1",
    kind: "dhcp",
    name: "Bench DHCP",
    config: {
      rangeStart: "192.168.2.100",
      rangeEnd: "192.168.2.200",
      subnet: "255.255.255.0",
      gateway: "192.168.2.1",
      dns: ["1.1.1.1"],
      static: { "aa:bb:cc:dd:ee:ff": "192.168.2.10" },
      bootFileName: "ios.bin"
    },
    autoLinkTftp: true,
    ...overrides
  };
}

function makeLocalShell(overrides: Partial<LocalShellProfile> = {}): LocalShellProfile {
  return {
    id: "sh-1",
    name: "Dev shell",
    launchMode: "custom",
    shellPath: "/bin/bash",
    shellArgs: ["-l"],
    cwd: "/work",
    env: { GITHUB_TOKEN: "ghp-shell-secret-value", PAGER: "less" },
    ...overrides
  };
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Router",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

interface FakeContext {
  context: vscode.ExtensionContext;
  state: Map<string, unknown>;
}

function makeContext(): FakeContext {
  const state = new Map<string, unknown>();
  const context = {
    globalState: {
      get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback),
      // JSON-cloned on write, as the real Memento does.
      update: async (key: string, value: unknown) => {
        if (value === undefined) state.delete(key);
        else state.set(key, JSON.parse(JSON.stringify(value)));
      },
      keys: () => [...state.keys()]
    },
    globalStorageUri: { fsPath: "/fake/global-storage", scheme: "file" }
  } as unknown as vscode.ExtensionContext;
  return { context, state };
}

interface Machine {
  core: NexusCore;
  vault: MockVault;
  ctx: FakeContext;
}

async function makeMachine(): Promise<Machine> {
  const core = new NexusCore(new InMemoryConfigRepository());
  await core.initialize();
  return { core, vault: new MockVault(), ctx: makeContext() };
}

function register(machine: Machine, runtime?: ConfigRuntimeHooks): void {
  registeredCommands.clear();
  registerConfigCommands(machine.core, machine.vault, machine.ctx.context, runtime);
}

/** Runs the real `nexus.config.export.backup` command and returns the file it wrote. */
async function exportBackup(machine: Machine): Promise<string> {
  register(machine);
  let written = "";
  mockShowInputBox.mockResolvedValueOnce(PASSWORD).mockResolvedValueOnce(PASSWORD);
  mockShowSaveDialog.mockResolvedValueOnce({ fsPath: "/fake/nexus-backup.json", scheme: "file" });
  mockWriteFile.mockImplementationOnce(async (_uri: unknown, data: Uint8Array) => {
    written = Buffer.from(data).toString("utf8");
  });
  await registeredCommands.get("nexus.config.export.backup")!();
  expect(written).not.toBe("");
  return written;
}

/** Runs the real `nexus.config.export` (Export for Sharing) command and returns the file it wrote. */
async function exportShare(machine: Machine): Promise<string> {
  register(machine);
  let written = "";
  mockShowSaveDialog.mockResolvedValueOnce({ fsPath: "/fake/nexus-shared.json", scheme: "file" });
  mockWriteFile.mockImplementationOnce(async (_uri: unknown, data: Uint8Array) => {
    written = Buffer.from(data).toString("utf8");
  });
  await registeredCommands.get("nexus.config.export")!();
  expect(written).not.toBe("");
  return written;
}

function decryptedSecretsOf(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as { encryptedSecrets: Parameters<typeof decrypt>[0] };
  return JSON.parse(decrypt(parsed.encryptedSecrets, PASSWORD)) as Record<string, unknown>;
}

/** Drives `nexus.config.import` → Nexus Export File… → Merge/Replace → master password. */
async function runImport(
  machine: Machine,
  json: string,
  mode: "merge" | "replace",
  runtime?: ConfigRuntimeHooks
): Promise<void> {
  await runImportAllowingRefusal(machine, json, mode, runtime);
  expect(mockShowErrorMessage).not.toHaveBeenCalled();
}

/** The same drive, for a test that expects the import to be refused. Returns the error shown, or "". */
async function runImportAllowingRefusal(
  machine: Machine,
  json: string,
  mode: "merge" | "replace",
  runtime?: ConfigRuntimeHooks
): Promise<string> {
  register(machine, runtime);
  mockShowQuickPick
    .mockResolvedValueOnce({ value: "nexusExport" })
    .mockResolvedValueOnce({ label: mode === "merge" ? "Merge" : "Replace", value: mode });
  mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/nexus-backup.json", scheme: "file" }]);
  mockReadFile.mockResolvedValueOnce(Buffer.from(json, "utf8"));
  mockShowInputBox.mockResolvedValueOnce(PASSWORD);
  await registeredCommands.get("nexus.config.import")!();
  return String(mockShowErrorMessage.mock.calls[0]?.[0] ?? "");
}

/** Parses a backup file, lets the test edit it as an attacker holding the file (but not the password) could, and writes it back. */
function tamper(json: string, edit: (clear: Record<string, any>) => void, indent = 2): string {
  const parsed = JSON.parse(json) as Record<string, any>;
  edit(parsed);
  return JSON.stringify(parsed, null, indent);
}

/** A hand-built backup payload, encrypted the way exportBackup encrypts one. */
function backupJson(clear: Record<string, unknown>, secrets: Record<string, unknown>): string {
  return JSON.stringify({
    version: 2,
    exportType: "backup",
    exportedAt: new Date().toISOString(),
    inventoryStatusPollPerSource: true,
    servers: [],
    settings: {},
    ...clear,
    encryptedSecrets: encrypt(JSON.stringify(secrets), PASSWORD)
  });
}

function lastInfoMessage(): string {
  const calls = mockShowInformationMessage.mock.calls;
  return String(calls[calls.length - 1]?.[0] ?? "");
}

function recordingRuntime(core: NexusCore): ConfigRuntimeHooks & {
  stoppedLocalServers: Array<{ id: string; profileStillPresent: boolean }>;
  networkStops: Array<{ tftpProfiles: number; dhcpProfiles: number; localServers: number }>;
} {
  const stoppedLocalServers: Array<{ id: string; profileStillPresent: boolean }> = [];
  const networkStops: Array<{ tftpProfiles: number; dhcpProfiles: number; localServers: number }> = [];
  return {
    stoppedLocalServers,
    networkStops,
    stopLocalServer: async (configId: string) => {
      stoppedLocalServers.push({ id: configId, profileStillPresent: core.getLocalServer(configId) !== undefined });
    },
    stopNetworkServices: async () => {
      const snapshot = core.getSnapshot();
      networkStops.push({
        tftpProfiles: snapshot.tftpProfiles.length,
        dhcpProfiles: snapshot.dhcpProfiles.length,
        localServers: snapshot.localServers.length
      });
    }
  };
}

const START_COMMANDS = [
  "nexus.localServer.start",
  "nexus.localServer.restart",
  "nexus.networkServer.start",
  "nexus.networkServer.restart"
];

beforeEach(async () => {
  for (const mock of allMocks) mock.mockReset();
  mockConfigUpdate.mockResolvedValue(undefined);
  mockExecuteCommand.mockResolvedValue(undefined);
  registeredCommands.clear();
  const store = new InMemoryMacroStore();
  await store.initialize();
  setActiveMacroStore(store);
});

describe("Encrypted Backup — what it carries", () => {
  it("carries Local Server profiles in the clear WITHOUT their environment, which travels only inside the encrypted section", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer());
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "ls-2", name: "Worker", env: undefined, group: undefined }));

    const json = await exportBackup(source);
    const exported = JSON.parse(json) as { localServers?: LocalServerConfig[] };

    const { env: _env, ...clearRecord } = makeLocalServer();
    expect(exported.localServers).toEqual([clearRecord, makeLocalServer({ id: "ls-2", name: "Worker", env: undefined, group: undefined })]);
    expect(exported.localServers?.every((server) => !("env" in server))).toBe(true);
    // Neither the value nor even the variable's name is readable without the password.
    expect(json).not.toContain("s3cr3t-token-value");
    expect(json).not.toContain("API_TOKEN");

    expect(decryptedSecretsOf(json).localServerEnv).toEqual({
      "ls-1": { API_TOKEN: "s3cr3t-token-value", NODE_OPTIONS: null }
    });
  });

  it("carries the saved TFTP and DHCP profiles", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateTftpProfile(makeTftp());
    await source.core.addOrUpdateDhcpProfile(makeDhcp());

    const exported = JSON.parse(await exportBackup(source)) as Record<string, unknown>;

    expect(exported.tftpProfiles).toEqual([makeTftp()]);
    expect(exported.dhcpProfiles).toEqual([makeDhcp()]);
  });

  it("carries the trusted SSH host keys, inside the encrypted section only", async () => {
    const source = await makeMachine();
    const trusted = { "10.0.0.1:22": fp("router"), "bastion.lab:2222": fp("bastion") };
    source.ctx.state.set(KNOWN_HOSTS_KEY, trusted);

    const json = await exportBackup(source);

    expect(json).not.toContain(fp("router"));
    expect(json).not.toContain("bastion.lab");
    expect(decryptedSecretsOf(json).knownHostFingerprints).toEqual(trusted);
  });
});

/**
 * Local Shell profiles carry an environment map exactly as Local Servers do, and
 * it holds the same kind of values. It used to ride in the readable half of the
 * backup; it now takes the Local Server route into the encrypted section.
 */
describe("Encrypted Backup — Local Shell environment variables", () => {
  it("carries Local Shell profiles in the clear WITHOUT their environment, which travels only inside the encrypted section", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell());
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell({ id: "sh-2", name: "Plain", env: undefined }));

    const json = await exportBackup(source);
    const exported = JSON.parse(json) as { localShellProfiles?: LocalShellProfile[] };

    const { env: _env, ...clearRecord } = makeLocalShell();
    expect(exported.localShellProfiles).toEqual([clearRecord, makeLocalShell({ id: "sh-2", name: "Plain", env: undefined })]);
    expect(json).not.toContain("ghp-shell-secret-value");
    expect(json).not.toContain("GITHUB_TOKEN");
    expect(decryptedSecretsOf(json).localShellEnv).toEqual({
      "sh-1": { GITHUB_TOKEN: "ghp-shell-secret-value", PAGER: "less" }
    });
  });

  it("Replace puts each Local Shell profile's environment back", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell());
    const json = await exportBackup(source);

    const dest = await makeMachine();
    await runImport(dest, json, "replace");

    expect(dest.core.getSnapshot().localShellProfiles).toEqual([makeLocalShell()]);
  });

  it("Merge keeps a local Local Shell profile's own environment over the backup's, and restores it onto one it adds", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell({ id: "sh-1", env: { FROM: "backup" } }));
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell({ id: "sh-2", name: "New", env: { TOKEN: "new-shell-token" } }));
    const json = await exportBackup(source);

    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalShellProfile(makeLocalShell({ id: "sh-1", name: "Local", env: { FROM: "local" } }));
    await runImport(dest, json, "merge");

    expect(dest.core.getSnapshot().localShellProfiles).toEqual([
      makeLocalShell({ id: "sh-1", name: "Local", env: { FROM: "local" } }),
      makeLocalShell({ id: "sh-2", name: "New", env: { TOKEN: "new-shell-token" } })
    ]);
  });

  it("a backup from before 2.8.243, with the environment still in the clear, imports it as it always did", async () => {
    const dest = await makeMachine();
    const oldBackup = backupJson(
      { localShellProfiles: [makeLocalShell()] },
      { passwords: {}, secretMacros: [], fileBackups: [] }
    );

    await runImport(dest, oldBackup, "replace");

    expect(dest.core.getSnapshot().localShellProfiles).toEqual([makeLocalShell()]);
  });
});

describe("Export for Sharing — backup-only collections stay out", () => {
  it("carries no Local Server profiles, no TFTP/DHCP profiles and no host keys", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateServer(makeServer());
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell());
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer());
    await source.core.addOrUpdateTftpProfile(makeTftp());
    await source.core.addOrUpdateDhcpProfile(makeDhcp());
    source.ctx.state.set(KNOWN_HOSTS_KEY, { "10.0.0.1:22": fp("router") });

    const json = await exportShare(source);
    const exported = JSON.parse(json) as Record<string, unknown>;

    expect(exported.exportType).toBe("share");
    expect(exported).not.toHaveProperty("localServers");
    expect(exported).not.toHaveProperty("tftpProfiles");
    expect(exported).not.toHaveProperty("dhcpProfiles");
    expect(exported).not.toHaveProperty("knownHostFingerprints");
    expect(json).not.toContain("s3cr3t-token-value");
    expect(json).not.toContain("ghp-shell-secret-value");
    expect(json).not.toContain("/srv/api");
    expect(json).not.toContain("Bench TFTP");
    expect(json).not.toContain("Bench DHCP");
    expect(json).not.toContain(fp("router"));
  });

  /**
   * Issue #159 — the share path stripped a Local Shell profile's working
   * directory and startup command but kept its environment, so any token in it
   * travelled in a file whose whole promise is "credentials stripped". The
   * backup now treats that map as secret; a share cannot carry it at all.
   */
  it("keeps Local Shell profiles but never their environment variables", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell());

    const json = await exportShare(source);
    const exported = JSON.parse(json) as { localShellProfiles?: LocalShellProfile[] };

    expect(exported.localShellProfiles?.map((p) => p.name)).toEqual(["Dev shell"]);
    expect(exported.localShellProfiles?.[0]).not.toHaveProperty("env");
    expect(json).not.toContain("ghp-shell-secret-value");
    expect(json).not.toContain("GITHUB_TOKEN");
  });
});

describe("Encrypted Backup import — Local Servers and TFTP/DHCP profiles", () => {
  it("Replace restores all three collections and every Local Server's environment, and starts nothing", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer());
    await source.core.addOrUpdateTftpProfile(makeTftp());
    await source.core.addOrUpdateDhcpProfile(makeDhcp());
    const json = await exportBackup(source);

    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "local-only", name: "Local only", env: undefined }));
    await dest.core.addOrUpdateTftpProfile(makeTftp({ id: "local-tftp", name: "Local TFTP" }));
    await dest.core.addOrUpdateDhcpProfile(makeDhcp({ id: "local-dhcp", name: "Local DHCP" }));
    const runtime = recordingRuntime(dest.core);

    await runImport(dest, json, "replace", runtime);

    const snapshot = dest.core.getSnapshot();
    expect(snapshot.localServers).toEqual([makeLocalServer()]);
    expect(snapshot.tftpProfiles).toEqual([makeTftp()]);
    expect(snapshot.dhcpProfiles).toEqual([makeDhcp()]);
    // A restore writes configuration; it never launches a process or a service.
    const issued = mockExecuteCommand.mock.calls.map((call) => call[0]);
    for (const command of START_COMMANDS) {
      expect(issued).not.toContain(command);
    }
    expect(snapshot.activeLocalServerSessions).toEqual([]);
    expect(snapshot.activeNetworkServerSessions).toEqual([]);
    expect(lastInfoMessage()).toBe("Imported 3 profiles (replaced existing).");
  });

  it("Replace stops a running Local Server BEFORE removing its profile, as Remove Local Server does", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer());
    const json = await exportBackup(source);

    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "ls-1", name: "Same id, older" }));
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "local-only", name: "Local only" }));
    const runtime = recordingRuntime(dest.core);

    await runImport(dest, json, "replace", runtime);

    expect(runtime.stoppedLocalServers).toEqual([
      { id: "ls-1", profileStillPresent: true },
      { id: "local-only", profileStillPresent: true }
    ]);
    expect(dest.core.getSnapshot().localServers.map((s) => s.id)).toEqual(["ls-1"]);
    // Nothing about the TFTP/DHCP daemon is touched by an import.
    expect(runtime.networkStops).toEqual([]);
  });

  it("Merge adds what is new, keeps a local record whose id the backup also holds, and restores the environment only onto records it added", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "ls-1", name: "From backup", env: { FROM: "backup" } }));
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "ls-2", name: "New", env: { TOKEN: "new-token" } }));
    await source.core.addOrUpdateTftpProfile(makeTftp({ id: "tftp-1", name: "From backup" }));
    await source.core.addOrUpdateTftpProfile(makeTftp({ id: "tftp-2", name: "New TFTP" }));
    await source.core.addOrUpdateDhcpProfile(makeDhcp({ id: "dhcp-1", name: "From backup" }));
    await source.core.addOrUpdateDhcpProfile(makeDhcp({ id: "dhcp-2", name: "New DHCP" }));
    const json = await exportBackup(source);

    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "ls-1", name: "Local", env: { FROM: "local" } }));
    await dest.core.addOrUpdateTftpProfile(makeTftp({ id: "tftp-1", name: "Local" }));
    await dest.core.addOrUpdateDhcpProfile(makeDhcp({ id: "dhcp-1", name: "Local" }));
    const runtime = recordingRuntime(dest.core);

    await runImport(dest, json, "merge", runtime);

    const snapshot = dest.core.getSnapshot();
    expect(snapshot.localServers).toEqual([
      makeLocalServer({ id: "ls-1", name: "Local", env: { FROM: "local" } }),
      makeLocalServer({ id: "ls-2", name: "New", env: { TOKEN: "new-token" } })
    ]);
    expect(snapshot.tftpProfiles.map((p) => [p.id, p.name])).toEqual([["tftp-1", "Local"], ["tftp-2", "New TFTP"]]);
    expect(snapshot.dhcpProfiles.map((p) => [p.id, p.name])).toEqual([["dhcp-1", "Local"], ["dhcp-2", "New DHCP"]]);
    // Merge removes nothing, so it has nothing to stop.
    expect(runtime.stoppedLocalServers).toEqual([]);
    expect(lastInfoMessage()).toBe("Imported 3 profiles (3 skipped).");
  });

  /**
   * The replace-mode wipe clears these collections only when the file CARRIES
   * them, and relies on this build always writing all three arrays — empty or
   * not. An export that dropped empty ones would make restoring a backup of a
   * machine with none silently keep this machine's instead of replacing them.
   */
  it("Replace with a backup whose Local Servers, TFTP/DHCP profiles and host keys are all EMPTY clears this machine's", async () => {
    const source = await makeMachine();
    const json = await exportBackup(source);

    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer());
    await dest.core.addOrUpdateTftpProfile(makeTftp());
    await dest.core.addOrUpdateDhcpProfile(makeDhcp());
    dest.ctx.state.set(KNOWN_HOSTS_KEY, { "a.lab:22": fp("a") });
    const runtime = recordingRuntime(dest.core);

    await runImport(dest, json, "replace", runtime);

    const snapshot = dest.core.getSnapshot();
    expect(snapshot.localServers).toEqual([]);
    expect(snapshot.tftpProfiles).toEqual([]);
    expect(snapshot.dhcpProfiles).toEqual([]);
    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual({});
    expect(runtime.stoppedLocalServers).toEqual([{ id: "ls-1", profileStillPresent: true }]);
  });

  it("an older backup, written before these collections existed, leaves them untouched — in Replace mode too", async () => {
    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer());
    await dest.core.addOrUpdateTftpProfile(makeTftp());
    await dest.core.addOrUpdateDhcpProfile(makeDhcp());
    const trusted = { "10.0.0.1:22": fp("router") };
    dest.ctx.state.set(KNOWN_HOSTS_KEY, trusted);
    const runtime = recordingRuntime(dest.core);
    // The shape every earlier build wrote: no localServers / tftpProfiles /
    // dhcpProfiles keys, and no localServerEnv / knownHostFingerprints secrets.
    const oldBackup = backupJson(
      { servers: [makeServer()] },
      { passwords: { "srv-1": "pw" }, secretMacros: [], fileBackups: [] }
    );

    await runImport(dest, oldBackup, "replace", runtime);

    const snapshot = dest.core.getSnapshot();
    expect(snapshot.servers.map((s) => s.id)).toEqual(["srv-1"]);
    expect(snapshot.localServers).toEqual([makeLocalServer()]);
    expect(snapshot.tftpProfiles).toEqual([makeTftp()]);
    expect(snapshot.dhcpProfiles).toEqual([makeDhcp()]);
    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual(trusted);
    expect(runtime.stoppedLocalServers).toEqual([]);
    expect(await dest.vault.get("password-srv-1")).toBe("pw");
  });

  it("an imported Local Server's folder is normalised: an invalid path lands at the root, a blank one is not a reason to drop the record, and a malformed record is skipped", async () => {
    const dest = await makeMachine();
    const json = backupJson(
      {
        localServers: [
          null,
          { id: "a", name: "Escapes", executable: "node", group: "../etc" },
          { id: "b", name: "Blank folder", executable: "node", group: "   " },
          { id: "c", name: "Tidy", executable: "node", group: " Apps / API " },
          { id: "d", name: "No executable" }
        ]
      },
      {}
    );

    await runImport(dest, json, "merge");

    const servers = dest.core.getSnapshot().localServers;
    expect(servers.map((s) => [s.id, s.group])).toEqual([
      ["a", undefined],
      ["b", undefined],
      ["c", "Apps/API"]
    ]);
    expect(lastInfoMessage()).toBe("Imported 3 profiles (2 skipped).");
  });

  it("an imported DHCP profile never keeps a lease-store path, whatever its shape", async () => {
    const dest = await makeMachine();
    const json = backupJson(
      {
        dhcpProfiles: [
          makeDhcp({ id: "d1", config: { ...makeDhcp().config, leaseStorePath: "/other/machine/leases.json" } }),
          // Malformed (a number) — stripped before validation, so it cannot
          // cost the profile itself.
          makeDhcp({ id: "d2", config: { ...makeDhcp().config, leaseStorePath: 42 as unknown as string } })
        ]
      },
      {}
    );

    await runImport(dest, json, "merge");

    const profiles = dest.core.getSnapshot().dhcpProfiles;
    expect(profiles.map((p) => p.id)).toEqual(["d1", "d2"]);
    for (const profile of profiles) {
      expect(profile.config).not.toHaveProperty("leaseStorePath");
      expect(profile.config).toEqual(makeDhcp().config);
    }
  });

  it("isValidExport rejects a payload whose new collections are not arrays", () => {
    const base = { version: 2, servers: [] };
    expect(isValidExport({ ...base, localServers: {} })).toBe(false);
    expect(isValidExport({ ...base, tftpProfiles: "x" })).toBe(false);
    expect(isValidExport({ ...base, dhcpProfiles: 1 })).toBe(false);
    expect(isValidExport({ ...base, localServers: [], tftpProfiles: [], dhcpProfiles: [] })).toBe(true);
  });
});

describe("Encrypted Backup import — trusted SSH host keys", () => {
  it("Merge adds hosts this machine has never trusted, and keeps its own key where the backup's differs — reporting the conflict", async () => {
    const dest = await makeMachine();
    dest.ctx.state.set(KNOWN_HOSTS_KEY, { "a.lab:22": fp("a"), "b.lab:22": fp("b-local") });
    const json = backupJson({}, {
      knownHostFingerprints: { "a.lab:22": fp("a"), "b.lab:22": fp("b-backup"), "c.lab:22": fp("c") }
    });

    await runImport(dest, json, "merge");

    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual({
      "a.lab:22": fp("a"),
      "b.lab:22": fp("b-local"),
      "c.lab:22": fp("c")
    });
    expect(lastInfoMessage()).toContain("Kept the locally trusted SSH host key for 1 host where the backup holds a different key.");
  });

  it("Merge with no conflicting key says nothing about host keys", async () => {
    const dest = await makeMachine();
    dest.ctx.state.set(KNOWN_HOSTS_KEY, { "a.lab:22": fp("a") });
    const json = backupJson({}, { knownHostFingerprints: { "a.lab:22": fp("a"), "c.lab:22": fp("c") } });

    await runImport(dest, json, "merge");

    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual({ "a.lab:22": fp("a"), "c.lab:22": fp("c") });
    expect(lastInfoMessage()).not.toContain("host key");
  });

  it("Replace makes the backup's set the trusted set", async () => {
    const dest = await makeMachine();
    dest.ctx.state.set(KNOWN_HOSTS_KEY, { "a.lab:22": fp("a"), "b.lab:22": fp("b-local") });
    const json = backupJson({}, { knownHostFingerprints: { "b.lab:22": fp("b-backup"), "c.lab:22": fp("c") } });

    await runImport(dest, json, "replace");

    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual({ "b.lab:22": fp("b-backup"), "c.lab:22": fp("c") });
  });

  it("drops every entry that is not a host:port → SHA256 fingerprint, and a non-object set leaves the local keys alone", async () => {
    const dest = await makeMachine();
    dest.ctx.state.set(KNOWN_HOSTS_KEY, { "keep.lab:22": fp("keep") });
    const json = backupJson({}, {
      knownHostFingerprints: {
        "good.lab:22": fp("good"),
        "no-port.lab": fp("x"),
        "port-out-of-range.lab:70000": fp("x"),
        "UPPER.lab:22": fp("x"),
        "md5.lab:22": "MD5:ab:cd",
        "short.lab:22": "SHA256:abc",
        "number.lab:22": 42
      }
    });

    await runImport(dest, json, "merge");

    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual({ "keep.lab:22": fp("keep"), "good.lab:22": fp("good") });

    const notAnObject = backupJson({}, { knownHostFingerprints: [["evil.lab:22", fp("evil")]] });
    await runImport(dest, notAnObject, "replace");

    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual({ "keep.lab:22": fp("keep"), "good.lab:22": fp("good") });
  });

  it("a set whose every entry is malformed counts as no set: Replace leaves the local trusted keys alone", async () => {
    const dest = await makeMachine();
    dest.ctx.state.set(KNOWN_HOSTS_KEY, { "keep.lab:22": fp("keep") });
    const json = backupJson({}, {
      knownHostFingerprints: { "UPPER.lab:22": fp("x"), "no-port.lab": fp("y"), "md5.lab:22": "MD5:ab:cd" }
    });

    await runImport(dest, json, "replace");

    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual({ "keep.lab:22": fp("keep") });
  });

  it("round-trips through a real export: Replace on a fresh machine trusts exactly what the source trusted", async () => {
    const source = await makeMachine();
    const trusted = { "10.0.0.1:22": fp("router"), "fe80::1:22": fp("v6") };
    source.ctx.state.set(KNOWN_HOSTS_KEY, trusted);
    const json = await exportBackup(source);

    const dest = await makeMachine();
    await runImport(dest, json, "replace");

    expect(dest.ctx.state.get(KNOWN_HOSTS_KEY)).toEqual(trusted);
  });
});

/**
 * Codex P1 on PR #168 — the encrypted section keeps a profile's SECRETS private,
 * but the records they are restored onto sit beside it in the readable half.
 * Anyone holding the file could rewrite a Local Server's command or a server's
 * host while keeping its id, and a restore would attach the protected
 * environment or saved password to the rewritten record. The encrypted section
 * therefore carries a digest of the readable half, and a mismatch refuses the
 * whole import before anything on this machine changes.
 */
describe("Encrypted Backup — the readable half is sealed by the encrypted half", () => {
  async function sourceBackup(): Promise<string> {
    const source = await makeMachine();
    await source.core.addOrUpdateServer(makeServer());
    await source.vault.store("password-srv-1", "router-pw");
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer());
    return exportBackup(source);
  }

  async function destWithLocalServer(): Promise<Machine> {
    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "mine", name: "Mine", env: undefined }));
    return dest;
  }

  it("refuses a backup whose Local Server command was rewritten, before anything on this machine changes", async () => {
    const tampered = tamper(await sourceBackup(), (clear) => {
      clear.localServers[0].executable = "/tmp/planted";
      clear.localServers[0].args = ["--exfiltrate"];
    });
    const dest = await destWithLocalServer();
    const runtime = recordingRuntime(dest.core);

    const error = await runImportAllowingRefusal(dest, tampered, "replace", runtime);

    expect(error).toContain("changed after it was created");
    expect(dest.core.getSnapshot().localServers.map((s) => s.id)).toEqual(["mine"]);
    expect(runtime.stoppedLocalServers).toEqual([]);
    expect(lastInfoMessage()).not.toContain("Imported");
  });

  it("refuses a backup whose server host was rewritten, so the saved password cannot follow it", async () => {
    const tampered = tamper(await sourceBackup(), (clear) => {
      clear.servers[0].host = "attacker.example";
    });
    const dest = await makeMachine();

    const error = await runImportAllowingRefusal(dest, tampered, "merge");

    expect(error).toContain("changed after it was created");
    expect(dest.core.getSnapshot().servers).toEqual([]);
    expect(await dest.vault.get("password-srv-1")).toBeUndefined();
  });

  it("making the readable half look like an older backup's does not skip the check", async () => {
    const tampered = tamper(await sourceBackup(), (clear) => {
      clear.servers[0].host = "attacker.example";
      for (const key of ["localServers", "tftpProfiles", "dhcpProfiles", "inventoryStatusPollPerSource", "deviceTemplates", "savedFilters"]) {
        delete clear[key];
      }
    });
    const dest = await makeMachine();

    const error = await runImportAllowingRefusal(dest, tampered, "replace");

    expect(error).toContain("changed after it was created");
    expect(dest.core.getSnapshot().servers).toEqual([]);
  });

  it("an unmodified backup still imports after its JSON is re-serialized with other spacing and key order", async () => {
    const reserialized = tamper(await sourceBackup(), (clear) => {
      const entries = Object.entries(clear).reverse();
      for (const key of Object.keys(clear)) delete clear[key];
      for (const [key, value] of entries) {
        clear[key] = value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value;
      }
    }, 0);
    const dest = await makeMachine();

    await runImport(dest, reserialized, "replace");

    expect(dest.core.getSnapshot().servers.map((s) => s.host)).toEqual(["10.0.0.1"]);
    expect(await dest.vault.get("password-srv-1")).toBe("router-pw");
    expect(dest.core.getSnapshot().localServers).toEqual([makeLocalServer()]);
  });

  it("refuses a seal it cannot read rather than importing unchecked", async () => {
    const dest = await makeMachine();
    const json = backupJson({ servers: [makeServer()] }, { passwords: { "srv-1": "pw" }, clearPartSeal: { version: 99, sha256: "0".repeat(64) } });

    const error = await runImportAllowingRefusal(dest, json, "replace");

    expect(error).toContain("newer version");
    expect(dest.core.getSnapshot().servers).toEqual([]);
  });
});

/**
 * Codex P1 on PR #168 — Replace clears these collections only when the file
 * carries them, but a carried list whose every entry is unusable used to clear
 * them all the same and then import nothing.
 */
describe("Encrypted Backup import — Replace never trades a working collection for an unusable one", () => {
  it("refuses Replace when the backup's Local Server list has entries but none that can be imported", async () => {
    const dest = await makeMachine();
    await dest.core.addOrUpdateServer(makeServer({ id: "keep-me", name: "Keep" }));
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer());
    const runtime = recordingRuntime(dest.core);
    const json = backupJson({ servers: [], localServers: [{ id: "x", name: "No executable" }, 42, null] }, {});

    const error = await runImportAllowingRefusal(dest, json, "replace", runtime);

    expect(error).toContain("Local Server");
    expect(error).toContain("Merge");
    expect(dest.core.getSnapshot().localServers).toEqual([makeLocalServer()]);
    expect(dest.core.getSnapshot().servers.map((s) => s.id)).toEqual(["keep-me"]);
    expect(runtime.stoppedLocalServers).toEqual([]);
  });

  it("refuses Replace the same way for an unusable TFTP or DHCP profile list", async () => {
    const dest = await makeMachine();
    await dest.core.addOrUpdateTftpProfile(makeTftp());
    await dest.core.addOrUpdateDhcpProfile(makeDhcp());
    const json = backupJson({ tftpProfiles: [makeTftp()], dhcpProfiles: [{ id: "d", kind: "tftp", name: "Wrong kind", config: {} }] }, {});

    const error = await runImportAllowingRefusal(dest, json, "replace");

    expect(error).toContain("DHCP");
    expect(error).not.toContain("TFTP profile list");
    expect(dest.core.getSnapshot().tftpProfiles).toEqual([makeTftp()]);
    expect(dest.core.getSnapshot().dhcpProfiles).toEqual([makeDhcp()]);
  });

  it("still replaces when at least one entry is usable, skipping the rest", async () => {
    const dest = await makeMachine();
    await dest.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "old" }));
    const json = backupJson({ localServers: [makeLocalServer({ id: "new", env: undefined }), { id: "broken" }] }, {});

    await runImport(dest, json, "replace");

    expect(dest.core.getSnapshot().localServers.map((s) => s.id)).toEqual(["new"]);
    expect(lastInfoMessage()).toBe("Imported 1 profile (replaced existing) (1 skipped).");
  });
});

/** Codex P2 on PR #168 — an id-keyed map must hold any id, `__proto__` included. */
describe("Encrypted Backup — environment maps hold any profile id", () => {
  it("round-trips the environment of profiles whose id is __proto__", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "__proto__" }));
    await source.core.addOrUpdateLocalShellProfile(makeLocalShell({ id: "__proto__" }));
    const json = await exportBackup(source);

    expect(json).not.toContain("s3cr3t-token-value");
    const dest = await makeMachine();
    await runImport(dest, json, "replace");

    expect(dest.core.getLocalServer("__proto__")?.env).toEqual(makeLocalServer().env);
    expect(dest.core.getSnapshot().localShellProfiles[0]?.env).toEqual(makeLocalShell().env);
  });
});

describe("Delete All Data (nexus.config.completeReset) covers Local Servers and TFTP/DHCP profiles", () => {
  const OLD_CONFIRMATION =
    "This will permanently delete ALL servers, tunnels, serial profiles, local shell profiles, inventory sources, macros, groups, and saved passwords. This cannot be undone.";

  async function runReset(machine: Machine, runtime?: ConfigRuntimeHooks): Promise<void> {
    register(machine, runtime);
    mockShowWarningMessage.mockResolvedValueOnce("Delete Everything");
    mockShowInputBox.mockResolvedValueOnce("DELETE");
    await registeredCommands.get("nexus.config.completeReset")!();
  }

  it("removes every Local Server profile and every saved TFTP/DHCP profile", async () => {
    const machine = await makeMachine();
    await machine.core.addOrUpdateLocalServerConfig(makeLocalServer());
    await machine.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "ls-2", name: "Worker" }));
    await machine.core.addOrUpdateTftpProfile(makeTftp());
    await machine.core.addOrUpdateDhcpProfile(makeDhcp());

    await runReset(machine, recordingRuntime(machine.core));

    const snapshot = machine.core.getSnapshot();
    expect(snapshot.localServers).toEqual([]);
    expect(snapshot.tftpProfiles).toEqual([]);
    expect(snapshot.dhcpProfiles).toEqual([]);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("All Nexus data has been deleted.");
  });

  it("runs the Local Server teardown for every profile, and stops the TFTP/DHCP services, BEFORE anything is removed", async () => {
    const machine = await makeMachine();
    await machine.core.addOrUpdateLocalServerConfig(makeLocalServer());
    await machine.core.addOrUpdateLocalServerConfig(makeLocalServer({ id: "ls-2", name: "Worker" }));
    await machine.core.addOrUpdateTftpProfile(makeTftp());
    await machine.core.addOrUpdateDhcpProfile(makeDhcp());
    const runtime = recordingRuntime(machine.core);

    await runReset(machine, runtime);

    expect(runtime.stoppedLocalServers).toEqual([
      { id: "ls-1", profileStillPresent: true },
      { id: "ls-2", profileStillPresent: true }
    ]);
    expect(runtime.networkStops).toEqual([{ tftpProfiles: 1, dhcpProfiles: 1, localServers: 2 }]);
  });

  it("stops nothing and removes nothing when the user cancels", async () => {
    const machine = await makeMachine();
    await machine.core.addOrUpdateLocalServerConfig(makeLocalServer());
    const runtime = recordingRuntime(machine.core);
    register(machine, runtime);
    mockShowWarningMessage.mockResolvedValueOnce(undefined);

    await registeredCommands.get("nexus.config.completeReset")!();

    expect(runtime.stoppedLocalServers).toEqual([]);
    expect(runtime.networkStops).toEqual([]);
    expect(machine.core.getSnapshot().localServers).toHaveLength(1);
  });

  it("names Local Server profiles and saved TFTP/DHCP profiles in its confirmation, and the old list that omitted them is gone", async () => {
    const machine = await makeMachine();
    register(machine);
    mockShowWarningMessage.mockResolvedValueOnce(undefined);

    await registeredCommands.get("nexus.config.completeReset")!();

    const confirmation = String(mockShowWarningMessage.mock.calls[0]?.[0]);
    expect(confirmation).toContain("Local Server profiles");
    expect(confirmation).toContain("saved TFTP/DHCP profiles");
    expect(confirmation).toContain("Running Local Servers and TFTP/DHCP services are stopped before their configuration is removed.");
    expect(confirmation).not.toBe(OLD_CONFIRMATION);
    expect(confirmation).not.toContain("local shell profiles, inventory sources, macros");
  });
});
