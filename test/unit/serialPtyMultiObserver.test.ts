import { describe, expect, it, vi } from "vitest";

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

import { SerialPty } from "../../src/services/serial/serialPty";
import type { PtyOutputObserver } from "../../src/services/macroAutoTrigger";

function makeObserver(): PtyOutputObserver & { disposed: boolean } {
  return {
    disposed: false,
    onOutput() {},
    pauseIntervalMacros() {},
    dispose() {
      (this as { disposed: boolean }).disposed = true;
    }
  };
}

function buildPty(initial?: PtyOutputObserver): SerialPty {
  const transport = {
    onDidReceiveData: () => () => {},
    onDidReceiveError: () => () => {},
    onDidDisconnect: () => () => {},
    writePort: vi.fn(),
    openPort: vi.fn(),
    closePort: vi.fn()
  } as unknown as ConstructorParameters<typeof SerialPty>[0];
  const options = { path: "/dev/null", baudRate: 9600 } as unknown as ConstructorParameters<typeof SerialPty>[1];
  const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() } as unknown as ConstructorParameters<typeof SerialPty>[2];
  const logger = { log: vi.fn(), close: vi.fn() } as unknown as ConstructorParameters<typeof SerialPty>[3];
  return new SerialPty(transport, options, callbacks, logger, undefined, undefined, initial);
}

describe("SerialPty multi-observer + setInputBlocked", () => {
  it("legacy + added observer both receive dispose", () => {
    const o1 = makeObserver();
    const o2 = makeObserver();
    const pty = buildPty(o1);
    pty.addOutputObserver(o2);
    pty.dispose();
    expect(o1.disposed).toBe(true);
    expect(o2.disposed).toBe(true);
  });

  it("disposable returned by addOutputObserver removes the observer", () => {
    const pty = buildPty();
    const o = makeObserver();
    pty.addOutputObserver(o).dispose();
    pty.dispose();
    expect(o.disposed).toBe(false);
  });

  it("setInputBlocked gates handleInput without throwing", () => {
    const pty = buildPty();
    pty.setInputBlocked(true);
    expect(() => pty.handleInput("hello")).not.toThrow();
  });

  it("notice emitted once per lock period", () => {
    const pty = buildPty();
    const writes: string[] = [];
    pty.onDidWrite((t) => writes.push(t));
    pty.setInputBlocked(true);
    pty.handleInput("a");
    pty.handleInput("b");
    pty.setInputBlocked(false);
    pty.setInputBlocked(true);
    pty.handleInput("c");
    const locks = writes.filter((w) => w.includes("Terminal is locked"));
    expect(locks).toHaveLength(2);
  });
});
