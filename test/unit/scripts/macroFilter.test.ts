import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let mockConfig: Record<string, Record<string, unknown>> = {};

vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(v: T) => void>();
    public readonly event = (l: (v: T) => void) => {
      this.listeners.add(l);
      return { dispose: () => this.listeners.delete(l) };
    };
    public fire(v?: T): void {
      for (const l of this.listeners) l(v as T);
    }
    public dispose(): void {
      this.listeners.clear();
    }
  },
  Disposable: class MockDisposable {
    public constructor(private readonly fn: () => void) {}
    public dispose(): void {
      this.fn();
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

import { MacroAutoTrigger } from "../../../src/services/macroAutoTrigger";
import { ScriptMacroFilter } from "../../../src/services/scripts/scriptMacroFilter";

function setConfig(macros: Array<Record<string, unknown>>): void {
  mockConfig = {
    "nexus.terminal": { macros },
    "nexus.terminal.macros": { autoTrigger: true }
  };
}

describe("MacroAutoTrigger + ScriptMacroFilter", () => {
  beforeEach(() => {
    mockConfig = {};
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suspends all macros on the filtered session with defaultAllow=false", () => {
    setConfig([{ name: "pw", text: "secret\n", triggerPattern: "[Pp]assword:" }]);
    const trigger = new MacroAutoTrigger();
    const sessionA: string[] = [];
    const obsA = trigger.createObserver((t) => sessionA.push(t), undefined, "session-A");

    const filter = new ScriptMacroFilter({ defaultAllow: false, allowList: [], denyList: [] });
    const disposable = trigger.pushFilter("session-A", filter);

    obsA.onOutput("Password: ");
    vi.runAllTimers();
    expect(sessionA).toEqual([]);

    disposable.dispose();
    obsA.onOutput("Password: ");
    vi.runAllTimers();
    expect(sessionA).toEqual(["secret\n"]);
    obsA.dispose();
  });

  it("does not affect unrelated sessions", () => {
    setConfig([{ name: "pw", text: "secret\n", triggerPattern: "[Pp]assword:" }]);
    const trigger = new MacroAutoTrigger();
    const sentA: string[] = [];
    const sentB: string[] = [];
    const obsA = trigger.createObserver((t) => sentA.push(t), undefined, "session-A");
    const obsB = trigger.createObserver((t) => sentB.push(t), undefined, "session-B");

    trigger.pushFilter("session-A", new ScriptMacroFilter({ defaultAllow: false, allowList: [], denyList: [] }));
    obsA.onOutput("Password: ");
    obsB.onOutput("Password: ");
    vi.runAllTimers();

    expect(sentA).toEqual([]);
    expect(sentB).toEqual(["secret\n"]);
    obsA.dispose();
    obsB.dispose();
  });

  it("allowList lets named macros through even when defaultAllow=false", () => {
    setConfig([
      { name: "pw", text: "secret\n", triggerPattern: "[Pp]assword:" },
      { name: "hello", text: "hi\n", triggerPattern: "Hello:" }
    ]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((t) => sent.push(t), undefined, "session-A");
    trigger.pushFilter(
      "session-A",
      new ScriptMacroFilter({ defaultAllow: false, allowList: ["pw"], denyList: [] })
    );

    obs.onOutput("Password: ");
    obs.onOutput(" Hello: ");
    vi.runAllTimers();
    expect(sent).toEqual(["secret\n"]);
    obs.dispose();
  });

  it("denyList overrides allowList", () => {
    setConfig([{ name: "pw", text: "secret\n", triggerPattern: "[Pp]assword:" }]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((t) => sent.push(t), undefined, "session-A");
    trigger.pushFilter(
      "session-A",
      new ScriptMacroFilter({ defaultAllow: true, allowList: ["pw"], denyList: ["pw"] })
    );
    obs.onOutput("Password: ");
    vi.runAllTimers();
    expect(sent).toEqual([]);
    obs.dispose();
  });

  it("LIFO-stacks filters and restores prior policy on popFilter", () => {
    setConfig([{ name: "pw", text: "secret\n", triggerPattern: "[Pp]assword:" }]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    const obs = trigger.createObserver((t) => sent.push(t), undefined, "session-A");
    const outer = trigger.pushFilter(
      "session-A",
      new ScriptMacroFilter({ defaultAllow: true, allowList: [], denyList: [] })
    );
    const inner = trigger.pushFilter(
      "session-A",
      new ScriptMacroFilter({ defaultAllow: false, allowList: [], denyList: [] })
    );

    // Inner is active: deny all
    obs.onOutput("Password: ");
    vi.runAllTimers();
    expect(sent).toEqual([]);

    // Remove inner, outer (allow all) applies
    inner.dispose();
    obs.onOutput("Password: ");
    vi.runAllTimers();
    expect(sent).toEqual(["secret\n"]);

    outer.dispose();
    obs.dispose();
  });

  it("creates observers without sessionId and applies no filter", () => {
    setConfig([{ name: "pw", text: "secret\n", triggerPattern: "[Pp]assword:" }]);
    const trigger = new MacroAutoTrigger();
    const sent: string[] = [];
    // No sessionId → filter API doesn't apply
    const obs = trigger.createObserver((t) => sent.push(t));
    trigger.pushFilter("session-unrelated", new ScriptMacroFilter({ defaultAllow: false, allowList: [], denyList: [] }));
    obs.onOutput("Password: ");
    vi.runAllTimers();
    expect(sent).toEqual(["secret\n"]);
    obs.dispose();
  });
});
