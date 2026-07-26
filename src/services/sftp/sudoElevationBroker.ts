import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SftpService } from "./sftpService";
import { SudoPasswordRequiredError } from "./elevatedWrite";
import type { ElevationBroker } from "./nexusFileSystemProvider";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSudoSetting<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration("nexus.sftp").get<T>(key, defaultValue);
}

/**
 * ElevationBroker implementation: owns the sudo password prompts and an in-memory
 * per-server password cache. Never writes to SecretStorage — a cached password lives
 * only as long as this object does, and only for servers whose entry the caller
 * hasn't cleared (see clearCachedPassword, wired to SSH disconnect in extension.ts).
 */
export class SudoElevationBroker implements ElevationBroker {
  private readonly passwordCache = new Map<string, string>();

  public constructor(
    private readonly sftp: SftpService,
    private readonly getServer: (serverId: string) => ServerConfig | undefined
  ) {}

  public async confirmElevation(remotePath: string): Promise<boolean> {
    if (!readSudoSetting("sudo.enabled", true)) {
      // Reactive offer skipped entirely — no modal. The plain save's own error still
      // surfaces to the user via VS Code's normal "unable to save" flow.
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `Permission denied writing ${remotePath}. Save with sudo on the remote host?`,
      { modal: true },
      "Save as Root"
    );
    return choice === "Save as Root";
  }

  public async saveElevated(serverId: string, remotePath: string, content: Buffer): Promise<boolean> {
    if (!readSudoSetting("sudo.enabled", true)) {
      vscode.window.showErrorMessage("Elevated saves are disabled (nexus.sftp.sudo.enabled is off).");
      return false;
    }

    try {
      const failure = await this.sftp.probeElevation(serverId);
      if (failure.kind !== "password-required") {
        // "none" needs no password; the other kinds (not-permitted / no-sudo /
        // requires-tty) are not password problems — let writeFileElevated surface
        // the same plain-language message runElevatedInstall already produces for
        // them rather than re-deriving it here.
        await this.sftp.writeFileElevated(serverId, remotePath, content);
        this.announceSuccess(remotePath);
        return true;
      }
      return await this.saveWithPassword(serverId, remotePath, content);
    } catch (error) {
      vscode.window.showErrorMessage(`Elevated save failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Drops any cached sudo password for a server. Call on SSH disconnect. */
  public clearCachedPassword(serverId: string): void {
    this.passwordCache.delete(serverId);
  }

  private async saveWithPassword(serverId: string, remotePath: string, content: Buffer): Promise<boolean> {
    const remember = readSudoSetting("sudo.rememberPasswordForSession", false);
    let password = this.passwordCache.get(serverId) ?? (await this.promptPassword(serverId));
    if (!password) {
      return false;
    }

    try {
      await this.sftp.writeFileElevated(serverId, remotePath, content, { password });
    } catch (error) {
      if (!(error instanceof SudoPasswordRequiredError)) {
        throw error;
      }
      this.passwordCache.delete(serverId);
      password = await this.promptPassword(serverId);
      if (!password) {
        return false;
      }
      try {
        await this.sftp.writeFileElevated(serverId, remotePath, content, { password });
      } catch (retryError) {
        if (!(retryError instanceof SudoPasswordRequiredError)) {
          throw retryError;
        }
        vscode.window.showErrorMessage("Elevated save failed: sudo rejected the password.");
        return false;
      }
    }

    if (remember) {
      this.passwordCache.set(serverId, password);
    }
    this.announceSuccess(remotePath);
    return true;
  }

  private async promptPassword(serverId: string): Promise<string | undefined> {
    const server = this.getServer(serverId);
    const target = server ? `${server.username}@${server.host}` : serverId;
    const password = await vscode.window.showInputBox({
      title: "sudo password",
      prompt: `sudo password for ${target}`,
      password: true,
      ignoreFocusOut: true,
    });
    return password || undefined;
  }

  private announceSuccess(remotePath: string): void {
    vscode.window.setStatusBarMessage(`$(shield) Saved as root: ${path.posix.basename(remotePath)}`, 4000);
  }
}
