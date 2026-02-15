import type { ServerConfig } from "../../models/config";
import type { PasswordPrompt, SecretVault, SshConnection, SshConnector } from "./contracts";

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
    private readonly prompt: PasswordPrompt
  ) {}

  public async connect(server: ServerConfig): Promise<SshConnection> {
    if (server.authType === "key") {
      try {
        return await this.connector.connect(server, {});
      } catch (error) {
        if (!isPassphraseError(error)) {
          throw error;
        }
        const passphrase = await this.passphrasePrompt(server);
        if (!passphrase) {
          throw new Error(`Passphrase entry canceled for ${server.name}`);
        }
        return this.connector.connect(server, { passphrase });
      }
    }

    if (server.authType !== "password") {
      return this.connector.connect(server, {});
    }

    const key = passwordSecretKey(server.id);
    const savedPassword = await this.vault.get(key);
    if (savedPassword) {
      try {
        return await this.connector.connect(server, { password: savedPassword });
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

    const connection = await this.connector.connect(server, { password: promptResult.password });
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
