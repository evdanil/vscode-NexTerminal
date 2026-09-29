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
  public release?: () => void;
  public hold = false;
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
    return new Promise<void>((resolve) => { this.release = resolve; });
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
    repo.release?.();
    await pending;
    stop();
  });

  it("switching a jump host from SSH to Telnet retires it and its transitive dependents before persistence resolves", async () => {
    const { core, repo, ids, stop } = await setup([
      server("jump"), server("mid", { proxy: { type: "ssh", jumpHostId: "jump" } }),
      server("far", { proxy: { type: "ssh", jumpHostId: "mid" } }), server("x")
    ]);
    const pending = core.addOrUpdateServer({ ...core.getServer("jump")!, protocol: "telnet" });
    expect(ids()).toEqual(new Set(["jump", "mid", "far"]));
    repo.release?.();
    await pending;
    stop();
  });

  it("a non-connection edit invalidates nothing", async () => {
    const { core, repo, ids, stop } = await setup([server("a")]);
    const pending = core.addOrUpdateServer({ ...core.getServer("a")!, name: "Renamed", group: "G" });
    expect(ids().size).toBe(0);
    repo.release?.();
    await pending;
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
    repo.release?.();
    await pending;
    stop();
  });

  it("a server removal invalidates it and its riders before persistence resolves", async () => {
    const { core, repo, ids, stop } = await setup([server("jump"), server("t", { proxy: { type: "ssh", jumpHostId: "jump" } })]);
    const pending = core.removeServer("jump");
    expect(ids()).toEqual(new Set(["jump", "t"]));
    repo.release?.();
    await pending;
    stop();
  });
});
