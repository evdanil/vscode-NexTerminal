import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMacroCommands } from "../../src/commands/macroCommands";
import { MacroEditorPanel } from "../../src/ui/macroEditorPanel";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockExecuteCommand = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowQuickPick = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockClipboardReadText = vi.fn();
const mockClipboardWriteText = vi.fn();
const mockOpenExternal = vi.fn();
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
    openExternal: (...args: unknown[]) => mockOpenExternal(...args),
    clipboard: {
      readText: (...args: unknown[]) => mockClipboardReadText(...args),
      writeText: (...args: unknown[]) => mockClipboardWriteText(...args)
    }
  },
  Uri: {
    parse: (value: string) => ({ toString: () => value, value })
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

describe("macroCommands documentation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockGetMacros.mockReturnValue([]);
    registerMacroCommands();
  });

  it("registers openDocs and opens the macro guide on GitHub", async () => {
    const openDocs = registeredCommands.get("nexus.macro.openDocs");
    expect(openDocs).toBeDefined();

    await openDocs!();

    expect(mockOpenExternal).toHaveBeenCalled();
    const arg = mockOpenExternal.mock.calls[0][0] as { toString: () => string };
    expect(arg.toString()).toMatch(/github\.com/);
    expect(arg.toString()).toMatch(/docs\/macros\.md/);
  });
});

describe("macroCommands template actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockGetMacros.mockReturnValue([]);
    mockShowQuickPick.mockImplementation(async (items: unknown) => Array.isArray(items) ? items[0] : undefined);
    registerMacroCommands();
  });

  it("registers addFromTemplate and offers starter macro templates", async () => {
    const addFromTemplate = registeredCommands.get("nexus.macro.addFromTemplate");
    expect(addFromTemplate).toBeDefined();

    await addFromTemplate!();

    const labels = mockShowQuickPick.mock.calls[0][0].map((item: { label: string }) => item.label);
    expect(labels).toEqual([
      "Send command",
      "Send password when prompted",
      "Wait and send confirmation",
      "Scoped auto-trigger example"
    ]);
  });

  it("creates the selected macro through getMacros and saveMacros then opens it", async () => {
    const macros = [{ name: "Existing", text: "show version\n" }];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ label: "Wait and send confirmation", templateId: "confirm" });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    expect(macros[1]).toMatchObject({
      name: "Confirm yes",
      text: "yes\n",
      triggerPattern: expect.stringMatching(/confirm|continue/i)
    });
    expect(mockSaveMacros).toHaveBeenCalledWith(macros);
    expect(MacroEditorPanel.open).toHaveBeenCalledWith(1);
  });

  it("creates the secret template without storing plaintext sample secrets", async () => {
    const macros: unknown[] = [];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ label: "Send password when prompted", templateId: "password" });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    expect(macros[0]).toMatchObject({
      name: "Password prompt",
      text: "",
      secret: true,
      triggerPattern: "[Pp]assword:\\s*$",
      triggerScope: "active-session",
      triggerInitiallyDisabled: true
    });
    expect(JSON.stringify(macros[0])).not.toMatch(/password123|hunter2|changeme/i);
    expect(mockSaveMacros).toHaveBeenCalledWith(macros);
  });

  it("does not save a macro when template selection is cancelled", async () => {
    mockShowQuickPick.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    expect(mockSaveMacros).not.toHaveBeenCalled();
    expect(MacroEditorPanel.open).not.toHaveBeenCalled();
  });
});
