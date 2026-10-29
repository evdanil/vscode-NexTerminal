import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, Server, utils, type AuthContext, type Connection, type PublicKeyAuthMethod } from "ssh2";
import { Ssh2Connector } from "../../src/services/ssh/ssh2Connector";
import { createExternalSshAuthentication } from "../../src/services/ssh/externalSshAuthentication";
import type { ExternalAuthProfile, ServerConfig } from "../../src/models/config";
import { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import { createExternalCredentialApproval } from "../../src/services/credentials/externalCredentialApproval";
import { createExternalCredentialResolver } from "../../src/services/credentials/externalCredentialResolver";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";
import type { HostKeyVerifier } from "../../src/services/ssh/contracts";

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" });
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function listen(authenticate: (ctx: AuthContext, peer: Connection) => void): Promise<ServerConfig> {
  const peers = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (peer) => {
    peers.add(peer);
    peer.on("error", () => undefined);
    peer.on("authentication", (ctx) => authenticate(ctx, peer));
    peer.on("session", (accept) => accept().on("exec", (acceptExec) => {
      const channel = acceptExec();
      channel.exit(0);
      channel.end("channel-after-disposal");
    }));
  });
  cleanups.push(async () => {
    for (const peer of peers) peer.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return { id: "test", name: "Test SSH", host: "127.0.0.1", port: address.port, username: "dormant", authType: "key", keyPath: "/must-not-read", isHidden: false };
}

describe("external credentials with installed ssh2", () => {
  it.each(["password", "pem", "openssh"])("authenticates returned %s credentials and opens a channel after connector disposal", async (method) => {
    const privateKey = Buffer.from(method === "openssh" ? utils.generateKeyPairSync("ed25519").private : hostKey);
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Invalid test key");
    const methods: string[] = [];
    const server = await listen((ctx) => {
      methods.push(ctx.method);
      if (ctx.method === "password" && ctx.username === "provider-user" && ctx.password === "provider-password") ctx.accept();
      else if (ctx.method === "publickey" && ctx.username === "provider-user" && ctx.key.data.equals(parsed.getPublicSSH()) &&
        (!ctx.signature || parsed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo))) ctx.accept();
      else ctx.reject(["password", "publickey"]);
    });
    const externalCredential = method === "password"
      ? { method: "password" as const, username: "provider-user", password: "provider-password" }
      : { method: "key" as const, username: "provider-user", privateKey };
    const connection = await new Ssh2Connector().connect(server, { externalCredential });
    cleanups.push(() => connection.dispose());
    const channel = await connection.execCommand!("test");
    let output = "";
    channel.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    channel.stderr.resume();
    await channel.completion;
    expect(output).toBe("channel-after-disposal");
    expect(methods).toEqual(method === "password" ? ["password"] : ["publickey", "publickey"]);
  });

  it.each(["pem", "openssh"] as const)("signs %s after both raw copies are wiped before PK_OK, then rekeys and opens a channel", async (format) => {
    const raw = Buffer.from(format === "pem" ? hostKey : utils.generateKeyPairSync("ed25519").private);
    const parsed = utils.parseKey(raw);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Invalid test key");
    const adapter = createExternalSshAuthentication({ method: "key", username: "provider-user", privateKey: raw });
    cleanups.push(() => adapter.dispose());
    const originalHandler = adapter.connectOptions.authHandler as (methods: string[] | null, partial: boolean) => PublicKeyAuthMethod | false;
    let ownRaw: Buffer | undefined;
    let peer: Connection | undefined;
    const methods: string[] = [];
    let signatureVerified = false;
    const server = await listen((ctx, acceptedPeer) => {
      peer = acceptedPeer;
      methods.push(ctx.method);
      if (ctx.method !== "publickey" || ctx.username !== "provider-user" || !ctx.key.data.equals(parsed.getPublicSSH())) { ctx.reject(); return; }
      if (!ctx.signature) {
        // The server has only received the probe. Signing will happen after PK_OK.
        raw.fill(0);
        adapter.dispose();
        expect(ownRaw?.every((byte) => byte === 0)).toBe(true);
        setImmediate(() => ctx.accept());
      } else {
        signatureVerified = parsed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true;
        if (signatureVerified) ctx.accept(); else ctx.reject();
      }
    });
    const client = new Client();
    cleanups.push(() => { client.destroy(); });
    const ready = once(client, "ready");
    client.connect({ host: server.host, port: server.port, ...adapter.connectOptions, authHandler: (methods, partial) => {
      const method = originalHandler(methods, partial);
      if (method) ownRaw = method.key as Buffer;
      return method;
    } });
    await ready;
    expect(signatureVerified).toBe(true);
    expect(methods).toEqual(["publickey", "publickey"]);
    // Read-only characterization: ssh2's undocumented config is inspected only
    // in tests, never modified or depended on by production code.
    const retained = (client as unknown as { config: Record<string, unknown> }).config;
    expect(retained.password).toBeUndefined();
    expect(retained.privateKey).toBeUndefined();
    expect(retained.agent).toBeUndefined();
    await new Promise<void>((resolve) => peer!.rekey(resolve));
    const stream = await new Promise<import("ssh2").ClientChannel>((resolve, reject) => client.exec("test", (error, channel) => error ? reject(error) : resolve(channel)));
    let output = "";
    stream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await once(stream, "close");
    expect(output).toBe("channel-after-disposal");
    expect(originalHandler(null, false)).toBe(false);
  });

  it("shows why top-level raw credentials cannot be used: ssh2 retains them after ready", async () => {
    const server = await listen((ctx) => ctx.accept());
    const client = new Client();
    cleanups.push(() => { client.destroy(); });
    const raw = Buffer.from(hostKey);
    const ready = once(client, "ready");
    client.connect({ host: server.host, port: server.port, username: "user", password: "retained-password", privateKey: raw });
    await ready;
    const retained = (client as unknown as { config: Record<string, unknown> }).config;
    expect(retained.password).toBe("retained-password");
    expect(retained.privateKey).toBe(raw);
    raw.fill(0);
  });

  it.each([false, true])("rejects without repeating password or trying agent/key (partial=%s)", async (partial) => {
    const methods: string[] = [];
    const server = await listen((ctx) => { methods.push(ctx.method); ctx.reject(["password", "publickey", "agent", "keyboard-interactive"], partial); });
    await expect(new Ssh2Connector().connect(server, { externalCredential: { method: "password", username: "provider-user", password: "provider-password" } })).rejects.toThrow("authentication");
    expect(methods).toEqual(partial ? ["password"] : ["password", "keyboard-interactive"]);
  });

  it.each(["otp", "multiple", "repeat", "echo", "password"])("external keyboard-interactive handles %s without local prompting", async (challenge) => {
    const methods: string[] = [];
    const server = await listen((ctx) => {
      methods.push(ctx.method);
      if (ctx.method !== "keyboard-interactive") { ctx.reject(["keyboard-interactive"]); return; }
      const prompts = challenge === "multiple" ? [{ prompt: "Password:", echo: false }, { prompt: "OTP:", echo: false }] :
        [{ prompt: challenge === "otp" ? "OTP:" : "Password:", echo: challenge === "echo" }];
      ctx.prompt(prompts, (responses) => {
        if (challenge === "repeat") {
          expect(responses).toEqual(["provider-password"]);
          ctx.prompt([{ prompt: "Password:", echo: false }], () => ctx.reject());
        } else if (challenge === "password" && responses[0] === "provider-password") ctx.accept();
        else ctx.reject();
      });
    });
    const connecting = new Ssh2Connector().connect(server, {
      externalCredential: { method: "password", username: "provider-user", password: "provider-password" },
      onKeyboardInteractive: async () => { throw new Error("local prompt must never run"); }
    });
    if (challenge === "password") {
      const connection = await connecting;
      cleanups.push(() => connection.dispose());
    } else {
      await expect(connecting).rejects.toMatchObject({ code: "interaction-required" });
    }
    expect(methods).toEqual(["password", "keyboard-interactive"]);
  });

  it("cancels a pending key authentication without waiting for the server", async () => {
    const controller = new AbortController();
    const raw = Buffer.from(hostKey);
    const server = await listen(() => { raw.fill(0); controller.abort(new Error("test cancellation")); });
    await expect(new Ssh2Connector().connect(server, { signal: controller.signal, externalCredential: { method: "key", username: "provider-user", privateKey: raw } })).rejects.toThrow("test cancellation");
  });

  it("refuses encrypted keys before any network authentication", async () => {
    let attempts = 0;
    const server = await listen(() => { attempts++; });
    const encrypted = utils.generateKeyPairSync("ed25519", { cipher: "aes256-ctr", passphrase: "test-passphrase", rounds: 1 }).private;
    await expect(new Ssh2Connector().connect(server, { externalCredential: { method: "key", username: "provider-user", privateKey: Buffer.from(encrypted) } })).rejects.toThrow("invalid response");
    expect(attempts).toBe(0);
  });
});

function fullFactory(target: ServerConfig, method: "password" | "key" = "password", verifier?: HostKeyVerifier) {
  const profile: ExternalAuthProfile = { id: "provider", name: "Provider", authType: "external", external: { version: 1, method, invocation: { executable: "/provider", args: [] } } };
  const linked = { ...target, authProfileId: profile.id };
  const vault = { get: vi.fn(async () => "dormant"), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const prompt = { prompt: vi.fn(async () => ({ password: "dormant", save: true })) };
  const run = vi.fn(async () => Buffer.from(JSON.stringify({ version: 1, username: "runtime-user", ...(method === "password" ? { password: "PROVIDER-CANARY" } : { private_key: String(hostKey) }) })));
  const resolver = createExternalCredentialResolver({ approvals: createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm: async () => true }), run, parse: parseExternalCredentialResponse });
  cleanups.push(() => resolver.dispose());
  const factory = new SilentAuthSshFactory(new Ssh2Connector(verifier), vault, prompt, undefined, () => profile, () => linked, resolver);
  const noLegacy = () => { expect(vault.get).not.toHaveBeenCalled(); expect(vault.store).not.toHaveBeenCalled(); expect(vault.delete).not.toHaveBeenCalled(); expect(prompt.prompt).not.toHaveBeenCalled(); };
  return { factory, linked, resolver, run, noLegacy };
}

