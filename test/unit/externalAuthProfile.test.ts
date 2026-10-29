import { describe, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { VscodeConfigRepository } from "../../src/storage/vscodeConfigRepository";
import { NexusCore } from "../../src/core/nexusCore";
import {
  authProfileConnectionIdentity, authProfileFieldOwnership, authProfileNeedsServerKeyPath,
  authProfileOwnedCredentials, effectiveServerUsername, isExternalAuthProfile,
  type AuthProfile, type ExternalAuthProfile, type ServerConfig
} from "../../src/models/config";
import { connectDescriptor } from "../../src/models/startDescriptors";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { validateAuthProfile } from "../../src/utils/validation";
import { watchPoolInvalidationOnConfigMutation } from "../../src/services/ssh/poolConfigInvalidation";

function external(method: "password" | "key" = "password"): ExternalAuthProfile {
  return { id: "ext", name: "Vault", authType: "external", external: { version: 1, method,
    invocation: { executable: "/opt/credential program", args: ["/vault/item with spaces", 'literal"quote', "back\\slash"] } } };
}
const server: ServerConfig = { id: "jump", name: "Jump", host: "example.invalid", port: 22,
  username: "dormant", authType: "password", keyPath: "/dormant", isHidden: false, authProfileId: "ext" };

// Exercise foreign persisted input without asserting that malformed data is a model.
function candidate(patch: Record<string, unknown>) { return { ...external(), ...patch }; }
function invocation(executable: unknown, args: unknown) {
  return candidate({ external: { version: 1, method: "password", invocation: { executable, args } } });
}

describe("external auth profile validation", () => {
  it.each(["password", "key"] as const)("accepts configured and unconfigured %s profiles", (method) => {
    expect(validateAuthProfile(external(method))).toBe(true);
    expect(validateAuthProfile(candidate({ external: { version: 1, method } }))).toBe(true);
  });
  it.each(["id", "name", "authType"])("rejects wrong %s types", (field) => {
    for (const value of [undefined, "", null, 2, [], {}]) expect(validateAuthProfile(candidate({ [field]: value }))).toBe(false);
  });
  it("rejects unknown and prototype-pollution fields", () => {
    expect(validateAuthProfile(JSON.parse('{"id":"ext","name":"Vault","authType":"external","external":{"version":1,"method":"password"},"__proto__":{}}'))).toBe(false);
  });
  it("retains legacy password, key and agent validation", () => {
    for (const authType of ["password", "key", "agent"]) {
      expect(validateAuthProfile({ id: "old", name: "Old", username: " ", authType, keyPath: "" })).toBe(true);
    }
  });
  it.each(["username", "keyPath"])("rejects any forbidden %s property", (field) => {
    for (const value of [undefined, "", "legacy", null, 1]) {
      expect(validateAuthProfile(candidate({ [field]: value }))).toBe(false);
    }
  });
  it.each([null, [], {}, { version: 2, method: "password" }, { version: 1 },
    { version: 1, method: "agent" }, { version: "1", method: "password" },
    { version: 1, method: false }, { version: 1, method: "password", invocation: null },
    { version: 1, method: "password", extra: "pollution" }].map((value) => [value]))("rejects malformed external configuration %#", (value) => {
    expect(validateAuthProfile(candidate({ external: value }))).toBe(false);
  });
  it("rejects contradictory legacy/external objects", () => {
    expect(validateAuthProfile({ ...external(), authType: "password", username: "old" })).toBe(false);
  });
  it.each([null, false, 3, "x", [], { executable: "/bin/helper", args: [], extra: true },
    Object.create({ executable: "/bin/helper", args: [] })].map((value) => [value]))("rejects malformed invocation %#", (value) => {
    expect(validateAuthProfile(candidate({ external: { version: 1, method: "password", invocation: value } }))).toBe(false);
  });
  it.each(["helper", "./helper", "~/helper", "$HOME/helper", "", " /bin/helper",
    "/bin/help\u0000er", "/bin/help\ner", "/bin/help\u202eer", "C:helper", null, 2])("rejects malformed absolute executable %#", (path) => {
    expect(validateAuthProfile(invocation(path, []))).toBe(false);
  });
  it("accepts literal absolute POSIX, drive and UNC paths and zero args", () => {
    for (const executable of ["/opt/credential program", "C:\\Program Files\\helper.exe", "\\\\host\\share\\helper.exe"]) {
      expect(validateAuthProfile(invocation(executable, []))).toBe(true);
    }
    const value = external();
    const before = JSON.stringify(value);
    expect(validateAuthProfile(value)).toBe(true);
    expect(JSON.stringify(value)).toBe(before);
  });
  it.each([null, {}, "arg", Array(1), [null], [1], [""], ["\u0000"], ["a\rb"], ["a\nb"], [" a"], ["a "], ["a\t"],
    Array(33).fill("x"), ["x".repeat(4097)], ["é".repeat(2049)]].map((value) => [value]))("rejects unrepresentable argv %#", (args) => {
    expect(validateAuthProfile(invocation("/bin/helper", args))).toBe(false);
  });
  it("checks UTF-8 byte limits while preserving accepted bytes", () => {
    const args = ["é".repeat(2048), "x".repeat(4096), "inside space", '"literal"', "back\\slash"];
    expect(validateAuthProfile(invocation("/bin/helper", args))).toBe(true);
    expect(validateAuthProfile(invocation("/bin/helper", Array(32).fill("x")))).toBe(true);
  });
});

describe("external auth static values and dynamic ownership", () => {
  it("owns all credential fields without supplying dormant/static values", () => {
    expect(authProfileOwnedCredentials(external())).toEqual({});
    expect(authProfileFieldOwnership(external())).toEqual({ username: true, authType: true, keyPath: true });
    expect(effectiveServerUsername({ username: "dormant" }, external())).toBe("");
    expect(authProfileNeedsServerKeyPath(external("key"))).toBe(false);
    expect(isExternalAuthProfile(external())).toBe(true);
    expect(isExternalAuthProfile(undefined)).toBe(false);
  });
  it("derives stored ownership from usable values", () => {
    expect(authProfileFieldOwnership({ id: "old", name: "Old", authType: "key", username: " ", keyPath: "" }))
      .toEqual({ username: false, authType: true, keyPath: false });
    expect(authProfileFieldOwnership(undefined)).toEqual({ username: false, authType: false, keyPath: false });
  });
});

const identityChanges: Array<[string, (p: ExternalAuthProfile) => AuthProfile]> = [
  ["executable", (p) => ({ ...p, external: { ...p.external, invocation: { executable: "/bin/other", args: p.external.invocation!.args } } })],
  ["args", (p) => ({ ...p, external: { ...p.external, invocation: { ...p.external.invocation!, args: ["different"] } } })],
  ["method", (p) => ({ ...p, external: { ...p.external, method: "key" } })],
  // Invalid future versions must still invalidate a previously authorized connection.
  ["version", (p) => ({ ...p, external: { ...p.external, version: 2 } } as unknown as AuthProfile)],
  ["unconfigured", (p) => ({ ...p, external: { ...p.external, invocation: undefined } })]
];
describe("external auth connection identity", () => {
  it.each(identityChanges)("%s changes pure identity", (_label, change) => {
    const before = external();
    expect(authProfileConnectionIdentity(change(before))).not.toEqual(authProfileConnectionIdentity(before));
  });
  it.each(identityChanges)("%s changes start descriptors", (_label, change) => {
    const before = external();
    const descriptor = (p: AuthProfile) => connectDescriptor(server, { multiplexingDefault: true, authProfileLookup: () => p });
    expect(descriptor(change(before))).not.toBe(descriptor(before));
  });
  it.each(identityChanges)("%s invalidates transitive jump riders", async (_label, change) => {
    const before = external();
    const after = change(before);
    const repo = new InMemoryConfigRepository([server, { ...server, id: "mid", authProfileId: undefined,
      proxy: { type: "ssh", jumpHostId: "jump" } }, { ...server, id: "far", authProfileId: undefined,
      proxy: { type: "ssh", jumpHostId: "mid" } }], [], [], [], [before]);
    const core = new NexusCore(repo);
    await core.initialize();
    const invalidate = vi.fn();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate });
    await core.addOrUpdateAuthProfile(after);
    expect(new Set(invalidate.mock.calls.map(([id]) => id))).toEqual(new Set(["jump", "mid", "far"]));
    stop();
  });
  it("display rename leaves identity, descriptors and the pool unchanged", async () => {
    const before = external();
    const after = { ...before, name: "Renamed" };
    expect(authProfileConnectionIdentity(after)).toEqual(authProfileConnectionIdentity(before));
    const descriptor = (p: AuthProfile) => connectDescriptor(server, { multiplexingDefault: true, authProfileLookup: () => p });
    expect(descriptor(after)).toBe(descriptor(before));
    const core = new NexusCore(new InMemoryConfigRepository([server], [], [], [], [before]));
    await core.initialize();
    const invalidate = vi.fn();
    const stop = watchPoolInvalidationOnConfigMutation(core, { invalidate });
    await core.addOrUpdateAuthProfile(after);
    expect(invalidate).not.toHaveBeenCalled();
    stop();
  });
});

