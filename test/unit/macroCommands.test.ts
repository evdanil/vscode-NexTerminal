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
      "IPMI SOL console (via jump host)",
      "IPMI Power Status",
      "IPMI Power On",
      "IPMI Power Off (hard, no OS shutdown)",
      "Launch IPMI web console"
    ]);
  });

  it("creates the IPMI SOL console template with the BMC address, username and password all off the profile (§9.7, issue #48 PR-B)", async () => {
    const macros: unknown[] = [];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ label: "IPMI SOL console", templateId: "prompted-command" });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    expect(macros[0]).toMatchObject({
      text: expect.stringContaining("ipmitool"),
      runIn: "localTerminal",
      // The template is the one place the extension itself vouches that the
      // command is ipmitool, so it ships with the credential opt-in already set.
      provideIpmiCredentials: true
    });
    const created = macros[0] as { text: string; variables?: Array<{ name: string }> };
    // Both facts come from the server profile, not from a prompt: the address,
    // and — new in PR-B — the BMC username, off the linked IPMI auth profile.
    expect(created.text).toContain("-H ${profile.ipmiHost}");
    expect(created.text).toContain("-U ${profile.ipmiUsername}");
    // No prompted variables at all any more: the password reaches ipmitool
    // through the environment (`-E`), so there is nothing left to type.
    expect(created.variables).toBeUndefined();
    expect(created.text).toContain(" -E ");
    // A shipped example must never demonstrate a literal password on the command
    // line: argv is visible in `ps`, in the scrollback, and in the extension's own
    // TerminalCaptureBuffer (which `nexus.terminal.copyAll` exports).
    expect(created.text).not.toContain("-P ");
    expect(mockSaveMacros).toHaveBeenCalledWith(macros);
  });

  it("ships the jump-host SOL template with route:ipmiGateway, the -a form, and NO credential flag (issue #48 PR-C)", async () => {
    const macros: unknown[] = [];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ templateId: "ipmi-sol-gateway" });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    const created = macros[0] as { text: string; runIn?: string; route?: string; provideIpmiCredentials?: boolean };
    expect(created.runIn).toBe("localTerminal");
    // The route is what makes this the gateway sibling — a template insert is a
    // LOCAL action, so the shipped route survives insertion (fails against a
    // template shipped without the route, which would run locally like PR-B's).
    expect(created.route).toBe("ipmiGateway");
    // `-a`, never `-E`: env injection can't cross to the gateway shell, so
    // ipmitool prompts on the bastion. The credential flag would be inert here,
    // so the template ships with it OFF.
    expect(created.text).toContain(" -a ");
    expect(created.text).not.toContain(" -E ");
    expect(created.text).not.toContain("-P ");
    expect(created.provideIpmiCredentials).toBeUndefined();
    expect(created.text).toContain("-H ${profile.ipmiHost}");
    expect(created.text).toContain("-U ${profile.ipmiUsername}");
  });

  it.each([
    ["ipmi-power-status", "chassis power status"],
    ["ipmi-power-on", "chassis power on"],
    ["ipmi-power-off", "chassis power off"]
  ])("ships the %s power template in the SOL template's shape", async (templateId, expectedVerb) => {
    const macros: unknown[] = [];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ templateId });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    expect(macros[0]).toMatchObject({
      runIn: "localTerminal",
      provideIpmiCredentials: true
    });
    const created = macros[0] as { name: string; text: string };
    expect(created.text).toContain(expectedVerb);
    expect(created.text).toContain("-U ${profile.ipmiUsername}");
    expect(created.text).toContain(" -E ");
    expect(created.text).not.toContain("-P ");
  });

  it("names power-off as destructive where the user reads it — in the picker and in the macro list", async () => {
    // The only warning this operation gets is its own name and description, so
    // a rename that drops the qualifier is a real regression: `chassis power
    // off` is an abrupt power cut, not a graceful shutdown.
    const macros: unknown[] = [];
    mockGetMacros.mockReturnValue(macros);
    mockShowQuickPick.mockResolvedValue({ templateId: "ipmi-power-off" });

    await registeredCommands.get("nexus.macro.addFromTemplate")!();

    const offered = mockShowQuickPick.mock.calls[0][0].find(
      (item: { templateId: string }) => item.templateId === "ipmi-power-off"
    ) as { label: string; description: string };
    expect(offered.label).toMatch(/hard, no OS shutdown/i);
    expect(offered.description).toMatch(/not shut down cleanly/i);
    expect((macros[0] as { name: string }).name).toMatch(/hard, no OS shutdown/i);
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

describe("macroCommands — escaped profile tokens on the ordinary send paths (PR #55 review, P2)", () => {
  // `$${profile.host}` is documented to send the literal `${profile.host}`. That
  // unescape used to live ONLY in `resolveProfileTokens()`, which only
  // `nexus.server.runMacro` calls — and an escaped-only macro is (correctly) not
  // redirected there, because an escaped token names no field and so constrains
  // nothing about which server the macro can run on. Both dollars went out.
  const escapedOnlyMacro = { name: "Docs", text: "echo $${profile.host}\n" };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    mockGetMacros.mockReturnValue([]);
    mockRunMacro.mockResolvedValue(undefined);
    registerMacroCommands();
  });

  it("nexus.macro.run sends the UNESCAPED text on the variable-free path", async () => {
    mockGetMacros.mockReturnValue([escapedOnlyMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });

    await registeredCommands.get("nexus.macro.run")!();

    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", {
      text: "echo ${profile.host}\n"
    });
  });

  it("an escaped-only macro is NOT redirected to Run Macro on Server", async () => {
    // Pins `hasProfileTokens()`'s semantics from the caller's side: redirecting
    // would make a documentation macro unrunnable without picking a server it
    // does not need.
    mockGetMacros.mockReturnValue([escapedOnlyMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });

    await registeredCommands.get("nexus.macro.run")!();

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("nexus.server.runMacro", expect.anything());
  });

  it("nexus.macro.run hands runMacro the UNESCAPED text, and still prompts for the declared variable", async () => {
    // The prompt-walk route. Order is profile-unescape FIRST, then the variable
    // engine — safe in both directions because a macro variable's name has no
    // dots, so the variable engine can never match `${profile.…}` and this pass
    // can never manufacture a dotless placeholder for it.
    const mixed = {
      name: "Mixed",
      text: "echo $${profile.host} $target\n",
      variables: [{ name: "target" }]
    };
    mockGetMacros.mockReturnValue([mixed]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });

    await registeredCommands.get("nexus.macro.run")!();

    expect(mockRunMacro).toHaveBeenCalledWith({
      ...mixed,
      text: "echo ${profile.host} $target\n"
    });
    // The variable declaration rides along untouched, so the prompt walk inside
    // `runMacro` still asks for it.
    const handed = mockRunMacro.mock.calls[0][0] as { variables: Array<{ name: string }> };
    expect(handed.variables).toEqual([{ name: "target" }]);
  });

  it("nexus.macro.runBinding, nexus.macro.slot and nexus.macro.runItem unescape too", async () => {
    // Every entry point funnels through `runOrSendMacro`, so this is a
    // route-coverage assertion rather than three separate behaviors.
    mockGetMacros.mockReturnValue([escapedOnlyMacro]);
    vi.mocked(getAssignedBinding).mockImplementation((m) => (m === escapedOnlyMacro ? "alt+1" : undefined));
    await registeredCommands.get("nexus.macro.runBinding")!({ binding: "alt+1" });
    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", {
      text: "echo ${profile.host}\n"
    });

    mockExecuteCommand.mockClear();
    vi.mocked(getAssignedBinding).mockReturnValue(undefined);
    mockGetMacros.mockReturnValue([{ ...escapedOnlyMacro, slot: 1 }]);
    await registeredCommands.get("nexus.macro.slot")!({ index: 0 });
    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", {
      text: "echo ${profile.host}\n"
    });

    mockExecuteCommand.mockClear();
    await registeredCommands.get("nexus.macro.runItem")!({ index: 0, macro: escapedOnlyMacro });
    expect(mockExecuteCommand).toHaveBeenCalledWith("workbench.action.terminal.sendSequence", {
      text: "echo ${profile.host}\n"
    });
  });

  it("an UNESCAPED token still redirects, and nothing is sent to a terminal", async () => {
    // The other half of the routing rule, so "unescape everywhere" cannot be
    // mistaken for "resolve everywhere": a real token has no server here.
    const profileMacro = { name: "SOL", text: "ipmitool -H ${profile.ipmiHost}\n" };
    mockGetMacros.mockReturnValue([profileMacro]);
    mockShowQuickPick.mockResolvedValue({ index: 0 });
    mockShowInformationMessage.mockResolvedValue("Run Macro on Server…");

    await registeredCommands.get("nexus.macro.run")!();

    expect(mockExecuteCommand).toHaveBeenCalledWith("nexus.server.runMacro", { macro: profileMacro });
    expect(mockExecuteCommand).not.toHaveBeenCalledWith(
      "workbench.action.terminal.sendSequence",
      expect.anything()
    );
  });
});
