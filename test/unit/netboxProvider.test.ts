import { describe, expect, it, vi } from "vitest";
import {
  NETBOX_PROVIDER_ID,
  DEFAULT_FOLDER_TEMPLATE,
  createNetboxProvider,
  stripCidr,
  renderFolderTemplate
} from "../../src/services/inventory/providers/netboxProvider";

function makeResponse(status: number, body: unknown): { status: number; text: () => Promise<string> } {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, text: async () => text };
}

describe("stripCidr", () => {
  it("strips an IPv4 CIDR suffix", () => {
    expect(stripCidr("192.0.2.10/24")).toBe("192.0.2.10");
  });

  it("strips an IPv6 CIDR suffix (kills a first-colon-based implementation)", () => {
    expect(stripCidr("2001:db8::5/64")).toBe("2001:db8::5");
  });

  it("returns the address unchanged when there is no CIDR suffix", () => {
    expect(stripCidr("10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("renderFolderTemplate", () => {
  it("drops an empty segment after substitution rather than leaving a dangling separator", () => {
    expect(renderFolderTemplate("{site}/{rack}", { site: "Sydney", rack: "" })).toBe("Sydney");
  });

  it("renders unknown tokens as empty (documented) rather than leaving the literal placeholder", () => {
    expect(renderFolderTemplate("{bogus}/{site}", { site: "Sydney" })).toBe("Sydney");
  });

  it("keeps both segments when both resolve", () => {
    expect(renderFolderTemplate(DEFAULT_FOLDER_TEMPLATE, { site: "Sydney", rack: "R1" })).toBe("Sydney/R1");
  });

  it("returns an empty string when every segment is empty", () => {
    expect(renderFolderTemplate("{site}/{rack}", {})).toBe("");
  });
});

describe("createNetboxProvider", () => {
  it("has the expected id and a stable config field order (drives sequential add-source prompts)", () => {
    const provider = createNetboxProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.id).toBe(NETBOX_PROVIDER_ID);
    expect(provider.configFields.map((f) => f.id)).toEqual(["baseUrl", "apiToken", "filter", "folderTemplate", "includeVms"]);
    expect(provider.configFields.find((f) => f.id === "apiToken")?.type).toBe("password");
  });

  describe("pagination", () => {
    it("paginates by offset, ignores a malicious `next`, and fetches every device exactly once (kills following next verbatim / off-by-one)", async () => {
      const total = 520;
      const devices = Array.from({ length: total }, (_, i) => ({
        id: i + 1,
        name: `dev-${i + 1}`,
        primary_ip: { address: `10.0.0.${(i % 250) + 1}/24` },
        site: { name: "Sydney" }
      }));
      const requestedOffsets: number[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        const parsed = new URL(url);
        const offset = Number(parsed.searchParams.get("offset"));
        const limit = Number(parsed.searchParams.get("limit"));
        requestedOffsets.push(offset);
        return makeResponse(200, {
          count: total,
          // Attacker/misconfig-controlled — a follow-next implementation would
          // end up requesting this host instead of the configured baseUrl.
          next: "http://evil.internal/api/dcim/devices/?offset=999999",
          results: devices.slice(offset, offset + limit)
        });
      });

      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);
      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(total);
      expect(new Set(tree.devices.map((d) => d.externalId)).size).toBe(total);
      expect(requestedOffsets).toEqual([0, 250, 500]);
      for (const call of fetchImpl.mock.calls) {
        expect(new URL(String(call[0])).origin).toBe("https://netbox.local");
      }
    });

    it("FINDING 1 — aborts with a protocol error when a later page reports a different count than the first page (kills silently continuing with shifted offsets)", async () => {
      // Page 1 reports count 520 (2 more pages expected at limit=250). Page 2
      // reports 519 — as if a device was deleted server-side between the two
      // requests. A naive loop that overwrites `count` on every page would
      // just keep going with offsets that no longer line up with the
      // now-smaller collection (skipping or duplicating a still-existing
      // device); this must fail loudly instead.
      let call = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        call++;
        const offset = Number(new URL(url).searchParams.get("offset"));
        const reportedCount = call === 1 ? 520 : 519;
        const results = Array.from({ length: Math.min(250, reportedCount - offset) }, (_, i) => ({
          id: offset + i + 1,
          name: `d${offset + i}`,
          primary_ip: { address: "10.0.0.1/24" }
        }));
        return makeResponse(200, { count: reportedCount, results });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      let caught: unknown;
      try {
        await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ kind: "protocol" });
      expect(String((caught as { message?: string }).message)).toContain("520");
      expect(String((caught as { message?: string }).message)).toContain("519");
    });

    it("FINDING 1 — a stable count across every page still succeeds (sanity companion — kills over-strict rejection of a normal multi-page fetch)", async () => {
      const total = 520;
      const fetchImpl = vi.fn(async (url: string) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        const results = Array.from({ length: Math.min(250, total - offset) }, (_, i) => ({
          id: offset + i + 1,
          name: `d${offset + i}`,
          primary_ip: { address: "10.0.0.1/24" }
        }));
        return makeResponse(200, { count: total, results });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(total);
    });

    it("F2 — throws a protocol error when a page is empty but the reported count says more remain (kills silent truncation / an infinite loop)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 50, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({ kind: "protocol" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("rejects a negative `count` instead of reading it as a complete empty inventory (kills accept-as-empty on `{ count: -1, results: [] }`)", async () => {
      // `0 < -1` is false, so the pagination loop's `collected.length < count` guard never
      // runs a single iteration — a malformed/negative count must fail loudly here rather
      // than silently pass through as "there is nothing to sync", which would prune every
      // server this endpoint owns.
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: -1, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({ kind: "protocol" });
    });

    it("a genuinely empty inventory (`{ count: 0, results: [] }`) still resolves without error (sanity companion — kills over-strict rejection of a legitimate empty result)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 0, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(0);
    });

    it("count 20,000 capped at 10,000 — truncates at the hard cap and warns, instead of collecting every reported item (and marks the tree truncated so the engine skips pruning)", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        const results = Array.from({ length: 250 }, (_, i) => ({
          id: offset + i + 1,
          name: `d${offset + i}`,
          primary_ip: { address: "10.0.0.1/24" }
        }));
        return makeResponse(200, { count: 20_000, results });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices.length).toBeLessThanOrEqual(10_000);
      expect(tree.warnings.some((w) => w.includes("10000") && w.toLowerCase().includes("truncat"))).toBe(true);
      expect(tree.truncated).toBe(true);
    });

    it("FIX 3 — an inventory of exactly 10,000 devices (the hard cap) is NOT marked truncated and gets no truncation warning (kills always-mark-at-cap)", async () => {
      const total = 10_000;
      const fetchImpl = vi.fn(async (url: string) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        const remaining = total - offset;
        const pageSize = Math.min(250, remaining);
        const results = Array.from({ length: pageSize }, (_, i) => ({
          id: offset + i + 1,
          name: `d${offset + i}`,
          primary_ip: { address: "10.0.0.1/24" }
        }));
        return makeResponse(200, { count: total, results });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(total);
      expect(tree.truncated).toBeUndefined();
      expect(tree.warnings.some((w) => w.toLowerCase().includes("truncat"))).toBe(false);
    });

    it("F2 — a server that clamps our requested limit=250 down to 100 items per page still completes the fetch (kills a fixed-iteration bound sized for 250-item pages)", async () => {
      // The server "clamps" our requested limit=250 down to 100 items per page.
      // A fixed bound tuned to 250-item pages (41 iterations = 4100 items) could
      // never reach the reported count of 5000 — this must now succeed by
      // deriving the iteration bound from the page size NetBox actually used.
      const total = 5_000;
      const requestedOffsets: number[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        requestedOffsets.push(offset);
        const results = Array.from({ length: 100 }, (_, i) => ({
          id: offset + i + 1,
          name: `d${offset + i}`,
          primary_ip: { address: "10.0.0.1/24" }
        }));
        return makeResponse(200, { count: total, results });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(total);
      expect(new Set(tree.devices.map((d) => d.externalId)).size).toBe(total);
      expect(requestedOffsets).toEqual(Array.from({ length: 50 }, (_, i) => i * 100));
      expect(tree.truncated).toBeUndefined();
    });

    it("F2 — still throws a protocol error for a genuinely stuck server whose page size collapses after a fast start (kills a bound that only ever grows/never re-anchors)", async () => {
      // First page is a full 250-item page (establishing an optimistic bound),
      // then every subsequent page shrinks to 10 items while `count` keeps
      // reporting far more remain. The bound stays anchored to the largest
      // page size actually demonstrated (250), so it runs out long before
      // reaching the reported count — this must still fail loudly rather than
      // silently returning a partial inventory.
      let calls = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        calls++;
        const offset = Number(new URL(url).searchParams.get("offset"));
        const pageSize = calls === 1 ? 250 : 10;
        const results = Array.from({ length: pageSize }, (_, i) => ({
          id: offset + i + 1,
          name: `d${offset + i}`,
          primary_ip: { address: "10.0.0.1/24" }
        }));
        return makeResponse(200, { count: 20_000, results });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({ kind: "protocol" });
      // Bound = ceil(min(20000,10000)/250)+1 = 41 — well short of what 10-item
      // pages would need, and cheap enough to assert the loop actually terminates.
      expect(calls).toBeLessThanOrEqual(41);
    });
  });

  describe("device/VM mapping", () => {
    it("(FIX 1) still emits devices without a name or without a primary IP into the tree — with empty endpoints — instead of dropping them, while still aggregating one warning (kills host: undefined AND kills drop-at-mapper causing the sync engine to prune their owned servers)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 3,
          results: [
            { id: 1, name: "good", primary_ip: { address: "10.0.0.1/24" } },
            { id: 2, name: "", primary_ip: { address: "10.0.0.2/24" } },
            { id: 3, name: "no-ip", primary_ip: null }
          ]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      // All three are present on the tree — the two unmappable ones just carry
      // no ssh endpoint, rather than being silently absent (which the sync
      // engine would read as "deleted at the source").
      expect(tree.devices).toHaveLength(3);
      const byExternalId = new Map(tree.devices.map((d) => [d.externalId, d]));
      expect(byExternalId.get("device:1")?.endpoints).toHaveLength(1);
      expect(byExternalId.get("device:2")?.endpoints).toEqual([]);
      expect(byExternalId.get("device:3")?.endpoints).toEqual([]);
      expect(tree.warnings.some((w) => w.includes("2") && w.toLowerCase().includes("primary ip"))).toBe(true);
    });

    it("(FIX 1) a device with an id and a name but no primary IP appears in tree.devices with an empty endpoints array (kills drop-at-mapper)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 1,
          results: [{ id: 42, name: "no-primary-ip-device", primary_ip: null }]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(1);
      expect(tree.devices[0]).toMatchObject({ externalId: "device:42", name: "no-primary-ip-device", endpoints: [] });
    });

    it("prefixes device/vm externalIds so a shared numeric id coexists instead of colliding (kills unprefixed String(id))", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes("virtual-machines")) {
          return makeResponse(200, { count: 1, results: [{ id: 7, name: "vm-seven", primary_ip: { address: "10.0.1.7/24" } }] });
        }
        return makeResponse(200, { count: 1, results: [{ id: 7, name: "device-seven", primary_ip: { address: "10.0.0.7/24" } }] });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local", includeVms: true }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(2);
      expect(tree.devices.map((d) => d.externalId).sort()).toEqual(["device:7", "vm:7"]);
    });

    it("never requests the virtual-machines endpoint when includeVms is omitted/false (kills unconditional VM fetch)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 0, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(fetchImpl.mock.calls.every((c) => !String(c[0]).includes("virtual-machines"))).toBe(true);
    });

    it("resolves the folder template's {role} from `role`, falling back to the legacy `device_role` (both NetBox schema generations)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 2,
          results: [
            { id: 1, name: "new-role-dev", primary_ip: { address: "10.0.0.1/24" }, site: { name: "Sydney" }, rack: { name: "R1" }, role: { name: "Core" } },
            { id: 2, name: "legacy-role-dev", primary_ip: { address: "10.0.0.2/24" }, site: { name: "Sydney" }, rack: { name: "R2" }, device_role: { name: "Edge" } }
          ]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local", folderTemplate: "{site}/{rack}/{role}" }, { apiToken: "tok" });

      const byName = new Map(tree.devices.map((d) => [d.name, d.folderPath]));
      expect(byName.get("new-role-dev")).toBe("Sydney/R1/Core");
      expect(byName.get("legacy-role-dev")).toBe("Sydney/R2/Edge");
    });
  });

  describe("filter handling (F11)", () => {
    it("appends the user filter to the devices request and normalizes a trailing /api/ base URL (no /api/api/)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 0, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await provider.fetchInventory({ baseUrl: "https://netbox.local/api/", filter: "status=active&site=syd" }, { apiToken: "tok" });

      const url = new URL(String(fetchImpl.mock.calls[0][0]));
      expect(url.pathname).toBe("/api/dcim/devices/");
      expect(url.pathname.includes("/api/api/")).toBe(false);
      expect(url.searchParams.get("status")).toBe("active");
      expect(url.searchParams.get("site")).toBe("syd");
    });

    it("strips reserved filter keys (limit/offset/brief), keeps Nexus's own pagination values, and warns (kills a naive param merge)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 0, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local", filter: "limit=1&status=active" }, { apiToken: "tok" });

      const url = new URL(String(fetchImpl.mock.calls[0][0]));
      expect(url.searchParams.get("limit")).toBe("250");
      expect(url.searchParams.get("status")).toBe("active");
      expect(tree.warnings.some((w) => w.toLowerCase().includes("reserved"))).toBe(true);
    });

    it("never applies the device filter to the VM request (F11 — filter is devices-only, documented in the field description)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 0, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await provider.fetchInventory({ baseUrl: "https://netbox.local", filter: "status=active", includeVms: true }, { apiToken: "tok" });

      const vmCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes("virtual-machines"));
      expect(vmCall).toBeDefined();
      expect(new URL(String(vmCall![0])).searchParams.get("status")).toBeNull();
    });
  });

  describe("error mapping", () => {
    it("maps HTTP 401 to an auth error", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(401, "unauthorized"));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "bad" })).rejects.toMatchObject({ kind: "auth" });
    });

    it("maps a network failure (ECONNREFUSED) to a network error", async () => {
      const err = new Error("connect ECONNREFUSED") as Error & { cause?: { code: string } };
      err.cause = { code: "ECONNREFUSED" };
      const fetchImpl = vi.fn(async () => {
        throw err;
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({ kind: "network" });
    });

    it("maps a 200 response with a non-JSON (HTML) body to a protocol error (kills a catch-all classification)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, "<html>not json</html>"));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({ kind: "protocol" });
    });
  });

  describe("testConnection", () => {
    it("succeeds via /api/status/ alone", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(String(url)).toContain("/api/status/");
        return makeResponse(200, { "netbox-version": "3.7.0" });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.testConnection({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("falls back to /api/dcim/devices/?limit=1&brief=true on a 404 from /api/status/ (older NetBox)", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes("/api/status/")) return makeResponse(404, "not found");
        return makeResponse(200, { count: 1, results: [{ id: 1 }] });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.testConnection({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).resolves.toBeUndefined();

      const devicesCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes("dcim/devices"));
      expect(devicesCall).toBeDefined();
      const url = new URL(String(devicesCall![0]));
      expect(url.searchParams.get("limit")).toBe("1");
      expect(url.searchParams.get("brief")).toBe("true");
    });

    it("does NOT fall back on 401 — bubbles as an auth error with a single request (kills fallback-on-every-error masking auth)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(401, "unauthorized"));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.testConnection({ baseUrl: "https://netbox.local" }, { apiToken: "bad" })).rejects.toMatchObject({ kind: "auth" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
