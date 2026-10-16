import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowInputBox = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockSetStatusBarMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockOpenNew = vi.fn();

// The tree-item members below exist so the Remove Folder tests (#288) can hand
// the command the very FolderTreeItem the Macros view draws, and read the tree
// back afterwards, instead of a duck-typed stand-in.
vi.mock("vscode", () => ({
  TreeItem: class {
    label?: string;
    id?: string;
    description?: string;
    contextValue?: string;
    command?: unknown;
    tooltip?: string;
    iconPath?: unknown;
    collapsibleState?: number;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  EventEmitter: class {
    public readonly event = vi.fn();
    public readonly fire = vi.fn();
  },
  workspace: { getConfiguration: vi.fn() },
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
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args)
  },
  env: {
    openExternal: vi.fn(),
    clipboard: { readText: vi.fn(), writeText: vi.fn() }
  },
  Uri: { parse: (value: string) => ({ toString: () => value, value }) },
  InputBoxValidationSeverity: { Warning: 2 }
}));

vi.mock("../../src/ui/macroEditorPanel", () => ({
  MacroEditorPanel: {
    open: vi.fn(),
    openNew: (...args: unknown[]) => mockOpenNew(...args),
    setProfileProvider: vi.fn()
  }
}));

vi.mock("../../src/macroBindingHelpers", () => ({
  assignBinding: vi.fn(),
  findBindingOwnerIndex: vi.fn(() => -1),
  getAssignedBinding: vi.fn(() => undefined),
  normalizeBinding: vi.fn((value?: string) => value)
}));

vi.mock("../../src/macroBindings", () => ({
  bindingToContextKey: vi.fn((binding: string) => `nexus.binding.${binding}`),
  bindingToDisplayLabel: vi.fn((binding: string) => binding),
  isValidBinding: vi.fn(() => true),
  slotToBinding: vi.fn((slot: number) => `alt+${slot}`)
}));

vi.mock("../../src/commands/macroVariablePrompt", () => ({
  runMacro: vi.fn()
}));

import { registerMacroCommands } from "../../src/commands/macroCommands";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { getMacroFolders, getMacros, setActiveMacroStore } from "../../src/macroSettings";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import { MacroTreeProvider } from "../../src/ui/macroTreeProvider";
import { FolderTreeItem } from "../../src/ui/nexusTreeProvider";

/** A tree-item-shaped arg carrying a macro at its TRUE getMacros() index — mirrors MacroTreeItem's duck-typed shape. */
function macroArg(index: number): { macro: TerminalMacro; index: number } {
  return { macro: getMacros()[index], index };
}

/** A folder-tree-item-shaped arg — mirrors FolderTreeItem's duck-typed `folderPath` shape (§4.6, §4.7). */
function folderArg(path: string): { folderPath: string } {
  return { folderPath: path };
}

function drawnChildFolders(provider: MacroTreeProvider, parent?: FolderTreeItem): FolderTreeItem[] {
  return provider.getChildren(parent).filter((c): c is FolderTreeItem => c instanceof FolderTreeItem);
}

/** Every folder the Macros view draws, depth-first, indented two spaces per level. */
function drawnTree(provider: MacroTreeProvider, parent?: FolderTreeItem, depth = 0): string[] {
  return drawnChildFolders(provider, parent).flatMap((folder) => [
    `${"  ".repeat(depth)}${String(folder.label)}`,
    ...drawnTree(provider, folder, depth + 1)
  ]);
}

/** The FolderTreeItem the Macros view draws for `path`: what a right-click hands the command. */
function drawnFolder(provider: MacroTreeProvider, path: string, parent?: FolderTreeItem): FolderTreeItem {
  for (const folder of drawnChildFolders(provider, parent)) {
    if (folder.folderPath === path) {
      return folder;
    }
    if (path.startsWith(`${folder.folderPath}/`)) {
      return drawnFolder(provider, path, folder);
    }
  }
  throw new Error(`The Macros view draws no folder "${path}"`);
}

let store: InMemoryMacroStore;

