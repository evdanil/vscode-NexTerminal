import * as vscode from "vscode";
import { hostSshAgentLookup, resolveSshAgent, toSshAgentMode, type SshAgentChoice } from "./sshAgentLocator";

/**
 * The connector's agent lookup, reading `nexus.ssh.agent` and
 * `nexus.ssh.agentPath` on every call, so a change applies at the next
 * connection with no reload. Both settings are machine-scoped in
 * package.json: VS Code ignores them in workspace settings, so a repository
 * the user opens can never redirect their key signing to another agent.
 */
export function sshAgentResolver(): () => SshAgentChoice {
  return () => {
    const config = vscode.workspace.getConfiguration("nexus.ssh");
    const customPath = config.get<unknown>("agentPath");
    return resolveSshAgent(
      hostSshAgentLookup({
        mode: toSshAgentMode(config.get<unknown>("agent")),
        customPath: typeof customPath === "string" ? customPath : ""
      })
    );
  };
}

/**
 * The button offered wherever an SSH Agent login failure is shown (the
 * terminal's failure notice and Test Connection), so both say the same thing
 * and land in the same place.
 */
export const OPEN_AGENT_SETTINGS = "Open Agent Settings";

/** The Nexus settings panel at the SSH category, where the SSH Agent settings live. */
export function openAgentSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand("nexus.settings.openPanel", "ssh");
}
