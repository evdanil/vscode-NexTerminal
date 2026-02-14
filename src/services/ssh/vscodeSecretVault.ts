import * as vscode from "vscode";
import type { SecretVault } from "./contracts";

export class VscodeSecretVault implements SecretVault {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async get(key: string): Promise<string | undefined> {
    return this.context.secrets.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    await this.context.secrets.store(key, value);
  }

  public async delete(key: string): Promise<void> {
    await this.context.secrets.delete(key);
  }
}
