import { describe, expect, it, vi } from "vitest";
import {
  GNS3_INSECURE_TLS_WARNING,
  GNS3_PROVIDER_ID,
  GNS3_STATUS_POLL_FIELD_ID,
  createGns3Provider,
  gns3InstanceKey,
  readGns3StatusPollSeconds
} from "../../src/services/inventory/providers/gns3Provider";
import { validateProviderShape } from "../../src/services/inventory/providerRegistry";
import { ADVANCED_SECTION_LABEL } from "../../src/ui/formTypes";
import {
  InventoryProviderError,
  resolveStatusTruncationRemedy,
  type InventoryConfigField,
  type InventoryStatusReport,
  type InventoryTree
} from "../../src/models/inventory";

// ---------------------------------------------------------------------------
// The fake world. No `vi.mock` anywhere in this file: the provider is
// vscode-free and takes its transport by injection, so the "world" is a routed
// fetch keyed by pathname. AN UNROUTED PATH ANSWERS 500, deliberately — a
// request the provider makes that this world did not anticipate must show up as
// a loud failure rather than as a silently empty result.
// ---------------------------------------------------------------------------

const TOKEN = "jwt-access-token";
const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const NODE_ID = "22222222-2222-2222-2222-222222222222";

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): unknown {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  return {
    status,
    text: async () => text,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null }
  };
}

interface World {
  /** Which API this fake controller serves. Default v2 (GNS3 2.2). */
  api?: "v2" | "v3";
  /** GNS3 2.2 with `auth=True`: every unauthenticated request is refused 401. */
  v2RequiresAuth?: boolean;
  /** Suppress the `WWW-Authenticate: Basic` header on that 401. */
  v2OmitAuthenticateHeader?: boolean;
  /**
   * A reverse proxy with an HTTP Basic wall in front of the controller: EVERY
   * unauthenticated request is refused `401 + WWW-Authenticate: Basic`,
   * `/v3/version` included. A real deployment shape, and the one a status-code
   * -only detection rule reads as "a 3.x controller".
   */
  proxyBasicWall?: boolean;
  projects?: Record<string, unknown>[];
  /** Raw node arrays keyed by project id. A project absent here answers 404. */
  nodes?: Record<string, unknown[]>;
  /** Force a status on `GET .../projects` (error-mapping tests). */
  projectsHttp?: number;
  projectsBody?: unknown;
  /** Force a status/body on a node-action POST. */
  actionHttp?: number;
  actionBody?: unknown;
}

interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  init?: RequestInit;
}

function makeWorld(world: World): { fetchImpl: typeof fetch; calls: Call[] } {
  const api = world.api ?? "v2";
  const calls: Call[] = [];
  const impl = async (input: string, init?: RequestInit): Promise<unknown> => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: input,
      path,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      init
    });

    // The wall sits in FRONT of every path, so it answers before any route
    // below — which is the whole point: the proxy has no idea what `/v3` is.
    if (world.proxyBasicWall && !headers.Authorization) {
      return makeResponse(401, { message: "Unauthorized" }, { "WWW-Authenticate": 'Basic realm="lab"' });
    }

    // --- version probes -----------------------------------------------------
    if (path === "/v3/version") {
      return api === "v3" ? makeResponse(200, { version: "3.0.5" }) : makeResponse(404, { message: "Not Found" });
    }
    if (path === "/v2/version") {
      if (api !== "v2") {
        return makeResponse(404, { message: "Not Found" });
      }
      if (world.v2RequiresAuth && !headers.Authorization) {
        return makeResponse(
          401,
          { message: "Unauthorized", status: 401 },
          world.v2OmitAuthenticateHeader ? {} : { "WWW-Authenticate": 'Basic realm="GNS3 server"' }
        );
      }
      return makeResponse(200, { version: "2.2.49" });
    }
    if (path === "/v3/access/users/authenticate") {
      return makeResponse(200, { access_token: TOKEN, token_type: "bearer" });
    }

    const prefix = `/${api}`;
    if (!path.startsWith(`${prefix}/`)) {
      return makeResponse(500, "unrouted");
    }
    const rest = path.slice(prefix.length);

    // --- project list -------------------------------------------------------
    if (rest === "/projects") {
      if (world.projectsHttp !== undefined && world.projectsHttp !== 200) {
        return makeResponse(world.projectsHttp, world.projectsBody ?? { message: "nope" });
      }
      // `hasOwnProperty`, not `??`: a test that routes a literal `null` body is
      // testing exactly the value `??` would fold back onto the default.
      if (Object.prototype.hasOwnProperty.call(world, "projectsBody")) {
        return makeResponse(200, world.projectsBody);
      }
      return makeResponse(200, world.projects ?? []);
    }

    // --- node list ----------------------------------------------------------
    const nodeList = /^\/projects\/([^/]+)\/nodes$/.exec(rest);
    if (nodeList) {
      const nodes = world.nodes?.[nodeList[1]];
      if (nodes === undefined) {
        return makeResponse(404, { message: "Project not found" });
      }
      return makeResponse(200, nodes);
    }

    // --- node action --------------------------------------------------------
    const nodeAction = /^\/projects\/([^/]+)\/nodes\/([^/]+)\/(start|stop)$/.exec(rest);
    if (nodeAction) {
      if (world.actionHttp !== undefined && world.actionHttp !== 200) {
        return makeResponse(world.actionHttp, world.actionBody ?? { message: "refused" });
      }
      // v2 answers 200 with the node; v3 answers 204 with an empty body.
      return api === "v3" ? makeResponse(204, "") : makeResponse(200, node());
    }

    return makeResponse(500, "unrouted");
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { project_id: PROJECT_ID, name: "Lab One", status: "opened", ...overrides };
}

/** A running qemu node with a telnet console on the default `0.0.0.0` host. */
function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: NODE_ID,
    name: "R1",
    node_type: "qemu",
    status: "started",
    console: 5000,
    console_host: "0.0.0.0",
    console_type: "telnet",
    compute_id: "local",
    ...overrides
  };
}

/** One project holding `nodes`, the shape most tests vary from. */
function oneProjectWorld(nodes: Record<string, unknown>[], projectOverrides: Record<string, unknown> = {}, api: "v2" | "v3" = "v2"): World {
  return { api, projects: [project(projectOverrides)], nodes: { [PROJECT_ID]: nodes } };
}

const CONFIG = { baseUrl: "http://gns3.example.com:3080", username: "admin" };
const SECRETS = { password: "pw" };

async function fetchTree(world: World, config: Record<string, string | number | boolean> = {}): Promise<InventoryTree> {
  const { fetchImpl } = makeWorld(world);
  return createGns3Provider(fetchImpl).fetchInventory({ ...CONFIG, ...config }, SECRETS);
}

async function fetchStatus(world: World, config: Record<string, string | number | boolean> = {}): Promise<InventoryStatusReport> {
  const { fetchImpl } = makeWorld(world);
  const provider = createGns3Provider(fetchImpl);
  return provider.fetchStatus!({ ...CONFIG, ...config }, SECRETS);
}

// ---------------------------------------------------------------------------
// instanceKey
// ---------------------------------------------------------------------------

/**
 * This key decides whether a server kept from a removed source may be reclaimed
 * by a later one (see `DetachedServerOrigin.instanceKey`, models/config.ts). Two
 * deployments must never collide onto one key, and one deployment must not
 * fragment into several — the first loses a record to a source that never
 * synced it, the second breaks the re-add the feature exists for.
 */
