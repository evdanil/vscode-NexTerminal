import { describe, it, expect, vi, beforeEach } from "vitest";
import { VscodeMacroStore, macroSecretKey } from "../../src/storage/vscodeMacroStore";
import type { TerminalMacro } from "../../src/models/terminalMacro";

vi.mock("vscode", () => {
  const configs = new Map<string, { global: unknown; workspace: unknown; workspaceFolder: unknown }>();
  const api = {
    workspace: {
      getConfiguration(section: string) {
        const get = () => configs.get(section) ?? { global: undefined, workspace: undefined, workspaceFolder: undefined };
        return {
          inspect(key: string) {
            const c = get();
            return {
              key,
              defaultValue: undefined,
              globalValue: c.global,
              workspaceValue: c.workspace,
              workspaceFolderValue: c.workspaceFolder
            };
          },
          async update(key: string, value: unknown, target: number) {
            const c = get();
            const next = { ...c };
            if (target === api.ConfigurationTarget.Global) next.global = value;
            if (target === api.ConfigurationTarget.Workspace) next.workspace = value;
            if (target === api.ConfigurationTarget.WorkspaceFolder) next.workspaceFolder = value;
            configs.set(section, next);
          },
          get<T>(key: string, fallback: T): T {
            const c = get();
            return (c.workspaceFolder ?? c.workspace ?? c.global ?? fallback) as T;
          }
        };
      }
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    __setConfig(section: string, value: { global?: unknown; workspace?: unknown; workspaceFolder?: unknown }) {
      configs.set(section, { global: value.global, workspace: value.workspace, workspaceFolder: value.workspaceFolder });
    },
    __getConfig(section: string) {
      return configs.get(section);
    },
    __reset() { configs.clear(); }
  };
  return api;
});

function makeCtx() {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    ctx: {
      globalState: {
        get<T>(k: string, fb: T): T { return (state.get(k) as T) ?? fb; },
        async update(k: string, v: unknown): Promise<void> { if (v === undefined) state.delete(k); else state.set(k, v); },
        keys(): readonly string[] { return [...state.keys()]; }
      },
      secrets: {
        async get(k: string): Promise<string | undefined> { return secrets.get(k); },
        async store(k: string, v: string): Promise<void> { secrets.set(k, v); },
        async delete(k: string): Promise<void> { secrets.delete(k); }
      }
    } as unknown as import("vscode").ExtensionContext,
    state,
    secrets
  };
}

beforeEach(async () => {
  const vscode = await import("vscode") as unknown as { __reset(): void };
  vscode.__reset();
});

