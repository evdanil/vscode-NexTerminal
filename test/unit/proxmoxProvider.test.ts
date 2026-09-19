import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOLDER_TEMPLATE,
  PROXMOX_INSECURE_TLS_WARNING,
  PROXMOX_PROVIDER_ID,
  createProxmoxProvider,
  parsePrimaryIpFamily,
  proxmoxInstanceKey
} from "../../src/services/inventory/providers/proxmoxProvider";
import { validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { InventoryProviderError, type InventorySourceValues } from "../../src/models/inventory";
import { ADVANCED_SECTION_LABEL } from "../../src/ui/formTypes";

function makeResponse(status: number, body: unknown): { status: number; text: () => Promise<string> } {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, text: async () => text };
}

/**
 * REVIEW FINDING (P1, cross-instance adoption) — this key decides whether a
 * server kept from a removed source may be reclaimed by a later one (see
 * `DetachedServerOrigin.instanceKey`, models/config.ts). Two deployments must
 * never collide onto one key, and one deployment must not fragment into several
 * — the first loses a record to a source that never synced it, the second breaks
 * the re-add this whole feature exists for.
 */
describe("proxmoxInstanceKey", () => {
  it("collapses every spelling of ONE deployment onto ONE key — trailing slashes, an /api suffix, host case, and whitespace (kills a raw-string key, which fragments one instance into five and refuses the re-add it is supposed to allow)", () => {
    const canonical = "https://pve.example.com";
    for (const spelling of [
      "https://pve.example.com",
      "https://pve.example.com/",
      "https://pve.example.com///",
      "https://pve.example.com/api",
      "https://pve.example.com/api/",
      "https://PVE.Example.COM",
      "  https://pve.example.com  ",
      "https://pve.example.com?foo=bar",
      "https://pve.example.com#frag"
    ]) {
      expect(proxmoxInstanceKey({ baseUrl: spelling })).toBe(canonical);
    }
  });

  it("KEEPS PVE's :8006 — it is not any scheme's default port, so https://pve.example.com:8006 and https://pve.example.com are DIFFERENT deployments (kills a default-port rule copied from netbox by reflex: dropping every :port would merge a PVE API on :8006 with whatever else answers on :443)", () => {
    expect(proxmoxInstanceKey({ baseUrl: "https://pve.example.com:8006" })).toBe("https://pve.example.com:8006");
    expect(proxmoxInstanceKey({ baseUrl: "https://pve.example.com:8006" })).not.toBe(
      proxmoxInstanceKey({ baseUrl: "https://pve.example.com" })
    );
    // The rule is "drop the SCHEME's default port", not "drop every port": the
    // URL parser has already folded http://…:80, and the key must not fragment it.
    expect(proxmoxInstanceKey({ baseUrl: "http://pve.example.com:80" })).toBe("http://pve.example.com");
  });

  it("keeps everything that actually distinguishes two deployments: host, port, path prefix, path case and scheme (kills over-normalizing, which is the failure that transfers a record)", () => {
    const keys = [
      "https://pve.example.com",
      "https://pve-lab.example.com",
      "https://pve.example.com:8006",
      "https://pve.example.com/pve",
      "https://pve.example.com/PVE",
      "http://pve.example.com"
    ].map((baseUrl) => proxmoxInstanceKey({ baseUrl }));

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[2]).toBe("https://pve.example.com:8006");
    expect(keys[3]).toBe("https://pve.example.com/pve");
    expect(keys[5]).toBe("http://pve.example.com");
  });

  it("NEVER carries userinfo — a credential typed into the non-secret base URL must not be persisted onto every kept server or copied into a backup (kills returning the base URL as typed)", () => {
    expect(proxmoxInstanceKey({ baseUrl: "https://root@pam!tok@pve.example.com/" })).toBe("https://pve.example.com");
    expect(proxmoxInstanceKey({ baseUrl: "https://token@pve.example.com/" })).toBe("https://pve.example.com");
    // The whole point, stated as the property that matters rather than as an
    // equality: no fragment of the credential survives into the persisted key.
    expect(proxmoxInstanceKey({ baseUrl: "https://user:s3cr3t@pve.example.com/" })).not.toContain("s3cr3t");
    expect(proxmoxInstanceKey({ baseUrl: "https://user:s3cr3t@pve.example.com/" })).not.toContain("user");
  });

  it("returns undefined — no instance identity, therefore no adoption — for a base URL nothing could be fetched from (kills inventing a key for an endpoint that does not resolve)", () => {
    // A scheme-less host is the common typo, and `new URL` rejects it; the fetch
    // path builds its URLs from the same string, so such a source cannot sync at
    // all and must not claim an identity either.
    expect(proxmoxInstanceKey({ baseUrl: "pve.example.com" })).toBeUndefined();
    expect(proxmoxInstanceKey({ baseUrl: "" })).toBeUndefined();
    expect(proxmoxInstanceKey({ baseUrl: "   " })).toBeUndefined();
    expect(proxmoxInstanceKey({})).toBeUndefined();
  });

  it("is exposed ON the provider, since that is the only way the engine ever reaches it (kills an implementation that exists but is never wired up)", () => {
    const provider = createProxmoxProvider(vi.fn() as unknown as typeof fetch);
    expect(typeof provider.instanceKey).toBe("function");
    expect(provider.instanceKey?.({ baseUrl: "https://pve.example.com:8006/api/" })).toBe("https://pve.example.com:8006");
  });
});

