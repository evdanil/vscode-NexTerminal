import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EVE_NG_PROVIDER_ID, createEveNgProvider, eveNgInstanceKey } from "../../src/services/inventory/providers/eveNgProvider";
import { validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { computeSyncPlan, validateInventoryTree } from "../../src/services/inventory/syncEngine";

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
      "consoleHost"
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

  it("warns in the baseUrl description that self-signed HTTPS is unsupported (the failure is otherwise an opaque fetch error)", () => {
    const provider = createEveNgProvider(vi.fn() as unknown as typeof fetch);
    expect(provider.configFields.find((f) => f.id === "baseUrl")?.description?.toLowerCase()).toContain("self-signed");
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
      return makeResponse(200, jsend({ version: world.version ?? "5.0.1-13" }));
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

  it("applies `filter` as a case-insensitive substring of the lab's full path, and never even asks for a non-matching lab's nodes", async () => {
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

  it("emits a node with a non-telnet console (or no console URL at all) WITH NO ENDPOINTS rather than dropping it, and reports the count ONCE (⊘ dropping the device reads as \"deleted at the source\" and prunes the server; one warning per node buries the summary)", async () => {
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
    const consoleWarnings = (tree.warnings ?? []).filter((w) => w.includes("telnet console"));
    expect(consoleWarnings).toHaveLength(1);
    expect(consoleWarnings[0]).toContain("3");
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

describe("createEveNgProvider — error mapping", () => {
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

  it("maps a non-JSON body (a proxy's HTML error page) to `protocol` with a BOUNDED slice of it (⊘ echoing the whole body puts a full HTML page into a notification)", async () => {
    const html = `<!doctype html><html><body>${"x".repeat(5_000)}</body></html>`;
    const fetchImpl = (async () => makeResponse(200, html, [`unetlab_session=${SESSION}`])) as unknown as typeof fetch;
    const err = await createEveNgProvider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as Error).message.length).toBeLessThan(500);
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
