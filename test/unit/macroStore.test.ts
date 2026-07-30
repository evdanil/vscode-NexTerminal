import { describe, it, expect, vi } from "vitest";

// VscodeMacroStore imports vscode for migration only; the tests with
// { runLegacyMigration: false } never touch these stubs.
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      inspect: vi.fn(() => ({})),
      update: vi.fn()
    }))
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
}));

import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { VscodeMacroStore } from "../../src/storage/vscodeMacroStore";
import { assignUniqueMacroIds, isValidMacroId } from "../../src/storage/macroStore";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { macroGroup } from "../../src/services/macroFolders";

function makeFakeContext() {
  const stateBag = new Map<string, unknown>();
  const secretBag = new Map<string, string>();
  return {
    context: {
      globalState: {
        get<T>(key: string, fallback: T): T {
          return (stateBag.get(key) as T) ?? fallback;
        },
        async update(key: string, value: unknown): Promise<void> {
          if (value === undefined) stateBag.delete(key);
          else stateBag.set(key, value);
        },
        keys(): readonly string[] {
          return [...stateBag.keys()];
        }
      },
      secrets: {
        async get(key: string): Promise<string | undefined> {
          return secretBag.get(key);
        },
        async store(key: string, value: string): Promise<void> {
          secretBag.set(key, value);
        },
        async delete(key: string): Promise<void> {
          secretBag.delete(key);
        }
      }
    } as unknown as import("vscode").ExtensionContext,
    stateBag,
    secretBag
  };
}

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

  it("reassigns a fresh id to a later duplicate on save (Fix 1 — unique-id invariant)", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([
      { id: "duplicate", name: "Password", text: "hunter2\n" },
      { id: "duplicate", name: "Poll", text: "show status\n" }
    ]);
    const [first, second] = store.getAll();
    expect(first.id).toBe("duplicate");
    expect(second.id).toBeDefined();
    expect(second.id).not.toBe("duplicate");
    expect(second.id!.length).toBeGreaterThan(0);
  });

  it("treats an explicit empty-string id as missing, not as a real id (Fix 5)", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([{ id: "", name: "m", text: "x" }]);
    const [m] = store.getAll();
    expect(m.id).toBeTruthy();
    expect(m.id).not.toBe("");
  });

  it("Fix 1 (BLOCKER) — drops a record with no name/text rather than persisting a ghost macro", async () => {
    // Reproduces the exact shape a stale-index write produces:
    // `{ ...updated[idx] }` where `updated[idx]` is `undefined` yields `{}`.
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([
      { name: "Good", text: "t" },
      {} as unknown as TerminalMacro
    ]);
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Good");
  });

  it("Fix 1 — drops a record whose name or text is non-string", async () => {
    const store = new InMemoryMacroStore();
    await store.initialize();
    await store.save([
      { name: "Good", text: "t" },
      { name: 42, text: "t" } as unknown as TerminalMacro,
      { name: "NoText", text: undefined } as unknown as TerminalMacro
    ]);
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Good");
  });

  describe("group ingest contract matches VscodeMacroStore's exactly", () => {
    it("canonicalizes an empty-string group to undefined (§4.1 — it holds no path)", async () => {
      const store = new InMemoryMacroStore();
      await store.initialize();
      await store.save([{ name: "m", text: "t", group: "" }]);
      expect(store.getAll()[0].group).toBeUndefined();
    });

    it("drops a non-string group — it cannot be a path, so nothing is destroyed", async () => {
      const store = new InMemoryMacroStore();
      await store.initialize();
      await store.save([{ name: "m", text: "t", group: { nope: true } } as unknown as TerminalMacro]);
      expect(store.getAll()[0].group).toBeUndefined();
    });

    it("PRESERVES an unrenderable group string rather than deleting the assignment", async () => {
      // `save()` rewrites the WHOLE array, so running the folder-path grammar
      // here deleted the stored group of macros the caller never touched.
      // Macro "Other" is the victim: the user is only editing "Edited".
      const store = new InMemoryMacroStore();
      await store.initialize();
      await store.save([
        { name: "Edited", text: "t", group: "Cisco" },
        { name: "Other", text: "t", group: "Cisco\\Routers" }
      ]);
      expect(store.getAll()[1].group).toBe("Cisco\\Routers");
    });

    it("keeps a valid group untouched", async () => {
      const store = new InMemoryMacroStore();
      await store.initialize();
      await store.save([{ name: "m", text: "t", group: "Cisco/Routers" }]);
      expect(store.getAll()[0].group).toBe("Cisco/Routers");
    });
  });
});

