import {
  EXTERNAL_CREDENTIAL_LIVENESS_INTERVAL_MS, EXTERNAL_CREDENTIAL_MAX_QUEUED, EXTERNAL_CREDENTIAL_MAX_RUNNING,
  EXTERNAL_CREDENTIAL_QUEUE_TIMEOUT_MS, type ExternalCredentialAttempt, type ExternalCredentialProcessRunner,
  type ExternalCredentialRequest, type ExternalCredentialResolver, type ResolvedExternalCredential
} from "./contracts";
import { CredentialProviderError, type CredentialProviderErrorCode } from "./credentialProviderError";
import type { ExternalCredentialApproval } from "./externalCredentialApproval";
import type { parseExternalCredentialResponse } from "./externalCredentialProtocol";
import { expandExternalCredentialArguments } from "./externalCredentialArguments";
import { validateExternalCredentialInvocation, type ExternalAuthProfile, type ExternalCredentialInvocation } from "../../models/authProfile";

interface PendingAttempt {
  profileId: string;
  cancel(code: CredentialProviderErrorCode): void;
  recheck(): void;
}
interface QueuedJob {
  start(): void;
  fail(code: CredentialProviderErrorCode): void;
}

/** Release extension-owned references; JavaScript strings and dependency copies cannot be erased. */
function release(result: ResolvedExternalCredential): void {
  result.username = "";
  if (result.method === "key") result.privateKey.fill(0);
  else result.password = "";
}

function safeError(error: unknown, fallback: CredentialProviderErrorCode): CredentialProviderError {
  // Rebuild even typed errors: do not retain an overridden message, cause or provider properties.
  return error instanceof CredentialProviderError ? new CredentialProviderError(error.code, error.exitCode) : new CredentialProviderError(fallback);
}

