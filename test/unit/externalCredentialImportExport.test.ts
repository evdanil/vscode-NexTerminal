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

vi.mock("node:crypto", async (importOriginal) =>
  (await import("../helpers/fastBackupKdf")).withFastPbkdf2(await importOriginal<typeof import("node:crypto")>())
);
import { captureBackupStateForExport, registerConfigCommands, sanitizeForSharing, validateExternalAuthProfileImport, type ConfigRuntimeHooks } from "../../src/commands/configCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";
import { encrypt } from "../../src/utils/configCrypto";
import type { ExternalAuthProfile } from "../../src/models/authProfile";
import type { ServerConfig } from "../../src/models/config";
import type { InventorySourceConfig } from "../../src/models/inventory";
import type { DeviceTemplateProfile } from "../../src/models/deviceTemplate";
import { authProfilePasswordSecretKey, authProfilePassphraseSecretKey, passwordSecretKey } from "../../src/services/ssh/silentAuth";
import type * as vscode from "vscode";
import { VscodeConfigRepository } from "../../src/storage/vscodeConfigRepository";
import { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import { createExternalCredentialResolver } from "../../src/services/credentials/externalCredentialResolver";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";
import { createExternalCredentialApproval } from "../../src/services/credentials/externalCredentialApproval";

const external = (): ExternalAuthProfile => ({ id: "ext", name: "External", authType: "external",
  external: { version: 1, method: "key", invocation: { executable: "/fixture/credential-program", args: ["ARG-CANARY"] } } });
const server = (): ServerConfig => ({ id: "server", name: "Server", host: "host.example", port: 22, username: "dormant", authType: "password", isHidden: false, authProfileId: "ext" });
const source = (): InventorySourceConfig => ({ id: "source", name: "Source", providerId: "netbox", defaultUsername: "dormant", targetFolder: "Lab", prunePolicy: "orphan", config: { baseUrl: "https://inventory.example" }, secretFieldIds: [], authProfileId: "ext", templateRules: [{ id: "rule", templateId: "template" }] });
const template = (): DeviceTemplateProfile => ({ id: "template", name: "Template", fields: { authProfileId: { value: "ext", mode: "override" } } });
const password = "fixture-backup";
const json = (data: Record<string, unknown>, secrets?: Record<string, unknown>) => JSON.stringify({ version: 2, exportType: "backup", servers: [], ...data,
  ...(secrets ? { encryptedSecrets: encrypt(JSON.stringify(secrets), password) } : {}) });
async function machine() {
  const repo = new InMemoryConfigRepository();
  const core = new NexusCore(repo); await core.initialize();
  const values = new Map<string, string>();
  const vault = { get: vi.fn(async (key: string) => values.get(key)), store: vi.fn(async (key: string, value: string) => { values.set(key, value); }), delete: vi.fn(async (key: string) => { values.delete(key); }) };
  return { core, repo, vault, values };
}
type Machine = Awaited<ReturnType<typeof machine>>;
function runtime(revoke: (ids?: readonly string[]) => void): ConfigRuntimeHooks {
  return { revokeExternalCredentialApprovals: revoke, stopLocalServer: async () => {}, stopNetworkServices: async () => {}, teardownServerRuntime: async () => {}, stopTunnel: async () => {}, activeTunnelIdForProfile: () => undefined, closeSerialProfileTerminals: () => {}, closeLocalShellProfileTerminals: () => {} };
}
async function importData(m: Machine, text: string, mode = "replace", hooks?: ConfigRuntimeHooks) {
  registerConfigCommands(m.core, m.vault, undefined, hooks);
  mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }).mockResolvedValueOnce({ value: mode });
  mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/import.json", scheme: "file" }]);
  mockReadFile.mockResolvedValueOnce(Buffer.from(text)); mockShowInputBox.mockResolvedValueOnce(password);
  await registeredCommands.get("nexus.config.import")!();
}
beforeEach(async () => {
  allMocks.forEach(mock => mock.mockReset()); registeredCommands.clear();
  mockShowInformationMessage.mockResolvedValue(undefined);
  const store = new InMemoryMacroStore(); await store.initialize(); setActiveMacroStore(store);
});

