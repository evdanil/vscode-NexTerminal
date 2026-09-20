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

export interface AddresslessMessageOptions {
  /**
   * True only when the CALLER has confirmed this exact device has a browser
   * console. Never inferred here — an addressless server is just as likely to be
   * an IP-less NetBox row, which has no console at all.
   */
  webConsoleAvailable?: boolean;
}

/**
 * ADDRESSLESS (Codex P1 on #82) — the shared refusal for ANY connect/SSH-only
 * feature invoked against a synced placeholder that has no console address yet
 * (a stopped EVE node, a VNC-console node, a NetBox row with no IP). Like
 * `telnetUnsupportedMessage`, it names the real reason up front instead of
 * letting the connect path reach for a transport against an empty host — which
 * would prompt, read the vault, and then fail on a handshake to nothing.
 *
 * Returns `undefined` when the server IS addressed (the common case), so a call
 * site reads `const m = addresslessUnavailableMessage(server); if (m) { … }`.
 *
 * WEB CONSOLE — `options.webConsoleAvailable` is how a caller that has
 * ESTABLISHED the capability (the provider behind this server implements
 * `webConsoleUrl` and accepts this device) gets a message that names it. It is
 * opt-in, and the default is the neutral text, so a caller that cannot answer
 * the capability question cannot accidentally promise a console: the guard
 * itself still knows nothing about providers.
 */
export function addresslessUnavailableMessage(
  server: Pick<ServerConfig, "name" | "addressless">,
  options: AddresslessMessageOptions = {}
): string | undefined {
  if (server.addressless !== true) {
    return undefined;
  }
  if (options.webConsoleAvailable === true) {
    // Every clause of the neutral text below is false for this device: the
    // address is not missing "yet", the guest is not offline, and re-syncing
    // will never assign one — a hypervisor guest without a guest agent reports
    // no IP by design. So this names the route that does work instead, in terms
    // of the capability rather than of a provider: any source offering a web
    // console gets this wording.
    return `"${server.name}" has no console address, so Nexus cannot open a terminal session to it. Its inventory source provides a web console that needs no address — open that instead.`;
  }
  // P2 (Codex review) — PROVIDER-NEUTRAL, and this is still the answer for every
  // caller that has NOT established a console. This guard is shared and gets no
  // provider identity, and an addressless server can come from an IP-less NetBox
  // row (remedy: assign an address in NetBox) as well as a stopped EVE-NG node —
  // so it must not prescribe an EVE-NG-specific remedy.
  return `"${server.name}" has no console address yet. It may be offline, or its inventory source hasn't assigned one — re-sync the source once it has an address.`;
}
