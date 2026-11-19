import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CommandContext } from "../../src/commands/types";
import type { SerialPtyCallbacks } from "../../src/services/serial/serialPty";
import type { FormValues } from "../../src/ui/formTypes";

const ui = vi.hoisted(() => ({
  activeTerminal: undefined as object | undefined,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  createInputBox: vi.fn(),
  createTerminal: vi.fn(),
  executeCommand: vi.fn(),
  saveProfile: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  sshPtys: [] as Array<FakePty>,
  telnetPtys: [] as Array<FakePty>,
  serialPtys: [] as Array<{
    callbacks: SerialPtyCallbacks; dispose: ReturnType<typeof vi.fn>; getInputState: ReturnType<typeof vi.fn>
  }>,
  openForm: vi.fn(),
  serialValuesToProfile: vi.fn(),
  serialPortConflict: vi.fn(),
  scanForPort: vi.fn()
}));

interface FakePty {
  callbacks: {
    onSessionOpened(): void;
    onDisconnected(): void;
    onSessionClosed(): void;
    onConnectFailed(sessionId: string, message: string): boolean;
  };
  markShuttingDown: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

vi.mock("vscode", () => ({
  ThemeIcon: class { public constructor(readonly id: string) {} },
  QuickInputButtons: { Back: { tooltip: "Back" } },
  CancellationTokenSource: class {
    readonly token = {};
    cancel() {}
    dispose() {}
  },
  commands: {
    registerCommand(id: string, callback: (...args: unknown[]) => unknown) {
      ui.commands.set(id, callback);
      return { dispose: () => ui.commands.delete(id) };
    },
    executeCommand: ui.executeCommand
  },
  window: {
    get activeTerminal() { return ui.activeTerminal; },
    onDidChangeActiveTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} }),
    createInputBox: ui.createInputBox,
    showQuickPick: ui.showQuickPick,
    showInformationMessage: ui.showInformationMessage,
    showErrorMessage: ui.showErrorMessage,
    createTerminal: ui.createTerminal
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, value: unknown) => value }) }
}));

vi.mock("../../src/commands/profileCommands", () => ({ openQuickConnectProfileForm: ui.saveProfile }));
vi.mock("../../src/commands/serialCommands", () => ({
  createStandardSerialPty(_ctx: unknown, _profile: unknown, callbacks: SerialPtyCallbacks) {
    const pty = { callbacks, dispose: vi.fn(), getInputState: vi.fn(() => ({ status: "opening" })) };
    ui.serialPtys.push(pty);
    return pty;
  },
  createSerialTerminal: (_profile: unknown, pty: unknown) => ui.createTerminal(pty),
  formValuesToSerial: ui.serialValuesToProfile,
  scanForPort: ui.scanForPort,
  serialPortInUseMessage: ui.serialPortConflict
}));
vi.mock("../../src/ui/webviewFormPanel", () => ({ WebviewFormPanel: { open: ui.openForm } }));
vi.mock("../../src/commands/serverCommands", () => ({
  createServerSessionTranscript: () => undefined,
  createNetworkDeviceTerminal: (_name: string, pty: FakePty) => ui.createTerminal(pty)
}));
vi.mock("../../src/services/ssh/sshPty", () => ({
  SshPty: class implements FakePty {
    public markShuttingDown = vi.fn();
    public dispose = vi.fn();
    public constructor(readonly server: unknown, readonly factory: unknown, readonly callbacks: FakePty["callbacks"]) {
      ui.sshPtys.push(this);
    }
  }
}));
vi.mock("../../src/services/telnet/telnetPty", () => ({
  TelnetPty: class implements FakePty {
    public markShuttingDown = vi.fn();
    public dispose = vi.fn();
    public constructor(readonly server: unknown, readonly callbacks: FakePty["callbacks"]) {
      ui.telnetPtys.push(this);
    }
  }
}));

import { parseQuickConnectAddress, QuickConnectCommands } from "../../src/commands/quickConnectCommands";

function makeInput() {
  let accept = () => {};
  let change = () => {};
  let hide = () => {};
  let button = (_button: unknown) => {};
  return {
    value: "",
    buttons: [] as unknown[],
    validationMessage: undefined as string | undefined,
    show: vi.fn(),
    dispose: vi.fn(),
    hide: () => hide(),
    onDidAccept: (handler: () => void) => { accept = handler; },
    onDidChangeValue: (handler: () => void) => { change = handler; },
    onDidHide: (handler: () => void) => { hide = handler; },
    onDidTriggerButton: (handler: (button: unknown) => void) => { button = handler; },
    enter(value: string) { this.value = value; change(); accept(); },
    trigger(index: number) { button(this.buttons[index]); }
  };
}

