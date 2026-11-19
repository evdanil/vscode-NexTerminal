import { beforeEach, describe, expect, it, vi } from "vitest";
import { openQuickConnectProfileForm } from "../../src/commands/profileCommands";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import type { SerialProfile, ServerConfig } from "../../src/models/config";
import { configMutationLock } from "../../src/services/configMutationLock";
import { currentProxyPasswordSecretKey } from "../../src/services/ssh/proxyPasswordKeys";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { quickConnectSerialFormDefinition } from "../../src/ui/formDefinitions";
import { renderFormHtml } from "../../src/ui/formHtml";
import type { FormDefinition, FormValues } from "../../src/ui/formTypes";

const { openForm } = vi.hoisted(() => ({
  openForm: vi.fn((_id: string, _definition: FormDefinition, _options: {
    onSubmit: (values: FormValues) => Promise<void>;
  }) => ({ onDidDispose: vi.fn() }))
}));

vi.mock("vscode", () => ({
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
  }
}));

vi.mock("../../src/ui/webviewFormPanel", () => ({ WebviewFormPanel: { open: openForm } }));

const quickServer: ServerConfig = {
  id: "quick-tab-1", name: "ops@switch.example.test", host: "switch.example.test", port: 2222,
  username: "ops", authType: "key", keyPath: "/private/session-key", isHidden: false,
  legacyAlgorithms: true, authProfileId: "runtime-auth", group: "Runtime folder",
  proxy: { type: "socks5", host: "proxy.example.test", port: 1080, username: "runtime-proxy" }
};

const formValues: FormValues = {
  profileType: "ssh", name: "Saved switch", host: "switch.example.test", port: 2222,
  username: "ops", group: "Lab/Console", authType: "password", legacyAlgorithms: true
};

const quickSerial: SerialProfile = {
  id: "quick-serial-tab", name: "COM4", path: "COM4", baudRate: 31250, dataBits: 7,
  stopBits: 2, parity: "even", rtscts: true, mode: "standard"
};

const serialValues: FormValues = {
  name: "Saved serial console", path: "COM4", baudRate: "custom", customBaudRate: "31250",
  dataBits: "7", stopBits: "2", parity: "even", rtscts: true, group: "Lab/Console"
};

async function makeContext(repository = new InMemoryConfigRepository()) {
  const core = new NexusCore(repository);
  await core.initialize();
  const secretVault = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };
  return { ctx: { core, secretVault } as unknown as CommandContext, core, repository, secretVault };
}

function latestForm() {
  const call = openForm.mock.calls.at(-1);
  expect(call).toBeDefined();
  const [id, definition, handlers] = call!;
  const valueOf = (key: string) => {
    const field = definition.fields.find((entry) => "key" in entry && entry.key === key);
    return field && "value" in field ? field.value : undefined;
  };
  return { id, definition, valueOf, submit: handlers.onSubmit };
}

