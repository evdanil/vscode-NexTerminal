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
});
