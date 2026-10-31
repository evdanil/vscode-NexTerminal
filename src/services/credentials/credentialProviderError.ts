export type CredentialProviderErrorCode =
  | "unconfigured"
  | "untrusted-workspace"
  | "approval-required"
  | "cancelled"
  | "configuration-changed"
  | "queue-full"
  | "queue-timeout"
  | "spawn-failed"
  | "invalid-template"
  | "timed-out"
  | "cleanup-failed"
  | "output-too-large"
  | "exited"
  | "invalid-response"
  | "unsupported-consumer";

const messages: Record<CredentialProviderErrorCode, string> = {
  unconfigured: "External credential program is not configured. Edit the Auth Profile to configure it.",
  "untrusted-workspace": "External credential programs require a trusted workspace.",
  "approval-required": "External credential program requires approval. Start an interactive SSH connection to approve it.",
  cancelled: "External credential request was cancelled.",
  "configuration-changed": "External credential configuration changed. Start a new connection.",
  "queue-full": "External credential request queue is full. Try again after another request finishes.",
  "queue-timeout": "External credential request timed out while queued.",
  "spawn-failed": "External credential program could not start. Check the executable and arguments in the Auth Profile.",
  "invalid-template": "External credential arguments could not be expanded. Check the Auth Profile argument placeholders and the server lookup username.",
  "timed-out": "External credential program timed out.",
  "cleanup-failed": "External credential program could not be stopped. Restart the extension host before trying again.",
  "output-too-large": "External credential program exceeded its output limit.",
  exited: "External credential program exited without a complete successful response.",
  "invalid-response": "External credential program returned an invalid response.",
  "unsupported-consumer": "External credential programs are unavailable for this operation. Choose a supported Auth Profile."
};

/** Accepts controlled codes only: provider output and raw exceptions must never become error context. */
export class CredentialProviderError extends Error {
  public readonly code: CredentialProviderErrorCode;
  public readonly exitCode?: number;

  public constructor(code: CredentialProviderErrorCode, exitCode?: number) {
    const safeExitCode = Number.isSafeInteger(exitCode) ? exitCode : undefined;
    super(messages[code] + (safeExitCode === undefined ? "" : ` Exit code: ${safeExitCode}.`));
    this.name = "CredentialProviderError";
    this.code = code;
    if (safeExitCode !== undefined) this.exitCode = safeExitCode;
  }
}

/** Follow only Error causes; wrapper text must never become provider diagnostics. */
export function findCredentialProviderError(error: unknown): CredentialProviderError | undefined {
  const seen = new Set<Error>();
  for (let cause = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (cause instanceof CredentialProviderError) return new CredentialProviderError(cause.code, cause.exitCode);
  }
  return undefined;
}
