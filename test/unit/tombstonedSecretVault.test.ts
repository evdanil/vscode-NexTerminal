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

/** A vault whose store and delete calls are held until the test releases them. */
class GatedVault implements SecretVault {
  public readonly data = new Map<string, string>();
  public readonly storeGates: Array<() => void> = [];
  public readonly deleteGates: Array<() => void> = [];
  public getGate?: Promise<void>;
  public failStore = false;
  async get(key: string) { const v = this.data.get(key); await this.getGate; return v; }
  async store(key: string, value: string) {
    await new Promise<void>((resolve) => this.storeGates.push(resolve));
    if (this.failStore) throw new Error("store failed");
    this.data.set(key, value);
  }
  async delete(key: string) {
    await new Promise<void>((resolve) => this.deleteGates.push(resolve));
    this.data.delete(key);
  }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("TombstonedSecretVault — ordering", () => {
  const key = proxyPasswordSecretKey("s1");

  it("an older store settling does not lift a newer tombstone (absent until the delete lands)", async () => {
    const inner = new GatedVault();
    const vault = new TombstonedSecretVault(inner);
    const oldStore = vault.store(key, "old-endpoint-secret"); // e.g. a post-auth store for the old proxy
    await tick();
    const deleting = vault.markStale(key); // queued behind the store
    inner.storeGates.shift()!(); // the older store succeeds
    await oldStore;
    await tick();
    expect(inner.data.get(key)).toBe("old-endpoint-secret");
    expect(await vault.get(key)).toBeUndefined();
    inner.deleteGates.shift()!();
    await deleting;
    expect(await vault.get(key)).toBeUndefined();
    expect(inner.data.has(key)).toBe(false);
  });

  it("a store issued after markStale lifts the tombstone once written, and the new value is returned", async () => {
    const inner = new GatedVault();
    const vault = new TombstonedSecretVault(inner);
    const deleting = vault.markStale(key);
    const storing = vault.store(key, "new-endpoint-secret");
    await tick();
    inner.deleteGates.shift()!();
    await deleting;
    await tick();
    inner.storeGates.shift()!();
    await storing;
    await tick();
    expect(await vault.get(key)).toBe("new-endpoint-secret");
  });

  it("a double markStale stays absent until the last delete resolves", async () => {
    const inner = new GatedVault();
    inner.data.set(key, "old");
    const vault = new TombstonedSecretVault(inner);
    const first = vault.markStale(key);
    const second = vault.markStale(key);
    await tick();
    inner.deleteGates.shift()!();
    await first;
    await tick();
    expect(await vault.get(key)).toBeUndefined(); // second delete still pending
    inner.deleteGates.shift()!();
    await second;
    expect(await vault.get(key)).toBeUndefined();
    expect(inner.data.has(key)).toBe(false);
  });

  it("a store issued between two markStales does not lift the second tombstone", async () => {
    const inner = new GatedVault();
    const vault = new TombstonedSecretVault(inner);
    const first = vault.markStale(key);
    const storing = vault.store(key, "between");
    const second = vault.markStale(key);
    await tick();
    inner.deleteGates.shift()!();
    await first;
    await tick();
    inner.storeGates.shift()!();
    await storing;
    await tick();
    expect(await vault.get(key)).toBeUndefined();
    inner.deleteGates.shift()!();
    await second;
    expect(await vault.get(key)).toBeUndefined();
  });

  it("a read already in flight when the tombstone appears is discarded", async () => {
    const inner = new GatedVault();
    inner.data.set(key, "old");
    let open!: () => void;
    inner.getGate = new Promise<void>((resolve) => { open = resolve; });
    const vault = new TombstonedSecretVault(inner);
    const reading = vault.get(key);
    const deleting = vault.markStale(key);
    open();
    expect(await reading).toBeUndefined();
    inner.deleteGates.shift()!();
    await deleting;
  });

  it("a failed store does not lift the tombstone, and later operations still run", async () => {
    const inner = new GatedVault();
    inner.failStore = true;
    const vault = new TombstonedSecretVault(inner);
    const deleting = vault.markStale(key);
    const storing = vault.store(key, "x");
    const outcome = storing.catch((e: Error) => e.message);
    await tick();
    inner.deleteGates.shift()!();
    await deleting;
    await tick();
    inner.storeGates.shift()!();
    expect(await outcome).toBe("store failed");
    // The delete already lifted its own generation's tombstone, and nothing was written.
    expect(await vault.get(key)).toBeUndefined();
    inner.failStore = false;
    const again = vault.store(key, "y");
    await tick();
    inner.storeGates.shift()!();
    await again;
    expect(await vault.get(key)).toBe("y");
  });

  it("a direct delete leaves the tombstone state alone and is ordered with stores", async () => {
    const inner = new GatedVault();
    inner.data.set(key, "old");
    const vault = new TombstonedSecretVault(inner);
    const deleting = vault.delete(key);
    expect(await vault.get(key)).toBe("old"); // not stale-marked: still readable until it lands
    inner.deleteGates.shift()!();
    await deleting;
    expect(await vault.get(key)).toBeUndefined();
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