export function createExternalCredentialResolver(deps: {
  approvals: ExternalCredentialApproval;
  run: ExternalCredentialProcessRunner;
  parse: typeof parseExternalCredentialResponse;
}): ExternalCredentialResolver {
  const pending = new Set<PendingAttempt>();
  const queue: QueuedJob[] = [];
  const listeners = new Set<(ids: readonly string[] | undefined) => void>();
  let active = 0;
  let disposed = false;
  let unhealthy = false;
  const admissionFailure = (): CredentialProviderErrorCode | undefined => unhealthy ? "cleanup-failed" : disposed ? "cancelled" : undefined;
  const drain = (): void => {
    while (!admissionFailure() && active < EXTERNAL_CREDENTIAL_MAX_RUNNING && queue.length) queue.shift()!.start();
  };
  const poison = (): void => {
    unhealthy = true;
    for (const attempt of [...pending]) attempt.cancel("cleanup-failed");
    for (const job of [...queue]) job.fail("cleanup-failed");
  };
  const unsubscribe = deps.approvals.onDidRevoke((ids) => {
    const affected = ids === undefined ? undefined : new Set(ids);
    for (const attempt of [...pending]) if (!affected || affected.has(attempt.profileId)) attempt.cancel("configuration-changed");
    for (const listener of [...listeners]) {
      try { listener(ids); } catch { /* Retirement of one pool must not suppress other subscribers. */ }
    }
  });

  return {
    begin(request): ExternalCredentialAttempt {
      const unavailable = admissionFailure();
      if (unavailable) throw new CredentialProviderError(unavailable);
      const source = request.profile;
      const sourceInvocation = source.external.invocation;
      // Own both snapshots: caller mutations during consent must never change what runs.
      const profile: ExternalAuthProfile = {
        ...source, external: { ...source.external, ...(sourceInvocation && {
          invocation: { ...sourceInvocation, args: Array.isArray(sourceInvocation.args) ? [...sourceInvocation.args] : sourceInvocation.args }
        }) }
      };
      const argumentContext = request.argumentContext ? { ...request.argumentContext } : undefined;
      if (profile.external.invocation && Array.isArray(profile.external.invocation.args)) Object.freeze(profile.external.invocation.args);
      if (profile.external.invocation) Object.freeze(profile.external.invocation);
      Object.freeze(profile.external); Object.freeze(profile);
      const ownerSignal = request.signal;
      const interaction = request.interaction;
      const isOwnerCurrent = request.isCurrent;
      const controller = new AbortController();
      const epoch = deps.approvals.generation(profile.id);
      let state: "pending" | "committed" | "disposed" = "pending";
      let failure: CredentialProviderErrorCode | undefined;
      let called = false;
      let resolved = false;
      let result: ResolvedExternalCredential | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      const ownerCurrent = (): boolean => {
        try { return isOwnerCurrent(); } catch { return false; }
      };
      const releaseResult = (): void => {
        if (result) release(result);
        result = undefined;
      };
      const detach = (): void => {
        pending.delete(lease);
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        ownerSignal.removeEventListener("abort", onAbort);
      };
      const cancel = (code: CredentialProviderErrorCode): void => {
        if (state !== "pending" || failure) return;
        failure = code;
        detach();
        releaseResult();
        controller.abort();
      };
      const check = (): CredentialProviderErrorCode | undefined => {
        if (failure) return failure;
        if (state === "disposed") return "cancelled";
        if (state === "committed") return undefined;
        const code = admissionFailure() ?? (ownerSignal.aborted ? "cancelled" :
          deps.approvals.generation(profile.id) !== epoch || !ownerCurrent() ? "configuration-changed" : undefined);
        if (code) cancel(code);
        return code;
      };
      const assertCurrent = (): void => {
        const code = check();
        if (code) throw new CredentialProviderError(code);
      };
      const onAbort = (): void => cancel("cancelled");
      const lease: PendingAttempt = { profileId: profile.id, cancel, recheck: () => { check(); } };
      pending.add(lease);
      ownerSignal.addEventListener("abort", onAbort, { once: true });
      timer = setInterval(() => { check(); }, EXTERNAL_CREDENTIAL_LIVENESS_INTERVAL_MS);
      timer.unref?.();
      check();
      let invocation: ExternalCredentialInvocation | undefined;

      const retrieve = (): Promise<ResolvedExternalCredential> => new Promise((resolve, reject) => {
        let settled = false;
        let queueTimer: ReturnType<typeof setTimeout> | undefined;
        const removeQueued = (): void => {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          if (queueTimer !== undefined) clearTimeout(queueTimer);
          queueTimer = undefined;
        };
        const finish = (error?: CredentialProviderError, value?: ResolvedExternalCredential): void => {
          if (settled) { if (value) release(value); return; }
          settled = true;
          removeQueued();
          controller.signal.removeEventListener("abort", abortJob);
          if (error) reject(error); else resolve(value!);
        };
        const abortJob = (): void => finish(new CredentialProviderError(failure ?? "cancelled"));
        const job: QueuedJob = {
          fail: (code) => finish(new CredentialProviderError(code)),
          start() {
            removeQueued();
            const code = check();
            if (code) { job.fail(code); return; }
            active++;
            void (async () => {
              let bytes: Buffer | undefined;
              let value: ResolvedExternalCredential | undefined;
              let stage: CredentialProviderErrorCode = "spawn-failed";
              try {
                assertCurrent();
                bytes = await deps.run(invocation!, profile.external.method,
                  { signal: controller.signal, isCurrent: () => !check() });
                assertCurrent();
                stage = "invalid-response";
                value = deps.parse(bytes, profile.external.method);
                assertCurrent();
                finish(undefined, value);
                value = undefined;
              } catch (error) {
                const safe = safeError(error, stage);
                // Observe cleanup failure even if cancellation already settled the caller's promise.
                if (safe.code === "cleanup-failed") poison();
                finish(safe);
              } finally {
                bytes?.fill(0);
                if (value) release(value);
                active--;
                drain();
              }
            })();
          }
        };
        controller.signal.addEventListener("abort", abortJob, { once: true });
        const code = check();
        if (code) { job.fail(code); return; }
        if (active < EXTERNAL_CREDENTIAL_MAX_RUNNING) job.start();
        else if (queue.length >= EXTERNAL_CREDENTIAL_MAX_QUEUED) job.fail("queue-full");
        else {
          queue.push(job);
          queueTimer = setTimeout(() => job.fail("queue-timeout"), EXTERNAL_CREDENTIAL_QUEUE_TIMEOUT_MS);
          queueTimer.unref?.();
        }
      });

      return {
        signal: controller.signal,
        isCurrent: () => !check(),
        async resolve() {
          if (called || state !== "pending") throw new CredentialProviderError("cancelled");
          called = true;
          try {
            assertCurrent();
            const configured = profile.external.invocation;
            if (!validateExternalCredentialInvocation(configured)) throw new CredentialProviderError("unconfigured");
            if (configured.argumentExpansion === true) {
              if (!argumentContext) throw new CredentialProviderError("invalid-template");
              invocation = Object.freeze({ executable: configured.executable, args: Object.freeze(expandExternalCredentialArguments(configured.args, argumentContext)) });
            } else invocation = configured;
            const approvedRequest: ExternalCredentialRequest = { profile, signal: controller.signal, interaction,
              isCurrent: () => !check(), ...(configured.argumentExpansion === true && { resolvedInvocation: invocation }) };
            await deps.approvals.authorize(approvedRequest);
            assertCurrent();
            const value = await retrieve();
            // Cancellation can win between the process promise and this continuation.
            result = value;
            const code = check();
            if (code) { releaseResult(); throw new CredentialProviderError(code); }
            resolved = true;
            return value;
          } catch (error) {
            const safe = safeError(error, "approval-required");
            cancel(failure ?? safe.code);
            throw new CredentialProviderError(failure ?? safe.code, safe.exitCode);
          }
        },
        commit() {
          if (state !== "pending" || !resolved || check()) return false;
          state = "committed";
          detach();
          return true;
        },
        dispose() {
          if (state === "disposed") return;
          cancel("cancelled");
          state = "disposed";
          detach();
          releaseResult();
        }
      };
    },
    recheckPending() {
      for (const attempt of [...pending]) attempt.recheck();
    },
    revoke: (ids) => deps.approvals.revoke(ids),
    onDidRevoke(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const attempt of [...pending]) attempt.cancel("cancelled");
      for (const job of [...queue]) job.fail("cancelled");
      unsubscribe();
      listeners.clear();
      deps.approvals.dispose();
    }
  };
}