describe("gns3InstanceKey", () => {
  it("collapses every spelling of ONE controller onto ONE key — trailing slashes, host case, a pasted /v2 or /v3 suffix, a stray query/fragment (⊘ a raw-string key fragments one server into nine and refuses the re-add adoption exists for)", () => {
    const canonical = "http://gns3.example.com:3080";
    for (const spelling of [
      "http://gns3.example.com:3080",
      "http://gns3.example.com:3080/",
      "http://gns3.example.com:3080///",
      "http://GNS3.Example.COM:3080",
      "  http://gns3.example.com:3080  ",
      "http://gns3.example.com:3080/v2",
      "http://gns3.example.com:3080/v3",
      "http://gns3.example.com:3080/v3/",
      "http://gns3.example.com:3080?foo=bar",
      "http://gns3.example.com:3080#frag"
    ]) {
      expect(gns3InstanceKey({ baseUrl: spelling })).toBe(canonical);
    }
  });

  it("KEEPS the port, which on GNS3 is never the scheme's default (⊘ dropping it collapses two controllers sharing one host — the normal way to run a second GNS3 — onto one identity)", () => {
    const a = gns3InstanceKey({ baseUrl: "http://gns3.example.com:3080" });
    const b = gns3InstanceKey({ baseUrl: "http://gns3.example.com:3081" });
    expect(a).toBe("http://gns3.example.com:3080");
    expect(a).not.toBe(b);
  });

  it("KEEPS a real mount path and its case, so two proxied controllers on one host stay distinct (⊘ dropping the path lets one source adopt the other's kept servers)", () => {
    expect(gns3InstanceKey({ baseUrl: "https://gw.example.com/gns3a/" })).toBe("https://gw.example.com/gns3a");
    expect(gns3InstanceKey({ baseUrl: "https://gw.example.com/GNS3A" })).toBe("https://gw.example.com/GNS3A");
    expect(gns3InstanceKey({ baseUrl: "https://gw.example.com/gns3a" })).not.toBe(gns3InstanceKey({ baseUrl: "https://gw.example.com/gns3b" }));
  });

  it("keeps the scheme — http and https on one host are two deployments as far as adoption is concerned (⊘ over-normalizing is the failure that transfers a record)", () => {
    expect(gns3InstanceKey({ baseUrl: "http://gns3.example.com:3080" })).not.toBe(gns3InstanceKey({ baseUrl: "https://gns3.example.com:3080" }));
  });

  it("NEVER carries userinfo — the server URL is a NON-secret field whose value is persisted on every kept server and copied into backups (⊘ returning the URL as typed leaks a password into globalState)", () => {
    const key = gns3InstanceKey({ baseUrl: "http://admin:s3cr3t@gns3.example.com:3080/" });
    expect(key).toBe("http://gns3.example.com:3080");
    expect(key).not.toContain("s3cr3t");
    expect(key).not.toContain("admin");
  });

  it("returns undefined — no instance identity, therefore no adoption — for a server URL nothing could be fetched from (⊘ inventing a key for an endpoint that does not resolve)", () => {
    // A scheme-less host is the common typo, and on GNS3 an especially nasty
    // one: because the address carries a port, `gns3.local:3080` PARSES — as
    // the scheme `gns3.local:` with the opaque path `3080` — so a key derived
    // from `new URL` alone comes back as the plausible-looking nonsense
    // `gns3.local://3080` rather than as "no identity".
    expect(gns3InstanceKey({ baseUrl: "gns3.local:3080" })).toBeUndefined();
    expect(gns3InstanceKey({ baseUrl: "ftp://gns3.example.com" })).toBeUndefined();
    expect(gns3InstanceKey({ baseUrl: "" })).toBeUndefined();
    expect(gns3InstanceKey({ baseUrl: "   " })).toBeUndefined();
    expect(gns3InstanceKey({})).toBeUndefined();
  });

  it("is exposed ON the provider, the only way the engine ever reaches it (⊘ an implementation that exists but is never wired up)", () => {
    const provider = createGns3Provider(vi.fn() as unknown as typeof fetch);
    expect(typeof provider.instanceKey).toBe("function");
    expect(provider.instanceKey?.({ baseUrl: "http://gns3.example.com:3080/v3/" })).toBe("http://gns3.example.com:3080");
  });
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("createGns3Provider — shape", () => {
  const provider = (): ReturnType<typeof createGns3Provider> => createGns3Provider(vi.fn() as unknown as typeof fetch);

  it("registers under the id and label the rest of the extension keys off", () => {
    expect(provider().id).toBe(GNS3_PROVIDER_ID);
    expect(GNS3_PROVIDER_ID).toBe("gns3");
    expect(provider().label).toBe("GNS3");
  });

  /**
   * THE FIELD ORDER IS FINGERPRINTED. `computeProviderFingerprint`
   * (models/inventory.ts) hashes each field's id, label, type and required flag
   * IN ORDER and stamps the result on every saved source; a source whose stamp
   * no longer matches must re-confirm its credentials before it will sync. So
   * this list is APPEND-ONLY from the moment the provider ships, and this test
   * is the thing that says so out loud.
   */
  it("declares exactly these config fields, in exactly this order (⊘ reordering or inserting a field silently re-prompts every existing GNS3 source for its password)", () => {
    expect(provider().configFields.map((f: InventoryConfigField) => f.id)).toEqual([
      "baseUrl",
      "username",
      "password",
      "filter",
      "consoleHost",
      "allowInsecureTls",
      GNS3_STATUS_POLL_FIELD_ID
    ]);
  });

  it("passes the public registration boundary with its real defaults, the way activate() builds it (⊘ a shape mistake that only shows up when a user adds a source)", () => {
    expect(() => validateProviderShape(createGns3Provider())).not.toThrow();
    expect(() => validateProviderShape(provider())).not.toThrow();
  });

  /**
   * The id/type pair is what attaches the shared saved-filter picker above the
   * field (`SAVED_FILTER_TARGET_FIELD_ID`, ui/formDefinitions.ts). Renaming the
   * field to `projectFilter`, or typing it as anything but a string, silently
   * removes the picker with nothing on screen to say why.
   */
  it("names the filter field `filter` and types it `string`, which is what attaches the saved-filter picker (⊘ any other id or type drops the picker silently)", () => {
    const filter = provider().configFields.find((f: InventoryConfigField) => f.id === "filter");
    expect(filter?.type).toBe("string");
    expect(filter?.required).not.toBe(true);
  });

  it("marks only baseUrl required — a stock GNS3 2.2 runs with auth disabled and has no username at all (⊘ requiring credentials refuses a normal 2.2 server at the form)", () => {
    const required = provider()
      .configFields.filter((f: InventoryConfigField) => f.required === true)
      .map((f: InventoryConfigField) => f.id);
    expect(required).toEqual(["baseUrl"]);
  });

  it("hides the two switches that change behaviour behind the Advanced disclosure, and names that section in the base-URL hint so it can be found", () => {
    const advanced = provider()
      .configFields.filter((f: InventoryConfigField) => f.advanced === true)
      .map((f: InventoryConfigField) => f.id);
    expect(advanced).toEqual(["allowInsecureTls", GNS3_STATUS_POLL_FIELD_ID]);
    const baseUrl = provider().configFields.find((f: InventoryConfigField) => f.id === "baseUrl");
    expect(baseUrl?.description).toContain(ADVANCED_SECTION_LABEL);
    // The port is the other thing a GNS3 user gets wrong: 3080 is not any
    // scheme's default, so a URL without it reaches nothing.
    expect(baseUrl?.placeholder).toContain("3080");
    expect(baseUrl?.description).toContain("3080");
  });

  it("bounds the poll field and refuses a fraction, so a hand-typed 0.5 cannot arm a sub-second timer at the form", () => {
    const field = provider().configFields.find((f: InventoryConfigField) => f.id === GNS3_STATUS_POLL_FIELD_ID);
    expect(field?.type).toBe("number");
    expect(field?.min).toBe(0);
    expect(field?.max).toBe(3600);
    expect(field?.integer).toBe(true);
  });

  it("declares a GNS3-specific remedy for a truncated status scan, naming the field that narrows the crawl (⊘ without it a partial refresh falls back to the neutral line and never says which field bounds the crawl)", () => {
    const remedy = resolveStatusTruncationRemedy(provider());
    expect(remedy).toBeDefined();
    expect(remedy).toContain("Project Filter");
  });

  it("declares every attribute key it actually emits, so a template rule filtering on one is never warned off a key that works", async () => {
    const tree = await fetchTree(oneProjectWorld([node()]));
    const emitted = Object.keys(tree.devices[0].attributes ?? {});
    expect(new Set(createGns3Provider(vi.fn() as unknown as typeof fetch).attributeKeys)).toEqual(
      new Set(["project", "type", "console", "status", "compute", "name"])
    );
    for (const key of emitted) {
      expect(createGns3Provider(vi.fn() as unknown as typeof fetch).attributeKeys).toContain(key);
    }
  });

  /**
   * ⊘ ABSENCE PIN — `canControlNode`. The contract (models/inventory.ts) says an
   * ABSENT member means every device is controllable, and that a member which IS
   * present must AGREE with `controlNode`'s refusals. `controlNodeImpl` refuses
   * exactly one class of node — one in a CLOSED project — and that is live state
   * the externalId does not encode, so a gate could only answer from a cache
   * that is empty before the first crawl and stale after the user opens the
   * project in GNS3. Implementing it from that cache would HIDE a menu for an
   * action that now works, with nothing on screen to explain the absence. The
   * refusal is made worth reading instead (see the closed-project tests below).
   */
  it("⊘ implements NO canControlNode — the only refusal is live state the externalId cannot carry, so the gate would hide a working Start on a project the user just opened", () => {
    expect(createGns3Provider(vi.fn() as unknown as typeof fetch).canControlNode).toBeUndefined();
  });

  /**
   * ⊘ ABSENCE PIN — the web-console pair. GNS3's web UI has no per-node console
   * page to hand a browser: a node's console IS the telnet/VNC endpoint the
   * device already carries. Implementing `webConsoleUrl` to return the server
   * root would stamp an "Open Web Console" marker on every row and land the user
   * somewhere that is not that node's console.
   */
  it("⊘ implements NO webConsoleUrl and NO canWebConsole — a GNS3 node has no browser console page, and a member returning the server root would put the marker on every row", () => {
    const p = createGns3Provider(vi.fn() as unknown as typeof fetch);
    expect(p.webConsoleUrl).toBeUndefined();
    expect(p.canWebConsole).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readGns3StatusPollSeconds
// ---------------------------------------------------------------------------

/**
 * TOTAL BY DESIGN. The form bounds the value on the way IN, but a source
 * restored from a hand-edited backup never went through the form — and an
 * unclamped read there arms a millisecond-period timer against a lab
 * controller, or a `NaN` period, which reports itself as running and never
 * fires.
 */
describe("readGns3StatusPollSeconds", () => {
  it("reads an absent field as OFF, which is what every source predating the field must mean (⊘ returning NaN arms a timer that reports itself running and never fires)", () => {
    expect(readGns3StatusPollSeconds({})).toBe(0);
    expect(readGns3StatusPollSeconds({ statusPollSeconds: Number.NaN })).toBe(0);
  });

  it("reads a non-number as OFF — the form never stores one, but a hand-edited backup can (⊘ Number(value) turns the string \"30\" into a poll the user never configured, and \"abc\" into NaN)", () => {
    expect(readGns3StatusPollSeconds({ statusPollSeconds: "30" as unknown as number })).toBe(0);
    expect(readGns3StatusPollSeconds({ statusPollSeconds: true as unknown as number })).toBe(0);
  });

  it("clamps to the declared bounds rather than trusting the stored number (⊘ an unclamped read arms a millisecond-period timer against the controller)", () => {
    expect(readGns3StatusPollSeconds({ statusPollSeconds: -5 })).toBe(0);
    expect(readGns3StatusPollSeconds({ statusPollSeconds: 999_999 })).toBe(3600);
    expect(readGns3StatusPollSeconds({ statusPollSeconds: Number.POSITIVE_INFINITY })).toBe(3600);
    expect(readGns3StatusPollSeconds({ statusPollSeconds: Number.NEGATIVE_INFINITY })).toBe(0);
  });

  it("FLOORS a fraction, so 0.4 lands on OFF rather than on a sub-second period (⊘ Math.round makes 0.6 a one-second poll the user never asked for)", () => {
    expect(readGns3StatusPollSeconds({ statusPollSeconds: 0.4 })).toBe(0);
    expect(readGns3StatusPollSeconds({ statusPollSeconds: 0.9 })).toBe(0);
    expect(readGns3StatusPollSeconds({ statusPollSeconds: 1.9 })).toBe(1);
  });

  it("passes a normal value straight through", () => {
    expect(readGns3StatusPollSeconds({ statusPollSeconds: 30 })).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

describe("createGns3Provider — API version detection", () => {
  it("probes /v3/version FIRST and, on a 200, speaks v3 for every later request (⊘ probing /v2 first misidentifies a 3.x controller, which serves no /v2 at all)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()], {}, "v3"));
    await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(calls[0].path).toBe("/v3/version");
    expect(calls.some((c) => c.path === "/v2/version")).toBe(false);
    expect(calls.some((c) => c.path === "/v3/projects")).toBe(true);
  });

  it("falls back to /v2/version on a 404 and then speaks v2 (⊘ treating the 404 as fatal refuses every GNS3 2.2 server)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
    await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(calls.map((c) => c.path).slice(0, 2)).toEqual(["/v3/version", "/v2/version"]);
    expect(calls.some((c) => c.path === "/v2/projects")).toBe(true);
    expect(calls.some((c) => c.path.startsWith("/v3/") && c.path !== "/v3/version")).toBe(false);
  });

  /**
   * GNS3 2.2 with `auth=True` answers 401 to EVERY request, `/v2/version`
   * included — there is no unauthenticated endpoint to identify it by. A
   * 200-only detection rule therefore refuses to talk to an authenticated 2.2
   * server at all, which is the configuration a user who cares about their lab
   * is most likely to be running.
   */
  it("reads a 401 carrying `WWW-Authenticate: Basic` on /v2/version as a v2 server (⊘ a 200-only rule cannot identify GNS3 2.2 with auth enabled, which 401s every single request)", async () => {
    const world = oneProjectWorld([node()]);
    world.v2RequiresAuth = true;
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(calls.some((c) => c.path === "/v2/projects")).toBe(true);
  });

  it("does NOT read a bare 401 with no Basic challenge as a v2 server, and says what both probes answered (⊘ accepting any 401 identifies a reverse proxy's login wall as a GNS3 controller and then blames the credentials)", async () => {
    const world = oneProjectWorld([node()]);
    world.v2RequiresAuth = true;
    world.v2OmitAuthenticateHeader = true;
    const { fetchImpl } = makeWorld(world);
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as InventoryProviderError).message).toContain("/v3/version");
    expect((err as InventoryProviderError).message).toContain("/v2/version");
    expect((err as InventoryProviderError).message).toContain("3080");
  });

  /**
   * THE TYPO THE BASE-URL FIELD PREDICTS. Omitting `:3080` sends the probe to
   * port 80, where a generic web server or an SPA reverse proxy (`try_files …
   * /index.html`) answers 200 with HTML for every path. Read as "a 3.x
   * controller" on the status code alone, that lands the user in the
   * authentication path — told to add a username and password (which fixes
   * nothing) or that the login "returned no access_token". Neither remedy can
   * happen; the one that can is the message this function already has.
   */
  it("does NOT read a 200 of HTML on /v3/version as a 3.x controller, and refuses with the URL/port remedy (⊘ a status-code-only rule sends the `:3080`-less typo down the authentication path, where every remedy offered is a lie)", async () => {
    const html = "<!doctype html><html><body>Welcome to nginx</body></html>";
    const spa = (async () => makeResponse(200, html)) as unknown as typeof fetch;
    const err = await createGns3Provider(spa)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    const message = (err as InventoryProviderError).message;
    expect(message).toContain("3080");
    expect(message).toContain("/v3/version");
    expect(message).toContain("/v2/version");
    // ⊘ The two misdetection dead ends, neither of which names a remedy the
    // user can act on.
    expect(message).not.toContain("access_token");
    expect(message).not.toContain("requires a username and password");
  });

  it("probes /v2/version after a 200 of HTML on /v3/version, rather than stopping at the status code (⊘ accepting the 200 never asks the other probe and loses the evidence the refusal is built from)", async () => {
    const seen: string[] = [];
    const spa = (async (input: string) => {
      seen.push(new URL(String(input)).pathname);
      return makeResponse(200, "<html>index</html>");
    }) as unknown as typeof fetch;
    await createGns3Provider(spa)
      .fetchInventory(CONFIG, SECRETS)
      .catch(() => undefined);
    // The first two calls only: what happens AFTER the second probe is the next
    // test's business, so this one stays red for its own reason alone.
    expect(seen.slice(0, 2)).toEqual(["/v3/version", "/v2/version"]);
  });

  it("does NOT accept a 200 whose JSON carries no `version` field (⊘ any-JSON-will-do passes a proxy's `{\"status\":\"ok\"}` health page off as a controller)", async () => {
    const fetchImpl = (async () => makeResponse(200, { status: "ok" })) as unknown as typeof fetch;
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    const message = (err as InventoryProviderError).message;
    expect(message).toContain("did not answer as a GNS3 controller");
    // ⊘ NOT the login dead end: this body would satisfy a JSON-shaped check and
    // then fail on the missing token, blaming the credentials instead.
    expect(message).not.toContain("access_token");
  });

  /**
   * A Basic wall in front of a 2.2 controller answers `401 + WWW-Authenticate:
   * Basic` on EVERY path, `/v3/version` included. Read as v3, the JSON login
   * POST is what 401s next and the user is told their credentials were
   * rejected — while the Basic header a v2 source would have sent is never
   * tried. The provider's own v2 rule four lines below already treats a Basic
   * challenge as evidence of Basic auth; this makes the two agree.
   */
  it("falls through to the v2 probe on a 401 whose challenge is Basic, and syncs over HTTP Basic (⊘ reading any 401 as v3 sends a JSON login into a Basic wall and blames a password that works)", async () => {
    const world = oneProjectWorld([node()]);
    world.proxyBasicWall = true;
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(calls.map((c) => c.path).slice(0, 2)).toEqual(["/v3/version", "/v2/version"]);
    const projects = calls.find((c) => c.path === "/v2/projects");
    expect(projects?.headers.Authorization).toBe(`Basic ${Buffer.from("admin:pw").toString("base64")}`);
    // ⊘ The login POST that the misdetection would have issued never happens.
    expect(calls.some((c) => c.path === "/v3/access/users/authenticate")).toBe(false);
  });

  it("⊘ produces no rejected-credentials message for a Basic wall in front of a 2.2 controller (⊘ the v3 misreading fails the sync by blaming the user's password)", async () => {
    const world = oneProjectWorld([node()]);
    world.proxyBasicWall = true;
    const { fetchImpl } = makeWorld(world);
    const result = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect(result).not.toBeInstanceOf(InventoryProviderError);
  });

  /**
   * The defensive half of the v3 rule still stands: a token challenge on a route
   * a 2.2 controller does not serve at all is the server saying which API it
   * speaks, and falling through would end in "could not identify" on a server we
   * had just identified.
   */
  it("still reads a 401 challenging for Bearer on /v3/version as v3 (⊘ excluding every 401 refuses a 3.x controller that protects its version route)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/v3/version") return makeResponse(401, { message: "Not authenticated" }, { "WWW-Authenticate": "Bearer" });
      if (path === "/v3/access/users/authenticate") return makeResponse(200, { access_token: TOKEN, token_type: "bearer" });
      if (path === "/v3/projects") return makeResponse(200, [project()]);
      if (path === `/v3/projects/${PROJECT_ID}/nodes`) return makeResponse(200, [node()]);
      return makeResponse(500, "unrouted");
    }) as unknown as typeof fetch;

    const tree = await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(tree.devices).toHaveLength(1);
    expect(calls).not.toContain("/v2/version");
  });

  /**
   * Codex P1 (#146). A GNS3 controller — or a reverse proxy in front of one —
   * supplies these strings, and they land in a notification whose other lines
   * this codebase wrote. AGENTS.md: sanitize where the text ENTERS the composed
   * string, never at the render site.
   */
  it("⊘ flattens newlines and control characters out of a server error body before it reaches the message (⊘ a newline mints a notification line that reads like one of ours)", async () => {
    const nasty = "denied\nNexus: 4 servers were deleted\u202ereversed";
    const fetchImpl = (async (url: string) =>
      String(url).includes("/v3/version")
        ? makeResponse(200, { version: "3.0.5" })
        : makeResponse(500, { message: nasty })) as unknown as typeof fetch;

    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);

    const message = (err as InventoryProviderError).message;
    expect(message).toContain("denied");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\u202e");
  });

  it("⊘ flattens a server-supplied project id before it reaches a sync-failure message (⊘ the first sweep covered the response body and the project NAME and missed the id in four other messages)", async () => {
    const nastyId = "p1\nNexus: 4 servers were deleted";
    const fetchImpl = (async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v3/version") return makeResponse(200, { version: "3.0.5" });
      if (path === "/v3/access/users/authenticate") return makeResponse(200, { access_token: "t", token_type: "bearer" });
      if (path === "/v3/projects") return makeResponse(200, [{ project_id: nastyId, name: "lab", status: "opened" }]);
      // Malformed node list — an array is required, so this fails the sync and
      // composes a message naming the project id.
      return makeResponse(200, { not: "an array" });
    }) as unknown as typeof fetch;

    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);

    const message = (err as InventoryProviderError).message;
    expect(message).toContain("malformed node list");
    expect(message).not.toContain("\n");
  });

  it("fails as `protocol` — not as empty inventory — when neither probe identifies a controller (⊘ returning no devices makes computeSyncPlan prune every server this source owns)", async () => {
    const fetchImpl = (async () => makeResponse(404, "nope")) as unknown as typeof fetch;
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
  });

  it("detects ONCE per operation, never per request (⊘ re-probing per request triples the round trips against a controller that serves closed projects off disk)", async () => {
    const projects = [project({ project_id: "p1", name: "A" }), project({ project_id: "p2", name: "B" })];
    const { fetchImpl, calls } = makeWorld({ api: "v2", projects, nodes: { p1: [node()], p2: [node({ node_id: "n2" })] } });
    await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(calls.filter((c) => c.path === "/v3/version")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/v2/version")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("createGns3Provider — authentication", () => {
  it("logs in at /v3/access/users/authenticate — the path carries an `/access` segment — and sends the credentials as a JSON body (⊘ posting to /v3/users/authenticate 404s and reports a working password as wrong)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()], {}, "v3"));
    await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    const login = calls.find((c) => c.path.includes("authenticate"));
    expect(login?.path).toBe("/v3/access/users/authenticate");
    expect(login?.method).toBe("POST");
    expect(JSON.parse(login?.body ?? "{}")).toEqual({ username: "admin", password: "pw" });
  });

  it("carries the JWT as `Authorization: Bearer` on every v3 API request (⊘ sending Basic to a 3.x controller is refused on every call)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()], {}, "v3"));
    await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    const api = calls.filter((c) => c.path.startsWith("/v3/projects"));
    expect(api.length).toBeGreaterThan(0);
    for (const call of api) {
      expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("sends HTTP Basic on v2 when the source carries a username (⊘ omitting it fails on every 2.2 server with auth enabled)", async () => {
    const world = oneProjectWorld([node()]);
    world.v2RequiresAuth = true;
    const { fetchImpl, calls } = makeWorld(world);
    await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    const projects = calls.find((c) => c.path === "/v2/projects");
    expect(projects?.headers.Authorization).toBe(`Basic ${Buffer.from("admin:pw").toString("base64")}`);
  });

  it("sends NO Authorization header on v2 when the source has no username — a stock 2.2 runs with auth disabled (⊘ sending `Basic OnB3` mints a credential out of an empty username)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
    await createGns3Provider(fetchImpl).fetchInventory({ baseUrl: CONFIG.baseUrl }, {});
    for (const call of calls) {
      expect(call.headers.Authorization).toBeUndefined();
    }
  });

  it("refuses a v3 server with no username as `auth`, naming what to add (⊘ posting an empty username to the JWT endpoint reports the server as broken instead of the source as incomplete)", async () => {
    const { fetchImpl } = makeWorld(oneProjectWorld([node()], {}, "v3"));
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory({ baseUrl: CONFIG.baseUrl }, {})
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("auth");
    expect((err as InventoryProviderError).message).toContain("3.x");
  });

  /**
   * GNS3 3.0.5 issues a 24h token and exposes NO refresh endpoint, so the only
   * correct response to an expired one is to log in again — ONE extra round
   * trip, never a loop against the lab server, and never clock arithmetic on the
   * expiry (the client's clock is not the server's, and a 401 is the only
   * authority on whether a token still works).
   */
  it("re-logs in EXACTLY ONCE on a mid-crawl 401 and then gives up (⊘ no retry fails a long sync on an aged token; an unbounded retry hammers the controller with a wrong password)", async () => {
    let logins = 0;
    let projectReads = 0;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      if (path === "/v3/version") return makeResponse(200, { version: "3.0.5" });
      if (path === "/v3/access/users/authenticate") {
        logins++;
        return makeResponse(200, { access_token: `${TOKEN}-${logins}`, token_type: "bearer" });
      }
      if (path === "/v3/projects") {
        projectReads++;
        // Always 401: the point is that the client stops, not that it recovers.
        return makeResponse(401, { message: "Not authenticated" });
      }
      void init;
      return makeResponse(500, "unrouted");
    }) as unknown as typeof fetch;

    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("auth");
    expect(logins).toBe(2); // the initial login, plus exactly one re-login
    expect(projectReads).toBe(2); // the original request, plus exactly one retry
  });

  it("does NOT retry a v2 401 — Basic carries no session, so replaying it just sends the same rejected header twice (⊘ a version-blind retry doubles every failed request against a 2.2 server)", async () => {
    let projectReads = 0;
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/v3/version") return makeResponse(404, "no");
      if (path === "/v2/version") return makeResponse(200, { version: "2.2.49" });
      if (path === "/v2/projects") {
        projectReads++;
        return makeResponse(401, { message: "Unauthorized" });
      }
      return makeResponse(500, "unrouted");
    }) as unknown as typeof fetch;
    await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS).catch(() => undefined);
    expect(projectReads).toBe(1);
  });

  it("fails as `protocol`, not `auth`, when the login is accepted but carries no access_token (⊘ carrying on token-less 401s on the next call and points the user at a password that is correct)", async () => {
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/v3/version") return makeResponse(200, { version: "3.0.5" });
      if (path === "/v3/access/users/authenticate") return makeResponse(200, { token_type: "bearer" });
      return makeResponse(500, "unrouted");
    }) as unknown as typeof fetch;
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as InventoryProviderError).message).toContain("access_token");
  });
});

