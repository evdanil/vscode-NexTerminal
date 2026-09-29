import { describe, expect, it } from "vitest";
import type { ServerConfig, TunnelProfile } from "../../src/models/config";
import { connectDescriptor, tunnelStartDescriptor } from "../../src/models/startDescriptors";

const server: ServerConfig = {
  id: "s1", name: "S", host: "h", port: 22, username: "u", authType: "password", isHidden: false
};
const tunnel: TunnelProfile = {
  id: "t1", name: "T", localPort: 1, remoteIP: "10.0.0.1", remotePort: 2, autoStart: false
};

type Use = "connect" | "tunnel" | "connect+tunnel" | "ignored";

/**
 * Every ServerConfig key must be classified. `Record<keyof ServerConfig, ...>`
 * makes a newly added field a compile error here until someone decides whether
 * a connect or a tunnel start reads it — the per-field drip this replaces.
 * Each entry names the reason.
 */
const SERVER_FIELDS: Record<keyof ServerConfig, { use: Use; why: string; alt: unknown }> = {
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
  authProfileId: { use: "connect+tunnel", why: "credential source", alt: "ap1" },
  origin: { use: "ignored", why: "inventory bookkeeping", alt: { sourceId: "x", externalId: "y" } },
  formerlySynced: { use: "ignored", why: "inventory bookkeeping", alt: { sourceId: "x", externalId: "y" } },
};

const TUNNEL_FIELDS: Record<keyof TunnelProfile, { use: "used" | "ignored"; why: string; alt: unknown }> = {
  id: { use: "used", why: "identity", alt: "t2" },
  name: { use: "ignored", why: "display", alt: "N" },
  localPort: { use: "used", why: "listener port", alt: 9 },
  remoteIP: { use: "used", why: "local tunnel target (checked on a local tunnel)", alt: "10.0.0.9" },
  remotePort: { use: "used", why: "local target / reverse bind port", alt: 9 },
  defaultServerId: { use: "ignored", why: "server is passed explicitly to the start", alt: "s2" },
  autoStart: { use: "ignored", why: "decides WHETHER to start, not how", alt: true },
  autoStop: { use: "ignored", why: "read at stop time", alt: true },
  connectionMode: { use: "used", why: "resolved mode (effective value is compared)", alt: "isolated" },
  tunnelType: { use: "used", why: "changes the route entirely", alt: "dynamic" },
  remoteBindAddress: { use: "ignored", why: "reverse only (covered in the reverse test)", alt: "0.0.0.0" },
  localTargetIP: { use: "ignored", why: "reverse only (covered in the reverse test)", alt: "10.1.1.1" },
  localBindAddress: { use: "used", why: "local listener address", alt: "0.0.0.0" },
  notes: { use: "ignored", why: "free text", alt: "n" },
  browserUrl: { use: "ignored", why: "open-in-browser shortcut", alt: "http://x" }
};

const inputs = { multiplexingDefault: true };
const tinputs = { mode: "isolated" as const, multiplexingDefault: true };

describe("start descriptors — every field is classified", () => {
  it.each(Object.entries(SERVER_FIELDS))("server.%s", (key, { use, alt }) => {
    // keyPath is read only by a key login, so it is judged on a key server.
    const base: ServerConfig = key === "keyPath" ? { ...server, authType: "key" } : server;
    const changed = { ...base, [key]: alt } as ServerConfig;
    const connectChanges = connectDescriptor(changed, inputs) !== connectDescriptor(base, inputs);
    expect(connectChanges).toBe(use === "connect" || use === "connect+tunnel");
    if (key === "multiplexing") return; // tunnel side depends on the mode; see below
    const tunnelChanges =
      tunnelStartDescriptor(tunnel, changed, tinputs) !== tunnelStartDescriptor(tunnel, base, tinputs);
    expect(tunnelChanges).toBe(use === "tunnel" || use === "connect+tunnel");
  });

  it.each(Object.entries(TUNNEL_FIELDS))("tunnel.%s", (key, { use, alt }) => {
    const changed = { ...tunnel, [key]: alt } as TunnelProfile;
    // remoteBindAddress/localTargetIP are reverse-only and connectionMode is
    // passed as the resolved input, so those are exercised in their own tests.
    if (["remoteBindAddress", "localTargetIP", "connectionMode"].includes(key)) return;
    const differs = tunnelStartDescriptor(changed, server, tinputs) !== tunnelStartDescriptor(tunnel, server, tinputs);
    expect(differs).toBe(use === "used");
  });
});

