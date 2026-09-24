import { describe, expect, it } from "vitest";
import { resolveScriptSessionForTerminal, resolveSessionForTerminal } from "../../src/utils/terminalSessionLookup";

describe("resolveSessionForTerminal", () => {
  it("finds SSH, Serial, and Local Shell sessions for active VS Code terminals", () => {
    const sshTerminal = { name: "ssh" } as any;
    const serialTerminal = { name: "serial" } as any;
    const localShellTerminal = { name: "local" } as any;

    const sessionTerminals = new Map<string, any>([["ssh-session", sshTerminal]]);
    const serialTerminals = new Map<string, any>([
      ["serial-session", { terminal: serialTerminal, profileId: "serial-profile" }]
    ]);
    const localShellTerminals = new Map<string, any>([
      ["local-session", { terminal: localShellTerminal, profileId: "local-profile" }]
    ]);

    expect(resolveSessionForTerminal(sshTerminal, sessionTerminals, serialTerminals, localShellTerminals)).toBe("ssh-session");
    expect(resolveSessionForTerminal(serialTerminal, sessionTerminals, serialTerminals, localShellTerminals)).toBe("serial-session");
    expect(resolveSessionForTerminal(localShellTerminal, sessionTerminals, serialTerminals, localShellTerminals)).toBe("local-session");
    expect(resolveSessionForTerminal({ name: "other" } as any, sessionTerminals, serialTerminals, localShellTerminals)).toBeUndefined();
  });

  it("finds SSH, Serial, and Local Shell sessions for script quick-run lookup", () => {
    const sshTerminal = { name: "ssh" } as any;
    const serialTerminal = { name: "serial" } as any;
    const localShellTerminal = { name: "local" } as any;

    const sessionTerminals = new Map<string, any>([["ssh-session", sshTerminal]]);
    const serialTerminals = new Map<string, any>([
      ["serial-session", { terminal: serialTerminal, profileId: "serial-profile" }]
    ]);
    const localShellTerminals = new Map<string, any>([
      ["local-session", { terminal: localShellTerminal, profileId: "local-profile" }]
    ]);

    expect(resolveScriptSessionForTerminal(sshTerminal, sessionTerminals, serialTerminals, localShellTerminals)).toBe("ssh-session");
    expect(resolveScriptSessionForTerminal(serialTerminal, sessionTerminals, serialTerminals, localShellTerminals)).toBe("serial-session");
    expect(resolveScriptSessionForTerminal(localShellTerminal, sessionTerminals, serialTerminals, localShellTerminals)).toBe("local-session");
  });

  it("script lookup ignores a Local Server terminal, so Quick Run treats it like a plain terminal (#155)", () => {
    const localServerTerminal = { name: "Nexus Local Server: api" } as any;
    const localServerTerminals = new Map<string, any>([
      ["local-server-session", { terminal: localServerTerminal, profileId: "api" }]
    ]);

    // The general lookup still finds it — focus tracking needs that.
    expect(
      resolveSessionForTerminal(localServerTerminal, new Map(), new Map(), new Map(), localServerTerminals)
    ).toBe("local-server-session");
    // ⊘ the script lookup as an alias of the general one, handed every map as
    // the extension used to: it returned the Local Server session id, which
    // the script runtime cannot bind to, so Quick Run did nothing and said
    // nothing instead of offering the session picker.
    expect(
      (resolveScriptSessionForTerminal as (...args: unknown[]) => string | undefined)(
        localServerTerminal,
        new Map(),
        new Map(),
        new Map(),
        localServerTerminals
      )
    ).toBeUndefined();
  });
});
