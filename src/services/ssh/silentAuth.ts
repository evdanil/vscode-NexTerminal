import type { Duplex } from "node:stream";
import type { AuthProfile, ServerConfig } from "../../models/config";
import { authProfileOwnedCredentials } from "../../models/config";
import type {
  KeyboardInteractiveHandler,
  PasswordPrompt,
  PasswordPromptResult,
  SecretVault,
  SshConnection,
  SshConnector,
  SshFactory
} from "./contracts";

export type InputPromptFn = (message: string, password: boolean) => Promise<string | undefined>;

export function passwordSecretKey(serverId: string): string {
  return `password-${serverId}`;
}

export function passphraseSecretKey(serverId: string): string {
  return `passphrase-${serverId}`;
}

export function proxyPasswordSecretKey(serverId: string): string {
  return `proxy-password-${serverId}`;
}

/**
 * Deletes every secret saved under a server's own id — its password, key
 * passphrase and proxy password. Every path that deletes a server calls this,
 * so a key added here is deleted by all of them.
 *
 * By default the first failed delete rejects, for a caller that has not removed
 * the record yet and can stop. `bestEffort` is for cleanup after the record is
 * already gone: a failed key is logged and the rest are still attempted, so one
 * rejection does not strand the others.
 */
export async function deleteServerSecrets(
  vault: SecretVault,
  serverId: string,
  options: { bestEffort?: boolean } = {}
): Promise<void> {
  for (const key of [passwordSecretKey(serverId), passphraseSecretKey(serverId), proxyPasswordSecretKey(serverId)]) {
    if (!options.bestEffort) {
      await vault.delete(key);
      continue;
    }
    try {
      await vault.delete(key);
    } catch (error) {
      console.warn(`[Nexus] Failed to delete secret key "${key}":`, error);
    }
  }
}

export function authProfilePasswordSecretKey(profileId: string): string {
  return `auth-profile-password-${profileId}`;
}

export function authProfilePassphraseSecretKey(profileId: string): string {
  return `auth-profile-passphrase-${profileId}`;
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("authentication") ||
    message.includes("auth fail") ||
    message.includes("all configured authentication methods failed")
  );
}

function isPassphraseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("encrypted") || message.includes("passphrase") || message.includes("bad decrypt");
}

/** A prompted password or passphrase being asked for, or answered and not yet settled. */
interface SharedPromptAnswer {
  /** What it was typed for: a password's `user@host:port` and route, a passphrase's key file. */
  typedFor: string;
  answer: Promise<PasswordPromptResult | undefined>;
}

export class SilentAuthSshFactory implements SshFactory {
  /**
   * Per vault key: the prompted answer shared by every login that reaches the
   * prompt before one that used it settles. The pool joins its own consumers
   * onto one pending connect per server, but isolated-mode tunnel clients — and
   * any consumer when multiplexing is off — log in on their own, in parallel.
   * VS Code shows one input box at a time, so a second prompt dismissed the
   * first, which read as a cancel and failed that login (issue #177).
   *
   * Keyed by the vault key the answer would be saved under, so only logins
   * that already share a credential share its answer: one server, or the
   * servers linked to one auth profile. `typedFor` then keeps a password on the
   * endpoint it was typed for — an edit or a sync can repoint a server while
   * its prompt is open, and the servers on a profile are different devices —
   * and a passphrase on its key file.
   *
   * A password is also kept on its route, as `ProxySshFactory` gives it: the
   * live jump-host connection the login's socket is opened through, or the
   * endpoint of the SOCKS5/HTTP proxy it dials. The same `user@host:port`
   * reached another way can be another machine — lab networks reuse private
   * addresses — and a password the user typed for one, perhaps choosing not to
   * save it, must not reach the other because an edit or a sync re-pointed the
   * server, or one of its jump hosts, while the prompt was open. A login
   * through a proxy whose route the caller did not give is never shared. A
   * passphrase has no route: it unlocks the key file here and is never sent
   * anywhere.
   */
  private readonly sharedAnswers = new Map<string, SharedPromptAnswer>();

  public constructor(
    private readonly connector: SshConnector,
    private readonly vault: SecretVault,
    private readonly prompt: PasswordPrompt,
    private readonly inputPromptFn?: InputPromptFn,
    private readonly authProfileLookup?: (id: string) => AuthProfile | undefined
  ) {}

