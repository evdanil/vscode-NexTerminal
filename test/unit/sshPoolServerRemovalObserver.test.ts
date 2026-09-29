import { describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ServerConfig } from "../../src/models/config";
import { watchSshPoolServerRemovals } from "../../src/services/ssh/sshPoolServerRemovalObserver";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

function server(id: string, jump?: string): ServerConfig {
  return {
    id, name: id, host: `${id}.example`, port: 22, username: "u", authType: "password", isHidden: false,
    ...(jump ? { proxy: { type: "ssh" as const, jumpHostId: jump } } : {})
  };
}

async function setup(servers: ServerConfig[]) {
  const core = new NexusCore(new InMemoryConfigRepository(servers, []));
  await core.initialize();
  const invalidate = vi.fn();
  const stop = watchSshPoolServerRemovals(core, { invalidate });
  return { core, invalidate, stop };
}

describe("watchSshPoolServerRemovals — dependents of a removed jump host", () => {
  it("retires the removed server and every server that rides it, transitively", async () => {
    const { core, invalidate, stop } = await setup([
      server("jump"), server("mid", "jump"), server("far", "mid"), server("other")
    ]);
    await core.removeServer("jump");
    const ids = new Set(invalidate.mock.calls.map((call) => call[0]));
    expect(ids).toEqual(new Set(["jump", "mid", "far"]));
    expect(ids.has("other")).toBe(false);
    stop();
  });

  it("a plain removal with no dependents retires only that server", async () => {
    const { core, invalidate, stop } = await setup([server("a"), server("b")]);
    await core.removeServer("a");
    expect(new Set(invalidate.mock.calls.map((call) => call[0]))).toEqual(new Set(["a"]));
    stop();
  });
});
