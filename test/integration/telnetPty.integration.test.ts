import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  Disposable: class {
    public constructor(private readonly fn: () => void) {}
    public dispose(): void {
      this.fn();
    }
  },
  window: { showErrorMessage: vi.fn() }
}));

import { TelnetPty } from "../../src/services/telnet/telnetPty";
import {
  DO,
  DONT,
  IAC,
  OPT_BINARY,
  OPT_ECHO,
  OPT_NAWS,
  OPT_SGA,
  OPT_TERMINAL_TYPE,
  SB,
  SE,
  WILL,
  WONT
} from "../../src/services/telnet/telnetProtocol";
import type { ServerConfig } from "../../src/models/config";

const TTYPE_SEND = 1;
const TTYPE_IS = 0;

interface Fixture {
  port: number;
  server: net.Server;
  /** Bytes the client sent us, in arrival order. */
  received: number[];
  /** Resolves once the client has connected and we hold its socket. */
  connected: Promise<net.Socket>;
  send: (...bytes: number[]) => void;
  sendText: (text: string) => void;
  /** Wait until the client has sent at least `count` bytes. */
  waitForBytes: (count: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A REAL TCP listener that speaks the server half of a telnet negotiation, so
 * the pty is exercised end to end over a socket rather than against a double.
 */
async function startTelnetServer(): Promise<Fixture> {
  const received: number[] = [];
  let clientSocket: net.Socket | undefined;
  let resolveConnected: (socket: net.Socket) => void = () => {};
  const connected = new Promise<net.Socket>((resolve) => {
    resolveConnected = resolve;
  });

  const server = net.createServer((socket) => {
    clientSocket = socket;
    socket.on("data", (chunk) => received.push(...chunk));
    socket.on("error", () => {
      /* the pty tears the connection down in teardown; nothing to report */
    });
    resolveConnected(socket);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a port");
  }

  return {
    port: address.port,
    server,
    received,
    connected,
    send: (...bytes: number[]) => clientSocket?.write(Buffer.from(bytes)),
    sendText: (value: string) => clientSocket?.write(Buffer.from(value, "utf8")),
    waitForBytes: async (count: number) => {
      const deadline = Date.now() + 5_000;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} bytes; got ${received.length}: ${received.join(",")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close: async () => {
      clientSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function serverConfig(port: number): ServerConfig {
  return {
    id: "srv-telnet",
    name: "console-server",
    host: "127.0.0.1",
    port,
    username: "",
    authType: "password",
    isHidden: false
  };
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TelnetPty over a real TCP connection", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("completes a full negotiation exchange and passes data both ways", async () => {
    const fixture = await startTelnetServer();
    const rendered: string[] = [];
    const observed: string[] = [];
    const onSessionOpened = vi.fn();

    const pty = new TelnetPty(
      serverConfig(fixture.port),
      { onSessionOpened, onSessionClosed: vi.fn() },
      { log: vi.fn(), close: vi.fn() } as never,
      { terminalType: "xterm-256color" }
    );
    cleanups.push(() => pty.dispose());
    cleanups.push(() => fixture.close());

    pty.onDidWrite((chunk) => rendered.push(chunk));
    pty.addOutputObserver({
      onOutput: (text) => observed.push(text),
      pauseIntervalMacros: () => {},
      dispose: () => {}
    });

    pty.open({ columns: 132, rows: 43 });
    await fixture.connected;
    await settle();

    expect(onSessionOpened).toHaveBeenCalledTimes(1);
    expect(rendered.join("")).toContain(`[Nexus Telnet] Connected 127.0.0.1:${fixture.port}`);

    // The server opens with the negotiation a Cisco-style console emits.
    fixture.send(IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_TERMINAL_TYPE, IAC, DO, OPT_NAWS);
    await fixture.waitForBytes(21);

    expect(fixture.received).toEqual([
      IAC, DO, OPT_ECHO,
      IAC, DO, OPT_SGA,
      IAC, WILL, OPT_TERMINAL_TYPE,
      IAC, WILL, OPT_NAWS,
      IAC, SB, OPT_NAWS, 0x00, 132, 0x00, 43, IAC, SE
    ]);

    // TERMINAL-TYPE subnegotiation.
    fixture.received.length = 0;
    fixture.send(IAC, SB, OPT_TERMINAL_TYPE, TTYPE_SEND, IAC, SE);
    await fixture.waitForBytes(4 + "xterm-256color".length + 2);
    expect(fixture.received).toEqual([
      IAC, SB, OPT_TERMINAL_TYPE, TTYPE_IS,
      ...Buffer.from("xterm-256color", "ascii"),
      IAC, SE
    ]);

    // An unimplemented option is refused, once.
    fixture.received.length = 0;
    fixture.send(IAC, WILL, OPT_BINARY, IAC, WILL, OPT_BINARY);
    await fixture.waitForBytes(3);
    await settle();
    expect(fixture.received).toEqual([IAC, DONT, OPT_BINARY]);

    // Device output, with a negotiation embedded mid-prompt and a CR NUL.
    fixture.received.length = 0;
    fixture.sendText("Router");
    fixture.send(IAC, DO, OPT_BINARY);
    fixture.sendText("> ");
    fixture.send(0x0d, 0x00);
    await settle();

    expect(observed.join("")).toBe("Router> \r");
    expect(rendered.join("")).toContain("Router> ");
    expect(fixture.received).toEqual([IAC, WONT, OPT_BINARY]);

    // Keystrokes reach the wire with NVT newline translation.
    fixture.received.length = 0;
    pty.handleInput("show version\r");
    await fixture.waitForBytes("show version\r\n".length);
    expect(Buffer.from(fixture.received).toString("utf8")).toBe("show version\r\n");

    // A resize re-sends NAWS now that the option is agreed.
    fixture.received.length = 0;
    pty.setDimensions({ columns: 80, rows: 24 });
    await fixture.waitForBytes(9);
    expect(fixture.received).toEqual([IAC, SB, OPT_NAWS, 0x00, 80, 0x00, 24, IAC, SE]);
  });

  it("reports a remote close as a disconnect and unregisters the session", async () => {
    const fixture = await startTelnetServer();
    const rendered: string[] = [];
    const onDisconnected = vi.fn();

    const pty = new TelnetPty(
      serverConfig(fixture.port),
      { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onDisconnected },
      { log: vi.fn(), close: vi.fn() } as never
    );
    cleanups.push(() => pty.dispose());
    cleanups.push(() => fixture.close());

    pty.onDidWrite((chunk) => rendered.push(chunk));
    pty.open({ columns: 80, rows: 24 });
    const socket = await fixture.connected;
    await settle();

    socket.end();
    await settle();

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(rendered.join("")).toContain("[Nexus Telnet] Remote host closed the connection.");
    expect(rendered.join("")).toContain("Press any key to close");
  });

  it("reports a refused connection in-terminal without registering a session", async () => {
    // Bind then immediately release a port so the address is almost certainly free.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to allocate a port");
    }
    const deadPort = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const rendered: string[] = [];
    const onSessionOpened = vi.fn();
    const onConnectFailed = vi.fn();
    const pty = new TelnetPty(
      serverConfig(deadPort),
      { onSessionOpened, onSessionClosed: vi.fn(), onConnectFailed },
      { log: vi.fn(), close: vi.fn() } as never
    );
    cleanups.push(() => pty.dispose());

    pty.onDidWrite((chunk) => rendered.push(chunk));
    pty.open({ columns: 80, rows: 24 });
    await settle(300);

    expect(onSessionOpened).not.toHaveBeenCalled();
    expect(onConnectFailed).toHaveBeenCalledTimes(1);
    expect(rendered.join("")).toContain("[Nexus Telnet] Connection failed:");
  });
});
