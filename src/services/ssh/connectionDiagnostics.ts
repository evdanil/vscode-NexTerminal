export type ConnectionDiagnosticStage =
  | "dns"
  | "tcp"
  | "auth"
  | "host-key"
  | "key"
  | "proxy"
  | "unknown";

export interface ConnectionDiagnosticResult {
  ok: boolean;
  stage: ConnectionDiagnosticStage;
  title: string;
  detail: string;
  suggestion: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

export function classifySshConnectionError(error: unknown): ConnectionDiagnosticResult {
  const message = errorMessage(error).toLowerCase();

  if (/proxy|socks|http connect|jump host|jump-host/.test(message)) {
    return {
      ok: false,
      stage: "proxy",
      title: "Proxy connection failed",
      detail: "Nexus could not complete the configured proxy or jump-host connection.",
      suggestion: "Check the proxy server, credentials, and jump-host settings before retrying."
    };
  }

  if (/host key|hostkey|remote host identification has changed|key verification failed|key rejected|host denied \(verification failed\)/.test(message)) {
    return {
      ok: false,
      stage: "host-key",
      title: "Host key verification failed",
      detail: "The server host key was rejected or does not match the trusted key.",
      suggestion: "Verify the server identity. If the change is expected, remove the old trusted host key and reconnect."
    };
  }

  if (/unsupported key|privatekey|private key|passphrase|encrypted key|cannot parse/.test(message)) {
    return {
      ok: false,
      stage: "key",
      title: "Private key could not be used",
      detail: "The selected private key or its passphrase could not be used for this connection.",
      suggestion: "Use a supported OpenSSH private key, or update the saved key path/passphrase and try again."
    };
  }

  if (/enotfound|getaddrinfo|eai_again|dns|name or service not known|nodename nor servname/.test(message)) {
    return {
      ok: false,
      stage: "dns",
      title: "Host name could not be resolved",
      detail: "Nexus could not resolve the server host name to an IP address.",
      suggestion: "Check the host name, DNS settings, or VPN connection, then try again."
    };
  }

  if (/etimedout|timed out|timeout|operation timed out/.test(message)) {
    return {
      ok: false,
      stage: "tcp",
      title: "Connection timed out",
      detail: "The TCP connection attempt did not complete before the timeout.",
      suggestion: "Verify the host is reachable, the port is correct, and firewalls allow SSH traffic."
    };
  }

  if (/econnrefused|connection refused/.test(message)) {
    return {
      ok: false,
      stage: "tcp",
      title: "Connection refused",
      detail: "The remote host rejected the TCP connection.",
      suggestion: "Verify the SSH service is running on the target port and accepting connections."
    };
  }

  if (/auth|permission denied|all configured authentication methods failed|login denied/.test(message)) {
    return {
      ok: false,
      stage: "auth",
      title: "Authentication failed",
      detail: "The server rejected the configured SSH credentials.",
      suggestion: "Check the username and selected authentication method, then update stored credentials if needed."
    };
  }

  return {
    ok: false,
    stage: "unknown",
    title: "SSH connection failed",
    detail: "The SSH connection failed before a session could be opened.",
    suggestion: "Review the profile settings and retry. If it keeps failing, check the extension logs for more detail."
  };
}
