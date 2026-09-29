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

  public constructor(message: string) {
    super(message);
    this.name = "AuthNotJudgedError";
  }
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
