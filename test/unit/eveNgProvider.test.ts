import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EVE_NG_INSECURE_TLS_WARNING,
  EVE_NG_PROVIDER_ID,
  createEveNgProvider,
  eveNgInstanceKey,
  labFolderPath
} from "../../src/services/inventory/providers/eveNgProvider";
import { validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { computeSyncPlan, validateInventoryTree } from "../../src/services/inventory/syncEngine";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import type { ServerConfig } from "../../src/models/config";
import type { InventoryConfigField, InventoryStatusReport } from "../../src/models/inventory";

/**
 * EVE-NG's identity as a deployment — the same contract `netboxInstanceKey`
 * implements (see `InventoryProvider.instanceKey`, models/inventory.ts): two
 * deployments must never collide onto one key, and one deployment must not
 * fragment into several. Unlike NetBox, the PATH is dropped: an EVE-NG server's
 * API always lives at the origin's `/api`, so a path in the base URL is a typo
 * or a stray copy-paste rather than a second deployment on the same host.
 */
describe("eveNgInstanceKey", () => {
  it("collapses every spelling of ONE deployment onto ONE key — trailing slashes, host case, the scheme's default port, the /api suffix, a stray query/fragment (⊘ a raw-string key fragments one instance into seven and refuses the re-add adoption exists for)", () => {
    const canonical = "http://eve.example.com";
    for (const spelling of [
      "http://eve.example.com",
      "http://eve.example.com/",
      "http://eve.example.com///",
      "http://EVE.Example.COM",
      "http://eve.example.com:80",
      "  http://eve.example.com  ",
      // A pasted `/api` is the API path the user copied out of the browser, not
      // a mount point — it is stripped so it cannot double up into
      // `/api/api/auth/login`, and the key derived from the same normalized
      // string agrees.
      "http://eve.example.com/api",
      "http://eve.example.com/api/",
      "http://eve.example.com?foo=bar",
      "http://eve.example.com#frag"
    ]) {
      expect(eveNgInstanceKey({ baseUrl: spelling })).toBe(canonical);
    }
  });

  /**
   * MAJOR-2 — the key and the fetch MUST agree. `authedGet`/`login` build
   * `new URL(`${baseUrl}${path}`)`, so a base URL with a mount path
   * (`http://gw/eve1`, a reverse proxy fronting several EVE-NG boxes) issues
   * every request UNDER that path. Dropping the path from the key would map
   * `http://gw/eve1` and `http://gw/eve2` — two distinct working deployments —
   * onto one identity, and source B could then adopt (and its prune policy
   * delete) servers and credentials kept from source A on a different box.
   */
  it("KEEPS a real mount path, so two proxied deployments on one host stay distinct (⊘ dropping the path collides two boxes onto one key and lets one adopt the other's kept servers)", () => {
    expect(eveNgInstanceKey({ baseUrl: "http://gw.example.com/eve1" })).toBe("http://gw.example.com/eve1");
    const a = eveNgInstanceKey({ baseUrl: "http://gw.example.com/eve1" });
    const b = eveNgInstanceKey({ baseUrl: "http://gw.example.com/eve2" });
    expect(a).not.toBe(b);
  });

  it("normalizes only the path's trailing slash, and keeps path case (a mount path is server-significant, unlike host case)", () => {
    expect(eveNgInstanceKey({ baseUrl: "http://gw.example.com/eve1/" })).toBe("http://gw.example.com/eve1");
    expect(eveNgInstanceKey({ baseUrl: "http://gw.example.com/EVE1" })).toBe("http://gw.example.com/EVE1");
  });

  it("keeps host, non-default port and scheme — the three things that actually distinguish two EVE-NG servers (⊘ over-normalizing is the failure that hands one lab's records to another)", () => {
    const keys = ["http://eve.example.com", "http://eve-lab.example.com", "http://eve.example.com:8080", "https://eve.example.com"].map(
      (baseUrl) => eveNgInstanceKey({ baseUrl })
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[2]).toBe("http://eve.example.com:8080");
    expect(keys[3]).toBe("https://eve.example.com");
  });

  it("NEVER carries userinfo — the base URL is a NON-secret field whose value is persisted on every kept server and copied into backups (⊘ returning the URL as typed leaks a password into globalState)", () => {
    expect(eveNgInstanceKey({ baseUrl: "http://admin:s3cr3t@eve.example.com/" })).toBe("http://eve.example.com");
    expect(eveNgInstanceKey({ baseUrl: "http://admin:s3cr3t@eve.example.com/" })).not.toContain("s3cr3t");
    expect(eveNgInstanceKey({ baseUrl: "http://admin:s3cr3t@eve.example.com/" })).not.toContain("admin");
  });

  it("returns undefined — no instance identity, therefore no adoption — for a base URL nothing could be fetched from (⊘ inventing a key for an endpoint that does not resolve)", () => {
    expect(eveNgInstanceKey({ baseUrl: "eve.example.com" })).toBeUndefined();
    expect(eveNgInstanceKey({ baseUrl: "" })).toBeUndefined();
    expect(eveNgInstanceKey({ baseUrl: "   " })).toBeUndefined();
    expect(eveNgInstanceKey({})).toBeUndefined();
  });

  it("is exposed ON the provider, the only way the engine ever reaches it (⊘ an implementation that exists but is never wired up)", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    expect(typeof provider.instanceKey).toBe("function");
    expect(provider.instanceKey?.({ baseUrl: "http://eve.example.com/" })).toBe("http://eve.example.com");
  });
});

describe("createEveNgProvider — shape", () => {
  it("has the eve-ng id, the EVE-NG label, and a stable config field order (the form renders fields in this order, and the order is part of the provider fingerprint)", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.id).toBe(EVE_NG_PROVIDER_ID);
    expect(EVE_NG_PROVIDER_ID).toBe("eve-ng");
    expect(provider.label).toBe("EVE-NG");
    expect(provider.configFields.map((f) => f.id)).toEqual([
      "baseUrl",
      "username",
      "password",
      "rootFolder",
      "filter",
      "includeStopped",
      "consoleHost",
      // INSECURE TLS — appended LAST on purpose: the order is part of the
      // provider fingerprint, and adding the field at the end keeps every
      // existing field where the user last saw it.
      "allowInsecureTls"
    ]);
  });

  it("declares `password` as the only password-typed field, so it is the only one the vault captures (⊘ a string-typed password field would be persisted in cleartext globalState alongside the base URL)", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.configFields.filter((f) => f.type === "password").map((f) => f.id)).toEqual(["password"]);
    expect(provider.configFields.find((f) => f.id === "username")?.type).toBe("string");
  });

  it("marks exactly baseUrl/username/password required — rootFolder, filter, includeStopped and consoleHost all have working defaults", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.configFields.filter((f) => f.required === true).map((f) => f.id)).toEqual(["baseUrl", "username", "password"]);
  });

  it("keeps the saved-filter picker attachable: `filter` is a type:\"string\" field (⊘ the picker only renders for id `filter` AND type string — any other type silently drops it)", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.configFields.find((f) => f.id === "filter")?.type).toBe("string");
  });

  it("still raises the certificate question in the baseUrl description, but now POINTS AT THE OPTION rather than declaring the setup unsupported (the failure is otherwise an opaque certificate code with no named remedy)", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    const description = provider.configFields.find((f) => f.id === "baseUrl")?.description?.toLowerCase() ?? "";
    expect(description).toContain("self-signed");
    expect(description).toContain("certificate");
    expect(description).not.toContain("not supported");
  });

  it("declares the attribute keys its devices actually carry, so a template rule filter on an unknown key is caught at save time", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.attributeKeys).toEqual(["lab", "template", "type", "console", "status", "image", "name"]);
  });

  it("passes validateProviderShape — the same gate the registry applies at registration (⊘ a provider that only compiles still cannot be registered)", () => {
    expect(() => validateProviderShape(createEveNgProvider(vi.fn() as unknown as typeof fetch))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Network behaviour
// ---------------------------------------------------------------------------

import { InventoryProviderError, type InventoryTree } from "../../src/models/inventory";

const SESSION = "s3ss10n";

function makeResponse(status: number, body: unknown, setCookie: string[] = []): unknown {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    text: async () => text,
    headers: {
      get: (name: string) => (name.toLowerCase() === "set-cookie" ? (setCookie[0] ?? null) : null),
      getSetCookie: () => setCookie
    }
  };
}

function jsend(data: unknown, overrides: Record<string, unknown> = {}): unknown {
  return { code: 200, status: "success", message: "", data, ...overrides };
}

interface FolderListing {
  folders?: { name: string; path: string }[];
  labs?: { file: string; path: string }[];
}

interface World {
  version?: string;
  /** Separate `data.edition` field some installs report; omitted from the response when undefined. */
  edition?: string;
  statusHttp?: number;
  /** keyed by DECODED folder path ("/", "/ACME"). */
  folders?: Record<string, FolderListing>;
  /** keyed by DECODED lab path ("/ACME/Lab 1.unl"). */
  nodes?: Record<string, unknown>;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeWorld(world: World): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string, init?: RequestInit): Promise<unknown> => {
    const url = new URL(input);
    calls.push({
      url: input,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined
    });
    const path = decodeURIComponent(url.pathname);
    if (path === "/api/auth/login") {
      return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}; Path=/; HttpOnly`]);
    }
    if (path === "/api/status") {
      const http = world.statusHttp ?? 200;
      if (http !== 200) {
        return makeResponse(http, "not here");
      }
      const statusData: Record<string, unknown> = { version: world.version ?? "5.0.1-13" };
      if (world.edition !== undefined) {
        statusData.edition = world.edition;
      }
      return makeResponse(200, jsend(statusData));
    }
    if (path.startsWith("/api/folders")) {
      const folderPath = path.slice("/api/folders".length) || "/";
      const listing = world.folders?.[folderPath];
      if (!listing) {
        return makeResponse(404, "no such folder");
      }
      return makeResponse(200, jsend({ folders: listing.folders ?? [], labs: listing.labs ?? [] }));
    }
    if (path.startsWith("/api/labs") && path.endsWith("/nodes")) {
      const labPath = path.slice("/api/labs".length, -"/nodes".length);
      return makeResponse(200, jsend(world.nodes?.[labPath] ?? {}));
    }
    return makeResponse(404, "not found");
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

const CONFIG = { baseUrl: "http://eve.example.com", username: "admin" };
const SECRETS = { password: "pw" };

/** A running qemu node with a native telnet console — the shape everything else varies from. */
function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    name: "R1",
    template: "vios",
    type: "qemu",
    image: "vios-adventerprisek9-m",
    console: "telnet",
    status: 2,
    url: "telnet://127.0.0.1:32769",
    ...overrides
  };
}

/** One lab at the root holding `nodes`, keyed the way the API keys them. */
function oneLabWorld(nodes: Record<string, unknown>, labFile = "Lab 1.unl"): World {
  return {
    folders: { "/": { labs: [{ file: labFile, path: `/${labFile}` }] } },
    nodes: { [`/${labFile}`]: nodes }
  };
}

async function fetchTree(world: World, config: Record<string, string | number | boolean> = {}): Promise<InventoryTree> {
  const { fetchImpl } = makeWorld(world);
  return createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, ...config }, SECRETS);
}

describe("createEveNgProvider — login and session", () => {
  it("logs in with html5:\"-1\" so EVE-NG hands back NATIVE telnet console URLs (⊘ omitting it — or sending \"0\"/\"1\" — makes every node report an HTML5 console URL, and the whole inventory maps to zero endpoints)", async () => {
    const { fetchImpl, calls } = makeWorld(oneLabWorld({ "1": node() }));
    await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);

    const login = calls.find((c) => c.url.endsWith("/api/auth/login"));
    expect(login?.method).toBe("POST");
    expect(JSON.parse(login?.body ?? "{}")).toEqual({ username: "admin", password: "pw", html5: "-1" });
  });

  it("issues every request UNDER a base-URL mount path, matching the deployment the instanceKey names (⊘ ignoring the path fetches `/api/...` at the origin while the key claims `/eve1` — key and fetch disagree)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(input);
      const path = new URL(input).pathname;
      if (path.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (path.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1-13" }));
      if (path.includes("/api/folders")) return makeResponse(200, jsend({ folders: [], labs: [] }));
      return makeResponse(200, jsend({}));
    }) as unknown as typeof fetch;

    await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, baseUrl: "http://gw.example.com/eve1" }, SECRETS);
    expect(calls).toContain("http://gw.example.com/eve1/api/auth/login");
    expect(calls.some((u) => u.includes("/eve1/api/folders"))).toBe(true);
    // ⊘ Nothing may be requested at the bare origin — that is a different box.
    expect(calls.every((u) => new URL(u).pathname.startsWith("/eve1/"))).toBe(true);
  });

  it("strips a pasted `/api` suffix so it cannot double into `/api/api/auth/login` (⊘ treating the API path as a mount path makes the very first request 404)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(input);
      return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
    }) as unknown as typeof fetch;
    await createEveNgProvider(fetchImpl).testConnection({ ...CONFIG, baseUrl: "http://eve.example.com/api" }, SECRETS).catch(() => undefined);
    expect(calls[0]).toBe("http://eve.example.com/api/auth/login");
  });

  /**
   * P2 — a Base URL copied from a browser can carry a query string or a
   * fragment. Appending `/api/auth/login` to `http://eve?foo=bar` yields
   * `http://eve?foo=bar/api/auth/login`, whose pathname is `/` — login hits the
   * root and fails. instanceKey already canonicalizes these away; the fetch
   * must agree.
   */
  it("P2 — strips a query string / fragment from the base URL before appending API paths, so the request hits /api/... (⊘ the suffix survives and the login lands on pathname `/`)", async () => {
    for (const baseUrl of ["http://eve.example.com?foo=bar", "http://eve.example.com#frag", "http://eve.example.com/?a=1#f"]) {
      const calls: string[] = [];
      const fetchImpl = (async (input: string) => {
        calls.push(input);
        return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      }) as unknown as typeof fetch;
      await createEveNgProvider(fetchImpl).testConnection({ ...CONFIG, baseUrl }, SECRETS).catch(() => undefined);
      expect(new URL(calls[0]).pathname, baseUrl).toBe("/api/auth/login");
      expect(calls[0], baseUrl).toBe("http://eve.example.com/api/auth/login");
    }
  });

  it("P2 — keeps a mount path while stripping a trailing query/fragment, and the instanceKey still names exactly that origin+path (⊘ key and fetch disagree once a query is involved)", async () => {
    const baseUrl = "http://gw.example.com/eve1?token=x";
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(input);
      return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
    }) as unknown as typeof fetch;
    await createEveNgProvider(fetchImpl).testConnection({ ...CONFIG, baseUrl }, SECRETS).catch(() => undefined);
    expect(calls[0]).toBe("http://gw.example.com/eve1/api/auth/login");
    // The key names the same origin+path the fetch actually used.
    expect(eveNgInstanceKey({ baseUrl })).toBe("http://gw.example.com/eve1");
  });

  it("M13 — captures the exact `unetlab_session` cookie, not a decoy that merely ends in that name (⊘ a boundary-less match grabs `xunetlab_session=DECOY`)", async () => {
    const calls: { cookie?: string }[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ cookie: headers.Cookie });
      if (new URL(input).pathname.endsWith("/api/auth/login")) {
        // Decoy first, so a leftmost substring match would grab it.
        return makeResponse(200, jsend(null), ["xunetlab_session=DECOY; Path=/", "unetlab_session=REAL; Path=/; HttpOnly"]);
      }
      if (new URL(input).pathname.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      return makeResponse(200, jsend({ folders: [], labs: [] }));
    }) as unknown as typeof fetch;
    await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    const authed = calls.filter((c) => c.cookie !== undefined);
    expect(authed.length).toBeGreaterThan(0);
    expect(authed.every((c) => c.cookie === "unetlab_session=REAL")).toBe(true);
  });

  it("M45 — arms an abort signal on every request so a hung EVE-NG box cannot stall the crawl forever (⊘ dropping the signal leaves each fetch unbounded)", async () => {
    const signals: unknown[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      signals.push(init?.signal);
      if (new URL(input).pathname.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (new URL(input).pathname.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      return makeResponse(200, jsend({ folders: [], labs: [] }));
    }) as unknown as typeof fetch;
    await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("captures the unetlab_session cookie and replays it on EVERY later request (⊘ undici's fetch keeps no cookie jar, so a client that never sets the header gets a 401 on the first folder listing)", async () => {
    const { fetchImpl, calls } = makeWorld(oneLabWorld({ "1": node() }));
    await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);

    const after = calls.filter((c) => !c.url.endsWith("/api/auth/login"));
    expect(after.length).toBeGreaterThan(1);
    for (const call of after) {
      expect(call.headers.Cookie).toBe(`unetlab_session=${SESSION}`);
    }
  });

  it("re-logs in ONCE and retries when a mid-crawl request 401s, and the sync still completes (⊘ surfacing the first 401 fails a sync that a single re-login would have saved — EVE-NG expires sessions aggressively)", async () => {
    let folderCalls = 0;
    let logins = 0;
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/auth/login") {
        logins++;
        return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}-${logins}`]);
      }
      if (path === "/api/status") return makeResponse(200, jsend({ version: "5.0.1-13" }));
      if (path.startsWith("/api/folders")) {
        folderCalls++;
        if (folderCalls === 1) return makeResponse(401, "session expired");
        return makeResponse(200, jsend({ folders: [], labs: [{ file: "L.unl", path: "/L.unl" }] }));
      }
      return makeResponse(200, jsend({ "1": node() }));
    }) as unknown as typeof fetch;

    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(logins).toBe(2);
  });

  it("surfaces `auth` — and stops — when the request 401s AGAIN after the silent re-login (⊘ retrying forever turns a wrong password into an unbounded login loop against the lab server)", async () => {
    let logins = 0;
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/auth/login") {
        logins++;
        return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      }
      if (path === "/api/status") return makeResponse(200, jsend({ version: "5.0.1-13" }));
      return makeResponse(401, "nope");
    }) as unknown as typeof fetch;

    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("auth");
    expect(logins).toBe(2);
  });

  it("treats a JSend `status:\"fail\"` login envelope as an auth failure even though the HTTP status is 200 (⊘ EVE-NG answers a bad password with HTTP 200 — a status-code-only check reads it as a successful login and fails later, somewhere else)", async () => {
    const fetchImpl = (async (input: string) => {
      if (new URL(input).pathname === "/api/auth/login") {
        // Cookie deliberately present: an implementation that ignores the
        // envelope has everything else it needs to believe the login worked.
        return makeResponse(200, { code: 401, status: "fail", message: "Unauthorized access (90403).", data: null }, [
          `unetlab_session=${SESSION}`
        ]);
      }
      return makeResponse(200, jsend({}));
    }) as unknown as typeof fetch;

    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("auth");
  });

  it("maps an HTTP 401 on login to `auth`", async () => {
    const fetchImpl = (async () => makeResponse(401, "denied")) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("auth");
  });

  it("refuses a login that succeeds but returns no session cookie (⊘ carrying on cookie-less produces a 401 on the next call and reports it as expired credentials, pointing the user at the wrong problem)", async () => {
    const fetchImpl = (async () => makeResponse(200, jsend(null), [])) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as Error).message.toLowerCase()).toContain("cookie");
  });
});

