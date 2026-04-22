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
});