describe("external profile deletion requires explicit unlink", () => {
  it.each(["server SSH", "server IPMI", "source", "template SSH", "template IPMI"])("refuses %s references without any mutation", async (relation) => {
    const repo = new InMemoryConfigRepository();
    const core = new NexusCore(repo);
    await core.initialize();
    await core.addOrUpdateAuthProfile(external());
    if (relation.startsWith("server")) await core.addOrUpdateServer({ ...server,
      ...(relation === "server SSH" ? { authProfileId: "ext" } : { authProfileId: undefined, ipmiAuthProfileId: "ext" }) });
    if (relation === "source") await core.addOrUpdateInventorySource({ id: "src", providerId: "containerlab", name: "Source",
      targetFolder: "", prunePolicy: "orphan", defaultUsername: "u", config: { location: "local" }, secretFieldIds: [], authProfileId: "ext" });
    if (relation.startsWith("template")) await core.addOrUpdateDeviceTemplate({ id: "tpl", name: "Template", fields: {
      [relation === "template SSH" ? "authProfileId" : "ipmiAuthProfileId"]: { mode: "fill", value: "ext" } } });
    const before = core.getSnapshot();
    const changed = vi.fn();
    core.onDidChange(changed);
    await expect(core.removeAuthProfile("ext")).rejects.toThrow(/unlink|referenc/i);
    expect(core.getSnapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    if (relation.startsWith("server")) await core.addOrUpdateServer({ ...core.getServer("jump")!, authProfileId: undefined, ipmiAuthProfileId: undefined });
    if (relation === "source") await core.addOrUpdateInventorySource({ ...core.getSnapshot().inventorySources[0], authProfileId: undefined });
    if (relation.startsWith("template")) await core.addOrUpdateDeviceTemplate({ ...core.getSnapshot().deviceTemplates[0], fields: {} });
    await core.removeAuthProfile("ext");
    expect(core.getAuthProfile("ext")).toBeUndefined();
  });
});


describe("invalid external profile repository load", () => {
  it("rejects the malformed row while retaining its unresolved SSH link", async () => {
    const state: Record<string, unknown> = { "nexus.servers": [server], "nexus.authProfiles": [candidate({ external: { version: 2, method: "password" } })] };
    const context = { globalState: { get: (key: string, fallback: unknown) => state[key] ?? fallback,
      update: async (key: string, value: unknown) => { state[key] = value; } } } as unknown as import("vscode").ExtensionContext;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const core = new NexusCore(new VscodeConfigRepository(context));
      await core.initialize();
      expect(core.getAuthProfile("ext")).toBeUndefined();
      expect(core.getServer("jump")?.authProfileId).toBe("ext");
    } finally { warn.mockRestore(); }
  });
});
