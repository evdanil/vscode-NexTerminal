import { describe, it, expect, vi } from "vitest";

// `VscodeMacroStore` imports vscode only for the legacy migration (tests with
// { runLegacyMigration: false } never touch those stubs). It deliberately touches no other
// part of the API — in particular NOT `workspace.fs`: the per-secret-id marker files it used
// to write under `globalStorageUri` are gone, replaced by `SecretStorage.keys()`. The absence
// of an `fs` stub here is therefore load-bearing rather than an omission — any re-introduction
// of a filesystem-backed ledger fails every test in this file with "Cannot read properties of
// undefined".
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
import { assignMacroIds, assignUniqueMacroIds, isValidMacroId } from "../../src/storage/macroStore";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { macroGroup } from "../../src/services/macroFolders";

/**
 * A fake `ExtensionContext` whose `SecretStorage` has `keys()`, because every host the
 * extension now runs on does: `engines.vscode` is `^1.105.0` and the API was finalized in
 * 1.105. `clearAll()` calls it unconditionally.
 */
function makeFakeContext() {
  const stateBag = new Map<string, unknown>();
  const secretBag = new Map<string, string>();
  const secrets: Record<string, unknown> = {
    async get(key: string): Promise<string | undefined> {
      return secretBag.get(key);
    },
    async store(key: string, value: string): Promise<void> {
      secretBag.set(key, value);
    },
    async delete(key: string): Promise<void> {
      secretBag.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...secretBag.keys()];
    }
  };
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
      secrets
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

  it("clearAll removes every globalState key this store has ever written — including the dead secret-id ledger — and all secret vault entries", async () => {
    const { context, stateBag, secretBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([{ id: "b", name: "m2", text: "classified", secret: true }]);

    // Seeded AFTER the save, because the save is not what has to erase it: `nexus.macros.secretIds`
    // is the ledger an earlier build maintained and this one neither reads nor writes, so the only
    // thing that can account for its absence below is `clearAll()` itself. This is what a profile
    // upgrading from 2.8.73 is still holding. The key is inert — a stale id in it can cause neither
    // a wrong deletion nor a missed sweep — but Complete Reset reports "All Nexus data has been
    // deleted", and a reset that leaves a key of Nexus's own behind has not said something true.
    stateBag.set("nexus.macros.secretIds", ["b"]);

    await store.clearAll();
    expect(stateBag.has("nexus.macros")).toBe(false);
    expect(stateBag.has("nexus.macros.secretIds")).toBe(false);
    expect(secretBag.has("macro-secret-text-b")).toBe(false);
  });

  it("clearAll order: MACROS_KEY first, then vault entries", async () => {
    const { context } = makeFakeContext();
    const ops: string[] = [];
    const origUpdate = context.globalState.update.bind(context.globalState);
    context.globalState.update = async (k: string, v: unknown) => {
      if (k === "nexus.macros" && v === undefined) ops.push("state");
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
    // MACROS_KEY goes first so a crash between the two leaves no record pointing at a value
    // that is already gone; the entries the record no longer names are found by enumeration.
    expect(ops[0]).toBe("state");
    expect(ops[1]).toBe("secret");
  });

  // The sweep must cover an entry that is in the VAULT but in neither `resolved` nor
  // `nexus.macros` — the shape a crash between `secrets.store()` and the MACROS_KEY commit
  // leaves, and the shape a build predating any of this could leave. Nothing names "orphan"
  // anywhere; only `SecretStorage.keys()` can report it.
  it("clearAll sweeps an orphan vault entry that `resolved` does not account for", async () => {
    const { context, secretBag } = makeFakeContext();
    const store = new VscodeMacroStore(context, { runLegacyMigration: false });
    await store.initialize();
    await store.save([{ id: "live", name: "m", text: "v", secret: true }]);

    await context.secrets.store("macro-secret-text-orphan", "zombie");

    await store.clearAll();
    expect(secretBag.has("macro-secret-text-live")).toBe(false);
    expect(secretBag.has("macro-secret-text-orphan")).toBe(false);
  });

  describe("Complete Reset sweeps by ENUMERATION — no list this extension had to remember to write", () => {
    it("finds a vault entry after a reload that no longer sees the macro at all", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      const store1 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store1.initialize();
      await store1.save([{ id: "s", name: "Password", text: "hunter2", secret: true }]);
      expect(secretBag.get("macro-secret-text-s")).toBe("hunter2");

      // MACROS_KEY is lost — a partial write, a corrupt value degraded to [], or another
      // window's Complete Reset landing between the vault write and the state write. The
      // vault entry is still there and NOTHING in globalState names it.
      stateBag.delete("nexus.macros");

      const store2 = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store2.initialize();
      expect(store2.getAll()).toEqual([]);
      expect([...secretBag.keys()]).toEqual(["macro-secret-text-s"]);

      // A sweep restricted to what the store can still name — `this.resolved`, which is
      // empty — leaves the secret in the OS keyring forever.
      await store2.clearAll();
      expect(secretBag.has("macro-secret-text-s")).toBe(false);
    });

    it("does not throw when SecretStorage.keys() rejects — the rest of the reset still runs", async () => {
      // A locked or unavailable OS keyring can reject rather than answer. Complete Reset has
      // vault entries of its own to delete and must get to them, so enumeration degrades to
      // "nothing extra to sweep" rather than failing the command.
      const { context, stateBag, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([{ id: "s", name: "Password", text: "hunter2\n", secret: true }]);

      (context.secrets as unknown as { keys(): Promise<string[]> }).keys = async () => {
        throw new Error("the OS keyring is unavailable");
      };

      await expect(store.clearAll()).resolves.toBeUndefined();
      expect(stateBag.has("nexus.macros")).toBe(false);
      expect(secretBag.has("macro-secret-text-s")).toBe(false);
    });

    it("serializes its own mutations: Complete Reset issued while a save is blocked on the keyring cannot interleave with it", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      // The save blocks inside `secrets.store()`, which is exactly where a real one blocks:
      // an OS keychain that needs unlocking can sit on that call for as long as the user
      // takes to answer the prompt. Complete Reset is a command like any other and can be
      // invoked in the meantime.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let gated = false;
      const origStore = context.secrets.store.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => {
        if (!gated) {
          gated = true;
          await gate;
        }
        return origStore(k, v);
      };

      const saving = store.save([{ id: "p", name: "Password", text: "hunter2\n", secret: true }]);
      const clearing = store.clearAll();
      release();
      await Promise.all([saving, clearing]);

      // Interleaved, the reset's vault deletes land between the save's `secrets.store()` and
      // its `nexus.macros` commit, and the commit then republishes `secret: true` with
      // nothing behind it. Serialized, the two run whole, in the order they were issued, and
      // the reset is what the user sees.
      expect(stateBag.has("nexus.macros")).toBe(false);
      expect(secretBag.size).toBe(0);
      // The property that must hold whatever the order: no record on disk names a vault entry
      // that is not there.
      for (const m of (stateBag.get("nexus.macros") ?? []) as TerminalMacro[]) {
        if (m.secret) expect(secretBag.has(`macro-secret-text-${m.id}`)).toBe(true);
      }
    });

    /**
     * The interleaving `runExclusive()` does NOT cover, because it is between two WINDOWS —
     * and the one no list of names could ever have swept, which is why the sweep asks the
     * vault itself instead:
     *
     *   1. windows A and B both hold secret `p`;
     *   2. B starts a stale save and blocks inside `secrets.store(p)` behind an OS keychain
     *      prompt;
     *   3. A deletes `p`, taking the vault entry;
     *   4. B's store resumes and RE-CREATES the entry, then republishes MACROS_KEY;
     *   5. A saves some other secret. Its wholesale MACROS_KEY write drops `p`.
     *
     * `p`'s value is then in the OS keyring with no macro record naming it. No ordering of
     * writes at the START of a save prevents that, because the write that unnames the entry
     * happens afterwards.
     */
    async function overlappingStaleSave(context: import("vscode").ExtensionContext): Promise<void> {
      const windowA = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowA.initialize();
      await windowA.save([{ id: "p", name: "Password", text: "hunter2\n", secret: true }]);

      const windowB = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowB.initialize();
      expect(windowB.getAll().map((m) => m.id)).toEqual(["p"]);

      // B blocks INSIDE the store for `p`, which is where a real save blocks.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let gated = false;
      const origStore = context.secrets.store.bind(context.secrets);
      (context.secrets as unknown as { store: typeof origStore }).store = async (k: string, v: string) => {
        if (!gated && k === "macro-secret-text-p") {
          gated = true;
          await gate;
        }
        return origStore(k, v);
      };

      const bSaving = windowB.save([{ id: "p", name: "Password", text: "hunter2\n", secret: true }]);
      // A deletes the macro while B sits on the prompt.
      await windowA.save([]);
      release();
      await bSaving;
      (context.secrets as unknown as { store: typeof origStore }).store = origStore;

      // A saves an unrelated secret. Its wholesale write publishes A's view, in which `p`
      // does not exist — so no macro record names `p` any more.
      await windowA.save([{ id: "q", name: "Other", text: "other\n", secret: true }]);
    }

    it("sweeps an entry a stale save in another window re-created after this one deleted it — named by no macro record at all", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      await overlappingStaleSave(context);

      // The residue, reproduced: the value is live in the keyring and `nexus.macros` names
      // only `q`.
      expect(secretBag.get("macro-secret-text-p")).toBe("hunter2\n");
      expect((stateBag.get("nexus.macros") as TerminalMacro[]).map((m) => m.id)).toEqual(["q"]);

      const later = new VscodeMacroStore(context, { runLegacyMigration: false });
      await later.initialize();
      // `p` is in neither `later.resolved` nor `nexus.macros`, so only enumeration can reach it.
      expect(later.getAll().map((m) => m.id)).toEqual(["q"]);
      await later.clearAll();

      // Both gone. Complete Reset is genuinely complete.
      expect([...secretBag.keys()]).toEqual([]);
    });

    it("the enumeration sweep touches macro secrets ONLY — server passwords and passphrases are not this store's to delete", async () => {
      // `SecretStorage` is shared by the whole extension: server passwords, key passphrases,
      // proxy credentials and auth-profile secrets live in the same namespace. Complete Reset
      // of the MACRO store must not take them, and an enumeration that swept everything it
      // could see would.
      //
      // Two things keep that true: the prefix filter in `readVaultSecretIds()`, and the fact
      // that the sweep deletes `macroSecretKey(id)` rather than the enumerated key itself. Each
      // is pinned separately, because the SURVIVING-KEYS assertion alone does not distinguish
      // them — a foreign key that slips past the filter is then looked up under
      // `macro-secret-text-<its tail>`, which does not exist, so the foreign secret survives
      // anyway. So the delete TARGETS are asserted too: dropping the filter makes the sweep
      // reach for keys derived from other subsystems' names (`passphrase-server-1` becomes
      // `macro-secret-text-1`, `authProfilePassword-ap1` becomes `macro-secret-text-d-ap1`) and
      // that shows up here even though nothing is destroyed by it.
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([{ id: "m", name: "Password", text: "hunter2\n", secret: true }]);
      secretBag.set("password-server-1", "server-pw");
      secretBag.set("passphrase-server-1", "key-pp");
      secretBag.set("authProfilePassword-ap1", "auth-pw");
      // An orphan of this store's own that nothing names, so the sweep has a reason to run.
      secretBag.set("macro-secret-text-orphan", "stranded\n");

      const deleted: string[] = [];
      const origDelete = context.secrets.delete.bind(context.secrets);
      context.secrets.delete = async (k: string) => {
        deleted.push(k);
        return origDelete(k);
      };

      await store.clearAll();

      expect([...secretBag.keys()].sort()).toEqual([
        "authProfilePassword-ap1",
        "passphrase-server-1",
        "password-server-1"
      ]);
      // Exactly the two macro keys, and nothing derived from a foreign one.
      expect(deleted.sort()).toEqual(["macro-secret-text-m", "macro-secret-text-orphan"]);
    });

    it("sweeps an entry left behind by a save whose MACROS_KEY commit failed after the value had landed", async () => {
      // The crash contract, end to end. The store lands in the vault, the commit rejects, so
      // the record never reaches `nexus.macros` OR `this.resolved`. Nothing this extension
      // wrote names that entry — the point of the deleted marker/ledger machinery was to make
      // sure something did, and enumeration makes the question moot.
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const origUpdate = context.globalState.update.bind(context.globalState);
      let failNext = true;
      (context.globalState as unknown as { update: typeof origUpdate }).update = async (
        key: string,
        value: unknown
      ) => {
        if (key === "nexus.macros" && failNext) {
          failNext = false;
          throw new Error("EPERM: globalState is not writable");
        }
        return origUpdate(key, value);
      };

      await expect(
        store.save([{ id: "s", name: "Password", text: "hunter2\n", secret: true }])
      ).rejects.toThrow(/EPERM/);
      expect(secretBag.get("macro-secret-text-s")).toBe("hunter2\n");
      expect(store.getAll()).toEqual([]);
      expect(context.globalState.get("nexus.macros", [])).toEqual([]);

      await store.clearAll();
      expect(secretBag.has("macro-secret-text-s")).toBe(false);
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
      // NOTHING was written, anywhere. This used to have to allow one write — the secret-id
      // ledger growing on every reload to name the existing `macro-secret-text-dup` entry —
      // and with that ledger gone the load path is a pure read again, which is what the
      // sibling test above asserts for the no-secrets case.
      expect(writes).toEqual([]);
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

  describe("unreadable secrets meet the duplicate-id repair — the re-key must not strand the value", () => {
    it("an outage plus a duplicate id: the unreadable secret keeps its id, the twin is re-keyed instead", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();

      // What a pre-invariant build could leave on disk: two macros sharing one id, one of
      // them the secret. `save()` is what repairs it.
      stateBag.set("nexus.macros", [
        { id: "dup", name: "Poll", text: "show status\n" },
        { id: "dup", name: "Password", text: "", secret: true }
      ]);
      secretBag.set("macro-secret-text-dup", "hunter2\n");

      // Keyring outage at activation: `get()` reports it as `undefined`.
      const realGet = context.secrets.get.bind(context.secrets);
      context.secrets.get = async () => undefined;

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      expect(store.getAll().map((m) => m.text)).toEqual(["show status\n", ""]);

      // Any save at all is enough to trigger the repair — here the least destructive edit
      // there is, applied to the OTHER macro.
      const vaultOps: string[] = [];
      const origStore = context.secrets.store.bind(context.secrets);
      const origDelete = context.secrets.delete.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => { vaultOps.push(`store:${k}`); return origStore(k, v); };
      context.secrets.delete = async (k: string) => { vaultOps.push(`delete:${k}`); return origDelete(k); };

      const macros = store.getAll();
      macros[0].name = "Poll (prod)";
      await store.save(macros);

      // The only durable copy of the password is untouched...
      expect(secretBag.get("macro-secret-text-dup")).toBe("hunter2\n");
      // ...and the surviving secret macro is still filed under the key that holds it, so
      // the value comes back when the keyring does. Preserving the entry while re-keying
      // the macro away from it would leave the password in the vault and unreachable.
      const [poll, password] = store.getAll();
      expect(password.id).toBe("dup");
      expect(poll.id).not.toBe("dup");
      // The re-keyed NON-secret twin runs an incidental vault delete on every save. It must
      // name the id that twin ended up with, never the one it arrived carrying — the id it
      // arrived with is the one holding the other macro's password.
      //
      // COVERAGE CAVEAT, recorded rather than implied. This line does NOT independently
      // discriminate today, and the round-3 commit message that introduced it should have
      // said so. Mutating the incidental delete to name `priorId` instead of the record's
      // final id — the wrong implementation it was written for — destroys the password, so
      // the `secretBag.get("macro-secret-text-dup")` assertion four lines up fails first and
      // this one is never reached. (Verified by applying exactly that mutation: the run
      // fails at the end-state assertion.) It is kept because it states the ORDERING
      // requirement in a form a reader can check, and because an end-state-only test would
      // miss a delete that happens to be a no-op for some other reason — not because it is
      // currently the thing catching anything.
      expect(vaultOps).not.toContain("delete:macro-secret-text-dup");
      // And no empty entry was minted under the re-keyed twin's fresh id.
      expect([...secretBag.keys()]).toEqual(["macro-secret-text-dup"]);

      // The property the user actually experiences: when the keyring answers again, the
      // password comes back attached to the macro that owns it.
      context.secrets.get = realGet;
      const recovered = new VscodeMacroStore(context, { runLegacyMigration: false });
      await recovered.initialize();
      const [poll2, password2] = recovered.getAll();
      expect(password2.id).toBe("dup");
      expect(password2.text).toBe("hunter2\n");
      expect(poll2.text).toBe("show status\n");
    });

    it("two unreadable secrets sharing an id: the entry survives, the loser gets no vault entry, and a NON-secret claimant standing ahead of both does not take the id", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      // The non-secret record is FIRST on purpose. With only the two secrets in the fixture,
      // "pinned records claim first" and plain "first in array order wins" pick the same
      // winner, so an implementation ignoring `keepIdIfPossible` entirely satisfied every
      // assertion. Here the two rules disagree: plain first-wins hands "dup" to Poll, whose
      // non-secret branch then deletes the entry holding the only copy of the password.
      stateBag.set("nexus.macros", [
        { id: "dup", name: "Poll", text: "show status\n" },
        { id: "dup", name: "Password A", text: "", secret: true },
        { id: "dup", name: "Password B", text: "", secret: true }
      ]);
      secretBag.set("macro-secret-text-dup", "hunter2\n");
      context.secrets.get = async () => undefined;

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const macros = store.getAll();
      macros[1].name = "Password A (prod)";
      await store.save(macros);

      expect(secretBag.get("macro-secret-text-dup")).toBe("hunter2\n");
      const [poll, a, b] = store.getAll();
      expect(a.id).toBe("dup");
      expect(poll.id).not.toBe("dup");
      expect(b.id).not.toBe("dup");
      expect(new Set([poll.id, a.id, b.id]).size).toBe(3);
      // Exactly what MacroStore.save()'s doc promises: the loser of the collision gets NO
      // entry, not an empty one. An empty entry is a value the user never set, and next
      // load it is indistinguishable from a deliberately cleared secret.
      expect(secretBag.has(`macro-secret-text-${b.id}`)).toBe(false);
      expect([...secretBag.keys()]).toEqual(["macro-secret-text-dup"]);
    });

    it("re-keys an unreadable secret normally once the user supplies a new value, storing it under the new key BEFORE nexus.macros is committed and the old key deleted", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      stateBag.set("nexus.macros", [
        { id: "dup", name: "Poll", text: "show status\n" },
        { id: "dup", name: "Password", text: "", secret: true }
      ]);
      secretBag.set("macro-secret-text-dup", "hunter2\n");
      context.secrets.get = async () => undefined;

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const ops: string[] = [];
      const origStore = context.secrets.store.bind(context.secrets);
      const origDelete = context.secrets.delete.bind(context.secrets);
      const origUpdate = context.globalState.update.bind(context.globalState);
      context.secrets.store = async (k: string, v: string) => { ops.push(`store:${k}`); return origStore(k, v); };
      context.secrets.delete = async (k: string) => { ops.push(`delete:${k}`); return origDelete(k); };
      context.globalState.update = async (k: string, v: unknown) => {
        if (k === "nexus.macros") ops.push("commit");
        return origUpdate(k, v);
      };

      const macros = store.getAll();
      macros[1].text = "new-pass\n";
      await store.save(macros);

      // A value the user just typed CAN travel, so array order decides the id as usual and
      // the new value lands under the new key.
      const [poll, password] = store.getAll();
      expect(poll.id).toBe("dup");
      expect(password.id).not.toBe("dup");
      expect(secretBag.get(`macro-secret-text-${password.id}`)).toBe("new-pass\n");
      expect(secretBag.has("macro-secret-text-dup")).toBe(false);

      // Order, not just the end state — and all THREE points of it, because the commit is
      // what makes the delete safe rather than merely late. Until the fresh key holds a
      // value there is exactly one durable copy of anything on this macro and it is under
      // "dup", so a delete ahead of the store leaves a crash right there with neither; and a
      // delete ahead of the commit leaves `nexus.macros` still naming "dup" with nothing
      // behind it. `store → delete → commit` satisfies the first and fails the second, and
      // every end-state assertion above holds for all three orderings.
      const iStore = ops.indexOf(`store:macro-secret-text-${password.id}`);
      const iCommit = ops.indexOf("commit");
      const iDelete = ops.indexOf("delete:macro-secret-text-dup");
      expect(iStore).toBeGreaterThanOrEqual(0);
      expect(iCommit).toBeGreaterThan(iStore);
      expect(iDelete).toBeGreaterThan(iCommit);
    });

    it("the pin keys off the failed READ, not off the empty value: in ONE save an unreadable secret keeps its id and a genuinely empty one does not", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      // Two contested ids in one stored list. "e" holds a secret that really is empty and
      // reads back fine; "u" holds a real password the keyring refuses to hand over. A
      // negative control on its own is satisfied by an implementation with no pinning at all,
      // so the positive case is put in the same save: the two halves cannot both pass unless
      // the decision is made per record, on whether that record's READ failed.
      //
      // The order of the two groups is deliberate. The group that NEEDS the pin is the
      // SECOND one, so an implementation that resolves only the first contested id it sees
      // and then falls back to plain array order — which is what a fixture with one contested
      // group, or with the pinned group first, cannot distinguish from a correct one — hands
      // "u" to the plain twin and deletes the password.
      stateBag.set("nexus.macros", [
        { id: "e", name: "Poll", text: "show status\n" },
        { id: "e", name: "Empty password", text: "", secret: true },
        { id: "u", name: "Plain twin", text: "show status\n" },
        { id: "u", name: "Unreadable", text: "", secret: true }
      ]);
      secretBag.set("macro-secret-text-u", "keyring-value\n");
      secretBag.set("macro-secret-text-e", "");

      const realGet = context.secrets.get.bind(context.secrets);
      context.secrets.get = async (key: string) =>
        key === "macro-secret-text-u" ? undefined : realGet(key);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      expect(store.getAll().map((m) => m.text)).toEqual([
        "show status\n",
        "",
        "show status\n",
        ""
      ]);

      const macros = store.getAll();
      macros[0].name = "Poll (prod)";
      await store.save(macros);

      const [poll, empty, plainTwin, unreadable] = store.getAll();
      // "e": nothing failed to read, so array order decides as usual and the empty value
      // travels to the re-keyed record's own key.
      expect(poll.id).toBe("e");
      expect(empty.id).not.toBe("e");
      expect(secretBag.get(`macro-secret-text-${empty.id}`)).toBe("");
      expect(secretBag.has("macro-secret-text-e")).toBe(false);
      // "u", the second contested group: the pin beats array order, and the password behind
      // the key is untouched.
      expect(unreadable.id).toBe("u");
      expect(plainTwin.id).not.toBe("u");
      expect(secretBag.get("macro-secret-text-u")).toBe("keyring-value\n");
    });
  });

  describe("cross-window secret writes — a save publishes this window's whole view", () => {
    it("republishes every secret it holds, so a deleted entry comes back whole — and, as the documented cost, another window's newer value is reverted with the rest of that window's edits", async () => {
      const { context, secretBag } = makeFakeContext();
      const seed = new VscodeMacroStore(context, { runLegacyMigration: false });
      await seed.initialize();
      await seed.save([
        { id: "p", name: "Password", text: "old\n", secret: true },
        { id: "r", name: "Poll", text: "show status\n" }
      ]);

      // Two windows open the same state.
      const windowA = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowA.initialize();
      const windowB = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowB.initialize();
      expect(windowB.getAll()[0].text).toBe("old\n");

      // Part 1 — the TRADE, asserted rather than left implicit. A changes the password. B,
      // still holding "old", edits something else and saves; B's wholesale MACROS_KEY write
      // already reverts A's rename, and its vault write now reverts A's password with it.
      //
      // Two earlier revisions tried to keep A's value here by not rewriting a secret B had not
      // changed — first unconditionally, then after reading the key back and restoring it only
      // when it had gone. Both published a MIXTURE of the two windows' views, and the second
      // could not even be correct in principle: `SecretStorage` has no compare-and-swap, so the
      // read-back is separated from the commit it guards by every remaining await in `save()`,
      // and a delete landing in that gap produces exactly the torn record it was meant to
      // prevent (see part 2 for what "torn" costs). The rule shipped instead is one sentence
      // long: a save publishes this window's whole view. This assertion is what pins it — the
      // read-back implementation leaves "new\n" here and fails.
      const a = windowA.getAll();
      a[0].text = "new\n";
      await windowA.save(a);
      expect(secretBag.get("macro-secret-text-p")).toBe("new\n");

      const b = windowB.getAll();
      b[1].name = "Poll (prod)";
      await windowB.save(b);

      expect(secretBag.get("macro-secret-text-p")).toBe("old\n");
      // ...and the rest of B's view landed too, which is what makes it a coherent revert
      // rather than a stray write: A's rename is gone by the same wholesale rule.
      expect((context.globalState.get("nexus.macros", []) as TerminalMacro[])[1].name).toBe("Poll (prod)");

      // Part 2 — what the trade BUYS. A deletes the macro, taking its vault entry with it. B
      // still holds the old list, so B's next save republishes the record through the same
      // wholesale MACROS_KEY write. Because B writes every secret it holds, the record it
      // republishes is whole. Skipping the write would leave `secret: true` on disk with no
      // value behind it — an empty secret at the next load, reported to nobody, which is
      // neither what A's user asked for nor what B's did.
      const a2 = windowA.getAll().filter((m) => m.id !== "p");
      await windowA.save(a2);
      expect(secretBag.has("macro-secret-text-p")).toBe(false);

      const b2 = windowB.getAll();
      b2[1].name = "Poll (prod 2)";
      await windowB.save(b2);

      const persisted = context.globalState.get("nexus.macros", []) as TerminalMacro[];
      expect(persisted.find((m) => m.id === "p")?.secret).toBe(true);
      expect(secretBag.get("macro-secret-text-p")).toBe("old\n");

      const reloaded = new VscodeMacroStore(context, { runLegacyMigration: false });
      await reloaded.initialize();
      expect(reloaded.getAll().find((m) => m.id === "p")?.text).toBe("old\n");

      // Part 3 — the republished entry stays SWEEPABLE even once no macro record names it.
      // A, whose view no longer contains "p", saves a secret of its own; its wholesale
      // MACROS_KEY write drops "p" again while B's republished vault entry stays behind. This
      // is the residue the deleted marker files existed to name, and Complete Reset reaches it
      // now because it asks `SecretStorage` rather than a list of names.
      await windowA.save([...windowA.getAll(), { id: "q", name: "Enable", text: "enable\n", secret: true }]);

      expect(secretBag.get("macro-secret-text-p")).toBe("old\n");
      expect(
        (context.globalState.get("nexus.macros", []) as TerminalMacro[]).some((m) => m.id === "p")
      ).toBe(false);

      const sweeper = new VscodeMacroStore(context, { runLegacyMigration: false });
      await sweeper.initialize();
      expect(sweeper.getAll().some((m) => m.id === "p")).toBe(false);
      await sweeper.clearAll();
      expect(secretBag.has("macro-secret-text-p")).toBe(false);
      expect(secretBag.has("macro-secret-text-q")).toBe(false);
    });

    it("restores the vault entry when another window ran Complete Reset between this window's load and its save", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      const seed = new VscodeMacroStore(context, { runLegacyMigration: false });
      await seed.initialize();
      await seed.save([
        { id: "p", name: "Password", text: "old\n", secret: true },
        { id: "r", name: "Poll", text: "show status\n" }
      ]);

      const windowA = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowA.initialize();
      const windowB = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowB.initialize();

      // A wipes everything: MACROS_KEY and every vault entry.
      await windowA.clearAll();
      expect(stateBag.has("nexus.macros")).toBe(false);
      expect(secretBag.has("macro-secret-text-p")).toBe(false);

      // B knows nothing about the reset and saves its own list — a rename. Whether the
      // macros should come back at all is the generic globalState race and is not this
      // store's to decide; what IS this store's is that they come back WHOLE. A secret
      // record on disk with no vault entry behind it is a state neither user asked for.
      const b = windowB.getAll();
      b[1].name = "Poll (prod)";
      await windowB.save(b);

      const persisted = context.globalState.get("nexus.macros", []) as TerminalMacro[];
      expect(persisted.find((m) => m.id === "p")?.secret).toBe(true);
      expect(secretBag.get("macro-secret-text-p")).toBe("old\n");

      const reloaded = new VscodeMacroStore(context, { runLegacyMigration: false });
      await reloaded.initialize();
      expect(reloaded.getAll().find((m) => m.id === "p")?.text).toBe("old\n");
    });

    it("writes EVERY secret it holds, not only the one this window changed — and the changed one is not the first", async () => {
      const { context, secretBag } = makeFakeContext();
      const seed = new VscodeMacroStore(context, { runLegacyMigration: false });
      await seed.initialize();
      await seed.save([
        { id: "p", name: "Password", text: "p-old\n", secret: true },
        { id: "q", name: "Enable", text: "q-old\n", secret: true },
        { id: "s", name: "Console", text: "s-old\n", secret: true }
      ]);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const stores: string[] = [];
      const origStore = context.secrets.store.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => { stores.push(k); return origStore(k, v); };

      // The edited macro sits at index 1, with an untouched secret on either side of it. An
      // implementation that decides what to write from ARRAY POSITION — "the first one", "the
      // one being edited is index 0" — passes a two-record fixture whose changed record
      // happens to be at position zero. Here it cannot: whichever single key such an
      // implementation picks, the list below has three.
      const macros = store.getAll();
      macros[1].text = "q-new\n";
      await store.save(macros);

      expect(secretBag.get("macro-secret-text-p")).toBe("p-old\n");
      expect(secretBag.get("macro-secret-text-q")).toBe("q-new\n");
      expect(secretBag.get("macro-secret-text-s")).toBe("s-old\n");
      // The count and the order are the assertion. Every secret this window holds is written
      // back on every save — the unchanged ones with the same bytes they were read with —
      // because a write elided on the strength of a snapshot is a write elided on the strength
      // of something another window may have deleted since. An implementation that writes only
      // the changed record produces `["macro-secret-text-q"]` here.
      expect(stores).toEqual([
        "macro-secret-text-p",
        "macro-secret-text-q",
        "macro-secret-text-s"
      ]);
    });

    it("a re-keyed secret is stored under its NEW key, and the unmoved secret beside it is written too", async () => {
      const { context, secretBag } = makeFakeContext();
      // No caller produces this shape today: `save()`'s input is a mutation of `getAll()`
      // (whose ids are unique after any write) and the only wholesale-external list goes
      // through `replaceAll()`, which strips ids. It is kept for the caller that does not
      // exist yet — a record whose id MOVES has nothing behind its new key, so a write keyed
      // off the id it arrived with would put the value somewhere no macro names.
      const seed = new VscodeMacroStore(context, { runLegacyMigration: false });
      await seed.initialize();
      await seed.save([
        { id: "dup", name: "Password", text: "hunter2\n", secret: true },
        { id: "q", name: "Enable", text: "enable-pass\n", secret: true }
      ]);

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      expect(store.getAll()[0].text).toBe("hunter2\n");

      const stores: string[] = [];
      const origStore = context.secrets.store.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => { stores.push(k); return origStore(k, v); };

      const [password, enable] = store.getAll();
      await store.save([{ id: "dup", name: "Poll", text: "show status\n" }, password, enable]);

      const [, movedPassword, unmovedEnable] = store.getAll();
      expect(movedPassword.id).not.toBe("dup");
      expect(secretBag.get(`macro-secret-text-${movedPassword.id}`)).toBe("hunter2\n");
      expect(secretBag.has("macro-secret-text-dup")).toBe(false);
      expect(unmovedEnable.id).toBe("q");
      expect(secretBag.get("macro-secret-text-q")).toBe("enable-pass\n");
      // Both keys, and the moved one keyed by where the record ENDED UP rather than where it
      // came from. `macro-secret-text-dup` appears nowhere in the store list: it is deleted,
      // never written.
      expect(stores).toEqual([`macro-secret-text-${movedPassword.id}`, "macro-secret-text-q"]);
    });
  });

  describe("vault write ordering — the crash contract clearAll() relies on", () => {
    it("stores BEFORE committing MACROS_KEY, and deletes only after — and the whole save writes globalState exactly once", async () => {
      const { context } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([{ id: "s", name: "Password", text: "hunter2\n", secret: true }]);

      const ops: string[] = [];
      const origUpdate = context.globalState.update.bind(context.globalState);
      context.globalState.update = async (k: string, v: unknown) => {
        ops.push(`state:${k}`);
        return origUpdate(k, v);
      };
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

      // Flip "s" to non-secret (a delete) and add a brand-new secret "t" (a store), so
      // one save exercises store → MACROS_KEY → delete.
      await store.save([
        { id: "s", name: "Password", text: "now-public", secret: false },
        { id: "t", name: "Enable", text: "enable\n", secret: true }
      ]);

      const iStore = ops.indexOf("store:macro-secret-text-t");
      const iState = ops.indexOf("state:nexus.macros");
      const iDelete = ops.indexOf("delete:macro-secret-text-s");
      expect(iStore).toBeGreaterThanOrEqual(0);
      expect(iState).toBeGreaterThan(iStore);
      expect(iDelete).toBeGreaterThan(iState);
      // ONE globalState write, and it is `nexus.macros`. The ledger this save used to grow
      // before the store and shrink after the delete is gone; a re-introduction shows up here
      // as extra `state:` entries, and any name-based ledger has to write globalState.
      expect(ops.filter((o) => o.startsWith("state:"))).toEqual(["state:nexus.macros"]);
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

  describe("assignMacroIds() — id provenance and pinning", () => {
    it("reports the PRE-dedup id of every record, and gives EVERY record a valid id — not only the ones the collision was about", () => {
      const out = assignMacroIds([
        { id: "dup", name: "A", text: "a" },
        { id: "dup", name: "B", text: "b" },
        { name: "C", text: "c" },
        { id: "solo", name: "D", text: "d" }
      ] as TerminalMacro[]);

      expect(out.map((a) => a.priorId)).toEqual(["dup", "dup", undefined, "solo"]);
      expect(out[0].macro.id).toBe("dup");
      expect(out[1].macro.id).not.toBe("dup");
      // The re-keyed record's own id says nothing about where its side storage lives; only
      // priorId does. That distinction is the whole point of the return shape.
      expect(out[1].priorId).not.toBe(out[1].macro.id);
      // Asserting only the contested pair leaves an implementation that resolves the
      // collision and drops every other record's final id on the floor indistinguishable
      // from a correct one — `macro.id` would simply be `undefined` and nothing would look.
      expect(out).toHaveLength(4);
      for (const { macro } of out) {
        expect(isValidMacroId(macro.id)).toBe(true);
      }
      // ...and "every record has SOME valid id" is not the same claim as "an uncontested id
      // is left alone". Without this line an implementation that mints a fresh UUID for
      // `solo` satisfies everything above: the id is valid, it is unique, and nothing else
      // looks at it. `save()` keys the vault by the final id, so re-keying an uncontested
      // record is what orphans its entry.
      expect(out[3].macro.id).toBe("solo");
      expect(new Set(out.map((a) => a.macro.id)).size).toBe(4);
    });

    it("without keepIdIfPossible it reproduces the plain array-order rule, keeping a valid unique id that arrives AFTER the contested one", () => {
      const input = [
        { id: "dup", name: "A", text: "a" },
        { id: "dup", name: "B", text: "b" },
        { id: "", name: "C", text: "c" },
        { id: "solo", name: "D", text: "d" }
      ] as TerminalMacro[];
      const out = assignMacroIds(input);
      expect(out[0].macro.id).toBe("dup");
      expect(out[1].macro.id).not.toBe("dup");
      expect(out[2].macro.id).toBeTruthy();
      expect(out[2].macro.id).not.toBe("");
      // `solo` is the row that matters. Every record before it either contests an id or has
      // none, which is where "keep every valid unique id" and "regenerate everything once a
      // collision is seen" agree; a fixture that stops there cannot tell them apart.
      expect(out[3].macro.id).toBe("solo");
      expect(new Set(out.map((a) => a.macro.id)).size).toBe(4);
      // Provenance is part of "the plain array-order rule", not a separate feature of the
      // pinned path, and this is the only test of the no-option call that says so. Inspecting
      // final ids alone is satisfied by an implementation that reports `priorId: undefined`
      // for everything — which is precisely the value that tells `save()` "this record has no
      // vault entry of its own", the mistake that let a keyring outage destroy a password.
      // An empty-string id is NOT provenance: `isValidMacroId()` rejects it.
      expect(out.map((a) => a.priorId)).toEqual(["dup", "dup", undefined, "solo"]);
    });

    it("keepIdIfPossible gives a MIDDLE record first claim on a contested id, in EVERY contested group, and is consulted per record until each id is claimed", () => {
      const seen: string[] = [];
      const out = assignMacroIds(
        [
          { id: "one", name: "A", text: "a" },
          { id: "one", name: "B", text: "b" },
          { id: "two", name: "C", text: "c" },
          { id: "two", name: "D", text: "d" },
          { id: "two", name: "E", text: "e" }
        ] as TerminalMacro[],
        {
          keepIdIfPossible: (m) => {
            seen.push(m.name);
            return m.name === "B" || m.name === "D";
          }
        }
      );
      // TWO contested groups, and in neither of them is the winner first. One group cannot
      // distinguish "the pin pass runs over the whole list" from "the first contested id is
      // resolved by the pin and the rest fall back to array order" — the second is a real
      // implementation, and under it a save with two unreadable secrets destroys the second
      // one's password. Three claimants in the second group also rule out "the last wins".
      expect(out[1].macro.id).toBe("one");
      expect(out[0].macro.id).not.toBe("one");
      expect(out[3].macro.id).toBe("two");
      expect(out[2].macro.id).not.toBe("two");
      expect(out[4].macro.id).not.toBe("two");
      expect(new Set(out.map((a) => a.macro.id)).size).toBe(5);
      // The predicate receives the RECORD — not an id, not an index — and is not asked
      // again once the id it would claim is spoken for, which is why "E" never appears.
      expect(seen).toEqual(["A", "B", "C", "D"]);
      // Provenance is unaffected by who won.
      expect(out.map((a) => a.priorId)).toEqual(["one", "one", "two", "two", "two"]);
    });

    it("pinned records claim ahead of array order, among several pinned claimants the first in array order wins, and an uncontested id elsewhere is left alone", () => {
      const out = assignMacroIds(
        [
          { id: "dup", name: "Unpinned", text: "u" },
          { id: "dup", name: "Pinned A", text: "a" },
          { id: "solo", name: "Bystander", text: "s" },
          { id: "dup", name: "Pinned B", text: "b" }
        ] as TerminalMacro[],
        { keepIdIfPossible: (m) => m.name.startsWith("Pinned") }
      );
      // An UNPINNED record stands first, so "pinned records claim ahead of array order" and
      // plain "first in array order wins" give different answers. With all of them pinned —
      // the fixture this replaces — they agree, and ignoring the option entirely passed.
      expect(out[1].macro.id).toBe("dup");
      expect(out[0].macro.id).not.toBe("dup");
      expect(out[3].macro.id).not.toBe("dup");
      // `solo` is uncontested and unpinned, and it must survive the pin pass untouched. A
      // fixture containing nothing but the contested id cannot see an implementation that
      // regenerates every id it did not explicitly award — which would orphan the vault entry
      // of every secret macro that was not part of a collision, on every save.
      expect(out[2].macro.id).toBe("solo");
      expect(new Set(out.map((a) => a.macro.id)).size).toBe(4);
      expect(out.map((a) => a.priorId)).toEqual(["dup", "dup", "solo", "dup"]);
    });

    it("a pinned record with an UNUSABLE id — missing, empty, or not a string — gets a fresh one like any other, and never consumes the claim of a record that does have one", () => {
      const seen: string[] = [];
      const out = assignMacroIds(
        [
          { name: "No id", text: "n" },
          { id: "", name: "Empty id", text: "e" },
          { id: { length: 1 } as unknown as string, name: "Object id", text: "o" },
          { id: "dup", name: "Unpinned", text: "u" },
          { id: "dup", name: "Pinned", text: "p" }
        ] as TerminalMacro[],
        {
          keepIdIfPossible: (m) => {
            seen.push(m.name);
            return m.name !== "Unpinned";
          }
        }
      );
      expect(out[0].priorId).toBeUndefined();
      expect(out[1].priorId).toBeUndefined();
      expect(out[2].priorId).toBeUndefined();
      expect(isValidMacroId(out[0].macro.id)).toBe(true);
      expect(isValidMacroId(out[1].macro.id)).toBe(true);
      expect(isValidMacroId(out[2].macro.id)).toBe(true);
      // All three id-less records are pinned too. The pin pass has to pass over them rather
      // than treat "no id" as a claim — a single record with `id: undefined` proves nothing,
      // because plain missing-id UUID assignment produces the same answer with no pinning
      // implemented at all. The contested pair beside them is what makes the two diverge.
      expect(out[4].macro.id).toBe("dup");
      expect(out[3].macro.id).not.toBe("dup");
      expect(new Set(out.map((a) => a.macro.id)).size).toBe(5);
      // And none of them reaches the predicate: they have nothing to claim. `undefined` alone
      // is exercised by any `priorId === undefined` guard; `""` and a non-string with a
      // positive `.length` are what a `!m.id` or a bare `.length` check lets through, and a
      // pinned `""` would then claim the empty string and starve a later record of it.
      expect(seen).toEqual(["Unpinned", "Pinned"]);
    });
  });

  describe("replaceAll() — an external list is not a mutation of this store's list", () => {
    it("an imported record cannot inherit the vault entry of a local macro whose id it collides with, even while the keyring is down", async () => {
      const { context, stateBag, secretBag } = makeFakeContext();
      // The state the review reproduced against: a local secret macro whose password is in
      // the vault, and a keyring outage that makes the value unreadable — which is what puts
      // the id in `unresolvedSecretIds` and arms the pin.
      stateBag.set("nexus.macros", [
        { id: "p", name: "Existing", text: "", secret: true, triggerPattern: "Password:" }
      ]);
      secretBag.set("macro-secret-text-p", "old-local-password\n");
      const realGet = context.secrets.get.bind(context.secrets);
      context.secrets.get = async () => undefined;

      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      expect(store.getAll()[0].text).toBe("");

      // A replace-mode restore from a backup whose own secret blob could not be decrypted:
      // `secret: true` with no text, an id that happens to equal the local macro's, and a
      // live auto-trigger. The user has already been told this macro's secret is missing.
      await store.replaceAll([
        {
          id: "p",
          name: "Imported missing secret",
          text: "",
          secret: true,
          triggerPattern: "Password:"
        }
      ]);

      const [imported] = store.getAll();
      expect(imported.name).toBe("Imported missing secret");
      expect(imported.id).not.toBe("p");
      // Replace means replace: the local entry is gone rather than silently adopted.
      expect(secretBag.has("macro-secret-text-p")).toBe(false);

      // The disclosure, stated as an assertion: once the keyring answers again the imported
      // macro must still be what the import said it was — a secret macro with no value —
      // and not a `Password:` auto-trigger armed with the local machine's password.
      context.secrets.get = realGet;
      const reloaded = new VscodeMacroStore(context, { runLegacyMigration: false });
      await reloaded.initialize();
      const [after] = reloaded.getAll();
      expect(after.name).toBe("Imported missing secret");
      expect(after.text).toBe("");
      expect(after.text).not.toBe("old-local-password\n");
    });

    it("freshens every incoming id and deletes the vault entries of the set it replaces", async () => {
      const { context, secretBag } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([
        { id: "local-1", name: "Local secret", text: "local-value\n", secret: true },
        { id: "local-2", name: "Local plain", text: "show version\n" }
      ]);

      await store.replaceAll([
        { id: "local-1", name: "Imported secret", text: "imported-value\n", secret: true },
        { id: "from-file", name: "Imported plain", text: "show run\n" }
      ]);

      const [importedSecret, importedPlain] = store.getAll();
      // Not "the colliding one is re-keyed" — every incoming id, colliding or not, because
      // an id in a file is not an identity in this store.
      expect(importedSecret.id).not.toBe("local-1");
      expect(importedPlain.id).not.toBe("from-file");
      expect(importedSecret.text).toBe("imported-value\n");
      expect(secretBag.get(`macro-secret-text-${importedSecret.id}`)).toBe("imported-value\n");
      // The replaced set's vault entry is deleted, not left orphaned under a key nothing names.
      expect([...secretBag.keys()]).toEqual([`macro-secret-text-${importedSecret.id}`]);
    });

    it("InMemoryMacroStore.replaceAll() freshens ids too, so both implementations agree on what callers observe", async () => {
      const store = new InMemoryMacroStore();
      await store.initialize();
      await store.save([{ id: "local-1", name: "Local", text: "show version\n" }]);
      await store.replaceAll([{ id: "local-1", name: "Imported", text: "show run\n" }]);

      const [imported] = store.getAll();
      expect(imported.name).toBe("Imported");
      expect(imported.id).toBeTruthy();
      expect(imported.id).not.toBe("local-1");
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
        },
        async keys(): Promise<string[]> {
          return [...secretBag.keys()];
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

  it("clearAll does not throw when SecretStorage.keys() answers with a non-array", async () => {
    // A host answering something other than `string[]` is not a shape the API admits, but the
    // sweep must not turn a surprising answer into a failed Complete Reset — it has vault
    // entries of its own to delete and must get to them.
    const context = makeStrictContext({ "nexus.macros": [] });
    (context.secrets as unknown as { keys(): Promise<unknown> }).keys = async () => ({ bad: true });
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
