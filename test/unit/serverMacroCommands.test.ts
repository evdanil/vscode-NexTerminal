import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/models/config";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import type { CommandContext } from "../../src/commands/types";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const showQuickPick = vi.fn();
const showWarningMessage = vi.fn();
const showErrorMessage = vi.fn();
const showInformationMessage = vi.fn();
const setStatusBarMessage = vi.fn();
const executeCommand = vi.fn();
const openExternal = vi.fn(async () => true);
const createdTerminals: Array<{ name: string; sent: string[] }> = [];
let openTerminals: Array<{ name: string; sendText: (text: string, addNewLine?: boolean) => void; exitStatus?: unknown }> = [];

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: (...args: unknown[]) => executeCommand(...args)
  },
  window: {
    showQuickPick: (...args: unknown[]) => showQuickPick(...args),
    showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
    showErrorMessage: (...args: unknown[]) => showErrorMessage(...args),
    showInformationMessage: (...args: unknown[]) => showInformationMessage(...args),
    setStatusBarMessage: (...args: unknown[]) => setStatusBarMessage(...args),
    createInputBox: vi.fn(),
    createTerminal: vi.fn((options: { name: string }) => {
      const record = { name: options.name, sent: [] as string[] };
      createdTerminals.push(record);
      return {
        name: options.name,
        show: vi.fn(),
        sendText: (text: string) => record.sent.push(text)
      };
    }),
    get terminals() {
      return openTerminals;
    },
    activeTerminal: undefined as unknown
  },
  env: {
    openExternal: (...args: unknown[]) => openExternal(...args)
  },
  Uri: {
    parse: (value: string) => ({ toString: () => value, value })
  },
  QuickInputButtons: { Back: {} }
}));

// The server-resolution helpers are exercised by serverCommands.test.ts; mocking
// them here keeps this file about macro dispatch and off the SSH/keygen imports.
const pickServer = vi.fn();
const connectServer = vi.fn(async () => {});
vi.mock("../../src/commands/serverCommands", () => ({
  pickServer: (...args: unknown[]) => pickServer(...args),
  connectServer: (...args: unknown[]) => connectServer(...args),
  toServerFromArg: (_core: unknown, arg: unknown) =>
    arg && typeof arg === "object" && "server" in arg ? (arg as { server: ServerConfig }).server : undefined
}));

import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";
import {
  buildServerMacroPicks,
  resolveMacroBrowserUrl,
  runMacroOnServer
} from "../../src/commands/serverMacroCommands";

const store = new InMemoryMacroStore();

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Core Switch",
    host: "10.1.2.3",
    port: 22,
    username: "admin",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    core: {
      getSnapshot: () => ({ activeSessions: [], servers: [] }),
      onDidChange: () => () => {}
    },
    sessionTerminals: new Map(),
    ...overrides
  } as unknown as CommandContext;
}

async function setMacros(macros: TerminalMacro[]): Promise<void> {
  await store.save(macros);
}

beforeEach(async () => {
  registeredCommands.clear();
  showQuickPick.mockReset();
  showWarningMessage.mockReset();
  showErrorMessage.mockReset();
  showInformationMessage.mockReset();
  setStatusBarMessage.mockReset();
  executeCommand.mockReset();
  openExternal.mockClear();
  pickServer.mockReset();
  connectServer.mockReset();
  createdTerminals.length = 0;
  openTerminals = [];
  setActiveMacroStore(store);
  await store.clearAll();
});

describe("resolveMacroBrowserUrl", () => {
  it("accepts http and https", () => {
    expect(resolveMacroBrowserUrl("https://10.0.0.9/")).toBe("https://10.0.0.9/");
    expect(resolveMacroBrowserUrl("http://bmc.example.com/redfish")).toBe("http://bmc.example.com/redfish");
  });

  it("refuses every other scheme, and anything that is not a URL", () => {
    expect(resolveMacroBrowserUrl("javascript:alert(1)")).toBeUndefined();
    expect(resolveMacroBrowserUrl("file:///etc/passwd")).toBeUndefined();
    expect(resolveMacroBrowserUrl("vscode://extension/x")).toBeUndefined();
    expect(resolveMacroBrowserUrl("10.0.0.9")).toBeUndefined();
    expect(resolveMacroBrowserUrl("")).toBeUndefined();
  });
});

