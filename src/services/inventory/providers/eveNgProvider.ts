import {
  InventoryProviderError,
  type InventoryConfigField,
  type InventoryDevice,
  type InventoryDeviceStatus,
  type InventoryProvider,
  type InventorySourceSecrets,
  type InventorySourceValues,
  type InventoryStatusReport,
  type InventoryTree
} from "../../../models/inventory";

export const EVE_NG_PROVIDER_ID = "eve-ng";

const FETCH_TIMEOUT_MS = 20_000;
const TEST_CONNECTION_TIMEOUT_MS = 10_000;

/** Hard caps. See `fetchInventoryImpl` for why every one of them sets `truncated`. */
const MAX_NODES = 10_000;
const MAX_LABS = 1_000;
const MAX_FOLDER_DEPTH = 12;
const MAX_FOLDER_REQUESTS = 2_000;

/** Bound on an error message's echo of a response body — see `throwForStatus`. */
const BODY_SLICE = 200;

export const EVE_NG_PRO_WARNING =
  "EVE-NG Professional detected — Pro support is preliminary in this version; lab discovery and console mapping are validated against Community edition.";

/**
 * THE CONFIG FIELD LIST IS PART OF THE PROVIDER FINGERPRINT
 * (`computeProviderFingerprint`, models/inventory.ts): its ids, labels, types,
 * required flags and ORDER are hashed and stamped onto every source at save
 * time, and a later change makes every existing source re-prompt the user to
 * re-confirm handing the registrant its saved credentials. Adding a field later
 * is therefore a user-visible event, not a refactor — which is why the whole
 * set this provider will need is declared up front.
 */
const EVE_NG_CONFIG_FIELDS: InventoryConfigField[] = [
  {
    id: "baseUrl",
    label: "EVE-NG Base URL",
    type: "string",
    required: true,
    placeholder: "http://eve.example.com",
    // The HTTPS caveat lives here rather than only in the docs because the
    // symptom is an opaque `fetch failed` that never mentions certificates:
    // the extension host's fetch has no per-source trust store to relax, and
    // EVE-NG ships a self-signed certificate by default.
    description:
      "The EVE-NG web UI address; a trailing slash is fine. Self-signed HTTPS is not supported — use http or a trusted certificate."
  },
  { id: "username", label: "Username", type: "string", required: true, placeholder: "admin" },
  {
    id: "password",
    label: "Password",
    type: "password",
    required: true,
    description: "Stored in the OS credential vault, never in settings."
  },
  {
    id: "rootFolder",
    label: "Root Folder",
    type: "string",
    required: false,
    placeholder: "/",
    description: "Subtree of the EVE-NG lab folder tree to scan. Defaults to the whole tree."
  },
  {
    // Deliberately id `filter` + `type: "string"`: that exact pair is what
    // attaches the shared saved-filter picker above the field
    // (`SAVED_FILTER_TARGET_FIELD_ID`, ui/formDefinitions.ts).
    id: "filter",
    label: "Lab Filter",
    type: "string",
    required: false,
    placeholder: "acme",
    description: "Case-insensitive substring matched against each lab's full path. Empty imports every lab."
  },
  {
    id: "includeStopped",
    label: "Include Stopped Nodes",
    type: "boolean",
    required: false,
    // Lab nodes are stopped most of the time; a source that imported none of
    // them would look like an empty inventory and, under a `delete` prune
    // policy, remove the servers a previous sync created.
    defaultValue: true,
    description:
      "Import nodes that are not currently running. Turning this off makes a stopped node look deleted to the sync, so the source's prune policy applies to it."
  },
  {
    id: "consoleHost",
    label: "Console Host Override",
    type: "string",
    required: false,
    placeholder: "eve.example.com",
    description: "Host to use for telnet consoles when EVE-NG reports an address you cannot reach (NAT, port forwarding)."
  }
];

// ---------------------------------------------------------------------------
// URL / config helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalizes the base URL into the exact string every request is built from,
 * so the fetch and `eveNgInstanceKey` (which derives from this) cannot disagree:
 *  - P2 — QUERY and FRAGMENT are dropped. A base URL pasted from a browser can
 *    carry `?foo=bar` / `#x`; appending `/api/auth/login` to it would otherwise
 *    yield `http://eve?foo=bar/api/auth/login`, whose pathname is `/`, and login
 *    would hit the root.
 *  - the trailing slash and a pasted `/api` SUFFIX are stripped (the latter like
 *    `netboxProvider.normalizeBaseUrl`), so `http://eve/api` cannot double into
 *    `/api/api/auth/login`.
 *  - a real mount PATH (`http://gw/eve1`, a reverse-proxy mount) is KEPT, with
 *    its case, since the deployment answers there (MAJOR-2).
 * An unparseable value (a scheme-less `eve.example.com`) is returned trimmed, so
 * `buildUrl` maps its `new URL` throw to a provider error at the boundary.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  // Rebuilt from parts (scheme + host + path only), which by construction drops
  // any query, fragment AND userinfo — so a browser-pasted `?foo=bar` / `#x`
  // cannot survive into `${baseUrl}/api/...` and mangle the pathname (P2).
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * This EVE-NG deployment's identity — see `InventoryProvider.instanceKey`
 * (models/inventory.ts) for the contract and `netboxInstanceKey` for the
 * reference implementation this mirrors.
 *
 * MAJOR-2 (review) — THE KEY DERIVES FROM EXACTLY THE STRING THE FETCH DERIVES
 * FROM. `login`/`authedGet` build `new URL(`${baseUrl}${path}`)`, so a base URL
 * carrying a mount path (`http://gw/eve1`, a reverse proxy fronting several
 * EVE-NG boxes) issues every request under that path — and the key MUST keep
 * the path too, or `http://gw/eve1` and `http://gw/eve2` (two distinct working
 * deployments) collapse onto one identity and source B can adopt, then its
 * prune policy delete, servers and credentials kept from source A on a
 * different box. The `/api` suffix is the one path segment `normalizeBaseUrl`
 * removes, and it removes it from the fetch string too, so the two never
 * disagree.
 *
 * Canonicalization otherwise matches NetBox: scheme and host lower-cased (both
 * case-insensitive per RFC 3986, and `new URL` does it), a default port
 * dropped, the path's trailing slash removed but its case kept (a mount path is
 * server-significant), and userinfo/query/fragment stripped — userinfo because
 * this key is PERSISTED on every kept server and copied into backups, and
 * `http://admin:pw@eve` is a credential typed into a non-secret field.
 *
 * `undefined` for anything `new URL` rejects (a scheme-less host is the common
 * typo): the fetch path builds its URLs from the same string, so a source whose
 * base URL cannot be parsed cannot sync at all and must not claim an identity.
 */
