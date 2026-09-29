import type { ServerConfig } from "../../src/models/config";

export type Use = "connect" | "tunnel" | "connect+tunnel" | "ignored";

/**
 * Every ServerConfig key must be classified. `Record<keyof ServerConfig, ...>`
 * makes a newly added field a compile error here until someone decides whether
 * a connect or a tunnel start reads it — the per-field drip this replaces.
 * Each entry names the reason.
 */
export const SERVER_FIELDS: Record<keyof ServerConfig, { use: Use; why: string; alt: unknown }> = {
  id: { use: "connect+tunnel", why: "record identity", alt: "s2" },
  name: { use: "ignored", why: "display only (terminal title); a rename must not cancel", alt: "Renamed" },
  group: { use: "ignored", why: "folder placement", alt: "G" },
  host: { use: "connect+tunnel", why: "dialled address", alt: "other" },
  port: { use: "connect+tunnel", why: "dialled port", alt: 2222 },
  addressless: { use: "connect+tunnel", why: "placeholder with nothing to dial", alt: true },
  protocol: { use: "connect+tunnel", why: "telnet vs ssh transport", alt: "telnet" },
  altHost: { use: "connect", why: "SshPty fallback address; tunnels never dial it (only a pooled lease can inherit it: see the shared-mode test)", alt: "alt.example" },
  username: { use: "connect+tunnel", why: "login", alt: "root" },
  authType: { use: "connect+tunnel", why: "login", alt: "key" },
  keyPath: { use: "connect+tunnel", why: "login key (key auth, or any server linked to an auth profile that may switch to key)", alt: "/k" },
  isHidden: { use: "ignored", why: "tree visibility", alt: true },
  logSession: { use: "ignored", why: "transcript preference; editor writes the global default on every Save", alt: true },
  multiplexing: { use: "connect", why: "pool use; tunnels only when shared (covered separately)", alt: false },
  legacyAlgorithms: { use: "connect+tunnel", why: "handshake algorithms", alt: true },
  ipmiHost: { use: "ignored", why: "BMC tooling, not the SSH path", alt: "10.9.9.9" },
  ipmiAuthProfileId: { use: "ignored", why: "BMC tooling", alt: "ap" },
  bmcWebProtocol: { use: "ignored", why: "BMC tooling", alt: "https" },
  ipmiGatewayServerId: { use: "ignored", why: "macro routing, not this connection", alt: "gw" },
  openFileExplorerOnFirstConnect: { use: "ignored", why: "post-connect convenience", alt: true },
  proxy: { use: "connect+tunnel", why: "route to the host", alt: { type: "socks5", host: "p", port: 1080 } },
  authProfileId: { use: "connect+tunnel", why: "credential source: the link itself, and (in the descriptor) whether the linked profile RESOLVED, since that selects the profile-scoped vs server-scoped secret key even when every effective field is equal", alt: "ap1" },
  origin: { use: "ignored", why: "inventory bookkeeping", alt: { sourceId: "x", externalId: "y" } },
  formerlySynced: { use: "ignored", why: "inventory bookkeeping", alt: { sourceId: "x", externalId: "y" } },
};

