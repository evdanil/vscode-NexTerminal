import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  NETBOX_INSECURE_TLS_WARNING,
  NETBOX_PROVIDER_ID,
  DEFAULT_FOLDER_TEMPLATE,
  createNetboxProvider,
  netboxInstanceKey,
  stripCidr,
  renderFolderTemplate
} from "../../src/services/inventory/providers/netboxProvider";
import { createInsecureHttpsFetch } from "../../src/services/inventory/insecureFetch";
import { redirectNotFollowedMessage } from "../../src/services/inventory/certificateHints";
import { validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { deviceMatchesFilter, parseTemplateFilter } from "../../src/services/inventory/templateApply";
import { InventoryProviderError, type InventoryConfigField } from "../../src/models/inventory";
import { ADVANCED_SECTION_LABEL } from "../../src/ui/formTypes";

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
    expect(provider.configFields.map((f) => f.id)).toEqual([
      "baseUrl",
      "apiToken",
      "filter",
      "folderTemplate",
      "includeVms",
      "primaryIpFamily",
      // INSECURE TLS — appended LAST on purpose: the order is part of the
      // provider fingerprint and drives the sequential add-source prompts.
      "allowInsecureTls"
    ]);
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

// ---------------------------------------------------------------------------
// INSECURE TLS — the same per-source opt-in EVE-NG shipped in 2.8.190, and the
// question that actually matters: which transport a given config selects.
// ---------------------------------------------------------------------------

/**
 * Self-hosted NetBox is commonly behind a self-signed certificate, or reached by
 * IP address with a certificate that never listed it, and this provider used the
 * same plain injected `fetch` EVE-NG used — so it failed the same way, with the
 * same unexplained OpenSSL code and no way to say "yes, I know, connect anyway".
 *
 * The transport itself is NOT a second implementation: `insecureFetch.ts` was
 * written provider-agnostic for EVE-NG and is reused as-is (see there for why
 * `NODE_TLS_REJECT_UNAUTHORIZED` is not an option in a shared extension host).
 *
 * The tests that matter here are the NEGATIVE ones: an opted-out source and an
 * `http:` source must never reach the insecure transport.
 */
describe("createNetboxProvider — allowInsecureTls field", () => {
  const field = (): InventoryConfigField => {
    const found = createNetboxProvider(vi.fn() as unknown as typeof fetch).configFields.find((f) => f.id === "allowInsecureTls");
    expect(found).toBeDefined();
    return found!;
  };

  it("is an OPTIONAL boolean that starts OFF, and is drawn behind the Advanced disclosure (⊘ a defaultValue of true silently turns certificate verification off for every new source)", () => {
    const f = field();
    expect(f.type).toBe("boolean");
    expect(f.required).not.toBe(true);
    expect(f.defaultValue).toBe(false);
    expect(f.advanced).toBe(true);
  });

  /**
   * The wording diverges from EVE-NG's here, and deliberately: what travels over
   * a NetBox connection is an API TOKEN, not a password. Naming a password would
   * be describing an exposure this user does not have while leaving the one they
   * do have unnamed — and the token is the more dangerous of the two to leak,
   * being a bearer credential that no second factor stands behind.
   */
  it("names THE API TOKEN as what crosses the unverified connection, not a password (⊘ borrowing EVE-NG's password wording describes an exposure NetBox users do not have and hides the bearer token they do)", () => {
    const hint = String(field().description ?? "").toLowerCase();
    expect(hint).toMatch(/api token/);
    expect(hint).not.toMatch(/password/);
    expect(hint).toMatch(/intercept|unauthenticated|not verified|unverified/);
    expect(hint).toMatch(/trust|http base url|no effect/);
  });

  it("is appended LAST, so no existing field changes position (⊘ inserting it mid-list reorders the sequential add-source prompts and re-asks for values against the wrong labels)", () => {
    const ids = createNetboxProvider(vi.fn() as unknown as typeof fetch).configFields.map((f) => f.id);
    expect(ids[ids.length - 1]).toBe("allowInsecureTls");
  });

  it("still passes the provider-shape validation the registry runs, with the new field in place", () => {
    expect(() => validateProviderShape(createNetboxProvider(vi.fn() as unknown as typeof fetch))).not.toThrow();
  });
});

describe("createNetboxProvider — insecure TLS transport selection", () => {
  /** An empty but well-formed NetBox that answers every endpoint. */
  function world(): { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = async (url: string, init?: RequestInit): Promise<unknown> => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/status/")) return makeResponse(200, { "netbox-version": "4.1.0" });
      return makeResponse(200, { count: 0, results: [] });
    };
    return { impl: impl as unknown as typeof fetch, calls };
  }

  function probes(): {
    standard: ReturnType<typeof world>;
    insecure: ReturnType<typeof world>;
    provider: ReturnType<typeof createNetboxProvider>;
  } {
    const standard = world();
    const insecure = world();
    return { standard, insecure, provider: createNetboxProvider(standard.impl, insecure.impl) };
  }

  const SECRETS = { apiToken: "tok" };

  it("uses the insecure transport — and ONLY it — for an https source that opted in", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://10.0.0.5", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls).toHaveLength(0);
  });

  it("NEVER uses it for a source that did not opt in, however the certificate would have failed (⊘ selecting on the URL scheme alone turns verification off for every https source)", async () => {
    for (const config of [{ baseUrl: "https://10.0.0.5", allowInsecureTls: false }, { baseUrl: "https://10.0.0.5" }]) {
      const { standard, insecure, provider } = probes();
      await provider.fetchInventory(config, SECRETS);
      expect(standard.calls.length).toBeGreaterThan(0);
      expect(insecure.calls).toHaveLength(0);
    }
  });

  it("NEVER uses it for an http source, where relaxing certificate checks means nothing and the adapter would refuse the URL anyway (⊘ selecting on the opt-in alone breaks every plain-http source the moment the box is ticked)", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "http://netbox.example.com", allowInsecureTls: true }, SECRETS);
    expect(standard.calls.length).toBeGreaterThan(0);
    expect(insecure.calls).toHaveLength(0);
  });

  it("decides per CONFIG, not per provider — one registry serves every source, so two sources on one provider must get different transports", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://10.0.0.5", allowInsecureTls: true }, SECRETS);
    await provider.fetchInventory({ baseUrl: "https://netbox.example.com" }, SECRETS);
    // Compare the parsed HOST, not a URL prefix: `startsWith("https://netbox.example.com")`
    // is also satisfied by `https://netbox.example.com.evil.net/…`, so the assertion
    // would hold even if a request went somewhere else entirely.
    expect(insecure.calls.every((c) => new URL(c.url).host === "10.0.0.5")).toBe(true);
    expect(standard.calls.every((c) => new URL(c.url).host === "netbox.example.com")).toBe(true);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls.length).toBeGreaterThan(0);
  });

  it("routes BOTH entry points through the same decision (⊘ one path built without the selector connects with verification ON and the user's source works from the tree but not from Test Connection, or the reverse)", async () => {
    const opted = { baseUrl: "https://10.0.0.5", allowInsecureTls: true };
    const runs: ((p: ReturnType<typeof createNetboxProvider>) => Promise<unknown>)[] = [
      (p) => p.fetchInventory(opted, SECRETS),
      (p) => p.testConnection(opted, SECRETS)
    ];
    for (const run of runs) {
      const { standard, insecure, provider } = probes();
      await run(provider).catch(() => undefined);
      expect(insecure.calls.length).toBeGreaterThan(0);
      expect(standard.calls).toHaveLength(0);
    }
  });

  it("normalizes the scheme before deciding, so an uppercase HTTPS:// base URL is still https (⊘ a raw startsWith('https:') check reads HTTPS:// as plain http and silently ignores the opt-in)", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "HTTPS://10.0.0.5", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls).toHaveLength(0);
  });

  /**
   * THE STRICTNESS IS LOAD-BEARING (EVE-NG A4, same finding). The negative cases
   * above only cover `false` and absent, so the mutation `if
   * (!config.allowInsecureTls)` would pass every one of them. The string "true"
   * is reachable — a restored backup, or a hand-edited globalState, stores
   * whatever it holds — and under that mutation it turns certificate
   * verification OFF for a source whose owner never ticked a box.
   */
  it.each([["true"], ["false"], [1], [0], ["0"], ["yes"], [{}]])(
    "treats a NON-boolean %o as no opt-in at all and keeps the standard transport (⊘ a truthiness test turns verification off for a value the form can never produce)",
    async (value) => {
      const { standard, insecure, provider } = probes();
      await provider.fetchInventory({ baseUrl: "https://10.0.0.5", allowInsecureTls: value as unknown as boolean }, SECRETS);
      expect(standard.calls.length).toBeGreaterThan(0);
      expect(insecure.calls).toHaveLength(0);
    }
  );

  /** The URL-parse `catch` is OBSERVABLE, not dead: `new URL("https:")` throws. */
  it.each(["https:", "https:/"])(
    "falls back to the STANDARD transport for the unparseable base URL %o, even with the box ticked (⊘ a catch that returns the insecure transport relaxes TLS on a URL nobody could parse)",
    async (baseUrl) => {
      const { insecure, provider } = probes();
      await provider.fetchInventory({ baseUrl, allowInsecureTls: true }, SECRETS).catch(() => undefined);
      expect(insecure.calls).toHaveLength(0);
    }
  );

  /**
   * THE ADAPTER'S OWN PRECONDITION. `insecureFetch` REFUSES any redirect mode
   * other than `"manual"` — it never follows a redirect, and accepting `follow`
   * while not following would be a silent lie. NetBox's requests did not set one
   * (the platform `fetch` default is `follow`), so an opted-in source would have
   * had every single request rejected by the adapter before a socket opened.
   */
  it("asks the insecure transport for redirect: \"manual\", which is the only mode it accepts (⊘ leaving the default makes every request on an opted-in source fail inside the adapter, before it reaches the server)", async () => {
    const { insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://10.0.0.5", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    for (const call of insecure.calls) {
      expect(call.init?.redirect).toBe("manual");
    }
  });

  /**
   * …and NOT on the standard transport. Every existing NetBox source runs there,
   * some behind a reverse proxy that redirects; turning redirect-following off
   * for them would be a behaviour change nobody asked for, delivered as an
   * unexplained HTTP 301 protocol error.
   */
  it("leaves the STANDARD transport's redirect handling exactly as it was (⊘ setting manual globally breaks every existing source behind a redirecting proxy, which is not what a new opt-in is allowed to do)", async () => {
    const { standard, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://netbox.example.com" }, SECRETS);
    expect(standard.calls.length).toBeGreaterThan(0);
    for (const call of standard.calls) {
      expect(call.init?.redirect).toBeUndefined();
    }
  });

  it("defaults the second argument to the real node:https adapter, so a provider built the way activate() builds it is not silently transport-less", () => {
    expect(() => createNetboxProvider(vi.fn() as unknown as typeof fetch)).not.toThrow();
  });
});

