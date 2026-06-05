import { describe, expect, it } from "vitest";
import {
  detectMacroKeybindingBlockers,
  MNEMONICS_BLOCKER,
  SEND_KEYBINDINGS_BLOCKER,
  SKIP_SHELL_BLOCKER,
  type MacroKeybindingEnvironment
} from "../../src/services/terminal/macroKeybindingBlockers";

// Mirrors MACRO_SKIP_SHELL_COMMANDS in extension.ts.
const REQUIRED = ["nexus.macro.run", "nexus.macro.runBinding"];

/** Build an environment, defaulting every field to a healthy value. */
function env(overrides: Partial<MacroKeybindingEnvironment> = {}): MacroKeybindingEnvironment {
  return {
    sendKeybindingsToShell: false,
    commandsToSkipShell: [...REQUIRED],
    enableMenuBarMnemonics: false,
    requiredCommands: REQUIRED,
    ...overrides
  };
}

describe("detectMacroKeybindingBlockers", () => {
  it("returns [] for a healthy environment", () => {
    expect(detectMacroKeybindingBlockers(env())).toEqual([]);
  });

  it("treats a skip list with extra unrelated entries as healthy", () => {
    expect(
      detectMacroKeybindingBlockers(
        env({ commandsToSkipShell: ["editor.action.foo", ...REQUIRED, "workbench.action.bar"] })
      )
    ).toEqual([]);
  });

  describe("single blockers", () => {
    it("flags sendKeybindingsToShell === true", () => {
      expect(detectMacroKeybindingBlockers(env({ sendKeybindingsToShell: true }))).toEqual([
        SEND_KEYBINDINGS_BLOCKER
      ]);
    });

    it("flags a skip list missing all required commands", () => {
      expect(detectMacroKeybindingBlockers(env({ commandsToSkipShell: [] }))).toEqual([
        SKIP_SHELL_BLOCKER
      ]);
    });

    it("flags a skip list missing one required command", () => {
      expect(
        detectMacroKeybindingBlockers(env({ commandsToSkipShell: ["nexus.macro.run"] }))
      ).toEqual([SKIP_SHELL_BLOCKER]);
    });

    it("flags enableMenuBarMnemonics === true", () => {
      expect(detectMacroKeybindingBlockers(env({ enableMenuBarMnemonics: true }))).toEqual([
        MNEMONICS_BLOCKER
      ]);
    });
  });

  describe("priority order in combinations", () => {
    it("orders sendKeybindings before skip-shell before mnemonics", () => {
      expect(
        detectMacroKeybindingBlockers(
          env({
            sendKeybindingsToShell: true,
            commandsToSkipShell: [],
            enableMenuBarMnemonics: true
          })
        )
      ).toEqual([SEND_KEYBINDINGS_BLOCKER, SKIP_SHELL_BLOCKER, MNEMONICS_BLOCKER]);
    });

    it("orders skip-shell before mnemonics when sendKeybindings is healthy", () => {
      expect(
        detectMacroKeybindingBlockers(
          env({ commandsToSkipShell: [], enableMenuBarMnemonics: true })
        )
      ).toEqual([SKIP_SHELL_BLOCKER, MNEMONICS_BLOCKER]);
    });

    it("orders sendKeybindings before mnemonics when skip list is healthy", () => {
      expect(
        detectMacroKeybindingBlockers(
          env({ sendKeybindingsToShell: true, enableMenuBarMnemonics: true })
        )
      ).toEqual([SEND_KEYBINDINGS_BLOCKER, MNEMONICS_BLOCKER]);
    });
  });

  describe("corrupt / non-canonical types", () => {
    it("does not flag the string \"true\" for sendKeybindingsToShell", () => {
      expect(
        detectMacroKeybindingBlockers(env({ sendKeybindingsToShell: "true" }))
      ).toEqual([]);
    });

    it("does not flag the string \"true\" for enableMenuBarMnemonics", () => {
      expect(
        detectMacroKeybindingBlockers(env({ enableMenuBarMnemonics: "true" }))
      ).toEqual([]);
    });

    it("does not flag the number 1 for either boolean setting", () => {
      expect(
        detectMacroKeybindingBlockers(
          env({ sendKeybindingsToShell: 1, enableMenuBarMnemonics: 1 })
        )
      ).toEqual([]);
    });

    it("does not flag null for either boolean setting", () => {
      expect(
        detectMacroKeybindingBlockers(
          env({ sendKeybindingsToShell: null, enableMenuBarMnemonics: null })
        )
      ).toEqual([]);
    });

    it("treats a non-array skip list as missing all required commands", () => {
      expect(
        detectMacroKeybindingBlockers(env({ commandsToSkipShell: "nexus.macro.run" }))
      ).toEqual([SKIP_SHELL_BLOCKER]);
    });

    it("treats null skip list as missing all required commands", () => {
      expect(detectMacroKeybindingBlockers(env({ commandsToSkipShell: null }))).toEqual([
        SKIP_SHELL_BLOCKER
      ]);
    });

    it("treats an array with non-string entries as missing the required commands", () => {
      expect(
        detectMacroKeybindingBlockers(env({ commandsToSkipShell: [1, 2, 3] }))
      ).toEqual([SKIP_SHELL_BLOCKER]);
    });

    it("matches required commands even when the array contains noise entries", () => {
      expect(
        detectMacroKeybindingBlockers(
          env({ commandsToSkipShell: [42, null, ...REQUIRED] })
        )
      ).toEqual([]);
    });
  });

  it("returns all three blockers in order when everything is misconfigured", () => {
    expect(
      detectMacroKeybindingBlockers({
        sendKeybindingsToShell: true,
        commandsToSkipShell: "not-an-array",
        enableMenuBarMnemonics: true,
        requiredCommands: REQUIRED
      })
    ).toEqual([SEND_KEYBINDINGS_BLOCKER, SKIP_SHELL_BLOCKER, MNEMONICS_BLOCKER]);
  });
});
