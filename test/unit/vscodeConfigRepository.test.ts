import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { VscodeConfigRepository } from "../../src/storage/vscodeConfigRepository";
import type { ServerConfig } from "../../src/models/config";

/**
 * A fake ExtensionContext whose globalState mirrors VS Code semantics: the
 * default is returned ONLY when the key is absent. A stored value of any shape
 * (including a corrupt non-array) is returned verbatim. `update` models VS
 * Code 1.105's ExtensionMemento boundary: object and array values are
 * JSON-cloned into the cache synchronously before the returned persistence
 * promise settles.
 */
function makeContext(state: Record<string, unknown>) {
  // Capture these before a performance test spies on JSON.stringify: the
  // Memento's internal clone is outside the repository work E3 measures.
  const jsonStringify = JSON.stringify;
  const jsonParse = JSON.parse;
  return {
    globalState: {
      get(key: string, fallback: unknown) {
        return key in state ? state[key] : fallback;
      },
      async update(key: string, value: unknown) {
        if (value === undefined) delete state[key];
        else state[key] = jsonParse(jsonStringify(value));
      }
    }
  } as unknown as import("vscode").ExtensionContext;
}

function makePostUpdateGetFailureContext(
  state: Record<string, unknown>,
  cacheReadError: Error,
  persistence: Promise<void>
) {
  let failNextGet = false;
  let failuresRemaining = 1;
  return {
    globalState: {
      get<T>(key: string, fallback?: T): T | undefined {
        if (failNextGet) {
          failNextGet = false;
          failuresRemaining -= 1;
          throw cacheReadError;
        }
        return key in state ? (state[key] as T) : fallback;
      },
      update(key: string, value: unknown): Promise<void> {
        if (value === undefined) delete state[key];
        else state[key] = JSON.parse(JSON.stringify(value));
        failNextGet = failuresRemaining > 0;
        return persistence;
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

  it("(T-M3) SAVED FILTER DEFINITIONS (PR-E) getSavedFilters DROPS a malformed entry WHOLE while a valid sibling in the same array survives (kills a validator loosened to accept a non-string filter or an empty name)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Five malformed shapes `validateSavedFilter` must reject, plus one valid
    // sibling in the SAME array — so the assertion cannot pass merely because the
    // array was empty. Each malformed entry must be dropped WHOLE, never partially
    // loaded. This is the store-getter read boundary (no `ensureId` synthesis), so
    // a missing-id and a non-object entry are exercised faithfully here.
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.savedFilters": [
          { id: "bad-filter-type", name: "Bad filter type", filter: 42 }, // filter not a string
          { id: "bad-empty-name", name: "", filter: "x=1" }, // empty name
          { name: "no-id", filter: "x=1" }, // missing id
          "not-an-object", // non-object entry
          null, // null entry
          { id: "good", name: "Good", filter: "role=core" } // the valid sibling
        ]
      })
    );

    const filters = await repo.getSavedFilters();

    // Only the valid sibling survives; every malformed entry was dropped whole.
    expect(filters).toEqual([{ id: "good", name: "Good", filter: "role=core" }]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("(Codex round 5, P2) SAVED FILTER DEFINITIONS (PR-E) getSavedFilters DROPS a `__create__`-prefixed id WHOLE while a valid uuid sibling survives (kills a validator that lets the reserved inline-create sentinel prefix through and load an un-selectable filter)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A `__create__`-prefixed id is the webview inline-create sentinel namespace
    // (isCreateOption): loaded, such a filter is DISPLAYED but un-selectable —
    // clicking it opens "Save current filter as…" instead of applying it. It can
    // only arrive via an imported backup or a hand-edited row (randomUUID never
    // produces it). Two flavours: an arbitrary prefixed id, and one that exactly
    // collides with the real save-current sentinel value. Both must be dropped
    // WHOLE; the valid uuid sibling in the SAME array must survive.
    const repo = new VscodeConfigRepository(
      makeContext({
        "nexus.savedFilters": [
          { id: "__create__foo", name: "Foo", filter: "role=core" },
          { id: "__create__savedFilter", name: "Collides with sentinel", filter: "site=syd" },
          { id: "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f", name: "Real", filter: "role=edge" }
        ]
      })
    );

    const filters = await repo.getSavedFilters();

    expect(filters).toEqual([{ id: "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f", name: "Real", filter: "role=edge" }]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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

/**
 * DEFECT B (cross-window overwrite detection) — every save*() persists the
 * whole in-memory list, and globalState is shared across windows with
 * last-writer-wins and no compare-and-swap, so a save from window A silently
 * reverts anything window B persisted since A last loaded. Prevention is not
 * available at the Memento layer (whole-blob writes, no CAS); the repository
 * therefore DETECTS the overwrite — baseline JSON per key, recorded on read
 * and write, compared against the store at save time — and warns without ever
 * blocking or failing the save. The fake context's shared `state` object
 * stands in for the cross-window-propagated globalState cache. Each test
 * names the wrong implementation it fails against.
 */
describe("VscodeConfigRepository cross-window overwrite detection", () => {
  const validSource = {
    id: "source-1",
    providerId: "netbox",
    name: "NetBox",
    targetFolder: "NetBox",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config: {},
    secretFieldIds: []
  };

  // Every collection, exercised through its own get/save pair: the defect is
  // general, so the guard must be too. Values are minimal but VALID for their
  // reader (reads sanitize), and `changed` differs from both `initial` and
  // `saved` so the buggy paths visibly diverge.
  const COLLECTIONS: Array<{
    label: string;
    key: string;
    initial: unknown[];
    changed: unknown[];
    saved: unknown[];
    read: (r: VscodeConfigRepository) => Promise<unknown>;
    save: (r: VscodeConfigRepository, value: unknown[]) => Promise<void>;
  }> = [
    {
      label: "servers",
      key: "nexus.servers",
      initial: [validServer],
      changed: [{ ...validServer, name: "Renamed in window B" }],
      saved: [{ ...validServer, name: "Saved by window A" }],
      read: (r) => r.getServers(),
      save: (r, v) => r.saveServers(v as never)
    },
    {
      label: "tunnel profiles",
      key: "nexus.tunnels",
      initial: [],
      changed: [{ id: "t1", name: "B", localPort: 1, remoteIP: "h", remotePort: 2, autoStart: false }],
      saved: [{ id: "t2", name: "A", localPort: 3, remoteIP: "h", remotePort: 4, autoStart: false }],
      read: (r) => r.getTunnels(),
      save: (r, v) => r.saveTunnels(v as never)
    },
    {
      label: "serial profiles",
      key: "nexus.serialProfiles",
      initial: [],
      changed: [{ id: "sp1", name: "B", path: "/dev/ttyUSB0", baudRate: 9600 }],
      saved: [{ id: "sp2", name: "A", path: "/dev/ttyUSB1", baudRate: 115200 }],
      read: (r) => r.getSerialProfiles(),
      save: (r, v) => r.saveSerialProfiles(v as never)
    },
    {
      label: "local shell profiles",
      key: "nexus.localShellProfiles",
      initial: [],
      changed: [{ id: "l1", name: "B", launchMode: "custom", shellPath: "/bin/sh" }],
      saved: [{ id: "l2", name: "A", launchMode: "custom", shellPath: "/bin/bash" }],
      read: (r) => r.getLocalShellProfiles(),
      save: (r, v) => r.saveLocalShellProfiles(v as never)
    },
    {
      label: "folders",
      key: "nexus.groups",
      initial: ["Prod"],
      changed: ["Prod", "Added in window B"],
      saved: ["Prod", "Added in window A"],
      read: (r) => r.getGroups(),
      save: (r, v) => r.saveGroups(v as never)
    },
    {
      label: "auth profiles",
      key: "nexus.authProfiles",
      initial: [],
      changed: [{ id: "a1", name: "B", username: "u", authType: "password" }],
      saved: [{ id: "a2", name: "A", username: "u", authType: "password" }],
      read: (r) => r.getAuthProfiles(),
      save: (r, v) => r.saveAuthProfiles(v as never)
    },
    {
      label: "inventory sources",
      key: "nexus.inventorySources",
      initial: [validSource],
      changed: [{ ...validSource, name: "Renamed in window B" }],
      saved: [{ ...validSource, name: "Saved by window A" }],
      read: (r) => r.getInventorySources(),
      save: (r, v) => r.saveInventorySources(v as never)
    },
    {
      label: "device templates",
      key: "nexus.deviceTemplates",
      initial: [],
      changed: [{ id: "d1", name: "B", fields: {} }],
      saved: [{ id: "d2", name: "A", fields: {} }],
      read: (r) => r.getDeviceTemplates(),
      save: (r, v) => r.saveDeviceTemplates(v as never)
    },
    {
      label: "saved filters",
      key: "nexus.savedFilters",
      initial: [],
      changed: [{ id: "11111111-1111-4111-8111-111111111111", name: "B", providerId: "netbox", filter: "x" }],
      saved: [{ id: "22222222-2222-4222-8222-222222222222", name: "A", providerId: "netbox", filter: "y" }],
      read: (r) => r.getSavedFilters(),
      save: (r, v) => r.saveSavedFilters(v as never)
    }
  ];

  for (const c of COLLECTIONS) {
    it(`${c.key}: a save that overwrites another window's change warns AND still writes (kills the guard-less save — the silent revert this detection exists to expose — and kills a guard that blocks the write)`, async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const state: Record<string, unknown> = { [c.key]: c.initial };
        const onConcurrentOverwrite = vi.fn();
        const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });

        await c.read(repo); // window A loads (activation) -> baseline
        state[c.key] = c.changed; // window B's edit propagates into the store

        await c.save(repo, c.saved); // window A saves

        expect(onConcurrentOverwrite).toHaveBeenCalledTimes(1);
        expect(onConcurrentOverwrite).toHaveBeenCalledWith(c.label);
        // The write itself is NOT blocked or altered: last-writer-wins stands,
        // it just stops being silent.
        expect(state[c.key]).toEqual(c.saved);
      } finally {
        warnSpy.mockRestore();
      }
    });
  }

  it("this window's own saves never trip the detector, even across several different writes (kills a baseline that is not refreshed after a save, and kills naive 'warn whenever the new value differs from the stored one' — which would fire on every genuine change)", async () => {
    const state: Record<string, unknown> = { "nexus.inventorySources": [validSource] };
    const onConcurrentOverwrite = vi.fn();
    const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });

    await repo.getInventorySources();
    await repo.saveInventorySources([{ ...validSource, name: "First edit" }] as never);
    await repo.saveInventorySources([{ ...validSource, name: "Second edit" }] as never);
    await repo.saveInventorySources([] as never);

    expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    expect(state["nexus.inventorySources"]).toEqual([]);
  });

  it("a baseline whose REFERENCE moved while its CONTENT stood still does not warn, even when this window is making a real edit (kills the pre-2.8.201 predicate, which compared the stored value against the PENDING one and so fired on every genuine change once any unrelated write had replaced the cached object — reported in the field by a user with a single window open)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const state: Record<string, unknown> = { "nexus.inventorySources": [validSource] };
      const onConcurrentOverwrite = vi.fn();
      const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });

      await repo.getInventorySources(); // activation seeds the baseline

      // Nobody edited anything. The object behind this key is simply a
      // different instance carrying identical content — what a whole-blob
      // Memento write from anywhere else in the extension leaves behind.
      state["nexus.inventorySources"] = [{ ...validSource }];

      // ...and now the user does something that really does change content.
      await repo.saveInventorySources([{ ...validSource, name: "Re-synced" }] as never);

      expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("an IN-PLACE mutation of the rows this repository handed to the core is not a foreign edit (kills a baseline that stores a live reference: getServers returns the raw stored rows, and NexusCore._renameFolderPath rewrites server.group ON those objects, so a mutable baseline drifts to match the pending value and reports a folder rename as somebody else's overwrite)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const state: Record<string, unknown> = { "nexus.servers": [{ ...validServer, group: "Lab" }] };
      const onConcurrentOverwrite = vi.fn();
      const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });

      const servers = await repo.getServers(); // the core is handed the RAW rows

      // An unrelated whole-blob write leaves an equal clone behind this key.
      state["nexus.servers"] = JSON.parse(JSON.stringify(state["nexus.servers"]));

      // The core renames a folder — mutating the very object it was handed.
      servers[0].group = "Lab renamed";

      await repo.saveServers(servers);

      expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a foreign edit is still caught when the reference AND the content both moved (kills over-correcting the above into a detector that never fires)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const state: Record<string, unknown> = { "nexus.inventorySources": [validSource] };
      const onConcurrentOverwrite = vi.fn();
      const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });

      await repo.getInventorySources();
      state["nexus.inventorySources"] = [{ ...validSource, name: "Edited elsewhere" }];

      await repo.saveInventorySources([{ ...validSource, name: "Edited here" }] as never);

      expect(onConcurrentOverwrite).toHaveBeenCalledTimes(1);
      expect(onConcurrentOverwrite).toHaveBeenCalledWith("inventory sources");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a save with no baseline (key never read or written by this window) does not warn (kills a detector that compares against undefined and cries foul on first contact)", async () => {
    const state: Record<string, unknown> = { "nexus.groups": ["Pre-existing"] };
    const onConcurrentOverwrite = vi.fn();
    const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });

    await repo.saveGroups(["Fresh"]);

    expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    expect(state["nexus.groups"]).toEqual(["Fresh"]);
  });

  it("a save after a detected overwrite re-baselines: the NEXT save does not warn again without a new foreign write (kills a baseline frozen at read time, which would nag on every subsequent save forever)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const state: Record<string, unknown> = { "nexus.groups": ["Prod"] };
      const onConcurrentOverwrite = vi.fn();
      const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });

      await repo.getGroups();
      state["nexus.groups"] = ["Prod", "From window B"];
      await repo.saveGroups(["Prod", "From window A"]);
      expect(onConcurrentOverwrite).toHaveBeenCalledTimes(1);

      await repo.saveGroups(["Prod"]);
      expect(onConcurrentOverwrite).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a throwing onConcurrentOverwrite callback does not fail the save (kills a guard able to break persistence — the one regression the detection must never introduce)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const state: Record<string, unknown> = { "nexus.groups": ["Prod"] };
      const repo = new VscodeConfigRepository(makeContext(state), {
        onConcurrentOverwrite: () => {
          throw new Error("notifier bug");
        }
      });

      await repo.getGroups();
      state["nexus.groups"] = ["From window B"];

      await expect(repo.saveGroups(["From window A"])).resolves.toBeUndefined();
      expect(state["nexus.groups"]).toEqual(["From window A"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a post-update cache read failure is fail-open and clears both stale baselines after the cache already accepted the pending value (kills baseline refresh outside the detector catch)", async () => {
    const cacheReadError = new Error("cache unavailable after update");
    const state: Record<string, unknown> = { "nexus.groups": ["Prod"] };
    const onConcurrentOverwrite = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repo = new VscodeConfigRepository(
      makePostUpdateGetFailureContext(state, cacheReadError, Promise.resolve()),
      { onConcurrentOverwrite }
    );
    try {
      await repo.getGroups();

      await expect(repo.saveGroups(["Saved"])).resolves.toBeUndefined();
      expect(state["nexus.groups"]).toEqual(["Saved"]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[Nexus] Concurrent-write detection failed; saving anyway:",
        cacheReadError
      );
      const baselines = repo as unknown as {
        lastSeenValue: Map<string, unknown>;
        lastSeenJson: Map<string, string | undefined>;
      };
      expect(baselines.lastSeenValue.has("nexus.groups")).toBe(false);
      expect(baselines.lastSeenJson.has("nexus.groups")).toBe(false);

      // If either old map entry survived, this later replacement would be
      // compared with the stale pre-failure baseline and reported.
      state["nexus.groups"] = ["From elsewhere"];
      await repo.saveGroups(["Saved again"]);
      expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a post-update cache read failure preserves and awaits a rejecting persistence verdict (kills adopting the cache-read error and abandoning the update promise)", async () => {
    const cacheReadError = new Error("cache unavailable after update");
    const persistenceError = new Error("disk unavailable");
    const persistence = Promise.reject(persistenceError);
    // Keep the deliberately leaked promise from becoming an unhandled test-run
    // rejection against the broken implementation; the repository still gets
    // the original rejecting promise and must await its verdict.
    void persistence.catch(() => undefined);
    const state: Record<string, unknown> = { "nexus.groups": ["Prod"] };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repo = new VscodeConfigRepository(
      makePostUpdateGetFailureContext(state, cacheReadError, persistence)
    );
    try {
      await repo.getGroups();

      await expect(repo.saveGroups(["Saved"])).rejects.toBe(persistenceError);
      expect(state["nexus.groups"]).toEqual(["Saved"]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[Nexus] Concurrent-write detection failed; saving anyway:",
        cacheReadError
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the repository warning describes the baseline as the last value read or saved (kills the stale 'read or wrote' wording)", async () => {
    const state: Record<string, unknown> = { "nexus.groups": ["Prod"] };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repo = new VscodeConfigRepository(makeContext(state));
    try {
      await repo.getGroups();
      state["nexus.groups"] = ["From elsewhere"];

      await repo.saveGroups(["Saved"]);

      expect(warnSpy).toHaveBeenCalledWith(
        "[Nexus] The folders list changed in storage since this window last read or saved it; this window's save is overwriting that change."
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a persistence rejection still rejects the save after the synchronous cache baseline refresh (kills swallowing update failures while capturing the cloned cache object)", async () => {
    const persistenceError = new Error("disk unavailable");
    const state: Record<string, unknown> = { "nexus.groups": ["Prod"] };
    const context = {
      globalState: {
        get<T>(key: string, fallback?: T): T | undefined {
          return key in state ? (state[key] as T) : fallback;
        },
        update(key: string, value: unknown): Promise<void> {
          if (value === undefined) delete state[key];
          else state[key] = JSON.parse(JSON.stringify(value));
          return Promise.reject(persistenceError);
        }
      }
    } as unknown as import("vscode").ExtensionContext;
    const repo = new VscodeConfigRepository(context);

    await repo.getGroups();

    await expect(repo.saveGroups(["Saved"])).rejects.toThrow(persistenceError);
    expect(state["nexus.groups"]).toEqual(["Saved"]);
  });
});

/**
 * REVIEW FIXES E1/E2/E3 (PR #93) — the guard itself must not cry wolf: a
 * warning that fires when nothing was lost trains the user to ignore the one
 * that matters. E1: two windows converging on the SAME value is not a loss.
 * E2: the Memento synchronously JSON-clones an object/array into its cache
 * inside update(), before the returned promise settles, so an overlapping
 * same-collection save in ONE window must never observe its own predecessor as
 * a foreign write. E3: the
 * steady-state save path serializes the pending collection exactly once and
 * must not also serialize the stored side when the cache object was not
 * replaced (multi-thousand-row imports run on the extension-host thread).
 * Each test names the wrong implementation it fails against.
 */
describe("VscodeConfigRepository overwrite detection precision (E1/E2/E3)", () => {
  const KEY = "nexus.groups";

  function makeRepo(initial: unknown) {
    const state: Record<string, unknown> = { [KEY]: initial };
    const onConcurrentOverwrite = vi.fn();
    const repo = new VscodeConfigRepository(makeContext(state), { onConcurrentOverwrite });
    return { state, onConcurrentOverwrite, repo };
  }

  it("E1: a foreign write whose content is identical to the pending save warns about nothing (kills the baseline-only comparison, which reports byte-identical data as overwritten)", async () => {
    const { state, onConcurrentOverwrite, repo } = makeRepo(["Prod"]);
    await repo.getGroups();
    // Window B lands a change... which is exactly the value window A is about
    // to save (deep-equal, different object — foreign propagation always
    // yields fresh objects).
    state[KEY] = ["Prod", "Shared"];

    await repo.saveGroups(["Prod", "Shared"]);

    expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    expect(state[KEY]).toEqual(["Prod", "Shared"]);
  });

  it("E2: two overlapping same-collection saves in one window warn about nothing (kills the baseline refreshed only AFTER the awaited update — the cache mutates synchronously inside update(), so the second save would observe its own predecessor as foreign)", async () => {
    const { state, onConcurrentOverwrite, repo } = makeRepo(["Prod"]);
    await repo.getGroups();

    // Neither save is awaited before the next starts — exactly the overlap
    // NexusCore can produce with back-to-back persistence calls.
    const first = repo.saveGroups(["Prod", "A"]);
    const second = repo.saveGroups(["Prod", "A", "B"]);
    await Promise.all([first, second]);

    expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    expect(state[KEY]).toEqual(["Prod", "A", "B"]);
  });

  it("E2 counter-direction: a genuinely foreign write landing between two local saves in the same window STILL warns (kills 'fixing' E2 by suppressing detection around local saves altogether)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { state, onConcurrentOverwrite, repo } = makeRepo(["Prod"]);
      await repo.getGroups();
      await repo.saveGroups(["Prod", "A"]);
      expect(onConcurrentOverwrite).not.toHaveBeenCalled();

      state[KEY] = ["From window B"];

      await repo.saveGroups(["Prod", "A", "C"]);
      expect(onConcurrentOverwrite).toHaveBeenCalledTimes(1);
      expect(state[KEY]).toEqual(["Prod", "A", "C"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("E2 counter-direction: a foreign write landing DURING an overlap of two local saves still warns (kills a same-key queue that skips comparison for queued saves)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { state, onConcurrentOverwrite, repo } = makeRepo(["Prod"]);
      await repo.getGroups();

      const first = repo.saveGroups(["Prod", "A"]);
      state[KEY] = ["From window B"]; // propagation lands mid-overlap
      const second = repo.saveGroups(["Prod", "A", "B"]);
      await Promise.all([first, second]);

      expect(onConcurrentOverwrite).toHaveBeenCalledTimes(1);
      expect(state[KEY]).toEqual(["Prod", "A", "B"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("E3 (revised in 2.8.201): consecutive ordinary same-window saves each serialize only the pending collection once and never the stored side (kills a post-update baseline that retains the caller object instead of the synchronously cloned cache object)", async () => {
    // WHY THIS TEST CHANGED. It originally asserted ZERO serialization, which
    // was affordable only while the reference check was believed to prove a
    // foreign write. It does not (2.8.201): the baseline must be a frozen
    // record of CONTENT, because the objects behind it are handed to NexusCore
    // and mutated in place there. One O(n) pass over the pending value per save
    // is the price; that same serialization becomes the immutable baseline. It
    // is strictly smaller than the `globalState.update` beside it, which
    // marshals the extension's ENTIRE blob across the extension-host RPC
    // boundary regardless. Weakening this to "no assertion" would have been the
    // wrong repair: what is worth pinning is that the stored-side pass is not
    // added until the cache object is actually replaced. The test fake performs
    // its own clone using the pre-spy JSON functions, so this count is solely
    // repository serialization work.
    const bigList = Array.from({ length: 2000 }, (_, i) => `Folder ${i}`);
    const { state, onConcurrentOverwrite, repo } = makeRepo(["Prod"]);
    await repo.getGroups();

    const stringifySpy = vi.spyOn(JSON, "stringify");
    try {
      await repo.saveGroups(bigList);
      await repo.saveGroups([...bigList, "one more"]);
      expect(stringifySpy).toHaveBeenCalledTimes(2);
    } finally {
      stringifySpy.mockRestore();
    }
    expect(onConcurrentOverwrite).not.toHaveBeenCalled();
    expect(state[KEY]).toEqual([...bigList, "one more"]);
  });

  it("E3b: a save whose stored REFERENCE was replaced costs at most TWO passes — one for the pending value, one for the stored one (kills recomputing the pending serialization for the baseline after already serializing it for the comparison, which made the path this guard exists for the most expensive one; the unchanged-reference case above never exercised it)", async () => {
    const bigList = Array.from({ length: 2000 }, (_, i) => `Folder ${i}`);
    const { state, repo } = makeRepo(["Prod"]);
    await repo.getGroups();

    // The scenario this whole change is about: an unrelated whole-blob write
    // leaves an equal clone behind this key, so the reference no longer matches.
    state[KEY] = JSON.parse(JSON.stringify(state[KEY]));

    const stringifySpy = vi.spyOn(JSON, "stringify");
    try {
      await repo.saveGroups(bigList);
      expect(stringifySpy).toHaveBeenCalledTimes(2);
    } finally {
      stringifySpy.mockRestore();
    }
    expect(state[KEY]).toEqual(bigList);
  });

  it("E3c: a save that actually WARNS still costs at most two passes (kills a third pass hidden behind the divergence branch)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const bigList = Array.from({ length: 2000 }, (_, i) => `Folder ${i}`);
      const { state, onConcurrentOverwrite, repo } = makeRepo(["Prod"]);
      await repo.getGroups();

      // A genuine foreign edit: reference AND content both moved.
      state[KEY] = ["Prod", "From another window"];

      const stringifySpy = vi.spyOn(JSON, "stringify");
      try {
        await repo.saveGroups(bigList);
        expect(stringifySpy).toHaveBeenCalledTimes(2);
      } finally {
        stringifySpy.mockRestore();
      }
      expect(onConcurrentOverwrite).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