/**
 * DISCLOSURE AFTER THE FACT (EVE-NG A2, same reasoning). `allowInsecureTls` is
 * read once, at transport selection, and would otherwise never be heard from
 * again — so a source ticked for a lab box and later repointed at a production
 * NetBox keeps sending the API token over an unauthenticated connection with
 * nothing on screen saying so. It is also the answer to a restored backup
 * enabling the flag: the import trust boundary is already broad, so the
 * proportionate response is disclosure, not another gate.
 */
describe("createNetboxProvider — a sync run with verification off discloses it", () => {
  const SECRETS = { apiToken: "tok" };

  function provider(): ReturnType<typeof createNetboxProvider> {
    const impl = (async (url: string) =>
      String(url).includes("/api/status/")
        ? makeResponse(200, { "netbox-version": "4.1.0" })
        : makeResponse(200, {
            count: 1,
            results: [{ id: 1, name: "dev-1", primary_ip: { address: "10.0.0.1/24" }, site: { name: "Sydney" } }]
          })) as unknown as typeof fetch;
    return createNetboxProvider(impl, impl);
  }

  it("warns EXACTLY ONCE that this source's certificate is not verified, naming the option and the API-token exposure (⊘ a sync that silently ran unauthenticated — the whole point of the disclosure)", async () => {
    const tree = await provider().fetchInventory({ baseUrl: "https://10.0.0.5", allowInsecureTls: true }, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect((tree.warnings ?? []).filter((w) => w === NETBOX_INSECURE_TLS_WARNING)).toHaveLength(1);
    // The two clauses that must survive any later rewording: the option the user
    // can turn back off, and what is actually crossing the unverified connection.
    expect(NETBOX_INSECURE_TLS_WARNING).toContain("Allow a Self-Signed or Mismatched Certificate");
    expect(NETBOX_INSECURE_TLS_WARNING.toLowerCase()).toContain("api token");
  });

  it("says NOTHING for a source that is actually verifying its certificate (⊘ an unconditional warning trains the user to ignore the one that means something)", async () => {
    for (const config of [
      { baseUrl: "https://10.0.0.5", allowInsecureTls: false },
      { baseUrl: "https://10.0.0.5" },
      // Ticked but http: the selector keeps the standard transport, so nothing
      // was relaxed and there is nothing to disclose.
      { baseUrl: "http://netbox.example.com", allowInsecureTls: true }
    ]) {
      const tree = await provider().fetchInventory(config, SECRETS);
      // Asserted against the CONSTANT, not a substring like "certificate": the
      // warning capitalises the word in both places it uses it, so a
      // case-sensitive substring search matches nothing and the assertion holds
      // even when the warning IS wrongly emitted.
      expect(tree.warnings ?? []).not.toContain(NETBOX_INSECURE_TLS_WARNING);
    }
  });
});

/**
 * The error a user actually hits BEFORE they know the option exists. NetBox's
 * `mapNetworkError` echoed the bare node code (`Could not reach 10.0.0.5:
 * DEPTH_ZERO_SELF_SIGNED_CERT.`), which names the problem in a vocabulary the
 * user did not choose and offers no remedy. The sentence comes from the SHARED
 * table (`services/inventory/certificateHints.ts`), so NetBox cannot fall behind
 * EVE-NG as codes are added to it.
 */
describe("createNetboxProvider — certificate errors name the option", () => {
  function failsWith(code: string, viaCause = false): typeof fetch {
    return (async () => {
      const err = new Error("fetch failed");
      if (viaCause) {
        (err as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
      } else {
        (err as { code?: string }).code = code;
      }
      throw err;
    }) as unknown as typeof fetch;
  }

  async function messageFor(code: string, viaCause = false): Promise<string> {
    const err = await createNetboxProvider(failsWith(code, viaCause))
      .testConnection({ baseUrl: "https://10.0.0.5" }, { apiToken: "tok" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("network");
    return (err as Error).message;
  }

  const CERT_CODES = [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_NOT_YET_VALID"
  ];

  it.each(CERT_CODES)(
    "names the option, and the host, instead of leaving %s to speak for itself (⊘ dropping the mapping restores the bare code, which is the state the user was stuck in)",
    async (code) => {
      const message = await messageFor(code);
      expect(message).toContain("10.0.0.5");
      expect(message).toContain("Allow a Self-Signed or Mismatched Certificate");
      expect(message).toContain(ADVANCED_SECTION_LABEL);
      expect(message).not.toBe(`Could not reach 10.0.0.5: ${code}.`);
    }
  );

  it.each(CERT_CODES)("keeps %s itself in the message tail, because the code is what makes the failure diagnosable", async (code) => {
    expect(await messageFor(code)).toContain(code);
  });

  it("says API TOKEN where EVE-NG says password — that is what NetBox sends over the unverified connection (⊘ a shared sentence that hard-codes one provider's credential misdescribes the other's exposure)", async () => {
    const message = (await messageFor("DEPTH_ZERO_SELF_SIGNED_CERT")).toLowerCase();
    expect(message).toContain("api token");
    expect(message).not.toContain("password");
  });

  it("does NOT claim NetBox ships a self-signed certificate by default, which is EVE-NG's situation and not NetBox's (⊘ a shared table that keeps one provider's aside states something untrue about the other)", async () => {
    expect(await messageFor("DEPTH_ZERO_SELF_SIGNED_CERT")).not.toContain("ships by default");
  });

  it("reads the code out of `cause` too — undici puts it there, and node:https puts it on the error itself", async () => {
    expect(await messageFor("DEPTH_ZERO_SELF_SIGNED_CERT", true)).toContain("Allow a Self-Signed or Mismatched Certificate");
  });

  it("leaves every NON-certificate code's wording exactly as it was (⊘ a greedy match rewrites ECONNREFUSED into advice about certificates)", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "CERT_SOMETHING_NEW"]) {
      expect(await messageFor(code)).toBe(`Could not reach 10.0.0.5: ${code}.`);
    }
  });

  it("reads the hint table by OWN member only, so an inherited name is not a certificate hint (⊘ the table answers `constructor` with a function and the message becomes whatever calling it returns)", async () => {
    for (const code of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(await messageFor(code)).toBe(`Could not reach 10.0.0.5: ${code}.`);
    }
  });

  it("still reports a timeout as a timeout — an abort has no code and must not be swept into the certificate branch", async () => {
    const timesOut = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const err = await createNetboxProvider(timesOut)
      .testConnection({ baseUrl: "https://10.0.0.5" }, { apiToken: "tok" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("Connection to 10.0.0.5 timed out.");
  });

  it("names the option by its EXACT form label (⊘ a hint pointing at a control the user cannot find by that name is worse than the bare OpenSSL code it replaced)", async () => {
    const label = createNetboxProvider(vi.fn() as unknown as typeof fetch).configFields.find((f) => f.id === "allowInsecureTls")!.label;
    expect(await messageFor("DEPTH_ZERO_SELF_SIGNED_CERT")).toContain(label);
  });
});

/**
 * THE SECOND WALL a user hits on the way through the certificate opt-in. The
 * insecure transport cannot follow a redirect — the adapter refuses any mode but
 * `"manual"` — so a host that canonicalises a trailing slash answered the sync
 * with `failed with HTTP 301: ` and an empty body. Having just been sent here by
 * our own certificate message, the user gets a second dead end that names
 * neither cause nor remedy.
 */
describe("createNetboxProvider — a 3xx on the transport that cannot follow it", () => {
  const SECRETS = { apiToken: "tok" };
  const OPTED_IN = { baseUrl: "https://10.0.0.5", allowInsecureTls: true };

  function redirects(status: number, location?: string): typeof fetch {
    return (async () => ({
      status,
      text: async () => "",
      headers: { get: (name: string) => (name.toLowerCase() === "location" ? (location ?? null) : null) }
    })) as unknown as typeof fetch;
  }

  /**
   * The SAME implementation is installed as both transports, so the only thing
   * that varies between these cases is which one the config selects — the
   * wording difference cannot come from the responses differing.
   */
  async function messageFor(impl: typeof fetch, config: Record<string, unknown> = OPTED_IN): Promise<string> {
    const err = await createNetboxProvider(impl, impl)
      .testConnection(config, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    return (err as Error).message;
  }

  it("explains the redirect and names the address the server pointed at, which is the base URL the source should have (⊘ dropping the branch restores `failed with HTTP 301: ` with nothing after the colon — the state the user was stuck in)", async () => {
    const message = await messageFor(redirects(301, "https://netbox.example.com/api/status/"));
    expect(message).toContain("301");
    expect(message).toContain("does not follow redirects");
    expect(message.toLowerCase()).toContain("base url");
    expect(message).toContain("https://netbox.example.com/api/status/");
  });

  it("says the server named no Location when it sent none, rather than promising an address it never gives (⊘ interpolating an absent header prints `undefined` as the address to use)", async () => {
    const message = await messageFor(redirects(302));
    expect(message).toContain("does not follow redirects");
    expect(message).not.toContain("undefined");
    expect(message).toContain("no Location");
  });

  it("uses the SAME sentence EVE-NG uses — one shared module, so the two providers cannot explain the same dead end differently (⊘ a copied sentence drifts the moment one of them is reworded)", async () => {
    const message = await messageFor(redirects(301, "https://netbox.example.com/api/status/"));
    expect(message).toContain(redirectNotFollowedMessage("https://netbox.example.com/api/status/"));
  });

  it("leaves a 3xx on the STANDARD transport worded exactly as it always was — that transport DOES follow redirects, so advice about not following them would be wrong there (⊘ applying the branch to both transports tells every existing source something untrue about its own connection)", async () => {
    const message = await messageFor(redirects(301, "https://netbox.example.com/api/status/"), { baseUrl: "https://10.0.0.5" });
    expect(message).toBe("NetBox request to https://10.0.0.5/api/status/ failed with HTTP 301: ");
  });
});

/**
 * THE END-TO-END SEAM. Every test above stubs the insecure transport with a spy,
 * which proves the SELECTION is right and nothing about whether the requests
 * NetBox builds are ones the real adapter will accept.
 *
 * That gap is not theoretical: `insecureFetch` refuses a request whose redirect
 * mode is not `"manual"`, refuses a non-string body, and refuses a `Request`
 * object — and NetBox's requests were written years before it existed. So this
 * runs an actual sync through the REAL `createInsecureHttpsFetch`, with only its
 * `node:https` seam faked, and asserts a device comes out the other end.
 */
describe("createNetboxProvider — a real sync over the real insecure adapter", () => {
  it("completes a sync through createInsecureHttpsFetch itself, with certificate verification off (⊘ the adapter rejects NetBox's request shape and every opted-in source fails before a socket opens — invisible to a test that stubs the transport)", async () => {
    const seen: { rejectUnauthorized: unknown; path: unknown }[] = [];
    const requestImpl = ((options: { rejectUnauthorized?: unknown; path?: unknown }, callback: (res: unknown) => void) => {
      seen.push({ rejectUnauthorized: options.rejectUnauthorized, path: options.path });
      const body = String(options.path).includes("/api/status/")
        ? JSON.stringify({ "netbox-version": "4.1.0" })
        : JSON.stringify({
            count: 1,
            results: [{ id: 1, name: "dev-1", primary_ip: { address: "10.0.0.1/24" }, site: { name: "Sydney" } }]
          });
      const res = Readable.from([Buffer.from(body, "utf8")]) as Readable & {
        statusCode?: number;
        statusMessage?: string;
        headers?: Record<string, string>;
      };
      res.statusCode = 200;
      res.statusMessage = "OK";
      res.headers = { "content-type": "application/json" };
      // Delivered asynchronously, as node does — the adapter attaches its
      // listeners after `request()` returns.
      setTimeout(() => callback(res), 0);
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: () => void;
        setTimeout: (ms: number, cb: () => void) => unknown;
      };
      req.end = (): void => undefined;
      req.destroy = (): void => undefined;
      req.setTimeout = (): unknown => req;
      return req;
    }) as unknown as Parameters<typeof createInsecureHttpsFetch>[0];

    const refuse = (async () => {
      throw new Error("the standard transport must not be used by an opted-in https source");
    }) as unknown as typeof fetch;

    const provider = createNetboxProvider(refuse, createInsecureHttpsFetch(requestImpl));
    const tree = await provider.fetchInventory({ baseUrl: "https://10.0.0.5", allowInsecureTls: true }, { apiToken: "tok" });

    expect(tree.devices).toHaveLength(1);
    expect(tree.devices[0].name).toBe("dev-1");
    expect(tree.warnings ?? []).toContain(NETBOX_INSECURE_TLS_WARNING);
    // The whole point of the transport: every request went out with
    // certificate verification turned off, on sockets this call owns.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.rejectUnauthorized === false)).toBe(true);
  });
});
