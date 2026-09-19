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
import { InventoryProviderError } from "../../src/models/inventory";
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
      const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        expect(String(url)).toBe("https://pve.example.com:8006/api2/json/version");
        expect(init?.headers).toMatchObject({ Authorization: "PVEAPIToken=root@pam!test=secret" });
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

    it("carries PVE's own message from a {\"data\":null,\"message\":…} failure body, newline trimmed (kills echoing raw JSON — or an empty tail where a message should be — at the user)", async () => {
      const fetchImpl = vi.fn(async () => makeResponse(500, { data: null, message: "QEMU guest agent is not running\n" }));
      const provider = createProxmoxProvider(fetchImpl as unknown as typeof fetch);

      const err = await provider
        .testConnection({ baseUrl: "https://pve.example.com:8006" }, SECRETS)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: "protocol" });
      expect((err as Error).message).toContain("QEMU guest agent is not running");
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
});
