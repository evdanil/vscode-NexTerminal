import { describe, expect, it } from "vitest";
import type { SecretVault } from "../../src/services/ssh/contracts";
import { KeySerializedSecretVault } from "../../src/services/ssh/keySerializedSecretVault";

/** A vault whose store/delete calls wait for the test to open them, in call order. */
class GatedVault implements SecretVault {
  public readonly data = new Map<string, string>();
  public readonly log: string[] = [];
  public gated = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  async get(key: string) { return this.data.get(key); }
  private async gate(label: string): Promise<void> {
    this.log.push(`start:${label}`);
    if (this.gated.has(label.split(":")[0])) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  async store(key: string, value: string) { await this.gate(`store:${key}`); this.data.set(key, value); this.log.push(`end:store:${key}`); }
  async delete(key: string) { await this.gate(`delete:${key}`); this.data.delete(key); this.log.push(`end:delete:${key}`); }
  open(): void { const w = this.waiters.splice(0); w.forEach((r) => r()); }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("KeySerializedSecretVault", () => {
  it("a store queued after a pending delete of the same key runs after it and survives", async () => {
    const inner = new GatedVault();
    inner.data.set("k", "old");
    inner.gated.add("delete");
    const vault = new KeySerializedSecretVault(inner);
    const deleting = vault.delete("k");
    await tick();
    const storing = vault.store("k", "fresh");
    await tick();
    expect(inner.log).toEqual(["start:delete:k"]); // the store waits its turn
    inner.open();
    await Promise.all([deleting, storing]);
    expect(inner.data.get("k")).toBe("fresh");
    expect(inner.log).toEqual(["start:delete:k", "end:delete:k", "start:store:k", "end:store:k"]);
  });

  it("a delete queued after a store cannot overtake it", async () => {
    const inner = new GatedVault();
    inner.gated.add("store");
    const vault = new KeySerializedSecretVault(inner);
    const storing = vault.store("k", "v");
    const deleting = vault.delete("k");
    await tick();
    inner.open();
    await Promise.all([storing, deleting]);
    expect(inner.data.has("k")).toBe(false);
  });

  it("deleteIf skips when the condition no longer holds by the time it runs, and deletes when it does", async () => {
    const inner = new GatedVault();
    inner.data.set("k", "v");
    inner.gated.add("store");
    const vault = new KeySerializedSecretVault(inner);
    let unused = true;
    const storing = vault.store("k", "v2"); // earlier write holds the queue
    const guarded = vault.deleteIf("k", () => unused);
    unused = false; // the endpoint came back into use before the delete reached the front
    await tick();
    inner.open();
    await storing;
    expect(await guarded).toBe(false);
    expect(inner.data.get("k")).toBe("v2");

    unused = true;
    expect(await vault.deleteIf("k", () => unused)).toBe(true);
    expect(inner.data.has("k")).toBe(false);
  });

  it("different keys never wait for each other, and a failed write does not stall its queue", async () => {
    const inner = new GatedVault();
    inner.gated.add("delete");
    const vault = new KeySerializedSecretVault(inner);
    const slow = vault.delete("a");
    await vault.store("b", "v"); // not blocked by a's pending delete
    expect(inner.data.get("b")).toBe("v");
    inner.open();
    await slow;

    const failing = new KeySerializedSecretVault({
      get: async () => undefined,
      store: async () => { throw new Error("boom"); },
      delete: async () => undefined
    });
    await expect(failing.store("k", "v")).rejects.toThrow("boom");
    await expect(failing.delete("k")).resolves.toBeUndefined();
  });
});
