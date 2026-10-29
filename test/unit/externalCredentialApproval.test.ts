import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalAuthProfile } from "../../src/models/authProfile";
import type { ExternalCredentialRequest } from "../../src/services/credentials/contracts";
import { createExternalCredentialApproval } from "../../src/services/credentials/externalCredentialApproval";
import { createVscodeExternalCredentialApproval } from "../../src/services/credentials/vscodeExternalCredentialApproval";

vi.mock("vscode", () => ({
  workspace: { isTrusted: true, registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })), openTextDocument: vi.fn(async (uri) => ({ uri })) },
  env: { remoteName: "ssh-remote" },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), activeTextEditor: undefined, showTextDocument: vi.fn(async (document) => { (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = { document }; }) },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
  Uri: { parse: (uri: string) => ({ toString: () => uri }) },
  EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn(); }
}));
import * as vscode from "vscode";

const profile = (): ExternalAuthProfile => ({ id: "provider", name: "Vault", authType: "external", external: { version: 1, method: "password", invocation: { executable: "/provider", args: ["vault item"] } } });
const request = (p = profile(), controller = new AbortController()): ExternalCredentialRequest => ({ profile: p, signal: controller.signal, interaction: "interactive", isCurrent: () => true });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const approvals: ReturnType<typeof createExternalCredentialApproval>[] = [];
function setup(confirm = vi.fn<(profile: ExternalAuthProfile, signal: AbortSignal) => Promise<boolean>>(async () => true), trusted = true) { const approval = createExternalCredentialApproval({ isWorkspaceTrusted: () => trusted, confirm }); approvals.push(approval); return { approval, confirm }; }
afterEach(() => { approvals.splice(0).forEach((a) => a.dispose()); vi.clearAllMocks(); });

