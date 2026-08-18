import { ADVANCED_SECTION_LABEL } from "../../../ui/formTypes";
import { certificateFailureMessage, type CertificateHintContext } from "../certificateHints";
import { createInsecureHttpsFetch } from "../insecureFetch";
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
/**
 * WALL-CLOCK CRAWL DEADLINE (task #30) — the whole crawl (folder walk + per-lab
 * node fetch) is bounded in real time as well as by the request/lab/node/depth
 * caps above. The caps bound WORK; this bounds TIME, which the others cannot: a
 * tree well within every cap but served by a slow EVE-NG box can still take
 * minutes per listing and hang the sync/refresh. Computed ONCE per crawl and
 * shared between `walkFolders` and the node-fetch loop, so the two phases share a
 * single budget rather than each getting a fresh one. Trips `truncated` (a
 * partial crawl, so `applyInventoryStatus` MERGES rather than prunes) and pushes
 * a deadline-named warning. `Date.now()` is allowed here — only Workflow scripts
 * forbid it.
 */
const CRAWL_DEADLINE_MS = 120_000;

/** Bound on an error message's echo of a response body — see `throwForStatus`. */
const BODY_SLICE = 200;

export const EVE_NG_PRO_WARNING =
  "EVE-NG Professional detected — Pro support is preliminary in this version; lab discovery and console mapping are validated against Community edition.";

/**
 * INSECURE TLS — ONE definition of the option's name, used both as the config
 * field's label and inside the certificate-error hint that tells the user to go
 * turn it on. A message naming an option the form does not show is worse than
 * the bare OpenSSL code it replaced, so the two cannot be allowed to drift.
 */
const ALLOW_INSECURE_TLS_LABEL = "Allow a Self-Signed or Mismatched Certificate";

/**
 * INSECURE TLS — what a sync that RAN with certificate verification off says
 * about itself, on the same `tree.warnings` channel as the Pro warning above.
 *
 * The opt-in is read once, at transport selection, and would otherwise never be
 * heard from again — so a source ticked for a lab box and later repointed at a
 * remote EVE-NG keeps sending the password over an unauthenticated connection
 * with nothing on screen saying so. (Same answer for a restored backup that
 * enables the flag: an import can already add telnet servers, proxies and jump
 * hosts, so the proportionate response is disclosure, not another gate.)
 *
 * Names the option so it can be found and turned back off, and names the
 * password because that is the part the user is actually exposed on.
 */
