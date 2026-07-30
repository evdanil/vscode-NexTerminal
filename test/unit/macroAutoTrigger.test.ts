import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import { VscodeMacroStore } from "../../src/storage/vscodeMacroStore";
import { setActiveMacroStore } from "../../src/macroSettings";
import type { TerminalMacro } from "../../src/models/terminalMacro";
import type { MacroStore, MacroStoreChangeListener } from "../../src/storage/macroStore";

let mockConfig: Record<string, Record<string, unknown>> = {};
let activeStore: InMemoryMacroStore;

/**
 * Minimal MacroStore that does NOT synthesize an `id` on save (unlike both
 * InMemoryMacroStore and VscodeMacroStore, which always assign one). Used
 * only by the tests that need to exercise MacroAutoTrigger's `anon:` fallback
 * identity (macros with no `id` at all) — every other test in this file goes
 * through `activeStore`/`setConfig()`, where ids ARE always present, matching
 * how both real store implementations behave in production.
 */
class RawMacroStore implements MacroStore {
  private macros: TerminalMacro[] = [];
  private readonly listeners = new Set<MacroStoreChangeListener>();

  public async initialize(): Promise<void> {
    // no-op
  }

  public getAll(): TerminalMacro[] {
    return this.macros.map((m) => ({ ...m }));
  }

  public async save(macros: TerminalMacro[]): Promise<void> {
    this.macros = macros.map((m) => ({ ...m })); // deliberately no id synthesis
    for (const listener of this.listeners) listener();
  }

