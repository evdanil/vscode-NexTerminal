import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";
import type { TerminalMacro } from "../../src/models/terminalMacro";

let mockConfig: Record<string, Record<string, unknown>> = {};
let activeStore: InMemoryMacroStore;

vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        }
      };
    };

    public fire(value?: T): void {
      for (const listener of this.listeners) {
        listener(value as T);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  },
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
  autoTrigger = true,
  macroSettings: Record<string, unknown> = {}
): void {
  mockConfig = {
    "nexus.terminal.macros": { autoTrigger, ...macroSettings }
  };
  // Feed macros into the store synchronously (save is async but InMemoryMacroStore resolves immediately)
  void activeStore.save(macros as TerminalMacro[]);
}

/** Flush deferred writeBack calls (setTimeout(fn, 0)). */
function flush(): void {
  vi.runAllTimers();
}

describe("MacroAutoTrigger", () => {
  beforeEach(async () => {
    mockConfig = {};
    activeStore = new InMemoryMacroStore();
    await activeStore.initialize();
    setActiveMacroStore(activeStore);
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

  it("cleans buffer on cooldown-blocked match to prevent stale re-trigger", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:\\s*$", triggerCooldown: 5 }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password: ");
    flush();
    expect(sent).toHaveLength(1);

    // Server redraws prompt during cooldown window
    obs.onOutput("Password: ");
    flush();
    expect(sent).toHaveLength(1); // blocked by cooldown

    // Advance past cooldown
    vi.advanceTimersByTime(6000);

    // Whitespace-only output must NOT re-trigger on stale buffer content
    obs.onOutput("\n");
    flush();
    expect(sent).toHaveLength(1);
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

  it("uses the configured default cooldown when macros do not override it", () => {
    setConfig(
      [{ name: "pw", text: "secret\n", triggerPattern: "Password:" }],
      true,
      { defaultCooldown: 10 }
    );
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual(["secret\n"]);

    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual(["secret\n"]);

    vi.advanceTimersByTime(10_000);
    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual(["secret\n", "secret\n"]);
    obs.dispose();
  });

  it("uses the configured buffer length when trimming prompt history", () => {
    setConfig(
      [{ name: "end", text: "found\n", triggerPattern: "MARKER$" }],
      true,
      { bufferLength: 256 }
    );
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("MARKER" + "x".repeat(300));
    flush();
    expect(sent).toEqual([]);

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

  it("starts configured triggers paused until enabled", () => {
    setConfig([
      { name: "route", text: "show ip route 0.0.0.0\n", triggerPattern: "router#", triggerInitiallyDisabled: true }
    ]);
    const trigger = new MacroAutoTrigger();

    expect(trigger.isDisabled(0)).toBe(true);
  });

  it("large chunk guard keeps the tail so prompt-at-end still matches", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "Password:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("x".repeat(8200) + "Password:");
    flush();
    expect(sent).toEqual(["secret\n"]);
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

    trigger.setDisabled(0, true);
    expect(trigger.isDisabled(0)).toBe(true);

    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual([]); // disabled

    obs.onOutput("Continue?");
    flush();
    expect(sent).toEqual(["yes\n"]); // other macro still works

    trigger.setDisabled(0, false);
    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual(["yes\n", "secret\n"]); // re-enabled
    obs.dispose();
  });

  it("enabling a previously paused trigger re-evaluates buffered output", () => {
    setConfig([
      { name: "route", text: "show ip route 0.0.0.0\n", triggerPattern: "router#", triggerInitiallyDisabled: true }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("router#");
    flush();
    expect(sent).toEqual([]);

    trigger.setDisabled(0, false);
    flush();
    expect(sent).toEqual(["show ip route 0.0.0.0\n"]);
    obs.dispose();
  });

  it("fires interval macros later without extra input once the prompt has re-armed them", () => {
    setConfig([
      {
        name: "route",
        text: "show ip route 0.0.0.0\n",
        triggerPattern: "router#",
        triggerInterval: 10,
        triggerInitiallyDisabled: true
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("router#");
    flush();
    expect(sent).toEqual([]);

    trigger.setDisabled(0, false);
    flush();
    expect(sent).toEqual(["show ip route 0.0.0.0\n"]);

    obs.onOutput("Codes: C connected\r\nrouter#");
    expect(sent).toEqual(["show ip route 0.0.0.0\n"]);

    vi.advanceTimersByTime(9999);
    expect(sent).toEqual(["show ip route 0.0.0.0\n"]);

    vi.advanceTimersByTime(1);
    flush();
    expect(sent).toEqual([
      "show ip route 0.0.0.0\n",
      "show ip route 0.0.0.0\n"
    ]);
    obs.dispose();
  });

  it("does not fire interval macros until the prompt has matched again", () => {
    setConfig([
      {
        name: "route",
        text: "show ip route 0.0.0.0\n",
        triggerPattern: "router#",
        triggerInterval: 10,
        triggerInitiallyDisabled: true
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("router#");
    flush();
    trigger.setDisabled(0, false);
    flush();
    expect(sent).toEqual(["show ip route 0.0.0.0\n"]);

    vi.advanceTimersByTime(15000);
    flush();
    expect(sent).toEqual(["show ip route 0.0.0.0\n"]);

    obs.onOutput("router#");
    flush();
    expect(sent).toEqual([
      "show ip route 0.0.0.0\n",
      "show ip route 0.0.0.0\n"
    ]);
    obs.dispose();
  });

  it("enabling a paused trigger can fire from the tail of a large login chunk", () => {
    setConfig([
      { name: "route", text: "show ip route 0.0.0.0\n", triggerPattern: "router#", triggerInitiallyDisabled: true }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("Welcome\r\n" + "x".repeat(8200) + "router#");
    flush();
    expect(sent).toEqual([]);

    trigger.setDisabled(0, false);
    flush();
    expect(sent).toEqual(["show ip route 0.0.0.0\n"]);
    obs.dispose();
  });

  it("disabling one duplicate-named macro does not disable the other", () => {
    setConfig([
      { name: "dup", text: "first\n", triggerPattern: "FirstPrompt" },
      { name: "dup", text: "second\n", triggerPattern: "SecondPrompt" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    trigger.setDisabled(0, true);

    obs.onOutput("FirstPrompt");
    flush();
    expect(sent).toEqual([]);

    obs.onOutput("SecondPrompt");
    flush();
    expect(sent).toEqual(["second\n"]);
    obs.dispose();
  });

  it("interval macro only fires on the terminal where it was enabled", () => {
    setConfig([
      {
        name: "poll",
        text: "show status\n",
        triggerPattern: "router#",
        triggerInterval: 10,
        triggerInitiallyDisabled: true
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    let activeObs: "a" | "b" = "b";
    const obsA = trigger.createObserver(
      (text) => sentA.push(text),
      () => activeObs === "a"
    );
    const obsB = trigger.createObserver(
      (text) => sentB.push(text),
      () => activeObs === "b"
    );

    // Both terminals show a prompt
    obsA.onOutput("router#");
    obsB.onOutput("router#");
    flush();
    expect(sentA).toEqual([]);
    expect(sentB).toEqual([]);

    // Enable the macro while terminal B is active
    trigger.setDisabled(0, false);
    flush();

    // Only terminal B should fire
    expect(sentA).toEqual([]);
    expect(sentB).toEqual(["show status\n"]);

    // Simulate interval cycle: server echoes back on B
    obsB.onOutput("show status\nrouter#");
    vi.advanceTimersByTime(10000);
    flush();
    expect(sentB).toEqual(["show status\n", "show status\n"]);
    expect(sentA).toEqual([]);

    // Switch focus to terminal A — interval stays on B, does NOT move to A
    activeObs = "a";
    // No reevaluate call — focus change alone should not start intervals.
    expect(sentA).toEqual([]);

    // Terminal B keeps running even though unfocused
    obsB.onOutput("show status\nrouter#");
    vi.advanceTimersByTime(10000);
    flush();
    expect(sentB).toEqual(["show status\n", "show status\n", "show status\n"]);
    expect(sentA).toEqual([]);

    obsA.dispose();
    obsB.dispose();
  });

  it("interval macro does not start on unfocused terminal receiving matching output", () => {
    setConfig([
      {
        name: "poll",
        text: "show status\n",
        triggerPattern: "router#",
        triggerInterval: 10
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    let activeObs: "a" | "b" = "a";
    const obsA = trigger.createObserver(
      (text) => sentA.push(text),
      () => activeObs === "a"
    );
    const obsB = trigger.createObserver(
      (text) => sentB.push(text),
      () => activeObs === "b"
    );

    // Terminal A (focused) gets output — interval starts
    obsA.onOutput("router#");
    flush();
    expect(sentA).toEqual(["show status\n"]);

    // Terminal B (unfocused) gets same output — interval should NOT start
    obsB.onOutput("router#");
    flush();
    expect(sentB).toEqual([]);

    // Even after waiting the full interval, B should not fire
    vi.advanceTimersByTime(15000);
    flush();
    expect(sentB).toEqual([]);

    obsA.dispose();
    obsB.dispose();
  });

  it("disabling an interval macro clears armed state so re-enable targets focused terminal", () => {
    setConfig([
      {
        name: "poll",
        text: "show status\n",
        triggerPattern: "router#",
        triggerInterval: 10,
        triggerInitiallyDisabled: true
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    let activeObs: "a" | "b" = "a";
    const obsA = trigger.createObserver(
      (text) => sentA.push(text),
      () => activeObs === "a"
    );
    const obsB = trigger.createObserver(
      (text) => sentB.push(text),
      () => activeObs === "b"
    );

    // Both terminals show prompt
    obsA.onOutput("router#");
    obsB.onOutput("router#");
    flush();

    // Enable while on A — starts on A
    trigger.setDisabled(0, false);
    flush();
    expect(sentA).toEqual(["show status\n"]);
    expect(sentB).toEqual([]);

    // Disable the macro
    trigger.setDisabled(0, true);
    // Run a cycle so isDisabled clears armed state
    obsA.onOutput("router#");
    flush();

    // Switch to B and re-enable — should start on B now
    activeObs = "b";
    obsB.onOutput("router#");
    trigger.setDisabled(0, false);
    flush();
    expect(sentB).toEqual(["show status\n"]);
    // A should not have fired again
    expect(sentA).toEqual(["show status\n"]);

    obsA.dispose();
    obsB.dispose();
  });

  it("re-enabling an interval macro rebinds it to the focused terminal and keeps ownership sticky", () => {
    setConfig([
      {
        name: "poll",
        text: "show status\n",
        triggerPattern: "router#",
        triggerInterval: 10,
        triggerInitiallyDisabled: true
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    const sentC: string[] = [];
    let activeObs: "a" | "b" | "c" = "a";
    const obsA = trigger.createObserver(
      (text) => sentA.push(text),
      () => activeObs === "a"
    );
    const obsB = trigger.createObserver(
      (text) => sentB.push(text),
      () => activeObs === "b"
    );
    const obsC = trigger.createObserver(
      (text) => sentC.push(text),
      () => activeObs === "c"
    );

    obsA.onOutput("router#");
    obsB.onOutput("router#");
    obsC.onOutput("router#");
    flush();

    trigger.setDisabled(0, false);
    flush();
    expect(sentA).toEqual(["show status\n"]);
    expect(sentB).toEqual([]);
    expect(sentC).toEqual([]);

    trigger.setDisabled(0, true);
    activeObs = "b";
    trigger.setDisabled(0, false);
    flush();
    expect(sentA).toEqual(["show status\n"]);
    expect(sentB).toEqual(["show status\n"]);
    expect(sentC).toEqual([]);

    activeObs = "c";
    obsC.onOutput("router#");
    flush();
    expect(sentC).toEqual([]);

    obsB.onOutput("router#");
    vi.advanceTimersByTime(10_000);
    flush();
    expect(sentB).toEqual(["show status\n", "show status\n"]);
    expect(sentA).toEqual(["show status\n"]);
    expect(sentC).toEqual([]);

    obsA.dispose();
    obsB.dispose();
    obsC.dispose();
  });

  it("disabling an interval macro clears owner and timers immediately", () => {
    setConfig([
      {
        name: "poll",
        text: "show status\n",
        triggerPattern: "router#",
        triggerInterval: 10
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    let activeObs: "a" | "b" = "a";
    const obsA = trigger.createObserver(
      (text) => sentA.push(text),
      () => activeObs === "a"
    );
    const obsB = trigger.createObserver(
      (text) => sentB.push(text),
      () => activeObs === "b"
    );

    obsA.onOutput("router#");
    flush();
    expect(sentA).toEqual(["show status\n"]);

    obsA.onOutput("router#");
    trigger.setDisabled(0, true);
    vi.advanceTimersByTime(15_000);
    flush();
    expect(sentA).toEqual(["show status\n"]);

    activeObs = "b";
    obsB.onOutput("router#");
    flush();
    trigger.setDisabled(0, false);
    flush();
    expect(sentB).toEqual(["show status\n"]);

    obsA.dispose();
    obsB.dispose();
  });

  it("disposing the owning observer pauses the interval macro until manually restarted", () => {
    setConfig([
      {
        name: "poll",
        text: "show status\n",
        triggerPattern: "router#",
        triggerInterval: 10
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const changes = vi.fn();
    trigger.onDidChange(changes);
    const sentA: string[] = [];
    const sentB: string[] = [];
    let activeObs: "a" | "b" = "a";
    const obsA = trigger.createObserver(
      (text) => sentA.push(text),
      () => activeObs === "a"
    );
    const obsB = trigger.createObserver(
      (text) => sentB.push(text),
      () => activeObs === "b"
    );

    obsA.onOutput("router#");
    flush();
    expect(sentA).toEqual(["show status\n"]);

    obsA.dispose();
    expect(trigger.isDisabled(0)).toBe(true);
    expect(changes).toHaveBeenCalled();

    activeObs = "b";
    obsB.onOutput("router#");
    flush();
    expect(sentB).toEqual([]);

    trigger.setDisabled(0, false);
    flush();
    expect(sentB).toEqual(["show status\n"]);

    obsB.dispose();
  });

  it("interval macro waiting for delay does not block non-interval rules", () => {
    setConfig([
      {
        name: "poll",
        text: "show status\n",
        triggerPattern: "router#",
        triggerInterval: 10
      },
      {
        name: "pw",
        text: "secret123\n",
        triggerPattern: "[Pp]assword:\\s*$"
      }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    // Trigger the interval macro first
    obs.onOutput("router#");
    flush();
    expect(sent).toEqual(["show status\n"]);

    // While interval is waiting, a password prompt arrives
    obs.onOutput("Password: ");
    flush();

    // Password macro should fire even though interval is pending
    expect(sent).toEqual(["show status\n", "secret123\n"]);
    obs.dispose();
  });

  it("non-interval rule on cooldown does not block other rules", () => {
    setConfig([
      { name: "first", text: "aaa\n", triggerPattern: "ALPHA", triggerCooldown: 5 },
      { name: "second", text: "bbb\n", triggerPattern: "BETA" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text));

    obs.onOutput("ALPHA");
    flush();
    expect(sent).toEqual(["aaa\n"]);

    // Within cooldown, both patterns arrive
    obs.onOutput("ALPHA BETA");
    flush();

    // ALPHA is on cooldown so it's skipped, but BETA should still fire
    expect(sent).toEqual(["aaa\n", "bbb\n"]);
    obs.dispose();
  });

  it("non-interval macro fires on inactive observer (password prompt use-case)", () => {
    setConfig([
      { name: "pw", text: "secret123\n", triggerPattern: "[Pp]assword:\\s*$" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver(
      (text) => sent.push(text),
      () => false // always inactive
    );

    obs.onOutput("Password: ");
    flush();

    // Non-interval macros fire regardless of focus
    expect(sent).toEqual(["secret123\n"]);
    obs.dispose();
  });

  it("keeps missing triggerScope compatible with all-terminal matching", () => {
    setConfig([
      { name: "legacy", text: "legacy\n", triggerPattern: "Prompt:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    const obsA = trigger.createObserver((text) => sentA.push(text), () => true, "a");
    const obsB = trigger.createObserver((text) => sentB.push(text), () => false, "b");

    obsB.onOutput("Prompt:");
    flush();

    expect(sentA).toEqual([]);
    expect(sentB).toEqual(["legacy\n"]);
    obsA.dispose();
    obsB.dispose();
  });

  it("limits active-session scoped macros to the active observer", () => {
    setConfig([
      { name: "scoped", text: "scoped\n", triggerPattern: "Prompt:", triggerScope: "active-session" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    const obsA = trigger.createObserver((text) => sentA.push(text), () => true, "a");
    const obsB = trigger.createObserver((text) => sentB.push(text), () => false, "b");

    obsB.onOutput("Prompt:");
    flush();
    obsA.onOutput("Prompt:");
    flush();

    expect(sentA).toEqual(["scoped\n"]);
    expect(sentB).toEqual([]);
    obsA.dispose();
    obsB.dispose();
  });

  it("limits profile scoped macros to matching observer profile ids", () => {
    setConfig([
      { name: "profile", text: "profile\n", triggerPattern: "Prompt:", triggerScope: "profile", triggerProfileId: "router" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    const obsA = trigger.createObserver((text) => sentA.push(text), () => true, "a", "router");
    const obsB = trigger.createObserver((text) => sentB.push(text), () => true, "b", "switch");

    obsB.onOutput("Prompt:");
    flush();
    obsA.onOutput("Prompt:");
    flush();

    expect(sentA).toEqual(["profile\n"]);
    expect(sentB).toEqual([]);
    obsA.dispose();
    obsB.dispose();
  });

  it("fails closed for unknown trigger scopes", () => {
    setConfig([
      { name: "bad-scope", text: "secret\n", triggerPattern: "Prompt:", triggerScope: "typo" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((text) => sent.push(text), () => true, "a");

    obs.onOutput("Prompt:");
    flush();

    expect(sent).toEqual([]);
    obs.dispose();
  });
});
