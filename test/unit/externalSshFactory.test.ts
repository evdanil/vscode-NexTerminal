import * as vscode from "vscode";
import { PassThrough } from "node:stream";
import { utils } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { AuthProfile, ExternalAuthProfile, ServerConfig } from "../../src/models/config";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { ExternalCredentialProcessRunner } from "../../src/services/credentials/contracts";
import { CredentialProviderError } from "../../src/services/credentials/credentialProviderError";
import { createExternalCredentialApproval } from "../../src/services/credentials/externalCredentialApproval";
import { createExternalCredentialResolver } from "../../src/services/credentials/externalCredentialResolver";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";
import type { SshConnection, SshConnector } from "../../src/services/ssh/contracts";
import { SilentAuthSshFactory } from "../../src/services/ssh/silentAuth";
import { ProxySshFactory } from "../../src/services/ssh/proxySshFactory";
import { SshConnectionPool } from "../../src/services/ssh/sshConnectionPool";
import { watchPoolInvalidationOnConfigMutation } from "../../src/services/ssh/poolConfigInvalidation";
import { classifySshConnectionError } from "../../src/services/ssh/connectionDiagnostics";
import { SshPty } from "../../src/services/ssh/sshPty";

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private readonly listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: T): void { for (const listener of this.listeners) listener(value); }
    dispose(): void { this.listeners.clear(); }
  },
  window: { showErrorMessage: vi.fn() }, commands: { executeCommand: vi.fn() }
}));

const profile = (): ExternalAuthProfile => ({ id: "external", name: "Provider", authType: "external", external: { version: 1, method: "password", invocation: { executable: "/provider", args: ["item"] } } });
const server = (id = "target", extra: Partial<ServerConfig> = {}): ServerConfig => ({ id, name: id, host: `${id}.example`, port: 22, username: "dormant", authType: "key", keyPath: "/must-not-read", authProfileId: "external", isHidden: false, ...extra });
const output = () => Buffer.from(JSON.stringify({ version: 1, username: "runtime-user", password: "PROVIDER-CANARY" }));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { resolve, promise }; };
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function connection(): SshConnection {
  return { openShell: vi.fn(async () => new PassThrough()), openDirectTcp: vi.fn(async () => new PassThrough()), openSftp: vi.fn(), exec: vi.fn(), requestForwardIn: vi.fn(), cancelForwardIn: vi.fn(), onTcpConnection: vi.fn(() => () => {}), onClose: vi.fn(() => () => {}), getBanner: vi.fn(), dispose: vi.fn() };
}
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((stop) => stop()); vi.useRealTimers(); });
function setup(options: { run?: ExternalCredentialProcessRunner; confirm?: () => Promise<boolean>; connect?: SshConnector["connect"]; resolver?: boolean } = {}) {
  const profiles = new Map<string, AuthProfile>([["external", profile()]]);
  const servers = new Map([["target", server()]]);
  const vault = { get: vi.fn(async () => "DORMANT"), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const prompt = { prompt: vi.fn(async () => ({ password: "DORMANT", save: true })) };
  const input = vi.fn(async () => "DORMANT");
  const run = vi.fn(options.run ?? (async () => output()));
  const confirm = vi.fn(options.confirm ?? (async () => true));
  const approvals = createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm });
  const resolver = createExternalCredentialResolver({ approvals, run, parse: parseExternalCredentialResponse });
  cleanup.push(() => resolver.dispose());
  const delivered: Array<{ username: string; password?: string; method: string }> = [];
  const connect = vi.fn(options.connect ?? (async (_server, auth) => {
    if (auth.externalCredential) delivered.push({ ...auth.externalCredential });
    return connection();
  }));
  const factory = new SilentAuthSshFactory({ connect }, vault, prompt, input, (id) => profiles.get(id), (id) => servers.get(id), options.resolver === false ? undefined : resolver);
  const unpooled = new ProxySshFactory(factory, (id) => servers.get(id), vault);
  const proxied = new ProxySshFactory(factory, (id) => servers.get(id), vault);
  const pool = new SshConnectionPool(proxied, { enabled: true, idleTimeoutMs: 0 });
  proxied.setJumpHostConnectionFactory(pool);
  cleanup.push(() => pool.dispose());
  const noLegacy = () => {
    expect(vault.get).not.toHaveBeenCalled(); expect(vault.store).not.toHaveBeenCalled(); expect(vault.delete).not.toHaveBeenCalled();
    expect(prompt.prompt).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
    expect((factory as unknown as { sharedAnswers: Map<string, unknown> }).sharedAnswers.size).toBe(0);
  };
  return { profiles, servers, factory, unpooled, proxied, pool, resolver, approvals, run, confirm, connect, delivered, noLegacy };
}

