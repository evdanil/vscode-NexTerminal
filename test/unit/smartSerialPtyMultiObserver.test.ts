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

import { SmartSerialPty } from "../../src/services/serial/smartSerialPty";
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

function buildPty(initial?: PtyOutputObserver): SmartSerialPty {
  const transport = {
    onDidReceiveData: () => () => {},
    onDidReceiveError: () => () => {},
    onDidDisconnect: () => () => {},
    writePort: vi.fn(),
    openPort: vi.fn(),
    closePort: vi.fn()
  } as unknown as ConstructorParameters<typeof SmartSerialPty>[0];
  const profile = { id: "p1", name: "serial", path: "/dev/null", baudRate: 9600 } as unknown as ConstructorParameters<typeof SmartSerialPty>[1];
  const callbacks = {
    onSessionOpened: vi.fn(),
    onSessionClosed: vi.fn(),
    onClosed: vi.fn(),
    onTransportSessionChanged: vi.fn(),
    onActivePortChanged: vi.fn(),
    onDataReceived: vi.fn()
  } as unknown as ConstructorParameters<typeof SmartSerialPty>[2];
  const logger = { log: vi.fn(), close: vi.fn() } as unknown as ConstructorParameters<typeof SmartSerialPty>[3];
  return new SmartSerialPty(transport, profile, callbacks, logger, undefined, undefined, initial);
}

describe("SmartSerialPty multi-observer + setInputBlocked", () => {
  it("addOutputObserver + dispose both register an observer", () => {
    const o1 = makeObserver();
    const o2 = makeObserver();
    const pty = buildPty(o1);
    pty.addOutputObserver(o2);
    pty.dispose();
    expect(o1.disposed).toBe(true);
    expect(o2.disposed).toBe(true);
  });

  it("addOutputObserver's disposable removes the observer", () => {
    const pty = buildPty();
    const o = makeObserver();
    const sub = pty.addOutputObserver(o);
    sub.dispose();
    pty.dispose();
    expect(o.disposed).toBe(false);
  });

  it("setInputBlocked(true/false) toggles flag without throwing", () => {
    const pty = buildPty();
    expect(() => {
      pty.setInputBlocked(true);
      pty.handleInput("x");
      pty.setInputBlocked(false);
      pty.handleInput("y");
    }).not.toThrow();
  });

  it("first dropped keystroke while locked emits one notice to writeEmitter", () => {
    const pty = buildPty();
    const writes: string[] = [];
    pty.onDidWrite((t) => writes.push(t));
    pty.setInputBlocked(true);
    pty.handleInput("a");
    pty.handleInput("b");
    const locks = writes.filter((w) => w.includes("Terminal is locked"));
    expect(locks).toHaveLength(1);
  });
});
