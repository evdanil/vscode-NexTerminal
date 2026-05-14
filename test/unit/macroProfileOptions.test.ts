import { describe, expect, it } from "vitest";
import { buildMacroProfileInputsFromSnapshot, buildMacroProfileSelectOptions } from "../../src/ui/macroProfileOptions";

describe("buildMacroProfileSelectOptions", () => {
  it("labels Local Shell profiles distinctly in the macro profile picker", () => {
    expect(buildMacroProfileSelectOptions([
      { id: "local-1", name: "Project Shell", kind: "localShell" as never }
    ])).toEqual([
      {
        id: "local-1",
        name: "Project Shell",
        kind: "localShell",
        label: "Project Shell (Local Shell)"
      }
    ]);
  });
});

describe("buildMacroProfileInputsFromSnapshot", () => {
  it("includes servers, serial profiles, and Local Shell profiles for macro scoping", () => {
    expect(buildMacroProfileInputsFromSnapshot({
      servers: [{ id: "server-1", name: "Router" }],
      serialProfiles: [{ id: "serial-1", name: "Console" }],
      localShellProfiles: [{ id: "local-1", name: "Project Shell" }]
    })).toEqual([
      { id: "server-1", name: "Router", kind: "server" },
      { id: "serial-1", name: "Console", kind: "serial" },
      { id: "local-1", name: "Project Shell", kind: "localShell" }
    ]);
  });
});