// ---------------------------------------------------------------------------
// The crawl: closed projects, and the mutation that must never happen
// ---------------------------------------------------------------------------

describe("createGns3Provider — the crawl visits closed projects", () => {
  /**
   * THE CENTRAL FACT ABOUT GNS3. `GET /projects/{id}/nodes` answers 200 for a
   * CLOSED project too — the controller reads the topology off disk — and a
   * GNS3 server's projects are closed most of the time. A crawl that skipped
   * them would import nothing on a typical install, and the SECOND sync would
   * then prune every server the first one created.
   */
  it("still fetches the nodes of a CLOSED project and imports them (⊘ skipping closed projects imports nothing on a normal server and prunes everything on the next sync)", async () => {
    const world = oneProjectWorld(
      // The closed-project payload as the controller really serves it: no
      // `console_host`, no `status`, but the persisted console port.
      [{ node_id: NODE_ID, name: "R1", node_type: "qemu", console: 5000, console_type: "telnet", compute_id: "local" }],
      { status: "closed" }
    );
    const { fetchImpl, calls } = makeWorld(world);
    const tree = await createGns3Provider(fetchImpl).fetchInventory(CONFIG, SECRETS);
    expect(calls.some((c) => c.path === `/v2/projects/${PROJECT_ID}/nodes`)).toBe(true);
    expect(tree.devices).toHaveLength(1);
    expect(tree.devices[0].externalId).toBe(`${PROJECT_ID}#${NODE_ID}`);
    expect(tree.truncated).toBeUndefined();
  });

  /**
   * A closed project's payload is a dump of the `.gns3` file, so its `status`
   * field — when it carries one at all — is whatever was last written there and
   * may name a node that has not existed as a process since the project closed.
   * Nothing runs in a closed project, so the PROJECT is the authority.
   */
  it("reports every node of a CLOSED project as stopped, even when the on-disk payload still says `started` (⊘ reading the node's own status paints a green running dot on a node that is not a process at all)", async () => {
    const world = oneProjectWorld([node({ status: "started" })], { status: "closed" });
    const tree = await fetchTree(world);
    expect(tree.devices[0].attributes?.status).toBe("stopped");
    expect(tree.status?.statuses[`${PROJECT_ID}#${NODE_ID}`]).toEqual({ state: "stopped" });
  });

  it("reports an OPENED project's nodes from the node's own status (⊘ folding every node to stopped makes the running highlight dead on every row)", async () => {
    const tree = await fetchTree(oneProjectWorld([node({ status: "started" })]));
    expect(tree.status?.statuses[`${PROJECT_ID}#${NODE_ID}`]).toEqual({ state: "running" });
    expect(tree.devices[0].attributes?.status).toBe("running");
  });

  it("folds `suspended` onto stopped — the contract's state is binary, and a paused node answers nothing (⊘ calling it running lights a dot on a node the user cannot reach)", async () => {
    const tree = await fetchTree(oneProjectWorld([node({ status: "suspended" })]));
    expect(tree.status?.statuses[`${PROJECT_ID}#${NODE_ID}`]).toEqual({ state: "stopped" });
  });

  /**
   * 🚨 THE ONE MUTATION THIS PROVIDER MUST NEVER MAKE. `POST /projects/{id}/open`
   * boots every node whose `auto_start` is set (the default), rewrites the
   * user's `.gns3` on disk, reallocates every console port and broadcasts the
   * change to every other connected GNS3 client. A read-only sync that does that
   * is not a read-only sync.
   */
  it("NEVER opens or closes a project, and issues no write at all, on either read path (⊘ opening a closed project to read its nodes boots the user's whole lab from a background sync)", async () => {
    for (const status of ["opened", "closed"]) {
      const world = oneProjectWorld([node()], { status });
      const { fetchImpl, calls } = makeWorld(world);
      const provider = createGns3Provider(fetchImpl);
      await provider.fetchInventory(CONFIG, SECRETS);
      await provider.fetchStatus!(CONFIG, SECRETS);
      expect(calls.every((c) => c.method === "GET")).toBe(true);
      expect(calls.some((c) => /\/(open|close)$/.test(c.path))).toBe(false);
    }
  });

  it("issues no open/close even on the CONTROL path, where a closed project is refused instead (⊘ opening the project to serve a Start reassigns every console port in the lab)", async () => {
    const world = oneProjectWorld([node()], { status: "closed" });
    const { fetchImpl, calls } = makeWorld(world);
    await createGns3Provider(fetchImpl)
      .controlNode!(CONFIG, SECRETS, `${PROJECT_ID}#${NODE_ID}`, "start")
      .catch(() => undefined);
    expect(calls.some((c) => /\/(open|close)$/.test(c.path))).toBe(false);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Console address resolution
// ---------------------------------------------------------------------------

describe("createGns3Provider — console address", () => {
  it("substitutes the configured server host for the `0.0.0.0` GNS3 reports on essentially every default install (⊘ keeping it dials 0.0.0.0 from the user's own machine, which either fails opaquely or hits something unrelated)", async () => {
    const tree = await fetchTree(oneProjectWorld([node({ console_host: "0.0.0.0" })]));
    expect(tree.devices[0].endpoints).toEqual([{ kind: "telnet", host: "gns3.example.com", port: 5000 }]);
  });

  it.each(["", "localhost", "127.0.0.1", "::1", "::"])(
    "substitutes the server host for the host-local address %o too (⊘ a `=== \"0.0.0.0\"` test leaves every other loopback spelling pointed at the user's own machine)",
    async (consoleHost) => {
      const tree = await fetchTree(oneProjectWorld([node({ console_host: consoleHost })]));
      expect(tree.devices[0].endpoints[0].host).toBe("gns3.example.com");
    }
  );

  /**
   * The closed-project payload omits `console_host` ENTIRELY, and that is the
   * normal case rather than a corner. Treating the absence as "we do not know
   * where the console is" would leave every node of every closed project
   * ADDRESSLESS — which is an active downgrade in `computeSyncPlan`: it clears
   * a working owned server's host and port.
   */
  it("substitutes the server host when `console_host` is ABSENT, which is what a closed project's payload always looks like (⊘ treating the absence as unknown strips the address off every server in every closed project)", async () => {
    const closed = { node_id: NODE_ID, name: "R1", node_type: "qemu", console: 5000, console_type: "telnet" };
    const tree = await fetchTree(oneProjectWorld([closed], { status: "closed" }));
    expect(tree.devices[0].endpoints).toEqual([{ kind: "telnet", host: "gns3.example.com", port: 5000 }]);
  });

  it("KEEPS a routable host GNS3 reports — a node on a remote compute is not on the controller (⊘ always substituting the base host sends every remote-compute console to the wrong box)", async () => {
    const tree = await fetchTree(oneProjectWorld([node({ console_host: "10.10.0.7" })]));
    expect(tree.devices[0].endpoints[0].host).toBe("10.10.0.7");
  });

  it("lets the Console Host Override win over BOTH the reported host and the server host, which is the whole point of a NAT override (⊘ applying it only to loopback leaves a reachable-looking-but-wrong address in place behind NAT)", async () => {
    for (const consoleHost of ["0.0.0.0", "10.10.0.7"]) {
      const tree = await fetchTree(oneProjectWorld([node({ console_host: consoleHost })]), { consoleHost: "nat.example.com" });
      expect(tree.devices[0].endpoints).toEqual([{ kind: "telnet", host: "nat.example.com", port: 5000 }]);
    }
  });

  it.each(["vnc", "http", "https", "spice", "spice+agent", "none", "telnet-over-quantum-link"])(
    "emits NO endpoint for console_type %o — the enum is treated as OPEN, so an unknown type is not guessed into a telnet dial (⊘ mapping every console to telnet points a terminal at a VNC port)",
    async (consoleType) => {
      const tree = await fetchTree(oneProjectWorld([node({ console_type: consoleType })]));
      expect(tree.devices[0].endpoints).toEqual([]);
      // Still a DEVICE — an addressless placeholder, never a dropped row.
      expect(tree.devices).toHaveLength(1);
    }
  );

  it.each([[null], [undefined], [0], [70_000], [5000.5], ["5000"]])(
    "emits NO endpoint when the console port is %o (⊘ coercing it mints an endpoint on port 0 or NaN that can never connect)",
    async (consolePort) => {
      const tree = await fetchTree(oneProjectWorld([node({ console: consolePort })]));
      expect(tree.devices[0].endpoints).toEqual([]);
    }
  );

  it("strips the brackets off an IPv6 server URL so the telnet transport gets an address it can dial", async () => {
    const tree = await fetchTree(oneProjectWorld([node({ console_host: "0.0.0.0" })]), { baseUrl: "http://[fd00::5]:3080" });
    expect(tree.devices[0].endpoints[0].host).toBe("fd00::5");
  });
});

// ---------------------------------------------------------------------------
// Device mapping
// ---------------------------------------------------------------------------

describe("createGns3Provider — device mapping", () => {
  it("keys the device on `<project_id>#<node_id>`, both UUIDs, so a project RENAME does not reidentify (and reprune) every node in it", async () => {
    const tree = await fetchTree(oneProjectWorld([node()]));
    expect(tree.devices[0].externalId).toBe(`${PROJECT_ID}#${NODE_ID}`);
    const renamed = await fetchTree(oneProjectWorld([node()], { name: "Lab One Renamed" }));
    expect(renamed.devices[0].externalId).toBe(tree.devices[0].externalId);
  });

  it("falls back to `node-<id>` for an unnamed node rather than dropping it (⊘ dropping a device reads as deleted at the source and the prune policy removes the server and its credentials)", async () => {
    const tree = await fetchTree(oneProjectWorld([node({ name: "" }), node({ node_id: "n2", name: undefined })]));
    expect(tree.devices.map((d) => d.name)).toEqual([`node-${NODE_ID}`, "node-n2"]);
  });

  it("puts each node in ONE folder named for its project — GNS3 has no project folders, so the hierarchy is flat", async () => {
    const tree = await fetchTree(oneProjectWorld([node()], { name: "Customer A" }));
    expect(tree.devices[0].folderPath).toBe("Customer A");
    expect(tree.devices[0].folderPath).not.toContain("/");
  });

  it("names the folder after the project id when the project has no name, rather than after nothing at all", async () => {
    const tree = await fetchTree(oneProjectWorld([node()], { name: "" }));
    expect(tree.devices[0].folderPath).toBe(PROJECT_ID);
  });

  it("emits exactly the six documented attributes, with the values the tree filters on", async () => {
    const tree = await fetchTree(oneProjectWorld([node()], { name: "Lab One" }));
    expect(tree.devices[0].attributes).toEqual({
      project: "Lab One",
      type: "qemu",
      console: "telnet",
      status: "running",
      compute: "local",
      name: "R1"
    });
  });

  it("filters projects by a case-insensitive substring of the project NAME, and imports every project when the filter is empty", async () => {
    const world: World = {
      api: "v2",
      projects: [project({ project_id: "p1", name: "ACME Core" }), project({ project_id: "p2", name: "Other" })],
      nodes: { p1: [node({ node_id: "n1" })], p2: [node({ node_id: "n2" })] }
    };
    expect((await fetchTree(world, { filter: "acme" })).devices.map((d) => d.externalId)).toEqual(["p1#n1"]);
    expect((await fetchTree(world)).devices).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Malformed FAILS, missing TRUNCATES
// ---------------------------------------------------------------------------

/**
 * THE RULE, stated once for the whole describe: MALFORMED DATA FAILS THE SYNC,
 * MISSING DATA TRUNCATES IT. Coercing a bad response into "empty" is what makes
 * `computeSyncPlan` prune every server this source owns — and the stored
 * credentials with them.
 */
describe("createGns3Provider — malformed data fails the sync", () => {
  async function expectProtocolFailure(world: World): Promise<InventoryProviderError> {
    const err = await fetchTree(world).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    return err as InventoryProviderError;
  }

  it.each([[{ message: "hello" }], ["<html>proxy</html>"], [null], [42]])(
    "fails when the project list is %o instead of an array (⊘ coercing it to [] empties the inventory and prunes every owned server)",
    async (projectsBody) => {
      const err = await expectProtocolFailure({ api: "v2", projectsBody });
      expect(err.message).toContain("project list");
    }
  );

  it("fails on a project ENTRY that is not an object (⊘ skipping it silently omits that project's servers while leaving the crawl non-truncated, so they are all pruned)", async () => {
    await expectProtocolFailure({ api: "v2", projectsBody: ["not-a-project"] });
  });

  it("fails on a project with no project_id — there is no request we could make for its nodes, so there is no safe placeholder either", async () => {
    const err = await expectProtocolFailure({ api: "v2", projectsBody: [{ name: "Lab One", status: "opened" }] });
    expect(err.message).toContain("project_id");
  });

  it("fails when a project's node list is not an array (⊘ reading it as an empty project prunes that project's servers over one bad response)", async () => {
    await expectProtocolFailure({ api: "v2", projects: [project()], nodes: { [PROJECT_ID]: { "0": node() } as unknown as unknown[] } });
  });

  it("fails on a node VALUE that is not an object (⊘ keeping it as an endpoint-less device ACTIVELY clears the address of a working owned server)", async () => {
    await expectProtocolFailure({ api: "v2", projects: [project()], nodes: { [PROJECT_ID]: ["nope"] } });
  });

  it("fails on a node with no node_id — an unidentifiable node cannot be keyed, and a wrong key is a prune plus an add", async () => {
    const err = await expectProtocolFailure({ api: "v2", projects: [project()], nodes: { [PROJECT_ID]: [{ name: "R1" }] } });
    expect(err.message).toContain("node_id");
  });

  it("accepts an EMPTY project list and an EMPTY node list — those are answers, not malformations", async () => {
    expect((await fetchTree({ api: "v2", projects: [] })).devices).toEqual([]);
    expect((await fetchTree({ api: "v2", projects: [project()], nodes: { [PROJECT_ID]: [] } })).devices).toEqual([]);
  });

  /**
   * MISSING, not malformed: the project was deleted between the listing that
   * named it and the fetch for its nodes. Skipping it is right — but the crawl
   * must report itself TRUNCATED, because those nodes were never seen and
   * absence here must not read as "these devices no longer exist".
   */
  it("skips a project that 404s mid-crawl, keeps the rest, and marks the crawl TRUNCATED so the plan does not prune the nodes it never saw", async () => {
    const world: World = {
      api: "v2",
      projects: [project({ project_id: "gone", name: "Gone" }), project({ project_id: "p2", name: "Here" })],
      nodes: { p2: [node({ node_id: "n2" })] }
    };
    const tree = await fetchTree(world);
    expect(tree.devices.map((d) => d.externalId)).toEqual(["p2#n2"]);
    expect(tree.truncated).toBe(true);
    expect(tree.status?.truncated).toBe(true);
    expect((tree.warnings ?? []).some((w) => /not found/i.test(w) && /project/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("createGns3Provider — error mapping", () => {
  async function kindOf(world: World): Promise<InventoryProviderError> {
    const err = await fetchTree(world).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    return err as InventoryProviderError;
  }

  it("maps a 401 on an API read to `auth`", async () => {
    expect((await kindOf({ api: "v2", projectsHttp: 401, projectsBody: { message: "Unauthorized" } })).kind).toBe("auth");
  });

  it("maps a 403 on an API read to `auth` — the only caller that can tell a permission failure from GNS3's closed-project refusal does that itself", async () => {
    expect((await kindOf({ api: "v2", projectsHttp: 403, projectsBody: { message: "Forbidden" } })).kind).toBe("auth");
  });

  it("maps a 500 to `protocol`, not to `auth`, and echoes the server's own `message` (⊘ classifying every failure as auth sends the user to reset a working password)", async () => {
    const err = await kindOf({ api: "v2", projectsHttp: 500, projectsBody: { message: "Internal error", status: 500 } });
    expect(err.kind).toBe("protocol");
    expect(err.message).toContain("Internal error");
  });

  it("bounds the body it echoes, because the text is server-supplied and ends up in a notification", async () => {
    const err = await kindOf({ api: "v2", projectsHttp: 500, projectsBody: { message: "A".repeat(5000) } });
    expect(err.message.length).toBeLessThan(600);
  });

  it("maps a redirect to `protocol` and names the Location, since a 3xx carries no body to explain itself (⊘ `failed with HTTP 301: ` says nothing at all)", async () => {
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/v3/version") return makeResponse(404, "no");
      if (path === "/v2/version") return makeResponse(200, { version: "2.2.49" });
      return makeResponse(301, "", { Location: "https://gns3.example.com/login" });
    }) as unknown as typeof fetch;
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as InventoryProviderError).message).toContain("https://gns3.example.com/login");
  });

  /**
   * THE `Location` IS SERVER-CONTROLLED TEXT, and `redirectNotFollowedMessage`
   * drops it into a sentence this codebase composed — so it is flattened where
   * it ENTERS that sentence, in the shared helper
   * (`services/inventory/certificateHints.ts`), not at the four providers that
   * interpolate the result.
   *
   * The exposure is NOT newline injection through a real HTTP client: undici
   * rejects CR/LF and C0 in a header value. It is the bidi and invisible
   * formatting block, which undici passes through untouched and which reorders
   * the rendered notification around the address it names. The newline is
   * asserted too because `fetchImpl` is a seam and a non-undici transport
   * enforces nothing.
   *
   * Lives in this file because there is no `certificateHints` test file; the
   * helper's other three callers pass it the same header.
   */
  it("⊘ flattens a bidi control out of the Location header before it reaches the redirect message (⊘ an RLO in a header undici does NOT reject reverses the sentence the user reads)", async () => {
    const nasty = "https://gns3.example.com/‮login\nX-Nexus: 4 servers were deleted";
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/v3/version") return makeResponse(404, "no");
      if (path === "/v2/version") return makeResponse(200, { version: "2.2.49" });
      return makeResponse(301, "", { Location: nasty });
    }) as unknown as typeof fetch;
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    const message = (err as InventoryProviderError).message;
    // The address is still named — flattening must not cost the answer.
    expect(message).toContain("https://gns3.example.com/");
    expect(message).not.toContain("‮");
    expect(message).not.toContain("\n");
    expect(message.split("\n")).toHaveLength(1);
  });

  it("maps a transport failure to `network`, naming the OS code rather than a stack trace", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("network");
    expect((err as InventoryProviderError).message).toContain("ECONNREFUSED");
  });

  it("maps an abort to `network` and says the connection timed out", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("network");
    expect((err as InventoryProviderError).message).toContain("timed out");
  });

  /**
   * `gns3.local:3080` is not merely unparseable — it PARSES, as the scheme
   * `gns3.local:` with the opaque path `3080`. Concatenating the API path onto
   * it yields a URL whose pathname is `/v3/version` and whose host is EMPTY, so
   * a client that trusts `new URL` alone goes on to issue real requests against
   * a target the user never named and reports whatever comes back as inventory.
   * The scheme has to be checked, not just the parse.
   */
  it.each(["gns3.local:3080", "ftp://gns3.example.com", "  "])(
    "refuses the non-http server URL %o as a `network` error naming the fix, before issuing a single request (⊘ trusting new URL alone sends the crawl at a host-less URL and calls the result an inventory)",
    async (baseUrl) => {
      const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
      const err = await createGns3Provider(fetchImpl)
        .fetchInventory({ baseUrl }, SECRETS)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryProviderError);
      expect((err as InventoryProviderError).kind).toBe("network");
      expect((err as InventoryProviderError).message).toContain("http://");
      expect(calls).toHaveLength(0);
    }
  );

  /**
   * THE ONE UNPARSEABLE URL THAT CARRIES A SECRET. `normalizeBaseUrl` drops
   * userinfo on every URL that parses — it rebuilds from protocol + host — but
   * hands back the raw string when the parse fails, and
   * `admin:s3cret@gns3.local:3080` is exactly that shape (scheme `admin:`,
   * rejected by `parseHttpUrl`). Echoed verbatim, the refusal shows the user
   * their own password back and writes it into whatever records the sync
   * failure.
   */
  it("⊘ does not echo a `user:pass@` prefix back in the invalid-URL refusal, while still naming the host (⊘ echoing the raw string puts a typed password in a notification and in the sync error record)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory({ baseUrl: "admin:s3cret@gns3.example.com:3080" }, SECRETS)
      .catch((e: unknown) => e);
    const message = (err as InventoryProviderError).message;
    expect((err as InventoryProviderError).kind).toBe("network");
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("admin");
    // The host is the diagnostic half of the echo and must survive the redaction.
    expect(message).toContain("gns3.example.com:3080");
    expect(calls).toHaveLength(0);
  });

  it("leaves an `@` that is part of a PATH alone, since only a prefix before the first slash is userinfo", async () => {
    const { fetchImpl } = makeWorld(oneProjectWorld([node()]));
    const err = await createGns3Provider(fetchImpl)
      .fetchInventory({ baseUrl: "gns3.local:3080/api@v2" }, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).message).toContain("gns3.local:3080/api@v2");
  });
});

// ---------------------------------------------------------------------------
// Every server-supplied value that enters a composed message
// ---------------------------------------------------------------------------

/**
 * ONE PIN PER `inMessage` CALL SITE, and the reason it is a table rather than a
 * test per message: the bug this guards against was itself a MISSED SITE — the
 * first sweep flattened the response body and the project NAME and left the
 * project id raw in four other messages. Two of those sites had a pin; four did
 * not, so stripping `inMessage` from any of them left the suite green. A table
 * enumerated from the call sites fails the day a seventh message is composed
 * without one.
 *
 * The payload carries BOTH shapes the helper exists to remove: a newline, which
 * mints a line the reader takes as one of Nexus's own, and an RLO (U+202E),
 * which reorders the rendered sentence around it. Each case asserts the composed
 * message is one line and control-free while still naming the value — a site
 * that simply dropped the value would pass the first two assertions.
 */
describe("createGns3Provider — server text entering a composed message", () => {
  /** `p1` is the part that must survive; the rest is what must not. */
  const NASTY = "p1\nNexus: 4 servers were deleted‮reversed";

  async function messageOf(run: () => Promise<unknown>): Promise<string> {
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    return (err as InventoryProviderError).message;
  }

  /** `/v3/version` 404s, `/v2/version` identifies v2; the rest is per-case. */
  function v2Then(route: (path: string) => unknown): typeof fetch {
    return (async (input: string) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      if (path === "/v3/version") return makeResponse(404, { message: "Not Found" });
      if (path === "/v2/version") return makeResponse(200, { version: "2.2.49" });
      return route(path);
    }) as unknown as typeof fetch;
  }

  const cases: [string, () => Promise<unknown>][] = [
    [
      "the error body echoed by throwForStatus",
      () => fetchTree({ api: "v2", projectsHttp: 500, projectsBody: { message: NASTY } })
    ],
    [
      "the project id in the malformed-node-list refusal",
      () =>
        createGns3Provider(
          v2Then((path) => (path === "/v2/projects" ? makeResponse(200, [project({ project_id: NASTY })]) : makeResponse(200, { not: "an array" })))
        ).fetchInventory(CONFIG, SECRETS)
    ],
    [
      "the project id in the malformed-node refusal",
      () => fetchTree({ api: "v2", projects: [project({ project_id: NASTY })], nodes: { [NASTY]: [null] } })
    ],
    [
      "the project id in the missing-node_id refusal",
      () => fetchTree({ api: "v2", projects: [project({ project_id: NASTY })], nodes: { [NASTY]: [{ name: "R1" }] } })
    ],
    [
      "the node id in controlNode's malformed-id refusal",
      () => {
        const { fetchImpl } = makeWorld(oneProjectWorld([node()]));
        return createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, NASTY, "start");
      }
    ],
    [
      "the project id in controlNode's stale-inventory refusal",
      () => {
        const { fetchImpl } = makeWorld({ api: "v2", projects: [] });
        return createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, `${NASTY}#${NODE_ID}`, "start");
      }
    ],
    [
      "the project name in controlNode's closed-project refusal",
      () => {
        const { fetchImpl } = makeWorld(oneProjectWorld([node()], { name: NASTY, status: "closed" }));
        return createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, `${PROJECT_ID}#${NODE_ID}`, "start");
      }
    ]
  ];

  it.each(cases)("⊘ flattens %s (⊘ a raw newline mints a notification line that reads like one of ours)", async (_label, run) => {
    const message = await messageOf(run);
    expect(message).toContain("p1");
    expect(message.split("\n")).toHaveLength(1);
    expect(message).not.toContain("\r");
    expect(message).not.toContain("‮");
  });
});

