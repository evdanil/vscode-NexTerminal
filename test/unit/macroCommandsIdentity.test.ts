import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Resolve a macro, await a dialog, mutate the array" — the shape every
 * concurrency defect in this feature has had.
 *
 * These tests all drive the SAME interleaving: the mocked dialog performs
 * another window's save before it resolves, so by the time the command writes,
 * the array it captured no longer describes reality. A command that re-reads
 * `getMacros()` but keeps applying its PRE-dialog index is not merely stale —
 * it confidently mutates whichever macro has since slid into that slot, which
 * is strictly worse than writing back the stale snapshot.
 *
 * Unlike `macroFolderCommands.test.ts`, this file uses the REAL
 * `macroBindingHelpers`: `assignBinding` clears the binding from every other
 * macro that holds it, and that whole-array side effect is exactly what makes
 * a mis-targeted write damage a THIRD macro. Mocking it away would hide the
 * damage this file exists to detect.
 */

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowInputBox = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockSetStatusBarMessage = vi.fn();
const mockClipboardReadText = vi.fn();
const mockClipboardWriteText = vi.fn();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn()
  },
  window: {
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args)
  },
  env: {
    openExternal: vi.fn(),
    clipboard: {
      readText: (...args: unknown[]) => mockClipboardReadText(...args),
      writeText: (...args: unknown[]) => mockClipboardWriteText(...args)
    }
  },
  Uri: { parse: (value: string) => ({ toString: () => value, value }) },
  InputBoxValidationSeverity: { Warning: 2 }
}));

vi.mock("../../src/ui/macroEditorPanel", () => ({
  MacroEditorPanel: {
    open: vi.fn(),
    openNew: vi.fn(),
    setProfileProvider: vi.fn()
  }
}));

vi.mock("../../src/commands/macroVariablePrompt", () => ({
  runMacro: vi.fn()
}));

import { registerMacroCommands } from "../../src/commands/macroCommands";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { getMacros, setActiveMacroStore } from "../../src/macroSettings";
import type { TerminalMacro } from "../../src/models/terminalMacro";

let store: InMemoryMacroStore;

/** A tree-item-shaped arg — mirrors MacroTreeItem's duck-typed `{ macro, index }` shape. */
function macroArg(index: number): { macro: TerminalMacro; index: number } {
  return { macro: getMacros()[index], index };
}

function named(name: string): TerminalMacro | undefined {
  return getMacros().find((m) => m.name === name);
}