describe("VscodeMacroStore", () => {
  it("persists non-secret fields to globalState, secret text to vault", async () => {
    const { context, stateBag, secretBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([
      { id: "a", name: "m1", text: "plain", secret: false },
      { id: "b", name: "m2", text: "classified", secret: true }
    ]);

    const persisted = stateBag.get("nexus.macros") as TerminalMacro[];
    expect(persisted).toHaveLength(2);
    expect(persisted[0].text).toBe("plain");
    expect(persisted[1].text).toBe(""); // secret text stripped on disk
    expect(secretBag.get("macro-secret-text-b")).toBe("classified");
    expect(secretBag.has("macro-secret-text-a")).toBe(false);
  });

  it("preserves declared variables on a macro-level-secret macro across the vault split (§7.4)", async () => {
    const { context, stateBag, secretBag } = makeFakeContext();
    const declaredVariables = [
      { name: "host", label: "Host" },
      { name: "username", label: "Username" },
      { name: "password", label: "Password", secret: true }
    ];

    const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store1.initialize();
    await store1.save([
      {
        id: "b",
        name: "IPMI SOL console",
        text: " ipmitool -I lanplus -H $host -U $username -P $password sol activate\n",
        secret: true,
        variables: declaredVariables
      }
    ]);

    // The vault split strips `text` from the on-disk record — it must never
    // strip the variable declarations sitting alongside it.
    const persisted = stateBag.get("nexus.macros") as TerminalMacro[];
    expect(persisted[0].text).toBe("");
    expect(persisted[0].variables).toEqual(declaredVariables);
    expect(secretBag.get("macro-secret-text-b")).toContain("ipmitool");

    const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store2.initialize();
    const [m] = store2.getAll();
    expect(m.text).toContain("ipmitool");
    expect(m.variables).toEqual(declaredVariables);
  });

  it("resolves secret text on reload", async () => {
    const { context } = makeFakeContext();
    const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store1.initialize();
    await store1.save([{ id: "b", name: "m2", text: "classified", secret: true }]);

    const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store2.initialize();
    const [m] = store2.getAll();
    expect(m.text).toBe("classified");
  });

  it("deletes vault entries when a secret macro is removed", async () => {
    const { context, secretBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([{ id: "b", name: "m2", text: "classified", secret: true }]);
    expect(secretBag.has("macro-secret-text-b")).toBe(true);
    await store.save([]);
    expect(secretBag.has("macro-secret-text-b")).toBe(false);
  });

  it("deletes vault entries when a macro flips from secret to non-secret", async () => {
    const { context, secretBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([{ id: "b", name: "m2", text: "classified", secret: true }]);
    await store.save([{ id: "b", name: "m2", text: "now-public", secret: false }]);
    expect(secretBag.has("macro-secret-text-b")).toBe(false);
    expect(store.getAll()[0].text).toBe("now-public");
  });

  it("clearAll removes both globalState and all secret vault entries", async () => {
    const { context, stateBag, secretBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([{ id: "b", name: "m2", text: "classified", secret: true }]);
    await store.clearAll();
    expect(stateBag.has("nexus.macros")).toBe(false);
    expect(secretBag.has("macro-secret-text-b")).toBe(false);
  });

  it("clearAll order: MACROS_KEY first, then vault entries, then SECRET_IDS_KEY", async () => {
    const { context } = makeFakeContext();
    const ops: string[] = [];
    const origUpdate = context.globalState.update.bind(context.globalState);
    context.globalState.update = async (k: string, v: unknown) => {
      if (k === "nexus.macros" && v === undefined) ops.push("state");
      if (k === "nexus.macros.secretIds" && v === undefined) ops.push("secretIds");
      return origUpdate(k, v);
    };
    const origDelete = context.secrets.delete.bind(context.secrets);
    context.secrets.delete = async (k: string) => {
      if (k.startsWith("macro-secret-text-")) ops.push("secret");
      return origDelete(k);
    };

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([{ id: "x", name: "s", text: "v", secret: true }]);
    ops.length = 0;
    await store.clearAll();
    expect(ops[0]).toBe("state");
    expect(ops[1]).toBe("secret");
    expect(ops[ops.length - 1]).toBe("secretIds");
  });

  it("clearAll sweeps an orphan vault entry the index knows about but `resolved` does not", async () => {
    const { context, secretBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([{ id: "live", name: "m", text: "v", secret: true }]);

    // Simulate orphan from a crash: index has an extra id, vault has a stale entry
    const index = [...(context.globalState.get<string[]>("nexus.macros.secretIds", []))];
    index.push("orphan");
    await context.globalState.update("nexus.macros.secretIds", index);
    await context.secrets.store("macro-secret-text-orphan", "zombie");

    await store.clearAll();
    expect(secretBag.has("macro-secret-text-live")).toBe(false);
    expect(secretBag.has("macro-secret-text-orphan")).toBe(false);
  });

  describe("secret-id ledger — the orphan list clearAll depends on", () => {
    // The test above seeds the index by hand, so it only proves clearAll READS the
    // index; it says nothing about whether the index still holds anything by the time
    // clearAll runs. Every real clearAll is preceded by an initialize(), so these
    // exercise the maintenance path instead.

    it("survives a reload that no longer sees the macro — this is what makes clearAll's vault-first/index-last order mean anything", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store1.initialize();
      await store1.save([{ id: "s", name: "Password", text: "hunter2", secret: true }]);
      expect(secretBag.get("macro-secret-text-s")).toBe("hunter2");

      // MACROS_KEY is lost — a partial write, a corrupt value degraded to [], or
      // another window's Complete Reset landing between the vault write and the state
      // write. The vault entry is still there and only the ledger can still name it.
      stateBag.delete("nexus.macros");

      const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store2.initialize();
      expect(store2.getAll()).toEqual([]);

      // A reload that REBUILT the index from what it just read would have wiped the
      // only remaining reference to this vault entry, stranding the secret forever.
      await store2.clearAll();
      expect(secretBag.has("macro-secret-text-s")).toBe(false);
    });

    it("drops an id whose vault entry save() just deleted, so the ledger cannot grow without bound", async () => {
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([{ id: "s", name: "m", text: "classified", secret: true }]);
      expect(context.globalState.get<string[]>("nexus.macros.secretIds", [])).toEqual(["s"]);

      // Flip to non-secret: save() deletes the vault entry, so the ledger must forget it.
      await store.save([{ id: "s", name: "m", text: "now-public", secret: false }]);
      expect(secretBag.has("macro-secret-text-s")).toBe(false);
      expect(context.globalState.get<string[]>("nexus.macros.secretIds", [])).toEqual([]);

      // And likewise when the macro is removed outright.
      await store.save([{ id: "t", name: "n", text: "classified", secret: true }]);
      await store.save([]);
      expect(context.globalState.get<string[]>("nexus.macros.secretIds", [])).toEqual([]);
    });

    it("never lists an id that exists only in memory — a runtime-only UUID has no vault entry to sweep", async () => {
      const { context, stateBag } = makeFakeContext();
      // A secret record with no id at all: reloadFromState() mints a runtime UUID for
      // it so the rest of the app can key off `macro.id`, but that UUID was never a
      // vault key, so indexing it would describe an entry that cannot exist.
      stateBag.set("nexus.macros", [{ name: "Password", text: "", secret: true }]);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const runtimeId = store.getAll()[0].id!;
      expect(runtimeId).toBeTruthy();
      expect(context.globalState.get<string[]>("nexus.macros.secretIds", [])).not.toContain(runtimeId);
    });
  });

  describe("unique-id invariant — enforced on save(), never on load", () => {
    it("reassigns a fresh id to a later duplicate, and each secret macro keeps its own vault entry", async () => {
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      // The exact triggering input from the review: a replace-mode backup import
      // saving two macros with the same id verbatim, one of them secret.
      await store.save([
        {
          id: "duplicate",
          name: "Password",
          text: "hunter2\n",
          secret: true,
          triggerPattern: "Password:",
          triggerInitiallyDisabled: true
        },
        {
          id: "duplicate",
          name: "Poll",
          text: "show status\n",
          triggerPattern: "router#"
        }
      ]);

      const [password, poll] = store.getAll();
      expect(password.id).toBe("duplicate");
      expect(poll.id).toBeDefined();
      expect(poll.id).not.toBe("duplicate");

      // The secret macro's text must resolve correctly under its own id...
      expect(password.text).toBe("hunter2\n");
      expect(secretBag.get("macro-secret-text-duplicate")).toBe("hunter2\n");
      // ...and the reassigned macro must not have clobbered or inherited it.
      expect(poll.text).toBe("show status\n");
      expect(secretBag.has(`macro-secret-text-${poll.id}`)).toBe(false);
    });

    it("dedup runs before the vault write loop: two SECRET macros sharing an id each get a distinct, non-colliding vault entry", async () => {
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      await store.save([
        { id: "dup", name: "First", text: "first-secret", secret: true },
        { id: "dup", name: "Second", text: "second-secret", secret: true }
      ]);

      const [first, second] = store.getAll();
      expect(first.id).toBe("dup");
      expect(second.id).not.toBe("dup");
      expect(first.text).toBe("first-secret");
      expect(second.text).toBe("second-secret");
      expect(secretBag.get("macro-secret-text-dup")).toBe("first-secret");
      expect(secretBag.get(`macro-secret-text-${second.id}`)).toBe("second-secret");
    });

    it("treats an explicit empty-string id as missing on save", async () => {
      const { context } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([{ id: "", name: "m", text: "x" }]);
      const [m] = store.getAll();
      expect(m.id).toBeTruthy();
      expect(m.id).not.toBe("");
    });

    it("save() dedup is loss-free with the secret SECOND: the value moves to the fresh key and the shared key is not left holding it", async () => {
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      // Mirror of the test above with the ordering reversed, so neither test can be
      // satisfied by a rule that happens to favour whichever claimant sorts first.
      await store.save([
        { id: "dup", name: "Poll", text: "show status\n" },
        { id: "dup", name: "Password", text: "hunter2\n", secret: true }
      ]);

      const [poll, password] = store.getAll();
      expect(poll.id).toBe("dup");
      expect(password.id).not.toBe("dup");
      expect(password.text).toBe("hunter2\n");
      // The non-secret claimant kept "dup", and save() clears the vault entry for a
      // non-secret macro — so the secret must have landed under its own fresh key.
      expect(secretBag.get(`macro-secret-text-${password.id}`)).toBe("hunter2\n");
      expect(secretBag.has("macro-secret-text-dup")).toBe(false);
    });

    it("reloadFromState() leaves a duplicate id EXACTLY as found — no re-key in memory, no rewrite on disk, no vault write", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      // Two secret macros sharing an id, from before the invariant existed. The single
      // vault entry may belong to either (duplicate secret saves were last-write-wins),
      // so there is nothing to repair here that is not a guess. Load must not guess:
      // ambiguity is resolved fail-safe by MacroAutoTrigger, which compiles no rule for
      // either of them (see macroAutoTrigger.test.ts).
      const seeded = [
        { id: "dup", name: "Password A", text: "", secret: true },
        { id: "dup", name: "Password B", text: "", secret: true }
      ];
      stateBag.set("nexus.macros", seeded);
      secretBag.set("macro-secret-text-dup", "password-b-secret\n");

      const macrosKeyWrites: unknown[] = [];
      const origUpdate = context.globalState.update.bind(context.globalState);
      context.globalState.update = async (k: string, v: unknown) => {
        if (k === "nexus.macros") macrosKeyWrites.push(v);
        return origUpdate(k, v);
      };
      const vaultWrites: string[] = [];
      const origStore = context.secrets.store.bind(context.secrets);
      const origDelete = context.secrets.delete.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => { vaultWrites.push(`store:${k}`); return origStore(k, v); };
      context.secrets.delete = async (k: string) => { vaultWrites.push(`delete:${k}`); return origDelete(k); };

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      // In memory: both keep the id they were stored with.
      const [a, b] = store.getAll();
      expect(a.id).toBe("dup");
      expect(b.id).toBe("dup");

      // On disk: byte-identical, and MACROS_KEY was never written at all.
      expect(macrosKeyWrites).toHaveLength(0);
      expect(stateBag.get("nexus.macros")).toBe(seeded);

      // The vault is read-only on this path. Deleting the ambiguous entry would destroy
      // the only copy of whichever macro's secret it really is.
      expect(vaultWrites).toEqual([]);
      expect(secretBag.get("macro-secret-text-dup")).toBe("password-b-secret\n");
    });

    it("the remedy for a pre-existing duplicate is a save(): it re-keys and each twin's OWN value lands under its own key", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      stateBag.set("nexus.macros", [
        { id: "dup", name: "Password A", text: "", secret: true },
        { id: "dup", name: "Password B", text: "", secret: true }
      ]);
      secretBag.set("macro-secret-text-dup", "shared-secret\n");

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      // Both twins resolve to the SAME vault value at load, so a save of the list
      // unchanged cannot tell a correct re-key apart from one that cross-wires the two
      // values — every assertion would hold either way. Give them different values first,
      // which is also what the real remedy looks like: the user opens the macro that is
      // actually wrong and corrects it.
      const loaded = store.getAll();
      expect(loaded.map((m) => m.text)).toEqual(["shared-secret\n", "shared-secret\n"]);
      loaded[1].text = "b-only-secret\n";

      // Saving the full list is exactly what macroCommands.ts / macroEditorPanel.ts do.
      await store.save(loaded);

      const [a, b] = store.getAll();
      expect(a.id).not.toBe(b.id);
      // Each id names the value of the macro that carries it — not the other one, and not
      // whichever the loop happened to write last.
      expect(secretBag.get(`macro-secret-text-${a.id}`)).toBe("shared-secret\n");
      expect(secretBag.get(`macro-secret-text-${b.id}`)).toBe("b-only-secret\n");
      expect(a.text).toBe("shared-secret\n");
      expect(b.text).toBe("b-only-secret\n");

      // And it converges: a fresh store instance reading the repaired state sees the
      // same unique ids, and each resolves its own secret back.
      const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store2.initialize();
      expect(store2.getAll().map((m) => m.id)).toEqual([a.id, b.id]);
      expect(store2.getAll().map((m) => m.text)).toEqual(["shared-secret\n", "b-only-secret\n"]);
    });
  });

  describe("legacy slot migration — a read-time normalization, never an activation write", () => {
    /** Records every storage mutation so "nothing was written" is a real assertion. */
    function recordWrites(context: import("vscode").ExtensionContext): string[] {
      const writes: string[] = [];
      const origUpdate = context.globalState.update.bind(context.globalState);
      context.globalState.update = async (k: string, v: unknown) => {
        writes.push(`state:${k}`);
        return origUpdate(k, v);
      };
      const origStore = context.secrets.store.bind(context.secrets);
      const origDelete = context.secrets.delete.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => {
        writes.push(`store:${k}`);
        return origStore(k, v);
      };
      context.secrets.delete = async (k: string) => {
        writes.push(`delete:${k}`);
        return origDelete(k);
      };
      return writes;
    }

    it("resolves `slot` to `keybinding` in memory, leaves the stored record alone, and writes nothing at all", async () => {
      const { context, stateBag } = makeFakeContext();
      const seeded = [
        { id: "a", name: "Slot macro", text: "x", slot: 3 },
        // Both fields set: the explicit keybinding already wins everywhere, so `slot` is
        // deliberately left in place — that shape is what keeps the `nexus.macro.slot`
        // back-compat command's `m.slot === targetSlot` fallback meaningful.
        { id: "b", name: "Bound macro", text: "y", slot: 4, keybinding: "alt+m" }
      ];
      stateBag.set("nexus.macros", seeded);
      const writes = recordWrites(context);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const [a, b] = store.getAll();
      expect(a.keybinding).toBe("alt+3");
      expect(a.slot).toBeUndefined();
      expect(b.keybinding).toBe("alt+m");
      expect(b.slot).toBe(4);

      // The whole point: no write. The routine this replaced (`migrateMacroSlots()` in
      // macroCommands.ts, called from activate()) rewrote the field and then saved the
      // list — which made MacroStore.save(), the only place that re-keys duplicate ids,
      // reachable at startup.
      expect(writes).toEqual([]);
      expect(stateBag.get("nexus.macros")).toBe(seeded);
    });

    it("a slot-era duplicate-id secret pair still shares its id after initialize() — startup does not re-key it, and nothing is left to trigger a migration save", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      // The reachable case: legacy settings absorption copies slot-era records in
      // verbatim, so the first startup after that has BOTH a duplicate id pair and a
      // pending slot migration. Re-keying here would hand both twins a unique id, which
      // makes MacroAutoTrigger compile BOTH rules — and the vault holds one password for
      // the two of them, so macro A would auto-send macro B's.
      const seeded = [
        { id: "dup", name: "Password A", text: "", secret: true, slot: 1, triggerPattern: "[Pp]assword:" },
        { id: "dup", name: "Password B", text: "", secret: true, slot: 2, triggerPattern: "[Pp]assword:" }
      ];
      stateBag.set("nexus.macros", seeded);
      secretBag.set("macro-secret-text-dup", "b-password\n");
      const writes = recordWrites(context);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const all = store.getAll();
      // Still ambiguous — which is what keeps findAmbiguousMacroStateKeys() suppressing
      // both of them (see macroAutoTrigger.test.ts).
      expect(all.map((m) => m.id)).toEqual(["dup", "dup"]);
      expect(all.map((m) => m.keybinding)).toEqual(["alt+1", "alt+2"]);
      // No macro still carries a `slot`, so a migration routine of the old shape would
      // find nothing to change and could not reach save() even if one came back.
      expect(all.some((m) => m.slot !== undefined)).toBe(false);
      // MACROS_KEY untouched and the vault never written — read or delete. (The one write
      // that IS expected here is the secret-id ledger growing to name the existing
      // `macro-secret-text-dup` entry, which is `reloadFromState()` keeping Complete Reset
      // able to find it; it neither reads nor changes the secret.)
      expect(writes).not.toContain("state:nexus.macros");
      expect(writes.filter((w) => w.startsWith("store:") || w.startsWith("delete:"))).toEqual([]);
      expect(stateBag.get("nexus.macros")).toBe(seeded);
      expect(secretBag.get("macro-secret-text-dup")).toBe("b-password\n");
    });

    it("save() persists the migrated shape, so a restored slot-era backup converges on disk", async () => {
      const { context, stateBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      // configCommands.ts's replace-mode import hands save() the file's records verbatim.
      await store.save([{ id: "a", name: "Slot macro", text: "x", slot: 7 }]);

      const persisted = stateBag.get("nexus.macros") as TerminalMacro[];
      expect(persisted[0].keybinding).toBe("alt+7");
      expect(persisted[0].slot).toBeUndefined();
    });
  });

  describe("unreadable secrets — a keyring transient must not become a wipe", () => {
    it("save() leaves a secret's vault entry alone when its value could not be read", async () => {
      const { context, secretBag } = makeFakeContext();
      const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store1.initialize();
      await store1.save([
        { id: "p", name: "Password", text: "hunter2\n", secret: true },
        { id: "q", name: "Enable", text: "enable-pass\n", secret: true }
      ]);

      // The keyring goes away. `SecretStorage.get()` reports this as `undefined` — the
      // same answer it gives for "no such entry" — rather than rejecting, so every secret
      // macro resolves to "".
      context.secrets.get = async () => undefined;

      const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store2.initialize();
      expect(store2.getAll().map((m) => m.text)).toEqual(["", ""]);

      // Any save at all used to be enough — here the least destructive edit there is.
      const macros = store2.getAll();
      macros[0].name = "Password (prod)";
      await store2.save(macros);

      expect(secretBag.get("macro-secret-text-p")).toBe("hunter2\n");
      expect(secretBag.get("macro-secret-text-q")).toBe("enable-pass\n");
    });

    it("entering a new value for an unreadable secret still writes it", async () => {
      const { context, secretBag } = makeFakeContext();
      const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store1.initialize();
      await store1.save([{ id: "p", name: "Password", text: "hunter2\n", secret: true }]);

      context.secrets.get = async () => undefined;
      const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store2.initialize();

      const macros = store2.getAll();
      macros[0].text = "new-pass\n";
      await store2.save(macros);
      expect(secretBag.get("macro-secret-text-p")).toBe("new-pass\n");
    });

    it("a secret the user really did clear is still cleared — the guard keys off the failed READ, not the empty value", async () => {
      const { context, secretBag } = makeFakeContext();
      const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store1.initialize();
      await store1.save([{ id: "p", name: "Password", text: "hunter2\n", secret: true }]);

      // Read SUCCEEDS this time, so "" is a real edit and must land. A blunt "never store
      // an empty string for a secret macro" guard would pass every test above and fail
      // this one.
      const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store2.initialize();
      expect(store2.getAll()[0].text).toBe("hunter2\n");
      await store2.save([{ id: "p", name: "Password", text: "", secret: true }]);
      expect(secretBag.get("macro-secret-text-p")).toBe("");
    });
  });

  describe("vault write ordering — the crash contract clearAll() relies on", () => {
    it("names a vault key in the ledger BEFORE storing it, and deletes only after MACROS_KEY is committed", async () => {
      const { context } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([{ id: "s", name: "Password", text: "hunter2\n", secret: true }]);

      const ops: string[] = [];
      const ledgerAtStore = new Map<string, string[]>();
      const origUpdate = context.globalState.update.bind(context.globalState);
      context.globalState.update = async (k: string, v: unknown) => {
        ops.push(k === "nexus.macros" ? "state" : "ledger");
        return origUpdate(k, v);
      };
      const origStore = context.secrets.store.bind(context.secrets);
      const origDelete = context.secrets.delete.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => {
        ledgerAtStore.set(k, [...context.globalState.get<string[]>("nexus.macros.secretIds", [])]);
        ops.push(`store:${k}`);
        return origStore(k, v);
      };
      context.secrets.delete = async (k: string) => {
        ops.push(`delete:${k}`);
        return origDelete(k);
      };

      // Flip "s" to non-secret (a delete) and add a brand-new secret "t" (a store), so
      // one save exercises grow → store → MACROS_KEY → delete → shrink.
      await store.save([
        { id: "s", name: "Password", text: "now-public", secret: false },
        { id: "t", name: "Enable", text: "enable\n", secret: true }
      ]);

      // The guarantee itself: at the instant "t"'s value hit the vault, the ledger already
      // named it. A crash right there leaves an entry Complete Reset can still sweep;
      // growing the ledger afterwards would leave it named by nothing, forever.
      expect(ledgerAtStore.get("macro-secret-text-t")).toContain("t");

      const iStore = ops.indexOf("store:macro-secret-text-t");
      const iState = ops.indexOf("state");
      const iDelete = ops.indexOf("delete:macro-secret-text-s");
      expect(iStore).toBeGreaterThanOrEqual(0);
      expect(iState).toBeGreaterThan(iStore);
      expect(iDelete).toBeGreaterThan(iState);
      // The shrink is last, after the delete it describes.
      expect(ops[ops.length - 1]).toBe("ledger");
      expect(ops.lastIndexOf("ledger")).toBeGreaterThan(iDelete);
    });

    it("re-keying a duplicate stores the secret under its new key BEFORE the old key is deleted", async () => {
      const { context } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const ops: string[] = [];
      const origStore = context.secrets.store.bind(context.secrets);
      const origDelete = context.secrets.delete.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => {
        ops.push(`store:${k}`);
        return origStore(k, v);
      };
      context.secrets.delete = async (k: string) => {
        ops.push(`delete:${k}`);
        return origDelete(k);
      };

      // The non-secret twin keeps "dup" and its branch deletes that vault key; the secret
      // twin is re-keyed to a fresh id. `macro-secret-text-dup` is the only durable copy
      // of the secret's value until the fresh key holds it, so a crash between a delete
      // that ran first and the store that had not yet run would destroy it.
      await store.save([
        { id: "dup", name: "Poll", text: "show status\n" },
        { id: "dup", name: "Password", text: "hunter2\n", secret: true }
      ]);

      const [, password] = store.getAll();
      const iStore = ops.indexOf(`store:macro-secret-text-${password.id}`);
      const iDelete = ops.indexOf("delete:macro-secret-text-dup");
      expect(iStore).toBeGreaterThanOrEqual(0);
      expect(iDelete).toBeGreaterThan(iStore);
    });
  });

  describe("shared unique-id normalizer (Fix 2) — non-string ids bypass the uniqueness invariant", () => {
    it("isValidMacroId rejects a non-string id even when it has a positive .length", () => {
      expect(isValidMacroId({ length: 1 })).toBe(false);
      expect(isValidMacroId("")).toBe(false);
      expect(isValidMacroId(undefined)).toBe(false);
      expect(isValidMacroId(null)).toBe(false);
      expect(isValidMacroId("x")).toBe(true);
    });

    it("assignUniqueMacroIds() treats two DIFFERENT non-string ids of the same shape as both needing a fresh, real string id — a bare truthy/.length check would let both through unchanged and indistinguishable", () => {
      // Two SEPARATE object instances of the same shape, exactly as JSON.parse
      // would produce for `[{"id":{"length":1}}, {"id":{"length":1}}]` — a Set
      // never treats them as equal (different references), yet a bare
      // `m.id && m.id.length > 0` check accepts both as "valid" ids verbatim.
      const macros = [
        { id: { length: 1 } as unknown as string, name: "A", text: "a" },
        { id: { length: 1 } as unknown as string, name: "B", text: "b" }
      ];
      const out = assignUniqueMacroIds(macros);
      expect(typeof out[0].id).toBe("string");
      expect(typeof out[1].id).toBe("string");
      expect(out[0].id).not.toBe(out[1].id);
    });

    it("InMemoryMacroStore.save() treats a non-string id as missing, not as a valid, distinguishing id", async () => {
      const store = new InMemoryMacroStore();
      await store.initialize();
      await store.save([
        { id: { length: 1 } as unknown as string, name: "A", text: "a" },
        { id: { length: 1 } as unknown as string, name: "B", text: "b" }
      ] as TerminalMacro[]);

      const [a, b] = store.getAll();
      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
    });

    it("VscodeMacroStore.save() treats a non-string id as missing: each SECRET macro gets its own real vault entry instead of colliding on a coerced '[object Object]' key", async () => {
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      await store.save([
        { id: { length: 1 } as unknown as string, name: "A", text: "secret-a", secret: true },
        { id: { length: 1 } as unknown as string, name: "B", text: "secret-b", secret: true }
      ] as TerminalMacro[]);

      const [a, b] = store.getAll();
      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
      expect(a.text).toBe("secret-a");
      expect(b.text).toBe("secret-b");
      expect(secretBag.get(`macro-secret-text-${a.id}`)).toBe("secret-a");
      expect(secretBag.get(`macro-secret-text-${b.id}`)).toBe("secret-b");
      expect(secretBag.has("macro-secret-text-[object Object]")).toBe(false);
    });

    it("save() drops a record with no name/text rather than persisting a ghost macro (BLOCKER)", async () => {
      // Reproduces `nexus.macro.moveToFolder`'s exact failure mode: writing
      // through a stale/out-of-bounds index turns `{ ...updated[idx] }` (where
      // `updated[idx]` is `undefined`) into `{}` — a record with no `name` or
      // `text` that used to survive straight into globalState and then crash
      // the tree on `macro.text.replace(...)` (macroTreeProvider.ts).
      const { context, stateBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      await store.save([
        { id: "a", name: "Good", text: "t" },
        {} as unknown as TerminalMacro
      ]);

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe("Good");
      const persisted = stateBag.get("nexus.macros") as TerminalMacro[];
      expect(persisted).toHaveLength(1);
    });

    it("save() drops a record whose name or text is non-string", async () => {
      const { context } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      await store.save([
        { id: "a", name: "Good", text: "t" },
        { id: "b", name: 42, text: "t" } as unknown as TerminalMacro,
        { id: "c", name: "NoText", text: undefined } as unknown as TerminalMacro
      ]);

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe("Good");
    });
  });

  describe("reloadFromState() also enforces isUsableMacro — a malformed record must not reach the tree (Fix 1, this review round)", () => {
    // Prior to this fix, `isUsableMacro` was applied only by `save()`.
    // `reloadFromState()` admitted every non-null object verbatim, so a
    // record already sitting in MACROS_KEY (from a hand-edited settings.json
    // absorbed on a previous activation, storage corruption, or a caller bug
    // elsewhere) reached `getAll()` — and from there `MacroTreeItem`, where
    // `macro.text.replace(...)` throws on EVERY render, killing the Macros
    // view permanently, surviving restart, with no in-product recovery.
    it("drops a record with no name/text already sitting in MACROS_KEY, without crashing", async () => {
      const { context, stateBag } = makeFakeContext();
      stateBag.set("nexus.macros", [
        { id: "a", name: "Good", text: "t" },
        // The exact settings.json trigger from the review:
        // `{"name":"Broken","group":"Cisco"}` — no `text` at all.
        { name: "Broken", group: "Cisco" }
      ]);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await expect(store.initialize()).resolves.toBeUndefined();

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe("Good");
    });

    it("drops a record whose name or text is non-string, already sitting in MACROS_KEY", async () => {
      const { context, stateBag } = makeFakeContext();
      stateBag.set("nexus.macros", [
        { id: "a", name: "Good", text: "t" },
        { id: "b", name: 42, text: "t" },
        { id: "c", name: "NoText", text: undefined }
      ]);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe("Good");
    });
  });
});

describe("VscodeMacroStore — masked variable default sanitization at persistence chokepoints (Fix 1)", () => {
  const dirtyVariable = { name: "password", label: "Password", secret: true, default: "hunter2" };
  const sanitizedVariable = { name: "password", label: "Password", secret: true };

  it("save() strips a masked variable's plaintext default before it reaches globalState", async () => {
    const { context, stateBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([
      { id: "a", name: "Login", text: "login $password\n", variables: [dirtyVariable] }
    ]);

    const persisted = stateBag.get("nexus.macros") as TerminalMacro[];
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("hunter2");
    // The declaration itself survives — only the plaintext default is stripped.
    expect(persisted[0].variables).toEqual([sanitizedVariable]);

    expect(JSON.stringify(store.getAll())).not.toContain("hunter2");
    expect(store.getAll()[0].variables).toEqual([sanitizedVariable]);
  });

  it("reloadFromState() strips a masked variable's plaintext default already sitting in globalState from an earlier build", async () => {
    const { context, stateBag } = makeFakeContext();
    // Simulate a record persisted by a build that predates this fix — written
    // directly into globalState, bypassing save() (and therefore its sanitization)
    // entirely.
    stateBag.set("nexus.macros", [
      { id: "a", name: "Login", text: "login $password\n", variables: [dirtyVariable] }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain("hunter2");
    // The variable NAME (and other non-forbidden fields) still survive — we strip
    // the default, not the declaration.
    expect(all[0].variables).toEqual([sanitizedVariable]);
  });

  it("reloadFromState() scrubs the RAW globalState value itself, not just getAll() — plaintext must not remain on disk", async () => {
    const { context, stateBag } = makeFakeContext();
    // Same pre-fix-build scenario as above, but this time we inspect the storage
    // layer directly. A bug that redacted only the in-memory `resolved` list (and
    // skipped rewriting MACROS_KEY) would pass every getAll()-only assertion above
    // while leaving "hunter2" sitting in globalState indefinitely.
    stateBag.set("nexus.macros", [
      { id: "a", name: "Login", text: "login $password\n", variables: [dirtyVariable] }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    const rawOnDisk = stateBag.get("nexus.macros") as TerminalMacro[];
    expect(JSON.stringify(rawOnDisk)).not.toContain("hunter2");
    expect(rawOnDisk[0].variables).toEqual([sanitizedVariable]);
  });

  it("reloadFromState() does not rewrite globalState's macros entry when nothing needed redaction (no needless write)", async () => {
    const { context, stateBag } = makeFakeContext();
    const cleanMacro = { id: "a", name: "Login", text: "login\n", variables: [{ name: "host" }] };
    stateBag.set("nexus.macros", [cleanMacro]);

    const macrosKeyWrites: unknown[] = [];
    const origUpdate = context.globalState.update.bind(context.globalState);
    context.globalState.update = async (k: string, v: unknown) => {
      if (k === "nexus.macros") macrosKeyWrites.push(v);
      return origUpdate(k, v);
    };

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    expect(macrosKeyWrites).toHaveLength(0);
    expect(store.getAll()[0].variables).toEqual([{ name: "host" }]);
  });

  it("reloadFromState() scrub preserves macro-level secret text blanking on disk and leaves the vault entry untouched", async () => {
    const { context, stateBag, secretBag } = makeFakeContext();
    const realSecretText = "ipmitool -H $host -U $username -P $password sol activate\n";
    // On-disk shape for a macro-level secret macro: `text` is already blanked
    // (real text lives only in the vault) — the scrub must preserve that shape
    // while still stripping the masked variable's plaintext default.
    stateBag.set("nexus.macros", [
      { id: "a", name: "IPMI console", text: "", secret: true, variables: [dirtyVariable] }
    ]);
    secretBag.set("macro-secret-text-a", realSecretText);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    const rawOnDisk = stateBag.get("nexus.macros") as TerminalMacro[];
    expect(rawOnDisk[0].text).toBe(""); // still blanked — the scrub must not disturb this
    expect(JSON.stringify(rawOnDisk)).not.toContain("hunter2");
    expect(rawOnDisk[0].variables).toEqual([sanitizedVariable]);

    // The scrub rewrites MACROS_KEY only — it must never touch the vault.
    expect(secretBag.get("macro-secret-text-a")).toBe(realSecretText);

    // Sanity: getAll() still resolves the real secret text from the (untouched) vault.
    expect(store.getAll()[0].text).toBe(realSecretText);
    expect(store.getAll()[0].variables).toEqual([sanitizedVariable]);
  });

  it("Fix D — scrub is built from the RAW array: a null entry survives and no fresh id is injected into a record that only needed redaction", async () => {
    const { context, stateBag } = makeFakeContext();
    // Serializing the hydrated `resolved` projection instead of `raw` would turn this
    // redaction into a rewrite of records that were never the problem: `resolved`
    // drops non-object entries (the `null` here) and assigns every entry a fresh
    // UUID when it lacks one.
    const seeded = [
      null,
      { name: "Login", text: "x", variables: [dirtyVariable] }
    ];
    stateBag.set("nexus.macros", seeded);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    const rawOnDisk = stateBag.get("nexus.macros") as unknown[];
    expect(rawOnDisk).toHaveLength(2);
    expect(rawOnDisk[0]).toBeNull();
    const login = rawOnDisk[1] as TerminalMacro;
    expect(login.id).toBeUndefined();
    expect(login.name).toBe("Login");
    expect(login.text).toBe("x");
    expect(login.variables).toEqual([sanitizedVariable]);

    // getAll() still degrades the null entry away and assigns it a runtime-only id —
    // that in-memory repair is fine; it's the on-disk rewrite that must stay minimal.
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Login");
  });

  it("Fix D — skips the scrub write when globalState changed during the await on the vault (compare-and-skip race guard)", async () => {
    const { context, stateBag, secretBag } = makeFakeContext();
    // A macro-level-secret entry so reloadFromState() awaits context.secrets.get()
    // mid-loop — the exact gap between the read and the eventual scrub write.
    const original = [
      { id: "a", name: "Login", text: "", secret: true, variables: [dirtyVariable] }
    ];
    stateBag.set("nexus.macros", original);
    secretBag.set("macro-secret-text-a", "ipmitool -H $host -P $password sol activate\n");

    const newerValue = [{ id: "b", name: "SavedByAnotherWindow", text: "new" }];

    const origSecretsGet = context.secrets.get.bind(context.secrets);
    context.secrets.get = async (key: string) => {
      // Simulate another window completing a save (or a Complete Reset) during this
      // await: globalState.nexus.macros now differs from what reloadFromState
      // originally read.
      stateBag.set("nexus.macros", newerValue);
      return origSecretsGet(key);
    };

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    // The scrub must not have clobbered the newer value written mid-await.
    expect(stateBag.get("nexus.macros")).toBe(newerValue);
  });
});

describe("VscodeMacroStore corrupt globalState shape", () => {
  // A context whose globalState returns the default ONLY when the key is absent,
  // mirroring VS Code: a corrupt stored value (object/string/null/number) is
  // returned verbatim and must not crash initialize().
  function makeStrictContext(initialState: Record<string, unknown> = {}) {
    const state: Record<string, unknown> = { ...initialState };
    const secretBag = new Map<string, string>();
    return {
      globalState: {
        get<T>(key: string, fallback: T): T {
          return (key in state ? state[key] : fallback) as T;
        },
        async update(key: string, value: unknown): Promise<void> {
          if (value === undefined) delete state[key];
          else state[key] = value;
        }
      },
      secrets: {
        async get(key: string): Promise<string | undefined> {
          return secretBag.get(key);
        },
        async store(key: string, value: string): Promise<void> {
          secretBag.set(key, value);
        },
        async delete(key: string): Promise<void> {
          secretBag.delete(key);
        }
      }
    } as unknown as import("vscode").ExtensionContext;
  }

  const CORRUPT_SHAPES: Array<[string, unknown]> = [
    ["an object", { not: "array" }],
    ["a string", "corrupt"],
    ["null", null],
    ["a number", 7]
  ];

  for (const [label, shape] of CORRUPT_SHAPES) {
    it(`initialize() degrades to [] when nexus.macros is ${label}`, async () => {
      const context = makeStrictContext({ "nexus.macros": shape });
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await expect(store.initialize()).resolves.toBeUndefined();
      expect(store.getAll()).toEqual([]);
    });
  }

  it("clearAll does not throw when nexus.macros.secretIds is corrupt", async () => {
    const context = makeStrictContext({ "nexus.macros.secretIds": { bad: true } });
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await expect(store.clearAll()).resolves.toBeUndefined();
  });
});

describe("VscodeMacroStore — explicit folders (§4.1, nexus.macros.folders)", () => {
  it("saveFolders persists, getFolders reads it back", async () => {
    const { context, stateBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    await store.saveFolders(["Cisco", "Cisco/Routers"]);

    expect(store.getFolders().sort()).toEqual(["Cisco", "Cisco/Routers"]);
    expect((stateBag.get("nexus.macros.folders") as string[]).sort()).toEqual(["Cisco", "Cisco/Routers"]);
  });

  it("an explicit folder survives a reload while EMPTY (zero macros assigned) — §1.1", async () => {
    const { context } = makeFakeContext();
    const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store1.initialize();
    await store1.saveFolders(["Empty/Nested"]);

    const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store2.initialize();
    expect(store2.getFolders()).toEqual(["Empty/Nested"]);
    expect(store2.getAll()).toEqual([]); // genuinely zero macros — the folder is not derived
  });

  it("clearAll clears the explicit folder list", async () => {
    const { context, stateBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.saveFolders(["Cisco"]);

    await store.clearAll();

    expect(store.getFolders()).toEqual([]);
    expect(stateBag.has("nexus.macros.folders")).toBe(false);
  });

  it("saveFolders sanitizes untrusted input: drops non-strings, invalid paths, and dedupes", async () => {
    const { context } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    await store.saveFolders(["Cisco", 42 as unknown as string, "../bad", "Cisco"]);

    expect(store.getFolders()).toEqual(["Cisco"]);
  });

  it("a malformed folder list already sitting in globalState degrades to [] rather than throwing on initialize()", async () => {
    // `get(key, fallback)` returns the fallback only when the key is ABSENT
    // (mirrors real VS Code) — a corrupt stored value must be returned verbatim.
    const state: Record<string, unknown> = { "nexus.macros.folders": { not: "an array" } };
    const context = {
      globalState: {
        get<T>(key: string, fallback: T): T {
          return (key in state ? state[key] : fallback) as T;
        },
        async update(key: string, value: unknown): Promise<void> {
          if (value === undefined) delete state[key];
          else state[key] = value;
        }
      },
      secrets: {
        async get(): Promise<string | undefined> { return undefined; },
        async store(): Promise<void> {},
        async delete(): Promise<void> {}
      }
    } as unknown as import("vscode").ExtensionContext;
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(store.getFolders()).toEqual([]);
  });
});

describe("VscodeMacroStore — `group` is untrusted at every ingest site (§4.2)", () => {
  it("save() canonicalizes an empty-string group to undefined", async () => {
    const { context } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    await store.save([{ id: "a", name: "m", text: "t", group: "" }]);

    expect(store.getAll()[0].group).toBeUndefined();
  });

  it("save() drops a non-string group — it cannot be a path, so nothing is destroyed", async () => {
    const { context, stateBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    await store.save([{ id: "a", name: "m", text: "t", group: { nope: true } } as unknown as TerminalMacro]);

    expect(store.getAll()[0].group).toBeUndefined();
    const persisted = stateBag.get("nexus.macros") as Array<{ group?: string }>;
    expect(persisted[0].group).toBeUndefined();
  });

  it("save() PRESERVES an unrenderable group string on an untouched macro rather than deleting the assignment", async () => {
    // `save()` rewrites the WHOLE array. Running the folder-path grammar here
    // meant editing ONE macro silently deleted the stored folder of every
    // other macro whose group no longer normalizes. "Other" is the victim.
    const { context, stateBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    await store.save([
      { id: "a", name: "Edited", text: "t", group: "Cisco" },
      { id: "b", name: "Other", text: "t", group: "Cisco\\Routers" }
    ]);

    expect(store.getAll()[1].group).toBe("Cisco\\Routers");
    const persisted = stateBag.get("nexus.macros") as Array<{ group?: string }>;
    expect(persisted[1].group).toBe("Cisco\\Routers");
    // ...and it is still treated as ungrouped everywhere it is READ, which is
    // what keeps §4.2's "malformed group breaks the sidebar" hazard closed.
    expect(macroGroup(store.getAll()[1])).toBeUndefined();
  });

  it("save() keeps a valid group untouched", async () => {
    const { context } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    await store.save([{ id: "a", name: "m", text: "t", group: "Cisco/Routers" }]);

    expect(store.getAll()[0].group).toBe("Cisco/Routers");
  });

  // §4.2's concrete failure inputs, applied to a value ALREADY sitting in
  // MACROS_KEY (reloadFromState — not save()) — the untrusted-input path the
  // design calls out explicitly: "a malformed value can already be sitting in
  // MACROS_KEY". None of these may throw and break the whole macro view, and
  // — the point of this whole block — none of them may DELETE the stored
  // value: an activation is not a licence to rewrite the user's data.
  it("reloadFromState() degrades a non-string (object) group already in MACROS_KEY without crashing", async () => {
    const { context, stateBag } = makeFakeContext();
    stateBag.set("nexus.macros", [
      { id: "a", name: "m", text: "t", group: { a: 1 } }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await expect(store.initialize()).resolves.toBeUndefined();

    expect(store.getAll()[0].group).toBeUndefined();
  });

  it("reloadFromState() keeps a '..' group already sitting in MACROS_KEY, and renders it as ungrouped", async () => {
    const { context, stateBag } = makeFakeContext();
    stateBag.set("nexus.macros", [
      { id: "a", name: "m", text: "t", group: "../secrets" }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    expect(store.getAll()[0].group).toBe("../secrets");
    // The safety property §4.2 actually needs: it never renders as a `..`
    // folder, because every READ site sanitizes.
    expect(macroGroup(store.getAll()[0])).toBeUndefined();
  });

  it("reloadFromState() keeps an over-depth group already sitting in MACROS_KEY, and renders it as ungrouped", async () => {
    const { context, stateBag } = makeFakeContext();
    const deep = Array.from({ length: 200 }, () => "a").join("/");
    stateBag.set("nexus.macros", [
      { id: "a", name: "m", text: "t", group: deep }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await expect(store.initialize()).resolves.toBeUndefined();

    expect(store.getAll()[0].group).toBe(deep);
    expect(macroGroup(store.getAll()[0])).toBeUndefined();
  });

  it("a pathologically long SINGLE-SEGMENT group already in MACROS_KEY is kept on disk but never renders (depth/segment-count alone never bounds this)", async () => {
    // The over-depth test above uses 200 SHORT segments — it exercises depth
    // only. This is a single segment (segment count 1, well under
    // MAX_FOLDER_DEPTH) that is instead pathologically LONG — the original
    // repro, `group: "X".repeat(8_000_000)`. The bound that matters is at the
    // READ site: `macroGroup()` must reject it, in O(1), without splitting,
    // sorting or rendering it.
    const { context, stateBag } = makeFakeContext();
    const huge = "X".repeat(8_000_000);
    stateBag.set("nexus.macros", [
      { id: "a", name: "m", text: "t", group: huge }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await expect(store.initialize()).resolves.toBeUndefined();

    expect(macroGroup(store.getAll()[0])).toBeUndefined();
    expect(store.getAll()[0].group).toHaveLength(8_000_000);
  });

  it("reloadFromState() does NOT rewrite MACROS_KEY to strip an unrenderable group — merely activating must not destroy a folder assignment", async () => {
    // This is the inverse of what this test previously asserted. The eager
    // disk scrub exists so a masked variable's PLAINTEXT DEFAULT cannot linger
    // in globalState; a folder path is not a secret, and reusing that
    // machinery for `group` meant one activation permanently deleted the
    // user's folder with no notice and no undo.
    const { context, stateBag } = makeFakeContext();
    stateBag.set("nexus.macros", [
      { id: "a", name: "m", text: "t", group: "Cisco\\Routers" }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    const rawOnDisk = stateBag.get("nexus.macros") as Array<{ group?: string }>;
    expect(rawOnDisk[0].group).toBe("Cisco\\Routers");
  });

  it("the variables scrub still rewrites MACROS_KEY — the group change must not have disabled it", async () => {
    // Guards the other side of the same edit: `needsDiskScrub` now fires only
    // for `variables`, so prove it still fires at all.
    const { context, stateBag } = makeFakeContext();
    stateBag.set("nexus.macros", [
      {
        id: "a",
        name: "m",
        text: "t",
        group: "Cisco\\Routers",
        variables: [{ name: "pw", secret: true, default: "hunter2" }]
      }
    ]);

    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();

    const rawOnDisk = stateBag.get("nexus.macros") as Array<{ group?: string; variables?: Array<{ default?: string }> }>;
    expect(JSON.stringify(rawOnDisk)).not.toContain("hunter2");
    // ...without taking the folder assignment down with it.
    expect(rawOnDisk[0].group).toBe("Cisco\\Routers");
  });
});
