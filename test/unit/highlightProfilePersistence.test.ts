import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { NexusCore } from "../../src/core/nexusCore";
import { mergeServerConfigFields, serverConfigsEqual } from "../../src/models/config";
import { localServerConfigsEqual } from "../../src/models/localServer";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { VscodeConfigRepository } from "../../src/storage/vscodeConfigRepository";
import { computeSyncPlan } from "../../src/services/inventory/syncEngine";
import { validateLocalServerConfig, validateLocalShellProfile, validateSerialProfile, validateServerConfig } from "../../src/utils/validation";

const server = { id: "server", name: "Server", host: "host", port: 22, username: "u", authType: "agent" as const, isHidden: false };
const serial = { id: "serial", name: "Serial", path: "/dev/tty0", baudRate: 9600, dataBits: 8 as const, stopBits: 1 as const, parity: "none" as const, rtscts: false };
const shell = { id: "shell", name: "Shell", launchMode: "custom" as const, shellPath: "/bin/sh" };
const local = { id: "local", name: "Local", executable: "node" };

function context(state: Record<string, unknown> = {}) {
  return { globalState: {
    get: (key: string, fallback: unknown) => key in state ? state[key] : fallback,
    update: async (key: string, value: unknown) => { state[key] = JSON.parse(JSON.stringify(value)); }
  } } as unknown as import("vscode").ExtensionContext;
}

describe("saved highlight selections", () => {
  it("validates inherit, none, and bounded named selections on every saved record", () => {
    for (const [validate, base] of [
      [validateServerConfig, server], [validateSerialProfile, serial],
      [validateLocalShellProfile, shell], [validateLocalServerConfig, local]
    ] as const) {
      for (const value of [undefined, null, "profile-1", "x".repeat(100)]) {
        expect(validate({ ...base, highlightProfileId: value }), String(value)).toBe(true);
      }
      for (const value of ["", "  ", "x".repeat(101), 3, {}, []]) {
        expect(validate({ ...base, highlightProfileId: value }), JSON.stringify(value)).toBe(false);
      }
    }
  });

  it("round-trips all three selections across add, edit, reload, and snapshots", async () => {
    for (const repository of [new InMemoryConfigRepository(), new VscodeConfigRepository(context())]) {
      const core = new NexusCore(repository);
      await core.initialize();
      for (const selection of [undefined, null, "profile-1"] as const) {
        await core.addOrUpdateServer({ ...server, highlightProfileId: selection });
        await core.addOrUpdateSerialProfile({ ...serial, highlightProfileId: selection });
        await core.addOrUpdateLocalShellProfile({ ...shell, highlightProfileId: selection });
        await core.addOrUpdateLocalServerConfig({ ...local, highlightProfileId: selection });
        const reloaded = new NexusCore(repository);
        await reloaded.initialize();
        const snapshot = reloaded.getSnapshot();
        expect(snapshot.servers[0].highlightProfileId).toBe(selection);
        expect(snapshot.serialProfiles[0].highlightProfileId).toBe(selection);
        expect(snapshot.localShellProfiles[0].highlightProfileId).toBe(selection);
        expect(snapshot.localServers[0].highlightProfileId).toBe(selection);
      }
    }
  });

  it("loads malformed selections as none without dropping usable records", async () => {
    const repo = new VscodeConfigRepository(context({
      "nexus.servers": [{ ...server, highlightProfileId: {} }],
      "nexus.serialProfiles": [{ ...serial, highlightProfileId: "" }],
      "nexus.localShellProfiles": [{ ...shell, highlightProfileId: 7 }],
      "nexus.localServers": [{ ...local, highlightProfileId: "x".repeat(101) }]
    }));
    expect((await repo.getServers())[0]?.highlightProfileId).toBeNull();
    expect((await repo.getSerialProfiles())[0]?.highlightProfileId).toBeNull();
    expect((await repo.getLocalShellProfiles())[0]?.highlightProfileId).toBeNull();
    expect((await repo.getLocalServers())[0]?.highlightProfileId).toBeNull();
  });

  it("distinguishes selection changes during server and local-server comparisons", () => {
    expect(serverConfigsEqual(server, { ...server, highlightProfileId: null })).toBe(false);
    expect(serverConfigsEqual({ ...server, highlightProfileId: null }, { ...server, highlightProfileId: "p" })).toBe(false);
    expect(localServerConfigsEqual(local, { ...local, highlightProfileId: null })).toBe(false);
  });

  it("preserves a concurrent selection edit during a failed inventory write rollback", () => {
    const prior = { ...server, highlightProfileId: "old" };
    const batch = { ...prior, host: "updated" };
    expect(mergeServerConfigFields(prior, batch, { ...batch, highlightProfileId: null })).toMatchObject({ host: "host", highlightProfileId: null });
    expect(mergeServerConfigFields(prior, batch, { ...batch, highlightProfileId: undefined }).highlightProfileId).toBeUndefined();
  });

  it("preserves manual selections when an inventory device is re-synced", () => {
    const source = { id: "source", providerId: "netbox", name: "Inventory", targetFolder: "Inventory", prunePolicy: "orphan" as const, defaultUsername: "u", config: {}, secretFieldIds: [] };
    const tree = { contractVersion: 1 as const, devices: [{ externalId: "device", name: "Device", endpoints: [{ kind: "ssh" as const, host: "host" }] }] };
    const initial = computeSyncPlan({ source, tree, currentServers: [], now: 1000 });
    expect(initial.adds).toHaveLength(1);
    expect(initial.adds[0].highlightProfileId).toBeUndefined();
    for (const selection of [null, "profile-1"] as const) {
      const saved = { ...initial.adds[0], highlightProfileId: selection };
      const renamedTree = { ...tree, devices: [{ ...tree.devices[0], name: "Renamed" }] };
      const sync = computeSyncPlan({ source, tree: renamedTree, currentServers: [saved], now: 2000 });
      expect(sync.updates).toHaveLength(1);
      expect(sync.updates[0].after.name).toBe("Renamed");
      expect(sync.updates[0].after.highlightProfileId).toBe(selection);
    }
  });

});
