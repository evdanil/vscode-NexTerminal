import { describe, expect, it } from "vitest";
import { validateServerConfig } from "../../src/utils/validation";
import { serverConfigsEqual, mergeServerConfigFields } from "../../src/models/config";
import type { ServerConfig } from "../../src/models/config";

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "R1",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    authType: "agent",
    isHidden: false,
    ...overrides
  };
}

/**
 * ADDRESSLESS (Codex P1 on #82) — a synced placeholder server for a device with
 * no usable primary endpoint (a stopped EVE node, a VNC-console node, a NetBox
 * row with no IP). It carries `addressless: true` and an empty `host`, and must
 * survive the storage/import validation boundary that would otherwise drop any
 * empty-host record.
 */
describe("validateServerConfig — addressless", () => {
  it("accepts an addressless server with an empty host and no usable port (⊘ requiring a non-empty host drops the sync's own placeholder output on reload)", () => {
    expect(validateServerConfig(server({ addressless: true, host: "", port: 0 }))).toBe(true);
  });

  it("still REQUIRES a non-empty host when NOT addressless — a hand-created empty-host server fails exactly as before (⊘ relaxing host unconditionally lets a broken hand entry through)", () => {
    expect(validateServerConfig(server({ host: "" }))).toBe(false);
    expect(validateServerConfig(server({ host: "", port: 0 }))).toBe(false);
    expect(validateServerConfig(server({ addressless: false, host: "" }))).toBe(false);
  });

  it("treats a non-boolean `addressless` as false (fail-closed) — an empty-host record with a junk flag still fails (⊘ any-truthy coercion would let a hostile `addressless:\"x\"` smuggle an empty host past validation)", () => {
    expect(validateServerConfig({ ...server(), addressless: "true", host: "" } as never)).toBe(false);
    expect(validateServerConfig({ ...server(), addressless: 1, host: "" } as never)).toBe(false);
  });

  it("keeps a normal addressed server valid whether or not the addressless field is present-and-false", () => {
    expect(validateServerConfig(server())).toBe(true);
    expect(validateServerConfig(server({ addressless: false }))).toBe(true);
  });
});

describe("serverConfigsEqual — addressless", () => {
  it("treats a flip of the addressless flag as a DIFFERENCE, so an upgrade/downgrade is never dropped as a no-op (⊘ omitting the field calls an addressless→addressed server 'unchanged' and the sync never applies the fix)", () => {
    // Same host on both sides so ONLY the flag differs — isolating the field.
    const a = server({ addressless: true, host: "" });
    const b = server({ addressless: false, host: "" });
    expect(serverConfigsEqual(a, b)).toBe(false);
  });

  it("treats absent addressless and explicit false as equal (absent ≡ false — no spurious churn on legacy records)", () => {
    expect(serverConfigsEqual(server(), server({ addressless: false }))).toBe(true);
  });
});

describe("addressless export/import round-trip", () => {
  it("survives a JSON round-trip (a backup) unchanged — still valid, still addressless (⊘ a validator that dropped the empty-host record silently loses it on the next reload)", () => {
    const original = server({
      addressless: true,
      host: "",
      port: 0,
      origin: { sourceId: "src", externalId: "e1", syncedAt: 1 }
    });
    const roundTripped = JSON.parse(JSON.stringify(original)) as ServerConfig;
    expect(validateServerConfig(roundTripped)).toBe(true);
    expect(roundTripped.addressless).toBe(true);
    expect(roundTripped.host).toBe("");
    expect(serverConfigsEqual(original, roundTripped)).toBe(true);
  });
});

describe("mergeServerConfigFields — addressless", () => {
  it("keeps a concurrent addressless flip on `current` rather than reverting it to `prior` (⊘ omitting the field silently reverts a downgrade the batch wrote)", () => {
    const prior = server({ addressless: false, host: "10.0.0.1" });
    const batchSnapshot = server({ addressless: false, host: "10.0.0.1" });
    const current = server({ addressless: true, host: "" });
    const merged = mergeServerConfigFields(prior, batchSnapshot, current);
    expect(merged.addressless).toBe(true);
    expect(merged.host).toBe("");
  });

  it("falls back to prior's addressless when the batch did not change it", () => {
    const prior = server({ addressless: true, host: "" });
    const batchSnapshot = server({ addressless: true, host: "" });
    const current = server({ addressless: true, host: "" });
    expect(mergeServerConfigFields(prior, batchSnapshot, current).addressless).toBe(true);
  });
});
