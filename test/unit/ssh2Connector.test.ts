import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
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

import { isAuthNotJudged, SshAgentUnavailableError } from "../../src/services/ssh/authErrors";
import type { SshAgentChoice } from "../../src/services/ssh/sshAgentLocator";
import { classifySshConnectionError } from "../../src/services/ssh/connectionDiagnostics";
import { SshInteractionRequiredError, type ContextAwareSshFactory } from "../../src/services/ssh/contracts";
import { SshConnectionPool } from "../../src/services/ssh/sshConnectionPool";
import { buildConnectConfig, LEGACY_ALGORITHMS, Ssh2Connector } from "../../src/services/ssh/ssh2Connector";

function appendedAlgorithms(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || !("append" in value) || !Array.isArray(value.append)) {
    throw new Error("Expected appended SSH algorithms");
  }
  return value.append;
}

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

  it("puts the resolved agent in an agent login's config and never reads SSH_AUTH_SOCK itself (⊘ the old pass-through, which offered Windows no agent at all)", async () => {
    const saved = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/from-environment";
    try {
      const agentServer = makeServer({ authType: "agent" });
      const resolved = await buildConnectConfig(agentServer, undefined, undefined, undefined, undefined, "\\\\.\\pipe\\openssh-ssh-agent");
      expect(resolved.agent).toBe("\\\\.\\pipe\\openssh-ssh-agent");
      expect((await buildConnectConfig(agentServer)).agent).toBeUndefined();
      // A password login carries no agent even when one is passed.
      expect((await buildConnectConfig(makeServer(), "pw", undefined, undefined, undefined, "/tmp/x")).agent).toBeUndefined();
    } finally {
      if (saved === undefined) {
        delete process.env.SSH_AUTH_SOCK;
      } else {
        process.env.SSH_AUTH_SOCK = saved;
      }
    }
  });

  it("LEGACY_ALGORITHMS contains expected algorithm families", () => {
    expect(appendedAlgorithms(LEGACY_ALGORITHMS.kex)).toContain("diffie-hellman-group1-sha1");
    expect(appendedAlgorithms(LEGACY_ALGORITHMS.cipher)).toContain("3des-cbc");
    expect(appendedAlgorithms(LEGACY_ALGORITHMS.serverHostKey)).toContain("ssh-dss");
    expect(appendedAlgorithms(LEGACY_ALGORITHMS.hmac)).toContain("hmac-md5");
  });

  it("LEGACY_ALGORITHMS excludes broken and unsupported ciphers", () => {
    const ciphers = appendedAlgorithms(LEGACY_ALGORITHMS.cipher);
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

  it("preserves a typed noninteractive host-key refusal through ssh2 error wrapping", async () => {
    const verifier = {
      verify: vi.fn(async () => { throw new SshInteractionRequiredError("host key requires a decision"); })
    };
    const connector = new Ssh2Connector(verifier);
    const connecting = connector.connect(makeServer(), { interaction: "noninteractive" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    const config = client.connect.mock.calls[0][0];
    const verify = vi.fn();

    config.hostVerifier(Buffer.from("host-key"), verify);
    await flushMicrotasks();
    client.emit("error", new Error("Host denied (verification failed)"));

    await expect(connecting).rejects.toMatchObject({ code: "interaction-required" });
    expect(verifier.verify).toHaveBeenCalledWith(makeServer(), Buffer.from("host-key"), { interaction: "noninteractive" });
  });

  it("returns separate stdout and stderr and waits for exit plus close", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    const stream = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(stream, { stderr });
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => callback(undefined, stream));

    const channel = await connection.execCommand?.("containerlab inspect");
    expect(channel).toBeDefined();
    expect(channel?.stdout).toBe(stream);
    expect(channel?.stderr).toBe(stderr);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    channel?.stdout.on("data", (chunk: Buffer | string) => stdoutChunks.push(String(chunk)));
    channel?.stderr.on("data", (chunk: Buffer | string) => stderrChunks.push(String(chunk)));
    stream.write("stdout data");
    stderr.write("stderr data");

    let completed = false;
    void channel?.completion.then(() => { completed = true; }, () => { completed = true; });
    stream.emit("exit", 17, undefined);
    await flushMicrotasks();
    expect(completed).toBe(false);
    stream.end();
    stderr.end();

    await expect(channel?.completion).resolves.toEqual({ code: 17 });
    expect(stdoutChunks).toEqual(["stdout data"]);
    expect(stderrChunks).toEqual(["stderr data"]);
  });

  it("observes an exit emitted synchronously inside the exec callback", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    const stream = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(stream, { stderr });
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => {
      callback(undefined, stream);
      stream.emit("exit", 0, undefined);
    });

    const channel = await connection.execCommand?.("containerlab inspect");
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    channel?.stdout.on("data", (chunk: Buffer | string) => stdoutChunks.push(String(chunk)));
    channel?.stderr.on("data", (chunk: Buffer | string) => stderrChunks.push(String(chunk)));
    stream.end("stdout");
    stderr.end("stderr");
    await flushMicrotasks();
    stream.emit("close");

    await expect(channel?.completion).resolves.toEqual({ code: 0 });
    expect(stdoutChunks).toEqual(["stdout"]);
    expect(stderrChunks).toEqual(["stderr"]);
  });

  it("waits for delayed stdout drainage after exit and channel close", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    const stream = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(stream, { stderr });
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => callback(undefined, stream));

    const channel = await connection.execCommand?.("containerlab inspect");
    const stderrChunks: string[] = [];
    channel?.stderr.on("data", (chunk: Buffer | string) => stderrChunks.push(String(chunk)));
    stream.end("delayed stdout");
    stderr.end("stderr");
    stream.emit("exit", 0, undefined);
    stream.emit("close");
    await flushMicrotasks();

    let completed = false;
    void channel?.completion.then(() => { completed = true; }, () => { completed = true; });
    await flushMicrotasks();
    expect(completed).toBe(false);

    const stdoutChunks: string[] = [];
    channel?.stdout.on("data", (chunk: Buffer | string) => stdoutChunks.push(String(chunk)));
    await flushMicrotasks();

    await expect(channel?.completion).resolves.toEqual({ code: 0 });
    expect(stdoutChunks).toEqual(["delayed stdout"]);
    expect(stderrChunks).toEqual(["stderr"]);
  });

  it("waits for buffered stderr to drain after stdout and channel close", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    const stream = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(stream, { stderr });
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => callback(undefined, stream));

    const channel = await connection.execCommand?.("containerlab inspect");
    channel?.stdout.on("data", () => {});
    stream.end("stdout");
    stderr.end("buffered stderr");
    stream.emit("exit", 0, undefined);
    stream.emit("close");
    await flushMicrotasks();

    let completed = false;
    void channel?.completion.then(() => { completed = true; }, () => { completed = true; });
    await flushMicrotasks();
    expect(completed).toBe(false);

    const stderrChunks: string[] = [];
    channel?.stderr.on("data", (chunk: Buffer | string) => stderrChunks.push(String(chunk)));
    await flushMicrotasks();

    await expect(channel?.completion).resolves.toEqual({ code: 0 });
    expect(stderrChunks).toEqual(["buffered stderr"]);
  });

  it("rejects a stderr error before readable end", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    const stream = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(stream, { stderr });
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => callback(undefined, stream));

    const channel = await connection.execCommand?.("containerlab inspect");
    const error = new Error("stderr stream failed");
    stderr.emit("error", error);

    await expect(channel?.completion).rejects.toBe(error);
  });

  it("preserves cancellation while closing a command channel during drainage", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    const stream = new PassThrough();
    const stderr = new PassThrough();
    const teardownError = new Error("channel closed during abort");
    const close = vi.fn(() => {
      stream.emit("error", teardownError);
      stream.emit("close");
    });
    Object.assign(stream, { stderr, close });
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => callback(undefined, stream));
    const controller = new AbortController();
    const cancellation = new Error("discovery canceled during drainage");

    const channel = await connection.execCommand?.("containerlab inspect", controller.signal);
    stream.emit("exit", 0, undefined);
    stream.emit("close");
    controller.abort(cancellation);

    await expect(channel?.completion).rejects.toBe(cancellation);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects typed command completion when a channel closes without an exit result", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    const stream = new PassThrough();
    Object.assign(stream, { stderr: new PassThrough() });
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => callback(undefined, stream));

    const channel = await connection.execCommand?.("containerlab inspect");
    stream.emit("close");

    await expect(channel?.completion).rejects.toThrow(/without an exit result/i);
  });

  it("closes a command channel that arrives after cancellation", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("ready");
    const connection = await connecting;
    let completeExec: ((error: Error | undefined, channel: PassThrough) => void) | undefined;
    client.exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: PassThrough) => void) => { completeExec = callback; });
    const controller = new AbortController();
    const reason = new Error("discovery canceled");
    const opening = connection.execCommand?.("containerlab inspect", controller.signal);

    controller.abort(reason);
    await expect(opening).rejects.toBe(reason);
    const lateStream = new PassThrough();
    Object.assign(lateStream, { stderr: new PassThrough() });
    completeExec?.(undefined, lateStream);
    await flushMicrotasks();

    expect(lateStream.destroyed).toBe(true);
  });

  it("aborts a keyboard-interactive request when the handshake times out", async () => {
    const connector = new Ssh2Connector();
    let signal: AbortSignal | undefined;
    const handler = vi.fn(async (_name, _instructions, _prompts, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      return new Promise<string[]>(() => {});
    });
    const connecting = connector.connect(makeServer(), { password: "pw", onKeyboardInteractive: handler });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    client.emit("keyboard-interactive", "Verification", "", "", [{ prompt: "Code:", echo: false }], vi.fn());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);

    client.emit("error", new Error("Timed out while waiting for handshake"));
    await expect(connecting).rejects.toThrow("Timed out while waiting for handshake");
    expect(signal?.aborted).toBe(true);
  });

  it("rejects a close before ready as an unjudged login, not a credential verdict", async () => {
    const connector = new Ssh2Connector();
    const connecting = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    mockClients.at(-1).emit("close");
    const error = await connecting.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isAuthNotJudged(error)).toBe(true);
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

  it("buffers a banner when a pooled message router has no terminal sink yet", async () => {
    const connector = new Ssh2Connector();
    const onAuthMessage = vi.fn(() => false);
    const connectPromise = connector.connect(makeServer(), { password: "pw", onAuthMessage });
    await flushMicrotasks();

    const client = mockClients.at(-1);
    client.emit("banner", "Authorized use only");
    client.emit("ready");

    const connection = await connectPromise;
    expect(onAuthMessage).toHaveBeenCalledWith("Authorized use only");
    expect(connection.getBanner()).toBe("Authorized use only");
  });

  it("buffers a pooled banner without a live sink and does not replay one already delivered", async () => {
    const connector = new Ssh2Connector();
    const factory: ContextAwareSshFactory = {
      connect: vi.fn(async () => { throw new Error("unexpected direct connect"); }),
      connectWithContext: vi.fn((server, context) => connector.connect(server, {
        password: "pw",
        ...(context?.onAuthMessage && { onAuthMessage: context.onAuthMessage })
      }))
    };
    const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 5000 });

    const noSinkOpening = pool.connect(makeServer({ id: "no-sink" }));
    await flushMicrotasks();
    const noSinkClient = mockClients.at(-1);
    noSinkClient.emit("banner", "Buffered for a later terminal");
    noSinkClient.emit("ready");
    const noSinkLease = await noSinkOpening;
    expect(noSinkLease.getBanner()).toBe("Buffered for a later terminal");

    const liveSink = vi.fn();
    const liveOpening = pool.connectWithContext(makeServer({ id: "live-sink" }), { onAuthMessage: liveSink });
    await flushMicrotasks();
    const liveClient = mockClients.at(-1);
    liveClient.emit("banner", "Delivered to a terminal");
    liveClient.emit("ready");
    const liveLease = await liveOpening;
    expect(liveSink).toHaveBeenCalledWith("Delivered to a terminal");
    expect(liveLease.getBanner()).toBeUndefined();

    pool.dispose();
  });

  it("notifies a close listener registered after the SSH connection has closed", async () => {
    const connector = new Ssh2Connector();

    const connectPromise = connector.connect(makeServer(), { password: "pw" });
    await flushMicrotasks();
    const client = mockClients.at(-1);
    expect(client).toBeDefined();
    client.emit("ready");
    const connection = await connectPromise;

    client.emit("close");
    const onClose = vi.fn();
    connection.onClose(onClose);

    expect(onClose).toHaveBeenCalledTimes(1);
    client.emit("end");
    expect(onClose).toHaveBeenCalledTimes(1);
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

describe("Ssh2Connector — SSH agent logins", () => {
  const PAGEANT: SshAgentChoice = {
    agent: "\\\\.\\pipe\\pageant.alice.abc123",
    source: "pageant",
    note: "auto; SSH_AUTH_SOCK unset"
  };
  const EXHAUSTED = (): Error =>
    Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });

  const agentServer = (): ServerConfig => makeServer({ authType: "agent" });

  // The agent lookup and key check are awaited before `new Client()`, so give
  // them a few turns of the event loop rather than one.
  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await flushMicrotasks();
    }
  }

  beforeEach(() => {
    mockClients.length = 0;
  });

  it("dials with the agent the resolver chose, and logs which agent answered and why", async () => {
    const sink = vi.fn();
    const countKeys = vi.fn(async () => 2);
    const connector = new Ssh2Connector(undefined, undefined, sink, { resolve: () => PAGEANT, countKeys });

    const connecting = connector.connect(agentServer(), {});
    await settle();
    const client = mockClients.at(-1);
    expect(client.connect.mock.calls[0][0].agent).toBe(PAGEANT.agent);
    expect(countKeys).toHaveBeenCalledWith(PAGEANT.agent, undefined);
    const logged = sink.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain("[agent] Test Server (example.com): Pageant at \\\\.\\pipe\\pageant.alice.abc123");
    expect(logged).toContain("auto; SSH_AUTH_SOCK unset");
    expect(logged).toContain("2 keys");

    client.emit("ready");
    await expect(connecting).resolves.toBeDefined();
  });

  it("refuses before dialling when no agent can be chosen (⊘ a doomed dial that ends in ssh2's misleading auth failure)", async () => {
    const refusal = new SshAgentUnavailableError("Pageant is not running, or it is older than 0.75 and has no named pipe.");
    const countKeys = vi.fn(async () => 1);
    const connector = new Ssh2Connector(undefined, undefined, undefined, {
      resolve: () => {
        throw refusal;
      },
      countKeys
    });

    await expect(connector.connect(agentServer(), {})).rejects.toBe(refusal);
    expect(mockClients).toHaveLength(0);
    expect(countKeys).not.toHaveBeenCalled();
  });

  it("refuses before dialling when the chosen agent does not answer the key check, naming where it looked", async () => {
    const connector = new Ssh2Connector(undefined, undefined, undefined, {
      resolve: () => PAGEANT,
      countKeys: async () => {
        throw new Error("it did not answer within 5 seconds");
      }
    });

    const error = await connector.connect(agentServer(), {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SshAgentUnavailableError);
    expect((error as Error).message).toBe(
      "Could not use the SSH agent at \\\\.\\pipe\\pageant.alice.abc123 (Pageant): it did not answer within 5 seconds. Restart Pageant and connect again."
    );
    expect(mockClients).toHaveLength(0);
  });

  it("an agent holding no keys does not block the server's other login methods (⊘ refusing here locks out keyboard-interactive logins that worked before)", async () => {
    const connector = new Ssh2Connector(undefined, undefined, undefined, { resolve: () => PAGEANT, countKeys: async () => 0 });

    const connecting = connector.connect(agentServer(), {});
    await settle();
    const client = mockClients.at(-1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect.mock.calls[0][0].agent).toBeUndefined();
    client.emit("ready");
    await expect(connecting).resolves.toBeDefined();
  });

  it("...and explains itself if the server refuses everything else (⊘ leaving ssh2's 'All configured authentication methods failed')", async () => {
    const connector = new Ssh2Connector(undefined, undefined, undefined, { resolve: () => PAGEANT, countKeys: async () => 0 });

    const connecting = connector.connect(agentServer(), {});
    await settle();
    const exhausted = EXHAUSTED();
    mockClients.at(-1).emit("error", exhausted);

    const error = await connecting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SshAgentUnavailableError);
    expect((error as Error).message).toBe(
      "The SSH agent at \\\\.\\pipe\\pageant.alice.abc123 (Pageant) holds no keys. Add your key in Pageant (Add Key) or with ssh-add, or unlock the agent (ssh-add -X), then connect again."
    );
    expect((error as Error).cause).toBe(exhausted);
    expect(isAuthNotJudged(error)).toBe(true);
  });

  it("with no agent found in auto mode, dials without one exactly as before — and replaces ONLY the exhausted-methods failure", async () => {
    const nothingFound = new SshAgentUnavailableError("No SSH agent found. Start Pageant (PuTTY 0.75 or newer)…", {
      proceedWithoutAgent: true
    });
    const countKeys = vi.fn(async () => 1);
    const connector = new Ssh2Connector(undefined, undefined, undefined, {
      resolve: () => {
        throw nothingFound;
      },
      countKeys
    });

    // A transport failure is not the agent's doing: it passes through untouched.
    const refused = connector.connect(agentServer(), {});
    await settle();
    expect(mockClients.at(-1).connect.mock.calls[0][0].agent).toBeUndefined();
    const transport = new Error("connect ECONNREFUSED 203.0.113.10:22");
    mockClients.at(-1).emit("error", transport);
    await expect(refused).rejects.toBe(transport);

    const exhaustedLogin = connector.connect(agentServer(), {});
    await settle();
    mockClients.at(-1).emit("error", EXHAUSTED());
    await expect(exhaustedLogin).rejects.toThrow(/^No SSH agent found\./);
    expect(countKeys).not.toHaveBeenCalled();
  });

  /**
   * The soft path's replacement is only true while the server has judged
   * nothing the user typed. Once a keyboard-interactive answer went in — a
   * device's "Password:" prompt — "All configured authentication methods
   * failed" means that answer was refused: the same `auth` failure it was
   * before agent discovery, with the missing agent as context, not the cause.
   */
  describe("when the server asked keyboard-interactive questions", () => {
    async function keyboardInteractiveLogin(answers: string[], resolve: () => SshAgentChoice, countKeys = async () => 0) {
      const connector = new Ssh2Connector(undefined, undefined, undefined, { resolve, countKeys });
      const connecting = connector.connect(agentServer(), { onKeyboardInteractive: vi.fn(async () => answers) });
      await settle();
      const client = mockClients.at(-1);
      const finish = vi.fn();
      client.emit("keyboard-interactive", "", "", "", answers.map(() => ({ prompt: "Password: ", echo: false })), finish);
      await settle();
      const exhausted = EXHAUSTED();
      client.emit("error", exhausted);
      return { error: await connecting.catch((caught: unknown) => caught), exhausted, finish };
    }

    it("keeps a refused typed answer an auth failure (⊘ blaming the missing agent for a mistyped password)", async () => {
      const { error, exhausted, finish } = await keyboardInteractiveLogin(["typo"], () => PAGEANT);
      expect(finish).toHaveBeenCalledWith(["typo"]);
      expect(error).not.toBeInstanceOf(SshAgentUnavailableError);
      expect((error as Error).message).toBe(
        "All configured authentication methods failed (no SSH agent key was offered: the agent holds no keys)"
      );
      expect((error as Error).cause).toBe(exhausted);
      expect((error as { level?: unknown }).level).toBe("client-authentication");
      expect(classifySshConnectionError(error)).toMatchObject({ stage: "auth", title: "Authentication failed" });
    });

    it("says no agent was found, as context, when the resolver found none", async () => {
      const { error } = await keyboardInteractiveLogin(["typo"], () => {
        throw new SshAgentUnavailableError("No SSH agent found.", { proceedWithoutAgent: true });
      });
      expect((error as Error).message).toBe(
        "All configured authentication methods failed (no SSH agent key was offered: no agent was found)"
      );
      expect(classifySshConnectionError(error).stage).toBe("auth");
    });

    it("still explains the agent when nothing was typed — an empty answer is no answer", async () => {
      const { error } = await keyboardInteractiveLogin([""], () => PAGEANT);
      expect(error).toBeInstanceOf(SshAgentUnavailableError);
      expect(classifySshConnectionError(error).stage).toBe("agent");
    });
  });

  it("treats nothing listening at a GUESSED pipe as no agent found (the pipe list could not be read), not a broken agent", async () => {
    const guess: SshAgentChoice = {
      agent: "\\\\.\\pipe\\openssh-ssh-agent",
      source: "openssh",
      note: "auto; the named-pipe list could not be read (ENOTDIR)",
      ifUnreachable: new SshAgentUnavailableError("No SSH agent found. (guess)", { proceedWithoutAgent: true })
    };
    const connector = new Ssh2Connector(undefined, undefined, undefined, {
      resolve: () => guess,
      countKeys: async () => {
        throw new Error("Failed to connect to agent");
      }
    });

    const connecting = connector.connect(agentServer(), {});
    await settle();
    // ⊘ a hard refusal here removes a keyboard-interactive login that works today.
    expect(mockClients.at(-1).connect.mock.calls[0][0].agent).toBeUndefined();
    mockClients.at(-1).emit("error", EXHAUSTED());
    await expect(connecting).rejects.toThrow("No SSH agent found. (guess)");
  });

  it("still refuses a guessed pipe where something answers but hangs, and any agent the user chose that cannot be reached", async () => {
    const guess: SshAgentChoice = {
      agent: "\\\\.\\pipe\\openssh-ssh-agent",
      source: "openssh",
      note: "auto; guess",
      ifUnreachable: new SshAgentUnavailableError("No SSH agent found.", { proceedWithoutAgent: true })
    };
    const hung = new Ssh2Connector(undefined, undefined, undefined, {
      resolve: () => guess,
      countKeys: async () => {
        throw new Error("it did not answer within 5 seconds");
      }
    });
    await expect(hung.connect(agentServer(), {})).rejects.toThrow(/^Could not use the SSH agent at .*did not answer/);

    const chosen = new Ssh2Connector(undefined, undefined, undefined, {
      resolve: () => ({ ...guess, ifUnreachable: undefined, note: "nexus.ssh.agent is openssh" }),
      countKeys: async () => {
        throw new Error("Failed to connect to agent");
      }
    });
    await expect(chosen.connect(agentServer(), {})).rejects.toThrow(/^Could not use the SSH agent at .*Failed to connect to agent/);
    expect(mockClients).toHaveLength(0);
  });

  it("does not look up or probe an agent for a connect that was already cancelled (⊘ a cancelled connect waiting out the 5-second key check)", async () => {
    const resolve = vi.fn(() => PAGEANT);
    const countKeys = vi.fn(async () => 1);
    const connector = new Ssh2Connector(undefined, undefined, undefined, { resolve, countKeys });
    const controller = new AbortController();
    const reason = new Error("terminal closed");
    controller.abort(reason);

    await expect(connector.connect(agentServer(), { signal: controller.signal })).rejects.toBe(reason);
    expect(resolve).not.toHaveBeenCalled();
    expect(countKeys).not.toHaveBeenCalled();
    expect(mockClients).toHaveLength(0);
  });

  it("hands the connect's cancellation to the key check, and a cancel during it stays a cancel (not an agent failure)", async () => {
    const controller = new AbortController();
    const reason = new Error("terminal closed");
    const countKeys = vi.fn((_path: string, signal?: AbortSignal) => {
      controller.abort(reason);
      return Promise.reject(signal?.reason);
    });
    const connector = new Ssh2Connector(undefined, undefined, undefined, { resolve: () => PAGEANT, countKeys });

    await expect(connector.connect(agentServer(), { signal: controller.signal })).rejects.toBe(reason);
    expect(countKeys).toHaveBeenCalledWith(PAGEANT.agent, controller.signal);
    expect(mockClients).toHaveLength(0);
  });

  it("never looks up an agent for a password or key login", async () => {
    const resolve = vi.fn(() => PAGEANT);
    const connector = new Ssh2Connector(undefined, undefined, undefined, { resolve, countKeys: async () => 1 });

    const connecting = connector.connect(makeServer(), { password: "pw" });
    await settle();
    const client = mockClients.at(-1);
    expect(client.connect.mock.calls[0][0].agent).toBeUndefined();
    client.emit("error", EXHAUSTED());
    // A password login's rejection stays ssh2's own: silentAuth reads it to
    // decide whether the saved password was wrong.
    await expect(connecting).rejects.toThrow("All configured authentication methods failed");
    expect(resolve).not.toHaveBeenCalled();
  });
});
