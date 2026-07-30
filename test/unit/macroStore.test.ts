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
import type { TerminalMacro } from "../../src/models/terminalMacro";

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

  it("clearAll sweeps orphan secret ids tracked in the index", async () => {
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
