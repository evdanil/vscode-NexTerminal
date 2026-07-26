import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { SftpService } from "./sftpService";
import { ElevatedInstallFailedError, SudoNotPermittedError, SudoPasswordRequiredError } from "./elevatedWrite";
import type { ElevationBroker } from "./nexusFileSystemProvider";

const OPEN_SETTINGS = "Open Settings";
const DISABLED_MESSAGE = "Elevated saves are disabled (nexus.sftp.sudo.enabled is off).";
const PARTIAL_WRITE_NOTE = "The file may be partially written — keep the editor open and retry the save.";

// VS Code's Save As issues two writeFile calls (create, then content) for one
// user-visible save; the second reuses this class's elevation but, with
// rememberPasswordForSession off (the default), had nothing to reuse for the
// password itself and prompted a second time. 30s covers that pair (including a
// slow /tmp staging upload before the second write even starts) without
// resembling session-long retention.
export const GRACE_WINDOW_MS = 30_000;

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
  // Fixed window from the moment a password is entered, not refreshed on reuse —
  // see GRACE_WINDOW_MS. Applies regardless of rememberPasswordForSession.
  private readonly graceCache = new Map<string, { password: string; expiresAt: number }>();

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

    // Authoritative place for the "remembrance off drops the cache" rule: the passwordless
    // fast path below (the optimistic attempt) writes and returns without ever reaching
    // saveWithPassword, so clearing only there (as before) left a stale password cached
    // whenever the remote sudo timestamp was still valid. Clearing here, ahead of the
    // attempt, covers every path.
    const remember = readSudoSetting("sudo.rememberPasswordForSession", false);
    if (!remember) {
      this.passwordCache.delete(serverId);
    }

    // Skip the optimistic no-password attempt when a password is already on hand
    // (session cache, or the grace window above): that account is already known to
    // need one for this server, so the extra round trip just to watch sudo -n fail
    // again buys nothing.
    const hasUsablePassword = (remember && this.passwordCache.has(serverId)) || this.peekGracePassword(serverId) !== undefined;

    try {
      if (!hasUsablePassword) {
        try {
          // The attempt itself is the probe: sudo -n refuses before the target is
          // ever touched if a password is required, so this safely tests the exact
          // install command's authorization instead of a separate `sudo -n -v`
          // probe, which can't see command-scoped sudoers rules (Codex round 6).
          await this.sftp.writeFileElevated(serverId, remotePath, content, { createMode: knownMode });
          this.announceSuccess(remotePath);
          return true;
        } catch (error) {
          if (!(error instanceof SudoPasswordRequiredError)) {
            throw error;
          }
        }
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
    this.graceCache.delete(serverId);
  }

  /** Clears the in-memory password cache. Call on extension deactivate. */
  public dispose(): void {
    this.passwordCache.clear();
    this.graceCache.clear();
  }

  private peekGracePassword(serverId: string): string | undefined {
    const entry = this.graceCache.get(serverId);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.graceCache.delete(serverId);
      return undefined;
    }
    return entry.password;
  }

  private async saveWithPassword(
    serverId: string,
    remotePath: string,
    content: Buffer,
    knownMode?: number
  ): Promise<boolean> {
    // The remembrance-off cache clear is handled once, up front, in saveElevated — this
    // method is only ever reached after that clear has already run. `remember` is still
    // needed here to gate whether a successful password gets cached below.
    const remember = readSudoSetting("sudo.rememberPasswordForSession", false);
    const cached = (remember ? this.passwordCache.get(serverId) : undefined) ?? this.peekGracePassword(serverId);
    let password: string;
    let enteredFresh = false;
    if (cached !== undefined) {
      password = cached;
    } else {
      const entered = await this.promptPassword(serverId);
      if (!entered) {
        return false;
      }
      password = entered;
      enteredFresh = true;
    }

    try {
      await this.sftp.writeFileElevated(serverId, remotePath, content, { password, createMode: knownMode });
    } catch (error) {
      if (!(error instanceof SudoPasswordRequiredError)) {
        throw error;
      }
      this.passwordCache.delete(serverId);
      this.graceCache.delete(serverId);
      const entered = await this.promptPassword(serverId, true);
      if (!entered) {
        return false;
      }
      password = entered;
      enteredFresh = true;
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
    if (enteredFresh) {
      // Only a freshly-typed password (re)starts the window — a cache hit above
      // must never land here, or reuse would keep pushing the expiry out and the
      // window would become sliding (explicitly disallowed).
      this.graceCache.set(serverId, { password, expiresAt: Date.now() + GRACE_WINDOW_MS });
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