const PRO_WARNING =
  "EVE-NG Professional detected — Pro support is preliminary in this version; lab discovery and console mapping are validated against Community edition.";

describe("createEveNgProvider — edition detection", () => {
  it("says nothing about editions on Community (⊘ warning unconditionally trains users to ignore the warning that matters)", async () => {
    const tree = await fetchTree({ ...oneLabWorld({ "1": node() }), version: "5.0.1-13" });
    expect((tree.warnings ?? []).some((w) => w.includes("Professional"))).toBe(false);
  });

  /**
   * P2 (round 5) — some installs report the edition via a dedicated
   * `data.edition` field while `data.version` is just a numeric build string.
   * Detecting Pro from the version alone misses those, so the Pro-preliminary
   * warning never shows.
   */
  it("detects Pro from a `data.edition` field even when `data.version` is a plain numeric build, and warns exactly once (⊘ version-only detection returns community and the warning never appears)", async () => {
    const world: World = {
      version: "6.2.0-4",
      edition: "Professional",
      folders: { "/": { labs: [{ file: "A.unl", path: "/A.unl" }] } },
      nodes: { "/A.unl": { "1": node() } }
    };
    const tree = await fetchTree(world);
    expect((tree.warnings ?? []).filter((w) => w === PRO_WARNING)).toHaveLength(1);
  });

  it("still detects Pro from the legacy version string when there is no `edition` field (existing behavior preserved)", async () => {
    const tree = await fetchTree({ ...oneLabWorld({ "1": node() }), version: "5.0.1-24-pro" });
    expect((tree.warnings ?? []).filter((w) => w === PRO_WARNING)).toHaveLength(1);
  });

  it("stays Community when neither the edition field nor the version names pro (⊘ a stray `edition` presence must not itself trigger the warning)", async () => {
    const tree = await fetchTree({ ...oneLabWorld({ "1": node() }), version: "6.2.0-4", edition: "Community" });
    expect((tree.warnings ?? []).some((w) => w.includes("Professional"))).toBe(false);
  });

  it("appends the Pro-preliminary warning EXACTLY ONCE for a version naming pro, whatever its case (⊘ per-lab or per-node emission buries the plan summary under one copy per device)", async () => {
    const world: World = {
      version: "5.0.1-24-PRO",
      folders: { "/": { labs: [{ file: "A.unl", path: "/A.unl" }, { file: "B.unl", path: "/B.unl" }] } },
      nodes: { "/A.unl": { "1": node() }, "/B.unl": { "1": node(), "2": node({ id: "2", name: "R2" }) } }
    };
    const tree = await fetchTree(world);
    expect(tree.devices).toHaveLength(3);
    expect((tree.warnings ?? []).filter((w) => w === PRO_WARNING)).toHaveLength(1);
  });

  it("still syncs — and claims no edition — when /api/status is missing (⊘ failing the whole sync on an optional capability probe makes an older build unusable)", async () => {
    const tree = await fetchTree({ ...oneLabWorld({ "1": node() }), statusHttp: 404 });
    expect(tree.devices).toHaveLength(1);
    expect((tree.warnings ?? []).some((w) => w.includes("Professional"))).toBe(false);
  });
});