  private resolveServer(
    server: ServerConfig
  ): {
    resolved: ServerConfig;
    passwordKey: string;
    passphraseKey: string;
    legacyServerPassphraseKey?: string;
    profileScoped: boolean;
  } {
    if (!server.authProfileId || !this.authProfileLookup) {
      return {
        resolved: server,
        passwordKey: passwordSecretKey(server.id),
        passphraseKey: passphraseSecretKey(server.id),
        profileScoped: false
      };
    }
    const profile = this.authProfileLookup(server.authProfileId);
    if (!profile) {
      return {
        resolved: server,
        passwordKey: passwordSecretKey(server.id),
        passphraseKey: passphraseSecretKey(server.id),
        profileScoped: false
      };
    }
    // REVIEW FINDING (P2) — only the fields the profile actually SUPPLIES are
    // taken over (authProfileOwnedCredentials, models/config.ts); the server
    // keeps its own value for the rest. This used to overwrite all three
    // unconditionally, so an imported profile with a whitespace-only username
    // replaced every linked server's working username with whitespace — for a
    // synced server, the very fallback `fallbackUsernameForSource` had just
    // taken care to store — and a `key` profile with no key path blanked the
    // server's own `keyPath`, the one the server form now lets you set
    // precisely because the profile does not supply it.
    const resolved: ServerConfig = { ...server, ...authProfileOwnedCredentials(profile) };
    return {
      resolved,
      passwordKey: resolved.authType === "password" ? authProfilePasswordSecretKey(profile.id) : passwordSecretKey(server.id),
      passphraseKey: resolved.authType === "key" ? authProfilePassphraseSecretKey(profile.id) : passphraseSecretKey(server.id),
      legacyServerPassphraseKey: resolved.authType === "key" ? passphraseSecretKey(server.id) : undefined,
      // The active credential key (the one matching the resolved authType) is
      // shared by EVERY server linked to this profile. A rejection on one
      // server must not erase what the others still authenticate with, so
      // deletion sites consult this flag — see the catch blocks in connect().
      profileScoped: true
    };
  }

  private buildKeyboardInteractiveHandler(
    password?: string,
    onAuthMessage?: (text: string) => void
  ): KeyboardInteractiveHandler | undefined {
    if (!this.inputPromptFn) {
      return undefined;
    }
    const promptFn = this.inputPromptFn;
    return async (name, instructions, prompts) => {
      // OpenSSH delivers MFA context (e.g. Duo's option menu) via these two
      // fields ahead of the prompts. Surface them before prompting so the
      // user isn't shown a bare input box with no context. Display is
      // best-effort — a throwing sink must not abort authentication.
      if (onAuthMessage) {
        if (name.trim()) {
          try {
            onAuthMessage(name);
          } catch {
            // ignore — see comment above
          }
        }
        if (instructions.trim()) {
          try {
            onAuthMessage(instructions);
          } catch {
            // ignore — see comment above
          }
        }
      }
      const responses: string[] = [];
      for (const p of prompts) {
        const isPasswordPrompt = /password/i.test(p.prompt);
        if (isPasswordPrompt && password) {
          responses.push(password);
        } else {
          const answer = await promptFn(p.prompt, !p.echo);
          if (answer === undefined) {
            throw new Error("Keyboard-interactive authentication canceled");
          }
          responses.push(answer);
        }
      }
      return responses;
    };
  }