describe("common external factory through installed ssh2", () => {
  it.each(["password", "otp", "multiple", "echo", "key"])("answers only the supported password challenge (%s)", async (challenge) => {
    const methods: string[] = [];
    const answers: string[][] = [];
    const target = await listen((ctx) => {
      methods.push(ctx.method);
      if (ctx.method !== "keyboard-interactive") { ctx.reject(["keyboard-interactive"]); return; }
      const prompts = challenge === "multiple" ? [{ prompt: "Password:", echo: false }, { prompt: "OTP:", echo: false }] : [{ prompt: challenge === "otp" ? "OTP:" : "Password:", echo: challenge === "echo" }];
      ctx.prompt(prompts, (responses) => { answers.push(responses); if (challenge === "password" && responses[0] === "PROVIDER-CANARY") ctx.accept(); else ctx.reject(); });
    });
    const h = fullFactory(target, challenge === "key" ? "key" : "password");
    const messages: string[] = [];
    const pending = h.factory.connect(h.linked, { onAuthMessage: (text) => { messages.push(text); } });
    if (challenge === "password") {
      const connection = await pending; cleanups.push(() => connection.dispose());
      expect(answers).toEqual([["PROVIDER-CANARY"]]);
    } else if (challenge === "key") {
      await expect(pending).rejects.toThrow("authentication");
      expect(methods).toEqual(["publickey"]); expect(answers).toEqual([]);
    } else {
      await expect(pending).rejects.toMatchObject({ code: "interaction-required" });
      expect(answers.flat()).not.toContain("PROVIDER-CANARY");
    }
    expect(messages.join("")).not.toContain("PROVIDER-CANARY"); expect(h.run).toHaveBeenCalledTimes(1); h.noLegacy();
  });

  it("revoke during real host verification stops authentication even when the verifier later accepts", async () => {
    let entered!: () => void;
    const verifying = new Promise<void>((resolve) => { entered = resolve; });
    let allow!: (value: boolean) => void;
    const decision = new Promise<boolean>((resolve) => { allow = resolve; });
    const authenticate = vi.fn((ctx: AuthContext) => ctx.accept());
    const target = await listen(authenticate);
    let signal: AbortSignal | undefined;
    const h = fullFactory(target, "password", { verify: async (_server, _key, context) => { signal = context?.signal; entered(); return decision; } });
    const pending = h.factory.connect(h.linked).catch((error: unknown) => error);
    await verifying; h.resolver.revoke();
    expect(signal?.aborted).toBe(true); expect(await pending).toMatchObject({ code: "cancelled" });
    allow(true); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(authenticate).not.toHaveBeenCalled(); h.noLegacy();
  });

  it("revoke while real SSH authentication awaits readiness cancels delivery", async () => {
    let entered!: () => void;
    const authenticating = new Promise<void>((resolve) => { entered = resolve; });
    let accept!: () => void;
    const target = await listen((ctx) => { accept = () => ctx.accept(); entered(); });
    const h = fullFactory(target);
    const pending = h.factory.connect(h.linked).catch((error: unknown) => error);
    await authenticating; h.resolver.revoke();
    expect(await pending).toMatchObject({ code: "cancelled" });
    accept(); await new Promise<void>((resolve) => setImmediate(resolve)); h.noLegacy();
  });
});
