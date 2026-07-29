import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalMacro } from "../../src/models/terminalMacro";

const mockSetStatusBarMessage = vi.fn();
const mockCreateInputBox = vi.fn();
const mockBackButton = vi.hoisted(() => ({ __brand: "back" }));

vi.mock("vscode", () => ({
  window: {
    activeTerminal: undefined,
    terminals: [] as unknown[],
    createInputBox: (...args: unknown[]) => mockCreateInputBox(...args),
    setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args)
  },
  QuickInputButtons: { Back: mockBackButton }
}));

import * as vscode from "vscode";
import { resolveMacroText, runMacro } from "../../src/commands/macroVariablePrompt";

/** Waits for all currently-queued microtasks (promise resolution chains) to flush. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Handler<T> = (arg: T) => void;

class FakeInputBox {
  title?: string;
  step?: number;
  totalSteps?: number;
  prompt?: string;
  value = "";
  password = false;
  ignoreFocusOut = false;
  buttons: unknown[] = [];
  disposed = false;
  showCount = 0;
  show: () => void = () => {
    this.showCount++;
  };

  private acceptHandlers: Array<Handler<void>> = [];
  private hideHandlers: Array<Handler<void>> = [];
  private buttonHandlers: Array<Handler<unknown>> = [];

  onDidAccept(handler: Handler<void>) {
    this.acceptHandlers.push(handler);
    return { dispose: () => this.remove(this.acceptHandlers, handler) };
  }

  onDidHide(handler: Handler<void>) {
    this.hideHandlers.push(handler);
    return { dispose: () => this.remove(this.hideHandlers, handler) };
  }

  onDidTriggerButton(handler: Handler<unknown>) {
    this.buttonHandlers.push(handler);
    return { dispose: () => this.remove(this.buttonHandlers, handler) };
  }

  dispose(): void {
    this.disposed = true;
  }

  fireAccept(): void {
    for (const h of [...this.acceptHandlers]) h(undefined);
  }

  fireHide(): void {
    for (const h of [...this.hideHandlers]) h(undefined);
  }

  fireBack(): void {
    this.fireButton(mockBackButton);
  }

  fireButton(button: unknown): void {
    for (const h of [...this.buttonHandlers]) h(button);
  }

  private remove<T>(list: Handler<T>[], handler: Handler<T>): void {
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }
}

interface FakeTerminal {
  name: string;
  exitStatus: { code: number | undefined } | undefined;
  sendText: ReturnType<typeof vi.fn>;
}

function makeTerminal(name: string): FakeTerminal {
  return { name, exitStatus: undefined, sendText: vi.fn() };
}

let lastInputBox: FakeInputBox | undefined;

function queueInputBox(configure?: (box: FakeInputBox) => void): FakeInputBox {
  const box = new FakeInputBox();
  configure?.(box);
  lastInputBox = box;
  mockCreateInputBox.mockImplementationOnce(() => box);
  return box;
}

function makeMacro(overrides: Partial<TerminalMacro> = {}): TerminalMacro {
  return {
    name: "IPMI SOL",
    text: "ipmitool -H $host -U $username -P $password sol activate\n",
    variables: [
      { name: "host" },
      { name: "username" },
      { name: "password", secret: true }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lastInputBox = undefined;
  (vscode.window as { activeTerminal: unknown }).activeTerminal = undefined;
  (vscode.window as { terminals: unknown[] }).terminals = [];
});

describe("resolveMacroText — prompt sequencing", () => {
  it("returns macro.text unchanged (identity) when there is nothing to resolve", async () => {
    const macro: TerminalMacro = { name: "plain", text: "show version\n" };
    const result = await resolveMacroText(macro);
    expect(result).toBe(macro.text);
    expect(mockCreateInputBox).not.toHaveBeenCalled();
  });

  it("a declared variable that never appears in the text is never prompted, and text is returned unchanged", async () => {
    const macro = makeMacro({ text: "no placeholders here\n" });
    const result = await resolveMacroText(macro);
    expect(result).toBe(macro.text);
    expect(mockCreateInputBox).not.toHaveBeenCalled();
  });

  it("prompts only for declared variables actually used, in declaration order", async () => {
    const macro = makeMacro({
      text: "$username only\n",
      variables: [{ name: "host" }, { name: "username" }, { name: "port" }]
    });
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    expect(mockCreateInputBox).toHaveBeenCalledTimes(1);
    expect(box.totalSteps).toBe(1);
    expect(box.prompt).toBe("username");

    box.value = "root";
    box.fireAccept();
    const result = await resultPromise;
    expect(result).toBe("root only\n");
  });

  it("dedups a name that appears multiple times — prompted exactly once", async () => {
    const macro = makeMacro({ text: "$host and $host again", variables: [{ name: "host" }] });
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    expect(box.totalSteps).toBe(1);
    box.value = "10.0.0.1";
    box.fireAccept();
    expect(await resultPromise).toBe("10.0.0.1 and 10.0.0.1 again");
  });

  it("walks a 3-step macro end to end with the same InputBox instance", async () => {
    const macro = makeMacro();
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    expect(box.step).toBe(1);
    expect(box.totalSteps).toBe(3);
    expect(box.buttons).toEqual([]); // no Back on the first step
    box.value = "10.0.0.1";
    box.fireAccept();
    await tick();

    expect(box.step).toBe(2);
    expect(box.buttons.length).toBe(1); // Back appears from step 2 onward
    expect(box.password).toBe(false);
    box.value = "root";
    box.fireAccept();
    await tick();

    expect(box.step).toBe(3);
    expect(box.password).toBe(true);
    box.value = "s3cr3t";
    box.fireAccept();

    const result = await resultPromise;
    expect(result).toBe("ipmitool -H 10.0.0.1 -U root -P s3cr3t sol activate\n");
    expect(mockCreateInputBox).toHaveBeenCalledTimes(1); // one reused box, not three
    expect(box.disposed).toBe(true);
  });

  it("Back at step 2 returns to step 1 with the previously entered value preserved", async () => {
    const macro = makeMacro();
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    box.value = "10.0.0.1";
    box.fireAccept();
    await tick();
    expect(box.step).toBe(2);

    box.value = "root";
    box.fireAccept();
    await tick();
    expect(box.step).toBe(3);

    box.fireBack();
    await tick();
    expect(box.step).toBe(2);
    expect(box.value).toBe("root"); // step 2's own entered value preserved

    box.fireBack();
    await tick();
    expect(box.step).toBe(1);
    expect(box.value).toBe("10.0.0.1"); // step 1's entered value preserved, not reset

    // Forward again — re-accept unchanged values and finish.
    box.fireAccept();
    await tick();
    box.fireAccept();
    await tick();
    box.value = "s3cr3t";
    box.fireAccept();

    const result = await resultPromise;
    expect(result).toBe("ipmitool -H 10.0.0.1 -U root -P s3cr3t sol activate\n");
  });

  it.each([0, 1, 2])("cancel (ESC/hide) at step %i aborts the whole sequence — resolves to undefined", async (cancelAtStep) => {
    const macro = makeMacro();
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    for (let i = 0; i < cancelAtStep; i++) {
      box.value = "x";
      box.fireAccept();
      await tick();
    }
    box.fireHide();

    const result = await resultPromise;
    expect(result).toBeUndefined();
    expect(box.disposed).toBe(true);
  });

  it("escape-only text: zero prompts, and the escape is un-escaped", async () => {
    const macro = makeMacro({ text: "echo $${host}", variables: [{ name: "host" }] });
    const result = await resolveMacroText(macro);
    expect(result).toBe("echo ${host}");
    expect(mockCreateInputBox).not.toHaveBeenCalled();
  });

  it("mixed escaped and unescaped use of the same name: one prompt, both forms resolved correctly", async () => {
    const macro = makeMacro({ text: "echo $host; echo $${host}", variables: [{ name: "host" }] });
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    expect(mockCreateInputBox).toHaveBeenCalledTimes(1);
    expect(box.totalSteps).toBe(1);

    box.value = "10.0.0.1";
    box.fireAccept();
    const result = await resultPromise;
    expect(result).toBe("echo 10.0.0.1; echo ${host}");
  });

  it("a second declared variable that only appears escaped is never prompted, but its escape still resolves", async () => {
    const macro = makeMacro({
      text: "curl $host:8080 '$${port}'",
      variables: [{ name: "host" }, { name: "port" }]
    });
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    expect(mockCreateInputBox).toHaveBeenCalledTimes(1);
    expect(box.totalSteps).toBe(1);
    expect(box.prompt).toBe("host");

    box.value = "10.0.0.1";
    box.fireAccept();
    const result = await resultPromise;
    expect(result).toBe("curl 10.0.0.1:8080 '${port}'");
  });

  it("backing into a masked step never prefills the previously entered secret", async () => {
    const macro = makeMacro({
      text: "$host $password $confirm",
      variables: [{ name: "host" }, { name: "password", secret: true }, { name: "confirm" }]
    });
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    box.value = "10.0.0.1";
    box.fireAccept();
    await tick();

    expect(box.password).toBe(true);
    expect(box.value).toBe(""); // masked step never prefills, even on the first visit
    box.value = "hunter2";
    box.fireAccept();
    await tick();

    // Now at step 3 (confirm) — go back into the masked step.
    box.fireBack();
    await tick();
    expect(box.password).toBe(true);
    expect(box.value).toBe(""); // backing in must not re-seat the previously typed secret

    box.value = "hunter2";
    box.fireAccept();
    await tick();
    box.value = "yes";
    box.fireAccept();

    const result = await resultPromise;
    expect(result).toBe("10.0.0.1 hunter2 yes");
  });

  it("a non-Back button settles the step as a cancel rather than hanging forever", async () => {
    const macro = makeMacro({ variables: [{ name: "host" }], text: "$host" });
    const box = queueInputBox();
    const resultPromise = resolveMacroText(macro);
    await tick();

    const someOtherButton = { __brand: "not-back" };
    box.fireButton(someOtherButton);

    const result = await resultPromise;
    expect(result).toBeUndefined();
    expect(box.disposed).toBe(true);
  });

  it("disposes the InputBox even when something throws mid-flow", async () => {
    const macro = makeMacro({ variables: [{ name: "host" }], text: "$host" });
    const box = queueInputBox((b) => {
      b.show = () => {
        throw new Error("boom");
      };
    });

    await expect(resolveMacroText(macro)).rejects.toThrow("boom");
    expect(box.disposed).toBe(true);
  });
});

describe("resolveMacroText — remember map (§7.1)", () => {
  it("remembers a non-secret value across separate runs of the same macro (has id)", async () => {
    const macro = makeMacro({ id: "macro-1", variables: [{ name: "host" }], text: "$host" });

    const box1 = queueInputBox();
    const p1 = resolveMacroText(macro);
    await tick();
    box1.value = "10.0.0.1";
    box1.fireAccept();
    await p1;

    const box2 = queueInputBox();
    const p2 = resolveMacroText({ ...macro });
    await tick();
    expect(box2.value).toBe("10.0.0.1"); // prefilled from the remembered value
    box2.fireAccept();
    await p2;
  });

  it("never remembers a secret variable's value, and never prefills it from the map", async () => {
    const macro = makeMacro({ id: "macro-2", variables: [{ name: "password", secret: true }], text: "$password" });

    const box1 = queueInputBox();
    const p1 = resolveMacroText(macro);
    await tick();
    expect(box1.value).toBe("");
    box1.value = "hunter2";
    box1.fireAccept();
    await p1;

    const box2 = queueInputBox();
    const p2 = resolveMacroText({ ...macro });
    await tick();
    expect(box2.value).toBe(""); // never prefilled — never remembered in the first place
    box2.fireAccept();
    await p2;
  });

  it("no macro.id — never remembers, even across repeated runs of an otherwise-identical macro", async () => {
    const macro = makeMacro({ id: undefined, variables: [{ name: "host" }], text: "$host" });

    const box1 = queueInputBox();
    const p1 = resolveMacroText(macro);
    await tick();
    box1.value = "10.0.0.1";
    box1.fireAccept();
    await p1;

    const box2 = queueInputBox();
    const p2 = resolveMacroText({ ...macro });
    await tick();
    expect(box2.value).toBe(""); // no id → no remember, on read as well as write
    box2.fireAccept();
    await p2;
  });

  it("remember: false suppresses persisting the entered value for the next run", async () => {
    const macro = makeMacro({
      id: "macro-3",
      variables: [{ name: "host", remember: false }],
      text: "$host"
    });

    const box1 = queueInputBox();
    const p1 = resolveMacroText(macro);
    await tick();
    box1.value = "10.0.0.1";
    box1.fireAccept();
    await p1;

    const box2 = queueInputBox();
    const p2 = resolveMacroText({ ...macro });
    await tick();
    expect(box2.value).toBe("");
    box2.fireAccept();
    await p2;
  });

  it("prefills from `default` when nothing is remembered yet", async () => {
    const macro = makeMacro({
      id: "macro-4",
      variables: [{ name: "host", default: "10.0.0.99" }],
      text: "$host"
    });
    const box = queueInputBox();
    const p = resolveMacroText(macro);
    await tick();
    expect(box.value).toBe("10.0.0.99");
    box.fireAccept();
    await p;
  });

  it("a secret variable ignores a (corrupt/untrusted) `default` entirely — always starts empty", async () => {
    const macro = makeMacro({
      variables: [{ name: "password", secret: true, default: "should-never-appear" }],
      text: "$password"
    });
    const box = queueInputBox();
    const p = resolveMacroText(macro);
    await tick();
    expect(box.value).toBe("");
    box.fireAccept();
    await p;
  });
});

describe("runMacro — target pinning (§8.1)", () => {
  it("sends the resolved text to the terminal active at invocation time, even if activeTerminal changes mid-prompt", async () => {
    const terminalA = makeTerminal("a");
    const terminalB = makeTerminal("b");
    vscode.window.terminals = [terminalA, terminalB] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macro = makeMacro({ variables: [{ name: "host" }], text: "$host" });
    const box = queueInputBox();
    const runPromise = runMacro(macro);
    await tick();

    // User clicks a different terminal while the prompt is open.
    vscode.window.activeTerminal = terminalB as unknown as vscode.Terminal;

    box.value = "10.0.0.1";
    box.fireAccept();
    await runPromise;

    expect(terminalA.sendText).toHaveBeenCalledWith("10.0.0.1", false);
    expect(terminalB.sendText).not.toHaveBeenCalled();
  });

  it("aborts with no send and no prompt when there is no active terminal", async () => {
    vscode.window.activeTerminal = undefined;
    const macro = makeMacro();

    await runMacro(macro);

    expect(mockCreateInputBox).not.toHaveBeenCalled();
    expect(mockSetStatusBarMessage).toHaveBeenCalledWith("No active terminal — nothing was sent.", 4000);
  });

  it("aborts with no send when the captured target terminal closes mid-prompt", async () => {
    const terminalA = makeTerminal("a");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macro = makeMacro({ variables: [{ name: "host" }], text: "$host" });
    const box = queueInputBox();
    const runPromise = runMacro(macro);
    await tick();

    // Terminal closes while the prompt is open.
    vscode.window.terminals = [] as unknown as vscode.Terminal[];

    box.value = "10.0.0.1";
    box.fireAccept();
    await runPromise;

    expect(terminalA.sendText).not.toHaveBeenCalled();
    expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Target terminal closed — nothing was sent.", 4000);
  });

  it("aborts with no send when the captured target terminal's exitStatus becomes set mid-prompt", async () => {
    const terminalA = makeTerminal("a");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macro = makeMacro({ variables: [{ name: "host" }], text: "$host" });
    const box = queueInputBox();
    const runPromise = runMacro(macro);
    await tick();

    terminalA.exitStatus = { code: 0 };

    box.value = "10.0.0.1";
    box.fireAccept();
    await runPromise;

    expect(terminalA.sendText).not.toHaveBeenCalled();
    expect(mockSetStatusBarMessage).toHaveBeenCalledWith("Target terminal closed — nothing was sent.", 4000);
  });
});

describe("runMacro — success reporting (§8.3 fix: successful sends were silent)", () => {
  it("reports success via the status bar after a successful send, without leaking the resolved value", async () => {
    const terminalA = makeTerminal("Router1");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macro = makeMacro({ name: "IPMI SOL", variables: [{ name: "host" }], text: "$host" });
    const box = queueInputBox();
    const runPromise = runMacro(macro);
    await tick();

    box.value = "10.0.0.1";
    box.fireAccept();
    await runPromise;

    expect(mockSetStatusBarMessage).toHaveBeenCalledWith('Macro "IPMI SOL" sent to Router1.', 4000);
    const messages = mockSetStatusBarMessage.mock.calls.map((call) => call[0]);
    expect(messages.some((msg) => typeof msg === "string" && msg.includes("10.0.0.1"))).toBe(false);
  });
});

describe("runMacro — cancel reporting (§8.3)", () => {
  it("cancelling reports through the status bar and sends nothing", async () => {
    const terminalA = makeTerminal("a");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macro = makeMacro({ name: "IPMI SOL" });
    const box = queueInputBox();
    const runPromise = runMacro(macro);
    await tick();

    box.fireHide();
    await runPromise;

    expect(terminalA.sendText).not.toHaveBeenCalled();
    expect(mockSetStatusBarMessage).toHaveBeenCalledWith('Macro "IPMI SOL" cancelled — nothing was sent.', 4000);
  });
});

describe("runMacro — re-entrancy (§8.4)", () => {
  it("rejects a concurrent run of a DIFFERENT macro while one is in flight, with no second InputBox", async () => {
    const terminalA = makeTerminal("a");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macroA = makeMacro({ name: "First", id: "a" });
    const macroB = makeMacro({ name: "Second", id: "b" });

    const box = queueInputBox();
    const runA = runMacro(macroA);
    await tick();

    await runMacro(macroB); // should resolve immediately, rejected by the guard
    expect(mockCreateInputBox).toHaveBeenCalledTimes(1); // no box opened for macroB
    expect(mockSetStatusBarMessage).toHaveBeenCalledWith('A macro is already waiting for input ("First").', 4000);

    // Finish macroA normally.
    box.value = "10.0.0.1";
    box.fireAccept();
    await tick();
    box.value = "root";
    box.fireAccept();
    await tick();
    box.value = "s3cr3t";
    box.fireAccept();
    await runA;
    expect(terminalA.sendText).toHaveBeenCalled();
  });

  it("a repeat invocation of the SAME in-flight macro drops silently (no status message, no second box)", async () => {
    const terminalA = makeTerminal("a");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macro = makeMacro({ id: "same-id" });
    const box = queueInputBox();
    const run1 = runMacro(macro);
    await tick();

    await runMacro({ ...macro }); // logically the same macro (same id) — silently dropped
    expect(mockCreateInputBox).toHaveBeenCalledTimes(1);
    expect(mockSetStatusBarMessage).not.toHaveBeenCalled();

    box.value = "10.0.0.1";
    box.fireAccept();
    await tick();
    box.value = "root";
    box.fireAccept();
    await tick();
    box.value = "s3cr3t";
    box.fireAccept();
    await run1;
  });

  it("releases the guard even when the resolver throws, so a later run is not permanently locked out", async () => {
    const terminalA = makeTerminal("a");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const failingMacro = makeMacro({ name: "Failing", id: "fail", variables: [{ name: "host" }], text: "$host" });
    queueInputBox((b) => {
      b.show = () => {
        throw new Error("boom");
      };
    });

    await expect(runMacro(failingMacro)).rejects.toThrow("boom");

    // Guard must be free now — a different macro runs normally right after.
    const okMacro = makeMacro({ name: "OK", id: "ok" });
    const box2 = queueInputBox();
    const runOk = runMacro(okMacro);
    await tick();
    box2.value = "10.0.0.1";
    box2.fireAccept();
    await tick();
    box2.value = "root";
    box2.fireAccept();
    await tick();
    box2.value = "s3cr3t";
    box2.fireAccept();
    await runOk;

    expect(terminalA.sendText).toHaveBeenCalled();
    expect(mockSetStatusBarMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("already waiting"),
      expect.anything()
    );
  });
});

describe("runMacro — variable-free macros never reach the InputBox machinery", () => {
  it("a macro with no variables resolves to its own text with no prompt", async () => {
    const terminalA = makeTerminal("a");
    vscode.window.terminals = [terminalA] as unknown as vscode.Terminal[];
    vscode.window.activeTerminal = terminalA as unknown as vscode.Terminal;

    const macro: TerminalMacro = { name: "Plain", text: "show version\n" };
    await runMacro(macro);

    expect(mockCreateInputBox).not.toHaveBeenCalled();
    expect(terminalA.sendText).toHaveBeenCalledWith("show version\n", false);
  });
});
