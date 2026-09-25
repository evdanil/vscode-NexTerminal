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
import { PassThrough } from "node:stream";
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
import type { SecretVault, SshConnection, SshConnector } from "../../src/services/ssh/contracts";
import type { LocalServerConfig } from "../../src/models/localServer";
import type { DhcpConfigProfile, TftpConfigProfile } from "../../src/models/networkServerProfile";
import type { AuthProfile, LocalShellProfile, ServerConfig } from "../../src/models/config";
import { ProxySshFactory } from "../../src/services/ssh/proxySshFactory";
import { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";

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
 * Issue #175 — Replace removes every local server and then imports the file's,
 * ids preserved. A server's saved secrets are filed under its id, so a file with
 * no seal to check — a backup from before 2.8.243, a hand-written export, a
 * backup with its encrypted part removed — could re-create id X at another host
 * and the password this machine already held for X went there on the next
 * connect. They are now kept only when the re-created server has the same
 * endpoint: host, alternate host, port, username and proxy.
 */
describe("Replace keeps a removed server's saved secrets only when its endpoint is unchanged (#175)", () => {
  const SECRET_KEYS = ["password-srv-1", "passphrase-srv-1", "proxy-password-srv-1"];
  const KEPT = ["router-pw", "router-pp", "proxy-pw"];
  const GONE = [undefined, undefined, undefined];
  const LOCAL_ENDPOINT: Partial<ServerConfig> = {
    altHost: "10.0.1.1",
    proxy: { type: "socks5", host: "proxy.lab", port: 1080, username: "pxuser" }
  };

  async function destWithSavedSecrets(overrides: Partial<ServerConfig> = {}, vault: MockVault = new MockVault()): Promise<Machine> {
    const dest = { ...(await makeMachine()), vault };
    await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, ...overrides }));
    await vault.store("password-srv-1", "router-pw");
    await vault.store("passphrase-srv-1", "router-pp");
    await vault.store("proxy-password-srv-1", "proxy-pw");
    return dest;
  }

  function savedSecrets(machine: Machine): Promise<Array<string | undefined>> {
    return Promise.all(SECRET_KEYS.map((key) => machine.vault.get(key)));
  }

  /** A file that carries no seal and no secrets: the only secrets in play are the ones already on this machine. */
  function unsealedJson(servers: unknown[], authProfiles?: unknown[]): string {
    return JSON.stringify({
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers,
      ...(authProfiles !== undefined && { authProfiles })
    });
  }

  it("a file that re-creates the server's id at another host takes none of the secrets this machine saved for it", async () => {
    const dest = await destWithSavedSecrets();

    await runImport(dest, unsealedJson([makeServer({ ...LOCAL_ENDPOINT, host: "attacker.example" })]), "replace");

    expect(dest.core.getServer("srv-1")?.host).toBe("attacker.example");
    expect(await savedSecrets(dest)).toEqual(GONE);
    expect(lastInfoMessage()).toContain(
      "1 server came back at a different address or route; the credentials saved here for it were cleared."
    );
    expect(lastInfoMessage()).not.toContain("next connect");
  });

  it("an unchanged endpoint keeps them, whatever else about the server changed", async () => {
    const dest = await destWithSavedSecrets();
    const sameEndpoint = makeServer({
      name: "Renamed",
      group: "Moved",
      isHidden: true,
      multiplexing: false,
      altHost: "10.0.1.1",
      // Same members, other key order: identity is by value, not by serialization.
      proxy: { username: "pxuser", port: 1080, host: "proxy.lab", type: "socks5" }
    });

    await runImport(dest, unsealedJson([sameEndpoint]), "replace");

    expect(dest.core.getServer("srv-1")?.name).toBe("Renamed");
    expect(await savedSecrets(dest)).toEqual(KEPT);
    expect(lastInfoMessage()).not.toContain("different address");
  });

  it.each<[string, Partial<ServerConfig>, Partial<ServerConfig>]>([
    ["the port", {}, { port: 2222 }],
    ["the username", {}, { username: "root" }],
    ["the alternate host", {}, { altHost: "attacker.example" }],
    ["the alternate host, removed", {}, { altHost: undefined }],
    ["the proxy host", {}, { proxy: { type: "socks5", host: "attacker.example", port: 1080, username: "pxuser" } }],
    ["the proxy port", {}, { proxy: { type: "socks5", host: "proxy.lab", port: 1081, username: "pxuser" } }],
    ["the proxy username", {}, { proxy: { type: "socks5", host: "proxy.lab", port: 1080, username: "other" } }],
    ["the proxy type", {}, { proxy: { type: "http", host: "proxy.lab", port: 1080, username: "pxuser" } }],
    ["the proxy, removed", {}, { proxy: undefined }],
    ["the jump host", { proxy: { type: "ssh", jumpHostId: "jump-1" } }, { proxy: { type: "ssh", jumpHostId: "jump-2" } }],
    ["a proxy, added", { proxy: undefined }, { proxy: { type: "socks5", host: "proxy.lab", port: 1080, username: "pxuser" } }],
    ["the proxy kind, an SSH jump host turned SOCKS5", { proxy: { type: "ssh", jumpHostId: "jump-1" } }, { proxy: { type: "socks5", host: "jump-1", port: 1080 } }],
    ["the proxy kind, HTTP turned an SSH jump host", { proxy: { type: "http", host: "proxy.lab", port: 3128 } }, { proxy: { type: "ssh", jumpHostId: "proxy.lab" } }]
  ])("a changed endpoint — %s — deletes all three", async (_what, local, incoming) => {
    const dest = await destWithSavedSecrets(local);
    const recreated = makeServer({ ...LOCAL_ENDPOINT, ...local, ...incoming });

    await runImport(dest, unsealedJson([recreated]), "replace");

    expect(dest.core.getServer("srv-1")).toBeDefined();
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("a removed server the file does not re-create leaves no saved secrets behind for a later record with its id", async () => {
    const dest = await destWithSavedSecrets();

    await runImport(dest, unsealedJson([makeServer({ id: "other", name: "Other" })]), "replace");

    expect(dest.core.getServer("srv-1")).toBeUndefined();
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("a same-endpoint record that cannot be imported does not keep them either", async () => {
    const dest = await destWithSavedSecrets();

    // Same endpoint, but no name: validation skips it, so nothing re-creates srv-1.
    await runImport(dest, unsealedJson([makeServer({ ...LOCAL_ENDPOINT, name: "" })]), "replace");

    expect(dest.core.getServer("srv-1")).toBeUndefined();
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("a second record with the same id at another host is judged too — the last one written is the one that connects", async () => {
    const dest = await destWithSavedSecrets();

    await runImport(dest, unsealedJson([
      makeServer({ ...LOCAL_ENDPOINT }),
      makeServer({ ...LOCAL_ENDPOINT, host: "attacker.example" })
    ]), "replace");

    expect(dest.core.getServer("srv-1")?.host).toBe("attacker.example");
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("the secrets are deleted before the re-created server is published, so no connect can pair them", async () => {
    const hostAtDelete: Array<string | undefined> = [];
    let dest: Machine | undefined;
    class WatchingVault extends MockVault {
      async delete(key: string) {
        if (key === "password-srv-1") hostAtDelete.push(dest?.core.getServer("srv-1")?.host);
        await super.delete(key);
      }
    }
    dest = await destWithSavedSecrets({}, new WatchingVault());

    await runImport(dest, unsealedJson([makeServer({ ...LOCAL_ENDPOINT, host: "attacker.example" })]), "replace");

    expect(hostAtDelete).toEqual([undefined]);
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("restores linked auth profiles before publishing servers that keep their saved credentials", async () => {
    const dest = await makeMachine();
    const jumpAuth: AuthProfile = {
      id: "jump-auth",
      name: "Jump auth",
      username: "safe-user",
      authType: "key",
      keyPath: "/keys/jump"
    };
    const jump = makeServer({
      id: "jump-1",
      name: "Bastion",
      host: "bastion.example",
      username: "raw-other-user",
      authType: "key",
      keyPath: "/keys/jump",
      authProfileId: jumpAuth.id
    });
    const target = makeServer({
      id: "srv-1",
      name: "Router",
      host: "10.0.0.1",
      username: "target-user",
      authType: "password",
      proxy: { type: "ssh", jumpHostId: jump.id }
    });
    await dest.core.addOrUpdateAuthProfile(jumpAuth);
    await dest.core.addOrUpdateServer(jump);
    await dest.core.addOrUpdateServer(target);
    await dest.vault.store("password-srv-1", "target-secret");

    const connectorCalls: Array<{
      server: ServerConfig;
      auth: Parameters<SshConnector["connect"]>[1];
    }> = [];
    const connector: SshConnector = {
      connect: async (server, auth) => {
        connectorCalls.push({ server, auth });
        return {
          openDirectTcp: async () => new PassThrough(),
          onClose: () => () => undefined,
          dispose: () => undefined,
          getBanner: () => undefined
        } as unknown as SshConnection;
      }
    };
    const authFactory = new SilentAuthSshFactory(
      connector,
      dest.vault,
      { prompt: async () => undefined },
      undefined,
      (id) => dest.core.getAuthProfile(id),
      (id) => dest.core.getServer(id)
    );
    const proxyFactory = new ProxySshFactory(authFactory, (id) => dest.core.getServer(id), dest.vault);
    let profileAtTargetPublication: AuthProfile | undefined;
    let connectPromise: Promise<SshConnection> | undefined;
    const unsubscribe = dest.core.onDidChange((snapshot) => {
      const hasJump = snapshot.servers.some((server) => server.id === jump.id);
      const hasTarget = snapshot.servers.some((server) => server.id === target.id);
      if (!connectPromise && hasJump && hasTarget) {
        profileAtTargetPublication = dest.core.getAuthProfile(jumpAuth.id);
        // `addOrUpdateServer` publishes synchronously, while an unrelated connect
        // can start without waiting for the import command's mutation lock.
        connectPromise = proxyFactory.connectWithContext(dest.core.getServer(target.id)!);
      }
    });

    try {
      await runImport(dest, unsealedJson([jump, target], [jumpAuth]), "replace");
      if (!connectPromise) throw new Error("Replace did not publish the complete jump route");
      await connectPromise;
    } finally {
      unsubscribe();
    }

    expect(profileAtTargetPublication).toEqual(jumpAuth);
    expect(connectorCalls.map(({ server }) => server.id)).toEqual([jump.id, target.id]);
    expect(connectorCalls[0]?.server.username).toBe("safe-user");
    expect(connectorCalls[1]?.auth.password).toBe("target-secret");
    expect(await dest.vault.get("password-srv-1")).toBe("target-secret");
  });

  it("a sealed backup still restores the secrets it carries onto its own record, and a secret it lacks is not kept from this machine", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateServer(makeServer({ host: "10.9.9.9" }));
    await source.vault.store("password-srv-1", "file-pw");
    const json = await exportBackup(source);
    const dest = await destWithSavedSecrets();

    await runImport(dest, json, "replace");

    expect(dest.core.getServer("srv-1")?.host).toBe("10.9.9.9");
    expect(await savedSecrets(dest)).toEqual(["file-pw", undefined, undefined]);
  });

  it("the message counts a server whose backup put back its password but not its proxy password, and not one whose backup put back everything cleared", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, host: "10.9.9.9" }));
    await source.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, id: "srv-2", name: "srv-2", host: "10.9.9.10" }));
    await source.vault.store("password-srv-1", "file-pw");
    await source.vault.store("password-srv-2", "file-pw-2");
    const json = await exportBackup(source);
    const dest = await makeMachine();
    await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT }));
    await dest.vault.store("password-srv-1", "router-pw");
    await dest.vault.store("proxy-password-srv-1", "proxy-pw");
    await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, id: "srv-2", name: "srv-2" }));
    await dest.vault.store("password-srv-2", "router-pw-2");

    await runImport(dest, json, "replace");

    // srv-1 will still ask for its proxy password; srv-2 got everything it lost back.
    expect(await dest.vault.get("proxy-password-srv-1")).toBeUndefined();
    expect(await dest.vault.get("password-srv-2")).toBe("file-pw-2");
    expect(lastInfoMessage()).toContain(
      "1 server came back at a different address or route; the credentials saved here for it were cleared."
    );
    expect(lastInfoMessage()).not.toContain("next connect");
  });

  it("a sealed backup of the same endpoint keeps what this machine saved and overwrites only what the backup carries", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT }));
    await source.vault.store("password-srv-1", "file-pw");
    const json = await exportBackup(source);
    const dest = await destWithSavedSecrets();

    await runImport(dest, json, "replace");

    expect(await savedSecrets(dest)).toEqual(["file-pw", "router-pp", "proxy-pw"]);
  });

  it("a server a sealed backup brings back with no proxy and its SSH password restored is still counted, and the message promises no prompt", async () => {
    const source = await makeMachine();
    await source.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, proxy: undefined }));
    await source.vault.store("password-srv-1", "file-pw");
    const json = await exportBackup(source);
    const dest = await makeMachine();
    await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT }));
    await dest.vault.store("password-srv-1", "router-pw");
    await dest.vault.store("proxy-password-srv-1", "proxy-pw");

    await runImport(dest, json, "replace");

    // Nothing will ask for the cleared proxy password — the server has no proxy
    // now — so the message states what happened and nothing more.
    expect(dest.core.getServer("srv-1")?.proxy).toBeUndefined();
    expect(await savedSecrets(dest)).toEqual(["file-pw", undefined, undefined]);
    expect(lastInfoMessage()).toContain("1 server came back at a different address or route; the credentials saved here for it were cleared.");
    expect(lastInfoMessage()).not.toContain("next connect");
  });

  it("the completion message counts the re-created servers whose saved secrets were cleared — not an unchanged one, and not one that had none", async () => {
    const dest = await destWithSavedSecrets();
    for (const id of ["srv-2", "srv-3"]) {
      await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, id, name: id }));
      await dest.vault.store(`password-${id}`, `${id}-pw`);
    }
    await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, id: "srv-4", name: "No saved password" }));

    await runImport(dest, unsealedJson([
      makeServer({ ...LOCAL_ENDPOINT, host: "attacker.example" }),
      makeServer({ ...LOCAL_ENDPOINT, id: "srv-2", name: "srv-2", port: 2222 }),
      makeServer({ ...LOCAL_ENDPOINT, id: "srv-3", name: "srv-3" }),
      makeServer({ ...LOCAL_ENDPOINT, id: "srv-4", name: "No saved password", host: "elsewhere.example" })
    ]), "replace");

    expect(lastInfoMessage()).toBe(
      "Imported 4 profiles (replaced existing). 2 servers came back at a different address or route; the credentials saved here for them were cleared."
    );
    expect(await dest.vault.get("password-srv-3")).toBe("srv-3-pw");
  });

  it("if the import fails partway, every removed server still holding secrets loses them before the error surfaces — re-created unchanged or not", async () => {
    const dest = await destWithSavedSecrets();
    const write = dest.core.addOrUpdateServer.bind(dest.core);
    vi.spyOn(dest.core, "addOrUpdateServer").mockImplementation(async (server) => {
      if (server.id === "boom") throw new Error("disk full");
      await write(server);
    });

    // srv-1 comes back unchanged, then the next record's write fails.
    register(dest);
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }).mockResolvedValueOnce({ label: "Replace", value: "replace" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/nexus-backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(unsealedJson([makeServer({ ...LOCAL_ENDPOINT }), makeServer({ id: "boom", name: "Boom" })]), "utf8"));
    await expect(registeredCommands.get("nexus.config.import")!()).rejects.toThrow("disk full");

    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("if clearing a changed endpoint's secrets fails, they are cleared again before the error surfaces, and the record is never published", async () => {
    let failOnce = true;
    class FlakyVault extends MockVault {
      async delete(key: string) {
        if (key === "password-srv-1" && failOnce) {
          failOnce = false;
          throw new Error("keychain locked");
        }
        await super.delete(key);
      }
    }
    const dest = await destWithSavedSecrets({}, new FlakyVault());

    register(dest);
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }).mockResolvedValueOnce({ label: "Replace", value: "replace" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/nexus-backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(unsealedJson([makeServer({ ...LOCAL_ENDPOINT, host: "attacker.example" })]), "utf8"));
    await expect(registeredCommands.get("nexus.config.import")!()).rejects.toThrow("keychain locked");

    expect(dest.core.getServer("srv-1")).toBeUndefined();
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  describe("a server behind an SSH jump host — the jump host is part of its route", () => {
    const via = (jumpHostId: string): Partial<ServerConfig> => ({ proxy: { type: "ssh", jumpHostId } });

    async function destWithChain(): Promise<Machine> {
      const dest = await destWithSavedSecrets(via("jump-1"));
      await dest.core.addOrUpdateServer(makeServer({ id: "jump-1", name: "Jump 1", host: "10.1.0.1", ...via("jump-2") }));
      await dest.core.addOrUpdateServer(makeServer({ id: "jump-2", name: "Jump 2", host: "10.2.0.1" }));
      for (const id of ["jump-1", "jump-2"]) await dest.vault.store(`password-${id}`, `${id}-pw`);
      return dest;
    }
    const target = () => makeServer({ ...LOCAL_ENDPOINT, ...via("jump-1") });
    const jump1 = (overrides: Partial<ServerConfig> = {}) => makeServer({ id: "jump-1", name: "Jump 1", host: "10.1.0.1", ...via("jump-2"), ...overrides });
    const jump2 = (overrides: Partial<ServerConfig> = {}) => makeServer({ id: "jump-2", name: "Jump 2", host: "10.2.0.1", ...overrides });

    it("a target that comes back unchanged loses its secrets when its jump host comes back somewhere else", async () => {
      const dest = await destWithChain();

      await runImport(dest, unsealedJson([jump1({ host: "attacker.example" }), target(), jump2()]), "replace");

      expect(dest.core.getServer("srv-1")?.host).toBe("10.0.0.1");
      expect(await savedSecrets(dest)).toEqual(GONE);
      expect(await dest.vault.get("password-jump-2")).toBe("jump-2-pw");
    });

    it.each([
      ["recreates a profile with changed connection fields", "jump-auth", "ops-new"],
      ["relinks the jump host to another profile", "jump-auth-replacement", "ops-old"]
    ])("clears target secrets when Replace %s", async (_change, profileId, username) => {
      const dest = await destWithChain();
      const oldProfile = { id: "jump-auth", name: "Jump auth", username: "ops-old", authType: "password" as const };
      await dest.core.addOrUpdateAuthProfile(oldProfile);
      await dest.core.addOrUpdateServer(jump1({ authProfileId: oldProfile.id }));
      await dest.vault.store("password-jump-1", "jump-1-pw");

      // The server record and its raw username are unchanged. The effective
      // bastion auth changes either through profile fields or its linked id.
      const replacementProfile = { ...oldProfile, id: profileId, username };
      await runImport(
        dest,
        unsealedJson([target(), jump1({ authProfileId: replacementProfile.id }), jump2()], [replacementProfile]),
        "replace"
      );

      expect(dest.core.getAuthProfile(replacementProfile.id)?.username).toBe(username);
      expect(await savedSecrets(dest)).toEqual(GONE);
      expect(await dest.vault.get("password-jump-1")).toBeUndefined();
    });

    it("a two-hop chain whose far hop moved clears every server behind it", async () => {
      const dest = await destWithChain();

      await runImport(dest, unsealedJson([target(), jump1(), jump2({ host: "attacker.example" })]), "replace");

      expect(await savedSecrets(dest)).toEqual(GONE);
      expect(await dest.vault.get("password-jump-1")).toBeUndefined();
      expect(await dest.vault.get("password-jump-2")).toBeUndefined();
    });

    it("a jump host listed after its target still decides the target, before the target is published", async () => {
      const hostAtDelete: Array<string | undefined> = [];
      let dest: Machine | undefined;
      class WatchingVault extends MockVault {
        async delete(key: string) {
          if (key === "password-srv-1") hostAtDelete.push(dest?.core.getServer("srv-1")?.host);
          await super.delete(key);
        }
      }
      dest = await destWithSavedSecrets(via("jump-1"), new WatchingVault());
      await dest.core.addOrUpdateServer(jump1({ proxy: undefined }));

      await runImport(dest, unsealedJson([target(), jump1({ proxy: undefined, host: "attacker.example" })]), "replace");

      expect(hostAtDelete).toEqual([undefined]);
      expect(await savedSecrets(dest)).toEqual(GONE);
    });

    it("a jump host the file does not bring back clears the servers behind it", async () => {
      const dest = await destWithChain();

      await runImport(dest, unsealedJson([target(), jump2()]), "replace");

      expect(dest.core.getServer("jump-1")).toBeUndefined();
      expect(await savedSecrets(dest)).toEqual(GONE);
    });

    it("an unchanged chain, or an unchanged cycle, keeps every hop's secrets", async () => {
      const dest = await destWithChain();
      await dest.core.addOrUpdateServer(makeServer({ id: "cyc-a", name: "Cycle A", host: "10.3.0.1", ...via("cyc-b") }));
      await dest.core.addOrUpdateServer(makeServer({ id: "cyc-b", name: "Cycle B", host: "10.3.0.2", ...via("cyc-a") }));
      for (const id of ["cyc-a", "cyc-b"]) await dest.vault.store(`password-${id}`, `${id}-pw`);

      await runImport(dest, unsealedJson([
        target(),
        jump1(),
        jump2(),
        makeServer({ id: "cyc-a", name: "Cycle A", host: "10.3.0.1", ...via("cyc-b") }),
        makeServer({ id: "cyc-b", name: "Cycle B", host: "10.3.0.2", ...via("cyc-a") })
      ]), "replace");

      expect(await savedSecrets(dest)).toEqual(KEPT);
      for (const id of ["jump-1", "jump-2", "cyc-a", "cyc-b"]) {
        expect(await dest.vault.get(`password-${id}`)).toBe(`${id}-pw`);
      }
      expect(lastInfoMessage()).not.toContain("different address");
    });
  });

  it("a wipe step that fails after the servers are removed still sweeps their secrets, and the original error is the one reported", async () => {
    class FailingVault extends MockVault {
      async delete(key: string) {
        if (key === "auth-profile-password-ap-1" || key === "passphrase-srv-1") throw new Error(`cannot delete ${key}`);
        await super.delete(key);
      }
    }
    const dest = await destWithSavedSecrets({}, new FailingVault());
    await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, id: "srv-2", name: "srv-2" }));
    await dest.vault.store("password-srv-2", "srv-2-pw");
    await dest.vault.store("proxy-password-srv-2", "srv-2-proxy");
    await dest.core.addOrUpdateAuthProfile({ id: "ap-1", name: "Ops", username: "ops", authType: "password" });

    register(dest);
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }).mockResolvedValueOnce({ label: "Replace", value: "replace" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/nexus-backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(unsealedJson([makeServer({ ...LOCAL_ENDPOINT })]), "utf8"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(registeredCommands.get("nexus.config.import")!()).rejects.toThrow("cannot delete auth-profile-password-ap-1");
    warn.mockRestore();

    // Every key that can be deleted is: the one that cannot does not stop the rest.
    expect(await savedSecrets(dest)).toEqual([undefined, "router-pp", undefined]);
    expect(await dest.vault.get("password-srv-2")).toBeUndefined();
    expect(await dest.vault.get("proxy-password-srv-2")).toBeUndefined();
  });

  it("a server whose removal fails to persist still has its secrets swept — it is already gone from this session", async () => {
    const dest = await destWithSavedSecrets();
    await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, id: "srv-2", name: "srv-2" }));
    await dest.vault.store("password-srv-2", "srv-2-pw");
    const remove = dest.core.removeServer.bind(dest.core);
    vi.spyOn(dest.core, "removeServer").mockImplementation(async (id) => {
      // As NexusCore does: the record leaves memory, then the persist rejects.
      await remove(id);
      if (id === "srv-2") throw new Error("disk full");
    });

    register(dest);
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }).mockResolvedValueOnce({ label: "Replace", value: "replace" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/nexus-backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(unsealedJson([makeServer({ ...LOCAL_ENDPOINT })]), "utf8"));
    await expect(registeredCommands.get("nexus.config.import")!()).rejects.toThrow("disk full");

    expect(dest.core.getServer("srv-2")).toBeUndefined();
    expect(await dest.vault.get("password-srv-2")).toBeUndefined();
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("a failed delete for one server the file leaves out does not stop the others' being cleared", async () => {
    let failOnce = true;
    class FlakyVault extends MockVault {
      async delete(key: string) {
        if (key === "password-srv-1" && failOnce) {
          failOnce = false;
          throw new Error("keychain locked");
        }
        await super.delete(key);
      }
    }
    const dest = await destWithSavedSecrets({}, new FlakyVault());
    for (const id of ["srv-2", "srv-3"]) {
      await dest.core.addOrUpdateServer(makeServer({ ...LOCAL_ENDPOINT, id, name: id }));
      await dest.vault.store(`password-${id}`, `${id}-pw`);
    }

    register(dest);
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }).mockResolvedValueOnce({ label: "Replace", value: "replace" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/nexus-backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(unsealedJson([makeServer({ id: "other", name: "Other" })]), "utf8"));
    await expect(registeredCommands.get("nexus.config.import")!()).rejects.toThrow("keychain locked");

    expect(await dest.vault.get("password-srv-2")).toBeUndefined();
    expect(await dest.vault.get("password-srv-3")).toBeUndefined();
    // The one that failed stays waiting, and the sweep clears it.
    expect(await savedSecrets(dest)).toEqual(GONE);
  });

  it("Merge is unchanged: the local server and its secrets stay, whatever endpoint the file gives its id", async () => {
    const dest = await destWithSavedSecrets();

    await runImport(dest, unsealedJson([
      makeServer({ ...LOCAL_ENDPOINT, host: "attacker.example" }),
      makeServer({ id: "srv-2", name: "New" })
    ]), "merge");

    expect(dest.core.getServer("srv-1")?.host).toBe("10.0.0.1");
    expect(dest.core.getServer("srv-2")).toBeDefined();
    expect(await savedSecrets(dest)).toEqual(KEPT);
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
