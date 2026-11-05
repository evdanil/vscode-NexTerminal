import { generateKeyPairSync } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenSSHAgent, Server, utils } from "ssh2";
import type { ServerConfig } from "../../src/models/config";
import { Ssh2Connector } from "../../src/services/ssh/ssh2Connector";
import type { AuthContext } from "ssh2";
import { SshInteractionRequiredError } from "../../src/services/ssh/contracts";

const pem = (): string => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const hostKey = pem();
const agentKey = pem();
const secondAgentKey = pem();
const profile: ServerConfig = { id: "test", name: "Test", host: "example.com", port: 22, username: "user", authType: "agent", isHidden: false };

function setup(onAuth: (ctx: AuthContext) => void, multipleKeys = false, readyTimeoutMs?: number) {
  const identity = utils.parseKey(agentKey);
  if (identity instanceof Error || Array.isArray(identity)) throw new Error("Invalid test key");
  const second = multipleKeys ? utils.parseKey(secondAgentKey) : undefined;
  if (second instanceof Error || Array.isArray(second)) throw new Error("Invalid test key");
  vi.spyOn(OpenSSHAgent.prototype, "getIdentities").mockImplementation((callback) => callback(null, second ? [identity, second] : [identity]));
  vi.spyOn(OpenSSHAgent.prototype, "sign").mockImplementation(((_key: unknown, data: Buffer, options: { hash?: string } | ((error: Error | null, signature: Buffer) => void), callback?: (error: Error | null, signature: Buffer) => void) => {
    const done = typeof options === "function" ? options : callback!;
    done(null, identity.sign(data, typeof options === "function" ? undefined : options.hash));
    return true;
  }) as OpenSSHAgent["sign"]);
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", onAuth);
  });
  const a = new PassThrough();
  const b = new PassThrough();
  const serverSock = Duplex.from({ readable: a, writable: b });
  const clientSock = Duplex.from({ readable: b, writable: a });
  server.injectSocket(serverSock as never);
  const connector = new Ssh2Connector(undefined, readyTimeoutMs ? { readyTimeoutMs } : undefined, undefined, {
    resolve: () => ({ agent: "/fake-agent", source: "custom", note: "test" }),
    countKeys: async () => 1
  });
  return { connector, clientSock, cleanup: () => { clientSock.destroy(); serverSock.destroy(); } };
}

afterEach(() => vi.restoreAllMocks());

