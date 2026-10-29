import { describe, expect, it, vi } from "vitest";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import { externalAuthProfileUnsupportedReason, keyDeploymentUnavailableReason } from "../../src/models/authProfile";
import type { CommandContext } from "../../src/commands/types";
import { profileTokenServer, resolveIpmiTerminalEnv } from "../../src/commands/ipmiCredentials";
import { resolveProfileTokens } from "../../src/services/profileTokens";
import { computeSyncPlan } from "../../src/services/inventory/syncEngine";

const { showErrorMessage, showInputBox, executeCommand } = vi.hoisted(() => ({ showErrorMessage: vi.fn(), showInputBox: vi.fn(), executeCommand: vi.fn() }));
vi.mock("vscode", () => ({ window: { showErrorMessage, showInputBox }, commands: { executeCommand } }));

const external: AuthProfile = { id: "external", name: "Program", authType: "external", external: { version: 1, method: "key" } };
const server: ServerConfig = { id: "server", name: "Server", host: "192.0.2.1", port: 22, username: "dormant-account", authType: "key", keyPath: "/dormant/key", authProfileId: external.id, ipmiAuthProfileId: external.id, isHidden: false };
function context(profile: AuthProfile | undefined = external) {
  const resolve = vi.fn(); const get = vi.fn(async () => "stale-password");
  const ctx = { core: { getAuthProfile: () => profile }, secretVault: { get }, externalCredentialResolver: { resolve } } as unknown as CommandContext;
  return { ctx, resolve, get };
}

describe("external credential consumer boundaries", () => {
  it("does not expose dormant usernames or retrieve a program response for tokens", () => {
    const { ctx, resolve, get } = context(); const facts = profileTokenServer(ctx, server);
    expect(facts.username).toBe(""); expect(facts.ipmiUsername).toBeUndefined();
    for (const token of ["username", "ipmiUsername"]) {
      const result = resolveProfileTokens('${profile.' + token + '}', facts);
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error.message).toContain("unavailable"); expect(result.error.message).not.toContain("dormant-account"); }
    }
    expect(resolveProfileTokens("${profile.host}", facts)).toEqual({ ok: true, text: server.host, unknownTokens: [] });
    expect(resolveProfileTokens("$${profile.username}", facts)).toEqual({ ok: true, text: "${profile.username}", unknownTokens: [] });
    expect(resolve).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it.each(["external", "missing"])("refuses %s IPMI before a stale vault slot or fallback prompt", async (kind) => {
    showErrorMessage.mockReset(); showInputBox.mockReset(); executeCommand.mockReset();
    const { ctx, resolve, get } = context();
    if (kind === "missing") vi.spyOn(ctx.core, "getAuthProfile").mockReturnValue(undefined);
    showErrorMessage.mockResolvedValue("Manage Auth Profiles");
    expect(await resolveIpmiTerminalEnv(ctx, server)).toEqual({ kind: "cancelled" });
    expect(get).not.toHaveBeenCalled(); expect(showInputBox).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith("nexus.authProfile.manage", external.id);
  });
  it("returns fixed safe unsupported reasons without using a profile display name", () => {
    const hostile = { ...external, name: "untrusted\nprofile" };
    expect(externalAuthProfileUnsupportedReason(hostile, "ipmi")).toContain("SSH only");
    expect(externalAuthProfileUnsupportedReason(hostile, "key-deployment")).not.toContain(hostile.name);
    expect(externalAuthProfileUnsupportedReason(undefined, "ipmi")).toBeUndefined();
    expect(keyDeploymentUnavailableReason(server, undefined)).toContain("no longer exists");
  });
  it.each([true, false])("inventory assigns an external key source without retrieval (configured=%s)", (configured) => {
    const profile: AuthProfile = { ...external, external: { ...external.external, ...(configured ? { invocation: { executable: "/example/provider", args: [] } } : {}) } };
    const plan = computeSyncPlan({ source: { id: "source", providerId: "netbox", name: "Inventory", targetFolder: "Inventory", prunePolicy: "orphan", defaultUsername: "static-metadata", config: {}, secretFieldIds: [], authProfileId: profile.id }, authProfile: profile, tree: { contractVersion: 1, devices: [{ externalId: "device", name: "Device", endpoints: [{ kind: "ssh", host: "192.0.2.1" }] }] }, currentServers: [], now: 1 });
    expect(plan.adds[0].authProfileId).toBe(profile.id); expect(plan.adds[0].username).toBe("static-metadata");
    expect(plan.warnings.join(" ")).not.toContain("key path");
  });
});
