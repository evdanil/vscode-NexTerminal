import { describe, expect, it } from "vitest";
import type { ColorScheme } from "../../src/models/colorScheme";
import { ColorSchemeService, InMemoryColorSchemeStorage } from "../../src/services/colorSchemeService";
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
});