describe("createEveNgProvider — folder walk", () => {
  it("recurses into nested folders and collects labs from every level", async () => {
    const world: World = {
      folders: {
        "/": { folders: [{ name: "ACME", path: "/ACME" }], labs: [{ file: "Top.unl", path: "/Top.unl" }] },
        "/ACME": { folders: [{ name: "Edge", path: "/ACME/Edge" }], labs: [{ file: "Core.unl", path: "/ACME/Core.unl" }] },
        "/ACME/Edge": { labs: [{ file: "Deep.unl", path: "/ACME/Edge/Deep.unl" }] }
      },
      nodes: {
        "/Top.unl": { "1": node() },
        "/ACME/Core.unl": { "1": node() },
        "/ACME/Edge/Deep.unl": { "1": node() }
      }
    };
    const tree = await fetchTree(world);
    expect(tree.devices.map((d) => d.folderPath).sort()).toEqual(["ACME/Core", "ACME/Edge/Deep", "Top"]);
  });

  it("never leaves the Root Folder subtree — the \"..\" entry every listing carries points at an ancestor, and following any such path imports the whole server (⊘ the crawl escapes the scope Root Folder exists to define)", async () => {
    const world: World = {
      folders: {
        "/A": { labs: [{ file: "Escaped.unl", path: "/A/Escaped.unl" }] },
        "/A/Other": { labs: [{ file: "Sibling.unl", path: "/A/Other/Sibling.unl" }] },
        // Two ways out of the subtree: the ".." entry EVE-NG puts in every
        // listing, and a plain entry whose server-supplied path simply points
        // somewhere else. Neither may be followed.
        "/A/B": {
          folders: [{ name: "..", path: "/A" }, { name: "Other", path: "/A/Other" }],
          labs: [{ file: "Mine.unl", path: "/A/B/Mine.unl" }]
        }
      },
      nodes: {
        "/A/Escaped.unl": { "1": node() },
        "/A/Other/Sibling.unl": { "1": node() },
        "/A/B/Mine.unl": { "1": node() }
      }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, rootFolder: "/A/B" }, SECRETS);
    expect(tree.devices.map((d) => d.externalId)).toEqual(["/A/B/Mine.unl#1"]);
    expect(calls.filter((c) => c.url.includes("/api/folders"))).toHaveLength(1);
  });

  it("visits each folder path at most once, so a listing naming an already-visited path cannot loop (⊘ a name-based \"..\" check alone misses a cycle spelled with real folder names)", async () => {
    const world: World = {
      folders: {
        "/": { folders: [{ name: "A", path: "/A" }] },
        "/A": { folders: [{ name: "B", path: "/A/B" }] },
        "/A/B": { folders: [{ name: "A", path: "/A" }], labs: [{ file: "L.unl", path: "/A/B/L.unl" }] }
      },
      nodes: { "/A/B/L.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/api/folders"))).toHaveLength(3);
  });

  it("stops descending past the depth cap, and says so rather than silently returning a partial tree (⊘ a silent stop reads as \"those labs were deleted\" and the prune policy removes their servers)", async () => {
    const folders: Record<string, FolderListing> = {};
    let path = "";
    for (let i = 0; i <= 20; i++) {
      const child = `${path}/d${i}`;
      folders[path === "" ? "/" : path] = { folders: [{ name: `d${i}`, path: child }] };
      path = child;
    }
    const tree = await fetchTree({ folders });
    expect(tree.truncated).toBe(true);
    expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("deep"))).toBe(true);
  });

  /**
   * P2-2 — at the depth cap, `truncated` must reflect whether a genuinely
   * DESCENDABLE in-scope unvisited child remains, not merely `folders.length >
   * 0`. Every EVE-NG listing carries a `..` parent entry, so a valid tree whose
   * deepest folder sits exactly at the cap would otherwise be marked truncated
   * forever — and `computeSyncPlan` would then never prune the servers of
   * genuinely deleted nodes.
   */
  it("P2-2 — a folder exactly at the depth cap whose only child entries are `..`, out-of-scope, or already-visited does NOT mark the tree truncated (⊘ counting `folders.length` treats the ever-present `..` entry as unfinished work and disables pruning forever)", async () => {
    const root = "/A";
    const folders: Record<string, FolderListing> = {};
    let path = root;
    // root (depth 0) -> /A/d1 (1) -> ... -> leaf at depth MAX_FOLDER_DEPTH (12).
    for (let d = 1; d <= 12; d++) {
      const child = `${path}/d${d}`;
      folders[path] = { folders: [{ name: `d${d}`, path: child }] };
      path = child;
    }
    const parentOfLeaf = path.slice(0, path.lastIndexOf("/")); // depth-11, already visited
    // The leaf's only folder entries are all non-descendable.
    folders[path] = {
      folders: [
        { name: "..", path: parentOfLeaf }, // parent — visited
        { name: "seen", path: root }, // root — visited
        { name: "escape", path: "/SECRET/x" } // out of the /A subtree
      ]
    };
    const tree = await fetchTree({ folders }, { rootFolder: root });
    expect(tree.truncated).toBeFalsy();
    expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("deep"))).toBe(false);
  });

  it("P2-2 — but a REAL unvisited in-scope child beyond the depth cap still marks the tree truncated, so its unreached labs are not pruned (⊘ over-correcting would silently drop a genuinely deeper subtree)", async () => {
    const root = "/A";
    const folders: Record<string, FolderListing> = {};
    let path = root;
    for (let d = 1; d <= 12; d++) {
      const child = `${path}/d${d}`;
      folders[path] = { folders: [{ name: `d${d}`, path: child }] };
      path = child;
    }
    folders[path] = { folders: [{ name: "deeper", path: `${path}/deeper` }] }; // in-scope, unvisited, below the cap
    const tree = await fetchTree({ folders }, { rootFolder: root });
    expect(tree.truncated).toBe(true);
    expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("deep"))).toBe(true);
  });

  // E-2 (Fable) — the "Stopped after N labs" warning fired whenever
  // `labs.length >= MAX_LABS && truncated`, so a tree with EXACTLY the cap of labs
  // that was truncated for an UNRELATED reason (the depth cap here) wrongly claimed
  // labs were dropped when none were. ⊘ Gate on `labs.length >= MAX_LABS` and it
  // fires at exact capacity with no lab skipped.
  it("E-2 — does NOT claim labs were dropped when exactly the cap was collected and truncation came from the depth cap", async () => {
    const folders: Record<string, FolderListing> = {};
    // Root carries exactly MAX_LABS (1000) labs — all pushed, none skipped for the
    // cap — plus a chain deeper than the folder-depth cap to set `truncated`.
    const labs = Array.from({ length: 1000 }, (_, i) => ({ file: `L${i}.unl`, path: `/L${i}.unl` }));
    let path = "/deep0";
    folders["/"] = { folders: [{ name: "deep0", path: "/deep0" }], labs };
    for (let d = 1; d <= 20; d++) {
      const child = `${path}/d${d}`;
      folders[path] = { folders: [{ name: `d${d}`, path: child }] };
      path = child;
    }
    const tree = await fetchTree({ folders });
    // Truncated by the depth cap...
    expect(tree.truncated).toBe(true);
    expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("deep"))).toBe(true);
    // ...but NO lab was skipped for the lab cap, so no "Stopped after N labs".
    expect((tree.warnings ?? []).some((w) => /stopped after \d+ labs/i.test(w))).toBe(false);
  });

  it("E-2 control — DOES warn when a lab is genuinely skipped for the cap (⊘ gating on labsCapped must still fire when labs really were dropped)", async () => {
    const labs = Array.from({ length: 1001 }, (_, i) => ({ file: `L${i}.unl`, path: `/L${i}.unl` }));
    const tree = await fetchTree({ folders: { "/": { labs } } });
    expect((tree.warnings ?? []).some((w) => /stopped after \d+ labs/i.test(w))).toBe(true);
  });

  it("percent-encodes each path segment, so a lab or folder named with a space or a hash is actually requested (⊘ interpolating the raw path lets the hash start a URL fragment, and the request lands on a truncated path)", async () => {
    const world: World = {
      folders: {
        "/": { folders: [{ name: "My Labs", path: "/My Labs" }] },
        "/My Labs": { labs: [{ file: "Lab #1.unl", path: "/My Labs/Lab #1.unl" }] }
      },
      nodes: { "/My Labs/Lab #1.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(calls.map((c) => c.url)).toContain("http://eve.example.com/api/folders/My%20Labs");
    // ⊘ `new URL` would silently rescue a raw SPACE, so the lab name also
    // carries a "#": interpolated raw, everything from it on becomes a URL
    // FRAGMENT and the request lands on "/api/labs/My%20Labs/Lab".
    expect(calls.map((c) => c.url)).toContain("http://eve.example.com/api/labs/My%20Labs/Lab%20%231.unl/nodes");
    // ⊘ A whole-path encodeURIComponent would escape the separators too.
    expect(calls.every((c) => !c.url.includes("%2F"))).toBe(true);
  });

  it("starts the walk at rootFolder and never lists anything above it (⊘ ignoring rootFolder imports the entire server, which is what the field exists to prevent)", async () => {
    const world: World = {
      folders: {
        "/": { folders: [{ name: "ACME", path: "/ACME" }], labs: [{ file: "Elsewhere.unl", path: "/Elsewhere.unl" }] },
        "/ACME": { labs: [{ file: "Mine.unl", path: "/ACME/Mine.unl" }] }
      },
      nodes: { "/ACME/Mine.unl": { "1": node() }, "/Elsewhere.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, rootFolder: "/ACME" }, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(tree.devices[0].folderPath).toBe("Mine");
    expect(calls.some((c) => c.url.endsWith("/api/folders/"))).toBe(false);
  });

  /**
   * MAJOR-1(a) — lab entries are server-supplied and were used verbatim. A
   * hostile (or misconfigured) server can answer a request scoped to `/A/B`
   * with a lab whose path is `/SECRET/Other.unl`; the crawl then fetches that
   * lab's nodes — with the session cookie attached — and imports a device from
   * outside the Root Folder the user set to bound the scan.
   */
  it("MAJOR-1(a) — refuses a lab whose path escapes the Root Folder subtree, warns, and never requests its nodes (⊘ using labs[].path verbatim imports a device from /SECRET on a request scoped to /A/B)", async () => {
    const world: World = {
      folders: { "/A/B": { labs: [{ file: "Other.unl", path: "/SECRET/Other.unl" }, { file: "Mine.unl", path: "/A/B/Mine.unl" }] } },
      nodes: { "/SECRET/Other.unl": { "1": node() }, "/A/B/Mine.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, rootFolder: "/A/B" }, SECRETS);
    expect(tree.devices.map((d) => d.externalId)).toEqual(["/A/B/Mine.unl#1"]);
    expect(calls.some((c) => c.url.includes("SECRET"))).toBe(false);
    expect((tree.warnings ?? []).some((w) => /outside the Root Folder/i.test(w))).toBe(true);
    // A hostile out-of-scope lab is not a hard cap; pruning must stay enabled.
    expect(tree.truncated).toBeFalsy();
  });

  /**
   * P1 (data-loss) — the OPPOSITE treatment to the malformed-node case, and the
   * asymmetry is the point. A malformed LAB entry inside an accepted `labs`
   * array has NO recoverable identity: you cannot enumerate which nodes it
   * should contain, so there is no safe placeholder to emit. Skip-and-continue
   * would omit an UNKNOWN number of real servers while leaving the tree
   * non-truncated → computeSyncPlan prunes them all. So this FAILS the sync.
   */
  it("P1 — fails the sync on a non-object lab entry inside a valid labs array, rather than skipping it (⊘ `continue` omits every node of that lab and prunes its servers)", async () => {
    for (const badLab of [null, "L.unl", 42]) {
      const world: World = {
        folders: { "/": { folders: [], labs: [{ file: "Good.unl", path: "/Good.unl" }, badLab as never] } },
        nodes: { "/Good.unl": { "1": node() } }
      };
      const { fetchImpl } = makeWorld(world);
      const err = await createEveNgProvider(fetchImpl)
        .fetchInventory(CONFIG, SECRETS)
        .catch((e: unknown) => e);
      expect(err, `lab=${JSON.stringify(badLab)}`).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, `lab=${JSON.stringify(badLab)}`).toBe("protocol");
    }
  });

  it("P1 — the sync fails ATOMICALLY: a valid sibling lab is not partially imported alongside a malformed one (⊘ importing the good lab while dropping the bad one still prunes the bad lab's servers)", async () => {
    const world: World = {
      folders: { "/": { folders: [], labs: [{ file: "Good.unl", path: "/Good.unl" }, null as never] } },
      nodes: { "/Good.unl": { "1": node() } }
    };
    const { fetchImpl } = makeWorld(world);
    const result = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .then(() => "resolved" as const)
      .catch(() => "rejected" as const);
    expect(result).toBe("rejected");
  });

  it("P1 — fails the sync on a lab entry that is a valid object but carries no usable `.unl` path (⊘ silently dropping it has the same prune consequence as a non-object entry)", async () => {
    for (const badLab of [{ file: "", path: "" }, { name: "x" }, { path: "/NotALab" }]) {
      const world: World = {
        folders: { "/": { folders: [], labs: [{ file: "Good.unl", path: "/Good.unl" }, badLab as never] } },
        nodes: { "/Good.unl": { "1": node() } }
      };
      const { fetchImpl } = makeWorld(world);
      const err = await createEveNgProvider(fetchImpl)
        .fetchInventory(CONFIG, SECRETS)
        .catch((e: unknown) => e);
      expect(err, `lab=${JSON.stringify(badLab)}`).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, `lab=${JSON.stringify(badLab)}`).toBe("protocol");
    }
  });

  /**
   * P1 (data-loss) — the last member of the containment hierarchy (envelope →
   * node → lab → FOLDER). A malformed CHILD-FOLDER entry has no recoverable
   * descendant identity: skipping it omits an UNKNOWN subtree of servers while
   * the tree stays non-truncated, so computeSyncPlan prunes them. Same treatment
   * as the malformed-lab case — FAIL the sync. The CRITICAL distinction is that
   * only "malformed" fails; the LEGITIMATELY not-descendable entries (`..`,
   * out-of-scope, visited, dot-segment) keep being skipped.
   */
  it("P1 — fails the sync on a non-object child-folder entry, rather than dropping its subtree (⊘ `continue` omits an unknown subtree and prunes its servers)", async () => {
    for (const badFolder of [null, "F", 42]) {
      const world: World = {
        folders: { "/": { folders: [{ name: "Good", path: "/Good" }, badFolder as never], labs: [] }, "/Good": { labs: [{ file: "L.unl", path: "/Good/L.unl" }] } },
        nodes: { "/Good/L.unl": { "1": node() } }
      };
      const { fetchImpl } = makeWorld(world);
      const err = await createEveNgProvider(fetchImpl)
        .fetchInventory(CONFIG, SECRETS)
        .catch((e: unknown) => e);
      expect(err, `folder=${JSON.stringify(badFolder)}`).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, `folder=${JSON.stringify(badFolder)}`).toBe("protocol");
    }
  });

  it("P1 — fails the sync on a child-folder entry that is a valid object with no usable `path` (⊘ an empty/blank path is silently skipped, dropping the subtree it should have named)", async () => {
    for (const badFolder of [{ name: "x" }, { name: "x", path: "" }, { path: "   " }]) {
      const world: World = {
        folders: { "/": { folders: [{ name: "Good", path: "/Good" }, badFolder as never], labs: [] }, "/Good": { labs: [{ file: "L.unl", path: "/Good/L.unl" }] } },
        nodes: { "/Good/L.unl": { "1": node() } }
      };
      const { fetchImpl } = makeWorld(world);
      const err = await createEveNgProvider(fetchImpl)
        .fetchInventory(CONFIG, SECRETS)
        .catch((e: unknown) => e);
      expect(err, `folder=${JSON.stringify(badFolder)}`).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, `folder=${JSON.stringify(badFolder)}`).toBe("protocol");
    }
  });

  it("P1 — does NOT fail on LEGITIMATELY non-descendable folder entries (`..`, out-of-scope, already-visited) — every EVE-NG listing carries `..`, so failing on these makes normal trees unsyncable (⊘ over-correcting turns the skip cases into sync failures)", async () => {
    const world: World = {
      folders: {
        "/A": {
          folders: [
            { name: "..", path: "/" }, // the ubiquitous parent entry
            { name: "escape", path: "/SECRET" }, // out-of-scope
            { name: "A", path: "/A" }, // already-visited (the root itself)
            { name: "Sub", path: "/A/Sub" } // a real descendable child
          ],
          labs: [{ file: "Top.unl", path: "/A/Top.unl" }]
        },
        "/A/Sub": { folders: [], labs: [{ file: "Deep.unl", path: "/A/Sub/Deep.unl" }] },
        "/SECRET": { labs: [{ file: "Leak.unl", path: "/SECRET/Leak.unl" }] }
      },
      nodes: { "/A/Top.unl": { "1": node() }, "/A/Sub/Deep.unl": { "1": node() }, "/SECRET/Leak.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, rootFolder: "/A" }, SECRETS);
    // Completed without throwing; descended only into the real child, and the
    // out-of-scope subtree was never even requested.
    expect(tree.devices.map((d) => d.externalId).sort()).toEqual(["/A/Sub/Deep.unl#1", "/A/Top.unl#1"]);
    expect(calls.some((c) => c.url.includes("SECRET"))).toBe(false);
    expect(tree.truncated).toBeFalsy();
  });

  it("MAJOR-1(b) — refuses a folder child path containing a `..` segment BEFORE requesting it, so `new URL` cannot collapse it to a different origin path after the guard approved it (⊘ isWithin runs on the pre-normalized path — `/A/../../secret` startsWith `/A/`, passes, then the fetch lands on /api/secret with the cookie)", async () => {
    const world: World = {
      folders: {
        "/A": { folders: [{ name: "evil", path: "/A/../../secret" }], labs: [{ file: "Mine.unl", path: "/A/Mine.unl" }] },
        "/secret": { labs: [{ file: "Leak.unl", path: "/secret/Leak.unl" }] }
      },
      nodes: { "/A/Mine.unl": { "1": node() }, "/secret/Leak.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, rootFolder: "/A" }, SECRETS);
    expect(tree.devices.map((d) => d.externalId)).toEqual(["/A/Mine.unl#1"]);
    // ⊘ The collapsed path must never be requested.
    expect(calls.some((c) => new URL(c.url).pathname === "/api/secret")).toBe(false);
    expect(calls.some((c) => new URL(c.url).pathname.includes("/secret"))).toBe(false);
  });

  it("MAJOR-1(b) — refuses a lab path containing a `..` segment before building the node request (⊘ `/A/../../../etc/x.unl` collapses to /api/labs/etc/x.unl/nodes, carrying the cookie off to an unintended path)", async () => {
    const world: World = {
      folders: { "/A": { labs: [{ file: "x.unl", path: "/A/../../../etc/x.unl" }, { file: "Mine.unl", path: "/A/Mine.unl" }] } },
      nodes: { "/etc/x.unl": { "1": node() }, "/A/Mine.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, rootFolder: "/A" }, SECRETS);
    expect(tree.devices.map((d) => d.externalId)).toEqual(["/A/Mine.unl#1"]);
    expect(calls.some((c) => new URL(c.url).pathname.includes("/etc/"))).toBe(false);
    expect((tree.warnings ?? []).some((w) => /outside the Root Folder/i.test(w))).toBe(true);
  });

  it("rejects a Root Folder that itself carries a `.`/`..` segment rather than letting `new URL` silently collapse it into an unintended scope (⊘ user config `/A/../secret` scans /secret without saying so)", async () => {
    const world: World = { folders: { "/": {} }, nodes: {} };
    const { fetchImpl } = makeWorld(world);
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory({ ...CONFIG, rootFolder: "/A/../secret" }, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as Error).message.toLowerCase()).toContain("root folder");
  });

  /**
   * MINOR-1 — the request budget stops the walk once, warns once. The old code
   * pushed the warning inside the per-item loop and then let `queue = next`
   * run, so the next level re-hit the budget and warned again (and the
   * `queue = []` it set was dead — immediately overwritten).
   */
  it("MINOR-1 — stops at the folder-listing budget, warns exactly once, and issues no more than the budget of listings (⊘ warning inside the loop fires again for each level already queued when the budget hit; the dead `queue = []` never stops anything)", async () => {
    // NESTED on purpose: each level-1 folder enqueues a grandchild, so when the
    // budget trips mid-level the `next` queue is NON-empty — which is exactly
    // when the old in-loop warning re-fired on the following iteration. A flat
    // tree would leave `next` empty and hide the double-warning.
    const top = Array.from({ length: 2_100 }, (_, i) => ({ name: `f${i}`, path: `/f${i}` }));
    const folders: Record<string, FolderListing> = { "/": { folders: top } };
    for (const f of top) folders[f.path] = { folders: [{ name: "c", path: `${f.path}/c` }] };
    const { fetchImpl, calls } = makeWorld({ folders });
    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    const budgetWarnings = (tree.warnings ?? []).filter((w) => /folder listings/i.test(w));
    expect(budgetWarnings).toHaveLength(1);
    expect(tree.truncated).toBe(true);
    const folderRequests = calls.filter((c) => c.url.includes("/api/folders"));
    expect(folderRequests.length).toBeLessThanOrEqual(2_000);
    expect(folderRequests.length).toBeGreaterThan(1_900);
  });

  /**
   * MINOR-12 — a folder or lab that 404s mid-walk (deleted between its parent's
   * listing and its own fetch) is skipped with a warning, not aborted. A live
   * lab tree will hit this, and failing the whole sync over one deleted folder
   * updates NOTHING.
   */
  it("MINOR-12 — skips a child folder / lab that 404s mid-walk and warns, rather than aborting the whole sync (⊘ one 404 throws and no lab is updated)", async () => {
    const fetchImpl = (async (input: string) => {
      const path = decodeURIComponent(new URL(input).pathname);
      if (path.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (path.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      if (path === "/api/folders/") {
        return makeResponse(200, jsend({ folders: [{ name: "Ghost", path: "/Ghost" }], labs: [{ file: "Good.unl", path: "/Good.unl" }, { file: "Gone.unl", path: "/Gone.unl" }] }));
      }
      if (path === "/api/folders/Ghost") return makeResponse(404, "gone");
      if (path === "/api/labs/Good.unl/nodes") return makeResponse(200, jsend({ "1": node() }));
      if (path === "/api/labs/Gone.unl/nodes") return makeResponse(404, "gone");
      return makeResponse(404, "nf");
    }) as unknown as typeof fetch;
    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices.map((d) => d.externalId)).toEqual(["/Good.unl#1"]);
    expect((tree.warnings ?? []).some((w) => /not found|removed|skipped/i.test(w))).toBe(true);
  });

  it("MINOR-12 — a 404 on the ROOT folder is a hard error, since an empty result would prune every server the source owns (⊘ treating root-gone as 'no labs' deletes the whole inventory)", async () => {
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (path.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      return makeResponse(404, "gone");
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory({ ...CONFIG, rootFolder: "/Nope" }, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
  });
});

describe("createEveNgProvider — nodes", () => {
  it("reads the object-keyed `data` map EVE-NG returns and keys each device by its map key", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node(), "7": node({ id: "7", name: "R7" }) }));
    expect(tree.devices.map((d) => d.externalId).sort()).toEqual(["/Lab 1.unl#1", "/Lab 1.unl#7"]);
  });

  it("accepts the EMPTY ARRAY a lab with no nodes returns instead of an empty object (⊘ Object.entries([]) is fine but a shape check demanding an object throws, failing the whole sync for one empty lab)", async () => {
    const world: World = {
      folders: { "/": { labs: [{ file: "Empty.unl", path: "/Empty.unl" }, { file: "Full.unl", path: "/Full.unl" }] } },
      nodes: { "/Empty.unl": [], "/Full.unl": { "1": node() } }
    };
    const tree = await fetchTree(world);
    expect(tree.devices).toHaveLength(1);
  });

  /**
   * P1 (data-loss, one level deeper) — a malformed node VALUE inside an
   * ACCEPTED node map has a recoverable identity (its map key), so it must be
   * PRESERVED as an endpoint-less placeholder rather than filtered out. Dropping
   * it removes its externalId while leaving the tree non-truncated, so
   * computeSyncPlan reads it as deleted and prunes its server + credentials on
   * the next sync of an otherwise-healthy lab.
   */
  it("P1-a — a NON-OBJECT node value FAILS the sync as protocol, rather than becoming an addressless placeholder (⊘ now that endpoint-less = an ACTIVE downgrade, a placeholder would clear a working sibling server's host over a transient corruption of one node value)", async () => {
    for (const bad of [42, "garbage", null]) {
      const err = await fetchTree(oneLabWorld({ "1": node(), "2": bad as never }))
        .then(() => "resolved" as const)
        .catch((e: unknown) => e);
      expect(err, `value=${JSON.stringify(bad)}`).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, `value=${JSON.stringify(bad)}`).toBe("protocol");
    }
  });

  it("P1-a — a VALID node OBJECT with no telnet console STILL becomes an endpoint-less (addressless) device — the split is object-validity, NOT endpoint-presence (⊘ over-correcting fails the sync for a merely-stopped node the placeholder feature exists for)", async () => {
    const tree = await fetchTree(
      oneLabWorld({
        "1": node({ status: 0, url: "" }), // stopped Community node
        "2": node({ id: "2", name: "V1", console: "vnc", url: "http://eve.example.com/html5/vnc.html" }) // VNC console
      })
    );
    expect(tree.devices).toHaveLength(2);
    expect(tree.devices.every((d) => d.endpoints.length === 0)).toBe(true);
    expect(tree.truncated).toBeFalsy();
  });

  it("P1-a — a prototype-polluting map key (`__proto__` / `constructor`) with a valid node OBJECT value yields a plain-string externalId and never touches Object.prototype (⊘ a naive object-keyed write would pollute the prototype chain)", async () => {
    // Raw JSON body so the keys are OWN properties on the parsed object. The
    // values are valid node objects (a non-object value now FAILS the sync).
    const validNode = '{"id":"n","name":"N","console":"telnet","url":"telnet://10.0.0.5:23","status":2}';
    const rawNodes = `{"code":200,"status":"success","message":"","data":{"__proto__":${validNode},"constructor":${validNode},"1":${validNode}}}`;
    const fetchImpl = (async (input: string) => {
      const path = decodeURIComponent(new URL(input).pathname);
      if (path.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (path.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      if (path === "/api/folders/") return makeResponse(200, jsend({ folders: [], labs: [{ file: "L.unl", path: "/L.unl" }] }));
      return makeResponse(200, rawNodes);
    }) as unknown as typeof fetch;

    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices.some((d) => d.externalId === "/L.unl#__proto__")).toBe(true);
    expect(tree.devices.some((d) => d.externalId === "/L.unl#constructor")).toBe(true);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("maps status 2 to running and everything else to stopped", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node({ status: 2 }), "2": node({ id: "2", status: 0 }), "3": node({ id: "3", status: 3 }) }));
    const statusOf = (id: string) => tree.devices.find((d) => d.externalId.endsWith(`#${id}`))?.attributes?.status;
    expect(statusOf("1")).toBe("running");
    expect(statusOf("2")).toBe("stopped");
    expect(statusOf("3")).toBe("stopped");
  });

  it("omits stopped nodes when includeStopped is false, and keeps them when it is absent (⊘ reading an absent value as false silently drops every stopped node from a source the user never configured that way)", async () => {
    const world = oneLabWorld({ "1": node({ status: 2 }), "2": node({ id: "2", name: "R2", status: 0 }) });
    expect((await fetchTree(world, { includeStopped: false })).devices.map((d) => d.name)).toEqual(["R1"]);
    expect((await fetchTree(world)).devices).toHaveLength(2);
    expect((await fetchTree(world, { includeStopped: true })).devices).toHaveLength(2);
  });

  /**
   * M42 — the filter matches the lab's FULL PATH, not just its name. The
   * fixture deliberately separates the two: `Core.unl` sits in `/ACME`, whose
   * only occurrence of "acme" is in the DIRECTORY, not the filename — so a
   * name-only matcher would drop it. And `Edge.unl` carries "edge" in its
   * NAME. Testing both directions verifies "full path", not one side of it.
   */
  it("M42 — filters on the lab's FULL PATH (directory included), not just its name, in both directions (⊘ a name-only matcher drops `/ACME/Core.unl` under filter `acme`)", async () => {
    const world: World = {
      folders: {
        "/": { folders: [{ name: "ACME", path: "/ACME" }, { name: "Other", path: "/Other" }] },
        "/ACME": { labs: [{ file: "Core.unl", path: "/ACME/Core.unl" }] },
        "/Other": { labs: [{ file: "Edge.unl", path: "/Other/Edge.unl" }] }
      },
      nodes: { "/ACME/Core.unl": { "1": node() }, "/Other/Edge.unl": { "1": node() } }
    };
    // "acme" appears only in Core's DIRECTORY.
    expect((await fetchTree(world, { filter: "acme" })).devices.map((d) => d.attributes?.lab)).toEqual(["Core"]);
    // "edge" appears in Edge's NAME.
    expect((await fetchTree(world, { filter: "edge" })).devices.map((d) => d.attributes?.lab)).toEqual(["Edge"]);
    // A substring in neither path matches nothing.
    expect((await fetchTree(world, { filter: "zzz" })).devices).toHaveLength(0);
  });

  it("M41 — matches case-insensitively on BOTH sides: an UPPERCASE filter against a lowercase path, and vice versa (⊘ lower-casing only one side misses the other)", async () => {
    const lowerWorld: World = { folders: { "/": { labs: [{ file: "core.unl", path: "/acme/core.unl" }] } }, nodes: { "/acme/core.unl": { "1": node() } } };
    expect((await fetchTree(lowerWorld, { filter: "ACME" })).devices).toHaveLength(1);
    const upperWorld: World = { folders: { "/": { labs: [{ file: "CORE.unl", path: "/ACME/CORE.unl" }] } }, nodes: { "/ACME/CORE.unl": { "1": node() } } };
    expect((await fetchTree(upperWorld, { filter: "acme" })).devices).toHaveLength(1);
  });

  it("never even asks for a non-matching lab's nodes (⊘ filtering after the node fetch still leaks a request for every lab)", async () => {
    const world: World = {
      folders: { "/": { labs: [{ file: "ACME Core.unl", path: "/ACME Core.unl" }, { file: "Other.unl", path: "/Other.unl" }] } },
      nodes: { "/ACME Core.unl": { "1": node() }, "/Other.unl": { "1": node() } }
    };
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, filter: "acme" }, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("Other.unl"))).toBe(false);
  });
});