const invoke = (id: string, ...args: unknown[]) => ui.commands.get(id)!(...args);

beforeEach(() => {
  vi.clearAllMocks();
  ui.commands.clear();
  ui.sshPtys.length = 0;
  ui.telnetPtys.length = 0;
  ui.serialPtys.length = 0;
  ui.activeTerminal = undefined;
  ui.createTerminal.mockImplementation(() => ({ creationOptions: {}, show: vi.fn() }));
  ui.showQuickPick.mockReset();
  ui.showQuickPick.mockImplementation(async items => items[0]);
  ui.openForm.mockReturnValue({ dispose: vi.fn() });
});

describe("Quick Connect address", () => {
  it("uses protocol defaults and parses a port on bracketed IPv6", () => {
    expect(parseQuickConnectAddress("operator@switch.example")).toEqual({
      protocol: "ssh", host: "switch.example", port: 22, username: "operator"
    });
    expect(parseQuickConnectAddress("ssh://operator@[2001:db8::1]:2222")).toEqual({
      protocol: "ssh", host: "2001:db8::1", port: 2222, username: "operator"
    });
    expect(parseQuickConnectAddress("telnet://2001:db8::1")).toEqual({
      protocol: "telnet", host: "2001:db8::1", port: 23
    });
    expect(parseQuickConnectAddress("switch.example", "telnet")).toEqual({
      protocol: "telnet", host: "switch.example", port: 23
    });
  });

  it("keeps ASCII hostnames and converts international domain names", () => {
    expect(parseQuickConnectAddress("operator@123").host).toBe("123");
    expect(parseQuickConnectAddress("operator@täst.example").host).toBe("xn--tst-qla.example");
  });

  it.each([
    "ssh://user:password@switch.example", "ssh://user@switch.example/shell",
    "telnet://user@switch.example", "host:0", "host:65536", "host:",
    "host:12.5", "ssh -p 22 host", "https://switch.example", "host\nother"
  ])("rejects an invalid address without echoing it", (address) => {
    expect(() => parseQuickConnectAddress(address)).toThrow("Enter a host");
  });
});

