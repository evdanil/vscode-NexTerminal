import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMacroCommands } from "../../src/commands/macroCommands";
import { MacroEditorPanel } from "../../src/ui/macroEditorPanel";
import { getAssignedBinding } from "../../src/macroBindingHelpers";
import { VARIABLE_MARKER } from "../../src/ui/macroVariableMarker";

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
const mockRunMacro = vi.fn();

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

vi.mock("../../src/commands/macroVariablePrompt", () => ({
  runMacro: (...args: unknown[]) => mockRunMacro(...args)
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
    // `id` is a MacroStore invariant — both store implementations assign one
    // in save(), and VscodeMacroStore assigns one again on reload — so
    // everything getMacros() returns carries one. The command resolves its
    // target by id across the clipboard/prompt awaits.
    const macros = [{ id: "pw-1", name: "Password", text: "old", secret: true }];
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

describe("macroCommands copyAllAsJson (Fix 1 — output-path sanitization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    registerMacroCommands();
  });

  it("does not leak a masked variable's plaintext default into the clipboard JSON", async () => {
    const macros = [
      {
        name: "Login",
        text: "login $password\n",
        variables: [{ name: "password", secret: true, default: "hunter2" }]
      }
    ];
    mockGetMacros.mockReturnValue(macros);

    const copyAllAsJson = registeredCommands.get("nexus.macro.copyAllAsJson");
    expect(copyAllAsJson).toBeDefined();
    await copyAllAsJson!();

    expect(mockClipboardWriteText).toHaveBeenCalledTimes(1);
    const written = mockClipboardWriteText.mock.calls[0][0] as string;
    expect(written).not.toContain("hunter2");

    const parsed = JSON.parse(written);
    expect(parsed[0].variables).toEqual([{ name: "password", secret: true }]);
  });

  it("Fix C boundary — drops an array-like (non-array) variables value entirely, rather than leaking its plaintext default", async () => {
    // The well-formed-array test above can't catch this: the pre-fix
    // withRedactedVariables() only ran its redaction loop on real arrays, so an
    // array-like object (e.g. reconstructed from a hand-edited settings.json) passed
    // through untouched, plaintext default and all.
    const macros = [
      {
        name: "Login",
        text: "login $password\n",
        variables: { 0: { name: "password", secret: true, default: "hunter2" }, length: 1 }
      }
    ];
    mockGetMacros.mockReturnValue(macros);

    const copyAllAsJson = registeredCommands.get("nexus.macro.copyAllAsJson");
    expect(copyAllAsJson).toBeDefined();
    await copyAllAsJson!();

    expect(mockClipboardWriteText).toHaveBeenCalledTimes(1);
    const written = mockClipboardWriteText.mock.calls[0][0] as string;
    expect(written).not.toContain("hunter2");

    const parsed = JSON.parse(written);
    expect(parsed[0].variables).toBeUndefined();
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
      "Scoped auto-trigger example",
      "IPMI SOL console",
      "Launch IPMI web console"
    ]);
  });

  it("creates the IPMI SOL console template with the BMC address from the profile and the password masked (§9.7, issue #48)", async () => {
    const macros: unknown[] = [];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ label: "IPMI SOL console", templateId: "prompted-command" });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    expect(macros[0]).toMatchObject({
      text: expect.stringContaining("ipmitool"),
      runIn: "localTerminal",
      variables: [
        { name: "username", label: "Username" },
        { name: "password", label: "Password", secret: true }
      ]
    });
    const created = macros[0] as { text: string; variables: Array<{ name: string; secret?: boolean; default?: string }> };
    // The address is a fact about the server profile, not something to retype
    // on every run — and `$host` must NOT be declared any more, or the template
    // would prompt for what the profile already knows.
    expect(created.text).toContain("-H ${profile.ipmiHost}");
    expect(created.variables.some((v) => v.name === "host")).toBe(false);
    expect(created.text).toContain("$username");
    expect(created.text).toContain("$password");
    // §7.1 — a masked variable must never carry a default (plaintext in the store).
    expect(created.variables.find((v) => v.secret)?.default).toBeUndefined();
    // A shipped example must never demonstrate a literal password on the command
    // line: argv is visible in `ps`, in the scrollback, and in the extension's own
    // TerminalCaptureBuffer (which `nexus.terminal.copyAll` exports).
    expect(created.text).not.toMatch(/-P\s+(?!\$password)\S/);
    expect(mockSaveMacros).toHaveBeenCalledWith(macros);
  });

  it("creates the IPMI web console template as a browser macro with no trailing newline", async () => {
    const macros: unknown[] = [];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ label: "Launch IPMI web console", templateId: "ipmi-web-console" });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    expect(macros[0]).toMatchObject({
      text: "https://${profile.ipmiHost}/",
      runIn: "browser"
    });
    // No trailing newline, deliberately: a build that does not know `runIn`
    // pastes the URL into a terminal instead of executing anything.
    expect((macros[0] as { text: string }).text.endsWith("\n")).toBe(false);
    expect((macros[0] as { triggerPattern?: string }).triggerPattern).toBeUndefined();
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

