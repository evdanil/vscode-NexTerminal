import { describe, it, expect } from "vitest";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import type { TerminalMacro } from "../../src/models/terminalMacro";

describe("MacroStore (in-memory)", () => {
  it("returns empty array before any save", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    expect(store.getAll()).toEqual([]);
  });

  it("assigns ids to macros that lack one on save", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([{ name: "m1", text: "echo 1" }]);
    const stored = store.getAll();
    expect(stored).toHaveLength(1);
    expect(typeof stored[0].id).toBe("string");
    expect(stored[0].id!.length).toBeGreaterThan(0);
  });

  it("preserves existing ids across save", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    const macro: TerminalMacro = { id: "fixed-id", name: "m", text: "x" };
    await store.save([macro]);
    expect(store.getAll()[0].id).toBe("fixed-id");
  });

  it("fires onDidChange after save", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    let fired = 0;
    store.onDidChange(() => fired++);
    await store.save([{ name: "a", text: "b" }]);
    expect(fired).toBe(1);
  });

  it("round-trips secret text via the in-memory vault", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([{ name: "s", text: "super-secret", secret: true }]);
    const [m] = store.getAll();
    expect(m.secret).toBe(true);
    expect(m.text).toBe("super-secret"); // resolved transparently
  });
});
