import type * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type { TerminalLoggerFactory } from "../logging/terminalLogger";
import type { SerialSidecarManager } from "../services/serial/serialSidecarManager";
import type { SilentAuthSshFactory } from "../services/ssh/silentAuth";
import type { TunnelManager } from "../services/tunnel/tunnelManager";

export type ServerTerminalMap = Map<string, Set<vscode.Terminal>>;
export type SerialTerminalMap = Map<string, { terminal: vscode.Terminal; profileId: string }>;

export interface CommandContext {
  core: NexusCore;
  tunnelManager: TunnelManager;
  serialSidecar: SerialSidecarManager;
  sshFactory: SilentAuthSshFactory;
  loggerFactory: TerminalLoggerFactory;
  terminalsByServer: ServerTerminalMap;
  serialTerminals: SerialTerminalMap;
}