describe("session approval", () => {
  it("starts empty, does not authorize on creation, and refuses noninteractive and untrusted calls without a dialog", async () => {
    const { approval, confirm } = setup();
    expect(confirm).not.toHaveBeenCalled();
    await expect(approval.authorize({ ...request(), interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
    expect(confirm).not.toHaveBeenCalled();
    const untrusted = setup(vi.fn(async () => true), false);
    await expect(untrusted.approval.authorize(request())).rejects.toMatchObject({ code: "untrusted-workspace" });
    expect(untrusted.confirm).not.toHaveBeenCalled();
  });
  it("keys grants by profile id, executable, args and method; a fresh host starts empty", async () => {
    const { approval, confirm } = setup();
    await approval.authorize(request());
    await approval.authorize({ ...request(), interaction: "noninteractive" });
    expect(confirm).toHaveBeenCalledTimes(1);
    for (const change of [
      (p: ExternalAuthProfile) => { p.id = "another"; },
      (p: ExternalAuthProfile) => { p.external.method = "key"; },
      (p: ExternalAuthProfile) => { p.external.invocation!.executable = "/replacement"; },
      (p: ExternalAuthProfile) => { p.external.invocation!.args = ["different"]; }
    ]) { const p = profile(); change(p); await approval.authorize(request(p)); }
    expect(confirm).toHaveBeenCalledTimes(5);
    await expect(setup().approval.authorize({ ...request(), interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
  });
  it("shares only the question and cancelling one owner preserves the other", async () => {
    const answer = deferred<boolean>(); const confirm = vi.fn((_profile: ExternalAuthProfile, _signal: AbortSignal) => answer.promise); const { approval } = setup(confirm);
    const first = new AbortController(); const a = approval.authorize(request(profile(), first)).catch((e: unknown) => e);
    const b = approval.authorize(request()); await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1); first.abort("SECRET");
    expect(await a).toMatchObject({ code: "cancelled" }); expect(confirm.mock.calls[0][1].aborted).toBe(false);
    answer.resolve(true); await b;
  });
  it("cancelling every owner prevents a late allow from granting approval", async () => {
    const answer = deferred<boolean>(); const { approval } = setup(vi.fn(() => answer.promise)); const c = new AbortController();
    const a = approval.authorize(request(profile(), c)).catch((e: unknown) => e); c.abort(); answer.resolve(true); await a; await Promise.resolve();
    await expect(approval.authorize({ ...request(), interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
  });
  it("revocation advances generation, removes grants and synchronously notifies subscribers", async () => {
    const { approval } = setup(); await approval.authorize(request()); const before = approval.generation("provider");
    const listener = vi.fn(); const off = approval.onDidRevoke(listener); approval.revoke(["provider"]);
    expect(approval.generation("provider")).toBeGreaterThan(before); expect(listener).toHaveBeenCalledWith(["provider"]);
    await expect(approval.authorize({ ...request(), interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
    off(); approval.revoke(); expect(listener).toHaveBeenCalledTimes(1);
  });
  it("revocation while asking rejects a late allow and does not grant the replacement generation", async () => {
    const answer = deferred<boolean>(); const { approval } = setup(vi.fn(() => answer.promise));
    const a = approval.authorize(request()).catch((e: unknown) => e); await Promise.resolve(); approval.revoke(); answer.resolve(true);
    expect(await a).toMatchObject({ code: "configuration-changed" }); await Promise.resolve();
    await expect(approval.authorize({ ...request(), interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
  });
  it("decline is not remembered, and stale owners cannot create a grant", async () => {
    const { approval, confirm } = setup(vi.fn(async () => false));
    await expect(approval.authorize(request())).rejects.toMatchObject({ code: "cancelled" });
    confirm.mockResolvedValue(true); await approval.authorize(request()); expect(confirm).toHaveBeenCalledTimes(2);
    const answer = deferred<boolean>(); const other = setup(vi.fn(() => answer.promise)); let current = true;
    const a = other.approval.authorize({ ...request(), isCurrent: () => current }).catch((e: unknown) => e);
    current = false; answer.resolve(true); expect(await a).toMatchObject({ code: "configuration-changed" });
    await expect(other.approval.authorize({ ...request(), interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
  });
  it("disposal rejects pending owners immediately and prevents late native approval", async () => {
    const answer = deferred<boolean>(); const { approval } = setup(vi.fn(() => answer.promise));
    const pending = approval.authorize(request()).catch((e: unknown) => e); await Promise.resolve(); approval.dispose();
    expect(await pending).toMatchObject({ code: "cancelled" }); answer.resolve(true); await Promise.resolve();
    await expect(approval.authorize(request())).rejects.toMatchObject({ code: "cancelled" });
  });
  it("does not expose raw confirmation failures and refuses after disposal", async () => {
    const { approval } = setup(vi.fn(async () => { throw new Error("SECRET"); }));
    const error = await approval.authorize(request()).catch((e: unknown) => e); expect(error).toMatchObject({ code: "approval-required" }); expect(String(error)).not.toContain("SECRET");
    approval.dispose(); await expect(approval.authorize(request())).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("native approval disclosure", () => {
  it("discloses complete indexed reversible argv and host authority without truncation", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue({ title: "Allow for This Session" });
    const approval = createVscodeExternalCredentialApproval(); approvals.push(approval);
    const p = profile(); p.name = "Name\n\u202eSpoof";
    p.external.invocation!.args = ['quote"slash\\\t\b\f\u0001\u0085\u2028\u2029\u202eend', ...Array.from({ length: 31 }, () => "x".repeat(4096))];
    const pending = approval.authorize(request(p));
    await vi.waitFor(() => expect(vscode.window.showTextDocument).toHaveBeenCalled());
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    const provider = vi.mocked(vscode.workspace.registerTextDocumentContentProvider).mock.calls[0][1];
    const detail = await provider.provideTextDocumentContent(vscode.window.activeTextEditor!.document.uri, {} as vscode.CancellationToken) as string;
    const callback = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === "nexus.authProfile.continueExternalApproval")![1];
    await callback(); await pending;
    const [message, options] = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    expect(message).not.toContain("\n"); expect(message).not.toContain("\u202e");
    expect((options as { detail: string }).detail).toContain("read-only document just reviewed");
    expect(detail).toContain('Executable: "/provider"');
    p.external.invocation!.args.forEach((arg, index) => { const line = detail.split("\n").find((l) => l.startsWith(`argv[${index}]: `)); expect(JSON.parse(line!.slice(line!.indexOf(": ") + 2))).toBe(arg); });
    expect(detail).toContain('argv[32]: "--pass"'); expect(detail).toContain("ssh-remote");
    expect(detail).toContain("environment"); expect(detail).toContain("files"); expect(detail).toContain("network");
    expect(detail).toContain("mutable"); expect(detail).not.toContain("\u0085"); expect(detail).not.toContain("\u2028"); expect(detail).not.toContain("\u202e");
    expect(detail.length).toBeGreaterThan(31 * 4096);
  });
  it("ignores a native answer after cancellation", async () => {
    const answer = deferred<vscode.MessageItem | undefined>(); vi.mocked(vscode.window.showWarningMessage).mockReturnValue(answer.promise);
    const approval = createVscodeExternalCredentialApproval(); approvals.push(approval); const c = new AbortController();
    const pending = approval.authorize(request(profile(), c)).catch((e: unknown) => e);
    await vi.waitFor(() => expect(vscode.window.showTextDocument).toHaveBeenCalled());
    const callback = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === "nexus.authProfile.continueExternalApproval")![1];
    const modal = callback(); c.abort(); answer.resolve({ title: "Allow for This Session" }); await modal;
    expect(await pending).toMatchObject({ code: "cancelled" });
    await expect(approval.authorize({ ...request(), interaction: "noninteractive" })).rejects.toMatchObject({ code: "approval-required" });
  });
});