/**
 * MINOR-2 — `labFolderPath` stripped the root prefix with a raw `startsWith`,
 * so a sibling folder sharing the prefix as a substring (`/CustXtra` vs
 * `/Cust`) had the wrong number of characters shaved off. MAJOR-1's confinement
 * now blocks such a lab from reaching this function through the public API, so
 * it is exercised directly to keep the boundary honest.
 */
describe("labFolderPath", () => {
  it("strips the root prefix on a SEGMENT boundary, not by raw string prefix (⊘ `/CustXtra` under root `/Cust` becomes `Xtra/L`, mangling the folder)", () => {
    expect(labFolderPath({ path: "/Cust/ACME/Site.unl", name: "Site" }, "/Cust")).toBe("ACME/Site");
    expect(labFolderPath({ path: "/CustXtra/L.unl", name: "L" }, "/Cust")).toBe("CustXtra/L");
  });

  it("places a lab sitting directly in the root at the root of the source's target folder", () => {
    expect(labFolderPath({ path: "/Cust/Only.unl", name: "Only" }, "/Cust")).toBe("Only");
  });

  it("with an empty root prefix (whole-tree scan) keeps the absolute folder path, minus the leading slash", () => {
    expect(labFolderPath({ path: "/A/B/Lab.unl", name: "Lab" }, "")).toBe("A/B/Lab");
  });
});

describe("createEveNgProvider — device mapping", () => {
  it("builds externalId as `${labPath}#${nodeId}` so two labs' node 1 never collide (⊘ a bare node id makes every lab's node 1 the same device, and the sync collapses the whole server into one record)", async () => {
    const world: World = {
      folders: { "/": { labs: [{ file: "A.unl", path: "/A.unl" }, { file: "B.unl", path: "/B.unl" }] } },
      nodes: { "/A.unl": { "1": node() }, "/B.unl": { "1": node() } }
    };
    const tree = await fetchTree(world);
    expect(tree.devices.map((d) => d.externalId).sort()).toEqual(["/A.unl#1", "/B.unl#1"]);
  });

  it("puts each lab in its own folder, relative to rootFolder, with the lab name (minus .unl) as the last segment", async () => {
    const world: World = {
      folders: {
        "/Customers": { folders: [{ name: "ACME", path: "/Customers/ACME" }] },
        "/Customers/ACME": { labs: [{ file: "Site 1.unl", path: "/Customers/ACME/Site 1.unl" }] }
      },
      nodes: { "/Customers/ACME/Site 1.unl": { "1": node() } }
    };
    const tree = await fetchTree(world, { rootFolder: "/Customers" });
    // ⊘ Using the ABSOLUTE lab path would nest every device under a
    // "Customers" folder inside the source's own targetFolder.
    expect(tree.devices[0].folderPath).toBe("ACME/Site 1");
  });

  it("maps a native telnet console URL onto a telnet endpoint with its port", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node({ url: "telnet://10.0.0.9:32770" }) }));
    expect(tree.devices[0].endpoints).toEqual([{ kind: "telnet", host: "10.0.0.9", port: 32770 }]);
  });

  it("substitutes the base URL's host when EVE-NG reports the console on loopback or 0.0.0.0 (⊘ keeping 127.0.0.1 points every console at the USER'S OWN machine — the connection succeeds against whatever is local, or fails opaquely)", async () => {
    for (const reported of ["telnet://127.0.0.1:32769", "telnet://0.0.0.0:32769", "telnet://localhost:32769", "telnet://[::1]:32769"]) {
      const tree = await fetchTree(oneLabWorld({ "1": node({ url: reported }) }));
      expect(tree.devices[0].endpoints[0].host).toBe("eve.example.com");
      expect(tree.devices[0].endpoints[0].port).toBe(32769);
    }
  });

  it("keeps a routable host EVE-NG reports rather than rewriting it to the base URL host", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node({ url: "telnet://192.0.2.50:32769" }) }));
    expect(tree.devices[0].endpoints[0].host).toBe("192.0.2.50");
  });

  it("lets consoleHost beat BOTH the reported host and the base URL host — it exists for the NAT case where neither is reachable", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node({ url: "telnet://192.0.2.50:32769" }) }), { consoleHost: "nat.example.com" });
    expect(tree.devices[0].endpoints[0].host).toBe("nat.example.com");
    const loopback = await fetchTree(oneLabWorld({ "1": node({ url: "telnet://127.0.0.1:32769" }) }), { consoleHost: "nat.example.com" });
    expect(loopback.devices[0].endpoints[0].host).toBe("nat.example.com");
  });

  it("emits a node with a non-telnet console (or no console URL at all) WITH NO ENDPOINTS rather than dropping it, and says NOTHING about them in its own warnings (⊘ dropping the device reads as \"deleted at the source\" and prunes the server; ⊘ a provider-side aggregate duplicates the sync engine's addressless line)", async () => {
    const tree = await fetchTree(
      oneLabWorld({
        "1": node(),
        "2": node({ id: "2", name: "V1", console: "vnc", url: "http://eve.example.com/html5/vnc.html?token=x" }),
        "3": node({ id: "3", name: "D1", console: "telnet", url: "" }),
        "4": node({ id: "4", name: "B1", console: "telnet", url: "not a url" })
      })
    );
    expect(tree.devices).toHaveLength(4);
    for (const id of ["2", "3", "4"]) {
      expect(tree.devices.find((d) => d.externalId.endsWith(`#${id}`))?.endpoints).toEqual([]);
    }
    // ONE ADDRESSLESS LINE (follow-up 1) — the provider used to push its own
    // aggregate here ("3 nodes have no telnet console URL … were imported without
    // a connection endpoint."). It overlapped the sync engine's addressless line,
    // so a sync showed two lines about intersecting sets of nodes. The engine owns
    // the disclosure now: it is the only layer that knows whether each of these
    // became a placeholder this run or already was one.
    //
    // R6 (review) — asserted as NO warnings at all, matching the NetBox twin,
    // rather than filtering for the old wording. A filter on "telnet console"
    // only forbids the sentence that was deleted: a re-introduced aggregate
    // phrased any other way ("3 nodes have no console URL and were imported
    // without an endpoint.") would slip past it, and no engine test would catch
    // it either, since the engine suites never run through this provider.
    expect(tree.warnings ?? []).toEqual([]);
  });

  /**
   * MINOR-3 — a console URL with no usable host must mint NO endpoint. The
   * failure mode is `new URL("telnet:1.2.3.4:9000")` (no `//`) and
   * `new URL("telnet://")` both parsing to an EMPTY hostname, which
   * `isHostLocalOnly("")` calls loopback and substitutes the EVE-NG host for —
   * so the user gets a server pointed at port 23 of the EVE box, believing it
   * is a node.
   */
  it("mints no endpoint for a console URL whose host is empty (⊘ empty host reads as loopback and points the server at the EVE box itself)", async () => {
    const tree = await fetchTree(
      oneLabWorld({
        "1": node({ url: "telnet:1.2.3.4:9000" }), // no "//" — opaque, empty hostname
        "2": node({ id: "2", name: "B", url: "telnet://" }),
        "3": node({ id: "3", name: "C", url: "telnet://192.0.2.9:9000" })
      })
    );
    expect(tree.devices.find((d) => d.externalId.endsWith("#1"))?.endpoints).toEqual([]);
    expect(tree.devices.find((d) => d.externalId.endsWith("#2"))?.endpoints).toEqual([]);
    expect(tree.devices.find((d) => d.externalId.endsWith("#3"))?.endpoints).toEqual([{ kind: "telnet", host: "192.0.2.9", port: 9000 }]);
    // No provider-side addressless aggregate (follow-up 1) — the endpoint
    // suppression above is this test's subject, and the sync engine reports the
    // two endpoint-less nodes. Asserted strictly (R6): see the note on the
    // sibling above for why a wording-specific filter is not enough.
    expect(tree.warnings ?? []).toEqual([]);
  });

  it("mints no endpoint for a telnet console reported on port 0 (⊘ M18 — a port-0 endpoint dials port 0, which never connects)", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node({ url: "telnet://192.0.2.9:0" }) }));
    expect(tree.devices[0].endpoints).toEqual([]);
  });

  it("substitutes an IPv6 base-URL host WITHOUT brackets, so a loopback console maps to an address net.connect can dial (⊘ `new URL(...).hostname` keeps the brackets on `[::1]`, and the endpoint host is then unusable)", async () => {
    const { fetchImpl } = makeWorld(oneLabWorld({ "1": node({ url: "telnet://127.0.0.1:32769" }) }));
    const tree = await createEveNgProvider(fetchImpl).fetchInventory({ ...CONFIG, baseUrl: "http://[2001:db8::5]:8080" }, SECRETS);
    expect(tree.devices[0].endpoints[0].host).toBe("2001:db8::5");
  });

  it("names a blank-named node `node-<id>` instead of dropping it (⊘ dropping it for a cosmetic data problem prunes a server that still exists)", async () => {
    const tree = await fetchTree(oneLabWorld({ "9": node({ id: "9", name: "   " }) }));
    expect(tree.devices).toHaveLength(1);
    expect(tree.devices[0].name).toBe("node-9");
  });

  it("carries the lab/template/type/console/status/image/name attributes a template rule filters on, omitting the ones EVE-NG left blank (⊘ emitting empty strings makes `image=` match every diskless node)", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node({ image: "", template: "iol" }) }, "Edge Lab.unl"));
    expect(tree.devices[0].attributes).toEqual({
      lab: "Edge Lab",
      template: "iol",
      type: "qemu",
      console: "telnet",
      status: "running",
      name: "R1"
    });
  });
});

