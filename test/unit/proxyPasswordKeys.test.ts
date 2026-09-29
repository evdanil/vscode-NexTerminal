import { describe, expect, it } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ServerConfig } from "../../src/models/config";
import type { SecretVault } from "../../src/services/ssh/contracts";
import { watchPoolInvalidationOnConfigMutation } from "../../src/services/ssh/poolConfigInvalidation";
import {
  currentProxyPasswordSecretKey,
  legacyProxyPasswordSecretKey,
  migrateLegacyProxyPasswords,
  proxyPasswordSecretKey
} from "../../src/services/ssh/proxyPasswordKeys";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { KeySerializedSecretVault } from "../../src/services/ssh/keySerializedSecretVault";
import type { PasswordBearingProxy } from "../../src/services/ssh/proxyPasswordKeys";

/** The extension's wiring: deletes go through the per-key write queue, guarded by the delete-time re-check. */
function endpointDeleter(vault: SecretVault) {
  const serialized = new KeySerializedSecretVault(vault);
  return (id: string, proxy: PasswordBearingProxy, stillUnused: () => boolean): Promise<boolean> =>
    serialized.deleteIf(proxyPasswordSecretKey(id, proxy), stillUnused);
}

class MemoryVault implements SecretVault {
  public readonly data = new Map<string, string>();
  public readonly deleted: string[] = [];
  async get(key: string) { return this.data.get(key); }
  async store(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.deleted.push(key); this.data.delete(key); }
}

const A = { type: "socks5" as const, host: "proxy-a", port: 1080, username: "u" };
const B = { type: "socks5" as const, host: "proxy-b", port: 1080, username: "u" };

function server(extra: Partial<ServerConfig> = {}): ServerConfig {
  return { id: "s1", name: "S", host: "h", port: 22, username: "u", authType: "password", isHidden: false, proxy: A, ...extra };
}

describe("endpoint-keyed proxy password keys", () => {
  it("differ per endpoint field and per server, and are stable for equal endpoints", () => {
    const base = proxyPasswordSecretKey("s1", A);
    expect(proxyPasswordSecretKey("s1", { ...A })).toBe(base);
    for (const other of [
      { ...A, host: "x" }, { ...A, port: 1081 }, { ...A, username: "v" }, { ...A, username: undefined },
      { type: "http" as const, host: A.host, port: A.port, username: A.username }
    ]) {
      expect(proxyPasswordSecretKey("s1", other)).not.toBe(base);
    }
    expect(proxyPasswordSecretKey("s2", A)).not.toBe(base);
    expect(base).not.toBe(legacyProxyPasswordSecretKey("s1"));
  });

  it("an ssh jump proxy or no proxy has no password key", () => {
    expect(currentProxyPasswordSecretKey({ id: "s1", proxy: { type: "ssh", jumpHostId: "j" } })).toBeUndefined();
    expect(currentProxyPasswordSecretKey({ id: "s1", proxy: undefined })).toBeUndefined();
  });
});

describe("legacy proxy password migration ordering", () => {
  it("a target another window saved before the store is not overwritten by the legacy value", async () => {
    class RacyVault extends MemoryVault {
      async get(key: string) {
        const value = this.data.get(key);
        // Another window saves the endpoint's new password right after this window reads the legacy key.
        if (key === legacyProxyPasswordSecretKey("s1")) {
          this.data.set(proxyPasswordSecretKey("s1", A), "newer-from-other-window");
        }
        return value;
      }
    }
    const vault = new RacyVault();
    vault.data.set(legacyProxyPasswordSecretKey("s1"), "legacy-pw");
    await migrateLegacyProxyPasswords(vault, [server()]);
    expect(vault.data.get(proxyPasswordSecretKey("s1", A))).toBe("newer-from-other-window");
  });

  it("the legacy key is deleted only after the store resolved, and only if it still holds what was migrated", async () => {
    const order: string[] = [];
    class TracingVault extends MemoryVault {
      async store(key: string, value: string) { await Promise.resolve(); order.push("store"); await super.store(key, value); }
      async delete(key: string) { order.push("delete"); await super.delete(key); }
    }
    const vault = new TracingVault();
    vault.data.set(legacyProxyPasswordSecretKey("s1"), "legacy-pw");
    await migrateLegacyProxyPasswords(vault, [server()]);
    expect(order).toEqual(["store", "delete"]);

    // An older window rewrites the legacy key while the store is in flight: it is not destroyed.
    class RewritingVault extends MemoryVault {
      async store(key: string, value: string) {
        await super.store(key, value);
        this.data.set(legacyProxyPasswordSecretKey("s1"), "rewritten-by-older-window");
      }
    }
    const other = new RewritingVault();
    other.data.set(legacyProxyPasswordSecretKey("s1"), "legacy-pw");
    await migrateLegacyProxyPasswords(other, [server()]);
    expect(other.data.get(legacyProxyPasswordSecretKey("s1"))).toBe("rewritten-by-older-window");
  });
});

