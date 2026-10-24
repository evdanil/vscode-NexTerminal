/**
 * A login that ended without the server ruling on the credential.
 *
 * The saved-credential catch in `SilentAuthSshFactory` deletes a stored
 * password or passphrase only when the server rejected it. These failures say
 * nothing about the credential — the owner went away, the transport dropped
 * mid-handshake, or the user dismissed a prompt — so they carry an identity
 * rather than message text: their wording contains "authentication", which a
 * substring classifier would read as a rejection and delete a valid secret.
 */
export class AuthNotJudgedError extends Error {
  public readonly code = "NEXUS_AUTH_NOT_JUDGED";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthNotJudgedError";
  }
}

/**
 * An SSH Agent login that has no agent key to offer: no agent was found, the
 * one chosen cannot be used, or it holds no keys (`sshAgentLocator.ts`).
 *
 * The message is the remedy shown to the user. It extends `AuthNotJudgedError`
 * because the server never ruled on the agent's key, so no saved secret may
 * be deleted for it, whatever the wording.
 *
 * `proceedWithoutAgent` marks the two cases that are simply "no agent key":
 * nothing found in auto mode, and an agent that holds no keys. Before agent
 * discovery existed those logins went on with the server's other methods (a
 * keyboard-interactive password prompt, which network devices commonly
 * offer), so they still do, and this message replaces ssh2's "All configured
 * authentication methods failed" only if the server then refuses them too.
 * Every other case is a choice the user made that cannot be honoured, and the
 * login is refused before anything is dialled.
 */
export class SshAgentUnavailableError extends AuthNotJudgedError {
  public readonly proceedWithoutAgent: boolean;

  public constructor(message: string, options?: { proceedWithoutAgent?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SshAgentUnavailableError";
    this.proceedWithoutAgent = options?.proceedWithoutAgent === true;
  }
}

/** The `SshAgentUnavailableError` in `error` or its `cause` chain, if any. */
export function findSshAgentUnavailable(error: unknown): SshAgentUnavailableError | undefined {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++) {
    if (error instanceof SshAgentUnavailableError) {
      return error;
    }
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True for `AuthNotJudgedError` and for any error that wraps one as its `cause`. */
export function isAuthNotJudged(error: unknown): boolean {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++) {
    if (error instanceof AuthNotJudgedError || (error as { code?: unknown }).code === "NEXUS_AUTH_NOT_JUDGED") {
      return true;
    }
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}
