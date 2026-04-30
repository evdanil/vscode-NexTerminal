import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockChmod = vi.hoisted(() => vi.fn(async () => {}));

// Capture registered command handlers
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
const mockWithProgress = vi.fn();
const mockConfigUpdate = vi.fn();
const configStore = new Map<string, unknown>();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    })
  },
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showSaveDialog: (...args: unknown[]) => mockShowSaveDialog(...args),
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    withProgress: (_opts: unknown, task: (progress: unknown) => Promise<void>) => {
      mockWithProgress(_opts);
      return task({ report: vi.fn() });
    }
  },
  workspace: {
    fs: {
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
      readDirectory: (...args: unknown[]) => mockReadDirectory(...args),
      stat: (...args: unknown[]) => mockStat(...args),
      createDirectory: (...args: unknown[]) => mockCreateDirectory(...args)
    },
    workspaceFolders: [
      { uri: { fsPath: "/workspace", scheme: "file", path: "/workspace" }, name: "workspace", index: 0 }
    ],
    getConfiguration: vi.fn((section: string) => ({
      get: (key: string) => configStore.get(`${section}.${key}`),
      update: (key: string, value: unknown) => {
        if (value === undefined) {
          configStore.delete(`${section}.${key}`);
        } else {
          configStore.set(`${section}.${key}`, value);
        }
        return mockConfigUpdate(section, key, value);
      }
    }))
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: "file" }),
    joinPath: (base: { fsPath: string; scheme: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/").replace(/\/+/g, "/"),
      scheme: base.scheme
    })
  },
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 }
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    chmod: mockChmod
  };
});

import { registerConfigCommands, isValidExport, SETTINGS_KEYS, sanitizeForSharing } from "../../src/commands/configCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { VscodeMacroStore, macroSecretKey } from "../../src/storage/vscodeMacroStore";
import { setActiveMacroStore, getMacros } from "../../src/macroSettings";
import type { SecretVault } from "../../src/services/ssh/contracts";
import type { AuthProfile, ServerConfig, TunnelProfile, SerialProfile } from "../../src/models/config";

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  contributes?: {
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
};

class MockVault implements SecretVault {
  private secrets = new Map<string, string>();
  async get(key: string) { return this.secrets.get(key); }
  async store(key: string, value: string) { this.secrets.set(key, value); }
  async delete(key: string) { this.secrets.delete(key); }
  clear() { this.secrets.clear(); }
  getAll() { return new Map(this.secrets); }
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

function makeTunnel(overrides: Partial<TunnelProfile> = {}): TunnelProfile {
  return {
    id: "t1",
    name: "DB Tunnel",
    localPort: 5432,
    remoteIP: "127.0.0.1",
    remotePort: 5432,
    autoStart: false,
    ...overrides
  };
}

function makeSerialProfile(overrides: Partial<SerialProfile> = {}): SerialProfile {
  return {
    id: "sp1",
    name: "Lab UART",
    path: "COM4",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    ...overrides
  };
}

function makeAuthProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: "ap1",
    name: "Prod Auth",
    username: "deploy",
    authType: "password",
    ...overrides
  };
}

function makeExportData(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    servers: [makeServer()],
    tunnels: [makeTunnel()],
    serialProfiles: [makeSerialProfile()],
    groups: ["Dev"],
    settings: {},
    ...overrides
  };
}

// Set up a shared macro store for all tests in this file. The store must be
// initialized before any test that triggers exportBackup or importMergeReplace,
// both of which call getMacros()/saveMacros().
beforeEach(async () => {
  const store = new InMemoryMacroStore();
  await store.initialize();
  setActiveMacroStore(store);
});

describe("isValidExport", () => {
  it("accepts valid export data", () => {
    expect(isValidExport(makeExportData())).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidExport(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isValidExport("string")).toBe(false);
    expect(isValidExport(42)).toBe(false);
  });

  it("rejects missing version", () => {
    expect(isValidExport(makeExportData({ version: undefined }))).toBe(false);
  });

  it("rejects wrong version", () => {
    expect(isValidExport(makeExportData({ version: 3 }))).toBe(false);
  });

  it("accepts version 2 exports", () => {
    expect(isValidExport(makeExportData({ version: 2 }))).toBe(true);
  });

  it("rejects when no arrays are present", () => {
    expect(isValidExport(makeExportData({ servers: "not-array", tunnels: null, serialProfiles: undefined }))).toBe(false);
  });

  it("accepts servers-only partial config", () => {
    expect(isValidExport({ version: 1, servers: [makeServer()] })).toBe(true);
  });

  it("accepts tunnels-only partial config", () => {
    expect(isValidExport({ version: 1, tunnels: [makeTunnel()] })).toBe(true);
  });

  it("accepts serialProfiles-only partial config", () => {
    expect(isValidExport({ version: 1, serialProfiles: [makeSerialProfile()] })).toBe(true);
  });

  it("accepts authProfiles-only partial config", () => {
    expect(isValidExport({ version: 1, authProfiles: [makeAuthProfile()] })).toBe(true);
  });

  it("accepts empty profile arrays (valid backup scaffold)", () => {
    expect(isValidExport({ version: 1, servers: [], tunnels: [], serialProfiles: [] })).toBe(true);
  });

  it("rejects invalid profile array types", () => {
    expect(isValidExport({ version: 1, servers: {} })).toBe(false);
    expect(isValidExport({ version: 1, authProfiles: "bad" })).toBe(false);
  });
});

