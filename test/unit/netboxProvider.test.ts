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
        expect(String(call[0]).startsWith("http://evil.internal")).toBe(false);
        expect(String(call[0]).startsWith("https://netbox.local")).toBe(true);
      }
    });

    it("F2 — throws a protocol error when a page is empty but the reported count says more remain (kills silent truncation / an infinite loop)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 50, results: [] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({ kind: "protocol" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("truncates at the 10,000-device hard cap and warns, instead of collecting every reported item", async () => {
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
    });

    it("F2 — bounds iterations even when every page is non-empty but short of the reported count (kills an unbounded pagination loop)", async () => {
      let calls = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        calls++;
        if (calls > 100) {
          // An unbounded implementation would get this far; the resulting
          // empty-page-with-nonzero-remaining response throws fast (F2) instead
          // of looping forever, so this test still terminates either way.
          return makeResponse(200, { count: 1_000_000, results: [] });
        }
        const offset = Number(new URL(url).searchParams.get("offset"));
        return makeResponse(200, { count: 1_000_000, results: [{ id: offset + 1, name: `d${offset}`, primary_ip: { address: "10.0.0.1/24" } }] });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(calls).toBeLessThanOrEqual(41);
      expect(tree.devices.length).toBeLessThanOrEqual(41);
    });
  });

  describe("device/VM mapping", () => {
    it("skips devices without a name or without a primary IP, aggregating them into one warning (kills host: undefined)", async () => {
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

      expect(tree.devices).toHaveLength(1);
      expect(tree.devices[0].externalId).toBe("device:1");
      expect(tree.warnings.some((w) => w.includes("2") && w.toLowerCase().includes("primary ip"))).toBe(true);
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
