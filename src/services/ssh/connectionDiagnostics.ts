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

  // STRUCTURED proxy / jump-host failure FIRST (issue #48, PR #67 Codex round 3 P2a).
  // `ProxySshFactory` wraps every jump-host connect failure as
  // "Jump host connection failed (<name>): <underlying>" (round 2 fix). That phrase
  // must classify as `proxy` even when the underlying text contains a concrete errno
  // such as `ECONNREFUSED` / `ENOTFOUND`, so no futile alternate-host retry is made
  // for a proxy hop. It is matched on the STRUCTURED phrase — NOT the bare word
  // "proxy" — so that an ordinary DIRECT target whose hostname merely contains
  // "proxy"/"socks"/"jump-host" (e.g. `getaddrinfo ENOTFOUND proxy01.example.com`)
  // falls through to the concrete DNS/TCP signatures below and keeps its
  // connect-fallback. The broad keyword match runs LAST (just before `auth`).
  if (/jump host connection failed|proxy connection failed/.test(message)) {
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

  // ALTERNATE HOST (issue #48) — "no route to host" / "network is unreachable"
  // are TCP-stage (pre-auth) failures exactly like ECONNREFUSED / ETIMEDOUT:
  // the transport never reached a peer, so no credential was ever offered. They
  // MUST classify as `tcp` — not `unknown` — because the `SshPty` connect-fallback
  // (services/ssh/sshPty.ts) only retries the alternate address on a `tcp`/`dns`
  // stage, and the feature's headline scenario is precisely one of these: a
  // primary `host` on an IP family the client has no route to (an IPv6 address
  // with no IPv6 route) rejects INSTANTLY with `connect ENETUNREACH …`, and
  // before this branch that landed in `unknown` and the alternate was never tried.
  //
  // Deliberately NOT `econnreset`: a mid-handshake reset is ambiguous — the peer
  // WAS reachable and answered, then dropped the connection — so falling back
  // would re-attempt a reachable-but-flaky host and could cost a second
  // credential prompt or trip a lockout. Left `unknown` (conservative): the
  // existing "review the profile settings and retry" path is the safer default
  // for a reset than an automatic alternate-host retry.
  if (/ehostunreach|enetunreach|no route to host|network is unreachable/.test(message)) {
    return {
      ok: false,
      stage: "tcp",
      title: "Host unreachable",
      detail: "Nexus could not reach the host — there is no network route to the address.",
      suggestion: "Check that the address is reachable from this machine (routing, IP family, VPN) and that firewalls allow SSH traffic."
    };
  }

  // BROAD proxy / socks keyword LAST (issue #48, PR #67 Codex round 3 P2a): a genuine
  // proxy failure that carries no concrete DNS/TCP errno (e.g. "socks5 authentication
  // failed", "http connect refused by proxy") still classifies `proxy`. Runs AFTER the
  // DNS/TCP signatures above so an incidental hostname containing these words does not
  // disable the connect-fallback, and BEFORE `auth` so a proxy-side auth failure is
  // still reported as a proxy problem (preserving the prior proxy-before-auth order).
  if (/proxy|socks|http connect|jump host|jump-host/.test(message)) {
    return {
      ok: false,
      stage: "proxy",
      title: "Proxy connection failed",
      detail: "Nexus could not complete the configured proxy or jump-host connection.",
      suggestion: "Check the proxy server, credentials, and jump-host settings before retrying."
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
