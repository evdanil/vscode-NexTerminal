import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/models/config";

// Minimal fake for ssh2's `Client`: a bare event emitter with the handful of
// methods Ssh2Connector.connect() calls (`connect`, `end`). Real ssh2 would
// require a live TCP handshake, so we swap the module for this test file.
const { mockClients } = vi.hoisted(() => ({ mockClients: [] as any[] }));

vi.mock("ssh2", () => {
  class MockClient {
    private handlers: Record<string, Array<(...args: any[]) => void>> = {};
    public connect = vi.fn();
    public end = vi.fn();
    public on(event: string, cb: (...args: any[]) => void): this {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    public emit(event: string, ...args: any[]): void {
      for (const cb of this.handlers[event] ?? []) {
        cb(...args);
      }
    }
    constructor() {
      mockClients.push(this);
    }
  }
  return { Client: MockClient };
});

import { buildConnectConfig, LEGACY_ALGORITHMS, Ssh2Connector } from "../../src/services/ssh/ssh2Connector";

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "Test Server",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

describe("buildConnectConfig", () => {
  it("returns base config without algorithms when legacyAlgorithms is not set", async () => {
    const config = await buildConnectConfig(makeServer(), "password123");
    expect(config.host).toBe("example.com");
    expect(config.port).toBe(22);
    expect(config.username).toBe("dev");
    expect(config.password).toBe("password123");
    expect((config as any).algorithms).toBeUndefined();
  });

  it("returns base config without algorithms when legacyAlgorithms is false", async () => {
    const config = await buildConnectConfig(makeServer({ legacyAlgorithms: false }), "pw");
    expect((config as any).algorithms).toBeUndefined();
  });

  it("includes LEGACY_ALGORITHMS when legacyAlgorithms is true", async () => {
    const config = await buildConnectConfig(makeServer({ legacyAlgorithms: true }), "pw");
    expect((config as any).algorithms).toBe(LEGACY_ALGORITHMS);
  });

  it("applies custom connection options", async () => {
    const config = await buildConnectConfig(
      makeServer(),
      "password123",
      undefined,
      undefined,
      {
        readyTimeoutMs: 12_000,
        keepaliveIntervalMs: 0,
        keepaliveCountMax: 7
      }
    );

    expect(config.readyTimeout).toBe(12_000);
    expect(config.keepaliveInterval).toBe(0);
    expect(config.keepaliveCountMax).toBe(7);
  });

  it("clamps connection options to safe runtime bounds", async () => {
    const config = await buildConnectConfig(
      makeServer(),
      "password123",
      undefined,
      undefined,
      {
        readyTimeoutMs: 1,
        keepaliveIntervalMs: -5,
        keepaliveCountMax: 999
      }
    );

    expect(config.readyTimeout).toBe(5_000);
    expect(config.keepaliveInterval).toBe(0);
    expect(config.keepaliveCountMax).toBe(30);
  });

  it("LEGACY_ALGORITHMS contains expected algorithm families", () => {
    expect(LEGACY_ALGORITHMS.kex.append).toContain("diffie-hellman-group1-sha1");
    expect(LEGACY_ALGORITHMS.cipher.append).toContain("3des-cbc");
    expect(LEGACY_ALGORITHMS.serverHostKey.append).toContain("ssh-dss");
    expect(LEGACY_ALGORITHMS.hmac.append).toContain("hmac-md5");
  });

  it("LEGACY_ALGORITHMS excludes broken and unsupported ciphers", () => {
    const ciphers = LEGACY_ALGORITHMS.cipher.append as string[];
    // RC4 - cryptographically broken
    expect(ciphers).not.toContain("arcfour");
    expect(ciphers).not.toContain("arcfour128");
    expect(ciphers).not.toContain("arcfour256");
    // Dropped by OpenSSL 3.x - cause silent handshake timeouts
    expect(ciphers).not.toContain("cast128-cbc");
    expect(ciphers).not.toContain("blowfish-cbc");
  });
});

// setImmediate runs after the microtask queue drains, so this reliably waits
// past buildConnectConfig()'s internal await before `new Client()` runs.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Ssh2Connector.connect banner handling", () => {
  beforeEach(() => {
    mockClients.length = 0;
  });

  it("routes the banner to onAuthMessage immediately and does not buffer it when a callback is provided", async () => {
    const connector = new Ssh2Connector();
    const onAuthMessage = vi.fn();

    const connectPromise = connector.connect(makeServer(), { password: "pw", onAuthMessage });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    expect(client).toBeDefined();
    client.emit("banner", "Authorized use only");
    client.emit("ready");

    const connection = await connectPromise;

    expect(onAuthMessage).toHaveBeenCalledWith("Authorized use only");
    // Must NOT also be buffered — sshPty's post-ready getBanner() flush would
    // otherwise print the same banner a second time.
    expect(connection.getBanner()).toBeUndefined();
  });

  it("still buffers the banner for getBanner() when no onAuthMessage callback is provided (legacy behavior unchanged)", async () => {
    const connector = new Ssh2Connector();

    const connectPromise = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    expect(client).toBeDefined();
    client.emit("banner", "Authorized use only");
    client.emit("ready");

    const connection = await connectPromise;

    expect(connection.getBanner()).toBe("Authorized use only");
  });

  it("supports multiple onAuthMessage calls (e.g. banner then keyboard-interactive context) without buffering any of them", async () => {
    const connector = new Ssh2Connector();
    const onAuthMessage = vi.fn();

    const connectPromise = connector.connect(makeServer(), { password: "pw", onAuthMessage });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    client.emit("banner", "Authorized use only");
    client.emit("banner", "Second banner line");
    client.emit("ready");

    const connection = await connectPromise;

    expect(onAuthMessage).toHaveBeenNthCalledWith(1, "Authorized use only");
    expect(onAuthMessage).toHaveBeenNthCalledWith(2, "Second banner line");
    expect(connection.getBanner()).toBeUndefined();
  });

  it("does not relay a blank banner to onAuthMessage", async () => {
    const connector = new Ssh2Connector();
    const onAuthMessage = vi.fn();

    const connectPromise = connector.connect(makeServer(), { password: "pw", onAuthMessage });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    client.emit("banner", "   ");
    client.emit("ready");

    await connectPromise;

    expect(onAuthMessage).not.toHaveBeenCalled();
  });

  it("T11 — post-ready client errors reach the diagnostics sink instead of being discarded", async () => {
    const sink = vi.fn();
    const connector = new Ssh2Connector(undefined, undefined, sink);

    const connectPromise = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connectPromise;

    // Post-ready this used to return silently, which is why "all my terminals
    // disconnected" was undiagnosable: a keepalive timeout destroys the socket
    // 30s after the last response and left no trace anywhere.
    client.emit("error", Object.assign(new Error("Keepalive timeout"), { level: "client-timeout" }));

    const logged = sink.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain("Keepalive timeout");
    expect(logged).toContain("client-timeout");
    expect(logged).toContain("Test Server (example.com)");
    expect(connection).toBeDefined();
  });

  it("T11 — a pre-ready error still rejects the connect promise and is NOT logged instead", async () => {
    const sink = vi.fn();
    const connector = new Ssh2Connector(undefined, undefined, sink);

    const connectPromise = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    client.emit("error", new Error("All configured authentication methods failed"));

    await expect(connectPromise).rejects.toThrow("All configured authentication methods failed");
    // Logging must not replace rejection: the connect flow (auth retry,
    // host-key prompts) reads pre-ready errors.
    expect(sink).not.toHaveBeenCalled();
  });

  it("T11 — a connection close is logged once, even though ssh2 emits both 'close' and 'end'", async () => {
    const sink = vi.fn();
    const connector = new Ssh2Connector(undefined, undefined, sink);

    const connectPromise = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    client.emit("ready");
    await connectPromise;

    client.emit("close");
    client.emit("end");

    const closeLines = sink.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("connection closed"));
    expect(closeLines).toHaveLength(1);
    expect(closeLines[0]).toContain("Test Server (example.com)");
  });

  it("swallows an onAuthMessage callback that throws instead of aborting the handshake", async () => {
    const connector = new Ssh2Connector();
    const onAuthMessage = vi.fn(() => {
      throw new Error("boom");
    });

    const connectPromise = connector.connect(makeServer(), { password: "pw", onAuthMessage });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    // Must not throw / reject the connect promise even though the sink throws.
    expect(() => client.emit("banner", "Authorized use only")).not.toThrow();
    client.emit("ready");

    const connection = await connectPromise;

    expect(onAuthMessage).toHaveBeenCalledWith("Authorized use only");
    expect(connection).toBeDefined();
  });
});