describe("Save Quick Connect as a profile", () => {
  beforeEach(() => { openForm.mockClear(); });

  it("uses the normal serial form to save the connected port settings as a fresh profile", async () => {
    const { ctx, repository } = await makeContext();
    const onSaved = vi.fn();
    openQuickConnectProfileForm(ctx, quickSerial, () => true, onSaved);
    const serial = latestForm();
    expect(serial.definition.title).toBe("Add Serial Profile");
    expect([
      "name", "path", "baudRate", "customBaudRate", "dataBits", "stopBits", "parity", "rtscts"
    ].map(serial.valueOf)).toEqual(["COM4", "COM4", "custom", "31250", "7", "2", "even", true]);
    expect(serial.definition.fields).not.toContainEqual(expect.objectContaining({ key: "host" }));

    await serial.submit(serialValues);
    const [stored] = await repository.getSerialProfiles();
    expect(stored.id).not.toBe(quickSerial.id);
    expect(stored).toMatchObject({
      name: "Saved serial console", path: "COM4", baudRate: 31250, dataBits: 7,
      stopBits: 2, parity: "even", rtscts: true, group: "Lab/Console", mode: "standard"
    });
    expect(await repository.getServers()).toEqual([]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("refuses a serial save if its terminal closes while waiting for the config lock", async () => {
    const { ctx, repository } = await makeContext();
    let available = true;
    const onSaved = vi.fn();
    openQuickConnectProfileForm(ctx, quickSerial, () => available, onSaved);

    let release!: () => void;
    const pendingCommit = new Promise<void>((resolve) => { release = resolve; });
    const lock = configMutationLock.runExclusive(() => pendingCommit);
    const saving = latestForm().submit(serialValues);
    available = false;
    release();
    await lock;

    await expect(saving).rejects.toThrow(/Quick Connect terminal/);
    expect(await repository.getSerialProfiles()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps a failed serial write out of core and reuses its ID on a single successful retry", async () => {
    const { ctx, core, repository } = await makeContext();
    const saveSerialProfiles = vi.spyOn(repository, "saveSerialProfiles")
      .mockRejectedValueOnce(new Error("serial repository unavailable"));
    const onSaved = vi.fn();
    openQuickConnectProfileForm(ctx, quickSerial, () => true, onSaved);
    const { submit } = latestForm();

    await expect(submit(serialValues)).rejects.toThrow("serial repository unavailable");
    expect(core.getSnapshot().serialProfiles).toEqual([]);
    expect(await repository.getSerialProfiles()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();

    await Promise.all([submit(serialValues), submit({ ...serialValues, name: "Duplicate" })]);
    const stored = await repository.getSerialProfiles();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("Saved serial console");
    expect(stored[0].id).toBe(saveSerialProfiles.mock.calls[0][0][0].id);
    expect(core.getSnapshot().serialProfiles).toEqual(stored);
    expect(saveSerialProfiles).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("prefills only the reusable connection details and scopes the editor to its terminal", async () => {
    const { ctx, repository, secretVault } = await makeContext();
    const onSaved = vi.fn();
    openQuickConnectProfileForm(ctx, quickServer, () => true, onSaved);
    const ssh = latestForm();
    expect(ssh.definition.title).toBe("Add Network Device Profile");
    expect(["name", "protocol", "host", "port", "username", "legacyAlgorithms"].map(ssh.valueOf)).toEqual([
      "ops@switch.example.test", "ssh", "switch.example.test", 2222, "ops", true
    ]);
    expect(["authType", "authProfileId", "keyPath", "group", "proxySocks5Username"].map(ssh.valueOf)).toEqual([
      "password", "", undefined, "", ""
    ]);
    expect(JSON.stringify(ssh.definition)).not.toContain("/private/session-key");
    expect(JSON.stringify(ssh.definition)).not.toContain("runtime-proxy");

    openQuickConnectProfileForm(ctx, { ...quickServer, id: "quick-tab-2", protocol: "telnet", port: 2323 }, () => true, vi.fn());
    const telnet = latestForm();
    expect(telnet.id).not.toBe(ssh.id);
    expect(telnet.valueOf("protocol")).toBe("telnet");
    expect(telnet.valueOf("port")).toBe(2323);
    openQuickConnectProfileForm(ctx, quickServer, () => true, onSaved);
    expect(latestForm().id).toBe(ssh.id);

    await ssh.submit(formValues);
    const [stored] = await repository.getServers();
    expect(stored.id).not.toBe(quickServer.id);
    expect(stored).toMatchObject({
      name: "Saved switch", host: "switch.example.test", port: 2222, username: "ops", group: "Lab/Console",
      authType: "password", legacyAlgorithms: true
    });
    expect(stored.authProfileId).toBeUndefined();
    expect(stored.keyPath).toBeUndefined();
    expect(stored.proxy).toBeUndefined();
    expect(secretVault.get).not.toHaveBeenCalled();
    expect(secretVault.store).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("refuses a save when its terminal closed while waiting on another config change", async () => {
    const { ctx, repository } = await makeContext();
    let available = true;
    const onSaved = vi.fn();
    openQuickConnectProfileForm(ctx, quickServer, () => available, onSaved);

    let release!: () => void;
    const pendingCommit = new Promise<void>((resolve) => { release = resolve; });
    const lock = configMutationLock.runExclusive(() => pendingCommit);
    const saving = latestForm().submit(formValues);
    available = false;
    release();
    await lock;

    await expect(saving).rejects.toThrow(/Quick Connect terminal/);
    expect(await repository.getServers()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps a failed save out of core and retries with the same ID exactly once", async () => {
    const { ctx, core, repository } = await makeContext();
    let failSave!: (error: Error) => void;
    const failedWrite = new Promise<void>((_resolve, reject) => { failSave = reject; });
    let startWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { startWrite = resolve; });
    const saveServers = vi.spyOn(repository, "saveServers").mockImplementationOnce(() => {
      startWrite();
      return failedWrite;
    });
    const onSaved = vi.fn();
    openQuickConnectProfileForm(ctx, quickServer, () => true, onSaved);
    const { submit } = latestForm();

    const attempt = submit(formValues);
    await writeStarted;
    const duringWrite = core.getSnapshot().servers;
    failSave(new Error("repository unavailable"));
    await expect(attempt).rejects.toThrow("repository unavailable");
    expect(duringWrite).toEqual([]);
    expect(core.getSnapshot().servers).toEqual([]);
    expect(await repository.getServers()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();

    await Promise.all([submit(formValues), submit({ ...formValues, name: "Duplicate" })]);
    const stored = await repository.getServers();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("Saved switch");
    expect(stored[0].id).toBe(saveServers.mock.calls[0][0][0].id);
    expect(core.getSnapshot().servers).toEqual(stored);
    expect(saveServers).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("discards a new proxy password if the terminal closes while it is being stored", async () => {
    const { ctx, repository, secretVault } = await makeContext();
    let available = true;
    let finishStore!: () => void;
    const storing = new Promise<void>((resolve) => { finishStore = resolve; });
    let startStore!: () => void;
    const storeStarted = new Promise<void>((resolve) => { startStore = resolve; });
    secretVault.store.mockImplementationOnce(() => {
      startStore();
      return storing;
    });
    const onSaved = vi.fn();
    openQuickConnectProfileForm(ctx, quickServer, () => available, onSaved);

    const saving = latestForm().submit({
      ...formValues, proxyType: "socks5", proxySocks5Host: "chosen.proxy.test", proxySocks5Port: 1080,
      proxySocks5Username: "new-user", proxySocks5Password: "new-secret"
    });
    await storeStarted;
    available = false;
    finishStore();

    await expect(saving).rejects.toThrow(/Quick Connect terminal/);
    expect(await repository.getServers()).toEqual([]);
    const [key, secret] = secretVault.store.mock.calls[0];
    expect(secret).toBe("new-secret");
    expect(key).not.toBe(currentProxyPasswordSecretKey(quickServer));
    expect(secretVault.delete).toHaveBeenCalledExactlyOnceWith(key);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("Quick Connect Serial form", () => {
  it("shows physical serial settings and labels the action Connect", () => {
    const definition = quickConnectSerialFormDefinition();
    expect(definition.fields.filter((field) => "key" in field).map((field) => field.key)).toEqual([
      "path", "baudRate", "customBaudRate", "dataBits", "stopBits", "parity", "rtscts"
    ]);
    expect(definition.fields[0]).toMatchObject({ key: "path", required: true, scannable: true });
    expect(definition.expandAdvanced).toBe(true);
    const html = renderFormHtml(definition);
    expect(html).toContain('id="save-btn">Connect</button>');
    expect(html).not.toContain('id="save-btn">Save</button>');
  });
});