describe("buildServerMacroPicks", () => {
  it("sorts profile-token macros first without reordering the rest", async () => {
    const macros: TerminalMacro[] = [
      { id: "a", name: "Plain A", text: "show version\n" },
      { id: "b", name: "Uses profile", text: "ping ${profile.host}\n" },
      { id: "c", name: "Plain C", text: "show clock\n" }
    ];
    const picks = buildServerMacroPicks(macros, server());
    expect(picks.map((p) => p.label)).toEqual(["Uses profile", "Plain A", "Plain C"]);
  });

  it("lists a macro that needs an IPMI host the server lacks, and flags it", () => {
    const macros: TerminalMacro[] = [{ id: "a", name: "SOL", text: "ipmitool -H ${profile.ipmiHost}\n" }];
    const picks = buildServerMacroPicks(macros, server());
    // Listed, not hidden — hiding makes the feature undiscoverable.
    expect(picks).toHaveLength(1);
    expect(picks[0].issue?.token).toBe("ipmiHost");
    expect(picks[0].detail).toContain("IPMI / BMC Host");
  });

  it("does not flag it once the server has one", () => {
    const macros: TerminalMacro[] = [{ id: "a", name: "SOL", text: "ipmitool -H ${profile.ipmiHost}\n" }];
    const picks = buildServerMacroPicks(macros, server({ ipmiHost: "10.0.0.9" }));
    expect(picks[0].issue).toBeUndefined();
    expect(picks[0].detail).toBeUndefined();
  });

  it("redacts a secret macro's value and marks a prompting macro", () => {
    const macros: TerminalMacro[] = [
      { id: "a", name: "Password", text: "hunter2\n", secret: true },
      { id: "b", name: "Prompted", text: "ssh $user@host\n", variables: [{ name: "user" }] }
    ];
    const picks = buildServerMacroPicks(macros, server());
    expect(picks[0].description).toContain("***");
    expect(picks[0].description).not.toContain("hunter2");
    expect(picks[1].description).not.toBe("ssh $user@host\\n");
  });

  it("badges a macro that does not run in the session", () => {
    const macros: TerminalMacro[] = [{ id: "a", name: "BMC", text: "https://x/", runIn: "browser" }];
    expect(buildServerMacroPicks(macros, server())[0].description).toContain("[Browser]");
  });
});

