import * as vscode from "vscode";
import { hostname } from "node:os";
import { createExternalCredentialApproval, type ExternalCredentialApproval } from "./externalCredentialApproval";
import { createExternalCredentialDisclosure, quoteExternalInvocation, type ExternalCredentialDisclosureHost } from "./externalCredentialDisclosure";

/** Register once at activation; disposal retires both pending documents and grants. */
export function createVscodeExternalCredentialApproval(facade?: ExternalCredentialDisclosureHost): ExternalCredentialApproval {
  const changes = facade ? undefined : new vscode.EventEmitter<vscode.Uri>();
  const disclosure = createExternalCredentialDisclosure(facade ?? {
    registerProvider: (scheme, read) => vscode.workspace.registerTextDocumentContentProvider(scheme, {
      onDidChange: changes!.event,
      provideTextDocumentContent: (uri) => read(uri.toString())
    }),
    registerCommand: (id, callback) => vscode.commands.registerCommand(id, callback),
    async showDocument(uri) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await vscode.window.showTextDocument(document, { preserveFocus: false, preview: false });
    },
    activeDocument: () => vscode.window.activeTextEditor?.document.uri.toString(),
    changed: (uri) => changes!.fire(vscode.Uri.parse(uri)),
    async confirm(message, detail) {
      const answer = await vscode.window.showWarningMessage(message, { modal: true, detail },
        { title: "Allow for This Session" }, { title: "Cancel", isCloseAffordance: true }, { title: "Back to Invocation" });
      return answer?.title;
    },
    status: (message) => { void vscode.window.showInformationMessage(message); },
    executionHost: () => `${quoteExternalInvocation(hostname())}${vscode.env.remoteName ? ` (remote environment: ${quoteExternalInvocation(vscode.env.remoteName)})` : " (local extension host)"}`
  });
  const approval = createExternalCredentialApproval({
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    confirm: (profile, signal) => disclosure.confirm(profile, signal)
  });
  return { ...approval, dispose() { approval.dispose(); disclosure.dispose(); changes?.dispose(); } };
}
