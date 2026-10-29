import * as vscode from "vscode";
import { hostname } from "node:os";
import { createExternalCredentialApproval, type ExternalCredentialApproval } from "./externalCredentialApproval";

/** Reversible literals prevent control/bidi characters from disguising argv boundaries. */
function quote(value: string): string {
  return '"' + Array.from(value, (character) =>
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(character)
      ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      : JSON.stringify(character).slice(1, -1)).join("") + '"';
}

export function createVscodeExternalCredentialApproval(): ExternalCredentialApproval {
  return createExternalCredentialApproval({
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    async confirm(profile, signal) {
      if (signal.aborted || !profile.external.invocation) return false;
      const { executable, args } = profile.external.invocation;
      const flag = profile.external.method === "password" ? "--pass" : "--pkey";
      const host = `${quote(hostname())}${vscode.env.remoteName ? ` (remote environment: ${quote(vscode.env.remoteName)})` : " (local extension host)"}`;
      const detail = [
        `Execution machine: ${host}`,
        `Executable: ${quote(executable)}`,
        ...[...args, flag].map((arg, index) => `argv[${index}]: ${quote(arg)}`),
        "",
        "This program runs with the extension-host user's privileges. It inherits the environment and can access files and the network on that machine.",
        "Approval covers this mutable program path and its dependencies; their contents are not cryptographically pinned.",
        "Do not put secrets in arguments: they are saved in configuration. Approval lasts only for this extension-host session."
      ].join("\n");
      // Keep the entire disclosure. Native modal readability at maximum configuration
      // size is a platform acceptance gate; MessageOptions offers no scrolling API.
      const answer = await vscode.window.showWarningMessage(`Allow external credential program for ${quote(profile.name)}?`,
        { modal: true, detail }, { title: "Allow for This Session" }, { title: "Cancel", isCloseAffordance: true });
      // VS Code cannot dismiss this modal through an AbortSignal; a late answer has no authority.
      return !signal.aborted && answer?.title === "Allow for This Session";
    }
  });
}