  /**
   * Connect to `server`, prompting the user for credentials when saved
   * credentials are missing or rejected.
   *
   * `options.sockFactory`, when provided, is invoked once **per internal
   * SSH-handshake attempt** (saved-credential attempt and prompted retry are
   * separate attempts). It MUST be idempotent: each call must return an
   * **independent** `Duplex` (a fresh tunnel stream / fresh upstream socket /
   * etc.). Reusing one `Duplex` across attempts breaks `ssh2` — once the
   * stream has been consumed by a failed handshake there is no SSH banner
   * left for the retry to read, and the retry hangs until `readyTimeout`
   * (~60s).
   *
   * The sock from a failed attempt is `.destroy()`'d before the next attempt
   * is started or the error is rethrown; the sock that backs a successful
   * `connector.connect` is retained by the returned `SshConnection`.
   */
  public async connect(
    server: ServerConfig,
    options?: {
      sockFactory?: () => Promise<Duplex>;
      onAuthMessage?: (text: string) => void;
      /**
       * The route this login takes to the server, as `ProxySshFactory`
       * identifies it; see `sharedAnswers`. Asked again once the socket is
       * open, because opening it can move a pooled jump connection onto a
       * fallback of its own.
       */
      route?: () => string;
    }
  ): Promise<SshConnection> {
    const { resolved, passwordKey, passphraseKey, legacyServerPassphraseKey, profileScoped } = this.resolveServer(server);

    if (resolved.authType === "key") {
      const handler = this.buildKeyboardInteractiveHandler(undefined, options?.onAuthMessage);
      const savedPassphrase = await this.vault.get(passphraseKey);

      // Try saved passphrase (or no passphrase on first attempt).
      const firstSock = await options?.sockFactory?.();
      try {
        return await this.connector.connect(resolved, {
          ...(savedPassphrase && { passphrase: savedPassphrase }),
          ...(handler && { onKeyboardInteractive: handler }),
          ...(firstSock && { sock: firstSock }),
          ...(options?.onAuthMessage && { onAuthMessage: options.onAuthMessage })
        });
      } catch (error) {
        firstSock?.destroy();
        if (!isPassphraseError(error)) {
          throw error;
        }
        // Saved passphrase was wrong — clear it. A profile-scoped passphrase
        // is shared by every linked server, and a rejection on this one does
        // not prove the others are wrong too, so it stays: the next attempt
        // on this server retries it once and prompts, while the rest of the
        // fleet keeps authenticating silently.
        if (savedPassphrase && !profileScoped) {
          await this.vault.delete(passphraseKey);
        }
      }

      // Prompt user for passphrase — or join the prompt already open for it.
      const prompted = await this.promptShared(passphraseKey, resolved.keyPath ?? "", () =>
        this.prompt.prompt({
          ...resolved,
          name: `${server.name} (key passphrase)`
        })
      );
      if (!prompted) {
        throw new Error(`Passphrase entry canceled for ${server.name}`);
      }
      const { result: promptResult, settle } = prompted;

      try {
        const secondSock = await options?.sockFactory?.();

        // Stage A — establish connection. Narrow try scope so vault ops cannot
        // trigger the catch that destroys the live sock.
        // Note: onAuthMessage may render the banner/KI context a second time
        // here (once for the failed saved-passphrase attempt, once for this
        // prompted retry) — intentional, mirrors re-running ssh by hand.
        let connection: SshConnection;
        try {
          connection = await this.connector.connect(resolved, {
            passphrase: promptResult.password,
            ...(handler && { onKeyboardInteractive: handler }),
            ...(secondSock && { sock: secondSock }),
            ...(options?.onAuthMessage && { onAuthMessage: options.onAuthMessage })
          });
        } catch (error) {
          secondSock?.destroy();
          throw error;
        }

        // Stage B — persist credentials, best-effort. A transient SecretStorage
        // failure must not destroy the live SSH connection the user just
        // authenticated; the natural fallback is being re-prompted next time.
        // Note: if the legacy vault.delete throws after the primary vault.store
        // succeeded, the entire catch fires and Stage B is abandoned. That is
        // acceptable — the legacy delete is cleanup of a stale key and missing
        // it is not security-relevant.
        try {
          if (promptResult.save) {
            await this.vault.store(passphraseKey, promptResult.password);
            if (legacyServerPassphraseKey && legacyServerPassphraseKey !== passphraseKey) {
              await this.vault.delete(legacyServerPassphraseKey);
            }
          } else if (!profileScoped) {
            // Declining to save replaces the stored credential for a server —
            // but a profile-scoped passphrase belongs to the whole fleet, and
            // "don't save this one" must not erase what other servers still
            // authenticate with. Clearing a profile passphrase is done through
            // the profile editor, not here.
            await this.vault.delete(passphraseKey);
          }
        } catch (vaultErr) {
          console.error(
            `[Nexus SSH] Could not ${promptResult.save ? "save" : "clear"} passphrase for ${server.name}; ` +
              "the session is connected but credentials may not be persisted.",
            vaultErr
          );
        }

        return connection;
      } finally {
        settle();
      }
    }

    if (resolved.authType !== "password") {
      const handler = this.buildKeyboardInteractiveHandler(undefined, options?.onAuthMessage);
      const sock = await options?.sockFactory?.();
      try {
        return await this.connector.connect(resolved, {
          ...(handler && { onKeyboardInteractive: handler }),
          ...(sock && { sock }),
          ...(options?.onAuthMessage && { onAuthMessage: options.onAuthMessage })
        });
      } catch (error) {
        sock?.destroy();
        throw error;
      }
    }

    const savedPassword = await this.vault.get(passwordKey);
    if (savedPassword) {
      const handler = this.buildKeyboardInteractiveHandler(savedPassword, options?.onAuthMessage);
      const firstSock = await options?.sockFactory?.();
      try {
        return await this.connector.connect(resolved, {
          password: savedPassword,
          ...(handler && { onKeyboardInteractive: handler }),
          ...(firstSock && { sock: firstSock }),
          ...(options?.onAuthMessage && { onAuthMessage: options.onAuthMessage })
        });
      } catch (error) {
        firstSock?.destroy();
        if (!isAuthError(error)) {
          throw error;
        }
        // Saved password was wrong for this server — clear it so the next
        // attempt prompts instead of retrying a rejected credential. A
        // profile-scoped password is shared by every linked server, and this
        // server's rejection does not prove the others are wrong too, so it
        // stays: this server retries it once and prompts, while the rest of
        // the fleet keeps authenticating silently.
        if (!profileScoped) {
          await this.vault.delete(passwordKey);
        }
      }
    }

    // Prompt user for the password — or join the prompt already open for it.
    const route = options?.route?.() ?? (resolved.proxy ? undefined : "direct");
    const prompted = await this.promptShared(
      passwordKey,
      route === undefined ? undefined : `${resolved.username}@${resolved.host}:${resolved.port} via ${route}`,
      () => this.prompt.prompt({ ...resolved, name: server.name })
    );
    if (!prompted) {
      throw new Error(`Password entry canceled for ${server.name}`);
    }
    const { result: promptResult, settle, joined } = prompted;

    try {
      const handler = this.buildKeyboardInteractiveHandler(promptResult.password, options?.onAuthMessage);
      const secondSock = await options?.sockFactory?.();
      if (joined && options?.route && options.route() !== route) {
        // Opening the socket moved this login onto another route — a pooled
        // jump connection falling back to one of its own, made from the jump
        // host's configuration as the lease found it. The answer it joined was
        // typed for another login's route and is not sent. Failed rather than
        // asked again: a second prompt here is the one the sharing exists to
        // avoid, and a retry leases a fresh jump connection of its own.
        secondSock?.destroy();
        throw new Error(
          `The route to ${server.name} changed while its password was being entered, so the password was not sent. Connect again.`
        );
      }

      // Stage A — establish connection. Narrow try scope so vault ops cannot
      // trigger the catch that destroys the live sock.
      // Note: onAuthMessage may render the banner/KI context a second time
      // here (once for the failed saved-password attempt, once for this
      // prompted retry) — intentional, mirrors re-running ssh by hand.
      let connection: SshConnection;
      try {
        connection = await this.connector.connect(resolved, {
          password: promptResult.password,
          ...(handler && { onKeyboardInteractive: handler }),
          ...(secondSock && { sock: secondSock }),
          ...(options?.onAuthMessage && { onAuthMessage: options.onAuthMessage })
        });
      } catch (error) {
        secondSock?.destroy();
        throw error;
      }

      // Stage B — persist credentials, best-effort. A transient SecretStorage
      // failure must not destroy the live SSH connection the user just
      // authenticated; the natural fallback is being re-prompted next time.
      try {
        if (promptResult.save) {
          await this.vault.store(passwordKey, promptResult.password);
        } else if (!profileScoped) {
          // Declining to save replaces the stored credential for a server —
          // but a profile-scoped password belongs to the whole fleet, and
          // "don't save this one" must not erase what other servers still
          // authenticate with. Clearing a profile password is done through the
          // profile editor, not here.
          await this.vault.delete(passwordKey);
        }
      } catch (vaultErr) {
        console.error(
          `[Nexus SSH] Could not ${promptResult.save ? "save" : "clear"} password for ${server.name}; ` +
            "the session is connected but credentials may not be persisted.",
          vaultErr
        );
      }

      return connection;
    } finally {
      settle();
    }
  }