describe("external SSH factory", () => {
  it("snapshots each authenticating hop's context for the provider", async () => {
    const h = setup();
    const configured = profile();
    h.profiles.set("external", { ...configured, external: { ...configured.external,
      invocation: { ...configured.external.invocation!, argumentExpansion: true } } });
    h.servers.set("jump", server("jump", { name: "Jump", host: "jump.example", port: 2222, username: "jump-user" }));
    h.servers.set("target", server("target", { name: "Target", port: 2200, username: "target-user", proxy: { type: "ssh", jumpHostId: "jump" } }));
    const begin = vi.spyOn(h.resolver, "begin");
    const lease = await h.pool.connect(h.servers.get("target")!);
    expect(begin.mock.calls.map(([request]) => request.argumentContext)).toEqual([
      { host: "jump.example", port: 2222, SessionName: "Jump", username: "jump-user", profile: "Provider", protocol: "ssh" },
      { host: "target.example", port: 2200, SessionName: "Target", username: "target-user", profile: "Provider", protocol: "ssh" }
    ]);
    expect(begin.mock.calls.every(([request]) => Object.isFrozen(request.argumentContext))).toBe(true);
    expect(h.delivered.map((result) => result.username)).toEqual(["runtime-user", "runtime-user"]);
    lease.dispose(); h.noLegacy();
  });

  it("does not pass connection context to literal external profiles", async () => {
    const h = setup(); const begin = vi.spyOn(h.resolver, "begin");
    await h.factory.connect(h.servers.get("target")!);
    expect(begin.mock.calls[0][0]).not.toHaveProperty("argumentContext"); h.noLegacy();
  });

  it("uses the alternate dial host while checking the original live record", async () => {
    const h = setup({ connect: async (s) => { if (s.host === "target.example") throw new Error("connect ECONNREFUSED"); return connection(); } });
    const configured = profile(); h.profiles.set("external", { ...configured, external: { ...configured.external,
      invocation: { ...configured.external.invocation!, argumentExpansion: true } } });
    const target = server("target", { altHost: "alternate.example" }); h.servers.set(target.id, target);
    const begin = vi.spyOn(h.resolver, "begin");
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onConnectFailed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() } as unknown as ConstructorParameters<typeof SshPty>[3];
    const pty = new SshPty(target, h.pool, callbacks, logger); cleanup.push(() => pty.dispose());
    pty.open(); await flush(); await flush();
    expect(callbacks.onSessionOpened).toHaveBeenCalledTimes(1);
    expect(begin.mock.calls.map(([request]) => request.argumentContext?.host)).toEqual(["target.example", "alternate.example"]);
  });

  it.each(["server name", "username", "profile name"])("fences an in-place %s change before SSH delivery", async (field) => {
    const answer = deferred<boolean>(); const h = setup({ confirm: () => answer.promise });
    const configured = profile(); const expanded: ExternalAuthProfile = { ...configured, external: { ...configured.external,
      invocation: { ...configured.external.invocation!, argumentExpansion: true } } };
    h.profiles.set("external", expanded);
    const target = h.servers.get("target")!;
    const pending = h.factory.connect(target).catch((error: unknown) => error); await flush();
    if (field === "server name") target.name = "changed";
    if (field === "username") target.username = "changed";
    if (field === "profile name") expanded.name = "changed";
    answer.resolve(true);
    expect(await pending).toMatchObject({ code: "configuration-changed" });
    expect(h.connect).not.toHaveBeenCalled(); h.noLegacy();
  });

  it("retrieves independently, passes only external auth and releases the borrowed result at ready", async () => {
    const h = setup(); const target = h.servers.get("target")!;
    await h.factory.connect(target); await h.factory.connect(target, { interaction: "noninteractive" });
    expect(h.run).toHaveBeenCalledTimes(2); expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.delivered).toEqual(Array(2).fill({ method: "password", username: "runtime-user", password: "PROVIDER-CANARY" }));
    const auth = h.connect.mock.calls[0][1];
    expect(auth).not.toHaveProperty("password"); expect(auth).not.toHaveProperty("passphrase"); expect(auth).not.toHaveProperty("onKeyboardInteractive");
    expect(auth.externalCredential).toMatchObject({ username: "", password: "" });
    expect(h.connect.mock.calls[1][1].interaction).toBe("noninteractive"); h.noLegacy();
  });

  it.each(["missing resolver", "unconfigured", "deleted profile", "exited", "invalid-response", "encrypted key", "authentication rejection"])("fails closed for %s", async (failure) => {
    const h = setup({ resolver: failure !== "missing resolver",
      run: async () => {
        if (failure === "exited") throw new CredentialProviderError("exited", 9);
        if (failure === "invalid-response") return Buffer.from("PROVIDER-CANARY");
        if (failure === "encrypted key") return Buffer.from(JSON.stringify({ version: 1, username: "u", private_key: utils.generateKeyPairSync("ed25519", { cipher: "aes256-ctr", passphrase: "fixture-passphrase", rounds: 1 }).private }));
        return output();
      }, connect: async () => { if (failure === "authentication rejection") throw new Error("All configured authentication methods failed"); return connection(); }
    });
    if (failure === "unconfigured") h.profiles.set("external", { ...profile(), external: { version: 1, method: "password" } });
    if (failure === "deleted profile") h.profiles.clear();
    if (failure === "encrypted key") h.profiles.set("external", { ...profile(), external: { ...profile().external, method: "key" } });
    const error = await h.factory.connect(h.servers.get("target")!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("CANARY");
    if (failure !== "authentication rejection") expect(h.connect).not.toHaveBeenCalled();
    else expect(classifySshConnectionError(error).stage).toBe("auth");
    h.noLegacy();
  });

  it("pooled shell, SFTP and forwarding reuse one login; invalidation retrieves again without closing a lease", async () => {
    const h = setup(); const target = h.servers.get("target")!;
    const one = await h.pool.connect(target); const two = await h.pool.connect(target);
    await one.openShell(); await two.openSftp(); await two.openDirectTcp("service.example", 80);
    expect(h.run).toHaveBeenCalledTimes(1);
    const first = await h.connect.mock.results[0].value;
    h.pool.invalidate(target.id); expect(first.dispose).not.toHaveBeenCalled();
    const three = await h.pool.connect(target); expect(h.run).toHaveBeenCalledTimes(2);
    one.dispose(); two.dispose(); three.dispose(); h.noLegacy();
  });

  it("authenticates jump and target once each, preserving noninteractive policy", async () => {
    const h = setup(); h.servers.set("jump", server("jump"));
    h.servers.set("target", server("target", { proxy: { type: "ssh", jumpHostId: "jump" } }));
    const approved = h.resolver.begin({ profile: profile(), interaction: "interactive", signal: new AbortController().signal, isCurrent: () => true });
    await approved.resolve(); approved.dispose(); h.run.mockClear(); h.confirm.mockClear();
    await h.pool.connectWithContext(h.servers.get("target")!, { interaction: "noninteractive" });
    expect(h.run).toHaveBeenCalledTimes(2); expect(h.connect.mock.calls.map(([s]) => s.id)).toEqual(["jump", "target"]);
    expect(h.connect.mock.calls.map(([, auth]) => auth.interaction)).toEqual(["noninteractive", "noninteractive"]);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.connect.mock.calls[1][1].sock).toBeDefined(); h.noLegacy();
  });

  for (const phase of ["consent", "retrieval", "socket"] as const) {
    it.each(["server", "profile", "method", "args", "route", "identical profile"])(`fences %s replacement during ${phase}`, async (change) => {
      const gate = deferred<boolean>(); const bytes = deferred<Buffer>(); const sock = deferred<PassThrough>();
      const h = setup({ confirm: phase === "consent" ? () => gate.promise : undefined, run: phase === "retrieval" ? () => bytes.promise : undefined });
      let route = "route-before";
      const pending = h.factory.connect(h.servers.get("target")!, { route: () => route, ...(phase === "socket" ? { sockFactory: () => sock.promise } : {}) }).catch((e: unknown) => e);
      await flush();
      if (change === "server") h.servers.set("target", server("target", { host: "changed.example" }));
      if (change === "profile") h.profiles.delete("external");
      if (change === "method") h.profiles.set("external", { ...profile(), external: { ...profile().external, method: "key" } });
      if (change === "args") h.profiles.set("external", { ...profile(), external: { ...profile().external, invocation: { executable: "/provider", args: ["changed"] } } });
      if (change === "route") route = "route-after";
      if (change === "identical profile") h.profiles.set("external", profile());
      const late = new PassThrough(); gate.resolve(true); bytes.resolve(output()); sock.resolve(late);
      expect(await pending).toBeInstanceOf(CredentialProviderError);
      expect(h.connect).not.toHaveBeenCalled(); if (phase === "socket") expect(late.destroyed).toBe(true); h.noLegacy();
    });
  }

  it.each(["socket", "host verification", "ready"])("revokes without config edits while %s is pending, disposing late resources", async (phase) => {
    const sock = deferred<PassThrough>(); const ready = deferred<SshConnection>();
    const h = setup({ connect: () => ready.promise });
    const pending = h.factory.connect(h.servers.get("target")!, phase === "socket" ? { sockFactory: () => sock.promise } : {}).catch((e: unknown) => e);
    await flush(); expect(h.run).toHaveBeenCalledTimes(1);
    h.resolver.revoke(); await flush();
    if (phase !== "socket") expect(h.connect.mock.calls[0][1].signal?.aborted).toBe(true);
    // Cancellation settles even when a dependency ignores the abort signal.
    expect(await pending).toBeInstanceOf(CredentialProviderError);
    const lateSocket = new PassThrough(); const lateConnection = connection(); sock.resolve(lateSocket); ready.resolve(lateConnection); await flush();
    if (phase === "socket") { expect(lateSocket.destroyed).toBe(true); expect(h.connect).not.toHaveBeenCalled(); }
    else expect(lateConnection.dispose).toHaveBeenCalledTimes(1);
    h.noLegacy();
  });

  it("does not let an abandoned pooled owner cancel its live joiner", async () => {
    const answer = deferred<boolean>(); const h = setup({ confirm: () => answer.promise }); const controller = new AbortController();
    const first = h.pool.connectWithContext(h.servers.get("target")!, { signal: controller.signal }).catch((e: unknown) => e);
    const second = h.pool.connect(h.servers.get("target")!); await flush(); controller.abort(); answer.resolve(true);
    expect(await first).toBeInstanceOf(Error); const live = await second;
    expect(h.run).toHaveBeenCalledTimes(1); expect(h.connect).toHaveBeenCalledTimes(1); live.dispose(); h.noLegacy();
  });

  it("a disposed terminal leaves a live pooled SFTP joiner able to finish consent", async () => {
    const answer = deferred<boolean>(); const h = setup({ confirm: () => answer.promise });
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() } as unknown as ConstructorParameters<typeof SshPty>[3];
    const pty = new SshPty(h.servers.get("target")!, h.pool, callbacks, logger); cleanup.push(() => pty.dispose());
    pty.open(); const joined = h.pool.connect(h.servers.get("target")!); await flush();
    pty.dispose(); answer.resolve(true); const lease = await joined; await lease.openSftp();
    expect(callbacks.onSessionOpened).not.toHaveBeenCalled(); expect(h.run).toHaveBeenCalledTimes(1);
    lease.dispose(); h.noLegacy();
  });

  it("cancels a caller during retrieval without retaining raw abort reasons", async () => {
    const bytes = deferred<Buffer>(); const h = setup({ run: () => bytes.promise }); const controller = new AbortController();
    const pending = h.factory.connect(h.servers.get("target")!, { signal: controller.signal }).catch((e: unknown) => e);
    await flush(); controller.abort(new Error("ABORT-CANARY")); const error = await pending;
    expect(error).toBeInstanceOf(CredentialProviderError); expect(String(error)).not.toContain("CANARY");
    bytes.resolve(output()); await flush(); expect(h.connect).not.toHaveBeenCalled(); h.noLegacy();
  });

  it("preserves controlled external cancellation through a jump wrapper instead of its raw caller reason", async () => {
    const bytes = deferred<Buffer>(); const h = setup({ run: () => bytes.promise }); const controller = new AbortController();
    h.servers.set("jump", server("jump"));
    h.servers.set("target", server("target", { proxy: { type: "ssh", jumpHostId: "jump" } }));
    const pending = h.unpooled.connectWithContext(h.servers.get("target")!, { signal: controller.signal }).catch((e: unknown) => e);
    await flush(); controller.abort(new Error("ABORT-CANARY")); const error = await pending;
    expect(String(error)).not.toContain("ABORT-CANARY");
    bytes.resolve(output()); await flush(); h.noLegacy();
  });

  it("refuses synchronous ready delivery after configuration changes and disposes that connection", async () => {
    const ready = deferred<SshConnection>(); const h = setup({ connect: () => ready.promise });
    const pending = h.factory.connect(h.servers.get("target")!).catch((e: unknown) => e); await flush();
    const late = connection(); ready.resolve(late); h.servers.set("target", server());
    expect(await pending).toMatchObject({ code: "configuration-changed" });
    expect(late.dispose).toHaveBeenCalledTimes(1); h.noLegacy();
  });

  it("classifies provider errors through jump wrappers without treating timeout as transport fallback", () => {
    for (const code of ["timed-out", "queue-timeout", "unconfigured", "approval-required", "invalid-response"] as const) {
      const error = new Error("Jump host connection failed: ECONNREFUSED", { cause: new CredentialProviderError(code) });
      expect(classifySshConnectionError(error).stage).toBe("credential-provider");
    }
    expect(classifySshConnectionError(new Error("connect ECONNREFUSED")).stage).toBe("tcp");
    expect(classifySshConnectionError(new Error("getaddrinfo ENOTFOUND")).stage).toBe("dns");
  });

  it.each(["tcp", "dns", "provider", "auth"])("terminal alternate-address behavior preserves %s provenance and retrieval counts", async (failure) => {
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    const h = setup({
      run: async () => { if (failure === "provider") throw new CredentialProviderError("timed-out"); return output(); },
      connect: async (target) => {
        if (target.host === "target.example") throw new Error(failure === "tcp" ? "connect ECONNREFUSED" : failure === "dns" ? "getaddrinfo ENOTFOUND" : "All configured authentication methods failed");
        return connection();
      }
    });
    const target = server("target", { altHost: "alternate.example" }); h.servers.set(target.id, target);
    const callbacks = { onSessionOpened: vi.fn(), onSessionClosed: vi.fn(), onConnectFailed: vi.fn() };
    const logger = { log: vi.fn(), close: vi.fn() } as unknown as ConstructorParameters<typeof SshPty>[3];
    const pty = new SshPty(target, h.pool, callbacks, logger); cleanup.push(() => pty.dispose());
    const writes: string[] = []; pty.onDidWrite((text) => writes.push(text));
    pty.open(); await flush(); await flush();
    if (failure === "tcp" || failure === "dns") {
      expect(callbacks.onSessionOpened).toHaveBeenCalledTimes(1); expect(h.run).toHaveBeenCalledTimes(2);
      expect(h.connect.mock.calls.map(([s]) => s.host)).toEqual(["target.example", "alternate.example"]);
    } else {
      expect(callbacks.onConnectFailed).toHaveBeenCalledTimes(1); expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.connect).toHaveBeenCalledTimes(failure === "provider" ? 0 : 1);
      expect(writes.join("")).not.toContain("trying alternate host");
    }
    if (failure === "provider") {
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(new CredentialProviderError("timed-out").message, "Manage Auth Profiles");
    }
    expect(writes.join("")).not.toContain("PROVIDER-CANARY"); h.noLegacy();
  });

  it("fences a byte-identical target profile replacement while its jump authentication is pending", async () => {
    const ready = deferred<SshConnection>(); const h = setup({ connect: (s) => s.id === "jump" ? ready.promise : Promise.resolve(connection()) });
    h.profiles.set("jump-profile", { ...profile(), id: "jump-profile" });
    h.servers.set("jump", server("jump", { authProfileId: "jump-profile" }));
    h.servers.set("target", server("target", { proxy: { type: "ssh", jumpHostId: "jump" } }));
    const pending = h.proxied.connect(h.servers.get("target")!).catch((e: unknown) => e); await flush();
    h.profiles.set("external", profile()); ready.resolve(connection());
    expect(await pending).toBeInstanceOf(CredentialProviderError);
    expect(h.connect.mock.calls.map(([s]) => s.id)).toEqual(["jump"]);
    expect(h.run).toHaveBeenCalledTimes(1); h.noLegacy();
  });
});

