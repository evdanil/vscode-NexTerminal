import type { Duplex } from "node:stream";
import type { AuthProfile, ServerConfig } from "../../models/config";
import type { KeyboardInteractiveHandler, PasswordPrompt, SecretVault, SshConnection, SshConnector, SshFactory } from "./contracts";

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

export class SilentAuthSshFactory implements SshFactory {
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
  } {
    if (!server.authProfileId || !this.authProfileLookup) {
      return {
        resolved: server,
        passwordKey: passwordSecretKey(server.id),
        passphraseKey: passphraseSecretKey(server.id)
      };
    }
    const profile = this.authProfileLookup(server.authProfileId);
    if (!profile) {
      return {
        resolved: server,
        passwordKey: passwordSecretKey(server.id),
        passphraseKey: passphraseSecretKey(server.id)
      };
    }
    return {
      resolved: { ...server, username: profile.username, authType: profile.authType, keyPath: profile.keyPath },
      passwordKey: profile.authType === "password" ? authProfilePasswordSecretKey(profile.id) : passwordSecretKey(server.id),
      passphraseKey: profile.authType === "key" ? authProfilePassphraseSecretKey(profile.id) : passphraseSecretKey(server.id),
      legacyServerPassphraseKey: profile.authType === "key" ? passphraseSecretKey(server.id) : undefined
    };
  }

  private buildKeyboardInteractiveHandler(password?: string): KeyboardInteractiveHandler | undefined {
    if (!this.inputPromptFn) {
      return undefined;
    }
    const promptFn = this.inputPromptFn;
    return async (_name, _instructions, prompts) => {
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
  public async connect(server: ServerConfig, options?: { sockFactory?: () => Promise<Duplex> }): Promise<SshConnection> {
    const { resolved, passwordKey, passphraseKey, legacyServerPassphraseKey } = this.resolveServer(server);

    if (resolved.authType === "key") {
      const handler = this.buildKeyboardInteractiveHandler();
      const savedPassphrase = await this.vault.get(passphraseKey);

      // Try saved passphrase (or no passphrase on first attempt).
      const firstSock = await options?.sockFactory?.();
      try {
        return await this.connector.connect(resolved, {
          ...(savedPassphrase && { passphrase: savedPassphrase }),
          ...(handler && { onKeyboardInteractive: handler }),
          ...(firstSock && { sock: firstSock })
        });
      } catch (error) {
        firstSock?.destroy();
        if (!isPassphraseError(error)) {
          throw error;
        }
        // Saved passphrase was wrong — clear it.
        if (savedPassphrase) {
          await this.vault.delete(passphraseKey);
        }
      }

      // Prompt user for passphrase.
      const promptResult = await this.prompt.prompt({
        ...resolved,
        name: `${server.name} (key passphrase)`
      });
      if (!promptResult) {
        throw new Error(`Passphrase entry canceled for ${server.name}`);
      }

      const secondSock = await options?.sockFactory?.();

      // Stage A — establish connection. Narrow try scope so vault ops cannot
      // trigger the catch that destroys the live sock.
      let connection: SshConnection;
      try {
        connection = await this.connector.connect(resolved, {
          passphrase: promptResult.password,
          ...(handler && { onKeyboardInteractive: handler }),
          ...(secondSock && { sock: secondSock })
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
        } else {
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
    }

    if (resolved.authType !== "password") {
      const handler = this.buildKeyboardInteractiveHandler();
      const sock = await options?.sockFactory?.();
      try {
        return await this.connector.connect(resolved, {
          ...(handler && { onKeyboardInteractive: handler }),
          ...(sock && { sock })
        });
      } catch (error) {
        sock?.destroy();
        throw error;
      }
    }

    const savedPassword = await this.vault.get(passwordKey);
    if (savedPassword) {
      const handler = this.buildKeyboardInteractiveHandler(savedPassword);
      const firstSock = await options?.sockFactory?.();
      try {
        return await this.connector.connect(resolved, {
          password: savedPassword,
          ...(handler && { onKeyboardInteractive: handler }),
          ...(firstSock && { sock: firstSock })
        });
      } catch (error) {
        firstSock?.destroy();
        if (!isAuthError(error)) {
          throw error;
        }
        await this.vault.delete(passwordKey);
      }
    }

    const promptResult = await this.prompt.prompt({ ...resolved, name: server.name });
    if (!promptResult) {
      throw new Error(`Password entry canceled for ${server.name}`);
    }

    const handler = this.buildKeyboardInteractiveHandler(promptResult.password);
    const secondSock = await options?.sockFactory?.();

    // Stage A — establish connection. Narrow try scope so vault ops cannot
    // trigger the catch that destroys the live sock.
    let connection: SshConnection;
    try {
      connection = await this.connector.connect(resolved, {
        password: promptResult.password,
        ...(handler && { onKeyboardInteractive: handler }),
        ...(secondSock && { sock: secondSock })
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
      } else {
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
  }

}
