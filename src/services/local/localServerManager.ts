/**
 * @author kanekitakitos
 *
 * Execution engine and lifecycle orchestrator for the Local Servers subsystem.
 *
 * Sits between the command layer (localServerCommands.ts → UI user intent) and
 * the PTY layer (LocalShellPty → process spawn). Responsibilities:
 *
 *  1. Workspace Trust gating. In Restricted Mode every spawn is hard-refused
 *     with WorkspaceUntrusted, because Local Servers can execute arbitrary
 *     binaries/arguments from untrusted workspace settings.
 *  2. Launch-option resolution: expand ~, ${workspaceFolder}, ${env:...} in
 *     executable path / args / cwd / env, with lexical scope-checking for
 *     workspace-relative cwds (PathOutsideScope).
 *  3. Single-flight enforcement: one ActiveLocalServerSession per configId at
 *     a time (ServerAlreadyRunning).
 *  4. Auto-restart with exponential back-off, bounded by
 *     LocalServerConfig.maxAutoRestarts.
 *  5. Clean teardown: stopSession + stopAllSessions for deactivate / tab close
 *     / profile removal. Callers hold pty references through the session map;
 *     the manager owns correct ordering of markShuttingDown → dispose.
 *
 * The manager does NOT write persisted config. Config mutation flows go
 * through NexusCore.addOrUpdateLocalServerConfig under configMutationLock,
 * exactly like SSH / Serial / Local Shell profiles.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NexusCore } from "../../core/nexusCore";
import {
  LocalServerError,
  type ActiveLocalServerSession,
  type LocalServerConfig,
  type LocalServerStatus
} from "../../models/localServer";
import { LocalShellPty, resolveLocalPtySidecarPath, type LocalShellEarlyTerminationEvent, type LocalShellOutputChannel } from "./localShellPty";
import type { TerminalRegistry } from "../terminal/terminalRegistry";
import type { CommandContext, LocalServerTerminalEntry, LocalServerTerminalMap } from "../../commands/types";
import type { TerminalHighlighter } from "../terminalHighlighter";

export const LOCAL_SERVER_STABLE_RUN_MS = 10_000;
export const LOCAL_SERVER_INITIAL_BACKOFF_MS = 500;
export const LOCAL_SERVER_MAX_BACKOFF_MS = 30_000;
export const LOCAL_SERVER_DEFAULT_MAX_RESTARTS = 5;
/**
 * Bound on how long stop() waits for the pty to report a real exit code
 * (via the onDidClose/onDidTerminateEarly listeners wired in start()) before
 * forcing cleanup itself. A forced kill often never reports back, so this is
 * the common path in practice, not just a rare-failure fallback.
 */
export const LOCAL_SERVER_STOP_GRACE_MS = 2_000;

export interface LocalServerLaunchOptions {
  shellPath: string;
  shellArgs: string[];
  cwd?: string;
  env?: Record<string, string | null | undefined>;
}

interface InternalRunningEntry {
  sessionId: string;
  pty: LocalShellPty;
  terminal: vscode.Terminal;
  config: LocalServerConfig;
  restartTimer?: ReturnType<typeof setTimeout>;
  stableTimer?: ReturnType<typeof setTimeout>;
  stopGraceTimer?: ReturnType<typeof setTimeout>;
  userInitiatedStop: boolean;
  /**
   * True from the moment stop() is called until handleExit() finally tears
   * the entry down (via the pty's real close/terminate event or the grace
   * timer). getActiveSessionIdForConfig() treats a stopping entry as not
   * running, so restart() can immediately re-start the same config without
   * a false ServerAlreadyRunning.
   */
  stopping: boolean;
}

function isBareCommand(value: string): boolean {
  return !/[\\/]/.test(value) && !/^[A-Za-z]:/.test(value);
}

function pathExists(value: string): boolean {
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function readEnv(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  const foundKey = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
  return foundKey ? process.env[foundKey] : undefined;
}

function expandHome(value: string): string {
  return value.replace(/^~(?=\/|\\|$)/, os.homedir());
}

function workspaceFolders(): ReadonlyArray<{ name?: string; uri: { fsPath: string } }> {
  return vscode.workspace.workspaceFolders ?? [];
}

function expandWorkspaceVariables(value: string): string {
  const folders = workspaceFolders();
  const defaultFolder = folders[0]?.uri.fsPath;
  let expanded = value;
  if (defaultFolder) {
    expanded = expanded
      .replace(/\$\{workspaceFolder\}/g, defaultFolder)
      .replace(/\$\{workspaceRoot\}/g, defaultFolder);
  }
  expanded = expanded.replace(/\$\{workspaceFolder:([^}]+)\}/g, (match, name: string) => {
    const folder = folders.find((item) => item.name === name);
    return folder?.uri.fsPath ?? match;
  });
  return expanded;
}