describe("MacroStore legacy migration", () => {
  it("absorbs global settings macros and clears the legacy scope", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void; __getConfig: (s: string) => unknown };
    vscode.__setConfig("nexus.terminal", {
      global: [{ name: "a", text: "echo a" }, { name: "s", text: "classified", secret: true }] as TerminalMacro[]
    });
    const { ctx, state, secrets } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    expect(store.getAll()).toHaveLength(2);
    const persisted = state.get("nexus.macros") as TerminalMacro[];
    expect(persisted.find((m) => m.name === "a")!.text).toBe("echo a");
    const secretMacro = persisted.find((m) => m.name === "s")!;
    expect(secretMacro.text).toBe("");
    expect(secrets.get(macroSecretKey(secretMacro.id!))).toBe("classified");

    // Legacy setting cleared
    const legacy = (vscode.__getConfig("nexus.terminal") as { global: unknown }).global;
    expect(legacy).toBeUndefined();
  });

  it("merges macros from all three scopes with dedupe", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const shared = { name: "dup", text: "same" } as TerminalMacro;
    vscode.__setConfig("nexus.terminal", {
      global: [shared, { name: "g-only", text: "g" }],
      workspace: [shared, { name: "w-only", text: "w" }],
      workspaceFolder: [{ name: "wf-only", text: "wf" }]
    });
    const { ctx } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const names = store.getAll().map((m) => m.name).sort();
    expect(names).toEqual(["dup", "g-only", "w-only", "wf-only"]);
  });

  it("re-absorbs when legacy settings reappear after first migration", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void; __getConfig: (s: string) => unknown };
    vscode.__setConfig("nexus.terminal", { global: [{ name: "first", text: "a" }] });
    const { ctx } = makeCtx();
    let store = new VscodeMacroStore(ctx);
    await store.initialize();
    expect(store.getAll().map((m) => m.name)).toEqual(["first"]);

    // Simulate Settings Sync replay bringing the old setting back with a NEW entry
    vscode.__setConfig("nexus.terminal", { global: [{ name: "first", text: "a" }, { name: "synced-back", text: "b" }] });
    store = new VscodeMacroStore(ctx);
    await store.initialize();

    const names = store.getAll().map((m) => m.name).sort();
    expect(names).toEqual(["first", "synced-back"]);

    // And the legacy scope is cleared again
    expect((vscode.__getConfig("nexus.terminal") as { global: unknown }).global).toBeUndefined();
  });

  it("no legacy entries → migration is a no-op", async () => {
    const { ctx } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();
    expect(store.getAll()).toEqual([]);
  });

  it("Fix 1 — a masked variable's plaintext default in legacy settings never reaches globalState", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    vscode.__setConfig("nexus.terminal", {
      global: [
        {
          name: "Login",
          text: "login $password\n",
          variables: [{ name: "password", secret: true, default: "hunter2" }]
        } as TerminalMacro
      ]
    });
    const { ctx, state } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    expect(store.getAll().map((m) => m.name)).toEqual(["Login"]);
    const persisted = state.get("nexus.macros") as TerminalMacro[];
    expect(JSON.stringify(persisted)).not.toContain("hunter2");
    expect(persisted[0].variables).toEqual([{ name: "password", secret: true }]);
  });

  it("Fix 3 — two DISTINCT secret macros sharing a hand-written duplicate id through legacy settings each get their own vault entry", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    // Trigger from the review: legacy settings.json contains two genuinely
    // different secret macros that happen to share a hand-written `id`.
    // Content-based dedup (dedupeLegacyMacros) does not collapse these — they
    // differ in name and text — so both must survive persistLegacyMigration
    // with DISTINCT ids, each with its own vault entry.
    vscode.__setConfig("nexus.terminal", {
      global: [
        { id: "dup", name: "First", text: "first-secret", secret: true },
        { id: "dup", name: "Second", text: "second-secret", secret: true }
      ] as TerminalMacro[]
    });
    const { ctx, state, secrets } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const all = store.getAll();
    expect(all).toHaveLength(2);
    const [first, second] = all;
    expect(first.id).toBeDefined();
    expect(second.id).toBeDefined();
    expect(first.id).not.toBe(second.id);
    expect(first.text).toBe("first-secret");
    expect(second.text).toBe("second-secret");
    expect(secrets.get(macroSecretKey(first.id!))).toBe("first-secret");
    expect(secrets.get(macroSecretKey(second.id!))).toBe("second-secret");

    // NOTE: an earlier version of this test claimed to check the secret-id index but
    // asserted on `nexus.macros`. Asserting the index here instead does not fix that,
    // it just makes the assertion decorative in a new way: `initialize()` always runs
    // `reloadFromState()` after the absorb, and that unions the on-disk secret ids back
    // into the ledger, so ANY single-point failure of index maintenance on the absorb
    // path is healed before this test can observe it. The ledger is asserted where it
    // can actually fail — see "secret-id ledger" in macroStore.test.ts.
    const persisted = state.get("nexus.macros") as TerminalMacro[];
    expect(persisted.map((m) => m.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("an already-persisted macro's id is IMMUTABLE across an absorb — re-keying one at startup orphans its vault entry", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const { ctx, state, secrets } = makeCtx();

    // Two secret macros already in globalState sharing an id from before the
    // uniqueness invariant existed. Their real text lives in the vault; the on-disk
    // records carry `text: ""`. Absorption runs on EVERY activation, so if it re-keyed
    // one of them the vault-store branch would be skipped (empty text) and the value
    // would be stranded under the old id with nothing left pointing at it.
    state.set("nexus.macros", [
      { id: "dup", name: "Password A", text: "", secret: true },
      { id: "dup", name: "Password B", text: "", secret: true }
    ] as TerminalMacro[]);
    secrets.set(macroSecretKey("dup"), "shared-secret");

    // Something to absorb, so persistLegacyMigration actually runs.
    vscode.__setConfig("nexus.terminal", { global: [{ name: "new", text: "echo new" }] as TerminalMacro[] });

    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const persisted = state.get("nexus.macros") as TerminalMacro[];
    expect(persisted.filter((m) => m.id === "dup")).toHaveLength(2);
    expect(secrets.get(macroSecretKey("dup"))).toBe("shared-secret");
    // Duplicates on disk are left for MacroAutoTrigger to suppress, not repaired here.
    expect(store.getAll().filter((m) => m.id === "dup")).toHaveLength(2);
  });

  it("an absorbed macro whose hand-written id collides with an existing one is re-keyed — it must not overwrite that macro's vault entry", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const { ctx, state, secrets } = makeCtx();

    // Provenance, not position: the absorbed record's secret is the cleartext in
    // settings.json and it has never had a vault entry, so it is provably not the
    // owner of `macro-secret-text-shared`. Keeping its id would make
    // persistLegacyMigration's `secrets.store()` clobber the existing macro's password.
    state.set("nexus.macros", [
      { id: "shared", name: "Existing", text: "", secret: true }
    ] as TerminalMacro[]);
    secrets.set(macroSecretKey("shared"), "existing-secret");

    vscode.__setConfig("nexus.terminal", {
      global: [{ id: "shared", name: "Absorbed", text: "absorbed-secret", secret: true }] as TerminalMacro[]
    });

    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const all = store.getAll();
    const existing = all.find((m) => m.name === "Existing")!;
    const absorbed = all.find((m) => m.name === "Absorbed")!;
    expect(existing.id).toBe("shared");
    expect(absorbed.id).not.toBe("shared");
    expect(secrets.get(macroSecretKey("shared"))).toBe("existing-secret");
    expect(secrets.get(macroSecretKey(absorbed.id!))).toBe("absorbed-secret");
    expect(existing.text).toBe("existing-secret");
    expect(absorbed.text).toBe("absorbed-secret");
  });

  it("a non-object entry in the legacy setting is dropped, not absorbed, and does not fail activation", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const { ctx } = makeCtx();
    // Only the ARRAY shape is validated before this point, so a hand-edited
    // settings.json can put anything inside it. `keyOfLegacy()` dereferences `.secret`
    // — an unguarded entry here rejects initialize(), which rejects activate().
    vscode.__setConfig("nexus.terminal", { global: [null, { name: "real", text: "echo real" }] });

    const store = new VscodeMacroStore(ctx);
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(store.getAll().map((m) => m.name)).toEqual(["real"]);
  });

  it("a non-object record already in globalState survives the absorb rewrite as-is, not as a phantom {id} macro", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const { ctx, state } = makeCtx();
    state.set("nexus.macros", [null, { id: "a", name: "Real", text: "x" }]);
    vscode.__setConfig("nexus.terminal", { global: [{ name: "new", text: "echo new" }] as TerminalMacro[] });

    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const persisted = state.get("nexus.macros") as unknown[];
    expect(persisted[0]).toBeNull();
    expect(store.getAll().map((m) => m.name)).toEqual(["Real", "new"]);
  });

  it("does not clobber a MACROS_KEY another window moved while the vault write was in flight — and keeps the legacy setting so the absorb retries", async () => {
    const vscode = await import("vscode") as unknown as {
      __setConfig: (s: string, v: Record<string, unknown>) => void;
      __getConfig: (s: string) => unknown;
    };
    const { ctx, state, secrets } = makeCtx();
    state.set("nexus.macros", [{ id: "a", name: "Existing", text: "x" }] as TerminalMacro[]);
    const legacy = [{ name: "Absorbed", text: "absorbed-secret", secret: true }] as TerminalMacro[];
    vscode.__setConfig("nexus.terminal", { global: legacy });

    // Absorption runs on EVERY activation, so a second window starting at the same time —
    // or the user deleting a macro in another window — lands inside the `await` on the
    // vault store. Writing MACROS_KEY unconditionally after that resurrects what the other
    // window deleted, or drops what it added. `reloadFromState()` already documents this
    // guard as mandatory; this path needs the same one.
    const mutableSecrets = ctx.secrets as unknown as { store(k: string, v: string): Promise<void> };
    const origStore = mutableSecrets.store.bind(ctx.secrets);
    mutableSecrets.store = async (k: string, v: string) => {
      state.set("nexus.macros", [{ id: "b", name: "From other window", text: "z" }] as TerminalMacro[]);
      return origStore(k, v);
    };

    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    // The other window's write survives untouched.
    expect((state.get("nexus.macros") as TerminalMacro[]).map((m) => m.name)).toEqual(["From other window"]);
    expect(store.getAll().map((m) => m.name)).toEqual(["From other window"]);
    expect(store.getLastAbsorbedCount()).toBe(0);

    // The legacy setting is still there, so the next activation absorbs it against
    // whatever the other window left behind. Clearing it here would have been the only
    // remaining copy of "Absorbed" disappearing.
    expect((vscode.__getConfig("nexus.terminal") as { global: unknown }).global).toEqual(legacy);

    // The vault value that was written before the guard fired is an orphan, but a NAMED
    // one: the ledger grows before the store, so Complete Reset can still sweep it.
    const orphanKeys = [...secrets.keys()];
    expect(orphanKeys).toHaveLength(1);
    const indexed = ctx.globalState.get<string[]>("nexus.macros.secretIds", []);
    expect(orphanKeys[0]).toBe(macroSecretKey(indexed[0]));
  });

  it("does not duplicate secret macros when Settings Sync replays cleartext", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    vscode.__setConfig("nexus.terminal", { global: [{ name: "pw", text: "hunter2", secret: true }] });
    const { ctx } = makeCtx();
    let store = new VscodeMacroStore(ctx);
    await store.initialize();
    expect(store.getAll().map((m) => m.name)).toEqual(["pw"]);

    // Settings Sync replays the ORIGINAL cleartext back into settings (same name+secret)
    vscode.__setConfig("nexus.terminal", { global: [{ name: "pw", text: "hunter2", secret: true }] });
    store = new VscodeMacroStore(ctx);
    await store.initialize();
    expect(store.getAll().map((m) => m.name)).toEqual(["pw"]); // no duplicate
  });

  describe("§4.2 — `group` is untrusted on the absorption path too", () => {
    // Isolates `persistLegacyMigration()` specifically: `initialize()` always
    // runs `reloadFromState()` right after absorption, and THAT method's own
    // scrub would clean up a malformed group even if persistLegacyMigration did
    // nothing — so asserting only the post-initialize() state cannot tell the
    // two ingest sites apart. Capturing the FIRST write to `nexus.macros`
    // (persistLegacyMigration's own write, before reloadFromState ever runs)
    // isolates it.
    it("a non-string group from a hand-edited settings.json is dropped BEFORE reloadFromState ever sees it", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        global: [{ name: "a", text: "echo a", group: { nope: true } } as unknown as TerminalMacro]
      });
      const { ctx } = makeCtx();
      const writes: unknown[] = [];
      const origUpdate = ctx.globalState.update.bind(ctx.globalState);
      ctx.globalState.update = async (key: string, value: unknown) => {
        if (key === "nexus.macros") writes.push(value);
        return origUpdate(key, value);
      };
      const store = new VscodeMacroStore(ctx);

      await expect(store.initialize()).resolves.toBeUndefined();

      expect(writes.length).toBeGreaterThan(0);
      const firstWrite = writes[0] as Array<{ group?: unknown }>;
      expect(firstWrite[0].group).toBeUndefined();
    });

    it("a '..' path-traversal group from legacy settings is dropped", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        global: [{ name: "a", text: "echo a", group: "../secrets" } as TerminalMacro]
      });
      const { ctx } = makeCtx();
      const store = new VscodeMacroStore(ctx);

      await store.initialize();

      expect(store.getAll()[0].group).toBeUndefined();
    });

    it("Fix 4 — a pathologically long SINGLE-SEGMENT group from legacy settings is dropped (depth/segment-count alone never bounds this)", async () => {
      // The exact repro from the review: `group: "X".repeat(8_000_000)` has a
      // segment count of 1 — comfortably under MAX_FOLDER_DEPTH — so only a
      // length bound (not a depth bound) can catch it.
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      const huge = "X".repeat(8_000_000);
      vscode.__setConfig("nexus.terminal", {
        global: [{ name: "a", text: "echo a", group: huge } as TerminalMacro]
      });
      const { ctx } = makeCtx();
      const store = new VscodeMacroStore(ctx);

      await expect(store.initialize()).resolves.toBeUndefined();

      expect(store.getAll()[0].group).toBeUndefined();
    });

    it("a valid group from legacy settings survives absorption", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        global: [{ name: "a", text: "echo a", group: "Cisco/Routers" } as TerminalMacro]
      });
      const { ctx } = makeCtx();
      const store = new VscodeMacroStore(ctx);

      await store.initialize();

      expect(store.getAll()[0].group).toBe("Cisco/Routers");
    });
  });

  describe("Fix 1 (this review round) — persistLegacyMigration() enforces isUsableMacro too", () => {
    // Isolates `persistLegacyMigration()` the same way the §4.2 block above
    // does: capture the FIRST write to `nexus.macros` (persistLegacyMigration's
    // own write), before `reloadFromState()` ever runs, so a fix living only
    // in `reloadFromState()` can't make this pass by accident.
    it("a macro missing `text` in legacy settings never reaches globalState, not even transiently", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        // The exact settings.json trigger from the review.
        global: [{ name: "Broken", group: "Cisco" } as unknown as TerminalMacro]
      });
      const { ctx } = makeCtx();
      const writes: unknown[] = [];
      const origUpdate = ctx.globalState.update.bind(ctx.globalState);
      ctx.globalState.update = async (key: string, value: unknown) => {
        if (key === "nexus.macros") writes.push(value);
        return origUpdate(key, value);
      };
      const store = new VscodeMacroStore(ctx);

      await expect(store.initialize()).resolves.toBeUndefined();

      expect(writes.length).toBeGreaterThan(0);
      const firstWrite = writes[0] as unknown[];
      expect(firstWrite).toHaveLength(0); // dropped before persistence, not merely hidden later
      expect(store.getAll()).toEqual([]);
    });

    it("a usable macro alongside a broken one in legacy settings: only the broken one is dropped", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        global: [
          { name: "Good", text: "echo good" },
          { name: "Broken", group: "Cisco" } as unknown as TerminalMacro
        ]
      });
      const { ctx } = makeCtx();
      const store = new VscodeMacroStore(ctx);

      await store.initialize();

      expect(store.getAll().map((m) => m.name)).toEqual(["Good"]);
    });
  });

  describe("§7 — keyOfLegacy() deliberately excludes `group` (assert the decision)", () => {
    it("an on-disk macro and a legacy-settings entry differing ONLY by group are treated as the same macro (no duplicate added)", async () => {
      const { ctx, state } = makeCtx();
      // Simulate a macro already migrated once (now living at MACROS_KEY, no group).
      state.set("nexus.macros", [{ id: "existing-id", name: "reload", text: "reload\n" }]);

      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      // Legacy settings still carries what LOOKS like the same macro, but with
      // a `group` the user assigned through some other path. If `keyOfLegacy`
      // included `group`, this would be absorbed as a SECOND, duplicate macro.
      vscode.__setConfig("nexus.terminal", {
        global: [{ name: "reload", text: "reload\n", group: "Cisco" } as TerminalMacro]
      });

      const store = new VscodeMacroStore(ctx);
      await store.initialize();

      expect(store.getAll()).toHaveLength(1); // not duplicated
      expect(store.getAll()[0].id).toBe("existing-id");
    });
  });
});