export function eveNgInstanceKey(config: InventorySourceValues): string | undefined {
  const normalized = normalizeBaseUrl(String(config.baseUrl ?? ""));
  if (!normalized) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return undefined;
  }
  // `host` rather than `hostname` so a non-default port stays part of the
  // identity; the parser has already dropped the scheme's default port. The
  // path is kept (trailing slash trimmed) because the fetch honours it.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Percent-encodes each SEGMENT and rejoins on "/". A whole-string
 * `encodeURIComponent` would escape the separators too and address a single
 * bizarrely-named folder; leaving the path raw sends a literal space, which the
 * URL parser mangles into a 404. EVE-NG lab and folder names routinely contain
 * spaces, so this is the common case rather than a corner.
 */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** "/", "", "  " and "/Customers/" all normalize to a canonical, slash-led, un-suffixed path. */
function normalizeFolderPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const withLead = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLead.replace(/\/+$/, "") || "/";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Error mapping — mirrors netboxProvider's mapNetworkError / throwForStatus /
// parseJsonOrThrow trio so both providers fail in the same vocabulary.
// ---------------------------------------------------------------------------

function mapNetworkError(err: unknown, url: URL): InventoryProviderError {
  const host = url.host || url.toString();
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new InventoryProviderError("network", `Connection to ${host} timed out.`);
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err as { code?: string }).code;
    if (code) {
      return new InventoryProviderError("network", `Could not reach ${host}: ${code}.`);
    }
    return new InventoryProviderError("network", `Could not reach ${host}: ${err.message}`);
  }
  return new InventoryProviderError("network", `Could not reach ${host}: ${String(err)}`);
}

function throwForStatus(status: number, text: string, url: URL): never {
  if (status === 401 || status === 403) {
    throw new InventoryProviderError("auth", `EVE-NG rejected the credentials (HTTP ${status}) at ${url}.`);
  }
  throw new InventoryProviderError("protocol", `EVE-NG request to ${url} failed with HTTP ${status}: ${text.slice(0, BODY_SLICE)}`);
}

/**
 * Every EVE-NG endpoint answers with a JSend envelope
 * (`{code, status, message, data}`), and — this is the part a status-code-only
 * client gets wrong — a REJECTED LOGIN comes back as HTTP 200 with
 * `status: "fail"`. The envelope is therefore validated as carefully as the
 * status line.
 */
interface JSendEnvelope {
  code?: number;
  status: string;
  message?: string;
  data?: unknown;
}

function parseEnvelope(text: string, url: URL): JSendEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // MINOR-7 — the body is attacker-influenced (a proxy's HTML error page,
    // say) and is NOT echoed into the message, matching NetBox's parse error.
    throw new InventoryProviderError("protocol", `Response from ${url} is not EVE-NG JSON — is the base URL correct?`);
  }
  if (!isObject(parsed) || !isString(parsed.status)) {
    throw new InventoryProviderError("protocol", `Response from ${url} is not an EVE-NG API envelope — is the base URL correct?`);
  }
  return parsed as unknown as JSendEnvelope;
}

interface RawResponse {
  status: number;
  text: string;
  url: URL;
}

// ---------------------------------------------------------------------------
// EveApiClient — owns login/cookie, JSend parsing, edition detection, the
// folder walk and per-lab node fetches. Every endpoint call goes through it, so
// a future Pro divergence lands inside this class rather than being sprinkled
// through the mapper.
// ---------------------------------------------------------------------------

export interface EveLab {
  /** Full EVE-NG path, ending ".unl" — the stable half of a node's externalId. */
  path: string;
  /** Lab name with the ".unl" suffix removed — the folder segment and the `lab` attribute. */
  name: string;
}

export interface FolderWalkResult {
  labs: EveLab[];
  /** Set when a cap (labs, depth, request budget) stopped the walk short. */
  truncated: boolean;
  warnings: string[];
}

type Edition = "community" | "pro" | "unknown";

/** MINOR-12 — a resource that 404'd (folder/lab deleted mid-walk), distinct from an empty one. */
const NOT_FOUND = Symbol("eve-ng-not-found");

class EveApiClient {
  private session?: string;

