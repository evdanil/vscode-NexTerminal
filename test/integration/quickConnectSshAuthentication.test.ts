import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { Server, type AuthContext, type Connection } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ServerConfig } from "../../src/models/config";
import type { HostKeyVerifier } from "../../src/services/ssh/contracts";
import { createSshCredentialRuntime } from "../../src/services/ssh/sshCredentialRuntime";
import { Ssh2Connector } from "../../src/services/ssh/ssh2Connector";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

vi.mock("../../src/services/credentials/vscodeExternalCredentialApproval", async () => {
  const { createExternalCredentialApproval } = await import("../../src/services/credentials/externalCredentialApproval");
  return {
    createVscodeExternalCredentialApproval: () => createExternalCredentialApproval({
      isWorkspaceTrusted: () => true,
      confirm: async () => false
    })
  };
});

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(authenticate: (ctx: AuthContext) => void) {
  const peers = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (peer) => {
    peers.add(peer);
    peer.on("error", () => undefined);
    peer.on("close", () => peers.delete(peer));
    peer.on("authentication", authenticate);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const peer of peers) peer.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const saved: ServerConfig = {
    id: "saved", name: "Saved", host: "127.0.0.1", port: address.port,
    username: "saved-user", authType: "password", isHidden: false
  };
  const quick: ServerConfig = { ...saved, id: "quick", name: "Quick", username: "quick-user" };
  const core = new NexusCore(new InMemoryConfigRepository([saved]));
  await core.initialize();
  const vault = {
    get: vi.fn(async () => undefined),
    store: vi.fn(async () => {}),
    delete: vi.fn(async () => {})
  };
  const verify = vi.fn<HostKeyVerifier["verify"]>(async () => true);
  const resolveAgent = vi.fn(() => { throw new Error("Agent must not be opened"); });
  const prompt = vi.fn(async (_server: ServerConfig, _signal?: AbortSignal, _options?: { allowSave?: boolean }) => ({
    password: "once", save: true
  }));
  const inputPrompt = vi.fn(async () => "challenge-answer");
  const runtime = createSshCredentialRuntime({
    core, vault, connector: new Ssh2Connector({ verify }, undefined, undefined, { resolve: resolveAgent }),
    passwordPrompt: { prompt }, inputPrompt,
    transport: { pool: { enabled: true, idleTimeoutMs: 1_000 }, proxyTimeoutMs: 1_000, socks5HandshakeTimeoutMs: 1_000 },
    proxySecrets: undefined
  });
  cleanups.push(() => { runtime.dispose(); runtime.pool.dispose(); });
  return { runtime, quick, saved, core, vault, verify, resolveAgent, prompt, inputPrompt };
}

describe("Quick Connect authentication", () => {
  it("uses fresh passwords over separate verified handshakes with no saved credential access", async () => {
    const passwords: string[] = [];
    const h = await setup((ctx) => {
      if (ctx.method === "password") { passwords.push(ctx.password); ctx.accept(); }
      else ctx.reject(["password"]);
    });
    const getServer = vi.spyOn(h.core, "getServer");
    const getAuthProfile = vi.spyOn(h.core, "getAuthProfile");
    h.prompt.mockResolvedValueOnce({ password: "first", save: true });
    h.prompt.mockResolvedValueOnce({ password: "second", save: true });
    const contaminated: ServerConfig = {
      ...h.quick, id: h.saved.id, authType: "agent", authProfileId: "irrelevant",
      keyPath: "/must-not-read", proxy: { type: "ssh", jumpHostId: "must-not-look-up" }
    };

    (await h.runtime.quickConnectFactory.connect(contaminated)).dispose();
    (await h.runtime.quickConnectFactory.connect(contaminated)).dispose();

    expect(passwords).toEqual(["first", "second"]);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.verify.mock.invocationCallOrder[0]).toBeLessThan(h.prompt.mock.invocationCallOrder[0]);
    expect(h.verify.mock.invocationCallOrder[1]).toBeLessThan(h.prompt.mock.invocationCallOrder[1]);
    expect(h.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ username: "quick-user" }), expect.any(AbortSignal), { allowSave: false });
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(getServer).not.toHaveBeenCalled();
    expect(getAuthProfile).not.toHaveBeenCalled();
    expect(h.vault.get).not.toHaveBeenCalled();
    expect(h.vault.store).not.toHaveBeenCalled();
    expect(h.vault.delete).not.toHaveBeenCalled();
  });

  it("routes keyboard-interactive challenges through the shared input prompt", async () => {
    const delegated: string[][] = [];
    const h = await setup((ctx) => {
      if (ctx.method !== "keyboard-interactive") { ctx.reject(["keyboard-interactive"]); return; }
      ctx.prompt([{ prompt: "Security code", echo: false }, { prompt: "Label", echo: true }], (answers) => {
        delegated.push(answers);
        ctx.accept();
      });
    });

    (await h.runtime.quickConnectFactory.connect(h.quick)).dispose();

    expect(delegated).toEqual([["challenge-answer", "challenge-answer"]]);
    expect(h.inputPrompt).toHaveBeenNthCalledWith(1, "Security code", true, expect.any(AbortSignal));
    expect(h.inputPrompt).toHaveBeenNthCalledWith(2, "Label", false, expect.any(AbortSignal));
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.vault.get).not.toHaveBeenCalled();
    expect(h.vault.store).not.toHaveBeenCalled();
  });

  it("forwards the legacy algorithm opt-in for one connection only", async () => {
    const h = await setup((ctx) => {
      if (ctx.method === "password") ctx.accept();
      else ctx.reject(["password"]);
    });

    (await h.runtime.quickConnectFactory.connect({ ...h.quick, legacyAlgorithms: true })).dispose();
    (await h.runtime.quickConnectFactory.connect({ ...h.quick, legacyAlgorithms: false })).dispose();

    expect(h.verify.mock.calls.map(([target]) => target.legacyAlgorithms)).toEqual([true, undefined]);
  });

  it("queues Quick Connect behind a saved login and cancels without sending an abandoned answer", async () => {
    const usernames: string[] = [];
    const h = await setup((ctx) => {
      if (ctx.method === "password") { usernames.push(ctx.username); ctx.accept(); }
      else ctx.reject(["password"]);
    });
    let answerSaved!: (answer: { password: string; save: boolean }) => void;
    h.prompt.mockImplementationOnce(() => new Promise((resolve) => { answerSaved = resolve; }));
    h.prompt.mockImplementationOnce((_server, signal) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve({ password: "abandoned", save: true }), { once: true });
    }));
    const saved = h.runtime.pool.connect(h.saved);
    void saved.catch(() => undefined);
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledTimes(1));
    let active = true;
    const quick = h.runtime.quickConnectFactory.connectWithContext(h.quick, { isActive: () => active });
    const canceled = expect(quick).rejects.toThrow(/attempt ended/i);
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));
    expect(h.prompt).toHaveBeenCalledTimes(1);

    answerSaved({ password: "saved", save: false });
    (await saved).dispose();
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledTimes(2));
    active = false;
    await canceled;

    expect(usernames).toEqual(["saved-user"]);
    const quickSignal = h.prompt.mock.calls[1][1];
    expect(quickSignal?.aborted).toBe(true);
  });
});