it("backs up external configuration without reading either profile secret slot", async () => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external()); await m.core.addOrUpdateServer(server());
  m.values.set(authProfilePasswordSecretKey("ext"), "SECRET-CANARY"); m.values.set(authProfilePassphraseSecretKey("ext"), "SECRET-CANARY");
  m.values.set(passwordSecretKey("server"), "server-secret");
  const result = await captureBackupStateForExport(m.core, m.vault);
  expect(result.authProfiles).toEqual([external()]); expect(result.authProfileSecrets).toEqual({ passwords: {}, passphrases: {} });
  expect(m.vault.get).not.toHaveBeenCalledWith(authProfilePasswordSecretKey("ext"));
  expect(m.vault.get).not.toHaveBeenCalledWith(authProfilePassphraseSecretKey("ext"));
  expect(result.serverSecrets.passwords.server).toBe("server-secret");
  expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
});

it("preserves expansion in a backup and strips it with invocation from shares", async () => {
  const m = await machine();
  const profile = external();
  profile.external.invocation = { ...profile.external.invocation!, argumentExpansion: true, args: ["${host}"] };
  await m.core.addOrUpdateAuthProfile(profile);
  expect((await captureBackupStateForExport(m.core, m.vault)).authProfiles).toEqual([profile]);
  const shared = sanitizeForSharing([server()], [], [], [], {}, [profile], [], [], []);
  expect(shared.authProfiles[0]).toMatchObject({ external: { version: 1, method: "key" } });
  expect(JSON.stringify(shared)).not.toContain("argumentExpansion");
  expect(JSON.stringify(shared)).not.toContain("${host}");
});

it("restores enabled, disabled and legacy argument settings through a backup", async () => {
  const origin = await machine();
  const enabled = external(); enabled.external.invocation = { ...enabled.external.invocation!, argumentExpansion: true, args: ["${host}"] };
  const disabled = external(); disabled.id = "disabled"; disabled.external.invocation = { ...disabled.external.invocation!, argumentExpansion: false, args: ["${host}"] };
  const legacy = external(); legacy.id = "legacy"; legacy.external.invocation = { ...legacy.external.invocation!, args: ["${host}"] };
  for (const profile of [enabled, disabled, legacy]) await origin.core.addOrUpdateAuthProfile(profile);
  const canonicalDisabled = { ...disabled, external: { ...disabled.external, invocation: { executable: disabled.external.invocation!.executable, args: disabled.external.invocation!.args } } };
  expect(origin.core.getAuthProfile("disabled")).toEqual(canonicalDisabled);
  expect(disabled.external.invocation?.argumentExpansion).toBe(false);
  const backup = await captureBackupStateForExport(origin.core, origin.vault);
  const restored = await machine();
  expect(backup.authProfiles).toEqual([enabled, canonicalDisabled, legacy]);
  await importData(restored, json({ authProfiles: [enabled, disabled, legacy] }));
  expect(mockShowErrorMessage).not.toHaveBeenCalled();
  const reopened = new NexusCore(restored.repo); await reopened.initialize();
  expect(reopened.getSnapshot().authProfiles).toEqual([enabled, canonicalDisabled, legacy]);
});

