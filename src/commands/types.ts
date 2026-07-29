import type * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { TerminalLoggerFactory } from "../logging/terminalLogger";
import type { SerialSidecarManager } from "../services/serial/serialSidecarManager";
import type { SftpService } from "../services/sftp/sftpService";
import type { SecretVault, SshFactory, SshPoolControl } from "../services/ssh/contracts";
import type { MacroAutoTrigger } from "../services/macroAutoTrigger";
import type { TerminalHighlighter } from "../services/terminalHighlighter";
import type { TunnelManager } from "../services/tunnel/tunnelManager";
import type { TunnelRegistrySync } from "../services/tunnel/tunnelRegistrySync";
import type { FileExplorerTreeProvider } from "../ui/fileExplorerTreeProvider";
import type { ScriptRuntimeManager } from "../services/scripts/scriptRuntimeManager";
import type { TerminalRegistry } from "../services/terminal/terminalRegistry";
import type { ElevationBroker, NexusFileSystemProvider } from "../services/sftp/nexusFileSystemProvider";
import type { CwdTracker } from "../services/terminal/cwdTracker";
import type { CwdSyncCoordinator } from "../services/sftp/cwdSyncCoordinator";

export type ServerTerminalMap = Map<string, Set<vscode.Terminal>>;
export type SessionTerminalMap = Map<string, vscode.Terminal>;
export interface SerialTerminalEntry {
  terminal: vscode.Terminal;
  profileId: string;
  transportSessionId?: string;
  smartFollow?: boolean;
  /**
   * Path of the COM port currently held by this session. Set on connect, cleared
   * while waiting/disconnected. Used by Smart Follow to filter out ports already
   * owned by other Nexus serial sessions before opening or showing pickers.
   */
  activePath?: string;
}

export type SerialTerminalMap = Map<string, SerialTerminalEntry>;
export interface LocalShellTerminalEntry {
  terminal: vscode.Terminal;
  profileId: string;
  pty?: import("../models/config").SessionPtyHandle;
}
export type LocalShellTerminalMap = Map<string, LocalShellTerminalEntry>;

export interface CommandContext {
  core: NexusCore;
  tunnelManager: TunnelManager;
  serialSidecar: SerialSidecarManager;
  sshFactory: SshFactory;
  sshPool: SshPoolControl;
  loggerFactory: TerminalLoggerFactory;
  sessionLogDir: string;
  terminalsByServer: ServerTerminalMap;
  sessionTerminals: SessionTerminalMap;
  serialTerminals: SerialTerminalMap;
  localShellTerminals: LocalShellTerminalMap;
  highlighter: TerminalHighlighter;
  macroAutoTrigger: MacroAutoTrigger;
  sftpService: SftpService;
  fileExplorerProvider: FileExplorerTreeProvider;
  fileSystemProvider?: NexusFileSystemProvider;
  elevationBroker?: ElevationBroker;
  secretVault?: SecretVault;
  registrySync?: TunnelRegistrySync;
  focusedTerminal?: vscode.Terminal;
  activityIndicators: Map<string, { setActivityIndicator(active: boolean): void }>;
  scriptRuntimeManager?: ScriptRuntimeManager;
  terminalRegistry?: TerminalRegistry;
  localShellOutputChannel?: vscode.OutputChannel;
  globalStoragePath: string;
  extensionPath: string;
  globalState: vscode.Memento;
  /**
   * Directory-sync (issue #35) infrastructure — all optional so existing test
   * harnesses that build a `CommandContext` literal without them keep
   * type-checking unchanged; production wiring (`extension.ts`) always
   * supplies them.
   */
  cwdTracker?: CwdTracker;
  cwdSyncCoordinator?: CwdSyncCoordinator;
  /** Per-session last-output timestamp, fed by the OSC 7 observer in
   * `serverCommands.ts` and read by `CwdSyncDeps.lastOutputAt` (§7.5 staleness). */
  cwdLastOutputAt?: Map<string, number>;
  /** Diagnostics sink for directory-sync suppressions/failures (§7.6). */
  cwdSyncOutputChannel?: vscode.OutputChannel;
}