describe("legacy proxy password migration", () => {
  it("moves the legacy value to the server's CURRENT endpoint key and deletes the legacy key", async () => {
    const vault = new MemoryVault();
    vault.data.set(legacyProxyPasswordSecretKey("s1"), "legacy-pw");
    await migrateLegacyProxyPasswords(vault, [server()]);
    expect(vault.data.get(proxyPasswordSecretKey("s1", A))).toBe("legacy-pw");
    expect(vault.data.has(legacyProxyPasswordSecretKey("s1"))).toBe(false);
  });

  it("is idempotent, and an existing endpoint key wins (cross-window safe): the legacy key is just deleted", async () => {
    const vault = new MemoryVault();
    vault.data.set(legacyProxyPasswordSecretKey("s1"), "legacy-pw");
    vault.data.set(proxyPasswordSecretKey("s1", A), "newer-pw");
    await migrateLegacyProxyPasswords(vault, [server()]);
    await migrateLegacyProxyPasswords(vault, [server()]);
    expect(vault.data.get(proxyPasswordSecretKey("s1", A))).toBe("newer-pw");
    expect(vault.data.has(legacyProxyPasswordSecretKey("s1"))).toBe(false);
  });

  it("leaves servers without a password-bearing proxy alone", async () => {
    const vault = new MemoryVault();
    vault.data.set(legacyProxyPasswordSecretKey("s1"), "legacy-pw");
    await migrateLegacyProxyPasswords(vault, [server({ proxy: { type: "ssh", jumpHostId: "j" } }), server({ id: "s2", proxy: undefined })]);
    expect(vault.data.get(legacyProxyPasswordSecretKey("s1"))).toBe("legacy-pw");
  });
});

