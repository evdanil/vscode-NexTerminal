import { describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { watchPoolInvalidationOnConfigMutation } from "../../src/services/ssh/poolConfigInvalidation";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

function server(id: string, extra: Partial<ServerConfig> = {}): ServerConfig {
  return { id, name: id, host: `${id}.example`, port: 22, username: "u", authType: "password", isHidden: false, ...extra };
}

/** A repository whose persistence can be held open, like a slow globalState write. */
class HeldRepository extends InMemoryConfigRepository {
  private gates: Array<() => void> = [];
  public hold = false;
  /** Resolves every held save (a mutation may persist more than one collection). */
  public get release(): (() => void) | undefined {
    return this.gates.length > 0 ? () => { const g = this.gates; this.gates = []; g.forEach((r) => r()); } : undefined;
  }
  public override async saveServers(servers: ServerConfig[]): Promise<void> {
    await this.gate();
    return super.saveServers(servers);
  }
  public override async saveAuthProfiles(profiles: AuthProfile[]): Promise<void> {
    await this.gate();
    return super.saveAuthProfiles(profiles);
  }
  private gate(): Promise<void> {
    if (!this.hold) return Promise.resolve();
    return new Promise<void>((resolve) => { this.gates.push(resolve); });
  }
}

/** Releases held saves until the operation settles (a mutation may persist several collections in turn). */
async function settle(repo: HeldRepository, operation: Promise<unknown>): Promise<void> {
  let done = false;
  void operation.finally(() => { done = true; });
  while (!done) {
    repo.release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function setup(servers: ServerConfig[], authProfiles: AuthProfile[] = []) {
  const repo = new HeldRepository(servers, [], [], [], authProfiles);
  const core = new NexusCore(repo);
  await core.initialize();
  const invalidate = vi.fn();
  const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate });
  repo.hold = true;
  const ids = () => new Set(invalidate.mock.calls.map((c) => c[0]));
  return { core, repo, invalidate, ids, stop };
}

describe("pool invalidation is synchronous with the in-memory mutation", () => {
  it("a server edit invalidates it and its jump riders BEFORE persistence resolves", async () => {
    const { core, repo, ids, stop } = await setup([server("jump"), server("t", { proxy: { type: "ssh", jumpHostId: "jump" } }), server("x")]);
    const pending = core.addOrUpdateServer({ ...core.getServer("jump")!, host: "moved.example" });
    // Persistence is still pending: the pool has already been told.
    expect(ids()).toEqual(new Set(["jump", "t"]));
    await settle(repo, pending);
    stop();
  });

  it("switching a jump host from SSH to Telnet retires it and its transitive dependents before persistence resolves", async () => {
    const { core, repo, ids, stop } = await setup([
      server("jump"), server("mid", { proxy: { type: "ssh", jumpHostId: "jump" } }),
      server("far", { proxy: { type: "ssh", jumpHostId: "mid" } }), server("x")
    ]);
    const pending = core.addOrUpdateServer({ ...core.getServer("jump")!, protocol: "telnet" });
    expect(ids()).toEqual(new Set(["jump", "mid", "far"]));
    await settle(repo, pending);
    stop();
  });

  it("a non-connection edit invalidates nothing", async () => {
    const { core, repo, ids, stop } = await setup([server("a")]);
    const pending = core.addOrUpdateServer({ ...core.getServer("a")!, name: "Renamed", group: "G" });
    expect(ids().size).toBe(0);
    await settle(repo, pending);
    stop();
  });

  it("a linked auth profile edit invalidates the linked servers and their riders before persistence resolves", async () => {
    const profile: AuthProfile = { id: "ap", name: "AP", username: "a", authType: "password" };
    const { core, repo, ids, stop } = await setup(
      [server("jump", { authProfileId: "ap" }), server("t", { proxy: { type: "ssh", jumpHostId: "jump" } }), server("x")],
      [profile]
    );
    const pending = core.addOrUpdateAuthProfile({ ...profile, username: "b" });
    expect(ids()).toEqual(new Set(["jump", "t"]));
    await settle(repo, pending);
    stop();
  });

  it("a server removal invalidates it and its riders before persistence resolves", async () => {
    const { core, repo, ids, stop } = await setup([server("jump"), server("t", { proxy: { type: "ssh", jumpHostId: "jump" } })]);
    const pending = core.removeServer("jump");
    expect(ids()).toEqual(new Set(["jump", "t"]));
    await settle(repo, pending);
    stop();
  });
});

describe("wholesale reload (initialize / Refresh)", () => {
  /** Rewrites what the repository will hand back, then reloads while the repair save is held open. */
  async function reload(
    initial: ServerConfig[],
    reloaded: ServerConfig[],
    profiles: { initial?: AuthProfile[]; reloaded?: AuthProfile[] } = {}
  ) {
    const s = await setup(initial, profiles.initial ?? []);
    s.repo.hold = false;
    await s.repo.saveServers(reloaded);
    await s.repo.saveAuthProfiles(profiles.reloaded ?? profiles.initial ?? []);
    s.repo.hold = true;
    return s;
  }
  // Two owners of the file-explorer auto-open flag force normalizeFileExplorerAutoOpenOwner
  // to repair the snapshot, so initialize() awaits saveServers after repopulating.
  const flagged = (id: string, extra: Partial<ServerConfig> = {}) => server(id, { openFileExplorerOnFirstConnect: true, ...extra });

  it("a changed host in the reloaded snapshot invalidates it and its riders before the repair save resolves", async () => {
    const jump = server("jump");
    const rider = server("t", { proxy: { type: "ssh", jumpHostId: "jump" } });
    const { core, repo, ids, stop } = await reload(
      [jump, rider, server("x")],
      [flagged("jump", { host: "moved.example" }), flagged("t", { proxy: { type: "ssh", jumpHostId: "jump" } }), server("x")]
    );
    const pending = core.initialize();
    await vi.waitFor(() => expect(repo.release).toBeDefined());
    expect(ids()).toEqual(new Set(["jump", "t"]));
    await settle(repo, pending);
    stop();
  });

  it("an unchanged reload invalidates nothing", async () => {
    const a = server("a");
    const b = server("b");
    const { core, repo, ids, stop } = await reload([a, b], [flagged("a"), flagged("b")]);
    const pending = core.initialize();
    await vi.waitFor(() => expect(repo.release).toBeDefined());
    expect(ids().size).toBe(0);
    await settle(repo, pending);
    stop();
  });

  it("a server missing from the reloaded snapshot is retired with its riders", async () => {
    const { core, repo, ids, stop } = await reload(
      [server("jump"), server("t", { proxy: { type: "ssh", jumpHostId: "jump" } })],
      [flagged("t", { proxy: { type: "ssh", jumpHostId: "jump" } }), flagged("u")]
    );
    const pending = core.initialize();
    await vi.waitFor(() => expect(repo.release).toBeDefined());
    expect(ids()).toEqual(new Set(["jump", "t"]));
    await settle(repo, pending);
    stop();
  });

  it("a reloaded auth profile with changed credentials invalidates its servers; an equal reload does not", async () => {
    const p1: AuthProfile = { id: "ap", name: "AP", username: "a", authType: "password" };
    const linked = [flagged("l", { authProfileId: "ap" }), flagged("m")];
    const changed = await reload(linked, linked, { initial: [p1], reloaded: [{ ...p1, username: "b" }] });
    const pending = changed.core.initialize();
    await vi.waitFor(() => expect(changed.repo.release).toBeDefined());
    expect(changed.ids()).toEqual(new Set(["l"]));
    await settle(changed.repo, pending);
    changed.stop();

    const equal = await reload(linked, linked, { initial: [p1], reloaded: [{ ...p1 }] });
    const pending2 = equal.core.initialize();
    await vi.waitFor(() => expect(equal.repo.release).toBeDefined());
    expect(equal.ids().size).toBe(0);
    await settle(equal.repo, pending2);
    equal.stop();
  });
});

describe("auth profile removal and edits", () => {
  it("removeAuthProfile invalidates the linked servers and their riders before saveAuthProfiles resolves", async () => {
    const profile: AuthProfile = { id: "ap", name: "AP", username: "a", authType: "password" };
    const { core, repo, ids, stop } = await setup(
      [server("jump", { authProfileId: "ap" }), server("t", { proxy: { type: "ssh", jumpHostId: "jump" } }), server("x")],
      [profile]
    );
    const pending = core.removeAuthProfile("ap");
    expect(ids()).toEqual(new Set(["jump", "t"]));
    await settle(repo, pending);
    stop();
  });

  it("a profile rename alone invalidates nothing", async () => {
    const profile: AuthProfile = { id: "ap", name: "AP", username: "a", authType: "password" };
    const { core, repo, ids, stop } = await setup([server("l", { authProfileId: "ap" })], [profile]);
    const pending = core.addOrUpdateAuthProfile({ ...profile, name: "Renamed" });
    expect(ids().size).toBe(0);
    await settle(repo, pending);
    stop();
  });
});

describe("cost", () => {
  it("a 5000-deep jump chain is retired with exactly one invalidate per server", async () => {
    const N = 5000;
    const servers = [server("s0")];
    for (let i = 1; i < N; i++) {
      servers.push(server(`s${i}`, { proxy: { type: "ssh", jumpHostId: `s${i - 1}` } }));
    }
    const { core, repo, invalidate, stop } = await setup(servers);
    repo.hold = false;
    await core.addOrUpdateServer({ ...core.getServer("s0")!, host: "moved.example" });
    expect(invalidate).toHaveBeenCalledTimes(N);
    expect(new Set(invalidate.mock.calls.map((c) => c[0])).size).toBe(N);
    stop();
  });

  it("a bulk edit of many servers invalidates each changed one and its riders once", async () => {
    const jumps = Array.from({ length: 200 }, (_, i) => server(`j${i}`));
    const riders = jumps.map((j, i) => server(`r${i}`, { proxy: { type: "ssh", jumpHostId: j.id } }));
    const { core, repo, invalidate, stop } = await setup([...jumps, ...riders]);
    repo.hold = false;
    for (const j of jumps.slice(0, 100)) {
      await core.addOrUpdateServer({ ...j, host: "moved.example" });
    }
    const ids = new Set(invalidate.mock.calls.map((c) => c[0]));
    expect(ids.size).toBe(200);
    for (let i = 0; i < 100; i++) {
      expect(ids.has(`j${i}`) && ids.has(`r${i}`)).toBe(true);
    }
    expect(ids.has("j150")).toBe(false);
    stop();
  });
});

