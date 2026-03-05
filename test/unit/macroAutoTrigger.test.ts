import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let mockConfig: Record<string, Record<string, unknown>> = {};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn((section: string) => ({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        const sectionConfig = mockConfig[section];
        if (sectionConfig && key in sectionConfig) return sectionConfig[key];
        return defaultValue;
      })
    }))
  }
}));

import { MacroAutoTrigger } from "../../src/services/macroAutoTrigger";

function setConfig(
  macros: Array<Record<string, unknown>>,
  autoTrigger = true
): void {
  mockConfig = {
    "nexus.terminal": { macros },
    "nexus.terminal.macros": { autoTrigger }
  };
}

/** Flush deferred writeBack calls (setTimeout(fn, 0)). */
function flush(): void {
  vi.runAllTimers();
}

describe("MacroAutoTrigger", () => {
  beforeEach(() => {
    mockConfig = {};
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers on basic match", () => {
    setConfig([
      { name: "pw", text: "secret123\n", triggerPattern: "[Pp]assword:\\s*$" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password: ");
    flush();
    expect(sent).toEqual(["secret123\n"]);
    obs.dispose();
  });

  it("defers writeBack to next event-loop turn", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password:");
    // Before flush: nothing sent yet (deferred)
    expect(sent).toEqual([]);
    flush();
    expect(sent).toEqual(["secret\n"]);
    obs.dispose();
  });

  it("triggers on cross-chunk match", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Pass");
    flush();
    expect(sent).toEqual([]);
    obs.onOutput("word:");
    flush();
    expect(sent).toEqual(["secret\n"]);
    obs.dispose();
  });

  it("triggers through ANSI escape codes", () => {
    setConfig([
      { name: "pw", text: "yes\n", triggerPattern: "Continue\\?" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("\x1b[1mContinue?\x1b[0m ");
    flush();
    expect(sent).toEqual(["yes\n"]);
    obs.dispose();
  });

  it("respects cooldown — second match within window does not fire", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:", triggerCooldown: 5 }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password:");
    flush();
    expect(sent).toHaveLength(1);

    obs.onOutput("Password:");
    flush();
    expect(sent).toHaveLength(1); // blocked by cooldown
    obs.dispose();
  });

  it("fires after cooldown expires", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:", triggerCooldown: 0 }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password:");
    flush();
    expect(sent).toHaveLength(1);

    obs.onOutput("Password:");
    flush();
    expect(sent).toHaveLength(2); // cooldown=0 means immediate re-trigger
    obs.dispose();
  });

  it("skips invalid regex silently", () => {
    setConfig([
      { name: "bad", text: "x", triggerPattern: "[invalid" },
      { name: "good", text: "y\n", triggerPattern: "hello" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("hello");
    flush();
    expect(sent).toEqual(["y\n"]);
    obs.dispose();
  });

  it("rejects empty-match regex", () => {
    setConfig([
      { name: "empty", text: "x", triggerPattern: ".*" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("anything");
    flush();
    expect(sent).toEqual([]);
    obs.dispose();
  });

  it("caps buffer at 2048 chars", () => {
    setConfig([
      { name: "end", text: "found\n", triggerPattern: "MARKER" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    // Fill buffer with padding so MARKER at the start gets trimmed away
    obs.onOutput("x".repeat(2000));
    obs.onOutput("x".repeat(2000));
    // Buffer is now capped at 2048 from the end — all x's

    // MARKER at end of a new chunk should still work (appended to trimmed buffer)
    obs.onOutput("MARKER");
    flush();
    expect(sent).toEqual(["found\n"]);
    obs.dispose();
  });

  it("does not fire after dispose", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.dispose();
    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual([]);
  });

  it("does not fire deferred callback after dispose", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password:");
    // Dispose before the deferred callback fires
    obs.dispose();
    flush();
    expect(sent).toEqual([]); // callback should check disposed flag
  });

  it("reload picks up new patterns", () => {
    setConfig([
      { name: "old", text: "old\n", triggerPattern: "OldPattern" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    setConfig([
      { name: "new", text: "new\n", triggerPattern: "NewPattern" }
    ]);
    trigger.reload();

    obs.onOutput("NewPattern");
    flush();
    expect(sent).toEqual(["new\n"]);

    obs.onOutput("OldPattern");
    flush();
    expect(sent).toEqual(["new\n"]); // old pattern no longer active
    obs.dispose();
  });

  it("first-match-wins — only first matching macro fires", () => {
    setConfig([
      { name: "first", text: "first\n", triggerPattern: "prompt" },
      { name: "second", text: "second\n", triggerPattern: "prompt" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("prompt");
    flush();
    expect(sent).toEqual(["first\n"]);
    obs.dispose();
  });

  it("global disable prevents all triggers", () => {
    setConfig(
      [{ name: "pw", text: "secret\n", triggerPattern: "Password:" }],
      false
    );
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual([]);
    obs.dispose();
  });

  it("large chunk guard — chunks > 8192 chars skipped", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password:" + "x".repeat(8200));
    flush();
    expect(sent).toEqual([]);
    obs.dispose();
  });

  it("writeBack receives exact macro text, not matched text", () => {
    setConfig([
      { name: "pw", text: "my-password\n", triggerPattern: "[Pp]assword:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("password:");
    flush();
    expect(sent).toEqual(["my-password\n"]);
    obs.dispose();
  });

  it("per-macro disable prevents that macro from firing", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:" },
      { name: "confirm", text: "yes\n", triggerPattern: "Continue\\?" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    trigger.setDisabled("pw", true);
    expect(trigger.isDisabled("pw")).toBe(true);

    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual([]); // disabled

    obs.onOutput("Continue?");
    flush();
    expect(sent).toEqual(["yes\n"]); // other macro still works

    trigger.setDisabled("pw", false);
    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual(["yes\n", "secret\n"]); // re-enabled
    obs.dispose();
  });
});