it("normalizes disabled expansion on repository reads and writes for old readers", async () => {
  const disabled = external(); disabled.external.invocation = { ...disabled.external.invocation!, argumentExpansion: false, args: ["${host}"] };
  const expected = external(); expected.external.invocation = { ...expected.external.invocation!, args: ["${host}"] };
  const state = new Map<string, unknown>([["nexus.authProfiles", [disabled]]]);
  const context = { globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } } as unknown as vscode.ExtensionContext;
  const repository = new VscodeConfigRepository(context);
  expect(await repository.getAuthProfiles()).toEqual([expected]);
  await repository.saveAuthProfiles([disabled]);
  expect(state.get("nexus.authProfiles")).toEqual([expected]);
  const invocation = (state.get("nexus.authProfiles") as ExternalAuthProfile[])[0].external.invocation!;
  expect(Object.keys(invocation).every(key => key === "executable" || key === "args")).toBe(true);
  expect(disabled.external.invocation?.argumentExpansion).toBe(false);
});

it("older profile loading drops expansion fields and an unrelated save removes those rows", async () => {
  const enabled = external(); enabled.external.invocation = { ...enabled.external.invocation!, argumentExpansion: true };
  const disabled = external(); disabled.id = "disabled"; disabled.external.invocation = { ...disabled.external.invocation!, argumentExpansion: false };
  const legacy = external(); legacy.id = "legacy";
  const state = new Map<string, unknown>([["nexus.authProfiles", [enabled, disabled, legacy]], ["nexus.servers", [server()]]]);
  const context = { globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } } as unknown as vscode.ExtensionContext;
  // v2.8.306's invocation validator rejects every key except executable and args.
  // Other validation and the full-list load/save are exercised by the real repository/core.
  class OlderRepository extends VscodeConfigRepository {
    override async getAuthProfiles() {
      return (state.get("nexus.authProfiles") as ExternalAuthProfile[]).filter(profile => profile.authType !== "external" || !profile.external.invocation ||
        Object.keys(profile.external.invocation).every(key => key === "executable" || key === "args"));
    }
  }
  const core = new NexusCore(new OlderRepository(context)); await core.initialize();
  expect(core.getSnapshot().authProfiles).toEqual([legacy]);
  const local = await machine(); const connect = vi.fn(); const prompt = { prompt: vi.fn() };
  const factory = new SilentAuthSshFactory({ connect }, local.vault, prompt, undefined, id => core.getAuthProfile(id), id => core.getServer(id));
  await expect(factory.connect(core.getServer("server")!)).rejects.toThrow("linked auth profile is unavailable");
  expect(connect).not.toHaveBeenCalled(); expect(local.vault.get).not.toHaveBeenCalled(); expect(prompt.prompt).not.toHaveBeenCalled();
  await core.addOrUpdateAuthProfile({ id: "other", name: "Other", authType: "password", username: "user" });
  expect(state.get("nexus.authProfiles")).toEqual([legacy, { id: "other", name: "Other", authType: "password", username: "user" }]);
});

it("shares preserve external type, method and all SSH links but strip invocation", async () => {
  const shared = sanitizeForSharing([server()], [], [], [], {}, [external()], [], [source()], [template()]);
  expect(shared.authProfiles[0]).toEqual({ id: expect.any(String), name: "External", authType: "external", external: { version: 1, method: "key" } });
  const id = shared.authProfiles[0].id;
  expect(shared.servers[0].authProfileId).toBe(id); expect(shared.inventorySources[0].authProfileId).toBe(id);
  expect(shared.deviceTemplates[0].fields.authProfileId?.value).toBe(id);
  expect(JSON.stringify(shared)).not.toContain("ARG-CANARY"); expect(JSON.stringify(shared)).not.toContain("credential-program");
  const m = await machine(); await importData(m, json({ ...shared, exportType: "share" }));
  expect(mockShowErrorMessage).not.toHaveBeenCalled();
  expect(m.core.getSnapshot().authProfiles[0]).toMatchObject({ authType: "external", external: { version: 1, method: "key" } });
  expect(m.core.getSnapshot().servers[0].authProfileId).toBe(m.core.getSnapshot().authProfiles[0].id);
  const importedId = m.core.getSnapshot().authProfiles[0].id;
  expect(m.core.getSnapshot().inventorySources[0].authProfileId).toBe(importedId);
  expect(m.core.getSnapshot().deviceTemplates[0].fields.authProfileId?.value).toBe(importedId);
  const run = vi.fn(); const connect = vi.fn(); const prompt = { prompt: vi.fn() };
  const approvals = createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm: async () => true });
  const resolver = createExternalCredentialResolver({ approvals, run, parse: parseExternalCredentialResponse });
  const factory = new SilentAuthSshFactory({ connect }, m.vault, prompt, undefined, id => m.core.getAuthProfile(id), id => m.core.getServer(id), resolver);
  await expect(factory.connect(m.core.getSnapshot().servers[0])).rejects.toMatchObject({ code: "unconfigured" });
  expect(run).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(m.vault.get).not.toHaveBeenCalled(); expect(prompt.prompt).not.toHaveBeenCalled(); resolver.dispose();
});