describe("nexus.server.runMacro — dispatch", () => {
  it("opens an https URL for a browser macro, with the profile token filled in", async () => {
    await setMacros([{ id: "a", name: "BMC", text: "https://${profile.ipmiHost}/", runIn: "browser" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server({ ipmiHost: "10.0.0.9" }) });

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect((openExternal.mock.calls[0][0] as { value: string }).value).toBe("https://10.0.0.9/");
  });

  it("refuses a javascript: URL — nothing is opened and the failure is reported", async () => {
    await setMacros([{ id: "a", name: "Evil", text: "javascript:alert(1)", runIn: "browser" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server() });

    expect(openExternal).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalled();
    // Never claim a send for something that was refused.
    expect(setStatusBarMessage).not.toHaveBeenCalled();
  });

  it("runs a localTerminal macro in a fresh terminal, never through sendSequence", async () => {
    await setMacros([
      { id: "a", name: "SOL", text: " ipmitool -H ${profile.ipmiHost} sol activate\n", runIn: "localTerminal" }
    ]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server({ ipmiHost: "10.0.0.9" }) });

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].sent).toEqual([" ipmitool -H 10.0.0.9 sol activate\n"]);
    // `workbench.action.terminal.sendSequence` targets whatever terminal is
    // focused — the exact mis-delivery this command exists to avoid.
    expect(executeCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  it("refuses a macro whose ipmiHost the server lacks, and offers Edit Server", async () => {
    await setMacros([{ id: "a", name: "SOL", text: "ipmitool -H ${profile.ipmiHost}\n", runIn: "localTerminal" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue("Edit Server");

    const target = server();
    await runMacroOnServer(context(), { server: target });

    // Nothing sent anywhere — not a literal token, not an empty -H argument.
    expect(createdTerminals).toHaveLength(0);
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("IPMI / BMC Host");
    // `expandAdvanced` — "IPMI / BMC Host" lives behind the form's Advanced
    // section, so the button must open it rather than land on a collapsed field.
    expect(executeCommand).toHaveBeenCalledWith("nexus.server.edit", { server: target, expandAdvanced: true });
  });

  it("refuses a host that carries shell syntax before anything is run", async () => {
    await setMacros([{ id: "a", name: "Ping", text: "ping ${profile.host}\n", runIn: "localTerminal" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue(undefined);

    await runMacroOnServer(context(), { server: server({ host: "1.2.3.4; rm -rf ~" }) });

    expect(createdTerminals).toHaveLength(0);
    expect(showErrorMessage).toHaveBeenCalled();
  });

  it("sends a session macro to THIS server's session terminal, not the active terminal", async () => {
    await setMacros([{ id: "a", name: "Version", text: "show version\n" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    const sent: string[] = [];
    const sessionTerminal = { name: "Nexus SSH: Core Switch", sendText: (text: string) => sent.push(text) };
    const otherTerminal = { name: "Some other host", sendText: () => expect.unreachable("wrong terminal") };
    openTerminals = [otherTerminal, sessionTerminal];

    const ctx = context({
      core: {
        getSnapshot: () => ({ activeSessions: [{ id: "sess-1", serverId: "srv-1" }], servers: [] }),
        onDidChange: () => () => {}
      },
      sessionTerminals: new Map([["sess-1", sessionTerminal]])
    } as unknown as Partial<CommandContext>);

    await runMacroOnServer(ctx, { server: server() });

    expect(sent).toEqual(["show version\n"]);
  });

  it("offers to connect first when the server has no session, and sends nothing if declined", async () => {
    await setMacros([{ id: "a", name: "Version", text: "show version\n" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showWarningMessage.mockResolvedValue(undefined);

    await runMacroOnServer(context(), { server: server() });

    expect(String(showWarningMessage.mock.calls[0][0])).toContain("not connected");
    expect(connectServer).not.toHaveBeenCalled();
    expect(setStatusBarMessage).not.toHaveBeenCalled();
  });

  it("runs a preselected macro without ever showing the macro picker", async () => {
    // The redirect from `nexus.macro.run` / a keybinding already knows WHICH
    // macro — it only lacks a server. Re-asking would cost the user the
    // selection they just made.
    await setMacros([
      { id: "a", name: "Other", text: "show version\n" },
      { id: "b", name: "BMC", text: "https://${profile.ipmiHost}/", runIn: "browser" }
    ]);

    await runMacroOnServer(context(), { server: server({ ipmiHost: "10.0.0.9" }), macro: { id: "b" } });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect((openExternal.mock.calls[0][0] as { value: string }).value).toBe("https://10.0.0.9/");
  });

  it("prefers the STORED record over the macro object the caller was holding", async () => {
    // The caller's copy can be stale — the store is the source of truth for what
    // running this macro does.
    await setMacros([{ id: "b", name: "BMC", text: "https://${profile.ipmiHost}/edited", runIn: "browser" }]);

    await runMacroOnServer(context(), {
      server: server({ ipmiHost: "10.0.0.9" }),
      macro: { id: "b", name: "BMC", text: "https://stale.example.com/", runIn: "browser" }
    });

    expect((openExternal.mock.calls[0][0] as { value: string }).value).toBe("https://10.0.0.9/edited");
  });

  it("still opens the picker for a server argument that names no macro", async () => {
    await setMacros([{ id: "a", name: "Version", text: "show version\n" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showWarningMessage.mockResolvedValue(undefined);

    await runMacroOnServer(context(), { server: server() });

    expect(showQuickPick).toHaveBeenCalled();
  });

  it("points at the templates when there are no macros at all", async () => {
    showInformationMessage.mockResolvedValue("Add From Template…");

    await runMacroOnServer(context(), { server: server() });

    expect(String(showInformationMessage.mock.calls[0][0])).toContain("IPMI templates");
    // Both routes offered; the template one is what this command exists for.
    expect(showInformationMessage.mock.calls[0].slice(1)).toEqual(["Add From Template…", "Add Blank Macro"]);
    expect(executeCommand).toHaveBeenCalledWith("nexus.macro.addFromTemplate");
  });

  it("offers Edit Macro when a browser macro's text is not a URL", async () => {
    await setMacros([{ id: "a", name: "Evil", text: "javascript:alert(1)", runIn: "browser" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue("Edit Macro");

    await runMacroOnServer(context(), { server: server() });

    // The fix is in the macro's text, so the repair button opens the macro —
    // the mirror of the Edit Server button on a profile-token refusal.
    expect(showErrorMessage.mock.calls[0][1]).toBe("Edit Macro");
    expect(executeCommand).toHaveBeenCalledWith(
      "nexus.macro.edit",
      expect.objectContaining({ index: 0 })
    );
  });

  it("falls back to the server picker when invoked from the palette", async () => {
    await setMacros([{ id: "a", name: "BMC", text: "https://${profile.ipmiHost}/", runIn: "browser" }]);
    pickServer.mockResolvedValue(server({ ipmiHost: "10.0.0.9" }));
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), undefined);

    expect(pickServer).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