describe("createEveNgProvider — hard caps", () => {
  it("stops at the node cap, marks the tree truncated and names what was dropped (⊘ a silent cap makes the uncollected nodes look deleted, and `truncated` is what tells computeSyncPlan to skip pruning entirely)", async () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 1; i <= 10_050; i++) {
      nodes[String(i)] = node({ id: String(i), name: `R${i}` });
    }
    const tree = await fetchTree(oneLabWorld(nodes));
    expect(tree.devices).toHaveLength(10_000);
    expect(tree.truncated).toBe(true);
    expect((tree.warnings ?? []).some((w) => w.includes("10000") && w.toLowerCase().includes("node"))).toBe(true);
  });

  it("stops at the lab cap the same way, and does not fetch nodes for labs past it", async () => {
    const labs = Array.from({ length: 1_050 }, (_, i) => ({ file: `L${i}.unl`, path: `/L${i}.unl` }));
    const nodes: Record<string, unknown> = {};
    for (const lab of labs) nodes[lab.path] = { "1": node() };
    const { fetchImpl, calls } = makeWorld({ folders: { "/": { labs } }, nodes });
    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toHaveLength(1_000);
    expect(tree.truncated).toBe(true);
    expect((tree.warnings ?? []).some((w) => w.includes("1000") && w.toLowerCase().includes("lab"))).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/nodes"))).toHaveLength(1_000);
  });

  it("leaves `truncated` unset for an inventory below the caps (⊘ marking every tree truncated disables pruning forever, so a lab deleted in EVE-NG keeps its servers indefinitely)", async () => {
    const tree = await fetchTree(oneLabWorld({ "1": node() }));
    expect(tree.truncated).toBeFalsy();
  });
});

/**
 * WALL-CLOCK CRAWL DEADLINE (task #30) — the crawl is bounded in real time as
 * well as by the request/lab/node/depth caps: a tree well within every cap but
 * served by a slow EVE-NG box can still take minutes. The deadline is driven by
 * `Date.now()`, so the seam is a `Date.now` spy plus an injected fetch that
 * advances the clock — no real sleeps, so the suite stays fast.
 */