it("strips invocation from a hand-crafted share before storing it", async () => {
  const m = await machine(); await importData(m, json({ exportType: "share", authProfiles: [external()], servers: [server()] }));
  expect(mockShowErrorMessage).not.toHaveBeenCalled();
  expect(m.core.getSnapshot().authProfiles).toHaveLength(1);
  expect(m.core.getSnapshot().authProfiles[0]).toMatchObject({ authType: "external", external: { version: 1, method: "key" } });
  expect(JSON.stringify(m.core.getSnapshot().authProfiles)).not.toContain("invocation");
});

const malformed = [
  { ...external(), external: { version: 2, method: "key" } },
  { ...external(), external: { version: 1, method: "key", invocation: { executable: "relative", args: [] } } },
  { ...external(), username: "legacy" },
  { ...external(), authType: "password", username: "legacy" }
];
for (const mode of ["merge", "replace", "share"]) {
  for (const [index, invalid] of malformed.entries()) it(`refuses malformed external row ${index} in ${mode} before any write`, async () => {
    const m = await machine(); await m.core.addOrUpdateServer({ ...server(), authProfileId: undefined });
    const before = m.core.getSnapshot(); const writes = vi.spyOn(m.repo, "saveServers");
    await importData(m, json({ ...(mode === "share" ? { exportType: "share" } : {}), authProfiles: [external(), invalid], servers: [server()] }), mode);
    expect(mockShowErrorMessage).toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(m.core.getSnapshot()).toEqual(before);
    expect(m.vault.delete).not.toHaveBeenCalled(); expect(m.vault.store).not.toHaveBeenCalled();
    expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
  });
  it(`refuses an unresolved SSH link in ${mode} before mutation`, async () => {
    const m = await machine(); const save = vi.spyOn(m.repo, "saveServers");
    await importData(m, json({ ...(mode === "share" ? { exportType: "share" } : {}), servers: [server()] }), mode);
    expect(mockShowErrorMessage).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
}

it("ignores malicious external secret buckets while restoring stored profile secrets", async () => {
  const m = await machine(); await importData(m, json({ authProfiles: [external(), { id: "stored", name: "Stored", authType: "password", username: "user" }], servers: [server()] },
    { authProfilePasswords: { ext: "SECRET-CANARY", stored: "stored-secret" }, authProfilePassphrases: { ext: "SECRET-CANARY" } }));
  expect(mockShowErrorMessage).not.toHaveBeenCalled(); expect(m.core.getAuthProfile("ext")).toEqual(external());
  expect(m.values.get(authProfilePasswordSecretKey("stored"))).toBe("stored-secret");
  expect(m.vault.store).not.toHaveBeenCalledWith(authProfilePasswordSecretKey("ext"), expect.anything());
  expect(m.vault.store).not.toHaveBeenCalledWith(authProfilePassphraseSecretKey("ext"), expect.anything());
});

it("revokes a byte-identical replacement before the first delete and does not restore authority after failure", async () => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external()); await m.core.addOrUpdateServer(server());
  const confirm = vi.fn(async () => true);
  const approval = createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm });
  const request = { profile: external(), signal: new AbortController().signal, isCurrent: () => true, interaction: "interactive" as const };
  await approval.authorize(request);
  const resolver = createExternalCredentialResolver({ approvals: approval, run: async () => Buffer.from("{}"), parse: parseExternalCredentialResponse });
  const pending = resolver.begin(request);
  const remove = vi.spyOn(m.core, "removeServer").mockImplementationOnce(async () => {
    expect(pending.signal.aborted).toBe(true);
    await expect(approval.authorize({ ...request, interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
    throw new Error("write failed");
  });
  await expect(importData(m, json({ authProfiles: [external()], servers: [server()] }), "replace", runtime(ids => resolver.revoke(ids)))).rejects.toThrow("write failed");
  expect(remove).toHaveBeenCalled();
  await expect(approval.authorize({ ...request, interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
  expect(confirm).toHaveBeenCalledTimes(1); resolver.dispose();
});

it.each(["replace", "reset"])("%s removes dependent sources and templates before external profiles and revokes first", async (mode) => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external()); await m.core.addOrUpdateServer(server());
  await m.core.addOrUpdateInventorySource(source()); await m.core.addOrUpdateDeviceTemplate(template());
  const revoked = vi.fn(); const hooks = runtime(revoked);
  const remove = m.core.removeAuthProfile.bind(m.core);
  vi.spyOn(m.core, "removeAuthProfile").mockImplementation(async id => {
    expect(revoked).toHaveBeenCalled(); expect(m.core.getSnapshot().servers).toHaveLength(0);
    expect(m.core.getSnapshot().inventorySources).toHaveLength(0); expect(m.core.getSnapshot().deviceTemplates).toHaveLength(0);
    expect(m.vault.delete).toHaveBeenCalledWith(authProfilePasswordSecretKey(id)); expect(m.vault.delete).toHaveBeenCalledWith(authProfilePassphraseSecretKey(id));
    return remove(id);
  });
  if (mode === "replace") await importData(m, json({ authProfiles: [external()], servers: [server()] }), mode, hooks);
  else {
    registerConfigCommands(m.core, m.vault, undefined, hooks); mockShowWarningMessage.mockResolvedValueOnce("Delete Everything"); mockShowInputBox.mockResolvedValueOnce("DELETE");
    await registeredCommands.get("nexus.config.completeReset")!(); expect(revoked).toHaveBeenCalledWith();
  }
  expect(mockShowErrorMessage).not.toHaveBeenCalled();
});


it("validates every external candidate and reports only safe internal ids", () => {
  expect(validateExternalAuthProfileImport([external()])).toEqual({ ok: true });
  expect(validateExternalAuthProfileImport([external(), { id: "ext", name: "Conflict", username: "legacy", authType: "password" }])).toEqual({ ok: false, invalidIds: ["ext"] });
  expect(validateExternalAuthProfileImport([{ ...external(), id: "unsafe\nCANARY", external: {} }])).toEqual({ ok: false, invalidIds: [] });
  expect(validateExternalAuthProfileImport([{ ...external(), id: "" }]).ok).toBe(false);
});

it.each(["source", "template"])("refuses a missing SSH profile in a %s before any profile write", async kind => {
  const m = await machine(); const save = vi.spyOn(m.repo, "saveAuthProfiles");
  await importData(m, json({ authProfiles: [{ ...external(), id: "other" }], ...(kind === "source" ? { inventorySources: [source()] } : { deviceTemplates: [template()] }) }));
  expect(mockShowErrorMessage).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});

it("rechecks the projected merge graph after the mode prompt", async () => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external());
  // The prompt yields control to another writer before this import acquires its lock.
  registerConfigCommands(m.core, m.vault);
  mockShowQuickPick.mockResolvedValueOnce({ value: "nexusExport" }).mockImplementationOnce(async () => {
    await m.core.removeAuthProfile("ext"); return { value: "merge" };
  });
  mockShowOpenDialog.mockResolvedValueOnce([{ fsPath: "/fake/import.json", scheme: "file" }]);
  mockReadFile.mockResolvedValueOnce(Buffer.from(json({ servers: [server()] })));
  const save = vi.spyOn(m.repo, "saveServers");
  await registeredCommands.get("nexus.config.import")!();
  expect(mockShowErrorMessage).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});