// ---------------------------------------------------------------------------
// Caps and truncation
// ---------------------------------------------------------------------------

describe("createGns3Provider — caps and truncation", () => {
  function manyNodes(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_v, i) => node({ node_id: `n${i}`, name: `R${i}` }));
  }

  it("imports EXACTLY the cap without claiming truncation — a crawl that stopped because it ran out of nodes must still allow pruning (⊘ an off-by-one that trips at the cap disables pruning forever on a source sitting at it)", async () => {
    const tree = await fetchTree(oneProjectWorld(manyNodes(10_000)));
    expect(tree.devices).toHaveLength(10_000);
    expect(tree.truncated).toBeUndefined();
    expect(tree.status?.truncated).toBeUndefined();
    expect((tree.warnings ?? []).some((w) => /Stopped after 10000 nodes/.test(w))).toBe(false);
  });

  it("stops ABOVE the cap, marks the tree truncated so nothing is pruned, and says so with the remedy (⊘ a silent cap looks like the later projects were deleted at the source)", async () => {
    const tree = await fetchTree(oneProjectWorld(manyNodes(10_001)));
    expect(tree.devices).toHaveLength(10_000);
    expect(tree.truncated).toBe(true);
    expect(tree.status?.truncated).toBe(true);
    const warning = (tree.warnings ?? []).filter((w) => /Stopped after 10000 nodes/.test(w));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain("Project Filter");
  });

  function manyProjects(count: number): World {
    const projects = Array.from({ length: count }, (_v, i) => project({ project_id: `p${i}`, name: `P${i}` }));
    const nodes: Record<string, unknown[]> = {};
    for (const p of projects) {
      nodes[String(p.project_id)] = [];
    }
    return { api: "v2", projects, nodes };
  }

  it("scans EXACTLY the project cap without claiming truncation", async () => {
    const tree = await fetchTree(manyProjects(1_000));
    expect(tree.truncated).toBeUndefined();
  });

  it("stops above the project cap, truncates, and names the Project Filter", async () => {
    const tree = await fetchTree(manyProjects(1_001));
    expect(tree.truncated).toBe(true);
    expect((tree.warnings ?? []).some((w) => /Stopped after 1000 projects/.test(w) && w.includes("Project Filter"))).toBe(true);
  });

  it("carries the truncation onto the STATUS report too, so applyInventoryStatus merges instead of clearing nodes it never reached", async () => {
    const { fetchImpl } = makeWorld(oneProjectWorld(manyNodes(10_001)));
    const report = await createGns3Provider(fetchImpl).fetchStatus!(CONFIG, SECRETS);
    expect(report.truncated).toBe(true);
    expect(Object.keys(report.statuses)).toHaveLength(10_000);
  });
});