describe("Quick Connect terminal ownership", () => {
  function harness() {
    const ctx = {
      loggerFactory: { create: vi.fn() },
      core: { addOrUpdateServer: vi.fn(), registerSession: vi.fn() },
      terminalRegistry: { register: vi.fn(), unregister: vi.fn(), refreshContextKeys: vi.fn() }
    };
    const factory = { connect: vi.fn(), connectWithContext: vi.fn() };
    const quick = new QuickConnectCommands(ctx as unknown as CommandContext, factory);
    async function open(value: string, type: "ssh" | "telnet" = "ssh") {
      const input = makeInput();
      ui.createInputBox.mockReturnValueOnce(input);
      ui.showQuickPick.mockImplementationOnce(async items => items.find((item: { type: string }) => item.type === type));
      const result = invoke("nexus.server.quickConnect");
      await vi.waitFor(() => expect(input.show).toHaveBeenCalled());
      input.enter(value);
      await result;
      return ui.createTerminal.mock.results.at(-1)!.value;
    }
    return { ctx, quick, factory, open };
  }

  it("asks for SSH, Telnet, or Serial before opening a connection", async () => {
    const h = harness();
    ui.showQuickPick.mockResolvedValueOnce(undefined);
    await invoke("nexus.server.quickConnect");
    expect(ui.showQuickPick.mock.calls[0]?.[0].map((item: { label: string }) => item.label)).toEqual([
      "SSH", "Telnet", "Serial"
    ]);
    expect(ui.createInputBox).not.toHaveBeenCalled();
    h.quick.dispose();
  });

  it("cancels a pending protocol choice across a session reset", async () => {
    const h = harness();
    let chooseSerial!: () => void;
    ui.showQuickPick.mockImplementationOnce(items => new Promise(resolve => {
      chooseSerial = () => resolve(items[2]);
    }));
    const result = invoke("nexus.server.quickConnect");
    h.quick.closeAll();
    chooseSerial();
    await result;
    expect(ui.openForm).not.toHaveBeenCalled();
    expect(ui.createInputBox).not.toHaveBeenCalled();
    h.quick.dispose();
  });

  it("keeps the chosen protocol until the user goes Back to change it", async () => {
    const h = harness();
    const ssh = makeInput();
    const telnet = makeInput();
    ui.createInputBox.mockReturnValueOnce(ssh).mockReturnValueOnce(telnet);
    ui.showQuickPick.mockImplementationOnce(async items => items[0]).mockImplementationOnce(async items => items[1]);
    const result = invoke("nexus.server.quickConnect");
    await vi.waitFor(() => expect(ssh.show).toHaveBeenCalled());
    ssh.enter("telnet://switch.example");
    expect(ssh.validationMessage).toContain("Use Back");
    expect(ui.createTerminal).not.toHaveBeenCalled();
    ssh.trigger(0);
    await vi.waitFor(() => expect(telnet.show).toHaveBeenCalled());
    telnet.enter("telnet://switch.example");
    await result;
    expect(ui.telnetPtys[0]).toMatchObject({ server: { protocol: "telnet", port: 23 } });
    h.quick.dispose();
  });

  it("offers a selection of savable Quick Connect terminals when another tab is active", async () => {
    const h = harness();
    await h.open("one@switch.example");
    await h.open("two@switch.example");
    ui.sshPtys[0].callbacks.onSessionOpened();
    ui.sshPtys[1].callbacks.onSessionOpened();
    ui.activeTerminal = { creationOptions: {} };
    ui.showQuickPick.mockImplementationOnce(async (items) => items[1]);
    await invoke("nexus.server.saveQuickConnectProfile");
    expect(ui.saveProfile).toHaveBeenCalledWith(
      h.ctx, expect.objectContaining({ username: "two" }), expect.any(Function), expect.any(Function)
    );
    h.quick.dispose();
  });

  it("opens a direct Telnet tab without SSH authentication or a stored profile", async () => {
    const h = harness();
    await h.open("switch.example", "telnet");
    ui.telnetPtys[0].callbacks.onSessionOpened();
    expect(ui.telnetPtys).toHaveLength(1);
    expect(ui.telnetPtys[0]).toMatchObject({ server: { protocol: "telnet", port: 23 } });
    expect(ui.sshPtys).toHaveLength(0);
    expect(h.factory.connect).not.toHaveBeenCalled();
    expect(h.ctx.core.addOrUpdateServer).not.toHaveBeenCalled();
    expect(h.ctx.core.registerSession).not.toHaveBeenCalled();
    h.quick.dispose();
  });

  it("uses scanned settings for an unsaved Serial terminal and lets the exact tab save after a disconnect", async () => {
    const h = harness();
    ui.showQuickPick.mockImplementationOnce(async items => items[2]);
    await invoke("nexus.server.quickConnect");
    const [, , handlers] = ui.openForm.mock.calls[0] as [
      string, unknown, { onScan(): Promise<string>; onSubmit(values: FormValues): void }
    ];
    ui.scanForPort.mockResolvedValueOnce("/dev/ttyUSB0");
    await expect(handlers.onScan()).resolves.toBe("/dev/ttyUSB0");
    const baudRate = "9600";
    const profile = { name: "/dev/ttyUSB0", path: "/dev/ttyUSB0", baudRate: 9600, dataBits: 7, stopBits: 2, parity: "even" };
    ui.serialValuesToProfile.mockReturnValueOnce(profile);
    handlers.onSubmit({ path: profile.path, baudRate, dataBits: "7", stopBits: "2", parity: "even" });
    expect(ui.serialValuesToProfile).toHaveBeenCalledWith(expect.objectContaining({ path: profile.path, baudRate, mode: "standard" }));
    const terminal = ui.createTerminal.mock.results[0].value;
    expect(h.quick.listSerialPortOwners()).toEqual([{ path: profile.path, terminal }]);
    await invoke("nexus.server.saveQuickConnectProfile", terminal);
    expect(ui.saveProfile).not.toHaveBeenCalled();
    ui.serialPtys[0].callbacks.onSessionOpened("serial-id");
    ui.serialPtys[0].callbacks.onSessionClosed("serial-id");
    ui.serialPtys[0].getInputState.mockReturnValue({ status: "disconnected" });
    expect(h.quick.listSerialPortOwners()).toEqual([]);
    await invoke("nexus.server.saveQuickConnectProfile", terminal);
    expect(ui.saveProfile).toHaveBeenCalledWith(h.ctx, profile, expect.any(Function), expect.any(Function));
    expect(h.ctx.core.registerSession).not.toHaveBeenCalled();
    h.quick.dispose();
    expect(ui.serialPtys[0].dispose).toHaveBeenCalledOnce();
  });

  it("saves the exact successful tab after disconnect and refuses stale or explicit undefined targets", async () => {
    const h = harness();
    const a = await h.open("one@switch.example");
    const b = await h.open("two@switch.example");
    ui.activeTerminal = b;
    ui.sshPtys[0].callbacks.onSessionOpened();
    ui.sshPtys[0].callbacks.onDisconnected();
    ui.sshPtys[1].callbacks.onSessionOpened();

    invoke("nexus.server.saveQuickConnectProfile", {});
    invoke("nexus.server.saveQuickConnectProfile", undefined);
    expect(ui.saveProfile).not.toHaveBeenCalled();
    invoke("nexus.server.saveQuickConnectProfile", a);
    expect(ui.saveProfile).toHaveBeenLastCalledWith(
      h.ctx, expect.objectContaining({ username: "one" }), expect.any(Function), expect.any(Function)
    );
    const [,, isAvailable, onSaved] = ui.saveProfile.mock.calls[0];
    onSaved();
    expect(isAvailable()).toBe(false);
    await invoke("nexus.server.saveQuickConnectProfile");
    expect(ui.saveProfile).toHaveBeenLastCalledWith(
      h.ctx, expect.objectContaining({ username: "two" }), expect.any(Function), expect.any(Function)
    );
    h.quick.dispose();
    expect(ui.sshPtys.every(pty => pty.markShuttingDown.mock.calls.length === 1 && pty.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("retains the address on Back and applies a deliberate legacy SSH opt-in", async () => {
    const h = harness();
    const input = makeInput();
    ui.createInputBox.mockReturnValueOnce(input);
    const result = invoke("nexus.server.quickConnect");
    await vi.waitFor(() => expect(input.show).toHaveBeenCalled());
    input.enter("switch.example");
    input.trigger(0);
    expect(input.value).toBe("switch.example");
    input.trigger(1);
    input.enter("switch.example");
    input.enter("operator");
    await result;
    expect(ui.sshPtys[0]).toMatchObject({
      server: { host: "switch.example", username: "operator", legacyAlgorithms: true }
    });
    h.quick.dispose();
  });

  it("offers to reopen the failed address for editing", async () => {
    const h = harness();
    await h.open("telnet://switch.example:2001", "telnet");
    const retry = makeInput();
    ui.showErrorMessage.mockResolvedValueOnce("Edit Address…");
    ui.createInputBox.mockReturnValueOnce(retry);
    expect(ui.telnetPtys[0].callbacks.onConnectFailed("id", "Connection refused")).toBe(true);
    ui.telnetPtys[0].callbacks.onSessionClosed();
    await vi.waitFor(() => expect(retry.value).toBe("telnet://switch.example:2001"));
    expect(ui.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Connection refused"), "Edit Address…");
    retry.hide();
    h.quick.dispose();
  });
});

it("contributes a distinct save command in the Command Palette and on supported terminal surfaces", () => {
  const { contributes } = JSON.parse(readFileSync("package.json", "utf8"));
  const save = "nexus.server.saveQuickConnectProfile";
  const find = (entries: Array<{ command: string; when?: string }>, command: string) => entries.find(entry => entry.command === command);
  expect(find(contributes.commands, save)).toMatchObject({ title: "Save Quick Connect as Profile…" });
  expect(find(contributes.commands, "nexus.networkServer.profile.saveCurrent")).toMatchObject({ title: "Save DHCP/TFTP Settings as Profile…" });
  expect(find(contributes.menus.commandPalette, save)).toEqual({ command: save });
  for (const menu of ["terminal/context", "terminal/title/context"]) {
    expect(find(contributes.menus[menu], save)).toMatchObject({ when: "nexus.quickConnectHasSavableTerminal" });
  }
  expect(find(contributes.menus["editor/title/context"], save)).toBeUndefined();
});
