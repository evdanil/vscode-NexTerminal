import { describe, expect, it } from "vitest";
import type { ColorScheme } from "../../src/models/colorScheme";
import { ColorSchemeService, InMemoryColorSchemeStorage, type ColorSchemeStorage } from "../../src/services/colorSchemeService";
import { BUILTIN_SCHEMES } from "../../src/services/builtinSchemes";

describe("ColorSchemeService", () => {
  function createService(userSchemes: ColorScheme[] = [], activeId = "") {
    const storage = new InMemoryColorSchemeStorage(userSchemes, activeId);
    return new ColorSchemeService(storage);
  }

  it("getAllSchemes returns built-in + user schemes", () => {
    const userScheme: ColorScheme = { ...BUILTIN_SCHEMES[0], id: "custom-1", name: "Custom", builtIn: false };
    const service = createService([userScheme]);
    const all = service.getAllSchemes();
    expect(all.length).toBe(BUILTIN_SCHEMES.length + 1);
    expect(all.find(s => s.id === "custom-1")).toBeTruthy();
  });

  it("addSchemes persists user schemes", async () => {
    const storage = new InMemoryColorSchemeStorage();
    const service = new ColorSchemeService(storage);
    const scheme: ColorScheme = { ...BUILTIN_SCHEMES[0], id: "new-1", name: "New", builtIn: false };
    await service.addSchemes([scheme]);
    expect(service.getAllSchemes().find(s => s.id === "new-1")).toBeTruthy();
  });

  it("removeScheme removes user scheme", async () => {
    const scheme: ColorScheme = { ...BUILTIN_SCHEMES[0], id: "del-1", name: "Del", builtIn: false };
    const service = createService([scheme]);
    await service.removeScheme("del-1");
    expect(service.getAllSchemes().find(s => s.id === "del-1")).toBeUndefined();
  });

  it("removeScheme refuses to delete built-in scheme", async () => {
    const service = createService();
    const builtInId = BUILTIN_SCHEMES[0].id;
    await service.removeScheme(builtInId);
    expect(service.getAllSchemes().find(s => s.id === builtInId)).toBeTruthy();
  });

  it("getActiveSchemeId returns stored active id", () => {
    const service = createService([], "builtin-dracula");
    expect(service.getActiveSchemeId()).toBe("builtin-dracula");
  });

  it("setActiveSchemeId persists the active id", async () => {
    const storage = new InMemoryColorSchemeStorage();
    const service = new ColorSchemeService(storage);
    await service.setActiveSchemeId("builtin-nord");
    expect(service.getActiveSchemeId()).toBe("builtin-nord");
  });

  it("getSchemeById finds built-in scheme", () => {
    const service = createService();
    const scheme = service.getSchemeById("builtin-catppuccin-mocha");
    expect(scheme).toBeTruthy();
    expect(scheme!.name).toBe("Catppuccin Mocha");
  });

  it("removeScheme clears active id when removing active scheme", async () => {
    const scheme: ColorScheme = { ...BUILTIN_SCHEMES[0], id: "active-del", name: "Active", builtIn: false };
    const service = createService([scheme], "active-del");
    await service.removeScheme("active-del");
    expect(service.getActiveSchemeId()).toBe("");
  });

  it("reset drops user schemes, the selection and the font in memory and in storage", async () => {
    const storage = new InMemoryColorSchemeStorage([{ id: "u1", name: "U", source: "user" } as unknown as ColorScheme], "u1", { family: "Fira", size: 12, weight: "normal" });
    const service = new ColorSchemeService(storage);

    await service.reset();

    expect(service.getAllSchemes()).toEqual(BUILTIN_SCHEMES);
    expect(service.getActiveSchemeId()).toBe("");
    expect(service.getFontConfig()).toBeUndefined();
    expect(storage.getUserSchemes()).toEqual([]);
    expect(storage.getActiveSchemeId()).toBe("");
    expect(storage.getFontConfig()).toBeUndefined();
  });

  it("a panel action taken while a reset awaits storage is queued behind it and applies to the emptied store (⊘ interleaving, where the reset's late clear erases the new scheme from storage while memory still shows it)", async () => {
    const stored = { schemes: [{ id: "old" } as unknown as ColorScheme], active: "old" };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const storage: ColorSchemeStorage = {
      getUserSchemes: () => [...stored.schemes],
      saveUserSchemes: async (v) => { stored.schemes = [...v]; },
      getActiveSchemeId: () => stored.active,
      saveActiveSchemeId: async (v) => { stored.active = v; },
      getFontConfig: () => undefined,
      saveFontConfig: async () => undefined,
      // The reset's first update is held pending.
      clearAll: async () => { await held; stored.schemes = []; stored.active = ""; }
    };
    const service = new ColorSchemeService(storage);

    const reset = service.reset();
    const added = service.addSchemes([{ id: "fresh" } as unknown as ColorScheme]);
    await Promise.resolve();
    release();
    await Promise.all([reset, added]);

    // Intended semantics: the action ran AFTER the reset, on a clean store, so it survives — and nothing from before does.
    expect(stored.schemes).toEqual([{ id: "fresh" }]);
    expect(service.getAllSchemes().filter((s) => s.id === "old")).toEqual([]);
    expect(service.getAllSchemes().some((s) => s.id === "fresh")).toBe(true);
  });

  it("removing the active scheme still clears the selection (the chained mutators do not wait on themselves)", async () => {
    const storage = new InMemoryColorSchemeStorage([{ id: "u1" } as unknown as ColorScheme], "u1");
    const service = new ColorSchemeService(storage);
    await service.removeScheme("u1");
    expect(service.getActiveSchemeId()).toBe("");
  });
});
