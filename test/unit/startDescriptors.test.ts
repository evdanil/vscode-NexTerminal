import { describe, expect, it } from "vitest";
import { applyAuthProfile, type AuthProfile, type ServerConfig, type TunnelProfile } from "../../src/models/config";
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

const profile: AuthProfile = { id: "key-profile", name: "P", username: "pu", authType: "password" };
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
  it("keyPath counts when a linked auth profile makes the effective login a key login", () => {
    const linked: ServerConfig = { ...server, authType: "password", authProfileId: "key-profile" };
    const moved = { ...linked, keyPath: "/new" };
    const lookup = (id: string) => (id === "key-profile" ? { ...profile, authType: "key" as const, keyPath: undefined } : undefined);
    const i = { ...inputs, authProfileLookup: lookup };
    expect(connectDescriptor(moved, i)).not.toBe(connectDescriptor(linked, i));
    expect(tunnelStartDescriptor(tunnel, moved, { ...tinputs, authProfileLookup: lookup }))
      .not.toBe(tunnelStartDescriptor(tunnel, linked, { ...tinputs, authProfileLookup: lookup }));
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

describe("start descriptors — secrets are not part of the fence", () => {
  it("no ServerConfig or TunnelProfile field is secret-bearing (they live in SecretStorage)", () => {
    const names = [...Object.keys(SERVER_FIELDS), ...Object.keys(TUNNEL_FIELDS)];
    expect(names.filter((n) => /password|passphrase|secret/i.test(n))).toEqual([]);
  });

  it("a password, passphrase or proxy password smuggled onto a record does not enter a descriptor", () => {
    const withSecrets = {
      ...server,
      password: "p1",
      passphrase: "p2",
      proxy: { type: "socks5", host: "p", port: 1, password: "p3", proxyPassword: "p4" }
    } as unknown as ServerConfig;
    const changed = {
      ...withSecrets,
      password: "other",
      passphrase: "other",
      proxy: { type: "socks5", host: "p", port: 1, password: "other", proxyPassword: "other" }
    } as unknown as ServerConfig;
    expect(connectDescriptor(changed, inputs)).toBe(connectDescriptor(withSecrets, inputs));
    expect(tunnelStartDescriptor(tunnel, changed, tinputs)).toBe(tunnelStartDescriptor(tunnel, withSecrets, tinputs));
    expect(connectDescriptor(withSecrets, inputs)).not.toMatch(/"(p1|p2|p3|p4)"|passphrase/i);
  });
});

/** Every AuthProfile key must be classified, like the server table. */
const PROFILE_FIELDS: Record<keyof AuthProfile, { use: "used" | "ignored"; why: string; alt: unknown }> = {
  id: { use: "ignored", why: "the link (server.authProfileId) is what the descriptor holds", alt: "other" },
  name: { use: "ignored", why: "display only", alt: "Renamed" },
  username: { use: "used", why: "supplied login name, applied over the server's", alt: "root" },
  authType: { use: "used", why: "supplied auth method, applied over the server's", alt: "password" },
  keyPath: { use: "used", why: "supplied key file (counts when the effective type is key)", alt: "/k" }
};

describe("start descriptors — linked auth profile is applied", () => {
  const linked: ServerConfig = { ...server, authProfileId: "key-profile" };
  const withProfile = (p: AuthProfile) => ({ ...inputs, authProfileLookup: () => p });

  it.each(Object.entries(PROFILE_FIELDS))("profile.%s", (key, { use, alt }) => {
    // A key profile so keyPath is relevant; the field under test is then varied.
    const base: AuthProfile = { ...profile, authType: "key", keyPath: "/base" };
    const edited = { ...base, [key]: alt } as AuthProfile;
    const differs = connectDescriptor(linked, withProfile(edited)) !== connectDescriptor(linked, withProfile(base));
    expect(differs).toBe(use === "used");
    const tDiffers =
      tunnelStartDescriptor(tunnel, linked, { ...tinputs, ...withProfile(edited) }) !==
      tunnelStartDescriptor(tunnel, linked, { ...tinputs, ...withProfile(base) });
    expect(tDiffers).toBe(use === "used");
  });

  it("a deleted profile leaves the server's own fields, as resolveServer does", () => {
    const missing = { ...inputs, authProfileLookup: () => undefined };
    expect(connectDescriptor(linked, missing)).toBe(connectDescriptor(linked, inputs));
  });

  it("agrees with the shared merge helper SilentAuthSshFactory.resolveServer uses", () => {
    const p: AuthProfile = { id: "key-profile", name: "P", username: "root", authType: "key", keyPath: "/k" };
    expect(connectDescriptor(linked, withProfile(p))).toBe(connectDescriptor(applyAuthProfile(linked, p), inputs));
    expect(tunnelStartDescriptor(tunnel, linked, { ...tinputs, ...withProfile(p) }))
      .toBe(tunnelStartDescriptor(tunnel, applyAuthProfile(linked, p), tinputs));
  });
});

describe("start descriptors — proxy username and other empty-vs-absent values", () => {
  it("an empty proxy username equals an absent one (runtime: no proxy auth)", () => {
    const a = { ...server, proxy: { type: "socks5" as const, host: "p", port: 1, username: "" } };
    const b = { ...server, proxy: { type: "socks5" as const, host: "p", port: 1 } };
    expect(connectDescriptor(a, inputs)).toBe(connectDescriptor(b, inputs));
    expect(connectDescriptor({ ...b, proxy: { ...b.proxy, username: "u" } }, inputs)).not.toBe(connectDescriptor(b, inputs));
    const h = { ...server, proxy: { type: "http" as const, host: "p", port: 1, username: "" } };
    expect(connectDescriptor(h, inputs)).toBe(connectDescriptor({ ...h, proxy: { type: "http", host: "p", port: 1 } }, inputs));
  });

  it("whitespace altHost is absent, an empty keyPath and authProfileId are absent, addressless absent is false", () => {
    expect(connectDescriptor({ ...server, altHost: " \t" }, inputs)).toBe(connectDescriptor(server, inputs));
    expect(connectDescriptor({ ...server, authType: "key", keyPath: "" }, inputs)).toBe(connectDescriptor({ ...server, authType: "key" }, inputs));
    expect(connectDescriptor({ ...server, authProfileId: "" }, inputs)).toBe(connectDescriptor(server, inputs));
    expect(connectDescriptor({ ...server, addressless: false }, inputs)).toBe(connectDescriptor(server, inputs));
  });
});

describe("start descriptors — jump-host chain", () => {
  const jump: ServerConfig = { id: "j1", name: "Jump", host: "jh", port: 22, username: "ju", authType: "password", isHidden: false };
  const far: ServerConfig = { id: "j2", name: "Far", host: "fh", port: 22, username: "fu", authType: "password", isHidden: false };
  const target: ServerConfig = { ...server, proxy: { type: "ssh", jumpHostId: "j1" } };

  function world(records: ServerConfig[], profiles: AuthProfile[] = []) {
    return {
      ...inputs,
      serverLookup: (id: string) => records.find((r) => r.id === id),
      authProfileLookup: (id: string) => profiles.find((p) => p.id === id)
    };
  }
  const both = (t: ServerConfig, w: ReturnType<typeof world>) =>
    [connectDescriptor(t, w), tunnelStartDescriptor(tunnel, t, { ...tinputs, ...w })];

  it("a jump host's own host, port, user, auth, key, proxy and legacy flag change both descriptors", () => {
    const base = both(target, world([target, jump]));
    for (const patch of [
      { host: "other" }, { port: 2222 }, { username: "x" }, { authType: "key" as const },
      { legacyAlgorithms: true }, { proxy: { type: "socks5" as const, host: "p", port: 1 } }
    ]) {
      expect(both(target, world([target, { ...jump, ...patch }]))).not.toEqual(base);
    }
  });

  it("a jump host's key path counts for a key hop, and its multiplexing and pooled alt host count", () => {
    const keyJump = { ...jump, authType: "key" as const };
    expect(both(target, world([target, { ...keyJump, keyPath: "/k" }]))).not.toEqual(both(target, world([target, keyJump])));
    expect(both(target, world([target, { ...jump, altHost: "alt" }]))).not.toEqual(both(target, world([target, jump])));
    expect(both(target, world([target, { ...jump, multiplexing: false }]))).not.toEqual(both(target, world([target, jump])));
    // Alt host is moot when the hop bypasses the pool.
    const off = { ...jump, multiplexing: false };
    expect(both(target, world([target, { ...off, altHost: "alt" }]))).toEqual(both(target, world([target, off])));
  });

  it("a jump host's linked profile username edit changes both descriptors", () => {
    const linked = { ...jump, authProfileId: "ap1" };
    const p1: AuthProfile = { id: "ap1", name: "P", username: "a", authType: "password" };
    expect(both(target, world([target, linked], [{ ...p1, username: "b" }]))).not.toEqual(both(target, world([target, linked], [p1])));
    expect(both(target, world([target, linked], [{ ...p1, name: "Renamed" }]))).toEqual(both(target, world([target, linked], [p1])));
  });

  it("the far hop of a two-hop chain counts", () => {
    const mid = { ...jump, proxy: { type: "ssh" as const, jumpHostId: "j2" } };
    expect(both(target, world([target, mid, { ...far, host: "changed" }]))).not.toEqual(both(target, world([target, mid, far])));
  });

  it("renaming or moving the jump server does not change them", () => {
    expect(both(target, world([target, { ...jump, name: "Renamed", group: "G", isHidden: true }])))
      .toEqual(both(target, world([target, jump])));
  });

  it("a cycle terminates with a stable descriptor", () => {
    const a = { ...jump, proxy: { type: "ssh" as const, jumpHostId: "j2" } };
    const b = { ...far, proxy: { type: "ssh" as const, jumpHostId: "j1" } };
    const w = world([target, a, b]);
    expect(connectDescriptor(target, w)).toBe(connectDescriptor(target, w));
    expect(connectDescriptor(target, w)).toContain("cycle");
  });

  it("a missing jump server is a distinct value, not a crash", () => {
    const missing = connectDescriptor(target, world([target]));
    expect(missing).toContain("missing");
    expect(missing).not.toBe(connectDescriptor(target, world([target, jump])));
  });

  /** The per-hop fields reuse the server classification table: what a tunnel/connect reads on a target, a hop reads too. */
  it.each(Object.entries(SERVER_FIELDS).filter(([k, v]) => v.use === "connect+tunnel" && k !== "id" && k !== "keyPath"))(
    "hop.%s follows its classification",
    (key, { alt }) => {
      const base = both(target, world([target, jump]));
      const changed = both(target, world([target, { ...jump, [key]: alt } as ServerConfig]));
      // keyPath is excluded from this loop: it counts only for a key hop (see above).
      expect(changed).not.toEqual(base);
    }
  );

  it.each(Object.entries(SERVER_FIELDS).filter(([, v]) => v.use === "ignored"))("hop.%s is ignored", (key, { alt }) => {
    expect(both(target, world([target, { ...jump, [key]: alt } as ServerConfig])))
      .toEqual(both(target, world([target, jump])));
  });
});