describe("macro commands resolve their target by identity across every dialog await", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);
    registerMacroCommands();
  });

  describe("nexus.macro.remove", () => {
    it("removes the macro it confirmed, from a tree item", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      const item = macroArg(0);
      mockShowWarningMessage.mockResolvedValue("Remove");

      await registeredCommands.get("nexus.macro.remove")!(item);

      expect(getMacros().map((m) => m.name)).toEqual(["B"]);
    });

    it("a concurrent delete during the confirmation must not remove the macro that took the freed slot", async () => {
      // [A, B]; the context menu was opened on A (index 0). While the modal is
      // up, another window deletes A and saves [B]. Confirming must remove
      // NOTHING — A is already gone — and above all must not remove B, whose
      // name the user never saw in the dialog.
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      const item = macroArg(0);
      const survivor = getMacros()[1];
      mockShowWarningMessage.mockImplementation(async () => {
        await store.save([survivor]);
        return "Remove";
      });

      await registeredCommands.get("nexus.macro.remove")!(item);

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('"A"'),
        expect.anything(),
        "Remove"
      );
      expect(getMacros().map((m) => m.name)).toEqual(["B"]);
    });

    it("the palette path carries identity too, not the quick pick's ordinal", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      const survivor = getMacros()[1];
      mockShowQuickPick.mockImplementation(async (items: Array<{ label: string }>) =>
        items.find((i) => i.label === "A")
      );
      mockShowWarningMessage.mockImplementation(async () => {
        await store.save([survivor]);
        return "Remove";
      });

      await registeredCommands.get("nexus.macro.remove")!();

      expect(getMacros().map((m) => m.name)).toEqual(["B"]);
    });

    it("the palette path still removes the picked macro when nothing changes underneath it", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      mockShowQuickPick.mockImplementation(async (items: Array<{ label: string }>) =>
        items.find((i) => i.label === "B")
      );
      mockShowWarningMessage.mockResolvedValue("Remove");

      await registeredCommands.get("nexus.macro.remove")!();

      expect(getMacros().map((m) => m.name)).toEqual(["A"]);
    });
  });

  describe("nexus.macro.assignSlot", () => {
    it("assigns the binding to the macro it was invoked on", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      const item = macroArg(0);
      mockShowInputBox.mockResolvedValue("alt+7");

      await registeredCommands.get("nexus.macro.assignSlot")!(item);

      expect(named("A")?.keybinding).toBe("alt+7");
      expect(named("B")?.keybinding).toBeUndefined();
    });

    it("a concurrent delete during the binding prompt must not rebind another macro or strip a third macro's shortcut", async () => {
      // [A, B, C]; C owns alt+7. The menu was opened on A (index 0). While the
      // input box is up, another window deletes A, leaving [B, C]. A write
      // through the pre-dialog index 0 lands on B — and `assignBinding` first
      // clears alt+7 from everyone else, so C loses its shortcut as collateral.
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" },
        { name: "C", text: "c", keybinding: "alt+7" }
      ]);
      const item = macroArg(0);
      const [, b, c] = getMacros();
      mockShowInputBox.mockImplementation(async () => {
        await store.save([b, c]);
        return "alt+7";
      });

      await registeredCommands.get("nexus.macro.assignSlot")!(item);

      expect(named("B")?.keybinding).toBeUndefined();
      expect(named("C")?.keybinding).toBe("alt+7");
    });

    it("the palette path carries identity too, not the quick pick's ordinal", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" },
        { name: "C", text: "c", keybinding: "alt+7" }
      ]);
      const [, b, c] = getMacros();
      mockShowQuickPick.mockImplementation(async (items: Array<{ label: string }>) =>
        items.find((i) => i.label === "A")
      );
      mockShowInputBox.mockImplementation(async () => {
        await store.save([b, c]);
        return "alt+7";
      });

      await registeredCommands.get("nexus.macro.assignSlot")!();

      expect(named("B")?.keybinding).toBeUndefined();
      expect(named("C")?.keybinding).toBe("alt+7");
    });

    it("still moves an existing binding off its previous owner when the target is genuinely there", async () => {
      // Proves the identity guard did not turn the command into a no-op: the
      // whole-array side effect of assignBinding must survive it.
      await store.save([
        { name: "A", text: "a" },
        { name: "C", text: "c", keybinding: "alt+7" }
      ]);
      const item = macroArg(0);
      mockShowInputBox.mockResolvedValue("alt+7");

      await registeredCommands.get("nexus.macro.assignSlot")!(item);

      expect(named("A")?.keybinding).toBe("alt+7");
      expect(named("C")?.keybinding).toBeUndefined();
    });
  });

  describe("nexus.macro.pasteSecret", () => {
    it("writes the clipboard text into the macro it was invoked on", async () => {
      await store.save([
        { name: "A", text: "old-a", secret: true },
        { name: "B", text: "old-b", secret: true }
      ]);
      const item = macroArg(0);
      mockClipboardReadText.mockResolvedValue("fresh\n");

      await registeredCommands.get("nexus.macro.pasteSecret")!(item);

      expect(named("A")?.text).toBe("fresh\n");
      expect(named("B")?.text).toBe("old-b");
    });

    it("a concurrent delete during the clipboard read must not paste a secret into a different macro", async () => {
      // The worst of the three: `clipboard.readText()` is an await, and the
      // append-newline prompt is another. Writing a password into whichever
      // macro now occupies index 0 both destroys that macro's value and puts
      // the secret somewhere the user never intended.
      await store.save([
        { name: "A", text: "old-a", secret: true },
        { name: "B", text: "old-b", secret: true }
      ]);
      const item = macroArg(0);
      const survivor = getMacros()[1];
      mockClipboardReadText.mockImplementation(async () => {
        await store.save([survivor]);
        return "hunter2\n";
      });

      await registeredCommands.get("nexus.macro.pasteSecret")!(item);

      expect(named("B")?.text).toBe("old-b");
      expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("from clipboard")
      );
    });
  });
});