describe("macroCommands variable routing (§8.5)", () => {
  const plainMacro = { name: "Plain", text: "show version\n" };
  const variableMacro = {
    name: "Prompted",
    text: "$host",
    variables: [{ name: "host" }]
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockGetMacros.mockReturnValue([]);
    mockRunMacro.mockResolvedValue(undefined);
    registerMacroCommands();
  });

  it("nexus.macro.run sends a variable-free macro through sendMacroText unchanged, never through runMacro", async () => {
    mockGetMacros.mockReturnValue([plainMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });

    await registeredCommands.get("nexus.macro.run")!();

    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", {
      text: "show version\n"
    });
    expect(mockRunMacro).not.toHaveBeenCalled();
  });

  it("nexus.macro.run routes a macro with variables through runMacro, never through sendMacroText", async () => {
    mockGetMacros.mockReturnValue([variableMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });

    await registeredCommands.get("nexus.macro.run")!();

    expect(mockRunMacro).toHaveBeenCalledWith(variableMacro);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  it("nexus.macro.run marks a variable macro's quick-pick description, but not a plain macro's (§9.6)", async () => {
    mockGetMacros.mockReturnValue([plainMacro, variableMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });

    await registeredCommands.get("nexus.macro.run")!();

    const items = mockShowQuickPick.mock.calls[0][0] as Array<{ label: string; description: string }>;
    expect(items[0].description).not.toContain(VARIABLE_MARKER.trim());
    expect(items[1].description).toContain(VARIABLE_MARKER.trim());
  });

  it("nexus.macro.run badges a macro that does not run in the session (issue #48)", async () => {
    const browserMacro = { name: "BMC", text: "https://10.0.0.9/", runIn: "browser" as const };
    mockGetMacros.mockReturnValue([plainMacro, browserMacro]);
    mockShowQuickPick.mockResolvedValue(undefined);

    await registeredCommands.get("nexus.macro.run")!();

    const items = mockShowQuickPick.mock.calls[0][0] as Array<{ description: string }>;
    // "sends a line to this terminal" and "opens a browser window" must not
    // look identical in the list they are picked from.
    expect(items[0].description).not.toContain("[");
    expect(items[1].description).toContain("[Browser]");
  });

  it("nexus.macro.run hands the picked profile-token macro to Run Macro on Server, not just the command", async () => {
    const profileMacro = { name: "SOL", text: "ipmitool -H ${profile.ipmiHost}\n" };
    mockGetMacros.mockReturnValue([profileMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });
    mockShowInformationMessage.mockResolvedValue("Run Macro on Server…");

    await registeredCommands.get("nexus.macro.run")!();

    // Without the argument the redirect makes the user pick the macro a second
    // time, having already picked it here.
    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.server.runMacro", { macro: profileMacro });
  });

  it("nexus.macro.run: a cancelled resolve (runMacro resolves without sending) results in no sendMacroText call either", async () => {
    mockGetMacros.mockReturnValue([variableMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });
    mockRunMacro.mockResolvedValue(undefined); // simulates runMacro's own cancel path (§8.3) — it never throws

    await registeredCommands.get("nexus.macro.run")!();

    expect(mockRunMacro).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  it("nexus.macro.runBinding routes through runMacro for a bound macro with variables", async () => {
    mockGetMacros.mockReturnValue([variableMacro]);
    vi.mocked(getAssignedBinding).mockImplementation((m) => (m === variableMacro ? "alt+1" : undefined));

    await registeredCommands.get("nexus.macro.runBinding")!({ binding: "alt+1" });

    expect(mockRunMacro).toHaveBeenCalledWith(variableMacro);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  it("nexus.macro.runBinding sends a variable-free bound macro through sendMacroText unchanged", async () => {
    mockGetMacros.mockReturnValue([plainMacro]);
    vi.mocked(getAssignedBinding).mockImplementation((m) => (m === plainMacro ? "alt+1" : undefined));

    await registeredCommands.get("nexus.macro.runBinding")!({ binding: "alt+1" });

    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", { text: "show version\n" });
    expect(mockRunMacro).not.toHaveBeenCalled();
  });

  it("nexus.macro.slot routes a slot-matched macro with variables through runMacro", async () => {
    const slotMacro = { ...variableMacro, slot: 1 };
    mockGetMacros.mockReturnValue([slotMacro]);

    await registeredCommands.get("nexus.macro.slot")!({ index: 0 }); // targetSlot = (0+1)%10 = 1

    expect(mockRunMacro).toHaveBeenCalledWith(slotMacro);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  it("nexus.macro.slot sends a variable-free slot-matched macro through sendMacroText unchanged", async () => {
    const slotMacro = { ...plainMacro, slot: 1 };
    mockGetMacros.mockReturnValue([slotMacro]);

    await registeredCommands.get("nexus.macro.slot")!({ index: 0 });

    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", { text: "show version\n" });
    expect(mockRunMacro).not.toHaveBeenCalled();
  });

  it("nexus.macro.runItem routes a macro with variables through runMacro", async () => {
    await registeredCommands.get("nexus.macro.runItem")!({ index: 0, macro: variableMacro });

    expect(mockRunMacro).toHaveBeenCalledWith(variableMacro);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("workbench.action.terminal.sendSequence", expect.anything());
  });

  it("nexus.macro.runItem sends a variable-free macro through sendMacroText unchanged", async () => {
    await registeredCommands.get("nexus.macro.runItem")!({ index: 0, macro: plainMacro });

    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", { text: "show version\n" });
    expect(mockRunMacro).not.toHaveBeenCalled();
  });
});
