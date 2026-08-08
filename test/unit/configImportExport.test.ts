import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockChmod = vi.hoisted(() => vi.fn(async () => {}));
// Spies on the real hasSecureCrtSessionsRoot (forwarded to its actual implementation
// below) so Finding 6 — "don't re-validate+re-parse XML that already parsed a
// session" — can assert the call is skipped, not just that behavior is unchanged.
const mockHasSecureCrtSessionsRoot = vi.hoisted(() => vi.fn());

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
const mockClipboardReadText = vi.fn();
const mockOpenTextDocument = vi.fn();
const mockShowTextDocument = vi.fn();
const mockExecuteCommand = vi.fn();
const configStore = new Map<string, unknown>();
const configDefaults = new Map<string, unknown>();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
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
    showTextDocument: (...args: unknown[]) => mockShowTextDocument(...args),
    withProgress: (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<void>) => {
      mockWithProgress(_opts);
      return task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: vi.fn() });
    }
  },
  env: {
    clipboard: {
      readText: (...args: unknown[]) => mockClipboardReadText(...args)
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
    openTextDocument: (...args: unknown[]) => mockOpenTextDocument(...args),
    workspaceFolders: [
      { uri: { fsPath: "/workspace", scheme: "file", path: "/workspace" }, name: "workspace", index: 0 }
    ],
    getConfiguration: vi.fn((section: string) => ({
      get: (key: string, fallback?: unknown) => {
        const fullKey = `${section}.${key}`;
        if (configStore.has(fullKey)) return configStore.get(fullKey);
        if (configDefaults.has(fullKey)) return configDefaults.get(fullKey);
        return fallback;
      },
      inspect: (key: string) => {
        const fullKey = `${section}.${key}`;
        return {
          defaultValue: configDefaults.get(fullKey),
          globalValue: configStore.has(fullKey) ? configStore.get(fullKey) : undefined
        };
      },
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
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 }
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    chmod: mockChmod
  };
});

vi.mock("../../src/utils/securecrtParser", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/securecrtParser")>("../../src/utils/securecrtParser");
  mockHasSecureCrtSessionsRoot.mockImplementation(actual.hasSecureCrtSessionsRoot);
  return {
    ...actual,
    hasSecureCrtSessionsRoot: mockHasSecureCrtSessionsRoot
  };
});

import { registerConfigCommands, isValidExport, SETTINGS_KEYS, sanitizeForSharing } from "../../src/commands/configCommands";
import { SETTINGS_META } from "../../src/ui/settingsMetadata";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { VscodeMacroStore, macroSecretKey } from "../../src/storage/vscodeMacroStore";
import { setActiveMacroStore, getMacros } from "../../src/macroSettings";
import { INVALID_FOLDER_PATH_MESSAGE } from "../../src/utils/folderPaths";
import { getAssignedBinding } from "../../src/macroBindingHelpers";
import type { SecretVault } from "../../src/services/ssh/contracts";
import type { AuthProfile, LocalShellProfile, ServerConfig, TunnelProfile, SerialProfile } from "../../src/models/config";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { inventorySecretKey, type InventorySourceConfig } from "../../src/models/inventory";

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

function makeLocalShellProfile(overrides: Partial<LocalShellProfile> = {}): LocalShellProfile {
  return {
    id: "local1",
    name: "Local Dev",
    launchMode: "custom",
    shellPath: "/bin/bash",
    shellArgs: ["--login"],
    cwd: "/workspace",
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

function makeInventorySource(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    id: "src1",
    providerId: "netbox",
    name: "NetBox",
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: { baseUrl: "https://netbox.example.com" },
    secretFieldIds: ["apiToken"],
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
  configDefaults.clear();
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

  it("accepts localShellProfiles-only partial config", () => {
    expect(isValidExport({ version: 1, localShellProfiles: [makeLocalShellProfile()] })).toBe(true);
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

  it("accepts a valid inventorySources array and rejects a non-array inventorySources (B6 guard)", () => {
    expect(isValidExport(makeExportData({ inventorySources: [makeInventorySource()] }))).toBe(true);
    expect(isValidExport(makeExportData({ inventorySources: "not-an-array" }))).toBe(false);
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

  it("is a superset of SETTINGS_META (drift guard — adding a contributed setting must flow through automatically)", () => {
    const keys = new Set(SETTINGS_KEYS.map((k) => `${k.section}.${k.key}`));
    const missing = SETTINGS_META
      .map((m) => `${m.section}.${m.key}`)
      .filter((fullKey) => !keys.has(fullKey));
    expect(missing).toEqual([]);
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

  it("skips servers with invalid File Explorer auto-open values", async () => {
    const exportData = makeExportData({
      servers: [
        { ...makeServer(), openFileExplorerOnFirstConnect: "yes" }
      ],
      tunnels: [],
      serialProfiles: []
    });
    await runImport(exportData);

    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 0 profiles (1 skipped).");
  });

  it("rejects invalid JSON that sniffs as a host list and offers a one-click reroute", async () => {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from("not json!", "utf8"));
    mockShowErrorMessage.mockResolvedValue(undefined);

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "That file isn't a Nexus JSON export.",
      "Import as Host List"
    );
  });

  it("routes 'Import as Host List' straight into the host-list parser using the same bytes — no re-opened dialog or source pick", async () => {
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from("not json!", "utf8"));
    mockShowErrorMessage.mockResolvedValueOnce("Import as Host List");
    mockShowInputBox.mockResolvedValue(""); // folder prompt: skip
    mockShowWarningMessage.mockResolvedValue(undefined);

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    // "not json!" fails HOST_RE (contains a space and "!"), so the reused bytes
    // parse to zero valid sessions — the point being *no second dialog ran*.
    expect(mockShowOpenDialog).toHaveBeenCalledTimes(1);
    expect(mockClipboardReadText).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).toHaveBeenCalledWith("No servers found (1 skipped).");
  });

  it("rejects valid JSON that isn't shaped like a Nexus export, with no reroute button", async () => {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify({ foo: "bar" }), "utf8"));
    mockShowErrorMessage.mockResolvedValue(undefined);

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "This is valid JSON, but not a Nexus export — expected a version field and at least one profile list (servers, tunnels, …)."
    );
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

  it("imports backed-up Ctrl+Q terminal passthrough selection", async () => {
    const exportData = makeExportData({
      settings: {
        "nexus.terminal.passthroughKeys": ["b", "q", "w"]
      }
    });
    await runImport(exportData);

    expect(configStore.get("nexus.terminal.passthroughKeys")).toEqual(["b", "q", "w"]);
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith(
      "1 imported Nexus setting had an invalid value and was skipped."
    );
  });

  it("rejects and does NOT write passthroughKeys: [] from imported backup — shows warning", async () => {
    // A corrupt backup (or a user who unchecked all boxes before the UI fix) must
    // not propagate [] into the user's settings.json; validation treats [] as invalid.
    configStore.clear();
    mockShowWarningMessage.mockClear();
    const exportData = makeExportData({
      settings: {
        "nexus.terminal.passthroughKeys": []
      }
    });
    await runImport(exportData);

    expect(configStore.has("nexus.terminal.passthroughKeys")).toBe(false);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      "1 imported Nexus setting had an invalid value and was skipped."
    );
  });

  it("accepts a valid non-empty passthroughKeys subset from imported backup", async () => {
    configStore.clear();
    mockShowWarningMessage.mockClear();
    const exportData = makeExportData({
      settings: {
        "nexus.terminal.passthroughKeys": ["b", "r"]
      }
    });
    await runImport(exportData);

    expect(configStore.get("nexus.terminal.passthroughKeys")).toEqual(["b", "r"]);
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith(
      "1 imported Nexus setting had an invalid value and was skipped."
    );
  });

  it.each(["merge", "replace"] as const)(
    "migrates backed-up legacy default wait timeout to the registered seconds setting in %s mode",
    async (mode) => {
    const exportData = makeExportData({
      exportType: "backup",
      settings: {
        "nexus.scripts.defaultTimeout": 60_000
      }
    });
    await runImport(exportData, mode);

    expect(configStore.get("nexus.scripts.defaultTimeoutSeconds")).toBe(60);
    expect(configStore.has("nexus.scripts.defaultTimeout")).toBe(false);
    expect(mockConfigUpdate).not.toHaveBeenCalledWith("nexus.scripts", "defaultTimeout", expect.anything());
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith(
      "1 imported Nexus setting had an invalid value and was skipped."
    );
    }
  );

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

  it("preserves File Explorer auto-open through import", async () => {
    const exportData = makeExportData({
      servers: [makeServer({ openFileExplorerOnFirstConnect: true })],
      tunnels: [],
      serialProfiles: []
    });
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].openFileExplorerOnFirstConnect).toBe(true);
  });

  it("keeps only one imported server marked for File Explorer auto-open", async () => {
    const exportData = makeExportData({
      servers: [
        makeServer({ id: "s1", openFileExplorerOnFirstConnect: true }),
        makeServer({ id: "s2", name: "Server 2", openFileExplorerOnFirstConnect: true })
      ],
      tunnels: [],
      serialProfiles: []
    });
    await runImport(exportData);

    const snapshot = core.getSnapshot();
    expect(snapshot.servers.find((server) => server.id === "s1")?.openFileExplorerOnFirstConnect).toBeUndefined();
    expect(snapshot.servers.find((server) => server.id === "s2")?.openFileExplorerOnFirstConnect).toBe(true);
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

  it("imports partial config with only local shell profiles", async () => {
    const partialExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      localShellProfiles: [makeLocalShellProfile()]
    };
    await runImport(partialExport);

    const snapshot = core.getSnapshot();
    expect(snapshot.localShellProfiles).toHaveLength(1);
    expect(snapshot.localShellProfiles[0].id).toBe("local1");
    expect(snapshot.servers).toHaveLength(0);
    expect(snapshot.serialProfiles).toHaveLength(0);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 1 profile.");
  });

  it("(N2) strips a malformed origin (numeric externalId) from a backup-imported server instead of passing it through to core (kills passthrough)", async () => {
    const exportData = makeExportData({
      servers: [
        { ...makeServer(), origin: { sourceId: "src1", externalId: 12345, syncedAt: 1000 } }
      ],
      tunnels: [],
      serialProfiles: []
    });
    await runImport(exportData, "merge");

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].id).toBe("s1");
    expect(snapshot.servers[0].origin).toBeUndefined();
  });

  it("imports shared local shell profiles after path sanitization", async () => {
    const sanitized = sanitizeForSharing(
      [],
      [],
      [],
      [makeLocalShellProfile({ cwd: "/home/alice/project", startupCommand: "npm run dev" })],
      {}
    );
    const partialExport = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      localShellProfiles: sanitized.localShellProfiles
    };

    await runImport(partialExport);

    const snapshot = core.getSnapshot();
    expect(snapshot.localShellProfiles).toHaveLength(1);
    expect(snapshot.localShellProfiles[0].cwd).toBeUndefined();
    expect(snapshot.localShellProfiles[0].startupCommand).toBeUndefined();
  });
});

interface ChooserItem {
  label: string;
  description?: string;
  kind?: number;
  value?: string;
}

