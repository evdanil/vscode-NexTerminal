import { describe, expect, it } from "vitest";
import {
  fetchProviderStatus,
  validateInventoryStatusReport,
  type InventoryStatusReport
} from "../../src/models/inventory";

/**
 * fetchStatus provider capability (Phase 2). Every answer a third-party provider
 * can return is validated before it reaches the tree, and anything it cannot
 * fully vouch for degrades to `undefined` — "no status update", never a throw
 * into the refresh path and never a partial report applied.
 */
describe("validateInventoryStatusReport", () => {
  it("passes a well-formed report through unchanged, including optional console fields", () => {
    const report: InventoryStatusReport = {
      contractVersion: 1,
      statuses: {
        "lab/a.unl#1": { state: "running", consoleHost: "10.0.0.1", consolePort: 32769 },
        "lab/a.unl#2": { state: "stopped" }
      }
    };
    const result = validateInventoryStatusReport(report);
    expect(result).toEqual(report);
  });

  it("rejects a wrong contractVersion (⊘ accepting version 2 would apply a report whose shape this code never agreed to)", () => {
    expect(validateInventoryStatusReport({ contractVersion: 2, statuses: {} })).toBeUndefined();
    expect(validateInventoryStatusReport({ contractVersion: "1", statuses: {} })).toBeUndefined();
  });

  it("rejects a non-object top-level value or a non-object statuses map", () => {
    expect(validateInventoryStatusReport(null)).toBeUndefined();
    expect(validateInventoryStatusReport(42)).toBeUndefined();
    expect(validateInventoryStatusReport({ contractVersion: 1 })).toBeUndefined();
    expect(validateInventoryStatusReport({ contractVersion: 1, statuses: [] })).toBeUndefined();
    expect(validateInventoryStatusReport({ contractVersion: 1, statuses: "x" })).toBeUndefined();
  });

  it("rejects the whole report when ANY status value has a bad state (⊘ silently dropping one bad entry would apply a partial report keyed differently than the provider intended)", () => {
    expect(
      validateInventoryStatusReport({
        contractVersion: 1,
        statuses: { a: { state: "running" }, b: { state: "paused" } }
      })
    ).toBeUndefined();
    expect(
      validateInventoryStatusReport({ contractVersion: 1, statuses: { a: { state: 2 } } })
    ).toBeUndefined();
    expect(
      validateInventoryStatusReport({ contractVersion: 1, statuses: { a: "running" } })
    ).toBeUndefined();
  });

  it("rejects a non-string consoleHost or a non-finite / non-number consolePort (⊘ a NaN/Infinity port would be persisted and dialled)", () => {
    expect(
      validateInventoryStatusReport({ contractVersion: 1, statuses: { a: { state: "running", consolePort: Number.NaN } } })
    ).toBeUndefined();
    expect(
      validateInventoryStatusReport({ contractVersion: 1, statuses: { a: { state: "running", consolePort: Number.POSITIVE_INFINITY } } })
    ).toBeUndefined();
    expect(
      validateInventoryStatusReport({ contractVersion: 1, statuses: { a: { state: "running", consolePort: "32769" } } })
    ).toBeUndefined();
    expect(
      validateInventoryStatusReport({ contractVersion: 1, statuses: { a: { state: "running", consoleHost: 10 } } })
    ).toBeUndefined();
  });

  it("accepts an empty statuses map (a source with no devices reports nothing running)", () => {
    expect(validateInventoryStatusReport({ contractVersion: 1, statuses: {} })).toEqual({ contractVersion: 1, statuses: {} });
  });

  it("is prototype-pollution-safe AND preserves a __proto__ own key as real data (⊘ writing into a plain `{}` triggers the inherited setter — the entry is silently dropped and `state` leaks onto Object.prototype)", () => {
    const raw = JSON.parse('{"contractVersion":1,"statuses":{"__proto__":{"state":"running"},"real":{"state":"stopped"}}}');
    const result = validateInventoryStatusReport(raw);
    expect(result).toBeDefined();
    expect(result?.statuses.real).toEqual({ state: "stopped" });
    // The __proto__ device key survives as a genuine own data property — not
    // swallowed by a prototype setter — and nothing leaked onto Object.prototype.
    const descriptor = Object.getOwnPropertyDescriptor(result!.statuses, "__proto__");
    expect(descriptor).toBeDefined();
    expect(descriptor?.value).toEqual({ state: "running" });
    expect(({} as Record<string, unknown>).state).toBeUndefined();
    // A neutral object's prototype is untouched.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("fetchProviderStatus", () => {
  const validReport: InventoryStatusReport = {
    contractVersion: 1,
    statuses: { "lab/a.unl#1": { state: "running", consolePort: 5000 } }
  };

  it("returns undefined for a provider that does not implement fetchStatus (⊘ throwing would break refresh for NetBox and every provider that never opts in)", async () => {
    expect(await fetchProviderStatus({}, { baseUrl: "http://eve" }, {})).toBeUndefined();
  });

  it("returns undefined when fetchStatus throws, never letting the exception escape into the refresh loop", async () => {
    const result = await fetchProviderStatus(
      { fetchStatus: async () => { throw new Error("boom"); } },
      {},
      {}
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for a malformed report (⊘ passing an unvalidated return straight through would apply garbage to the tree)", async () => {
    const result = await fetchProviderStatus(
      { fetchStatus: async () => ({ contractVersion: 1, statuses: { a: { state: "paused" } } }) as unknown as InventoryStatusReport },
      {},
      {}
    );
    expect(result).toBeUndefined();
  });

  it("passes a valid report through", async () => {
    const result = await fetchProviderStatus({ fetchStatus: async () => validReport }, {}, {});
    expect(result).toEqual(validReport);
  });

  it("hands the provider a COPY of config, so an in-place normalization cannot mutate the caller's stored source config (⊘ passing source.config straight through mutates globalState with no revision bump)", async () => {
    const live = { baseUrl: "HTTP://EVE/" };
    const seen: unknown[] = [];
    await fetchProviderStatus(
      {
        fetchStatus: async (config) => {
          seen.push(config);
          (config as Record<string, unknown>).baseUrl = "mutated";
          return validReport;
        }
      },
      live,
      {}
    );
    expect(seen[0]).not.toBe(live);
    expect(live).toEqual({ baseUrl: "HTTP://EVE/" });
  });

  it("returns undefined when the config cannot be cloned, rather than throwing into the refresh path", async () => {
    const uncloneable = { baseUrl: (() => "nope") as unknown as string };
    const result = await fetchProviderStatus({ fetchStatus: async () => validReport }, uncloneable, {});
    expect(result).toBeUndefined();
  });
});
