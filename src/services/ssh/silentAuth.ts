import type { ServerConfig } from "../../models/config";
import type { KeyboardInteractiveHandler, PasswordPrompt, SecretVault, SshConnection, SshConnector } from "./contracts";

export type InputPromptFn = (message: string, password: boolean) => Promise<string | undefined>;

export function passwordSecretKey(serverId: string): string {
  return `password-${serverId}`;
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

export class SilentAuthSshFactory {
  public constructor(
    private readonly connector: SshConnector,
    private readonly vault: SecretVault,
    private readonly prompt: PasswordPrompt,
    private readonly inputPromptFn?: InputPromptFn
  ) {}

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

  public async connect(server: ServerConfig): Promise<SshConnection> {
    if (server.authType === "key") {
      const handler = this.buildKeyboardInteractiveHandler();
      try {
        return await this.connector.connect(server, {
          ...(handler && { onKeyboardInteractive: handler })
        });
      } catch (error) {
        if (!isPassphraseError(error)) {
          throw error;
        }
        const passphrase = await this.passphrasePrompt(server);
        if (!passphrase) {
          throw new Error(`Passphrase entry canceled for ${server.name}`);
        }
        return this.connector.connect(server, {
          passphrase,
          ...(handler && { onKeyboardInteractive: handler })
        });
      }
    }

    if (server.authType !== "password") {
      const handler = this.buildKeyboardInteractiveHandler();
      return this.connector.connect(server, {
        ...(handler && { onKeyboardInteractive: handler })
      });
    }

    const key = passwordSecretKey(server.id);
    const savedPassword = await this.vault.get(key);
    if (savedPassword) {
      const handler = this.buildKeyboardInteractiveHandler(savedPassword);
      try {
        return await this.connector.connect(server, {
          password: savedPassword,
          ...(handler && { onKeyboardInteractive: handler })
        });
      } catch (error) {
        if (!isAuthError(error)) {
          throw error;
        }
        await this.vault.delete(key);
      }
    }

    const promptResult = await this.prompt.prompt(server);
    if (!promptResult) {
      throw new Error(`Password entry canceled for ${server.name}`);
    }

    const handler = this.buildKeyboardInteractiveHandler(promptResult.password);
    const connection = await this.connector.connect(server, {
      password: promptResult.password,
      ...(handler && { onKeyboardInteractive: handler })
    });
    if (promptResult.save) {
      await this.vault.store(key, promptResult.password);
    } else {
      await this.vault.delete(key);
    }
    return connection;
  }

  private async passphrasePrompt(server: ServerConfig): Promise<string | undefined> {
    const result = await this.prompt.prompt({
      ...server,
      name: `${server.name} (key passphrase)`
    });
    return result?.password;
  }
}
