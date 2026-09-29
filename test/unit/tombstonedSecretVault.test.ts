import { describe, expect, it } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ServerConfig } from "../../src/models/config";
import type { SecretVault } from "../../src/services/ssh/contracts";
import { watchPoolInvalidationOnConfigMutation } from "../../src/services/ssh/poolConfigInvalidation";
import { proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import { TombstonedSecretVault } from "../../src/services/ssh/tombstonedSecretVault";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

class MemoryVault implements SecretVault {
  public readonly data = new Map<string, string>();
  public deleteGate?: Promise<void>;
  public failDelete = false;
  async get(key: string) { return this.data.get(key); }
  async store(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) {
    await this.deleteGate;
    if (this.failDelete) throw new Error("boom");
    this.data.delete(key);
  }
}

function server(extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1", name: "S", host: "h", port: 22, username: "u", authType: "password", isHidden: false,
    proxy: { type: "socks5", host: "old-proxy", port: 1080, username: "pu" }, ...extra
  };
}

describe("TombstonedSecretVault", () => {
  const key = proxyPasswordSecretKey("s1");

  it("reads as absent immediately while the delete is still in flight, then the delete lands", async () => {
    const inner = new MemoryVault();
    inner.data.set(key, "old-secret");
    let open!: () => void;
    inner.deleteGate = new Promise<void>((resolve) => { open = resolve; });
    const vault = new TombstonedSecretVault(inner);

    const deleting = vault.markStale(key);
    expect(await vault.get(key)).toBeUndefined();
    expect(inner.data.get(key)).toBe("old-secret");
    open();
    await deleting;
    expect(inner.data.has(key)).toBe(false);
    expect(await vault.get(key)).toBeUndefined();
  });

  it("a value stored for the new endpoint is used and survives the pending stale delete", async () => {
    const inner = new MemoryVault();
    inner.data.set(key, "old-secret");
    let open!: () => void;
    inner.deleteGate = new Promise<void>((resolve) => { open = resolve; });
    const vault = new TombstonedSecretVault(inner);

    const deleting = vault.markStale(key);
    const storing = vault.store(key, "new-secret");
    expect(await vault.get(key)).toBeUndefined();
    inner.deleteGate = undefined;
    open();
    await Promise.all([deleting, storing]);
    expect(await vault.get(key)).toBe("new-secret");
  });

  it("a failed delete keeps the tombstone (never sends a possibly stale secret)", async () => {
    const inner = new MemoryVault();
    inner.data.set(key, "old-secret");
    inner.failDelete = true;
    const vault = new TombstonedSecretVault(inner);
    await expect(vault.markStale(key)).rejects.toThrow("boom");
    expect(await vault.get(key)).toBeUndefined();
  });

  it("untouched keys read normally", async () => {
    const inner = new MemoryVault();
    inner.data.set("other", "v");
    const vault = new TombstonedSecretVault(inner);
    await vault.markStale(key);
    expect(await vault.get("other")).toBe("v");
  });
});

describe("proxy endpoint edit tombstones the saved proxy password synchronously", () => {
  class SlowRepo extends InMemoryConfigRepository {
    public release?: () => void;
    public override async saveServers(servers: ServerConfig[]): Promise<void> {
      await new Promise<void>((resolve) => { this.release = resolve; });
      return super.saveServers(servers);
    }
  }
  const key = proxyPasswordSecretKey("s1");

  async function setup() {
    const inner = new MemoryVault();
    inner.data.set(key, "old-secret");
    const vault = new TombstonedSecretVault(inner);
    const repo = new SlowRepo([server()], []);
    const core = new NexusCore(repo);
    await core.initialize();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate: () => {} }, (id) => {
      void vault.markStale(proxyPasswordSecretKey(id));
    });
    return { core, repo, vault, inner, stop };
  }

  it("a connect that starts while the save is pending does not see the old proxy's password", async () => {
    const { core, repo, vault, stop } = await setup();
    const pending = core.addOrUpdateServer(server({ proxy: { type: "socks5", host: "new-proxy", port: 1080, username: "pu" } }));
    // What ProxySshFactory.resolveProxyPassword reads:
    expect(await vault.get(key)).toBeUndefined();
    repo.release?.();
    await pending;
    stop();
  });

  it("the password the editor stores for the new endpoint in the same save is used", async () => {
    const { core, repo, vault, stop } = await setup();
    const pending = core.addOrUpdateServer(server({ proxy: { type: "socks5", host: "new-proxy", port: 1080, username: "pu" } }));
    await vault.store(key, "typed-for-new-proxy"); // syncProxyPasswordSecret, right after addOrUpdateServer
    repo.release?.();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await vault.get(key)).toBe("typed-for-new-proxy");
    stop();
  });

  it("a non-proxy edit leaves the saved password alone", async () => {
    const { core, repo, vault, stop } = await setup();
    const pending = core.addOrUpdateServer(server({ name: "Renamed", host: "other-host", username: "root" }));
    expect(await vault.get(key)).toBe("old-secret");
    repo.release?.();
    await pending;
    expect(await vault.get(key)).toBe("old-secret");
    stop();
  });
});
