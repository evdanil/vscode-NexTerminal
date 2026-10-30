import { authProfileConnectionIdentity, validateExternalCredentialInvocation, type ExternalAuthProfile } from "../../models/authProfile";
import type { ExternalCredentialRequest } from "./contracts";
import { CredentialProviderError, type CredentialProviderErrorCode } from "./credentialProviderError";

export interface ExternalCredentialApproval {
  authorize(request: ExternalCredentialRequest): Promise<void>;
  generation(profileId: string): number;
  revoke(profileIds?: readonly string[]): void;
  /** Synchronous invalidation, including when revocation originates outside the resolver. */
  onDidRevoke(listener: (profileIds: readonly string[] | undefined) => void): () => void;
  dispose(): void;
}

interface Owner {
  request: ExternalCredentialRequest;
  finish(code?: CredentialProviderErrorCode): void;
}
interface Question {
  profileId: string;
  generation: number;
  controller: AbortController;
  owners: Set<Owner>;
}

export function createExternalCredentialApproval(deps: {
  isWorkspaceTrusted(): boolean;
  confirm(profile: ExternalAuthProfile, signal: AbortSignal): Promise<boolean>;
}): ExternalCredentialApproval {
  const grants = new Map<string, string>();
  const generations = new Map<string, number>();
  const questions = new Map<string, Question>();
  const listeners = new Set<(ids: readonly string[] | undefined) => void>();
  let disposed = false;
  const generation = (id: string): number => {
    if (!generations.has(id)) generations.set(id, 0);
    return generations.get(id)!;
  };
  const current = (request: ExternalCredentialRequest): boolean => {
    try { return request.isCurrent(); } catch { return false; }
  };
  const trusted = (): boolean => {
    try { return deps.isWorkspaceTrusted(); } catch { return false; }
  };
  const invalid = (owner: Owner, question: Question, key: string): CredentialProviderErrorCode | undefined => {
    if (disposed || owner.request.signal.aborted) return "cancelled";
    if (generation(question.profileId) !== question.generation || !current(owner.request) ||
      JSON.stringify(authProfileConnectionIdentity(owner.request.profile)) !== key) return "configuration-changed";
    if (!trusted()) return "untrusted-workspace";
    return undefined;
  };
  const finishQuestion = (key: string, question: Question, allowed: boolean, failure?: CredentialProviderErrorCode): void => {
    if (questions.get(key) !== question) return;
    questions.delete(key);
    const owners = [...question.owners];
    const outcomes = owners.map((owner) => invalid(owner, question, key) ?? failure ?? (allowed ? undefined : "cancelled"));
    if (outcomes.some((code) => code === undefined)) grants.set(key, question.profileId);
    owners.forEach((owner, index) => owner.finish(outcomes[index]));
  };
  const revoke = (ids?: readonly string[]): void => {
    const affected = ids === undefined ? undefined : new Set(ids);
    for (const id of affected ?? generations.keys()) generations.set(id, generation(id) + 1);
    for (const [key, id] of grants) if (!affected || affected.has(id)) grants.delete(key);
    for (const [key, question] of questions) {
      if (affected && !affected.has(question.profileId)) continue;
      questions.delete(key);
      question.controller.abort();
      for (const owner of [...question.owners]) owner.finish(disposed ? "cancelled" : "configuration-changed");
    }
    const notification = ids === undefined ? undefined : Object.freeze([...ids]);
    for (const listener of [...listeners]) {
      try { listener(notification); } catch { /* One consumer must not suppress other cancellation handlers. */ }
    }
  };
  return {
    generation,
    revoke,
    onDidRevoke(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async authorize(request) {
      if (disposed || request.signal.aborted) throw new CredentialProviderError("cancelled");
      if (!current(request)) throw new CredentialProviderError("configuration-changed");
      if (!trusted()) throw new CredentialProviderError("untrusted-workspace");
      const { profile } = request;
      if (profile.external.version !== 1 || !["password", "key"].includes(profile.external.method) ||
        !validateExternalCredentialInvocation(profile.external.invocation)) throw new CredentialProviderError("unconfigured");
      const key = JSON.stringify(authProfileConnectionIdentity(profile));
      const epoch = generation(profile.id);
      if (grants.has(key)) return;
      if (request.interaction !== "interactive") throw new CredentialProviderError("approval-required");
      let question = questions.get(key);
      const start = !question;
      if (!question) {
        question = { profileId: profile.id, generation: epoch, controller: new AbortController(), owners: new Set() };
        questions.set(key, question);
      }
      const shared = question;
      const promise = new Promise<void>((resolve, reject) => {
        const onAbort = (): void => owner.finish("cancelled");
        const owner: Owner = { request, finish(code) {
          if (!shared.owners.delete(owner)) return;
          request.signal.removeEventListener("abort", onAbort);
          if (shared.owners.size === 0) {
            if (questions.get(key) === shared) questions.delete(key);
            shared.controller.abort();
          }
          if (code) reject(new CredentialProviderError(code)); else resolve();
        } };
        shared.owners.add(owner);
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      });
      if (start) {
        // Joiners register synchronously before the native dialog is opened.
        void Promise.resolve().then(() => shared.controller.signal.aborted ? false : deps.confirm(profile, shared.controller.signal))
          .then((allowed) => finishQuestion(key, shared, allowed), () => finishQuestion(key, shared, false, "approval-required"));
      }
      return promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      revoke();
      listeners.clear();
    }
  };
}
