import { describe, expect, it, vi, beforeEach } from "vitest";

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
      readFile: (...args: unknown[]) => mockReadFile(...args)
    },
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
    file: (path: string) => ({ fsPath: path, scheme: "file" })
  },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 }
}));

import { registerConfigCommands, isValidExport, SETTINGS_KEYS, sanitizeForSharing } from "../../src/commands/configCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { SecretVault } from "../../src/services/ssh/contracts";
import type { ServerConfig, TunnelProfile, SerialProfile } from "../../src/models/config";

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
    expect(isValidExport(makeExportData({ version: 2 }))).toBe(false);
  });

  it("rejects missing servers array", () => {
    expect(isValidExport(makeExportData({ servers: "not-array" }))).toBe(false);
  });

  it("rejects missing tunnels array", () => {
    expect(isValidExport(makeExportData({ tunnels: null }))).toBe(false);
  });

  it("rejects missing serialProfiles array", () => {
    expect(isValidExport(makeExportData({ serialProfiles: undefined }))).toBe(false);
  });
});

describe("SETTINGS_KEYS", () => {
  it("includes all terminal settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.terminal.openLocation");
    expect(keys).toContain("nexus.terminal.keyboardPassthrough");
    expect(keys).toContain("nexus.terminal.passthroughKeys");
    expect(keys).toContain("nexus.terminal.macros");
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
  });

  it("includes SFTP settings", () => {
    const keys = SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`);
    expect(keys).toContain("nexus.sftp.cacheTtlSeconds");
    expect(keys).toContain("nexus.sftp.maxCacheEntries");
    expect(keys).toContain("nexus.sftp.autoRefreshInterval");
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
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 1 profiles (1 skipped).");
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
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 1 profiles (2 skipped).");
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
      servers: [],
      tunnels: [],
      serialProfiles: [],
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

    configStore.set("nexus.terminal.macros", [
      { name: "Hello", text: "echo hi", secret: false },
      { name: "Secret", text: "super-secret", secret: true }
    ]);
    configStore.set("nexus.logging.sessionLogDirectory", "/home/alice/logs");

    const savedUri = { fsPath: "/fake/export.json", scheme: "file" };
    mockShowSaveDialog.mockResolvedValue(savedUri);
    mockWriteFile.mockResolvedValue(undefined);

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));

    expect(writtenData.exportType).toBe("share");
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

    // Secret macros stripped
    const macros = writtenData.settings["nexus.terminal.macros"];
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe("Hello");

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

  it("exports with encrypted secrets and strips secret macro text from settings", async () => {
    await core.addOrUpdateServer(makeServer());
    await vault.store("password-s1", "mypassword");
    await vault.store("passphrase-s1", "mypassphrase");

    configStore.set("nexus.terminal.macros", [
      { name: "Hello", text: "echo hi", secret: false },
      { name: "Secret", text: "super-secret", secret: true }
    ]);

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
    expect(writtenData.encryptedSecrets).toBeDefined();
    expect(writtenData.encryptedSecrets.cipher).toBe("aes-256-gcm");

    // Secret macro text should be stripped in the settings block
    const macros = writtenData.settings["nexus.terminal.macros"];
    const secretMacro = macros.find((m: { name: string }) => m.name === "Secret");
    expect(secretMacro.text).toBe("");

    // Non-secret macros keep their text
    const normalMacro = macros.find((m: { name: string }) => m.name === "Hello");
    expect(normalMacro.text).toBe("echo hi");

    // Original IDs preserved in backup
    expect(writtenData.servers[0].id).toBe("s1");
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
    const secrets = {
      passwords: { s1: "restored-pw" },
      passphrases: { s1: "restored-pp" },
      secretMacros: [{ name: "Secret", text: "super-secret", secret: true }]
    };
    const encrypted = encrypt(JSON.stringify(secrets), "testpass");

    const exportData = makeExportData({
      exportType: "backup",
      encryptedSecrets: encrypted,
      settings: {
        "nexus.terminal.macros": [
          { name: "Hello", text: "echo hi", secret: false },
          { name: "Secret", text: "", secret: true }
        ]
      }
    });

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("testpass"); // decrypt password

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    // Passwords restored to vault
    expect(await vault.get("password-s1")).toBe("restored-pw");
    expect(await vault.get("passphrase-s1")).toBe("restored-pp");

    // Secret macros merged back
    const macros = configStore.get("nexus.terminal.macros") as Array<{ name: string; text: string; secret?: boolean }>;
    expect(macros).toBeDefined();
    const secretMacro = macros.find(m => m.name === "Secret");
    expect(secretMacro?.text).toBe("super-secret");
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
});

describe("sanitizeForSharing", () => {
  it("generates fresh IDs and sanitizes user fields", () => {
    const servers = [makeServer({ username: "alice", keyPath: "/home/alice/.ssh/id_rsa" })];
    const tunnels = [makeTunnel({ defaultServerId: "s1" })];
    const serialProfiles = [makeSerialProfile()];
    const settings: Record<string, unknown> = {
      "nexus.terminal.macros": [
        { name: "public", text: "echo hi" },
        { name: "secret", text: "password123", secret: true }
      ],
      "nexus.logging.sessionLogDirectory": "/home/alice/logs"
    };

    const result = sanitizeForSharing(servers, tunnels, serialProfiles, settings);

    expect(result.servers[0].id).not.toBe("s1");
    expect(result.servers[0].username).toBe("user");
    expect(result.servers[0].keyPath).toBe("");

    expect(result.tunnels[0].id).not.toBe("t1");
    expect(result.tunnels[0].defaultServerId).toBe(result.servers[0].id);

    expect(result.serialProfiles[0].id).not.toBe("sp1");

    const macros = result.settings["nexus.terminal.macros"] as Array<{ name: string }>;
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe("public");

    expect(result.settings["nexus.logging.sessionLogDirectory"]).toBe("");
  });

  it("clears defaultServerId when server not in export", () => {
    const servers: ServerConfig[] = [];
    const tunnels = [makeTunnel({ defaultServerId: "missing" })];
    const result = sanitizeForSharing(servers, tunnels, [], {});
    expect(result.tunnels[0].defaultServerId).toBeUndefined();
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
    await core.addGroup("Production");
    await vault.store("password-s1", "pw");
    await vault.store("passphrase-s1", "pp");
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
    await sourceCore.addOrUpdateTunnel(makeTunnel({ defaultServerId: "s1" }));
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
    await vault.store("password-s1", "mypw");
    await vault.store("passphrase-s1", "mypp");

    configStore.set("nexus.terminal.macros", [
      { name: "Public", text: "echo hi" },
      { name: "Secret", text: "hidden", secret: true }
    ]);

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

    // Clear vault and config to simulate fresh install
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
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = destCore.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(await vault.get("password-s1")).toBe("mypw");
    expect(await vault.get("passphrase-s1")).toBe("mypp");

    // Secret macros restored
    const macros = configStore.get("nexus.terminal.macros") as Array<{ name: string; text: string; secret?: boolean }>;
    expect(macros).toBeDefined();
    expect(macros.find(m => m.name === "Secret")?.text).toBe("hidden");
    expect(macros.find(m => m.name === "Public")?.text).toBe("echo hi");
  });
});
