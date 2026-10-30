import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { CredentialProviderError } from "../../src/services/credentials/credentialProviderError";
import { showExternalCredentialError } from "../../src/services/credentials/externalCredentialUi";
vi.mock("vscode", () => ({ window: { showErrorMessage: vi.fn() }, commands: { executeCommand: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
describe("external credential remedies", () => {
  it("offers profile repair using safe error text even through a wrapper", async () => {
    const error = new CredentialProviderError("invalid-response");
    error.message = "PROVIDER-CANARY";
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce("Manage Auth Profiles" as never);
    expect(await showExternalCredentialError(new Error("WRAPPER-CANARY", { cause: error }), "target")).toBe(true);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(new CredentialProviderError("invalid-response").message, "Manage Auth Profiles");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("nexus.authProfile.manage");
    expect(JSON.stringify(vi.mocked(vscode.window.showErrorMessage).mock.calls)).not.toContain("CANARY");
  });
  it("offers an interactive Connect for approval without automatically retrying the program", async () => {
    await showExternalCredentialError(new CredentialProviderError("approval-required"), "target");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(new CredentialProviderError("approval-required").message, "Connect");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce("Connect" as never);
    await showExternalCredentialError(new CredentialProviderError("approval-required"), "target");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("nexus.server.connect", "target");
  });
  it("does not invent a Connect target or intercept unrelated connection errors", async () => {
    await showExternalCredentialError(new CredentialProviderError("approval-required"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(new CredentialProviderError("approval-required").message);
    vi.clearAllMocks();
    expect(await showExternalCredentialError(new Error("ECONNREFUSED"), "target")).toBe(false);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});
