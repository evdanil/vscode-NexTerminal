import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMacroCommands } from "../../src/commands/macroCommands";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockExecuteCommand = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockClipboardReadText = vi.fn();
const mockClipboardWriteText = vi.fn();
const mockGetMacros = vi.fn();
const mockSaveMacros = vi.fn();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  },
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args)
  },
  env: {
    clipboard: {
      readText: (...args: unknown[]) => mockClipboardReadText(...args),
      writeText: (...args: unknown[]) => mockClipboardWriteText(...args)
    }
  },
  InputBoxValidationSeverity: {
    Warning: 2
  }
}));

vi.mock("../../src/macroSettings", () => ({
  confirmBindingWarnings: vi.fn(async () => true),
  getMacros: (...args: unknown[]) => mockGetMacros(...args),
  saveMacros: (...args: unknown[]) => mockSaveMacros(...args)
}));

vi.mock("../../src/ui/macroEditorPanel", () => ({
  MacroEditorPanel: {
    open: vi.fn(),
    openNew: vi.fn()
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

describe("macroCommands clipboard actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockGetMacros.mockReturnValue([]);
    registerMacroCommands();
  });

  it("copies secret macro values to the clipboard", async () => {
    const copySecret = registeredCommands.get("nexus.macro.copySecret");
    expect(copySecret).toBeDefined();

    await copySecret!({ index: 0, macro: { name: "Password", text: "hunter2", secret: true } });

    expect(mockClipboardWriteText).toHaveBeenCalledWith("hunter2");
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Copied "Password" value to clipboard.');
  });

  it("shows an informative message when pasting with an empty clipboard", async () => {
    const pasteSecret = registeredCommands.get("nexus.macro.pasteSecret");
    expect(pasteSecret).toBeDefined();
    mockClipboardReadText.mockResolvedValue("");

    await pasteSecret!({ index: 0, macro: { name: "Password", text: "old", secret: true } });

    expect(mockShowInformationMessage).toHaveBeenCalledWith("Clipboard is empty.");
    expect(mockSaveMacros).not.toHaveBeenCalled();
  });

  it("can append a newline before saving pasted secret text", async () => {
    const macros = [{ name: "Password", text: "old", secret: true }];
    const pasteSecret = registeredCommands.get("nexus.macro.pasteSecret");
    expect(pasteSecret).toBeDefined();
    mockGetMacros.mockReturnValue(macros);
    mockClipboardReadText.mockResolvedValue("new-secret");
    mockShowInformationMessage
      .mockResolvedValueOnce("Yes")
      .mockResolvedValueOnce(undefined);

    await pasteSecret!({ index: 0, macro: macros[0] });

    expect(mockShowInformationMessage).toHaveBeenNthCalledWith(
      1,
      "Append newline (\\n) to the end of the pasted text?",
      "Yes",
      "No"
    );
    expect(macros[0].text).toBe("new-secret\n");
    expect(mockSaveMacros).toHaveBeenCalledWith(macros);
    expect(mockShowInformationMessage).toHaveBeenNthCalledWith(2, 'Updated "Password" from clipboard.');
  });
});