describe("agent password fallback over SSH", () => {
  it("never requests a password when an agent key succeeds", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "publickey") ctx.accept();
      else ctx.reject(["publickey", "password"]);
    });
    const onPasswordFallback = vi.fn(async () => "secret");
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback });
      expect(methods).not.toContain("password");
      expect(onPasswordFallback).not.toHaveBeenCalled();
      connection.dispose();
    } finally { cleanup(); }
  });

  it("uses keyboard-interactive before offering a password", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "keyboard-interactive") ctx.accept();
      else ctx.reject(["publickey", "keyboard-interactive", "password"]);
    });
    const onPasswordFallback = vi.fn(async () => "secret");
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback });
      expect(methods).toEqual(["none", "publickey", "keyboard-interactive"]);
      expect(onPasswordFallback).not.toHaveBeenCalled();
      connection.dispose();
    } finally { cleanup(); }
  });

  it("tries a saved password first in noninteractive mode when both methods are offered", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "password" && ctx.password === "saved") ctx.accept();
      else ctx.reject(["publickey", "keyboard-interactive", "password"]);
    });
    const onPasswordFallback = vi.fn(async () => "saved");
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback, interaction: "noninteractive" });
      expect(methods).toEqual(["none", "publickey", "password"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      connection.dispose();
    } finally { cleanup(); }
  });

  it("still tries noninteractive keyboard-interactive when there is no saved password", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "keyboard-interactive") ctx.accept();
      else ctx.reject(["publickey", "keyboard-interactive", "password"]);
    });
    const onPasswordFallback = vi.fn(async () => undefined);
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback, interaction: "noninteractive" });
      expect(methods).toEqual(["none", "publickey", "keyboard-interactive"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      connection.dispose();
    } finally { cleanup(); }
  });

  it("reports interaction required when no saved password or other method succeeds", async () => {
    const { connector, clientSock, cleanup } = setup((ctx) => ctx.reject(["publickey", "keyboard-interactive", "password"]));
    const onPasswordFallback = vi.fn(async () => undefined);
    try {
      await expect(connector.connect(profile, { sock: clientSock, onPasswordFallback, interaction: "noninteractive" })).rejects.toBeInstanceOf(SshInteractionRequiredError);
    } finally { cleanup(); }
  });

  it("reports interaction required without attempting unadvertised keyboard-interactive", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      ctx.reject(["publickey", "password"]);
    });
    try {
      await expect(connector.connect(profile, {
        sock: clientSock,
        onPasswordFallback: async () => undefined,
        interaction: "noninteractive"
      })).rejects.toBeInstanceOf(SshInteractionRequiredError);
      expect(methods).toEqual(["none", "publickey"]);
    } finally { cleanup(); }
  });

  it("tries keyboard-interactive after a saved password is rejected without prompting", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "keyboard-interactive") ctx.accept();
      else ctx.reject(["publickey", "keyboard-interactive", "password"]);
    });
    const onPasswordFallback = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce(undefined);
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback, interaction: "noninteractive" });
      expect(methods).toEqual(["none", "publickey", "password", "keyboard-interactive"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      connection.dispose();
    } finally { cleanup(); }
  });

  it("asks after the agent key is rejected and sends the password on the same connection", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
        methods.push(ctx.method);
        if (ctx.method === "password" && ctx.password === "correct") ctx.accept();
        else ctx.reject(["publickey", "password"]);
    });
    const onPasswordFallback = vi.fn(async () => "correct");
    const onPasswordFallbackResult = vi.fn();
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback, onPasswordFallbackResult });
      expect(methods).toEqual(["none", "publickey", "password"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      expect(onPasswordFallbackResult.mock.calls).toEqual([[true]]);
      connection.dispose();
    } finally {
      cleanup();
    }
  });

  it("allows one fresh password after a saved password is rejected", async () => {
    const passwords: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      if (ctx.method === "password") {
        passwords.push(ctx.password);
        if (ctx.password === "correct") { ctx.accept(); return; }
      }
      ctx.reject(["publickey", "password"]);
    });
    const onPasswordFallback = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("correct");
    const onPasswordFallbackResult = vi.fn();
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback, onPasswordFallbackResult });
      expect(passwords).toEqual(["old", "correct"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(2);
      expect(onPasswordFallbackResult.mock.calls).toEqual([[false], [true]]);
      connection.dispose();
    } finally { cleanup(); }
  });

  it("does not send a password when the server does not offer it", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      ctx.reject(["publickey"]);
    });
    const onPasswordFallback = vi.fn(async () => "secret");
    try {
      await expect(connector.connect(profile, { sock: clientSock, onPasswordFallback })).rejects.toThrow("All configured authentication methods failed");
      expect(methods).not.toContain("password");
      expect(onPasswordFallback).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it("honors a password offer added after an agent key is rejected", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "password" && ctx.password === "correct") ctx.accept();
      else if (ctx.method === "none") ctx.reject(["publickey"]);
      else ctx.reject(["password"]);
    });
    const onPasswordFallback = vi.fn(async () => "correct");
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback });
      expect(methods).toEqual(["none", "publickey", "password"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      connection.dispose();
    } finally { cleanup(); }
  });

  it("moves to the next factor after the server accepts the agent key as partial success", async () => {
    const methods: string[] = [];
    const offeredKeys: string[] = [];
    let verified = false;
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "none") ctx.reject(["publickey"]);
      else if (ctx.method === "publickey") {
        offeredKeys.push(ctx.key.data.toString("base64"));
        if (!ctx.signature || !ctx.blob) { ctx.accept(); return; }
        const key = utils.parseKey(ctx.key.data);
        if (key instanceof Error || Array.isArray(key)) throw new Error("Invalid offered key");
        verified = key.verify(ctx.blob, ctx.signature, ctx.hashAlgo);
        if (verified) ctx.reject(["password"], true);
        else ctx.reject(["publickey"]);
      }
      else if (ctx.method === "password" && ctx.password === "correct") ctx.accept();
      else ctx.reject(["password"]);
    }, true);
    const onPasswordFallback = vi.fn(async () => "correct");
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback });
      expect(methods).toEqual(["none", "publickey", "publickey", "password"]);
      expect(verified).toBe(true);
      expect(offeredKeys).toHaveLength(2);
      expect(offeredKeys[0]).toBe(offeredKeys[1]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      connection.dispose();
    } finally { cleanup(); }
  });

  it("does not send a late answer after cancellation", async () => {
    const methods: string[] = [];
    let release!: (value: string) => void;
    let started!: () => void;
    const promptStarted = new Promise<void>((resolve) => { started = resolve; });
    const onPasswordFallback = vi.fn(() => { started(); return new Promise<string>((resolve) => { release = resolve; }); });
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      ctx.reject(["publickey", "password"]);
    });
    const abort = new AbortController();
    const onPasswordFallbackResult = vi.fn();
    try {
      const connecting = connector.connect(profile, { sock: clientSock, onPasswordFallback, onPasswordFallbackResult, signal: abort.signal });
      await promptStarted;
      abort.abort();
      await expect(connecting).rejects.toThrow();
      release("secret");
      await new Promise((resolve) => setImmediate(resolve));
      expect(methods).not.toContain("password");
      expect(onPasswordFallbackResult).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it("closes a pending prompt on handshake timeout and never sends its late answer", async () => {
    const methods: string[] = [];
    let release!: (value: string) => void;
    let promptSignal: AbortSignal | undefined;
    const onPasswordFallback = vi.fn((signal?: AbortSignal) => {
      promptSignal = signal;
      return new Promise<string>((resolve) => { release = resolve; });
    });
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      ctx.reject(["publickey", "password"]);
    }, false, 5_000);
    const onPasswordFallbackResult = vi.fn();
    try {
      await expect(connector.connect(profile, { sock: clientSock, onPasswordFallback, onPasswordFallbackResult })).rejects.toThrow(/timed out/i);
      expect(promptSignal?.aborted).toBe(true);
      release("secret");
      await new Promise((resolve) => setImmediate(resolve));
      expect(methods).not.toContain("password");
      expect(onPasswordFallbackResult).not.toHaveBeenCalled();
    } finally { cleanup(); }
  }, 10_000);

  it("does not send a password after the server withdraws its offer", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      ctx.reject(ctx.method === "none" ? ["publickey", "password"] : ["publickey"]);
    });
    const onPasswordFallback = vi.fn(async () => "secret");
    try {
      await expect(connector.connect(profile, { sock: clientSock, onPasswordFallback })).rejects.toThrow("All configured authentication methods failed");
      expect(methods).not.toContain("password");
      expect(onPasswordFallback).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it("does not repeat a password accepted as an MFA factor", async () => {
    const methods: string[] = [];
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "password") ctx.reject(["password", "keyboard-interactive"], true);
      else if (ctx.method === "keyboard-interactive") ctx.accept();
      else ctx.reject(["publickey", "password"]);
    });
    const onPasswordFallback = vi.fn(async () => "first-factor");
    const onPasswordFallbackResult = vi.fn();
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback, onPasswordFallbackResult });
      expect(methods).toEqual(["none", "publickey", "password", "keyboard-interactive"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      expect(onPasswordFallbackResult.mock.calls).toEqual([[true]]);
      connection.dispose();
    } finally { cleanup(); }
  });

  it("allows keyboard-interactive again after a password becomes an MFA factor", async () => {
    const methods: string[] = [];
    let keyboardAttempts = 0;
    const { connector, clientSock, cleanup } = setup((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "keyboard-interactive") {
        if (++keyboardAttempts === 2) ctx.accept();
        else ctx.reject(["password"]);
      } else if (ctx.method === "password") ctx.reject(["keyboard-interactive"], true);
      else ctx.reject(["publickey", "keyboard-interactive", "password"]);
    });
    const onPasswordFallback = vi.fn(async () => "first-factor");
    try {
      const connection = await connector.connect(profile, { sock: clientSock, onPasswordFallback });
      expect(methods).toEqual(["none", "publickey", "keyboard-interactive", "password", "keyboard-interactive"]);
      expect(onPasswordFallback).toHaveBeenCalledTimes(1);
      connection.dispose();
    } finally { cleanup(); }
  });
});
