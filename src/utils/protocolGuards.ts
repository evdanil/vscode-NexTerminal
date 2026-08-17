import type { ServerConfig } from "../models/config";
import { resolveServerProtocol } from "../models/config";

/**
 * TELNET (Phase 0) — the shared refusal for an SSH-ONLY feature invoked against
 * a telnet server, as a message rather than a thrown error.
 *
 * Every one of these features (SFTP browsing, tunnels/port forwarding, jump
 * hosts, SSH key deployment, the connection test) reaches for an SSH connection
 * from a server id. Before the protocol field existed there was no such thing as
 * a server that could not supply one, so those paths reported failure by letting
 * the connect throw — which for a telnet server means a raw ssh2 handshake error
 * naming a port that is answering perfectly well, several seconds after the
 * click. Naming the real reason up front is the whole point of the guard.
 *
 * Returns `undefined` when the feature IS available (the SSH case, explicit or
 * by default), so a call site reads as `const message = telnetUnsupportedMessage(…);
 * if (message) { warn(message); return; }`.
 *
 * Goes through `resolveServerProtocol` rather than comparing the stored value:
 * a record carrying anything outside the two literals is an SSH server
 * everywhere else, and a guard that disagreed with the connect path about which
 * transport a server uses would be worse than no guard.
 */
export function telnetUnsupportedMessage(
  server: Pick<ServerConfig, "name" | "protocol">,
  feature: string
): string | undefined {
  if (resolveServerProtocol(server) !== "telnet") {
    return undefined;
  }
  return `${feature} is not available for telnet servers. "${server.name}" is configured as Telnet, which carries no file transfer, port forwarding or authentication of its own — switch it to SSH to use this.`;
}
