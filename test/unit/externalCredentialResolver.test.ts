import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalAuthProfile } from "../../src/models/authProfile";
import type { ExternalCredentialProcessRunner, ExternalCredentialRequest } from "../../src/services/credentials/contracts";
import { CredentialProviderError } from "../../src/services/credentials/credentialProviderError";
import { createExternalCredentialApproval } from "../../src/services/credentials/externalCredentialApproval";
import { createExternalCredentialResolver } from "../../src/services/credentials/externalCredentialResolver";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";
const profile = (): ExternalAuthProfile => ({ id: "provider", name: "Vault", authType: "external", external: { version: 1, method: "password", invocation: { executable: "/provider", args: [] } } });
const request = (controller = new AbortController()): ExternalCredentialRequest => ({ profile: profile(), signal: controller.signal, interaction: "interactive", isCurrent: () => true });
const output = (password = "SECRET") => Buffer.from(JSON.stringify({ version: 1, username: "operator", password }));
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
const resolvers: ReturnType<typeof createExternalCredentialResolver>[] = [];
function setup(run: ExternalCredentialProcessRunner = vi.fn(async () => output()), confirm = vi.fn(async () => true), parse = parseExternalCredentialResponse) {
  const approvals = createExternalCredentialApproval({ isWorkspaceTrusted: () => true, confirm });
  const resolver = createExternalCredentialResolver({ approvals, run, parse }); resolvers.push(resolver); return { approvals, resolver, run, confirm };
}
afterEach(() => { resolvers.splice(0).forEach((r) => r.dispose()); vi.useRealTimers(); });

