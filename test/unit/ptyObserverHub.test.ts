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
import type { TerminalHighlighter, TerminalHighlighterStream } from "../../src/services/terminalHighlighter";

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

/**
 * The highlighter stream buffers for a flush period so cross-chunk matches can
 * resolve. With highlighting off that buffering buys nothing — `apply()` is an
 * identity function — but it was still on the path, which is why turning
 * highlighting off never fixed the typing lag it appeared to cause.
 */
describe("PtyObserverHub.notifyOutput — highlighter bypass when highlighting is off", () => {
  function makeStream(): TerminalHighlighterStream & { pushed: string[]; flushes: number } {
    const pushed: string[] = [];
    const stream = {
      pushed,
      flushes: 0,
      push: (t: string) => pushed.push(t),
      flush: () => {
        stream.flushes += 1;
      }
    };
    return stream as unknown as TerminalHighlighterStream & { pushed: string[]; flushes: number };
  }

  function makeHighlighter(enabled: boolean): TerminalHighlighter {
    return {
      isEnabled: () => enabled,
      apply: (text: string) => (enabled ? `<${text}>` : text)
    } as unknown as TerminalHighlighter;
  }

  it("emits synchronously and skips the buffering stream when highlighting is disabled", () => {
    const hub = new PtyObserverHub();
    const stream = makeStream();
    const emitted: string[] = [];

    hub.notifyOutput("a", stream, makeHighlighter(false), (rendered) => emitted.push(rendered));

    // Rendered on the same tick as the chunk — no timer, no flush period.
    expect(emitted).toEqual(["a"]);
    expect(stream.pushed).toEqual([]);
  });

  it("still routes through the stream when highlighting is enabled", () => {
    const hub = new PtyObserverHub();
    const stream = makeStream();
    const emitted: string[] = [];

    hub.notifyOutput("a", stream, makeHighlighter(true), (rendered) => emitted.push(rendered));

    expect(stream.pushed).toEqual(["a"]);
    expect(emitted).toEqual([]);
  });

  it("keeps streaming for a highlighter double that predates isEnabled()", () => {
    const hub = new PtyObserverHub();
    const stream = makeStream();
    const legacy = { apply: (t: string) => t } as unknown as TerminalHighlighter;

    hub.notifyOutput("a", stream, legacy, () => {});

    expect(stream.pushed).toEqual(["a"]);
  });

  it("flushes what the stream is already holding when highlighting is toggled off mid-session", () => {
    const hub = new PtyObserverHub();
    const emitted: string[] = [];
    // A real-shaped stream: buffers until flushed, then emits through the PTY's
    // own emitter — exactly how each PTY wires createStream().
    let pending = "";
    const stream = {
      push: (t: string) => {
        pending += t;
      },
      flush: () => {
        if (pending) {
          emitted.push(pending);
          pending = "";
        }
      }
    } as unknown as TerminalHighlighterStream;

    let enabled = true;
    const highlighter = {
      isEnabled: () => enabled,
      apply: (text: string) => text
    } as unknown as TerminalHighlighter;

    hub.notifyOutput("buffered-", stream, highlighter, (rendered) => emitted.push(rendered));
    expect(emitted).toEqual([]);

    // User turns highlighting off; highlighter.reload() flips the flag.
    enabled = false;
    hub.notifyOutput("after", stream, highlighter, (rendered) => emitted.push(rendered));

    // Buffered text is not stranded, and it lands BEFORE the bypassed chunk.
    expect(emitted).toEqual(["buffered-", "after"]);
  });
});
