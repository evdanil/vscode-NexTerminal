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
import {
  captureMacroRef,
  captureMacroRefFromRow,
  resolveMacroTarget
} from "../../src/services/macroMutation";
import { assignUniqueMacroIds } from "../../src/storage/macroStore";
import { MacroEditorPanel } from "../../src/ui/macroEditorPanel";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { DuplicateIdMacroStore } from "../helpers/duplicateIdMacroStore";
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

  describe("a STALE tree item whose index is back in bounds", () => {
    /**
     * The other half of identity, and the half that resolving purely by id was
     * never wrong about: a tree item outlives the array it was built from. Move
     * Up / Move Down were the two commands still applying `item.index` directly,
     * so deleting a macro ABOVE the selected one made them reorder a macro the
     * user never clicked — and in the Move Up case they moved the selected macro
     * the wrong way.
     */
    it("moveUp reorders the macro the row was built for, not whatever now occupies its index", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" },
        { name: "C", text: "c" }
      ]);
      const staleItem = macroArg(1); // the row for B, built from [A, B, C]
      const [, b, c] = getMacros();
      await store.save([b, c]); // A deleted; index 1 now names C

      await registeredCommands.get("nexus.macro.moveUp")!(staleItem);

      // B is already first, so the correct answer is "nothing moves". Applying
      // the stale index swapped C and B — moving the SELECTED macro down and an
      // untouched one up.
      expect(getMacros().map((m) => m.name)).toEqual(["B", "C"]);
      expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Already at the top of the list", 2000);
    });

    it("moveDown reorders the macro the row was built for, not whatever now occupies its index", async () => {
      // The mirror case, and it fails the opposite way: the stale index lands on
      // the LAST macro, so a raw-index implementation reports "already at the
      // bottom" and silently does nothing at all.
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" },
        { name: "C", text: "c" }
      ]);
      const staleItem = macroArg(1);
      const [, b, c] = getMacros();
      await store.save([b, c]);

      await registeredCommands.get("nexus.macro.moveDown")!(staleItem);

      expect(getMacros().map((m) => m.name)).toEqual(["C", "B"]);
      expect(mockSetStatusBarMessage).not.toHaveBeenCalled();
    });

    it("Edit Macro opens the macro the row was built for, not whatever now occupies its index", async () => {
      // Opening the editor writes nothing, so this is not a data-loss bug — it is
      // worse-shaped than that: the wrong macro arrives pre-filled in a form whose
      // Save button writes for real, and nothing on screen says the row the user
      // clicked is not the record they are looking at.
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" },
        { name: "C", text: "c" }
      ]);
      const staleItem = macroArg(1);
      const [, b, c] = getMacros();
      await store.save([b, c]); // index 1 now names C

      await registeredCommands.get("nexus.macro.edit")!(staleItem);

      expect(MacroEditorPanel.open).toHaveBeenCalledWith(0);
    });

    it("Edit Macro on a row whose macro is GONE opens nothing and says so — it must not reveal whatever the editor already had", async () => {
      // This used to call `MacroEditorPanel.open(undefined)`, described in the
      // adjacent comment as "opens the editor with no selection". That is only
      // true of a panel that does not exist yet: `open()` with no index REVEALS
      // an already-open panel and leaves its selection untouched
      // (macroEditorPanel.ts). So a stale row for a deleted macro brought
      // whatever the user last had open to the front — a different macro
      // entirely, pre-filled and one Save away, with nothing saying why.
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);
      const staleItem = macroArg(0);
      const survivor = getMacros()[1];
      await store.save([survivor]); // A is gone; index 0 now names B

      await registeredCommands.get("nexus.macro.edit")!(staleItem);

      expect(MacroEditorPanel.open).not.toHaveBeenCalled();
      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('"A"'));
    });

    it("moveUp still swaps normally when the row is fresh — the guard must not turn reordering into a no-op", async () => {
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" }
      ]);

      await registeredCommands.get("nexus.macro.moveUp")!(macroArg(1));

      expect(getMacros().map((m) => m.name)).toEqual(["B", "A"]);
    });
  });

  describe("two macros sharing one id", () => {
    /**
     * Duplicate stored ids are reachable and deliberately unrepaired on the read
     * path (`VscodeMacroStore.reloadFromState()`), so every command has to cope
     * with them. Resolving "by id" alone answers with the FIRST match, which
     * means the user acts on one row and the other one changes — the same class
     * of wrong-target write as a stale index, arrived at from the opposite
     * direction. The clicked row's position is the only thing that can tell the
     * twins apart, so it is preferred whenever the macro still sitting there
     * carries the same id.
     *
     * `DuplicateIdMacroStore` is used instead of `InMemoryMacroStore` because
     * the latter mirrors the store's WRITE path and re-keys duplicates on
     * `save()`, so it cannot hold this state at all.
     */
    function twins(extra: Partial<TerminalMacro> = {}): TerminalMacro[] {
      return [
        { id: "x", name: "login", text: "login\n", ...extra },
        { id: "x", name: "reboot", text: "reboot\n", ...extra }
      ];
    }

    function seed(macros: TerminalMacro[]): DuplicateIdMacroStore {
      const dupStore = new DuplicateIdMacroStore(macros);
      setActiveMacroStore(dupStore);
      return dupStore;
    }

    it("remove confirms and deletes the twin the context menu was opened on", async () => {
      const dupStore = seed(twins());
      const item = { macro: dupStore.getAll()[1], index: 1 };
      mockShowWarningMessage.mockResolvedValue("Remove");

      await registeredCommands.get("nexus.macro.remove")!(item);

      // First-match resolution named "login" in the confirmation and deleted
      // "login" — a macro the user did not select, under a name they did not
      // click, after a dialog that told them it was the other one.
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('"reboot"'),
        expect.anything(),
        "Remove"
      );
      expect(dupStore.getAll().map((m) => m.name)).toEqual(["login"]);
    });

    it("pasteSecret writes the clipboard value into the twin that was clicked", async () => {
      const dupStore = seed(twins({ secret: true }));
      const item = { macro: dupStore.getAll()[1], index: 1 };
      mockClipboardReadText.mockResolvedValue("hunter2\n");

      await registeredCommands.get("nexus.macro.pasteSecret")!(item);

      const after = dupStore.getAll();
      expect(after[1].text).toBe("hunter2\n");
      expect(after[0].text).toBe("login\n"); // the other twin's password is untouched
    });

    it("assignSlot binds the twin that was clicked", async () => {
      const dupStore = seed(twins());
      const item = { macro: dupStore.getAll()[1], index: 1 };
      mockShowInputBox.mockResolvedValue("alt+7");

      await registeredCommands.get("nexus.macro.assignSlot")!(item);

      const after = dupStore.getAll();
      expect(after[1].keybinding).toBe("alt+7");
      expect(after[0].keybinding).toBeUndefined();
    });

    it("moveToFolder moves the clicked twin only — never every macro carrying the id", async () => {
      const dupStore = seed(twins());
      const item = { macro: dupStore.getAll()[1], index: 1 };
      mockShowQuickPick.mockImplementation(async (items: Array<{ folderKind?: string; label: string }>) =>
        items.find((i) => i.label === "$(new-folder) New folder…")
      );
      mockShowInputBox.mockResolvedValue("Cisco");

      await registeredCommands.get("nexus.macro.moveToFolder")!(item);

      const after = dupStore.getAll();
      expect(after[1].group).toBe("Cisco");
      expect(after[0].group).toBeUndefined(); // an id-keyed rewrite moved both
    });

    it("moveUp still reorders the clicked row — the remedy the sidebar tooltip names must actually work", async () => {
      // The identity-conflict tooltip (macroTreeProvider.ts) tells the user to
      // "Reorder any macro with Move Up / Move Down to assign fresh ids", and
      // the Macro Editor already refuses to touch a flagged macro. If reordering
      // refused too, a duplicate-id state would have no stated way out at all.
      const dupStore = seed(twins());

      await registeredCommands.get("nexus.macro.moveUp")!({ macro: dupStore.getAll()[1], index: 1 });

      expect(dupStore.getAll().map((m) => m.name)).toEqual(["reboot", "login"]);
      expect(mockSetStatusBarMessage).not.toHaveBeenCalled();
    });

    it("refuses, saying why, when the row went stale AND the id is shared", async () => {
      // Neither signal survives: the position no longer holds the dragged id, and
      // the id names two macros. Guessing here is exactly what destroys the wrong
      // record, and silence would read as a dead menu item.
      const dupStore = seed([
        { id: "y", name: "Other", text: "o" },
        { id: "x", name: "login", text: "login\n" },
        { id: "x", name: "reboot", text: "reboot\n" }
      ]);
      const item = { macro: dupStore.getAll()[2], index: 2 };
      mockShowWarningMessage.mockImplementation(async (message: string) => {
        if (!message.startsWith("Remove macro")) return undefined;
        // A concurrent same-window write reorders the list while the modal is up,
        // so index 2 stops naming a macro with id "x".
        const [other, first, second] = dupStore.getAll();
        await dupStore.save([first, second, other]);
        return "Remove";
      });

      await registeredCommands.get("nexus.macro.remove")!(item);

      expect(dupStore.getAll().map((m) => m.name)).toEqual(["login", "reboot", "Other"]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });
  });

  /**
   * The interleaving every one of these drives, and the reason a reference has
   * to remember what it knew:
   *
   *   stored  [Unrelated(u), login(x), reboot(x)]
   *   click   reboot — id "x", row 2
   *   dialog  ANY save lands (here: a rename of Unrelated, the most innocuous
   *           write there is). `MacroStore.save()` runs `assignUniqueMacroIds()`,
   *           which lets the FIRST holder of "x" keep it and hands "reboot" a
   *           fresh id.
   *   store   [Unrelated'(u), login(x), reboot(new-id)]
   *   write   row 2 no longer carries "x" — and "x" now has exactly ONE holder.
   *
   * At that last step the array is indistinguishable from an ordinary stale
   * index over a unique id, which every command is REQUIRED to resolve by
   * falling back to the id. The difference is entirely in the past: this id was
   * shared when the user pointed at it. So the reference carries that
   * (`MacroIdProvenance`), and a reference taken over a shared id is honoured
   * only by an exact row-and-id match — never by the id alone.
   *
   * Without it, every command below quietly writes to "login": deletes it,
   * rebinds it, pastes another macro's clipboard password into it, moves it.
   */
  describe("an id that was shared WHEN THE REFERENCE WAS TAKEN is never resolved by id alone", () => {
    function seedThree(extra: Partial<TerminalMacro> = {}): DuplicateIdMacroStore {
      const dupStore = new DuplicateIdMacroStore([
        { id: "u", name: "Unrelated", text: "u" },
        { id: "x", name: "login", text: "login\n", ...extra },
        { id: "x", name: "reboot", text: "reboot\n", ...extra }
      ]);
      setActiveMacroStore(dupStore);
      return dupStore;
    }

    /** The unrelated, id-preserving write that nevertheless re-keys the twins. */
    async function renameUnrelated(dupStore: DuplicateIdMacroStore): Promise<void> {
      const latest = dupStore.getAll();
      await dupStore.save([{ ...latest[0], name: "Unrelated (edited)" }, latest[1], latest[2]]);
    }

    it("remove refuses instead of deleting the other twin", async () => {
      const dupStore = seedThree();
      const item = { macro: dupStore.getAll()[2], index: 2 };
      mockShowWarningMessage.mockImplementation(async (message: string) => {
        if (!message.startsWith("Remove macro")) return undefined;
        await renameUnrelated(dupStore);
        return "Remove";
      });

      await registeredCommands.get("nexus.macro.remove")!(item);

      // The confirmation named "reboot"; "login" must survive it.
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('"reboot"'),
        expect.anything(),
        "Remove"
      );
      expect(dupStore.getAll().map((m) => m.name)).toEqual(["Unrelated (edited)", "login", "reboot"]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });

    it("assignSlot refuses instead of rebinding the other twin", async () => {
      const dupStore = seedThree();
      const item = { macro: dupStore.getAll()[2], index: 2 };
      mockShowInputBox.mockImplementation(async () => {
        await renameUnrelated(dupStore);
        return "alt+7";
      });

      await registeredCommands.get("nexus.macro.assignSlot")!(item);

      expect(dupStore.getAll().map((m) => m.keybinding)).toEqual([undefined, undefined, undefined]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });

    it("pasteSecret refuses instead of overwriting the other twin's stored password", async () => {
      // The worst of the four: the reference used to be built at the WRITE site,
      // from an array read after the prompt — by which point the re-key had
      // already happened and its provenance said "unique". Capturing at the top
      // of the handler is half of what makes this pass; the other half is the
      // resolver refusing to fall back.
      const dupStore = seedThree({ secret: true });
      const item = { macro: dupStore.getAll()[2], index: 2 };
      mockClipboardReadText.mockResolvedValue("hunter2"); // no trailing \n → the prompt fires
      mockShowInformationMessage.mockImplementation(async (message: string) => {
        if (!message.startsWith("Append newline")) return undefined;
        await renameUnrelated(dupStore);
        return "No";
      });

      await registeredCommands.get("nexus.macro.pasteSecret")!(item);

      expect(dupStore.getAll().map((m) => m.text)).toEqual(["u", "login\n", "reboot\n"]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });

    it("moveToFolder refuses instead of moving the other twin", async () => {
      const dupStore = seedThree();
      const item = { macro: dupStore.getAll()[2], index: 2 };
      mockShowQuickPick.mockImplementation(async (items: Array<{ label: string }>) =>
        items.find((i) => i.label === "$(new-folder) New folder…")
      );
      mockShowInputBox.mockImplementation(async () => {
        await renameUnrelated(dupStore);
        return "Cisco";
      });

      await registeredCommands.get("nexus.macro.moveToFolder")!(item);

      expect(dupStore.getAll().map((m) => m.group)).toEqual([undefined, undefined, undefined]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });

    it("moveToFolder over a multi-select moves what it can still identify and REPORTS the twin it cannot", async () => {
      // Both twins selected from the palette. The re-key during the folder
      // prompt leaves the first one exactly where its reference says it is (it
      // keeps the shared id, so row-and-id still match) and the second one
      // unidentifiable. Moving one and saying nothing about the other is the
      // silent-skip this reports instead: the user asked for two macros to move
      // and would otherwise have to notice for themselves that one did not.
      const dupStore = seedThree();
      mockShowQuickPick.mockImplementation(
        async (items: Array<{ label: string }>, options?: { canPickMany?: boolean }) =>
          options?.canPickMany
            ? items.filter((i) => i.label === "login" || i.label === "reboot")
            : items.find((i) => i.label === "$(new-folder) New folder…")
      );
      mockShowInputBox.mockImplementation(async () => {
        await renameUnrelated(dupStore);
        return "Cisco";
      });

      await registeredCommands.get("nexus.macro.moveToFolder")!();

      expect(dupStore.getAll().map((m) => [m.name, m.group])).toEqual([
        ["Unrelated (edited)", undefined],
        ["login", "Cisco"],
        ["reboot", undefined]
      ]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });

    it("moveUp refuses on a row DRAWN over the conflict, even though the list looks unambiguous by the time it is clicked", async () => {
      // No dialog at all here — the re-key lands between the tree painting the
      // row and the user clicking it, which the tree cannot repaint fast enough
      // to prevent. By command time the array is clean, so an ambiguity check
      // made now sees nothing; the row's own render-time flag
      // (`MacroTreeItem.identityConflict`, already computed for the warning
      // icon) is the only surviving witness.
      const dupStore = seedThree();
      const row = { macro: dupStore.getAll()[2], index: 2, identityConflict: true };
      await renameUnrelated(dupStore);

      await registeredCommands.get("nexus.macro.moveUp")!(row);

      expect(dupStore.getAll().map((m) => m.name)).toEqual(["Unrelated (edited)", "login", "reboot"]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });

    it("still resolves normally when the id was NOT shared at capture — the stale-index fallback must survive all of this", async () => {
      // The counterweight. `[A, B, C]`, click B (row 1), A is deleted mid-modal:
      // row 1 now names C, and B must still be the macro that gets removed. A
      // rule that refused every mismatched index would pass every test above and
      // break this one.
      await store.save([
        { name: "A", text: "a" },
        { name: "B", text: "b" },
        { name: "C", text: "c" }
      ]);
      const item = macroArg(1);
      const [, b, c] = getMacros();
      mockShowWarningMessage.mockImplementation(async (message: string) => {
        if (!message.startsWith("Remove macro")) return undefined;
        await store.save([b, c]);
        return "Remove";
      });

      await registeredCommands.get("nexus.macro.remove")!(item);

      expect(getMacros().map((m) => m.name)).toEqual(["C"]);
      expect(mockShowWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining("same internal id"));
    });
  });
});

/**
 * The primitive underneath every command above, exercised directly against the
 * REAL `assignUniqueMacroIds()` — the same function both production stores run
 * on every `save()`. Going through the real re-keying rather than hand-writing
 * "and now the ids look like this" is the point: the whole defect was a wrong
 * belief about what a save does to a duplicated id.
 */
describe("resolveMacroTarget (services/macroMutation.ts)", () => {
  const stored: TerminalMacro[] = [
    { id: "u", name: "Unrelated", text: "u" },
    { id: "x", name: "First", text: "f" },
    { id: "x", name: "Second", text: "s" }
  ];

  it("honours the clicked row while the twins are still twins", () => {
    const ref = captureMacroRef(stored, "x", 2);
    expect(resolveMacroTarget(stored, ref)).toEqual({ kind: "resolved", index: 2 });
  });

  it("refuses after a save re-keys the twins — the surviving holder of the id is the OTHER macro", () => {
    const ref = captureMacroRef(stored, "x", 2);
    expect(ref.idWhenCaptured).toBe("ambiguous");

    // Exactly what `MacroStore.save()` does, run for real: "First" keeps "x",
    // "Second" is handed a fresh UUID.
    const afterSave = assignUniqueMacroIds(stored);
    expect(afterSave[1].id).toBe("x");
    expect(afterSave[2].id).not.toBe("x");
    expect(afterSave.filter((m) => m.id === "x")).toHaveLength(1); // NOT ambiguous any more

    expect(resolveMacroTarget(afterSave, ref)).toEqual({ kind: "ambiguous" });
  });

  it("still refuses when the id has vanished entirely — 'deleted' and 're-keyed' are the same array", () => {
    // `"missing"` is not a silent no-op: callers report it ("…was already
    // removed"). After a re-key that sentence is a fabrication, so the refusal
    // stands.
    const ref = captureMacroRef(stored, "x", 2);
    expect(resolveMacroTarget([{ id: "u", name: "Unrelated", text: "u" }], ref)).toEqual({ kind: "ambiguous" });
  });

  it("a reference taken over a UNIQUE id still falls back to the id when its row moves", () => {
    const unique: TerminalMacro[] = [
      { id: "a", name: "A", text: "a" },
      { id: "b", name: "B", text: "b" },
      { id: "c", name: "C", text: "c" }
    ];
    const ref = captureMacroRef(unique, "b", 1);
    expect(ref.idWhenCaptured).toBe("unique");
    // "A" deleted: row 1 now names "C".
    expect(resolveMacroTarget([unique[1], unique[2]], ref)).toEqual({ kind: "resolved", index: 0 });
  });

  it("a row's render-time conflict flag wins over an array that has already been repaired", () => {
    const afterSave = assignUniqueMacroIds(stored);
    const row = { macro: stored[2], index: 2, identityConflict: true };
    // The array the command reads is clean, so checking it now proves nothing.
    expect(captureMacroRef(afterSave, "x", 2).idWhenCaptured).toBe("unique");
    expect(captureMacroRefFromRow(afterSave, row).idWhenCaptured).toBe("ambiguous");
    expect(resolveMacroTarget(afterSave, captureMacroRefFromRow(afterSave, row))).toEqual({ kind: "ambiguous" });
  });

  it("an unverified reference (a drag payload from an unknown producer) resolves by id", () => {
    const unique: TerminalMacro[] = [
      { id: "a", name: "A", text: "a" },
      { id: "b", name: "B", text: "b" }
    ];
    expect(resolveMacroTarget(unique, { id: "b", idWhenCaptured: "unverified" })).toEqual({
      kind: "resolved",
      index: 1
    });
    // …and still refuses a genuinely ambiguous array.
    expect(
      resolveMacroTarget(
        [unique[0], { id: "b", name: "B1", text: "b" }, { id: "b", name: "B2", text: "b" }],
        { id: "b", idWhenCaptured: "unverified" }
      )
    ).toEqual({ kind: "ambiguous" });
  });
});
