/**
 * Classification of errors raised while opening a *channel* (shell, direct-tcpip,
 * sftp, exec) on an already-established SSH connection.
 *
 * `connectionDiagnostics.ts` classifies failures of the *connect* itself (DNS,
 * TCP, auth, host key). This module covers the stage after that, where two
 * different questions get asked about the same error and they are NOT the same
 * question:
 *
 * 1. `shouldFallbackForChannelLimit` — "did the server refuse this channel
 *    because the multiplexed session is out of channel slots, so opening a
 *    second, standalone connection would succeed?" Used by `SshConnectionPool`
 *    to decide whether to transparently fall back.
 * 2. `isFatalToSshConnection` — "did the SSH transport itself die, or was only
 *    this one channel refused?" Used by `TunnelManager` to decide whether a
 *    failed proxy attempt should tear down the shared SSH connection that every
 *    other in-flight stream on that tunnel is riding on.
 *
 * The two deliberately disagree on `SSH_OPEN_CONNECT_FAILED`: it is *not* a
 * channel-limit condition (a second connection would not help — the requested
 * destination is simply unreachable) but it *is* channel-level (the transport
 * that carried the refusal is by definition healthy).
 */

/** SSH_MSG_CHANNEL_OPEN_FAILURE reason codes (RFC 4254 §5.1). */
export const SSH_OPEN_ADMINISTRATIVELY_PROHIBITED = 1;
export const SSH_OPEN_CONNECT_FAILED = 2;
export const SSH_OPEN_UNKNOWN_CHANNEL_TYPE = 3;
export const SSH_OPEN_RESOURCE_SHORTAGE = 4;

const FALLBACK_ALLOW_HINTS = [
  "administratively prohibited",
  "resource shortage",
  "too many sessions",
  "maxsessions",
  "channel limit",
  "no more sessions"
] as const;

const FALLBACK_DENY_HINTS = [
  "connection refused",
  "connect failed",
  "unknown channel type"
] as const;

/**
 * Text that only ever appears on a per-channel refusal. `(SSH) Channel open
 * failure: …` is the exact prefix ssh2 builds for every CHANNEL_OPEN_FAILURE
 * (see `node_modules/ssh2/lib/utils.js:onChannelOpenFailure`), so it alone
 * settles most cases; the rest cover wrappers that reword the description.
 */
const CHANNEL_LEVEL_HINTS = [
  "channel open failure",
  "administratively prohibited",
  "connect failed",
  "connection refused",
  "unknown channel type",
  "resource shortage",
  "too many sessions",
  "maxsessions",
  "channel limit",
  "no more sessions"
] as const;

/**
 * Text that means the SSH client/transport is gone, not that one channel was
 * refused. `Not connected` is thrown synchronously by ssh2's `Client` methods
 * when the socket is down, and `No response from server` is its keepalive
 * timeout — neither ever reaches the wire as a channel request.
 */
const TRANSPORT_LEVEL_HINTS = [
  "not connected",
  "no response from server",
  "socket hang up",
  "econnreset",
  "epipe",
  "etimedout",
  "timed out",
  "keepalive",
  "handshake failed",
  "connection lost",
  "connection closed",
  "disposed ssh connection"
] as const;

function hasAnyNeedle(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

function readReason(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { reason?: unknown }).reason
    : undefined;
}

export function isStaleConnectionError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("not connected");
}

export function shouldFallbackForChannelLimit(error: unknown): boolean {
  const reason = readReason(error);

  if (typeof reason === "number") {
    if (reason === SSH_OPEN_ADMINISTRATIVELY_PROHIBITED || reason === SSH_OPEN_RESOURCE_SHORTAGE) {
      return true;
    }
    if (reason === SSH_OPEN_CONNECT_FAILED || reason === SSH_OPEN_UNKNOWN_CHANNEL_TYPE) {
      return false;
    }
  }

  if (typeof reason === "string") {
    const normalizedReason = reason.toLowerCase();
    if (hasAnyNeedle(normalizedReason, FALLBACK_DENY_HINTS)) {
      return false;
    }
    if (hasAnyNeedle(normalizedReason, FALLBACK_ALLOW_HINTS)) {
      return true;
    }
  }

  const message = errorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }
  if (hasAnyNeedle(message, FALLBACK_DENY_HINTS)) {
    return false;
  }
  return hasAnyNeedle(message, FALLBACK_ALLOW_HINTS);
}

/**
 * True only when the error means the SSH connection as a whole is unusable, so
 * a caller sharing that connection between many streams should dispose it.
 *
 * A channel-open refusal returns false: the remote could not reach *this one*
 * destination, which says nothing about the transport. Callers that treat every
 * rejection as fatal kill every other stream multiplexed on the same connection
 * and force a full re-authentication for the next request.
 *
 * When nothing matches, the answer is false. That default is safe because a
 * transport that truly died also fires the connection's `close` event, and the
 * `onClose` listeners that own the shared connection clear it there; disposing
 * on a guess, by contrast, is unrecoverable for the streams already running.
 */
export function isFatalToSshConnection(error: unknown): boolean {
  const reason = readReason(error);

  // A numeric reason code is decisive. ssh2 sets `.reason` only when unpacking
  // an SSH_MSG_CHANNEL_OPEN_FAILURE packet, so its mere presence proves the
  // server received the channel request over a live transport and answered it —
  // including for server-specific codes outside the four RFC 4254 values.
  if (typeof reason === "number") {
    return false;
  }

  const text = `${typeof reason === "string" ? reason : ""} ${errorMessage(error)}`.toLowerCase();

  // Channel-level first: "(SSH) Channel open failure: Connection timed out" is a
  // per-destination refusal, and must not be read as a transport timeout by the
  // "timed out" hint below.
  if (hasAnyNeedle(text, CHANNEL_LEVEL_HINTS)) {
    return false;
  }
  return hasAnyNeedle(text, TRANSPORT_LEVEL_HINTS);
}
