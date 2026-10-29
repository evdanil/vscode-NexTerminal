import type { ExternalAuthProfile, ExternalCredentialInvocation } from "../../models/authProfile";
import type { SshInteractionPolicy } from "../ssh/contracts";

export const EXTERNAL_CREDENTIAL_PROCESS_TIMEOUT_MS = 30_000;
export const EXTERNAL_CREDENTIAL_STDOUT_MAX_BYTES = 256 * 1024;
export const EXTERNAL_CREDENTIAL_STDERR_MAX_BYTES = 64 * 1024;
export const EXTERNAL_CREDENTIAL_USERNAME_MAX_BYTES = 1024;
export const EXTERNAL_CREDENTIAL_PASSWORD_MAX_BYTES = 64 * 1024;
export const EXTERNAL_CREDENTIAL_PRIVATE_KEY_MAX_BYTES = 192 * 1024;
export const EXTERNAL_CREDENTIAL_MAX_RUNNING = 4;
export const EXTERNAL_CREDENTIAL_MAX_QUEUED = 32;
export const EXTERNAL_CREDENTIAL_QUEUE_TIMEOUT_MS = 30_000;
export const EXTERNAL_CREDENTIAL_TERMINATION_GRACE_MS = 250;
export const EXTERNAL_CREDENTIAL_STREAM_DRAIN_GRACE_MS = 250;
export const EXTERNAL_CREDENTIAL_CLEANUP_TIMEOUT_MS = 1000;
export const EXTERNAL_CREDENTIAL_LIVENESS_INTERVAL_MS = 25;

export type ResolvedExternalCredential =
  | { method: "password"; username: string; password: string }
  | { method: "key"; username: string; privateKey: Buffer };

export interface ExternalCredentialRequest {
  /** Immutable configuration snapshot, never a provider response. */
  profile: ExternalAuthProfile;
  signal: AbortSignal;
  interaction: SshInteractionPolicy;
  isCurrent(): boolean;
}

export interface ExternalCredentialAttempt {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /**
   * May be called once per attempt; results are never shared or cached. The
   * returned value is borrowed until dispose/cancellation: cancellation clears
   * its fields and zeros key bytes synchronously, before notifying abort listeners.
   * Consumers needing bytes beyond that boundary must own and dispose a copy.
   */
  resolve(): Promise<ResolvedExternalCredential>;
  /** Synchronously fences connection delivery against revocation and stale configuration. */
  commit(): boolean;
  dispose(): void;
}

export interface ExternalCredentialResolver {
  begin(request: ExternalCredentialRequest): ExternalCredentialAttempt;
  revoke(profileIds?: readonly string[]): void;
  onDidRevoke(listener: (profileIds: readonly string[] | undefined) => void): () => void;
  dispose(): void;
}

/** The successful stdout buffer transfers to the caller, which must wipe it after parsing. */
export type ExternalCredentialProcessRunner = (
  invocation: ExternalCredentialInvocation,
  method: "password" | "key",
  context: { signal: AbortSignal; isCurrent(): boolean }
) => Promise<Buffer>;