  public constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string
  ) {}

  /**
   * The host requests fall back to when EVE-NG reports a console on loopback.
   * MINOR-4 — brackets stripped so an IPv6 base URL (`http://[::1]:8080`)
   * yields `::1`, an address the telnet transport's `net.connect` can dial;
   * `URL.hostname` keeps the brackets, and the reported-host side already
   * strips them, so both sides must agree.
   */
  public get hostname(): string {
    try {
      return new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return "";
    }
  }

  /**
   * MINOR-6 — build a request URL, mapping `new URL`'s `TypeError` (a
   * scheme-less base URL is the common typo) into a provider error at the
   * client boundary instead of letting a raw `TypeError: Invalid URL` escape
   * `fetchInventory`.
   */
  private buildUrl(path: string): URL {
    try {
      return new URL(`${this.baseUrl}${path}`);
    } catch {
      throw new InventoryProviderError(
        "network",
        `The EVE-NG base URL "${this.baseUrl}" is not a valid URL — include http:// or https://.`
      );
    }
  }

  private async raw(url: URL, init: RequestInit, timeoutMs: number): Promise<{ res: Response; text: string }> {
    let res: Response;
    try {
      // MINOR-5 — `redirect: "manual"` on every request. No EVE-NG endpoint
      // legitimately redirects; the default `"follow"` would let a 3xx from the
      // lab box carry the crawl (and, on 307/308, the login POST body — the
      // password) to another origin. A 3xx surfaces below as a non-2xx protocol
      // error instead.
      res = await this.fetchImpl(url.toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw mapNetworkError(err, url);
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    return { res, text };
  }

  /**
   * `POST /api/auth/login` with `html5: "-1"`, which is what makes EVE-NG report
   * NATIVE `telnet://host:port` console URLs instead of browser HTML5 console
   * links. Without it every node's `url` is an HTML5 page and the entire
   * inventory maps to zero endpoints — a silent, total mapping failure rather
   * than an error.
   *
   * undici's fetch keeps NO cookie jar, so the `unetlab_session` cookie is
   * captured here by hand and replayed on every later request.
   */
  public async login(timeoutMs: number): Promise<void> {
    const url = this.buildUrl("/api/auth/login");
    const { res, text } = await this.raw(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: this.username, password: this.password, html5: "-1" })
      },
      timeoutMs
    );
    if (res.status < 200 || res.status >= 300) {
      throwForStatus(res.status, text, url);
    }
    const envelope = parseEnvelope(text, url);
    if (envelope.status !== "success") {
      // A rejected password is HTTP 200 + `status: "fail"`. Anything non-success
      // on the LOGIN endpoint is a credential problem by definition, so it maps
      // to `auth` regardless of the code the envelope claims.
      throw new InventoryProviderError(
        "auth",
        `EVE-NG rejected the credentials for "${this.username}": ${str(envelope.message) || envelope.status}`
      );
    }
    const session = readSessionCookie(res);
    if (!session) {
      // Carrying on without a cookie produces a 401 on the very next call, which
      // would be reported as expired credentials — pointing the user at a
      // password that is in fact correct.
      throw new InventoryProviderError(
        "protocol",
        `EVE-NG accepted the login at ${url} but returned no unetlab_session cookie — a proxy in front of it may be stripping Set-Cookie.`
      );
    }
    this.session = session;
  }

  /**
   * One authenticated GET, with the single silent re-login the session lifetime
   * makes necessary: EVE-NG expires sessions aggressively, and a mid-crawl 401
   * on a large tree would otherwise fail a sync that one extra round trip
   * saves. Exactly ONE retry — a wrong password must not become an unbounded
   * login loop against the lab server.
   *
   * Returns the raw response rather than throwing on a non-2xx, because
   * `testConnection` has to tell a 404 (fall back to another endpoint) from
   * every other failure (surface it).
   */
  public async authedGet(path: string, timeoutMs: number): Promise<RawResponse> {
    const url = this.buildUrl(path);
    const send = async (): Promise<{ res: Response; text: string }> =>
      this.raw(url, { headers: { Cookie: `unetlab_session=${this.session ?? ""}`, Accept: "application/json" } }, timeoutMs);

    let { res, text } = await send();
    if (res.status === 401 || res.status === 403) {
      await this.login(timeoutMs);
      ({ res, text } = await send());
    }
    return { status: res.status, text, url };
  }

  /** `authedGet` plus the 2xx + JSend-success checks — the normal path. */
  public async getData(path: string, timeoutMs: number): Promise<unknown> {
    const raw = await this.authedGet(path, timeoutMs);
    return unwrap(raw);
  }

  /**
   * MINOR-12 — like `getData`, but a 404 returns the `NOT_FOUND` sentinel
   * instead of throwing. A folder or lab can vanish between the parent listing
   * that named it and the request for its own contents; a live lab tree hits
   * this routinely, and aborting the entire sync over one gone folder updates
   * nothing. Every OTHER failure (auth, 500, malformed) still throws.
   */
  public async getDataAllowingGone(path: string, timeoutMs: number): Promise<unknown | typeof NOT_FOUND> {
    const raw = await this.authedGet(path, timeoutMs);
    if (raw.status === 404) {
      return NOT_FOUND;
    }
    return unwrap(raw);
  }

  /**
   * `GET /api/status` → `data.version`. A version string naming "pro" (any
   * case) is Professional; anything else is Community. A MISSING endpoint is
   * `unknown` rather than fatal — edition detection is an optional capability
   * probe, and failing a whole sync over it would make an older build unusable.
   * Any other failure still propagates: a 500 here means the server is unwell,
   * not that it is old.
   */
  public async detectEdition(timeoutMs: number): Promise<Edition> {
    const raw = await this.authedGet("/api/status", timeoutMs);
    if (raw.status === 404) {
      return "unknown";
    }
    const data = unwrap(raw);
    if (!isObject(data)) {
      return "unknown";
    }
    // P2 (round 5) — a dedicated `data.edition` field is authoritative when it
    // names Pro. Some installs report the edition there while `data.version` is
    // just a numeric build string ("6.2.0-4"), so version-only detection would
    // return Community and never show the Pro-preliminary warning. Kept
    // defensive: `edition` may be absent or non-string (`str` yields "" then),
    // in which case we fall back to the legacy version check.
    const edition = str(data.edition);
    const version = str(data.version);
    if (/pro/i.test(edition) || /pro/i.test(version)) {
      return "pro";
    }
    // With no usable version AND no edition field there is no signal at all —
    // the capability is unknown (a `/api/status` with an empty version, like the
    // 404 case, shows no warning either way).
    if (!version && !edition) {
      return "unknown";
    }
    return "community";
  }

  /**
   * `GET /api/folders{path}` — the raw listing, already unwrapped from JSend.
   * `NOT_FOUND` when the folder 404s (deleted since it was listed — MINOR-12).
   *
   * P1 (data-loss) — the documented shape is STRICT: `data` is an object with a
   * `folders` array and a `labs` array (both keys present even for an empty
   * folder). A success envelope carrying anything else — `data` missing, null, a
   * primitive, or a partial/wrong-typed object — is a protocol error, NOT an
   * empty folder. Coercing it to `{folders:[],labs:[]}` would make the whole
   * inventory look empty, and `computeSyncPlan` would then orphan/delete every
   * owned device (and its credentials) over a malformed response.
   */
  public async listFolder(folderPath: string, timeoutMs: number): Promise<{ folders: unknown[]; labs: unknown[] } | typeof NOT_FOUND> {
    const data = await this.getDataAllowingGone(`/api/folders${encodePath(folderPath)}`, timeoutMs);
    if (data === NOT_FOUND) {
      return NOT_FOUND;
    }
    if (!isObject(data) || !Array.isArray(data.folders) || !Array.isArray(data.labs)) {
      throw new InventoryProviderError(
        "protocol",
        `EVE-NG returned a malformed folder listing for "${folderPath}" — expected { folders: [...], labs: [...] }. Failing the sync rather than risk pruning every device.`
      );
    }
    return { folders: data.folders, labs: data.labs };
  }

  /**
   * `GET /api/labs{labPath}/nodes` → `[nodeId, node]` pairs.
   *
   * `data` is an OBJECT keyed by node id — except for a lab with no nodes,
   * where EVE-NG returns an empty ARRAY instead. Both shapes are normalized
   * here; a client that demands an object fails the entire sync over one empty
   * lab.
   */
  public async listNodes(labPath: string, timeoutMs: number): Promise<[string, Record<string, unknown>][] | typeof NOT_FOUND> {
    const data = await this.getDataAllowingGone(`/api/labs${encodePath(labPath)}/nodes`, timeoutMs);
    // MINOR-12 — the lab was deleted between the folder listing and this fetch.
    if (data === NOT_FOUND) {
      return NOT_FOUND;
    }
    // The documented shapes are exactly two: an object keyed by node id, or the
    // EMPTY array EVE-NG returns for a lab with no nodes. P1 (data boundary) —
    // anything else (a primitive, null, or a NON-empty array) is malformed and
    // must fail the sync, not read as "this lab has no nodes" — which would
    // prune the lab's servers over a bad response.
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return [];
      }
      throw new InventoryProviderError(
        "protocol",
        `EVE-NG returned a malformed node list for "${labPath}" — a non-empty array is not the expected node map.`
      );
    }
    if (!isObject(data)) {
      throw new InventoryProviderError(
        "protocol",
        `EVE-NG returned a malformed node list for "${labPath}" — expected an object keyed by node id or an empty array.`
      );
    }
    // P1-a (Codex review) — a node VALUE that is not an object FAILS the sync,
    // joining the malformed-lab / malformed-folder treatment. It used to become
    // an endpoint-less placeholder for prune-protection, but an endpoint-less
    // device is now an ADDRESSLESS placeholder — an ACTIVE downgrade in
    // computeSyncPlan that clears a working owned server's host/port. So a
    // transient corruption of one node value would nuke a real profile's
    // address; failing closed protects it instead. The split is object-VALIDITY,
    // not endpoint-presence: a valid object with no telnet console is still a
    // legitimate addressless placeholder (the feature), handled by the mapper.
    //
    // `Object.entries` reads only own enumerable properties and never writes, so
    // a prototype-polluting key (`__proto__`, `constructor` from JSON.parse)
    // carrying a VALID object value is just a harmless string in the externalId.
    const entries = Object.entries(data);
    for (const [key, value] of entries) {
      if (!isObject(value)) {
        throw new InventoryProviderError(
          "protocol",
          `EVE-NG returned a malformed node "${key}" in "${labPath}" (its value is not an object). Failing the sync rather than downgrade the node's server over corrupt data.`
        );
      }
    }
    return entries as [string, Record<string, unknown>][];
  }

  /**
   * Breadth-first walk from `root`, collecting labs. Three independent guards,
   * because an EVE-NG folder listing is server-supplied data that can name any
   * path at all:
   *  - a VISITED SET, so a listing pointing back at an ancestor (or the ".."
   *    entry every listing carries) cannot loop;
   *  - a DEPTH CAP, so a pathological generator of ever-deeper paths terminates;
   *  - a REQUEST BUDGET, so a wide-and-deep tree cannot hammer the server.
   *
   * Every guard that actually fires sets `truncated`, which is what stops
   * `computeSyncPlan` from reading the labs we never reached as "deleted at the
   * source" and pruning their servers.
   */
  public async walkFolders(root: string, matchesFilter: (labPath: string) => boolean, timeoutMs: number): Promise<FolderWalkResult> {
    const labs: EveLab[] = [];
    const warnings: string[] = [];
    const visited = new Set<string>([root]);
    let queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
    let requests = 0;
    let truncated = false;
    let depthCapped = false;
    // E-2 (Fable) — set ONLY when a lab is actually skipped for the MAX_LABS cap, so
    // the "Stopped after N labs" warning does not misfire at exact capacity when the
    // tree was truncated for an unrelated reason (the depth/budget cap).
    let labsCapped = false;
    let budgetHit = false;
    // MINOR-12 — child folders that 404'd (removed mid-walk); counted for one
    // aggregate warning, never fatal (only the ROOT 404 is fatal — see below).
    let goneFolders = 0;
    // MAJOR-1(a) — LABS the server reported OUTSIDE the Root Folder subtree, or
    // bearing a dot-segment. Counted, not silently dropped: a lab carries devices,
    // so a scope violation that hides one is worth surfacing. It is NOT a cap, so
    // it must not set `truncated` (that would disable pruning of the in-scope
    // servers that legitimately disappeared).
    //
    // E-3 (Fable) — only LABS are counted here. An out-of-scope FOLDER EDGE is
    // silently skipped by `isDescendable` below rather than counted: a folder edge
    // is a descent target, not a device, so skipping one hides nothing on its own
    // (any in-scope labs are still reached by their own in-scope paths). The warning
    // copy therefore says "labs", never "labs and folders".
    let outOfScope = 0;

    // MINOR-1 — the budget check breaks BOTH loops and the warning is pushed
    // exactly once, below. The old code warned inside the loop and then let
    // `queue = next` run, so every level already queued when the budget tripped
    // warned again; its `queue = []` was dead, overwritten by `queue = next`.
    while (queue.length > 0 && !budgetHit) {
      const next: typeof queue = [];
      for (const { path, depth } of queue) {
        if (requests >= MAX_FOLDER_REQUESTS) {
          budgetHit = true;
          break;
        }
        requests++;
        const listing = await this.listFolder(path, timeoutMs);
        if (listing === NOT_FOUND) {
          // MINOR-12 — the ROOT folder being gone would yield an empty tree and
          // prune every server the source owns, so it is fatal; a child folder
          // vanishing mid-walk is just skipped.
          if (depth === 0) {
            throw new InventoryProviderError("protocol", `Root Folder "${path}" was not found on the EVE-NG server.`);
          }
          goneFolders++;
          continue;
        }

        for (const rawLab of listing.labs) {
          // P1 — a malformed LAB entry FAILS the sync (the OPPOSITE of the
          // malformed-NODE case in `listNodes`, and the asymmetry is the point).
          // A node has a recoverable identity — its map key — so a bad node
          // value is preserved as an endpoint-less placeholder. A lab does not:
          // if the entry is not an object, or is an object with no usable `.unl`
          // path, we cannot enumerate which nodes/servers it should contain, so
          // there is no safe placeholder. Skipping it would omit an UNKNOWN
          // number of real servers while leaving the tree non-truncated, and
          // computeSyncPlan would prune every one of them — so we fail loudly.
          if (!isObject(rawLab)) {
            throw new InventoryProviderError(
              "protocol",
              `EVE-NG returned a malformed lab entry under "${path}" (not an object). Failing the sync rather than risk pruning that lab's servers.`
            );
          }
          const labPath = normalizeFolderPath(str(rawLab.path) || joinPath(path, str(rawLab.file)));
          if (!labPath.toLowerCase().endsWith(".unl")) {
            throw new InventoryProviderError(
              "protocol",
              `EVE-NG returned a lab entry under "${path}" with no usable .unl path. Failing the sync rather than risk pruning that lab's servers.`
            );
          }
          // MAJOR-1(a)/(b) — confine the lab path with the SAME boundary check
          // as folder edges, and reject dot-segments, before it is ever turned
          // into a `/api/labs{labPath}/nodes` request. Skipping a lab hides
          // devices, so this counts toward one aggregate warning rather than
          // vanishing silently.
          if (hasDotSegment(labPath) || !isWithin(labPath, root)) {
            outOfScope++;
            continue;
          }
          if (!matchesFilter(labPath)) continue;
          if (labs.length >= MAX_LABS) {
            truncated = true;
            labsCapped = true;
            continue;
          }
          labs.push({ path: labPath, name: labNameOf(labPath) });
        }

        // A folder entry Nexus would actually descend into: an in-scope,
        // unvisited, dot-segment-free child. The `..` parent entry every
        // listing carries (and any out-of-scope or already-visited entry) is
        // NOT one, so it must not count toward "there is more tree below".
        const isDescendable = (rawFolder: unknown): boolean => {
          if (!isObject(rawFolder)) return false;
          const childPath = normalizeFolderPath(str(rawFolder.path));
          return !hasDotSegment(childPath) && isWithin(childPath, root) && !visited.has(childPath);
        };

        // P1 (data-loss) — the last member of the containment hierarchy
        // (envelope → node → lab → FOLDER), and it fails the sync for the SAME
        // reason the malformed-lab case does: a folder we cannot descend into
        // (a non-object entry, or an object with no usable `path`) hides an
        // UNKNOWN subtree of servers, and skipping it would prune every one of
        // them while the tree stays non-truncated. The ASYMMETRY, documented
        // here as on the lab and node sites: only MALFORMED fails. The
        // LEGITIMATELY not-descendable entries below — the `..` parent every
        // listing carries, an out-of-scope path (MAJOR-1a), an already-visited
        // path (cycle guard), a dot-segment path (MAJOR-1b) — are NOT malformed
        // and keep being skipped, because failing on `..` would make every
        // normal EVE-NG tree unsyncable.
        const isMalformedFolder = (rawFolder: unknown): boolean =>
          !isObject(rawFolder) || str((rawFolder as Record<string, unknown>).path) === "";
        for (const rawFolder of listing.folders) {
          if (isMalformedFolder(rawFolder)) {
            throw new InventoryProviderError(
              "protocol",
              `EVE-NG returned a malformed child-folder entry under "${path}" (not an object, or no usable path). Failing the sync rather than risk pruning that subtree's servers.`
            );
          }
        }

        if (depth >= MAX_FOLDER_DEPTH) {
          // P2-2 — only mark truncated when a GENUINELY descendable child
          // remains below the cap. Counting `folders.length` treated the
          // ever-present `..` entry of a valid leaf as unfinished work, marking
          // the whole tree truncated forever — which makes `computeSyncPlan`
          // skip pruning, so servers for deleted nodes are never removed.
          if (listing.folders.some(isDescendable)) {
            depthCapped = true;
            truncated = true;
          }
          continue;
        }
        for (const rawFolder of listing.folders) {
          // NEVER LEAVE THE SUBTREE the user scoped with Root Folder. The
          // listing's paths are server-supplied. A dot-segment
          // (`/A/../../secret`) is rejected outright — `new URL` would
          // otherwise collapse it past `isWithin` into a request on a different
          // path (MAJOR-1(b)); this also subsumes the old ".." parent-entry
          // skip, whose path always points at an ancestor and so fails
          // `isWithin` too. A visited path cannot be re-entered, so a cycle
          // spelled with real folder names still terminates.
          if (!isDescendable(rawFolder)) continue;
          const childPath = normalizeFolderPath(str((rawFolder as Record<string, unknown>).path));
          visited.add(childPath);
          next.push({ path: childPath, depth: depth + 1 });
        }
      }
      queue = next;
    }

    if (budgetHit) {
      truncated = true;
      warnings.push(
        `Stopped after ${MAX_FOLDER_REQUESTS} folder listings — part of the EVE-NG folder tree was not scanned. Narrow the Root Folder.`
      );
    }
    if (labsCapped) {
      warnings.push(`Stopped after ${MAX_LABS} labs — later labs under the Root Folder were not imported. Narrow the Root Folder or the Lab Filter.`);
    }
    if (depthCapped) {
      warnings.push(`The EVE-NG folder tree is deeper than ${MAX_FOLDER_DEPTH} levels — folders below that depth were not scanned.`);
    }
    if (outOfScope > 0) {
      warnings.push(
        `${outOfScope} lab${outOfScope === 1 ? "" : "s"} the server reported outside the Root Folder ${
          outOfScope === 1 ? "was" : "were"
        } skipped.`
      );
    }
    if (goneFolders > 0) {
      warnings.push(
        `${goneFolders} folder${goneFolders === 1 ? "" : "s"} ${goneFolders === 1 ? "was" : "were"} not found (removed during the scan) and skipped.`
      );
    }
    return { labs, truncated, warnings };
  }
}

