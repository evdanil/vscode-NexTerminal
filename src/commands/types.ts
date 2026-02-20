import type * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { TerminalLoggerFactory } from "../logging/terminalLogger";
import type { SerialSidecarManager } from "../services/serial/serialSidecarManager";
import type { SftpService } from "../services/sftp/sftpService";
import type { SshFactory, SshPoolControl } from "../services/ssh/contracts";
import type { TerminalHighlighter } from "../services/terminalHighlighter";
import type { TunnelManager } from "../services/tunnel/tunnelManager";
import type { TunnelRegistrySync } from "../services/tunnel/tunnelRegistrySync";
import type { FileExplorerTreeProvider } from "../ui/fileExplorerTreeProvider";

export type ServerTerminalMap = Map<string, Set<vscode.Terminal>>;
export type SessionTerminalMap = Map<string, vscode.Terminal>;
export type SerialTerminalMap = Map<string, { terminal: vscode.Terminal; profileId: string }>;

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
  sftpService: SftpService;
  fileExplorerProvider: FileExplorerTreeProvider;
  registrySync?: TunnelRegistrySync;
}
