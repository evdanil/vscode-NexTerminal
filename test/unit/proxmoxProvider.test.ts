import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOLDER_TEMPLATE,
  PROXMOX_HARD_CAP_FIELD_ID,
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
  readProxmoxHardCap,
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
  it("collapses every spelling of ONE deployment onto ONE key — trailing slashes, host case, and whitespace (kills a raw-string key, which fragments one instance into five and refuses the re-add it is supposed to allow)", () => {
    const canonical = "https://pve.example.com";
    for (const spelling of [
      "https://pve.example.com",
      "https://pve.example.com/",
      "https://pve.example.com///",
      "https://PVE.Example.COM",
      "  https://pve.example.com  ",
      "https://pve.example.com?foo=bar",
      "https://pve.example.com#frag"
    ]) {
      expect(proxmoxInstanceKey({ baseUrl: spelling })).toBe(canonical);
    }
    // The netbox collapse list included `/api` spellings; on PVE a `/api`
    // suffix is a legitimate mount prefix and names a DIFFERENT deployment —
    // pinned by the mount-prefix tests below, not folded away here.
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
    // A `/api` mount prefix SURVIVES into the key — unlike netbox, whose strip
    // this normalizer deliberately dropped (see normalizeBaseUrl): PVE's API
    // root is /api2/json, so `/api` is a reverse-proxy path, not the API root.
    expect(provider.instanceKey?.({ baseUrl: "https://pve.example.com:8006/api/" })).toBe("https://pve.example.com:8006/api");
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
      "2001:db8::1%eth0", // scoped — not a usable host address
      "1:2:3:4:5:6:7:8:9", // nine groups — colon-shaped garbage the whitelist admitted (kills the character-whitelist IPv6 check)
      "abcd:", // trailing empty group
      "::ffff:999.999.999.999", // malformed embedded dotted quad
      "2001:db8:::1" // triple colon
    ]) {
      expect(isGlobalAddress(addr)).toBe(false);
    }
    // Compressed and IPv4-mapped literals are real guests' shapes and must
    // survive the syntax check (kills an over-strict parser that only knows
    // one spelling).
    for (const addr of ["2001:db8::", "0:0:0:0:0:ffff:192.0.2.7", "::ffff:192.0.2.7", "::ffff:192.0.2.7/128"]) {
      expect(isGlobalAddress(addr)).toBe(true);
    }
  });

  it("isGlobalAddress — applies the range exclusions to the CANONICAL IPv6 literal, so expanded, IPv4-mapped and IPv4-compatible spellings of excluded ranges are refused (kills literal-string comparisons that recognized one spelling only — net.isIPv6 accepts `0:0:0:0:0:0:0:1` but the `=== \"::1\"` check never saw it)", () => {
    for (const addr of [
      "0:0:0:0:0:0:0:1", // expanded loopback — canonicalizes to ::1
      "0:0:0:0:0:0:0:0", // expanded unspecified — canonicalizes to ::
      "::ffff:127.0.0.1", // IPv4-mapped loopback ⇒ canonical ::ffff:7f00:1
      "::7f00:1", // IPv4-compatible loopback (::/96 — deprecated but real)
      "::ffff:169.254.9.9", // mapped link-local 169.254/16
      "::ffff:224.0.0.1" // mapped multicast-range v4 (≥224)
    ]) {
      expect(isGlobalAddress(addr)).toBe(false);
    }
    // The plain-global mapped form stays usable: the embedded octets are a
    // documentation-range host, so the mapped spelling must not be excluded
    // with the special ranges.
    expect(isGlobalAddress("::ffff:192.0.2.7")).toBe(true);
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

describe("readProxmoxHardCap", () => {
  it("resolves 10,000 when the field is absent and clamps/floors every other value into [100, 1_000_000] — the poll reader's discipline applied to the cap (kills a raw `config.hardCap` read, under which a hand-edited backup carrying 0, -1 or NaN empties every sync's device set and every status report)", () => {
    const config = (v: unknown): Record<string, unknown> => ({ baseUrl: "https://pve.example.com:8006", [PROXMOX_HARD_CAP_FIELD_ID]: v });
    expect(PROXMOX_HARD_CAP_FIELD_ID).toBe("hardCap");
    expect(readProxmoxHardCap(config(500) as never)).toBe(500);
    expect(readProxmoxHardCap(config(50) as never)).toBe(100);
    expect(readProxmoxHardCap(config(0) as never)).toBe(100);
    expect(readProxmoxHardCap(config(-5) as never)).toBe(100);
    expect(readProxmoxHardCap(config(999_999_999) as never)).toBe(1_000_000);
    expect(readProxmoxHardCap(config(500.9) as never)).toBe(500);
    // The ABSENT case (every source that predates the field) and a numeric
    // STRING (which the form never stores, but a restored backup can carry)
    // both land on the default — never on the minimum, which would silently
    // shrink an existing source's cap by two orders of magnitude.
    expect(readProxmoxHardCap(config(undefined) as never)).toBe(10_000);
    expect(readProxmoxHardCap(config("500") as never)).toBe(10_000);
    expect(readProxmoxHardCap(config(Number.NaN) as never)).toBe(10_000);
    expect(readProxmoxHardCap({} as never)).toBe(10_000);
  });
});

describe("createProxmoxProvider", () => {
  it("passes validateProviderShape — the same gate the registry applies at registration (⊘ a provider that only compiles still cannot be registered)", () => {
    expect(() => validateProviderShape(createProxmoxProvider())).not.toThrow();
  });

  it("declares canControlNode — bare vmids only, so a cluster node's node/<name> externalId is refused by the menu gate exactly where controlNodeImpl refuses it on the wire (⊘ a device-blind gate offers Start/Stop on a hypervisor node, an action the provider's own controlNode always fails)", () => {
    const provider = createProxmoxProvider();
    expect(provider.canControlNode?.("105")).toBe(true);
    expect(provider.canControlNode?.("node/pve")).toBe(false);
  });

  it("declares canWebConsole — guests only, so a cluster node's node/<name> externalId carries no web-console marker (⊘ a device-blind gate offers Open Web Console on a hypervisor node, whose shell is not a guest's noVNC console and which webConsoleUrl always refuses)", () => {
    const provider = createProxmoxProvider();
    expect(provider.canWebConsole?.("105")).toBe(true);
    expect(provider.canWebConsole?.("node/pve")).toBe(false);
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
      "statusPollSeconds",
      "hardCap"
    ]);
    expect(provider.configFields.find((f) => f.id === "apiToken")?.type).toBe("password");
    expect(provider.configFields.find((f) => f.id === "baseUrl")?.placeholder).toBe("https://pve.example.com:8006");
    expect(provider.configFields.find((f) => f.id === "folderTemplate")?.placeholder).toBe(DEFAULT_FOLDER_TEMPLATE);
    // LABELS are hashed too, and this test's own title says so — leaving them
    // unpinned let a label revert pass the suite while the CHANGELOG, the
    // README and the docs all asserted the new one AND the one-time credential
    // re-confirmation it costs. Same for the two field strings this release
    // rewrote, which the walkthrough quotes.
    const byId = (id: string) => provider.configFields.find((f) => f.id === id)!;
    expect(byId("statusPollSeconds").label).toBe("Status Poll Interval (seconds)");
    expect(byId("hardCap").label).toBe("Hard Cap (entries)");
    // The token field asks for PVE's ONE-LINE credential: the placeholder is a
    // whole `<user@realm>!<tokenid>=<secret>` specimen, and the description
    // spells the form out.
    expect(byId("apiToken").placeholder).toMatch(/^[^!=]+![^!=]+=.+$/);
    expect(byId("apiToken").description).toContain("<user@realm>!<tokenid>=<secret>");
    // The base-url field names the port a PVE cluster actually answers on.
    expect(byId("baseUrl").description).toContain("8006");
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

  it("declares hardCap as an advanced integer number field bounded [100, 1_000_000] with NO defaultValue, and its description names BOTH budgets it bounds (kills a defaultValue, which stamps the number onto every saved source and pins it there forever; and a description that names only devices, under which nobody raising it for a large cluster learns it also bounds the status report)", () => {
    const field = createProxmoxProvider().configFields.find((f) => f.id === "hardCap")!;
    expect(field.label).toBe("Hard Cap (entries)");
    expect(field.type).toBe("number");
    expect(field.advanced).toBe(true);
    expect(field.integer).toBe(true);
    expect(field.min).toBe(100);
    expect(field.max).toBe(1_000_000);
    expect(field.required).toBe(false);
    expect(field.defaultValue).toBeUndefined();
    expect(field.description).toContain("10,000");
    expect(field.description).toContain("status");
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

    it("keeps a base URL's /api MOUNT PREFIX — the request goes under it, not at the origin (kills the netbox-style /api-suffix strip copied into normalizeBaseUrl, which rewrote https://gateway.example/api onto the origin so Test Connection and sync could never reach a deployment mounted there — PVE's API root is /api2/json, so a trailing /api is a legitimate reverse-proxy path, not the API root)", async () => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(String(url));
        return makeResponse(200, { data: { version: "9.2.11", release: "9.2" } });
      });
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.testConnection({ baseUrl: "https://gateway.example/api" }, SECRETS)).resolves.toBeUndefined();
      expect(calls).toEqual(["https://gateway.example/api/api2/json/version"]);
    });

    it("strips pasted URL STATE — a web-UI fragment or query must not absorb the appended API path (kills a string-trimming normalizer under which https://pve:8006/#v1:0:=qemu/100 sent every request to `/`, since the appended /api2/json/version landed INSIDE the fragment)", async () => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(String(url));
        return makeResponse(200, { data: { version: "9.2.11", release: "9.2" } });
      });
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch);

      await expect(provider.testConnection({ baseUrl: "https://pve:8006/#v1:0:=qemu/100" }, SECRETS)).resolves.toBeUndefined();
      await expect(provider.testConnection({ baseUrl: "https://pve:8006/?x=1#/y" }, SECRETS)).resolves.toBeUndefined();
      await expect(provider.testConnection({ baseUrl: "https://gw.example/pve/?x=1" }, SECRETS)).resolves.toBeUndefined();
      await expect(provider.testConnection({ baseUrl: "https://user:s3cr3t@pve:8006" }, SECRETS)).resolves.toBeUndefined();
      expect(calls).toEqual([
        "https://pve:8006/api2/json/version",
        "https://pve:8006/api2/json/version",
        "https://gw.example/pve/api2/json/version",
        // PVE authenticates with the API-token header; pasted basic-auth must
        // not silently become the transport credential.
        "https://pve:8006/api2/json/version"
      ]);
      // ...and the persisted identity collapses the fragment spellings onto
      // the same deployment, so a re-add after re-pasting without the fragment
      // is still offered its adopted servers.
      const provider2 = createProxmoxProvider(vi.fn() as unknown as typeof fetch);
      expect(provider2.instanceKey?.({ baseUrl: "https://pve:8006/#v1:0:=qemu/100" })).toBe(
        provider2.instanceKey?.({ baseUrl: "https://pve:8006" })
      );
      expect(calls.join("\n")).not.toContain("s3cr3t");
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

    // THE SYNC'S STATUS REPORT — the listing IS the status fetch: every row
    // the sync already read carries its running/stopped state, so the tree
    // carries a FULL report unconditionally and a sync alone refreshes running
    // state exactly as an EVE-NG sync does. The mapping rules are the poll's
    // (fetchStatusImpl): shape-valid guests report running/stopped REGARDLESS
    // of includeStopped (status reports reality; the apply ignores ids
    // matching no device), template rows and "unknown" guests are never
    // reported and ride clearedExternalIds instead, and `truncated` marks a
    // PARTIAL collection only — a complete report is applied clear-then-apply,
    // which is exactly what drops a vanished guest's decoration. The engine
    // side (validate + apply through syncNow, degraded not thrown, applied
    // post-commit and incarnation-guarded) is generic machinery with no
    // provider-specific branch, pinned in nexusCoreInventory.test.ts.
    it("attaches the FULL status report to every tree — every guest's state rides the sync, template and unknown vmids ride clearedExternalIds, and a complete listing sets NO truncated (kills a sync that discards the states it just read, leaving every guest's Start/Stop menu hidden after a first sync until an unprompted palette command)", async () => {
      const { tree } = await syncRows([
        guestRow(),
        guestRow({ vmid: 106, name: "gold-image", template: 1 }),
        guestRow({ vmid: 114, name: "dns", type: "lxc", status: "stopped" }),
        guestRow({ vmid: 118, name: "hatchling", status: "unknown" })
      ]);
      expect(tree.status).toEqual({
        contractVersion: 1,
        statuses: {
          "105": { state: "running" },
          "114": { state: "stopped" }
        },
        clearedExternalIds: ["106", "118"],
        // The template's clear carries its explanation; the "unknown" row's
        // does not (pinned on its own below).
        notSyncableReasons: { "106": "it is now a template" }
      });
      // Complete listing ⇒ clear-then-apply is correct (it drops decorations
      // for guests that vanished), so the flag must be ABSENT, not false —
      // the validator tolerates a present-undefined key but the poll's
      // omission idiom is the shape to hold.
      expect(Object.prototype.hasOwnProperty.call(tree.status, "truncated")).toBe(false);
      // The device-set opt-in governs nothing here: with includeTemplates OFF
      // the template is still OBSERVED (and the pre-conversion server more
      // likely to still exist), so the clear rides all the same.
      const excluded = await syncRows([guestRow({ template: 1, name: "gold-image" })]);
      expect(excluded.tree.status).toEqual({
        contractVersion: 1,
        statuses: {},
        clearedExternalIds: ["105"],
        notSyncableReasons: { "105": "it is now a template" }
      });
      expect(excluded.tree.devices).toEqual([]);
    });

    it("reports stopped guests even when includeStopped keeps them out of the DEVICE set — status reports reality, the sync's device-set preference does not gate it (kills a report that mirrors includeStopped, under which a guest synced while running and then stopped keeps its stale running decoration — Start/Stop menu included — until a separate refresh)", async () => {
      const { tree } = await syncRows([guestRow({ status: "stopped" }), guestRow({ vmid: 106, name: "up" })], {
        baseUrl: BASE,
        includeStopped: false
      });
      expect(tree.devices.map((d) => d.name)).toEqual(["up"]);
      expect(tree.status?.statuses).toEqual({ "105": { state: "stopped" }, "106": { state: "running" } });
    });

    it("flags the report truncated when the row cap tripped — beyond-cap guests are absent and the MERGE must protect them (kills a complete report over a capped listing, whose clear-then-apply would drop every beyond-cap guest's decoration the sync never collected)", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree } = await syncRows(rows);
      expect(tree.truncated).toBe(true);
      expect(tree.status?.truncated).toBe(true);
      expect(Object.keys(tree.status?.statuses ?? {})).toHaveLength(10_000);
      expect(tree.status?.statuses["10001"]).toBeUndefined();
    });

    it("flags the report truncated when the REPORT's own cap trips even though the device set stayed empty — includeStopped off holds the tree at zero devices while 10,001 stopped guests overflow the statuses budget (kills a report flag driven by the tree's cap alone, under which the beyond-cap guests' decorations are wiped by a clear-then-apply over a report that never collected them)", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree } = await syncRows(rows, { baseUrl: BASE, includeStopped: false });
      expect(tree.devices).toEqual([]);
      expect(tree.truncated).toBeUndefined();
      expect(tree.status?.truncated).toBe(true);
      expect(Object.keys(tree.status?.statuses ?? {})).toHaveLength(10_000);
    });

    it("WARNS on the tree when the report's own cap trips without the tree's — syncNow shows tree warnings but never warns about a status report's own truncation, so a status-only cap would retain stale states (and Start/Stop menus) with nothing on screen saying the collection was partial (kills a silent status-only cap)", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree } = await syncRows(rows, { baseUrl: BASE, includeStopped: false });
      expect(tree.truncated).toBeUndefined();
      expect(tree.warnings?.some((w) => w.includes("status entries") && w.includes("than the budget covers"))).toBe(true);
      // ...and the two caps are independent: when the ROW cap trips, the
      // status-collection warning must NOT also fire (the device warning
      // channel stays honest about WHICH collection was partial). Stopped
      // rows keep the IP crawl out of this scenario.
      const rowsTree = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree: tree2 } = await syncRows(rowsTree);
      expect(tree2.truncated).toBe(true);
      expect(tree2.warnings?.some((w) => w.includes("Status collection stopped"))).toBe(false);
    }, 20_000);

    it("budgets the sync's STATUS collection by the CONFIGURED hardCap and names it in the warning — 501 stopped guests with Include Stopped off collect 500 states (kills a status budget still pinned to the constant while the device cap honours the field, which would make one source obey two different caps)", async () => {
      const rows = Array.from({ length: 501 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree } = await syncRows(rows, { baseUrl: BASE, includeStopped: false, hardCap: 500 });
      expect(tree.devices).toEqual([]);
      expect(Object.keys(tree.status?.statuses ?? {})).toHaveLength(500);
      expect(tree.status?.truncated).toBe(true);
      expect(tree.warnings?.some((w) => w.includes("stopped at 500 entries"))).toBe(true);
    });

    it("clears a guest whose row reads status 'unknown' on the sync path too — omitted from statuses, vmid in clearedExternalIds, the same observed-but-stateless class the poll clears, even when includeStopped keeps the row out of the device set (kills a sync-side clear list that covers only templates)", async () => {
      const { tree } = await syncRows([guestRow({ vmid: 118, status: "unknown" })]);
      expect(tree.status).toEqual({
        contractVersion: 1,
        statuses: {},
        clearedExternalIds: ["118"]
      });
      const gated = await syncRows([guestRow({ vmid: 118, status: "unknown" })], {
        baseUrl: BASE,
        includeStopped: false
      });
      expect(gated.tree.devices).toEqual([]);
      expect(gated.tree.status).toEqual({
        contractVersion: 1,
        statuses: {},
        clearedExternalIds: ["118"],
        // The clear is unchanged by the opt-in; the REASON rides only here,
        // because only here is the row excluded and its server prunable (pinned
        // in its own right below).
        notSyncableReasons: { "118": "Proxmox does not report it as running and Include Stopped Guests is off" }
      });
    });

    // THE PRUNE REASON — a guest converted to a template is still THERE, and
    // the sync's clear alone cannot say so: the orphan/delete popup reads
    // identically for a guest that was deleted. `notSyncableReasons` is the
    // sentence fragment that tells the two apart.
    it("names the REASON a template row no longer syncs and records NONE for an observed 'unknown' row — the vmid rides `notSyncableReasons` beside its clear, while a pre-RRD guest gets no entry (kills a popup that cannot tell a converted guest from a deleted one, and kills calling a guest PVE simply cannot describe yet 'not syncable')", async () => {
      const { tree } = await syncRows([
        guestRow(),
        guestRow({ vmid: 106, name: "gold-image", template: 1 }),
        guestRow({ vmid: 118, name: "hatchling", status: "unknown" })
      ]);
      // BOTH still clear — the reason explains one of them, it does not gate
      // the clear (the two members answer different questions).
      expect(tree.status?.clearedExternalIds).toEqual(["106", "118"]);
      expect(tree.status?.notSyncableReasons).toEqual({ "106": "it is now a template" });
      // The REAL downstream gate accepts the new member.
      expect(validateInventoryStatusReport(tree.status)).toBeDefined();
      // Nothing to explain ⇒ the field is absent, the report's omission idiom.
      const plain = await syncRows([guestRow()]);
      expect(Object.prototype.hasOwnProperty.call(plain.tree.status!, "notSyncableReasons")).toBe(false);
    });

    it("names the STOPPED gate, not templates, when templates ARE included — a template's PVE status is 'stopped', so with includeStopped off it is excluded for being stopped (kills a reason that blames the one opt-in the user switched ON)", async () => {
      const { tree } = await syncRows([guestRow({ vmid: 106, name: "gold-image", template: 1, status: "stopped" })], {
        baseUrl: BASE,
        includeTemplates: true,
        includeStopped: false
      });
      // The row IS excluded — by `isImportableGuestRow`'s stopped gate, which
      // the template opt-in does not reach — so its server is prunable and the
      // reason attached here IS rendered in the confirmation popup.
      expect(tree.devices).toEqual([]);
      // The clear still rides: a template has no running/stopped state to show,
      // whichever opt-in excluded it.
      expect(tree.status?.clearedExternalIds).toEqual(["106"]);
      expect(tree.status?.notSyncableReasons).toEqual({ "106": "it is stopped and Include Stopped Guests is off" });
    });

    // THE STOPPED GATE'S OWN REASON — the twin of the template reason above,
    // for the far more ordinary event: a guest is powered off (or the user
    // turns Include Stopped Guests off) and its server drops out of the device
    // set. It is still on the cluster, so the prune line owes the same
    // disclosure the conversion case gets.
    it("names the reason a NON-RUNNING guest stopped syncing, per PVE status — 'stopped' says stopped, an 'unknown' row says only that PVE does not report it running, and the template gate still wins where IT is what excluded the row (kills one fragment for both states, which would call a pre-RRD guest stopped, and a stopped reason that outranks the template one)", async () => {
      const { tree } = await syncRows(
        [
          guestRow(),
          guestRow({ vmid: 106, name: "gold-image", template: 1 }),
          guestRow({ vmid: 114, name: "dns", type: "lxc", status: "stopped" }),
          guestRow({ vmid: 118, name: "hatchling", status: "unknown" })
        ],
        { baseUrl: BASE, includeStopped: false }
      );
      // Only the running guest survives the gate.
      expect(tree.devices.map((d) => d.externalId)).toEqual(["105"]);
      expect(tree.status?.notSyncableReasons).toEqual({
        // Excluded by the TEMPLATE gate — it is tested first and rejects the
        // row before the stopped clause is reached, so template-ness is what
        // actually excluded it and the reason must say so.
        "106": "it is now a template",
        "114": "it is stopped and Include Stopped Guests is off",
        // PVE emits "unknown" before RRD data exists — the guest may well be
        // running, so the fragment must claim only what was observed.
        "118": "Proxmox does not report it as running and Include Stopped Guests is off"
      });
      // Every entry is exactly one fragment — the two branches cannot both
      // write for one vmid.
      expect(validateInventoryStatusReport(tree.status)).toBeDefined();
    });

    it("attaches NO gate reason while Include Stopped Guests is ON — a stopped or pre-RRD guest is synced then, so there is nothing to explain (kills a reason recorded for rows the gate never rejected, which would decorate a prune caused by something else entirely)", async () => {
      const { tree } = await syncRows([
        guestRow({ vmid: 114, name: "dns", status: "stopped" }),
        guestRow({ vmid: 118, name: "hatchling", status: "unknown" })
      ]);
      expect(tree.devices.map((d) => d.externalId)).toEqual(["114", "118"]);
      expect(Object.prototype.hasOwnProperty.call(tree.status!, "notSyncableReasons")).toBe(false);
    });

    it("attaches the report even when there is nothing to say — an empty cluster yields an empty statuses object, no cleared list, no truncated (kills a conditional attach, which would reopen the gap the report closed: the ordinary sync must never leave tree.status unfilled)", async () => {
      const empty = await syncRows([]);
      expect(empty.tree.status).toEqual({ contractVersion: 1, statuses: {} });
      const ordinary = await syncRows([guestRow()]);
      expect(ordinary.tree.status).toEqual({ contractVersion: 1, statuses: { "105": { state: "running" } } });
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

    it("caps the device set at a CONFIGURED hardCap and names it in the warning — 501 rows under hardCap 500 yield 500 devices (kills a runtime read of the module constant, under which the field is saved, shown in the form, and ignored)", async () => {
      const rows = Array.from({ length: 501 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree } = await syncRows(rows, { baseUrl: BASE, hardCap: 500 });
      expect(tree.devices).toHaveLength(500);
      expect(tree.truncated).toBe(true);
      expect(tree.warnings).toContain("Truncated at 500 devices — narrow the source.");
    });

    it("clamps a below-minimum hardCap at the RUNTIME site, not only in the reader — hardCap 50 still admits 100 devices (kills a site that reads `config.hardCap` directly, under which a hand-edited 1 turns a whole cluster into one device and a prune-suppressing truncation)", async () => {
      const rows = Array.from({ length: 101 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}`, status: "stopped" }));
      const { tree } = await syncRows(rows, { baseUrl: BASE, hardCap: 50 });
      expect(tree.devices).toHaveLength(100);
      expect(tree.warnings).toContain("Truncated at 100 devices — narrow the source.");
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

    it("caps the address crawl at MAX_IP_GUESTS — guests beyond the cap stay ADDRESSLESS but EMITTED, the tree is NOT truncated, and a warning names the cap (kills an unbounded per-guest crawl that would pin a big cluster for minutes, and a budget trip that read as an incomplete device listing and froze pruning on every sync of a large cluster)", async () => {
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
      // The device listing itself is complete — only the address crawl stopped
      // — so the tree must NOT claim truncation: that would skip pruning on
      // every sync of a cluster over the crawl budget, keeping removed guests
      // forever.
      expect(tree.truncated).toBeUndefined();
      expect(tree.warnings).toContain(
        "Address crawl stopped at 1000 guests — the remaining guests arrived without addresses and will pick them up on a later sync."
      );
    });

    it("trips the shared crawl deadline — the next guest makes no fetch, the tree stays UNtruncated and a deadline warning names the budget (kills an unbounded crawl against a slow cluster; the clock seam is a Date.now spy advanced by the fetch, the same idiom EVE-NG's deadline tests use)", async () => {
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
        expect(tree.truncated).toBeUndefined();
        expect(tree.warnings).toContain(
          "Address crawl stopped after 120s — the remaining guests arrived without addresses and will pick them up on a later sync."
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

    it("composes truncation — a payload over the row cap whose guests then exhaust the IP cap keeps `truncated` from the ROW cap alone (device rows were omitted) and pushes both warnings (kills an IP-cap flag that overwrote the row-cap flag, and a row cap that loses its flag when the crawl also stops short)", async () => {
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
      expect(tree.warnings).toContain(
        "Address crawl stopped at 1000 guests — the remaining guests arrived without addresses and will pick them up on a later sync."
      );
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

    // THE SYNC'S NODE STATUSES — the same gate the poll uses (`=== true`), the
    // same source (the /cluster/status join's numeric `online`), the same
    // omit-only rule for an entry whose `online` is absent or unrecognizable:
    // a node entry is not an observed guest row, so it is omitted, never
    // cleared.
    it("reports node statuses onto the sync's own status report when includeNodes is on — online 1/0 become running/stopped, an unrecognizable entry invents nothing, and with the gate off no node status exists (kills a sync report that covers guests only while the poll reports nodes, and one that reads the resources row's degraded 'online' string)", async () => {
      const on = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [statusEntry()] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(on.tree.status?.statuses).toEqual({ "node/pve": { state: "running" } });

      const stopped = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [statusEntry({ online: 0 })] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(stopped.tree.status?.statuses).toEqual({ "node/pve": { state: "stopped" } });

      const noOnline = statusEntry();
      delete noOnline.online;
      const unrecognizable = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [noOnline] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(unrecognizable.tree.status?.statuses).toEqual({});

      const off = await syncNodes({ [RESOURCES]: { body: { data: [nodeRow()] } } }, { baseUrl: BASE });
      expect(off.tree.status?.statuses).toEqual({});
      expect(off.calls.every(({ url }) => !url.includes("/cluster/status"))).toBe(true);
    });

    it("flags the sync's report truncated when the node join fails — the guests reported, the nodes unreached, so the apply must MERGE instead of wiping every node's decoration (the poll's controller ruling, reused verbatim: a complete report is clear-then-apply, and this listing did not reach the nodes)", async () => {
      const { tree } = await syncNodes(
        {
          [RESOURCES]: {
            body: { data: [nodeRow(), { vmid: 105, name: "clawdbot", node: "pve", type: "qemu", status: "running", template: 0 }] }
          },
          [STATUS]: { status: 403, body: "" }
        },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(tree.status?.statuses).toEqual({ "105": { state: "running" } });
      expect(tree.status?.truncated).toBe(true);
    });

    it("WARNS on the tree when the node join fails — the sync plan is the ONLY surface that can say a report was partial, and a token without Sys.Audit is the EXPECTED answer, not an exotic one (kills a silent join failure, under which imported nodes arrive addressless and every node's stale running dot stands indefinitely with nothing on screen)", async () => {
      const { tree } = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { status: 403, body: "" } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(tree.status?.truncated).toBe(true);
      const warning = tree.warnings?.find((w) => w.includes("Cluster node status")) ?? "";
      expect(warning).toContain("Sys.Audit");
      expect(warning).toContain("last known running state");
      expect(warning).not.toContain("Refresh Lab Status");
      // A healthy join pushes no such line — the warning names a real failure,
      // never a routine sync.
      const ok = await syncNodes(
        { [RESOURCES]: { body: { data: [nodeRow()] } }, [STATUS]: { body: { data: [statusEntry()] } } },
        { baseUrl: BASE, includeNodes: true }
      );
      expect(ok.tree.warnings?.some((w) => w.includes("Cluster node status"))).toBe(false);
      // …and neither does a sync with node import OFF, which never makes the
      // call at all.
      const off = await syncNodes({ [RESOURCES]: { body: { data: [nodeRow()] } } }, { baseUrl: BASE });
      expect(off.tree.warnings?.some((w) => w.includes("Cluster node status"))).toBe(false);
    });

    // THE STATUS-CAP WARNING WITH NODES IN THE BUDGET — node states and guest
    // states share ONE entry budget, so the entry a cap trip omits may be a
    // NODE. The warning is the only surface the user sees for this, and it
    // must not name a guest when it cannot know that it was one.
    it("names STATUS ENTRIES, not guests, when the entry budget runs out with node states in it — the omitted entry here is a node (kills the guest-only wording, which tells a user with two nodes and Include Stopped off that the cluster lists more than the cap in GUESTS and that a GUEST kept a stale state, when neither is true)", async () => {
      const guests = Array.from({ length: 100 }, (_, i) => ({
        vmid: i + 1,
        name: `guest-${i + 1}`,
        node: "pve",
        type: "qemu",
        status: "stopped",
        template: 0
      }));
      const { tree } = await syncNodes(
        {
          [RESOURCES]: { body: { data: [...guests, nodeRow(), nodeRow({ id: "node/pve2", node: "pve2" })] } },
          [STATUS]: { body: { data: [statusEntry(), statusEntry({ name: "pve2", id: "node/pve2", nodeid: 1 })] } }
        },
        { baseUrl: BASE, includeNodes: true, includeStopped: false, hardCap: 100 }
      );
      // The DEVICE cap never trips: Include Stopped is off, so the only
      // devices are the two nodes.
      expect(tree.devices.map((d) => d.externalId)).toEqual(["node/pve", "node/pve2"]);
      expect(tree.truncated).toBeUndefined();
      // The 100 guest states spent the whole entry budget, so what the
      // collection actually omitted is the NODES' states.
      expect(Object.keys(tree.status?.statuses ?? {})).toHaveLength(100);
      expect(tree.status?.statuses["node/pve"]).toBeUndefined();
      expect(tree.status?.truncated).toBe(true);
      const warning = tree.warnings?.find((w) => w.includes("Status collection stopped")) ?? "";
      expect(warning).toContain("100 entries");
      expect(warning).toContain("status entries");
      expect(warning).not.toMatch(/more guests than/);
      expect(warning).not.toMatch(/guests beyond/);
      // The persistent-limit property stays intact: no remedy is offered,
      // because every path that could retry shares this same budget.
      expect(warning).not.toContain("Refresh Lab Status");
      expect(warning).not.toContain("Sync Now");
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

    it("keys guest statuses by the BARE vmid externalId — running/stopped map through, status 'unknown' rows are OMITTED from statuses and their vmids CLEARED, and no entry ever carries console fields (kills an invented mapping for unknown rows, a `${type}/${vmid}` key the apply cannot resolve, and console fields the listing rows never carried — and kills omitting an unknown row WITHOUT clearing it, which left a previously-status-bearing guest's stale decoration standing on every merging report; the complete report's clear-then-apply drops that decoration anyway, so this pin is the consistency half of the round-5 fix)", async () => {
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
      // Round 5 (P2): the row was OBSERVED and has genuinely no state, so its
      // vmid is explicitly cleared — the same treatment a complete report
      // gives as a truncated one, where the clear is what drops the stale
      // decoration at all (the truncated report pins it below).
      expect(report.clearedExternalIds).toEqual(["116"]);
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

    it("status-reports a STOPPED guest even with includeStopped FALSE (kills the includeStopped-filtered status path: a previously synced running guest that stops was omitted from the report, so a COMPLETE report cleared its old running state instead of replacing it with stopped — the retained server ended up with unknown status and no Start action)", async () => {
      const { report } = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow({ status: "stopped" })] } } },
        { baseUrl: BASE, includeStopped: false }
      );
      expect(report.statuses).toEqual({ "105": { state: "stopped" } });

      // The running case is unchanged: includeStopped=false still reports it.
      const running = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow({ vmid: 106, name: "up" })] } } },
        { baseUrl: BASE, includeStopped: false }
      );
      expect(running.report.statuses).toEqual({ "106": { state: "running" } });
    });

    it("keeps the sync's template gate on the status set — with the includeTemplates opt-in OFF, template rows are dropped — while every guest is reported REGARDLESS of includeStopped (CONTROLLER RULING amending §Spec's 'Same filters as the sync device set': status reports all guests and includeStopped governs only the SYNC device set — this test previously pinned the includeStopped-off omission on the STATUS path; that assertion was the amended spec, not a defect guard, and is updated here, because with orphan/keep prune policies a retained stopped server must show truthful stopped + Start, and with delete the apply ignores statuses for unmatched servers anyway)", async () => {
      const templates = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow({ template: 1, name: "gold-image" }), guestRow()] } } },
        { baseUrl: BASE }
      );
      expect(templates.report.statuses).toEqual({ "105": { state: "running" } });

      const stoppedOff = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow({ status: "stopped" }), guestRow({ vmid: 106, name: "up" })] } } },
        { baseUrl: BASE, includeStopped: false }
      );
      expect(stoppedOff.report.statuses).toEqual({ "105": { state: "stopped" }, "106": { state: "running" } });
    });

    it("carries every template vmid in `clearedExternalIds` and NONE in `statuses` — with includeTemplates ON and OFF (superseding the intermediate reported-as-stopped design: per-vmid template-ness is invisible to the apply's control gate, a bare numeric vmid passes canControlNode, so a known status on a template row lights the Start/Stop menu PVE refuses to serve — a template never carries a status, and its id is explicitly cleared so a MERGING report cannot retain a converted guest's stale decoration; the cleared list rides the report regardless of the opt-in because the template need not be in the current sync set for its old server to still exist) (kills the reported-as-stopped design that exposed the menu)", async () => {
      const on = await pollStatus(
        {
          [RESOURCES]: {
            body: {
              data: [
                // The row's own status is NEVER consulted for a template — even
                // one lying about "running" is only cleared, never reported.
                guestRow({ vmid: 106, name: "gold-image", template: 1, status: "running" }),
                guestRow()
              ]
            }
          }
        },
        { baseUrl: BASE, includeTemplates: true }
      );
      expect(on.report.statuses).toEqual({ "105": { state: "running" } });
      expect(on.report.clearedExternalIds).toEqual(["106"]);
      // The REAL downstream gate accepts the new member.
      expect(validateInventoryStatusReport(on.report)).toBeDefined();

      const off = await pollStatus(
        {
          [RESOURCES]: {
            body: {
              data: [
                guestRow({ vmid: 106, name: "gold-image", template: 1, status: "stopped" }),
                guestRow({ vmid: 107, name: "second-gold", template: 1, status: "stopped" }),
                guestRow()
              ]
            }
          }
        },
        { baseUrl: BASE }
      );
      expect(off.report.statuses).toEqual({ "105": { state: "running" } });
      expect(off.report.clearedExternalIds).toEqual(["106", "107"]);
      expect(validateInventoryStatusReport(off.report)).toBeDefined();
    });

    it("carries NO `notSyncableReasons` on the POLL path — only the SYNC's tree report reaches computeSyncPlan, and applyInventoryStatus never reads the member, so an entry here could never be rendered anywhere (kills a copy of the sync branch that ships a field nothing can read)", async () => {
      const { report } = await pollStatus(
        { [RESOURCES]: { body: { data: [guestRow({ vmid: 106, name: "gold-image", template: 1 }), guestRow()] } } },
        { baseUrl: BASE }
      );
      expect(report.clearedExternalIds).toEqual(["106"]);
      expect(Object.prototype.hasOwnProperty.call(report, "notSyncableReasons")).toBe(false);
    });

    it("clears the converted template in a TRUNCATED (join-failure) report — the vmid rides `clearedExternalIds` so the MERGING apply removes the pre-conversion 'running' instead of retaining it, while the node statuses stay absent-and-retained (the Task-5 ruling: merge protects only what the report OMITS — an explicitly cleared entry is not omitted, it is asserted gone; the engine-side proof that the apply removes the stale status lives in nexusCoreInventory.test.ts) (kills the round-2 stopped-reporting shape, whose template entry is gone from statuses here)", async () => {
      const { report, calls } = await pollStatus(
        {
          [RESOURCES]: {
            body: { data: [guestRow({ vmid: 106, name: "gold-image", template: 1, status: "stopped" }), guestRow(), nodeRow()] }
          },
          [STATUS]: { status: 403, body: "" }
        },
        { baseUrl: BASE, includeNodes: true, includeTemplates: true }
      );
      // The join failed — the report is partial and the apply MERGES.
      expect(calls).toHaveLength(2);
      expect(report.truncated).toBe(true);
      // The template is NOT status-reported (the round-2 rule reverted)...
      expect(report.statuses).toEqual({ "105": { state: "running" } });
      // ...and its vmid is explicitly cleared, which is what removes the
      // stale "running" the server carried before its conversion.
      expect(report.clearedExternalIds).toEqual(["106"]);
      // Node statuses are ABSENT here (the join failed) — retained by the
      // merging apply, per the Task-5 ruling pin above.
    });

    it("clears an OBSERVED guest whose row now carries status 'unknown' in a TRUNCATED (join-failure) report — the row was seen and genuinely has no state, the same class as a converted template, so its vmid rides `clearedExternalIds` and the MERGING apply drops the guest's stale running/stopped (and the Start/Stop menu riding it) instead of retaining it indefinitely while Sys.Audit stays unavailable (kills the plain omission, which let a previously-status-bearing guest keep its stale decoration on every merging report)", async () => {
      const { report, calls } = await pollStatus(
        {
          [RESOURCES]: {
            body: { data: [guestRow({ vmid: 116, name: "rrd-lagging", status: "unknown" }), guestRow(), nodeRow()] }
          },
          [STATUS]: { status: 403, body: "" }
        },
        { baseUrl: BASE, includeNodes: true }
      );
      // The join failed — the report is partial and the apply MERGES.
      expect(calls).toHaveLength(2);
      expect(report.truncated).toBe(true);
      // The observed-but-stateless row is NOT status-reported (the
      // round-1..4 shape kept this half)...
      expect(report.statuses).toEqual({ "105": { state: "running" } });
      // ...but its vmid is now explicitly cleared — the template branch's
      // mechanism — which is what removes the stale "running" the server
      // carried from earlier polls. Node statuses stay absent-and-retained.
      expect(report.clearedExternalIds).toEqual(["116"]);
    });

    it("stops collecting at the hard cap and flags truncated — a partial report MERGES on apply (prior state retained for the entries never reached), never clears (kills an uncapped report whose apply would clear-then-set over a cluster the poll never finished reading)", async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}` }));
      const { report, calls } = await pollStatus({ [RESOURCES]: { body: { data: rows } } }, { baseUrl: BASE });
      expect(Object.keys(report.statuses)).toHaveLength(10_000);
      expect(report.truncated).toBe(true);
      // The cap needs no fan-out — the poll stays ONE call even at 10k guests.
      expect(calls).toHaveLength(1);
    });

    it("budgets the POLL's collection by the configured hardCap too — 501 guests under hardCap 500 report 500 states and truncated (kills a poll left on the constant while the sync honours the field, under which the same source reports two different collection sizes depending on which path ran)", async () => {
      const rows = Array.from({ length: 501 }, (_, i) => guestRow({ vmid: i + 1, name: `guest-${i + 1}` }));
      const { report } = await pollStatus({ [RESOURCES]: { body: { data: rows } } }, { baseUrl: BASE, hardCap: 500 });
      expect(Object.keys(report.statuses)).toHaveLength(500);
      expect(report.truncated).toBe(true);
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

  // -----------------------------------------------------------------------------
  // NODE CONTROL — start/stop one guest via a UPID task. The verified live
  // shape: the POST answers 200 IMMEDIATELY with `{"data":"UPID:…"}`; the task's
  // verdict (`exitstatus`) is only visible by polling the task endpoint, so a
  // 200 on the POST says nothing about success. Unlike fetchStatus, control
  // PROPAGATES failures (contract note, models/inventory.ts:346-355).
  // -----------------------------------------------------------------------------

  describe("controlNode", () => {
    const BASE = "https://pve.example.com:8006";
    const SECRETS = { apiToken: "root@pam!test=secret" };
    // Sanitized UPID shape: UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<vmid>:<user>:
    const UPID = "UPID:pve:00123D:00000000:68C00000:qmstart:105:root@pam:";
    const UPID_ENC = encodeURIComponent(UPID);
    const TASK_PATH = `/api2/json/nodes/pve/tasks/${UPID_ENC}/status`;
    // The brief's pinned budgets (module-internal constants): 2s cadence, 120s
    // deadline — 60 polls before giving up.
    const DEADLINE_MS = 120_000;

    type RouteMap = Record<string, { status?: number; body: unknown }>;

    /**
     * Routed world like pollStatus's, but recording the METHOD and headers too — the POST is the whole point here.
     * The optional `onCall` hook fires after a request is recorded and before its answer resolves, so a test can
     * move the fake clock by the latency each route simulates.
     */
    function controlFetch(routes: RouteMap, onCall?: (url: string) => void) {
      const calls: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
      const impl = async (input: string | URL, init?: { method?: string; headers?: Record<string, string> }): Promise<unknown> => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", headers: init?.headers });
        onCall?.(url);
        const hit = routes[new URL(url).pathname];
        if (!hit) {
          return makeResponse(500, { data: null, message: `no test route for ${new URL(url).pathname}` });
        }
        return makeResponse(hit.status ?? 200, hit.body);
      };
      return { calls, fetchImpl: impl as unknown as typeof fetch };
    }

    const qemuRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      vmid: 105,
      node: "pve",
      type: "qemu",
      ...overrides
    });

    it("resolves node and type with a fresh ?type=vm lookup BEFORE the POST — the bare vmid externalId does not name node+type, and a guest can migrate between syncs (kills a control that assumes node/type from thin air or reuses the last tree)", async () => {
      const { calls, fetchImpl } = controlFetch({
        "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
        "/api2/json/nodes/pve/qemu/105/status/start": { body: { data: UPID } },
        [TASK_PATH]: { body: { data: { status: "stopped", exitstatus: "OK" } } }
      });
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      await expect(provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start")).resolves.toBeUndefined();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${BASE}/api2/json/cluster/resources?type=vm`,
        `POST ${BASE}/api2/json/nodes/pve/qemu/105/status/start`,
        `GET ${BASE}${TASK_PATH}`
      ]);
      // The POST is a fresh request path — it must carry the same PVEAPIToken
      // credential the GETs do (kills a header that exists only on rawGet).
      const post = calls[1];
      expect(post.method).toBe("POST");
      expect(post.headers).toMatchObject({ Authorization: "PVEAPIToken=root@pam!test=secret" });
    });

    it("polls the URL-ENCODED UPID task endpoint and resolves once the task reports stopped/OK — a raw-colon UPID path is not the URL PVE serves (kills an unencoded task id, and a control that returns on the POST's 200 without ever checking the task's verdict)", async () => {
      const { calls, fetchImpl } = controlFetch({
        "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
        "/api2/json/nodes/pve/qemu/105/status/start": { body: { data: UPID } },
        [TASK_PATH]: { body: { data: { status: "stopped", exitstatus: "OK" } } }
      });
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      await expect(provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start")).resolves.toBeUndefined();
      expect(calls[2].url).toBe(`${BASE}/api2/json/nodes/pve/tasks/${UPID_ENC}/status`);
      expect(calls[2].url).not.toContain("UPID:pve");
    });

    it("REJECTS with the task's own message when it finished with a non-OK exitstatus — the POST's HTTP 200 said nothing (verified live: task `exitstatus: 'VM 105 already running'`; kills swallowing a failed task because the transport answered 200)", async () => {
      const { fetchImpl } = controlFetch({
        "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
        "/api2/json/nodes/pve/qemu/105/status/start": { body: { data: UPID } },
        [TASK_PATH]: { body: { data: { status: "stopped", exitstatus: "VM 105 already running" } } }
      });
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const err = await provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toContain("VM 105 already running");
    });

    it("gives up at the deadline when the task is still running and STOPS polling — the task continues server-side, so the error points at the PVE task log (kills an unbounded poll that never reports)", async () => {
      vi.useFakeTimers();
      try {
        const { calls, fetchImpl } = controlFetch({
          "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
          "/api2/json/nodes/pve/qemu/105/status/start": { body: { data: UPID } },
          [TASK_PATH]: { body: { data: { status: "running" } } }
        });
        const provider = createProxmoxProvider(fetchImpl, fetchImpl);
        const pending = provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start");
        const settled = expect(pending).rejects.toThrow(/still running/);
        await vi.advanceTimersByTimeAsync(DEADLINE_MS);
        await settled;
        // 1 lookup + 1 POST + 59 polls at the 2s cadence — every poll issued
        // STRICTLY before the 120s deadline (the pre-request check refuses one
        // that would start at or after it, so no request can run past the wait
        // the user was told), and the error still names the task log.
        expect(calls.filter((c) => c.url.includes("/tasks/"))).toHaveLength(59);
        expect(calls).toHaveLength(61);
      } finally {
        vi.useRealTimers();
      }
    });

    it("caps each task poll by the REMAINING deadline — a request issued near 120s must not carry the full 20s fetch timeout (the crawl's min(timeout, remaining) idiom; kills a poll whose every request gets the full budget, leaving the progress notification blocked up to 20s past the deadline the user was told)", async () => {
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      try {
        // Every task answer takes 19s of clock: each poll burns nearly its
        // whole budget, so the 6th is issued with 13s left and must be capped
        // to it (polls 1–5 still fit under the 20s ceiling).
        const { calls, fetchImpl } = controlFetch(
          {
            "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
            "/api2/json/nodes/pve/qemu/105/status/start": { body: { data: UPID } },
            [TASK_PATH]: { body: { data: { status: "running" } } }
          },
          (url) => {
            if (url.includes("/tasks/")) {
              vi.setSystemTime(Date.now() + 19_000);
            }
          }
        );
        // rawGet hands its timeout to the transport as `AbortSignal.timeout(ms)`
        // — the spy reads the duration each request actually asked for, in the
        // same chronological order the fetch mock records them.
        const provider = createProxmoxProvider(fetchImpl, fetchImpl);
        const pending = provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start");
        const settled = expect(pending).rejects.toThrow(/still running/);
        await vi.advanceTimersByTimeAsync(300_000);
        await settled;
        // lookup + POST + the six polls that fit before the deadline — no more.
        expect(calls.filter((c) => c.url.includes("/tasks/"))).toHaveLength(6);
        // Drop the lookup's and the POST's durations; the six polls follow.
        const durations = timeoutSpy.mock.calls.map((c) => c[0]).slice(2);
        expect(durations).toEqual([20_000, 20_000, 20_000, 20_000, 20_000, 13_000]);
      } finally {
        timeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("checks the deadline BEFORE each poll — once the budget is spent the 'still running' error fires without issuing another HTTP request (kills a deadline checked only after the response returns, which sends one more request past the deadline every time)", async () => {
      vi.useFakeTimers();
      try {
        // The first answer takes 117s of clock: the loop top after it sits 1s
        // past the deadline, so the SECOND poll must never be issued.
        const { calls, fetchImpl } = controlFetch(
          {
            "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
            "/api2/json/nodes/pve/qemu/105/status/start": { body: { data: UPID } },
            [TASK_PATH]: { body: { data: { status: "running" } } }
          },
          (url) => {
            if (url.includes("/tasks/")) {
              vi.setSystemTime(Date.now() + 117_000);
            }
          }
        );
        const provider = createProxmoxProvider(fetchImpl, fetchImpl);
        const pending = provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start");
        const settled = expect(pending).rejects.toThrow(/still running/);
        await vi.advanceTimersByTimeAsync(300_000);
        await settled;
        // lookup + POST + the ONE poll that fit inside the budget — the
        // deadline's expiry stops the poll before the next request.
        expect(calls.filter((c) => c.url.includes("/tasks/"))).toHaveLength(1);
        expect(calls).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects with a re-sync hint when the vmid is no longer in the cluster listing (kills an error that names neither the guest nor the way out)", async () => {
      const { calls, fetchImpl } = controlFetch({
        "/api2/json/cluster/resources": { body: { data: [] } }
      });
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const err = await provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toContain("105");
      expect((err as Error).message).toMatch(/re-sync/i);
      // The lookup answered — nothing further was attempted.
      expect(calls).toHaveLength(1);
    });

    it("rejects a node externalId immediately, WITHOUT any HTTP call — PVE nodes are not start/stop targets from Nexus (kills a control that POSTs to /nodes/<name>/status)", async () => {
      const { calls, fetchImpl } = controlFetch({});
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const err = await provider.controlNode!({ baseUrl: BASE }, SECRETS, "node/pve", "start").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toMatch(/cannot be started or stopped/i);
      expect(calls).toHaveLength(0);
    });

    it("rejects a POST response whose data is not a UPID string — absent, null, a number, or not 'UPID:'-prefixed (kills a control that polls a task id it never validated — the garbage poll must never fire and the error must name the tracking failure, not a downstream HTTP status)", async () => {
      for (const body of [{}, { data: null }, { data: 42 }, { data: "not-a-upid" }]) {
        const { calls, fetchImpl } = controlFetch({
          "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
          "/api2/json/nodes/pve/qemu/105/status/start": { body }
        });
        const provider = createProxmoxProvider(fetchImpl, fetchImpl);
        const err = await provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InventoryProviderError);
        expect((err as InventoryProviderError).kind).toBe("protocol");
        expect((err as Error).message).toMatch(/task id/i);
        expect(calls.filter((c) => c.url.includes("/tasks/"))).toHaveLength(0);
      }
    });

    it("routes an lxc stop through /nodes/pve/lxc/114/status/stop (kills a qemu-only control path)", async () => {
      const { calls, fetchImpl } = controlFetch({
        "/api2/json/cluster/resources": { body: { data: [qemuRow({ vmid: 114, type: "lxc" })] } },
        "/api2/json/nodes/pve/lxc/114/status/stop": { body: { data: "UPID:pve:00123E:00000000:68C00000:vzstop:114:root@pam:" } },
        "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00123E%3A00000000%3A68C00000%3Avzstop%3A114%3Aroot%40pam%3A/status": {
          body: { data: { status: "stopped", exitstatus: "OK" } }
        }
      });
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      await expect(provider.controlNode!({ baseUrl: BASE }, SECRETS, "114", "stop")).resolves.toBeUndefined();
      expect(calls[1]).toMatchObject({ method: "POST", url: `${BASE}/api2/json/nodes/pve/lxc/114/status/stop` });
    });

    it("propagates a 403 on the POST as an AUTH error — unlike the status path, control deliberately does NOT degrade a failed mutation into a no-op (contract, models/inventory.ts:346-355; kills a swallow on the control path)", async () => {
      const { calls, fetchImpl } = controlFetch({
        "/api2/json/cluster/resources": { body: { data: [qemuRow()] } },
        "/api2/json/nodes/pve/qemu/105/status/start": { status: 403, body: "" }
      });
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const err = await provider.controlNode!({ baseUrl: BASE }, SECRETS, "105", "start").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("auth");
      // The POST was attempted and refused — no task poll could follow.
      expect(calls).toHaveLength(2);
    });
  });

  /**
   * WEB CONSOLE (§Spec) — the one provider member that makes NO request on
   * behalf of what it returns: the URL goes to the user's browser, where the
   * PVE web session is the credential. Every assertion here defends a piece of
   * the URL PVE actually serves, because a wrong one fails as a blank noVNC
   * page with no diagnostic anywhere in Nexus.
   */
  describe("webConsoleUrl", () => {
    const BASE = "https://pve.example.com:8006";
    const SECRETS = { apiToken: "root@pam!test=secret" };

    function lookupFetch(rows: unknown[], status = 200) {
      const calls: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
      const impl = async (input: string | URL, init?: { method?: string; headers?: Record<string, string> }): Promise<unknown> => {
        calls.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers });
        return makeResponse(status, { data: rows });
      };
      return { calls, fetchImpl: impl as unknown as typeof fetch };
    }

    it("builds PVE's noVNC URL for a qemu guest with the FULL query, including the empty-valued cmd= PVE expects (kills a hand-concatenated query that drops or mis-orders a member — the console opens blank with nothing to diagnose)", async () => {
      const { fetchImpl } = lookupFetch([{ vmid: 107, node: "pve", type: "qemu", name: "build-vm" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      await expect(provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "107")).resolves.toBe(
        `${BASE}/?console=kvm&novnc=1&vmid=107&vmname=build-vm&node=pve&resize=off&cmd=`
      );
    });

    it("builds PVE's xterm.js URL for a container with ITS full query — console=lxc, xtermjs=1 and NO resize (kills a builder that swaps one flag and keeps the noVNC shape, and kills a qemu-only builder: each type's complete query is pinned, so flags cannot be traded between them unnoticed)", async () => {
      const { fetchImpl } = lookupFetch([{ vmid: 114, node: "pve", type: "lxc", name: "dns-ct" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      await expect(provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "114")).resolves.toBe(
        `${BASE}/?console=lxc&xtermjs=1&vmid=114&vmname=dns-ct&node=pve&cmd=`
      );
    });

    it("keeps the two shapes apart: a container URL carries no novnc and no resize, a VM URL carries no xtermjs (\u2298 one shared parameter set for both types hands PVE a viewer flag the other type's page does not read)", async () => {
      const ct = lookupFetch([{ vmid: 114, node: "pve", type: "lxc", name: "dns-ct" }]);
      const ctUrl = new URL(await createProxmoxProvider(ct.fetchImpl, ct.fetchImpl).webConsoleUrl!({ baseUrl: BASE }, SECRETS, "114"));
      expect(ctUrl.searchParams.get("xtermjs")).toBe("1");
      expect(ctUrl.searchParams.has("novnc")).toBe(false);
      expect(ctUrl.searchParams.has("resize")).toBe(false);
      const vm = lookupFetch([{ vmid: 107, node: "pve", type: "qemu", name: "build-vm" }]);
      const vmUrl = new URL(await createProxmoxProvider(vm.fetchImpl, vm.fetchImpl).webConsoleUrl!({ baseUrl: BASE }, SECRETS, "107"));
      expect(vmUrl.searchParams.get("novnc")).toBe("1");
      expect(vmUrl.searchParams.get("resize")).toBe("off");
      expect(vmUrl.searchParams.has("xtermjs")).toBe(false);
    });

    it("PRESERVES a reverse-proxy mount path from the base URL (kills a builder that keeps only the origin — https://gateway.example/?console=… is not where that deployment's UI lives)", async () => {
      const { fetchImpl } = lookupFetch([{ vmid: 107, node: "pve", type: "qemu", name: "build-vm" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      await expect(provider.webConsoleUrl!({ baseUrl: "https://gateway.example/pve" }, SECRETS, "107")).resolves.toBe(
        "https://gateway.example/pve/?console=kvm&novnc=1&vmid=107&vmname=build-vm&node=pve&resize=off&cmd="
      );
    });

    it("QUERY-ENCODES the guest name — it is guest-controlled text (kills raw interpolation, where a space or an & truncates the query and the remaining parameters are silently lost)", async () => {
      const { fetchImpl } = lookupFetch([{ vmid: 107, node: "pve", type: "qemu", name: "build vm&novnc=0" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const resolved = await provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "107");
      const parsed = new URL(resolved);
      expect(parsed.searchParams.get("vmname")).toBe("build vm&novnc=0");
      // The injected `novnc=0` must not survive as a parameter of its own.
      expect(parsed.searchParams.getAll("novnc")).toEqual(["1"]);
    });

    it("resolves node/type/name FRESH from ?type=vm before building anything, and reflects a node the guest has since migrated to (kills a URL built from the last sync's node — the console would open on a host that no longer runs the guest)", async () => {
      const { calls, fetchImpl } = lookupFetch([{ vmid: 107, node: "pve-2", type: "qemu", name: "build-vm" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const resolved = await provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "107");
      expect(new URL(resolved).searchParams.get("node")).toBe("pve-2");
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${BASE}/api2/json/cluster/resources?type=vm`]);
    });

    it("authenticates the lookup with the same PVEAPIToken header every other read uses (kills a lookup issued anonymously, which answers 401 and reads as 'guest gone')", async () => {
      const { calls, fetchImpl } = lookupFetch([{ vmid: 107, node: "pve", type: "qemu", name: "build-vm" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      await provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "107");
      expect(calls[0].headers).toMatchObject({ Authorization: "PVEAPIToken=root@pam!test=secret" });
    });

    it("NEVER puts the API token in the returned URL — it is opened in an external browser and lands in history (kills a builder that 'helpfully' authenticates the link)", async () => {
      const { fetchImpl } = lookupFetch([{ vmid: 107, node: "pve", type: "qemu", name: "build-vm" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const resolved = await provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "107");
      expect(resolved).not.toContain("secret");
      expect(resolved.toLowerCase()).not.toContain("token");
    });

    it("rejects with a re-sync hint when the vmid is no longer in the cluster listing (kills an error that names neither the guest nor the way out — same contract as controlNode's)", async () => {
      const { fetchImpl } = lookupFetch([]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const err = await provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "107").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toContain("107");
      expect((err as Error).message).toMatch(/re-sync/i);
    });

    it("refuses a node/<name> externalId BEFORE any request, naming it as a Proxmox NODE (kills falling through the guest lookup, which rejects with \"Guest node/pve is no longer present — re-sync\": guest-shaped wording for a node, blaming the sync for a route that never applied to a hypervisor node at all)", async () => {
      const { calls, fetchImpl } = lookupFetch([{ vmid: 107, node: "pve", type: "qemu", name: "build-vm" }]);
      const provider = createProxmoxProvider(fetchImpl, fetchImpl);
      const err = await provider.webConsoleUrl!({ baseUrl: BASE }, SECRETS, "node/pve").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect((err as Error).message).toContain("node/pve");
      expect((err as Error).message).toMatch(/is a Proxmox node/);
      // The two halves of the guest-shaped rejection this exists to kill: it
      // must not report the node as a missing guest, nor send the user to a
      // re-sync that would change nothing.
      expect((err as Error).message).not.toMatch(/no longer present/i);
      expect((err as Error).message).not.toMatch(/re-sync/i);
      // The predicate is the UI gate; the impl must stand on its own — a direct
      // call must not spend a cluster read before refusing.
      expect(calls).toEqual([]);
    });
  });
});
