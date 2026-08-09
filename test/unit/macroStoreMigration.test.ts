import { describe, it, expect, vi, beforeEach } from "vitest";
import { VscodeMacroStore, macroSecretKey } from "../../src/storage/vscodeMacroStore";
import { getAssignedBinding } from "../../src/macroBindingHelpers";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { macroGroup } from "../../src/services/macroFolders";

// There is deliberately no `workspace.fs` in this mock: the absorb path stores secrets, and it
// no longer writes anything to the filesystem to do so. The per-secret-id marker files it used
// to write under `globalStorageUri` are gone, replaced by `SecretStorage.keys()` at sweep time.
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
        async delete(k: string): Promise<void> { secrets.delete(k); },
        // Present because `engines.vscode` is `^1.105.0`, where `SecretStorage.keys()` is
        // finalized. `clearAll()` calls it unconditionally.
        async keys(): Promise<string[]> { return [...secrets.keys()]; }
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

  it("keeps two legacy macros that differ only in `runIn` — absorption must not collapse them (issue #48)", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    // `dedupeLegacyMacros()` runs on `keyOfLegacy()` BEFORE anything is
    // persisted, and `absorbLegacySettingsIfPresent()` then clears the legacy
    // scope — so whichever of the pair loses is gone for good. These two are
    // not near-duplicates: one types the URL into the session, the other opens
    // a browser window.
    vscode.__setConfig("nexus.terminal", {
      global: [
        { name: "BMC", text: "https://10.0.0.9/" },
        { name: "BMC", text: "https://10.0.0.9/", runIn: "browser" }
      ] as TerminalMacro[]
    });
    const { ctx } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.runIn).sort()).toEqual(["browser", undefined]);
  });

  it("still collapses two legacy macros whose `runIn` differs only in spelling", async () => {
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    // The other half of the rule: absent, explicit "session" and a corrupt
    // value all RUN in the session, so they are one macro and absorbing them
    // twice would multiply it on every startup.
    vscode.__setConfig("nexus.terminal", {
      global: [
        { name: "reload", text: "reload\n" },
        { name: "reload", text: "reload\n", runIn: "session" },
        { name: "reload", text: "reload\n", runIn: "nonsense" }
      ] as unknown as TerminalMacro[]
    });
    const { ctx } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    expect(store.getAll()).toHaveLength(1);
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

    // The vault value written before the guard fired is an orphan: no macro record names it,
    // in this window or the other one. It is still SWEEPABLE, because Complete Reset asks
    // `SecretStorage` which of this extension's keys exist rather than consulting a list this
    // path had to remember to write.
    const orphanKeys = [...secrets.keys()];
    expect(orphanKeys).toHaveLength(1);
    expect(orphanKeys[0]).toMatch(/^macro-secret-text-/);
    expect(store.getAll().some((m) => macroSecretKey(m.id!) === orphanKeys[0])).toBe(false);

    await store.clearAll();
    expect([...secrets.keys()]).toEqual([]);
  });

  it("absorbs legacy macros that differ only in trigger metadata or `slot` — the absorb dedupe is a ONE-WAY door", async () => {
    // `dedupeLegacyMacros()` collapses before anything is persisted, and
    // `absorbLegacySettingsIfPresent()` then clears `nexus.terminal.macros` from every scope.
    // So a record the dedupe key cannot tell apart from another is not "merged" — it is deleted
    // from the only place it existed. Two `Password:` responders scoped to different profiles,
    // or two shortcuts on different slots, are not one macro.
    //
    // Each pair below is identical on every other term, so restoring any single term to the
    // pre-fix key fails this test on its own.
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    vscode.__setConfig("nexus.terminal", {
      global: [
        { name: "Poll", text: "show status\n", triggerPattern: "#", triggerCooldown: 5 },
        { name: "Poll", text: "show status\n", triggerPattern: "#", triggerCooldown: 30 },
        { name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 60 },
        { name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: 300 },
        { name: "Reload", text: "reload\n", triggerPattern: "confirm" },
        { name: "Reload", text: "reload\n", triggerPattern: "confirm", triggerInitiallyDisabled: true },
        { name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "active-session" },
        { name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerScope: "all-terminals" },
        { name: "Scoped", text: "enable\n", triggerPattern: "Password:", triggerScope: "profile", triggerProfileId: "prod-1" },
        { name: "Scoped", text: "enable\n", triggerPattern: "Password:", triggerScope: "profile", triggerProfileId: "staging-1" },
        // The pattern itself, which the `Sep` pair below cannot pin (it differs in `text` too).
        { name: "Ack", text: "y\n", triggerPattern: "confirm:" },
        { name: "Ack", text: "y\n", triggerPattern: "proceed:" },
        { name: "Bounce", text: "bounce\n", slot: 1 },
        { name: "Bounce", text: "bounce\n", slot: 2 },
        { name: "Ping", text: "ping $host\n", variables: [{ name: "host", label: "Target host" }] },
        { name: "Ping", text: "ping $host\n", variables: [{ name: "host", label: "Jump host" }] },
        // A delimiter in a free-text field must not forge another record's key. The two terms
        // have to be ADJACENT in the key for a join to collide them, and `text` and
        // `triggerPattern` are: `x` + `p|q` and `x|p` + `q` both join to `…|x|p|q|…`, so with a
        // join the second of these is deleted from settings.json and never written anywhere.
        { name: "Sep", text: "x", triggerPattern: "p|q" },
        { name: "Sep", text: "x|p", triggerPattern: "q" }
      ] as TerminalMacro[]
    });
    const { ctx } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const all = store.getAll();
    expect(all).toHaveLength(18);
    const pick = (name: string) => all.filter((m) => m.name === name);
    expect(pick("Poll").map((m) => m.triggerCooldown).sort()).toEqual([30, 5]);
    expect(pick("Keepalive").map((m) => m.triggerInterval).sort()).toEqual([300, 60]);
    expect(pick("Reload").map((m) => m.triggerInitiallyDisabled === true).sort()).toEqual([false, true]);
    expect(pick("Enable").map((m) => m.triggerScope).sort()).toEqual(["active-session", "all-terminals"]);
    expect(pick("Scoped").map((m) => m.triggerProfileId).sort()).toEqual(["prod-1", "staging-1"]);
    // Migrated on the read path, which is what makes these two different macros rather than
    // two records that merely look different on disk.
    expect(pick("Bounce").map((m) => m.keybinding).sort()).toEqual(["alt+1", "alt+2"]);
    expect(pick("Ping").map((m) => m.variables?.[0].label).sort()).toEqual(["Jump host", "Target host"]);
    expect(pick("Ack").map((m) => m.triggerPattern).sort()).toEqual(["confirm:", "proceed:"]);
    expect(pick("Sep").map((m) => m.text).sort()).toEqual(["x", "x|p"]);
  });

  it("a legacy variable's ABSENT label and an EMPTY one are two different prompts, and the absorb keeps both", async () => {
    // `promptForValues()` sets `box.prompt = variable.label ?? variable.name`, so an absent
    // label asks for "host" and an empty one asks for nothing at all. Keying both as `""`
    // collapsed them — and this dedupe runs BEFORE `absorbLegacySettingsIfPresent()` clears
    // `nexus.terminal.macros` from every scope, so the loser was not merged into anything, it
    // was deleted from the only place it existed. The one-way direction is what makes this
    // worse than the duplicate direction: nothing the user can do afterwards brings it back.
    //
    // Neither shape can be produced by the macro editor or by an import (both drop an empty
    // label — macroEditorPanel.ts and `sanitizeImportedMacroVariables()`), which is exactly why
    // legacy absorption is where it has to be handled: a hand-written settings.json is the only
    // thing that makes one, and absorption is the only path that reads it.
    // The opposite direction is in the same fixture on purpose. A label the prompt path cannot
    // use — `toValidMacroVariable()` keeps only a string — asks the SAME question as no label at
    // all ("port", the variable's name), so those two records are one macro. A key that merely
    // told every DEFINED label apart from an absent one would satisfy the first pair while
    // absorbing this one twice, which is the wrong direction on the destructive path: absorption
    // clears `nexus.terminal.macros` afterwards.
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    vscode.__setConfig("nexus.terminal", {
      global: [
        { name: "Ping", text: "ping $host\n", variables: [{ name: "host" }] },
        { name: "Ping", text: "ping $host\n", variables: [{ name: "host", label: "" }] },
        { name: "Port", text: "port $port\n", variables: [{ name: "port" }] },
        { name: "Port", text: "port $port\n", variables: [{ name: "port", label: 42 }] }
      ] as unknown as TerminalMacro[]
    });
    const { ctx, state } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const all = store.getAll();
    expect(all).toHaveLength(3);
    expect(all.filter((m) => m.name === "Ping").map((m) => m.variables?.[0].label ?? "<absent>").sort())
      .toEqual(["", "<absent>"]);
    // First occurrence wins, so the survivor is the one with no label — and the unusable one is
    // what did NOT come through.
    expect(all.filter((m) => m.name === "Port").map((m) => m.variables?.[0].label ?? "<absent>"))
      .toEqual(["<absent>"]);
    // `withRedactedVariables()` keeps a non-string label verbatim, so the collapse is symmetric
    // across the persistence boundary and a Settings Sync replay of the same file absorbs nothing
    // further.
    expect((state.get("nexus.macros") as TerminalMacro[])).toHaveLength(3);
  });

  it("legacy cooldowns the trigger compiler cannot tell apart are absorbed once — and the ones it can are not", async () => {
    // `reload()` reads an explicit cooldown as `clampSeconds(value, DEFAULT, 0, 300)`, so the
    // key has to name the CLAMPED value rather than the number on disk. Two records the clamp
    // flattens together are one macro at runtime: absorbing both leaves two live rules with
    // identical timing, and for a `Password:` responder that is the password sent twice per
    // prompt — the same double-send this canonicalization exists to stop, arriving through the
    // one field that was still keyed verbatim.
    //
    // The clamp has THREE outcomes, not two, and the fixture pins all of them.
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    vscode.__setConfig("nexus.terminal", {
      global: [
        // Above the ceiling: both run at 300s.
        { name: "Poll", text: "show status\n", triggerPattern: "#", triggerCooldown: 300 },
        { name: "Poll", text: "show status\n", triggerPattern: "#", triggerCooldown: 301 },
        // Below the floor: both run at 0s.
        { name: "Floor", text: "f\n", triggerPattern: "more:", triggerCooldown: 0 },
        { name: "Floor", text: "f\n", triggerPattern: "more:", triggerCooldown: -5 },
        // Not a number at all: `clampSeconds()` hands both the shipped fallback, so a
        // hand-edited settings.json that quoted its cooldowns produces one macro, not two.
        { name: "Ack", text: "y\n", triggerPattern: "confirm:", triggerCooldown: "5" },
        { name: "Ack", text: "y\n", triggerPattern: "confirm:", triggerCooldown: "30" },
        // INSIDE the clamp two cooldowns are two macros — the collapse above must not widen
        // into this, which is the direction that silently deletes a record.
        { name: "Keep", text: "k\n", triggerPattern: ">", triggerCooldown: 5 },
        { name: "Keep", text: "k\n", triggerPattern: ">", triggerCooldown: 30 },
        // Absent is not the same as unusable: absent follows the `defaultCooldown` SETTING,
        // an unusable value pins the shipped constant, and the two part company the moment the
        // user changes that setting.
        { name: "Dflt", text: "d\n", triggerPattern: "confirm" },
        { name: "Dflt", text: "d\n", triggerPattern: "confirm", triggerCooldown: "nope" }
      ] as unknown as TerminalMacro[]
    });
    const { ctx } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const all = store.getAll();
    const pick = (name: string) => all.filter((m) => m.name === name);
    expect(all).toHaveLength(7);
    // First occurrence wins, so the survivor is the one the user listed first.
    expect(pick("Poll").map((m) => m.triggerCooldown)).toEqual([300]);
    expect(pick("Floor").map((m) => m.triggerCooldown)).toEqual([0]);
    expect(pick("Ack").map((m) => m.triggerCooldown)).toEqual(["5"]);
    expect(pick("Keep").map((m) => m.triggerCooldown).sort()).toEqual([30, 5]);
    expect(pick("Dflt").map((m) => m.triggerCooldown ?? "<absent>").sort()).toEqual(["<absent>", "nope"]);
  });

  it("legacy cooldowns and intervals that differ only below the millisecond the compiler multiplies to are absorbed once", async () => {
    // `reload()` does not store the seconds it reads, it stores `seconds * 1000` — and IEEE-754
    // multiplication is not injective. These two numbers are different, each survives a JSON round
    // trip as itself, and both sit inside every range the import path checks; their products are
    // the same double. Keying the SOURCE seconds therefore absorbed them as two macros whose
    // compiled rules are bit-identical, which for a `Password:` responder is one prompt answered
    // twice — the exact failure the canonicalization exists to prevent, arriving through the last
    // term that was still keyed as it is written rather than as it is compiled.
    const finer = 190.83296102825926;
    const coarser = 190.8329610282593;
    expect(finer).not.toBe(coarser);
    expect(JSON.parse(JSON.stringify([finer, coarser]))).toEqual([finer, coarser]);
    expect(finer * 1000).toBe(coarser * 1000);

    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    vscode.__setConfig("nexus.terminal", {
      global: [
        { name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerCooldown: finer },
        { name: "Enable", text: "enable\n", triggerPattern: "Password:", triggerCooldown: coarser },
        { name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: finer },
        { name: "Keepalive", text: " \n", triggerPattern: ">", triggerInterval: coarser }
      ] as TerminalMacro[]
    });
    const { ctx } = makeCtx();
    const store = new VscodeMacroStore(ctx);
    await store.initialize();

    const all = store.getAll();
    expect(all.map((m) => m.name)).toEqual(["Enable", "Keepalive"]);
    // First occurrence wins, and the survivor keeps the number the user wrote — the collapse is in
    // the KEY, not a rewrite of the record.
    expect(all[0].triggerCooldown).toBe(finer);
    expect(all[1].triggerInterval).toBe(finer);
  });

  it("legacy records neither the trigger compiler nor the prompt path can tell apart are absorbed once", async () => {
    // `variables: []` versus no `variables` key. Both runtime readers treat them identically —
    // §6.1's suppression is `Array.isArray && length > 0` and `getValidMacroVariables()` returns
    // `[]` for either — so keying them apart absorbs the same macro twice, and because neither
    // is suppressed BOTH copies compile a live `Password:` rule. `withRedactedVariables()` keeps
    // an empty array verbatim, so the empty shape is what lands on disk and the next activation
    // has to recognise the settings.json copy in it.
    //
    // An explicit `triggerScope: "all-terminals"` beside an absent one is the same collapse one
    // field over: `evaluate()` only ever tests for "active-session" and "profile".
    //
    // A `default` that is not a string is the third: `toValidMacroVariable()` discards it, so the
    // prompt prefills the same empty box it would with no default at all. It survives the
    // redaction boundary (only a MASKED variable's default is stripped), so both sides of the
    // comparison see it and the collapse cannot desync.
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const settings = [
      { name: "Enable", text: "enable\n", triggerPattern: "Password:", variables: [] },
      { name: "Enable", text: "enable\n", triggerPattern: "Password:" },
      { name: "Scope", text: "s\n", triggerPattern: "confirm:", triggerScope: "all-terminals" },
      { name: "Scope", text: "s\n", triggerPattern: "confirm:" },
      { name: "Ssh", text: "ssh $user\n", variables: [{ name: "user", default: 5 }] },
      { name: "Ssh", text: "ssh $user\n", variables: [{ name: "user" }] }
    ] as unknown as TerminalMacro[];
    vscode.__setConfig("nexus.terminal", { global: settings });
    const { ctx, state } = makeCtx();
    let store = new VscodeMacroStore(ctx);
    await store.initialize();

    expect(store.getAll().map((m) => m.name)).toEqual(["Enable", "Scope", "Ssh"]);
    // The empty array is what crossed the boundary, so the next activation compares the
    // settings.json shape against THAT.
    expect((state.get("nexus.macros") as TerminalMacro[])[0].variables).toEqual([]);
    // ...and so is the unusable default, which is what makes the collapse symmetric.
    expect((state.get("nexus.macros") as TerminalMacro[])[2].variables).toEqual([{ name: "user", default: 5 }]);

    vscode.__setConfig("nexus.terminal", { global: settings });
    store = new VscodeMacroStore(ctx);
    await store.initialize();
    expect(store.getAll().map((m) => m.name)).toEqual(["Enable", "Scope", "Ssh"]);
    expect(store.getLastAbsorbedCount()).toBe(0);
  });

  it("a legacy macro whose `keybinding` is not a string does not take activation down with it", async () => {
    // `keybinding: 1` is a plausible hand-edit — the slot number written into the field that
    // superseded it. Nothing on this path type-checks it: the non-object filter in
    // `absorbLegacySettingsIfPresent()` waves a well-formed object straight through, and
    // `keyOfLegacy()` then asks `getAssignedBinding()` for the record's effective binding.
    // With `normalizeBinding()` calling `.trim()` on whatever it was handed, that threw a
    // TypeError out of `initialize()` — which `extension.ts` awaits uncaught, so activation
    // failed outright. And it never self-healed: the throw happens before
    // `nexus.terminal.macros` is cleared, so the same record was still there on the next
    // start, and on every start after that.
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const settings = [{ name: "Bounce", text: "bounce\n", keybinding: 1 }] as unknown as TerminalMacro[];
    vscode.__setConfig("nexus.terminal", { global: settings });
    const { ctx } = makeCtx();
    let store = new VscodeMacroStore(ctx);
    await store.initialize();

    expect(store.getAll().map((m) => m.name)).toEqual(["Bounce"]);
    // An unusable value binds nothing, exactly as it does everywhere else that asks for the
    // effective binding — there is no slot here to fall back to.
    expect(getAssignedBinding(store.getAll()[0])).toBeUndefined();

    // ...and the record keys the same on both sides of the redaction boundary, so a Settings
    // Sync replay of the same value absorbs nothing further.
    vscode.__setConfig("nexus.terminal", { global: settings });
    store = new VscodeMacroStore(ctx);
    await store.initialize();
    expect(store.getAll().map((m) => m.name)).toEqual(["Bounce"]);
    expect(store.getLastAbsorbedCount()).toBe(0);
  });

  it("re-absorbing the identical settings does not multiply a macro across the redaction boundary", async () => {
    // The no-multiplication property, and the reason the widened key still cannot name
    // everything. The absorb runs on EVERY activation and Settings Sync can replay the cleared
    // setting back, so the key is compared between the settings.json copy and the copy already
    // on disk — which `persistLegacyMigration()` has run through `withRedactedVariables()`, and
    // whose secret text has moved to the vault leaving `text: ""` behind. A key that named a
    // masked variable's `default`, or a secret macro's text, would never match its own record
    // and would add a fresh copy of it on every single start.
    //
    // The fixture carries every shape that crosses that boundary at once: a secret macro, a
    // masked variable with a plaintext default, a legacy `slot`, and a full trigger
    // configuration. Absorbing three times must still be one of each.
    const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
    const settings = [
      {
        name: "Login",
        text: "hunter2\n",
        secret: true,
        slot: 1,
        triggerPattern: "Password:",
        triggerCooldown: 5,
        // Present so that "a full trigger configuration" really is full: without it an
        // implementation that mishandled the interval term ONLY across this boundary — the
        // one place the two sides of the comparison are not the same object — would still
        // pass, and would re-absorb this macro on every activation.
        triggerInterval: 60,
        triggerScope: "profile",
        triggerProfileId: "prod-1",
        triggerInitiallyDisabled: true
      },
      {
        name: "Ssh",
        text: "ssh $user@$host\n",
        variables: [
          { name: "user", label: "Username", default: "admin" },
          { name: "pass", label: "Password", secret: true, default: "hunter2", remember: true }
        ]
      }
    ] as unknown as TerminalMacro[];
    const { ctx, state } = makeCtx();

    vscode.__setConfig("nexus.terminal", { global: settings });
    let store = new VscodeMacroStore(ctx);
    await store.initialize();
    expect(store.getAll().map((m) => m.name)).toEqual(["Login", "Ssh"]);
    expect(store.getLastAbsorbedCount()).toBe(2);
    // The boundary really is being crossed: the masked default never reached globalState, and
    // the secret text moved to the vault.
    expect(JSON.stringify(state.get("nexus.macros"))).not.toContain("hunter2");

    for (let run = 0; run < 2; run++) {
      vscode.__setConfig("nexus.terminal", { global: settings });
      store = new VscodeMacroStore(ctx);
      await store.initialize();
      expect(store.getAll().map((m) => m.name)).toEqual(["Login", "Ssh"]);
      expect(store.getLastAbsorbedCount()).toBe(0);
    }

    // ...and the secret survived all of it, under one id.
    const login = store.getAll().find((m) => m.name === "Login")!;
    expect(login.text).toBe("hunter2\n");
    expect(login.keybinding).toBe("alt+1");
    expect(store.getAll().find((m) => m.name === "Ssh")!.variables).toEqual([
      { name: "user", label: "Username", default: "admin" },
      { name: "pass", label: "Password", secret: true }
    ]);
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

    it("a '..' path-traversal group from legacy settings is absorbed as written, and renders as ungrouped", async () => {
      // Absorption is the one moment this value crosses from settings.json
      // into permanent storage. Dropping it here loses the user's stated
      // intent for a macro they are migrating; sanitizing it at every READ
      // site is what stops it ever rendering as a `..` folder.
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        global: [{ name: "a", text: "echo a", group: "../secrets" } as TerminalMacro]
      });
      const { ctx } = makeCtx();
      const store = new VscodeMacroStore(ctx);

      await store.initialize();

      expect(store.getAll()[0].group).toBe("../secrets");
      expect(macroGroup(store.getAll()[0])).toBeUndefined();
    });

    it("a pathologically long SINGLE-SEGMENT group from legacy settings never renders, and absorption does not hang", async () => {
      // `group: "X".repeat(8_000_000)` has a segment count of 1 — comfortably
      // under MAX_FOLDER_DEPTH — so only a length bound catches it, and that
      // bound lives at the read site where it rejects in O(1).
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      const huge = "X".repeat(8_000_000);
      vscode.__setConfig("nexus.terminal", {
        global: [{ name: "a", text: "echo a", group: huge } as TerminalMacro]
      });
      const { ctx } = makeCtx();
      const store = new VscodeMacroStore(ctx);

      await expect(store.initialize()).resolves.toBeUndefined();

      expect(macroGroup(store.getAll()[0])).toBeUndefined();
      expect(store.getAll()[0].group).toHaveLength(8_000_000);
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

  describe("A1 — capability flags never survive legacy-settings absorption (issue #48 PR-B)", () => {
    // The strip lives in `sanitizeImportedMacro` (backup/share import) AND now the
    // absorb path (`persistLegacyMigration`), sharing ONE field list
    // (`stripImportedCapabilityFields`). `nexus.terminal.macros` values are
    // attacker-controllable — a checked-in `.vscode/settings.json` reaches
    // `workspaceValue`/`workspaceFolderValue`, a Settings Sync replay reaches
    // `globalValue` — so an armed `provideIpmiCredentials: true` reaching the store
    // would inject the fleet-wide BMC password with no checkbox ever ticked.

    it("strips provideIpmiCredentials from an absorbed GLOBAL-value macro — field ABSENT, not false", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        global: [
          { name: "BMC power", text: "ipmitool -E chassis power status\n", runIn: "localTerminal", provideIpmiCredentials: true }
        ] as TerminalMacro[]
      });
      const { ctx, state } = makeCtx();
      const store = new VscodeMacroStore(ctx);
      await store.initialize();

      const persisted = state.get("nexus.macros") as TerminalMacro[];
      const m = persisted.find((r) => r.name === "BMC power")!;
      expect("provideIpmiCredentials" in m).toBe(false);
      expect(store.getAll().find((r) => r.name === "BMC power")!.provideIpmiCredentials).toBeUndefined();
      // The rest of the record is intact — the strip is surgical, not a rewrite.
      expect(m.runIn).toBe("localTerminal");
    });

    it("strips `route` from an absorbed WORKSPACE-value macro — field ABSENT", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        workspace: [
          { name: "Gateway run", text: "reload\n", route: "ipmi-gateway" } as unknown as TerminalMacro
        ]
      });
      const { ctx, state } = makeCtx();
      const store = new VscodeMacroStore(ctx);
      await store.initialize();

      const persisted = state.get("nexus.macros") as TerminalMacro[];
      const m = persisted.find((r) => r.name === "Gateway run")!;
      expect("route" in m).toBe(false);
    });

    it("strips provideIpmiCredentials: FALSE too — the strip deletes, never normalizes (guards against a `=== true`-only fix)", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      vscode.__setConfig("nexus.terminal", {
        global: [
          { name: "Explicit off", text: "echo hi\n", runIn: "localTerminal", provideIpmiCredentials: false }
        ] as TerminalMacro[]
      });
      const { ctx, state } = makeCtx();
      const store = new VscodeMacroStore(ctx);
      await store.initialize();

      const persisted = state.get("nexus.macros") as TerminalMacro[];
      const m = persisted.find((r) => r.name === "Explicit off")!;
      // A stored `false` re-exports a decision the user never made, so it must be
      // absent, not `false`.
      expect("provideIpmiCredentials" in m).toBe(false);
    });

    it("does NOT strip an already-persisted existing record — the existing half stays byte-for-byte, no activation-time rewrite", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      const { ctx, state } = makeCtx();
      // An armed flag already in globalState (reachable only via a prior absorb, which
      // this fix now prevents going forward). Widening the strip to `keyed.existing`
      // would turn this into an activation-time write of user data — the class of write
      // the existing-half branch deliberately removed.
      state.set("nexus.macros", [
        { id: "kept", name: "Existing armed", text: "ipmitool -E chassis power status\n", runIn: "localTerminal", provideIpmiCredentials: true }
      ] as TerminalMacro[]);
      // An unrelated legacy macro so persistLegacyMigration actually runs.
      vscode.__setConfig("nexus.terminal", { global: [{ name: "new", text: "echo new" }] as TerminalMacro[] });

      const store = new VscodeMacroStore(ctx);
      await store.initialize();

      const persisted = state.get("nexus.macros") as TerminalMacro[];
      const existing = persisted.find((m) => m.id === "kept")!;
      expect(existing.provideIpmiCredentials).toBe(true); // untouched
      expect(persisted.map((m) => m.name).sort()).toEqual(["Existing armed", "new"]);
    });

    it("passes a non-object legacy record through verbatim while still stripping a sibling armed macro", async () => {
      const vscode = await import("vscode") as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void };
      const { ctx, state } = makeCtx();
      state.set("nexus.macros", [null]);
      vscode.__setConfig("nexus.terminal", {
        global: [
          { name: "Armed", text: "ipmitool -E chassis power status\n", runIn: "localTerminal", provideIpmiCredentials: true }
        ] as TerminalMacro[]
      });

      const store = new VscodeMacroStore(ctx);
      await store.initialize();

      const persisted = state.get("nexus.macros") as unknown[];
      expect(persisted[0]).toBeNull(); // non-object survives the map verbatim
      const armed = (persisted as TerminalMacro[]).find((m) => m && m.name === "Armed")!;
      expect("provideIpmiCredentials" in armed).toBe(false);
    });
  });
});
