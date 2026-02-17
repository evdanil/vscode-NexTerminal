import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture registered command handlers
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowInformationMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowSaveDialog = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockWriteFile = vi.fn();
const mockReadFile = vi.fn();
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
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showSaveDialog: (...args: unknown[]) => mockShowSaveDialog(...args),
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args)
  },
  workspace: {
    fs: {
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args)
    },
    getConfiguration: vi.fn((section: string) => ({
      get: (key: string) => configStore.get(`${section}.${key}`),
      update: (key: string, value: unknown) => {
        configStore.set(`${section}.${key}`, value);
        return mockConfigUpdate(section, key, value);
      }
    }))
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: "file" })
  },
  ConfigurationTarget: { Global: 1 }
}));

import { registerConfigCommands, isValidExport, SETTINGS_KEYS } from "../../src/commands/configCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { ServerConfig, TunnelProfile, SerialProfile } from "../../src/models/config";

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
  });
});

describe("config import command", () => {
  let core: NexusCore;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core);
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
});

describe("config export command", () => {
  let core: NexusCore;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    configStore.clear();
    const repo = new InMemoryConfigRepository();
    core = new NexusCore(repo);
    await core.initialize();
    registerConfigCommands(core);
  });

  it("exports all profiles and settings", async () => {
    await core.addOrUpdateServer(makeServer());
    await core.addOrUpdateTunnel(makeTunnel());
    await core.addOrUpdateSerialProfile(makeSerialProfile());

    configStore.set("nexus.terminal.macros", [{ name: "Hello", text: "echo hi" }]);

    const savedUri = { fsPath: "/fake/export.json", scheme: "file" };
    mockShowSaveDialog.mockResolvedValue(savedUri);
    mockWriteFile.mockResolvedValue(undefined);

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenData = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
    expect(writtenData.version).toBe(1);
    expect(writtenData.servers).toHaveLength(1);
    expect(writtenData.tunnels).toHaveLength(1);
    expect(writtenData.serialProfiles).toHaveLength(1);
    expect(writtenData.settings["nexus.terminal.macros"]).toEqual([{ name: "Hello", text: "echo hi" }]);
    expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Exported 3 profiles"));
  });

  it("does nothing when save dialog is cancelled", async () => {
    mockShowSaveDialog.mockResolvedValue(undefined);

    const exportCmd = registeredCommands.get("nexus.config.export")!;
    await exportCmd();

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe("export round-trip", () => {
  it("import of exported data preserves all profiles", async () => {
    registeredCommands.clear();
    configStore.clear();

    // Set up source core with data
    const sourceRepo = new InMemoryConfigRepository();
    const sourceCore = new NexusCore(sourceRepo);
    await sourceCore.initialize();
    await sourceCore.addOrUpdateServer(makeServer());
    await sourceCore.addOrUpdateServer(makeServer({ id: "s2", name: "Server 2", host: "s2.example.com" }));
    await sourceCore.addOrUpdateTunnel(makeTunnel());
    await sourceCore.addOrUpdateSerialProfile(makeSerialProfile());
    await sourceCore.addGroup("Production");

    registerConfigCommands(sourceCore);

    // Export
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
    registerConfigCommands(destCore);

    mockShowOpenDialog.mockResolvedValue([{ fsPath: "/fake/config.json", scheme: "file" }]);
    mockReadFile.mockResolvedValue(Buffer.from(exportedJson, "utf8"));
    mockShowQuickPick.mockResolvedValue({ label: "Replace", value: "replace" });

    const importCmd = registeredCommands.get("nexus.config.import")!;
    await importCmd();

    const destSnapshot = destCore.getSnapshot();
    const sourceSnapshot = sourceCore.getSnapshot();
    expect(destSnapshot.servers).toHaveLength(sourceSnapshot.servers.length);
    expect(destSnapshot.tunnels).toHaveLength(sourceSnapshot.tunnels.length);
    expect(destSnapshot.serialProfiles).toHaveLength(sourceSnapshot.serialProfiles.length);
    expect(destSnapshot.explicitGroups).toContain("Production");
  });
});
