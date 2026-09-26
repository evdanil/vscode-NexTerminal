import * as vscode from "vscode";
import type { ServerConfig } from "../../models/config";
import type { PasswordPrompt, PasswordPromptResult } from "./contracts";

export class VscodePasswordPrompt implements PasswordPrompt {
  public async prompt(server: ServerConfig, signal?: AbortSignal): Promise<PasswordPromptResult | undefined> {
    const cancellation = new vscode.CancellationTokenSource();
    const onAbort = (): void => cancellation.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const password = await vscode.window.showInputBox({
        title: `Nexus Password: ${server.name}`,
        prompt: `Enter password for ${server.username}@${server.host}`,
        password: true,
        ignoreFocusOut: true
      }, cancellation.token);
      if (!password || cancellation.token.isCancellationRequested) {
        return undefined;
      }
      const saveChoice = await vscode.window.showQuickPick(["Yes", "No"], {
        title: "Save password in system keychain?",
        canPickMany: false
      }, cancellation.token);
      if (cancellation.token.isCancellationRequested) return undefined;
      return {
        password,
        save: saveChoice === "Yes"
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      cancellation.dispose();
    }
  }
}
