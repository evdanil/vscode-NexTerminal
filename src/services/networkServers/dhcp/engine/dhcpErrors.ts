/** @author kanekitakitos */

/**
 * Classification and formatting of DHCP engine bind errors.
 * Converts raw Node errors (EACCES, EADDRINUSE, ...) into human messages
 * explaining WHAT, WHERE and HOW to resolve.
 */

import { DEFAULT_PORT, FALLBACK_ALT_PORT } from './dhcpConstants';

/** Stable classification of known DHCP bind errors. */
export type DhcpErrorKind =
  | 'EACCES_PRIVILEGES'
  | 'EADDRINUSE_PORT_TAKEN'
  | 'FALLBACK_ALT_FAILED'
  | 'UNKNOWN';

/**
 * Typed DHCP engine error.
 *
 * Unlike a generic Node `Error`, it always includes a discriminated `kind`
 * so the Adapter can format high-level human messages without having to do
 * regex/`instanceof` guesswork.
 */
export class DhcpEngineError extends Error {
  public constructor(
    message: string,
    public readonly kind: DhcpErrorKind,
    public readonly context?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DhcpEngineError';
    Object.setPrototypeOf(this, DhcpEngineError.prototype);
  }
}

/** Converts a generic Node Error into explanatory message + kind. */
export function classifyNodeError(
  err: unknown,
  port: number,
  triedFallback: boolean,
): { kind: DhcpErrorKind; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const isEACCES = /EACCES|Access|permission/i.test(raw);
  const isInUse = /EADDRINUSE|address already in use/i.test(raw);

  if (isEACCES) {
    return {
      kind: triedFallback ? 'FALLBACK_ALT_FAILED' : 'EACCES_PRIVILEGES',
      message: triedFallback
        ? `DhcpEngine: Port ${DEFAULT_PORT} (EACCES without Admin) and fallback ${FALLBACK_ALT_PORT} also failed. Both ports require privileges or are already taken. Original error: ${raw}`
        : `DhcpEngine: Bind on UDP port ${port} failed with EACCES. IANA port <1024 requires Administrator/root privileges. Use elevated mode or the ${FALLBACK_ALT_PORT} fallback. Original error: ${raw}`,
    };
  }

  if (isInUse) {
    return {
      kind: 'EADDRINUSE_PORT_TAKEN',
      message: `DhcpEngine: Bind on UDP port ${port} failed with EADDRINUSE. Another process is already occupying port ${port}. Stop the other DHCP server first. Original error: ${raw}`,
    };
  }

  return {
    kind: 'UNKNOWN',
    message: `DhcpEngine: Unknown error binding on UDP port ${port}. Technical detail: ${raw}`,
  };
}
