import { describe, expect, it, vi, beforeEach } from "vitest";

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
  }
}));

import { SshPty } from "../../src/services/ssh/sshPty";
import type { PtyOutputObserver } from "../../src/services/macroAutoTrigger";

function buildPty(initialObserver?: PtyOutputObserver): { pty: SshPty; writes: string[] } {
  const writes: string[] = [];
  const pty = new SshPty(
    { id: "s1", name: "test", host: "h", port: 22, username: "u" } as unknown as Parameters<typeof SshPty>[0],
    { create: vi.fn() } as unknown as Parameters<typeof SshPty>[1],
    { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() },
    { log: vi.fn(), close: vi.fn() } as unknown as Parameters<typeof SshPty>[3],
    undefined,
    undefined,
    initialObserver
  );
  pty.onDidWrite((t) => writes.push(t));
  return { pty, writes };
}

function makeObserver(): PtyOutputObserver & { seen: string[]; disposed: boolean; paused: number } {
  const o = {
    seen: [] as string[],
    disposed: false,
    paused: 0,
    onOutput(t: string) {
      o.seen.push(t);
    },
    pauseIntervalMacros() {
      o.paused++;
    },
    dispose() {
      o.disposed = true;
    }
  };
  return o;
}

describe("SshPty multi-observer + setInputBlocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("legacy single-observer constructor arg becomes the first registered observer", () => {
    const legacy = makeObserver();
    const { pty } = buildPty(legacy);
    pty.addOutputObserver(makeObserver()); // add a second
    pty.dispose();
    expect(legacy.disposed).toBe(true);
  });

  it("addOutputObserver returns a Disposable that removes the observer", () => {
    const { pty } = buildPty();
    const o = makeObserver();
    const sub = pty.addOutputObserver(o);
    sub.dispose();
    pty.dispose();
    expect(o.disposed).toBe(false); // already removed before the fan-out dispose
  });

  it("setInputBlocked(true) discards handleInput", () => {
    const { pty } = buildPty();
    pty.setInputBlocked(true);
    pty.handleInput("hello");
    // No SSH stream is ever attached in this test, so nothing to assert on write;
    // the test is: no throw when handleInput receives data while locked.
    expect(() => pty.handleInput("more")).not.toThrow();
  });

  it("writes a single info line to writeEmitter on the first dropped keystroke while locked", () => {
    const { pty, writes } = buildPty();
    pty.setInputBlocked(true);
    pty.handleInput("a");
    pty.handleInput("b");
    pty.handleInput("c");
    const locks = writes.filter((w) => w.includes("Terminal is locked"));
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatch(/^\r\n\[Nexus\] Terminal is locked.*\r\n$/);
  });

  it("re-arms the notice on next setInputBlocked(true)", () => {
    const { pty, writes } = buildPty();
    pty.setInputBlocked(true);
    pty.handleInput("a");
    pty.setInputBlocked(false);
    pty.setInputBlocked(true);
    pty.handleInput("b");
    const locks = writes.filter((w) => w.includes("Terminal is locked"));
    expect(locks).toHaveLength(2);
  });
});
