import { describe, expect, it } from "vitest";
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