describe("external revocation pool wiring", () => {
  it("synchronously cancels an old lookup and retires its pool on rename without closing the live lease", async () => {
    const configured = profile(); const expanded: ExternalAuthProfile = { ...configured, external: { ...configured.external,
      invocation: { ...configured.external.invocation!, argumentExpansion: true } } };
    const core = new NexusCore(new InMemoryConfigRepository([server()], [], [], [], [expanded])); await core.initialize();
    const stalled = deferred<Buffer>(); let runningSignal: AbortSignal | undefined; let calls = 0;
    const run: ExternalCredentialProcessRunner = async (_invocation, _method, ctx) => {
      calls++; if (calls === 2) { runningSignal = ctx.signal; return stalled.promise; } return output();
    };
    const resolver = createExternalCredentialResolver({ approvals: createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm: async () => true }), run, parse: parseExternalCredentialResponse });
    const connect = vi.fn(async () => connection());
    const vault = { get: vi.fn(async () => undefined), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const factory = new SilentAuthSshFactory({ connect }, vault, { prompt: vi.fn() }, undefined, (id) => core.getAuthProfile(id), (id) => core.getServer(id), resolver);
    const pool = new SshConnectionPool(new ProxySshFactory(factory, (id) => core.getServer(id), vault), { enabled: true, idleTimeoutMs: 0 });
    cleanup.push(() => resolver.dispose(), () => pool.dispose(), watchPoolInvalidationOnConfigMutation(core, pool, undefined, resolver));
    const first = await pool.connect(core.getServer("target")!); const transport = await connect.mock.results[0].value;
    const pending = factory.connect(core.getServer("target")!).catch((error: unknown) => error); await flush();
    expect(runningSignal?.aborted).toBe(false);
    const update = core.addOrUpdateServer({ ...core.getServer("target")!, name: "renamed" });
    expect(runningSignal?.aborted).toBe(true);
    expect(transport.dispose).not.toHaveBeenCalled(); await first.openShell();
    await update; expect(await pending).toMatchObject({ code: "configuration-changed" });
    stalled.resolve(output()); const second = await pool.connect(core.getServer("target")!);
    expect(calls).toBe(3); first.dispose(); second.dispose();
  });

  it("revoke-only retires an established pool entry while its lease remains usable", async () => {
    const h = setup(); const target = h.servers.get("target")!;
    const core = new NexusCore(new InMemoryConfigRepository([target], [], [], [], [profile()])); await core.initialize();
    cleanup.push(watchPoolInvalidationOnConfigMutation(core, h.pool, undefined, h.resolver));
    const first = await h.pool.connect(target); const transport = await h.connect.mock.results[0].value;
    h.resolver.revoke(); expect(transport.dispose).not.toHaveBeenCalled(); await first.openShell();
    const next = await h.pool.connect(target); expect(h.run).toHaveBeenCalledTimes(2); expect(h.confirm).toHaveBeenCalledTimes(2);
    first.dispose(); next.dispose(); h.noLegacy();
  });

  it("invalidates linked servers and transitive riders once, including identical overwrite before persistence", async () => {
    const h = setup();
    const repo = new InMemoryConfigRepository([server("jump"), server("mid", { authProfileId: undefined, proxy: { type: "ssh", jumpHostId: "jump" } }), server("far", { authProfileId: undefined, proxy: { type: "ssh", jumpHostId: "mid" } }), server("other", { authProfileId: undefined })], [], [], [], [profile()]);
    const core = new NexusCore(repo); await core.initialize();
    const invalidate = vi.fn();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate }, undefined, h.resolver); cleanup.push(stop);
    h.resolver.revoke(["external"]);
    expect(invalidate.mock.calls.map(([id]) => id).sort()).toEqual(["far", "jump", "mid"]);
    invalidate.mockClear();
    const gate = deferred<void>(); vi.spyOn(repo, "saveAuthProfiles").mockReturnValue(gate.promise);
    const update = core.addOrUpdateAuthProfile(profile());
    expect(invalidate.mock.calls.map(([id]) => id).sort()).toEqual(["far", "jump", "mid"]);
    gate.resolve(); await update;
    expect(invalidate).toHaveBeenCalledTimes(3);
    stop(); invalidate.mockClear(); h.resolver.revoke(); expect(invalidate).not.toHaveBeenCalled();
  });
});
