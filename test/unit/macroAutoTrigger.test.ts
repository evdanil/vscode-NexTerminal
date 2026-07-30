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
  private folders: string[] = [];
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

  public async replaceAll(macros: TerminalMacro[]): Promise<void> {
    await this.save(macros); // no vault here, and no id synthesis by design
  }

  public onDidChange(listener: MacroStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clearAll(): Promise<void> {
    this.macros = [];
    this.folders = [];
    for (const listener of this.listeners) listener();
  }

  // Kept in step with the MacroStore interface by hand: tsconfig.json only includes
  // src/**/*.ts, so `implements MacroStore` is never actually checked here and this
  // class silently drifted out of shape when folders were added.
  public getFolders(): string[] {
    return [...this.folders];
  }

  public async saveFolders(folders: string[]): Promise<void> {
    this.folders = [...folders];
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

    // Pins the EXACT position of the §6.1 skip relative to the `triggerInitiallyDisabled`
    // bookkeeping in reload() — the ordering that was the subject of four review rounds
    // in the PR that introduced it (see macroAutoTrigger.ts's §6.1 comment). The variables
    // `continue` must run BEFORE `defaultDisabledKeys.add(stateKey)`, so a macro that
    // declares both `variables` and `triggerInitiallyDisabled` never gets a disabled-state
    // entry recorded for a rule that will never compile. If that `continue` were moved
    // below the bookkeeping, `isDisabled()` below would flip to `true` (the key would land
    // in `defaultDisabledKeys` with nothing in `enabledKeys` to counter it) even though no
    // rule compiled — this test fails immediately under that regression, unlike the
    // "identity coherence" test further below, which doesn't move or change any identity
    // and so passes under either ordering.
    it("§6.1 skip position: variables + triggerInitiallyDisabled produces no compiled rule AND no disabled-state entry", () => {
      setConfig([
        {
          name: "hasVarsDisabled",
          text: "show ip route $host\n",
          triggerPattern: "router#",
          variables: [{ name: "host" }],
          triggerInitiallyDisabled: true
        }
      ]);
      const trigger = new MacroAutoTrigger();
      const macro = macroAt(0);

      // The key must never have entered `defaultDisabledKeys`: if it had,
      // isDisabledByKey() would report `true` (default-disabled with nothing in
      // enabledKeys to counter it) even though the rule never compiled.
      expect(trigger.isDisabled(macro)).toBe(false);

      // And, as a consequence of no rule compiling, it must never auto-fire.
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      obs.onOutput("router#");
      flush();
      expect(sent).toEqual([]);
      obs.dispose();
    });

    // NOTE: this one does NOT pin the position of the §6.1 `continue` relative to the
    // `triggerInitiallyDisabled` bookkeeping — the test above does that. What it pins
    // is that a compile-skipped sibling does not disturb the identity keying of the
    // macros around it ACROSS AN ARRAY MUTATION. The mutation is the point: an earlier
    // version of this test never moved, renamed, removed or re-id'd anything, so
    // reverting every state map in MacroAutoTrigger to array indices left it green.
    // It now reorders the list between the disable and the assertions, which is the
    // operation (`nexus.macro.moveUp`/`moveDown`) that index keying gets wrong.
    it("identity coherence: a paused password macro stays paused across a REORDER even though a sibling macro declares variables and compiles no rule", () => {
      setConfig([
        { name: "interval", text: "show status\n", triggerPattern: "router#", triggerInterval: 10 },
        { name: "hasVars", text: "show ip route $host\n", triggerPattern: "router#", variables: [{ name: "host" }] },
        { name: "pw", text: "secret123\n", triggerPattern: "[Pp]assword:\\s*$" },
        { name: "banner", text: "banner\n", triggerPattern: "MOTD" }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      const intervalMacro = macroAt(0);
      const varsMacro = macroAt(1);
      const pwMacro = macroAt(2);
      const bannerMacro = macroAt(3);

      // Arm the interval macro so intervalOwners keys it by identity.
      obs.onOutput("router#");
      flush();
      expect(sent).toEqual(["show status\n"]);

      // Disable the password macro by identity, exactly as extension.ts's
      // setDisabled(item.macro, …) does.
      trigger.setDisabled(pwMacro, true);
      expect(trigger.isDisabled(pwMacro)).toBe(true);

      // Reorder, as `nexus.macro.moveUp`/`moveDown` do — the password macro leaves
      // slot 2 and the banner macro takes it. Under index keying the pause would
      // transfer to whoever now occupies the old slot: `banner` would go silent and
      // `pw` would go live, which is the whole hazard this PR exists to close.
      void activeStore.save([intervalMacro, varsMacro, bannerMacro, pwMacro]);
      trigger.reload();

      expect(trigger.isDisabled(pwMacro)).toBe(true);
      expect(trigger.isDisabled(bannerMacro)).toBe(false);
      expect(trigger.isDisabled(intervalMacro)).toBe(false);

      // The password macro (still disabled) must not fire...
      obs.onOutput("Password: ");
      flush();
      expect(sent).toEqual(["show status\n"]);
      // ...and the macro that inherited its old slot must NOT have inherited its pause.
      obs.onOutput("MOTD");
      flush();
      expect(sent).toEqual(["show status\n", "banner\n"]);

      // The interval macro's ownership survived the reorder — re-arm and confirm it
      // still fires the SAME interval macro after the interval elapses.
      obs.onOutput("Codes: C connected\r\nrouter#");
      vi.advanceTimersByTime(10_000);
      flush();
      expect(sent).toEqual(["show status\n", "banner\n", "show status\n"]);

      // Re-enabling the password macro by identity fires it — proving identity
      // still resolves to it, not to the (compile-skipped) variables macro.
      trigger.setDisabled(pwMacro, false);
      obs.onOutput("Password: ");
      flush();
      expect(sent).toEqual(["show status\n", "banner\n", "show status\n", "secret123\n"]);

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
            },
            async keys(): Promise<string[]> {
              return [...secretBag.keys()];
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

      // Reorder: [A, route, C] -> [A, C, route] — route and C actually swap slots
      // (route: index 1 -> 2, C: index 2 -> 1). Under array-position-keyed state
      // this flips both: whatever now sits at index 1 (C) would read as "resumed"
      // (that slot's key is in enabledKeys), and whatever sits at index 2 (route)
      // would read as still "default-disabled" (that slot's key never entered
      // enabledKeys). A reorder that leaves the overridden macro at the same index
      // (e.g. [A, route, C] -> [C, route, A]) can't tell the two implementations
      // apart, since route never changes slot.
      void activeStore.save([macroA, macroC, macroRoute]);
      trigger.reload();

      expect(trigger.isDisabled(macroRoute)).toBe(false); // still resumed
      expect(trigger.isDisabled(macroC)).toBe(true); // still paused
    });

    it("interval ownership survives a reorder — the interval macro keeps its owner and does not double-fire", () => {
      // Uses TWO observers deliberately. A single-observer version of this test
      // can't tell a correct reorder-survives-reload implementation apart from a
      // buggy one that wrongly clears ownership/lastFired/timers on reload: with
      // only one observer around, feeding it a fresh matching prompt after reload
      // just makes it reacquire ownership from scratch and fire — producing the
      // exact same "fires exactly once more" output either way. A second observer
      // (B) that never owned this interval macro exposes the difference: if
      // reload dropped ownership, B's matching prompt (delivered first, before A
      // gets a chance) would let B steal ownership and fire — which the "B stays
      // silent" assertion below catches.
      setConfig([
        { name: "A", text: "a\n", triggerPattern: "AAA" },
        { name: "poll", text: "show status\n", triggerPattern: "router#", triggerInterval: 10 }
      ]);
      const trigger = new MacroAutoTrigger();
      const macroA = macroAt(0);
      const macroPoll = macroAt(1);
      const sentA: string[] = [];
      const sentB: string[] = [];
      const obsA = trigger.createObserver((text) => sentA.push(text));
      const obsB = trigger.createObserver((text) => sentB.push(text));

      // Arm the interval on observer A only — A becomes its owner.
      obsA.onOutput("router#");
      flush();
      expect(sentA).toEqual(["show status\n"]);
      expect(sentB).toEqual([]);

      // Reorder: [A, poll] -> [poll, A]
      void activeStore.save([macroPoll, macroA]);
      trigger.reload();

      // A fresh matching prompt delivered to B (which never owned this macro)
      // must NOT let B acquire ownership — A still owns it after the reorder.
      obsB.onOutput("router#");
      flush();
      expect(sentB).toEqual([]);

      // A does not fire again before the interval elapses. Deliberately no
      // flush() here: evaluate() runs synchronously inside onOutput and, since
      // the interval hasn't elapsed, only *schedules* a future evaluation — it
      // never touches sentA. flush() (vi.runAllTimers()) would run that
      // schedule to completion regardless of its 10s delay, so calling it here
      // would defeat this exact assertion.
      obsA.onOutput("show status\nrouter#");
      expect(sentA).toEqual(["show status\n"]);

      // Now step the clock in two parts rather than jumping the whole interval.
      // Ownership surviving is not the only thing reload could get wrong: it
      // could preserve ownership and still drop `lastFired`, in which case the
      // remaining delay computes as 0 and the macro fires early. A single
      // advance of the full interval cannot tell that apart from correct
      // behaviour — both end with exactly one more send — so the cooldown has
      // to be observed part-way through.
      vi.advanceTimersByTime(9_000);
      expect(sentA).toEqual(["show status\n"]);

      // ...and fires exactly once more when the interval actually elapses —
      // ownership survived the reorder rather than being dropped (B would have
      // fired above) or duplicated (both A and B firing here).
      vi.advanceTimersByTime(1_000);
      flush();
      expect(sentA).toEqual(["show status\n", "show status\n"]);
      expect(sentB).toEqual([]);

      obsA.dispose();
      obsB.dispose();
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

    it("two id-less macros with identical name AND text collide on the anon: fallback key — and that collision is treated as ambiguous, not as shared state", () => {
      // `macroStateKey()` falls back to `anon:${name}${NUL}${text}` only when a
      // macro has no `id`. Two macros that are byte-for-byte identical in both
      // name and text produce the SAME key in that case — there is no other
      // stable, position-independent identity available for a macro the store
      // hasn't assigned an id to. Both InMemoryMacroStore and VscodeMacroStore
      // enforce a unique, non-empty id for every macro on save() (an explicit
      // empty string is normalized the same as a missing id, and a later
      // duplicate id is reassigned a fresh one — see macroStore.test.ts), which
      // is why this collision only matters for the rare id-less `RawMacroStore`
      // path exercised below.
      //
      // The fallback is sound exactly as long as it is unique. When it is not, it is
      // no more usable than a duplicated `id` and gets the identical treatment: both
      // macros are ambiguous, so NEITHER compiles a rule and neither can fire. Letting
      // them share one live key instead would mean pausing one silently pauses the
      // other — and, worse, resuming one silently resumes the other.
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

      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      obs.onOutput("AAA");
      flush();
      obs.onOutput("BBB");
      flush();
      expect(sent).toEqual([]);
      obs.dispose();
    });

    it("macroStateKey() does not let two macros with differently-shaped non-string ids collide on a coerced key (Fix 2)", () => {
      // A bare `macro.id ? ... : ...` guard treats any truthy `id` — including a
      // non-string object surviving a corrupt import — as valid, and the template
      // literal below it coerces every such object to the SAME string,
      // "[object Object]", regardless of its actual shape or which macro it came
      // from. Two macros that differ in every other field would then collide on
      // "id:[object Object]" even though nothing upstream ever treated their ids
      // as equal.
      const macroA = { id: { length: 1 } as unknown as string, name: "A", text: "textA" } as unknown as TerminalMacro;
      const macroB = { id: { length: 1 } as unknown as string, name: "B", text: "textB" } as unknown as TerminalMacro;
      expect(macroStateKey(macroA)).not.toBe(macroStateKey(macroB));
    });
  });

  describe("ambiguous macro identity — two macros claiming one state key fail safe", () => {
    /**
     * Duplicate ids reach MacroAutoTrigger because the STORE deliberately stops
     * repairing them: at load there is no answerable question of which of two macros
     * sharing an id owns the single vault entry behind it, and every award heuristic
     * tried in review either handed one macro another's password, destroyed the only
     * copy of a legitimate secret, or re-derived identity from array position.
     * `RawMacroStore` stands in for that persisted state — it saves ids verbatim,
     * exactly as `VscodeMacroStore.reloadFromState()` now surfaces them.
     */
    function seed(macros: Array<Record<string, unknown>>): RawMacroStore {
      const rawStore = new RawMacroStore();
      void rawStore.initialize();
      setActiveMacroStore(rawStore);
      mockConfig = { "nexus.terminal.macros": { autoTrigger: true } };
      void rawStore.save(macros as TerminalMacro[]);
      return rawStore;
    }

    it("neither of two macros sharing an id compiles a rule — an ambiguous macro cannot fire at all", () => {
      // Restore of a backup ordered [A, P] where both carry id "dup" and P is a
      // deliberately-paused secret password trigger. Awarding "dup" to whichever
      // claimant sorts first makes ownership positional again and lets P go live under
      // A's state. Nothing may fire here.
      seed([
        { id: "dup", name: "A", text: "harmless\n", triggerPattern: "AAA" },
        { id: "dup", name: "P", text: "hunter2\n", secret: true, triggerPattern: "[Pp]assword:" }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("AAA");
      flush();
      obs.onOutput("Password: ");
      flush();

      expect(sent).toEqual([]);
      obs.dispose();
    });

    it("a macro with a UNIQUE id in the same set is unaffected — suppression is per key, not global", () => {
      seed([
        { id: "dup", name: "A", text: "a\n", triggerPattern: "AAA" },
        { id: "dup", name: "B", text: "b\n", triggerPattern: "BBB" },
        { id: "solo", name: "C", text: "c\n", triggerPattern: "CCC" }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("AAA");
      obs.onOutput("BBB");
      flush();
      expect(sent).toEqual([]);

      obs.onOutput("CCC");
      flush();
      expect(sent).toEqual(["c\n"]);
      obs.dispose();
    });

    it("ambiguity is measured across the WHOLE macro set: a macro with no trigger pattern still claims its key", () => {
      // The colliding macro never reaches the compile loop — it has no triggerPattern,
      // so it `continue`s out on the first guard. Counting keys only for macros that
      // survive that far would leave "dup" looking unique and let the password trigger
      // compile, while `isDisabled()`/`setDisabled()`/`pruneState()` still treat the two
      // macros as one.
      seed([
        { id: "dup", name: "Plain", text: "not a trigger\n" },
        { id: "dup", name: "P", text: "hunter2\n", secret: true, triggerPattern: "[Pp]assword:" }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));

      obs.onOutput("Password: ");
      flush();

      expect(sent).toEqual([]);
      obs.dispose();
    });

    it("skip position: an ambiguous macro records no default-disabled entry either", () => {
      // Same shape as the §6.1 skip-position test above. The ambiguity `continue` must
      // run BEFORE `defaultDisabledKeys.add(stateKey)`: if it ran after, the shared key
      // would land in `defaultDisabledKeys` with nothing in `enabledKeys` to counter it
      // and `isDisabled()` would report `true` for a rule that never compiled — state
      // recorded under a key whose owner is unknown, which is exactly what must not
      // happen.
      const store = seed([
        { id: "dup", name: "A", text: "a\n", triggerPattern: "AAA", triggerInitiallyDisabled: true },
        { id: "dup", name: "B", text: "b\n", triggerPattern: "BBB" }
      ]);
      const trigger = new MacroAutoTrigger();
      const [a, b] = store.getAll();

      expect(trigger.isDisabled(a)).toBe(false);
      expect(trigger.isDisabled(b)).toBe(false);
    });

    it("setDisabled() records nothing under an ambiguous key, so the surviving claimant cannot inherit it when a save re-keys the duplicates", () => {
      const store = seed([
        { id: "dup", name: "A", text: "a\n", triggerPattern: "AAA" },
        { id: "dup", name: "P", text: "hunter2\n", secret: true, triggerPattern: "[Pp]assword:" }
      ]);
      const trigger = new MacroAutoTrigger();
      const [a, p] = store.getAll();

      // The user pauses one of them (reachable only from a caller that bypasses the
      // tree, which hides the Pause/Resume items for a conflicted macro).
      trigger.setDisabled(a, true);

      // The conflict is then resolved the supported way — a save re-keys the
      // duplicates — with NO intervening reload to prune anything.
      void store.save([{ ...a, id: "dup" }, { ...p, id: "fresh" }] as TerminalMacro[]);
      trigger.reload();

      const [aFixed, pFixed] = store.getAll();
      // Whoever kept "dup" must not inherit a pause the user set while the key meant
      // "either of these two macros".
      expect(trigger.isDisabled(aFixed)).toBe(false);
      expect(trigger.isDisabled(pFixed)).toBe(false);

      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      obs.onOutput("AAA");
      flush();
      expect(sent).toEqual(["a\n"]);
      obs.dispose();
    });

    it("pruneState() evicts a key that BECOMES ambiguous, so it is not still parked there when the conflict is resolved", () => {
      // The other direction of the same invariant: the key was written while it
      // unambiguously belonged to A, and only later did a second claimant appear.
      const store = seed([
        { id: "a", name: "A", text: "a\n", triggerPattern: "AAA" },
        { id: "b", name: "B", text: "b\n", triggerPattern: "BBB" }
      ]);
      const trigger = new MacroAutoTrigger();
      const [a, b] = store.getAll();
      trigger.setDisabled(a, true);
      expect(trigger.isDisabled(a)).toBe(true);

      // A duplicate of A's id arrives (a merge import, a hand-edited backup).
      void store.save([a, b, { id: "a", name: "A-clone", text: "clone\n", triggerPattern: "CCC" }] as TerminalMacro[]);
      trigger.reload();

      // ...and is then resolved.
      void store.save([a, b, { id: "c", name: "A-clone", text: "clone\n", triggerPattern: "CCC" }] as TerminalMacro[]);
      trigger.reload();

      expect(trigger.isDisabled(store.getAll()[0])).toBe(false);
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text));
      obs.onOutput("AAA");
      flush();
      expect(sent).toEqual(["a\n"]);
      obs.dispose();
    });

    it("an armed interval macro stops when its key becomes ambiguous — ownership and timers are released, not left running", () => {
      const store = seed([
        { id: "poll", name: "Poll", text: "show status\n", triggerPattern: "router#", triggerInterval: 10 }
      ]);
      const trigger = new MacroAutoTrigger();
      const sent: string[] = [];
      const obs = trigger.createObserver((text) => sent.push(text), () => true);

      obs.onOutput("router#");
      flush();
      expect(sent).toEqual(["show status\n"]);

      // A second macro claiming "poll" arrives.
      const [poll] = store.getAll();
      void store.save([poll, { id: "poll", name: "Clone", text: "clone\n", triggerPattern: "ZZZ" }] as TerminalMacro[]);
      trigger.reload();

      obs.onOutput("Codes: C connected\r\nrouter#");
      vi.advanceTimersByTime(60_000);
      flush();
      expect(sent).toEqual(["show status\n"]);

      // Silence is guaranteed by reload()'s ambiguity `continue` on its own, so asserting
      // only silence says nothing about whether `intervalOwners` still names `obs` as the
      // owner of "id:poll". A leaked owner is invisible until the conflict is resolved —
      // and then it locks every OTHER observer out of that macro permanently, because
      // evaluate() bails on `owner && owner !== observerState` before it ever looks at the
      // pattern. Resolve the conflict and require a second observer to take ownership;
      // that is the assertion a leak cannot pass.
      void store.save([poll, { id: "clone", name: "Clone", text: "clone\n", triggerPattern: "ZZZ" }] as TerminalMacro[]);
      trigger.reload();

      const sent2: string[] = [];
      const obs2 = trigger.createObserver((text) => sent2.push(text), () => true);
      obs2.onOutput("router#");
      flush();
      expect(sent2).toEqual(["show status\n"]);

      obs2.dispose();
      obs.dispose();
    });
  });

  describe("shared trigger-field definitions", () => {
    it("compiles cooldowns and intervals through the same functions the content keys and the import sanitizer use", async () => {
      // `DEFAULT_TRIGGER_COOLDOWN` and the two `compiledTrigger*Seconds()` helpers moved into
      // storage/macroStore.ts so that the three readers of a stored trigger field — this compiler,
      // `canonicalMacroTriggerTerms()`, and `sanitizeImportedMacro()` — cannot hold three opinions
      // about what it means. Every duplicate-macro bug on this branch was two of those three
      // disagreeing, so the wiring itself is worth pinning: if the re-export ever resolved to
      // `undefined` (an import cycle, a bundling accident), the macro editor would start persisting
      // an explicit `3` where it now leaves the field absent, and every macro it saved would key as
      // a different macro from the one it replaced.
      const store = await import("../../src/storage/macroStore");
      const { DEFAULT_TRIGGER_COOLDOWN } = await import("../../src/services/macroAutoTrigger");
      expect(DEFAULT_TRIGGER_COOLDOWN).toBe(3);
      expect(DEFAULT_TRIGGER_COOLDOWN).toBe(store.DEFAULT_TRIGGER_COOLDOWN);

      // The three branches this compiler takes, asserted against the shared helper rather than
      // restated: clamped inside the bounds, the shipped fallback for anything unusable, and
      // "no explicit cooldown" for absent.
      expect(store.compiledTriggerCooldownSeconds(5000)).toBe(300);
      expect(store.compiledTriggerCooldownSeconds(-5)).toBe(0);
      expect(store.compiledTriggerCooldownSeconds("5")).toBe(DEFAULT_TRIGGER_COOLDOWN);
      expect(store.compiledTriggerCooldownSeconds(undefined)).toBeUndefined();
      expect(store.compiledTriggerCooldownSeconds(null)).toBeUndefined();
      // The interval is NOT clamped — `reload()` asks only for `> 0`.
      expect(store.compiledTriggerIntervalSeconds(0.5)).toBe(0.5);
      expect(store.compiledTriggerIntervalSeconds(0)).toBeUndefined();
      expect(store.compiledTriggerIntervalSeconds("60")).toBeUndefined();
    });
  });
});