describe("macro folder commands", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    store = new InMemoryMacroStore();
    await store.initialize();
    setActiveMacroStore(store);
    registerMacroCommands();
  });

  describe("nexus.macro.newFolder (§4.5)", () => {
    it("creates a folder (and its ancestors) that persists empty", async () => {
      mockShowInputBox.mockResolvedValue("Cisco/Routers");

      await registeredCommands.get("nexus.macro.newFolder")!();

      expect(getMacroFolders().sort()).toEqual(["Cisco", "Cisco/Routers"]);
    });

    it("cancelling the input box creates nothing", async () => {
      mockShowInputBox.mockResolvedValue(undefined);

      await registeredCommands.get("nexus.macro.newFolder")!();

      expect(getMacroFolders()).toEqual([]);
    });

    it("naming a folder that only exists because a macro's group derives it (Fix 5): still shows 'already exists', but now PROMOTES it to an explicit entry so it survives the macro moving out later", async () => {
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      mockShowInputBox.mockResolvedValue("Cisco");

      await registeredCommands.get("nexus.macro.newFolder")!();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining("already exists"));
      // Before Fix 5 this asserted `[]` (nothing persisted) — which is exactly
      // the bug: moving "M" out of "Cisco" afterward would make the folder the
      // user just "created" vanish, since it was never made explicit.
      expect(getMacroFolders()).toEqual(["Cisco"]);
    });

    it("rejects a path-traversal folder name via validateInput", async () => {
      mockShowInputBox.mockResolvedValue(undefined); // simulate the user cancelling after seeing the error
      await registeredCommands.get("nexus.macro.newFolder")!();

      const options = mockShowInputBox.mock.calls[0][0] as { validateInput: (v: string) => string | null };
      expect(options.validateInput("../secrets")).toBeTruthy();
      expect(options.validateInput("Cisco/Routers")).toBeNull();
    });

    it("Fix 8 — rejects a backslash with a message telling the user to use '/', matching the Scripts view's validator", async () => {
      mockShowInputBox.mockResolvedValue(undefined);
      await registeredCommands.get("nexus.macro.newFolder")!();

      const options = mockShowInputBox.mock.calls[0][0] as { validateInput: (v: string) => string | null };
      const message = options.validateInput("Cisco\\Routers");
      expect(message).toBeTruthy();
      expect(message).toMatch(/use '\/'/i);
    });
  });

  describe("nexus.macro.moveToFolder (§4.6, §4.7)", () => {
    it("on a tree item, moves just that one macro", async () => {
      // Fix 4(c) — both macros start in "Cisco" and the destination is root:
      // if `targetIndices` were ever widened to "every index" (a plausible
      // regression given the palette path's multi-select), index 0 would ALSO
      // be cleared here. Starting both at root (the old fixture) made the
      // correct and the broken behaviour produce the identical outcome.
      await store.save([
        { name: "A", text: "t", group: "Cisco" },
        { name: "B", text: "t", group: "Cisco" }
      ]);
      mockShowQuickPick.mockImplementation(async (items: Array<{ folderKind: string }>) =>
        items.find((i) => i.folderKind === "root")
      );

      await registeredCommands.get("nexus.macro.moveToFolder")!(macroArg(1));

      const macros = getMacros();
      expect(macros[0].group).toBe("Cisco"); // untouched — proves only index 1 moved
      expect(macros[1].group).toBeUndefined();
    });

    it("Fix 1 (BLOCKER) — a stale/out-of-bounds tree-item index is a no-op, never a persisted ghost macro", async () => {
      // Reproduces the exact failure from the review: the context menu was
      // opened for the macro at index 0, but by the time the command fires
      // (e.g. it was deleted via the Macro Editor without dismissing the
      // menu), index 0 either no longer exists or now refers to a different
      // macro entirely. Before Fix 1, `updated[idx] = { ...updated[idx] }`
      // with an out-of-range idx wrote `{}` — a nameless, textless macro —
      // straight into the store.
      await store.save([{ name: "Only", text: "t" }]);
      const staleItem = macroArg(0);
      await store.save([]); // the macro is gone; staleItem.index (0) is now out of bounds
      mockShowQuickPick.mockImplementation(async (items: Array<{ folderKind: string }>) =>
        items.find((i) => i.folderKind === "root")
      );

      await registeredCommands.get("nexus.macro.moveToFolder")!(staleItem);

      expect(getMacros()).toEqual([]); // no ghost record persisted
    });

    it("Fix 3 (MAJOR) — a stale index back IN bounds but now pointing at a DIFFERENT macro must not overwrite it (identity, not just bounds)", async () => {
      // The exact scenario from the review: a stale tree item
      // {macro: A(id="a"), index: 0}; A is deleted so the array becomes
      // [B(id="b", group="Old")] — B now sits at index 0 too. A bounds check
      // alone ("is 0 a valid index?") passes and would wrongly clear B's
      // group. The fixture in the ORIGINAL version of this test collapsed to
      // an empty array (one-item-to-empty), so index 0 was ALWAYS
      // out-of-bounds after the deletion — a bounds-only implementation and
      // the correct identity-based one produced the identical outcome there.
      // This fixture makes index 0 valid but identity-mismatched, so the two
      // implementations diverge.
      await store.save([
        { id: "a", name: "A", text: "t" },
        { id: "b", name: "B", text: "t", group: "Old" }
      ]);
      const staleItem = macroArg(0); // captures A (id "a") at index 0
      // A is removed; B shifts down to index 0 — same array slot, different macro.
      await store.save([{ id: "b", name: "B", text: "t", group: "Old" }]);
      mockShowQuickPick.mockImplementation(async (items: Array<{ folderKind: string }>) =>
        items.find((i) => i.folderKind === "root")
      );

      await registeredCommands.get("nexus.macro.moveToFolder")!(staleItem);

      // B's group must be untouched — the stale item's captured id ("a")
      // does not match B's id ("b"), so the identity-based implementation
      // treats this as a no-op even though index 0 is a valid slot.
      expect(getMacros()).toEqual([{ id: "b", name: "B", text: "t", group: "Old" }]);
    });

    it("moves the macro into an existing folder", async () => {
      await store.save([{ name: "A", text: "t" }]);
      await store.saveFolders(["Cisco"]);
      mockShowQuickPick.mockImplementation(async (items: Array<{ folderKind: string; path?: string }>) =>
        items.find((i) => i.folderKind === "folder" && i.path === "Cisco")
      );

      await registeredCommands.get("nexus.macro.moveToFolder")!(macroArg(0));

      expect(getMacros()[0].group).toBe("Cisco");
    });

    it("from the palette (no arg): multi-selects macros, then moves ALL of them (§4.6 bulk path)", async () => {
      await store.save([
        { name: "A", text: "t" },
        { name: "B", text: "t" },
        { name: "C", text: "t" }
      ]);
      // First quick pick: multi-select macros A and C (indices 0 and 2)
      mockShowQuickPick.mockImplementationOnce(async (items: Array<{ index: number }>) =>
        [items[0], items[2]]
      );
      // Second quick pick: folder destination
      mockShowQuickPick.mockImplementationOnce(async (items: Array<{ folderKind: string; path?: string }>) =>
        items.find((i) => i.folderKind === "folder" && i.path === "Juniper")
      );
      await store.saveFolders(["Juniper"]);

      await registeredCommands.get("nexus.macro.moveToFolder")!();

      const macros = getMacros();
      expect(macros.find((m) => m.name === "A")?.group).toBe("Juniper");
      expect(macros.find((m) => m.name === "B")?.group).toBeUndefined();
      expect(macros.find((m) => m.name === "C")?.group).toBe("Juniper");
    });

    it("choosing 'New folder…' prompts for a path, creates it, and assigns it", async () => {
      await store.save([{ name: "A", text: "t" }]);
      mockShowQuickPick.mockImplementation(async (items: Array<{ folderKind: string }>) =>
        items.find((i) => i.folderKind === "new")
      );
      mockShowInputBox.mockResolvedValue("Brand/New");

      await registeredCommands.get("nexus.macro.moveToFolder")!(macroArg(0));

      expect(getMacros()[0].group).toBe("Brand/New");
      expect(getMacroFolders().sort()).toEqual(["Brand", "Brand/New"]);
    });

    it("cancelling the folder picker leaves the macro untouched", async () => {
      await store.save([{ name: "A", text: "t", group: "Existing" }]);
      mockShowQuickPick.mockResolvedValue(undefined);

      await registeredCommands.get("nexus.macro.moveToFolder")!(macroArg(0));

      expect(getMacros()[0].group).toBe("Existing");
    });
  });

  describe("nexus.macro.addToFolder (§4.7)", () => {
    it("opens the editor with the Folder field pre-seeded", async () => {
      await registeredCommands.get("nexus.macro.addToFolder")!(folderArg("Cisco"));

      expect(mockOpenNew).toHaveBeenCalledWith({ group: "Cisco" });
    });

    it("no-ops without a folder arg", async () => {
      await registeredCommands.get("nexus.macro.addToFolder")!(undefined);

      expect(mockOpenNew).not.toHaveBeenCalled();
    });
  });

  describe("nexus.macro.renameFolder — prefix-safety (§4.7)", () => {
    it("renames descendants but leaves a similarly-prefixed sibling folder untouched (Net must not touch Network)", async () => {
      await store.save([
        { name: "InNet", text: "t", group: "Net" },
        { name: "InNetSub", text: "t", group: "Net/Sub" },
        { name: "InNetwork", text: "t", group: "Network" }
      ]);
      await store.saveFolders(["Net", "Net/Sub", "Network"]);
      mockShowInputBox.mockResolvedValue("Cisco");

      await registeredCommands.get("nexus.macro.renameFolder")!(folderArg("Net"));

      const macros = getMacros();
      expect(macros.find((m) => m.name === "InNet")?.group).toBe("Cisco");
      expect(macros.find((m) => m.name === "InNetSub")?.group).toBe("Cisco/Sub");
      expect(macros.find((m) => m.name === "InNetwork")?.group).toBe("Network"); // untouched
      expect(getMacroFolders()).toContain("Network");
      expect(getMacroFolders()).not.toContain("Net");
    });

    it("cancelling does nothing", async () => {
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      mockShowInputBox.mockResolvedValue(undefined);

      await registeredCommands.get("nexus.macro.renameFolder")!(folderArg("Cisco"));

      expect(getMacros()[0].group).toBe("Cisco");
    });

    it("re-entering the SAME name changes nothing — in particular it must not promote a derived folder to an explicit entry", async () => {
      // The cancel case above was the only thing this ever exercised, so
      // deleting the `newName.trim() === currentName` early return survived
      // it. Without that return the rename runs as a no-op prefix
      // substitution, and its "make sure the destination exists" pass writes
      // `nexus.macros.folders` — turning a folder that existed only because a
      // macro's `group` derives it into a persistent explicit one, which then
      // outlives the macro moving out.
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      expect(getMacroFolders()).toEqual([]); // derived only, nothing explicit
      mockShowInputBox.mockResolvedValue("Cisco");

      await registeredCommands.get("nexus.macro.renameFolder")!(folderArg("Cisco"));

      expect(getMacros()[0].group).toBe("Cisco");
      expect(getMacroFolders()).toEqual([]);
    });

    it("refuses a rename that would push a descendant past the path-length cap, writing nothing", async () => {
      // A rename is a prefix substitution, so a longer new name lengthens
      // every descendant. Unchecked, a deep descendant crosses
      // MAX_FOLDER_PATH_LENGTH, stops normalizing, and the macro silently
      // drops to the root — data loss caused by a command the user invoked.
      const longGroup = `A/${"x".repeat(4090)}`; // 4092 chars: valid today
      await store.save([{ name: "Deep", text: "t", group: longGroup }]);
      await store.saveFolders(["A"]);
      mockShowInputBox.mockResolvedValue("BBBBBBBBBB"); // 10 chars -> 4101, over the cap

      await registeredCommands.get("nexus.macro.renameFolder")!(folderArg("A"));

      expect(getMacros()[0].group).toBe(longGroup); // untouched, still renderable
      expect(getMacroFolders()).toEqual(["A"]); // and the folder list is untouched too
      expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("4096 characters"));
    });

    it("still renames when every resulting descendant path stays within the cap", async () => {
      // Guards the length check against becoming a blanket refusal.
      const group = `A/${"x".repeat(4000)}`;
      await store.save([{ name: "Deep", text: "t", group }]);
      mockShowInputBox.mockResolvedValue("BBBBBBBBBB");

      await registeredCommands.get("nexus.macro.renameFolder")!(folderArg("A"));

      expect(getMacros()[0].group).toBe(`BBBBBBBBBB/${"x".repeat(4000)}`);
      expect(mockShowErrorMessage).not.toHaveBeenCalled();
    });

    it("no-ops without a folder arg", async () => {
      await registeredCommands.get("nexus.macro.renameFolder")!(undefined);
      expect(mockShowInputBox).not.toHaveBeenCalled();
    });

    it("Fix 5 — validateInput rejects '.', '..', and '\\' with the shared invalid-path message instead of silently no-opping later", async () => {
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      mockShowInputBox.mockResolvedValue(undefined); // simulate cancelling after seeing the error

      await registeredCommands.get("nexus.macro.renameFolder")!(folderArg("Cisco"));

      const options = mockShowInputBox.mock.calls[0][0] as { validateInput: (v: string) => string | null };
      expect(options.validateInput("..")).toBeTruthy();
      expect(options.validateInput(".")).toBeTruthy();
      expect(options.validateInput("Routers\\Old")).toBeTruthy();
      expect(options.validateInput("Routers")).toBeNull();
    });
  });

  describe("nexus.macro.removeFolder — re-parents, never deletes (§4.7)", () => {
    it("removes an empty folder silently, no confirmation needed", async () => {
      await store.saveFolders(["Empty"]);

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Empty"));

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
      expect(getMacroFolders()).not.toContain("Empty");
    });

    it("re-parents descendants to the parent folder, preserving substructure, and deletes no macros", async () => {
      await store.save([
        { name: "Direct", text: "t", group: "Cisco/Routers" },
        { name: "Nested", text: "t", group: "Cisco/Routers/Old" }
      ]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Cisco/Routers"));

      const macros = getMacros();
      expect(macros).toHaveLength(2); // nothing deleted
      expect(macros.find((m) => m.name === "Direct")?.group).toBe("Cisco");
      expect(macros.find((m) => m.name === "Nested")?.group).toBe("Cisco/Old");
    });

    it("re-parents to root when the removed folder was top-level", async () => {
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Cisco"));

      expect(getMacros()[0].group).toBeUndefined();
    });

    it("cancelling the confirmation leaves everything untouched", async () => {
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      mockShowWarningMessage.mockResolvedValue(undefined);

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Cisco"));

      expect(getMacros()[0].group).toBe("Cisco");
    });

    it("prefix-safety: removing 'Net' must not touch macros in 'Network'", async () => {
      await store.save([
        { name: "InNet", text: "t", group: "Net" },
        { name: "InNetwork", text: "t", group: "Network" }
      ]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Net"));

      expect(getMacros().find((m) => m.name === "InNetwork")?.group).toBe("Network");
    });

    it("no-ops without a folder arg", async () => {
      await registeredCommands.get("nexus.macro.removeFolder")!(undefined);
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    /**
     * The explicit-folder list (`nexus.macros.folders`) is the SECOND thing
     * `removeMacroFolder` rewrites, and nothing was watching it: every
     * assertion in this block checked either that the removed folder was gone
     * or where the macros ended up, so replacing the whole final
     * `saveMacroFolders([...nextExplicit])` with `saveMacroFolders([])` — "Remove
     * Folder wipes every explicit folder in the store" — passed all 131 tests
     * across this file, macroTreeProvider, macroCommands and
     * macroCommandsIdentity. An explicit folder is the empty folder a user
     * deliberately created; wiping the list destroys every one of them, and the
     * only symptom is folders quietly vanishing from the sidebar.
     */
    it("an unrelated explicit folder survives the removal", async () => {
      await store.saveFolders(["Empty", "Other"]);

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Empty"));

      expect(getMacroFolders()).toEqual(["Other"]);
    });

    it("an explicit DESCENDANT folder is re-parented, keeping its substructure", async () => {
      // The folder-list mirror of the macro re-parenting asserted above: an
      // explicit "Cisco/Routers/Old" must come back as "Cisco/Old", not vanish
      // with its parent and not keep its old path.
      // Each folder removed in these three holds a subfolder, so it now asks
      // first (#288); confirming is what lets the re-parenting run.
      await store.saveFolders(["Cisco", "Cisco/Routers", "Cisco/Routers/Old"]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Cisco/Routers"));

      expect(getMacroFolders().sort()).toEqual(["Cisco", "Cisco/Old"]);
    });

    it("an explicit descendant of a TOP-LEVEL folder re-parents to the root", async () => {
      await store.saveFolders(["Cisco", "Cisco/Routers"]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Cisco"));

      expect(getMacroFolders()).toEqual(["Routers"]);
    });

    it("prefix-safety in the explicit list too: 'Network' survives removing 'Net'", async () => {
      await store.saveFolders(["Net", "Net/Sub", "Network"]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Net"));

      expect(getMacroFolders().sort()).toEqual(["Network", "Sub"]);
    });

    it("Fix 2 (MAJOR) — a macro saved WHILE the confirmation dialog is open must not be discarded by a stale pre-dialog snapshot", async () => {
      // Reproduces the exact scenario from the review: start removing "Cisco"
      // from [A(group=Cisco), B(root)]; while the modal warning is open,
      // something else saves a THIRD macro; confirm. Writing back the array
      // captured before the dialog opened would silently drop it.
      await store.save([
        { name: "A", text: "t", group: "Cisco" },
        { name: "B", text: "t" }
      ]);
      mockShowWarningMessage.mockImplementation(async () => {
        // Models a concurrent save landing during the (user-paced) modal.
        // `{ modal: true }` blocks the USER, not the extension host, so this is
        // another same-window flow: the Macro Editor, a config import, another
        // macro command. (Not another window — see macroCommandsIdentity.test.ts.)
        await store.save([...getMacros(), { name: "C", text: "t" }]);
        return "Remove Folder";
      });

      await registeredCommands.get("nexus.macro.removeFolder")!(folderArg("Cisco"));

      const macros = getMacros();
      expect(macros.map((m) => m.name)).toContain("C"); // must survive the dialog window
      expect(macros.find((m) => m.name === "A")?.group).toBeUndefined(); // still re-parented to root
      expect(macros).toHaveLength(3);
    });
  });

  /**
   * #288 — the confirmation was guarded by the number of MACROS beneath the
   * folder, so a folder holding only subfolders was removed without asking and
   * its subfolders silently moved up a level. Each test hands the command the
   * FolderTreeItem the Macros view itself draws, so the subfolder count is
   * checked against the folders a user can actually see.
   */
  describe("nexus.macro.removeFolder — asks before moving subfolders (#288)", () => {
    let provider: MacroTreeProvider;

    beforeEach(() => {
      provider = new MacroTreeProvider();
    });

    const removeFolder = async (path: string): Promise<void> => {
      await registeredCommands.get("nexus.macro.removeFolder")!(drawnFolder(provider, path));
    };
    const storedFolders = (): string[] => [...store.getFolders()].sort();

    it("a folder holding only subfolders asks first, counts them, and offers the single Remove Folder button", async () => {
      await store.saveFolders(["TEST1", "TEST1/TEST2", "TEST1/TEST2/TEST3"]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await removeFolder("TEST1");

      expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Remove folder "TEST1"? It contains 2 subfolders — they will be moved to the root.',
        { modal: true },
        "Remove Folder"
      );
      // No macro is beneath it, so none is counted: "0 macros" is what a fix
      // that only widened the guard would print.
      expect(mockShowWarningMessage.mock.calls[0][0]).not.toMatch(/\b0 macros?\b/);
    });

    it("confirming moves the subfolders up one level, substructure kept, through the folder-list save", async () => {
      await store.saveFolders(["TEST1", "TEST1/TEST2", "TEST1/TEST2/TEST3"]);
      const saveFolders = vi.spyOn(store, "saveFolders");
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await removeFolder("TEST1");

      expect(saveFolders).toHaveBeenCalledTimes(1);
      expect(storedFolders()).toEqual(["TEST2", "TEST2/TEST3"]);
      expect(drawnTree(provider)).toEqual(["TEST2", "  TEST3"]);
    });

    it("dismissing the confirmation removes nothing and saves nothing", async () => {
      await store.saveFolders(["TEST1", "TEST1/TEST2", "TEST1/TEST2/TEST3"]);
      const saveFolders = vi.spyOn(store, "saveFolders");
      const saveMacros = vi.spyOn(store, "save");
      mockShowWarningMessage.mockResolvedValue(undefined);

      await removeFolder("TEST1");

      expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
      expect(saveFolders).not.toHaveBeenCalled();
      expect(saveMacros).not.toHaveBeenCalled();
      expect(storedFolders()).toEqual(["TEST1", "TEST1/TEST2", "TEST1/TEST2/TEST3"]);
      expect(drawnTree(provider)).toEqual(["TEST1", "  TEST2", "    TEST3"]);
    });

    it("one subfolder is singular, noun and pronoun, and a nested folder's goes to the parent folder", async () => {
      await store.saveFolders(["Cisco", "Cisco/Routers", "Cisco/Routers/Old"]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await removeFolder("Cisco/Routers");

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Remove folder "Routers"? It contains 1 subfolder — it will be moved to the parent folder.',
        { modal: true },
        "Remove Folder"
      );
      expect(mockShowWarningMessage.mock.calls[0][0]).not.toContain("they will be moved");
      expect(drawnTree(provider)).toEqual(["Cisco", "  Old"]);
    });

    it("a folder holding only macros: one macro is singular, noun and pronoun; several keep the plural wording", async () => {
      await store.save([
        { name: "Top", text: "t", group: "Cisco" },
        { name: "E1", text: "t", group: "Lab/Edge" },
        { name: "E2", text: "t", group: "Lab/Edge" }
      ]);
      mockShowWarningMessage.mockResolvedValue(undefined);

      await removeFolder("Cisco");
      await removeFolder("Lab/Edge");

      // The single-macro text used to read "1 macro — they will be moved".
      expect(mockShowWarningMessage).toHaveBeenNthCalledWith(
        1,
        'Remove folder "Cisco"? It contains 1 macro — it will be moved to the root.',
        { modal: true },
        "Remove Folder"
      );
      expect(mockShowWarningMessage.mock.calls[0][0]).not.toContain("they will be moved");
      // Unchanged from before subfolders were counted.
      expect(mockShowWarningMessage).toHaveBeenNthCalledWith(
        2,
        'Remove folder "Edge"? It contains 2 macros — they will be moved to the parent folder.',
        { modal: true },
        "Remove Folder"
      );
    });

    it("one macro beside two subfolders is still several things moving: 'they'", async () => {
      // The pronoun follows the total, not the macro count alone.
      await store.saveFolders(["Core", "Core/Lab", "Core/Lab/Spare"]);
      await store.save([{ name: "C", text: "t", group: "Core/Lab/Edge" }]);
      mockShowWarningMessage.mockResolvedValue(undefined);

      await removeFolder("Core/Lab");

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Remove folder "Lab"? It contains 1 macro and 2 subfolders — they will be moved to the parent folder.',
        { modal: true },
        "Remove Folder"
      );
    });

    it("macros and subfolders are both counted, whether a subfolder was created or is implied by a macro's folder", async () => {
      await store.saveFolders(["Net", "Net/Lab", "Net/Lab/Spare"]);
      await store.save([
        { name: "A", text: "t", group: "Net/Lab" },
        { name: "B", text: "t", group: "Net/Lab" },
        { name: "C", text: "t", group: "Net/Lab/Edge" }
      ]);
      expect(drawnTree(provider)).toEqual(["Net", "  Lab", "    Edge", "    Spare"]);
      mockShowWarningMessage.mockResolvedValue("Remove Folder");

      await removeFolder("Net/Lab");

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Remove folder "Lab"? It contains 3 macros and 2 subfolders — they will be moved to the parent folder.',
        { modal: true },
        "Remove Folder"
      );
      expect(getMacros().map((m) => m.group)).toEqual(["Net", "Net", "Net/Edge"]);
      expect(drawnTree(provider)).toEqual(["Net", "  Edge", "  Spare"]);
    });

    it("an empty folder is still removed without asking", async () => {
      await store.saveFolders(["Empty"]);

      await removeFolder("Empty");

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
      expect(storedFolders()).toEqual([]);
    });

    it("prefix-safety: 'AB' and 'A-1' are not subfolders of 'A', so an empty 'A' beside them is still removed without asking", async () => {
      await store.saveFolders(["A", "AB", "AB/Sub", "A-1", "A-1/Sub"]);
      await store.save([
        { name: "InAB", text: "t", group: "AB" },
        { name: "InA1", text: "t", group: "A-1/Deep" }
      ]);

      await removeFolder("A");

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
      expect(storedFolders()).toEqual(["A-1", "A-1/Sub", "AB", "AB/Sub"]);
    });

    it("prefix-safety: a non-empty 'A' counts only what is really beneath it", async () => {
      await store.saveFolders(["A", "A/X", "AB", "AB/Sub", "A-1"]);
      await store.save([
        { name: "InA", text: "t", group: "A" },
        { name: "InAB", text: "t", group: "AB/Sub" },
        { name: "InA1", text: "t", group: "A-1/Deep" }
      ]);
      mockShowWarningMessage.mockResolvedValue(undefined);

      await removeFolder("A");

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Remove folder "A"? It contains 1 macro and 1 subfolder — they will be moved to the root.',
        { modal: true },
        "Remove Folder"
      );
    });
  });

  describe("nexus.macro.moveUp / moveDown — group-aware reorder (§4.4)", () => {
    it("swaps with the previous macro sharing the same group, even when non-adjacent in the array", async () => {
      await store.save([
        { name: "RootA", text: "t" },
        { name: "InFolder1", text: "t", group: "Cisco" },
        { name: "RootB", text: "t" },
        { name: "InFolder2", text: "t", group: "Cisco" }
      ]);

      // Move "InFolder2" (index 3) up — its only same-group neighbour is
      // "InFolder1" at index 1, NOT the adjacent index 2 ("RootB").
      await registeredCommands.get("nexus.macro.moveUp")!(macroArg(3));

      const names = getMacros().map((m) => m.name);
      expect(names).toEqual(["RootA", "InFolder2", "RootB", "InFolder1"]);
    });

    it("Fix 8 — swaps DOWN with the next macro sharing the same group, even when non-adjacent in the array", async () => {
      // The only prior Move Down fixture ("no-ops at the bottom of a
      // folder") put the moved item at the PHYSICAL END of the array, where
      // an adjacent-only implementation and the correct group-aware one both
      // report "no next element" — identical no-op, no discrimination. This
      // fixture mirrors the existing non-adjacent Move UP test above: F1's
      // only same-group neighbour ("F2") is two slots away, not the
      // adjacent "Root".
      await store.save([
        { name: "F1", text: "t", group: "Cisco" },
        { name: "Root", text: "t" },
        { name: "F2", text: "t", group: "Cisco" }
      ]);

      await registeredCommands.get("nexus.macro.moveDown")!(macroArg(0));

      // An adjacent-only implementation would swap F1 with "Root", yielding
      // [Root, F1, F2] — F1 still precedes F2 inside "Cisco", so from the
      // folder's perspective it LOOKS unchanged (a silent no-op dressed up
      // as a swap). The correct group-aware swap exchanges F1 and F2 directly.
      expect(getMacros().map((m) => m.name)).toEqual(["F2", "Root", "F1"]);
    });

    it("no-ops at the top of a folder with folder-specific wording", async () => {
      await store.save([
        { name: "First", text: "t", group: "Cisco" },
        { name: "RootA", text: "t" },
        { name: "Second", text: "t", group: "Cisco" }
      ]);

      await registeredCommands.get("nexus.macro.moveUp")!(macroArg(0));

      expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Already at the top of this folder", 2000);
      expect(getMacros().map((m) => m.name)).toEqual(["First", "RootA", "Second"]); // unchanged
    });

    it("no-ops at the bottom of a folder with folder-specific wording, leaving the array untouched", async () => {
      // Two things the previous version of this test could not see. It put the
      // moved macro at the PHYSICAL END of the array, where an implementation
      // that ignores groups entirely also finds no next element — identical
      // no-op, no discrimination. And it asserted only the status message, so
      // an implementation that showed the message AND swapped anyway survived.
      // Here "Second" is last within "Cisco" but NOT last in the array, and
      // the array is asserted.
      await store.save([
        { name: "First", text: "t", group: "Cisco" },
        { name: "Second", text: "t", group: "Cisco" },
        { name: "RootA", text: "t" }
      ]);

      await registeredCommands.get("nexus.macro.moveDown")!(macroArg(1));

      expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Already at the bottom of this folder", 2000);
      expect(getMacros().map((m) => m.name)).toEqual(["First", "Second", "RootA"]);
    });

    it("no-ops at the top of the ROOT list with root wording when no macro has a group", async () => {
      await store.save([
        { name: "A", text: "t" },
        { name: "B", text: "t" }
      ]);

      await registeredCommands.get("nexus.macro.moveUp")!(macroArg(0));

      expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Already at the top of the list", 2000);
    });

    it("no-ops at the bottom of the ROOT list with root wording when no macro has a group", async () => {
      await store.save([
        { name: "A", text: "t" },
        { name: "B", text: "t" }
      ]);

      await registeredCommands.get("nexus.macro.moveDown")!(macroArg(1));

      expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Already at the bottom of the list", 2000);
    });

    it("behaves exactly like a plain adjacent swap when no macro has a group at all (unchanged flat behaviour)", async () => {
      await store.save([
        { name: "A", text: "t" },
        { name: "B", text: "t" },
        { name: "C", text: "t" }
      ]);

      await registeredCommands.get("nexus.macro.moveDown")!(macroArg(0));

      expect(getMacros().map((m) => m.name)).toEqual(["B", "A", "C"]);
    });
  });

  describe("quick picks disambiguate by folder (§4.8 — detail, not description)", () => {
    it("nexus.macro.run puts the folder path in `detail`, preserving `description`'s existing content", async () => {
      await store.save([{ name: "M", text: "echo hi", group: "Cisco" }]);
      mockShowQuickPick.mockResolvedValue(undefined);

      await registeredCommands.get("nexus.macro.run")!();

      const items = mockShowQuickPick.mock.calls[0][0] as Array<{ description: string; detail?: string }>;
      expect(items[0].detail).toBe("Folder: Cisco");
      expect(items[0].description).toContain("echo hi");
    });

    it("a root macro (no group) has no detail", async () => {
      await store.save([{ name: "M", text: "echo hi" }]);
      mockShowQuickPick.mockResolvedValue(undefined);

      await registeredCommands.get("nexus.macro.run")!();

      const items = mockShowQuickPick.mock.calls[0][0] as Array<{ detail?: string }>;
      expect(items[0].detail).toBeUndefined();
    });
  });
});