describe("SETTINGS_KEYS", () => {
  it("covers every contributed Nexus setting (except macros array, which moved to MacroStore)", () => {
    const keys = new Set(SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`));
    // nexus.terminal.macros (the array) is intentionally excluded — it now lives in MacroStore, not settings.
    const INTENTIONALLY_EXCLUDED = new Set(["nexus.terminal.macros"]);
    const contributedKeys = Object.keys(packageJson.contributes?.configuration?.properties ?? {})
      .filter((key) => key.startsWith("nexus.") && !INTENTIONALLY_EXCLUDED.has(key));
    expect(contributedKeys.filter((key) => !keys.has(key))).toEqual([]);
  });

  it("includes all terminal settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.terminal.openLocation");
    expect(keys).toContain("nexus.terminal.keyboardPassthrough");
    expect(keys).toContain("nexus.terminal.passthroughKeys");
    // nexus.terminal.macros (array) intentionally not in SETTINGS_KEYS — moved to MacroStore
    expect(keys).not.toContain("nexus.terminal.macros");
    expect(keys).toContain("nexus.terminal.highlighting.enabled");
    expect(keys).toContain("nexus.terminal.highlighting.rules");
  });

  it("includes logging settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.logging.sessionTranscripts");
    expect(keys).toContain("nexus.logging.sessionLogDirectory");
    expect(keys).toContain("nexus.logging.maxFileSizeMb");
    expect(keys).toContain("nexus.logging.maxRotatedFiles");
  });

  it("includes tunnel settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.tunnel.defaultConnectionMode");
    expect(keys).toContain("nexus.tunnel.defaultBindAddress");
  });

  it("includes SSH multiplexing settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.ssh.multiplexing.enabled");
    expect(keys).toContain("nexus.ssh.multiplexing.idleTimeout");
    expect(keys).toContain("nexus.ssh.trustNewHosts");
  });

  it("includes SFTP settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.sftp.cacheTtlSeconds");
    expect(keys).toContain("nexus.sftp.maxCacheEntries");
    expect(keys).toContain("nexus.sftp.autoRefreshInterval");
    expect(keys).toContain("nexus.sftp.remoteWatchMode");
  });

  it("includes interface settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.ui.showTreeDescriptions");
  });
});

describe("config import command (legacy)", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  async function runImport(exportData: unknown, mode: "merge" | "replace" = "merge") {
    const json = JSON.stringify(exportData);
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(json, "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: mode === "merge" ? "Merge" : "Replace", value: mode });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();
  }

  it("imports valid profiles into empty core", async () => {
    const exportData = makeExportData();
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].id).toBe("s1");
    expect(snapshot.tunnels).toHaveLength(1);
    expect(snapshot.tunnels[0].id).toBe("t1");
    expect(snapshot.serialProfiles).toHaveLength(1);
    expect(snapshot.serialProfiles[0].id).toBe("sp1");
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 3 profiles.");
  });

  it("merge mode skips duplicate IDs", async () => {
    await core.addOrUpdateServer(makeServer());

    const exportData = makeExportData({
      servers: [makeServer(), makeServer({ id: "s2", name: "Server 2" })],
      tunnels: [],
      serialProfiles: []
    });
    await runImport(exportData, "merge");

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(2);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 1 profile (1 skipped).");
  });

  it("replace mode clears existing and imports new", async () => {
    await core.addOrUpdateServer(makeServer({ id: "existing", name: "Old" }));
    await core.addOrUpdateTunnel(makeTunnel({ id: "existing-t", name: "Old Tunnel" }));

    const exportData = makeExportData();
    await runImport(exportData, "replace");

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].id).toBe("s1");
    expect(snapshot.tunnels).toHaveLength(1);
    expect(snapshot.tunnels[0].id).toBe("t1");
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("(replaced existing)")
    );
  });

  it("replace mode deletes existing auth-profile password and passphrase secrets", async () => {
    await core.addOrUpdateAuthProfile(makeAuthProfile({ id: "existing-ap", authType: "key", keyPath: "/keys/id_ed25519" }));
    await vault.store("auth-profile-password-existing-ap", "old-password");
    await vault.store("auth-profile-passphrase-existing-ap", "old-passphrase");

    const exportData = makeExportData({ authProfiles: [] });
    await runImport(exportData, "replace");

    expect(await vault.get("auth-profile-password-existing-ap")).toBeUndefined();
    expect(await vault.get("auth-profile-passphrase-existing-ap")).toBeUndefined();
  });

  it("imports old-format tunnels without browserUrl or notes", async () => {
    const legacyTunnel = { id: "t-old", name: "Legacy", localPort: 8080, remoteIP: "127.0.0.1", remotePort: 80, autoStart: false };
    const exportData = makeExportData({ tunnels: [legacyTunnel] });
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    expect(snapshot.tunnels).toHaveLength(1);
    expect(snapshot.tunnels[0].id).toBe("t-old");
    expect(snapshot.tunnels[0].name).toBe("Legacy");
    expect(snapshot.tunnels[0].browserUrl).toBeUndefined();
    expect(snapshot.tunnels[0].notes).toBeUndefined();
  });

  it("skips invalid items and reports skip count", async () => {
    const exportData = makeExportData({
      servers: [
        makeServer(),
        { id: "bad", name: "" } // invalid: missing host, port, username, authType
      ],
      tunnels: [
        { id: "bad-t" } // invalid: missing required fields
      ],
      serialProfiles: []
    });
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.tunnels).toHaveLength(0);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 1 profile (2 skipped).");
  });

  it("rejects invalid JSON", async () => {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from("not json!", "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("Invalid JSON file.");
  });

  it("rejects non-NexusConfigExport data", async () => {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify({ foo: "bar" }), "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("Not a valid Nexus configuration file.");
  });

  it("imports groups", async () => {
    const exportData = makeExportData({ groups: ["Production", "Staging"] });
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    expect(snapshot.explicitGroups).toContain("Production");
    expect(snapshot.explicitGroups).toContain("Staging");
  });

  it("ignores unknown imported settings keys", async () => {
    const exportData = makeExportData({
      settings: {
        "nexus.logging.maxFileSizeMb": 12,
        "nexus.tunnel.defaultBindAddress": "0.0.0.0",
        "nexus.logging.unexpectedKey": true,
        "badkey": "value"
      }
    });
    await runImport(exportData);

    expect(configStore.get("nexus.logging.maxFileSizeMb")).toBe(12);
    expect(configStore.get("nexus.tunnel.defaultBindAddress")).toBe("0.0.0.0");
    expect(configStore.has("nexus.logging.unexpectedKey")).toBe(false);
    expect(configStore.has("badkey")).toBe(false);
  });

  it("skips unsafe imported highlighting rules", async () => {
    const exportData = makeExportData({
      settings: {
        "nexus.terminal.highlighting.rules": [
          { pattern: "^(?:a+)+$", color: "red", flags: "g" }
        ]
      }
    });
    await runImport(exportData);

    expect(configStore.has("nexus.terminal.highlighting.rules")).toBe(false);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      "1 imported Nexus setting had an invalid value and was skipped."
    );
  });

  it("generates IDs for items with missing IDs", async () => {
    const exportData = makeExportData({
      servers: [{ ...makeServer(), id: "" }],
      tunnels: [{ ...makeTunnel(), id: undefined }],
      serialProfiles: [{ ...makeSerialProfile(), id: "  " }]
    });
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    // The items should have been imported with generated IDs
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].id).toBeTruthy();
    expect(snapshot.servers[0].id).not.toBe("");
    expect(snapshot.tunnels).toHaveLength(1);
    expect(snapshot.tunnels[0].id).toBeTruthy();
    expect(snapshot.serialProfiles).toHaveLength(1);
    expect(snapshot.serialProfiles[0].id).toBeTruthy();
    expect(snapshot.serialProfiles[0].id.trim()).not.toBe("");
  });

  it("preserves legacyAlgorithms through import round-trip", async () => {
    const exportData = makeExportData({
      servers: [makeServer({ legacyAlgorithms: true })],
      tunnels: [],
      serialProfiles: []
    });
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].legacyAlgorithms).toBe(true);
  });

  it("imports partial config with only servers", async () => {
    const partialExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      servers: [makeServer()]
    };
    await runImport(partialExport);

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].id).toBe("s1");
    expect(snapshot.tunnels).toHaveLength(0);
    expect(snapshot.serialProfiles).toHaveLength(0);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 1 profile.");
  });
});

describe("share export command", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  it("exports with fresh IDs, sanitized fields, and stripped secret macros", async () => {
    await core.addOrUpdateServer(makeServer({ username: "alice", keyPath: "/home/alice/.ssh/id_rsa" }));
    await core.addOrUpdateTunnel(makeTunnel({ defaultServerId: "s1" }));
    await core.addOrUpdateSerialProfile(makeSerialProfile());
    await core.addOrUpdateAuthProfile(makeAuthProfile({ authType: "key", keyPath: "/home/alice/.ssh/id_ed25519" }));

    // Set macros via MacroStore (not configStore)
    const shareStore = new InMemoryMacroStore();
    await shareStore.initialize();
    await shareStore.save([
      { name: "Hello", text: "echo hi", secret: false, triggerPattern: "router#", triggerInterval: 10, triggerInitiallyDisabled: true },
      { name: "Secret", text: "super-secret", secret: true }
    ]);
    setActiveMacroStore(shareStore);
    configStore.set("nexus.logging.sessionLogDirectory", "/home/alice/logs");

    const savedUri = { fsPath: "/fake/export.json", scheme: "file" };
    mockShowSaveDialog.mockResolvedValue(savedUri);
    mockWriteFile.mockResolvedValue(undefined);

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));

    expect(writtenData.exportType).toBe("share");
    expect(writtenData.version).toBe(2);
    expect(writtenData.servers).toHaveLength(1);
    expect(writtenData.servers[0].id).not.toBe("s1");
    expect(writtenData.servers[0].username).toBe("user");
    expect(writtenData.servers[0].keyPath).toBe("");

    expect(writtenData.tunnels).toHaveLength(1);
    expect(writtenData.tunnels[0].id).not.toBe("t1");
    // defaultServerId should be remapped to the new server ID
    expect(writtenData.tunnels[0].defaultServerId).toBe(writtenData.servers[0].id);

    expect(writtenData.serialProfiles).toHaveLength(1);
    expect(writtenData.serialProfiles[0].id).not.toBe("sp1");

    // Auth profiles should NOT be in share exports
    expect(writtenData.authProfiles).toBeUndefined();

    // Secret macros stripped — non-secret macros are in top-level macros array
    expect(writtenData.macros).toHaveLength(1);
    expect(writtenData.macros[0].name).toBe("Hello");
    expect(writtenData.macros[0].triggerInterval).toBe(10);
    expect(writtenData.macros[0].triggerInitiallyDisabled).toBe(true);
    // Old settings key must not appear
    expect(writtenData.settings?.["nexus.terminal.macros"]).toBeUndefined();

    // Session log dir stripped
    expect(writtenData.settings["nexus.logging.sessionLogDirectory"]).toBe("");
  });

  it("does nothing when save dialog is cancelled", async () => {
    mockShowSaveDialog.mockResolvedValue(undefined);

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe("backup export command", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  it("exports with encrypted secrets and strips secret macro text from top-level macros", async () => {
    await core.addOrUpdateServer(makeServer());
    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await vault.store("password-s1", "mypassword");
    await vault.store("passphrase-s1", "mypassphrase");
    await vault.store("auth-profile-password-ap1", "profile-secret");
    await vault.store("auth-profile-passphrase-ap1", "profile-passphrase");

    // Set macros via MacroStore (not configStore)
    const backupExportStore = new InMemoryMacroStore();
    await backupExportStore.initialize();
    await backupExportStore.save([
      { name: "Hello", text: "echo hi", secret: false },
      { name: "Secret", text: "super-secret", secret: true }
    ]);
    setActiveMacroStore(backupExportStore);

    // First call: password entry, second: confirmation
    mockShowInputBox
      .mockResolvedValueOnce("testpass123")
      .mockResolvedValueOnce("testpass123");

    const savedUri = { fsPath: "/fake/backup.json", scheme: "file" };
    mockShowSaveDialog.mockResolvedValue(savedUri);
    mockWriteFile.mockResolvedValue(undefined);

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));

    expect(writtenData.exportType).toBe("backup");
    expect(writtenData.version).toBe(2);
    expect(writtenData.encryptedSecrets).toBeDefined();
    expect(writtenData.encryptedSecrets.cipher).toBe("aes-256-gcm");
    expect(writtenData.authProfiles).toHaveLength(1);
    expect(writtenData.authProfiles[0].id).toBe("ap1");

    const { decrypt } = await import("../../src/utils/configCrypto");
    const decrypted = JSON.parse(decrypt(writtenData.encryptedSecrets, "testpass123"));
    expect(decrypted.authProfilePasswords).toEqual({ ap1: "profile-secret" });
    expect(decrypted.authProfilePassphrases).toEqual({ ap1: "profile-passphrase" });

    // Macros are in the top-level macros array; secret text stripped, real text in encryptedSecrets
    expect(Array.isArray(writtenData.macros)).toBe(true);
    const secretMacro = writtenData.macros.find((m: { name: string }) => m.name === "Secret");
    expect(secretMacro.text).toBe("");

    // Non-secret macros keep their text
    const normalMacro = writtenData.macros.find((m: { name: string }) => m.name === "Hello");
    expect(normalMacro.text).toBe("echo hi");

    // Secret text in encrypted blob
    const secretBlob = (decrypted.secretMacros as Array<{ id?: string; text?: string }>).find(
      (b) => b.id === (secretMacro as { id?: string }).id
    );
    expect(secretBlob?.text).toBe("super-secret");

    // Original IDs preserved in backup
    expect(writtenData.servers[0].id).toBe("s1");
  });

  it("exports the user .ssh folder and resolved scripts folder inside encrypted secrets", async () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    const scriptsDir = "/workspace/.nexus/scripts";
    const fakeContext = {
      globalStorageUri: { fsPath: "/global-storage", scheme: "file", path: "/global-storage" }
    } as unknown as import("vscode").ExtensionContext;

    registeredCommands.clear();
    configStore.set("nexus.scripts.path", ".nexus/scripts");
    registerConfigCommands(core, vault, fakeContext);

    mockStat.mockImplementation(async (uri: { fsPath: string }) => {
      if ([sshDir, scriptsDir].includes(uri.fsPath)) return { type: 2 };
      if ([path.join(sshDir, "config"), path.join(sshDir, "keys"), path.join(sshDir, "keys/id_ed25519"), `${scriptsDir}/hello.js`].includes(uri.fsPath)) {
        return { type: uri.fsPath.endsWith("keys") ? 2 : 1 };
      }
      throw new Error(`ENOENT: ${uri.fsPath}`);
    });
    mockReadDirectory.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === sshDir) return [["config", 1], ["keys", 2]];
      if (uri.fsPath === path.join(sshDir, "keys")) return [["id_ed25519", 1]];
      if (uri.fsPath === scriptsDir) return [["hello.js", 1]];
      return [];
    });
    mockReadFile.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === path.join(sshDir, "config")) return Buffer.from("Host lab\n");
      if (uri.fsPath === path.join(sshDir, "keys/id_ed25519")) return Buffer.from("PRIVATE KEY");
      if (uri.fsPath === `${scriptsDir}/hello.js`) return Buffer.from("/** @nexus-script */\n");
      throw new Error(`ENOENT: ${uri.fsPath}`);
    });

    mockShowInputBox
      .mockResolvedValueOnce("testpass123")
      .mockResolvedValueOnce("testpass123");
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup.json", scheme: "file" });

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();

    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
    const { decrypt } = await import("../../src/utils/configCrypto");
    const decrypted = JSON.parse(decrypt(writtenData.encryptedSecrets, "testpass123"));

    const fileBackups = decrypted.fileBackups as Array<{ id: string; files: Array<{ relativePath: string; contentsBase64: string }> }>;
    expect(fileBackups.map((b) => b.id)).toEqual(["ssh", "scripts"]);
    expect(fileBackups.find((b) => b.id === "ssh")?.files.map((f) => f.relativePath).sort()).toEqual([
      "config",
      "keys/id_ed25519"
    ]);
    expect(Buffer.from(fileBackups.find((b) => b.id === "ssh")!.files[0].contentsBase64, "base64").toString("utf8")).toBe("Host lab\n");
    expect(fileBackups.find((b) => b.id === "scripts")?.configuredPath).toBe(".nexus/scripts");
    expect(fileBackups.find((b) => b.id === "scripts")?.files[0].relativePath).toBe("hello.js");
  });
});

describe("backup import", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  it("decrypts and restores passwords, passphrases, and secret macros", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");
    // Use version 2 backup format: top-level macros array + id-keyed secret blobs
    const helloId = "macro-hello-id";
    const secretId = "macro-secret-id";
    const secrets = {
      passwords: { s1: "restored-pw" },
      passphrases: { s1: "restored-pp" },
      authProfilePasswords: { ap1: "restored-auth-pw" },
      authProfilePassphrases: { ap1: "restored-auth-pp" },
      secretMacros: [{ id: secretId, text: "super-secret" }]
    };
    const encrypted = encrypt(JSON.stringify(secrets), "testpass");

    // Version 2 backup: macros at top level
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [makeServer()],
      tunnels: [makeTunnel()],
      serialProfiles: [makeSerialProfile()],
      authProfiles: [makeAuthProfile()],
      macros: [
        { id: helloId, name: "Hello", text: "echo hi", secret: false },
        { id: secretId, name: "Secret", text: "", secret: true }
      ],
      settings: {},
      encryptedSecrets: encrypted
    };

    // Backup import needs a fresh store
    const importStore = new InMemoryMacroStore();
    await importStore.initialize();
    setActiveMacroStore(importStore);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("testpass"); // decrypt password

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    // Passwords restored to vault
    expect(await vault.get("password-s1")).toBe("restored-pw");
    expect(await vault.get("passphrase-s1")).toBe("restored-pp");
    expect(await vault.get("auth-profile-password-ap1")).toBe("restored-auth-pw");
    expect(await vault.get("auth-profile-passphrase-ap1")).toBe("restored-auth-pp");

    // Secret macros restored via MacroStore
    const macros = importStore.getAll();
    expect(macros).toBeDefined();
    const secretMacro = macros.find(m => m.name === "Secret");
    expect(secretMacro?.text).toBe("super-secret");
    expect(core.getSnapshot().authProfiles).toHaveLength(1);
  });

  it("shows error on wrong password", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");
    const encrypted = encrypt(JSON.stringify({ passwords: {}, passphrases: {}, secretMacros: [] }), "correct");

    const exportData = makeExportData({ exportType: "backup", encryptedSecrets: encrypted });

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("wrong");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("Incorrect password or corrupted backup.");
    // Nothing imported
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("imports backup with only auth profiles", async () => {
    const exportData = {
      version: 1,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [makeAuthProfile()]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Merge", value: "merge" });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.authProfiles).toHaveLength(1);
    expect(snapshot.authProfiles[0].id).toBe("ap1");
    expect(snapshot.servers).toHaveLength(0);
    expect(snapshot.tunnels).toHaveLength(0);
    expect(snapshot.serialProfiles).toHaveLength(0);
  });

  it("merge import restores backed-up folder files only when missing", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");
    const sshDir = path.join(os.homedir(), ".ssh");
    const secrets = {
      passwords: {},
      passphrases: {},
      secretMacros: [],
      fileBackups: [
        {
          id: "ssh",
          label: "SSH user folder",
          directories: [],
          files: [
            { relativePath: "config", contentsBase64: Buffer.from("existing should win").toString("base64") },
            { relativePath: "known_hosts", contentsBase64: Buffer.from("missing restored").toString("base64") }
          ]
        }
      ]
    };
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      encryptedSecrets: encrypt(JSON.stringify(secrets), "testpass")
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Merge", value: "merge" });
    mockShowInputBox.mockResolvedValueOnce("testpass");
    mockStat.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === path.join(sshDir, "config")) return { type: 1 };
      throw new Error(`ENOENT: ${uri.fsPath}`);
    });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const restoredPaths = mockWriteFile.mock.calls.map((call) => (call[0] as { fsPath: string }).fsPath);
    expect(restoredPaths).toEqual([path.join(sshDir, "known_hosts")]);
    expect(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8")).toBe("missing restored");
    expect(mockChmod).toHaveBeenCalledWith(sshDir, 0o700);
    expect(mockChmod).toHaveBeenCalledWith(path.join(sshDir, "known_hosts"), 0o600);
  });

  it("replace import overwrites backed-up folder files without deleting extra files", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");
    const sshDir = path.join(os.homedir(), ".ssh");
    const secrets = {
      passwords: {},
      passphrases: {},
      secretMacros: [],
      fileBackups: [
        {
          id: "ssh",
          label: "SSH user folder",
          directories: [],
          files: [
            { relativePath: "config", contentsBase64: Buffer.from("restored").toString("base64") }
          ]
        }
      ]
    };
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      encryptedSecrets: encrypt(JSON.stringify(secrets), "testpass")
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("testpass");
    mockStat.mockResolvedValue({ type: 1 });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect((mockWriteFile.mock.calls[0][0] as { fsPath: string }).fsPath).toBe(path.join(sshDir, "config"));
    expect(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8")).toBe("restored");
  });

  it("uses encrypted scripts path metadata instead of mutable imported settings when restoring scripts", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");
    const fakeContext = {
      globalStorageUri: { fsPath: "/global-storage", scheme: "file", path: "/global-storage" }
    } as unknown as import("vscode").ExtensionContext;
    const secrets = {
      passwords: {},
      passphrases: {},
      secretMacros: [],
      fileBackups: [
        {
          id: "scripts",
          label: "Nexus scripts folder",
          configuredPath: ".nexus/scripts",
          directories: [],
          files: [
            { relativePath: "hello.js", contentsBase64: Buffer.from("/** @nexus-script */\n").toString("base64") }
          ]
        }
      ]
    };
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      settings: {
        "nexus.scripts.path": "/tmp/redirected-scripts"
      },
      encryptedSecrets: encrypt(JSON.stringify(secrets), "testpass")
    };

    registeredCommands.clear();
    registerConfigCommands(core, vault, fakeContext);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("testpass");
    mockStat.mockResolvedValue(undefined);

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(configStore.get("nexus.scripts.path")).toBe("/tmp/redirected-scripts");
    expect((mockWriteFile.mock.calls[0][0] as { fsPath: string }).fsPath).toBe("/workspace/.nexus/scripts/hello.js");
  });
});

describe("share import", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  it("always merges with fresh IDs", async () => {
    // Pre-existing data
    await core.addOrUpdateServer(makeServer({ id: "existing", name: "Existing" }));

    const exportData = makeExportData({
      exportType: "share",
      servers: [makeServer({ id: "share-s1", username: "user" })],
      tunnels: [makeTunnel({ id: "share-t1" })],
      serialProfiles: [makeSerialProfile({ id: "share-sp1" })]
    });

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = core.getSnapshot();
    // Existing server preserved + new one imported
    expect(snapshot.servers).toHaveLength(2);
    // IDs should be fresh (not the share IDs)
    expect(snapshot.servers.find(s => s.id === "share-s1")).toBeUndefined();
    expect(snapshot.servers.find(s => s.id === "existing")).toBeDefined();
  });

  it("remaps tunnel defaultServerId on share import", async () => {
    const exportData = makeExportData({
      exportType: "share",
      servers: [makeServer({ id: "src-s1" })],
      tunnels: [makeTunnel({ id: "src-t1", defaultServerId: "src-s1" })],
      serialProfiles: []
    });

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = core.getSnapshot();
    const importedTunnel = snapshot.tunnels[0];
    const importedServer = snapshot.servers[0];
    // The tunnel's defaultServerId should point to the newly generated server ID
    expect(importedTunnel.defaultServerId).toBe(importedServer.id);
  });

  it("v1 share import reads legacy macros from settings key", async () => {
    const v1ShareData = {
      version: 1,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [makeServer()],
      tunnels: [],
      serialProfiles: [],
      settings: {
        "nexus.terminal.macros": [{ name: "hello", text: "hi" }]
      }
    };

    const shareImportStore = new InMemoryMacroStore();
    await shareImportStore.initialize();
    setActiveMacroStore(shareImportStore);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/v1share.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(v1ShareData), "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const macros = shareImportStore.getAll();
    expect(macros.map(m => m.name)).toContain("hello");
    expect(macros.find(m => m.name === "hello")?.text).toBe("hi");
  });
});

describe("import from MobaXterm command", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  it("imports SSH sessions and creates groups", async () => {
    const ini = `[Bookmarks_1]
SubRep=Production
ImgNum=42
WebServer=#109#0%web.example.com%22%deploy%%-1%
DBServer=#109#0%db.example.com%5432%admin%%-1%
`;
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/mobafile.ini", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(ini, "utf8"));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const cmd = registeredCommands.get("nexus.config.import.mobaxterm")!;
    await cmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(2);
    expect(snapshot.servers[0].host).toBe("web.example.com");
    expect(snapshot.servers[0].port).toBe(22);
    expect(snapshot.servers[0].username).toBe("deploy");
    expect(snapshot.servers[0].authType).toBe("password");
    expect(snapshot.servers[0].group).toBe("Production");
    expect(snapshot.servers[1].host).toBe("db.example.com");
    expect(snapshot.servers[1].port).toBe(5432);
    // Each server gets a fresh UUID
    expect(snapshot.servers[0].id).not.toBe(snapshot.servers[1].id);
    expect(snapshot.explicitGroups).toContain("Production");
  });

  it("shows warning when no SSH sessions found", async () => {
    const ini = `[Bookmarks]
SubRep=
ImgNum=42
RDP=#91#3%rdp.example.com%3389%user%%-1%
`;
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/mobafile.ini", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(ini, "utf8"));

    const cmd = registeredCommands.get("nexus.config.import.mobaxterm")!;
    await cmd();

    expect(mockShowWarningMessage).toHaveBeenCalledWith("No SSH sessions found (1 non-SSH skipped).");
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("does nothing when user cancels file picker", async () => {
    mockShowOpenDialog.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.mobaxterm")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("does nothing when user cancels confirmation", async () => {
    const ini = `[Bookmarks]
SubRep=
ImgNum=42
Server=#109#0%host.test%22%user%%-1%
`;
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/mobafile.ini", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(ini, "utf8"));
    mockShowInformationMessage.mockResolvedValueOnce(undefined); // cancelled

    const cmd = registeredCommands.get("nexus.config.import.mobaxterm")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(0);
  });
});

describe("import from SecureCRT command", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT Sessions Folder", value: "folder" });
  });

  it("is registered as a command", () => {
    expect(registeredCommands.has("nexus.config.import.securecrt")).toBe(true);
  });

  it("imports SSH sessions recursively, supports mixed-case .ini extension, and creates groups", async () => {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/Sessions", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 2 });
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    mockReadDirectory.mockImplementation(async (uri: { fsPath: string }) => {
      switch (uri.fsPath) {
        case "/fake/Sessions":
          return [
            ["Prod", 2], // Directory
            ["RootSession.INI", 1], // File
            ["Telnet.ini", 1], // File (non-SSH)
            ["notes.txt", 1] // File (ignored by extension)
          ];
        case "/fake/Sessions/Prod":
          return [
            ["App.ini", 1], // File
            ["Nested", 2] // Directory
          ];
        case "/fake/Sessions/Prod/Nested":
          return [
            ["Db.iNi", 1] // File
          ];
        default:
          return [];
      }
    });

    mockReadFile.mockImplementation(async (uri: { fsPath: string }) => {
      const byPath: Record<string, string> = {
        "/fake/Sessions/RootSession.INI": `S:"Protocol Name"=SSH2\nS:"Hostname"=root.example.com\nD:"[SSH2] Port"=00000016`,
        "/fake/Sessions/Telnet.ini": `S:"Protocol Name"=Telnet\nS:"Hostname"=telnet.example.com`,
        "/fake/Sessions/Prod/App.ini": `S:"Protocol Name"=SSH2\nS:"Hostname"=app.example.com\nD:"[SSH2] Port"=000008AE\nS:"Username"=deploy`,
        "/fake/Sessions/Prod/Nested/Db.iNi": `S:"Protocol Name"=SSH2\nS:"Hostname"=db.example.com\nD:"[SSH2] Port"=00011170\nS:"Username"=`
      };
      return Buffer.from(byPath[uri.fsPath] ?? "", "utf8");
    });

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(3);

    const root = snapshot.servers.find((s) => s.name === "RootSession");
    expect(root).toBeDefined();
    expect(root?.username).toBe("user");
    expect(root?.port).toBe(22);
    expect(root?.group).toBeUndefined();

    const app = snapshot.servers.find((s) => s.name === "App");
    expect(app).toBeDefined();
    expect(app?.username).toBe("deploy");
    expect(app?.port).toBe(2222);
    expect(app?.group).toBe("Prod");

    const db = snapshot.servers.find((s) => s.name === "Db");
    expect(db).toBeDefined();
    expect(db?.username).toBe("user");
    expect(db?.port).toBe(22); // out-of-range value normalized
    expect(db?.group).toBe("Prod/Nested");

    expect(snapshot.explicitGroups).toContain("Prod");
    expect(snapshot.explicitGroups).toContain("Prod/Nested");
  });

  it("shows warning when folder has no SSH sessions", async () => {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/Sessions", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 2 });
    mockReadDirectory.mockResolvedValue([["Telnet.ini", 1]]);
    mockReadFile.mockResolvedValue(Buffer.from(`S:"Protocol Name"=Telnet\nS:"Hostname"=legacy.example.com`, "utf8"));

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(mockShowWarningMessage).toHaveBeenCalledWith("No SSH sessions found (1 non-SSH skipped).");
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("does nothing when user cancels confirmation", async () => {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/Sessions", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 2 });
    mockReadDirectory.mockResolvedValue([["Srv.ini", 1]]);
    mockReadFile.mockResolvedValue(Buffer.from(`S:"Protocol Name"=SSH2\nS:"Hostname"=srv.example.com`, "utf8"));
    mockShowInformationMessage.mockResolvedValueOnce(undefined);

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("does nothing when user cancels folder picker", async () => {
    mockShowOpenDialog.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("imports SSH sessions from SecureCRT XML file and truncates deep folders", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="SSH">
      <key name="Production">
        <key name="App">
          <dword name="Is Session">1</dword>
          <string name="Protocol Name">SSH2</string>
          <string name="Hostname">app.example.com</string>
          <dword name="[SSH2] Port">2222</dword>
          <string name="Username">deploy</string>
        </key>
      </key>
      <key name="A">
        <key name="B">
          <key name="C">
            <key name="D">
              <dword name="Is Session">1</dword>
              <string name="Protocol Name">SSH2</string>
              <string name="Hostname">deep.example.com</string>
              <dword name="[SSH2] Port">22</dword>
            </key>
          </key>
        </key>
      </key>
    </key>
    <key name="RDP">
      <key name="Desk">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">RDP</string>
        <string name="Hostname">rdp.example.com</string>
      </key>
    </key>
  </key>
</VanDyke>`;

    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/SecureCRTSessions.xml", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from(xml, "utf8"));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(2);

    const app = snapshot.servers.find((s) => s.name === "App");
    expect(app?.host).toBe("app.example.com");
    expect(app?.port).toBe(2222);
    expect(app?.username).toBe("deploy");
    expect(app?.group).toBe("SSH/Production");

    const deep = snapshot.servers.find((s) => s.name === "D");
    expect(deep?.host).toBe("deep.example.com");
    expect(deep?.group).toBe("SSH/A/B");

    expect(snapshot.explicitGroups).toContain("SSH/Production");
    expect(snapshot.explicitGroups).toContain("SSH/A/B");
  });

  it("shows parsing error for malformed XML files", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/SecureCRTSessions.xml", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from("<VanDyke><key name=\"Sessions\">", "utf8"));

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Failed to parse SecureCRT XML"));
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("shows warning when XML file has no SSH sessions", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="RDP">
      <key name="Desk">
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">RDP</string>
        <string name="Hostname">rdp.example.com</string>
      </key>
    </key>
  </key>
</VanDyke>`;
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/SecureCRTSessions.xml", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from(xml, "utf8"));

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(mockShowWarningMessage).toHaveBeenCalledWith("No SSH sessions found (1 non-SSH skipped).");
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("shows error for unsupported file extension", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/not-securecrt.txt", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "Unsupported SecureCRT input. Select a SecureCRT XML export file or Sessions folder."
    );
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("does nothing when user cancels source picker", async () => {
    mockShowQuickPick.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });
});

describe("sanitizeForSharing", () => {
  it("generates fresh IDs and sanitizes user fields", () => {
    const servers = [makeServer({ username: "alice", keyPath: "/home/alice/.ssh/id_rsa" })];
    const tunnels = [makeTunnel({ defaultServerId: "s1" })];
    const serialProfiles = [makeSerialProfile({ deviceHint: { serialNumber: "ABC123", vendorId: "1111", productId: "2222" } })];
    const settings: Record<string, unknown> = {
      "nexus.logging.sessionLogDirectory": "/home/alice/logs"
    };
    const macrosArg = [
      { id: "m1", name: "public", text: "echo hi" },
      { id: "m2", name: "secret", text: "password123", secret: true }
    ];

    const result = sanitizeForSharing(servers, tunnels, serialProfiles, settings, [], macrosArg);

    expect(result.servers[0].id).not.toBe("s1");
    expect(result.servers[0].username).toBe("user");
    expect(result.servers[0].keyPath).toBe("");

    expect(result.tunnels[0].id).not.toBe("t1");
    expect(result.tunnels[0].defaultServerId).toBe(result.servers[0].id);

    expect(result.serialProfiles[0].id).not.toBe("sp1");
    expect(result.serialProfiles[0].deviceHint).toBeUndefined();

    // Secret macros excluded from share; non-secret macros are in result.macros
    expect(result.macros).toHaveLength(1);
    expect(result.macros[0].name).toBe("public");
    // The old settings key no longer carries macros
    expect(result.settings["nexus.terminal.macros"]).toBeUndefined();

    expect(result.settings["nexus.logging.sessionLogDirectory"]).toBe("");
  });

  it("clears defaultServerId when server not in export", () => {
    const servers: ServerConfig[] = [];
    const tunnels = [makeTunnel({ defaultServerId: "missing" })];
    const result = sanitizeForSharing(servers, tunnels, [], {});
    expect(result.tunnels[0].defaultServerId).toBeUndefined();
  });

  it("remaps jump host IDs in proxy config", () => {
    const jumpServer = makeServer({ id: "jump-1", name: "Jump" });
    const targetServer = makeServer({
      id: "target-1",
      name: "Target",
      proxy: { type: "ssh", jumpHostId: "jump-1" }
    });
    const result = sanitizeForSharing([jumpServer, targetServer], [], [], {});

    const newJump = result.servers.find((s) => s.name === "Jump")!;
    const newTarget = result.servers.find((s) => s.name === "Target")!;
    expect(newTarget.proxy).toBeDefined();
    expect(newTarget.proxy!.type).toBe("ssh");
    if (newTarget.proxy!.type === "ssh") {
      expect(newTarget.proxy!.jumpHostId).toBe(newJump.id);
    }
  });

  it("strips proxy username from SOCKS5 and HTTP configs", () => {
    const server = makeServer({
      proxy: { type: "socks5", host: "proxy.local", port: 1080, username: "user1" }
    });
    const result = sanitizeForSharing([server], [], [], {});
    const sanitized = result.servers[0];
    expect(sanitized.proxy).toBeDefined();
    if (sanitized.proxy?.type === "socks5") {
      expect(sanitized.proxy.username).toBeUndefined();
    }
  });

  it("clears proxy when jump host is not in export", () => {
    const server = makeServer({
      proxy: { type: "ssh", jumpHostId: "nonexistent" }
    });
    const result = sanitizeForSharing([server], [], [], {});
    expect(result.servers[0].proxy).toBeUndefined();
  });

  it("returns empty authProfiles when none referenced", () => {
    const result = sanitizeForSharing([makeServer()], [], [], {});
    expect(result.authProfiles).toHaveLength(0);
  });

  it("preserves authProfileId link with sanitized auth profile copy", () => {
    const profile = makeAuthProfile({ id: "ap-123", name: "Prod Auth", username: "deploy", keyPath: "/key" });
    const server = makeServer({ authProfileId: "ap-123" });
    const result = sanitizeForSharing([server], [], [], {}, [profile]);

    // Server should have remapped authProfileId
    expect(result.servers[0].authProfileId).toBeDefined();
    expect(result.servers[0].authProfileId).not.toBe("ap-123"); // new ID

    // Auth profile should be included, sanitized
    expect(result.authProfiles).toHaveLength(1);
    expect(result.authProfiles[0].name).toBe("Prod Auth");
    expect(result.authProfiles[0].username).toBe("user");
    expect(result.authProfiles[0].keyPath).toBeUndefined();
    expect(result.authProfiles[0].id).toBe(result.servers[0].authProfileId);
  });

  it("omits unreferenced auth profiles from share export", () => {
    const profile = makeAuthProfile({ id: "ap-unused" });
    const server = makeServer(); // no authProfileId
    const result = sanitizeForSharing([server], [], [], {}, [profile]);
    expect(result.authProfiles).toHaveLength(0);
    expect(result.servers[0].authProfileId).toBeUndefined();
  });
});

describe("complete reset", () => {
  let core: NexusCore;
  let vault: MockVault;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  it("deletes all data after double confirmation", async () => {
    await core.addOrUpdateServer(makeServer());
    await core.addOrUpdateTunnel(makeTunnel());
    await core.addOrUpdateSerialProfile(makeSerialProfile());
    await core.addOrUpdateAuthProfile(makeAuthProfile());
    await core.addGroup("Production");
    await vault.store("password-s1", "pw");
    await vault.store("passphrase-s1", "pp");
    await vault.store("auth-profile-password-ap1", "auth-pw");
    await vault.store("auth-profile-passphrase-ap1", "auth-pp");
    configStore.set("nexus.terminal.macros", [{ name: "M", text: "echo" }]);

    mockShowWarningMessage.mockResolvedValue("Delete Everything");
    mockShowInputBox.mockResolvedValue("DELETE");

    const resetCmd = registeredCommands.get("nexus.config.completeReset")!;
    await resetCmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(0);
    expect(snapshot.tunnels).toHaveLength(0);
    expect(snapshot.serialProfiles).toHaveLength(0);
    expect(snapshot.explicitGroups).toHaveLength(0);
    expect(await vault.get("password-s1")).toBeUndefined();
    expect(await vault.get("passphrase-s1")).toBeUndefined();
    expect(await vault.get("auth-profile-password-ap1")).toBeUndefined();
    expect(await vault.get("auth-profile-passphrase-ap1")).toBeUndefined();
    expect(mockShowInformationMessage).toHaveBeenCalledWith("All Nexus data has been deleted.");
  });

  it("aborts when user cancels warning", async () => {
    await core.addOrUpdateServer(makeServer());
    mockShowWarningMessage.mockResolvedValue(undefined);

    const resetCmd = registeredCommands.get("nexus.config.completeReset")!;
    await resetCmd();

    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("aborts when user does not type DELETE", async () => {
    await core.addOrUpdateServer(makeServer());
    mockShowWarningMessage.mockResolvedValue("Delete Everything");
    mockShowInputBox.mockResolvedValue("nope");

    const resetCmd = registeredCommands.get("nexus.config.completeReset")!;
    await resetCmd();

    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("clears macro store and vault entries on reset", async () => {
    // Use a VscodeMacroStore so we can verify vault cleanup
    const stateMap = new Map<string, unknown>();
    const secretMap = new Map<string, string>();
    const fakeCtx = {
      globalState: {
        get<T>(k: string, fb: T): T { return (stateMap.get(k) as T) ?? fb; },
        async update(k: string, v: unknown): Promise<void> {
          if (v === undefined) stateMap.delete(k); else stateMap.set(k, v);
        },
        keys(): readonly string[] { return [...stateMap.keys()]; }
      },
      secrets: {
        async get(k: string): Promise<string | undefined> { return secretMap.get(k); },
        async store(k: string, v: string): Promise<void> { secretMap.set(k, v); },
        async delete(k: string): Promise<void> { secretMap.delete(k); }
      }
    } as unknown as import("vscode").ExtensionContext;

    const macroStore = new VscodeMacroStore(fakeCtx, { runLegacyMigration: false });
    await macroStore.initialize();
    await macroStore.save([{ id: "sec-id", name: "MySecret", text: "s3cr3t", secret: true }]);

    // Confirm setup: macro is present and vault entry exists
    expect(getMacros()).toHaveLength(0); // active store is still InMemoryMacroStore from beforeEach

    // Switch the active store to our VscodeMacroStore
    setActiveMacroStore(macroStore);
    expect(getMacros().map(m => m.name)).toEqual(["MySecret"]);
    expect(secretMap.has(macroSecretKey("sec-id"))).toBe(true);

    // Wire up reset command with the context so migrationNoticeShown gets reset too
    vi.clearAllMocks();
    registeredCommands.clear();
    const resetRepo = new InMemoryConfigRepository();
    const resetCore = new NexusCore(resetRepo);
    await resetCore.initialize();
    registerConfigCommands(resetCore, new MockVault(), fakeCtx);

    mockShowWarningMessage.mockResolvedValue("Delete Everything");
    mockShowInputBox.mockResolvedValue("DELETE");

    const resetCmd = registeredCommands.get("nexus.config.completeReset")!;
    await resetCmd();

    expect(getMacros()).toEqual([]);
    expect(secretMap.has(macroSecretKey("sec-id"))).toBe(false);
  });
});

describe("share export round-trip", () => {
  it("share export then import works with ID remapping", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    await sourceCore.addOrUpdateServer(makeServer());
    await sourceCore.addOrUpdateTunnel(makeTunnel({ defaultServerId: "s1", browserUrl: "https://myapp.local:{localPort}/admin", notes: "test note" }));
    await sourceCore.addOrUpdateSerialProfile(makeSerialProfile());
    await sourceCore.addGroup("Production");

    registerConfigCommands(sourceCore, vault);

    // Export (share)
    let exportedJson = "";
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/export.json", scheme: "file" });
    mockWriteFile.mockImplementation((_uri: unknown, data: Buffer) => {
      exportedJson = Buffer.from(data).toString("utf8");
    });

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();
    expect(exportedJson).not.toBe("");

    // Import into fresh core
    registeredCommands.clear();
    const destRepo = new InMemoryConfigRepository();
    const destCore = new NexusCore(destRepo);
    await destCore.initialize();
    registerConfigCommands(destCore, vault);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(exportedJson, "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = destCore.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.tunnels).toHaveLength(1);
    expect(snapshot.serialProfiles).toHaveLength(1);
    expect(snapshot.explicitGroups).toContain("Production");

    // Tunnel defaultServerId should point to the imported server
    expect(snapshot.tunnels[0].defaultServerId).toBe(snapshot.servers[0].id);
    // Optional fields should survive the round-trip
    expect(snapshot.tunnels[0].browserUrl).toBe("https://myapp.local:{localPort}/admin");
    expect(snapshot.tunnels[0].notes).toBe("test note");
  });

  it("share export then import preserves linked auth profile references", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    await sourceCore.addOrUpdateAuthProfile(makeAuthProfile({ id: "ap1", name: "Production Auth" }));
    await sourceCore.addOrUpdateServer(makeServer({ id: "s1", authProfileId: "ap1" }));

    registerConfigCommands(sourceCore, vault);

    let exportedJson = "";
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/share.json", scheme: "file" });
    mockWriteFile.mockImplementation((_uri: unknown, data: Buffer) => {
      exportedJson = Buffer.from(data).toString("utf8");
    });

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    const exported = JSON.parse(exportedJson);
    expect(exported.authProfiles).toHaveLength(1);
    expect(exported.servers[0].authProfileId).toBe(exported.authProfiles[0].id);

    registeredCommands.clear();
    const destRepo = new InMemoryConfigRepository();
    const destCore = new NexusCore(destRepo);
    await destCore.initialize();
    registerConfigCommands(destCore, vault);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(exportedJson, "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = destCore.getSnapshot();
    expect(snapshot.authProfiles).toHaveLength(1);
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].authProfileId).toBe(snapshot.authProfiles[0].id);
    expect(snapshot.servers[0].authProfileId).not.toBe("ap1");
  });
});

describe("backup export round-trip", () => {
  it("backup export then import preserves passwords and secret macros", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    await sourceCore.addOrUpdateServer(makeServer());
    await sourceCore.addOrUpdateAuthProfile(makeAuthProfile());
    await vault.store("password-s1", "mypw");
    await vault.store("passphrase-s1", "mypp");
    await vault.store("auth-profile-password-ap1", "authpw");
    await vault.store("auth-profile-passphrase-ap1", "authpp");

    // Set macros in the active MacroStore (store is set up in top-level beforeEach)
    const sourceStore = new InMemoryMacroStore();
    await sourceStore.initialize();
    await sourceStore.save([
      { name: "Public", text: "echo hi", triggerPattern: "[Pp]assword:\\s*$", triggerCooldown: 5, triggerInterval: 10, triggerInitiallyDisabled: true },
      { name: "Secret", text: "hidden", secret: true }
    ]);
    setActiveMacroStore(sourceStore);

    registerConfigCommands(sourceCore, vault);

    // Backup export
    mockShowInputBox
      .mockResolvedValueOnce("masterpass1")
      .mockResolvedValueOnce("masterpass1");

    let exportedJson = "";
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup.json", scheme: "file" });
    mockWriteFile.mockImplementation((_uri: unknown, data: Buffer) => {
      exportedJson = Buffer.from(data).toString("utf8");
    });

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();
    expect(exportedJson).not.toBe("");

    // Parse exported JSON and verify macros are in top-level macros array
    const exportedParsed = JSON.parse(exportedJson);
    expect(exportedParsed.version).toBe(2);
    expect(Array.isArray(exportedParsed.macros)).toBe(true);

    // Clear vault, config, and macro store to simulate fresh install
    vault.clear();
    configStore.clear();
    registeredCommands.clear();

    const destStore = new InMemoryMacroStore();
    await destStore.initialize();
    setActiveMacroStore(destStore);

    const destRepo = new InMemoryConfigRepository();
    const destCore = new NexusCore(destRepo);
    await destCore.initialize();
    registerConfigCommands(destCore, vault);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(exportedJson, "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = destCore.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.authProfiles).toHaveLength(1);
    expect(await vault.get("password-s1")).toBe("mypw");
    expect(await vault.get("passphrase-s1")).toBe("mypp");
    expect(await vault.get("auth-profile-password-ap1")).toBe("authpw");
    expect(await vault.get("auth-profile-passphrase-ap1")).toBe("authpp");

    // Secret macros restored via MacroStore
    const macros = destStore.getAll();
    expect(macros.find(m => m.name === "Secret")?.text).toBe("hidden");
    expect(macros.find(m => m.name === "Public")?.text).toBe("echo hi");
    expect(macros.find(m => m.name === "Public")?.triggerPattern).toBe("[Pp]assword:\\s*$");
    expect(macros.find(m => m.name === "Public")?.triggerCooldown).toBe(5);
    expect(macros.find(m => m.name === "Public")?.triggerInterval).toBe(10);
    expect(macros.find(m => m.name === "Public")?.triggerInitiallyDisabled).toBe(true);
  });

  it("backup export then import preserves authProfileId on servers", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    await sourceCore.addOrUpdateAuthProfile(makeAuthProfile({ id: "ap1" }));
    await sourceCore.addOrUpdateServer(makeServer({ id: "s1", authProfileId: "ap1" }));

    registerConfigCommands(sourceCore, vault);

    mockShowInputBox
      .mockResolvedValueOnce("masterpass1")
      .mockResolvedValueOnce("masterpass1");

    let exportedJson = "";
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup.json", scheme: "file" });
    mockWriteFile.mockImplementation((_uri: unknown, data: Buffer) => {
      exportedJson = Buffer.from(data).toString("utf8");
    });

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();

    // Verify authProfileId is in the exported JSON
    const parsed = JSON.parse(exportedJson);
    expect(parsed.servers[0].authProfileId).toBe("ap1");

    vault.clear();
    configStore.clear();
    registeredCommands.clear();

    const destRepo = new InMemoryConfigRepository();
    const destCore = new NexusCore(destRepo);
    await destCore.initialize();
    registerConfigCommands(destCore, vault);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(exportedJson, "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("masterpass1");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = destCore.getSnapshot();
    expect(snapshot.servers[0].authProfileId).toBe("ap1");
    expect(snapshot.authProfiles).toHaveLength(1);
  });

  it("import clears dangling authProfileId when profile not imported", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // Import data with a server referencing a profile that doesn't exist
    const importData = {
      version: 1,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [makeServer({ id: "s1", authProfileId: "nonexistent-profile" })],
      tunnels: [],
      serialProfiles: [],
      authProfiles: []
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/import.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].authProfileId).toBeUndefined();
  });
});
