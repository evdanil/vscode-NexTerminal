import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } }));

import { HighlightProfileService } from "../../src/services/terminal/highlightProfileService";
import { TerminalHighlighter } from "../../src/services/terminalHighlighter";
import { PtyObserverHub } from "../../src/services/terminal/ptyObserverHub";
import type { HighlightCatalog } from "../../src/models/highlightProfile";

function catalog(): HighlightCatalog {
  return { enabled: true, legacy: false, defaultProfileId: "red", profiles: [
    { id: "red", name: "Red", rules: [{ pattern: "ERROR", color: "red" }] },
    { id: "blue", name: "Blue", rules: [{ pattern: "WARN", color: "blue" }] }
  ] };
}

describe("HighlightProfileService", () => {
  it("isolates overrides on sessions sharing one saved connection", () => {
    const service = new HighlightProfileService(() => catalog());
    const a = service.createSession({ kind: "server", id: "x" }, "red");
    const b = service.createSession({ kind: "server", id: "x" }, "red");
    b.setOverride({ mode: "override", selection: "blue" });
    expect(a.apply("ERROR WARN")).toBe("\x1b[31mERROR\x1b[39m WARN");
    expect(b.apply("ERROR WARN")).toBe("ERROR \x1b[34mWARN\x1b[39m");
    a.dispose(); b.dispose();
  });

  it("resolves missing and none without falling back to the global rules", () => {
    const service = new HighlightProfileService(() => catalog());
    const h = service.createSession(undefined, "missing");
    expect(h.getSelection().missingProfileId).toBe("missing");
    expect(h.apply("ERROR")).toBe("ERROR");
    h.setOverride({ mode: "override", selection: null });
    expect(h.isEnabled()).toBe(false);
    const emitted: string[] = [];
    const hub = new PtyObserverHub();
    hub.notifyOutput("ERROR", h.createStream(x => emitted.push(x)), h, x => emitted.push(x));
    expect(emitted).toEqual(["ERROR"]);
    h.dispose();
  });

  it("uses the new selection for a buffered fragment without losing bytes", () => {
    const service = new HighlightProfileService(() => catalog());
    const h = service.createSession(undefined, "red");
    const emitted: string[] = [];
    const stream = h.createStream(x => emitted.push(x));
    stream.push("WA");
    h.setOverride({ mode: "override", selection: "blue" });
    stream.push("RN\n");
    expect(emitted).toEqual(["\x1b[34mWARN\x1b[39m\n"]);
    stream.dispose(); h.dispose();
  });

  it("flushes pending bytes before direct output after selecting none", () => {
    const service = new HighlightProfileService(() => catalog());
    const h = service.createSession(undefined, "red");
    const emitted: string[] = [];
    const stream = h.createStream(text => emitted.push(text));
    const hub = new PtyObserverHub();
    hub.notifyOutput("ER", stream, h, text => emitted.push(text));
    h.setOverride({ mode: "override", selection: null });
    hub.notifyOutput("ROR", stream, h, text => emitted.push(text));
    expect(emitted).toEqual(["ER", "ROR"]);
    stream.dispose(); h.dispose();
  });

  it("does not execute inactive profile expressions", () => {
    const service = new HighlightProfileService(() => catalog());
    const h = service.createSession(undefined, "red");
    const exec = vi.spyOn(RegExp.prototype, "exec");
    expect(h.apply("ERROR WARN")).toBe("\x1b[31mERROR\x1b[39m WARN");
    expect(exec.mock.instances.some(re => (re as RegExp).source === "WARN")).toBe(false);
    exec.mockRestore(); h.dispose();
  });

  it("caches a shared profile and only recompiles when its rules change", () => {
    let current = catalog();
    const compile = vi.spyOn(TerminalHighlighter.prototype, "reload");
    const service = new HighlightProfileService(() => current);
    const a = service.createSession(undefined, "red");
    const b = service.createSession(undefined, "red");
    expect(a.apply("ERROR")).toContain("\x1b[31mERROR");
    expect(b.apply("ERROR")).toContain("\x1b[31mERROR");
    expect(compile).toHaveBeenCalledTimes(1);
    current = { ...current, profiles: current.profiles.map(p => ({ ...p, name: p.name + " renamed" })) };
    service.reload();
    a.apply("ERROR");
    expect(compile).toHaveBeenCalledTimes(1);
    current = { ...current, profiles: current.profiles.map(p => p.id === "red" ? { ...p, rules: [{ pattern: "ERROR", color: "green" }] } : p) };
    service.reload();
    expect(a.apply("ERROR")).toBe("\x1b[32mERROR\x1b[39m");
    expect(compile).toHaveBeenCalledTimes(2);
    compile.mockRestore(); a.dispose(); b.dispose();
  });

  it("does not reread or serialize the catalog while rendering repeated chunks", () => {
    const read = vi.fn(catalog);
    const service = new HighlightProfileService(read);
    const h = service.createSession(undefined, "red");
    h.apply("ERROR");
    const stringify = vi.spyOn(JSON, "stringify");
    for (let i = 0; i < 100; i++) h.apply("ERROR");
    expect(read).toHaveBeenCalledTimes(1);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore(); h.dispose();
  });

  it("applies default and master switch changes to existing sessions", () => {
    let current = catalog();
    const service = new HighlightProfileService(() => current);
    const h = service.createSession();
    expect(h.apply("ERROR")).toBe("\x1b[31mERROR\x1b[39m");
    current = { ...current, defaultProfileId: "blue" };
    service.reload();
    expect(h.apply("WARN")).toBe("\x1b[34mWARN\x1b[39m");
    current = { ...current, enabled: false };
    service.reload();
    expect(h.apply("WARN")).toBe("WARN");
    current = { ...current, enabled: true, profiles: [] };
    service.reload();
    expect(h.apply("ERROR WARN")).toBe("ERROR WARN");
    expect(h.getSelection().missingProfileId).toBe("blue");
    h.dispose();
  });

  it("counts live sessions using a profile and removes closed sessions", () => {
    const service = new HighlightProfileService(() => catalog());
    const inherited = service.createSession();
    const explicit = service.createSession(undefined, "red");
    const other = service.createSession(undefined, "blue");
    service.updateSavedSelections({ servers: [{ id: "x", highlightProfileId: "red" }], serialProfiles: [], localShellProfiles: [{ id: "shell", highlightProfileId: "red" }], localServers: [] });
    expect(service.countProfileReferences("red")).toEqual({ saved: 2, live: 2 });
    explicit.dispose();
    expect(service.countProfileReferences("red")).toEqual({ saved: 2, live: 1 });
    inherited.dispose(); other.dispose();
  });

  it("counts saved connections inheriting the deleted global default, but excludes none", () => {
    let current = catalog();
    const service = new HighlightProfileService(() => current);
    service.updateSavedSelections({
      servers: [{ id: "inherit" }, { id: "none", highlightProfileId: null }, { id: "explicit", highlightProfileId: "red" }],
      serialProfiles: [{ id: "serial" }], localShellProfiles: [], localServers: []
    });
    expect(service.countProfileReferences("red").saved).toBe(3);
    expect(service.countProfileReferences("blue").saved).toBe(0);
    current = { ...current, defaultProfileId: "blue" };
    service.reload();
    expect(service.countProfileReferences("red").saved).toBe(1);
    expect(service.countProfileReferences("blue").saved).toBe(2);
  });

  it("reports current missing live selections and retained saved IDs for import collision checks", () => {
    let current = { ...catalog(), defaultProfileId: "missing-default" };
    const service = new HighlightProfileService(() => current);
    const session = service.createSession({ kind: "server", id: "deleted-owner" }, "missing-saved");
    session.setOverride({ mode: "override", selection: "missing-override" });
    service.updateSavedSelections({ servers: [{ id: "other", highlightProfileId: "saved-record" }], serialProfiles: [], localShellProfiles: [], localServers: [] });
    expect([...service.getReferencedProfileIds()].sort()).toEqual(["missing-default", "missing-override", "missing-saved", "saved-record"]);
    session.setOverride({ mode: "override", selection: null });
    current = { ...current, defaultProfileId: "new-default" };
    service.reload();
    expect([...service.getReferencedProfileIds()].sort()).toEqual(["missing-saved", "new-default", "saved-record"]);
    session.dispose();
    service.updateSavedSelections({ servers: [], serialProfiles: [], localShellProfiles: [], localServers: [] });
    expect([...service.getReferencedProfileIds()]).toEqual(["new-default"]);
  });

  it("updates saved settings while retaining a deleted owner's last selection", () => {
    const service = new HighlightProfileService(() => catalog());
    const h = service.createSession({ kind: "server", id: "x" }, "red");
    service.updateSavedSelections({ servers: [{ id: "x", highlightProfileId: "blue" }], serialProfiles: [], localShellProfiles: [], localServers: [] });
    expect(h.apply("WARN")).toBe("\x1b[34mWARN\x1b[39m");
    service.updateSavedSelections({ servers: [], serialProfiles: [], localShellProfiles: [], localServers: [] });
    expect(h.apply("WARN")).toBe("\x1b[34mWARN\x1b[39m");
    h.dispose();
  });
});