it("keeps unrelated external grants when merging a stored profile", async () => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external());
  const confirm = vi.fn(async () => true); const approvals = createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm });
  const request = { profile: external(), signal: new AbortController().signal, isCurrent: () => true, interaction: "interactive" as const };
  await approvals.authorize(request);
  await importData(m, json({ authProfiles: [{ id: "stored", name: "Stored", username: "user", authType: "password" }] }), "merge", runtime(ids => approvals.revoke(ids)));
  await expect(approvals.authorize({ ...request, interaction: "noninteractive" })).resolves.toBeUndefined();
  expect(confirm).toHaveBeenCalledTimes(1); expect(m.core.getAuthProfile("stored")).toBeDefined(); approvals.dispose();
});

it("keeps unresolved SSH source intent after repository rejection and refuses login before vault access", async () => {
  const state = new Map<string, unknown>([["nexus.authProfiles", [malformed[0]]], ["nexus.servers", [server()]]]);
  const context = { globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } } as unknown as vscode.ExtensionContext;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const core = new NexusCore(new VscodeConfigRepository(context)); await core.initialize(); warn.mockRestore();
  expect(core.getAuthProfile("ext")).toBeUndefined(); expect(core.getServer("server")?.authProfileId).toBe("ext");
  const m = await machine(); const connect = vi.fn(); const prompt = { prompt: vi.fn() };
  const factory = new SilentAuthSshFactory({ connect }, m.vault, prompt, undefined, id => core.getAuthProfile(id), id => core.getServer(id));
  await expect(factory.connect(core.getServer("server")!)).rejects.toThrow();
  expect(m.vault.get).not.toHaveBeenCalled(); expect(prompt.prompt).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
});