describe("parsePrimaryIpFamily", () => {
  it("passes the two explicit preferences through (kills a parser that forgets one of them and silently reads it as auto)", () => {
    expect(parsePrimaryIpFamily("prefer-ipv4")).toBe("prefer-ipv4");
    expect(parsePrimaryIpFamily("prefer-ipv6")).toBe("prefer-ipv6");
  });

  it("reads anything else — absent, auto, a hand-mangled value — as auto, so a legacy or corrupted stored value is zero behaviour change (kills throwing or inventing a fourth family)", () => {
    for (const raw of [undefined, "auto", "", "ipv4", "AUTO", 4, true, {}]) {
      expect(parsePrimaryIpFamily(raw)).toBe("auto");
    }
  });
});

describe("createProxmoxProvider", () => {
  it("passes validateProviderShape — the same gate the registry applies at registration (⊘ a provider that only compiles still cannot be registered)", () => {
    expect(() => validateProviderShape(createProxmoxProvider())).not.toThrow();
  });

  it("carries the Proxmox identity and the attribute vocabulary its devices report (kills an id that drifts from the registered one, and a filter key the devices can never match)", () => {
    const provider = createProxmoxProvider();
    expect(provider.id).toBe(PROXMOX_PROVIDER_ID);
    expect(provider.id).toBe("proxmox");
    expect(provider.label).toBe("Proxmox");
    expect(provider.attributeKeys).toEqual(["type", "node", "pool", "tag", "status", "ip", "ip6", "mac", "ifname", "name"]);
  });

  it("declares the config fields in fingerprint order — ids, labels, types, required flags and ORDER are hashed and stamped onto every source at save time (kills a reordering, which re-asks every existing source to re-confirm its credentials)", () => {
    const provider = createProxmoxProvider();
    expect(provider.configFields.map((f) => f.id)).toEqual([
      "baseUrl",
      "apiToken",
      "folderTemplate",
      "primaryIpFamily",
      "includeStopped",
      "allowInsecureTls",
      "includeTemplates",
      "includeNodes",
      "statusPollSeconds"
    ]);
    expect(provider.configFields.find((f) => f.id === "apiToken")?.type).toBe("password");
    expect(provider.configFields.find((f) => f.id === "baseUrl")?.placeholder).toBe("https://pve.example.com:8006");
    expect(provider.configFields.find((f) => f.id === "folderTemplate")?.placeholder).toBe(DEFAULT_FOLDER_TEMPLATE);
  });

  it("gives the boolean fields their contract defaults: includeStopped ON, the three disclosure-listed flags OFF and behind Advanced (kills a default-on insecure-TLS, and an includeStopped that ships OFF and silently drops the stopped guests the user asked to sync)", () => {
    const provider = createProxmoxProvider();
    const byId = (id: string) => provider.configFields.find((f) => f.id === id)!;
    expect(byId("includeStopped").defaultValue).toBe(true);
    for (const id of ["allowInsecureTls", "includeTemplates", "includeNodes"]) {
      expect(byId(id).advanced).toBe(true);
      expect(byId(id).defaultValue).toBe(false);
    }
    const poll = byId("statusPollSeconds");
    expect(poll.type).toBe("number");
    expect(poll.min).toBe(0);
    expect(poll.max).toBe(3600);
    expect(poll.integer).toBe(true);
    expect(poll.advanced).toBe(true);
  });

  it("shares primaryIpFamily's option VALUES with NetBox's field, in NetBox's order, under PVE's own labels (kills a divergent value spelling the shared code cannot read, and a label copied from NetBox that claims a 'primary IP' PVE does not have)", () => {
    const options = createProxmoxProvider().configFields.find((f) => f.id === "primaryIpFamily")!.options!;
    expect(options.map((o) => o.value)).toEqual(["auto", "prefer-ipv4", "prefer-ipv6"]);
    expect(options.map((o) => o.label)).toEqual(["Automatic (as reported by the guest)", "Prefer IPv4", "Prefer IPv6"]);
  });

  it("discloses an insecure sync by naming the option and the credential actually on the wire (⊘ a warning that names a password describes an exposure Proxmox users do not have)", () => {
    expect(PROXMOX_INSECURE_TLS_WARNING).toContain("Allow a Self-Signed or Mismatched Certificate");
    expect(PROXMOX_INSECURE_TLS_WARNING.toLowerCase()).toContain("proxmox api token");
    expect(PROXMOX_INSECURE_TLS_WARNING.toLowerCase()).not.toContain("netbox");
  });

  describe("testConnection", () => {
    const SECRETS = { apiToken: "root@pam!test=secret" };

    it("smoke-tests GET {base}/api2/json/version with the PVEAPIToken header and resolves on 200 (kills a Token- or Bearer-prefixed header PVE would reject)", async () => {
      const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string>; method?: string }) => {
        expect(String(url)).toBe("https://pve.example.com:8006/api2/json/version");
        expect(init?.headers).toMatchObject({ Authorization: "PVEAPIToken=root@pam!test=secret" });
        // rawGet sends no `method` member — GET is the platform default. Pin it
        // so a POST (a start/stop-style call) can never drift into the smoke test.
        expect(init?.method ?? "GET").toBe("GET");
        return makeResponse(200, { data: { version: "9.2.11", release: "9.2" } });
      });
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.testConnection({ baseUrl: "https://pve.example.com:8006" }, SECRETS)).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("maps an unauthenticated 401 to an auth error THAT NAMES THE TOKEN — PVE answers an empty body with the reason in the status line (kills a body-required parse that reports 'failed with HTTP 401: ' and nothing else)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(401, ""));
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch);

      const err = await provider
        .testConnection({ baseUrl: "https://pve.example.com:8006" }, SECRETS)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("auth");
      expect((err as Error).message).toContain("API token");
    });

    it("maps 403 to auth too — a token without VM.Audit on anything fails the same way (kills classing a permissions failure as protocol)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(403, ""));
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.testConnection({ baseUrl: "https://pve.example.com:8006" }, SECRETS)).rejects.toMatchObject({
        kind: "auth"
      });
    });

    it("carries PVE's own message from a {\"data\":null,\"message\":…} failure body, newline trimmed (kills echoing raw JSON — the message must be extracted, not the envelope sliced — or an empty tail where a message should be)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(500, { data: null, message: "QEMU guest agent is not running\n" }));
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch);

      const err = await provider
        .testConnection({ baseUrl: "https://pve.example.com:8006" }, SECRETS)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: "protocol" });
      expect((err as Error).message).toContain("QEMU guest agent is not running");
      // The message is a substring of the raw envelope, so `toContain` alone
      // would pass a body-echo implementation. The JSON scaffolding must not.
      expect((err as Error).message).not.toContain('"data"');
    });

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

    it("names the allowInsecureTls option, its Advanced section and the host for a TLS verification failure, keeping the OpenSSL code in the tail — read off `err.code` AND undici's `err.cause` (⊘ dropping the mapping restores the bare code the user was stuck in)", async () => {
      for (const viaCause of [false, true]) {
        const err = await createProxmoxProvider(failsWith("DEPTH_ZERO_SELF_SIGNED_CERT", viaCause))
          .testConnection({ baseUrl: "https://pve.example.com:8006" }, SECRETS)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InventoryProviderError);
        expect((err as InventoryProviderError).kind).toBe("network");
        const message = (err as Error).message;
        expect(message).toContain("pve.example.com");
        expect(message).toContain("Allow a Self-Signed or Mismatched Certificate");
        expect(message).toContain(ADVANCED_SECTION_LABEL);
        expect(message).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");
      }
    });

    it("leaves every NON-certificate code's wording exactly as it was (⊘ a greedy match rewrites ECONNREFUSED into advice about certificates)", async () => {
      for (const code of ["ECONNREFUSED", "ENOTFOUND", "CERT_SOMETHING_NEW"]) {
        const err = await createProxmoxProvider(failsWith(code))
          .testConnection({ baseUrl: "https://pve.example.com:8006" }, SECRETS)
          .catch((e: unknown) => e);
        expect((err as Error).message).toBe(`Could not reach pve.example.com:8006: ${code}.`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // INSECURE TLS — the same per-source opt-in EVE-NG and NetBox share, and the
  // question that actually matters: which transport a given config selects.
  // The tests that matter here are the NEGATIVE ones: an opted-out source and
  // an `http:` source must never reach the insecure transport.
  // ---------------------------------------------------------------------------

  describe("insecure TLS transport selection", () => {
    /** An empty but well-formed PVE that answers the version endpoint. */
    function world(): { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
      const calls: { url: string; init?: RequestInit }[] = [];
      const impl = async (url: string, init?: RequestInit): Promise<unknown> => {
        calls.push({ url: String(url), init });
        return makeResponse(200, { data: { version: "9.2.11", release: "9.2" } });
      };
      return { impl: impl as unknown as typeof fetch, calls };
    }

    function probes(): {
      standard: ReturnType<typeof world>;
      insecure: ReturnType<typeof world>;
      provider: ReturnType<typeof createProxmoxProvider>;
    } {
      const standard = world();
      const insecure = world();
      return { standard, insecure, provider: createProxmoxProvider(standard.impl, insecure.impl) };
    }

    const SECRETS = { apiToken: "root@pam!test=secret" };

    it("uses the insecure transport — and ONLY it — for an https source that opted in", async () => {
      const { standard, insecure, provider } = probes();
      await provider.testConnection({ baseUrl: "https://pve.example.com:8006", allowInsecureTls: true }, SECRETS);
      expect(insecure.calls.length).toBeGreaterThan(0);
      expect(standard.calls).toHaveLength(0);
    });

    it("NEVER uses it for a source that did not opt in, however the certificate would have failed (⊘ selecting on the URL scheme alone turns verification off for every https source)", async () => {
      for (const config of [{ baseUrl: "https://pve.example.com:8006", allowInsecureTls: false }, { baseUrl: "https://pve.example.com:8006" }]) {
        const { standard, insecure, provider } = probes();
        await provider.testConnection(config, SECRETS);
        expect(standard.calls.length).toBeGreaterThan(0);
        expect(insecure.calls).toHaveLength(0);
      }
    });

    it("NEVER uses it for an http source, where relaxing certificate checks means nothing and the adapter would refuse the URL anyway (⊘ selecting on the opt-in alone breaks every plain-http source the moment the box is ticked)", async () => {
      const { standard, insecure, provider } = probes();
      await provider.testConnection({ baseUrl: "http://pve.example.com", allowInsecureTls: true }, SECRETS);
      expect(standard.calls.length).toBeGreaterThan(0);
      expect(insecure.calls).toHaveLength(0);
    });

    /**
     * THE STRICTNESS IS LOAD-BEARING (EVE-NG A4, same finding as NetBox's). The
     * negative cases above only cover `false` and absent, so the mutation
     * `if (!config.allowInsecureTls)` would pass every one of them. The string
     * "true" is reachable — a restored backup, or a hand-edited globalState,
     * stores whatever it holds — and under that mutation it turns certificate
     * verification OFF for a source whose owner never ticked a box.
     */
    it("treats a NON-boolean opt-in as no opt-in at all and keeps the standard transport (⊘ a truthiness test turns verification off for a value the form can never produce)", async () => {
      for (const value of ["true", 1, "yes"]) {
        const { standard, insecure, provider } = probes();
        await provider.testConnection({ baseUrl: "https://pve.example.com:8006", allowInsecureTls: value }, SECRETS);
        expect(standard.calls.length).toBeGreaterThan(0);
        expect(insecure.calls).toHaveLength(0);
      }
    });

    it("normalizes the scheme before deciding, so an uppercase HTTPS:// base URL is still https (⊘ a raw startsWith('https:') check reads HTTPS:// as plain http and silently ignores the opt-in)", async () => {
      const { standard, insecure, provider } = probes();
      await provider.testConnection({ baseUrl: "HTTPS://pve.example.com:8006", allowInsecureTls: true }, SECRETS);
      expect(insecure.calls.length).toBeGreaterThan(0);
      expect(standard.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // FETCH INVENTORY — guests from ONE /cluster/resources call. Fixtures are
  // synthetic rows shaped exactly like the verified live rows: guest rows are
  // `{vmid, name?, node, type: "qemu"|"lxc", status, template, tags?, pool?}`;
  // node rows share the payload but carry no `ip` and no `name`. Addresses are
  // a later change — every device here is addressless by design.
  // ---------------------------------------------------------------------------

  describe("fetchInventory", () => {
    const BASE = "https://pve.example.com:8006";
    const SECRETS = { apiToken: "root@pam!test=secret" };

    /** A synthetic guest row shaped exactly like a verified live /cluster/resources row. */
    function guestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return { vmid: 105, name: "clawdbot", node: "pve", type: "qemu", status: "running", template: 0, ...overrides };
    }

    /**
     * Sync one mocked /cluster/resources payload. BOTH injected transports are
     * the same mock: unit tests never touch the network, and which transport a
     * config selects is Task 1's pinned territory — these tests only need every
     * request to land somewhere observable.
     */
    async function syncRows(rows: unknown[], config: InventorySourceValues = { baseUrl: BASE }) {
      const fetchImpl = vi.fn(async () => makeResponse(200, { data: rows }));
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch, fetchImpl as unknown as typeof fetch);
      const tree = await provider.fetchInventory(config, SECRETS);
      return { tree, fetchImpl };
    }

    it("maps one running qemu guest from the default template into its node folder — addressless, with the API call pinned to GET /cluster/resources and the PVEAPIToken header (kills a wrong endpoint, a missing unwrap of the {data:…} envelope, and a provider that invents endpoints before the address work exists)", async () => {
      const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        expect(String(url)).toBe(`${BASE}/api2/json/cluster/resources`);
        expect(init?.headers).toMatchObject({ Authorization: "PVEAPIToken=root@pam!test=secret" });
        return makeResponse(200, { data: [guestRow()] });
      });
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch, fetchImpl as unknown as typeof fetch);
      const tree = await provider.fetchInventory({ baseUrl: BASE }, SECRETS);
      expect(tree.devices).toEqual([
        {
          externalId: "105",
          name: "clawdbot",
          folderPath: "pve",
          endpoints: [],
          attributes: { type: ["qemu"], node: ["pve"], status: ["running"] }
        }
      ]);
      // The engine owns the addressless disclosure (ONE-ADDRESSLESS-LINE rule):
      // a clean sync of addressable-looking guests says NOTHING.
      expect(tree.warnings).toEqual([]);
    });

    it("keys every guest by its BARE vmid as a string — qemu and lxc alike (kills a `${type}/${vmid}` identity, which orphans every kept server the first time a guest's type spelling changes and breaks cross-source adoption)", async () => {
      const { tree } = await syncRows([
        guestRow({ vmid: 105, name: "clawdbot" }),
        guestRow({ vmid: 114, name: "dns", type: "lxc", status: "stopped" })
      ]);
      expect(tree.devices.map((d) => d.externalId)).toEqual(["105", "114"]);
    });

    it("keeps stopped guests by default — includeStopped ships ON — as addressless stopped placeholders (kills a default-OFF gate, under which a merely powered-off guest drops out of every sync and a delete-prune policy takes its server and stored credentials with it)", async () => {
      const { tree } = await syncRows([guestRow({ status: "stopped" })]);
      expect(tree.devices).toHaveLength(1);
      expect(tree.devices[0].attributes).toMatchObject({ status: ["stopped"] });
      expect(tree.devices[0].endpoints).toEqual([]);
    });

    it("drops stopped guests ENTIRELY when includeStopped is false, keeping the running ones (kills a filter that only stops mapping but still emits, and one that drops running guests too)", async () => {
      const { tree } = await syncRows([guestRow({ status: "stopped" }), guestRow({ vmid: 106, name: "up" })], {
        baseUrl: BASE,
        includeStopped: false
      });
      expect(tree.devices.map((d) => d.name)).toEqual(["up"]);
    });

    it("treats status 'unknown' — what PVE emits before RRD data exists — as the includeStopped gate's stopped case but invents NO status attribute for it (kills an invented 'unknown'/'running' state the status poll would immediately contradict)", async () => {
      const kept = await syncRows([guestRow({ status: "unknown" })]);
      expect(kept.tree.devices).toHaveLength(1);
      expect(kept.tree.devices[0].attributes).toEqual({ type: ["qemu"], node: ["pve"] });
      const gated = await syncRows([guestRow({ status: "unknown" })], { baseUrl: BASE, includeStopped: false });
      expect(gated.tree.devices).toEqual([]);
    });

    it("excludes template rows unless includeTemplates is on — a template cannot be started and the agent never answers for it (kills importing uninstantiable gold images by default)", async () => {
      const excluded = await syncRows([guestRow({ template: 1, name: "gold-image" })]);
      expect(excluded.tree.devices).toEqual([]);
      const included = await syncRows([guestRow({ template: 1, name: "gold-image" })], {
        baseUrl: BASE,
        includeTemplates: true
      });
      expect(included.tree.devices.map((d) => d.externalId)).toEqual(["105"]);
    });

    it("renders the folder template with PVE's variables — pool, node, type, and the SORTED-FIRST tag — dropping empty and unknown segments (kills an unsorted-first tag policy, which reshuffles folders when the user reorders tags in PVE, and a dangling '/' from an absent pool)", async () => {
      const cases: { template: string; row: Record<string, unknown>; expected: string }[] = [
        { template: "{pool}/{node}", row: guestRow({ pool: "prod" }), expected: "prod/pve" },
        { template: "{pool}/{node}", row: guestRow(), expected: "pve" },
        { template: "{tag}", row: guestRow({ tags: "zeta;alpha;mid" }), expected: "alpha" },
        { template: "{tag}", row: guestRow(), expected: "" },
        { template: "{type}", row: guestRow(), expected: "qemu" },
        { template: "{bogus}/{node}", row: guestRow(), expected: "pve" }
      ];
      for (const c of cases) {
        const { tree } = await syncRows([c.row], { baseUrl: BASE, folderTemplate: c.template });
        expect(tree.devices[0].folderPath).toBe(c.expected);
      }
    });

    it("splits the ';'-joined tag string into a set-valued tags attribute, dropping empty segments, and omits the key when the row has no tags (kills an attribute that leaks an empty array and one that keeps raw 'a;b' as a single value)", async () => {
      const tagged = await syncRows([guestRow({ tags: "managed-by-eve-ng-deploy;ops" })]);
      expect(tagged.tree.devices[0].attributes).toMatchObject({ tags: ["managed-by-eve-ng-deploy", "ops"] });
      const gapped = await syncRows([guestRow({ tags: "ops;;managed" })]);
      expect(gapped.tree.devices[0].attributes).toMatchObject({ tags: ["ops", "managed"] });
      const untagged = await syncRows([guestRow()]);
      expect(untagged.tree.devices[0].attributes).not.toHaveProperty("tags");
    });

    it("carries ONLY the documented attributes — the row's other API fields (cpu, mem, maxdisk, netin, id, uptime…) never leak in, and pool appears only when the row has one (kills a passthrough of the row object, which would churn matching attributes on every PVE stats update)", async () => {
      const loaded = await syncRows([
        guestRow({ cpu: 0.01, mem: 1024, maxdisk: 34359738368, netin: 100, netout: 200, id: "qemu/105", uptime: 99 })
      ]);
      expect(loaded.tree.devices[0].attributes).toEqual({ type: ["qemu"], node: ["pve"], status: ["running"] });
      const pooled = await syncRows([guestRow({ pool: "prod" })]);
      expect(pooled.tree.devices[0].attributes).toEqual({
        type: ["qemu"],
        node: ["pve"],
        status: ["running"],
        pool: ["prod"]
      });
    });

    it("emits a nameless guest with an empty name and NO endpoints — it cannot become a server, so an address on it would invite a half-mapped placeholder (kills an endpoint on a nameless device — the netbox convention)", async () => {
      const { tree } = await syncRows([guestRow({ vmid: 106, name: undefined })]);
      expect(tree.devices).toHaveLength(1);
      expect(tree.devices[0].externalId).toBe("106");
      expect(tree.devices[0].name).toBe("");
      expect(tree.devices[0].endpoints).toEqual([]);
    });

    it("stops at the hard cap — 10_001 rows yield exactly 10_000 devices, truncated: true and one warning (kills an uncapped mapper, which would stream an unbounded cluster into one tree and one sync plan)", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}` }));
      const { tree } = await syncRows(rows);
      expect(tree.devices).toHaveLength(10_000);
      expect(tree.truncated).toBe(true);
      expect(tree.warnings).toContain("Truncated at 10000 guests — narrow the source.");
    });

    it("refuses the whole sync when a row is not a JSON object — fail closed, never read-as-empty (kills a lenient mapper that skips corruption, under which the skipped row's server falls out of the engine's present set and gets pruned)", async () => {
      const err = await syncRows([guestRow(), "corrupted"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toContain("not a JSON object");
    });

    it("refuses a payload whose data is not an array — a truthy object is corruption, not an empty source (kills iterating a truthy object, which would present a mangled answer as 'the source legitimately has no devices' and prune everything)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(200, { data: {} }));
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch, fetchImpl as unknown as typeof fetch);
      const err = await provider.fetchInventory({ baseUrl: BASE }, SECRETS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toContain('"data" is not an array');
    });

    it("refuses a guest row without a usable vmid — no stable externalId, no safe identity, and fabricating one would poison adoption (kills a mapper that emits externalId 'undefined' for a corrupted row)", async () => {
      const err = await syncRows([{ name: "orphan", node: "pve", type: "qemu", status: "running", template: 0 }]).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toContain("vmid");
    });

    it("warns exactly once about an insecure sync, and only when the transport actually ran unverified — https with the opt-in warns, http with the same opt-in stays silent (kills a warning that disagrees with the selected transport, and one that fires twice)", async () => {
      const warned = await syncRows([guestRow()], { baseUrl: BASE, allowInsecureTls: true });
      expect(warned.tree.warnings).toEqual([PROXMOX_INSECURE_TLS_WARNING]);
      const quiet = await syncRows([guestRow()], { baseUrl: "http://pve.example.com", allowInsecureTls: true });
      expect(quiet.tree.warnings).toEqual([]);
    });

    it("ignores node rows in the payload while includeNodes is absent, making no second request (kills a mapper that turns /cluster/resources node rows — which carry no ip and no name — into devices, and one that fetches /cluster/status uninvited)", async () => {
      const { tree, fetchImpl } = await syncRows([
        { id: "node/pve", node: "pve", type: "node", status: "online" },
        guestRow()
      ]);
      expect(tree.devices.map((d) => d.externalId)).toEqual(["105"]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("stamps contractVersion 1 on the tree (kills an unversioned or re-versioned tree the engine's validator rejects)", async () => {
      const { tree } = await syncRows([guestRow()]);
      expect(tree.contractVersion).toBe(1);
    });
  });
});
