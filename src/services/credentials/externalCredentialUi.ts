import * as vscode from "vscode";
import { findCredentialProviderError } from "./credentialProviderError";

/** User-initiated connection surfaces only; background callers retain silent refusal. */
export async function showExternalCredentialError(error: unknown, serverId?: string): Promise<boolean> {
  const provider = findCredentialProviderError(error);
  if (!provider) return false;
  const actions: string[] = [];
  if ((provider.code === "approval-required" || provider.code === "configuration-changed") && serverId) {
    actions.push("Connect");
  } else if (["unconfigured", "spawn-failed", "invalid-response", "output-too-large", "timed-out", "exited", "unsupported-consumer"].includes(provider.code)) {
    actions.push("Manage Auth Profiles");
  } else if (provider.code === "cleanup-failed") {
    actions.push("Reload Window");
  }
  const choice = await vscode.window.showErrorMessage(provider.message, ...actions);
  if (choice === "Manage Auth Profiles") {
    // A jump hop may own the error: do not falsely select the target's profile.
    await vscode.commands.executeCommand("nexus.authProfile.manage");
  } else if (choice === "Connect" && serverId) {
    await vscode.commands.executeCommand("nexus.server.connect", serverId);
  } else if (choice === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
  return true;
}