it("never exposes missing-profile static authentication during a partial replacement", async () => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external()); await m.core.addOrUpdateServer(server());
  const connect = vi.fn(); const prompt = { prompt: vi.fn() };
  const factory = new SilentAuthSshFactory({ connect }, m.vault, prompt, undefined, id => m.core.getAuthProfile(id), id => m.core.getServer(id));
  const add = m.core.addOrUpdateServer.bind(m.core);
  vi.spyOn(m.core, "addOrUpdateServer").mockImplementationOnce(async row => {
    await add(row);
    expect(m.core.getAuthProfile("ext")?.authType).toBe("external");
    await expect(factory.connect(row)).rejects.toMatchObject({ code: "unsupported-consumer" });
    throw new Error("persist failed");
  });
  await expect(importData(m, json({ authProfiles: [external()], servers: [server()] }))).rejects.toThrow("persist failed");
  expect(m.core.getServer("server")?.authProfileId).toBe("ext"); expect(connect).not.toHaveBeenCalled(); expect(prompt.prompt).not.toHaveBeenCalled();
});

it("rejects unknown export versions before offering replacement", async () => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external());
  await importData(m, json({ version: 99, authProfiles: [external()] }));
  expect(m.core.getAuthProfile("ext")).toEqual(external()); expect(m.vault.delete).not.toHaveBeenCalled();
  expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
});

it("does not let an invented preflight id turn a share SSH link into static auth", async () => {
  const m = await machine();
  await importData(m, json({ exportType: "share", authProfiles: [{ name: "No id", authType: "password", username: "user" }], servers: [{ ...server(), authProfileId: "preflight" }] }));
  expect(mockShowErrorMessage).toHaveBeenCalled(); expect(m.core.getSnapshot().servers).toHaveLength(0); expect(m.core.getSnapshot().authProfiles).toHaveLength(0);
});


