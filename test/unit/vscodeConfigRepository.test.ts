import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { VscodeConfigRepository } from "../../src/storage/vscodeConfigRepository";
import type { ServerConfig } from "../../src/models/config";

/**
 * A fake ExtensionContext whose globalState mirrors VS Code semantics: the
 * default is returned ONLY when the key is absent. A stored value of any shape
 * (including a corrupt non-array) is returned verbatim.
 */
function makeContext(state: Record<string, unknown>) {
  return {
    globalState: {
      get(key: string, fallback: unknown) {
        return key in state ? state[key] : fallback;
      },
      async update(key: string, value: unknown) {
        if (value === undefined) delete state[key];
        else state[key] = value;
      }
    }
  } as unknown as import("vscode").ExtensionContext;
}

const validServer: ServerConfig = {
  id: "s1",
  name: "Prod",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  authType: "password"
};

// Each read method, paired with the globalState key it reads.
const READS = [
  { key: "nexus.servers", call: (r: VscodeConfigRepository) => r.getServers() },
  { key: "nexus.tunnels", call: (r: VscodeConfigRepository) => r.getTunnels() },
  { key: "nexus.serialProfiles", call: (r: VscodeConfigRepository) => r.getSerialProfiles() },
  { key: "nexus.localShellProfiles", call: (r: VscodeConfigRepository) => r.getLocalShellProfiles() },
  { key: "nexus.groups", call: (r: VscodeConfigRepository) => r.getGroups() },
  { key: "nexus.authProfiles", call: (r: VscodeConfigRepository) => r.getAuthProfiles() }
];

const CORRUPT_SHAPES: Array<[string, unknown]> = [
  ["an object", { not: "an array" }],
  ["a string", "corrupt"],
  ["null", null],
  ["a number", 42]
];