describe("start descriptors — reported regressions", () => {
  it("an unset connection mode equals an explicit one when it resolves to the same effective mode", () => {
    const a = tunnelStartDescriptor(tunnel, server, { mode: "shared", multiplexingDefault: true });
    const b = tunnelStartDescriptor({ ...tunnel, connectionMode: "shared" }, server, { mode: "shared", multiplexingDefault: true });
    expect(a).toBe(b);
    const c = tunnelStartDescriptor({ ...tunnel, connectionMode: "isolated" }, server, { mode: "isolated", multiplexingDefault: true });
    expect(c).not.toBe(a);
  });

  it("an altHost edit does not change an isolated tunnel start but does change a terminal connect", () => {
    const edited = { ...server, altHost: "alt.example" };
    const i = { mode: "isolated" as const, multiplexingDefault: true };
    expect(tunnelStartDescriptor(tunnel, edited, i)).toBe(tunnelStartDescriptor(tunnel, server, i));
    expect(connectDescriptor(edited, inputs)).not.toBe(connectDescriptor(server, inputs));
  });

  it("an altHost edit changes a shared, multiplexed tunnel start (the pooled lease may be via altHost)", () => {
    const edited = { ...server, altHost: "alt.example" };
    const i = { mode: "shared" as const, multiplexingDefault: true };
    expect(tunnelStartDescriptor(tunnel, edited, i)).not.toBe(tunnelStartDescriptor(tunnel, server, i));
    // A blank alt host is no alt host.
    expect(tunnelStartDescriptor(tunnel, { ...server, altHost: "  " }, i)).toBe(tunnelStartDescriptor(tunnel, server, i));
  });

  it("an altHost edit is ignored by a shared tunnel when multiplexing is off (pool bypassed)", () => {
    const off = { ...server, multiplexing: false };
    const i = { mode: "shared" as const, multiplexingDefault: true };
    expect(tunnelStartDescriptor(tunnel, { ...off, altHost: "alt.example" }, i)).toBe(tunnelStartDescriptor(tunnel, off, i));
  });
});

describe("start descriptors — resolved values, not stored representations", () => {
  it.each<[string, Partial<ServerConfig>]>([
    ["protocol ssh", { protocol: "ssh" }],
    ["blank altHost", { altHost: "  " }],
    ["blank keyPath", { keyPath: "" }],
    ["blank authProfileId", { authProfileId: "" }],
    ["legacyAlgorithms false", { legacyAlgorithms: false }],
    ["addressless false", { addressless: false }],
    ["multiplexing equal to the pool default", { multiplexing: true }]
  ])("%s equals absent for a connect", (_l, patch) => {
    expect(connectDescriptor({ ...server, ...patch }, inputs)).toBe(connectDescriptor(server, inputs));
  });

  it("multiplexing is judged against the pool's captured default", () => {
    const on = { ...server, multiplexing: true };
    expect(connectDescriptor(on, { multiplexingDefault: false })).not.toBe(connectDescriptor(server, { multiplexingDefault: false }));
  });

  it("multiplexing matters to a tunnel only in shared mode", () => {
    const off = { ...server, multiplexing: false };
    expect(tunnelStartDescriptor(tunnel, off, { mode: "isolated", multiplexingDefault: true }))
      .toBe(tunnelStartDescriptor(tunnel, server, { mode: "isolated", multiplexingDefault: true }));
    expect(tunnelStartDescriptor(tunnel, off, { mode: "shared", multiplexingDefault: true }))
      .not.toBe(tunnelStartDescriptor(tunnel, server, { mode: "shared", multiplexingDefault: true }));
  });

  it("tunnel address fields follow TunnelManager's plain default, whitespace included", () => {
    expect(tunnelStartDescriptor({ ...tunnel, localBindAddress: "127.0.0.1" }, server, tinputs)).toBe(tunnelStartDescriptor(tunnel, server, tinputs));
    expect(tunnelStartDescriptor({ ...tunnel, localBindAddress: "  " }, server, tinputs)).not.toBe(tunnelStartDescriptor(tunnel, server, tinputs));
  });

  it("type-specific fields: dynamic ignores the remote target, reverse uses bind/target and ignores remoteIP", () => {
    const dyn = { ...tunnel, tunnelType: "dynamic" as const };
    expect(tunnelStartDescriptor({ ...dyn, remoteIP: "1.1.1.1", remotePort: 9 }, server, tinputs)).toBe(tunnelStartDescriptor(dyn, server, tinputs));
    const rev = { ...tunnel, tunnelType: "reverse" as const };
    expect(tunnelStartDescriptor({ ...rev, remoteIP: "1.1.1.1" }, server, tinputs)).toBe(tunnelStartDescriptor(rev, server, tinputs));
    expect(tunnelStartDescriptor({ ...rev, remoteBindAddress: "0.0.0.0" }, server, tinputs)).not.toBe(tunnelStartDescriptor(rev, server, tinputs));
    expect(tunnelStartDescriptor({ ...rev, localTargetIP: "10.1.1.1" }, server, tinputs)).not.toBe(tunnelStartDescriptor(rev, server, tinputs));
    expect(tunnelStartDescriptor({ ...rev, remotePort: 99 }, server, tinputs)).not.toBe(tunnelStartDescriptor(rev, server, tinputs));
    // Reverse is always shared, whatever mode was passed.
    expect(tunnelStartDescriptor(rev, server, { mode: "isolated", multiplexingDefault: true }))
      .toBe(tunnelStartDescriptor(rev, server, { mode: "shared", multiplexingDefault: true }));
  });

  it("proxy changes count, key order does not", () => {
    const a = { ...server, proxy: { type: "socks5" as const, host: "p", port: 1 } };
    const b = { ...server, proxy: { port: 1, host: "p", type: "socks5" as const } };
    expect(connectDescriptor(a, inputs)).toBe(connectDescriptor(b, inputs));
    expect(connectDescriptor({ ...a, proxy: { ...a.proxy, port: 2 } }, inputs)).not.toBe(connectDescriptor(a, inputs));
  });
});