async function repositoryWithRejectedExternalProfile(kind: "server" | "source" | "template") {
  const state = new Map<string, unknown>([
    ["nexus.authProfiles", [malformed[0]]],
    ["nexus.servers", kind === "server" ? [server()] : []],
    ["nexus.inventorySources", kind === "server" ? [] : [{ ...source(), ...(kind === "template" ? { authProfileId: undefined } : {}) }]],
    ["nexus.deviceTemplates", kind === "template" ? [template()] : []]
  ]);
  const context = { globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } } as unknown as vscode.ExtensionContext;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const core = new NexusCore(new VscodeConfigRepository(context));
    await core.initialize();
    expect(core.getSnapshot().authProfiles).toHaveLength(0);
    return core;
  } finally { warn.mockRestore(); }
}

it.each(["server", "source", "template"] as const)("share export refuses an unresolved %s SSH link after repository profile rejection", async kind => {
  const core = await repositoryWithRejectedExternalProfile(kind);
  const snapshot = core.getSnapshot();
  const link = kind === "server" ? snapshot.servers[0].authProfileId
    : kind === "source" ? snapshot.inventorySources[0].authProfileId : snapshot.deviceTemplates[0].fields.authProfileId?.value;
  expect(link).toBe("ext");
  const m = await machine(); registerConfigCommands(core, m.vault);
  mockShowSaveDialog.mockResolvedValueOnce({ fsPath: "/fake/share.json", scheme: "file" });
  await registeredCommands.get("nexus.config.export")!();
  expect(mockWriteFile.mock.calls.length).toBe(0);
  expect(mockShowSaveDialog).not.toHaveBeenCalled();
  expect(mockShowErrorMessage).toHaveBeenCalledWith("Nothing was exported: an SSH auth profile link cannot be resolved. Repair the linked Auth Profile in Settings, or explicitly choose another profile or unlink it, then export again.");
  expect(core.getSnapshot()).toEqual(snapshot);
});

it("share export excludes unused templates before checking their unresolved SSH links", async () => {
  const m = await machine(); await m.core.addOrUpdateAuthProfile(external()); await m.core.addOrUpdateServer(server());
  await m.core.addOrUpdateDeviceTemplate({ ...template(), fields: { authProfileId: { mode: "override", value: "missing" } } });
  registerConfigCommands(m.core, m.vault); mockShowSaveDialog.mockResolvedValueOnce({ fsPath: "/fake/share.json", scheme: "file" });
  await registeredCommands.get("nexus.config.export")!();
  expect(mockShowErrorMessage).not.toHaveBeenCalled(); expect(mockWriteFile).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
  expect(payload.deviceTemplates).toBeUndefined();
  expect(payload.authProfiles[0].authType).toBe("external");
  expect(payload.servers[0].authProfileId).toBe(payload.authProfiles[0].id);
});

it("backup export preserves unresolved SSH source intent for repair without applying the share refusal", async () => {
  const core = await repositoryWithRejectedExternalProfile("server");
  const m = await machine(); registerConfigCommands(core, m.vault);
  mockShowInputBox.mockResolvedValueOnce(password).mockResolvedValueOnce(password);
  mockShowSaveDialog.mockResolvedValueOnce({ fsPath: "/fake/backup.json", scheme: "file" });
  await registeredCommands.get("nexus.config.export.backup")!();
  expect(mockShowErrorMessage).not.toHaveBeenCalled(); expect(mockWriteFile).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(Buffer.from(mockWriteFile.mock.calls[0][1]).toString("utf8"));
  expect(payload.exportType).toBe("backup"); expect(payload.servers[0].authProfileId).toBe("ext");
});