function expandEnvVariables(value: string): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (match, name: string) => readEnv(name) ?? match);
}

function expandValue(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return expandEnvVariables(expandWorkspaceVariables(expandHome(value.trim())));
}

function expandArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  return args.map((arg) => expandValue(arg) ?? "");
}

function expandEnv(
  env: Record<string, string | null | undefined> | undefined
): Record<string, string | null | undefined> | undefined {
  if (!env) return undefined;
  const result: Record<string, string | null | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = typeof value === "string" ? expandValue(value) : value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeFs(value: string): string {
  return path.resolve(value).toLowerCase().replace(/\\/g, "/");
}

/**
 * Lexical-only scope check: a resolved cwd that escapes every workspace root
 * is rejected with PathOutsideScope. This is NOT a security boundary (a
 * malicious binary can `cd` itself); it is a guard against accidental
 * misconfiguration that would otherwise fail with a confusing ENOENT.
 *
 * With no workspace open we allow any absolute path — there is nothing to
 * escape *from*.
 */
function assertCwdWithinScope(resolvedCwd: string): void {
  const folders = workspaceFolders();
  if (folders.length === 0) return;
  const normalized = normalizeFs(resolvedCwd);
  const withinAny = folders.some((folder) => {
    const root = normalizeFs(folder.uri.fsPath);
    return normalized === root || normalized.startsWith(root + "/");
  });
  if (!withinAny) {
    throw new LocalServerError(
      "PathOutsideScope",
      `Working directory "${resolvedCwd}" is outside all workspace roots.`
    );
  }
}

function resolveExecutable(executable: string): string {
  const expanded = expandValue(executable) ?? executable;
  if (isBareCommand(expanded)) {
    return expanded;
  }
  if (!pathExists(expanded)) {
    throw new LocalServerError(
      "ExecutableNotFound",
      `Executable not found: "${expanded}".`
    );
  }
  return expanded;
}

export function resolveLocalServerLaunchOptions(config: LocalServerConfig): LocalServerLaunchOptions {
  const executable = resolveExecutable(config.executable);
  const args = expandArgs(config.args) ?? [];
  let cwd: string | undefined;
  if (config.cwd?.trim()) {
    const expanded = expandValue(config.cwd);
    if (!expanded) {
      throw new LocalServerError(
        "InvalidConfiguration",
        "Working directory expanded to an empty path."
      );
    }
    if (!path.isAbsolute(expanded)) {
      const folders = workspaceFolders();
      if (folders.length === 0) {
        throw new LocalServerError(
          "InvalidConfiguration",
          `Relative cwd "${config.cwd}" requires an open workspace.`
        );
      }
      cwd = path.resolve(folders[0].uri.fsPath, expanded);
    } else {
      cwd = path.resolve(expanded);
    }
    assertCwdWithinScope(cwd);
    if (!isDirectory(cwd)) {
      throw new LocalServerError(
        "CwdNotDirectory",
        `Working directory "${cwd}" is not a directory.`
      );
    }
  }
  const env = expandEnv(config.env);
  return { shellPath: executable, shellArgs: args, cwd, env };
}

export function localServerDescription(config: LocalServerConfig): string {
  const parts = [config.executable];
  if (config.args?.length) {
    parts.push(...config.args);
  }
  return parts.join(" ");
}

export function localServerRemovalDisclosure(name: string): string {
  return `Remove local server "${name}", stop any running instance, and close its terminal?`;
}

export interface LocalServerManagerOptions {
  core: NexusCore;
  extensionPath: string;
  terminals: LocalServerTerminalMap;
  terminalRegistry?: TerminalRegistry;
  outputChannel?: LocalShellOutputChannel;
  highlighter?: TerminalHighlighter;
  diagnostics?: (line: string) => void;
}

export class LocalServerManager implements vscode.Disposable {
  private readonly entries = new Map<string, InternalRunningEntry>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  public constructor(private readonly options: LocalServerManagerOptions) {}

  public getActiveSessionIdForConfig(configId: string): string | undefined {
    for (const [sessionId, entry] of this.options.terminals.entries()) {
      if (entry.configId === configId) {
        const running = this.entries.get(sessionId);
        if (running && !running.stopping) return sessionId;
      }
    }
    return undefined;
  }

  public getRunningEntry(sessionId: string): InternalRunningEntry | undefined {
    return this.entries.get(sessionId);
  }

  public assertTrusted(): void {
    if (vscode.workspace.isTrusted === false) {
      throw new LocalServerError(
        "WorkspaceUntrusted",
        "Local Servers require a trusted workspace. Grant trust before starting servers."
      );
    }
  }

  public async start(config: LocalServerConfig): Promise<string> {
    this.assertTrusted();
    if (this.getActiveSessionIdForConfig(config.id)) {
      throw new LocalServerError(
        "ServerAlreadyRunning",
        `Local server "${config.name}" is already running. Stop it first.`
      );
    }
    const launch = resolveLocalServerLaunchOptions(config);
    const sessionId = randomUUID();
    const terminalName = `Nexus Local Server: ${config.name}`;
    const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";

    let ptyRef: LocalShellPty | undefined;
    const pty = new LocalShellPty({
      sidecarPath: resolveLocalPtySidecarPath(this.options.extensionPath),
      shellPath: launch.shellPath,
      shellArgs: launch.shellArgs,
      cwd: launch.cwd,
      env: launch.env,
      terminalName,
      outputChannel: this.options.outputChannel,
      highlighter: this.options.highlighter
    });
    ptyRef = pty;

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      pty,
      iconPath: new vscode.ThemeIcon("server-environment"),
      location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
    });

    const entry: InternalRunningEntry = {
      sessionId,
      pty,
      terminal,
      config,
      userInitiatedStop: false,
      stopping: false
    };
    this.entries.set(sessionId, entry);

    const activeSession: ActiveLocalServerSession = {
      id: sessionId,
      configId: config.id,
      terminalName,
      status: "starting",
      startedAt: Date.now(),
      restartAttempts: 0,
      pty
    };
    this.options.core.registerLocalServerSession(activeSession);

    const termEntry: LocalServerTerminalEntry = { terminal, configId: config.id, pty };
    this.options.terminals.set(sessionId, termEntry);
    this.options.terminalRegistry?.register(terminal, pty);

    pty.onDidStartupComplete(() => {
      if (this.disposed) return;
      if (!this.entries.has(sessionId)) return;
      this.options.core.updateLocalServerSessionStatus(sessionId, "running");
      entry.stableTimer = setTimeout(() => {
        if (this.entries.has(sessionId)) {
          this.options.core.resetLocalServerRestartAttempts(sessionId);
        }
      }, LOCAL_SERVER_STABLE_RUN_MS);
    });

    pty.onDidTerminateEarly((evt: LocalShellEarlyTerminationEvent) => {
      this.handleExit(sessionId, config, evt.code);
    });
    pty.onDidClose((code: number | void) => {
      this.handleExit(sessionId, config, typeof code === "number" ? code : null);
    });

    terminal.show();
    return sessionId;
  }

  public async stop(sessionId: string, userInitiated = true): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      throw new LocalServerError(
        "ServerNotRunning",
        "No running local server session matches this id."
      );
    }
    if (entry.stopping) return;
    entry.userInitiatedStop = userInitiated;
    entry.stopping = true;
    this.options.core.updateLocalServerSessionStatus(sessionId, "stopping");
    this.clearTimers(entry);
    try {
      entry.pty.markShuttingDown(userInitiated ? "Stopped by user." : "Extension deactivation.");
    } catch {
      /* best effort banner */
    }
    entry.terminal.dispose();

    // The pty's onDidClose/onDidTerminateEarly listeners wired in start()
    // drive the actual exit-code recording + cleanup via handleExit(),
    // exactly like the crash/auto-restart path. A forced kill frequently
    // never reports back, so this bounds how long the session lingers as
    // "stopping" before we finalize it ourselves with an unknown exit code.
    entry.stopGraceTimer = setTimeout(() => {
      if (this.entries.has(sessionId)) {
        this.handleExit(sessionId, entry.config, null);
      }
    }, LOCAL_SERVER_STOP_GRACE_MS);
  }

  public async stopConfig(configId: string, userInitiated = true): Promise<void> {
    const sessionsToStop: string[] = [];
    for (const [sessionId, entry] of this.options.terminals.entries()) {
      if (entry.configId === configId && this.entries.has(sessionId)) {
        sessionsToStop.push(sessionId);
      }
    }
    await Promise.all(sessionsToStop.map((id) => this.stop(id, userInitiated)));
  }

  public async restart(config: LocalServerConfig): Promise<string> {
    const existing = this.getActiveSessionIdForConfig(config.id);
    if (existing) {
      const entry = this.entries.get(existing);
      if (entry) {
        this.options.core.updateLocalServerSessionStatus(existing, "restarting");
      }
      await this.stop(existing, true);
    }
    return this.start(config);
  }

  public stopAll(userInitiated = true): void {
    const ids = [...this.entries.keys()];
    for (const id of ids) {
      void this.stop(id, userInitiated).catch(() => undefined);
    }
  }

  public inspectLogsTerminal(sessionId: string): vscode.Terminal | undefined {
    const entry = this.entries.get(sessionId) ?? this.options.terminals.get(sessionId);
    return entry?.terminal;
  }

  private handleExit(sessionId: string, config: LocalServerConfig, exitCode: number | null): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.clearTimers(entry);
    this.options.core.setLocalServerLastExitCode(sessionId, exitCode);
    this.cleanupSession(sessionId);

    if (!config.autoRestart) return;
    if (entry.userInitiatedStop) return;

    const maxRestarts =
      typeof config.maxAutoRestarts === "number" && config.maxAutoRestarts > 0
        ? config.maxAutoRestarts
        : LOCAL_SERVER_DEFAULT_MAX_RESTARTS;
    const activeSession = this.options.core.getActiveSessionById(sessionId) as ActiveLocalServerSession | undefined;
    const attempts = activeSession?.restartAttempts ?? 0;
    if (attempts >= maxRestarts) {
      this.options.core.updateLocalServerSessionStatus(sessionId, "failed");
      return;
    }

    const nextAttempts = this.options.core.incrementLocalServerRestartAttempts(sessionId);
    const backoff = Math.min(
      LOCAL_SERVER_INITIAL_BACKOFF_MS * Math.pow(2, nextAttempts - 1),
      LOCAL_SERVER_MAX_BACKOFF_MS
    );
    const restartEntry: InternalRunningEntry = {
      ...entry,
      restartTimer: setTimeout(() => {
        if (this.disposed) return;
        void this.retryStart(sessionId, config);
      }, backoff)
    };
    this.entries.set(sessionId, restartEntry);
    this.options.core.updateLocalServerSessionStatus(sessionId, "restarting");
  }

  private async retryStart(sessionId: string, config: LocalServerConfig): Promise<void> {
    if (this.disposed) return;
    this.entries.delete(sessionId);
    try {
      await this.start(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.diagnostics?.(`[Local Server retry ${config.name}] ${message}`);
      this.options.core.updateLocalServerSessionStatus(sessionId, "failed");
    }
  }

  private cleanupSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      this.clearTimers(entry);
    }
    this.entries.delete(sessionId);
    this.options.terminals.delete(sessionId);
    this.options.core.unregisterLocalServerSession(sessionId);
  }

  private clearTimers(entry: InternalRunningEntry): void {
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    if (entry.stableTimer) {
      clearTimeout(entry.stableTimer);
      entry.stableTimer = undefined;
    }
    if (entry.stopGraceTimer) {
      clearTimeout(entry.stopGraceTimer);
      entry.stopGraceTimer = undefined;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll(false);
    // stop() defers final cleanup to handleExit() (real event or grace
    // timer); the manager is going away right now, so cancel any pending
    // grace timers instead of letting them fire against a disposed manager.
    for (const entry of this.entries.values()) {
      this.clearTimers(entry);
    }
    this.entries.clear();
    for (const sub of this.subscriptions) {
      try { sub.dispose(); } catch { /* tolerate */ }
    }
    this.subscriptions.length = 0;
  }
}

export function wireLocalServerTerminalCloseListener(
  ctx: Pick<CommandContext, "localServerTerminals" | "core"> & { manager?: LocalServerManager }
): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((terminal) => {
    for (const [sessionId, entry] of ctx.localServerTerminals.entries()) {
      if (entry.terminal === terminal) {
        const running = ctx.manager?.getRunningEntry(sessionId);
        if (running) {
          running.userInitiatedStop = true;
        }
        ctx.localServerTerminals.delete(sessionId);
        ctx.core.unregisterLocalServerSession(sessionId);
      }
    }
  });
}