// ---------------------------------------------------------------------------
// fetchStatus
// ---------------------------------------------------------------------------

describe("createGns3Provider — fetchStatus", () => {
  it("reports the LIVE console address of a running node, which is what lets a sync-owned server follow a reallocated port (⊘ omitting it leaves the profile pointed at the port the project had before it was reopened)", async () => {
    const report = await fetchStatus(oneProjectWorld([node({ console: 5023, console_host: "0.0.0.0" })]));
    expect(report.statuses[`${PROJECT_ID}#${NODE_ID}`]).toEqual({ state: "running", consoleHost: "gns3.example.com", consolePort: 5023 });
  });

  it("applies the Console Host Override to the reported console address as well, so the refresh and the sync never disagree about where the console is", async () => {
    const report = await fetchStatus(oneProjectWorld([node()]), { consoleHost: "nat.example.com" });
    expect(report.statuses[`${PROJECT_ID}#${NODE_ID}`]?.consoleHost).toBe("nat.example.com");
  });

  it("carries NO console fields for a stopped node — there is no console to heal a port onto (⊘ reporting the stale port persists it onto the server as though it were live)", async () => {
    const report = await fetchStatus(oneProjectWorld([node({ status: "stopped" })]));
    expect(report.statuses[`${PROJECT_ID}#${NODE_ID}`]).toEqual({ state: "stopped" });
  });

  it("carries NO console fields for a running node whose console is not telnet", async () => {
    const report = await fetchStatus(oneProjectWorld([node({ console_type: "vnc" })]));
    expect(report.statuses[`${PROJECT_ID}#${NODE_ID}`]).toEqual({ state: "running" });
  });

  it("reports a CLOSED project's nodes as stopped with no console fields, from the project rather than from the on-disk node payload", async () => {
    const report = await fetchStatus(oneProjectWorld([node({ status: "started" })], { status: "closed" }));
    expect(report.statuses[`${PROJECT_ID}#${NODE_ID}`]).toEqual({ state: "stopped" });
  });

  it("keys the report by the SAME externalId the devices carry, or every status resolves to no server at all", async () => {
    const world = oneProjectWorld([node()]);
    const tree = await fetchTree(world);
    const report = await fetchStatus(world);
    expect(Object.keys(report.statuses)).toEqual(tree.devices.map((d) => d.externalId));
  });
});