describe("import chooser (nexus.config.import)", () => {
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

  function chooserItems(): ChooserItem[] {
    return mockShowQuickPick.mock.calls[0][0] as ChooserItem[];
  }

  it("shows the documented rows, in order, under three separators, with the right descriptions", async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowQuickPick).toHaveBeenCalledWith(expect.any(Array), {
      title: "Import",
      placeHolder: "What are you importing?"
    });

    const items = chooserItems();
    expect(items.map((i) => i.label)).toEqual([
      "add servers in bulk",
      "$(clippy) Paste Host List from Clipboard",
      "$(list-flat) Host List File…",
      "$(sync) Inventory Source (NetBox)…",
      "migrate from another client",
      "$(file-code) MobaXterm INI File…",
      "$(file-code) SecureCRT XML Export…",
      "$(folder-opened) SecureCRT Sessions Folder…",
      "nexus",
      "$(json) Nexus Export File…"
    ]);

    const byLabel = (fragment: string) => items.find((i) => i.label.includes(fragment));
    expect(byLabel("Paste Host List")?.description).toBe("Hostnames or CSV rows copied from a spreadsheet");
    expect(byLabel("Host List File")?.description).toBe(".csv, .tsv, or .txt — one device per line");
    expect(byLabel("Inventory Source")?.description).toBe("Live sync — devices stay linked to the source");
    expect(byLabel("MobaXterm INI")?.description).toBe("Sessions from a MobaXterm .ini bookmarks export");
    expect(byLabel("SecureCRT XML")?.description).toBe("Created in SecureCRT via Tools → Export Settings");
    expect(byLabel("SecureCRT Sessions Folder")?.description).toBe("SecureCRT's Config/Sessions directory");
    expect(byLabel("Nexus Export File")?.description).toBe("An encrypted backup or a shared config (.json)");
  });

  it("Inventory Source (NetBox)… routes straight to nexus.inventory.addSource (no host-list dialog)", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "inventorySource" });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.inventory.addSource");
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
    expect(mockClipboardReadText).not.toHaveBeenCalled();
  });

  it("does nothing when the chooser is canceled", async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowOpenDialog).not.toHaveBeenCalled();
    expect(mockClipboardReadText).not.toHaveBeenCalled();
  });

  it("Paste Host List from Clipboard skips the internal clipboard-vs-file pick entirely", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("10.0.0.1,sw1,admin\n");
    mockShowInputBox.mockResolvedValue(""); // folder prompt: skip (no folder column)
    mockShowInformationMessage.mockResolvedValue("Import");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockClipboardReadText).toHaveBeenCalled();
    expect(mockShowQuickPick).toHaveBeenCalledTimes(1); // only the chooser itself
    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("Host List File… opens a dialog titled 'Import Host List' with a Host Lists filter, and a clean list imports normally", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "hostListFile" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/hosts.csv", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1, size: 20 });
    mockReadFile.mockResolvedValue(Buffer.from("10.0.0.1,sw1,admin\n", "utf8"));
    mockShowInputBox.mockResolvedValue(""); // folder prompt: skip (no folder column)
    mockShowInformationMessage.mockResolvedValue("Import");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "Host Lists": ["csv", "tsv", "txt"], "All Files": ["*"] },
      title: "Import Host List"
    });
    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it.each([
    ["nexus-json", '{"version":2,"servers":[]}', "This looks like a Nexus JSON export, not a host list.", "Import as Nexus Export"],
    ["xml", "<VanDyke><key name=\"Sessions\"/></VanDyke>", "This is an XML file. If it came from SecureCRT, import it as a SecureCRT export.", "Import as SecureCRT XML"],
    ["mobaxterm", "[Bookmarks]\nSubRep=\n", "This looks like a MobaXterm INI file.", "Import as MobaXterm"]
  ] as const)(
    "Host List File… contradicted by a %s signature stops with a named error, a reroute button, and a non-terminal 'Import as Host List Anyway' escape hatch (Finding 5)",
    async (_sniff, content, message, button) => {
      mockShowQuickPick.mockResolvedValueOnce({ value: "hostListFile" });
      mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/hosts.csv", scheme: "file" }]);
      mockStat.mockResolvedValue({ type: 1, size: content.length });
      mockReadFile.mockResolvedValue(Buffer.from(content, "utf8"));
      mockShowErrorMessage.mockResolvedValue(undefined);

      const importCmd = registeredCommands.get("nexus.config.import")!;
      await importCmd();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(message, button, "Import as Host List Anyway");
    }
  );

  it("Host List File… contradicted by a nexus-json signature: picking 'Import as Host List Anyway' proceeds into the inventory tail with the same bytes — no second dialog (Finding 5)", async () => {
    // A genuine host list whose first line happens to start with "{" — the sniffer
    // mis-flags the whole file as nexus-json (first non-whitespace char), even
    // though the file is really one bad row (that HOST_RE rejects) followed by a
    // perfectly good one. The escape hatch must still import the good row.
    const misflaggedHostList = "{not actually json\n10.0.0.1,sw1,admin\n";
    mockShowQuickPick.mockResolvedValueOnce({ value: "hostListFile" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/hosts.csv", scheme: "file" }]);
    mockStat.mockResolvedValueOnce({ type: 1, size: misflaggedHostList.length });
    mockReadFile.mockResolvedValueOnce(Buffer.from(misflaggedHostList, "utf8"));
    mockShowErrorMessage.mockResolvedValueOnce("Import as Host List Anyway");
    mockShowInputBox.mockResolvedValue(""); // folder prompt: skip (no folder column)
    mockShowInformationMessage.mockResolvedValue("Import");
    mockShowWarningMessage.mockResolvedValue(undefined); // non-awaited "N lines skipped" toast

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowOpenDialog).toHaveBeenCalledTimes(1);
    expect(core.getSnapshot().servers).toHaveLength(1);
    expect(core.getSnapshot().servers[0].host).toBe("10.0.0.1");
  });

  it("Host List File… reroute button reuses the same bytes — no second dialog", async () => {
    const nexusJson = '{"version":2,"servers":[{"id":"a","name":"a","host":"10.0.0.1","port":22,"username":"u","authType":"password","isHidden":false}]}';
    mockShowQuickPick.mockResolvedValueOnce({ value: "hostListFile" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/hosts.csv", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1, size: nexusJson.length });
    mockReadFile.mockResolvedValue(Buffer.from(nexusJson, "utf8"));
    mockShowErrorMessage.mockResolvedValueOnce("Import as Nexus Export");
    mockShowQuickPick.mockResolvedValueOnce({ label: "Merge", value: "merge" }); // Import Mode pick

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowOpenDialog).toHaveBeenCalledTimes(1);
    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("MobaXterm INI File… opens the dialog with an All Files fallback filter", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "mobaxterm" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/moba.ini", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from("[Bookmarks]\nSubRep=\nServer=#109#0%host.test%22%user%%-1%\n", "utf8"));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "MobaXterm INI Files": ["ini"], "All Files": ["*"] },
      title: "Import from MobaXterm"
    });
    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it.each([
    ["nexus-json", '{"version":2}', "Import as Nexus Export"],
    ["xml", "<foo/>", "Import as SecureCRT XML"]
  ] as const)(
    "MobaXterm INI File… with no [Bookmarks] section and a %s signature offers a reroute",
    async (_sniff, content, button) => {
      mockShowQuickPick.mockResolvedValueOnce({ value: "mobaxterm" });
      mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/moba.ini", scheme: "file" }]);
      mockReadFile.mockResolvedValue(Buffer.from(content, "utf8"));
      mockShowErrorMessage.mockResolvedValue(undefined);

      const importCmd = registeredCommands.get("nexus.config.import")!;
      await importCmd();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        "This doesn't look like a MobaXterm sessions file — no [Bookmarks] section found.",
        button
      );
    }
  );

  it("MobaXterm INI File… with no [Bookmarks] section and no other signature gets the plain error, no button", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "mobaxterm" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/moba.ini", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from("just a hostname\n", "utf8"));
    mockShowErrorMessage.mockResolvedValue(undefined);

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "This doesn't look like a MobaXterm sessions file — no [Bookmarks] section found."
    );
    expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
    expect(mockShowErrorMessage.mock.calls[0]).toHaveLength(1); // no button argument
  });

  it("SecureCRT XML Export… opens the file dialog directly, without the .securecrt deep link's own source pick", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "securecrtXml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/SecureCRTSessions.xml", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from(
      `<VanDyke><key name="Sessions"><key name="Srv"><dword name="Is Session">1</dword><string name="Protocol Name">SSH2</string><string name="Hostname">srv.example.com</string></key></key></VanDyke>`,
      "utf8"
    ));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowQuickPick).toHaveBeenCalledTimes(1); // only the chooser — no "SecureCRT Import Source" prompt
    expect(mockShowOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ canSelectFiles: true, canSelectFolders: false, title: "Select SecureCRT XML Export File" })
    );
    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("SecureCRT XML Export… names a document that isn't a SecureCRT export at all, distinct from a valid-but-empty one", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "securecrtXml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/other.xml", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from(`<VanDyke><key name="Security"/></VanDyke>`, "utf8"));
    mockShowErrorMessage.mockResolvedValue(undefined);

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "This XML isn't a SecureCRT export — expected a <VanDyke> document with a Sessions section. In SecureCRT, use Tools → Export Settings."
    );
  });

  it("SecureCRT Sessions Folder… opens the folder dialog directly, without the .securecrt deep link's own source pick", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "securecrtFolder" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/Sessions", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 2 });
    mockReadDirectory.mockResolvedValue([["Srv.ini", 1]]);
    mockReadFile.mockResolvedValue(Buffer.from(`S:"Protocol Name"=SSH2\nS:"Hostname"=srv.example.com`, "utf8"));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowQuickPick).toHaveBeenCalledTimes(1); // only the chooser
    expect(mockShowOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ canSelectFiles: false, canSelectFolders: true, title: "Select SecureCRT Sessions Folder" })
    );
    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("SecureCRT Sessions Folder… with zero .ini files names the expected Windows path instead of a generic 'no sessions' warning", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "securecrtFolder" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/NotSessions", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 2 });
    mockReadDirectory.mockResolvedValue([["readme.txt", 1]]);
    mockShowErrorMessage.mockResolvedValue(undefined);

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "No .ini session files found under this folder. Select SecureCRT's Sessions directory (on Windows usually %APPDATA%\\VanDyke\\Config\\Sessions)."
    );
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it("Nexus Export File… opens the same JSON dialog the legacy direct command used", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(makeExportData()), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ label: "Merge", value: "merge" });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "JSON Files": ["json"] },
      title: "Import Nexus Configuration"
    });
    expect(core.getSnapshot().servers).toHaveLength(1);
  });
});

