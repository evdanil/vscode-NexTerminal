import { beforeEach, describe, expect, it, vi } from "vitest";

const { readdirSyncMock } = vi.hoisted(() => ({ readdirSyncMock: vi.fn((_path: string): string[] => []) }));
vi.mock("node:fs", () => ({ readdirSync: readdirSyncMock }));

import { isAuthNotJudged, SshAgentUnavailableError } from "../../src/services/ssh/authErrors";
import {
  hostSshAgentLookup,
  listWindowsPipes,
  OPENSSH_AGENT_PIPE,
  resolveSshAgent,
  sshAgentHoldsNoKeysMessage,
  sshAgentUnusableMessage,
  toSshAgentMode,
  type SshAgentLookup
} from "../../src/services/ssh/sshAgentLocator";

const PAGEANT_ALICE = "pageant.alice.2f8a1c0e7b9d4f6a3c5e8b1d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a";
const OPENSSH = "openssh-ssh-agent";
const NO_AGENT_ON_WINDOWS =
  "No SSH agent found. Start Pageant (PuTTY 0.75 or newer), or the OpenSSH Authentication Agent service or another agent that provides its pipe (e.g. 1Password), or set nexus.ssh.agent to custom and enter the agent's pipe.";

function lookup(overrides: Partial<SshAgentLookup> = {}): SshAgentLookup {
  return {
    platform: "win32",
    env: {},
    mode: "auto",
    customPath: "",
    username: "alice",
    listPipes: vi.fn(() => []),
    ...overrides
  };
}

