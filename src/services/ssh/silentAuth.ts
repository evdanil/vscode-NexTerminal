import type { Duplex } from "node:stream";
import type { AuthProfile, ServerConfig } from "../../models/config";
import { authProfileOwnedCredentials } from "../../models/config";
import { configMutationLock } from "../configMutationLock";
import type {
  KeyboardInteractiveHandler,
  PasswordPrompt,
  PasswordPromptResult,
  SecretVault,
  SshConnection,
  SshConnector,
  SshFactory
} from "./contracts";

export type InputPromptFn = (message: string, password: boolean, signal?: AbortSignal) => Promise<string | undefined>;

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

interface PromptAnswerProvenance {
  serverId: string;
  record: ServerConfig | null;
  endpointSignature: string;
  /** Whether `record` is authoritative enough to detect same-ID Replace. */
  recordIdentityAvailable: boolean;
}

/** A prompted password or passphrase being asked for, or answered and not yet settled. */
interface SharedPromptAnswer {
  /** What it was typed for: a password's complete endpoint and route, a passphrase's key file. */
  typedFor: string;
  /** Keep the prompt owner's record as the authority for any later vault write. */
  provenance?: PromptAnswerProvenance;
  answer: Promise<PasswordPromptResult | undefined>;
  /** A current joiner can own the prompt if the original request goes stale. */
  requests: Array<{
    ask: () => Promise<PasswordPromptResult | undefined>;
    provenance?: PromptAnswerProvenance;
    isActive?: () => boolean;
  }>;
  cancellationError?: Error;
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
  // A shared answer avoids duplicate questions; this queue also keeps distinct
  // credentials, proxy passwords and keyboard-interactive challenges from hiding one another.
  private promptTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly connector: SshConnector,
    private readonly vault: SecretVault,
    private readonly prompt: PasswordPrompt,
    private readonly inputPromptFn?: InputPromptFn,
    private readonly authProfileLookup?: (id: string) => AuthProfile | undefined,
    private readonly liveServerLookup?: (id: string) => ServerConfig | undefined
  ) {}

  /**
   * Captures the config identity a prompted SSH credential was authenticated
   * against, including profile-owned auth fields and every hop in its route.
   * ProxySshFactory calls this before opening a proxy/jump connection, so a
   * config replacement during that work cannot make a later target handshake
   * look as though it started on the new route.
   */
  public getCredentialEndpointSignature(
    server: ServerConfig,
    serverLookup: ((id: string) => ServerConfig | undefined) | undefined = this.liveServerLookup,
    visited: ReadonlySet<string> = new Set<string>()
  ): string {
    if (visited.has(server.id)) {
      return JSON.stringify(["cycle", server.id]);
    }
    const nextVisited = new Set(visited);
    nextVisited.add(server.id);

    const { resolved, passwordKey, passphraseKey, legacyServerPassphraseKey, profileScoped } = this.resolveServer(server);
    let route: unknown = null;
    if (server.proxy?.type === "ssh") {
      const jump = serverLookup?.(server.proxy.jumpHostId);
      route = jump
        ? ["ssh", server.proxy.jumpHostId, this.getCredentialEndpointSignature(jump, serverLookup, nextVisited)]
        : ["ssh", server.proxy.jumpHostId, "missing"];
    } else if (server.proxy) {
      route = [server.proxy.type, server.proxy.host, server.proxy.port, server.proxy.username ?? null];
    }

    return JSON.stringify([
      server.id,
      server.protocol ?? "ssh",
      resolved.host,
      resolved.altHost ?? null,
      resolved.port,
      resolved.username,
      resolved.authType,
      resolved.keyPath ?? null,
      server.authProfileId ?? null,
      passwordKey,
      passphraseKey,
      legacyServerPassphraseKey ?? null,
      profileScoped,
      route
    ]);
  }

  private async mutateCredentialIfEndpointUnchanged(
    serverId: string,
    expectedRecord: ServerConfig | null | undefined,
    expectedEndpoint: string,
    mutate: () => Promise<void>
  ): Promise<void> {
    if (!this.liveServerLookup) {
      return;
    }

    // Replace/reset and this deferred credential mutation share one lock. The
    // record identity catches same-value delete/re-adds that an endpoint
    // signature alone cannot distinguish; the signature still catches edits
    // to the captured record. Both checks and the vault operation stay atomic.
    await configMutationLock.runExclusive(async () => {
      const live = this.liveServerLookup?.(serverId);
      if (live && live === expectedRecord && this.getCredentialEndpointSignature(live) === expectedEndpoint) {
        await mutate();
      }
    });
  }

  public async promptExclusively<T>(ask: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.promptTail;
    let release!: () => void;
    this.promptTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) {
        throw new Error("SSH authentication attempt ended before its prompt opened");
      }
      return await ask();
    } finally {
      release();
    }
  }

  private isCredentialRecordCurrent(provenance: PromptAnswerProvenance | undefined): boolean {
    if (!provenance || !provenance.recordIdentityAvailable || !this.liveServerLookup) {
      return true;
    }

    const live = this.liveServerLookup(provenance.serverId) ?? null;
    return live !== null &&
      live === provenance.record &&
      this.getCredentialEndpointSignature(live) === provenance.endpointSignature;
  }

  private assertCredentialRecordCurrent(provenance: PromptAnswerProvenance | undefined): void {
    if (!this.isCredentialRecordCurrent(provenance)) {
      throw new Error("The server configuration changed while connecting; the credential was not sent. Connect again.");
    }
  }

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
    onAuthMessage?: (text: string) => void,
    provenance?: PromptAnswerProvenance,
    isActive?: () => boolean
  ): KeyboardInteractiveHandler | undefined {
    if (!this.inputPromptFn) {
      return undefined;
    }
    const promptFn = this.inputPromptFn;
    return (name, instructions, prompts, signal) => {
      const answer = async (): Promise<string[]> => {
        if (signal?.aborted) {
          throw new Error("SSH authentication attempt ended before its prompt opened");
        }
        this.assertAttemptActive(isActive);
        this.assertCredentialRecordCurrent(provenance);
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
            const answer = await promptFn(p.prompt, !p.echo, signal);
            if (answer === undefined) {
              throw new Error("Keyboard-interactive authentication canceled");
            }
            if (signal?.aborted) {
              throw new Error("SSH authentication attempt ended during its prompt");
            }
            this.assertAttemptActive(isActive);
            this.assertCredentialRecordCurrent(provenance);
            responses.push(answer);
          }
        }
        this.assertAttemptActive(isActive);
        this.assertCredentialRecordCurrent(provenance);
        return responses;
      };
      // Saved password answers never open UI, so they must not wait behind a
      // dialog while the SSH handshake's ready timeout keeps running.
      const needsInput = prompts.some((p) => !(/password/i.test(p.prompt) && password));
      return needsInput ? this.promptExclusively(answer, signal) : answer();
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
      credentialEndpointSignature?: string;
      /** Exact live record captured before async connection work; null means absent at start. */
      credentialRecord?: ServerConfig | null;
      isActive?: () => boolean;
    }
  ): Promise<SshConnection> {
    const credentialEndpointSignature =
      options?.credentialEndpointSignature ?? this.getCredentialEndpointSignature(server);
    const hasCapturedCredentialRecord = options !== undefined && "credentialRecord" in options;
    const credentialRecord = hasCapturedCredentialRecord
      ? options.credentialRecord ?? null
      : this.liveServerLookup
        ? this.liveServerLookup(server.id) ?? null
        : server;
    const promptProvenance: PromptAnswerProvenance = {
      serverId: server.id,
      record: credentialRecord,
      endpointSignature: credentialEndpointSignature,
      recordIdentityAvailable: this.liveServerLookup !== undefined || hasCapturedCredentialRecord
    };
    this.assertCredentialRecordCurrent(promptProvenance);
    const { resolved, passwordKey, passphraseKey, legacyServerPassphraseKey, profileScoped } = this.resolveServer(server);

    if (resolved.authType === "key") {
      const handler = this.buildKeyboardInteractiveHandler(undefined, options?.onAuthMessage, promptProvenance, options?.isActive);
      const savedPassphrase = await this.vault.get(passphraseKey);
      this.assertCredentialRecordCurrent(promptProvenance);

      // Try saved passphrase (or no passphrase on first attempt).
      const firstSock = await options?.sockFactory?.();
      try {
        this.assertCredentialRecordCurrent(promptProvenance);
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
          await this.mutateCredentialIfEndpointUnchanged(
            promptProvenance.serverId,
            promptProvenance.record,
            promptProvenance.endpointSignature,
            async () => {
              if (await this.vault.get(passphraseKey) === savedPassphrase) {
                await this.vault.delete(passphraseKey);
              }
            }
          );
        }
      }

      this.assertCredentialRecordCurrent(promptProvenance);

      // Prompt user for passphrase — or join the prompt already open for it.
      const prompted = await this.promptShared(
        passphraseKey,
        resolved.keyPath ?? "",
        () =>
          this.prompt.prompt({
            ...resolved,
            name: `${server.name} (key passphrase)`
          }),
        `Passphrase entry canceled for ${server.name}`,
        promptProvenance,
        options?.isActive
      );
      const { result: promptResult, settle, provenance = promptProvenance } = prompted;

      try {
        this.assertAttemptActive(options?.isActive);
        this.assertCredentialRecordCurrent(promptProvenance);
        const secondSock = await options?.sockFactory?.();

        // Stage A — establish connection. Narrow try scope so vault ops cannot
        // trigger the catch that destroys the live sock.
        // Note: onAuthMessage may render the banner/KI context a second time
        // here (once for the failed saved-passphrase attempt, once for this
        // prompted retry) — intentional, mirrors re-running ssh by hand.
        let connection: SshConnection;
        try {
          this.assertCredentialRecordCurrent(promptProvenance);
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
            await this.mutateCredentialIfEndpointUnchanged(provenance.serverId, provenance.record, provenance.endpointSignature, async () => {
              await this.vault.store(passphraseKey, promptResult.password);
            });
            // The profile-scoped value belongs to the shared prompt owner, but
            // this server-scoped legacy duplicate belongs only to this login.
            // Re-check its own captured record in a separate lock span: the
            // config lock is non-reentrant, and a same-id edit while the prompt
            // was open must not let the owner authorize deleting a new secret.
            if (legacyServerPassphraseKey && legacyServerPassphraseKey !== passphraseKey) {
              await this.mutateCredentialIfEndpointUnchanged(
                promptProvenance.serverId,
                promptProvenance.record,
                promptProvenance.endpointSignature,
                () => this.vault.delete(legacyServerPassphraseKey)
              );
            }
          } else if (!profileScoped) {
            // Declining to save replaces the stored credential for a server —
            // but a profile-scoped passphrase belongs to the whole fleet, and
            // "don't save this one" must not erase what other servers still
            // authenticate with. Clearing a profile passphrase is done through
            // the profile editor, not here.
            await this.mutateCredentialIfEndpointUnchanged(provenance.serverId, provenance.record, provenance.endpointSignature, () =>
              this.vault.delete(passphraseKey)
            );
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
      const handler = this.buildKeyboardInteractiveHandler(undefined, options?.onAuthMessage, promptProvenance, options?.isActive);
      const sock = await options?.sockFactory?.();
      try {
        this.assertCredentialRecordCurrent(promptProvenance);
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
    this.assertCredentialRecordCurrent(promptProvenance);
    if (savedPassword) {
      const handler = this.buildKeyboardInteractiveHandler(savedPassword, options?.onAuthMessage, promptProvenance, options?.isActive);
      const firstSock = await options?.sockFactory?.();
      try {
        this.assertCredentialRecordCurrent(promptProvenance);
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
          await this.mutateCredentialIfEndpointUnchanged(
            promptProvenance.serverId,
            promptProvenance.record,
            promptProvenance.endpointSignature,
            async () => {
              if (await this.vault.get(passwordKey) === savedPassword) {
                await this.vault.delete(passwordKey);
              }
            }
          );
        }
      }
    }

    this.assertCredentialRecordCurrent(promptProvenance);

    // Prompt user for the password — or join the prompt already open for it.
    const route = options?.route?.() ?? (resolved.proxy ? undefined : "direct");
    const typedFor =
      route === undefined
        ? undefined
        : JSON.stringify([
            resolved.protocol ?? "ssh",
            resolved.username,
            resolved.host,
            resolved.altHost ?? null,
            resolved.port,
            route
          ]);
    const prompted = await this.promptShared(
      passwordKey,
      typedFor,
      () => this.prompt.prompt({ ...resolved, name: server.name }),
      `Password entry canceled for ${server.name}`,
      promptProvenance,
      options?.isActive
    );
    const { result: promptResult, settle, joined, provenance = promptProvenance } = prompted;

    try {
      this.assertAttemptActive(options?.isActive);
      this.assertCredentialRecordCurrent(promptProvenance);
      const handler = this.buildKeyboardInteractiveHandler(promptResult.password, options?.onAuthMessage, promptProvenance, options?.isActive);
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
        this.assertCredentialRecordCurrent(promptProvenance);
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
          await this.mutateCredentialIfEndpointUnchanged(provenance.serverId, provenance.record, provenance.endpointSignature, () =>
            this.vault.store(passwordKey, promptResult.password)
          );
        } else if (!profileScoped) {
          // Declining to save replaces the stored credential for a server —
          // but a profile-scoped password belongs to the whole fleet, and
          // "don't save this one" must not erase what other servers still
          // authenticate with. Clearing a profile password is done through the
          // profile editor, not here.
          await this.mutateCredentialIfEndpointUnchanged(provenance.serverId, provenance.record, provenance.endpointSignature, () =>
            this.vault.delete(passwordKey)
          );
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
   * queued, open or answered with its login still in flight, for the same key and
   * the same `typedFor` (see `sharedAnswers`); an undefined `typedFor` is
   * never shared. Calls for the same server id also need the same captured live
   * record, so a same-value Replace cannot join an older record's prompt. The
   * entry retains the prompt owner's provenance for vault writes; a joiner's
   * newer record cannot vouch for an older answer. Different servers linked to
   * one profile can still share the same endpoint's answer. A cancel is every
   * waiting login's cancel, and the next login asks again. An answer is shared
   * until `settle()`, which each login that used it calls once it has succeeded
   * (and saved it, if asked to) or failed: settled only after the save, so a
   * login arriving in between still finds the answer; from then on the vault is
   * the source of truth, and a failed answer — which may be what failed — or
   * one the user chose not to save is asked for afresh.
   */
  private async promptShared(
    vaultKey: string,
    typedFor: string | undefined,
    ask: () => Promise<PasswordPromptResult | undefined>,
    cancellationMessage: string,
    provenance?: PromptAnswerProvenance,
    isActive?: () => boolean
  ): Promise<{ result: PasswordPromptResult; settle: () => void; joined: boolean; provenance?: PromptAnswerProvenance }> {
    if (typedFor === undefined) {
      const result = await this.promptExclusively(() => {
        if (isActive?.() === false) {
          throw new Error("SSH connection attempt ended before its prompt opened");
        }
        this.assertCredentialRecordCurrent(provenance);
        return ask();
      });
      this.assertAttemptActive(isActive);
      if (!result) throw new Error(cancellationMessage);
      return { result, settle: () => {}, joined: false, provenance };
    }
    const request = { ask, provenance, isActive };
    const promptCurrentRequest = (shared: SharedPromptAnswer): Promise<PasswordPromptResult | undefined> => {
      const current = shared.requests.find(
        (waiting) => waiting.isActive?.() !== false && this.isCredentialRecordCurrent(waiting.provenance)
      );
      if (current) {
        shared.provenance = current.provenance;
        return current.ask();
      }
      if (shared.requests.every((waiting) => waiting.isActive?.() === false)) {
        throw new Error("SSH connection attempt ended before its prompt opened");
      }
      throw new Error("The server configuration changed while connecting; the credential was not sent. Connect again.");
    };
    let shared = this.sharedAnswers.get(vaultKey);
    const sameSourceRecord =
      shared?.provenance === undefined ||
      provenance === undefined ||
      shared.provenance.serverId !== provenance.serverId ||
      (!shared.provenance.recordIdentityAvailable && !provenance.recordIdentityAvailable) ||
      (shared.provenance.recordIdentityAvailable &&
        provenance.recordIdentityAvailable &&
        shared.provenance.record === provenance.record);
    const joined = shared !== undefined && shared.typedFor === typedFor && sameSourceRecord;
    if (!shared || !joined) {
      const requests = [request];
      const own: SharedPromptAnswer = {
        typedFor,
        provenance,
        requests,
        answer: Promise.resolve(undefined)
      };
      own.answer = this.promptExclusively(() => promptCurrentRequest(own));
      shared = own;
      this.sharedAnswers.set(vaultKey, shared);
    } else {
      shared.requests.push(request);
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
    if (!result) {
      // Every login waiting on this one input box reports the same cancellation.
      own.cancellationError ??= new Error(cancellationMessage);
      throw own.cancellationError;
    }
    if (isActive?.() === false) {
      if (own.requests.every((waiting) => waiting.isActive?.() === false)) {
        settle();
      }
      throw new Error("SSH connection attempt ended before authentication completed");
    }
    return { result, settle, joined, provenance: own.provenance };
  }

  private assertAttemptActive(isActive?: () => boolean): void {
    if (isActive?.() === false) {
      throw new Error("SSH connection attempt ended before authentication completed");
    }
  }
}