  /**
   * Asks for the credential saved under `vaultKey`, or joins the prompt already
   * open — or answered, with its login still in flight — for the same key and
   * the same `typedFor` (see `sharedAnswers`); an undefined `typedFor` is
   * never shared. A cancel is every waiting
   * login's cancel, and the next login asks again. An answer is shared until
   * `settle()`, which each login that used it calls once it has succeeded (and
   * saved it, if asked to) or failed: settled only after the save, so a login
   * arriving in between still finds the answer; from then on the vault is the
   * source of truth, and a failed answer — which may be what failed — or one
   * the user chose not to save is asked for afresh.
   */
  private async promptShared(
    vaultKey: string,
    typedFor: string | undefined,
    ask: () => Promise<PasswordPromptResult | undefined>
  ): Promise<{ result: PasswordPromptResult; settle: () => void; joined: boolean } | undefined> {
    if (typedFor === undefined) {
      const result = await ask();
      return result ? { result, settle: () => {}, joined: false } : undefined;
    }
    let shared = this.sharedAnswers.get(vaultKey);
    const joined = shared !== undefined && shared.typedFor === typedFor;
    if (!shared || !joined) {
      shared = { typedFor, answer: ask() };
      this.sharedAnswers.set(vaultKey, shared);
    }
    const own = shared;
    // Only our own entry: one asked for another endpoint may have replaced it.
    const settle = (): void => {
      if (this.sharedAnswers.get(vaultKey) === own) {
        this.sharedAnswers.delete(vaultKey);
      }
    };
    let result: PasswordPromptResult | undefined;
    try {
      result = await own.answer;
    } finally {
      // Cancelled (or the prompt threw): nothing to share, so the next login asks again.
      if (!result) {
        settle();
      }
    }
    return result ? { result, settle, joined } : undefined;
  }
}
