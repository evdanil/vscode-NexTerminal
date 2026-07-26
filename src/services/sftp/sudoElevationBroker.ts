import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SftpService } from "./sftpService";
import { ElevatedInstallFailedError, SudoNotPermittedError, SudoPasswordRequiredError } from "./elevatedWrite";
import type { ElevationBroker } from "./nexusFileSystemProvider";

const OPEN_SETTINGS = "Open Settings";
const DISABLED_MESSAGE = "Elevated saves are disabled (nexus.sftp.sudo.enabled is off).";
const PARTIAL_WRITE_NOTE = "The file may be partially written — keep the editor open and retry the save.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSudoSetting<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration("nexus.sftp").get<T>(key, defaultValue);
}

/** Offers to open the sudo.enabled setting after telling the user elevation is off. */
async function reportSudoDisabled(): Promise<void> {
  const choice = await vscode.window.showErrorMessage(DISABLED_MESSAGE, OPEN_SETTINGS);
  if (choice === OPEN_SETTINGS) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "nexus.sftp.sudo.enabled");
  }
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

  public async confirmElevation(serverId: string, remotePath: string): Promise<boolean> {
    if (!readSudoSetting("sudo.enabled", true)) {
      // Reactive offer skipped entirely — no modal. The plain save's own error still
      // surfaces to the user via VS Code's normal "unable to save" flow.
      return false;
    }
    const server = this.getServer(serverId);
    const host = server ? server.name : serverId;
    const choice = await vscode.window.showWarningMessage(
      `Permission denied writing ${remotePath} on ${host}. Retry the save with sudo?`,
      { modal: true },
      "Save as Root"
    );
    return choice === "Save as Root";
  }

  public async saveElevated(serverId: string, remotePath: string, content: Buffer, knownMode?: number): Promise<boolean> {
    if (!readSudoSetting("sudo.enabled", true)) {
      await reportSudoDisabled();
      return false;
    }

    try {
      const failure = await this.sftp.probeElevation(serverId);
      if (failure.kind !== "password-required") {
        // "none" needs no password; the other kinds (not-permitted / no-sudo /
        // requires-tty) are not password problems — let writeFileElevated surface
        // the same plain-language message runElevatedInstall already produces for
        // them rather than re-deriving it here.
        try {
          await this.sftp.writeFileElevated(serverId, remotePath, content, { createMode: knownMode });
        } catch (error) {
          if (!(error instanceof SudoPasswordRequiredError)) {
            throw error;
          }
          // The non-interactive probe said "none" (a valid cached sudo timestamp),
          // but that timestamp lapsed in the moment before the install actually ran.
          // Fall through to the interactive path instead of failing a save the user
          // would just have to retry anyway.
          return await this.saveWithPassword(serverId, remotePath, content, knownMode);
        }
        this.announceSuccess(remotePath);
        return true;
      }
      return await this.saveWithPassword(serverId, remotePath, content, knownMode);
    } catch (error) {
      this.reportFailure(serverId, error);
      return false;
    }
  }

  /** Drops any cached sudo password for a server. Call on SSH disconnect. */
  public clearCachedPassword(serverId: string): void {
    this.passwordCache.delete(serverId);
  }

  /** Clears the in-memory password cache. Call on extension deactivate. */
  public dispose(): void {
    this.passwordCache.clear();
  }

  private async saveWithPassword(
    serverId: string,
    remotePath: string,
    content: Buffer,
    knownMode?: number
  ): Promise<boolean> {
    const remember = readSudoSetting("sudo.rememberPasswordForSession", false);
    let password = this.passwordCache.get(serverId) ?? (await this.promptPassword(serverId));
    if (!password) {
      return false;
    }

    try {
      await this.sftp.writeFileElevated(serverId, remotePath, content, { password, createMode: knownMode });
    } catch (error) {
      if (!(error instanceof SudoPasswordRequiredError)) {
        throw error;
      }
      this.passwordCache.delete(serverId);
      password = await this.promptPassword(serverId, true);
      if (!password) {
        return false;
      }
      try {
        await this.sftp.writeFileElevated(serverId, remotePath, content, { password, createMode: knownMode });
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

  /** Builds and shows the final failure toast for anything that escapes saveElevated's inner handling. */
  private reportFailure(serverId: string, error: unknown): void {
    const server = this.getServer(serverId);
    if (error instanceof SudoNotPermittedError) {
      const target = server ? `${server.username}@${server.host}` : serverId;
      const host = server ? server.name : serverId;
      vscode.window.showErrorMessage(
        `${target} is not permitted to run sudo for this file on ${host}. Check the remote sudoers policy — ` +
        `this can also happen with per-command restrictions rather than a full ban. ${error.detail}`
      );
      return;
    }
    if (error instanceof ElevatedInstallFailedError) {
      vscode.window.showErrorMessage(`${error.message} ${PARTIAL_WRITE_NOTE}`);
      return;
    }
    vscode.window.showErrorMessage(`Elevated save failed: ${errorMessage(error)}`);
  }

  private async promptPassword(serverId: string, retry = false): Promise<string | undefined> {
    const server = this.getServer(serverId);
    const target = server ? `${server.username}@${server.host}` : serverId;
    const title = `Sudo Password: ${server ? server.name : serverId}`;
    const reason = retry ? "Incorrect password. " : "";
    const password = await vscode.window.showInputBox({
      title,
      prompt: `${reason}Enter the sudo password for ${target} to save this file as root`,
      password: true,
      ignoreFocusOut: true,
    });
    return password || undefined;
  }

  private announceSuccess(remotePath: string): void {
    vscode.window.setStatusBarMessage(`$(shield) Saved as root: ${path.posix.basename(remotePath)}`, 4000);
  }
}