describe("createEveNgProvider — crawl deadline (task #30)", () => {
  // Wraps makeWorld's fetch, advancing a controllable clock by `stepMs` on every
  // request whose path matches `advanceWhen`. The Date.now spy reads that clock,
  // so the deadline (Date.now() + CRAWL_DEADLINE_MS, captured at crawl start)
  // trips deterministically once enough matching requests have run.
  function slowWorld(world: World, advanceWhen: (path: string) => boolean, stepMs: number) {
    let clock = 1_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { fetchImpl, calls } = makeWorld(world);
    const wrapped = (async (input: string, init?: RequestInit) => {
      const path = decodeURIComponent(new URL(input).pathname);
      if (advanceWhen(path)) {
        clock += stepMs;
      }
      return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
    }) as unknown as typeof fetch;
    return { fetchImpl: wrapped, calls, restore: () => nowSpy.mockRestore() };
  }

  it("trips the deadline during the FOLDER WALK when listings are slow → the tree is truncated with a deadline-named warning (⊘ removing the deadline check lets a slow-but-narrow tree crawl unbounded)", async () => {
    // Root has a child folder, so there is a second folder-listing iteration at
    // which the clock — advanced past the whole budget by the first listing — has
    // already blown the deadline.
    const world: World = {
      folders: {
        "/": { folders: [{ name: "A", path: "/A" }], labs: [{ file: "L1.unl", path: "/L1.unl" }] },
        "/A": { labs: [{ file: "L2.unl", path: "/A/L2.unl" }] }
      },
      nodes: { "/L1.unl": { "1": node() }, "/A/L2.unl": { "2": node() } }
    };
    const { fetchImpl, restore } = slowWorld(world, (p) => p.startsWith("/api/folders"), 130_000);
    try {
      const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
      expect(tree.truncated).toBe(true);
      expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("time limit") && w.toLowerCase().includes("folder tree"))).toBe(true);
      // "/A" (and its L2) was never reached.
      expect(tree.devices.some((d) => d.externalId.includes("/A/L2.unl"))).toBe(false);
      // P3-2 (review) — EXACTLY ONE deadline warning per crawl. The walk collected
      // L1 before tripping, so the node loop re-observes the already-blown deadline;
      // it must NOT push a second "Stopped after 120s…" line the walk already named.
      expect((tree.warnings ?? []).filter((w) => w.toLowerCase().includes("time limit"))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("trips the deadline during the NODE-FETCH phase when a source's lab count is what blows the budget → truncated + partial + a deadline warning (⊘ a deadline only in walkFolders leaves the per-lab node loop unbounded)", async () => {
    // Two labs at the root (fast folder walk). The FIRST lab's node fetch eats the
    // whole budget, so the second lab's node fetch is never issued.
    const world: World = {
      folders: { "/": { labs: [{ file: "L1.unl", path: "/L1.unl" }, { file: "L2.unl", path: "/L2.unl" }] } },
      nodes: { "/L1.unl": { "1": node({ id: "1" }) }, "/L2.unl": { "2": node({ id: "2" }) } }
    };
    const { fetchImpl, restore } = slowWorld(world, (p) => p.startsWith("/api/labs") && p.endsWith("/nodes"), 130_000);
    try {
      const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
      expect(tree.truncated).toBe(true);
      // Partial: the first lab's node was imported, the second lab's was not.
      expect(tree.devices.some((d) => d.externalId.includes("/L1.unl"))).toBe(true);
      expect(tree.devices.some((d) => d.externalId.includes("/L2.unl"))).toBe(false);
      expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("time limit") && w.toLowerCase().includes("later labs"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("a FAST crawl (clock never advances past the budget) is NOT truncated and carries no deadline warning (⊘ a deadline that trips regardless disables pruning on every healthy source)", async () => {
    const world: World = {
      folders: { "/": { folders: [{ name: "A", path: "/A" }], labs: [{ file: "L1.unl", path: "/L1.unl" }] }, "/A": { labs: [{ file: "L2.unl", path: "/A/L2.unl" }] } },
      nodes: { "/L1.unl": { "1": node() }, "/A/L2.unl": { "2": node() } }
    };
    // Advance by a trivial 1ms per request — nowhere near the 120s budget.
    const { fetchImpl, restore } = slowWorld(world, () => true, 1);
    try {
      const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
      expect(tree.truncated).toBeFalsy();
      expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("time limit"))).toBe(false);
      // Both labs' nodes were imported.
      expect(tree.devices).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("the deadline also truncates the fetchStatus report (⊘ leaving fetchStatus's node loop unbounded lets a slow status poll hang the Command Center)", async () => {
    const world: World = {
      folders: { "/": { labs: [{ file: "L1.unl", path: "/L1.unl" }, { file: "L2.unl", path: "/L2.unl" }] } },
      nodes: { "/L1.unl": { "1": node({ id: "1" }) }, "/L2.unl": { "2": node({ id: "2" }) } }
    };
    const { fetchImpl, restore } = slowWorld(world, (p) => p.startsWith("/api/labs") && p.endsWith("/nodes"), 130_000);
    try {
      const report = await createEveNgProvider(fetchImpl).fetchStatus!(CONFIG, SECRETS);
      expect(report.truncated).toBe(true);
      // Partial: the first lab's status is present, the second's is not.
      expect(Object.keys(report.statuses).some((k) => k.includes("/L1.unl"))).toBe(true);
      expect(Object.keys(report.statuses).some((k) => k.includes("/L2.unl"))).toBe(false);
    } finally {
      restore();
    }
  });

  // The 120s budget and the 20s per-request ceiling are module-private consts;
  // mirror them here so the intent is legible.
  const DEADLINE_MS = 120_000;
  const PER_REQUEST_MS = 20_000;

  it("#84 P2-2 — bounds each request's timeout by the REMAINING deadline budget (⊘ a fixed 20s per-request timeout lets a request issued near the 120s deadline still run the full 20s past it, and a 401 re-login adds another)", async () => {
    let clock = 1_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      // login lands 10s before the deadline, so the post-login folder request has
      // only ~10s of budget left — less than the 20s ceiling.
      const world: World = { folders: { "/": { labs: [] } } };
      const { fetchImpl } = makeWorld(world);
      const wrapped = (async (input: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(input).pathname);
        if (path === "/api/auth/login") {
          clock += DEADLINE_MS - 10_000;
        }
        return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
      }) as unknown as typeof fetch;
      await createEveNgProvider(wrapped).fetchStatus!(CONFIG, SECRETS);
      // At least one request (the post-login folder listing) was bounded BELOW the
      // 20s ceiling — capped by the ~10s of remaining deadline budget.
      expect(timeoutSpy.mock.calls.some(([ms]) => (ms as number) < PER_REQUEST_MS)).toBe(true);
      // ...and none exceeded the ceiling either.
      expect(timeoutSpy.mock.calls.every(([ms]) => (ms as number) <= PER_REQUEST_MS)).toBe(true);
    } finally {
      nowSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it("#84 P2-2 — does NOT re-login+retry on a 401 that arrives PAST the deadline (⊘ the single silent re-login adds another full request past the deadline, overrunning it)", async () => {
    let clock = 1_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      let loginCount = 0;
      const world: World = { folders: { "/": { labs: [] } } };
      const { fetchImpl } = makeWorld(world);
      const wrapped = (async (input: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(input).pathname);
        if (path === "/api/auth/login") {
          loginCount++;
          return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
        }
        if (path.startsWith("/api/folders")) {
          // The request is issued before the deadline, but the server is slow: the
          // response lands PAST the deadline, and it is a session-expiry 401.
          clock += DEADLINE_MS + 10_000;
          return makeResponse(401, "session expired");
        }
        return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
      }) as unknown as typeof fetch;
      await createEveNgProvider(wrapped)
        .fetchStatus!(CONFIG, SECRETS)
        .catch(() => undefined);
      // Only the INITIAL login — the 401 arrived past the deadline, so the silent
      // re-login+retry is skipped rather than overrunning the budget.
      expect(loginCount).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A request that STALLS until the deadline: the fake clock is advanced past the
  // deadline and the fetch rejects with a TimeoutError, exactly as
  // AbortSignal.timeout(remaining) would when the request never answers.
  function timeoutError(): Error {
    const err = new Error("The operation timed out.");
    err.name = "TimeoutError";
    return err;
  }

  it("#84 P2 — a request that STALLS to the deadline TRUNCATES the crawl (partial results + deadline warning), it does NOT fail the whole crawl (⊘ converting the deadline-abort to a network error discards every device already collected)", async () => {
    let clock = 1_000_000_000;
    const deadline = clock + DEADLINE_MS; // computed the same way the crawl does
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const world: World = {
        folders: { "/": { labs: [{ file: "L1.unl", path: "/L1.unl" }, { file: "L2.unl", path: "/L2.unl" }] } },
        nodes: { "/L1.unl": { "1": node({ id: "1" }) }, "/L2.unl": { "2": node({ id: "2" }) } }
      };
      const { fetchImpl } = makeWorld(world);
      let nodeReq = 0;
      const wrapped = (async (input: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(input).pathname);
        if (path.startsWith("/api/labs") && path.endsWith("/nodes")) {
          nodeReq++;
          if (nodeReq === 2) {
            // The second lab's node fetch stalls until the deadline and aborts.
            clock = deadline + 5_000;
            throw timeoutError();
          }
        }
        return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
      }) as unknown as typeof fetch;

      const tree = await createEveNgProvider(wrapped).fetchInventory(CONFIG, SECRETS);
      // Truncated + partial + warned — never thrown.
      expect(tree.truncated).toBe(true);
      expect(tree.devices.some((d) => d.externalId.includes("/L1.unl"))).toBe(true);
      expect(tree.devices.some((d) => d.externalId.includes("/L2.unl"))).toBe(false);
      expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("time limit"))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("#84 P2 — a genuine per-request timeout with the deadline STILL FAR OFF surfaces as a network error, not a truncation (⊘ treating every abort as a deadline trip would swallow a real dead-server timeout into a silently-partial sync)", async () => {
    let clock = 1_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const world: World = {
        folders: { "/": { labs: [{ file: "L1.unl", path: "/L1.unl" }] } },
        nodes: { "/L1.unl": { "1": node({ id: "1" }) } }
      };
      const { fetchImpl } = makeWorld(world);
      const wrapped = (async (input: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(input).pathname);
        if (path.startsWith("/api/labs") && path.endsWith("/nodes")) {
          // A per-request timeout, but the deadline is nowhere near (clock barely moves).
          clock += 20_000; // one FETCH_TIMEOUT_MS worth — well under the 120s budget
          throw timeoutError();
        }
        return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
      }) as unknown as typeof fetch;

      const err = await createEveNgProvider(wrapped)
        .fetchInventory(CONFIG, SECRETS)
        .then(() => undefined)
        .catch((e) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("network");
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A response whose HEADERS arrive (fetch resolves) but whose BODY read aborts:
  // `res.text()` rejects, exactly as the request's AbortSignal aborting the body
  // stream would. `advanceClock` runs at body-read time so the abort can be timed
  // relative to the deadline.
  function headersThenBodyStall(advanceClock: () => void): unknown {
    return {
      status: 200,
      text: async () => {
        advanceClock();
        throw timeoutError();
      },
      headers: { get: () => null, getSetCookie: () => [] }
    };
  }

  it("#84 P2-2 — a stall during the BODY READ (headers before the deadline, body after) TRUNCATES the crawl, not a protocol failure (⊘ swallowing the body-read abort to '' makes parsing throw a protocol error and discards the partial crawl)", async () => {
    let clock = 1_000_000_000;
    const deadline = clock + DEADLINE_MS;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const world: World = {
        folders: { "/": { labs: [{ file: "L1.unl", path: "/L1.unl" }, { file: "L2.unl", path: "/L2.unl" }] } },
        nodes: { "/L1.unl": { "1": node({ id: "1" }) }, "/L2.unl": { "2": node({ id: "2" }) } }
      };
      const { fetchImpl } = makeWorld(world);
      let nodeReq = 0;
      const wrapped = (async (input: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(input).pathname);
        if (path.startsWith("/api/labs") && path.endsWith("/nodes")) {
          nodeReq++;
          if (nodeReq === 2) {
            // The fetch() resolves with headers BEFORE the deadline; the body read
            // then stalls and aborts AFTER it.
            return headersThenBodyStall(() => {
              clock = deadline + 5_000;
            });
          }
        }
        return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
      }) as unknown as typeof fetch;

      const tree = await createEveNgProvider(wrapped).fetchInventory(CONFIG, SECRETS);
      expect(tree.truncated).toBe(true);
      expect(tree.devices.some((d) => d.externalId.includes("/L1.unl"))).toBe(true);
      expect(tree.devices.some((d) => d.externalId.includes("/L2.unl"))).toBe(false);
      expect((tree.warnings ?? []).some((w) => w.toLowerCase().includes("time limit"))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("#84 P2-2 — a body-read failure with the deadline FAR OFF is unchanged (the crawl still fails, not a silent truncation) (⊘ classifying every body-read abort as a deadline trip would swallow a real mid-body network failure into a partial sync)", async () => {
    let clock = 1_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const world: World = {
        folders: { "/": { labs: [{ file: "L1.unl", path: "/L1.unl" }] } },
        nodes: { "/L1.unl": { "1": node({ id: "1" }) } }
      };
      const { fetchImpl } = makeWorld(world);
      const wrapped = (async (input: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(input).pathname);
        if (path.startsWith("/api/labs") && path.endsWith("/nodes")) {
          // Body read fails with the deadline nowhere near (clock unchanged).
          return headersThenBodyStall(() => {});
        }
        return (fetchImpl as unknown as (i: string, n?: RequestInit) => Promise<unknown>)(input, init);
      }) as unknown as typeof fetch;

      const result = await createEveNgProvider(wrapped)
        .fetchInventory(CONFIG, SECRETS)
        .then((t) => ({ ok: true as const, t }))
        .catch((e) => ({ ok: false as const, e }));
      // Unchanged: the swallowed empty body makes parsing fail (protocol), not truncate.
      expect(result.ok).toBe(false);
      expect((result as { e: unknown }).e).toBeInstanceOf(InventoryProviderError);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("createEveNgProvider — error mapping", () => {
  /**
   * P1 (data-loss) — a syntactically valid `status:"success"` envelope whose
   * `data` is missing / null / a primitive / the wrong shape must FAIL the sync,
   * not be coerced into an empty (non-truncated) inventory. An empty tree makes
   * `computeSyncPlan` treat every owned device as absent and orphan/delete it —
   * and its stored credentials — over what is really a malformed response.
   */
  it("P1 — rejects a success envelope whose `data` is not a folder listing at the ROOT folder, rather than turning it into an empty prune-everything inventory (⊘ coercing malformed data to {folders:[],labs:[]} deletes every owned device and its credentials)", async () => {
    const malformed: unknown[] = [
      null,
      "oops",
      42,
      [],
      { folders: [] }, // labs missing
      { labs: [] }, // folders missing
      { folders: {}, labs: [] }, // folders not an array
      { folders: [], labs: "x" } // labs not an array
    ];
    for (const badData of malformed) {
      const fetchImpl = (async (input: string) => {
        const path = new URL(input).pathname;
        if (path.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
        if (path.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
        return makeResponse(200, { code: 200, status: "success", message: "", data: badData });
      }) as unknown as typeof fetch;
      const err = await createEveNgProvider(fetchImpl)
        .fetchInventory(CONFIG, SECRETS)
        .catch((e: unknown) => e);
      expect(err, `data=${JSON.stringify(badData)}`).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, `data=${JSON.stringify(badData)}`).toBe("protocol");
    }
  });

  it("P1 — accepts a genuinely empty-but-well-formed folder listing (both keys present as arrays), so a real lab-less/folder-less folder still syncs", async () => {
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (path.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      return makeResponse(200, jsend({ folders: [], labs: [] }));
    }) as unknown as typeof fetch;
    const tree = await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toEqual([]);
    // ⊘ A well-formed empty tree is NOT truncated — pruning of genuinely gone
    // devices must still run. (This is the shape the P1 guard must let through.)
    expect(tree.truncated).toBeFalsy();
  });

  it("P1 — rejects a success envelope whose node payload is neither an object map nor an empty array, rather than reading it as 'this lab has no nodes' (⊘ `data:\"garbage\"` -> [] prunes the lab's servers)", async () => {
    for (const badNodes of ["garbage", 7, null, [{ id: "1" }] /* non-empty array is not the node map */]) {
      const fetchImpl = (async (input: string) => {
        const path = decodeURIComponent(new URL(input).pathname);
        if (path.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
        if (path.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
        if (path === "/api/folders/") return makeResponse(200, jsend({ folders: [], labs: [{ file: "L.unl", path: "/L.unl" }] }));
        return makeResponse(200, { code: 200, status: "success", message: "", data: badNodes });
      }) as unknown as typeof fetch;
      const err = await createEveNgProvider(fetchImpl)
        .fetchInventory(CONFIG, SECRETS)
        .catch((e: unknown) => e);
      expect(err, `nodes=${JSON.stringify(badNodes)}`).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, `nodes=${JSON.stringify(badNodes)}`).toBe("protocol");
    }
  });

  it("maps an abort/timeout to `network`, naming the host rather than the stack", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("network");
    expect((err as Error).message).toContain("eve.example.com");
  });

  it("maps a connection-refused style failure to `network`", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("network");
    expect((err as Error).message).toContain("ECONNREFUSED");
  });

  it("maps a non-JSON body (a proxy's HTML error page) to `protocol` WITHOUT echoing the untrusted body (⊘ MINOR-7 — echoing 200 bytes of an attacker-influenced page into the error puts markup into a notification; NetBox echoes none)", async () => {
    const html = `<!doctype html><html><body>${"x".repeat(5_000)}</body></html>`;
    const fetchImpl = (async () => makeResponse(200, html, [`unetlab_session=${SESSION}`])) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as Error).message).not.toContain("xxxx");
    expect((err as Error).message.length).toBeLessThan(300);
  });

  it("maps a 500 to `protocol`, not to `auth`", async () => {
    const fetchImpl = (async (input: string) => {
      if (new URL(input).pathname === "/api/auth/login") return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      return makeResponse(500, "Internal Server Error");
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
  });

  it("MINOR-6 — maps an unparseable base URL (a scheme-less host) to a mapped provider error, not a raw TypeError (⊘ `new URL(\"eve.example.com/api/...\")` throws straight out of fetchInventory)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory({ ...CONFIG, baseUrl: "eve.example.com" }, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as Error).message.toLowerCase()).toContain("base url");
    // Never even attempted a request against a URL that cannot be built.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("M36 — a JSend `code:401` envelope on a NON-login endpoint (HTTP 200) maps to `auth`, not `protocol` (⊘ keying auth only off the HTTP status misses EVE-NG's in-envelope 401)", async () => {
    const fetchImpl = (async (input: string) => {
      if (new URL(input).pathname.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (new URL(input).pathname.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      return makeResponse(200, { code: 401, status: "fail", message: "Unauthorized access (90403).", data: null });
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("auth");
  });

  it("M37 — rejects a response whose envelope is missing `status` as `protocol` (⊘ a shape check that trusts `data` without `status` accepts a non-EVE-NG body)", async () => {
    const fetchImpl = (async () => makeResponse(200, { code: 200, data: {} }, [`unetlab_session=${SESSION}`])) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
  });

  it("MINOR-5 — sends `redirect: \"manual\"` on the login POST and on GETs, so a 3xx from the lab box is never auto-followed across origins with the password (⊘ default `redirect: \"follow\"` retains the POST body on 307/308)", async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      redirects.push(init?.redirect);
      if (new URL(input).pathname.endsWith("/api/auth/login")) return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (new URL(input).pathname.endsWith("/api/status")) return makeResponse(200, jsend({ version: "5.0.1" }));
      return makeResponse(200, jsend({ folders: [], labs: [] }));
    }) as unknown as typeof fetch;
    await createEveNgProvider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(redirects.length).toBeGreaterThan(1);
    expect(redirects.every((r) => r === "manual")).toBe(true);
  });

  it("MINOR-5 — treats a 3xx as a protocol error rather than success (⊘ no EVE-NG endpoint legitimately redirects; following one is how the crawl leaves the origin)", async () => {
    const fetchImpl = (async (input: string) => {
      if (new URL(input).pathname.endsWith("/api/auth/login")) return makeResponse(302, "", [`unetlab_session=${SESSION}`]);
      return makeResponse(200, jsend({}));
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
  });
});

describe("createEveNgProvider — testConnection", () => {
  it("logs in and probes /api/status", async () => {
    const { fetchImpl, calls } = makeWorld(oneLabWorld({ "1": node() }));
    await expect(createEveNgProvider(fetchImpl).testConnection(CONFIG, SECRETS)).resolves.toBeUndefined();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/auth/login", "/api/status"]);
  });

  it("falls back to a folder listing when /api/status is a 404 (⊘ failing there rejects a working server whose build predates the endpoint)", async () => {
    const { fetchImpl, calls } = makeWorld({ ...oneLabWorld({ "1": node() }), statusHttp: 404 });
    await expect(createEveNgProvider(fetchImpl).testConnection(CONFIG, SECRETS)).resolves.toBeUndefined();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/auth/login", "/api/status", "/api/folders/"]);
  });

  it("reports bad credentials as `auth` and never tries the fallback (⊘ a fallback after 401 can succeed on a laxer endpoint and report a broken source as healthy)", async () => {
    let statusCalls = 0;
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/auth/login") return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}`]);
      if (path === "/api/status") {
        statusCalls++;
        return makeResponse(403, "forbidden");
      }
      return makeResponse(200, jsend({ folders: [], labs: [] }));
    }) as unknown as typeof fetch;

    const err = await createEveNgProvider(fetchImpl)
      .testConnection(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("auth");
    // One original + one after the single silent re-login; never a folders fallback.
    expect(statusCalls).toBe(2);
  });
});

/**
 * Registration wiring. A provider that is never registered is unreachable: it
 * cannot be picked on the Add Inventory Source form and nothing else in the
 * product can name it. There is no cheaper seam than reading activate()'s
 * source — `extension.ts` imports `vscode` at module scope, so importing it
 * here would drag the whole extension host in.
 */
describe("activation wiring", () => {
  const source = readFileSync(path.resolve(__dirname, "..", "..", "src", "extension.ts"), "utf8");

  it("registers BOTH built-in providers in activate() (⊘ the import line alone satisfies a name check, so a version that imports the factory and never calls it would pass)", () => {
    expect(source).toMatch(/inventoryProviderRegistry\.register\(createNetboxProvider\(\)\);/);
    expect(source).toMatch(/inventoryProviderRegistry\.register\(createEveNgProvider\(\)\);/);
  });

  it("hands the Settings tree the core and the provider registry, without which its per-source rows are empty and never refresh", () => {
    expect(source).toMatch(/new SettingsTreeProvider\(core, inventoryProviderRegistry\)/);
  });

  it("imports the EVE-NG factory from the provider module", () => {
    expect(source).toMatch(/import \{ createEveNgProvider \} from "\.\/services\/inventory\/providers\/eveNgProvider";/);
  });
});

/**
 * END-TO-END CROSS-CHECK — the provider and the Phase 0 telnet engine work are
 * two halves of one promise ("an EVE-NG node becomes a working telnet server"),
 * and each half's own tests pass whether or not they agree. This runs the
 * provider's REAL output through the REAL `computeSyncPlan` and asserts the
 * server that comes out is dialable.
 */
describe("EVE-NG → computeSyncPlan", () => {
  /**
   * ADDRESSLESS (Codex P1 on #82) — the whole placeholder lifecycle end to end:
   * a stopped node (no console) syncs to an addressless server; when it is
   * started (a telnet console appears) the SAME server upgrades in place to an
   * addressed telnet server — same externalId, same deterministic id.
   */
  it("syncs a stopped node to an addressless server, then upgrades the SAME record to an addressed telnet server when it starts", async () => {
    const source = {
      id: "src-eve",
      providerId: EVE_NG_PROVIDER_ID,
      name: "Lab",
      targetFolder: "EVE",
      prunePolicy: "orphan" as const,
      defaultUsername: "admin",
      config: CONFIG,
      secretFieldIds: ["password"]
    };
    // Stopped Community node: status 0, no console url → endpoints: [].
    const stoppedTree = await fetchTree(oneLabWorld({ "1": node({ status: 0, url: "" }) }), { includeStopped: true });
    expect(() => validateInventoryTree(stoppedTree)).not.toThrow();
    const plan1 = computeSyncPlan({ source, tree: stoppedTree, currentServers: [], now: 1_000 });
    expect(plan1.adds).toHaveLength(1);
    const placeholder = plan1.adds[0];
    expect(placeholder.addressless).toBe(true);
    expect(placeholder.host).toBe("");
    expect(placeholder.origin?.externalId).toBe("/Lab 1.unl#1");

    // The node is started: a native telnet console appears.
    const startedTree = await fetchTree(oneLabWorld({ "1": node({ status: 2, url: "telnet://127.0.0.1:32769" }) }));
    const plan2 = computeSyncPlan({ source, tree: startedTree, currentServers: [placeholder], now: 2_000 });
    expect(plan2.adds).toHaveLength(0); // upgraded in place, not duplicated
    expect(plan2.updates).toHaveLength(1);
    const upgraded = plan2.updates[0].after;
    expect(upgraded.id).toBe(placeholder.id);
    expect(upgraded.addressless ?? false).toBe(false);
    expect(upgraded.protocol).toBe("telnet");
    expect(upgraded.host).toBe("eve.example.com");
    expect(upgraded.port).toBe(32769);
    expect(upgraded.origin?.externalId).toBe("/Lab 1.unl#1");
  });

  it("turns a running lab node into a telnet server on the console's own port, stamped so a later hand-flip is respected", async () => {
    const tree = await fetchTree({
      folders: { "/": { folders: [{ name: "ACME", path: "/ACME" }] }, "/ACME": { labs: [{ file: "Core.unl", path: "/ACME/Core.unl" }] } },
      nodes: { "/ACME/Core.unl": { "3": node({ id: "3", name: "R3", url: "telnet://127.0.0.1:32771" }) } }
    });

    // The tree crosses the provider boundary, so it goes through the same
    // runtime shape check a third-party provider's would.
    expect(() => validateInventoryTree(tree)).not.toThrow();

    const plan = computeSyncPlan({
      source: {
        id: "src-eve",
        providerId: EVE_NG_PROVIDER_ID,
        name: "Lab",
        targetFolder: "EVE",
        prunePolicy: "orphan",
        defaultUsername: "admin",
        config: CONFIG,
        secretFieldIds: ["password"]
      },
      tree,
      currentServers: [],
      now: 1_000
    });

    expect(plan.adds).toHaveLength(1);
    const [server] = plan.adds;
    // ⊘ A provider emitting `kind: "ssh"` (or the engine ignoring the telnet
    // kind) yields a record on port 22 with no protocol — three assertions that
    // are individually plausible and jointly unusable.
    expect(server.protocol).toBe("telnet");
    expect(server.host).toBe("eve.example.com");
    expect(server.port).toBe(32771);
    // The stamp is what makes a later hand-flip to SSH survive the next sync.
    expect(server.origin?.syncedProtocol).toBe("telnet");
    expect(server.origin?.externalId).toBe("/ACME/Core.unl#3");
    expect(server.group).toBe("EVE/ACME/Core");
  });
});

/**
 * LIVE STATUS (Phase 2) — `fetchStatus` reports every node's running/stopped
 * state keyed by the SAME externalId `fetchInventory` uses, so a status maps onto
 * the server it belongs to. It reports ALL nodes (no includeStopped filter — the
 * tree decides what to show), and only a RUNNING telnet node carries a fresh
 * console endpoint.
 */
async function fetchStatus(world: World, config: Record<string, string | number | boolean> = {}): Promise<InventoryStatusReport> {
  const { fetchImpl } = makeWorld(world);
  const provider = createEveNgProvider(fetchImpl);
  return provider.fetchStatus!({ ...CONFIG, ...config }, SECRETS);
}

describe("createEveNgProvider — fetchStatus", () => {
  it("maps status 2 to running and everything else to stopped, keyed by `${lab.path}#${nodeId}` (⊘ a bare node id collapses every lab's node 1 onto one key; the wrong status field flips the whole highlight)", async () => {
    const report = await fetchStatus(oneLabWorld({ "1": node(), "2": node({ id: "2", status: 0, url: "" }) }));
    expect(report.contractVersion).toBe(1);
    expect(report.statuses["/Lab 1.unl#1"].state).toBe("running");
    expect(report.statuses["/Lab 1.unl#2"].state).toBe("stopped");
    expect(Object.keys(report.statuses).sort()).toEqual(["/Lab 1.unl#1", "/Lab 1.unl#2"]);
  });

  it("emits consoleHost/consolePort for a RUNNING telnet node, applying the same loopback→base-host substitution mapNode does (⊘ keeping 127.0.0.1 points the console at the user's own machine)", async () => {
    const report = await fetchStatus(oneLabWorld({ "1": node({ url: "telnet://127.0.0.1:32769" }) }));
    expect(report.statuses["/Lab 1.unl#1"]).toEqual({ state: "running", consoleHost: "eve.example.com", consolePort: 32769 });
  });

  it("honours the consoleHost override on a running node exactly as the sync mapper does", async () => {
    const report = await fetchStatus(oneLabWorld({ "1": node({ url: "telnet://127.0.0.1:5001" }) }), { consoleHost: "nat.example.com" });
    expect(report.statuses["/Lab 1.unl#1"]).toEqual({ state: "running", consoleHost: "nat.example.com", consolePort: 5001 });
  });

  it("omits console fields for a STOPPED node even when it still reports a telnet url (⊘ healing toward a stale port on a stopped node)", async () => {
    const report = await fetchStatus(oneLabWorld({ "1": node({ status: 0, url: "telnet://127.0.0.1:32769" }) }));
    expect(report.statuses["/Lab 1.unl#1"]).toEqual({ state: "stopped" });
    expect(report.statuses["/Lab 1.unl#1"].consolePort).toBeUndefined();
  });

  it("omits console fields for a running node with NO native telnet console (an HTML5/VNC console has no dialable port)", async () => {
    const report = await fetchStatus(oneLabWorld({ "1": node({ console: "vnc", url: "" }) }));
    expect(report.statuses["/Lab 1.unl#1"]).toEqual({ state: "running" });
  });

  it("reports stopped nodes REGARDLESS of includeStopped — status is not a sync (⊘ reusing fetchInventory's includeStopped filter would hide a stopped lab's nodes from the tree)", async () => {
    const report = await fetchStatus(oneLabWorld({ "1": node({ status: 0, url: "" }) }), { includeStopped: false });
    expect(report.statuses["/Lab 1.unl#1"].state).toBe("stopped");
  });

  it("reuses the login cookie on every folder/node request, exactly like fetchInventory (⊘ dropping the cookie 401s the very next call)", async () => {
    const { fetchImpl, calls } = makeWorld(oneLabWorld({ "1": node() }));
    await createEveNgProvider(fetchImpl).fetchStatus!(CONFIG, SECRETS);
    const authed = calls.filter((c) => !c.url.endsWith("/api/auth/login"));
    expect(authed.length).toBeGreaterThan(0);
    expect(authed.every((c) => (c.headers.Cookie ?? "").includes(SESSION))).toBe(true);
  });

  it("maps a rejected login to an InventoryProviderError, same auth discipline as fetchInventory (⊘ letting a raw fetch/JSend error escape the refresh path)", async () => {
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/api/auth/login")) return makeResponse(401, "denied");
      return makeResponse(404, "not found");
    }) as unknown as typeof fetch;
    await expect(createEveNgProvider(fetchImpl).fetchStatus!(CONFIG, SECRETS)).rejects.toBeInstanceOf(InventoryProviderError);
  });

  it("sets truncated:true when the node scan hits the MAX_NODES cap, so a partial report is not mistaken for complete (⊘ an ordinary complete-looking report makes applyInventoryStatus clear decorations for every node beyond the cap)", async () => {
    // One lab with more nodes than the 10 000-node cap. Numeric string keys
    // iterate in numeric order, so the cap deterministically stops the scan
    // partway and the report must carry the truncation signal.
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= 10_000; i++) {
      many[String(i)] = node({ id: String(i), status: 2 });
    }
    const report = await fetchStatus(oneLabWorld(many));
    expect(report.truncated).toBe(true);
    // The report is genuinely capped (fewer than the nodes offered).
    expect(Object.keys(report.statuses).length).toBeLessThan(10_001);
    expect(Object.keys(report.statuses).length).toBeGreaterThan(0);
  });

  it("does NOT mark a normal (under-cap) report truncated (⊘ flagging every report truncated turns each apply into a merge and never clears a genuinely-removed node)", async () => {
    const report = await fetchStatus(oneLabWorld({ "1": node(), "2": node({ id: "2", status: 0, url: "" }) }));
    expect(report.truncated).toBeFalsy();
  });
});

/**
 * NODE CONTROL (Phase 4) — `controlNode` starts/stops one lab node. Community is
 * the certified path (GET .../nodes/{id}/start|stop); Pro is edition-aware but
 * PRELIMINARY (PUT + stopmode), matching the existing Pro-preliminary stance.
 * The externalId is `${lab.path}#${nodeId}` and is split on the LAST `#`.
 */
interface ControlWorldOpts {
  version?: string;
  edition?: string;
  /** HTTP status the node-action endpoint answers with (default 200). */
  actionHttp?: number;
  /** When set, the action endpoint returns a JSend `status:"fail"` envelope. */
  actionFail?: boolean;
  /**
   * When set, the FIRST node-action request 401s (an expired session) and every
   * later one succeeds — exercises `authedRequest`'s single silent re-login.
   */
  actionFirst401?: boolean;
}

function controlWorld(opts: ControlWorldOpts = {}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let actionHits = 0;
  const impl = async (input: string, init?: RequestInit): Promise<unknown> => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname);
    calls.push({
      url: input,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined
    });
    if (path === "/api/auth/login") {
      return makeResponse(200, jsend(null), [`unetlab_session=${SESSION}; Path=/; HttpOnly`]);
    }
    if (path === "/api/status") {
      const data: Record<string, unknown> = { version: opts.version ?? "5.0.1-13" };
      if (opts.edition !== undefined) {
        data.edition = opts.edition;
      }
      return makeResponse(200, jsend(data));
    }
    // Any /api/labs/.../nodes/{id}/{action} endpoint is the control call.
    actionHits++;
    if (opts.actionFirst401 && actionHits === 1) {
      return makeResponse(401, "session expired");
    }
    const http = opts.actionHttp ?? 200;
    if (http !== 200) {
      return makeResponse(http, "control failed");
    }
    if (opts.actionFail) {
      return makeResponse(200, { code: 400, status: "fail", message: "cannot start node" });
    }
    return makeResponse(200, jsend(true));
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

/** Login requests seen so far. */
function loginCount(calls: Call[]): number {
  return calls.filter((c) => c.url.endsWith("/api/auth/login")).length;
}

/** The single node-action request (everything that is not login or /api/status). */
function actionCall(calls: Call[]): Call | undefined {
  return calls.find((c) => c.url.includes("/nodes/") && !c.url.endsWith("/api/status"));
}

describe("createEveNgProvider — controlNode", () => {
  it("Community START issues GET /api/labs/{path}/nodes/{id}/start with the label URL-encoded (⊘ the wrong verb/path never starts the node; a bare id targets the wrong lab's node 1)", async () => {
    const { fetchImpl, calls } = controlWorld();
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab 1.unl#7", "start");
    const call = actionCall(calls);
    expect(call?.method).toBe("GET");
    expect(new URL(call!.url).pathname).toBe("/api/labs/Lab%201.unl/nodes/7/start");
  });

  it("Community STOP issues GET .../nodes/{id}/stop (⊘ reusing the start path stops nothing)", async () => {
    const { fetchImpl, calls } = controlWorld();
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab 1.unl#7", "stop");
    const call = actionCall(calls);
    expect(call?.method).toBe("GET");
    expect(decodeURIComponent(new URL(call!.url).pathname)).toBe("/api/labs/Lab 1.unl/nodes/7/stop");
  });

  it("splits the externalId on the LAST '#', so a lab path (or node) that itself contains '#' still resolves the right node (⊘ splitting on the FIRST '#' truncates the lab path)", async () => {
    const { fetchImpl, calls } = controlWorld();
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/A#B/Lab.unl#42", "start");
    const call = actionCall(calls);
    expect(decodeURIComponent(new URL(call!.url).pathname)).toBe("/api/labs/A#B/Lab.unl/nodes/42/start");
  });

  it("rejects a malformed externalId with a protocol error rather than firing a request at a bad path (⊘ a missing '#' or empty half silently hits /nodes//start)", async () => {
    const provider = createEveNgProvider(controlWorld().fetchImpl);
    for (const bad of ["no-hash", "#7", "/Lab.unl#", ""]) {
      const err = await provider.controlNode!(CONFIG, SECRETS, bad, "start").then(() => undefined, (e) => e);
      expect(err, bad).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind, bad).toBe("protocol");
    }
  });

  it("maps a JSend status:\"fail\" envelope on the action to an error, so a refused start surfaces (⊘ ignoring the envelope reports a failed start as success)", async () => {
    const { fetchImpl } = controlWorld({ actionFail: true });
    await expect(createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "start")).rejects.toBeInstanceOf(
      InventoryProviderError
    );
  });

  it("maps a non-2xx action response to an error (⊘ a 500 that is not surfaced leaves the user thinking the node started)", async () => {
    const { fetchImpl } = controlWorld({ actionHttp: 500 });
    await expect(createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "stop")).rejects.toBeInstanceOf(
      InventoryProviderError
    );
  });

  it("reuses the login cookie on the action request, exactly like the other paths (⊘ dropping the cookie 401s the control call)", async () => {
    const { fetchImpl, calls } = controlWorld();
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "start");
    const call = actionCall(calls);
    expect(call?.headers.Cookie).toBe(`unetlab_session=${SESSION}`);
  });

  it("re-logs in ONCE and retries when the node-action request 401s, and the control still succeeds (⊘ authedRequest without the silent re-login surfaces the first expired-session 401 as an auth failure, so a Start that a single re-login would have saved is reported as failed)", async () => {
    const { fetchImpl, calls } = controlWorld({ actionFirst401: true });
    // Resolves (no throw) only because the 401 triggered a re-login + retry.
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "start");
    // The initial login plus exactly one silent re-login off the 401.
    expect(loginCount(calls)).toBe(2);
    // The action endpoint was hit twice: the 401 and the successful retry.
    expect(calls.filter((c) => c.url.includes("/nodes/")).length).toBe(2);
  });

  it("Pro (PRELIMINARY) uses PUT for START, faithful to the edition-aware evengsdk verbs (⊘ falling back to the Community GET path is the un-edition-aware bug)", async () => {
    const { fetchImpl, calls } = controlWorld({ version: "5.0.1-24-pro" });
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "start");
    const call = actionCall(calls);
    expect(call?.method).toBe("PUT");
    expect(decodeURIComponent(new URL(call!.url).pathname)).toBe("/api/labs/Lab.unl/nodes/1/start");
  });

  it("Pro (PRELIMINARY) STOP carries stopmode=3 in the PUT body (⊘ omitting stopmode is the Pro-shape divergence Phase 3 will certify)", async () => {
    const { fetchImpl, calls } = controlWorld({ version: "5.0.1-24-pro" });
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "stop");
    const call = actionCall(calls);
    expect(call?.method).toBe("PUT");
    expect(decodeURIComponent(new URL(call!.url).pathname)).toBe("/api/labs/Lab.unl/nodes/1/stop");
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({ stopmode: 3 });
  });

  it("treats an UNKNOWN edition as Community best-effort — a GET start (⊘ failing closed on an absent /api/status blocks control on every older build)", async () => {
    const { fetchImpl, calls } = controlWorld({ version: "" });
    await createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "start");
    const call = actionCall(calls);
    expect(call?.method).toBe("GET");
  });

  it("maps a rejected login to an InventoryProviderError before any action request (⊘ letting a raw fetch/JSend error escape the command path)", async () => {
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/api/auth/login")) return makeResponse(401, "denied");
      return makeResponse(404, "not found");
    }) as unknown as typeof fetch;
    await expect(createEveNgProvider(fetchImpl).controlNode!(CONFIG, SECRETS, "/Lab.unl#1", "start")).rejects.toBeInstanceOf(
      InventoryProviderError
    );
  });
});

// ---------------------------------------------------------------------------
// INSECURE TLS — the per-source opt-in and, more importantly, which transport
// a given config selects.
// ---------------------------------------------------------------------------

/**
 * A home EVE-NG box at an IP address with a self-signed certificate fails two
 * checks at once (self-signed, AND a certificate that does not list the IP),
 * and until this option existed the provider had no way to accept it. The
 * insecure transport is scoped rather than global — see
 * `src/services/inventory/insecureFetch.ts` for why
 * `NODE_TLS_REJECT_UNAUTHORIZED` is not an option in a shared extension host.
 *
 * The tests that matter here are the NEGATIVE ones: an opted-out source and an
 * `http:` source must never reach the insecure transport.
 */
describe("createEveNgProvider — allowInsecureTls field", () => {
  const field = (): InventoryConfigField => {
    const found = createEveNgProvider(vi.fn() as unknown as typeof fetch).configFields.find((f) => f.id === "allowInsecureTls");
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

  it("says plainly, in its hint, that verification is off and that THE EVE-NG PASSWORD travels over the unverified connection (⊘ a hint that only says 'allows self-signed certificates' hides what the user is agreeing to)", () => {
    const hint = String(field().description ?? "").toLowerCase();
    expect(hint).toMatch(/password/);
    expect(hint).toMatch(/intercept|unauthenticated|not verified|unverified/);
    expect(hint).toMatch(/trust|lab/);
  });

  it("stops the base URL hint claiming self-signed HTTPS is unsupported, which this option makes false (⊘ leaving it tells the user to give up on the exact setup that now works)", () => {
    const baseUrl = createEveNgProvider(vi.fn() as unknown as typeof fetch).configFields.find((f) => f.id === "baseUrl");
    expect(String(baseUrl?.description ?? "")).not.toMatch(/not supported/i);
  });

  it("still passes the provider-shape validation the registry runs, with the new field in place", () => {
    expect(() => validateProviderShape(createEveNgProvider(vi.fn() as unknown as typeof fetch))).not.toThrow();
  });
});

describe("createEveNgProvider — insecure TLS transport selection", () => {
  const WORLD: World = { folders: { "/": { labs: [] } } };

  function probes(): { standard: ReturnType<typeof makeWorld>; insecure: ReturnType<typeof makeWorld>; provider: ReturnType<typeof createEveNgProvider> } {
    const standard = makeWorld(WORLD);
    const insecure = makeWorld(WORLD);
    return { standard, insecure, provider: createEveNgProvider(standard.fetchImpl, insecure.fetchImpl) };
  }

  it("uses the insecure transport — and ONLY it — for an https source that opted in", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ ...CONFIG, baseUrl: "https://10.0.0.5", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls).toHaveLength(0);
  });

  it("NEVER uses it for a source that did not opt in, however the certificate would have failed (⊘ selecting on the URL scheme alone turns verification off for every https source)", async () => {
    for (const config of [
      { baseUrl: "https://10.0.0.5", allowInsecureTls: false },
      { baseUrl: "https://10.0.0.5" }
    ]) {
      const { standard, insecure, provider } = probes();
      await provider.fetchInventory({ ...CONFIG, ...config }, SECRETS);
      expect(standard.calls.length).toBeGreaterThan(0);
      expect(insecure.calls).toHaveLength(0);
    }
  });

  it("NEVER uses it for an http source, where relaxing certificate checks means nothing and the adapter would refuse the URL anyway (⊘ selecting on the opt-in alone breaks every plain-http source the moment the box is ticked)", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ ...CONFIG, baseUrl: "http://eve.example.com", allowInsecureTls: true }, SECRETS);
    expect(standard.calls.length).toBeGreaterThan(0);
    expect(insecure.calls).toHaveLength(0);
  });

  it("decides per CONFIG, not per provider — one registry serves every source, so two sources on one provider must get different transports", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ ...CONFIG, baseUrl: "https://10.0.0.5", allowInsecureTls: true }, SECRETS);
    await provider.fetchInventory({ ...CONFIG, baseUrl: "https://eve.example.com" }, SECRETS);
    expect(insecure.calls.every((c) => c.url.startsWith("https://10.0.0.5"))).toBe(true);
    expect(standard.calls.every((c) => c.url.startsWith("https://eve.example.com"))).toBe(true);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls.length).toBeGreaterThan(0);
  });

  it("routes EVERY entry point through the same decision, not just the sync (⊘ one path built without the selector connects with verification ON and the user's source works from the tree but not from Test Connection, or the reverse)", async () => {
    const opted = { ...CONFIG, baseUrl: "https://10.0.0.5", allowInsecureTls: true };
    const runs: ((p: ReturnType<typeof createEveNgProvider>) => Promise<unknown>)[] = [
      (p) => p.fetchInventory(opted, SECRETS),
      (p) => p.testConnection(opted, SECRETS),
      (p) => p.fetchStatus!(opted, SECRETS),
      (p) => p.controlNode!(opted, SECRETS, "/Lab 1.unl#1", "start")
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
    await provider.fetchInventory({ ...CONFIG, baseUrl: "HTTPS://10.0.0.5", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls).toHaveLength(0);
  });

  /**
   * A4 — THE STRICTNESS IS LOAD-BEARING, and was unpinned: the negative cases
   * above only cover `false` and absent, so the mutation `if
   * (!config.allowInsecureTls)` passed every provider test. The string "true" is
   * reachable — a restored backup, or a hand-edited globalState, stores whatever
   * it holds — and under that mutation it turns certificate verification OFF for
   * a source whose owner never ticked a box.
   */
  it.each([["true"], ["false"], [1], [0], ["0"], ["yes"], [{}]])(
    "treats a NON-boolean %o as no opt-in at all and keeps the standard transport (⊘ a truthiness test turns verification off for a value the form can never produce)",
    async (value) => {
      const { standard, insecure, provider } = probes();
      await provider.fetchInventory(
        { ...CONFIG, baseUrl: "https://10.0.0.5", allowInsecureTls: value as unknown as boolean },
        SECRETS
      );
      expect(standard.calls.length).toBeGreaterThan(0);
      expect(insecure.calls).toHaveLength(0);
    }
  );

  /**
   * A4 — the URL-parse `catch` is OBSERVABLE, not dead: `new URL("https:")`
   * throws, so a base URL of `https:` or `https:/` with the box ticked reaches
   * it. The mutation `catch { return transports.insecure }` survived everything.
   * A base URL nothing can be parsed out of cannot have been proven https, so it
   * must not be answered by turning verification off.
   */
  it.each(["https:", "https:/"])(
    "falls back to the STANDARD transport for the unparseable base URL %o, even with the box ticked (⊘ a catch that returns the insecure transport relaxes TLS on a URL nobody could parse)",
    async (baseUrl) => {
      const { standard, insecure, provider } = probes();
      await provider.fetchInventory({ ...CONFIG, baseUrl, allowInsecureTls: true }, SECRETS).catch(() => undefined);
      expect(insecure.calls).toHaveLength(0);
    }
  );

  it("defaults the second argument to the real node:https adapter, so a provider built the way activate() builds it is not silently transport-less", () => {
    expect(() => createEveNgProvider(vi.fn() as unknown as typeof fetch)).not.toThrow();
  });
});

