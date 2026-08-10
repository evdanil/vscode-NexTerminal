import type { ServerConfig } from "../../models/config";

/**
 * Whether a server edit changed any parameter a LIVE pooled (multiplexed) SSH
 * connection was established with — in which case the pool entry for that server id
 * must be invalidated so the next terminal reconnects with the new settings instead
 * of reusing a socket to the old destination / credentials.
 *
 * `altHost` is compared for the same reason `host` is (issue #48, PR #67 Codex round
 * 2): the terminal connect-fallback (`SshPty`) can establish the pooled connection
 * against the ALTERNATE address when the primary is unreachable. If `altHost` is later
 * changed by an edit or an inventory sync, a cached connection to the OLD alternate
 * would otherwise be reused — opening a shell on the wrong machine.
 *
 * Pure and vscode-free so it is unit-testable; `extension.ts` calls it from the
 * `onDidChange` handler. The `proxy` term stays a structural (`JSON.stringify`)
 * compare, matching the prior inline predicate exactly; the separate proxy-password
 * clear stays in `extension.ts` (it is a different concern from pool invalidation).
 */
export function pooledConnectionParamsChanged(prev: ServerConfig, next: ServerConfig): boolean {
  return (
    prev.host !== next.host ||
    prev.altHost !== next.altHost ||
    prev.port !== next.port ||
    prev.username !== next.username ||
    prev.authType !== next.authType ||
    prev.keyPath !== next.keyPath ||
    prev.authProfileId !== next.authProfileId ||
    prev.multiplexing !== next.multiplexing ||
    prev.legacyAlgorithms !== next.legacyAlgorithms ||
    JSON.stringify(prev.proxy) !== JSON.stringify(next.proxy)
  );
}
