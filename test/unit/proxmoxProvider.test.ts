import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOLDER_TEMPLATE,
  PROXMOX_INSECURE_TLS_WARNING,
  PROXMOX_PROVIDER_ID,
  PROXMOX_STATUS_POLL_FIELD_ID,
  createProxmoxProvider,
  ifaceOrder,
  isGlobalAddress,
  parseLxcIfaces,
  parseNetMacs,
  parsePrimaryIpFamily,
  parseQemuAgentIfaces,
  pickAddress,
  proxmoxInstanceKey,
  readProxmoxStatusPollSeconds
} from "../../src/services/inventory/providers/proxmoxProvider";
import { validateProviderShape } from "../../src/services/inventory/providerRegistry";
import {
  InventoryProviderError,
  validateInventoryStatusReport,
  type InventorySourceValues
} from "../../src/models/inventory";
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

// -----------------------------------------------------------------------------
// GUEST ADDRESS RESOLUTION — pure parsing/selection pieces. Fixtures are the
// VERIFIED live API shapes (sanitized): the QEMU agent endpoint nests its
// interfaces under an extra `result` member; the LXC endpoint reports
// inet/inet6 CIDR strings; config netN property strings carry the NIC MACs.
// -----------------------------------------------------------------------------

describe("guest interface parsing", () => {
  it("parses the QEMU agent shape — the extra `result` nesting, the hardware-address MAC, and addresses kept in reported order (kills a flat-data read that finds no interfaces, and a parser that drops the loopback the global filter is supposed to judge)", () => {
    const payload = {
      data: {
        result: [
          {
            name: "lo",
            "hardware-address": "00:00:00:00:00:00",
            "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }]
          },
          {
            name: "enp6s18",
            "hardware-address": "BC:24:11:50:85:FA",
            "ip-addresses": [
              { "ip-address": "192.0.2.194", "ip-address-type": "ipv4", prefix: 24 },
              { "ip-address": "fe80::be24:11ff:fe50:85fa", "ip-address-type": "ipv6", prefix: 64 }
            ]
          }
        ]
      }
    };
    const ifaces = parseQemuAgentIfaces(payload);
    expect(ifaces).toEqual([
      { name: "lo", mac: "00:00:00:00:00:00", addresses: ["127.0.0.1"] },
      { name: "enp6s18", mac: "bc:24:11:50:85:fa", addresses: ["192.0.2.194", "fe80::be24:11ff:fe50:85fa"] }
    ]);
    // The global filter, applied to what the parser normalized: enp6s18 carries
    // exactly one usable host address — the link-local is dropped; the loopback
    // interface carries none.
    expect(ifaces[1].addresses.filter(isGlobalAddress)).toEqual(["192.0.2.194"]);
    expect(ifaces[0].addresses.filter(isGlobalAddress)).toEqual([]);
  });

  it("classifies agent addresses by SHAPE, never by the ip-address-type vocabulary — LXC's `inet` spelling shows up on the QEMU endpoint too (kills type-string classification, which drops or misroutes every address once the two endpoints' vocabularies drift)", () => {
    const payload = {
      data: {
        result: [
          {
            name: "eth0",
            "hardware-address": "BC:24:11:00:00:02",
            "ip-addresses": [
              { "ip-address": "192.0.2.5", "ip-address-type": "inet", prefix: 24 },
              { "ip-address": "2001:db8::5", "ip-address-type": "inet", prefix: 64 }
            ]
          }
        ]
      }
    };
    const [iface] = parseQemuAgentIfaces(payload);
    expect(iface.addresses.filter(isGlobalAddress)).toEqual(["192.0.2.5", "2001:db8::5"]);
    expect(pickAddress(iface.addresses, "prefer-ipv4")).toBe("192.0.2.5");
    expect(pickAddress(iface.addresses, "prefer-ipv6")).toBe("2001:db8::5");
  });

  it("parses the LXC interfaces shape — inet/inet6 CIDR strings read as addresses, hwaddr lowercased — and reads a stopped container's {\"data\":null} as NO interfaces, not an error (kills a null-read-as-error that would have every stopped CT's crawl blow up)", () => {
    const payload = {
      data: [
        { name: "lo", inet: "127.0.0.1/8" },
        { name: "eth0", hwaddr: "BC:24:11:6F:19:87", inet: "192.0.2.10/24", inet6: "2001:db8::10/64" }
      ]
    };
    expect(parseLxcIfaces(payload)).toEqual([
      { name: "lo", mac: "", addresses: ["127.0.0.1/8"] },
      { name: "eth0", mac: "bc:24:11:6f:19:87", addresses: ["192.0.2.10/24", "2001:db8::10/64"] }
    ]);
    expect(parseLxcIfaces({ data: null })).toEqual([]);
    // CIDR is stripped LATER — at the endpoint/attribute layer — so the parse
    // keeps what the API reported and the global filter still reads it.
    const eth0 = parseLxcIfaces(payload)[1];
    expect(isGlobalAddress("192.0.2.10/24")).toBe(true);
    expect(pickAddress(eth0.addresses, "auto")).toBe("192.0.2.10");
    expect(pickAddress(eth0.addresses, "prefer-ipv6")).toBe("2001:db8::10");
  });

  it("parses config netN property strings — model-agnostic MAC segment match, case-folded, NUMERIC index sort (kills lexical net10 < net2 ordering, which would rank the eleventh NIC above the third, and a qemu-only <model>=<MAC> first-segment read that misses lxc's hwaddr=)", () => {
    const qemu = {
      data: {
        net0: "virtio=BC:24:11:50:85:FA,bridge=vmbr0,firewall=1",
        net1: "e1000=BC:24:11:00:00:01,bridge=vmbr1"
      }
    };
    expect(parseNetMacs(qemu)).toEqual([
      { index: 0, mac: "bc:24:11:50:85:fa" },
      { index: 1, mac: "bc:24:11:00:00:01" }
    ]);
    // NUMERIC sort: net10 sorts after net2, never lexically between net1 and net2.
    const wide = {
      data: {
        net10: "virtio=BC:24:11:00:00:0A,bridge=vmbr0",
        net2: "virtio=BC:24:11:00:00:02,bridge=vmbr0"
      }
    };
    expect(parseNetMacs(wide)).toEqual([
      { index: 2, mac: "bc:24:11:00:00:02" },
      { index: 10, mac: "bc:24:11:00:00:0a" }
    ]);
    // LXC spells the MAC as a hwaddr= segment of the same comma-separated string.
    const lxc = { data: { net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:6F:19:87,ip=192.0.2.10/24" } };
    expect(parseNetMacs(lxc)).toEqual([{ index: 0, mac: "bc:24:11:6f:19:87" }]);
    // Non-MAC segments (bridge, firewall, name, ip) and non-netN keys are ignored.
    expect(parseNetMacs({ data: { net0: "bridge=vmbr0,firewall=1" } })).toEqual([]);
    expect(parseNetMacs({ data: { net0: "virtio=BC:24:11:50:85:FA", description: "ignored" } })).toEqual([
      { index: 0, mac: "bc:24:11:50:85:fa" }
    ]);
    // Defensive shapes: a missing/absent config payload reads as no MACs.
    expect(parseNetMacs({ data: null })).toEqual([]);
    expect(parseNetMacs(undefined)).toEqual([]);
  });

  it("isGlobalAddress — keeps documentation-range hosts of both families, drops loopback, link-local, unspecified, multicast/reserved and unparseable addresses, and reads CIDR suffixes (kills a filter that only knows one family's special ranges)", () => {
    for (const addr of ["192.0.2.1", "198.51.100.7", "203.0.113.9/24", "2001:db8::1", "fd00::1", "2001:db8::5/64"]) {
      expect(isGlobalAddress(addr)).toBe(true);
    }
    for (const addr of [
      "127.0.0.1",
      "127.8.8.8/8", // v4 loopback 127/8
      "169.254.3.4", // v4 link-local 169.254/16
      "0.0.0.0", // unspecified
      "224.0.0.1",
      "239.1.2.3",
      "255.255.255.255", // multicast and reserved, 224/4 and up
      "300.1.1.1",
      "not-an-address", // unparseable v4 — never a usable host
      "::1",
      "::", // v6 loopback and unspecified
      "fe80::1",
      "febf::1",
      "fe80::be24:11ff:fe50:85fa/64", // fe80::/10 spans fe80..febf
      "ff02::1",
      "ff05::1:3", // ff00::/8 multicast
      "2001:db8::1%eth0" // scoped — not a usable host address
    ]) {
      expect(isGlobalAddress(addr)).toBe(false);
    }
  });

  it("pickAddress — auto takes the first global in reported order, prefer-* takes that family first and FALLS BACK to the other, CIDR stripped (kills a family preference that yields an addressless device when the chosen interface has none of that family)", () => {
    const both = ["192.0.2.10/24", "2001:db8::10/64", "fe80::1/64", "127.0.0.1"];
    expect(pickAddress(both, "auto")).toBe("192.0.2.10");
    expect(pickAddress(both, "prefer-ipv4")).toBe("192.0.2.10");
    expect(pickAddress(both, "prefer-ipv6")).toBe("2001:db8::10");
    expect(pickAddress(["2001:db8::10"], "prefer-ipv4")).toBe("2001:db8::10");
    expect(pickAddress(["192.0.2.10"], "prefer-ipv6")).toBe("192.0.2.10");
    expect(pickAddress(["127.0.0.1", "fe80::1"], "auto")).toBeUndefined();
    expect(pickAddress([], "auto")).toBeUndefined();
  });

  it("ifaceOrder — config-MAC matches first by numeric netN index, then unmatched interfaces in enumeration order, comparing MACs case-insensitively (kills agent-order-only selection, which picks an in-guest docker bridge over the NIC PVE knows)", () => {
    const docker0 = { name: "docker0", mac: "aa:bb:cc:dd:ee:01", addresses: [] };
    const enp = { name: "enp6s18", mac: "bc:24:11:50:85:fa", addresses: [] };
    // The config side keeps the case PVE reported; the match must not care.
    expect(ifaceOrder([docker0, enp], [{ index: 0, mac: "BC:24:11:50:85:FA" }])).toEqual([enp, docker0]);
    // Both matched ⇒ net0 before net1 even when enumeration says otherwise.
    const eth1 = { name: "if1", mac: "bc:24:11:00:00:01", addresses: [] };
    const eth0 = { name: "if0", mac: "bc:24:11:00:00:00", addresses: [] };
    const two = [
      { index: 1, mac: "bc:24:11:00:00:01" },
      { index: 0, mac: "bc:24:11:00:00:00" }
    ];
    expect(ifaceOrder([eth1, eth0], two)).toEqual([eth0, eth1]);
    // No config (empty MACs) ⇒ enumeration order survives untouched — the
    // degrade path keeps yielding addresses.
    expect(ifaceOrder([docker0, enp], [])).toEqual([docker0, enp]);
  });
});

describe("readProxmoxStatusPollSeconds", () => {
  it("clamps and floors exactly like EVE-NG's reader but reads the PROXMOX field id — absent, non-numeric, negative, fractional and out-of-range values all land on an armable period (kills a reader wired to the wrong provider's field, and an unclamped read that would arm a millisecond-period timer against the cluster)", () => {
    expect(PROXMOX_STATUS_POLL_FIELD_ID).toBe("statusPollSeconds");
    const config = (v: unknown): Record<string, unknown> => ({ baseUrl: "https://pve.example.com:8006", [PROXMOX_STATUS_POLL_FIELD_ID]: v });
    expect(readProxmoxStatusPollSeconds(config(60) as never)).toBe(60);
    expect(readProxmoxStatusPollSeconds(config(9999) as never)).toBe(3600);
    expect(readProxmoxStatusPollSeconds(config(1.9) as never)).toBe(1);
    expect(readProxmoxStatusPollSeconds(config(0) as never)).toBe(0);
    expect(readProxmoxStatusPollSeconds(config(-5) as never)).toBe(0);
    expect(readProxmoxStatusPollSeconds(config(undefined) as never)).toBe(0);
    expect(readProxmoxStatusPollSeconds(config("60") as never)).toBe(0);
    expect(readProxmoxStatusPollSeconds(config(Number.NaN) as never)).toBe(0);
    expect(readProxmoxStatusPollSeconds({} as never)).toBe(0);
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
        expect(init?.headers).toMatchObject({ Authorization: "PVEAPIToken=root@pam!test=secret" });
        if (String(url) === `${BASE}/api2/json/cluster/resources`) {
          return makeResponse(200, { data: [guestRow()] });
        }
        // The running guest now triggers the per-guest address crawl (config +
        // agent GETs); this test pins the LIST call, so the crawl's requests are
        // answered with the "no data" shape and the guest stays addressless.
        return makeResponse(200, { data: null });
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

    it("stops at the hard cap — 10_001 rows yield exactly 10_000 devices, truncated: true and one warning (kills an uncapped mapper, which would stream an unbounded cluster into one tree and one sync plan). Rows are STOPPED so the row-cap pin stays single-call: running guests would fan out into the address crawl, whose own caps are pinned separately below", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree } = await syncRows(rows);
      expect(tree.devices).toHaveLength(10_000);
      expect(tree.truncated).toBe(true);
      expect(tree.warnings).toContain("Truncated at 10000 devices — narrow the source.");
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

    it("ignores node rows in the payload while includeNodes is absent, making no /cluster/status request (kills a mapper that turns /cluster/resources node rows — which carry no ip and no name — into devices, and one that fetches /cluster/status uninvited; the running guest's own address-crawl calls are expected and answered by the shared mock)", async () => {
      const { tree, fetchImpl } = await syncRows([
        { id: "node/pve", node: "pve", type: "node", status: "online" },
        guestRow()
      ]);
      expect(tree.devices.map((d) => d.externalId)).toEqual(["105"]);
      expect(fetchImpl.mock.calls.every(([u]) => !String(u).includes("/cluster/status"))).toBe(true);
    });

    it("stamps contractVersion 1 on the tree (kills an unversioned or re-versioned tree the engine's validator rejects)", async () => {
      const { tree } = await syncRows([guestRow()]);
      expect(tree.contractVersion).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // GUEST ADDRESS RESOLUTION — the per-running-guest crawl. Two GETs per guest
  // (config for the NIC MACs, the type's IP endpoint), both best-effort, within
  // a shared wall-clock deadline and a MAX_IP_GUESTS cap. Fixtures carry
  // documentation-range addresses (192.0.2.x, 2001:db8::) and synthetic MACs.
  // ---------------------------------------------------------------------------

  describe("fetchInventory — guest address resolution", () => {
    const BASE = "https://pve.example.com:8006";
    const SECRETS = { apiToken: "root@pam!test=secret" };
    const RESOURCES = "/api2/json/cluster/resources";
    const qemuConfigPath = (vmid: number | string) => `/api2/json/nodes/pve/qemu/${vmid}/config`;
    const qemuAgentPath = (vmid: number | string) => `/api2/json/nodes/pve/qemu/${vmid}/agent/network-get-interfaces`;
    const lxcConfigPath = (vmid: number | string) => `/api2/json/nodes/pve/lxc/${vmid}/config`;
    const lxcIfacesPath = (vmid: number | string) => `/api2/json/nodes/pve/lxc/${vmid}/interfaces`;

    const NET0 = "BC:24:11:50:85:FA";
    const NET1 = "BC:24:11:00:00:01";
    const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      vmid: 105,
      name: "clawdbot",
      node: "pve",
      type: "qemu",
      status: "running",
      template: 0,
      ...overrides
    });
    const ok = (body: unknown): { body: unknown } => ({ body });
    const fail = (status: number, body: unknown = null): { status: number; body: unknown } => ({ status, body });
    type RouteMap = Record<string, { status?: number; body: unknown }>;

    /** The qemu config of the default fixture guest: one NIC, net0. */
    const qemuConfig = { data: { net0: `virtio=${NET0},bridge=vmbr0,firewall=1` } };
    /** A two-NIC config, net0 + net1. */
    const qemuConfigTwo = { data: { net0: `virtio=${NET0},bridge=vmbr0`, net1: `e1000=${NET1},bridge=vmbr1` } };
    /** The verified agent shape for the net0 NIC: loopback + one global v4 + one link-local v6. */
    const agentEnp = {
      data: {
        result: [
          {
            name: "lo",
            "hardware-address": "00:00:00:00:00:00",
            "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }]
          },
          {
            name: "enp6s18",
            "hardware-address": NET0,
            "ip-addresses": [
              { "ip-address": "192.0.2.194", "ip-address-type": "ipv4", prefix: 24 },
              { "ip-address": "fe80::be24:11ff:fe50:85fa", "ip-address-type": "ipv6", prefix: 64 }
            ]
          }
        ]
      }
    };
    /** A single dual-stack interface carrying the net0 MAC. */
    const agentDual = (v4: string, v6: string): unknown => ({
      data: {
        result: [
          {
            name: "enp6s18",
            "hardware-address": NET0,
            "ip-addresses": [
              { "ip-address": v4, "ip-address-type": "ipv4", prefix: 24 },
              { "ip-address": v6, "ip-address-type": "ipv6", prefix: 64 }
            ]
          }
        ]
      }
    });
    /** The verified LXC interfaces shape for the running "dns" container. */
    const lxcIfaces = {
      data: [
        { name: "lo", inet: "127.0.0.1/8" },
        { name: "eth0", hwaddr: "BC:24:11:6F:19:87", inet: "192.0.2.10/24", inet6: "2001:db8::10/64" }
      ]
    };
    const lxcConfig = { data: { net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:6F:19:87" } };

    /**
     * Sync one routed world: responses keyed by URL path, call log returned for
     * call-count assertions. An unrouted path answers 500 — a crawl that goes
     * where the test did not plan shows up as a tolerated-addressless device
     * AND as an unexpected call, so both assertion styles can catch it.
     */
    async function syncRoutes(routes: RouteMap, config: InventorySourceValues = { baseUrl: BASE }) {
      const calls: string[] = [];
      const impl = async (input: string | URL): Promise<unknown> => {
        const url = String(input);
        calls.push(url);
        const hit = routes[new URL(url).pathname];
        if (!hit) {
          return makeResponse(500, { data: null, message: `no test route for ${new URL(url).pathname}` });
        }
        return makeResponse(hit.status ?? 200, hit.body);
      };
      const provider = createProxmoxProvider(impl as unknown as typeof fetch, impl as unknown as typeof fetch);
      const tree = await provider.fetchInventory(config, SECRETS);
      return { tree, calls };
    }

    it("chooses the config-MAC-matched interface over an earlier unmatched one — docker0 reporting first still loses to enp6s18 (kills agent-order-only selection, which puts an in-guest docker bridge where the guest's real NIC belongs)", async () => {
      const { tree } = await syncRoutes({
        [RESOURCES]: ok({ data: [row()] }),
        [qemuConfigPath(105)]: ok(qemuConfig),
        [qemuAgentPath(105)]: ok({
          data: {
            result: [
              {
                name: "docker0",
                "hardware-address": "AA:BB:CC:DD:EE:01",
                "ip-addresses": [{ "ip-address": "192.0.2.99", "ip-address-type": "ipv4", prefix: 16 }]
              },
              {
                name: "enp6s18",
                "hardware-address": NET0,
                "ip-addresses": [{ "ip-address": "192.0.2.194", "ip-address-type": "ipv4", prefix: 24 }]
              }
            ]
          }
        })
      });
      expect(tree.devices[0].endpoints).toEqual([{ kind: "ssh", host: "192.0.2.194", port: 22 }]);
    });

    it("orders two matched interfaces by netN index — net0 wins over net1 even when the agent reported net1 first (kills index-blind matching, which takes whichever interface the agent happened to list first)", async () => {
      const { tree } = await syncRoutes({
        [RESOURCES]: ok({ data: [row()] }),
        [qemuConfigPath(105)]: ok(qemuConfigTwo),
        [qemuAgentPath(105)]: ok({
          data: {
            result: [
              {
                name: "eth1",
                "hardware-address": NET1,
                "ip-addresses": [{ "ip-address": "192.0.2.2", "ip-address-type": "ipv4", prefix: 24 }]
              },
              {
                name: "eth0",
                "hardware-address": NET0,
                "ip-addresses": [{ "ip-address": "192.0.2.1", "ip-address-type": "ipv4", prefix: 24 }]
              }
            ]
          }
        })
      });
      expect(tree.devices[0].endpoints).toEqual([{ kind: "ssh", host: "192.0.2.1", port: 22 }]);
    });

    it("degrades when the config fetch fails — agent order still yields an address (kills dropping a device's only usable interface because its MAC could not be matched against a config that never arrived)", async () => {
      const { tree } = await syncRoutes({
        [RESOURCES]: ok({ data: [row()] }),
        [qemuConfigPath(105)]: fail(500, { data: null, message: "boom" }),
        [qemuAgentPath(105)]: ok({
          data: {
            result: [
              {
                name: "docker0",
                "hardware-address": "AA:BB:CC:DD:EE:01",
                "ip-addresses": [{ "ip-address": "192.0.2.99", "ip-address-type": "ipv4", prefix: 16 }]
              },
              {
                name: "enp6s18",
                "hardware-address": NET0,
                "ip-addresses": [{ "ip-address": "192.0.2.194", "ip-address-type": "ipv4", prefix: 24 }]
              }
            ]
          }
        })
      });
      expect(tree.devices[0].endpoints).toEqual([{ kind: "ssh", host: "192.0.2.99", port: 22 }]);
    });

    it("resolves a running LXC container — inet/inet6 CIDR stripped into bare hosts (kills an endpoint host carrying a '/24' suffix)", async () => {
      const { tree } = await syncRoutes({
        [RESOURCES]: ok({ data: [row({ vmid: 114, name: "dns", type: "lxc" })] }),
        [lxcConfigPath(114)]: ok(lxcConfig),
        [lxcIfacesPath(114)]: ok(lxcIfaces)
      });
      expect(tree.devices[0].endpoints).toEqual([
        { kind: "ssh", host: "192.0.2.10", port: 22 },
        { kind: "ssh", host: "2001:db8::10", port: 22 }
      ]);
      expect(tree.devices[0].attributes).toMatchObject({ ip: ["192.0.2.10"], ip6: ["2001:db8::10"] });
    });

    it("applies the family preference to the chosen interface and emits the other family as the SECOND ssh endpoint; a family with no address falls back and emits NO alternate (kills an addressless device from a family preference, and a duplicate-address alternate)", async () => {
      const run = async (routes: RouteMap, config: InventorySourceValues) => (await syncRoutes(routes, config)).tree.devices[0].endpoints;
      const dualRoutes: RouteMap = {
        [RESOURCES]: ok({ data: [row()] }),
        [qemuConfigPath(105)]: ok(qemuConfig),
        [qemuAgentPath(105)]: ok(agentDual("192.0.2.10", "2001:db8::10"))
      };
      // auto: first global in reported order, with the other family as alternate.
      expect(await run(dualRoutes, { baseUrl: BASE })).toEqual([
        { kind: "ssh", host: "192.0.2.10", port: 22 },
        { kind: "ssh", host: "2001:db8::10", port: 22 }
      ]);
      expect(await run(dualRoutes, { baseUrl: BASE, primaryIpFamily: "prefer-ipv4" })).toEqual([
        { kind: "ssh", host: "192.0.2.10", port: 22 },
        { kind: "ssh", host: "2001:db8::10", port: 22 }
      ]);
      expect(await run(dualRoutes, { baseUrl: BASE, primaryIpFamily: "prefer-ipv6" })).toEqual([
        { kind: "ssh", host: "2001:db8::10", port: 22 },
        { kind: "ssh", host: "192.0.2.10", port: 22 }
      ]);
      // Only v4 exists: prefer-ipv6 falls back to the v4 primary — the device
      // must NOT go addressless — and there is no v6 alternate to add.
      const v4OnlyRoutes: RouteMap = {
        [RESOURCES]: ok({ data: [row()] }),
        [qemuConfigPath(105)]: ok(qemuConfig),
        [qemuAgentPath(105)]: ok({
          data: {
            result: [
              {
                name: "enp6s18",
                "hardware-address": NET0,
                "ip-addresses": [{ "ip-address": "192.0.2.10", "ip-address-type": "ipv4", prefix: 24 }]
              }
            ]
          }
        })
      };
      expect(await run(v4OnlyRoutes, { baseUrl: BASE, primaryIpFamily: "prefer-ipv6" })).toEqual([
        { kind: "ssh", host: "192.0.2.10", port: 22 }
      ]);
      expect(await run(v4OnlyRoutes, { baseUrl: BASE, primaryIpFamily: "prefer-ipv4" })).toEqual([
        { kind: "ssh", host: "192.0.2.10", port: 22 }
      ]);
    });

    it("emits ssh endpoints at port 22, and a guest with no global address anywhere still ships as an addressless device with NO provider warning (kills a warning-per-addressless-guest flood — the engine owns that disclosure)", async () => {
      const { tree } = await syncRoutes({
        [RESOURCES]: ok({ data: [row()] }),
        [qemuConfigPath(105)]: ok(qemuConfig),
        [qemuAgentPath(105)]: ok({
          data: {
            result: [
              {
                name: "lo",
                "hardware-address": "00:00:00:00:00:00",
                "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }]
              },
              {
                name: "enp6s18",
                "hardware-address": NET0,
                "ip-addresses": [{ "ip-address": "fe80::be24:11ff:fe50:85fa", "ip-address-type": "ipv6", prefix: 64 }]
              }
            ]
          }
        })
      });
      expect(tree.devices).toHaveLength(1);
      expect(tree.devices[0].endpoints).toEqual([]);
      // The MACs are still disclosed — "all MACs across ALL interfaces" is a
      // property of what the guest REPORTED, not of what filled Host.
      expect(tree.devices[0].attributes).toEqual({
        type: ["qemu"],
        node: ["pve"],
        status: ["running"],
        mac: ["00:00:00:00:00:00", "bc:24:11:50:85:fa"]
      });
      expect(tree.warnings).toEqual([]);
    });

    it("tolerates a per-guest agent failure and keeps crawling — guest 105's agent 500 leaves 105 addressless while guest 106 still gets its address; a 403 degrades the same way (kills a first-failure-aborts-the-crawl)", async () => {
      const rows = [row(), row({ vmid: 106, name: "up" })];
      const syncWithAgentFailure = async (status: number, body: unknown) => {
        const routes: RouteMap = {
          [RESOURCES]: ok({ data: rows }),
          [qemuConfigPath(105)]: ok(qemuConfig),
          [qemuConfigPath(106)]: ok(qemuConfig),
          [qemuAgentPath(105)]: fail(status, body),
          [qemuAgentPath(106)]: ok(agentEnp)
        };
        return syncRoutes(routes);
      };
      // The verified agent-missing failure shape.
      const failed500 = await syncWithAgentFailure(500, { data: null, message: "QEMU guest agent is not running\n" });
      const [d105, d106] = failed500.tree.devices;
      expect(d105.endpoints).toEqual([]);
      expect(d105.attributes).not.toHaveProperty("ip");
      expect(d106.endpoints).toEqual([{ kind: "ssh", host: "192.0.2.194", port: 22 }]);
      // A permissions failure on one guest's agent is the same tolerated case.
      const failed403 = await syncWithAgentFailure(403, "");
      expect(failed403.tree.devices[0].endpoints).toEqual([]);
      expect(failed403.tree.devices[1].endpoints).toEqual([{ kind: "ssh", host: "192.0.2.194", port: 22 }]);
    });

    it("caps the address crawl at MAX_IP_GUESTS — guests beyond the cap stay addressless with truncated: true and a warning naming the cap (kills an unbounded per-guest crawl that would pin a big cluster for minutes)", async () => {
      const rows = Array.from({ length: 1001 }, (_, i) => row({ vmid: i + 1, name: `guest-${i + 1}` }));
      const calls: string[] = [];
      const impl = async (input: string | URL): Promise<unknown> => {
        const url = String(input);
        calls.push(url);
        const path = new URL(url).pathname;
        if (path === RESOURCES) return makeResponse(200, { data: rows });
        if (/^\/api2\/json\/nodes\/pve\/qemu\/\d+\/config$/.test(path)) return makeResponse(200, qemuConfig);
        if (/^\/api2\/json\/nodes\/pve\/qemu\/\d+\/agent\/network-get-interfaces$/.test(path)) {
          return makeResponse(200, agentEnp);
        }
        return makeResponse(500, { data: null, message: `no test route for ${path}` });
      };
      const provider = createProxmoxProvider(impl as unknown as typeof fetch, impl as unknown as typeof fetch);
      const tree = await provider.fetchInventory({ baseUrl: BASE }, SECRETS);
      expect(tree.devices).toHaveLength(1001);
      // The first 1000 guests were crawled; the 1001st never was.
      expect(calls.filter((c) => c.includes("/agent/"))).toHaveLength(1000);
      expect(calls.some((c) => c.includes("/1001/"))).toBe(false);
      expect(tree.devices[999].endpoints).toEqual([{ kind: "ssh", host: "192.0.2.194", port: 22 }]);
      expect(tree.devices[1000].endpoints).toEqual([]);
      expect(tree.truncated).toBe(true);
      expect(tree.warnings).toContain("Truncated at 1000 guest address lookups — narrow the source.");
    });

    it("trips the shared crawl deadline — the next guest makes no fetch, truncated: true and a deadline warning (kills an unbounded crawl against a slow cluster; the clock seam is a Date.now spy advanced by the fetch, the same idiom EVE-NG's deadline tests use)", async () => {
      let clock = 1_000_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
      try {
        const calls: string[] = [];
        const impl = async (input: string | URL): Promise<unknown> => {
          const url = String(input);
          calls.push(url);
          const path = new URL(url).pathname;
          // The FIRST guest's agent call eats the entire budget: a cluster this
          // slow must never see a second guest's requests.
          if (path === qemuAgentPath(105)) {
            clock += 130_000;
            return makeResponse(200, agentEnp);
          }
          if (path === RESOURCES) return makeResponse(200, { data: [row(), row({ vmid: 106, name: "up" })] });
          if (path === qemuConfigPath(105)) return makeResponse(200, qemuConfig);
          return makeResponse(500, { data: null, message: `no test route for ${path}` });
        };
        const provider = createProxmoxProvider(impl as unknown as typeof fetch, impl as unknown as typeof fetch);
        const tree = await provider.fetchInventory({ baseUrl: BASE }, SECRETS);
        expect(tree.truncated).toBe(true);
        expect(tree.warnings).toContain(
          "Stopped after 120s — the Proxmox address crawl exceeded its time limit and some guests were imported addressless."
        );
        expect(calls.some((c) => c.includes("/106/"))).toBe(false);
        // Guest 105 completed before the trip and keeps its address.
        expect(tree.devices.find((d) => d.externalId === "105")?.endpoints).toEqual([
          { kind: "ssh", host: "192.0.2.194", port: 22 }
        ]);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("only RUNNING, non-template guests trigger address fetches — stopped guests and included templates make no config/agent calls (kills a crawl that burns two requests per guest the API cannot answer)", async () => {
      const rows = [
        row(),
        row({ vmid: 114, name: "dns", type: "lxc", status: "stopped" }),
        row({ vmid: 116, name: "gold-image", template: 1 })
      ];
      const calls: string[] = [];
      const impl = async (input: string | URL): Promise<unknown> => {
        const url = String(input);
        calls.push(url);
        const path = new URL(url).pathname;
        if (path === RESOURCES) return makeResponse(200, { data: rows });
        if (/^\/api2\/json\/nodes\/pve\/qemu\/\d+\/config$/.test(path)) return makeResponse(200, qemuConfig);
        if (/^\/api2\/json\/nodes\/pve\/qemu\/\d+\/agent\/network-get-interfaces$/.test(path)) {
          return makeResponse(200, agentEnp);
        }
        return makeResponse(500, { data: null, message: `no test route for ${path}` });
      };
      const provider = createProxmoxProvider(impl as unknown as typeof fetch, impl as unknown as typeof fetch);
      const tree = await provider.fetchInventory({ baseUrl: BASE, includeTemplates: true }, SECRETS);
      expect(tree.devices.map((d) => d.externalId)).toEqual(["105", "114", "116"]);
      expect(calls).toHaveLength(3); // resources + 105's config + 105's agent
      expect(calls.some((c) => c.includes("/114/"))).toBe(false);
      expect(calls.some((c) => c.includes("/116/"))).toBe(false);
    });

    it("composes truncation — a payload over the row cap whose guests then exhaust the IP cap sets truncated from EITHER budget and pushes both warnings (kills an IP-cap flag that overwrites the row-cap flag)", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => row({ vmid: i + 1, name: `guest-${i + 1}` }));
      const calls: string[] = [];
      const impl = async (input: string | URL): Promise<unknown> => {
        const url = String(input);
        calls.push(url);
        const path = new URL(url).pathname;
        if (path === RESOURCES) return makeResponse(200, { data: rows });
        if (/^\/api2\/json\/nodes\/pve\/qemu\/\d+\/config$/.test(path)) return makeResponse(200, qemuConfig);
        if (/^\/api2\/json\/nodes\/pve\/qemu\/\d+\/agent\/network-get-interfaces$/.test(path)) {
          return makeResponse(200, agentEnp);
        }
        return makeResponse(500, { data: null, message: `no test route for ${path}` });
      };
      const provider = createProxmoxProvider(impl as unknown as typeof fetch, impl as unknown as typeof fetch);
      const tree = await provider.fetchInventory({ baseUrl: BASE }, SECRETS);
      expect(tree.devices).toHaveLength(10_000);
      // The crawl ran its own budget to exhaustion inside the row-capped list.
      expect(calls.filter((c) => c.includes("/agent/"))).toHaveLength(1000);
      expect(tree.truncated).toBe(true);
      expect(tree.warnings).toContain("Truncated at 10000 devices — narrow the source.");
      expect(tree.warnings).toContain("Truncated at 1000 guest address lookups — narrow the source.");
    });

    it("collects ALL interfaces' globals into the ip/ip6 sets plus lowercased MACs and global-holding interface names, omitting the empty sets (kills attribute sets that only mirror the chosen interface, and empty-set keys a template filter could match)", async () => {
      const { tree } = await syncRoutes({
        [RESOURCES]: ok({ data: [row()] }),
        [qemuConfigPath(105)]: ok(qemuConfig),
        [qemuAgentPath(105)]: ok({
          data: {
            result: [
              {
                name: "lo",
                "hardware-address": "00:00:00:00:00:00",
                "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }]
              },
              {
                name: "enp6s18",
                "hardware-address": NET0,
                "ip-addresses": [
                  { "ip-address": "192.0.2.194", "ip-address-type": "ipv4", prefix: 24 },
                  { "ip-address": "2001:db8::194", "ip-address-type": "ipv6", prefix: 64 },
                  { "ip-address": "fe80::be24:11ff:fe50:85fa", "ip-address-type": "ipv6", prefix: 64 }
                ]
              },
              {
                name: "docker0",
                "hardware-address": "AA:BB:CC:DD:EE:01",
                "ip-addresses": [{ "ip-address": "192.0.2.99", "ip-address-type": "ipv4", prefix: 16 }]
              }
            ]
          }
        })
      });
      expect(tree.devices[0].endpoints).toEqual([
        { kind: "ssh", host: "192.0.2.194", port: 22 },
        { kind: "ssh", host: "2001:db8::194", port: 22 }
      ]);
      expect(tree.devices[0].attributes).toEqual({
        type: ["qemu"],
        node: ["pve"],
        status: ["running"],
        ip: ["192.0.2.194", "192.0.2.99"],
        ip6: ["2001:db8::194"],
        mac: ["00:00:00:00:00:00", "bc:24:11:50:85:fa", "aa:bb:cc:dd:ee:01"],
        ifname: ["enp6s18", "docker0"]
      });
    });
  });

  // ---------------------------------------------------------------------------
  // CLUSTER NODE IMPORT (includeNodes) — the /cluster/resources payload's node
  // rows carry NO `ip` and NO `name` (verified live shape: {id, node, type,
  // status: "online"|"offline"|"unknown"}), so they establish EXISTENCE only;
  // name and address come from a SECOND call, GET /cluster/status (Sys.Audit),
  // the only endpoint carrying node `ip` and numeric `online`. Fixtures are the
  // verified shapes, sanitized.
  // ---------------------------------------------------------------------------

  describe("fetchInventory — cluster node import (includeNodes)", () => {
    const BASE = "https://pve.example.com:8006";
    const SECRETS = { apiToken: "root@pam!test=secret" };
    const RESOURCES = "/api2/json/cluster/resources";
    const STATUS = "/api2/json/cluster/status";

    /** The verified /cluster/resources node row: existence only, no name/ip members. */
    const nodeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "node/pve",
      node: "pve",
      type: "node",
      status: "online",
      ...overrides
    });

    /** The verified /cluster/status node entry: the ONLY source of node name, ip and numeric online. */
    const statusEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      type: "node",
      name: "pve",
      nodeid: 0,
      online: 1,
      ip: "192.0.2.240",
      id: "node/pve",
      ...overrides
    });

    type RouteMap = Record<string, { status?: number; body: unknown }>;

    /** Sync a routed world; unrouted paths answer 500 so an unexpected request shows in both the call log and the devices. */
    async function syncNodes(routes: RouteMap, config: InventorySourceValues) {
      const calls: { url: string; auth?: string }[] = [];
      const impl = async (input: string | URL, init?: { headers?: Record<string, string> }): Promise<unknown> => {
        const url = String(input);
        calls.push({ url, auth: init?.headers?.Authorization });
        const hit = routes[new URL(url).pathname];
        if (!hit) {
          return makeResponse(500, { data: null, message: `no test route for ${new URL(url).pathname}` });
        }
        return makeResponse(hit.status ?? 200, hit.body);
      };
      const provider = createProxmoxProvider(impl as unknown as typeof fetch, impl as unknown as typeof fetch);
      const tree = await provider.fetchInventory(config, SECRETS);
      return { tree, calls };
    }

    it("imports the node from a SECOND /cluster/status call joined by name — exactly two fetches, ssh endpoint at the entry's ip, running from online:1, and NO folderPath (kills an ssh endpoint invented from /cluster/resources node rows, which carry no ip, and a single-call implementation)", async () => {
      const { tree, calls } = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [statusEntry()] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      // Exactly TWO calls: the resources listing plus the node join. No guests,
      // so no address crawl can pad the count.
      expect(calls).toHaveLength(2);
      expect(calls[1]?.url).toBe(`${BASE}/api2/json/cluster/status`);
      expect(calls[1]?.auth).toBe("PVEAPIToken=root@pam!test=secret");
      expect(tree.devices).toEqual([
        {
          externalId: "node/pve",
          name: "pve",
          // toEqual reads an undefined folderPath as absent — "at targetFolder
          // root" either way; a RENDERED folder (the guest template's "pve")
          // would fail this equality.
          endpoints: [{ kind: "ssh", host: "192.0.2.240", port: 22 }],
          attributes: { type: ["node"], node: ["pve"], status: ["running"] }
        }
      ]);
    });

    it("maps online 0 to stopped WITH the endpoint still emitted — a stopped node still has a management IP — and omits the status attribute entirely when online is absent (kills an invented state, the same rule as a guest row's status 'unknown')", async () => {
      const stopped = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [statusEntry({ online: 0 })] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(stopped.tree.devices[0].attributes).toEqual({ type: ["node"], node: ["pve"], status: ["stopped"] });
      expect(stopped.tree.devices[0].endpoints).toEqual([{ kind: "ssh", host: "192.0.2.240", port: 22 }]);

      const noOnline = statusEntry();
      delete noOnline.online;
      const unknownState = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [noOnline] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(unknownState.tree.devices[0].attributes).toEqual({ type: ["node"], node: ["pve"] });
      expect(unknownState.tree.devices[0].endpoints).toEqual([{ kind: "ssh", host: "192.0.2.240", port: 22 }]);
    });

    it("emits a node /cluster/status knows nothing about — absent entry, a 403 without Sys.Audit, or a non-array payload — as addressless with no status, and the sync CONTINUES (kills a node fetch failure that aborts the whole sync)", async () => {
      const expectDegraded = async (statusRoute: { status?: number; body: unknown }): Promise<void> => {
        const { tree } = await syncNodes(
          { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: statusRoute },
          { baseUrl: BASE, includeNodes: true }
        );
        expect(tree.devices).toEqual([
          {
            externalId: "node/pve",
            name: "pve",
            endpoints: [],
            attributes: { type: ["node"], node: ["pve"] }
          }
        ]);
      };
      // Listed in status, but under another node's name — the join misses.
      await expectDegraded({ body: { data: [statusEntry({ name: "pve2", id: "node/pve2" })] } });
      // The token has the guest vocabulary only: Sys.Audit refused.
      await expectDegraded({ status: 403, body: "" });
      // Corruption reads as "no joins available", not as a protocol abort.
      await expectDegraded({ body: { data: {} } });
    });

    it("makes NO /cluster/status call and ignores node rows when includeNodes is absent, false, or a truthy STRING — exactly ONE fetch (kills an unconditional second request, a truthiness gate that a restored backup's \"true\" switches on, and a mapper that turns the nameless resources rows into devices)", async () => {
      for (const includeNodes of [undefined, false, "true"]) {
        const { tree, calls } = await syncNodes(
          { [RESOURCES]: { body: { data: [nodeRow()] } } },
          includeNodes === undefined ? { baseUrl: BASE } : { baseUrl: BASE, includeNodes }
        );
        expect(tree.devices).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(`${BASE}/api2/json/cluster/resources`);
      }
    });

    it("emits a node whose /cluster/status entry carries no ip — addressless, still present (kills dropping the node because its address could not be read)", async () => {
      const noIp = statusEntry();
      delete noIp.ip;
      const { tree } = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [noIp] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(tree.devices).toEqual([
        {
          externalId: "node/pve",
          name: "pve",
          endpoints: [],
          attributes: { type: ["node"], node: ["pve"], status: ["running"] }
        }
      ]);
    });

    it("never collides a node externalId with a vmid — 'node/pve' against guest '105' in one tree (trivial, but pins the prefix that keeps the two identities apart)", async () => {
      // The guest is STOPPED so the call count stays at the two listing calls.
      const guest = { vmid: 105, name: "clawdbot", node: "pve", type: "qemu", status: "stopped", template: 0 };
      const { tree, calls } = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow(), guest] } }, [STATUS]: { body: { data: [statusEntry()] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(calls).toHaveLength(2);
      expect(tree.devices.map((d) => d.externalId)).toEqual(["105", "node/pve"]);
      expect(tree.devices.map((d) => d.externalId)).not.toContain("pve");
    });

    it("counts node devices against the hard cap — 9,998 guests leave room for exactly two nodes, the dropped remainder sets truncated with ONE devices warning (kills a node branch that appends past the cap, and a second warning line when both loops trip)", async () => {
      // Stopped guests: no address crawl, so the call count stays at the two
      // listing calls and the only warning is the cap's.
      const guests = Array.from({ length: 9_998 }, (_, i) => ({
        vmid: i + 1,
        name: `guest-${i + 1}`,
        node: "pve",
        type: "qemu",
        status: "stopped",
        template: 0
      }));
      const nodeRows = [1, 2, 3, 4, 5].map((n) => nodeRow({ id: `node/n${n}`, node: `n${n}` }));
      const { tree, calls } = await syncNodes(
        {
          [RESOURCES]: { body: { data: [...nodeRows, ...guests] } },
          [STATUS]: { body: { data: nodeRows.map((r) => statusEntry({ name: r.node, id: r.id })) } }
        },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(calls).toHaveLength(2);
      expect(tree.devices).toHaveLength(10_000);
      // Guests first, then the two nodes that still fit under the cap.
      expect(tree.devices[9_997]?.externalId).toBe("9998");
      expect(tree.devices[9_998]?.externalId).toBe("node/n1");
      expect(tree.devices[9_999]?.externalId).toBe("node/n2");
      expect(tree.devices.some((d) => d.externalId === "node/n3")).toBe(false);
      expect(tree.truncated).toBe(true);
      expect(tree.warnings).toEqual(["Truncated at 10000 devices — narrow the source."]);
    });
  });

  // ---------------------------------------------------------------------------
  // LIVE STATUS (fetchStatus) — the poll path. ONE /cluster/resources call for
  // the guests (+ ONE /cluster/status only when includeNodes is on), no
  // per-guest fan-out, merge semantics on truncation. Fixtures reuse the
  // sanitized verified shapes from the sync tests above.
  // ---------------------------------------------------------------------------

  describe("fetchStatus", () => {
    const BASE = "https://pve.example.com:8006";
    const SECRETS = { apiToken: "root@pam!test=secret" };
    const RESOURCES = "/api2/json/cluster/resources";
    const STATUS = "/api2/json/cluster/status";

    const guestRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      vmid: 105,
      name: "clawdbot",
      node: "pve",
      type: "qemu",
      status: "running",
      template: 0,
      ...overrides
    });

    /** The verified /cluster/resources node row — its "online" is a STRING no status may ever be read from. */
    const nodeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "node/pve",
      node: "pve",
      type: "node",
      status: "online",
      ...overrides
    });

    /** The verified /cluster/status node entry — the ONLY source of a node's numeric `online`. */
    const statusEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      type: "node",
      name: "pve",
      nodeid: 0,
      online: 1,
      ip: "192.0.2.240",
      id: "node/pve",
      ...overrides
    });

    type RouteMap = Record<string, { status?: number; body: unknown }>;

    /** Poll a routed world; unrouted paths answer 500 so an unexpected request shows in the call log. */
    async function pollStatus(routes: RouteMap, config: InventorySourceValues) {
      const calls: string[] = [];
      const impl = async (input: string | URL): Promise<unknown> => {
        const url = String(input);
        calls.push(url);
        const hit = routes[new URL(url).pathname];
        if (!hit) {
          return makeResponse(500, { data: null, message: `no test route for ${new URL(url).pathname}` });
        }
        return makeResponse(hit.status ?? 200, hit.body);
      };
      const provider = createProxmoxProvider(impl as unknown as typeof fetch, impl as unknown as typeof fetch);
      const report = (await provider.fetchStatus?.(config, SECRETS))!;
      return { report, calls };
    }

    it("answers the guest poll with exactly ONE HTTP call when includeNodes is off — no per-guest address crawl on the status path (the provider's efficiency headline: every state the poll needs sits on the listing rows, and a crawl over a hundred running guests would turn a visible-panel poll into the sync's fan-out)", async () => {
      const { report, calls } = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow(), guestRow({ vmid: 106, name: "second" })] } } },
        { baseUrl: BASE }
      );
      expect(calls).toEqual([`${BASE}/api2/json/cluster/resources`]);
      expect(report.contractVersion).toBe(1);
    });

    it("keys guest statuses by the BARE vmid externalId — running/stopped map through, status 'unknown' rows are OMITTED, and no entry ever carries console fields (kills an invented mapping for unknown rows, a `${type}/${vmid}` key the apply cannot resolve, and console fields the listing rows never carried; the omission's price is stated honestly below — a COMPLETE report is applied clear-then-apply, so the omitted guest's decoration drops until a poll reports it again)", async () => {
      const { report } = await pollStatus(
        {
          [RESOURCES]: {
            body: {
              data: [
                guestRow(),
                guestRow({ vmid: 114, name: "dns", type: "lxc", status: "stopped" }),
                guestRow({ vmid: 116, name: "fresh", status: "unknown" })
              ]
            }
          }
        },
        { baseUrl: BASE }
      );
      // Exact shape: "116" absent — on a COMPLETE report the apply is
      // clear-then-apply, so the omitted unknown row's prior decoration is
      // DROPPED until a poll reports it again (the honest price of a state
      // nobody knows) — and no consoleHost/consolePort anywhere; toEqual
      // fails on either.
      expect(report.statuses).toEqual({ "105": { state: "running" }, "114": { state: "stopped" } });
      // Valid per the REAL downstream gate, which rejects any report carrying
      // a present-but-non-boolean `truncated` key — pins the key's omission
      // on a complete report.
      expect(validateInventoryStatusReport(report)).toBeDefined();
    });

    it("joins node statuses from a SECOND /cluster/status call only when includeNodes is set — online 1/0 become running/stopped — and without it neither the call nor any node status exists (kills a node-status path that invents state from the resources payload's 'online' string or fires the request uninvited)", async () => {
      const withNodes = await pollStatus(
        {
          [RESOURCES]: { body: { data: [guestRow(), nodeRow()] } },
          [STATUS]: {
            body: { data: [statusEntry(), statusEntry({ name: "pve2", id: "node/pve2", nodeid: 1, online: 0 })] }
          }
        },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(withNodes.calls).toHaveLength(2);
      expect(withNodes.calls[1]).toBe(`${BASE}/api2/json/cluster/status`);
      expect(withNodes.report.statuses).toEqual({
        "105": { state: "running" },
        "node/pve": { state: "running" },
        "node/pve2": { state: "stopped" }
      });

      // The SAME resources payload carries the node row with its "online"
      // STRING — which must invent no status and must not trigger the join.
      const withoutNodes = await pollStatus({ [RESOURCES]: { body: { data: [guestRow(), nodeRow()] } } }, { baseUrl: BASE });
      expect(withoutNodes.calls).toHaveLength(1);
      expect(withoutNodes.report.statuses).toEqual({ "105": { state: "running" } });
    });

    it("marks the report PARTIAL when the /cluster/status join fails — truncated: true with the guest statuses still present, so the apply MERGES (guest updates applied, nodes' prior decorations retained) instead of a complete report's clear-then-apply dropping every node highlight over one failed Sys.Audit (kills a complete-without-nodes report)", async () => {
      const { report, calls } = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow(), nodeRow()] } }, [STATUS]: { status: 403, body: "" } },
        { baseUrl: BASE, includeNodes: true }
      );
      // Both requests were attempted — the join failure is not a skipped call.
      expect(calls).toHaveLength(2);
      expect(calls[1]).toBe(`${BASE}/api2/json/cluster/status`);
      // The guests the poll DID reach are still applied...
      expect(report.statuses).toEqual({ "105": { state: "running" } });
      // ...but the report is partial, so merge retains the nodes' prior state.
      expect(report.truncated).toBe(true);
    });

    it("applies the sync's guest filters to the status set — template rows are dropped and, with includeStopped off, stopped rows too — so a device the sync never created gets no status either (the apply would ignore it, but the provider stays consistent with its own device set)", async () => {
      const templates = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow({ template: 1, name: "gold-image" }), guestRow()] } } },
        { baseUrl: BASE }
      );
      expect(templates.report.statuses).toEqual({ "105": { state: "running" } });

      const stoppedOff = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow({ status: "stopped" }), guestRow({ vmid: 106, name: "up" })] } } },
        { baseUrl: BASE, includeStopped: false }
      );
      expect(stoppedOff.report.statuses).toEqual({ "106": { state: "running" } });
    });

    it("stops collecting at the hard cap and flags truncated — a partial report MERGES on apply (prior state retained for the entries never reached), never clears (kills an uncapped report whose apply would clear-then-set over a cluster the poll never finished reading)", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}` }));
      const { report, calls } = await pollStatus({ [RESOURCES]: { body: { data: rows } } }, { baseUrl: BASE });
      expect(Object.keys(report.statuses)).toHaveLength(10_000);
      expect(report.truncated).toBe(true);
      // The cap needs no fan-out — the poll stays ONE call even at 10k guests.
      expect(calls).toHaveLength(1);
    });

    it("fails closed on a mangled payload — the poll THROWS instead of answering, because a complete report is applied clear-then-apply and an empty-but-valid one would DELETE every live-state decoration the source has until the next healthy poll (kills an empty-report degrade, which hands the apply a legitimate-looking 'nothing to report' answer built from one mangled 200 body)", async () => {
      for (const body of ["<html>gateway error</html>", "not json", "", { data: {} }, { data: null }]) {
        const fetchImpl = vi.fn(async () => makeResponse(200, body));
        const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch, fetchImpl as unknown as typeof fetch);
        const err = await provider.fetchStatus!({ baseUrl: BASE }, SECRETS).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InventoryProviderError);
        expect((err as InventoryProviderError).kind).toBe("protocol");
      }
    });
  });
});