/**
 * INSECURE TLS — the error a user actually hits BEFORE they know the option
 * exists. `mapNetworkError` used to echo the bare node code
 * (`Could not reach 10.0.0.5: DEPTH_ZERO_SELF_SIGNED_CERT.`), which names the
 * problem in a vocabulary the user did not choose and offers no remedy — which
 * is why the person who reported this was stuck rather than merely refused.
 */
/**
 * A2 — DISCLOSURE AFTER THE FACT. `allowInsecureTls` is read once, at transport
 * selection, and then never surfaces again: a source whose base URL was later
 * repointed from a lab box at a remote (or production) EVE-NG keeps shipping the
 * password over an unauthenticated channel, and nothing in the plan, the tree or
 * the sync summary says so. It is also the answer to a restored backup enabling
 * the flag silently — the import trust boundary is already broad (a backup can
 * add telnet servers, proxies and jump hosts), so the fix is DISCLOSURE, not a
 * new gate: the first sync says out loud that verification is off.
 *
 * Rides the same `tree.warnings` channel the Pro-preliminary warning uses, so it
 * reaches the sync plan the same way. `fetchStatus` has no warnings channel
 * (`InventoryStatusReport` carries `statuses` + `truncated` only), so the sync
 * path is where this belongs.
 */
describe("createEveNgProvider — a sync run with verification off discloses it", () => {
  const WORLD: World = { folders: { "/": { labs: [{ file: "A.unl", path: "/A.unl" }, { file: "B.unl", path: "/B.unl" }] } }, nodes: { "/A.unl": { "1": node() }, "/B.unl": { "1": node() } } };

  /** Both transports stubbed, so an opted-in https config never opens a real socket. */
  function provider(): ReturnType<typeof createEveNgProvider> {
    return createEveNgProvider(makeWorld(WORLD).fetchImpl, makeWorld(WORLD).fetchImpl);
  }

  it("warns EXACTLY ONCE that this source's certificate is not verified, naming the option and the password exposure (⊘ a sync that silently ran unauthenticated — the whole point of the disclosure)", async () => {
    const tree = await provider().fetchInventory({ ...CONFIG, baseUrl: "https://10.0.0.5", allowInsecureTls: true }, SECRETS);
    expect(tree.devices).toHaveLength(2);
    expect((tree.warnings ?? []).filter((w) => w === EVE_NG_INSECURE_TLS_WARNING)).toHaveLength(1);
    // The two clauses that must survive any later rewording: the option the user
    // can turn back off, and what is actually crossing the unverified connection.
    expect(EVE_NG_INSECURE_TLS_WARNING).toContain("Allow a Self-Signed or Mismatched Certificate");
    expect(EVE_NG_INSECURE_TLS_WARNING.toLowerCase()).toContain("password");
  });

  it("says NOTHING for a source that is actually verifying its certificate (⊘ an unconditional warning trains the user to ignore the one that means something)", async () => {
    for (const config of [
      { baseUrl: "https://10.0.0.5", allowInsecureTls: false },
      { baseUrl: "https://10.0.0.5" },
      // Ticked but http: the selector keeps the standard transport, so nothing
      // was relaxed and there is nothing to disclose.
      { baseUrl: "http://eve.example.com", allowInsecureTls: true }
    ]) {
      const tree = await provider().fetchInventory({ ...CONFIG, ...config }, SECRETS);
      expect((tree.warnings ?? []).some((w) => w.includes("certificate"))).toBe(false);
    }
  });
});