describe("start descriptors — keyPath and telnet", () => {
  it("keyPath counts when a linked auth profile can make the login a key login", () => {
    const linked: ServerConfig = { ...server, authType: "password", authProfileId: "key-profile" };
    const moved = { ...linked, keyPath: "/new" };
    expect(connectDescriptor(moved, inputs)).not.toBe(connectDescriptor(linked, inputs));
    expect(tunnelStartDescriptor(tunnel, moved, tinputs)).not.toBe(tunnelStartDescriptor(tunnel, linked, tinputs));
  });

  it("guard: a password server with no profile link ignores a keyPath change", () => {
    const moved = { ...server, keyPath: "/new" };
    expect(connectDescriptor(moved, inputs)).toBe(connectDescriptor(server, inputs));
    expect(tunnelStartDescriptor(tunnel, moved, tinputs)).toBe(tunnelStartDescriptor(tunnel, server, tinputs));
  });

  it("keyPath counts only for a key login", () => {
    expect(connectDescriptor({ ...server, keyPath: "/k" }, inputs)).toBe(connectDescriptor(server, inputs));
    const keyServer: ServerConfig = { ...server, authType: "key" };
    expect(connectDescriptor({ ...keyServer, keyPath: "/k" }, inputs)).not.toBe(connectDescriptor(keyServer, inputs));
  });

  const telnet: ServerConfig = { ...server, protocol: "telnet" };
  const SSH_ONLY: Array<[string, Partial<ServerConfig>]> = [
    ["username", { username: "root" }],
    ["authType", { authType: "key" }],
    ["keyPath", { keyPath: "/k" }],
    ["authProfileId", { authProfileId: "ap1" }],
    ["legacyAlgorithms", { legacyAlgorithms: true }],
    ["proxy", { proxy: { type: "ssh", jumpHostId: "j" } }],
    ["multiplexing", { multiplexing: false }],
    ["altHost", { altHost: "alt.example" }]
  ];

  it.each(SSH_ONLY)("a telnet connect ignores SSH-only %s", (_key, patch) => {
    expect(connectDescriptor({ ...telnet, ...patch }, inputs)).toBe(connectDescriptor(telnet, inputs));
  });

  it("a telnet connect still tracks host, port, addressless and the protocol itself", () => {
    expect(connectDescriptor({ ...telnet, host: "other" }, inputs)).not.toBe(connectDescriptor(telnet, inputs));
    expect(connectDescriptor({ ...telnet, port: 2323 }, inputs)).not.toBe(connectDescriptor(telnet, inputs));
    expect(connectDescriptor({ ...telnet, addressless: true }, inputs)).not.toBe(connectDescriptor(telnet, inputs));
    expect(connectDescriptor({ ...telnet, protocol: undefined }, inputs)).not.toBe(connectDescriptor(telnet, inputs));
  });
});