/** 2xx + JSend `status: "success"`, or the mapped error for whatever went wrong. */
function unwrap(raw: RawResponse): unknown {
  if (raw.status < 200 || raw.status >= 300) {
    throwForStatus(raw.status, raw.text, raw.url);
  }
  const envelope = parseEnvelope(raw.text, raw.url);
  if (envelope.status !== "success") {
    if (envelope.code === 401 || envelope.code === 403) {
      throw new InventoryProviderError("auth", `EVE-NG refused ${raw.url}: ${str(envelope.message) || envelope.status}`);
    }
    throw new InventoryProviderError(
      "protocol",
      `EVE-NG reported "${envelope.status}" for ${raw.url}: ${str(envelope.message).slice(0, BODY_SLICE) || "no message"}`
    );
  }
  return envelope.data;
}

/**
 * The `unetlab_session` value out of a login response's Set-Cookie header(s).
 * `getSetCookie()` is the correct API (a response can carry several Set-Cookie
 * headers and `get` folds them into one string); `get` is the fallback for a
 * Response-alike that predates it.
 */
function readSessionCookie(res: Response): string | undefined {
  const headers = res.headers as unknown as
    | { getSetCookie?: () => string[]; get?: (name: string) => string | null }
    | undefined;
  if (!headers) {
    return undefined;
  }
  const many = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const one = typeof headers.get === "function" ? headers.get("set-cookie") : null;
  for (const cookie of many.length > 0 ? many : one ? [one] : []) {
    const match = /(?:^|[;,\s])unetlab_session=([^;,\s]+)/.exec(cookie);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** Is `child` the root itself, or strictly beneath it? */
function isWithin(child: string, root: string): boolean {
  return root === "/" || child === root || child.startsWith(`${root}/`);
}

/**
 * MAJOR-1(b) — a `.` or `..` SEGMENT in a path. The `isWithin` boundary check
 * runs on the LOGICAL path, but `new URL` collapses dot-segments AFTER that
 * check when the request is built, so `/A/../../secret` (root `/A`) passes
 * `isWithin` — it startsWith `/A/` — and then the fetch lands on `/api/secret`
 * with the session cookie. Rejecting any path with a dot-segment before it is
 * ever turned into a request closes that gap for both folder and lab paths;
 * confinement then holds against the post-normalization path the fetch uses.
 */
function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function joinPath(folder: string, file: string): string {
  const base = folder === "/" ? "" : folder;
  return `${base}/${file}`;
}

function labNameOf(labPath: string): string {
  const file = labPath.slice(labPath.lastIndexOf("/") + 1);
  return file.replace(/\.unl$/i, "");
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * A console address EVE-NG reports that is only meaningful ON the EVE-NG host.
 * Keeping it would point every console at the USER'S OWN machine, where the
 * connection either fails opaquely or — worse — succeeds against something
 * unrelated that happens to be listening.
 */
function isHostLocalOnly(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "" || bare === "localhost" || bare === "0.0.0.0" || bare === "::" || bare === "::1" || /^127\./.test(bare);
}

interface TelnetTarget {
  host: string;
  port: number;
}

/**
 * `telnet://127.0.0.1:32769` → the address a Nexus telnet server should
 * actually dial. `undefined` when the node has no native telnet console — an
 * HTML5/VNC console URL, an empty `url` (common on a stopped Community node),
 * or something that is not a URL at all.
 */
function resolveTelnetTarget(consoleKind: string, rawUrl: string, consoleHost: string, baseHostname: string): TelnetTarget | undefined {
  if (consoleKind.toLowerCase() !== "telnet" || !rawUrl) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "telnet:") {
    return undefined;
  }
  // MINOR-3 — a malformed console URL (`telnet:1.2.3.4:9000` with no `//`,
  // or `telnet://`) parses to an EMPTY hostname. Left to the loopback branch
  // below, `isHostLocalOnly("")` is true and the EVE-NG host is substituted —
  // minting a bogus endpoint pointed at port 23 of the EVE box. An empty host
  // means we do not actually know where the console is, so: no endpoint.
  const reported = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!reported) {
    return undefined;
  }
  // MINOR-3 — reject port 0 (and anything out of range) before deciding the
  // host: a port-0 endpoint dials port 0, which never connects.
  const port = parsed.port ? Number(parsed.port) : 23;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return undefined;
  }
  // The override wins over BOTH the reported host and the base URL host: it
  // exists for the NAT case, where neither of those is reachable from here.
  const host = consoleHost || (isHostLocalOnly(reported) ? baseHostname : reported);
  if (!host) {
    return undefined;
  }
  return { host, port };
}