// ---------------------------------------------------------------------------
// controlNode
// ---------------------------------------------------------------------------

describe("createGns3Provider — controlNode", () => {
  const externalId = `${PROJECT_ID}#${NODE_ID}`;

  /**
   * THE UNDOCUMENTED FOOTGUN. The GNS3 3.x start route declares a request model,
   * so FastAPI makes the body MANDATORY: a POST with no body answers HTTP 422
   * with a validation error, not a started node. Nothing in the API docs says
   * so, which is exactly why it is pinned here.
   */
  it("sends an explicit `{}` JSON body on a v3 START (⊘ omitting it answers 422 from FastAPI's validator and the node never starts)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()], {}, "v3"));
    await createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, externalId, "start");
    const action = calls.find((c) => c.path.endsWith("/start"));
    expect(action?.method).toBe("POST");
    expect(action?.path).toBe(`/v3/projects/${PROJECT_ID}/nodes/${NODE_ID}/start`);
    expect(action?.body).toBe("{}");
    expect(action?.headers["Content-Type"]).toBe("application/json");
  });

  it("accepts the v3 START's 204-with-no-body as success (⊘ demanding a node object in the response reports a node that DID start as failed)", async () => {
    const { fetchImpl } = makeWorld(oneProjectWorld([node()], {}, "v3"));
    await expect(createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, externalId, "start")).resolves.toBeUndefined();
  });

  it("sends NO body on a v2 start — 2.2's handler takes none, and the v2 request stays exactly what it has always been", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
    await createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, externalId, "start");
    const action = calls.find((c) => c.path.endsWith("/start"));
    expect(action?.path).toBe(`/v2/projects/${PROJECT_ID}/nodes/${NODE_ID}/start`);
    expect(action?.body).toBeUndefined();
  });

  it.each([["v2"], ["v3"]] as const)("sends no body on a %s STOP, which needs none on either version", async (api) => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()], {}, api));
    await createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, externalId, "stop");
    const action = calls.find((c) => c.path.endsWith("/stop"));
    expect(action?.body).toBeUndefined();
  });

  /**
   * GNS3's single-node routes are `@open_required`: on a closed project they
   * answer 403 with `{"message": "The project is not opened"}` — a status code
   * INDISTINGUISHABLE from a real permission failure, which the shared mapper
   * quite correctly calls `auth`. Telling the user their credentials were
   * rejected when their project is merely closed sends them to reset a password
   * that works.
   */
  it("refuses a node in a CLOSED project BEFORE issuing the POST, as `protocol`, naming the project and the one remedy that can actually happen (⊘ letting the 403 through reports a closed project as rejected credentials)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()], { name: "Customer A", status: "closed" }));
    const err = await createGns3Provider(fetchImpl)
      .controlNode!(CONFIG, SECRETS, externalId, "start")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as InventoryProviderError).message).toContain("Customer A");
    expect((err as InventoryProviderError).message).toContain("Open the project in GNS3");
    // The refusal is a REFUSAL: no start was attempted.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a 403 from an OPEN project as the close-race rather than as credentials, because this is the only place that knows the project was open a round trip ago", async () => {
    const world = oneProjectWorld([node()]);
    world.actionHttp = 403;
    world.actionBody = { message: "The project is not opened" };
    const { fetchImpl } = makeWorld(world);
    const err = await createGns3Provider(fetchImpl)
      .controlNode!(CONFIG, SECRETS, externalId, "start")
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as InventoryProviderError).message).toContain("The project is not opened");
    expect((err as InventoryProviderError).message).toContain("open it in GNS3");
  });

  it("surfaces a non-2xx that is not a 403 as an error, so a failed start never looks like a successful one", async () => {
    const world = oneProjectWorld([node()]);
    world.actionHttp = 500;
    const { fetchImpl } = makeWorld(world);
    const err = await createGns3Provider(fetchImpl)
      .controlNode!(CONFIG, SECRETS, externalId, "start")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryProviderError);
    expect((err as InventoryProviderError).kind).toBe("protocol");
  });

  it("splits the externalId on the LAST '#', so neither half can be mis-addressed if an id ever grows one", async () => {
    const { fetchImpl, calls } = makeWorld({
      api: "v2",
      projects: [project({ project_id: "proj#with#hash" })],
      nodes: { "proj#with#hash": [node()] }
    });
    await createGns3Provider(fetchImpl).controlNode!(CONFIG, SECRETS, `proj#with#hash#${NODE_ID}`, "stop");
    const action = calls.find((c) => c.path.endsWith("/stop"));
    expect(action?.path).toBe(`/v2/projects/proj#with#hash/nodes/${NODE_ID}/stop`);
  });

  it.each([["no-hash"], ["#only-node"], ["project-only#"], ["#"], [""]])(
    "refuses the malformed node id %o as `protocol` rather than issuing a request at a half-built path",
    async (id) => {
      const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
      const err = await createGns3Provider(fetchImpl)
        .controlNode!(CONFIG, SECRETS, id, "start")
        .catch((e: unknown) => e);
      expect((err as InventoryProviderError).kind).toBe("protocol");
      expect(calls).toHaveLength(0);
    }
  );

  it("says the inventory is stale — not that the credentials failed — when the project is no longer listed at all", async () => {
    const { fetchImpl } = makeWorld({ api: "v2", projects: [] });
    const err = await createGns3Provider(fetchImpl)
      .controlNode!(CONFIG, SECRETS, externalId, "start")
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("protocol");
    expect((err as InventoryProviderError).message).toContain("Sync this source");
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe("createGns3Provider — testConnection", () => {
  it("actually reads the API the sync will use, not just the unauthenticated version probe (⊘ stopping after detection reports a source with a wrong password as healthy)", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
    await createGns3Provider(fetchImpl).testConnection(CONFIG, SECRETS);
    expect(calls.some((c) => c.path === "/v2/projects")).toBe(true);
  });

  it("propagates an auth failure rather than falling back to a laxer endpoint", async () => {
    const { fetchImpl } = makeWorld({ api: "v2", projectsHttp: 401 });
    const err = await createGns3Provider(fetchImpl)
      .testConnection(CONFIG, SECRETS)
      .catch((e: unknown) => e);
    expect((err as InventoryProviderError).kind).toBe("auth");
  });

  it("writes nothing — Test Connection must never mutate the user's lab", async () => {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
    await createGns3Provider(fetchImpl).testConnection(CONFIG, SECRETS);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INSECURE TLS — the two-probe harness
// ---------------------------------------------------------------------------

/**
 * TWO DISTINCT TRANSPORTS, so the selection is asserted by WHICH call log
 * filled rather than inferred from the config. Identity-comparing a returned
 * transport cannot tell the two apart when a caller injects the same function
 * as both — this harness can.
 */
describe("createGns3Provider — insecure TLS transport selection", () => {
  function probeWorld(): { impl: typeof fetch; calls: Call[] } {
    const { fetchImpl, calls } = makeWorld(oneProjectWorld([node()]));
    return { impl: fetchImpl, calls };
  }

  function probes(): { standard: ReturnType<typeof probeWorld>; insecure: ReturnType<typeof probeWorld>; provider: ReturnType<typeof createGns3Provider> } {
    const standard = probeWorld();
    const insecure = probeWorld();
    return { standard, insecure, provider: createGns3Provider(standard.impl, insecure.impl) };
  }

  it("uses the insecure transport — and ONLY it — for an https source that opted in", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://10.0.0.5:3080", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls).toHaveLength(0);
  });

  it("NEVER uses it for a source that did not opt in, however the certificate would have failed (⊘ selecting on the URL scheme alone turns verification off for every https source)", async () => {
    for (const config of [{ baseUrl: "https://10.0.0.5:3080", allowInsecureTls: false }, { baseUrl: "https://10.0.0.5:3080" }]) {
      const { standard, insecure, provider } = probes();
      await provider.fetchInventory(config, SECRETS);
      expect(standard.calls.length).toBeGreaterThan(0);
      expect(insecure.calls).toHaveLength(0);
    }
  });

  it("NEVER uses it for an http source — which on GNS3 is the DEFAULT — where relaxing certificate checks means nothing and the adapter would refuse the URL anyway (⊘ selecting on the opt-in alone breaks every stock GNS3 the moment the box is ticked)", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "http://gns3.example.com:3080", allowInsecureTls: true }, SECRETS);
    expect(standard.calls.length).toBeGreaterThan(0);
    expect(insecure.calls).toHaveLength(0);
  });

  it("decides per CONFIG, not per provider — one registry serves every source, so two sources on one provider must get different transports", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://10.0.0.5:3080", allowInsecureTls: true }, SECRETS);
    await provider.fetchInventory({ baseUrl: "https://gns3.example.com:3080" }, SECRETS);
    // Compare the parsed HOST, not a URL prefix: `startsWith("https://gns3.example.com")`
    // is also satisfied by `https://gns3.example.com.evil.net/…`.
    expect(insecure.calls.every((c) => new URL(c.url).host === "10.0.0.5:3080")).toBe(true);
    expect(standard.calls.every((c) => new URL(c.url).host === "gns3.example.com:3080")).toBe(true);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls.length).toBeGreaterThan(0);
  });

  it("routes EVERY entry point through the same decision (⊘ one path built without the selector connects with verification ON, and the source works from the tree but not from Test Connection, or the reverse)", async () => {
    const opted = { baseUrl: "https://10.0.0.5:3080", allowInsecureTls: true };
    const runs: ((p: ReturnType<typeof createGns3Provider>) => Promise<unknown>)[] = [
      (p) => p.fetchInventory(opted, SECRETS),
      (p) => p.testConnection(opted, SECRETS),
      (p) => p.fetchStatus!(opted, SECRETS),
      (p) => p.controlNode!(opted, SECRETS, `${PROJECT_ID}#${NODE_ID}`, "start")
    ];
    for (const run of runs) {
      const { standard, insecure, provider } = probes();
      await run(provider).catch(() => undefined);
      expect(insecure.calls.length).toBeGreaterThan(0);
      expect(standard.calls).toHaveLength(0);
    }
  });

  it("normalizes the scheme before deciding, so an uppercase HTTPS:// server URL is still https (⊘ a raw startsWith('https:') check reads HTTPS:// as plain http and silently ignores the opt-in)", async () => {
    const { standard, insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "HTTPS://10.0.0.5:3080", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    expect(standard.calls).toHaveLength(0);
  });

  /**
   * THE STRICTNESS IS LOAD-BEARING. The negative cases above only cover `false`
   * and absent, so the mutation `if (!config.allowInsecureTls)` would pass every
   * one of them. The string "true" is reachable — a restored backup, or a
   * hand-edited globalState, stores whatever it holds — and under that mutation
   * it turns certificate verification OFF for a source whose owner never ticked
   * a box.
   */
  it.each([["true"], ["false"], [1], [0], ["0"], ["yes"], [{}]])(
    "treats a NON-boolean %o as no opt-in at all and keeps the standard transport (⊘ a truthiness test turns verification off for a value the form can never produce)",
    async (value) => {
      const { standard, insecure, provider } = probes();
      await provider.fetchInventory({ baseUrl: "https://10.0.0.5:3080", allowInsecureTls: value as unknown as boolean }, SECRETS);
      expect(standard.calls.length).toBeGreaterThan(0);
      expect(insecure.calls).toHaveLength(0);
    }
  );

  /** The URL-parse `catch` is OBSERVABLE, not dead: `new URL("https:")` throws. */
  it.each(["https:", "https:/"])(
    "falls back to the STANDARD transport for the unparseable server URL %o, even with the box ticked (⊘ a catch that returns the insecure transport relaxes TLS on a URL nobody could parse)",
    async (baseUrl) => {
      const { insecure, provider } = probes();
      await provider.fetchInventory({ baseUrl, allowInsecureTls: true }, SECRETS).catch(() => undefined);
      expect(insecure.calls).toHaveLength(0);
    }
  );

  /**
   * THE ADAPTER'S OWN PRECONDITION. `insecureFetch` REFUSES any redirect mode
   * other than `"manual"` — it never follows a redirect, and accepting `follow`
   * while not following would be a silent lie. So an opted-in source whose
   * requests left the mode at the platform default would have every single one
   * of them rejected inside the adapter, before a socket opened.
   */
  it('asks the insecure transport for redirect: "manual", which is the only mode it accepts (⊘ leaving the default makes every request on an opted-in source fail inside the adapter, before it reaches the server)', async () => {
    const { insecure, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://10.0.0.5:3080", allowInsecureTls: true }, SECRETS);
    expect(insecure.calls.length).toBeGreaterThan(0);
    for (const call of insecure.calls) {
      expect(call.init?.redirect).toBe("manual");
    }
  });

  /**
   * …and on the STANDARD transport too, which is where this provider differs
   * from NetBox deliberately: GNS3 is a brand-new provider with no existing
   * sources behind a redirecting proxy to break, and a 3xx from a lab
   * controller has no legitimate meaning. Following one would carry the crawl —
   * and, on a 307/308 login, the password — to another origin.
   */
  it("sends redirect: \"manual\" on the standard transport as well, so no request can be carried to another origin (⊘ the default `follow` hands the v3 login POST, password and all, to whatever a 307 names)", async () => {
    const { standard, provider } = probes();
    await provider.fetchInventory({ baseUrl: "https://gns3.example.com:3080" }, SECRETS);
    expect(standard.calls.length).toBeGreaterThan(0);
    for (const call of standard.calls) {
      expect(call.init?.redirect).toBe("manual");
    }
  });

  it("defaults the second argument to the real node:https adapter, so a provider built the way activate() builds it is not silently transport-less", () => {
    expect(() => createGns3Provider(vi.fn() as unknown as typeof fetch)).not.toThrow();
  });
});

/**
 * DISCLOSURE AFTER THE FACT. `allowInsecureTls` is read once, at transport
 * selection, and would otherwise never be heard from again — so a source ticked
 * for a lab box and later repointed at a remote GNS3 keeps sending the password
 * over an unauthenticated connection with nothing on screen saying so.
 */
describe("createGns3Provider — a sync run with verification off discloses it", () => {
  it("names the option and the password on the warnings channel when it ran unverified (⊘ silence leaves a repointed source exposed with nothing on screen to say so)", async () => {
    const { fetchImpl } = makeWorld(oneProjectWorld([node()]));
    const tree = await createGns3Provider(vi.fn() as unknown as typeof fetch, fetchImpl).fetchInventory(
      { baseUrl: "https://10.0.0.5:3080", allowInsecureTls: true },
      SECRETS
    );
    expect(tree.warnings).toContain(GNS3_INSECURE_TLS_WARNING);
    expect(GNS3_INSECURE_TLS_WARNING).toContain("password");
  });

  it("says nothing on an ordinary verified sync (⊘ a warning on every sync is one nobody reads)", async () => {
    const tree = await fetchTree(oneProjectWorld([node()]));
    expect(tree.warnings ?? []).not.toContain(GNS3_INSECURE_TLS_WARNING);
  });
});
