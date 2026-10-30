import * as vscode from "vscode";
import type { CommandContext } from "./types";
import { AuthProfileEditorPanel } from "../ui/authProfileEditorPanel";

import { revokeExternalApprovals } from "../services/credentials/externalCredentialSessionActions";
export { EXTERNAL_APPROVALS_REVOKED } from "../services/credentials/externalCredentialSessionActions";

export function registerExternalCredentialCommands(ctx: Pick<CommandContext, "externalCredentialResolver">): vscode.Disposable[] {
  return [vscode.commands.registerCommand("nexus.authProfile.revokeExternalApprovals", () => {
    const message = revokeExternalApprovals(ctx.externalCredentialResolver);
    AuthProfileEditorPanel.notifyExternalApprovals(message);
    void vscode.window.showInformationMessage(message);
  })];
}