function mapNode(
  nodeId: string,
  raw: Record<string, unknown>,
  lab: EveLab,
  rootPrefix: string,
  consoleHost: string,
  baseHostname: string
): { device: InventoryDevice; hasEndpoint: boolean } {
  const rawName = str(raw.name);
  // Never dropped for a cosmetic data problem: a dropped device reads as
  // "deleted at the source" and the source's prune policy acts on the server.
  const name = rawName || `node-${nodeId}`;
  const consoleKind = str(raw.console);
  const target = resolveTelnetTarget(consoleKind, str(raw.url), consoleHost, baseHostname);
  const running = Number(raw.status) === 2;

  const attributes: Record<string, string> = {};
  const put = (key: string, value: string): void => {
    if (value) {
      attributes[key] = value;
    }
  };
  put("lab", lab.name);
  put("template", str(raw.template));
  put("type", str(raw.type));
  put("console", consoleKind);
  put("status", running ? "running" : "stopped");
  put("image", str(raw.image));
  put("name", name);

  return {
    hasEndpoint: target !== undefined,
    device: {
      // Stable and unique across labs: two labs each have a node "1", and a
      // bare node id would collapse every lab's node 1 into one server.
      //
      // E-4 (Fable) — the identity is `<lab path>#<node id>`, so RENAMING OR MOVING
      // a lab reidentifies every node in it: the old externalIds vanish from the
      // fetch and the sync prunes their servers, while the new ones arrive as fresh
      // adds. EVE-NG exposes no lab-stable GUID to key on, so this churn (prune +
      // re-add, losing per-server hand edits and credentials on a lab rename) is a
      // known limitation rather than a bug.
      externalId: `${lab.path}#${nodeId}`,
      name,
      folderPath: labFolderPath(lab, rootPrefix),
      endpoints: target ? [{ kind: "telnet", host: target.host, port: target.port }] : [],
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined
    }
  };
}

