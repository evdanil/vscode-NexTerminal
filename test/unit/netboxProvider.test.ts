import { describe, expect, it, vi } from "vitest";
import {
  NETBOX_PROVIDER_ID,
  DEFAULT_FOLDER_TEMPLATE,
  createNetboxProvider,
  netboxInstanceKey,
  stripCidr,
  renderFolderTemplate
} from "../../src/services/inventory/providers/netboxProvider";
import { hasConsoleEndpoint } from "../../src/models/inventory";
import { deviceMatchesFilter, parseTemplateFilter } from "../../src/services/inventory/templateApply";

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

/**
 * REVIEW FINDING (P1, cross-instance adoption) — this key decides whether a
 * server kept from a removed source may be reclaimed by a later one (see
 * `DetachedServerOrigin.instanceKey`, models/config.ts). Two deployments must
 * never collide onto one key, and one deployment must not fragment into several
 * — the first loses a record to a source that never synced it, the second breaks
 * the re-add this whole feature exists for.
 */
describe("netboxInstanceKey", () => {
  it("collapses every spelling of ONE deployment onto ONE key — trailing slashes, an /api suffix, host case, and the scheme's default port (kills a raw-string key, which fragments one instance into five and refuses the re-add it is supposed to allow)", () => {
    const canonical = "https://netbox.example.com";
    for (const spelling of [
      "https://netbox.example.com",
      "https://netbox.example.com/",
      "https://netbox.example.com///",
      "https://netbox.example.com/api",
      "https://netbox.example.com/api/",
      "https://NetBox.Example.COM",
      "https://netbox.example.com:443",
      "  https://netbox.example.com  ",
      "https://netbox.example.com?foo=bar",
      "https://netbox.example.com#frag"
    ]) {
      expect(netboxInstanceKey({ baseUrl: spelling })).toBe(canonical);
    }
  });

  it("keeps everything that actually distinguishes two deployments: host, non-default port, path prefix and path case, and the scheme (kills over-normalizing, which is the failure that transfers a record)", () => {
    const keys = [
      "https://netbox.example.com",
      "https://netbox-lab.example.com",
      "https://netbox.example.com:8443",
      "https://netbox.example.com/netbox",
      "https://netbox.example.com/NetBox",
      "http://netbox.example.com"
    ].map((baseUrl) => netboxInstanceKey({ baseUrl }));

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[2]).toBe("https://netbox.example.com:8443");
    expect(keys[3]).toBe("https://netbox.example.com/netbox");
    expect(keys[5]).toBe("http://netbox.example.com");
  });

  it("NEVER carries userinfo — a credential typed into the non-secret base URL must not be persisted onto every kept server or copied into a backup (kills returning the base URL as typed)", () => {
    expect(netboxInstanceKey({ baseUrl: "https://admin:s3cr3t@netbox.example.com/" })).toBe("https://netbox.example.com");
    expect(netboxInstanceKey({ baseUrl: "https://token@netbox.example.com/" })).toBe("https://netbox.example.com");
    // The whole point, stated as the property that matters rather than as an
    // equality: no fragment of the credential survives into the persisted key.
    expect(netboxInstanceKey({ baseUrl: "https://admin:s3cr3t@netbox.example.com/" })).not.toContain("s3cr3t");
    expect(netboxInstanceKey({ baseUrl: "https://admin:s3cr3t@netbox.example.com/" })).not.toContain("admin");
  });

  it("returns undefined — no instance identity, therefore no adoption — for a base URL nothing could be fetched from (kills inventing a key for an endpoint that does not resolve)", () => {
    // A scheme-less host is the common typo, and `new URL` rejects it; the fetch
    // path builds its URLs from the same string, so such a source cannot sync at
    // all and must not claim an identity either.
    expect(netboxInstanceKey({ baseUrl: "netbox.example.com" })).toBeUndefined();
    expect(netboxInstanceKey({ baseUrl: "" })).toBeUndefined();
    expect(netboxInstanceKey({ baseUrl: "   " })).toBeUndefined();
    expect(netboxInstanceKey({})).toBeUndefined();
  });

  it("is exposed ON the provider, since that is the only way the engine ever reaches it (kills an implementation that exists but is never wired up)", () => {
    const provider = createNetboxProvider(vi.fn() as unknown as typeof fetch);
    expect(typeof provider.instanceKey).toBe("function");
    expect(provider.instanceKey?.({ baseUrl: "https://netbox.example.com/api/" })).toBe("https://netbox.example.com");
  });
});

