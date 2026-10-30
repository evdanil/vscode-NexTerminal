import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { registerExternalCredentialCommands, EXTERNAL_APPROVALS_REVOKED } from "../../src/commands/externalCredentialCommands";
const callbacks = new Map<string, () => void>();
const status = vi.fn();
vi.mock("vscode", () => ({ commands: { registerCommand: (id: string, callback: () => void) => { callbacks.set(id, callback); return { dispose: vi.fn() }; } }, window: { showInformationMessage: vi.fn() } }));
vi.mock("../../src/ui/authProfileEditorPanel", () => ({ AuthProfileEditorPanel: { notifyExternalApprovals: (message: string) => status(message) } }));
describe("external credential session commands", () => {
  it("revokes all through the injected resolver and reports status without saving a profile", () => {
    const revoke = vi.fn(); registerExternalCredentialCommands({ externalCredentialResolver: { revoke } });
    callbacks.get("nexus.authProfile.revokeExternalApprovals")!();
    expect(revoke).toHaveBeenCalledWith(); expect(status).toHaveBeenCalledWith(EXTERNAL_APPROVALS_REVOKED);
  });
  it("contributes revoke only in palette and review commands only for the disclosure editor", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    for (const id of ["revokeExternalApprovals", "continueExternalApproval", "cancelExternalApproval"]) expect(pkg.contributes.commands.some((c: { command: string }) => c.command === "nexus.authProfile." + id)).toBe(true);
    for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
      for (const entry of entries as { command: string; when?: string }[]) {
        if (entry.command === "nexus.authProfile.revokeExternalApprovals") expect(menu).toBe("commandPalette");
        if (entry.command === "nexus.authProfile.continueExternalApproval" || entry.command === "nexus.authProfile.cancelExternalApproval") {
          expect(["commandPalette", "editor/title"]).toContain(menu); expect(entry.when).toContain("resourceScheme == nexus-credential-invocation");
        }
      }
    }
    expect(Object.keys(pkg.contributes.configuration.properties).some((key: string) => /externalCredential|vault/i.test(key))).toBe(false);
  });
});