/**
 * The lab's own folder, made RELATIVE to the source's root folder, with the lab
 * name as the final segment — so every lab is a folder in the tree and the
 * source's `targetFolder` is not shadowed by a repeat of the root path.
 *
 * MINOR-2 — the prefix is stripped on a SEGMENT boundary (the dir must equal
 * the root prefix or sit directly under it), not by raw `startsWith`, which
 * would shave `/Cust` off `/CustXtra` and yield `Xtra/…`.
 */
export function labFolderPath(lab: EveLab, rootPrefix: string): string {
  const dir = lab.path.slice(0, lab.path.lastIndexOf("/"));
  const withinRoot = rootPrefix !== "" && (dir === rootPrefix || dir.startsWith(`${rootPrefix}/`));
  const relative = (withinRoot ? dir.slice(rootPrefix.length) : dir).replace(/^\/+/, "");
  return relative ? `${relative}/${lab.name}` : lab.name;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function makeClient(fetchImpl: typeof fetch, config: InventorySourceValues, secrets: InventorySourceSecrets): EveApiClient {
  return new EveApiClient(
    fetchImpl,
    normalizeBaseUrl(String(config.baseUrl ?? "")),
    String(config.username ?? ""),
    secrets.password ?? ""
  );
}

async function fetchInventoryImpl(
  fetchImpl: typeof fetch,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryTree> {
  const client = makeClient(fetchImpl, config, secrets);
  const root = normalizeFolderPath(String(config.rootFolder ?? "/"));
  // MAJOR-1(b) — a user-typed Root Folder is built into every folder request,
  // so a `.`/`..` segment in it would be collapsed by `new URL` into a scope
  // the user never named. Reject it up front with a clear message rather than
  // silently scanning somewhere else.
  if (hasDotSegment(root)) {
    throw new InventoryProviderError("protocol", `Root Folder "${root}" must not contain "." or ".." path segments.`);
  }
  const rootPrefix = root === "/" ? "" : root;
  const filter = str(config.filter).toLowerCase();
  // Absent means INCLUDED — `includeStopped` defaults to true (see the field),
  // and reading an absent value as false would silently drop every stopped node
  // from a source the user never configured that way.
  const includeStopped = config.includeStopped !== false;
  const consoleHost = str(config.consoleHost);

  const warnings: string[] = [];
  await client.login(FETCH_TIMEOUT_MS);

  if ((await client.detectEdition(FETCH_TIMEOUT_MS)) === "pro") {
    warnings.push(EVE_NG_PRO_WARNING);
  }

  const walk = await client.walkFolders(root, (labPath) => !filter || labPath.toLowerCase().includes(filter), FETCH_TIMEOUT_MS);
  warnings.push(...walk.warnings);
  let truncated = walk.truncated;

  const devices: InventoryDevice[] = [];
  let noConsoleCount = 0;
  let goneLabs = 0;
  let nodesCapped = false;
  for (const lab of walk.labs) {
    if (nodesCapped) break;
    const nodePairs = await client.listNodes(lab.path, FETCH_TIMEOUT_MS);
    // MINOR-12 — the lab was deleted between the folder listing that named it
    // and this node fetch; skip it with a warning rather than aborting.
    if (nodePairs === NOT_FOUND) {
      goneLabs++;
      continue;
    }
    for (const [nodeId, raw] of nodePairs) {
      // `raw` is guaranteed an object — `listNodes` fails the sync on any
      // non-object node value (P1-a). A valid object with no telnet console is
      // still mapped (to an endpoint-less, i.e. addressless, device).
      if (!includeStopped && Number(raw.status) !== 2) {
        continue;
      }
      if (devices.length >= MAX_NODES) {
        nodesCapped = true;
        truncated = true;
        break;
      }
      const mapped = mapNode(nodeId, raw, lab, rootPrefix, consoleHost, client.hostname);
      devices.push(mapped.device);
      if (!mapped.hasEndpoint) {
        noConsoleCount++;
      }
    }
  }

  if (noConsoleCount > 0) {
    // ONE aggregate line, not one per node: a lab full of VNC-consoled
    // appliances would otherwise bury every other warning in the plan summary.
    warnings.push(
      `${noConsoleCount} node${noConsoleCount === 1 ? " has" : "s have"} no telnet console URL (a non-telnet console type, or no console address yet) and ${
        noConsoleCount === 1 ? "was" : "were"
      } imported without a connection endpoint.`
    );
  }
  if (goneLabs > 0) {
    warnings.push(`${goneLabs} lab${goneLabs === 1 ? "" : "s"} ${goneLabs === 1 ? "was" : "were"} not found (removed during the scan) and skipped.`);
  }
  if (nodesCapped) {
    warnings.push(`Stopped after ${MAX_NODES} nodes — later labs' nodes were not imported. Narrow the Root Folder or the Lab Filter.`);
  }
  return { contractVersion: 1, devices, warnings, truncated: truncated || undefined };
}

/**
 * LIVE STATUS (Phase 2) — the running/stopped state of every node the source
 * can see, keyed by the SAME `${lab.path}#${nodeId}` externalId `fetchInventory`
 * uses, so a status maps onto the server it belongs to. Reuses the exact
 * login / walkFolders / listNodes machinery `fetchInventory` does, under the same
 * auth/cookie/timeout/error discipline, but emits ONLY status:
 *  - NO `includeStopped` filter — this is not a sync; every node's status is
 *    reported and the tree decides what to render;
 *  - a fresh telnet console endpoint is emitted ONLY for a RUNNING node, parsed
 *    through the same `resolveTelnetTarget` helper `mapNode` uses (loopback /
 *    consoleHost substitution) so the two never drift. A stopped node — and a
 *    running node with no native telnet console — carries no console fields.
 */
async function fetchStatusImpl(
  fetchImpl: typeof fetch,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryStatusReport> {
  const client = makeClient(fetchImpl, config, secrets);
  const root = normalizeFolderPath(String(config.rootFolder ?? "/"));
  if (hasDotSegment(root)) {
    throw new InventoryProviderError("protocol", `Root Folder "${root}" must not contain "." or ".." path segments.`);
  }
  const filter = str(config.filter).toLowerCase();
  const consoleHost = str(config.consoleHost);

  await client.login(FETCH_TIMEOUT_MS);
  const walk = await client.walkFolders(root, (labPath) => !filter || labPath.toLowerCase().includes(filter), FETCH_TIMEOUT_MS);

  const statuses: Record<string, InventoryDeviceStatus> = {};
  let nodeCount = 0;
  // TRUNCATION — a partial scan (the node cap here, or the folder/lab/budget
  // caps inside walkFolders) must be signalled, so applyInventoryStatus MERGES
  // this report rather than clearing the decorations of nodes it never reached.
  // Same idiom fetchInventory uses.
  let truncated = walk.truncated;
  let nodesCapped = false;
  for (const lab of walk.labs) {
    if (nodesCapped) break;
    const nodePairs = await client.listNodes(lab.path, FETCH_TIMEOUT_MS);
    // MINOR-12 — the lab was deleted between the folder listing and this fetch;
    // skip it, exactly as fetchInventory does.
    if (nodePairs === NOT_FOUND) {
      continue;
    }
    for (const [nodeId, raw] of nodePairs) {
      if (nodeCount >= MAX_NODES) {
        nodesCapped = true;
        truncated = true;
        break;
      }
      nodeCount++;
      const running = Number(raw.status) === 2;
      const status: InventoryDeviceStatus = { state: running ? "running" : "stopped" };
      if (running) {
        const target = resolveTelnetTarget(str(raw.console), str(raw.url), consoleHost, client.hostname);
        if (target) {
          status.consoleHost = target.host;
          status.consolePort = target.port;
        }
      }
      statuses[`${lab.path}#${nodeId}`] = status;
    }
  }
  return { contractVersion: 1, statuses, truncated: truncated || undefined };
}

async function testConnectionImpl(fetchImpl: typeof fetch, config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void> {
  const client = makeClient(fetchImpl, config, secrets);
  await client.login(TEST_CONNECTION_TIMEOUT_MS);
  const status = await client.authedGet("/api/status", TEST_CONNECTION_TIMEOUT_MS);
  // ONLY a 404 falls back — the endpoint is absent on an older build. An auth
  // failure must bubble as-is (`unwrap` maps it), never masked by a second
  // request that could succeed on a laxer endpoint and report a broken source
  // as healthy. Branching on the STATUS CODE rather than on the shape of the
  // error message keeps the two decisions from drifting apart.
  if (status.status !== 404) {
    unwrap(status);
    return;
  }
  unwrap(await client.authedGet("/api/folders/", TEST_CONNECTION_TIMEOUT_MS));
}

export function createEveNgProvider(fetchImpl: typeof fetch = fetch): InventoryProvider {
  return {
    id: EVE_NG_PROVIDER_ID,
    label: "EVE-NG",
    configFields: EVE_NG_CONFIG_FIELDS,
    attributeKeys: ["lab", "template", "type", "console", "status", "image", "name"],
    instanceKey(config: InventorySourceValues): string | undefined {
      return eveNgInstanceKey(config);
    },
    testConnection(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void> {
      return testConnectionImpl(fetchImpl, config, secrets);
    },
    fetchInventory(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryTree> {
      return fetchInventoryImpl(fetchImpl, config, secrets);
    },
    fetchStatus(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryStatusReport> {
      return fetchStatusImpl(fetchImpl, config, secrets);
    }
  };
}