describe("createNetboxProvider", () => {
  it("has the expected id and a stable config field order (drives sequential add-source prompts)", () => {
    const provider = createNetboxProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.id).toBe(NETBOX_PROVIDER_ID);
    expect(provider.configFields.map((f) => f.id)).toEqual(["baseUrl", "apiToken", "filter", "folderTemplate", "includeVms", "primaryIpFamily"]);
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

    it("FINDING (P2) — count exactly equal to the hard cap (10,000) but pages carrying 10,001 rows is rejected as a protocol error, not silently clipped as a legitimate cap hit (kills capAllowance > count instead of >=)", async () => {
      // Reported count is exactly HARD_CAP (10,000), so capAllowance (== 10,000,
      // since nothing else has consumed the budget yet) equals count exactly.
      // The old `capAllowance > count` guard treated equality as "the cap
      // legitimately explains any shortfall" and let the loop silently drop the
      // 10,001st row instead of raising a protocol error — that row could be a
      // real, still-owned server. The last page here carries one extra row
      // (251 instead of 250) so the running total reaches 10,001 while count
      // says 10,000: an overrun that must fail loudly regardless of proximity
      // to the cap.
      const total = 10_000;
      const fetchImpl = vi.fn(async (url: string) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        const remaining = total - offset;
        // Every page is a normal 250 except the very last one, which is
        // oversized by one row — pushing the collected total to 10,001 across
        // pages while `count` is pinned at 10,000 throughout.
        const pageSize = remaining <= 250 ? remaining + 1 : 250;
        const results = Array.from({ length: pageSize }, (_, i) => ({
          id: offset + i + 1,
          name: `d${offset + i}`,
          primary_ip: { address: "10.0.0.1/24" }
        }));
        return makeResponse(200, { count: total, results });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({
        kind: "protocol",
        message: expect.stringMatching(/10000/)
      });
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

    it("FINDING 1 — aborts with a protocol error when a page's rows would push the collected total past the reported count (kills accept-overrun, e.g. {count: 1, results: [row1, row2]} read as a complete inventory)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 1,
          results: [
            { id: 1, name: "d1", primary_ip: { address: "10.0.0.1/24" } },
            { id: 2, name: "d2", primary_ip: { address: "10.0.0.2/24" } }
          ]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({
        kind: "protocol",
        message: expect.stringMatching(/count.*1/i)
      });
      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({
        message: expect.stringMatching(/2/)
      });
    });

    it("FINDING 1 — aborts with a protocol error when the first page reports count 0 but carries a row (kills desynchronized presence detection on a bogus zero count)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 0,
          results: [{ id: 1, name: "d1", primary_ip: { address: "10.0.0.1/24" } }]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({
        kind: "protocol"
      });
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
    it("(FIX 1) still emits devices without a name or without a primary IP into the tree — with empty endpoints — instead of dropping them (kills host: undefined AND kills drop-at-mapper causing the sync engine to prune their owned servers)", async () => {
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
      // ONE ADDRESSLESS LINE (follow-up 1) — the provider says NOTHING about
      // addressless rows any more. It used to push its own aggregate here ("1
      // device has no usable SSH or telnet address in NetBox."), which overlapped
      // the sync engine's own addressless line and showed the user two lines about
      // intersecting sets of devices. The engine owns the whole disclosure now:
      // only it knows whether a device became a placeholder this run or already
      // was one, and device:2 (a usable address, an empty name) is reported by the
      // engine under the reason that actually stops it — the missing name.
      expect(tree.warnings).toEqual([]);
    });

    it("(ROUND 3) a row with a valid primary IP but an EMPTY NAME still emits NO endpoints, and the provider emits no addressless aggregate about it (⊘ re-adding a provider-side count double-reports this row — once as addressless, once as the engine's empty-name skip)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 2,
          results: [
            // Usable address; only the NAME is missing. The sync engine reports
            // this row on its own ("N devices had an empty name and were
            // skipped"), and NetBox does hold an SSH address for it — this was the
            // exact row the deleted provider aggregate kept getting wrong.
            { id: 1, name: "", primary_ip: { address: "10.0.0.2/24" } },
            { id: 2, name: "genuinely-addressless", primary_ip: null }
          ]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.warnings).toEqual([]);
      // Endpoint SUPPRESSION for the nameless row is unchanged — dropping the
      // provider's count must not start emitting endpoints for rows the engine
      // will skip anyway.
      expect(tree.devices.find((d) => d.externalId === "device:1")?.endpoints).toEqual([]);
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

    /**
     * OOB (issue #48, Phase 2) — `oob_ip` becomes a SECOND endpoint beside the
     * SSH one, which the sync engine maps onto `ServerConfig.ipmiHost`. The
     * bookkeeping trap these fixtures exist for: the no-console-address warning
     * used to be keyed on `endpoints.length === 0`, and an OOB-only device has a
     * non-empty endpoints array while reaching exactly as little console as
     * before.
     */
    it("(OOB) emits a second `redfish` endpoint from oob_ip, CIDR-stripped, without disturbing the ssh one (kills reading oob_ip into the ssh endpoint, and kills ignoring it)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 1,
          results: [{ id: 1, name: "core-sw", primary_ip: { address: "10.0.0.1/24" }, oob_ip: { address: "10.9.9.9/24" } }]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      expect(tree.devices[0].endpoints).toEqual([
        { kind: "ssh", host: "10.0.0.1", port: 22 },
        { kind: "redfish", host: "10.9.9.9" }
      ]);
      expect(tree.warnings).toEqual([]);
    });

    it("(OOB) emits nothing extra when oob_ip is null, absent, or malformed (kills a non-defensive read that would throw, or emit an endpoint with an undefined host)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 4,
          results: [
            { id: 1, name: "null-oob", primary_ip: { address: "10.0.0.1/24" }, oob_ip: null },
            { id: 2, name: "no-oob-key", primary_ip: { address: "10.0.0.2/24" } },
            { id: 3, name: "oob-not-an-object", primary_ip: { address: "10.0.0.3/24" }, oob_ip: "10.9.9.9" },
            { id: 4, name: "oob-empty-address", primary_ip: { address: "10.0.0.4/24" }, oob_ip: { address: "" } }
          ]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      for (const device of tree.devices) {
        expect(device.endpoints).toHaveLength(1);
        expect(device.endpoints[0].kind).toBe("ssh");
      }
    });

    it("(OOB, PR-A REVIEW FINDING) a degenerate oob_ip that is NOTHING BUT a prefix emits no endpoint at all (kills checking emptiness BEFORE `stripCidr` rather than after, which puts `{ kind: \"redfish\", host: \"\" }` onto the tree)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 2,
          results: [
            // Non-empty going in, empty coming out — the one shape the
            // pre-strip check cannot see.
            { id: 1, name: "prefix-only", primary_ip: { address: "10.0.0.1/24" }, oob_ip: { address: "/24" } },
            // The control: the same field with something in front of the slash.
            { id: 2, name: "real-oob", primary_ip: { address: "10.0.0.2/24" }, oob_ip: { address: "10.9.9.9/24" } }
          ]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      // Asserted as "no management endpoint at all", not as "its host is not
      // empty": an empty-hosted endpoint must never reach the tree in the first
      // place, and the sync engine's own selector skipping it downstream is a
      // second line of defence rather than a reason to emit one.
      const byName = new Map(tree.devices.map((d) => [d.name, d]));
      expect(byName.get("prefix-only")!.endpoints).toEqual([{ kind: "ssh", host: "10.0.0.1", port: 22 }]);
      expect(byName.get("real-oob")!.endpoints).toContainEqual({ kind: "redfish", host: "10.9.9.9" });
    });

    it("(OOB) a device with an oob_ip but NO primary IP carries the redfish endpoint alone, and the fetch reports no addressless aggregate of its own (⊘ a BMC-only device silently losing its redfish endpoint; ⊘ the provider re-reporting addressless rows the engine already covers)", async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse(200, {
          count: 2,
          results: [
            { id: 1, name: "bmc-only", primary_ip: null, oob_ip: { address: "10.9.9.9/24" } },
            // A second, ordinary unmappable device: two addressless rows, and
            // STILL no provider warning about them.
            { id: 2, name: "nothing-at-all", primary_ip: null }
          ]
        })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      const byExternalId = new Map(tree.devices.map((d) => [d.externalId, d]));
      expect(byExternalId.get("device:1")?.endpoints).toEqual([{ kind: "redfish", host: "10.9.9.9" }]);
      expect(byExternalId.get("device:2")?.endpoints).toEqual([]);
      // ONE ADDRESSLESS LINE (follow-up 1) — this assertion has tracked the
      // shrinking of the provider's role twice: first "2 devices without a
      // primary IP were skipped." (untrue once they became placeholders), then
      // "2 devices have no usable SSH or telnet address in NetBox." (true, but a
      // second line about the same devices the engine already reports). The
      // provider's job is the TREE; the addressless disclosure is the engine's.
      expect(tree.warnings).toEqual([]);
    });

    it("(OOB) VMs never get a management endpoint, even when the payload carries oob_ip (kills applying the device-only field to the VM branch)", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes("virtual-machines")) {
          return makeResponse(200, {
            count: 1,
            results: [{ id: 7, name: "vm-seven", primary_ip: { address: "10.0.1.7/24" }, oob_ip: { address: "10.9.9.7/24" } }]
          });
        }
        return makeResponse(200, { count: 0, results: [] });
      });
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local", includeVms: true }, { apiToken: "tok" });

      expect(tree.devices).toHaveLength(1);
      expect(tree.devices[0].endpoints).toEqual([{ kind: "ssh", host: "10.0.1.7", port: 22 }]);
    });

    /**
     * PRIMARY-IP FAMILY PREFERENCE (issue #48 PR-E, backlog #3) — the SSH endpoint
     * address is chosen per the source's `primaryIpFamily` config from the SAME
     * device row (primary_ip / primary_ip4 / primary_ip6, no new API call). `auto`
     * is byte-identical to the previous single `primary_ip` read; `prefer-ipv4` /
     * `prefer-ipv6` read their family field with a fall-back to `primary_ip`.
     * `oob_ip` is a single field and MUST be unaffected by the preference.
     */
    describe("primary-IP family preference (PR-E)", () => {
      const bothFamilies = {
        id: 1,
        name: "dual-stack",
        primary_ip: { address: "2001:db8::5/64" }, // NetBox's primary_ip yields IPv6 when both exist
        primary_ip4: { address: "10.0.0.5/24" },
        primary_ip6: { address: "2001:db8::5/64" },
        oob_ip: { address: "10.9.9.9/24" },
        // T-N1 DECOY — a family-specific OOB address that MUST NOT be read. The
        // family preference governs only the primary IP; a broken impl that
        // rerouted oob by family (with fall-back to oob_ip) would produce
        // 10.4.4.4 under prefer-ipv4 and visibly diverge from the invariant
        // 10.9.9.9 the oob test asserts. Without this decoy, such a break would
        // fall straight through to oob_ip and the test would pass vacuously.
        oob_ip4: { address: "10.4.4.4/24" }
      };
      const fetchOne = (row: unknown) =>
        vi.fn(async () => makeResponse(200, { count: 1, results: [row] }));

      it("auto (default) takes primary_ip unchanged — byte-identical to pre-PR-E (kills a family read that reroutes the default)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });
        expect(tree.devices[0].endpoints).toContainEqual({ kind: "ssh", host: "2001:db8::5", port: 22 });
      });

      it("prefer-ipv4 takes primary_ip4 (kills auto/prefer-ipv6 picking the wrong family)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv4" },
          { apiToken: "tok" }
        );
        // ALTERNATE HOST (issue #48, Phase 2) — the v6 is no longer DROPPED; it
        // becomes the ALTERNATE (second) ssh endpoint. What "prefer-ipv4" still
        // guarantees is that the PRIMARY (first) ssh endpoint is the v4, so the
        // ordering is the assertion rather than the mere presence/absence of v6.
        const ssh = tree.devices[0].endpoints.filter((e) => e.kind === "ssh");
        expect(ssh[0]).toEqual({ kind: "ssh", host: "10.0.0.5", port: 22 });
        expect(ssh[1]).toEqual({ kind: "ssh", host: "2001:db8::5", port: 22 });
      });

      it("prefer-ipv6 takes primary_ip6 (kills a fixed primary_ip read)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv6" },
          { apiToken: "tok" }
        );
        expect(tree.devices[0].endpoints).toContainEqual({ kind: "ssh", host: "2001:db8::5", port: 22 });
      });

      it("prefer-ipv4 falls back to primary_ip when the device has only primary_ip (kills a no-fallback impl that drops the endpoint)", async () => {
        const onlyPrimary = { id: 2, name: "legacy", primary_ip: { address: "10.0.0.7/24" } };
        const provider = createNetboxProvider(fetchOne(onlyPrimary) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv4" },
          { apiToken: "tok" }
        );
        // The endpoint survives via the primary_ip fallback rather than dropping.
        expect(tree.devices[0].endpoints).toContainEqual({ kind: "ssh", host: "10.0.0.7", port: 22 });
        expect(tree.warnings).toEqual([]);
      });

      it("oob_ip is UNAFFECTED by the family preference across auto/prefer-ipv4/prefer-ipv6 (kills a family-pref that wrongly reroutes oob)", async () => {
        for (const family of ["auto", "prefer-ipv4", "prefer-ipv6"]) {
          const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
          const tree = await provider.fetchInventory(
            { baseUrl: "https://netbox.local", primaryIpFamily: family },
            { apiToken: "tok" }
          );
          // The redfish (oob) endpoint is always the single oob_ip, never a v4/v6
          // variant — even though the fixture carries an `oob_ip4` decoy that a
          // family-rerouting break would have taken under prefer-ipv4.
          expect(tree.devices[0].endpoints).toContainEqual({ kind: "redfish", host: "10.9.9.9" });
          expect(tree.devices[0].endpoints).not.toContainEqual({ kind: "redfish", host: "10.4.4.4" });
        }
      });

      it("(H1) prefer-ipv4 with a present-but-EMPTY primary_ip4 address falls back to primary_ip (kills the `typeof !== \"string\"`-only gate that returns \"\" and drops the SSH endpoint)", async () => {
        // NetBox does not emit this shape today; the gate must nevertheless treat a
        // present-but-empty family address as absent and fall back, not return "".
        const emptyV4 = {
          id: 3,
          name: "empty-v4",
          primary_ip: { address: "10.0.0.9/24" },
          primary_ip4: { address: "" }
        };
        const provider = createNetboxProvider(fetchOne(emptyV4) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv4" },
          { apiToken: "tok" }
        );
        // Falls back to primary_ip rather than emitting an empty-host / no endpoint.
        expect(tree.devices[0].endpoints).toContainEqual({ kind: "ssh", host: "10.0.0.9", port: 22 });
        expect(tree.warnings).toEqual([]);
      });

      it("an unknown/absent primaryIpFamily degrades to auto (kills a strict parse that drops the endpoint on a legacy source)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "garbage" },
          { apiToken: "tok" }
        );
        expect(tree.devices[0].endpoints).toContainEqual({ kind: "ssh", host: "2001:db8::5", port: 22 });
      });
    });

    /**
     * ALTERNATE HOST (issue #48, Phase 2) — the NON-PREFERRED IP family address
     * is emitted as a SECOND ssh endpoint AFTER the primary. THE ENDPOINT
     * CONVENTION: the first ssh endpoint is the primary host; the second ssh
     * endpoint is the alternate. The sync engine's `selectAltEndpoint` maps the
     * second onto `ServerConfig.altHost`. Only present, CIDR-stripped-non-empty
     * addresses DISTINCT from the primary become an alternate — a single-IP
     * device gets none. Every fixture is built so the WRONG family (or a
     * missing/duplicate alternate) produces a visibly different endpoint list.
     */
    describe("alternate host — second ssh endpoint (Phase 2)", () => {
      const bothFamilies = {
        id: 1,
        name: "dual-stack",
        primary_ip: { address: "2001:db8::5/64" }, // NetBox's primary_ip yields IPv6 when both exist
        primary_ip4: { address: "10.0.0.5/24" },
        primary_ip6: { address: "2001:db8::5/64" }
      };
      const fetchOne = (row: unknown) => vi.fn(async () => makeResponse(200, { count: 1, results: [row] }));
      const sshEndpoints = (tree: { devices: { endpoints: { kind: string }[] }[] }) =>
        tree.devices[0].endpoints.filter((e) => e.kind === "ssh");

      it("prefer-ipv4 emits [ssh v4, ssh v6] — primary v4, alternate the non-preferred v6 (kills no-alternate, and kills emitting the alt in the wrong order)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv4" },
          { apiToken: "tok" }
        );
        expect(sshEndpoints(tree)).toEqual([
          { kind: "ssh", host: "10.0.0.5", port: 22 },
          { kind: "ssh", host: "2001:db8::5", port: 22 }
        ]);
      });

      it("prefer-ipv6 emits [ssh v6, ssh v4] — primary v6, alternate the non-preferred v4 (kills reading the SAME family for both, which would emit no alternate)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv6" },
          { apiToken: "tok" }
        );
        expect(sshEndpoints(tree)).toEqual([
          { kind: "ssh", host: "2001:db8::5", port: 22 },
          { kind: "ssh", host: "10.0.0.5", port: 22 }
        ]);
      });

      it("auto emits [ssh primary_ip, ssh other-family] — the alternate is the family field that DIFFERS from primary_ip (kills an auto path that emits primary_ip twice or picks the same-family field)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });
        // primary_ip is the v6 here, so the alternate is the v4 (the concrete
        // opposite family), never a second copy of the v6 primary.
        expect(sshEndpoints(tree)).toEqual([
          { kind: "ssh", host: "2001:db8::5", port: 22 },
          { kind: "ssh", host: "10.0.0.5", port: 22 }
        ]);
      });

      it("auto with primary_ip == the v4 puts the v6 as the alternate (kills an auto rule hard-wired to one family instead of 'the one that differs from host')", async () => {
        const v4Primary = {
          id: 2,
          name: "v4-primary",
          primary_ip: { address: "10.0.0.5/24" }, // primary_ip IS the v4 this time
          primary_ip4: { address: "10.0.0.5/24" },
          primary_ip6: { address: "2001:db8::5/64" }
        };
        const provider = createNetboxProvider(fetchOne(v4Primary) as unknown as typeof fetch);
        const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });
        expect(sshEndpoints(tree)).toEqual([
          { kind: "ssh", host: "10.0.0.5", port: 22 },
          { kind: "ssh", host: "2001:db8::5", port: 22 }
        ]);
      });

      it("a single-IP device gets NO second ssh endpoint (kills always-emitting an alternate, which would put an empty or duplicate host on the tree)", async () => {
        const single = { id: 3, name: "single", primary_ip: { address: "10.0.0.7/24" } };
        for (const family of ["auto", "prefer-ipv4", "prefer-ipv6"]) {
          const provider = createNetboxProvider(fetchOne(single) as unknown as typeof fetch);
          const tree = await provider.fetchInventory(
            { baseUrl: "https://netbox.local", primaryIpFamily: family },
            { apiToken: "tok" }
          );
          expect(sshEndpoints(tree)).toEqual([{ kind: "ssh", host: "10.0.0.7", port: 22 }]);
        }
      });

      it("an alternate address EQUAL to the primary emits no second endpoint (kills dropping the `!== host` guard, which would emit a redundant duplicate ssh endpoint)", async () => {
        // primary_ip4 and primary_ip6 carry the same address (after CIDR strip),
        // so under prefer-ipv4 the alternate (v6) equals the primary (v4).
        const sameBothFamilies = {
          id: 4,
          name: "same-addr",
          primary_ip: { address: "10.0.0.9/24" },
          primary_ip4: { address: "10.0.0.9/24" },
          primary_ip6: { address: "10.0.0.9/32" }
        };
        const provider = createNetboxProvider(fetchOne(sameBothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv4" },
          { apiToken: "tok" }
        );
        expect(sshEndpoints(tree)).toEqual([{ kind: "ssh", host: "10.0.0.9", port: 22 }]);
      });

      it("the alternate is CIDR-stripped, same as the primary (kills emitting the raw `address` with its prefix)", async () => {
        const provider = createNetboxProvider(fetchOne(bothFamilies) as unknown as typeof fetch);
        const tree = await provider.fetchInventory(
          { baseUrl: "https://netbox.local", primaryIpFamily: "prefer-ipv4" },
          { apiToken: "tok" }
        );
        // 2001:db8::5/64 -> 2001:db8::5, never the raw slashed form.
        expect(sshEndpoints(tree)[1]).toEqual({ kind: "ssh", host: "2001:db8::5", port: 22 });
      });
    });

    it("FINDING 1 — throws a protocol error (not a silent drop) when a page contains a null row (kills silently dropping the row while pagination still believes the count was fully collected)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 1, results: [null] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({
        kind: "protocol"
      });
    });

    it("FINDING 1 — throws a protocol error naming the endpoint and row index when a row has no id (kills silently dropping an id-less row)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { count: 1, results: [{ name: "x" }] }));
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" })).rejects.toMatchObject({
        kind: "protocol",
        message: expect.stringContaining("/api/dcim/devices/")
      });
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

  // DEVICE TEMPLATES (issue #48 PR-T2, §2.2 A-M4) — fixture 22.
  describe("device attributes — names AND slugs (fixture 22)", () => {
    it("declares its attributeKeys", () => {
      const provider = createNetboxProvider(vi.fn() as unknown as typeof fetch);
      expect(provider.attributeKeys).toEqual(["role", "site", "location", "rack", "tenant", "status", "platform", "tag", "name"]);
    });

    it("emits BOTH display names and slugs as set values, omits empties, and matches on either vocabulary (kills single-vocabulary matching — A-M4's silent-no-op trap)", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).includes("virtualization")
          ? makeResponse(200, { count: 0, results: [] })
          : makeResponse(200, {
              count: 1,
              results: [
                {
                  id: 1,
                  name: "core-sw-1",
                  primary_ip: { address: "10.0.0.1/24" },
                  role: { name: "Core Switch", slug: "core-switch" },
                  site: { name: "Sydney", slug: "syd" },
                  rack: { name: "R1", slug: "" }, // slug empty → omitted (m9c)
                  status: { value: "active", label: "Active" },
                  tags: [{ name: "Prod", slug: "prod" }, { name: "Critical", slug: "critical" }]
                }
              ]
            })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);
      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local" }, { apiToken: "tok" });

      const attrs = tree.devices[0].attributes!;
      expect(attrs.role).toEqual(["Core Switch", "core-switch"]);
      expect(attrs.site).toEqual(["Sydney", "syd"]);
      expect(attrs.rack).toEqual(["R1"]); // empty slug omitted, single element survives
      expect(attrs.status).toEqual(["active", "Active"]);
      expect(attrs.tags).toEqual(["Prod", "prod", "Critical", "critical"]);

      // site=syd (slug) AND site=Sydney (display name) both match the same device.
      expect(deviceMatchesFilter(tree.devices[0], parseTemplateFilter("site=syd"))).toBe(true);
      expect(deviceMatchesFilter(tree.devices[0], parseTemplateFilter("site=Sydney"))).toBe(true);
      // tag=core (filter key `tag`) matches the `tags` attribute by name or slug.
      expect(deviceMatchesFilter(tree.devices[0], parseTemplateFilter("tag=critical"))).toBe(true);
      expect(deviceMatchesFilter(tree.devices[0], parseTemplateFilter("tag=Prod"))).toBe(true);
    });

    it("VMs carry the same attributes MINUS rack/location, mirroring vmVars' asymmetry", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).includes("virtualization")
          ? makeResponse(200, {
              count: 1,
              results: [
                {
                  id: 1,
                  name: "vm-1",
                  primary_ip: { address: "10.0.0.9/24" },
                  role: { name: "App", slug: "app" },
                  site: { name: "Sydney", slug: "syd" },
                  rack: { name: "R1", slug: "r1" }, // present in the row but VMs don't map it
                  location: { name: "Row A", slug: "row-a" }
                }
              ]
            })
          : makeResponse(200, { count: 0, results: [] })
      );
      const provider = createNetboxProvider(fetchImpl as unknown as typeof fetch);
      const tree = await provider.fetchInventory({ baseUrl: "https://netbox.local", includeVms: true }, { apiToken: "tok" });

      const vm = tree.devices.find((d) => d.externalId.startsWith("vm:"))!;
      expect(vm.attributes!.role).toEqual(["App", "app"]);
      expect(vm.attributes!.site).toEqual(["Sydney", "syd"]);
      expect(vm.attributes!.rack).toBeUndefined();
      expect(vm.attributes!.location).toBeUndefined();
    });
  });
});

