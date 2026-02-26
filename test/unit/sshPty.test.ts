import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/models/config";
import { SshPty } from "../../src/services/ssh/sshPty";

const { mockShowErrorMessage } = vi.hoisted(() => ({
  mockShowErrorMessage: vi.fn()
}));

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
  window: {
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args)
  }
}));

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "Server 1",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

describe("SshPty banner handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes pre-auth banner to terminal with CRLF normalization", async () => {
    const stream = new PassThrough();
    const connection = {
      openShell: vi.fn(async () => stream),
      getBanner: vi.fn(() => "Authorized users only\nDisconnect if not authorized"),
      onClose: vi.fn(() => () => {}),
      dispose: vi.fn()
    };
    const sshFactory = { connect: vi.fn(async () => connection) };
    const callbacks = {
      onSessionOpened: vi.fn(),
      onSessionClosed: vi.fn()
    };
    const logger = {
      log: vi.fn(),
      close: vi.fn()
    };
    const writes: string[] = [];
    const pty = new SshPty(makeServer(), sshFactory as any, callbacks, logger as any);
    pty.onDidWrite((text) => {
      writes.push(text);
    });

    pty.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.getBanner).toHaveBeenCalledTimes(1);
    expect(writes[0]).toBe("Authorized users only\r\nDisconnect if not authorized");
    expect(mockShowErrorMessage).not.toHaveBeenCalled();

    pty.dispose();
  });
});
