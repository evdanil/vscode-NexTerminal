import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowInputBox = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockSetStatusBarMessage = vi.fn();
const mockOpenNew = vi.fn();

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

/** A tree-item-shaped arg carrying a macro at its TRUE getMacros() index — mirrors MacroTreeItem's duck-typed shape. */
function macroArg(index: number): { macro: TerminalMacro; index: number } {
  return { macro: getMacros()[index], index };
}

/** A folder-tree-item-shaped arg — mirrors FolderTreeItem's duck-typed `folderPath` shape (§4.6, §4.7). */
function folderArg(path: string): { folderPath: string } {
  return { folderPath: path };
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

    it("naming an already-existing folder is a no-op with an info message, not an error", async () => {
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      mockShowInputBox.mockResolvedValue("Cisco");

      await registeredCommands.get("nexus.macro.newFolder")!();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining("already exists"));
      expect(getMacroFolders()).toEqual([]); // nothing NEW was persisted
    });

    it("rejects a path-traversal folder name via validateInput", async () => {
      mockShowInputBox.mockResolvedValue(undefined); // simulate the user cancelling after seeing the error
      await registeredCommands.get("nexus.macro.newFolder")!();

      const options = mockShowInputBox.mock.calls[0][0] as { validateInput: (v: string) => string | null };
      expect(options.validateInput("../secrets")).toBeTruthy();
      expect(options.validateInput("Cisco/Routers")).toBeNull();
    });
  });

  describe("nexus.macro.moveToFolder (§4.6, §4.7)", () => {
    it("on a tree item, moves just that one macro", async () => {
      await store.save([
        { name: "A", text: "t" },
        { name: "B", text: "t" }
      ]);
      mockShowQuickPick.mockImplementation(async (items: Array<{ folderKind: string }>) =>
        items.find((i) => i.folderKind === "root")
      );

      await registeredCommands.get("nexus.macro.moveToFolder")!(macroArg(1));

      const macros = getMacros();
      expect(macros[0].group).toBeUndefined();
      expect(macros[1].group).toBeUndefined();
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

    it("cancelling (or re-entering the same name) does nothing", async () => {
      await store.save([{ name: "M", text: "t", group: "Cisco" }]);
      mockShowInputBox.mockResolvedValue(undefined);

      await registeredCommands.get("nexus.macro.renameFolder")!(folderArg("Cisco"));

      expect(getMacros()[0].group).toBe("Cisco");
    });

    it("no-ops without a folder arg", async () => {
      await registeredCommands.get("nexus.macro.renameFolder")!(undefined);
      expect(mockShowInputBox).not.toHaveBeenCalled();
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

    it("no-ops at the bottom of a folder with folder-specific wording", async () => {
      await store.save([
        { name: "First", text: "t", group: "Cisco" },
        { name: "RootA", text: "t" },
        { name: "Second", text: "t", group: "Cisco" }
      ]);

      await registeredCommands.get("nexus.macro.moveDown")!(macroArg(2));

      expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Already at the bottom of this folder", 2000);
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