function refusal(input: SshAgentLookup): SshAgentUnavailableError {
  try {
    const choice = resolveSshAgent(input);
    throw new Error(`expected a refusal, got ${JSON.stringify(choice)}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SshAgentUnavailableError);
    return error as SshAgentUnavailableError;
  }
}

/**
 * The substrings `isAuthError` (silentAuth.ts) reads as "the server rejected
 * the credential" — the reading that deletes a saved password. An agent
 * message must never carry one, whatever the error's type.
 */
const SERVER_REJECTION_WORDING = /all configured authentication methods failed|authentication failed|auth fail/i;

describe("resolveSshAgent — auto", () => {
  it("uses SSH_AUTH_SOCK before looking for any Windows pipe (⊘ discovery first would pick Pageant over the agent the user's environment names)", () => {
    const listPipes = vi.fn(() => [PAGEANT_ALICE, OPENSSH]);
    const choice = resolveSshAgent(lookup({ env: { SSH_AUTH_SOCK: "\\\\.\\pipe\\my-agent" }, listPipes }));
    expect(choice).toMatchObject({ agent: "\\\\.\\pipe\\my-agent", source: "env" });
    expect(listPipes).not.toHaveBeenCalled();
  });

  it("keeps a Cygwin / MSYS SSH_AUTH_SOCK path as it is on Windows (today's behaviour)", () => {
    expect(resolveSshAgent(lookup({ env: { SSH_AUTH_SOCK: "/tmp/ssh-XXXX/agent.42" } }))).toMatchObject({
      agent: "/tmp/ssh-XXXX/agent.42",
      source: "env"
    });
  });

  it("finds this user's Pageant pipe when SSH_AUTH_SOCK is unset", () => {
    const choice = resolveSshAgent(lookup({ listPipes: () => ["some-other-pipe", PAGEANT_ALICE] }));
    expect(choice).toMatchObject({ agent: `\\\\.\\pipe\\${PAGEANT_ALICE}`, source: "pageant" });
    expect(choice.note).toMatch(/SSH_AUTH_SOCK unset/);
  });

  it("treats an empty SSH_AUTH_SOCK as unset", () => {
    expect(resolveSshAgent(lookup({ env: { SSH_AUTH_SOCK: "" }, listPipes: () => [PAGEANT_ALICE] })).source).toBe("pageant");
  });

  it("matches the user name case-insensitively, as Windows does", () => {
    const pipe = "pageant.Alice.abc123";
    expect(resolveSshAgent(lookup({ username: "ALICE", listPipes: () => [pipe] })).agent).toBe(`\\\\.\\pipe\\${pipe}`);
  });

  it("never uses another user's Pageant (⊘ matching any pageant.* pipe would sign with someone else's agent on a shared machine)", () => {
    const error = refusal(lookup({ listPipes: () => ["pageant.bob.abc123"] }));
    expect(error.proceedWithoutAgent).toBe(true);
  });

  /**
   * PuTTY names the pipe after the user principal name's prefix where Windows
   * has one (domain, Microsoft and Entra accounts), while Node reports the
   * account's SAM name — so the user's own Pageant can be under another name.
   * Nexus still never uses it (that waits for a Windows check of the pipe's
   * access rules), but it must not claim Pageant is absent: it names what it
   * found and the custom pipe that would use it.
   */
  it("names a Pageant running under another user name instead of saying none was found (⊘ 'No SSH agent found' while Pageant is plainly running)", () => {
    const error = refusal(lookup({ username: "jsmith", listPipes: () => ["pageant.john.smith.abc123", "some-other-pipe"] }));
    expect(error.message).toBe(
      'Pageant is running for user "john.smith", but this Windows account is "jsmith", so Nexus did not use it: \\\\.\\pipe\\pageant.john.smith.abc123. If that Pageant is yours, set nexus.ssh.agent to custom and enter that pipe (its name can change when Windows restarts); if not, start your own Pageant (0.75 or newer) or the OpenSSH Authentication Agent service.'
    );
    expect(error.message).not.toMatch(/No SSH agent found/);
    // Still "no agent key to offer": the login may carry on without one.
    expect(error.proceedWithoutAgent).toBe(true);
  });

  it("names every other-user Pageant when there are several", () => {
    const error = refusal(lookup({ listPipes: () => ["pageant.bob.a1", "pageant.carol.b2"] }));
    expect(error.message).toMatch(/^Pageant is running for users "bob", "carol", but this Windows account is "alice"/);
    expect(error.message).toContain("\\\\.\\pipe\\pageant.bob.a1, \\\\.\\pipe\\pageant.carol.b2");
    expect(error.message).toContain("If one of them is yours");
  });

  it("says in the log note which Pageant it skipped when it falls back to the OpenSSH agent", () => {
    const choice = resolveSshAgent(lookup({ listPipes: () => ["pageant.bob.abc", OPENSSH] }));
    expect(choice.source).toBe("openssh");
    expect(choice.note).toContain('Pageant is running for user "bob", not "alice"');
  });

  it("never chooses another user's pipe in any mode (⊘ a fallback onto a non-matching pipe)", () => {
    const foreign = "pageant.bob.abc123";
    for (const mode of ["auto", "pageant", "openssh"] as const) {
      for (const pipes of [[foreign], [foreign, OPENSSH]]) {
        try {
          expect(resolveSshAgent(lookup({ mode, listPipes: () => pipes })).agent).not.toContain(foreign);
        } catch (error) {
          expect(error).toBeInstanceOf(SshAgentUnavailableError);
        }
      }
    }
  });

  it("requires the dot after the user name (⊘ a bare prefix would hand alice the pipe of user 'alice2')", () => {
    expect(() => resolveSshAgent(lookup({ username: "ali", listPipes: () => [PAGEANT_ALICE] }))).toThrow(SshAgentUnavailableError);
  });

  it("never hands alice the pipe of user alice.bob (⊘ a prefix match reads pageant.alice.bob.<hash> as alice's)", () => {
    const error = refusal(lookup({ listPipes: () => ["pageant.alice.bob.abc123"] }));
    expect(error.message).toContain('Pageant is running for user "alice.bob", but this Windows account is "alice"');
  });

  it("does not assume the Pageant suffix is 64 hex characters, but requires one", () => {
    expect(resolveSshAgent(lookup({ listPipes: () => ["pageant.alice.x"] })).agent).toBe("\\\\.\\pipe\\pageant.alice.x");
    expect(() => resolveSshAgent(lookup({ listPipes: () => ["pageant.alice."] }))).toThrow(SshAgentUnavailableError);
  });

  it("prefers Pageant when both Pageant and the OpenSSH agent are running, and says how to pick the other", () => {
    const choice = resolveSshAgent(lookup({ listPipes: () => [OPENSSH, PAGEANT_ALICE] }));
    expect(choice.source).toBe("pageant");
    expect(choice.note).toMatch(/OpenSSH agent is running too/);
    expect(choice.note).toContain("nexus.ssh.agent");
  });

  it("falls back to the OpenSSH agent when no Pageant pipe belongs to this user", () => {
    expect(resolveSshAgent(lookup({ listPipes: () => ["pageant.bob.abc", OPENSSH] }))).toMatchObject({
      agent: OPENSSH_AGENT_PIPE,
      source: "openssh"
    });
    expect(OPENSSH_AGENT_PIPE).toBe("\\\\.\\pipe\\openssh-ssh-agent");
  });

  it("refuses to choose between two Pageant pipes of this user (⊘ picking one silently could sign with the wrong agent)", () => {
    const error = refusal(lookup({ listPipes: () => ["pageant.alice.aaa", "pageant.alice.bbb", OPENSSH] }));
    expect(error.message).toMatch(/2 Pageant pipes/);
    expect(error.message).toContain("custom");
    // A configuration the user has to resolve — not "no agent", so the login
    // must not carry on without one.
    expect(error.proceedWithoutAgent).toBe(false);
  });

  it("still tries the OpenSSH agent pipe when the pipe list cannot be read, says so — and marks the guess, so nothing there means no agent rather than a broken one", () => {
    const choice = resolveSshAgent(
      lookup({
        listPipes: () => {
          throw new Error("ENOTDIR: not a directory");
        }
      })
    );
    expect(choice).toMatchObject({ agent: OPENSSH_AGENT_PIPE, source: "openssh" });
    expect(choice.note).toMatch(/could not be read.*ENOTDIR/);
    // ⊘ an unmarked guess turns "nothing listens there" into a hard refusal
    // that removes a keyboard-interactive login which works today.
    expect(choice.ifUnreachable).toBeInstanceOf(SshAgentUnavailableError);
    expect(choice.ifUnreachable?.message).toBe(NO_AGENT_ON_WINDOWS);
    expect(choice.ifUnreachable?.proceedWithoutAgent).toBe(true);
  });

  it("marks nothing as a guess when the OpenSSH pipe was actually listed", () => {
    expect(resolveSshAgent(lookup({ listPipes: () => [OPENSSH] })).ifUnreachable).toBeUndefined();
  });

  it("names Pageant, the OpenSSH agent (or another agent on its pipe) and the custom setting when nothing is found on Windows — and lets the login carry on without an agent", () => {
    const error = refusal(lookup({ listPipes: () => ["some-other-pipe"] }));
    expect(error.message).toBe(NO_AGENT_ON_WINDOWS);
    expect(error.proceedWithoutAgent).toBe(true);
  });

  it("ignores SSH_AUTH_SOCK=pageant on Windows (⊘ ssh2 would try to spawn pagent.exe, which is not shipped) and looks for the pipe instead", () => {
    const choice = resolveSshAgent(lookup({ env: { SSH_AUTH_SOCK: "pageant" }, listPipes: () => [PAGEANT_ALICE] }));
    expect(choice.source).toBe("pageant");
    expect(choice.agent).not.toBe("pageant");
    expect(choice.note).toMatch(/SSH_AUTH_SOCK is "pageant"/);
  });

  for (const platform of ["linux", "darwin"] as const) {
    it(`never lists pipes on ${platform} (⊘ a Windows lookup elsewhere would be meaningless)`, () => {
      const listPipes = vi.fn(() => [PAGEANT_ALICE, OPENSSH]);
      expect(resolveSshAgent(lookup({ platform, env: { SSH_AUTH_SOCK: "/run/user/1000/agent" }, listPipes }))).toMatchObject({
        agent: "/run/user/1000/agent",
        source: "env"
      });
      const error = refusal(lookup({ platform, listPipes }));
      expect(error.message).toBe(
        "SSH_AUTH_SOCK is not set for VS Code, so there is no SSH agent to use. Start VS Code from a shell where your agent runs, or set nexus.ssh.agent to custom and enter the agent's socket path."
      );
      expect(error.proceedWithoutAgent).toBe(true);
      expect(listPipes).not.toHaveBeenCalled();
    });
  }

  it("passes \"pageant\" through off Windows, where ssh2 treats it as a socket path like any other", () => {
    expect(resolveSshAgent(lookup({ platform: "linux", env: { SSH_AUTH_SOCK: "pageant" } })).agent).toBe("pageant");
  });
});

describe("resolveSshAgent — explicit modes", () => {
  it("pageant: uses only Pageant, never the OpenSSH agent (⊘ a silent fallback would sign with an agent the user did not choose)", () => {
    const error = refusal(lookup({ mode: "pageant", listPipes: () => [OPENSSH] }));
    expect(error.message).toBe(
      "Pageant is not running, or it is older than 0.75 and has no named pipe. Start Pageant (0.75 or newer) or change nexus.ssh.agent."
    );
    expect(error.proceedWithoutAgent).toBe(false);
  });

  it("pageant: ignores SSH_AUTH_SOCK and finds the pipe", () => {
    expect(
      resolveSshAgent(lookup({ mode: "pageant", env: { SSH_AUTH_SOCK: "/tmp/agent" }, listPipes: () => [PAGEANT_ALICE] }))
    ).toMatchObject({ agent: `\\\\.\\pipe\\${PAGEANT_ALICE}`, source: "pageant" });
  });

  it("pageant: names a Pageant running under another user name, with this mode's remedy, and still refuses it", () => {
    const error = refusal(lookup({ mode: "pageant", username: "jsmith", listPipes: () => ["pageant.john.smith.abc123", OPENSSH] }));
    expect(error.message).toBe(
      'Pageant is running for user "john.smith", but this Windows account is "jsmith", so Nexus did not use it: \\\\.\\pipe\\pageant.john.smith.abc123. If that Pageant is yours, set nexus.ssh.agent to custom and enter that pipe (its name can change when Windows restarts); if not, start your own Pageant (0.75 or newer) or change nexus.ssh.agent.'
    );
    expect(error.proceedWithoutAgent).toBe(false);
  });

  it("pageant: refuses two pipes of this user, as auto does", () => {
    expect(refusal(lookup({ mode: "pageant", listPipes: () => ["pageant.alice.a", "pageant.alice.b"] })).message).toMatch(
      /2 Pageant pipes/
    );
  });

  it("openssh: uses only the OpenSSH agent, never Pageant", () => {
    const error = refusal(lookup({ mode: "openssh", listPipes: () => [PAGEANT_ALICE] }));
    expect(error.message).toBe(
      "Nothing is listening on the OpenSSH agent pipe (\\\\.\\pipe\\openssh-ssh-agent). Start the OpenSSH Authentication Agent service from Services, or another agent that provides this pipe (e.g. 1Password), or change nexus.ssh.agent."
    );
    expect(resolveSshAgent(lookup({ mode: "openssh", env: { SSH_AUTH_SOCK: "/tmp/agent" }, listPipes: () => [OPENSSH] }))).toMatchObject({
      agent: OPENSSH_AGENT_PIPE,
      source: "openssh"
    });
  });

  it("openssh: keeps a hard refusal when the pipe list cannot be read — the user chose this agent (no guess marker)", () => {
    const choice = resolveSshAgent(
      lookup({
        mode: "openssh",
        listPipes: () => {
          throw new Error("ENOTDIR");
        }
      })
    );
    expect(choice).toMatchObject({ agent: OPENSSH_AGENT_PIPE, source: "openssh" });
    expect(choice.ifUnreachable).toBeUndefined();
  });

  for (const mode of ["pageant", "openssh"] as const) {
    it(`${mode}: refuses off Windows with a remedy that exists there`, () => {
      const listPipes = vi.fn(() => [PAGEANT_ALICE, OPENSSH]);
      const error = refusal(lookup({ mode, platform: "linux", env: { SSH_AUTH_SOCK: "/tmp/agent" }, listPipes }));
      expect(error.message).toBe(
        `nexus.ssh.agent is ${mode}, which is Windows-only. On this system use auto (SSH_AUTH_SOCK) or custom.`
      );
      expect(listPipes).not.toHaveBeenCalled();
    });
  }

  it("custom: uses the trimmed path and nothing else", () => {
    const listPipes = vi.fn(() => [PAGEANT_ALICE]);
    expect(
      resolveSshAgent(lookup({ mode: "custom", customPath: "  /home/alice/.1password/agent.sock  ", env: { SSH_AUTH_SOCK: "/tmp/a" }, listPipes }))
    ).toMatchObject({ agent: "/home/alice/.1password/agent.sock", source: "custom" });
    expect(listPipes).not.toHaveBeenCalled();
  });

  it("custom: refuses an empty path, naming the setting to fill in", () => {
    for (const customPath of ["", "   "]) {
      const error = refusal(lookup({ mode: "custom", customPath }));
      expect(error.message).toBe(
        "nexus.ssh.agent is custom but nexus.ssh.agentPath is empty. Enter the agent's socket or pipe in nexus.ssh.agentPath, or set nexus.ssh.agent to auto."
      );
      expect(error.proceedWithoutAgent).toBe(false);
    }
  });

  it("custom: refuses the literal \"pageant\" on Windows (⊘ ssh2 would try to spawn pagent.exe, which is not shipped)", () => {
    expect(refusal(lookup({ mode: "custom", customPath: "pageant" })).message).toMatch(/set nexus\.ssh\.agent to pageant/);
  });
});

describe("agent messages", () => {
  it("never use the wording that marks a server rejection (⊘ isAuthError would read them as a rejected password and delete it)", () => {
    const messages: string[] = [];
    const collect = (input: SshAgentLookup): void => {
      try {
        resolveSshAgent(input);
      } catch (error) {
        messages.push((error as Error).message);
      }
    };
    collect(lookup());
    collect(lookup({ platform: "linux" }));
    collect(lookup({ mode: "pageant" }));
    collect(lookup({ mode: "openssh" }));
    collect(lookup({ mode: "pageant", platform: "darwin" }));
    collect(lookup({ mode: "custom" }));
    collect(lookup({ mode: "custom", customPath: "pageant" }));
    collect(lookup({ listPipes: () => ["pageant.alice.a", "pageant.alice.b"] }));
    collect(lookup({ listPipes: () => ["pageant.bob.a"] }));
    collect(lookup({ mode: "pageant", listPipes: () => ["pageant.bob.a", "pageant.carol.b"] }));
    for (const source of ["env", "pageant", "openssh", "custom"] as const) {
      const choice = { agent: "/tmp/agent", source, note: "" };
      messages.push(sshAgentHoldsNoKeysMessage(choice));
      messages.push(sshAgentUnusableMessage(choice, new Error("Failed to connect to agent"), "linux"));
    }
    for (const agent of ["\\\\.\\pipe\\openssh-ssh-agent", "/tmp/ssh-XXXX/agent.1"]) {
      messages.push(sshAgentUnusableMessage({ agent, source: "env", note: "" }, new Error("Failed to connect to agent"), "win32"));
    }
    const guess = resolveSshAgent(
      lookup({
        listPipes: () => {
          throw new Error("x");
        }
      })
    );
    messages.push(guess.ifUnreachable!.message);
    expect(messages).toHaveLength(21);
    for (const message of messages) {
      expect(message).not.toMatch(SERVER_REJECTION_WORDING);
    }
  });

  it("say where the agent was and what to do when it holds no keys", () => {
    expect(sshAgentHoldsNoKeysMessage({ agent: "\\\\.\\pipe\\pageant.alice.x", source: "pageant", note: "" })).toBe(
      "The SSH agent at \\\\.\\pipe\\pageant.alice.x (Pageant) holds no keys. Add your key in Pageant (Add Key) or with ssh-add, or unlock the agent (ssh-add -X), then connect again."
    );
  });

  it("give each source a remedy that can actually fix it when the agent cannot be used", () => {
    const failure = new Error("Failed to connect to agent");
    expect(sshAgentUnusableMessage({ agent: "/tmp/stale", source: "env", note: "" }, failure, "linux")).toBe(
      "Could not use the SSH agent at /tmp/stale (SSH_AUTH_SOCK): Failed to connect to agent. Start VS Code from a shell where your agent runs, or set nexus.ssh.agent to custom and enter the agent's socket path."
    );
    expect(sshAgentUnusableMessage({ agent: "/tmp/stale", source: "env", note: "" }, failure, "darwin")).toMatch(
      /Start VS Code from a shell where your agent runs/
    );
    for (const platform of ["win32", "linux"] as const) {
      expect(sshAgentUnusableMessage({ agent: "p", source: "pageant", note: "" }, failure, platform)).toMatch(/Restart Pageant and connect again\.$/);
      expect(sshAgentUnusableMessage({ agent: "p", source: "openssh", note: "" }, failure, platform)).toMatch(
        /\(OpenSSH Authentication Agent\).*Restart the OpenSSH Authentication Agent service, or the other agent that provides this pipe \(e\.g\. 1Password\), and connect again\.$/
      );
      expect(sshAgentUnusableMessage({ agent: "p", source: "custom", note: "" }, failure, platform)).toMatch(
        /\(nexus\.ssh\.agentPath\).*Check nexus\.ssh\.agentPath and that the agent is running, then connect again\.$/
      );
    }
  });

  /**
   * On Windows SSH_AUTH_SOCK is usually set for the whole user or system, so
   * starting VS Code from another shell changes nothing — a refusal naming
   * that remedy names one that cannot happen (found on a real Windows machine
   * with a global SSH_AUTH_SOCK at the OpenSSH pipe and only Pageant running).
   */
  describe("SSH_AUTH_SOCK that cannot be reached, on Windows", () => {
    const failure = new Error("Failed to connect to agent");

    it("names the agent behind the OpenSSH pipe, the setting that picks another agent, and removing the variable (⊘ 'Start VS Code from a shell', which a global variable ignores)", () => {
      const message = sshAgentUnusableMessage({ agent: "\\\\.\\pipe\\openssh-ssh-agent", source: "env", note: "" }, failure, "win32");
      expect(message).toBe(
        "Could not use the SSH agent at \\\\.\\pipe\\openssh-ssh-agent (SSH_AUTH_SOCK): Failed to connect to agent. Start the agent SSH_AUTH_SOCK points to (the OpenSSH Authentication Agent service, or another agent that provides this pipe, e.g. 1Password), or set nexus.ssh.agent to the agent Nexus should use instead, such as pageant. Or remove SSH_AUTH_SOCK from the Windows environment and fully restart VS Code, so Automatic finds Pageant or the OpenSSH agent itself."
      );
      expect(message).not.toContain("Start VS Code from a shell");
    });

    it("recognises the OpenSSH pipe however it is spelled (ssh2 accepts either slash, Windows any case)", () => {
      for (const agent of ["//./pipe/openssh-ssh-agent", "\\\\.\\pipe\\OpenSSH-SSH-Agent"]) {
        expect(sshAgentUnusableMessage({ agent, source: "env", note: "" }, failure, "win32")).toContain(
          "(the OpenSSH Authentication Agent service, or another agent that provides this pipe, e.g. 1Password)"
        );
      }
    });

    it("for any other agent behind SSH_AUTH_SOCK, names starting it, the setting and removing the variable — never a service it is not", () => {
      const message = sshAgentUnusableMessage({ agent: "/tmp/ssh-XXXX/agent.1234", source: "env", note: "" }, failure, "win32");
      expect(message).toBe(
        "Could not use the SSH agent at /tmp/ssh-XXXX/agent.1234 (SSH_AUTH_SOCK): Failed to connect to agent. Start the agent SSH_AUTH_SOCK points to, or set nexus.ssh.agent to the agent Nexus should use instead, such as pageant. Or remove SSH_AUTH_SOCK from the Windows environment and fully restart VS Code, so Automatic finds Pageant or the OpenSSH agent itself."
      );
      expect(message).not.toContain("Start VS Code from a shell");
      expect(message).not.toContain("OpenSSH Authentication Agent service");
    });
  });
});

describe("SshAgentUnavailableError", () => {
  it("is a login the server never judged, so no saved secret is ever deleted for it", () => {
    const error = new SshAgentUnavailableError("x");
    expect(isAuthNotJudged(error)).toBe(true);
    expect(error.name).toBe("SshAgentUnavailableError");
    expect(error.proceedWithoutAgent).toBe(false);
    expect(new SshAgentUnavailableError("x", { proceedWithoutAgent: true }).proceedWithoutAgent).toBe(true);
    const cause = new Error("inner");
    expect(new SshAgentUnavailableError("x", { cause }).cause).toBe(cause);
  });
});

describe("toSshAgentMode", () => {
  it("accepts the four modes and reads anything else as auto", () => {
    for (const mode of ["auto", "pageant", "openssh", "custom"]) {
      expect(toSshAgentMode(mode)).toBe(mode);
    }
    for (const junk of [undefined, null, "", "Pageant", 3, {}]) {
      expect(toSshAgentMode(junk)).toBe("auto");
    }
  });
});

describe("listWindowsPipes", () => {
  beforeEach(() => {
    readdirSyncMock.mockClear();
  });

  it("lists \\\\.\\pipe\\ WITH the trailing backslash (⊘ without it Node fails with ENOTDIR and Pageant is never found)", () => {
    readdirSyncMock.mockReturnValueOnce([PAGEANT_ALICE]);
    expect(listWindowsPipes()).toEqual([PAGEANT_ALICE]);
    expect(readdirSyncMock).toHaveBeenCalledTimes(1);
    expect(readdirSyncMock.mock.calls[0][0]).toBe("\\\\.\\pipe\\");
  });

  it("is what the host lookup uses, together with the process environment and platform", () => {
    const host = hostSshAgentLookup({ mode: "custom", customPath: "/x" });
    expect(host).toMatchObject({ mode: "custom", customPath: "/x", platform: process.platform, env: process.env });
    expect(host.listPipes).toBe(listWindowsPipes);
    expect(typeof host.username).toBe("string");
  });
});
