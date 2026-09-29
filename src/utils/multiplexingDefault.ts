import * as vscode from "vscode";

/**
 * The global multiplexing default, read the way the connection pool reads it
 * (`server.multiplexing ?? nexus.ssh.multiplexing.enabled`). Start fences use it
 * to compare a server's EFFECTIVE multiplexing, so an unset value only equals an
 * explicit one when that explicit value matches the global setting.
 */
export function readMultiplexingDefault(): boolean {
  try {
    return vscode.workspace?.getConfiguration("nexus.ssh.multiplexing").get<boolean>("enabled", true) ?? true;
  } catch {
    return true;
  }
}
