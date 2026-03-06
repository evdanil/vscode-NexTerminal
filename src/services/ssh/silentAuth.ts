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

  private resolveServer(server: ServerConfig): { resolved: ServerConfig; passwordKey: string } {
    if (!server.authProfileId || !this.authProfileLookup) {
      return { resolved: server, passwordKey: passwordSecretKey(server.id) };
    }
    const profile = this.authProfileLookup(server.authProfileId);
    if (!profile) {
      return { resolved: server, passwordKey: passwordSecretKey(server.id) };
    }
    return {
      resolved: { ...server, username: profile.username, authType: profile.authType, keyPath: profile.keyPath },
      passwordKey: authProfilePasswordSecretKey(profile.id)
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

  public async connect(server: ServerConfig, options?: { sock?: Duplex }): Promise<SshConnection> {
    const { resolved, passwordKey } = this.resolveServer(server);
    const sockOpt = options?.sock ? { sock: options.sock } : {};

    if (resolved.authType === "key") {
      const handler = this.buildKeyboardInteractiveHandler();
      const ppKey = passphraseSecretKey(server.id);
      const savedPassphrase = await this.vault.get(ppKey);

      // Try saved passphrase (or no passphrase on first attempt).
      try {
        return await this.connector.connect(resolved, {
          ...(savedPassphrase && { passphrase: savedPassphrase }),
          ...(handler && { onKeyboardInteractive: handler }),
          ...sockOpt
        });
      } catch (error) {
        if (!isPassphraseError(error)) {
          throw error;
        }
        // Saved passphrase was wrong — clear it.
        if (savedPassphrase) {
          await this.vault.delete(ppKey);
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

      const connection = await this.connector.connect(resolved, {
        passphrase: promptResult.password,
        ...(handler && { onKeyboardInteractive: handler }),
        ...sockOpt
      });
      if (promptResult.save) {
        await this.vault.store(ppKey, promptResult.password);
      } else {
        await this.vault.delete(ppKey);
      }
      return connection;
    }

    if (resolved.authType !== "password") {
      const handler = this.buildKeyboardInteractiveHandler();
      return this.connector.connect(resolved, {
        ...(handler && { onKeyboardInteractive: handler }),
        ...sockOpt
      });
    }

    const savedPassword = await this.vault.get(passwordKey);
    if (savedPassword) {
      const handler = this.buildKeyboardInteractiveHandler(savedPassword);
      try {
        return await this.connector.connect(resolved, {
          password: savedPassword,
          ...(handler && { onKeyboardInteractive: handler }),
          ...sockOpt
        });
      } catch (error) {
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
    const connection = await this.connector.connect(resolved, {
      password: promptResult.password,
      ...(handler && { onKeyboardInteractive: handler }),
      ...sockOpt
    });
    if (promptResult.save) {
      await this.vault.store(passwordKey, promptResult.password);
    } else {
      await this.vault.delete(passwordKey);
    }
    return connection;
  }

}
