import { describe, expect, it, vi } from "vitest";
import { createExternalCredentialDisclosure, EXTERNAL_CREDENTIAL_DISCLOSURE_SCHEME, type ExternalCredentialDisclosureHost } from "../../src/services/credentials/externalCredentialDisclosure";
import type { ExternalAuthProfile } from "../../src/models/config";

const profile = (): ExternalAuthProfile => ({ id: "p", name: "Program", authType: "external", external: { version: 1, method: "password", invocation: { executable: "/provider", args: ['a "quote"\\ x', "inside\t\u202evalue"] } } });
function harness() {
  let active: string | undefined;
  let provider: (uri: string) => string = () => "";
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const host: ExternalCredentialDisclosureHost = {
    registerProvider: vi.fn((_scheme, read) => { provider = read; return { dispose: vi.fn() }; }),
    registerCommand: vi.fn((id, command) => { commands.set(id, command); return { dispose: vi.fn() }; }),
    showDocument: vi.fn(async (uri) => { active = uri; }),
    activeDocument: () => active,
    changed: vi.fn(),
    confirm: vi.fn(async () => "Cancel"),
    status: vi.fn(),
    executionHost: () => "test-machine (remote environment: ssh-remote)",
  };
  const controller = createExternalCredentialDisclosure(host);
  return { controller, host, read: (uri: string) => provider(uri), commands, active: () => active!, select: (uri: string) => { active = uri; } };
}
const continueId = "nexus.authProfile.continueExternalApproval";
const cancelId = "nexus.authProfile.cancelExternalApproval";

describe("immutable external invocation disclosure", () => {
  it("shows the template and one escaped example while warning future values differ", async () => {
    const h = harness(); const p = profile();
    p.external.invocation = { executable: "/provider", args: ["--host", "${host}"], argumentExpansion: true };
    const answer = h.controller.confirm(p, new AbortController().signal, { executable: "/provider", args: ["--host", "example\u202ehost"] });
    const text = h.read(h.active());
    expect(text).toContain('${host}'); expect(text).toContain('example\\u202ehost'); expect(text).not.toContain("example\u202ehost");
    expect(text).toMatch(/future connection/i); expect(text).toMatch(/example/i);
    vi.mocked(h.host.confirm).mockResolvedValue("Allow for This Session");
    await h.commands.get(continueId)!(); expect(await answer).toBe(true);
    expect(String(vi.mocked(h.host.confirm).mock.calls[0][1])).toMatch(/future connection/i);
  });
  it("opens complete reversible text without consent; only native Allow grants", async () => {
    const h = harness(); const p = profile(); const signal = new AbortController();
    p.external.invocation!.args = [...p.external.invocation!.args, ...Array.from({ length: 30 }, (_, i) => "x".repeat(4088) + `END${i}`)];
    const original = [...p.external.invocation!.args, "--pass"];
    const answer = h.controller.confirm(p, signal.signal);
    const uri = h.active(); expect(uri).toContain(EXTERNAL_CREDENTIAL_DISCLOSURE_SCHEME); expect(uri).not.toContain("provider");
    p.external.invocation!.args = ["changed"];
    const text = h.read(uri);
    original.forEach((arg, index) => { const line = text.split("\n").find(l => l.startsWith(`argv[${index}]: `))!; expect(JSON.parse(line.slice(line.indexOf(": ") + 2))).toBe(arg); });
    expect(text).toContain("Argument count: 33"); expect(text).toContain("Continue External Credential Approval"); expect(text).toContain("environment");
    expect(text).not.toContain("\u202e"); expect(h.host.confirm).not.toHaveBeenCalled();
    vi.mocked(h.host.confirm).mockResolvedValue("Allow for This Session");
    await h.commands.get(continueId)!(true, { executable: "/forged" });
    expect(await answer).toBe(true); expect(h.host.confirm).toHaveBeenCalledOnce();
    expect(h.read(uri)).toBe("External credential invocation review completed or expired.");
  });
  it("Back preserves the same snapshot; unrelated and stale active editors fail closed", async () => {
    const h = harness(); const signal = new AbortController(); const answer = h.controller.confirm(profile(), signal.signal); const uri = h.active();
    h.select("file:/unrelated"); await h.commands.get(continueId)!(uri, true); expect(h.host.confirm).not.toHaveBeenCalled();
    h.select(uri); vi.mocked(h.host.confirm).mockResolvedValue("Back to Invocation"); await h.commands.get(continueId)!();
    expect(h.read(uri)).toContain('Executable: "/provider"');
    await h.commands.get(cancelId)!(); expect(await answer).toBe(false);
    await h.commands.get(continueId)!(); expect(h.host.confirm).toHaveBeenCalledOnce();
  });
  it("aborts and disposes active questions; a late native Allow is inert", async () => {
    const h = harness(); const signal = new AbortController(); const answer = h.controller.confirm(profile(), signal.signal);
    let allow!: (s: string) => void; vi.mocked(h.host.confirm).mockImplementation(() => new Promise(resolve => { allow = resolve; }));
    const modal = h.commands.get(continueId)!(); signal.abort(); expect(await answer).toBe(false); allow("Allow for This Session"); await modal;
    expect(h.read(h.active())).not.toContain("/provider");
    const second = h.controller.confirm(profile(), new AbortController().signal); h.controller.dispose(); expect(await second).toBe(false);
  });
  it("bounds active reviews without evicting existing questions and retains separate identities", async () => {
    const h = harness(); const answers = [];
    for (let i = 0; i < 32; i++) answers.push(h.controller.confirm({ ...profile(), id: String(i) }, new AbortController().signal));
    const last = h.active(); await expect(h.controller.confirm(profile(), new AbortController().signal)).rejects.toMatchObject({ code: "queue-full" });
    expect(h.read(last)).toContain("/provider"); h.controller.dispose(); expect(await Promise.all(answers)).toEqual(Array(32).fill(false));
  });
});
