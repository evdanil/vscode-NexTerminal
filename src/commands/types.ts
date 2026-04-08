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
  highlighter: TerminalHighlighter;
  macroAutoTrigger: MacroAutoTrigger;
  sftpService: SftpService;
  fileExplorerProvider: FileExplorerTreeProvider;
  secretVault?: SecretVault;
  registrySync?: TunnelRegistrySync;
  focusedTerminal?: vscode.Terminal;
  activityIndicators: Map<string, { setActivityIndicator(active: boolean): void }>;
}
