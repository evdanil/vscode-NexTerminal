import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchProviderStatus } from "../../src/models/inventory";
import { createContainerlabProvider } from "../../src/services/inventory/providers/containerlabProvider";
import type { ContainerlabInspection, ContainerlabRuntime } from "../../src/services/inventory/containerlabRuntimeContracts";

const CONFIG = { location: "local" as const };
const FIXTURE = readFileSync(join(__dirname, "../fixtures/containerlab/inspect-0.80.0.json"), "utf8");

describe("Containerlab inventory provider", () => {
  it("declares validated SSH profile metadata, route defaults, and template matching keys without control capabilities", () => {
    const provider = createContainerlabProvider();
    expect(provider.id).toBe("containerlab");
    expect(provider.configFields.find((field) => field.id === "labHostId")).toMatchObject({ type: "ssh-profile" });
    expect(provider.attributeKeys).toEqual(["lab", "kind", "image", "nodeName", "name"]);
    expect(provider.sourceDefaultRoute?.({ location: "ssh", labHostId: "profile-1" })).toEqual({ kind: "ssh", jumpHostId: "profile-1" });
    expect(provider.sourceDefaultRoute?.({ location: "local" })).toEqual({ kind: "direct" });
    expect(provider).not.toHaveProperty("instanceKey");
    expect(provider).not.toHaveProperty("controlNode");
    expect(provider).not.toHaveProperty("webConsoleUrl");
  });

  it("keeps the same metadata without a runtime and reports a clear unsupported-runtime error on execution", async () => {
    const provider = createContainerlabProvider();
    expect(provider.configFields).toEqual(createContainerlabProvider({
      inspect: async () => ({ version: "0.80.0", stdout: "{}" })
    }).configFields);
    await expect(provider.testConnection({}, {})).rejects.toThrow(/runtime.*unavailable|unsupported.*runtime/i);
    await expect(provider.fetchInventory({}, {})).rejects.toThrow(/runtime.*unavailable|unsupported.*runtime/i);
    await expect(provider.fetchStatus?.({}, {})).rejects.toThrow(/runtime.*unavailable|unsupported.*runtime/i);
  });

  it("uses the injected runtime and strictly parses the response for Test, fetch, and status", async () => {
    const inspection: ContainerlabInspection = { version: "0.80.0", stdout: FIXTURE };
    const inspect = vi.fn(async () => inspection);
    const runtime: ContainerlabRuntime = { inspect };
    const provider = createContainerlabProvider(runtime);
    const context = { intent: "test" as const, subject: { kind: "form" as const, sessionId: "session-1" } };

    await expect(provider.testConnection(CONFIG, {}, context)).resolves.toBeUndefined();
    const tree = await provider.fetchInventory(CONFIG, {}, context);
    const status = await provider.fetchStatus?.(CONFIG, {}, context);
    expect(tree.devices).toHaveLength(1);
    expect(status).toEqual(tree.status);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(inspect).toHaveBeenNthCalledWith(1, expect.objectContaining({ location: "local" }), context);
    expect(inspect).toHaveBeenNthCalledWith(2, expect.objectContaining({ location: "local" }), context);
    expect(inspect).toHaveBeenNthCalledWith(3, expect.objectContaining({ location: "local" }), context);
  });

  it("passes operation context through the status validation helper", async () => {
    const inspect = vi.fn(async () => ({ version: "0.80.0", stdout: FIXTURE }));
    const provider = createContainerlabProvider({ inspect });
    const context = { intent: "background-status" as const, subject: { kind: "source" as const, sourceId: "source-1", revision: "revision-2" } };
    await expect(fetchProviderStatus(provider, CONFIG, {}, context)).resolves.toMatchObject({ contractVersion: 1 });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ location: "local" }), context);
  });

  it("validates all rows before applying a lab filter in provider fetches", async () => {
    const malformed = JSON.stringify({
      selected: [],
      other: [{}]
    });
    const provider = createContainerlabProvider({ inspect: async () => ({ version: "0.80.0", stdout: malformed }) });
    await expect(provider.fetchInventory({ location: "local", labFilter: "selected" }, {})).rejects.toThrow();
  });

  it("does not expose the runtime module through its browser-safe provider metadata", () => {
    const provider = createContainerlabProvider({ inspect: async () => ({ version: "0.80.0", stdout: "{}" }) });
    expect(provider.id).toBe("containerlab");
    expect(provider.attributeKeys).toContain("nodeName");
  });
});