export const EVE_NG_INSECURE_TLS_WARNING =
  `Certificate verification is off for this source (\u201c${ALLOW_INSECURE_TLS_LABEL}\u201d) \u2014 the connection is encrypted but unauthenticated, and the EVE-NG password is sent over it.`;

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
    // symptom is otherwise an opaque certificate code that never names a
    // remedy, and EVE-NG ships a self-signed certificate by default. It used
    // to say self-signed HTTPS was unsupported; `allowInsecureTls` below made
    // that false, so it points there instead of telling the user to give up.
    description:
      `The EVE-NG web UI address; a trailing slash is fine. If it is https with EVE-NG's own self-signed certificate, see \u201c${ALLOW_INSECURE_TLS_LABEL}\u201d under ${ADVANCED_SECTION_LABEL}.`
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
  },
  {
    // INSECURE TLS — the opt-in that makes a self-signed or IP-addressed
    // EVE-NG box reachable at all. Default OFF and behind the Advanced
    // disclosure: it turns a safety default off, so it must be a deliberate
    // act rather than something a user finds themselves next to while typing a
    // base URL. Appended LAST so no existing field changes position.
    id: "allowInsecureTls",
    label: ALLOW_INSECURE_TLS_LABEL,
    type: "boolean",
    required: false,
    defaultValue: false,
    advanced: true,
    // Voice matches the telnet cleartext hint: state the exposure, say where it
    // is reasonable, stop. The password clause is the part that must not be
    // softened — it is what the user is actually agreeing to send.
    description:
      "Connects over https without checking the server's certificate. The traffic is encrypted but unauthenticated, so anything on the network path can intercept it \u2014 including the EVE-NG username and password, which are sent over that connection. Reasonable for a lab box on a network you trust; not for one reachable from outside it. Has no effect on an http base URL, which is not encrypted at all."
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

/**
 * WALL-CLOCK DEADLINE (task #30, #84 P2) — the sentinel `raw()` throws when a
 * request's abort was caused by the CRAWL DEADLINE expiring mid-flight (as
 * opposed to a genuine per-request network timeout with the deadline still far
 * off). The crawl loops CATCH it and terminate as TRUNCATED — returning the
 * partial results collected so far plus the deadline warning — rather than
 * letting it propagate as a `network` failure that discards the whole crawl. Not
 * an `InventoryProviderError`, so it can never be mistaken for a real fetch error
 * anywhere it might leak (a leak surfaces as a plain Error, loud, not a
 * misclassified network failure).
 */
class CrawlDeadlineExceeded extends Error {
  public constructor() {
    super("EVE-NG crawl deadline exceeded");
    this.name = "CrawlDeadlineExceeded";
  }
}

/**
 * INSECURE TLS — what this provider contributes to the SHARED certificate-hint
 * sentence (`services/inventory/certificateHints.ts`). The table of codes and the
 * "turn on <option> in this source's <section>" builder are one copy for every
 * provider that offers the opt-in; only the three provider-specific parts are
 * named here.
 *
 * `selfSignedNote` earns its place: EVE-NG SHIPS a self-signed certificate by
 * default, so saying so is what tells the user this is the expected state of a
 * stock install rather than something being wrong with their server.
 */
const EVE_NG_CERT_HINT_CONTEXT: CertificateHintContext = {
  optionLabel: ALLOW_INSECURE_TLS_LABEL,
  sectionLabel: ADVANCED_SECTION_LABEL,
  // The clause the user is actually agreeing to; it must not be softened.
  exposureNoun: "the EVE-NG password",
  selfSignedNote: ", which EVE-NG ships by default"
};

function mapNetworkError(err: unknown, url: URL): InventoryProviderError {
  const host = url.host || url.toString();
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new InventoryProviderError("network", `Connection to ${host} timed out.`);
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err as { code?: string }).code;
    if (code) {
      // A TLS verification failure gets the shared sentence naming the opt-in;
      // every other code keeps the wording it has always had.
      const certMessage = certificateFailureMessage(code, host, EVE_NG_CERT_HINT_CONTEXT);
      if (certMessage) {
        return new InventoryProviderError("network", certMessage);
      }
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
  // SESSION EXPIRY — the status line is not the whole answer. EVE-NG refuses an
  // unauthenticated request with HTTP 412 and says so only in the body (see
  // `envelopeSaysUnauthorized`), and reaching here means the silent re-login has
  // already had its one attempt. Reporting that as an unexplained `protocol`
  // failure at an odd status code sends the user looking at the wrong thing.
  const unauthorized = unauthorizedEnvelope(text);
  if (unauthorized) {
    throw new InventoryProviderError(
      "auth",
      `EVE-NG refused ${url} as unauthenticated (HTTP ${status}): ${str(unauthorized.message).slice(0, BODY_SLICE) || "no message"}`
    );
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

/**
 * EVE-NG'S ACTUAL SESSION-EXPIRY SIGNAL — reported from production (EVE-NG
 * 6.2.0-20 Professional, ~660 nodes). A crawl died partway through on:
 *
 *   HTTP 412 {"code":412,"status":"unauthorized",
 *             "message":"User is not authenticated or session timed out (90001)."}
 *
 * and the very next attempt succeeded, because it began with a fresh login. The
 * single silent re-login below was already there and is the right shape; what was
 * missing is that EVE-NG DOES NOT SAY 401 when a session ages out. It answers
 * 412 and puts the real answer in the JSend body.
 *
 * So the question is "does the ENVELOPE say unauthorized?" — never "is the status
 * 412?". 412 is a general precondition failure that EVE-NG also uses for ordinary
 * refusals, and blanket-retrying it would spend a login on a real error and then
 * report that same error one round trip later, no clearer than before.
 *
 * The sub-code is matched in its PARENTHESISED form only, so a message that
 * merely contains those digits (a node id, a byte count) is not read as an
 * expired session.
 */
const SESSION_EXPIRED_SUBCODE = /\(90001\)/;

function envelopeSaysUnauthorized(envelope: { code?: unknown; status?: unknown; message?: unknown }): boolean {
  // The status word EVE-NG actually sends, read the way every other envelope
  // field here is read — trimmed and case-folded, because it comes off the wire.
  if (str(envelope.status).toLowerCase() === "unauthorized") {
    return true;
  }
  // The IN-ENVELOPE status code, which some endpoints answer with on an HTTP 200
  // (M36). It lives in this one predicate so `unwrap` and the silent re-login ask
  // exactly the same question rather than two that can drift.
  if (envelope.code === 401 || envelope.code === 403) {
    return true;
  }
  return SESSION_EXPIRED_SUBCODE.test(str(envelope.message));
}

/**
 * The same question against a RAW body: the envelope when it parses as one and
 * says unauthorized, `undefined` otherwise — so the caller that needs the
 * message does not parse a second time.
 *
 * Deliberately NOT a substring search over the text: a proxy's HTML error page
 * is not an EVE-NG envelope whatever words it happens to contain, and treating
 * one as an expired session would burn a re-login on every such failure.
 */
function unauthorizedEnvelope(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isObject(parsed) && envelopeSaysUnauthorized(parsed) ? parsed : undefined;
}

/**
 * ONE decision, asked by BOTH `authedGet` and `authedRequest` — the two copies of
 * the silent re-login. Kept in one place because split across them, one would
 * eventually learn a signal the other did not, and Start/Stop would go on failing
 * on exactly the server whose sync had just been fixed.
 */
function isExpiredSessionResponse(status: number, text: string): boolean {
  return status === 401 || status === 403 || unauthorizedEnvelope(text) !== undefined;
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
  /**
   * WALL-CLOCK DEADLINE (task #30, P3-2) — set when the WALK itself tripped the
   * shared crawl deadline and already pushed its deadline warning. The node-fetch
   * loop reuses the same deadline, so it would otherwise re-observe the blown
   * budget and push a SECOND identical warning; it suppresses its own when this
   * is set, keeping one deadline warning per crawl.
   */
  deadlineHit: boolean;
}

type Edition = "community" | "pro" | "unknown";

/** MINOR-12 — a resource that 404'd (folder/lab deleted mid-walk), distinct from an empty one. */
const NOT_FOUND = Symbol("eve-ng-not-found");

class EveApiClient {
  private session?: string;
  // WALL-CLOCK DEADLINE (task #30, #84 P2-2) — the crawl's shared deadline, set
  // once per crawl. When present, every request's timeout is bounded by the
  // REMAINING budget (never past it), and the silent re-login on a 401 is skipped
  // once the deadline has passed. Absent for the non-crawl paths (testConnection),
  // which keep their own fixed timeouts.
  private crawlDeadline?: number;

  public constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string
  ) {}

  /** WALL-CLOCK DEADLINE (#84 P2-2) — arm the shared per-crawl deadline. */
  public setCrawlDeadline(deadline: number): void {
    this.crawlDeadline = deadline;
  }

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
    // WALL-CLOCK DEADLINE (#84 P2-2) — cap this request's timeout by the REMAINING
    // crawl budget, so a request issued just before the deadline (or a re-login
    // retry) can never run the full `timeoutMs` past it. The per-request
    // `timeoutMs` stays the ceiling when the deadline is far off (or absent, for
    // testConnection). The between-request checks trip the deadline before issuing
    // when the budget is already spent, so a >0 floor here is the near-boundary case.
    const effectiveTimeout =
      this.crawlDeadline !== undefined
        ? Math.min(timeoutMs, Math.max(0, this.crawlDeadline - Date.now()))
        : timeoutMs;
    try {
      // MINOR-5 — `redirect: "manual"` on every request. No EVE-NG endpoint
      // legitimately redirects; the default `"follow"` would let a 3xx from the
      // lab box carry the crawl (and, on 307/308, the login POST body — the
      // password) to another origin. A 3xx surfaces below as a non-2xx protocol
      // error instead.
      res = await this.fetchImpl(url.toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(effectiveTimeout) });
    } catch (err) {
      // WALL-CLOCK DEADLINE (#84 P2) — a request that STALLED until the crawl
      // deadline aborts exactly when the budget hit zero (its effective timeout
      // was the remaining budget). Distinguish that from a genuine per-request
      // network timeout (deadline still far off): an abort/timeout with the
      // deadline now passed is the crawl running out of time, not the server
      // being unreachable. Signal it as the truncation sentinel so the loops
      // return partial results + the deadline warning instead of failing the
      // whole crawl. A real timeout with the deadline far off still maps to
      // `network`.
      if (
        this.crawlDeadline !== undefined &&
        Date.now() >= this.crawlDeadline &&
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        throw new CrawlDeadlineExceeded();
      }
      throw mapNetworkError(err, url);
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      // WALL-CLOCK DEADLINE (#84 P2-2) — the BODY read can abort too: EVE may
      // send HEADERS before the deadline (so `fetch()` already resolved) then
      // STALL on the body, and the request's AbortSignal aborts `res.text()`.
      // Classify it the same way as the `fetch()` abort above — past the deadline
      // ⇒ the truncation sentinel, so the loops return partial results + the
      // deadline warning instead of swallowing to "" and having the parser throw
      // a `protocol` error that discards the whole crawl. Deadline far off ⇒ the
      // pre-existing tolerant empty-string behaviour (a truncated/garbled body is
      // not fatal on its own; the parser surfaces the real problem).
      if (this.crawlDeadline !== undefined && Date.now() >= this.crawlDeadline) {
        throw new CrawlDeadlineExceeded();
      }
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
    if (isExpiredSessionResponse(res.status, text)) {
      // WALL-CLOCK DEADLINE (#84 P2-2) — the silent re-login is TWO more requests
      // (login + retry). Once the crawl deadline has passed, skip it and surface
      // the 401: retrying would run the crawl a full re-login+retry past the
      // budget for a session that expired at the tail of an already-overlong
      // crawl. (When the deadline is merely NEAR, the retry still runs but each of
      // its requests is bounded by the remaining budget in `raw` above.)
      if (this.crawlDeadline !== undefined && Date.now() >= this.crawlDeadline) {
        return { status: res.status, text, url };
      }
      await this.login(timeoutMs);
      ({ res, text } = await send());
    }
    return { status: res.status, text, url };
  }

  /**
   * NODE CONTROL (Phase 4) — `authedGet` for an arbitrary METHOD (and optional
   * JSON body), so the Pro node-control path can issue a PUT. Mirrors
   * `authedGet` exactly: the `unetlab_session` cookie is attached by hand (undici
   * keeps no jar), a single silent re-login covers an expired session, and the
   * raw response is returned so the caller can `unwrap` it. A body is sent as
   * JSON with the matching Content-Type; omitting it sends no body (a bare GET).
   */
  public async authedRequest(method: string, path: string, body?: unknown, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<RawResponse> {
    const url = this.buildUrl(path);
    const send = async (): Promise<{ res: Response; text: string }> =>
      this.raw(
        url,
        {
          method,
          headers: {
            Cookie: `unetlab_session=${this.session ?? ""}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {})
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        },
        timeoutMs
      );

    let { res, text } = await send();
    if (isExpiredSessionResponse(res.status, text)) {
      // Same single-retry discipline as authedGet — one re-login, never a loop
      // against the lab server. (No crawl deadline is armed on the control path,
      // so the deadline short-circuit authedGet carries is simply inert here.)
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
  public async walkFolders(root: string, matchesFilter: (labPath: string) => boolean, timeoutMs: number, deadline: number): Promise<FolderWalkResult> {
    const labs: EveLab[] = [];
    const warnings: string[] = [];
    const visited = new Set<string>([root]);
    let queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
    let requests = 0;
    let truncated = false;
    let depthCapped = false;
    // WALL-CLOCK DEADLINE (task #30) — set when the crawl's shared time budget is
    // exhausted, alongside `budgetHit` (which stops both loops). Kept as its OWN
    // flag so the `if (budgetHit)` warning below can name the DEADLINE rather than
    // the request cap, which would otherwise misreport a slow crawl as a wide one.
    let deadlineHit = false;
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
        // WALL-CLOCK DEADLINE (task #30) — checked beside the request cap (both
        // loops terminate via `budgetHit`), so a crawl that is slow rather than
        // wide stops too. Checked BEFORE the listing request so a deadline already
        // passed does not fire one more slow fetch.
        if (Date.now() > deadline) {
          budgetHit = true;
          deadlineHit = true;
          break;
        }
        requests++;
        // WALL-CLOCK DEADLINE (#84 P2) — a listing that STALLED until the deadline
        // aborts as the truncation sentinel: stop the walk as TRUNCATED with the
        // labs collected so far, exactly like the between-request check above,
        // rather than failing the whole crawl. A real network error still throws.
        let listing: Awaited<ReturnType<typeof this.listFolder>>;
        try {
          listing = await this.listFolder(path, timeoutMs);
        } catch (err) {
          if (err instanceof CrawlDeadlineExceeded) {
            budgetHit = true;
            deadlineHit = true;
            break;
          }
          throw err;
        }
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
        deadlineHit
          ? `Stopped after ${Math.round(CRAWL_DEADLINE_MS / 1000)}s — the EVE-NG crawl exceeded its time limit and part of the folder tree was not scanned. Narrow the Root Folder.`
          : `Stopped after ${MAX_FOLDER_REQUESTS} folder listings — part of the EVE-NG folder tree was not scanned. Narrow the Root Folder.`
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
    return { labs, truncated, warnings, deadlineHit };
  }
}

/** 2xx + JSend `status: "success"`, or the mapped error for whatever went wrong. */
function unwrap(raw: RawResponse): unknown {
  if (raw.status < 200 || raw.status >= 300) {
    throwForStatus(raw.status, raw.text, raw.url);
  }
  const envelope = parseEnvelope(raw.text, raw.url);
  if (envelope.status !== "success") {
    // SESSION EXPIRY — the same predicate the silent re-login uses, so a 200 that
    // carries an unauthorized envelope is reported as `auth` rather than as a
    // malformed response.
    if (envelopeSaysUnauthorized(envelope)) {
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
): InventoryDevice {
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
    // No endpoint when the node has no usable telnet console — the sync engine
    // turns such a node into an addressless placeholder and reports it.
    endpoints: target ? [{ kind: "telnet", host: target.host, port: target.port }] : [],
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined
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

/**
 * INSECURE TLS — the two transports one provider instance holds, and the
 * decision between them.
 *
 * `standard` is the injected global `fetch`, untouched, and is what every
 * source has always used. `insecure` is the `node:https` adapter with
 * certificate verification off (`services/inventory/insecureFetch.ts`).
 */
export interface EveNgTransports {
  standard: typeof fetch;
  insecure: typeof fetch;
}

/**
 * BOTH conditions, ANDed, decided PER CONFIG rather than per provider — one
 * registry instance serves every EVE-NG source, so the choice cannot be baked
 * in at construction:
 *
 *  (a) the source explicitly opted in (`=== true`, never a truthiness test:
 *      the form stores a real boolean, and an absent field must read as off);
 *  (b) the URL is `https:` — relaxing certificate checks on plain http means
 *      nothing, and the adapter would refuse the URL outright, so an http
 *      source with the box ticked must keep working exactly as before.
 *
 * The scheme is read off `normalizeBaseUrl` + `new URL`, which lower-cases it,
 * rather than off the raw string: `HTTPS://…` is https.
 */
export function eveNgRunsWithoutCertificateVerification(config: InventorySourceValues): boolean {
  if (config.allowInsecureTls !== true) {
    return false;
  }
  try {
    return new URL(normalizeBaseUrl(String(config.baseUrl ?? ""))).protocol === "https:";
  } catch {
    // An unparseable base URL cannot be https. `buildUrl` reports it properly.
    return false;
  }
}

/**
 * ONE decision, asked twice: which transport to connect with, and whether the
 * sync has to disclose that it ran unverified (`EVE_NG_INSECURE_TLS_WARNING`).
 * Both read the predicate above rather than each re-deriving the conditions —
 * a disclosure that could disagree with the transport actually used would be
 * worse than none, and identity-comparing the returned transport cannot tell
 * the two apart when a caller injects the same function as both.
 */
export function selectEveNgTransport(transports: EveNgTransports, config: InventorySourceValues): typeof fetch {
  return eveNgRunsWithoutCertificateVerification(config) ? transports.insecure : transports.standard;
}

function makeClient(transports: EveNgTransports, config: InventorySourceValues, secrets: InventorySourceSecrets): EveApiClient {
  return new EveApiClient(
    selectEveNgTransport(transports, config),
    normalizeBaseUrl(String(config.baseUrl ?? "")),
    String(config.username ?? ""),
    secrets.password ?? ""
  );
}

async function fetchInventoryImpl(
  transports: EveNgTransports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryTree> {
  const client = makeClient(transports, config, secrets);
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
  // WALL-CLOCK DEADLINE (task #30) — one budget for the whole crawl, computed
  // before the folder walk and reused in the node-fetch loop below.
  const deadline = Date.now() + CRAWL_DEADLINE_MS;
  client.setCrawlDeadline(deadline); // #84 P2-2 — bound every crawl request by the remaining budget
  await client.login(FETCH_TIMEOUT_MS);

  // INSECURE TLS — this sync ran with certificate verification OFF, so it says
  // so, on the same channel and at the same moment as the Pro warning below.
  if (eveNgRunsWithoutCertificateVerification(config)) {
    warnings.push(EVE_NG_INSECURE_TLS_WARNING);
  }

  if ((await client.detectEdition(FETCH_TIMEOUT_MS)) === "pro") {
    warnings.push(EVE_NG_PRO_WARNING);
  }

  const walk = await client.walkFolders(root, (labPath) => !filter || labPath.toLowerCase().includes(filter), FETCH_TIMEOUT_MS, deadline);
  warnings.push(...walk.warnings);
  let truncated = walk.truncated;

  const devices: InventoryDevice[] = [];
  let goneLabs = 0;
  let nodesCapped = false;
  let deadlineHit = false;
  for (const lab of walk.labs) {
    if (nodesCapped || deadlineHit) break;
    // WALL-CLOCK DEADLINE (task #30) — the node-fetch phase shares the crawl's
    // budget, so a source whose LAB COUNT (not its folder tree) blows the time
    // limit is bounded too. Stops the per-lab loop and signals truncation.
    if (Date.now() > deadline) {
      deadlineHit = true;
      truncated = true;
      break;
    }
    // WALL-CLOCK DEADLINE (#84 P2) — a node fetch that STALLED until the deadline
    // aborts as the truncation sentinel: keep the devices collected so far and
    // stop the loop as TRUNCATED, rather than failing the whole crawl.
    let nodePairs: Awaited<ReturnType<typeof client.listNodes>>;
    try {
      nodePairs = await client.listNodes(lab.path, FETCH_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof CrawlDeadlineExceeded) {
        deadlineHit = true;
        truncated = true;
        break;
      }
      throw err;
    }
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
      // ONE ADDRESSLESS LINE (follow-up 1) — the endpoint-less nodes are pushed
      // and NOT counted here. This provider used to keep a `noConsoleCount` and
      // push its own aggregate ("N nodes have no telnet console URL … were
      // imported without a connection endpoint."), which overlapped the sync
      // engine's addressless line: one sync, two lines, intersecting sets of
      // nodes. The engine owns that disclosure now — it is the only layer that
      // knows whether each node became a placeholder this run or already was one.
      devices.push(mapNode(nodeId, raw, lab, rootPrefix, consoleHost, client.hostname));
    }
  }

  if (goneLabs > 0) {
    warnings.push(`${goneLabs} lab${goneLabs === 1 ? "" : "s"} ${goneLabs === 1 ? "was" : "were"} not found (removed during the scan) and skipped.`);
  }
  if (nodesCapped) {
    warnings.push(`Stopped after ${MAX_NODES} nodes — later labs' nodes were not imported. Narrow the Root Folder or the Lab Filter.`);
  }
  // P3-2 (review) — push the node-phase deadline warning ONLY when the walk did
  // not already name the deadline (the two share one budget, so a walk that
  // tripped it leaves the node loop re-observing the same blown deadline). One
  // deadline warning per crawl.
  if (deadlineHit && !walk.deadlineHit) {
    warnings.push(
      `Stopped after ${Math.round(CRAWL_DEADLINE_MS / 1000)}s — the EVE-NG crawl exceeded its time limit and later labs' nodes were not imported. Narrow the Root Folder or the Lab Filter.`
    );
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
  transports: EveNgTransports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryStatusReport> {
  const client = makeClient(transports, config, secrets);
  const root = normalizeFolderPath(String(config.rootFolder ?? "/"));
  if (hasDotSegment(root)) {
    throw new InventoryProviderError("protocol", `Root Folder "${root}" must not contain "." or ".." path segments.`);
  }
  const filter = str(config.filter).toLowerCase();
  const consoleHost = str(config.consoleHost);

  // WALL-CLOCK DEADLINE (task #30) — one budget for the whole crawl, shared with
  // the node-fetch loop below, exactly as fetchInventory does.
  const deadline = Date.now() + CRAWL_DEADLINE_MS;
  client.setCrawlDeadline(deadline); // #84 P2-2 — bound every crawl request by the remaining budget
  await client.login(FETCH_TIMEOUT_MS);
  const walk = await client.walkFolders(root, (labPath) => !filter || labPath.toLowerCase().includes(filter), FETCH_TIMEOUT_MS, deadline);

  const statuses: Record<string, InventoryDeviceStatus> = {};
  let nodeCount = 0;
  // TRUNCATION — a partial scan (the node cap here, the wall-clock deadline, or
  // the folder/lab/budget caps inside walkFolders) must be signalled, so
  // applyInventoryStatus MERGES this report rather than clearing the decorations
  // of nodes it never reached. Same idiom fetchInventory uses.
  let truncated = walk.truncated;
  let nodesCapped = false;
  let deadlineHit = false;
  for (const lab of walk.labs) {
    if (nodesCapped || deadlineHit) break;
    // WALL-CLOCK DEADLINE (task #30) — the node-fetch phase shares the crawl's
    // budget, so a source whose lab count blows the time limit is bounded too.
    if (Date.now() > deadline) {
      deadlineHit = true;
      truncated = true;
      break;
    }
    // WALL-CLOCK DEADLINE (#84 P2) — a node fetch that STALLED until the deadline
    // aborts as the truncation sentinel: keep the statuses collected so far and
    // stop as TRUNCATED (so applyInventoryStatus MERGES), not a failed poll.
    let nodePairs: Awaited<ReturnType<typeof client.listNodes>>;
    try {
      nodePairs = await client.listNodes(lab.path, FETCH_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof CrawlDeadlineExceeded) {
        deadlineHit = true;
        truncated = true;
        break;
      }
      throw err;
    }
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

/**
 * NODE CONTROL (Phase 4) — start or stop ONE lab node, keyed by the same
 * `${lab.path}#${nodeId}` externalId `fetchInventory`/`fetchStatus` use. Splits
 * on the LAST `#` (a lab path can legitimately contain `#`), validates both
 * halves, then dispatches by edition:
 *  - Community (CERTIFIED) and unknown (best-effort, the provider's convention):
 *    `GET /api/labs{labPath}/nodes/{nodeId}/{action}`.
 *  - Pro (PRELIMINARY, uncertified — Phase 3 certifies against a real Pro
 *    instance): the edition-aware evengsdk verbs — a PUT to the same node-action
 *    endpoint, with `stopmode: 3` in the body on stop (evengsdk's default stop
 *    mode). The Community path must NOT be blocked on getting the exact Pro shape
 *    right; this branch is deliberately marked preliminary.
 * Every response goes through `unwrap`, so a non-2xx or a JSend `status:"fail"`
 * (a refused start) surfaces as a mapped `InventoryProviderError` — the wrapper
 * (`controlProviderNode`) then PROPAGATES it to the user, unlike the status path.
 */
async function controlNodeImpl(
  transports: EveNgTransports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets,
  externalId: string,
  action: "start" | "stop"
): Promise<void> {
  const hashIndex = externalId.lastIndexOf("#");
  const labPath = hashIndex >= 0 ? externalId.slice(0, hashIndex) : "";
  const nodeId = hashIndex >= 0 ? externalId.slice(hashIndex + 1) : "";
  if (!labPath || !nodeId) {
    throw new InventoryProviderError(
      "protocol",
      `Malformed node id "${externalId}" — expected "<labPath>#<nodeId>".`
    );
  }

  const client = makeClient(transports, config, secrets);
  await client.login(FETCH_TIMEOUT_MS);
  const edition = await client.detectEdition(FETCH_TIMEOUT_MS);
  const nodeActionPath = `/api/labs${encodePath(labPath)}/nodes/${encodeURIComponent(nodeId)}/${action}`;

  if (edition === "pro") {
    // Pro (PRELIMINARY) — PUT the node-action endpoint, faithful to the
    // edition-aware evengsdk verbs; stop carries stopmode=3 (evengsdk's default).
    // Uncertified: Phase 3 validates the exact Pro shape against a real instance.
    const body = action === "stop" ? { stopmode: 3 } : {};
    unwrap(await client.authedRequest("PUT", nodeActionPath, body, FETCH_TIMEOUT_MS));
    return;
  }

  // Community (CERTIFIED) — and unknown edition, treated as Community best-effort.
  unwrap(await client.authedRequest("GET", nodeActionPath, undefined, FETCH_TIMEOUT_MS));
}

async function testConnectionImpl(transports: EveNgTransports, config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void> {
  const client = makeClient(transports, config, secrets);
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

/**
 * INSECURE TLS — the insecure transport is a SECOND injectable so a test can
 * assert which one a given config selects, rather than inferring it. Default
 * construction does no I/O and opens no socket, so building it eagerly here
 * costs nothing even for the (usual) source that never selects it.
 */
export function createEveNgProvider(
  fetchImpl: typeof fetch = fetch,
  insecureFetchImpl: typeof fetch = createInsecureHttpsFetch()
): InventoryProvider {
  const transports: EveNgTransports = { standard: fetchImpl, insecure: insecureFetchImpl };
  return {
    id: EVE_NG_PROVIDER_ID,
    label: "EVE-NG",
    configFields: EVE_NG_CONFIG_FIELDS,
    attributeKeys: ["lab", "template", "type", "console", "status", "image", "name"],
    instanceKey(config: InventorySourceValues): string | undefined {
      return eveNgInstanceKey(config);
    },
    testConnection(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void> {
      return testConnectionImpl(transports, config, secrets);
    },
    fetchInventory(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryTree> {
      return fetchInventoryImpl(transports, config, secrets);
    },
    fetchStatus(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryStatusReport> {
      return fetchStatusImpl(transports, config, secrets);
    },
    controlNode(
      config: InventorySourceValues,
      secrets: InventorySourceSecrets,
      externalId: string,
      action: "start" | "stop"
    ): Promise<void> {
      return controlNodeImpl(transports, config, secrets, externalId, action);
    }
  };
}