describe("createEveNgProvider — certificate errors name the option", () => {
  /** A transport that fails exactly the way node fails a TLS verification. */
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
    const err = await createEveNgProvider(failsWith(code, viaCause))
      .testConnection({ ...CONFIG, baseUrl: "https://10.0.0.5" }, SECRETS)
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
    // A3 — the two shapes the set was short of, both of which the option fixes
    // identically to the five above.
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_NOT_YET_VALID"
  ];

  it.each(CERT_CODES)("names the option, and the host, instead of leaving %s to speak for itself (⊘ dropping the mapping restores the bare code, which is the state the user was stuck in)", async (code) => {
    const message = await messageFor(code);
    expect(message).toContain("10.0.0.5");
    expect(message).toContain("Allow a Self-Signed or Mismatched Certificate");
    expect(message).not.toBe(`Could not reach 10.0.0.5: ${code}.`);
  });

  it.each(CERT_CODES)("keeps %s itself in the message tail, because the code is what makes the failure diagnosable", async (code) => {
    expect(await messageFor(code)).toContain(code);
  });

  it("reads the code out of `cause` too — undici puts it there, and node:https puts it on the error itself", async () => {
    const message = await messageFor("DEPTH_ZERO_SELF_SIGNED_CERT", true);
    expect(message).toContain("Allow a Self-Signed or Mismatched Certificate");
  });

  it("explains the PRIVATE-CA case in its own terms — a chain this machine cannot complete is not a self-signed certificate, and the homelab shape right after self-signed/altname (⊘ borrowing the self-signed sentence describes a certificate the user does not have)", async () => {
    const message = await messageFor("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    // Anchored on the hint's own sentence shape, not merely on a word the bare
    // OpenSSL code happens to contain — otherwise the unmapped fallback
    // ("Could not reach 10.0.0.5: UNABLE_TO_GET_ISSUER_CERT_LOCALLY.") satisfies
    // a /issuer/ match and the test proves nothing.
    expect(message).toMatch(/^10\.0\.0\.5 presented /);
    expect(message.toLowerCase()).toMatch(/issuer|authority|chain/);
    expect(message).not.toBe(await messageFor("DEPTH_ZERO_SELF_SIGNED_CERT"));
  });

  it("explains NOT-YET-VALID as the clock case, distinctly from expired — the lab box with a dead RTC (⊘ collapsing the two tells someone whose certificate is fine that it expired)", async () => {
    const message = await messageFor("CERT_NOT_YET_VALID");
    expect(message).toMatch(/^10\.0\.0\.5 presented /);
    expect(message.toLowerCase()).toMatch(/not yet valid|clock/);
    expect(message).not.toBe(await messageFor("CERT_HAS_EXPIRED"));
  });

  it("calls out THE IP CASE for an altname mismatch specifically — a certificate that does not list the IP is the common shape of this failure and reads as unrelated otherwise", async () => {
    const message = (await messageFor("ERR_TLS_CERT_ALTNAME_INVALID")).toLowerCase();
    expect(message).toMatch(/ip address|address/);
    // The self-signed wording would be actively misleading here: the cert may be
    // perfectly well signed and simply issued for a different name.
    expect(await messageFor("DEPTH_ZERO_SELF_SIGNED_CERT")).not.toBe(await messageFor("ERR_TLS_CERT_ALTNAME_INVALID"));
  });

  it("leaves every NON-certificate code's wording exactly as it was (⊘ a greedy match rewrites ECONNREFUSED into advice about certificates)", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "CERT_SOMETHING_NEW"]) {
      expect(await messageFor(code)).toBe(`Could not reach 10.0.0.5: ${code}.`);
    }
  });

  it("still reports a timeout as a timeout — an abort has no code and must not be swept into the certificate branch", async () => {
    const timesOut = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(timesOut)
      .testConnection({ ...CONFIG, baseUrl: "https://10.0.0.5" }, SECRETS)
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("Connection to 10.0.0.5 timed out.");
  });
});

describe("createEveNgProvider — the certificate hint and the field agree", () => {
  it("names the option by its EXACT form label (⊘ a hint pointing at a control the user cannot find by that name is worse than the bare OpenSSL code it replaced)", async () => {
    const label = createEveNgProvider(vi.fn() as unknown as typeof fetch).configFields.find((f) => f.id === "allowInsecureTls")!.label;
    const failing = (async () => {
      throw Object.assign(new Error("fetch failed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    }) as unknown as typeof fetch;
    const err = await createEveNgProvider(failing)
      .testConnection({ ...CONFIG, baseUrl: "https://10.0.0.5" }, SECRETS)
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain(label);
  });
});