describe("a pending proxy edit never exposes one endpoint's password under another", () => {
  class SlowRepo extends InMemoryConfigRepository {
    private gates: Array<() => void> = [];
    public failNext = false;
    public get release(): (() => void) | undefined {
      return this.gates.length > 0 ? () => { const g = this.gates; this.gates = []; g.forEach((r) => r()); } : undefined;
    }
    public override async saveServers(servers: ServerConfig[]): Promise<void> {
      await new Promise<void>((resolve) => { this.gates.push(resolve); });
      if (this.failNext) {
        this.failNext = false;
        throw new Error("save failed");
      }
      return super.saveServers(servers);
    }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function setup() {
    const vault = new MemoryVault();
    vault.data.set(proxyPasswordSecretKey("s1", A), "pw-A");
    const repo = new SlowRepo([server()], []);
    const core = new NexusCore(repo);
    await core.initialize();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate: () => {} }, {
      deleteEndpoint: endpointDeleter(vault)
    });
    const readForCurrent = () => vault.get(currentProxyPasswordSecretKey(core.getServer("s1")!)!);
    return { vault, repo, core, stop, readForCurrent };
  }

  it("A -> B pending, a password for B is stored, the save fails and rolls back to A: A's password is returned, B's never for A", async () => {
    const { vault, repo, core, stop, readForCurrent } = await setup();
    const original = core.getServer("s1")!;
    repo.failNext = true;
    const failing = core.addOrUpdateServer(server({ proxy: B }));
    // While tentative the server points at B: a prompt for B stores under B's own key.
    await vault.store(currentProxyPasswordSecretKey(core.getServer("s1")!)!, "pw-B");
    expect(await readForCurrent()).toBe("pw-B");
    repo.release?.();
    await expect(failing).rejects.toThrow("save failed");

    const restoring = core.addOrUpdateServer(original); // the rollback
    // Reading for the restored endpoint A finds A's own password, never B's.
    expect(await readForCurrent()).toBe("pw-A");
    repo.release?.();
    await restoring;
    await tick();
    expect(await readForCurrent()).toBe("pw-A");
    // A was never deleted; B's key is unreferenced and is cleaned up as housekeeping.
    expect(vault.deleted).not.toContain(proxyPasswordSecretKey("s1", A));
    stop();
  });

  it("A -> B with a new password in the editor save: B's is used, and A's key is cleaned up only after persistence", async () => {
    const { vault, repo, core, stop, readForCurrent } = await setup();
    const pending = core.addOrUpdateServer(server({ proxy: B }));
    await vault.store(proxyPasswordSecretKey("s1", B), "typed-for-B"); // syncProxyPasswordSecret
    expect(await readForCurrent()).toBe("typed-for-B");
    expect(vault.deleted).toEqual([]); // nothing deleted before persistence
    repo.release?.();
    await pending;
    await tick();
    expect(await readForCurrent()).toBe("typed-for-B");
    expect(vault.deleted).toEqual([proxyPasswordSecretKey("s1", A)]);
    expect(vault.data.has(proxyPasswordSecretKey("s1", A))).toBe(false);
    stop();
  });

  it("inside a server batch, an A -> B edit whose secret write then fails and rolls back to A keeps A's password", async () => {
    const { vault, repo, core, stop, readForCurrent } = await setup();
    const original = core.getServer("s1")!;
    // The editor's record + secret transaction.
    const transaction = core.runServerBatch(async () => {
      await core.addOrUpdateServer(server({ proxy: B })); // persisted before the secret write
      // ...the SecretStorage write for B rejects, so the catch restores the record:
      await core.addOrUpdateServer(original);
    });
    for (let i = 0; i < 4; i++) { repo.release?.(); await tick(); }
    await transaction;
    await tick();
    expect(await readForCurrent()).toBe("pw-A");
    expect(vault.deleted).not.toContain(proxyPasswordSecretKey("s1", A));
    stop();
  });

  it("the same edit outside a batch would have deleted A once B persisted (why the editor batches)", async () => {
    const { vault, repo, core, stop } = await setup();
    const pending = core.addOrUpdateServer(server({ proxy: B }));
    repo.release?.();
    await pending;
    await tick();
    expect(vault.deleted).toEqual([proxyPasswordSecretKey("s1", A)]);
    stop();
  });

  it("a same-window store for A queued after the pending delete of A survives it", async () => {
    const inner = new MemoryVault();
    inner.data.set(proxyPasswordSecretKey("s1", A), "pw-A");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realDelete = inner.delete.bind(inner);
    inner.delete = async (key: string) => { await gate; await realDelete(key); };
    const serialized = new KeySerializedSecretVault(inner);
    const repo = new SlowRepo([server()], []);
    const core = new NexusCore(repo);
    await core.initialize();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate: () => {} }, {
      // Not "still unused" is decided at run time; here A is genuinely left, so the delete runs.
      deleteEndpoint: (id, proxy, unused) => serialized.deleteIf(proxyPasswordSecretKey(id, proxy), unused)
    });
    const pending = core.addOrUpdateServer(server({ proxy: B }));
    repo.release?.();
    await pending;
    await tick(); // A's delete is queued and blocked on the gate
    // The user re-enters a password for A (a prompt of a server briefly on A): queued behind the delete.
    const storing = serialized.store(proxyPasswordSecretKey("s1", A), "fresh-A");
    await tick();
    release();
    await storing;
    await tick();
    expect(inner.data.get(proxyPasswordSecretKey("s1", A))).toBe("fresh-A");
    stop();
  });

  it("a queued delete whose endpoint came back into use before it runs is skipped, and the endpoint stays listed for a later persist", async () => {
    const inner = new MemoryVault();
    inner.data.set(proxyPasswordSecretKey("s1", A), "pw-A");
    // Hold the key's queue with an earlier write so the guarded delete waits.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realStore = inner.store.bind(inner);
    inner.store = async (key: string, value: string) => { await gate; await realStore(key, value); };
    const serialized = new KeySerializedSecretVault(inner);
    const repo = new SlowRepo([server()], []);
    const core = new NexusCore(repo);
    await core.initialize();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate: () => {} }, {
      deleteEndpoint: (id, proxy, unused) => serialized.deleteIf(proxyPasswordSecretKey(id, proxy), unused)
    });
    void serialized.store(proxyPasswordSecretKey("s1", A), "pw-A"); // earlier write holds the queue
    const first = core.addOrUpdateServer(server({ proxy: B }));
    repo.release?.();
    await first; // persisted on B: A's delete is now queued behind the held store
    await tick();
    // Before it runs, this window's state moves back to A (or a reload from another window reached it).
    const back = core.addOrUpdateServer(server({ proxy: A }));
    release();
    repo.release?.();
    await back;
    await tick();
    await tick();
    expect(inner.data.get(proxyPasswordSecretKey("s1", A))).toBe("pw-A");
    stop();
  });

  it("A -> B -> A before the save deletes nothing", async () => {
    const { vault, repo, core, stop, readForCurrent } = await setup();
    const original = core.getServer("s1")!;
    const first = core.addOrUpdateServer(server({ proxy: B }));
    const second = core.addOrUpdateServer(original);
    for (let i = 0; i < 2; i++) { repo.release?.(); await tick(); }
    await Promise.all([first, second]);
    expect(await readForCurrent()).toBe("pw-A");
    expect(vault.deleted).toEqual([proxyPasswordSecretKey("s1", B)]);
    stop();
  });

  it("a runtime-only change event and a failed save with no rollback delete nothing", async () => {
    const { vault, repo, core, stop } = await setup();
    repo.failNext = true;
    const failing = core.addOrUpdateServer(server({ proxy: B }));
    core.registerSession({ id: "sess", serverId: "s1", terminalName: "t", startedAt: Date.now() });
    await tick();
    repo.release?.();
    await expect(failing).rejects.toThrow("save failed");
    await tick();
    expect(vault.deleted).toEqual([]);
    expect(vault.data.get(proxyPasswordSecretKey("s1", A))).toBe("pw-A");
    stop();
  });

  it("removing a server deletes its endpoint key after the removal is persisted, not before", async () => {
    const { vault, repo, core, stop } = await setup();
    const pending = core.removeServer("s1");
    expect(vault.deleted).toEqual([]);
    repo.release?.();
    await pending;
    await tick();
    expect(vault.deleted).toEqual([proxyPasswordSecretKey("s1", A)]);
    stop();
  });

  it("a folder delete that removes servers deletes their endpoint keys after persistence", async () => {
    const vault = new MemoryVault();
    vault.data.set(proxyPasswordSecretKey("s1", A), "pw-A");
    vault.data.set(proxyPasswordSecretKey("s2", B), "pw-B");
    const repo = new SlowRepo([server({ group: "G" }), server({ id: "s2", proxy: B })], []);
    const core = new NexusCore(repo);
    await core.initialize();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate: () => {} }, {
      deleteEndpoint: endpointDeleter(vault)
    });
    const pending = core.removeFolderCascade("G", true);
    expect(vault.deleted).toEqual([]);
    for (let i = 0; i < 2; i++) { repo.release?.(); await tick(); }
    await pending;
    await tick();
    expect(vault.deleted).toEqual([proxyPasswordSecretKey("s1", A)]);
    expect(vault.data.get(proxyPasswordSecretKey("s2", B))).toBe("pw-B");
    stop();
  });

  it("inside a batch (Replace), a removed server re-created on the same endpoint keeps its key; on another endpoint the old key is deleted", async () => {
    const vault = new MemoryVault();
    vault.data.set(proxyPasswordSecretKey("s1", A), "pw-A");
    vault.data.set(proxyPasswordSecretKey("s2", A), "pw-A2");
    const repo = new SlowRepo([server(), server({ id: "s2" })], []);
    const core = new NexusCore(repo);
    await core.initialize();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate: () => {} }, {
      deleteEndpoint: endpointDeleter(vault)
    });
    const batch = core.runServerBatch(async () => {
      await core.removeServer("s1"); // persists the removal BEFORE the re-add
      await core.removeServer("s2");
      await core.addOrUpdateServer(server()); // same endpoint: keeps the key
      await core.addOrUpdateServer(server({ id: "s2", proxy: B })); // another endpoint: old key goes
    });
    for (let i = 0; i < 8; i++) { repo.release?.(); await tick(); }
    await batch;
    await tick();
    expect(vault.data.get(proxyPasswordSecretKey("s1", A))).toBe("pw-A");
    expect(vault.data.has(proxyPasswordSecretKey("s2", A))).toBe(false);
    expect(vault.deleted).toEqual([proxyPasswordSecretKey("s2", A)]);
    stop();
  });

  it("a batch that removes and never re-creates a server deletes its key when the batch ends", async () => {
    const { vault, repo, core, stop } = await setup();
    const batch = core.runServerBatch(async () => { await core.removeServer("s1"); });
    for (let i = 0; i < 3; i++) { repo.release?.(); await tick(); }
    await batch;
    await tick();
    expect(vault.deleted).toEqual([proxyPasswordSecretKey("s1", A)]);
    stop();
  });
});
