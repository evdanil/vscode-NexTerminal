import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { PasswordPrompt, PasswordPromptResult } from "./contracts";

export class VscodePasswordPrompt implements PasswordPrompt {
  public async prompt(server: ServerConfig): Promise<PasswordPromptResult | undefined> {
    const password = await vscode.window.showInputBox({
      title: `Nexus Password: ${server.name}`,
      prompt: `Enter password for ${server.username}@${server.host}`,
      password: true,
      ignoreFocusOut: true
    });
    if (!password) {
      return undefined;
    }
    const saveChoice = await vscode.window.showQuickPick(["Yes", "No"], {
      title: "Save password in system keychain?",
      canPickMany: false
    });
    return {
      password,
      save: saveChoice === "Yes"
    };
  }
}