describe("external credential attempt", () => {
  it("synchronous provenance rechecks cancel only stale pending attempts, preserving grants and committed sessions", async () => {
    vi.useFakeTimers(); const { resolver, approvals, confirm } = setup();
    let current = true;
    const established = resolver.begin(request()); await established.resolve(); expect(established.commit()).toBe(true);
    const stale = resolver.begin({ ...request(), isCurrent: () => current }); const borrowed = await stale.resolve();
    const live = resolver.begin(request()); await live.resolve();
    const generation = approvals.generation("provider"); current = false; resolver.recheckPending();
    expect(stale.signal.aborted).toBe(true); expect(borrowed).toMatchObject({ username: "", password: "" });
    expect(established.signal.aborted).toBe(false); expect(live.signal.aborted).toBe(false);
    expect(approvals.generation("provider")).toBe(generation);
    const approved = resolver.begin({ ...request(), interaction: "noninteractive" }); await approved.resolve();
    expect(confirm).toHaveBeenCalledTimes(1); expect(live.commit()).toBe(true);
    for (const attempt of [established, stale, live, approved]) attempt.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares consent but calls runner anew for every login, including approved noninteractive logins", async () => {
    let n = 0; const run = vi.fn(async () => output(`SECRET-${++n}`)); const { resolver, confirm } = setup(run);
    const a = resolver.begin(request()); const b = resolver.begin(request()); const [one, two] = await Promise.all([a.resolve(), b.resolve()]);
    expect(confirm).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(2); expect(one).not.toBe(two); expect(one).not.toEqual(two);
    const c = resolver.begin({ ...request(), interaction: "noninteractive" }); await c.resolve(); expect(run).toHaveBeenCalledTimes(3);
    await expect(a.resolve()).rejects.toMatchObject({ code: "cancelled" });
  });
  it("declined and missing noninteractive approval never spawn", async () => {
    const { resolver, run, confirm } = setup(undefined, vi.fn(async () => false));
    await expect(resolver.begin(request()).resolve()).rejects.toMatchObject({ code: "cancelled" });
    await expect(resolver.begin({ ...request(), interaction: "noninteractive" }).resolve()).rejects.toMatchObject({ code: "approval-required" });
    expect(run).not.toHaveBeenCalled(); expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("keeps the attempt alive after result delivery and revocation prevents a pending commit", async () => {
    vi.useFakeTimers(); const { resolver, approvals } = setup(); const attempt = resolver.begin(request()); const result = await attempt.resolve();
    expect(attempt.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(1);
    const notification = vi.fn(); resolver.onDidRevoke(notification); approvals.revoke(["provider"]);
    expect(notification).toHaveBeenCalledWith(["provider"]); expect(attempt.signal.aborted).toBe(true); expect(attempt.commit()).toBe(false);
    expect(result).toMatchObject({ username: "", password: "" }); expect(vi.getTimerCount()).toBe(0);
  });
  it("successful commit removes polling and caller/revoke cancellation while disposal releases credentials", async () => {
    vi.useFakeTimers(); const { resolver } = setup(); const c = new AbortController(); let current = true;
    const attempt = resolver.begin({ ...request(c), isCurrent: () => current }); const result = await attempt.resolve();
    expect(attempt.commit()).toBe(true); expect(vi.getTimerCount()).toBe(0); current = false; c.abort(); resolver.revoke();
    expect(attempt.signal.aborted).toBe(false); expect(result).toMatchObject({ password: "SECRET" });
    attempt.dispose(); attempt.dispose(); expect(result).toMatchObject({ password: "" }); expect(attempt.signal.aborted).toBe(false);
  });
  it("fences synchronous commit even before the liveness timer fires", async () => {
    const { resolver } = setup(); let current = true; const attempt = resolver.begin({ ...request(), isCurrent: () => current }); await attempt.resolve();
    current = false; expect(attempt.commit()).toBe(false); expect(attempt.signal.aborted).toBe(true);
  });
  it("aborts predicate-only owners at 25ms while consent or a handshake is pending", async () => {
    vi.useFakeTimers(); const answer = deferred<boolean>(); const { resolver, run } = setup(undefined, vi.fn(() => answer.promise)); let current = true;
    const attempt = resolver.begin({ ...request(), isCurrent: () => current }); const pending = attempt.resolve().catch((e: unknown) => e);
    await flush(); current = false; await vi.advanceTimersByTimeAsync(24); expect(attempt.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(attempt.signal.aborted).toBe(true); expect(await pending).toMatchObject({ code: "configuration-changed" });
    answer.resolve(true); await flush(); expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    const other = setup(); let live = true; const ready = other.resolver.begin({ ...request(), isCurrent: () => live }); await ready.resolve(); live = false;
    await vi.advanceTimersByTimeAsync(25); expect(ready.signal.aborted).toBe(true); expect(ready.commit()).toBe(false);
  });
  it("wipes stdout after parsing, and owns key disposal including cancellation winning delivery", async () => {
    const bytes = output(); const key = Buffer.from("KEY-CANARY"); const c = new AbortController();
    const parse = vi.fn(() => { c.abort(); return { method: "key" as const, username: "user", privateKey: key }; });
    const { resolver } = setup(vi.fn(async () => bytes), undefined, parse);
    await expect(resolver.begin(request(c)).resolve()).rejects.toMatchObject({ code: "cancelled" }); expect(bytes.every((b) => b === 0)).toBe(true); expect(key.every((b) => b === 0)).toBe(true);
    const key2 = Buffer.from("KEY-CANARY"); const other = setup(undefined, undefined, () => ({ method: "key", username: "user", privateKey: key2 }));
    const a = other.resolver.begin(request()); await a.resolve(); a.dispose(); expect(key2.every((b) => b === 0)).toBe(true);
  });
  it("sanitizes runner, parser, predicate and abort errors and wipes rejected bytes", async () => {
    const { resolver } = setup(vi.fn(async () => { throw new Error("OUTPUT-CANARY"); }));
    const first = await resolver.begin(request()).resolve().catch((e: unknown) => e); expect(first).toMatchObject({ code: "spawn-failed" }); expect(String(first)).not.toContain("OUTPUT-CANARY");
    const bytes = output(); const other = setup(vi.fn(async () => bytes), undefined, () => { throw new Error("PARSER-CANARY"); });
    const second = await other.resolver.begin(request()).resolve().catch((e: unknown) => e); expect(second).toMatchObject({ code: "invalid-response" }); expect(String(second)).not.toContain("PARSER-CANARY"); expect(bytes.every((b) => b === 0)).toBe(true);
    const bad = resolver.begin({ ...request(), isCurrent: () => { throw new Error("PREDICATE-CANARY"); } });
    await expect(bad.resolve()).rejects.toMatchObject({ code: "configuration-changed" });
  });
});

describe("bounded provider queue", () => {
  it("admits four active and 32 queued, rejects the 37th and starts the next FIFO job on completion", async () => {
    vi.useFakeTimers(); const jobs: ReturnType<typeof deferred<Buffer>>[] = []; const run = vi.fn(() => { const job = deferred<Buffer>(); jobs.push(job); return job.promise; });
    const { resolver } = setup(run); const pending = Array.from({ length: 37 }, () => resolver.begin(request()).resolve().catch((e: unknown) => e)); await flush();
    expect(run).toHaveBeenCalledTimes(4); expect(await pending[36]).toMatchObject({ code: "queue-full" });
    jobs[0].resolve(output()); await pending[0]; await flush(); expect(run).toHaveBeenCalledTimes(5);
    resolver.dispose(); jobs.forEach((j) => j.resolve(output())); await Promise.all(pending);
  });
  it("expires queued requests exactly at 30000ms; approval waiting is not charged", async () => {
    vi.useFakeTimers(); const answer = deferred<boolean>(); const jobs = Array.from({ length: 4 }, () => deferred<Buffer>()); let n = 0;
    const { resolver, run } = setup(vi.fn(() => jobs[n++].promise), vi.fn(() => answer.promise));
    const pending = Array.from({ length: 5 }, () => resolver.begin(request()).resolve().catch((e: unknown) => e));
    await vi.advanceTimersByTimeAsync(60_000); expect(run).not.toHaveBeenCalled(); answer.resolve(true); await flush(); expect(run).toHaveBeenCalledTimes(4);
    let settled = false; void pending[4].then(() => { settled = true; }); await vi.advanceTimersByTimeAsync(29_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await pending[4]).toMatchObject({ code: "queue-timeout" });
    resolver.dispose(); jobs.forEach((j) => j.resolve(output())); await Promise.all(pending);
  });
  it("cancelled queue owners free admission and revoke terminates only matching active and queued owners", async () => {
    const jobs: ReturnType<typeof deferred<Buffer>>[] = []; const signals: AbortSignal[] = [];
    const { resolver } = setup((_inv, _method, ctx) => { signals.push(ctx.signal); const job = deferred<Buffer>(); jobs.push(job); return job.promise; });
    const controllers = Array.from({ length: 36 }, () => new AbortController());
    const pending = controllers.map((c) => resolver.begin(request(c)).resolve().catch((e: unknown) => e)); await flush();
    controllers[4].abort("ABORT-CANARY"); expect(await pending[4]).toMatchObject({ code: "cancelled" });
    const otherRequest = request(); otherRequest.profile.id = "other"; const extra = resolver.begin(otherRequest).resolve().catch((e: unknown) => e); await flush();
    resolver.revoke(["provider"]); expect(signals.every((s) => s.aborted)).toBe(true); expect(await pending[5]).toMatchObject({ code: "configuration-changed" });
    jobs.slice(0, 4).forEach((j) => j.resolve(output())); await flush(); expect(jobs).toHaveLength(5); expect(signals[4].aborted).toBe(false);
    jobs[4].resolve(output()); expect(await extra).toMatchObject({ password: "SECRET" }); await Promise.all(pending);
  });
  it("cleanup failure permanently poisons queued and future admission but preserves committed leases", async () => {
    const jobs: ReturnType<typeof deferred<Buffer>>[] = []; const { resolver } = setup(() => { const job = deferred<Buffer>(); jobs.push(job); return job.promise; });
    const established = resolver.begin(request()); const ready = established.resolve(); await flush(); jobs[0].resolve(output()); await ready; expect(established.commit()).toBe(true);
    const pending = Array.from({ length: 5 }, () => resolver.begin(request()).resolve().catch((e: unknown) => e)); await flush(); jobs[1].reject(new CredentialProviderError("cleanup-failed")); await flush();
    expect(await pending[4]).toMatchObject({ code: "cleanup-failed" }); expect(established.signal.aborted).toBe(false);
    expect(() => resolver.begin(request())).toThrow(expect.objectContaining({ code: "cleanup-failed" }));
    resolver.revoke(); expect(() => resolver.begin(request())).toThrow(expect.objectContaining({ code: "cleanup-failed" }));
    jobs.slice(2).forEach((j) => j.resolve(output())); await Promise.all(pending);
  });
  it("holds cancelled active slots until cleanup completes, then starts FIFO queued work", async () => {
    const jobs: ReturnType<typeof deferred<Buffer>>[] = []; const order: string[] = [];
    const { resolver } = setup((invocation) => { order.push(invocation.args[0]); const job = deferred<Buffer>(); jobs.push(job); return job.promise; });
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const pending = controllers.map((c, index) => { const req = request(c); req.profile.external.invocation!.args = [String(index)]; return resolver.begin(req).resolve().catch((e: unknown) => e); });
    await flush(); expect(order).toEqual(["0", "1", "2", "3"]); controllers[0].abort();
    expect(await pending[0]).toMatchObject({ code: "cancelled" }); expect(order).toHaveLength(4);
    jobs[0].resolve(output()); await flush(); expect(order).toEqual(["0", "1", "2", "3", "4"]);
    jobs[1].resolve(output()); await flush(); expect(order).toEqual(["0", "1", "2", "3", "4", "5"]);
    resolver.dispose(); jobs.forEach((j) => j.resolve(output())); await Promise.all(pending);
  });
  it("poisons admission when cleanup fails after the active caller already cancelled", async () => {
    const job = deferred<Buffer>(); const { resolver } = setup(() => job.promise); const c = new AbortController();
    const pending = resolver.begin(request(c)).resolve().catch((e: unknown) => e); await flush(); c.abort("ABORT-CANARY");
    expect(await pending).toMatchObject({ code: "cancelled" }); job.reject(new CredentialProviderError("cleanup-failed")); await flush();
    expect(() => resolver.begin(request())).toThrow(expect.objectContaining({ code: "cleanup-failed" }));
  });
  it("disposal clears pending consent and queued timers without waiting for a dialog answer", async () => {
    vi.useFakeTimers(); const answer = deferred<boolean>(); const consent = setup(undefined, vi.fn(() => answer.promise));
    const waiting = consent.resolver.begin(request()).resolve().catch((e: unknown) => e); await flush(); consent.resolver.dispose();
    expect(await waiting).toMatchObject({ code: "cancelled" }); answer.resolve(true); await flush(); expect(consent.run).not.toHaveBeenCalled();
    const job = deferred<Buffer>(); const queued = setup(() => job.promise);
    const pending = Array.from({ length: 5 }, () => queued.resolver.begin(request()).resolve().catch((e: unknown) => e)); await flush(); queued.resolver.dispose();
    expect(await pending[4]).toMatchObject({ code: "cancelled" }); expect(vi.getTimerCount()).toBe(0); job.resolve(output()); await Promise.all(pending);
  });
  it("dispose cancels consent, queued and active attempts and rejects later begin calls", async () => {
    const job = deferred<Buffer>(); const { resolver } = setup(() => job.promise); const attempt = resolver.begin(request()); const pending = attempt.resolve().catch((e: unknown) => e); await flush();
    resolver.dispose(); resolver.dispose(); expect(attempt.signal.aborted).toBe(true); expect(await pending).toMatchObject({ code: "cancelled" });
    expect(() => resolver.begin(request())).toThrow(expect.objectContaining({ code: "cancelled" })); job.resolve(output()); await flush();
  });
});
