import { describe, it, expect, vi } from "vitest";

// VscodeMacroStore imports vscode for the legacy migration (tests with
// { runLegacyMigration: false } never touch those stubs) AND for `workspace.fs`, which it
// uses on every save that writes a secret: the secret-id ledger is one marker FILE per id
// under `globalStorageUri`, because a `globalState` array is a read-modify-write that two
// windows can lose. So the mock below is a real (if tiny) in-memory filesystem rather than
// a set of no-op spies — a no-op `writeFile` would make every "the marker was written"
// assertion vacuous, and a no-op `readDirectory` would hide the sweep entirely.
vi.mock("vscode", () => {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  return {
    workspace: {
      getConfiguration: vi.fn(() => ({
        inspect: vi.fn(() => ({})),
        update: vi.fn()
      })),
      fs: {
        async createDirectory(uri: { path: string }): Promise<void> {
          // Idempotent, like the real one, and it creates parents.
          const parts = uri.path.split("/").filter(Boolean);
          for (let i = 1; i <= parts.length; i++) dirs.add(`/${parts.slice(0, i).join("/")}`);
        },
        async writeFile(uri: { path: string }, content: Uint8Array): Promise<void> {
          const parent = uri.path.slice(0, uri.path.lastIndexOf("/"));
          if (!dirs.has(parent)) throw new Error(`ENOENT: no such directory, open '${uri.path}'`);
          files.set(uri.path, content);
        },
        async readFile(uri: { path: string }): Promise<Uint8Array> {
          const found = files.get(uri.path);
          if (!found) throw new Error(`ENOENT: no such file, open '${uri.path}'`);
          return found;
        },
        async readDirectory(uri: { path: string }): Promise<Array<[string, number]>> {
          if (!dirs.has(uri.path)) throw new Error(`ENOENT: no such directory, scandir '${uri.path}'`);
          const prefix = `${uri.path}/`;
          return [...files.keys()]
            .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
            .map((p) => [p.slice(prefix.length), 1] as [string, number]);
        },
        async delete(uri: { path: string }): Promise<void> {
          if (!files.delete(uri.path)) throw new Error(`ENOENT: no such file, unlink '${uri.path}'`);
        }
      }
    },
    Uri: {
      joinPath(base: { path: string; scheme?: string }, ...parts: string[]) {
        const path = [base.path.replace(/\/$/, ""), ...parts].join("/");
        return { path, fsPath: path, scheme: base.scheme ?? "file" };
      }
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    __fsFiles: files,
    __fsDirs: dirs
  };
});

import * as vscodeMock from "vscode";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { VscodeMacroStore } from "../../src/storage/vscodeMacroStore";
import { assignMacroIds, assignUniqueMacroIds, isValidMacroId } from "../../src/storage/macroStore";
import type { TerminalMacro } from "../../src/models/terminalMacro";

const fsFiles = (vscodeMock as unknown as { __fsFiles: Map<string, Uint8Array> }).__fsFiles;
const fsDirs = (vscodeMock as unknown as { __fsDirs: Set<string> }).__fsDirs;

/**
 * The mocked filesystem is module state and therefore shared by every test in this file, so
 * each context gets its OWN global-storage root. Without that, one test's marker files would
 * be visible to the next test's `clearAll()` sweep and a leak would read as a pass.
 */
let contextSeq = 0;

function makeFakeContext() {
  const stateBag = new Map<string, unknown>();
  const secretBag = new Map<string, string>();
  const globalStoragePath = `/global-storage/ctx-${++contextSeq}`;
  return {
    context: {
      globalStorageUri: { path: globalStoragePath, fsPath: globalStoragePath, scheme: "file" },
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
    secretBag,
    /** Marker-file names currently under this context's global storage, sorted. */
    markerNames(): string[] {
      const prefix = `${globalStoragePath}/macro-secret-ids/`;
      return [...fsFiles.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .sort();
    },
    /** Secret ids recoverable from this context's marker files — the ids are the CONTENTS. */
    markedIds(): string[] {
      const prefix = `${globalStoragePath}/macro-secret-ids/`;
      return [...fsFiles.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .map(([, bytes]) => new TextDecoder().decode(bytes))
        .sort();
    },
    globalStoragePath
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

  // Also the LEGACY-FALLBACK contract: "orphan" below is seeded into `nexus.macros.secretIds`
  // and into the vault by hand and has no marker file, which is exactly the shape a build
  // predating the marker files leaves behind. Complete Reset must still find it.
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

  describe("secret-id MARKER FILES — the per-entity ledger the globalState array could not be", () => {
    it("writes the marker BEFORE the vault entry it names, with the id as the file's contents", async () => {
      const { context, markerNames, markedIds } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const markedAtStore = new Map<string, string[]>();
      const origStore = context.secrets.store.bind(context.secrets);
      context.secrets.store = async (k: string, v: string) => {
        markedAtStore.set(k, markedIds());
        return origStore(k, v);
      };

      await store.save([{ id: "s", name: "Password", text: "hunter2\n", secret: true }]);

      // The guarantee: at the instant the value hit the vault, the id naming it was already
      // on disk in a medium that a second window cannot overwrite. Writing the marker
      // afterwards leaves a window in which a crash strands a plaintext credential under a
      // key nothing names — not `nexus.macros`, not the ledger, not Complete Reset.
      expect(markedAtStore.get("macro-secret-text-s")).toEqual(["s"]);
      // One file, named by a hash (macro ids are only promised to be non-empty strings, and a
      // hand-edited backup can put a path separator in one), with the id as its contents so
      // the sweep can recover it.
      expect(markerNames()).toHaveLength(1);
      expect(markerNames()[0]).toMatch(/^[0-9a-f]{64}\.id$/);
      expect(markedIds()).toEqual(["s"]);
    });

    it("Complete Reset sweeps a vault entry that only a marker still names — the entry the globalState ledger loses to a second window", async () => {
      const { context, stateBag, secretBag, markedIds } = makeFakeContext();
      const windowA = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowA.initialize();
      const windowB = new VscodeMacroStore(context, { runLegacyMigration: false });
      await windowB.initialize();

      await windowA.save([{ id: "a", name: "A", text: "secret-a\n", secret: true }]);
      expect(stateBag.get("nexus.macros.secretIds")).toEqual(["a"]);

      // Window B is running on a globalState cache from BEFORE A's save. That is not a
      // contrivance — it is what VS Code hands a second window, and extension code cannot
      // invalidate or lock it, which is the whole reason the array ledger cannot be the
      // authoritative record. B's ledger read therefore answers `[]`, its union write drops
      // "a", and its wholesale `nexus.macros` write drops A's macro too.
      const origGet = context.globalState.get.bind(context.globalState);
      context.globalState.get = ((key: string, fallback: unknown) =>
        key === "nexus.macros.secretIds" ? [] : origGet(key, fallback)) as typeof context.globalState.get;
      await windowB.save([{ id: "b", name: "B", text: "secret-b\n", secret: true }]);
      context.globalState.get = origGet;

      // The lost race, reproduced: nothing in globalState names "a" any more...
      expect(stateBag.get("nexus.macros.secretIds")).toEqual(["b"]);
      expect((stateBag.get("nexus.macros") as TerminalMacro[]).map((m) => m.id)).toEqual(["b"]);
      expect(secretBag.get("macro-secret-text-a")).toBe("secret-a\n");
      // ...but the marker files do, because two windows creating two different files cannot
      // lose one another's write.
      expect(markedIds()).toEqual(["a", "b"]);

      const later = new VscodeMacroStore(context, { runLegacyMigration: false });
      await later.initialize();
      await later.clearAll();

      expect(secretBag.has("macro-secret-text-a")).toBe(false);
      expect(secretBag.has("macro-secret-text-b")).toBe(false);
      // And the markers go with the entries they named, so the directory does not grow
      // without bound.
      expect(markedIds()).toEqual([]);
    });

    it("a save whose marker cannot be written writes NOTHING — not the vault entry, not the ledger, not nexus.macros", async () => {
      const { context, stateBag, secretBag, markedIds } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([{ id: "keep", name: "Existing", text: "show version\n" }]);
      const before = JSON.stringify(stateBag.get("nexus.macros"));

      const fs = (vscodeMock as unknown as { workspace: { fs: Record<string, unknown> } }).workspace.fs;
      const origWriteFile = fs.writeFile;
      fs.writeFile = async () => {
        throw new Error("EACCES: permission denied");
      };
      try {
        await expect(
          store.save([
            { id: "keep", name: "Existing", text: "show version\n" },
            { id: "new", name: "Password", text: "hunter2\n", secret: true }
          ])
        ).rejects.toThrow(/could not record macro secret ids/);
      } finally {
        fs.writeFile = origWriteFile;
      }

      // Fail CLOSED, and fail early: the marker is the first write of the save, so an
      // unwritable storage folder loses the save rather than producing a vault entry no key
      // names. The opposite choice — store the secret and hope — is how an unsweepable
      // plaintext credential is created, which is the whole point of the marker.
      expect(secretBag.has("macro-secret-text-new")).toBe(false);
      expect(markedIds()).toEqual([]);
      expect(context.globalState.get<string[]>("nexus.macros.secretIds", [])).toEqual([]);
      expect(JSON.stringify(stateBag.get("nexus.macros"))).toBe(before);
      // ...and the in-memory list is not advanced either, so the UI still shows what is
      // actually on disk rather than the save the user thinks succeeded.
      expect(store.getAll().map((m) => m.id)).toEqual(["keep"]);
    });

    it("bounds the added I/O: nothing at all for a save with no secrets, and one marker write per id per window however many times it is saved", async () => {
      const { context } = makeFakeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();

      const fs = (vscodeMock as unknown as {
        workspace: { fs: Record<string, (...args: never[]) => unknown> };
      }).workspace.fs;
      const calls: string[] = [];
      const wrapped = ["createDirectory", "writeFile", "readFile", "readDirectory", "delete"].map((name) => {
        const orig = fs[name];
        fs[name] = ((...args: never[]) => {
          calls.push(name);
          return orig(...args);
        }) as typeof orig;
        return [name, orig] as const;
      });
      try {
        // A macro list with no secrets in it never opens the storage folder — an unwritable
        // one therefore blocks saving a SECRET macro and nothing else.
        await store.save([{ id: "plain", name: "Poll", text: "show status\n" }]);
        expect(calls).toEqual([]);

        await store.save([
          { id: "plain", name: "Poll", text: "show status\n" },
          { id: "s", name: "Password", text: "hunter2\n", secret: true }
        ]);
        expect(calls).toEqual(["createDirectory", "writeFile"]);

        // Saving the same secret again — a rename, a reorder, a new value — re-writes the
        // vault entry but not the marker: the bytes are already the ones this window put
        // there. Without the memo this would be one filesystem write per secret macro per
        // save, on a path that can be a network share.
        calls.length = 0;
        await store.save([
          { id: "plain", name: "Poll (prod)", text: "show status\n" },
          { id: "s", name: "Password", text: "new-pass\n", secret: true }
        ]);
        expect(calls).toEqual([]);
      } finally {
        for (const [name, orig] of wrapped) fs[name] = orig;
      }
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
      stateBag.set("nexus.macros.secretIds", ["dup"]);

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
      expect(stateBag.get("nexus.macros.secretIds")).toEqual(["dup"]);

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
      stateBag.set("nexus.macros.secretIds", ["dup"]);
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
      stateBag.set("nexus.macros.secretIds", ["u", "e"]);

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
      stateBag.set("nexus.macros.secretIds", ["p"]);
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
