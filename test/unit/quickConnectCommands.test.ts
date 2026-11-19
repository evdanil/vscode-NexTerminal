import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";

const ui = vi.hoisted(() => ({
  activeTerminal: undefined as object | undefined,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  createInputBox: vi.fn(),
  createTerminal: vi.fn(),
  executeCommand: vi.fn(),
  saveProfile: vi.fn(),
  showErrorMessage: vi.fn(),
  sshPtys: [] as Array<FakePty>,
  telnetPtys: [] as Array<FakePty>
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
    showInformationMessage: vi.fn(),
    showErrorMessage: ui.showErrorMessage,
    createTerminal: ui.createTerminal
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, value: unknown) => value }) }
}));

vi.mock("../../src/commands/profileCommands", () => ({ openQuickConnectProfileForm: ui.saveProfile }));
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
  ui.activeTerminal = undefined;
  ui.createTerminal.mockImplementation(() => ({ creationOptions: {}, show: vi.fn() }));
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
    async function open(value: string) {
      const input = makeInput();
      ui.createInputBox.mockReturnValueOnce(input);
      const result = invoke("nexus.server.quickConnect");
      input.enter(value);
      await result;
      return ui.createTerminal.mock.results.at(-1)!.value;
    }
    return { ctx, quick, factory, open };
  }

  it("opens a direct Telnet tab without SSH authentication or a stored profile", async () => {
    const h = harness();
    await h.open("telnet://switch.example");
    ui.telnetPtys[0].callbacks.onSessionOpened();
    expect(ui.telnetPtys).toHaveLength(1);
    expect(ui.sshPtys).toHaveLength(0);
    expect(h.factory.connect).not.toHaveBeenCalled();
    expect(h.ctx.core.addOrUpdateServer).not.toHaveBeenCalled();
    expect(h.ctx.core.registerSession).not.toHaveBeenCalled();
    h.quick.dispose();
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
    invoke("nexus.server.saveQuickConnectProfile");
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
    input.enter("switch.example");
    input.trigger(0);
    expect(input.value).toBe("switch.example");
    input.trigger(0);
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
    await h.open("telnet://switch.example:2001");
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