describe("VscodeConfigRepository corrupt globalState shapes", () => {
  for (const { key, call } of READS) {
    for (const [label, shape] of CORRUPT_SHAPES) {
      it(`${key} returns [] (not throw) when state holds ${label}`, async () => {
        const repo = new VscodeConfigRepository(makeContext({ [key]: shape }));
        await expect(call(repo)).resolves.toEqual([]);
      });
    }
  }

  it("getServers still returns valid entries when the array is well-formed", async () => {
    const repo = new VscodeConfigRepository(makeContext({ "nexus.servers": [validServer] }));
    await expect(repo.getServers()).resolves.toEqual([validServer]);
  });

  it("getServers returns [] when the key is absent", async () => {
    const repo = new VscodeConfigRepository(makeContext({}));
    await expect(repo.getServers()).resolves.toEqual([]);
  });

  it("getGroups drops non-string entries inside an array", async () => {
    const repo = new VscodeConfigRepository(makeContext({ "nexus.groups": ["a", 1, null, "b"] }));
    await expect(repo.getGroups()).resolves.toEqual(["a", "b"]);
  });

  it("(F13/FIX 5) getServers strips a malformed origin and keeps the rest of the server, warning once — the row is NOT dropped (kills both 'rejects whole server' and 'never strips at all')", async () => {
    const serverWithBadOrigin: ServerConfig = {
      ...validServer,
      id: "s2",
      origin: { sourceId: "src", externalId: "ext", syncedAt: "not-a-number" } as unknown as import("../../src/models/config").ServerOrigin
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new VscodeConfigRepository(makeContext({ "nexus.servers": [serverWithBadOrigin] }));

    const servers = await repo.getServers();

    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe("s2");
    expect((servers[0] as { origin?: unknown }).origin).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("getServers keeps a well-formed origin unchanged", async () => {
    const origin = { sourceId: "src", externalId: "ext", syncedAt: 1000 };
    const serverWithOrigin: ServerConfig = { ...validServer, id: "s3", origin };
    const repo = new VscodeConfigRepository(makeContext({ "nexus.servers": [serverWithOrigin] }));

    const servers = await repo.getServers();

    expect(servers[0].origin).toEqual(origin);
  });

  it("getServers keeps an origin carrying syncedUsername, and keeps one that omits it (kills a shape check that rejects the new member, or that requires it and strips every pre-existing server's origin)", async () => {
    const stamped = { sourceId: "src", externalId: "ext", syncedAt: 1000, syncedUsername: "admin" };
    // The three-member shape every build before this release wrote. Stripping
    // it here would cost those servers their sync ownership on the next read —
    // the exact opposite of the backward compatibility the stamp is optional for.
    const legacy = { sourceId: "src", externalId: "ext2", syncedAt: 1000 };
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          { ...validServer, id: "s4", origin: stamped },
          { ...validServer, id: "s5", origin: legacy }
        ]
      })
    );

    const servers = await repo.getServers();

    expect(servers[0].origin).toEqual(stamped);
    expect(servers[1].origin).toEqual(legacy);
  });

  it("getServers strips an origin whose syncedUsername is not a non-empty string (kills leaving the new member unchecked, which would feed the retro-apply comparison a value no sync could have written)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          { ...validServer, id: "s6", origin: { sourceId: "src", externalId: "ext", syncedAt: 1000, syncedUsername: 42 } },
          { ...validServer, id: "s7", origin: { sourceId: "src", externalId: "ext2", syncedAt: 1000, syncedUsername: "" } }
        ]
      })
    );

    const servers = await repo.getServers();

    // Rows survive (a malformed origin never rejects the whole server); the
    // untrustworthy marker does not.
    expect(servers.map((s) => s.id)).toEqual(["s6", "s7"]);
    expect(servers[0].origin).toBeUndefined();
    expect(servers[1].origin).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("getServers keeps an origin carrying syncedAuthProfileId, and keeps one that omits it (kills a shape check that rejects the opt-out stamp, or that requires it and strips every pre-existing server's origin)", async () => {
    const stamped = { sourceId: "src", externalId: "ext", syncedAt: 1000, syncedUsername: "admin", syncedAuthProfileId: "p1" };
    const legacy = { sourceId: "src", externalId: "ext2", syncedAt: 1000, syncedUsername: "admin" };
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          { ...validServer, id: "s8", origin: stamped },
          { ...validServer, id: "s9", origin: legacy }
        ]
      })
    );

    const servers = await repo.getServers();

    expect(servers[0].origin).toEqual(stamped);
    expect(servers[1].origin).toEqual(legacy);
  });

  it("getServers strips an origin whose syncedAuthProfileId is not a non-empty string (kills leaving the opt-out stamp unchecked, which would feed the retro-apply rule a marker no sync could have written)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          { ...validServer, id: "s10", origin: { sourceId: "src", externalId: "ext", syncedAt: 1000, syncedAuthProfileId: 42 } },
          { ...validServer, id: "s11", origin: { sourceId: "src", externalId: "ext2", syncedAt: 1000, syncedAuthProfileId: "" } }
        ]
      })
    );

    const servers = await repo.getServers();

    expect(servers.map((s) => s.id)).toEqual(["s10", "s11"]);
    expect(servers[0].origin).toBeUndefined();
    expect(servers[1].origin).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("getServers keeps an origin carrying syncedIpmiHost, and keeps one that omits it (kills a shape check that rejects the OOB stamp, or that requires it and strips every pre-existing server's origin)", async () => {
    const stamped = { sourceId: "src", externalId: "ext", syncedAt: 1000, syncedUsername: "admin", syncedIpmiHost: "10.9.9.9" };
    const legacy = { sourceId: "src", externalId: "ext2", syncedAt: 1000, syncedUsername: "admin" };
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          { ...validServer, id: "s12", origin: stamped },
          { ...validServer, id: "s13", origin: legacy }
        ]
      })
    );

    const servers = await repo.getServers();

    expect(servers[0].origin).toEqual(stamped);
    expect(servers[1].origin).toEqual(legacy);
  });

  it("getServers strips an origin whose syncedIpmiHost is not a non-empty string (kills leaving the OOB stamp unchecked, which would feed the write rule a value no sync could have written)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          { ...validServer, id: "s14", origin: { sourceId: "src", externalId: "ext", syncedAt: 1000, syncedIpmiHost: 42 } },
          // An EMPTY stamp is the dangerous one: it would compare equal to a
          // server whose ipmiHost is likewise empty and hand the field to the
          // source on a record nothing synced.
          { ...validServer, id: "s15", origin: { sourceId: "src", externalId: "ext2", syncedAt: 1000, syncedIpmiHost: "" } }
        ]
      })
    );

    const servers = await repo.getServers();

    expect(servers.map((s) => s.id)).toEqual(["s14", "s15"]);
    expect(servers[0].origin).toBeUndefined();
    expect(servers[1].origin).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  /**
   * ADOPT 1 — the same F13/FIX 5 disposition for `formerlySynced`, the "Keep
   * Servers" receipt the sync engine's adoption rule matches on. A restored or
   * hand-edited backup can carry a bad one; it must cost the marker and nothing
   * else.
   *
   * The fixture is built so the two wrong implementations look DIFFERENT from
   * the right one, not merely equivalent: the server carries a marker on the way
   * in (so "never strips" leaves a visible object), and the row is asserted
   * present by id (so "rejects the whole row", which validateServerConfig
   * deliberately does not do, shows up as a missing server rather than as an
   * absent field that reads the same as a successful strip).
   */
  const MALFORMED_MARKERS: Array<[string, unknown]> = [
    ["detachedAt is a string", { sourceId: "src", sourceName: "NetBox", providerId: "netbox", externalId: "device:1", detachedAt: "yesterday" }],
    ["providerId is missing", { sourceId: "src", sourceName: "NetBox", externalId: "device:1", detachedAt: 1000 }],
    ["externalId is empty", { sourceId: "src", sourceName: "NetBox", providerId: "netbox", externalId: "", detachedAt: 1000 }],
    ["it is null", null],
    ["it is a string", "device:1"]
  ];

  for (const [label, marker] of MALFORMED_MARKERS) {
    it(`(ADOPT 1) getServers strips a formerlySynced marker when ${label}, keeping the server (kills 'never strips' and 'rejects the whole row')`, async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const repo = new VscodeConfigRepository(
        makeContext({ "nexus.servers": [{ ...validServer, id: "adopt-bad", formerlySynced: marker }] })
      );

      const servers = await repo.getServers();

      expect(servers.map((s) => s.id)).toEqual(["adopt-bad"]);
      expect((servers[0] as { formerlySynced?: unknown }).formerlySynced).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  }

  it("(ADOPT 1) getServers keeps a well-formed formerlySynced marker verbatim (kills stripping the marker unconditionally, which would make every kept server permanently unadoptable)", async () => {
    const marker = { sourceId: "src-1", sourceName: "NetBox", providerId: "netbox", externalId: "device:1", detachedAt: 1717000000000 };
    const repo = new VscodeConfigRepository(
      makeContext({ "nexus.servers": [{ ...validServer, id: "adopt-ok", formerlySynced: marker }] })
    );

    const servers = await repo.getServers();

    expect(servers[0].formerlySynced).toEqual(marker);
  });

  it("(ADOPT 1) getServers strips BOTH markers from a row that has both malformed (kills porting the origin strip's early `continue`, which returns before the marker is ever looked at)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          {
            ...validServer,
            id: "adopt-both",
            origin: { sourceId: "src", externalId: "ext", syncedAt: "not-a-number" },
            formerlySynced: { sourceId: "src", sourceName: "NetBox", providerId: "netbox", externalId: 42, detachedAt: 1000 }
          }
        ]
      })
    );

    const servers = await repo.getServers();

    expect(servers.map((s) => s.id)).toEqual(["adopt-both"]);
    expect(servers[0].origin).toBeUndefined();
    expect((servers[0] as { formerlySynced?: unknown }).formerlySynced).toBeUndefined();
    // One warning per stripped field — the second strip really ran rather than
    // being short-circuited by the first.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  /**
   * ADOPT 1 (mutual exclusion) — where the two independent strips meet. A row
   * holding a MALFORMED origin beside a WELL-FORMED marker comes off storage
   * unadoptable (the engine's first eligibility clause is `origin === undefined`)
   * and, stripping only the origin, went back to NexusCore ADOPTABLE: claimable
   * whole — name, address, folder, prune policy — by a source that never kept it.
   * Corruption must not buy a row authority it did not have, and repair is not
   * available: the origin is malformed precisely because its `externalId` cannot
   * be trusted, so nothing here can derive a truthful marker. The marker goes with
   * it.
   *
   * Three wrong implementations are each visibly different in this fixture:
   *  - "strip the origin only" leaves a marker object on `both-bad-origin`;
   *  - "reject the row" — which validateServerConfig deliberately does not do for
   *    a bookkeeping field — shows up as a missing id, not as an absent field that
   *    reads exactly like a successful strip;
   *  - "a row may never hold both" strips the marker off `both-good-origin` too,
   *    where nothing has removed the clause that keeps it inert.
   */
  it("(ADOPT 1) getServers drops a WELL-FORMED formerlySynced marker when the origin beside it was stripped as malformed, keeping the row — while a row with a well-formed origin keeps both (kills stripping the origin alone, which promotes a corrupt row to adoptable; kills rejecting the row; kills blanket both-field normalization)", async () => {
    const marker = { sourceId: "src-1", sourceName: "NetBox", providerId: "netbox", externalId: "device:1", detachedAt: 1717000000000 };
    const goodOrigin = { sourceId: "src-1", externalId: "device:2", syncedAt: 1000 };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.servers": [
          {
            ...validServer,
            id: "both-bad-origin",
            origin: { sourceId: "src-1", externalId: "device:2", syncedAt: "not-a-number" },
            formerlySynced: marker
          },
          { ...validServer, id: "both-good-origin", origin: goodOrigin, formerlySynced: marker }
        ]
      })
    );

    const servers = await repo.getServers();

    // Neither row was rejected.
    expect(servers.map((s) => s.id)).toEqual(["both-bad-origin", "both-good-origin"]);

    // THE ASSERTION — the corrupt row comes off storage carrying neither field,
    // i.e. exactly as unadoptable as it was stored.
    expect(servers[0].origin).toBeUndefined();
    expect((servers[0] as { formerlySynced?: unknown }).formerlySynced).toBeUndefined();
    // Both strips are reported: the marker did not vanish silently.
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // The coupling is scoped to the strip, not to the co-existence — this row's
    // origin was trustworthy, so nothing was taken from it.
    expect(servers[1].origin).toEqual(goodOrigin);
    expect(servers[1].formerlySynced).toEqual(marker);
    warnSpy.mockRestore();
  });
});
