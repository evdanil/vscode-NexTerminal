import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Disposable: class MockDisposable {
    public constructor(private readonly fn: () => void) {}
    public dispose(): void {
      this.fn();
    }
  }
}));

import { PtyObserverHub } from "../../src/services/terminal/ptyObserverHub";
import type { PtyOutputObserver } from "../../src/services/macroAutoTrigger";
import type { TerminalHighlighterStream } from "../../src/services/terminalHighlighter";

function makeObserver(onOutput?: (text: string) => void): PtyOutputObserver & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    onOutput: onOutput ?? ((t: string) => seen.push(t)),
    pauseIntervalMacros: () => {},
    dispose: () => {}
  };
}

function throwingObserver(message = "boom"): PtyOutputObserver {
  return {
    onOutput: () => {
      throw new Error(message);
    },
    pauseIntervalMacros: () => {},
    dispose: () => {}
  };
}

describe("PtyObserverHub.notifyOutput", () => {
  it("delivers output to every observer when none throw", () => {
    const hub = new PtyObserverHub();
    const a = makeObserver();
    const b = makeObserver();
    hub.addOutputObserver(a);
    hub.addOutputObserver(b);

    hub.notifyOutput("hello", undefined, undefined, () => {});

    expect(a.seen).toEqual(["hello"]);
    expect(b.seen).toEqual(["hello"]);
  });

  it("an observer that throws does not break delivery to the other observers (§6.6)", () => {
    const hub = new PtyObserverHub();
    hub.addOutputObserver(throwingObserver());
    const healthy = makeObserver();
    hub.addOutputObserver(healthy);

    expect(() => hub.notifyOutput("data", undefined, undefined, () => {})).not.toThrow();
    expect(healthy.seen).toEqual(["data"]);
  });

  it("does not break delivery regardless of registration order (throwing observer registered last)", () => {
    const hub = new PtyObserverHub();
    const healthy = makeObserver();
    hub.addOutputObserver(healthy);
    hub.addOutputObserver(throwingObserver());

    expect(() => hub.notifyOutput("data", undefined, undefined, () => {})).not.toThrow();
    expect(healthy.seen).toEqual(["data"]);
  });

  it("still renders via emit() when no highlighter stream is present, even with a throwing observer", () => {
    const hub = new PtyObserverHub();
    hub.addOutputObserver(throwingObserver());
    const emitted: string[] = [];

    hub.notifyOutput("x", undefined, undefined, (rendered) => emitted.push(rendered));

    expect(emitted).toEqual(["x"]);
  });

  it("still pushes to the highlighter stream when present, even with a throwing observer", () => {
    const hub = new PtyObserverHub();
    hub.addOutputObserver(throwingObserver());
    const pushed: string[] = [];
    const stream = { push: (t: string) => pushed.push(t) } as unknown as TerminalHighlighterStream;

    hub.notifyOutput("y", stream, undefined, () => {});

    expect(pushed).toEqual(["y"]);
  });

  it("multiple throwing observers each tolerate independently, healthy observers still see output", () => {
    const hub = new PtyObserverHub();
    hub.addOutputObserver(throwingObserver("first"));
    const healthy = makeObserver();
    hub.addOutputObserver(healthy);
    hub.addOutputObserver(throwingObserver("second"));

    expect(() => hub.notifyOutput("z", undefined, undefined, () => {})).not.toThrow();
    expect(healthy.seen).toEqual(["z"]);
  });
});