/**
 * The predicate behind the provider's no-console-address warning (Codex P2 on
 * PR #86). It must mean "no CONNECTABLE console endpoint" — exactly what the
 * sync engine's `selectPrimaryEndpoint` decides addressless on: an `ssh`
 * endpoint, else a `telnet` one, each with a non-empty host. Keyed on "no ssh
 * endpoint" it reports a device that syncs perfectly well as a TELNET server as
 * having no address.
 *
 * Exercised at the predicate rather than through a NetBox payload DELIBERATELY:
 * `mapEntry` emits only `ssh` (primary + alternate) and `redfish` (`oob_ip`)
 * endpoints, so no NetBox response can put a telnet endpoint on the tree today
 * and the telnet case is unreachable from this provider's own fetch path. The
 * inconsistency lives in the shared notion — which EVE-NG devices, and any
 * third-party provider emitting telnet, do reach.
 */
describe("hasConsoleEndpoint", () => {
  it("a TELNET-only device HAS a console address (kills the ssh-only predicate, which counts a device that syncs as a telnet server as having none)", () => {
    expect(hasConsoleEndpoint({ endpoints: [{ kind: "telnet", host: "10.0.0.9", port: 5001 }] })).toBe(true);
  });

  it("an ssh device has one, and a device with no endpoints at all has none", () => {
    expect(hasConsoleEndpoint({ endpoints: [{ kind: "ssh", host: "10.0.0.1", port: 22 }] })).toBe(true);
    expect(hasConsoleEndpoint({ endpoints: [] })).toBe(false);
  });

  it("an out-of-band address is NOT a console address (kills `endpoints.length > 0`, which would read a BMC-only device as reachable)", () => {
    expect(hasConsoleEndpoint({ endpoints: [{ kind: "redfish", host: "10.9.9.9" }] })).toBe(false);
    expect(hasConsoleEndpoint({ endpoints: [{ kind: "url", host: "10.9.9.9" }] })).toBe(false);
  });

  it("an EMPTY host is no address, on either console kind (matches the engine's own non-empty-host rule rather than trusting the kind alone)", () => {
    expect(hasConsoleEndpoint({ endpoints: [{ kind: "ssh", host: "" }] })).toBe(false);
    expect(hasConsoleEndpoint({ endpoints: [{ kind: "telnet", host: "" }] })).toBe(false);
  });
});