describe("guard equivalence with main across reroutes (Finding 1)", () => {
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

  it("Nexus Export File…'s 'Import as Host List' reroute is capped at 2 MB — a renamed oversized CSV never reaches the inventory parser", async () => {
    const oversizedCsv = "10.0.0.1,sw1,admin\n".repeat(150_000); // ~2.85 MB, sniffs as host-list
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/hosts.json", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(oversizedCsv, "utf8"));
    mockShowErrorMessage.mockResolvedValueOnce("Import as Host List");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("The list exceeds the 2 MB size limit.");
    expect(mockShowInputBox).not.toHaveBeenCalled();
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("MobaXterm INI File…'s 'Import as SecureCRT XML' reroute is capped at 10 MB — an oversized renamed XML never reaches the XML parser", async () => {
    const oversizedXml = `<VanDyke>${"a".repeat(11 * 1024 * 1024)}`;
    mockShowQuickPick.mockResolvedValueOnce({ value: "mobaxterm" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/export.xml", scheme: "file" }]);
    mockReadFile.mockResolvedValueOnce(Buffer.from(oversizedXml, "utf8"));
    mockShowErrorMessage.mockResolvedValueOnce("Import as SecureCRT XML");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("SecureCRT XML file exceeds the 10 MB size limit.");
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("the direct Host List File… route still rejects at 2 MB (unchanged)", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "hostListFile" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/hosts.csv", scheme: "file" }]);
    mockStat.mockResolvedValueOnce({ type: 1, size: 2 * 1024 * 1024 + 1 });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("The list exceeds the 2 MB size limit.");
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("the direct SecureCRT XML Export… route still rejects at 10 MB (unchanged)", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "securecrtXml" });
    mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/export.xml", scheme: "file" }]);
    mockStat.mockResolvedValueOnce({ type: 1 });
    mockReadFile.mockResolvedValueOnce(Buffer.from("a".repeat(10 * 1024 * 1024 + 1), "utf8"));

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("SecureCRT XML file exceeds the 10 MB size limit.");
    expect(core.getSnapshot().servers).toHaveLength(0);
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

  it("Fix 1 — a masked variable's plaintext default never reaches the exported share payload", async () => {
    const shareStore = new InMemoryMacroStore();
    await shareStore.initialize();
    await shareStore.save([
      {
        name: "Login",
        text: "login $password\n",
        secret: false,
        variables: [{ name: "password", secret: true, default: "hunter2" }]
      }
    ]);
    setActiveMacroStore(shareStore);

    const savedUri = { fsPath: "/fake/export-vars.json", scheme: "file" };
    mockShowSaveDialog.mockResolvedValue(savedUri);
    mockWriteFile.mockResolvedValue(undefined);

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenText = Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8");
    expect(writtenText).not.toContain("hunter2");

    const writtenData = JSON.parse(writtenText);
    const login = writtenData.macros.find((m: { name: string }) => m.name === "Login");
    expect(login.variables).toEqual([{ name: "password", secret: true }]);
  });

  it("Fix C boundary — an array-like (non-array) variables value is dropped, not leaked, in the exported share payload", async () => {
    // Well-formed-array export tests (above) can't catch this: the redaction loop in
    // the pre-fix withRedactedVariables() only ran on real arrays, so an array-like
    // object from a hand-edited settings.json (e.g. `{0: {...}, length: 1}`) passed
    // through untouched, carrying a masked entry's plaintext `default` into the
    // share file.
    const shareStore = new InMemoryMacroStore();
    await shareStore.initialize();
    await shareStore.save([
      {
        name: "Login",
        text: "login $password\n",
        secret: false,
        variables: { 0: { name: "password", secret: true, default: "hunter2" }, length: 1 }
      } as unknown as TerminalMacro
    ]);
    setActiveMacroStore(shareStore);

    const savedUri = { fsPath: "/fake/export-vars-arraylike.json", scheme: "file" };
    mockShowSaveDialog.mockResolvedValue(savedUri);
    mockWriteFile.mockResolvedValue(undefined);

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenText = Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8");
    expect(writtenText).not.toContain("hunter2");

    const writtenData = JSON.parse(writtenText);
    const login = writtenData.macros.find((m: { name: string }) => m.name === "Login");
    expect(login.variables).toBeUndefined();
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

  it("Fix 2 — strips a masked variable's plaintext default from the top-level (cleartext) macros array", async () => {
    // The InMemoryMacroStore used here does NOT itself sanitize on save() (only
    // VscodeMacroStore does, at its own persistence chokepoint) — so if this
    // assertion passes, it's specifically because configCommands.ts's own
    // `withRedactedVariables(...)` call (applied per-macro when building
    // `nonSecretForTopLevel`) did the stripping, not because the store already
    // cleaned the data before we saw it.
    const backupExportStore = new InMemoryMacroStore();
    await backupExportStore.initialize();
    await backupExportStore.save([
      {
        name: "Login",
        text: "login $password\n",
        variables: [{ name: "password", label: "Password", secret: true, default: "hunter2" }]
      }
    ]);
    setActiveMacroStore(backupExportStore);

    mockShowInputBox
      .mockResolvedValueOnce("testpass123")
      .mockResolvedValueOnce("testpass123");
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup.json", scheme: "file" });
    mockWriteFile.mockResolvedValue(undefined);

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();

    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
    expect(Array.isArray(writtenData.macros)).toBe(true);
    // The `macros` array sits OUTSIDE `encryptedSecrets` — the whole point of the
    // fix is that this plaintext default never appears anywhere in the backup file.
    expect(JSON.stringify(writtenData)).not.toContain("hunter2");
    const loginMacro = writtenData.macros.find((m: { name: string }) => m.name === "Login");
    expect(loginMacro.variables).toEqual([{ name: "password", label: "Password", secret: true }]);
  });

  it("Fix C boundary — an array-like (non-array) variables value is dropped from the top-level (cleartext) macros array", async () => {
    // Same gap as the share-export boundary test above, exercised on the backup path's
    // own `nonSecretForTopLevel` mapping.
    const backupExportStore = new InMemoryMacroStore();
    await backupExportStore.initialize();
    await backupExportStore.save([
      {
        name: "Login",
        text: "login $password\n",
        variables: { 0: { name: "password", label: "Password", secret: true, default: "hunter2" }, length: 1 }
      } as unknown as TerminalMacro
    ]);
    setActiveMacroStore(backupExportStore);

    mockShowInputBox
      .mockResolvedValueOnce("testpass123")
      .mockResolvedValueOnce("testpass123");
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup-vars-arraylike.json", scheme: "file" });
    mockWriteFile.mockResolvedValue(undefined);

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();

    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
    expect(Array.isArray(writtenData.macros)).toBe(true);
    expect(JSON.stringify(writtenData)).not.toContain("hunter2");
    const loginMacro = writtenData.macros.find((m: { name: string }) => m.name === "Login");
    expect(loginMacro.variables).toBeUndefined();
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

  it("exports only explicitly configured settings, not package defaults", async () => {
    configDefaults.set("nexus.scripts.defaultTimeoutSeconds", 30);
    configDefaults.set("nexus.scripts.maxRuntimeSeconds", 1800);
    configDefaults.set("nexus.terminal.highlighting.enabled", true);
    configStore.set("nexus.scripts.defaultTimeout", 60_000);
    configStore.set("nexus.scripts.maxRuntimeMs", 0);

    mockShowInputBox
      .mockResolvedValueOnce("testpass123")
      .mockResolvedValueOnce("testpass123");
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup.json", scheme: "file" });

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();

    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
    expect(writtenData.settings).toEqual({
      "nexus.scripts.defaultTimeoutSeconds": 60,
      "nexus.scripts.maxRuntimeMs": 0
    });
  });

  it("FINDING 1 (P2, secrets review) — a source whose declared secret has no vault value at export time still exports its record, but the completion message warns it was left uncredentialed (kills silent omission — a reverted fix drops the secret AND says nothing, so a replace-restore of this backup would later report success for a source that can never authenticate)", async () => {
    // src1 declares "apiToken" as a secret field but the vault is never populated for it —
    // e.g. the keychain was locked/unavailable when this backup was taken.
    await core.addOrUpdateInventorySource(makeInventorySource({ id: "src1", name: "NetBox", secretFieldIds: ["apiToken"] }));

    mockShowInputBox
      .mockResolvedValueOnce("testpass123")
      .mockResolvedValueOnce("testpass123");
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup.json", scheme: "file" });
    mockWriteFile.mockResolvedValue(undefined);

    const backupCmd = registeredCommands.get("nexus.config.export.backup")!;
    await backupCmd();

    // The record itself still exports cleanly — the fix is a warning, not an abort.
    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
    expect(writtenData.inventorySources).toHaveLength(1);
    expect(writtenData.inventorySources[0].id).toBe("src1");

    const { decrypt } = await import("../../src/utils/configCrypto");
    const decrypted = JSON.parse(decrypt(writtenData.encryptedSecrets, "testpass123"));
    expect(decrypted.inventorySourceSecrets.src1).toBeUndefined();

    // The completion message names the gap. A reverted fix (missing count never surfaced)
    // would call showInformationMessage with a message that does NOT contain this line.
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("1 inventory source had unreadable credentials — the backup does not include them.")
    );
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

  /** Drives the real `nexus.config.import` command over an unencrypted export payload. */
  async function runBackupImport(exportData: unknown, mode: "merge" | "replace"): Promise<void> {
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: mode === "merge" ? "Merge" : "Replace", value: mode });
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    await registeredCommands.get("nexus.config.import")!();
  }

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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

  it("replace-mode restore cannot hand an imported macro a local macro's stored password, even while the keyring is down", async () => {
    // End-to-end reproduction of the review finding, through the real import command.
    // Replace mode is the one macro write in the extension whose input is a wholesale
    // external list, so it goes through `MacroStore.replaceAll()` rather than `save()`.
    const stateMap = new Map<string, unknown>();
    const secretMap = new Map<string, string>();
    const realGet = async (k: string): Promise<string | undefined> => secretMap.get(k);
    let keyringDown = false;
    const fakeCtx = {
      globalState: {
        get<T>(k: string, fb: T): T { return (stateMap.get(k) as T) ?? fb; },
        async update(k: string, v: unknown): Promise<void> {
          if (v === undefined) stateMap.delete(k); else stateMap.set(k, v);
        },
        keys(): readonly string[] { return [...stateMap.keys()]; }
      },
      secrets: {
        async get(k: string): Promise<string | undefined> { return keyringDown ? undefined : realGet(k); },
        async store(k: string, v: string): Promise<void> { secretMap.set(k, v); },
        async delete(k: string): Promise<void> { secretMap.delete(k); },
        // Present because `engines.vscode` is `^1.105.0`, where `SecretStorage.keys()` is
        // finalized. `VscodeMacroStore.clearAll()` calls it unconditionally.
        async keys(): Promise<string[]> { return [...secretMap.keys()]; }
      }
    } as unknown as import("vscode").ExtensionContext;

    // A local secret macro with its password in the vault, filed under id "p".
    const seedStore = new VscodeMacroStore(fakeCtx, { runLegacyMigration: false });
    await seedStore.initialize();
    await seedStore.save([
      { id: "p", name: "Existing", text: "old-local-password\n", secret: true, triggerPattern: "Password:" }
    ]);
    expect(secretMap.get(macroSecretKey("p"))).toBe("old-local-password\n");

    // The OS keyring goes away. `SecretStorage.get()` reports that as `undefined`, which is
    // indistinguishable from "no entry", so the local secret resolves to "" — and that is
    // exactly the state in which the store must keep the macro on the id its entry is filed
    // under, because it cannot carry the value anywhere.
    keyringDown = true;
    const importStore = new VscodeMacroStore(fakeCtx, { runLegacyMigration: false });
    await importStore.initialize();
    expect(importStore.getAll()[0].text).toBe("");
    setActiveMacroStore(importStore);

    // The backup carries a macro whose id COLLIDES with the local one and whose own secret
    // is absent (no `encryptedSecrets`), so it arrives as `secret: true` with empty text —
    // the same shape the unreadable local secret has, and the shape the import warns about.
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [
        { id: "p", name: "Imported missing secret", text: "", secret: true, triggerPattern: "Password:" }
      ],
      settings: {}
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup-collide.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const [imported] = importStore.getAll();
    expect(imported.name).toBe("Imported missing secret");
    expect(imported.id).not.toBe("p");
    expect(secretMap.has(macroSecretKey("p"))).toBe(false);

    // The disclosure this closes: with the id inherited, the keyring recovering would arm
    // the imported macro's `Password:` auto-trigger with the local machine's password —
    // after the UI had told the user this macro's secret was missing.
    keyringDown = false;
    const recovered = new VscodeMacroStore(fakeCtx, { runLegacyMigration: false });
    await recovered.initialize();
    const [after] = recovered.getAll();
    expect(after.name).toBe("Imported missing secret");
    expect(after.text).toBe("");
    expect(after.text).not.toBe("old-local-password\n");
  });

  it("merging a backup that was previously restored in REPLACE mode adds nothing — the id skip alone stopped being idempotent once replace started freshening ids", async () => {
    // The regression this pins is a two-command sequence a user has every reason to run:
    // restore a backup in Replace mode, then later merge the same file to pick up whatever
    // was added since. Replace assigns a fresh id to every incoming record — it has to, an id
    // in a file is an identity from another machine — so after it runs, none of the ids in
    // that file names anything locally. Merge's only dedupe used to be the id, so every macro
    // in the file landed a SECOND time, with a distinct id, which means the ambiguous-id
    // fail-safe does not suppress either copy: both compile auto-trigger rules and both fire
    // on one match. A `Password:` responder answers a single prompt twice.
    const store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);

    const backup = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [
        { id: "file-a", name: "Enable", text: "enable\n", triggerPattern: "Password:" },
        { id: "file-b", name: "Poll", text: "show status\n" }
      ],
      settings: {}
    };

    await runBackupImport(backup, "replace");
    const afterReplace = getMacros();
    expect(afterReplace.map((m) => m.name)).toEqual(["Enable", "Poll"]);
    // The premise: the file's ids are gone, so the id skip below cannot match anything.
    expect(afterReplace.map((m) => m.id)).not.toContain("file-a");
    expect(afterReplace.map((m) => m.id)).not.toContain("file-b");

    await runBackupImport(backup, "merge");

    const afterMerge = getMacros();
    expect(afterMerge).toHaveLength(2);
    expect(afterMerge.map((m) => m.name)).toEqual(["Enable", "Poll"]);
    // Not merely "the right count": the records are the SAME records, still on the ids the
    // replace gave them, so nothing was replaced-in-place either.
    expect(afterMerge.map((m) => m.id)).toEqual(afterReplace.map((m) => m.id));

    // ...and the content key has not made merge inert. A macro the file has and the store
    // does not still lands, exactly once.
    await runBackupImport(
      { ...backup, macros: [...backup.macros, { id: "file-c", name: "Reload", text: "reload\n" }] },
      "merge"
    );
    const afterSecondMerge = getMacros();
    expect(afterSecondMerge.map((m) => m.name)).toEqual(["Enable", "Poll", "Reload"]);
    expect(afterSecondMerge[2].id).toBe("file-c");
  });

  it("merge still skips by ID, so a macro edited locally is not re-added from the backup as a second copy", async () => {
    // The two dedupe keys are independent and this is the half the content key cannot do:
    // the record's content has DIVERGED from the file's, so only the id identifies it. This
    // is also what keeps `MacroStore.save()`'s precondition true for this branch — every
    // incoming id the store already holds is dropped before the list reaches the store.
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([{ id: "shared", name: "Enable (renamed locally)", text: "enable-secret\n" }]);
    setActiveMacroStore(store);

    await runBackupImport(
      {
        version: 2,
        exportType: "backup",
        exportedAt: new Date().toISOString(),
        servers: [],
        tunnels: [],
        serialProfiles: [],
        macros: [{ id: "shared", name: "Enable", text: "enable\n" }],
        settings: {}
      },
      "merge"
    );

    const macros = getMacros();
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe("Enable (renamed locally)");
    expect(macros[0].text).toBe("enable-secret\n");
  });

  it("merge does not collapse macros that differ only in trigger or variable METADATA — a content-key collision here is a silent drop, not a merge", async () => {
    // The content key decides which incoming records are thrown away, with no report to
    // anyone, so anything it omits is a field two legitimate macros can differ in while one
    // of them vanishes. An earlier key covered name / secret / text / triggerPattern /
    // keybinding plus variable NAMES, and nothing else — so every pair below collided.
    //
    // Each pair is identical on every term that key DID cover AND on every term it did not,
    // except the ONE the pair is named for. That isolation is the point: with a pair that
    // differs in two omitted fields at once, restoring either one alone makes the case pass,
    // and the other term stays untested. Mutating any single term out of `keyOf()` must fail
    // this test.
    const store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);

    const file = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [
        // Scope, on a SHARED id — the reported case. The id skip cannot separate these
        // (neither id is held locally), so the content key is the only thing standing between
        // them, and it dropped the second before the store's `assignMacroIds()` ever saw it to
        // re-key. Neither carries a profile id, so scope is the only difference.
        { id: "dup", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "all-terminals" },
        { id: "dup", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "active-session" },
        // Target profile — same scope, different profile. "Send this password to prod" and
        // "send it to staging" are emphatically not one macro.
        { id: "pf1", name: "Enable (scoped)", text: "enable\n", triggerPattern: "Password:", triggerScope: "profile", triggerProfileId: "prod-1" },
        { id: "pf2", name: "Enable (scoped)", text: "enable\n", triggerPattern: "Password:", triggerScope: "profile", triggerProfileId: "staging-1" },
        // Cooldown.
        { id: "c1", name: "Poll", text: "show status\n", triggerPattern: "#", triggerCooldown: 5 },
        { id: "c2", name: "Poll", text: "show status\n", triggerPattern: "#", triggerCooldown: 30 },
        // Repeat interval.
        { id: "i1", name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 60 },
        { id: "i2", name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 300 },
        // Start-paused.
        { id: "d1", name: "Reload", text: "reload\n", triggerPattern: "confirm" },
        { id: "d2", name: "Reload", text: "reload\n", triggerPattern: "confirm", triggerInitiallyDisabled: true },
        // Variable metadata, one omitted field per pair, all under the same variable NAME —
        // which is all the old key looked at. Each changes what running the macro does: the
        // prompt text, the prefilled value, whether the input is masked, whether it is
        // remembered.
        { id: "vl1", name: "Ping", text: "ping $host\n", variables: [{ name: "host", label: "Target host" }] },
        { id: "vl2", name: "Ping", text: "ping $host\n", variables: [{ name: "host", label: "Jump host" }] },
        // The variable NAME itself, which nothing exercised. The two records here carry the
        // SAME text, referencing BOTH names, so the declared name is what decides which
        // placeholder is prompted for and substituted and which is left standing on the wire
        // (`resolveMacroText()` → `scanPlaceholders()`, macroVariablePrompt.ts). Two macros
        // asking for different things are two macros.
        { id: "vn1", name: "Connect", text: "connect ${host} ${target}\n", variables: [{ name: "host" }] },
        { id: "vn2", name: "Connect", text: "connect ${host} ${target}\n", variables: [{ name: "target" }] },
        // The same field again, on a text that references NEITHER name — a declaration the
        // prompt path never reads. `resolveMacroText()` scans no use of either, prompts for
        // nothing, and sends `connect\n` for both, so these two ARE runtime-identical today and
        // the key separates them anyway. That is a deliberate exception to the rule the rest of
        // this fixture pins, and it is argued where the collapse would have to be written —
        // `canonicalMacroVariableTerms()` in storage/macroStore.ts. In short: the declaration is
        // real user data that goes live again the moment the TEXT gains `$host`, no edit to the
        // variables array required, and collapsing costs whichever of the two the user listed
        // second — permanently, on the legacy path, since absorption clears the setting it read.
        // A duplicate here cannot double-send: §6.1 suppresses the auto-trigger of any macro
        // whose `variables` is a non-empty array, which is every macro this term can separate.
        { id: "vu1", name: "Deploy", text: "deploy\n", variables: [{ name: "host" }] },
        { id: "vu2", name: "Deploy", text: "deploy\n", variables: [{ name: "target" }] },
        { id: "vd1", name: "Ssh", text: "ssh $user\n", variables: [{ name: "user" }] },
        { id: "vd2", name: "Ssh", text: "ssh $user\n", variables: [{ name: "user", default: "admin" }] },
        { id: "vs1", name: "Login", text: "login $pw\n", variables: [{ name: "pw" }] },
        { id: "vs2", name: "Login", text: "login $pw\n", variables: [{ name: "pw", secret: true }] },
        { id: "vr1", name: "Trace", text: "trace $dest\n", variables: [{ name: "dest" }] },
        { id: "vr2", name: "Trace", text: "trace $dest\n", variables: [{ name: "dest", remember: false }] },
        // The four terms the key ALREADY had. They were vacuous under the previous fixture —
        // every pair in it happened to differ in a second field as well — so they are pinned
        // here too rather than left resting on inspection.
        { id: "n1", name: "Alpha", text: "same text\n" },
        { id: "n2", name: "Beta", text: "same text\n" },
        { id: "t1", name: "Save", text: "write mem\n" },
        { id: "t2", name: "Save", text: "copy run start\n" },
        { id: "tp1", name: "Ack", text: "y\n", triggerPattern: "confirm:" },
        { id: "tp2", name: "Ack", text: "y\n", triggerPattern: "proceed:" },
        { id: "kb1", name: "Shortcut", text: "bounce\n", keybinding: "alt+1" },
        { id: "kb2", name: "Shortcut", text: "bounce\n", keybinding: "alt+2" }
      ],
      settings: {}
    };

    await runBackupImport(file, "merge");

    const macros = getMacros();
    expect(macros).toHaveLength(30);
    // Both halves of every pair landed, and are distinguishable by the field they differ in.
    const pick = (name: string) => macros.filter((m) => m.name === name);
    expect(pick("Enable").map((m) => m.triggerScope).sort()).toEqual(["active-session", "all-terminals"]);
    expect(pick("Enable (scoped)").map((m) => m.triggerProfileId).sort()).toEqual(["prod-1", "staging-1"]);
    expect(pick("Poll").map((m) => m.triggerCooldown).sort()).toEqual([30, 5]);
    expect(pick("Keepalive").map((m) => m.triggerInterval).sort()).toEqual([300, 60]);
    expect(pick("Reload").map((m) => m.triggerInitiallyDisabled === true).sort()).toEqual([false, true]);
    expect(pick("Ping").map((m) => m.variables?.[0].label).sort()).toEqual(["Jump host", "Target host"]);
    expect(pick("Connect").map((m) => m.variables?.[0].name).sort()).toEqual(["host", "target"]);
    expect(pick("Deploy").map((m) => m.variables?.[0].name).sort()).toEqual(["host", "target"]);
    expect(pick("Ssh").map((m) => m.variables?.[0].default ?? "").sort()).toEqual(["", "admin"]);
    expect(pick("Login").map((m) => m.variables?.[0].secret === true).sort()).toEqual([false, true]);
    expect(pick("Trace").map((m) => m.variables?.[0].remember === false).sort()).toEqual([false, true]);
    expect([pick("Alpha").length, pick("Beta").length]).toEqual([1, 1]);
    expect(pick("Save").map((m) => m.text).sort()).toEqual(["copy run start\n", "write mem\n"]);
    expect(pick("Ack").map((m) => m.triggerPattern).sort()).toEqual(["confirm:", "proceed:"]);
    expect(pick("Shortcut").map((m) => m.keybinding).sort()).toEqual(["alt+1", "alt+2"]);

    // The shared id did not survive as one: the store re-keys the second, which is exactly
    // what the drop used to prevent from ever happening.
    expect(new Set(pick("Enable").map((m) => m.id)).size).toBe(2);

    // ...and the key has not become so strict that re-importing the same file duplicates it.
    // Idempotency is the property the content key exists for; widening it must not cost that.
    const before = getMacros().map((m) => m.id).sort();
    await runBackupImport(file, "merge");
    expect(getMacros().map((m) => m.id).sort()).toEqual(before);
  });

  it("a macro whose `keybinding` is not a string does not break the import — on either side of the content key", async () => {
    // The content key asks `getAssignedBinding()` for the binding the app actually applies, and
    // that call is made for EVERY record on both sides of the comparison: the local set
    // (`existing.map(keyOf)`) and each incoming one. A `keybinding: 1` — the slot number written
    // into the field that superseded it — threw a TypeError out of `normalizeBinding()`, so a
    // single such record anywhere in either set aborted the whole import: no macros, no servers
    // past that point, and an error the user cannot act on. The local set is the reachable half,
    // because legacy absorption persists settings.json records verbatim.
    //
    // Every JSON type that is not a string is covered on both sides, deliberately. A guard that
    // special-cased the plausible hand-edit (a NUMBER) and let the rest through would satisfy the
    // number-only version of this test while still throwing on `true` or `{}` — both of which a
    // hand-edited settings.json or a file from another machine can carry, and neither of which
    // has a `.trim()` to duck-type through.
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([
      { name: "Local", text: "local\n", keybinding: 1 },
      { name: "LocalBool", text: "local\n", keybinding: true },
      { name: "LocalObj", text: "local\n", keybinding: { key: "alt+9" } },
      { name: "LocalArr", text: "local\n", keybinding: ["alt+9"] }
    ] as unknown as TerminalMacro[]);
    setActiveMacroStore(store);

    await runBackupImport(
      {
        version: 2,
        exportType: "backup",
        exportedAt: new Date().toISOString(),
        servers: [],
        tunnels: [],
        serialProfiles: [],
        macros: [
          { id: "f1", name: "Fromfile", text: "file\n", keybinding: 2 },
          { id: "f2", name: "FromfileBool", text: "file\n", keybinding: false },
          { id: "f3", name: "FromfileObj", text: "file\n", keybinding: { key: "alt+8" } },
          { id: "f4", name: "FromfileArr", text: "file\n", keybinding: ["alt+8"] }
        ],
        settings: {}
      },
      "merge"
    );

    const macros = getMacros();
    expect(macros.map((m) => m.name).sort()).toEqual([
      "Fromfile", "FromfileArr", "FromfileBool", "FromfileObj", "Local", "LocalArr", "LocalBool", "LocalObj"
    ]);
    // No record binds anything: an unusable value is not a binding, and the imported ones do not
    // keep it either — `sanitizeImportedMacro()` drops a keybinding it cannot validate, the same
    // as it does for a malformed string.
    expect(macros.map((m) => getAssignedBinding(m))).toEqual(new Array(8).fill(undefined));
    expect(macros.filter((m) => m.name.startsWith("Fromfile")).map((m) => m.keybinding)).toEqual([
      undefined, undefined, undefined, undefined
    ]);
  });

  it("a macro carrying `variables: []` merges back from its own backup as ONE macro", async () => {
    // The round trip that the empty array used to break, end to end. `variables: []` reaches the
    // store from a hand-written `nexus.terminal.macros` (absorption persists it verbatim —
    // `withRedactedVariables()` drops only a NON-array), export writes it out unchanged, and
    // `sanitizeImportedMacroVariables()` then DELETES it on the way back in while leaving the
    // trigger alone (`hadDeclaration` is false for a zero-length array, so §6.2 does not strip).
    // So the same macro exists in two shapes that no runtime reader can tell apart — §6.1 is
    // `Array.isArray && length > 0` and `getValidMacroVariables()` returns `[]` for both — and
    // keying them apart put a second copy in the store with its own id and its own live
    // `Password:` rule. Two rules, one prompt, the password sent twice.
    //
    // The ids differ here because that is what makes the CONTENT key the only thing left: the
    // backup came from another machine (or from before a replace-mode restore freshened every
    // id), while this machine absorbed the same synced settings.json under an id of its own.
    const exportStore = new InMemoryMacroStore();
    await exportStore.initialize();
    await exportStore.save([
      { id: "machine-a-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", variables: [] }
    ]);
    setActiveMacroStore(exportStore);

    mockShowInputBox.mockResolvedValue("testpass123");
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup-empty-vars.json", scheme: "file" });
    mockWriteFile.mockResolvedValue(undefined);
    await registeredCommands.get("nexus.config.export.backup")!();

    const written = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
    // The boundary really is crossed: the file carries the empty array, not an absent key.
    expect(written.macros[0].variables).toEqual([]);

    const localStore = new InMemoryMacroStore();
    await localStore.initialize();
    await localStore.save([
      { id: "machine-b-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", variables: [] }
    ]);
    setActiveMacroStore(localStore);

    await runBackupImport(written, "merge");
    expect(localStore.getAll()).toHaveLength(1);
    expect(localStore.getAll()[0].id).toBe("machine-b-1");
  });

  /** A one-macro backup payload, for the round-trip repros below. */
  function backupWith(macro: Record<string, unknown>): Record<string, unknown> {
    return {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [macro],
      settings: {}
    };
  }

  /** Seeds a fresh store with one macro and makes it the active one. */
  async function storeWith(macro: TerminalMacro): Promise<InMemoryMacroStore> {
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([macro]);
    setActiveMacroStore(store);
    return store;
  }

  it("merge does NOT re-add a macro whose cooldown is above the clamp ceiling — the sanitizer clamps onto the runtime meaning instead of deleting", async () => {
    // `triggerCooldown: 5000` is what a user who assumed milliseconds writes, and legacy
    // absorption persists a hand-written `nexus.terminal.macros` verbatim. `reload()` clamps it
    // to the 300s ceiling and PINS it there. The import sanitizer used to delete anything outside
    // 0..300, which is not a rejection of a bad value but a different macro: an absent cooldown
    // follows the machine-local `defaultCooldown` SETTING. So the copy in the file stopped keying
    // like the record it was exported from, and merging that backup added a SECOND `Password:`
    // responder — a distinct id, so the ambiguous-id fail-safe suppresses neither, and both
    // compile a live rule. One prompt, two passwords.
    //
    // The ids differ because that is what leaves the content key as the only dedupe: the file
    // came from another machine, or from before a replace-mode restore freshened every id.
    const store = await storeWith(
      { id: "local-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerCooldown: 5000 }
    );

    await runBackupImport(
      backupWith({ id: "file-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerCooldown: 5000 }),
      "merge"
    );

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe("local-1");
    // Nothing was rewritten in place either — the skip is a skip.
    expect(store.getAll()[0].triggerCooldown).toBe(5000);

    // ...and when the store does NOT already hold it, the record still lands, carrying the value
    // the compiler would have used. Clamped, not deleted (which would hand it to the setting) and
    // not passed through verbatim (which would leave an out-of-range number in globalState).
    const fresh = new InMemoryMacroStore();
    await fresh.initialize();
    setActiveMacroStore(fresh);
    await runBackupImport(
      backupWith({ id: "file-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerCooldown: 5000 }),
      "merge"
    );
    expect(fresh.getAll()).toHaveLength(1);
    expect(fresh.getAll()[0].triggerCooldown).toBe(300);
  });

  it("merge does NOT re-add a macro whose sub-second interval the old import window erased", async () => {
    // The opposite direction of the same mistake. `reload()` asks only `typeof x === "number" &&
    // x > 0`, so a stored `0.5` is a live 500 ms interval rule; the sanitizer's 1..86400 window
    // was an import-path invention with no runtime behind it, and deleting the field turned that
    // rule into no rule at all. Two shapes, two keys, two macros — and the one in the store keeps
    // firing twice a second.
    const store = await storeWith(
      { id: "local-1", name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 0.5 }
    );

    await runBackupImport(
      backupWith({ id: "file-1", name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 0.5 }),
      "merge"
    );

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe("local-1");

    // Preserved rather than clamped when it lands: `reload()` does not clamp the interval, so
    // rounding it up to the old floor would make the imported copy a different macro again — the
    // very thing this fix is closing, one round of copying later.
    const fresh = new InMemoryMacroStore();
    await fresh.initialize();
    setActiveMacroStore(fresh);
    await runBackupImport(
      backupWith({ id: "file-1", name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 0.5 }),
      "merge"
    );
    expect(fresh.getAll()[0].triggerInterval).toBe(0.5);
  });

  it("merge does NOT re-add a macro whose quoted cooldown pins the shipped default", async () => {
    // A hand-edited settings.json that quoted its numbers. `clampSeconds()` hands `"5"` the
    // shipped `DEFAULT_TRIGGER_COOLDOWN`, so the record runs at a FIXED 3s — deleting the field
    // handed it to the setting instead, and the two copies parted company.
    const store = await storeWith(
      { id: "local-1", name: "Ack", text: "y\n", triggerPattern: "confirm:", triggerCooldown: "5" } as unknown as TerminalMacro
    );

    await runBackupImport(
      backupWith({ id: "file-1", name: "Ack", text: "y\n", triggerPattern: "confirm:", triggerCooldown: "5" }),
      "merge"
    );

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe("local-1");

    // What lands on a store that does not have it is the number the compiler was going to use,
    // which is also why the two key alike.
    const fresh = new InMemoryMacroStore();
    await fresh.initialize();
    setActiveMacroStore(fresh);
    await runBackupImport(
      backupWith({ id: "file-1", name: "Ack", text: "y\n", triggerPattern: "confirm:", triggerCooldown: "5" }),
      "merge"
    );
    expect(fresh.getAll()[0].triggerCooldown).toBe(3);
  });

  it("merge does NOT re-add a macro whose start-paused flag is a truthy non-boolean, and does not import it live", async () => {
    // `reload()` reads this field for TRUTHINESS, so a hand-written `"yes"` means "start paused".
    // Deleting it produced a second copy of the macro that was also the WRONG copy: the store's
    // record starts paused and the imported one starts live, so the pair is one macro the user
    // silenced plus one that fires.
    const store = await storeWith(
      { id: "local-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerInitiallyDisabled: "yes" } as unknown as TerminalMacro
    );

    await runBackupImport(
      backupWith({ id: "file-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerInitiallyDisabled: "yes" }),
      "merge"
    );

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe("local-1");

    const fresh = new InMemoryMacroStore();
    await fresh.initialize();
    setActiveMacroStore(fresh);
    await runBackupImport(
      backupWith({ id: "file-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerInitiallyDisabled: "yes" }),
      "merge"
    );
    expect(fresh.getAll()[0].triggerInitiallyDisabled).toBe(true);
  });

  it("merge does NOT re-add a macro whose trigger scope the compiler refuses — an unknown scope is the same nothing as no pattern", async () => {
    // `reload()` skips a macro whose scope the enum does not name, so the record compiles no rule
    // at all — exactly as much as a pattern-less one. The sanitizer strips the whole trigger for
    // the same reason, but the key used to keep the bad string verbatim, so the stripped copy
    // matched nothing and landed as a second (also inert) macro in the tree.
    const store = await storeWith(
      { id: "local-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "bogus" } as unknown as TerminalMacro
    );

    await runBackupImport(
      backupWith({ id: "file-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "bogus" }),
      "merge"
    );

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe("local-1");
    // A scope the compiler DOES name is untouched by that fold: this is still two macros.
    const scoped = await storeWith(
      { id: "local-2", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "active-session" }
    );
    await runBackupImport(
      backupWith({ id: "file-2", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "profile", triggerProfileId: "prod-1" }),
      "merge"
    );
    expect(scoped.getAll()).toHaveLength(2);
  });

  it("merge does not drop a secret macro whose decrypted text happens to equal a plain macro's", async () => {
    // The `secret` term in the content key, which nothing exercised. Merge is the only caller
    // that carries secret macros (share import filters them out before the key is built), and
    // by the time the key is computed the secret's text has already been decrypted — so a
    // secret macro and a plain one that agree on name, text and trigger are indistinguishable
    // without the term, and the incoming one is silently discarded. That is the user's
    // credential not being restored from their own backup, reported to nobody.
    const { encrypt } = await import("../../src/utils/configCrypto");
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([{ id: "local", name: "Enable", text: "cisco\n" }]);
    setActiveMacroStore(store);

    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [{ id: "file-s", name: "Enable", text: "", secret: true }],
      settings: {},
      encryptedSecrets: encrypt(
        JSON.stringify({ secretMacros: [{ id: "file-s", text: "cisco\n" }] }),
        "testpass"
      )
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup-secret-collision.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Merge", value: "merge" });
    mockShowInputBox.mockResolvedValueOnce("testpass"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    await registeredCommands.get("nexus.config.import")!();

    const macros = getMacros();
    expect(macros).toHaveLength(2);
    expect(macros.map((m) => m.secret === true).sort()).toEqual([false, true]);
    expect(macros.find((m) => m.secret)!.text).toBe("cisco\n");
    expect(macros.find((m) => !m.secret)!.id).toBe("local");
  });

  it("merge does NOT re-add a macro the editor saved with an explicit default scope when the backup leaves the scope absent", async () => {
    // Executed reproduction of the round-5 regression, and the reason the content key is
    // canonicalized rather than spelled out field by field.
    //
    // The macro editor always writes a scope for a trigger macro — ui/macroEditorHtml.ts
    // defaults the control to "all-terminals" and ui/macroEditorPanel.ts writes back whatever
    // the control says — while `sanitizeImportedMacro()` leaves an absent scope absent. The two
    // are the SAME MACRO at runtime: MacroAutoTrigger.evaluate() only ever tests for
    // "active-session" and "profile", so an absent scope and an explicit "all-terminals" both
    // mean every terminal.
    //
    // The user flow is ordinary: import an older backup or a share (absent scope), open the
    // macro in the editor and press Save — even changing nothing — then later merge the same
    // file again. With the scope keyed verbatim that produced TWO macros with distinct ids, so
    // the ambiguous-id fail-safe suppresses neither: both compile a rule and both fire on one
    // match. For this fixture, a `confirm:` responder, that is `y\n` sent twice; for a
    // `Password:` responder it is the password sent twice per prompt.
    const store = new InMemoryMacroStore();
    await store.initialize();
    // Exactly what the editor persists, down to the explicit scope.
    await store.save([
      { id: "local", name: "Ack", text: "y\n", triggerPattern: "confirm:", triggerScope: "all-terminals" }
    ]);
    setActiveMacroStore(store);

    const backup = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      // The same macro as written before the editor materialized the default: no scope at all.
      macros: [{ id: "file-ack", name: "Ack", text: "y\n", triggerPattern: "confirm:" }],
      settings: {}
    };

    await runBackupImport(backup, "merge");

    const macros = getMacros();
    expect(macros).toHaveLength(1);
    expect(macros[0].id).toBe("local");

    // The same collapse in the other direction — a pattern-less macro carrying inert trigger
    // fields. The editor's cooldown write is not gated on the pattern, so it can persist
    // `triggerCooldown` on a macro with no trigger at all, while `sanitizeImportedMacro()`
    // strips the whole group. Neither record compiles anything, so they are one macro.
    await store.save([
      ...getMacros(),
      { id: "local-2", name: "Banner", text: "show banner\n", triggerCooldown: 30, triggerInterval: 90 }
    ]);
    await runBackupImport(
      {
        ...backup,
        macros: [...backup.macros, { id: "file-banner", name: "Banner", text: "show banner\n" }]
      },
      "merge"
    );
    expect(getMacros().map((m) => m.name)).toEqual(["Ack", "Banner"]);
  });

  it("merge does NOT drop a plain macro that collides with a legacy TRUTHY-secret one — `secret` is keyed as the store reads it", async () => {
    // Executed reproduction of the second round-5 regression. Keying `m.secret === true`
    // regressed the truthy encoding every consumer in the codebase actually uses: legacy
    // settings absorption persists `secret: "true"` verbatim, `reloadFromState()` vault-reads on
    // `if (entry.secret)`, and `write()` vault-stores on `if (m.secret)`. So the stored record
    // below IS a secret macro at runtime, and the incoming plain one is a different macro that
    // happens to share its name and text.
    //
    // A content-key collision in the merge branch is a DROP with no report, so this cost the
    // user a macro out of their own backup, silently.
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([
      { id: "legacy", name: "Login", text: "hunter2\n", secret: "true" } as unknown as TerminalMacro
    ]);
    setActiveMacroStore(store);

    await runBackupImport(
      {
        version: 2,
        exportType: "backup",
        exportedAt: new Date().toISOString(),
        servers: [],
        tunnels: [],
        serialProfiles: [],
        macros: [{ id: "file-plain", name: "Login", text: "hunter2\n" }],
        settings: {}
      },
      "merge"
    );

    const macros = getMacros();
    expect(macros).toHaveLength(2);
    expect(macros.map((m) => m.id)).toEqual(["legacy", "file-plain"]);
    expect(macros[1].secret).toBeUndefined();
  });

  it("the content key cannot be forged through a field containing the delimiter", async () => {
    // The key is assembled with `JSON.stringify`, not a `|` join, and this is what makes that
    // a property rather than a comment. With a join, two records can produce the identical
    // string, and a collision here is a silent DROP — a macro missing from the user's own
    // backup, reported to nobody. A macro name is free text and a macro's TEXT is arbitrary
    // terminal input, so a `|` in either is not exotic.
    //
    // The forgery needs two ADJACENT free-text terms, which is why both pairs are here. The
    // first (`name`/`text`) does not collide under today's field order — `secret` sits between
    // them and contributes `false` — and is kept so the fixture still covers the shape if the
    // order ever changes. The second (`text`/`triggerPattern`, which ARE adjacent) is the one
    // that forges: `x` + `p|q` and `x|p` + `q` both join to `…|x|p|q|…`.
    //
    // Reverting `keyOf()` to a delimiter join with every field still present passes every other
    // test in this file; it fails here.
    const store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);

    await runBackupImport(
      {
        version: 2,
        exportType: "backup",
        exportedAt: new Date().toISOString(),
        servers: [],
        tunnels: [],
        serialProfiles: [],
        macros: [
          { id: "forge-1", name: "a|b", text: "c" },
          { id: "forge-2", name: "a", text: "b|c" },
          // The same shape one field further along, so a join that merely uses a rarer
          // separator does not pass either.
          { id: "forge-3", name: "Sep", text: "x", triggerPattern: "p|q" },
          { id: "forge-4", name: "Sep", text: "x|p", triggerPattern: "q" }
        ],
        settings: {}
      },
      "merge"
    );

    const macros = getMacros();
    expect(macros).toHaveLength(4);
    expect(macros.map((m) => m.id)).toEqual(["forge-1", "forge-2", "forge-3", "forge-4"]);
  });

  it("merge keeps two slot-era macros that differ only in their legacy `slot`", async () => {
    // `slot` is the deprecated spelling of `keybinding`, migrated by `withMigratedSlot()` on
    // both the read and the write path, so these two records become `alt+1` and `alt+2` — two
    // macros on two different shortcuts. Keying the raw `keybinding` field left `slot` out of
    // the key entirely: both records had an absent `keybinding`, agreed on every other term,
    // and the second was dropped before the store could migrate it.
    const store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);

    await runBackupImport(
      {
        version: 2,
        exportType: "backup",
        exportedAt: new Date().toISOString(),
        servers: [],
        tunnels: [],
        serialProfiles: [],
        macros: [
          { id: "slot-1", name: "Bounce", text: "bounce\n", slot: 1 },
          { id: "slot-2", name: "Bounce", text: "bounce\n", slot: 2 }
        ],
        settings: {}
      },
      "merge"
    );

    const macros = getMacros();
    expect(macros).toHaveLength(2);
    expect(macros.map((m) => getAssignedBinding(m)).sort()).toEqual(["alt+1", "alt+2"]);

    // ...and the converse, which is what makes this a key and not just a wider tuple: a record
    // that already carries the MIGRATED spelling of a slot the store holds is the same macro,
    // so re-importing it adds nothing.
    await runBackupImport(
      {
        version: 2,
        exportType: "backup",
        exportedAt: new Date().toISOString(),
        servers: [],
        tunnels: [],
        serialProfiles: [],
        macros: [{ id: "slot-1-migrated", name: "Bounce", text: "bounce\n", keybinding: "alt+1" }],
        settings: {}
      },
      "merge"
    );
    expect(getMacros()).toHaveLength(2);
  });

  it("Fix A — backup restore strips the trigger even when every declared variable entry is invalid", async () => {
    // codex noted the existing round-trip test above has no variables-plus-trigger
    // macro, so it can't detect a regression here: this goes through the same
    // collectIncomingMacros() path (version-2 top-level `macros` array) with a
    // macro whose only declaration is invalid. Before Fix A, sanitization deleted
    // the (all-invalid) `variables` array and then keyed the §6.2 trigger-strip on
    // the surviving (now empty) array, leaving the trigger live on import.
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [
        { name: "Password", text: "hunter2\n", triggerPattern: "[Pp]assword:", variables: [{ name: "2bad" }] }
      ],
      settings: {}
    };

    const importStore = new InMemoryMacroStore();
    await importStore.initialize();
    setActiveMacroStore(importStore);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup-allbad.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const macros = importStore.getAll();
    const password = macros.find((m) => m.name === "Password");
    expect(password).toBeDefined();
    expect(password?.variables).toBeUndefined();
    expect(password?.triggerPattern).toBeUndefined();
  });

  it("Fix A — backup restore strips the trigger when variables is a malformed non-array", async () => {
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [
        { name: "Password", text: "hunter2\n", triggerPattern: "[Pp]assword:", variables: "abc" },
        {
          name: "PasswordArrayLike",
          text: "hunter2\n",
          triggerPattern: "[Pp]assword:",
          variables: { 0: { name: "password", secret: true, default: "hunter2" }, length: 1 }
        }
      ],
      settings: {}
    };

    const importStore = new InMemoryMacroStore();
    await importStore.initialize();
    setActiveMacroStore(importStore);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup-malformed.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const macros = importStore.getAll();
    const stringShape = macros.find((m) => m.name === "Password");
    expect(stringShape?.variables).toBeUndefined();
    expect(stringShape?.triggerPattern).toBeUndefined();

    const arrayLikeShape = macros.find((m) => m.name === "PasswordArrayLike");
    expect(arrayLikeShape?.variables).toBeUndefined();
    expect(arrayLikeShape?.triggerPattern).toBeUndefined();
  });

  it("Fix 5c — replace mode clears macroFolders when the backup predates the field (pre-2.8.75)", async () => {
    // A pre-2.8.75 backup has no `macroFolders` key at all (`undefined`, not
    // `[]`). Replace mode unconditionally replaces the macros array via
    // `saveMacros()` below — leaving the OLD store's folder list untouched
    // would show folders left over from a config the import just discarded.
    const importStore = new InMemoryMacroStore();
    await importStore.initialize();
    await importStore.save([{ name: "Stale", text: "t", group: "Cisco" }]);
    await importStore.saveFolders(["Cisco", "Empty"]);
    setActiveMacroStore(importStore);

    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [{ name: "Fresh", text: "echo hi" }],
      settings: {}
      // no macroFolders — pre-2.8.75 shape
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup-no-folders.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(importStore.getAll().map((m) => m.name)).toEqual(["Fresh"]);
    // Before Fix 5c this stayed ["Cisco", "Empty"] — folders from the
    // discarded config, dangling after the macros they belonged to were wiped.
    expect(importStore.getFolders()).toEqual([]);
  });

  it("replace mode leaves macro folders alone when the payload replaces no macros at all (servers-only backup)", async () => {
    // Fix 5c cleared the folder list on EVERY replace import, justified by
    // "saveMacros() below unconditionally replaces the macros array". It does
    // not: `collectIncomingMacros()` returns undefined for a payload with
    // neither a top-level `macros` array nor `settings["nexus.terminal.macros"]`,
    // and the macros block is skipped entirely. `isValidExport()` accepts
    // exactly that shape (macros are optional), so replace-importing a
    // servers-only or pre-macro-export backup kept every macro and destroyed
    // every explicit empty folder — the one artifact this feature exists to
    // persist.
    //
    // The Fix 5c fixture above cannot see this: its payload HAS a macros array,
    // so the clear it asserts is correct there and both implementations agree.
    const importStore = new InMemoryMacroStore();
    await importStore.initialize();
    await importStore.save([{ name: "Kept", text: "t", group: "Cisco" }]);
    await importStore.saveFolders(["Cisco", "Staging"]);
    setActiveMacroStore(importStore);

    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [makeServer()],
      settings: {}
      // no `macros`, no `macroFolders` — a pre-macro-export backup
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup-servers-only.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    // Nothing replaced the macros, so nothing should have cleared their folders.
    expect(importStore.getAll().map((m) => m.name)).toEqual(["Kept"]);
    expect(importStore.getFolders().sort()).toEqual(["Cisco", "Staging"]);
  });

  it("shows error on wrong password", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");
    const encrypted = encrypt(JSON.stringify({ passwords: {}, passphrases: {}, secretMacros: [] }), "correct");

    const exportData = makeExportData({ exportType: "backup", encryptedSecrets: encrypted });

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("wrong");

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(configStore.get("nexus.scripts.path")).toBe("/tmp/redirected-scripts");
    expect((mockWriteFile.mock.calls[0][0] as { fsPath: string }).fsPath).toBe("/workspace/.nexus/scripts/hello.js");
  });

  it("merge-mode import does not overwrite a retained server's vault password with the backup's; a newly-imported server's password still restores; replace mode restores everything (kills restoreSecrets()'s pre-fix unconditional write)", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");

    // A local server "s1" already exists, with its own working vault password.
    await core.addOrUpdateServer(makeServer({ id: "s1", name: "Local Server" }));
    await vault.store("password-s1", "local-pw");

    // Backup carries the SAME server id (s1, with a different password — simulating a stale
    // backup) plus a server that doesn't exist locally yet (s2).
    const secrets = {
      passwords: { s1: "backup-pw", s2: "new-pw" },
      passphrases: {}
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [
        makeServer({ id: "s1", name: "Backup Server" }),
        makeServer({ id: "s2", name: "New Server" })
      ],
      tunnels: [],
      serialProfiles: [],
      encryptedSecrets
    };

    // --- Merge mode: importPreservingIds skips s1 (id already exists locally) and imports s2
    // (new). The secret restore must follow the same split: s1's vault password is left alone,
    // s2's is restored.
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Merge", value: "merge" }); // import mode

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getServer("s1")?.name).toBe("Local Server"); // config retained
    expect(await vault.get("password-s1")).toBe("local-pw"); // secret NOT overwritten
    expect(await vault.get("password-s2")).toBe("new-pw"); // newly-imported server restored

    // --- Replace mode: the existing s1 is removed and every backup server (re)imported — both
    // s1 and s2 land in importedIds and both secrets restore — s1's password IS overwritten.
    registeredCommands.clear();
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1");
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" });
    registerConfigCommands(core, vault);

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getServer("s1")?.name).toBe("Backup Server");
    expect(await vault.get("password-s1")).toBe("backup-pw");
    expect(await vault.get("password-s2")).toBe("new-pw");
  });

  it("merge-mode import does not overwrite a retained auth profile's vault password with the backup's; a newly-imported profile's password still restores; replace mode restores everything (kills restoreSecrets()'s pre-fix unconditional write)", async () => {
    const { encrypt } = await import("../../src/utils/configCrypto");

    // A local auth profile "ap1" already exists, with its own working vault password.
    await core.addOrUpdateAuthProfile(makeAuthProfile({ id: "ap1", name: "Local Profile" }));
    await vault.store("auth-profile-password-ap1", "local-pw");

    // Backup carries the SAME profile id (ap1, with a different password) plus a profile that
    // doesn't exist locally yet (ap2).
    const secrets = {
      passwords: {},
      passphrases: {},
      authProfilePasswords: { ap1: "backup-pw", ap2: "new-pw" }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const exportData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [
        makeAuthProfile({ id: "ap1", name: "Backup Profile" }),
        makeAuthProfile({ id: "ap2", name: "New Profile" })
      ],
      encryptedSecrets
    };

    // --- Merge mode: importPreservingIds skips ap1 (id already exists locally) and imports
    // ap2 (new). The secret restore must follow the same split: ap1's vault password is left
    // alone, ap2's is restored.
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Merge", value: "merge" }); // import mode

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getSnapshot().authProfiles.find((p) => p.id === "ap1")?.name).toBe("Local Profile"); // config retained
    expect(await vault.get("auth-profile-password-ap1")).toBe("local-pw"); // secret NOT overwritten
    expect(await vault.get("auth-profile-password-ap2")).toBe("new-pw"); // newly-imported profile restored

    // --- Replace mode: the existing ap1 is removed and every backup profile (re)imported —
    // both ap1 and ap2 land in importedIds and both secrets restore — ap1's password IS
    // overwritten.
    registeredCommands.clear();
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(exportData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1");
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" });
    registerConfigCommands(core, vault);

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getSnapshot().authProfiles.find((p) => p.id === "ap1")?.name).toBe("Backup Profile");
    expect(await vault.get("auth-profile-password-ap1")).toBe("backup-pw");
    expect(await vault.get("auth-profile-password-ap2")).toBe("new-pw");
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const macros = shareImportStore.getAll();
    expect(macros.map(m => m.name)).toContain("hello");
    expect(macros.find(m => m.name === "hello")?.text).toBe("hi");
  });

  it("share import survives a local macro whose `keybinding` is not a string", async () => {
    // The share path builds the same content key over the same two sides as merge does
    // (`existing.map(keyOf)`, then `keyOf()` per incoming record), so the third and last place
    // a non-string binding used to throw is here. The local record is the reachable half:
    // legacy absorption persists a hand-written `nexus.terminal.macros` verbatim, and nothing
    // between there and here type-checks the field. Every non-string JSON type is covered on both
    // sides for the reason the backup test gives: a guard that handled only the plausible NUMBER
    // still throws on `true` or `{}`, and nothing upstream stops either from arriving.
    const shareImportStore = new InMemoryMacroStore();
    await shareImportStore.initialize();
    await shareImportStore.save([
      { name: "Local", text: "local\n", keybinding: 1 },
      { name: "LocalBool", text: "local\n", keybinding: true },
      { name: "LocalObj", text: "local\n", keybinding: { key: "alt+9" } },
      { name: "LocalArr", text: "local\n", keybinding: ["alt+9"] }
    ] as unknown as TerminalMacro[]);
    setActiveMacroStore(shareImportStore);

    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      macros: [
        { name: "Shared", text: "shared\n", keybinding: 2 },
        { name: "SharedBool", text: "shared\n", keybinding: false },
        { name: "SharedObj", text: "shared\n", keybinding: { key: "alt+8" } },
        { name: "SharedArr", text: "shared\n", keybinding: ["alt+8"] }
      ],
      settings: {}
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-binding.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    await registeredCommands.get("nexus.config.import")!();

    const macros = shareImportStore.getAll();
    expect(macros.map((m) => m.name).sort()).toEqual([
      "Local", "LocalArr", "LocalBool", "LocalObj", "Shared", "SharedArr", "SharedBool", "SharedObj"
    ]);
    expect(macros.map((m) => getAssignedBinding(m))).toEqual(new Array(8).fill(undefined));
    expect(macros.filter((m) => m.name.startsWith("Shared")).map((m) => m.keybinding)).toEqual([
      undefined, undefined, undefined, undefined
    ]);
  });

  it("share import sanitizes variables — a masked variable's plaintext default never reaches the store", async () => {
    const macroStore = new InMemoryMacroStore();
    await macroStore.initialize();
    setActiveMacroStore(macroStore);

    // A share file is untrusted input from another machine. The editor blocks a
    // default on a masked variable, but nothing stops a hand-written share file
    // carrying one — and it would then sit in globalState and be picked up by
    // "Copy All as JSON".
    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      macros: [
        {
          name: "Login",
          text: "login $password\n",
          variables: [{ name: "password", secret: true, default: "hunter2" }]
        },
        {
          // Variables + auto-trigger is unsupported: the trigger must be stripped,
          // the declarations kept (§6.2).
          name: "Both",
          text: "connect $host\n",
          triggerPattern: "[Pp]assword:\\s*$",
          variables: [{ name: "host" }]
        },
        {
          name: "Malformed",
          text: "run $ok\n",
          variables: [{ name: "2bad" }, { name: "ok" }, { name: "ok" }]
        }
      ]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-hostile.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    await registeredCommands.get("nexus.config.import")!();

    const macros = macroStore.getAll();
    const login = macros.find((m) => m.name === "Login")!;
    expect(login.variables?.[0]).toEqual({ name: "password", secret: true });
    expect(JSON.stringify(macros)).not.toContain("hunter2");

    const both = macros.find((m) => m.name === "Both")!;
    expect(both.triggerPattern).toBeUndefined();
    expect(both.variables?.map((v) => v.name)).toEqual(["host"]);

    const malformed = macros.find((m) => m.name === "Malformed")!;
    expect(malformed.variables?.map((v) => v.name)).toEqual(["ok"]);
  });

  it("Fix A — share import strips the trigger even when every declared variable entry is invalid", async () => {
    // Share exports never carry secret macros (importShareData filters `!m.secret`
    // before sanitizing), so this uses a non-secret stand-in for the
    // `{secret: true, ...}` example in the fix's rationale — the trigger-strip
    // logic under test is identical either way.
    const macroStore = new InMemoryMacroStore();
    await macroStore.initialize();
    setActiveMacroStore(macroStore);

    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      macros: [
        { name: "Password", text: "hunter2\n", triggerPattern: "[Pp]assword:", variables: [{ name: "2bad" }] }
      ]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-allbad.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    await registeredCommands.get("nexus.config.import")!();

    const macros = macroStore.getAll();
    const password = macros.find((m) => m.name === "Password");
    expect(password).toBeDefined();
    expect(password?.variables).toBeUndefined();
    expect(password?.triggerPattern).toBeUndefined();
  });

  it("Fix A — share import strips the trigger when variables is a malformed non-array or array-like value", async () => {
    const macroStore = new InMemoryMacroStore();
    await macroStore.initialize();
    setActiveMacroStore(macroStore);

    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      macros: [
        { name: "Password", text: "hunter2\n", triggerPattern: "[Pp]assword:", variables: "abc" },
        {
          name: "PasswordArrayLike",
          text: "hunter2\n",
          triggerPattern: "[Pp]assword:",
          variables: { 0: { name: "password", secret: true, default: "hunter2" }, length: 1 }
        }
      ]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-malformed.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    await registeredCommands.get("nexus.config.import")!();

    const macros = macroStore.getAll();
    const stringShape = macros.find((m) => m.name === "Password");
    expect(stringShape?.variables).toBeUndefined();
    expect(stringShape?.triggerPattern).toBeUndefined();

    const arrayLikeShape = macros.find((m) => m.name === "PasswordArrayLike");
    expect(arrayLikeShape?.variables).toBeUndefined();
    expect(arrayLikeShape?.triggerPattern).toBeUndefined();
  });

  it("regression guard — share import keeps the trigger on a macro with no variables key at all", async () => {
    const macroStore = new InMemoryMacroStore();
    await macroStore.initialize();
    setActiveMacroStore(macroStore);

    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      macros: [{ name: "Router", text: "show version\n", triggerPattern: "router#" }]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-legit-trigger.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    await registeredCommands.get("nexus.config.import")!();

    const macros = macroStore.getAll();
    const router = macros.find((m) => m.name === "Router");
    expect(router?.triggerPattern).toBe("router#");
    expect(router?.variables).toBeUndefined();
  });

  it("keyOf includes declared variable names — two macros differing only in variables are NOT deduped (§10)", async () => {
    const macroStore = new InMemoryMacroStore();
    await macroStore.initialize();
    await macroStore.save([{ id: "existing-1", name: "cmd", text: "run\n" }]);
    setActiveMacroStore(macroStore);

    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      macros: [{ name: "cmd", text: "run\n", variables: [{ name: "host" }] }]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-vars.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const macros = macroStore.getAll();
    expect(macros).toHaveLength(2); // NOT collapsed — variables make the key distinct
    expect(macros.filter((m) => m.name === "cmd")).toHaveLength(2);
    expect(macros.some((m) => Array.isArray(m.variables) && m.variables[0]?.name === "host")).toBe(true);
    expect(macros.some((m) => m.variables === undefined)).toBe(true);
  });

  it("keyOf treats a macro with identical variables as a true duplicate on share-import merge", async () => {
    const macroStore = new InMemoryMacroStore();
    await macroStore.initialize();
    await macroStore.save([{ id: "existing-1", name: "cmd", text: "run\n", variables: [{ name: "host" }] }]);
    setActiveMacroStore(macroStore);

    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      macros: [{ name: "cmd", text: "run\n", variables: [{ name: "host" }] }]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-vars-dup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const macros = macroStore.getAll();
    expect(macros).toHaveLength(1); // deduped — same name/text/trigger/keybinding/variables
  });

  it("Fix 2 — two entries in one share file that differ before sanitization but collide after it are deduped, not both stored", async () => {
    const macroStore = new InMemoryMacroStore();
    await macroStore.initialize();
    setActiveMacroStore(macroStore);

    const shareData = {
      version: 2,
      exportType: "share",
      exportedAt: new Date().toISOString(),
      servers: [],
      macros: [
        // Carries an extra invalid-named variable that sanitization drops —
        // pre-sanitization this differs from the second entry, post-sanitization
        // it is identical (same name/text/trigger/keybinding/variables=["host"]).
        {
          name: "cmd",
          text: "run\n",
          variables: [{ name: "host" }, { name: "2bad" }]
        },
        {
          name: "cmd",
          text: "run\n",
          variables: [{ name: "host" }]
        }
      ]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-intra-file-dup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(shareData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const macros = macroStore.getAll();
    expect(macros).toHaveLength(1); // NOT two — the second entry collides with the first post-sanitization
    expect(macros[0].variables?.map((v) => v.name)).toEqual(["host"]);
  });
});

describe("legacy macro absorption with variables present (§10 — keyOfLegacy)", () => {
  beforeEach(() => {
    configStore.clear();
  });

  function makeLegacyMacroStoreContext() {
    const stateMap = new Map<string, unknown>();
    const secretMap = new Map<string, string>();
    return {
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
        async delete(k: string): Promise<void> { secretMap.delete(k); },
        // Present because `engines.vscode` is `^1.105.0`, where `SecretStorage.keys()` is
        // finalized. `VscodeMacroStore.clearAll()` calls it unconditionally.
        async keys(): Promise<string[]> { return [...secretMap.keys()]; }
      }
    } as unknown as import("vscode").ExtensionContext;
  }

  it("keyOfLegacy includes variable names — legacy macros differing only in variables are both absorbed, not deduped", async () => {
    configStore.set("nexus.terminal.macros", [
      { name: "cmd", text: "run\n" },
      { name: "cmd", text: "run\n", variables: [{ name: "host" }] }
    ]);

    const fakeCtx = makeLegacyMacroStoreContext();
    const macroStore = new VscodeMacroStore(fakeCtx);
    await macroStore.initialize();

    const macros = macroStore.getAll();
    expect(macros).toHaveLength(2); // both absorbed — variables make the legacy key distinct
    expect(macros.some((m) => m.variables === undefined)).toBe(true);
    expect(macros.some((m) => Array.isArray(m.variables) && m.variables[0]?.name === "host")).toBe(true);
  });

  it("keyOfLegacy still dedupes a truly identical legacy macro (same variables) on re-absorption", async () => {
    configStore.set("nexus.terminal.macros", [{ name: "cmd", text: "run\n", variables: [{ name: "host" }] }]);

    const fakeCtx = makeLegacyMacroStoreContext();
    let macroStore = new VscodeMacroStore(fakeCtx);
    await macroStore.initialize();
    expect(macroStore.getAll()).toHaveLength(1);

    // Simulate the legacy setting reappearing (Settings Sync replay) with the SAME entry.
    configStore.set("nexus.terminal.macros", [{ name: "cmd", text: "run\n", variables: [{ name: "host" }] }]);
    macroStore = new VscodeMacroStore(fakeCtx);
    await macroStore.initialize();
    expect(macroStore.getAll()).toHaveLength(1); // not duplicated
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

  it("does not call hasSecureCrtSessionsRoot when the parse already found a session — no redundant re-validate+re-parse (Finding 6)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/SecureCRTSessions.xml", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from(
      `<VanDyke><key name="Sessions"><key name="Srv"><dword name="Is Session">1</dword><string name="Protocol Name">SSH2</string><string name="Hostname">srv.example.com</string></key></key></VanDyke>`,
      "utf8"
    ));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(1);
    expect(mockHasSecureCrtSessionsRoot).not.toHaveBeenCalled();
  });

  it("does not call hasSecureCrtSessionsRoot when the parse result is non-empty but every session was skipped (Finding 6)", async () => {
    // Sessions root present, one non-SSH entry skipped — skippedCount > 0 already
    // proves the root exists, so the extra validate+parse pass would be pure waste.
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
    expect(mockHasSecureCrtSessionsRoot).not.toHaveBeenCalled();
  });

  it("still calls hasSecureCrtSessionsRoot to distinguish 'not a SecureCRT export' from 'valid, fully empty export' only when the parse is fully empty (Finding 6)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/other.xml", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from(`<VanDyke><key name="Security"/></VanDyke>`, "utf8"));

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "This XML isn't a SecureCRT export — expected a <VanDyke> document with a Sessions section. In SecureCRT, use Tools → Export Settings."
    );
    expect(mockHasSecureCrtSessionsRoot).toHaveBeenCalledTimes(1);
  });

  it("shows the unsupported-input error for a selected directory, not an extension check (Finding 2)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/not-a-file", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 2 }); // Directory, not File — the only case this arm now rejects

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      "Unsupported SecureCRT input. Select a SecureCRT XML export file or Sessions folder."
    );
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("a non-XML file with non-XML content gets the content-based parse error, not the old extension gate (Finding 2)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "SecureCRT XML Export File (.xml)", value: "xml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/not-securecrt.txt", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from("just some plain text, not xml at all", "utf8"));

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    // The file IS read now — extension is no longer the gate — and rejected on content.
    expect(mockReadFile).toHaveBeenCalled();
    expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Failed to parse SecureCRT XML"));
  });

  // The exact regression the "All Files" filter (Finding 2 in the review) was added
  // for: a user who renamed their SecureCRT export still gets to import it via the
  // chooser's "SecureCRT XML Export…" row, instead of a dead end from an extension
  // check that content validation (parseSecureCrtXmlExport / hasSecureCrtSessionsRoot)
  // already makes redundant.
  it("imports a renamed SecureCRT export whose extension isn't .xml, picked via the chooser's SecureCRT XML Export… row (Finding 2)", async () => {
    mockShowQuickPick.mockResolvedValueOnce({ value: "securecrtXml" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/SecureCRT-export.txt", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1 });
    mockReadFile.mockResolvedValue(Buffer.from(
      `<VanDyke><key name="Sessions"><key name="Srv"><dword name="Is Session">1</dword><string name="Protocol Name">SSH2</string><string name="Hostname">srv.example.com</string></key></key></VanDyke>`,
      "utf8"
    ));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(mockShowErrorMessage).not.toHaveBeenCalled();
    expect(core.getSnapshot().servers).toHaveLength(1);
    expect(core.getSnapshot().servers[0].host).toBe("srv.example.com");
  });

  it("does nothing when user cancels source picker", async () => {
    mockShowQuickPick.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.securecrt")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });
});

describe("import inventory list command", () => {
  let core: NexusCore;
  let vault: MockVault;
  let repo: InMemoryConfigRepository;

  async function flushMicrotasks(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    vault = new MockVault();
    repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);
  });

  it("registers nexus.config.import.inventory", () => {
    expect(registeredCommands.has("nexus.config.import.inventory")).toBe(true);
  });

  it("imports servers pasted from the clipboard, skipping prompts the list already answers", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue(
      "10.0.0.1,core-sw1,netadmin,22,DC1/Core\n10.0.0.2,core-sw2,netadmin,22,DC1/Core\n"
    );
    mockShowInformationMessage.mockResolvedValue("Import");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockClipboardReadText).toHaveBeenCalled();
    // Every row has an explicit username and its own folder — neither prompt is needed.
    expect(mockShowInputBox).not.toHaveBeenCalled();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(2);
    expect(snapshot.servers[0]).toMatchObject({
      host: "10.0.0.1",
      name: "core-sw1",
      username: "netadmin",
      port: 22,
      group: "DC1/Core"
    });
    expect(snapshot.servers[0].authType).toBe("password");
    expect(snapshot.explicitGroups).toContain("DC1/Core");
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 2 servers.");
  });

  it("reads the file chosen in the open dialog and prompts for a folder when the list has none of its own", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Choose File…", value: "file" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/inventory.csv", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from("Host,User\nsw1.lab.example.com,admin\n", "utf8"));
    mockShowInputBox.mockResolvedValue(""); // Enter with no text: skip the prefix
    mockShowInformationMessage.mockResolvedValue("Import");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowOpenDialog).toHaveBeenCalled();
    expect(mockReadFile).toHaveBeenCalledWith({ fsPath: "/fake/inventory.csv", scheme: "file" });
    expect(mockShowInputBox).toHaveBeenCalledTimes(1); // only the folder prompt; username was explicit
    expect(mockShowInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Folder for Imported Servers (Optional)" })
    );

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0]).toMatchObject({ host: "sw1.lab.example.com", username: "admin", name: "sw1", port: 22 });
  });

  it("prompts for a default username, stating how many rows need it, then for a folder", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com\nsw2.lab.example.com\n");
    mockShowInputBox.mockResolvedValueOnce("netadmin"); // default username prompt
    mockShowInputBox.mockResolvedValueOnce(""); // folder prompt: skip
    mockShowInformationMessage.mockResolvedValue("Import");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowInputBox).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "Default SSH Username",
        prompt: "Applied to the 2 rows that don't specify a username"
      })
    );
    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(2);
    expect(snapshot.servers.every((s) => s.username === "netadmin")).toBe(true);
  });

  it("skips the folder prompt entirely when the list already carries its own folder data", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin,,RackA\n");
    mockShowInformationMessage.mockResolvedValue("Import");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowInputBox).not.toHaveBeenCalled();
    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBe("RackA");
    expect(snapshot.explicitGroups).toContain("RackA");
  });

  it("applies the folder prefix when the list has no folder data of its own", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\n");
    mockShowInputBox.mockResolvedValueOnce("Site7"); // folder prompt; no username prompt needed
    mockShowInformationMessage.mockResolvedValue("Import");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers[0].group).toBe("Site7");
    expect(snapshot.explicitGroups).toContain("Site7");
  });

  it("Esc on the folder prompt cancels the whole import, not just the prefix", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\n");
    mockShowInputBox.mockResolvedValueOnce(undefined); // Esc
    mockShowWarningMessage.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowWarningMessage).toHaveBeenCalledWith("Import canceled.");
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("rejects an invalid folder prefix instead of silently discarding it", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\n");
    mockShowInputBox.mockResolvedValueOnce("Site7\\Access"); // Windows-style separator, rejected
    mockShowErrorMessage.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(INVALID_FOLDER_PATH_MESSAGE);
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("skips rows that duplicate an existing server and reports the count in the confirm modal", async () => {
    await core.addOrUpdateServer(
      makeServer({ id: "existing1", host: "sw1.lab.example.com", port: 22, username: "admin" })
    );

    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue(
      "sw1.lab.example.com,,admin\nsw2.lab.example.com,,admin\n"
    );
    mockShowInputBox.mockResolvedValue("");
    mockShowInformationMessage.mockResolvedValue("Import");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(2); // the pre-existing one + the new sw2
    expect(snapshot.servers.filter((s) => s.host === "sw1.lab.example.com")).toHaveLength(1);
    expect(snapshot.servers.filter((s) => s.host === "sw2.lab.example.com")).toHaveLength(1);
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "Import 1 server?",
      expect.objectContaining({ modal: true, detail: expect.stringContaining("1 server you already have will be skipped.") }),
      "Import"
    );
  });

  it("reports an unambiguous message when every row is already in the list, instead of a contradiction", async () => {
    await core.addOrUpdateServer(
      makeServer({ id: "existing1", host: "sw1.lab.example.com", port: 22, username: "admin" })
    );

    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\n");
    mockShowInputBox.mockResolvedValue("");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "All 1 server in the list already exists — nothing to import."
    );
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith("No servers found in the selected list.");
    expect(core.getSnapshot().servers).toHaveLength(1); // unchanged
  });

  it("does not block the import behind the post-import issues toast (P1)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\nbad host name\n");
    mockShowInputBox.mockResolvedValue("");
    mockShowInformationMessage.mockResolvedValue("Import");
    // A notification with a button never auto-dismisses; simulate the user
    // ignoring it entirely by never resolving the promise. If the command still
    // awaited this the way it used to, `await cmd()` below would hang forever.
    mockShowWarningMessage.mockReturnValue(new Promise(() => {}));

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(1);
  });

  it("shows one confirm modal with a detail breakdown and a Show Skipped Lines escape hatch (P2)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\nbad host name\n");
    mockShowInputBox.mockResolvedValue("");
    mockShowInformationMessage.mockResolvedValue("Import");
    mockShowWarningMessage.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "Import 1 server?",
      expect.objectContaining({ modal: true, detail: expect.stringContaining("1 line could not be parsed.") }),
      "Import",
      "Show Skipped Lines"
    );
  });

  it("Show Skipped Lines opens the scratch document without importing anything (P2)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\nbad host name\n");
    mockShowInputBox.mockResolvedValue("");
    mockShowInformationMessage.mockResolvedValue("Show Skipped Lines");
    mockOpenTextDocument.mockResolvedValue({ uri: { fsPath: "untitled:issues" } });

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockOpenTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("line 2: bad host name"), language: "log" })
    );
    expect(mockShowTextDocument).toHaveBeenCalled();
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("shows a non-awaited trailing toast for skipped lines after a successful import (P1/P2)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\nbad host name\n");
    mockShowInputBox.mockResolvedValue("");
    mockShowInformationMessage.mockResolvedValue("Import");
    mockShowWarningMessage.mockResolvedValue("Show Details");
    mockOpenTextDocument.mockResolvedValue({ uri: { fsPath: "untitled:issues" } });

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();
    await flushMicrotasks();

    expect(core.getSnapshot().servers).toHaveLength(1);
    expect(mockShowWarningMessage).toHaveBeenCalledWith("1 line was skipped.", "Show Details");
    expect(mockOpenTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("line 2: bad host name"), language: "log" })
    );
  });

  it("wraps the apply step in a non-cancellable progress notification and writes once (Codex round 4 finding B: the Cancel button couldn't actually stop the write, so it's no longer offered)", async () => {
    const saveServersSpy = vi.spyOn(repo, "saveServers");
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("sw1.lab.example.com,,admin\nsw2.lab.example.com,,admin\n");
    mockShowInputBox.mockResolvedValue("");
    mockShowInformationMessage.mockResolvedValue("Import");
    saveServersSpy.mockClear();

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({ cancellable: false, title: expect.stringContaining("Importing 2 servers") })
    );
    expect(saveServersSpy).toHaveBeenCalledTimes(1); // one write for the whole batch, not one per row
    expect(core.getSnapshot().servers).toHaveLength(2);
    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 2 servers.");
  });

  it("does not create an empty folder group for a folder whose only row was deduped (P9)", async () => {
    await core.addOrUpdateServer(
      makeServer({ id: "existing1", host: "sw1.lab.example.com", port: 22, username: "admin", group: "DC1/Core" })
    );
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue(
      "sw1.lab.example.com,,admin,,DC1/Core\nsw2.lab.example.com,,admin\n"
    );
    mockShowInformationMessage.mockResolvedValue("Import");

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(core.getSnapshot().explicitGroups).not.toContain("DC1/Core");
  });

  it("aborts silently when the user cancels the source pick", async () => {
    mockShowQuickPick.mockResolvedValue(undefined);

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(mockClipboardReadText).not.toHaveBeenCalled();
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });

  it("rejects an over-limit clipboard paste via the post-decode backstop check", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Paste from Clipboard", value: "clipboard" });
    mockClipboardReadText.mockResolvedValue("a".repeat(2 * 1024 * 1024 + 1));

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("The list exceeds the 2 MB size limit.");
    expect(core.getSnapshot().servers).toHaveLength(0);
  });

  it("rejects an over-limit file via stat before reading it (Codex round 2 finding C)", async () => {
    mockShowQuickPick.mockResolvedValue({ label: "Choose File…", value: "file" });
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/big.csv", scheme: "file" }]);
    mockStat.mockResolvedValue({ type: 1, size: 2 * 1024 * 1024 + 1 });

    const cmd = registeredCommands.get("nexus.config.import.inventory")!;
    await cmd();

    expect(mockShowErrorMessage).toHaveBeenCalledWith("The list exceeds the 2 MB size limit.");
    expect(core.getSnapshot().servers).toHaveLength(0);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("keeps the existing 'non-SSH skipped' wording for the MobaXterm importer", async () => {
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
  });

  it("pluralizes the MobaXterm import summary without the '(s)' shorthand", async () => {
    const ini = `[Bookmarks_1]
SubRep=
ImgNum=42
Server=#109#0%host.test%22%user%%-1%
`;
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/mobafile.ini", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(ini, "utf8"));
    mockShowInformationMessage.mockResolvedValueOnce("Import");

    const cmd = registeredCommands.get("nexus.config.import.mobaxterm")!;
    await cmd();

    expect(mockShowInformationMessage).toHaveBeenCalledWith("Imported 1 SSH session from MobaXterm.");
  });
});

