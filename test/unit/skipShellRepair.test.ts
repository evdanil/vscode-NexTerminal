import { describe, expect, it } from "vitest";
import { planSkipShellRepair } from "../../src/services/terminal/skipShellRepair";

// The commands Nexus requires in the skip-shell list
const REQUIRED = ["nexus.macro.run", "nexus.macro.runBinding"];

// Opaque target type — use strings to keep tests readable without vscode stubs
type Target = "global" | "workspace" | "workspaceFolder";

function levels(
  global?: string[],
  workspace?: string[],
  workspaceFolder?: string[]
): Array<{ value: string[] | undefined; target: Target }> {
  return [
    { value: global, target: "global" },
    { value: workspace, target: "workspace" },
    { value: workspaceFolder, target: "workspaceFolder" },
  ];
}

describe("planSkipShellRepair", () => {
  describe("orphan removal", () => {
    it("drops nexus.macro.slot from a level that contains it", () => {
      const writes = planSkipShellRepair(
        levels(["nexus.macro.slot", ...REQUIRED]),
        [...REQUIRED],
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].target).toBe("global");
      expect(writes[0].value).not.toContain("nexus.macro.slot");
      expect(writes[0].value).toEqual(expect.arrayContaining(REQUIRED));
    });

    it("drops orphan and also appends the missing required command in one write", () => {
      const writes = planSkipShellRepair(
        levels(["nexus.macro.slot", "nexus.macro.run"]),
        ["nexus.macro.slot", "nexus.macro.run"],
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).not.toContain("nexus.macro.slot");
      expect(writes[0].value).toContain("nexus.macro.runBinding");
      expect(writes[0].value).toContain("nexus.macro.run");
    });
  });

  describe("missing command append", () => {
    it("appends missing commands to a level that has a partial list", () => {
      const writes = planSkipShellRepair(
        levels(["nexus.macro.run"]),
        ["nexus.macro.run"],
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toContain("nexus.macro.run");
      expect(writes[0].value).toContain("nexus.macro.runBinding");
    });

    it("appends missing commands at the end, preserving existing order", () => {
      const existing = ["other.cmd", "nexus.macro.run"];
      const writes = planSkipShellRepair(
        levels(existing),
        existing,
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toEqual(["other.cmd", "nexus.macro.run", "nexus.macro.runBinding"]);
    });
  });

  describe("no write when already correct", () => {
    it("emits no write for a level that already contains all required commands and no orphans", () => {
      const writes = planSkipShellRepair(
        levels([...REQUIRED, "other.cmd"]),
        [...REQUIRED, "other.cmd"],
        REQUIRED
      );
      expect(writes).toHaveLength(0);
    });

    it("emits no write when the level is already exactly the required set", () => {
      const writes = planSkipShellRepair(
        levels([...REQUIRED]),
        [...REQUIRED],
        REQUIRED
      );
      expect(writes).toHaveLength(0);
    });
  });

  describe("user entries preserved verbatim", () => {
    it("preserves dash-prefixed removal entries in the user value", () => {
      const userValue = ["-workbench.action.focusActiveEditorGroup", ...REQUIRED];
      const writes = planSkipShellRepair(
        levels(userValue),
        [...REQUIRED], // effective value won't include the removal
        REQUIRED
      );
      // No change needed — all required commands present, no orphans
      expect(writes).toHaveLength(0);
    });

    it("preserves other third-party entries and only appends what is missing", () => {
      const userValue = ["other.extension.command", "nexus.macro.run"];
      const writes = planSkipShellRepair(
        levels(userValue),
        userValue,
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toContain("other.extension.command");
      expect(writes[0].value).toContain("nexus.macro.run");
      expect(writes[0].value).toContain("nexus.macro.runBinding");
    });
  });

  describe("multi-level patching", () => {
    it("patches only the levels that need changes", () => {
      const writes = planSkipShellRepair(
        [
          { value: [...REQUIRED], target: "global" },           // already correct — no write
          { value: ["nexus.macro.slot"], target: "workspace" }, // needs orphan removal + append
          { value: undefined, target: "workspaceFolder" },      // skipped
        ],
        [...REQUIRED],
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].target).toBe("workspace");
    });

    it("patches all levels that need changes", () => {
      const writes = planSkipShellRepair(
        [
          { value: ["nexus.macro.slot", "nexus.macro.run"], target: "global" },
          { value: ["nexus.macro.run"], target: "workspace" },
          { value: undefined, target: "workspaceFolder" },
        ],
        ["nexus.macro.run"],
        REQUIRED
      );
      expect(writes).toHaveLength(2);
      const targets = writes.map((w) => w.target);
      expect(targets).toContain("global");
      expect(targets).toContain("workspace");
    });
  });

  describe("fallback path (no user-level value anywhere)", () => {
    it("emits a single global-fallback write when commands are missing from effective value", () => {
      const writes = planSkipShellRepair(
        levels(undefined, undefined, undefined),
        ["workbench.action.terminal.clear"], // effective: has other commands but not ours
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].target).toBe("global-fallback");
      // Must include the existing effective entries (to preserve other extensions' contributions)
      expect(writes[0].value).toContain("workbench.action.terminal.clear");
      expect(writes[0].value).toContain("nexus.macro.run");
      expect(writes[0].value).toContain("nexus.macro.runBinding");
    });

    it("emits no write in fallback path when all commands already in effective value", () => {
      const writes = planSkipShellRepair(
        levels(undefined, undefined, undefined),
        [...REQUIRED, "workbench.action.terminal.clear"],
        REQUIRED
      );
      expect(writes).toHaveLength(0);
    });

    it("does NOT use fallback path when at least one level has a value", () => {
      // Even if workspace has a value, the global-fallback branch must not fire
      const writes = planSkipShellRepair(
        [
          { value: undefined, target: "global" },
          { value: [...REQUIRED], target: "workspace" },
          { value: undefined, target: "workspaceFolder" },
        ],
        [...REQUIRED],
        REQUIRED
      );
      // workspace already correct → no write; no fallback write either
      expect(writes).toHaveLength(0);
      const targets = writes.map((w) => w.target);
      expect(targets).not.toContain("global-fallback");
    });
  });

  describe("empty required commands list", () => {
    it("emits no writes when no commands are required", () => {
      const writes = planSkipShellRepair(
        levels(["some.command"]),
        ["some.command"],
        []
      );
      expect(writes).toHaveLength(0);
    });
  });

  describe("non-string entry sanitization", () => {
    it("drops non-string entries when repairing a corrupted level", () => {
      const writes = planSkipShellRepair(
        levels([{}, {}, "nexus.macro.run"] as unknown as string[]),
        ["nexus.macro.run"],
        REQUIRED
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toEqual(["nexus.macro.run", "nexus.macro.runBinding"]);
      expect(writes[0].value.every((v) => typeof v === "string")).toBe(true);
    });
  });
});
