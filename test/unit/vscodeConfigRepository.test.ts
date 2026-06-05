import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { VscodeConfigRepository } from "../../src/storage/vscodeConfigRepository";
import type { ServerConfig } from "../../src/models/config";

/**
 * A fake ExtensionContext whose globalState mirrors VS Code semantics: the
 * default is returned ONLY when the key is absent. A stored value of any shape
 * (including a corrupt non-array) is returned verbatim.
 */
function makeContext(state: Record<string, unknown>) {
  return {
    globalState: {
      get(key: string, fallback: unknown) {
        return key in state ? state[key] : fallback;
      },
      async update(key: string, value: unknown) {
        if (value === undefined) delete state[key];
        else state[key] = value;
      }
    }
  } as unknown as import("vscode").ExtensionContext;
}

const validServer: ServerConfig = {
  id: "s1",
  name: "Prod",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  authType: "password"
};

// Each read method, paired with the globalState key it reads.
const READS = [
  { key: "nexus.servers", call: (r: VscodeConfigRepository) => r.getServers() },
  { key: "nexus.tunnels", call: (r: VscodeConfigRepository) => r.getTunnels() },
  { key: "nexus.serialProfiles", call: (r: VscodeConfigRepository) => r.getSerialProfiles() },
  { key: "nexus.localShellProfiles", call: (r: VscodeConfigRepository) => r.getLocalShellProfiles() },
  { key: "nexus.groups", call: (r: VscodeConfigRepository) => r.getGroups() },
  { key: "nexus.authProfiles", call: (r: VscodeConfigRepository) => r.getAuthProfiles() }
];

const CORRUPT_SHAPES: Array<[string, unknown]> = [
  ["an object", { not: "an array" }],
  ["a string", "corrupt"],
  ["null", null],
  ["a number", 42]
];

describe("VscodeConfigRepository corrupt globalState shapes", () => {
  for (const { key, call } of READS) {
    for (const [label, shape] of CORRUPT_SHAPES) {
      it(`${key} returns [] (not throw) when state holds ${label}`, async () => {
        const repo = new VscodeConfigRepository(makeContext({ [key]: shape }));
        await expect(call(repo)).resolves.toEqual([]);
      });
    }
  }

  it("getServers still returns valid entries when the array is well-formed", async () => {
    const repo = new VscodeConfigRepository(makeContext({ "nexus.servers": [validServer] }));
    await expect(repo.getServers()).resolves.toEqual([validServer]);
  });

  it("getServers returns [] when the key is absent", async () => {
    const repo = new VscodeConfigRepository(makeContext({}));
    await expect(repo.getServers()).resolves.toEqual([]);
  });

  it("getGroups drops non-string entries inside an array", async () => {
    const repo = new VscodeConfigRepository(makeContext({ "nexus.groups": ["a", 1, null, "b"] }));
    await expect(repo.getGroups()).resolves.toEqual(["a", "b"]);
  });
});