  public onDidChange(listener: MacroStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clearAll(): Promise<void> {
    this.macros = [];
    for (const listener of this.listeners) listener();
  }
}

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

import { MacroAutoTrigger, macroStateKey } from "../../src/services/macroAutoTrigger";

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

/**
 * Fetches the macro currently at `index` from the active store, WITH its
 * assigned id (InMemoryMacroStore synthesizes one on save — see
 * inMemoryMacroStore.ts — matching how VscodeMacroStore behaves in
 * production). MacroAutoTrigger's public API now keys state by macro
 * identity rather than array position, so tests fetch the macro object to
 * pass to `isDisabled()`/`setDisabled()` instead of a raw index.
 */
function macroAt(index: number): TerminalMacro {
  const macro = activeStore.getAll()[index];
  if (!macro) throw new Error(`No macro at index ${index}`);
  return macro;
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

    expect(trigger.isDisabled(macroAt(0))).toBe(true);
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

    trigger.setDisabled(macroAt(0), true);
    expect(trigger.isDisabled(macroAt(0))).toBe(true);

    obs.onOutput("Password:");
    flush();
    expect(sent).toEqual([]); // disabled

    obs.onOutput("Continue?");
    flush();
    expect(sent).toEqual(["yes\n"]); // other macro still works

    trigger.setDisabled(macroAt(0), false);
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

    trigger.setDisabled(macroAt(0), false);
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

    trigger.setDisabled(macroAt(0), false);
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
    trigger.setDisabled(macroAt(0), false);
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

    trigger.setDisabled(macroAt(0), false);
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

    trigger.setDisabled(macroAt(0), true);

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
    trigger.setDisabled(macroAt(0), false);
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
    trigger.setDisabled(macroAt(0), false);
    flush();
    expect(sentA).toEqual(["show status\n"]);
    expect(sentB).toEqual([]);

    // Disable the macro
    trigger.setDisabled(macroAt(0), true);
    // Run a cycle so isDisabled clears armed state
    obsA.onOutput("router#");
    flush();

    // Switch to B and re-enable — should start on B now
    activeObs = "b";
    obsB.onOutput("router#");
    trigger.setDisabled(macroAt(0), false);
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

    trigger.setDisabled(macroAt(0), false);
    flush();
    expect(sentA).toEqual(["show status\n"]);
    expect(sentB).toEqual([]);
    expect(sentC).toEqual([]);

    trigger.setDisabled(macroAt(0), true);
    activeObs = "b";
    trigger.setDisabled(macroAt(0), false);
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
    trigger.setDisabled(macroAt(0), true);
    vi.advanceTimersByTime(15_000);
    flush();
    expect(sentA).toEqual(["show status\n"]);

    activeObs = "b";
    obsB.onOutput("router#");
    flush();
    trigger.setDisabled(macroAt(0), false);
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
    expect(trigger.isDisabled(macroAt(0))).toBe(true);
    expect(changes).toHaveBeenCalled();

    activeObs = "b";
    obsB.onOutput("router#");
    flush();
    expect(sentB).toEqual([]);

    trigger.setDisabled(macroAt(0), false);
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

  describe("macro variables (§6.1) — variables and auto-trigger are mutually exclusive", () => {
    it("a macro with variables compiles no rule, even with an otherwise-valid trigger pattern", () => {
      setConfig([
        { name: "hasVars", text: "show ip route $host\n", triggerPattern: "router#", variables: [{ name: "host" }] }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("router#");
      flush();

      expect(sent).toEqual([]);
      obs.dispose();
    });

    it("a corrupt `variables: \"abc\"` shape does NOT suppress a valid trigger (§4.2 — Array.isArray guard, not `?.length`)", () => {
      setConfig([
        { name: "corruptVars", text: "yes\n", triggerPattern: "Continue\\?", variables: "abc" }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("Continue?");
      flush();

      expect(sent).toEqual(["yes\n"]);
      obs.dispose();
    });

    it("an empty `variables: []` does NOT suppress a valid trigger", () => {
      setConfig([
        { name: "emptyVars", text: "yes\n", triggerPattern: "Continue\\?", variables: [] }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("Continue?");
      flush();

      expect(sent).toEqual(["yes\n"]);
      obs.dispose();
    });

    // Rewritten from a "positional coherence" test (see git history / PR review)
    // that asserted INDEX semantics: it proved that disabling the macro at raw
    // array index 2 kept working even though the macro at index 1 (declaring
    // `variables`) compiles no rule and could have shifted indices via
    // pre-filtering. Now that state is keyed by macro identity
    // (`macroStateKey()`), not array position, that specific hazard no longer
    // exists — indices are never used as keys anywhere in MacroAutoTrigger. This
    // test is rewritten to assert the equivalent IDENTITY guarantee instead: a
    // sibling macro that compiles no rule (variables) must not disturb the
    // disable-state or interval-ownership keying of the macros around it.
    it("identity coherence: disabling the password macro survives reload even though a sibling macro declares variables and compiles no rule", () => {
      setConfig([
        { name: "interval", text: "show status\n", triggerPattern: "router#", triggerInterval: 10 },
        { name: "hasVars", text: "show ip route $host\n", triggerPattern: "router#", variables: [{ name: "host" }] },
        { name: "pw", text: "secret123\n", triggerPattern: "[Pp]assword:\\s*$" }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      const intervalMacro = macroAt(0);
      const pwMacro = macroAt(2);

      // Arm the interval macro so intervalOwners keys it by identity.
      obs.onOutput("router#");
      flush();
      expect(sent).toEqual(["show status\n"]);

      // Disable the password macro by identity, exactly as extension.ts's
      // setDisabled(item.macro, …) does.
      trigger.setDisabled(pwMacro, true);
      expect(trigger.isDisabled(pwMacro)).toBe(true);

      // Reload (e.g. triggered by an unrelated settings change). The
      // variables-declaring sibling must not corrupt either the password
      // macro's disabled state or the interval macro's ownership keying.
      trigger.reload();

      expect(trigger.isDisabled(pwMacro)).toBe(true);
      expect(trigger.isDisabled(intervalMacro)).toBe(false);

      // The password macro (still disabled) must not fire.
      obs.onOutput("Password: ");
      flush();
      expect(sent).toEqual(["show status\n"]);

      // The interval macro's ownership survived reload — re-arm and confirm it
      // still fires the SAME interval macro after the interval elapses.
      obs.onOutput("Codes: C connected\r\nrouter#");
      vi.advanceTimersByTime(10_000);
      flush();
      expect(sent).toEqual(["show status\n", "show status\n"]);

      // Re-enabling the password macro by identity fires it — proving identity
      // still resolves to it, not to the (compile-skipped) variables macro.
      trigger.setDisabled(pwMacro, false);
      obs.onOutput("Password: ");
      flush();
      expect(sent).toEqual(["show status\n", "show status\n", "secret123\n"]);

      obs.dispose();
    });
  });

  describe("end-to-end: store redaction composed with auto-trigger compilation (security regression)", () => {
    // Deliberately uses VscodeMacroStore, not the InMemoryMacroStore that `setConfig()`
    // wires up above: InMemoryMacroStore.save() never calls `withRedactedVariables` at
    // all, so routing this scenario through it would pass regardless of whether the
    // redaction fix works. VscodeMacroStore.save() / reloadFromState() are the actual
    // persistence chokepoints the fix lives at, so this test drives a real instance of
    // one (against a fake in-memory vscode context, as in macroStore.test.ts) instead
    // of stubbing the store layer away.
    function makeFakeVscodeContext() {
      const stateBag = new Map<string, unknown>();
      const secretBag = new Map<string, string>();
      return {
        context: {
          globalState: {
            get<T>(key: string, fallback: T): T {
              return (stateBag.get(key) as T) ?? fallback;
            },
            async update(key: string, value: unknown): Promise<void> {
              if (value === undefined) stateBag.delete(key);
              else stateBag.set(key, value);
            }
          },
          secrets: {
            async get(key: string): Promise<string | undefined> {
              return secretBag.get(key);
            },
            async store(key: string, value: string): Promise<void> {
              secretBag.set(key, value);
            },
            async delete(key: string): Promise<void> {
              secretBag.delete(key);
            }
          }
        } as unknown as import("vscode").ExtensionContext,
        stateBag
      };
    }

    it("a macro whose only variable declaration is invalid-named stays suppressed end to end — the exact incident from the security fix", async () => {
      const { context } = makeFakeVscodeContext();
      const store = new VscodeMacroStore(context, { runLegacyMigration: false });
      await store.initialize();
      await store.save([
        {
          name: "Password",
          text: "hunter2\n",
          secret: true,
          triggerPattern: "[Pp]assword:",
          variables: [{ name: "2bad" }]
        }
      ]);

      // Sanity check on the composed precondition: the invalid-named declaration
      // must have survived the store round-trip as a non-empty array — that's
      // exactly what keeps `MacroAutoTrigger.reload()`'s
      // `Array.isArray(variables) && variables.length > 0` guard suppressing this
      // macro's trigger. If the old `withSanitizedVariables` behaviour regressed
      // back in, this array would be empty or the key would be gone.
      const stored = store.getAll();
      expect(Array.isArray(stored[0].variables)).toBe(true);
      expect(stored[0].variables!.length).toBeGreaterThan(0);

      setActiveMacroStore(store);
      const trigger = new MacroAutoTrigger(); // constructor calls reload() synchronously
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("Password: ");
      flush();

      // The regression this guards against: a masked/secret macro whose sole
      // declared variable has an invalid name must NOT auto-fire on matching
      // output. Before the fix, normalization at the store boundary dropped the
      // invalid entry, emptied `variables`, un-suppressed the trigger, and
      // "hunter2\n" would have been sent here.
      expect(sent).toEqual([]);
      obs.dispose();
    });
  });

  describe("macro identity survives array mutation (moveUp/moveDown/remove) — fix/macro-trigger-index-identity", () => {
    it("REGRESSION: reordering macros does not reattach pause/resume state to whoever now sits in the old slot", () => {
      setConfig([
        { name: "A", text: "a\n", triggerPattern: "AAA" },
        { name: "B", text: "secret-password\n", triggerPattern: "BBB" },
        { name: "C", text: "c\n", triggerPattern: "CCC" }
      ]);
      const trigger = new MacroAutoTrigger();
      const macroA = macroAt(0);
      const macroB = macroAt(1);
      const macroC = macroAt(2);

      // User pauses B (a secret-bearing trigger) — C is left at its default (active).
      trigger.setDisabled(macroB, true);
      expect(trigger.isDisabled(macroB)).toBe(true);
      expect(trigger.isDisabled(macroC)).toBe(false);

      // Simulate `nexus.macro.moveDown` on B: it swaps array elements 1 and 2
      // in place and saves — exactly what macroCommands.ts does.
      void activeStore.save([macroA, macroC, macroB]);
      trigger.reload();

      // Both directions of the bug: B (now at slot 2) must STAY paused, and C
      // (now at slot 1 — B's old slot) must STAY active. Before the fix, state
      // was keyed by array position, so this reorder would have silently
      // resumed B (the secret macro) and paused C (the unrelated one).
      expect(trigger.isDisabled(macroB)).toBe(true);
      expect(trigger.isDisabled(macroC)).toBe(false);

      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("BBB"); // B's pattern — must NOT fire, it is still paused.
      flush();
      expect(sent).toEqual([]);

      obs.onOutput("CCC"); // C's pattern — must still fire, it was never paused.
      flush();
      expect(sent).toEqual(["c\n"]);

      obs.dispose();
    });

    it("removing a macro before a paused one leaves the paused one paused", () => {
      setConfig([
        { name: "A", text: "a\n", triggerPattern: "AAA" },
        { name: "B", text: "b-secret\n", triggerPattern: "BBB" }
      ]);
      const trigger = new MacroAutoTrigger();
      const macroB = macroAt(1);

      trigger.setDisabled(macroB, true);
      expect(trigger.isDisabled(macroB)).toBe(true);

      // Simulate `nexus.macro.remove` on A (index 0): splices it out, B shifts
      // from array index 1 down to index 0.
      void activeStore.save([macroB]);
      trigger.reload();

      expect(trigger.isDisabled(macroB)).toBe(true);

      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      obs.onOutput("BBB");
      flush();
      expect(sent).toEqual([]); // still paused despite shifting to index 0
      obs.dispose();
    });

    it("triggerInitiallyDisabled macros keep their resumed/paused state across a reorder", () => {
      setConfig([
        { name: "A", text: "a\n", triggerPattern: "AAA" },
        { name: "route", text: "show ip route\n", triggerPattern: "router#", triggerInitiallyDisabled: true },
        { name: "C", text: "c\n", triggerPattern: "CCC", triggerInitiallyDisabled: true }
      ]);
      const trigger = new MacroAutoTrigger();
      const macroA = macroAt(0);
      const macroRoute = macroAt(1);
      const macroC = macroAt(2);

      // Both start paused (triggerInitiallyDisabled).
      expect(trigger.isDisabled(macroRoute)).toBe(true);
      expect(trigger.isDisabled(macroC)).toBe(true);

      // User resumes "route" only.
      trigger.setDisabled(macroRoute, false);
      expect(trigger.isDisabled(macroRoute)).toBe(false);
      expect(trigger.isDisabled(macroC)).toBe(true);

      // Reorder: [A, route, C] -> [C, route, A]
      void activeStore.save([macroC, macroRoute, macroA]);
      trigger.reload();

      expect(trigger.isDisabled(macroRoute)).toBe(false); // still resumed
      expect(trigger.isDisabled(macroC)).toBe(true); // still paused
    });

    it("interval ownership survives a reorder — the interval macro keeps its owner and does not double-fire", () => {
      setConfig([
        { name: "A", text: "a\n", triggerPattern: "AAA" },
        { name: "poll", text: "show status\n", triggerPattern: "router#", triggerInterval: 10 }
      ]);
      const trigger = new MacroAutoTrigger();
      const macroA = macroAt(0);
      const macroPoll = macroAt(1);
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("router#");
      flush();
      expect(sent).toEqual(["show status\n"]);

      // Reorder: [A, poll] -> [poll, A]
      void activeStore.save([macroPoll, macroA]);
      trigger.reload();

      obs.onOutput("show status\nrouter#");
      vi.advanceTimersByTime(10_000);
      flush();
      // Fires exactly once more — ownership survived the reorder rather than
      // being dropped (zero fires) or duplicated (double fire).
      expect(sent).toEqual(["show status\n", "show status\n"]);
      obs.dispose();
    });

    it("macros without an id (anon: fallback identity) also survive a reorder", () => {
      const rawStore = new RawMacroStore();
      void rawStore.initialize();
      setActiveMacroStore(rawStore);
      mockConfig = { "nexus.terminal.macros": { autoTrigger: true } };

      void rawStore.save([
        { name: "A", text: "a\n", triggerPattern: "AAA" },
        { name: "B", text: "b-secret\n", triggerPattern: "BBB" },
        { name: "C", text: "c\n", triggerPattern: "CCC" }
      ] as TerminalMacro[]);

      const trigger = new MacroAutoTrigger();
      const [macroA, macroB, macroC] = rawStore.getAll();
      expect(macroB.id).toBeUndefined(); // confirms the anon: fallback path is exercised

      trigger.setDisabled(macroB, true);
      expect(trigger.isDisabled(macroB)).toBe(true);
      expect(trigger.isDisabled(macroC)).toBe(false);

      // Reorder: [A, B, C] -> [A, C, B]
      void rawStore.save([macroA, macroC, macroB]);
      trigger.reload();

      expect(trigger.isDisabled(macroB)).toBe(true);
      expect(trigger.isDisabled(macroC)).toBe(false);

      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      obs.onOutput("BBB");
      flush();
      expect(sent).toEqual([]);
      obs.onOutput("CCC");
      flush();
      expect(sent).toEqual(["c\n"]);
      obs.dispose();
    });

    it("two id-less macros with identical name AND text collide on the anon: fallback key — documented behaviour, not a bug", () => {
      // `macroStateKey()` falls back to `anon:${name}${NUL}${text}` only when a
      // macro has no `id`. Two macros that are byte-for-byte identical in both
      // name and text produce the SAME key in that case — there is no other
      // stable, position-independent identity available for a macro the store
      // hasn't assigned an id to (both InMemoryMacroStore and VscodeMacroStore
      // always assign one in practice, which is why this only matters for the
      // rare id-less path). This test asserts and documents that collision
      // rather than pretending it can't happen: give macros an id, or vary
      // their text, to avoid it.
      const rawStore = new RawMacroStore();
      void rawStore.initialize();
      setActiveMacroStore(rawStore);
      mockConfig = { "nexus.terminal.macros": { autoTrigger: true } };

      void rawStore.save([
        { name: "dup", text: "same\n", triggerPattern: "AAA" },
        { name: "dup", text: "same\n", triggerPattern: "BBB" }
      ] as TerminalMacro[]);

      const trigger = new MacroAutoTrigger();
      const [first, second] = rawStore.getAll();

      expect(macroStateKey(first)).toBe(macroStateKey(second));

      trigger.setDisabled(first, true);

      // Disabling "first" reports "second" as disabled too — they share a key.
      expect(trigger.isDisabled(second)).toBe(true);
    });
  });
});
