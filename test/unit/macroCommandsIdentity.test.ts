import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Resolve a macro, await a dialog, mutate the array" — the shape every
 * concurrency defect in this feature has had.
 *
 * **The overlapping writer is in THIS window.** Earlier revisions of these
 * tests said "another window", which is not how it can happen:
 * `MacroStore.getAll()` serves an in-memory array that only this window's own
 * `save()` / `clearAll()` / `initialize()` update, and VS Code's `Memento` has
 * no change event, so a second window's `globalState` write is invisible here
 * until reload. What actually overlaps a dialog is a same-window flow the user
 * or the extension drives while it is open — the Macro Editor saving or
 * deleting, a drag onto a folder, `moveToFolder`, a config import. `{ modal:
 * true }` does not prevent any of them (it blocks the user's input, not the
 * extension host's async work), and the non-modal notifications used by
 * `confirmBindingWarnings` and the paste-newline prompt leave the whole window
 * clickable, so the user can drive one BY HAND mid-dialog. The mocked dialogs
 * below stand in for exactly that.
 *
 * These tests all drive the SAME interleaving: the mocked dialog performs one
 * of those saves before it resolves, so by the time the command writes, the
 * array it captured no longer describes reality. A command that re-reads
 * `getMacros()` but keeps applying its PRE-dialog index is not merely stale —
 * it confidently mutates whichever macro has since slid into that slot, which
 * is strictly worse than writing back the stale snapshot. And identity is not
 * the only thing that can go stale: `pasteSecret` re-resolves the right macro
 * and must still refuse to write, because the macro's `secret` FLAG can have
 * been turned off in the same window meanwhile.
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
      // up, the Macro Editor (same window — modality blocks the user, not the
      // host) deletes A and saves [B]. Confirming must remove NOTHING — A is
      // already gone — and above all must not remove B, whose name the user
      // never saw in the dialog.
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

    it("reports that the macro was already gone instead of answering a confirmation with silence", async () => {
      // The no-write is correct; saying nothing about it was not. The user
      // answered a modal naming "A" and, if A had merely been renamed rather
      // than deleted, would see a sidebar that still looks populated with no
      // indication of what their click did.
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

      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining("already removed"));
      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('"A"'));
    });

    it("stays silent on the ordinary successful removal — the report is for the vanished case only", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      const item = macroArg(0);
      mockShowWarningMessage.mockResolvedValue("Remove");

      await registeredCommands.get("nexus.macro.remove")!(item);

      expect(mockShowInformationMessage).not.toHaveBeenCalled();
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
      // input box is up, a same-window flow deletes A, leaving [B, C]. A write
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

    it("reports that the macro was already gone instead of dropping a typed binding on the floor", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      const item = macroArg(0);
      const survivor = getMacros()[1];
      mockShowInputBox.mockImplementation(async () => {
        await store.save([survivor]);
        return "alt+7";
      });

      await registeredCommands.get("nexus.macro.assignSlot")!(item);

      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining("no longer exists"));
      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('"A"'));
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

    it("a macro that stopped being SECRET while the append-newline prompt was open must not receive the clipboard text", async () => {
      // Identity is not the whole precondition. The macro re-resolves
      // perfectly here — same id, same slot — but the append-newline prompt is
      // a plain non-modal `showInformationMessage`, so the user can open the
      // Macro Editor on this very macro, untick Secret, save, and only then
      // answer it. Writing now would have `MacroStore.save()` delete the vault
      // entry and put the clipboard password into `nexus.macros` in cleartext.
      //
      // Clipboard text WITHOUT a trailing newline is what opens that prompt at
      // all — with "fresh\n" the command never awaits and the window never
      // exists.
      await store.save([
        { id: "a", name: "A", text: "old-a", secret: true },
        { id: "b", name: "B", text: "old-b", secret: true }
      ]);
      const item = macroArg(0);
      mockClipboardReadText.mockResolvedValue("hunter2");
      mockShowInformationMessage.mockImplementation(async () => {
        // The Macro Editor saving the same macro with Secret unticked.
        const [a, b] = getMacros();
        await store.save([{ ...a, secret: false }, b]);
        return "Yes";
      });

      await registeredCommands.get("nexus.macro.pasteSecret")!(item);

      // The clipboard password is nowhere in the store.
      expect(named("A")?.text).toBe("old-a");
      expect(named("A")?.secret).toBe(false);
      expect(getMacros().map((m) => m.text)).not.toContain("hunter2\n");
      // ...and the command does not claim it worked.
      expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("from clipboard")
      );
      // It says why, naming the macro — silence here reads as success.
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("no longer a secret macro")
      );
    });

    it("still pastes through the append-newline prompt when the macro is left alone", async () => {
      // Guards the fix against becoming a no-op: the added precondition must
      // not block the ordinary flow through that same prompt.
      await store.save([{ id: "a", name: "A", text: "old-a", secret: true }]);
      const item = macroArg(0);
      mockClipboardReadText.mockResolvedValue("hunter2");
      mockShowInformationMessage.mockResolvedValue("Yes");

      await registeredCommands.get("nexus.macro.pasteSecret")!(item);

      expect(named("A")?.text).toBe("hunter2\n");
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("from clipboard")
      );
    });
  });
});
