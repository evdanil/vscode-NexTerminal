import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NexusCore } from "../../src/core/nexusCore";
import type { ExternalAuthProfile, ServerConfig } from "../../src/models/config";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { ExternalCredentialProcessRunner } from "../../src/services/credentials/contracts";
import { CredentialProviderError } from "../../src/services/credentials/credentialProviderError";
import { createExternalCredentialApproval } from "../../src/services/credentials/externalCredentialApproval";
import type { SshConnection } from "../../src/services/ssh/contracts";
import { createSshCredentialRuntime } from "../../src/services/ssh/sshCredentialRuntime";

const mocks = vi.hoisted(() => ({ approval: vi.fn(), runner: vi.fn() }));
vi.mock("../../src/services/credentials/vscodeExternalCredentialApproval", () => ({ createVscodeExternalCredentialApproval: mocks.approval }));
vi.mock("../../src/services/credentials/externalCredentialProcess", () => ({ createExternalCredentialProcessRunner: mocks.runner }));

const profile: ExternalAuthProfile = { id: "provider", name: "Provider", authType: "external", external: { version: 1, method: "password", invocation: { executable: "/example/provider", args: [] } } };
const server: ServerConfig = { id: "target", name: "Target", host: "target.example", port: 22, username: "dormant", authType: "password", isHidden: false, authProfileId: profile.id };
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { cleanups.splice(0).reverse().forEach((fn) => fn()); vi.useRealTimers(); });

async function setup(run?: ExternalCredentialProcessRunner) {
  const core = new NexusCore(new InMemoryConfigRepository());
  await core.initialize();
  await core.addOrUpdateAuthProfile(profile);
  await core.addOrUpdateServer(server);
  const confirm = vi.fn(async () => true);
  const approvals = createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm });
  const disposeApproval = vi.spyOn(approvals, "dispose");
  mocks.approval.mockReturnValue(approvals);
  const runner = vi.fn(run ?? (async () => Buffer.from('{"version":1,"username":"dynamic","password":"SYNTHETIC"}')));
  mocks.runner.mockReturnValue(runner);
  const connections: SshConnection[] = [];
  const connect = vi.fn(async (): Promise<SshConnection> => {
    const connection: SshConnection = { openShell: vi.fn(async () => new PassThrough()), openDirectTcp: vi.fn(async () => new PassThrough()), openSftp: vi.fn(), exec: vi.fn(), requestForwardIn: vi.fn(), cancelForwardIn: vi.fn(), onTcpConnection: vi.fn(() => () => {}), onClose: vi.fn(() => () => {}), getBanner: vi.fn(), dispose: vi.fn() };
    connections.push(connection);
    return connection;
  });
  const vault = { get: vi.fn(async () => undefined), store: vi.fn(), delete: vi.fn() };
  const runtime = createSshCredentialRuntime({ core, vault, connector: { connect }, passwordPrompt: { prompt: vi.fn() }, inputPrompt: vi.fn(),
    proxySecrets: { deleteEndpoint: vi.fn() }, transport: { proxyTimeoutMs: 1000, socks5HandshakeTimeoutMs: 1000, pool: { enabled: true, idleTimeoutMs: 0 } } });
  cleanups.push(() => { runtime.dispose(); runtime.pool.dispose(); });
  return { core, runtime, confirm, runner, connect, connections, vault, disposeApproval };
}

describe("native SSH credential composition", () => {
  it("shares one resolver between SSH, explicit revoke, import hooks and the pool watcher", async () => {
    const h = await setup();
    const begin = vi.spyOn(h.runtime.externalCredentialResolver, "begin");
    const invalidate = vi.spyOn(h.runtime.pool, "invalidate");
    const lease = await h.runtime.pool.connect(h.core.getServer(server.id)!);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(mocks.approval).toHaveBeenCalledTimes(1);
    expect(mocks.runner).toHaveBeenCalledTimes(1);
    expect(h.runner).toHaveBeenCalledTimes(1);
    expect(h.vault.get).not.toHaveBeenCalled();
    // The same-id replacement hook must withdraw precisely this login's grant,
    // while preserving the established connection until its owner releases it.
    h.runtime.revokeExternalCredentialApprovals([profile.id]);
    expect(invalidate.mock.calls).toEqual([[server.id]]);
    expect(h.connections[0].dispose).not.toHaveBeenCalled();
    const fresh = await h.runtime.pool.connect(h.core.getServer(server.id)!);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.runner).toHaveBeenCalledTimes(2);
    invalidate.mockClear();
    h.runtime.externalCredentialResolver.revoke();
    expect(invalidate.mock.calls).toEqual([[server.id]]);
    lease.dispose(); fresh.dispose();
    h.runtime.dispose();
    expect(h.disposeApproval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("has the synchronous stale-attempt fence installed before consumers receive the runtime", async () => {
    let signal: AbortSignal | undefined;
    const h = await setup(async (_invocation, _method, context) => {
      signal = context.signal;
      return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new CredentialProviderError("cancelled")), { once: true }));
    });
    const pending = h.runtime.pool.connect(h.core.getServer(server.id)!).catch((error: unknown) => error);
    await flush();
    expect(signal?.aborted).toBe(false);
    const saving = h.core.addOrUpdateServer({ ...server, host: "changed.example" });
    expect(signal?.aborted).toBe(true); // No timer, persistence, or public change event has run.
    await saving; await pending;
    expect(h.connect).not.toHaveBeenCalled();
    h.runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("profile edits revoke once through the existing watcher and require new consent", async () => {
    const h = await setup();
    const lease = await h.runtime.pool.connect(h.core.getServer(server.id)!);
    const invalidate = vi.spyOn(h.runtime.pool, "invalidate");
    await h.core.addOrUpdateAuthProfile({ ...profile, external: { ...profile.external, invocation: { executable: "/example/changed", args: [] } } });
    expect(invalidate.mock.calls).toEqual([[server.id]]);
    const next = await h.runtime.pool.connect(h.core.getServer(server.id)!);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    lease.dispose(); next.dispose();
  });

  it("disposes running and queued work, approval ownership and every pending timer", async () => {
    const signals: AbortSignal[] = [];
    const h = await setup(async (_invocation, _method, context) => {
      signals.push(context.signal);
      return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new CredentialProviderError("cancelled")), { once: true }));
    });
    const pending = Array.from({ length: 5 }, () => h.runtime.proxiedFactory.connect(h.core.getServer(server.id)!).catch((error: unknown) => error));
    await flush();
    expect(h.runner).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.runtime.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const results = await Promise.all(pending);
    expect(results.every((error) => error instanceof CredentialProviderError)).toBe(true);
    expect(h.runner).toHaveBeenCalledTimes(4); // The fifth request never starts.
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.disposeApproval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