describe("sanitizeForSharing", () => {
  it("generates fresh IDs and sanitizes user fields", () => {
    const servers = [makeServer({ username: "alice", keyPath: "/home/alice/.ssh/id_rsa" })];
    const tunnels = [makeTunnel({ defaultServerId: "s1" })];
    const serialProfiles = [makeSerialProfile({ deviceHint: { serialNumber: "ABC123", vendorId: "1111", productId: "2222" } })];
    const localShellProfiles = [makeLocalShellProfile({ cwd: "/home/alice/project", startupCommand: "npm run dev" })];
    const settings: Record<string, unknown> = {
      "nexus.logging.sessionLogDirectory": "/home/alice/logs"
    };
    const macrosArg = [
      { id: "m1", name: "public", text: "echo hi" },
      { id: "m2", name: "secret", text: "password123", secret: true }
    ];

    const result = sanitizeForSharing(servers, tunnels, serialProfiles, localShellProfiles, settings, [], macrosArg);

    expect(result.servers[0].id).not.toBe("s1");
    expect(result.servers[0].username).toBe("user");
    expect(result.servers[0].keyPath).toBe("");

    expect(result.tunnels[0].id).not.toBe("t1");
    expect(result.tunnels[0].defaultServerId).toBe(result.servers[0].id);

    expect(result.serialProfiles[0].id).not.toBe("sp1");
    expect(result.serialProfiles[0].deviceHint).toBeUndefined();
    expect(result.localShellProfiles[0].id).not.toBe("local1");
    expect(result.localShellProfiles[0].cwd).toBeUndefined();
    expect(result.localShellProfiles[0].startupCommand).toBeUndefined();

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
    const result = sanitizeForSharing(servers, tunnels, [], [], {});
    expect(result.tunnels[0].defaultServerId).toBeUndefined();
  });

  it("remaps jump host IDs in proxy config", () => {
    const jumpServer = makeServer({ id: "jump-1", name: "Jump" });
    const targetServer = makeServer({
      id: "target-1",
      name: "Target",
      proxy: { type: "ssh", jumpHostId: "jump-1" }
    });
    const result = sanitizeForSharing([jumpServer, targetServer], [], [], [], {});

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
    const result = sanitizeForSharing([server], [], [], [], {});
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
    const result = sanitizeForSharing([server], [], [], [], {});
    expect(result.servers[0].proxy).toBeUndefined();
  });

  it("returns empty authProfiles when none referenced", () => {
    const result = sanitizeForSharing([makeServer()], [], [], [], {});
    expect(result.authProfiles).toHaveLength(0);
  });

  it("preserves authProfileId link with sanitized auth profile copy", () => {
    const profile = makeAuthProfile({ id: "ap-123", name: "Prod Auth", username: "deploy", keyPath: "/key" });
    const server = makeServer({ authProfileId: "ap-123" });
    const result = sanitizeForSharing([server], [], [], [], {}, [profile]);

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
    const result = sanitizeForSharing([server], [], [], [], {}, [profile]);
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
        async delete(k: string): Promise<void> { secretMap.delete(k); },
        // Present because `engines.vscode` is `^1.105.0`, where `SecretStorage.keys()` is
        // finalized. `VscodeMacroStore.clearAll()` calls it unconditionally.
        async keys(): Promise<string[]> { return [...secretMap.keys()]; }
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

  it("share export then import of that same file adds no macros — with both ends freshening ids, the content key is the only dedupe left", async () => {
    // The whole loop through the REAL commands, on ONE machine with no Settings Sync involved:
    // `nexus.config.export` writes a share file with a fresh id per macro, `nexus.config.import`
    // freshens every id again on the way in, so no id in the file names anything locally and the
    // content key decides alone. Any field the sanitizer rewrites into a different runtime meaning
    // therefore shows up here as a duplicate — and this one duplicated on THIS BRANCH but not on
    // main, where the key ignored the cooldown entirely and the sanitized copy still matched.
    // Widening the key is what made the sanitizer's deletions load-bearing.
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([
      { id: "local-1", name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerCooldown: 5000 },
      { id: "local-2", name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 0.5 },
      { id: "local-3", name: "Ack", text: "y\n", triggerPattern: "confirm:", triggerCooldown: "5" }
    ] as unknown as TerminalMacro[]);
    setActiveMacroStore(store);

    let exportedJson = "";
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/share-macros.json", scheme: "file" });
    mockWriteFile.mockImplementation((_uri: unknown, data: Buffer) => {
      exportedJson = Buffer.from(data).toString("utf8");
    });
    await registeredCommands.get("nexus.config.export")!();

    // The premise: the file really does carry the stored values verbatim, under other ids.
    const written = JSON.parse(exportedJson);
    expect(written.macros.map((m: TerminalMacro) => m.id)).not.toContain("local-1");
    expect(written.macros[0].triggerCooldown).toBe(5000);
    expect(written.macros[1].triggerInterval).toBe(0.5);
    expect(written.macros[2].triggerCooldown).toBe("5");

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/share-macros.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(exportedJson, "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    await registeredCommands.get("nexus.config.import")!();

    expect(store.getAll().map((m) => m.id)).toEqual(["local-1", "local-2", "local-3"]);
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = destCore.getSnapshot();
    expect(snapshot.authProfiles).toHaveLength(1);
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].authProfileId).toBe(snapshot.authProfiles[0].id);
    expect(snapshot.servers[0].authProfileId).not.toBe("ap1");
  });

  it("B6 — share export carries NO inventorySources key and strips origin from every server (fixture server WITH origin)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    await sourceCore.addOrUpdateInventorySource(makeInventorySource());
    await sourceCore.addOrUpdateServer(
      makeServer({ id: "s1", origin: { sourceId: "src1", externalId: "device:1", syncedAt: 1000 } })
    );

    registerConfigCommands(sourceCore, vault);

    let exportedJson = "";
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/share.json", scheme: "file" });
    mockWriteFile.mockImplementation((_uri: unknown, data: Buffer) => {
      exportedJson = Buffer.from(data).toString("utf8");
    });

    await registeredCommands.get("nexus.config.export")!();

    const exported = JSON.parse(exportedJson);
    expect(exported.inventorySources).toBeUndefined();
    expect(exported.servers).toHaveLength(1);
    expect(exported.servers[0].origin).toBeUndefined();
  });
});

