import { describe, expect, it } from "vitest";
import { AuthNotJudgedError, SshAgentUnavailableError } from "../../src/services/ssh/authErrors";
import { classifySshConnectionError } from "../../src/services/ssh/connectionDiagnostics";

describe("classifySshConnectionError", () => {
  it("classifies DNS resolution failures with a stable suggestion", () => {
    const result = classifySshConnectionError(new Error("getaddrinfo ENOTFOUND missing.example.com"));
    expect(result).toMatchObject({
      ok: false,
      stage: "dns",
      title: "Host name could not be resolved",
      suggestion: "Check the host name, DNS settings, or VPN connection, then try again."
    });
  });

  it("classifies TCP timeouts", () => {
    const result = classifySshConnectionError(new Error("connect ETIMEDOUT 203.0.113.10:22"));
    expect(result).toMatchObject({
      ok: false,
      stage: "tcp",
      title: "Connection timed out",
      suggestion: "Verify the host is reachable, the port is correct, and firewalls allow SSH traffic."
    });
  });

  it("classifies refused TCP connections", () => {
    const result = classifySshConnectionError(new Error("connect ECONNREFUSED 203.0.113.10:22"));
    expect(result).toMatchObject({
      ok: false,
      stage: "tcp",
      title: "Connection refused",
      suggestion: "Verify the SSH service is running on the target port and accepting connections."
    });
  });

  // ALTERNATE HOST (issue #48) — the four "unreachable" shapes MUST classify as
  // `tcp`, not `unknown`: the SshPty connect-fallback only retries the alternate
  // address on a `tcp`/`dns` stage, so an `unknown` here silently defeats the
  // whole feature for its headline scenario (a primary host on an unroutable IP
  // family). Against 0f9e47b these expected `stage: "tcp"` — the matcher returned
  // `unknown`.
  it("classifies ENETUNREACH (no network route) as a TCP-stage failure so the fallback fires", () => {
    const result = classifySshConnectionError(new Error("connect ENETUNREACH 2001:db8::1:22 - Local (:::0)"));
    expect(result).toMatchObject({
      ok: false,
      stage: "tcp",
      title: "Host unreachable"
    });
  });

  it("classifies EHOSTUNREACH as a TCP-stage failure", () => {
    const result = classifySshConnectionError(new Error("connect EHOSTUNREACH 203.0.113.10:22"));
    expect(result).toMatchObject({
      ok: false,
      stage: "tcp",
      title: "Host unreachable"
    });
  });

  it("classifies a lower-cased 'no route to host' message as a TCP-stage failure", () => {
    const result = classifySshConnectionError(new Error("No route to host"));
    expect(result).toMatchObject({ ok: false, stage: "tcp", title: "Host unreachable" });
  });

  it("classifies a 'network is unreachable' message as a TCP-stage failure", () => {
    const result = classifySshConnectionError(new Error("Network is unreachable"));
    expect(result).toMatchObject({ ok: false, stage: "tcp", title: "Host unreachable" });
  });

  it("leaves ECONNRESET a mid-handshake reset UNKNOWN — a reachable-but-flaky host must not auto-fall-back", () => {
    // Deliberately NOT `tcp`: the peer was reachable and answered, then dropped
    // the connection, so re-attempting the alternate could double-prompt / trip a
    // lockout. This asserts the conservative decision documented in the matcher.
    const result = classifySshConnectionError(new Error("read ECONNRESET"));
    expect(result.stage).toBe("unknown");
  });

  it.each([
    "SSH connection closed before authentication completed",
    "SSH connection attempt ended before authentication completed",
    "Keyboard-interactive authentication canceled"
  ])("does not report an unjudged login (%s) as a credential rejection", (message) => {
    const result = classifySshConnectionError(new AuthNotJudgedError(message));
    expect(result.stage).toBe("unknown");
    expect(result.title).toBe("SSH connection failed");
    expect(result.detail).not.toContain("rejected the");
    expect(result.title).not.toContain("Authentication");
  });

  it("still classifies a genuine server rejection as an auth failure", () => {
    expect(classifySshConnectionError(new Error("All configured authentication methods failed")).stage).toBe("auth");
  });

  it("classifies authentication failures without echoing secrets", () => {
    const result = classifySshConnectionError(
      new Error("All configured authentication methods failed for password hunter2")
    );
    expect(result).toMatchObject({
      ok: false,
      stage: "auth",
      title: "Authentication failed",
      suggestion: "Check the username and selected authentication method, then update stored credentials if needed."
    });
    expect(`${result.title} ${result.detail} ${result.suggestion}`).not.toContain("hunter2");
  });

  it("classifies changed or rejected host keys", () => {
    const result = classifySshConnectionError(new Error("REMOTE HOST IDENTIFICATION HAS CHANGED"));
    expect(result).toMatchObject({
      ok: false,
      stage: "host-key",
      title: "Host key verification failed",
      suggestion: "Verify the server identity. If the change is expected, remove the old trusted host key and reconnect."
    });
  });

  it("classifies ssh2 host verifier rejections as host-key failures", () => {
    const result = classifySshConnectionError(new Error("Host denied (verification failed)"));
    expect(result).toMatchObject({
      ok: false,
      stage: "host-key",
      title: "Host key verification failed",
      suggestion: "Verify the server identity. If the change is expected, remove the old trusted host key and reconnect."
    });
  });

  it("classifies unsupported private keys and passphrase problems", () => {
    const result = classifySshConnectionError(new Error("Cannot parse privateKey: Unsupported key format"));
    expect(result).toMatchObject({
      ok: false,
      stage: "key",
      title: "Private key could not be used",
      suggestion: "Use a supported OpenSSH private key, or update the saved key path/passphrase and try again."
    });
  });

  it("classifies proxy failures", () => {
    const result = classifySshConnectionError(new Error("HTTP CONNECT proxy failed with status 407"));
    expect(result).toMatchObject({
      ok: false,
      stage: "proxy",
      title: "Proxy connection failed",
      suggestion: "Check the proxy server, credentials, and jump-host settings before retrying."
    });
  });

  // PR #67 Codex round 3 P2a — the broad `/proxy|socks|jump-host/` keyword must NOT
  // win over concrete DNS/TCP errno signatures, otherwise a DIRECT target whose
  // hostname merely CONTAINS one of those words has its connect-fallback disabled.
  // Against the pre-fix ordering (broad proxy keyword checked first) these returned
  // `proxy`, which the SshPty gate treats as non-connection-level and rethrows.
  it("classifies a DNS failure on a hostname containing 'proxy' as dns (not proxy) so fallback fires", () => {
    const result = classifySshConnectionError(new Error("getaddrinfo ENOTFOUND proxy01.example.com"));
    expect(result.stage).toBe("dns");
  });

  it("classifies a TCP timeout on a hostname containing 'socks' as tcp (not proxy)", () => {
    const result = classifySshConnectionError(new Error("connect ETIMEDOUT socks-gw.example.com:22"));
    expect(result.stage).toBe("tcp");
  });

  it("classifies a refused connection to a host named 'jump-host' as tcp (not proxy)", () => {
    const result = classifySshConnectionError(new Error("connect ECONNREFUSED jump-host.example.com:22"));
    expect(result.stage).toBe("tcp");
  });

  // PR #67 Codex round 2 regression (must survive the P2a reorder): ProxySshFactory
  // wraps a jump-host connect failure as "Jump host connection failed (<name>): …".
  // Even though the wrapped text carries a concrete `ECONNREFUSED`/`ENOTFOUND` errno,
  // the STRUCTURED phrase must still classify `proxy` so no futile altHost retry is
  // attempted for a proxy hop.
  it("classifies a wrapped 'Jump host connection failed' error as proxy despite an inner ECONNREFUSED", () => {
    const result = classifySshConnectionError(
      new Error("Jump host connection failed (Bastion): connect ECONNREFUSED 203.0.113.9:22")
    );
    expect(result.stage).toBe("proxy");
  });

  it("classifies a wrapped 'Jump host connection failed' error as proxy despite an inner ENOTFOUND", () => {
    const result = classifySshConnectionError(
      new Error("Jump host connection failed (Bastion): getaddrinfo ENOTFOUND bastion.internal")
    );
    expect(result.stage).toBe("proxy");
  });

  // A genuine proxy error with no concrete DNS/TCP errno still classifies proxy via
  // the broad keyword that now runs last.
  it("still classifies a bare 'socks5 authentication failed' as proxy via the broad keyword", () => {
    const result = classifySshConnectionError(new Error("socks5 authentication failed"));
    expect(result.stage).toBe("proxy");
  });

  describe("agent stage", () => {
    const NO_AGENT =
      "No SSH agent found. Start Pageant (PuTTY 0.75 or newer) or the OpenSSH Authentication Agent service, or set nexus.ssh.agent to custom and enter the agent's pipe.";

    it("classifies an agent refusal as `agent`, carrying its remedy as the detail (⊘ the auth branch would read 'Authentication Agent' as a rejected login)", () => {
      const result = classifySshConnectionError(new SshAgentUnavailableError(NO_AGENT));
      expect(result).toMatchObject({ ok: false, stage: "agent", title: "SSH agent could not be used", detail: NO_AGENT });
    });

    it("keeps the agent stage whatever the agent's path contains (⊘ a keyword branch would read a path through 'proxy' or 'timeout' as a network failure and retry the alternate host)", () => {
      const message =
        "Could not use the SSH agent at /run/socks-proxy/timeout/agent.sock (nexus.ssh.agentPath): Failed to connect to agent. Check nexus.ssh.agentPath and that the agent is running, then connect again.";
      expect(classifySshConnectionError(new SshAgentUnavailableError(message)).stage).toBe("agent");
    });

    it("finds an agent refusal wrapped as another error's cause", () => {
      const wrapped = new Error("SSH connect failed", { cause: new SshAgentUnavailableError(NO_AGENT) });
      expect(classifySshConnectionError(wrapped)).toMatchObject({ stage: "agent", detail: NO_AGENT });
    });

    for (const ssh2Message of ["Failed to connect to agent", "Failed to retrieve identities from agent"]) {
      it(`classifies ssh2's "${ssh2Message}" as agent, not auth`, () => {
        const result = classifySshConnectionError(Object.assign(new Error(ssh2Message), { level: "agent" }));
        expect(result.stage).toBe("agent");
        expect(result.title).toBe("SSH agent could not be used");
      });
    }

    it("leaves a jump host whose agent failed as `proxy` — the hop is what failed (⊘ checking for the agent before the jump-host phrase)", () => {
      const jumpText = classifySshConnectionError(new Error("Jump host connection failed (Bastion): Failed to connect to agent"));
      expect(jumpText.stage).toBe("proxy");
      const jumpTyped = classifySshConnectionError(
        new Error(`Jump host connection failed (Bastion): ${NO_AGENT}`, { cause: new SshAgentUnavailableError(NO_AGENT) })
      );
      expect(jumpTyped.stage).toBe("proxy");
    });

    it("keeps a jump host's agent failure `proxy` but carries the agent's remedy as the detail (⊘ the generic proxy text hides what to fix)", () => {
      const result = classifySshConnectionError(
        new Error(`Jump host connection failed (Bastion): ${NO_AGENT}`, { cause: new SshAgentUnavailableError(NO_AGENT) })
      );
      expect(result.stage).toBe("proxy");
      expect(result.detail).toBe(`The jump host's SSH agent could not be used. ${NO_AGENT}`);
      // Any other jump-host failure keeps the generic proxy detail.
      expect(classifySshConnectionError(new Error("Jump host connection failed (Bastion): connect ECONNREFUSED")).detail).toBe(
        "Nexus could not complete the configured proxy or jump-host connection."
      );
    });

    it("does not claim other agent-free failures", () => {
      expect(classifySshConnectionError(new Error("All configured authentication methods failed")).stage).toBe("auth");
      expect(classifySshConnectionError(new Error("user agent string rejected")).stage).not.toBe("agent");
    });
  });

  it("falls back to an unknown failure without including raw secret-looking text", () => {
    const result = classifySshConnectionError(new Error("unexpected failure with secret=hunter2"));
    expect(result).toMatchObject({
      ok: false,
      stage: "unknown",
      title: "SSH connection failed",
      suggestion: "Review the profile settings and retry. If it keeps failing, check the extension logs for more detail."
    });
    expect(`${result.title} ${result.detail} ${result.suggestion}`).not.toContain("hunter2");
  });
});