describe("backup export round-trip", () => {
  it("backup export then import preserves explicitly configured settings without invalid warnings", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    configStore.set("nexus.terminal.passthroughKeys", ["b", "q", "w"]);
    configStore.set("nexus.ui.showTreeDescriptions", false);

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

    const exported = JSON.parse(exportedJson);
    expect(exported.version).toBe(2);
    expect(exported.exportType).toBe("backup");
    expect(exported.settings).toEqual({
      "nexus.ui.showTreeDescriptions": false,
      "nexus.terminal.passthroughKeys": ["b", "q", "w"]
    });

    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();

    const destRepo = new InMemoryConfigRepository();
    const destCore = new NexusCore(destRepo);
    await destCore.initialize();
    registerConfigCommands(destCore, vault);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(exportedJson, "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });
    mockShowInputBox.mockResolvedValueOnce("masterpass1");

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    expect(configStore.get("nexus.terminal.passthroughKeys")).toEqual(["b", "q", "w"]);
    expect(configStore.get("nexus.ui.showTreeDescriptions")).toBe(false);
    expect(mockShowWarningMessage).not.toHaveBeenCalledWith(
      "1 imported Nexus setting had an invalid value and was skipped."
    );
  });

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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
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

    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const snapshot = core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].authProfileId).toBeUndefined();
  });

  it("B6 — backup export then import round-trips inventory sources AND their vault secrets under exact keys", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    await sourceCore.addOrUpdateInventorySource(makeInventorySource());
    await vault.store(inventorySecretKey("src1", "apiToken"), "super-secret-token");

    registerConfigCommands(sourceCore, vault);

    mockShowInputBox
      .mockResolvedValueOnce("masterpass1")
      .mockResolvedValueOnce("masterpass1");

    let exportedJson = "";
    mockShowSaveDialog.mockResolvedValue({ fsPath: "/fake/backup.json", scheme: "file" });
    mockWriteFile.mockImplementation((_uri: unknown, data: Buffer) => {
      exportedJson = Buffer.from(data).toString("utf8");
    });

    await registeredCommands.get("nexus.config.export.backup")!();

    const exported = JSON.parse(exportedJson);
    expect(exported.inventorySources).toHaveLength(1);
    expect(exported.inventorySources[0].id).toBe("src1");
    // Secrets must NOT sit in cleartext next to the source record.
    expect(JSON.stringify(exported)).not.toContain("super-secret-token");

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
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…

    await registeredCommands.get("nexus.config.import")!();

    const snapshot = destCore.getSnapshot();
    expect(snapshot.inventorySources).toHaveLength(1);
    expect(snapshot.inventorySources[0].id).toBe("src1");
    expect(snapshot.inventorySources[0].name).toBe("NetBox");
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("super-secret-token");
  });

  it("F12/F14 — merge-mode import does NOT overwrite a locally-existing inventory source with the same id; replace mode does", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateInventorySource(makeInventorySource({ name: "Local Name (edited locally)" }));
    registerConfigCommands(core, vault);

    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [makeInventorySource({ name: "Incoming Name From Backup" })]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Merge", value: "merge" }); // import mode

    await registeredCommands.get("nexus.config.import")!();

    // Merge: the local source (same id) is untouched — a real merge, not a silent overwrite.
    expect(core.getInventorySource("src1")?.name).toBe("Local Name (edited locally)");

    // Now replace mode: the local source IS gone and the incoming one lands.
    registeredCommands.clear();
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" });
    registerConfigCommands(core, vault);

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")?.name).toBe("Incoming Name From Backup");
  });

  it("REVIEW FINDING 2 (P2, imported managedFolders are untrusted) — a backup-imported inventory source has managedFolders stripped at the import boundary, and a later sync re-accumulates ownership normally (kills passthrough)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const vault = new MockVault();

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // A backup carries a source whose managedFolders names a folder it never
    // actually created on THIS machine — e.g. hand-edited, copied from
    // another machine's tree, or simply stale. Without the strip, this would
    // hand the imported source GC authority over "Manual/Staging" and the
    // very next sync could delete it.
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [makeInventorySource({ managedFolders: ["Manual/Staging"] })]
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/untrusted-managed-folders.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode

    await registeredCommands.get("nexus.config.import")!();

    // KILLS PASSTHROUGH: under a wrong implementation that hands the
    // validated record straight to core.addOrUpdateInventorySource, this
    // would be ["Manual/Staging"] — the imported source would already own a
    // folder it never created, ready to be swept on its next sync.
    expect(core.getInventorySource("src1")?.managedFolders).toBeUndefined();

    // The imported record is otherwise intact (only managedFolders is
    // stripped — the strip must not silently drop the whole source).
    expect(core.getInventorySource("src1")?.name).toBe("NetBox");
    expect(core.getInventorySource("src1")?.targetFolder).toBe("NetBox");

    // Re-accumulation path: the imported source's very next sync CREATES a
    // folder and must record ownership of it exactly as any other
    // never-synced source would (see nexusCoreInventory.test.ts's "(legacy
    // source)" case for the underlying mechanism) — the strip is not a
    // permanent handicap, ownership simply re-builds from what this source
    // itself creates going forward.
    const device: ServerConfig = {
      id: "device-1",
      name: "core-sw",
      host: "10.0.0.1",
      port: 22,
      username: "admin",
      authType: "agent",
      isHidden: false,
      group: "NetBox/RackA",
      origin: { sourceId: "src1", externalId: "device:1", syncedAt: 1 }
    };
    await core.applyInventorySyncPlan({
      sourceId: "src1",
      syncedAt: 1,
      upsertServers: [device],
      removeServerIds: [],
      folders: ["NetBox/RackA"],
      expectedSource: core.getInventorySource("src1")!
    });
    expect(core.getInventorySource("src1")?.managedFolders).toEqual(["NetBox/RackA"]);
  });

  it("merge-mode import does not overwrite a retained source's vault secret with the backup's; a newly-imported source's secret still restores; replace mode restores everything", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");
    const vault = new MockVault();

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    // A local source "src1" already exists, with its own working vault token.
    await core.addOrUpdateInventorySource(makeInventorySource({ id: "src1", name: "Local NetBox" }));
    await vault.store(inventorySecretKey("src1", "apiToken"), "local-token");
    registerConfigCommands(core, vault);

    // Backup carries the SAME source id (src1, with a different token — simulating a stale
    // backup) plus a source that doesn't exist locally yet (src2).
    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "backup-token" },
        src2: { apiToken: "new-token" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [
        makeInventorySource({ id: "src1", name: "Backup NetBox" }),
        makeInventorySource({ id: "src2", name: "New Source" })
      ],
      encryptedSecrets
    };

    // --- Merge mode: importPreservingIds skips src1 (id already exists locally) and imports
    // src2 (new). The secret restore must follow the same split: src1's vault token is left
    // alone, src2's is restored.
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Merge", value: "merge" }); // import mode

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")?.name).toBe("Local NetBox"); // config retained
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("local-token"); // secret NOT overwritten
    expect(await vault.get(inventorySecretKey("src2", "apiToken"))).toBe("new-token"); // newly-imported source restored

    // --- Replace mode: every existing source (src1) is removed and every backup source
    // (re)imported — both src1 and src2 pass validateInventorySource, so both land in
    // importedIds and both secrets restore — src1's token IS overwritten.
    registeredCommands.clear();
    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/merge.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1");
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" });
    registerConfigCommands(core, vault);

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")?.name).toBe("Backup NetBox");
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("backup-token");
    expect(await vault.get(inventorySecretKey("src2", "apiToken"))).toBe("new-token");
  });

  it("FINDING 3 — replace-mode restore skips secrets for a source validateInventorySource rejected, even though it never existed locally to be filtered out by an id check (kills the round-2 fix's merge-mode-only importedIds filter)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");
    const vault = new MockVault();

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // src1 is a structurally valid source (imports normally). src2 fails
    // validateInventorySource (bad prunePolicy) and is skipped by importPreservingIds
    // in EVERY mode — merge or replace — so it never lands in core. Both have a
    // backed-up secret; only src1's should be discoverable in the vault afterward.
    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "valid-token" },
        src2: { apiToken: "orphaned-token" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [
        makeInventorySource({ id: "src1", name: "Valid Source" }),
        { ...makeInventorySource({ id: "src2", name: "Invalid Source" }), prunePolicy: "bogus" }
      ],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")?.name).toBe("Valid Source");
    expect(core.getInventorySource("src2")).toBeUndefined(); // rejected by validateInventorySource

    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("valid-token");
    // The invalid source's vault key must not exist at all — not merely "unset", but
    // genuinely absent, since export/removal/reset only ever enumerate persisted sources.
    expect(await vault.get(inventorySecretKey("src2", "apiToken"))).toBeUndefined();
  });

  it("FINDING 2 — restore intersects the secrets bucket with the imported source's own secretFieldIds, so a field the record doesn't declare is never written to the vault (kills the round-3 fix's source-only, unfiltered-field restore)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");
    const vault = new MockVault();

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // The imported src1 record declares only "apiToken" as a secret field. The backup's
    // secrets bucket for src1 also carries "obsoleteToken" — e.g. a field dropped from the
    // provider's config schema since the backup was taken, or hand-edited backup JSON.
    // Nothing can ever enumerate/delete "obsoleteToken" post-import (export/removal/reset
    // all walk secretFieldIds), so it must never be written in the first place.
    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "valid-token", obsoleteToken: "should-never-land" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [makeInventorySource({ id: "src1", name: "NetBox", secretFieldIds: ["apiToken"] })],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")?.name).toBe("NetBox");
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("valid-token");
    expect(await vault.get(inventorySecretKey("src1", "obsoleteToken"))).toBeUndefined();
  });

  it("ROUND 16 FINDING (import review) — a vault.store rejection while restoring one imported source's secrets rolls back only that source (record + any keys already stored this run) and reports it, while another imported source in the same run is left fully intact with its own secret restored (kills persisted-without-secrets — a source record surviving with no credential after a failed restore)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");

    // A custom vault (not MockVault) so `store` can be made to reject for one
    // specific key. Backing map is separate from MockVault's private one so
    // this test can assert on it directly.
    const backingStore = new Map<string, string>();
    const vault: SecretVault = {
      get: vi.fn(async (key: string) => backingStore.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        if (key === inventorySecretKey("src2", "apiSecret")) {
          throw new Error("secret storage unavailable");
        }
        backingStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        backingStore.delete(key);
      })
    };

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // src1 restores cleanly (one secret field). src2 declares TWO secret
    // fields — its first field (apiToken) stores successfully, its second
    // (apiSecret) rejects — so the rollback must delete the already-stored
    // apiToken key back out too, not just skip the field that failed.
    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "src1-token" },
        src2: { apiToken: "src2-token", apiSecret: "src2-secret" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [
        makeInventorySource({ id: "src1", name: "Source One", secretFieldIds: ["apiToken"] }),
        makeInventorySource({ id: "src2", name: "Source Two", secretFieldIds: ["apiToken", "apiSecret"] })
      ],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode — the
    // mode where a stranded, credential-less source is worst: any prior local
    // record with the same id has already been wiped by the time the restore
    // loop runs, so there is nothing to fall back to.
    mockShowWarningMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.config.import")!();

    // src1 is fully present, with its secret restored — the other source's
    // failure did not abort or otherwise affect it.
    expect(core.getInventorySource("src1")?.name).toBe("Source One");
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("src1-token");

    // src2 is rolled back entirely: the record importPreservingIds persisted
    // is gone, and NEITHER of its keys survive in the vault — not the one
    // that failed to store, and not the one that stored successfully just
    // before the failure (a reverted fix that only skips the failed field,
    // or only removes the record without cleaning up the vault, would leave
    // "src2"'s apiToken key stranded here).
    expect(core.getInventorySource("src2")).toBeUndefined();
    expect(await vault.get(inventorySecretKey("src2", "apiToken"))).toBeUndefined();
    expect(await vault.get(inventorySecretKey("src2", "apiSecret"))).toBeUndefined();

    // The import completes (no thrown/rejected command) with a warning
    // naming the source that could not be restored.
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Source "Source Two" could not be restored — its credentials failed to store; re-import or add it manually.'
    );
  });

  it("FINDING 1 (rollback review) — when the rollback's own core.removeInventorySource call ALSO rejects, the source is still live in core (not decremented from the import count) and the warning tells the user to re-enter credentials via Edit Source, not to re-import or add it manually (kills false-success reporting when the removal itself failed)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");

    const backingStore = new Map<string, string>();
    const vault: SecretVault = {
      get: vi.fn(async (key: string) => backingStore.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        if (key === inventorySecretKey("src2", "apiToken")) {
          throw new Error("secret storage unavailable");
        }
        backingStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        backingStore.delete(key);
      })
    };

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // The vault.store rejection above drives the rollback's attempt to remove the
    // just-imported record; make THAT call reject too (e.g. its own persist failed).
    // NexusCore.removeInventorySource restores the record in memory on a persist
    // failure — so the source is genuinely still live in core after this.
    vi.spyOn(core, "removeInventorySource").mockRejectedValueOnce(new Error("disk full"));

    const secrets = {
      inventorySourceSecrets: {
        src2: { apiToken: "src2-token" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [makeInventorySource({ id: "src2", name: "Source Two", secretFieldIds: ["apiToken"] })],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode
    mockShowWarningMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.config.import")!();

    // The source record is still present — this is NOT a successful rollback. A
    // reverted fix (catch swallowed, treated as if removal had succeeded) would
    // report this source as cleanly removed while it in fact still lives in core
    // with a missing credential.
    expect(core.getInventorySource("src2")).toBeDefined();
    expect(core.getInventorySource("src2")?.name).toBe("Source Two");
    expect(await vault.get(inventorySecretKey("src2", "apiToken"))).toBeUndefined();

    // The closing count reflects the source as still imported (not decremented) —
    // a reverted fix decrements it even though the record was never actually removed.
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Imported 1 profile")
    );

    // The warning distinguishes this from a clean rollback: it must point at Edit
    // Source rather than claim the source can be re-imported or added manually.
    const warningCalls = mockShowWarningMessage.mock.calls.map((c) => String(c[0]));
    expect(warningCalls.some((m) => /re-enter.*Edit Source/i.test(m))).toBe(true);
    expect(warningCalls.some((m) => /re-import or add/i.test(m))).toBe(false);
  });

  it("FINDING 2 (rollback review) — a successfully rolled-back source strips origin from the servers THIS RUN imported that named it, leaving a pre-existing (already-manual) server from the same backup untouched, and reports the conversion in the warning (kills orphaned synced-badged servers no re-added source could ever manage again)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");

    const backingStore = new Map<string, string>();
    const vault: SecretVault = {
      get: vi.fn(async (key: string) => backingStore.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        if (key === inventorySecretKey("src1", "apiToken")) {
          throw new Error("secret storage unavailable");
        }
        backingStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        backingStore.delete(key);
      })
    };

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "src1-token" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      // Two servers synced from src1, plus a third that was already a plain manual
      // server when the backup was taken (no origin at all).
      servers: [
        makeServer({ id: "srv-a", name: "Owned A", origin: { sourceId: "src1", externalId: "dev-a", syncedAt: 1 } }),
        makeServer({ id: "srv-b", name: "Owned B", origin: { sourceId: "src1", externalId: "dev-b", syncedAt: 1 } }),
        makeServer({ id: "srv-c", name: "Manual C" })
      ],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [makeInventorySource({ id: "src1", name: "Source One", secretFieldIds: ["apiToken"] })],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode
    mockShowWarningMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.config.import")!();

    // The rolled-back source is gone.
    expect(core.getInventorySource("src1")).toBeUndefined();

    // Both servers this run imported under that source had their origin stripped —
    // a reverted fix leaves them pointing at a source id nothing can ever manage
    // again (a manually re-added source always gets a fresh id).
    expect(core.getServer("srv-a")?.origin).toBeUndefined();
    expect(core.getServer("srv-a")?.name).toBe("Owned A");
    expect(core.getServer("srv-b")?.origin).toBeUndefined();
    expect(core.getServer("srv-b")?.name).toBe("Owned B");

    // The already-manual server from the same backup is untouched.
    expect(core.getServer("srv-c")?.origin).toBeUndefined();
    expect(core.getServer("srv-c")?.name).toBe("Manual C");

    // The warning reports the conversion.
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Source "Source One" could not be restored — its credentials failed to store; re-import or add it manually; 2 of its servers were kept as manual servers.'
    );
  });

  it("FINDING 2 (P2, origin-strip review) — when one of the origin-strip conversions itself rejects, the closing warning reports the successful conversion count AND the failed one separately (kills silent suppression that dropped the failure from the tally entirely)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");

    const backingStore = new Map<string, string>();
    const vault: SecretVault = {
      get: vi.fn(async (key: string) => backingStore.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        if (key === inventorySecretKey("src1", "apiToken")) {
          throw new Error("secret storage unavailable");
        }
        backingStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        backingStore.delete(key);
      })
    };

    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // Two servers are imported under src1's origin. The conversion sweep's SECOND call
    // (srv-b, once its origin has been stripped) rejects — the initial import of the server
    // records themselves (which also goes through addOrUpdateServer, but WITH origin still
    // intact) must succeed normally, so the mock only intercepts the origin-stripped shape.
    const realAddOrUpdateServer = core.addOrUpdateServer.bind(core);
    vi.spyOn(core, "addOrUpdateServer").mockImplementation(async (server: ServerConfig) => {
      if (server.id === "srv-b" && !("origin" in server)) {
        throw new Error("disk full");
      }
      return realAddOrUpdateServer(server);
    });

    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "src1-token" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [
        makeServer({ id: "srv-a", name: "Owned A", origin: { sourceId: "src1", externalId: "dev-a", syncedAt: 1 } }),
        makeServer({ id: "srv-b", name: "Owned B", origin: { sourceId: "src1", externalId: "dev-b", syncedAt: 1 } })
      ],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [makeInventorySource({ id: "src1", name: "Source One", secretFieldIds: ["apiToken"] })],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode
    mockShowWarningMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")).toBeUndefined();

    // srv-a converted cleanly.
    expect(core.getServer("srv-a")?.origin).toBeUndefined();

    // srv-b's conversion attempt rejected, so it never persisted the origin-stripped shape —
    // the server keeps its old origin, pointing at a source that no longer exists (exactly
    // the "may still show a synced badge" case the new warning clause names).
    expect(core.getServer("srv-b")?.origin).toEqual({ sourceId: "src1", externalId: "dev-b", syncedAt: 1 });

    // The warning reports BOTH counts. A reverted fix (catch swallowed with no counting)
    // would call showWarningMessage with the tail truncated after "manual servers." — this
    // exact string only matches when the failure is also surfaced.
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Source "Source One" could not be restored — its credentials failed to store; re-import or add it manually; 1 of its servers were kept as manual servers; 1 servers could not be converted and may still show a synced badge — edit them to clear it.'
    );
  });

  it("FINDING 1 (P2, secrets review) — replace-restoring a backup whose source has no secret bucket at all still imports the source record, but the import warning names it and points at Edit Source (kills silent success — a reverted fix reports a clean import for a source that can never authenticate)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");

    const vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // The backup's decrypted secrets carry no bucket for src1 at all — e.g. the export ran
    // with a locked/unavailable keychain (mirrors the export-side FINDING 1 test above).
    const secrets = {};
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [makeInventorySource({ id: "src1", name: "NetBox", secretFieldIds: ["apiToken"] })],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode
    mockShowWarningMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.config.import")!();

    // The source is imported fine — this is NOT a rollback, and the completion message
    // reports success.
    expect(core.getInventorySource("src1")?.name).toBe("NetBox");
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBeUndefined();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Imported 1 profile"));

    // The warning names the source and points at Edit Source — distinct wording from the two
    // rollback warnings above, since the record itself is fine here. A reverted fix (no
    // post-restore vault check) would leave this source's missing credential completely
    // unsurfaced, reporting only a clean successful import.
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Source "NetBox" was restored with missing credential(s) — re-enter them via Edit Source before syncing.'
    );
  });

  it("FINDING (P2, round-19 review) — a source declaring multiple secretFieldIds warns when only SOME of them made it into the vault (kills the any-present-suppresses-warning bug: one stored field used to mask another missing one)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");

    const vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    // Backup carries a stored value for "apiToken" but nothing for "apiSecret" — the source
    // declares BOTH as required secret fields.
    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "token-value" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [
        makeInventorySource({ id: "src1", name: "NetBox", secretFieldIds: ["apiToken", "apiSecret"] })
      ],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode
    mockShowWarningMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")?.name).toBe("NetBox");
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("token-value");
    expect(await vault.get(inventorySecretKey("src1", "apiSecret"))).toBeUndefined();

    // A reverted fix (warn only when ALL declared fields are absent) would see apiToken
    // present and stay silent — this exact call is only made when the partial-miss case is
    // also caught.
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Source "NetBox" was restored with missing credential(s) — re-enter them via Edit Source before syncing.'
    );
  });

  it("FINDING (P2, round-19 review) — a source declaring multiple secretFieldIds does NOT warn when ALL of them are present (guards against over-warning on a clean multi-field restore)", async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const { encrypt } = await import("../../src/utils/configCrypto");

    const vault = new MockVault();
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core, vault);

    const secrets = {
      inventorySourceSecrets: {
        src1: { apiToken: "token-value", apiSecret: "secret-value" }
      }
    };
    const encryptedSecrets = encrypt(JSON.stringify(secrets), "masterpass1");
    const importData = {
      version: 2,
      exportType: "backup",
      exportedAt: new Date().toISOString(),
      servers: [],
      tunnels: [],
      serialProfiles: [],
      authProfiles: [],
      inventorySources: [
        makeInventorySource({ id: "src1", name: "NetBox", secretFieldIds: ["apiToken", "apiSecret"] })
      ],
      encryptedSecrets
    };

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/backup.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify(importData), "utf8"));
    mockShowInputBox.mockResolvedValueOnce("masterpass1"); // decrypt password
    mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }); // chooser: Nexus Export File…
    mockShowQuickPick.mockResolvedValueOnce({ label: "Replace", value: "replace" }); // import mode
    mockShowWarningMessage.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.config.import")!();

    expect(core.getInventorySource("src1")?.name).toBe("NetBox");
    expect(await vault.get(inventorySecretKey("src1", "apiToken"))).toBe("token-value");
    expect(await vault.get(inventorySecretKey("src1", "apiSecret"))).toBe("secret-value");

    const missingCredentialWarnings = mockShowWarningMessage.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("missing credential")
    );
    expect(missingCredentialWarnings).toHaveLength(0);
  });
});
