import { ADVANCED_SECTION_LABEL } from "../../../ui/formTypes";
import { certificateFailureMessage, redirectNotFollowedMessage, type CertificateHintContext } from "../certificateHints";
import { createInsecureHttpsFetch } from "../insecureFetch";
import {
  InventoryProviderError,
  flattenProviderText,
  type InventoryConfigField,
  type InventoryDevice,
  type InventoryDeviceStatus,
  type InventoryProvider,
  type InventorySourceSecrets,
  type InventorySourceValues,
  type InventoryStatusReport,
  type InventoryTree
} from "../../../models/inventory";

export const GNS3_PROVIDER_ID = "gns3";

const FETCH_TIMEOUT_MS = 20_000;
const TEST_CONNECTION_TIMEOUT_MS = 10_000;

/** Hard caps. Every one of them sets `truncated` — see `crawlNodes`. */
const MAX_PROJECTS = 1_000;
const MAX_NODES = 10_000;

/**
 * WALL-CLOCK CRAWL DEADLINE — copied in shape from `eveNgProvider`, and it
 * earns its place here for a reason that provider does not have: a GNS3
 * controller answers `GET /projects/{id}/nodes` for a CLOSED project by reading
 * the project's `.gns3` file off disk, SYNCHRONOUSLY, on the event loop (2.2).
 * Most projects are closed most of the time, so the normal crawl is a run of
 * filesystem reads whose cost belongs to the server, not to us — the node caps
 * bound WORK, and only this bounds TIME. Trips `truncated` (a partial crawl, so
 * `applyInventoryStatus` MERGES rather than prunes) and pushes a deadline-named
 * warning. `Date.now()` is allowed here — only Workflow scripts forbid it.
 */
const CRAWL_DEADLINE_MS = 120_000;

/** Bound on an error message's echo of a response body — see `throwForStatus`. */
const BODY_SLICE = 200;

/**
 * INSECURE TLS — ONE definition of the option's name, used both as the config
 * field's label and inside the certificate-error hint that tells the user to go
 * turn it on. A message naming an option the form does not show is worse than
 * the bare OpenSSL code it replaced, so the two cannot be allowed to drift.
 */
const ALLOW_INSECURE_TLS_LABEL = "Allow a Self-Signed or Mismatched Certificate";

/**
 * INSECURE TLS — what a sync that RAN with certificate verification off says
 * about itself, on the `tree.warnings` channel. Same reasoning as EVE-NG's: the
 * opt-in is read once, at transport selection, and would otherwise never be
 * heard from again — so a source ticked for a lab box and later repointed at a
 * remote GNS3 keeps sending the password over an unauthenticated connection
 * with nothing on screen saying so.
 *
 * Names the option so it can be found and turned back off, and names the
 * password because that is the part the user is actually exposed on. On GNS3 3.x
 * the password is spent on a JWT login, so it crosses the wire in a request
 * BODY rather than in a header — no less exposed for it.
 */
export const GNS3_INSECURE_TLS_WARNING =
  `Certificate verification is off for this source (“${ALLOW_INSECURE_TLS_LABEL}”) — the connection is encrypted but unauthenticated, and the GNS3 password is sent over it.`;

/**
 * PER-SOURCE STATUS POLL — the field id, its bounds, and the ONE place a stored
 * value is turned into seconds. Mirrors `readEveNgStatusPollSeconds`, including
 * the part that matters: the function is deliberately TOTAL. Absent,
 * non-numeric, negative, fractional and out-of-range values all resolve to
 * something a timer can be armed with, because the form bounds the value on the
 * way IN but a source restored from a hand-edited backup never went through the
 * form — and an unclamped read there would arm a millisecond-period timer
 * against a lab controller (or a `NaN` period, which reports itself as running
 * and never fires).
 */
export const GNS3_STATUS_POLL_FIELD_ID = "statusPollSeconds";
export const GNS3_STATUS_POLL_MIN_SECONDS = 0;
export const GNS3_STATUS_POLL_MAX_SECONDS = 3600;

export function readGns3StatusPollSeconds(config: InventorySourceValues): number {
  const raw = config[GNS3_STATUS_POLL_FIELD_ID];
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    // Includes the ABSENT case (every source that predates the field) and a
    // numeric STRING, which the form never stores but a backup could carry.
    return GNS3_STATUS_POLL_MIN_SECONDS;
  }
  const clamped = Math.min(Math.max(raw, GNS3_STATUS_POLL_MIN_SECONDS), GNS3_STATUS_POLL_MAX_SECONDS);
  // Floor rather than round: a value between 0 and 1 must land on OFF, not on a
  // sub-second period, and no user typing "1.9" meant "poll twice as often".
  return Math.floor(clamped);
}

const GNS3_STATUS_POLL_DESCRIPTION =
  "How often, in seconds, to refresh this source's node running status while the Command Center is visible. 0 turns polling off for this source — use Refresh Inventory Status when you want it. Each poll re-reads every project, and a closed project's node list is served from disk by the controller, so a short interval on a server holding many projects makes real work for it.";

/**
 * THE CONFIG FIELD LIST IS PART OF THE PROVIDER FINGERPRINT
 * (`computeProviderFingerprint`, models/inventory.ts): its ids, labels, types,
 * required flags and ORDER are hashed and stamped onto every source at save
 * time. Changing this list is therefore a user-visible event for every existing
 * stamped GNS3 source, not a refactor — and a doubly visible one here, because
 * this provider implements `fetchStatus`, which is the half that goes quiet
 * instead of asking. THE ORDER IS APPEND-ONLY from the moment this ships: the
 * whole set of fields the provider will need is declared up front for exactly
 * that reason.
 */
const GNS3_CONFIG_FIELDS: InventoryConfigField[] = [
  {
    id: "baseUrl",
    label: "GNS3 Server URL",
    type: "string",
    required: true,
    placeholder: "http://gns3.local:3080",
    // Port 3080 is named because it is the default and is NOT the default a URL
    // without one implies (80): a user who types `http://gns3.local` reaches
    // nothing, and the failure is an opaque connection refusal.
    description:
      `The GNS3 controller's address, including its port — 3080 by default. A trailing slash, or a pasted “/v2” / “/v3” suffix, is fine. If it is https (GNS3's own certificate is normally self-signed), see “${ALLOW_INSECURE_TLS_LABEL}” under ${ADVANCED_SECTION_LABEL}.`
  },
  {
    id: "username",
    label: "Username",
    type: "string",
    required: false,
    placeholder: "admin",
    // OPTIONAL, and the asymmetry between the two API versions is the reason:
    // GNS3 2.2 ships with `auth=False` and accepts anonymous requests, while
    // 3.x requires a login for everything. Marking it required would refuse a
    // perfectly normal stock 2.2 server.
    description: "Leave empty for a GNS3 2.2 server with authentication disabled. GNS3 3.x always requires a username and password."
  },
  {
    id: "password",
    label: "Password",
    type: "password",
    required: false,
    description: "Stored in the OS credential vault, never in settings."
  },
  {
    // Deliberately id `filter` + `type: "string"`: that exact pair is what
    // attaches the shared saved-filter picker above the field
    // (`SAVED_FILTER_TARGET_FIELD_ID`, ui/formDefinitions.ts).
    id: "filter",
    label: "Project Filter",
    type: "string",
    required: false,
    placeholder: "acme",
    description: "Case-insensitive substring matched against each project's name. Empty imports every project."
  },
  {
    id: "consoleHost",
    label: "Console Host Override",
    type: "string",
    required: false,
    placeholder: "gns3.example.com",
    description: "Host to use for telnet consoles when GNS3 reports an address you cannot reach (NAT, port forwarding)."
  },
  {
    // INSECURE TLS — default OFF and behind the Advanced disclosure: it turns a
    // safety default off, so it must be a deliberate act rather than something a
    // user finds themselves next to while typing a base URL.
    id: "allowInsecureTls",
    label: ALLOW_INSECURE_TLS_LABEL,
    type: "boolean",
    required: false,
    defaultValue: false,
    advanced: true,
    description:
      "Connects over https without checking the server's certificate. The traffic is encrypted but unauthenticated, so anything on the network path can intercept it — including the GNS3 username and password, which are sent over that connection. Reasonable for a lab box on a network you trust; not for one reachable from outside it. Has no effect on an http base URL, which is not encrypted at all."
  },
  {
    // NO `defaultValue`: that member is boolean-only by contract
    // (`validateProviderShape` rejects a non-boolean), and it is not needed — an
    // absent value reads as 0 through `readGns3StatusPollSeconds`, which is the
    // OFF this ships with. Advanced, because turning it on starts unattended
    // requests against a lab server.
    id: GNS3_STATUS_POLL_FIELD_ID,
    label: "Node Status Poll Interval (seconds)",
    type: "number",
    required: false,
    advanced: true,
    min: GNS3_STATUS_POLL_MIN_SECONDS,
    max: GNS3_STATUS_POLL_MAX_SECONDS,
    // WHOLE SECONDS ONLY. `readGns3StatusPollSeconds` floors what it reads, so a
    // fraction is never the cadence that runs: 0.4 would be OFF and 1.9 would be
    // one second, both reported back by the form as the number the user typed.
    integer: true,
    placeholder: "0",
    description: GNS3_STATUS_POLL_DESCRIPTION
  }
];

// ---------------------------------------------------------------------------
// URL / config helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalizes the base URL into the exact string every request is built from,
 * so the fetch and `gns3InstanceKey` (which derives from this) cannot disagree:
 *  - QUERY, FRAGMENT and USERINFO are dropped (the URL is rebuilt from parts).
 *    A base URL pasted from a browser can carry `?foo=bar` / `#x`; appending
 *    `/v2/projects` to it would otherwise yield `http://gns3?foo=bar/v2/projects`,
 *    whose pathname is `/`.
 *  - the trailing slash and a pasted `/v2` or `/v3` SUFFIX are stripped, the
 *    same way `netboxProvider` strips `/api`: the version segment is chosen by
 *    the detection probe, so a base URL carrying one would double into
 *    `/v3/v3/projects` — and, worse, would PIN a 3.x-shaped URL onto a 2.2
 *    server the probe had just identified.
 *  - a real mount PATH (`http://gw/gns3a`, a reverse-proxy mount) is KEPT, with
 *    its case, since the deployment answers there.
 * An unparseable value (a scheme-less `gns3.local:3080`) is returned trimmed, so
 * `buildUrl` maps its `new URL` throw to a provider error at the boundary.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const parsed = parseHttpUrl(trimmed);
  if (!parsed) {
    return trimmed;
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v[23]$/i, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * `new URL` accepts far more than a fetchable address, and the shape it accepts
 * WRONGLY here is exactly the typo this field invites: `gns3.local:3080` parses
 * perfectly well, as the scheme `gns3.local:` with the opaque path `3080`. Left
 * to `new URL` alone, `${base}/v3/version` then builds a URL whose PATHNAME is
 * `/v3/version` and whose host is empty — a request that a permissive transport
 * can send somewhere the user never named, and an identity key
 * (`gns3.local://3080`) that no second source could ever match. So the scheme is
 * checked explicitly: only http and https are addresses this provider can use.
 */
function parseHttpUrl(raw: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
}

/**
 * This GNS3 deployment's identity — see `InventoryProvider.instanceKey`
 * (models/inventory.ts) for the contract, and `eveNgInstanceKey` /
 * `netboxInstanceKey` for the two references this mirrors.
 *
 * THE KEY DERIVES FROM EXACTLY THE STRING THE FETCH DERIVES FROM. Requests are
 * built as `new URL(`${baseUrl}/v3/...`)`, so a base URL carrying a mount path
 * (a reverse proxy fronting several controllers) issues every request under that
 * path — and the key MUST keep the path too, or two distinct working deployments
 * collapse onto one identity and source B can adopt, then its prune policy
 * delete, servers and credentials kept from source A on a different box.
 *
 * Canonicalization: scheme and host lower-cased (both case-insensitive per
 * RFC 3986, and `new URL` does it), a default port dropped, the path's trailing
 * slash removed but its case kept (a mount path is server-significant), and
 * userinfo/query/fragment stripped — userinfo because this key is PERSISTED on
 * every kept server and copied into backups, and `http://admin:pw@gns3` is a
 * credential typed into a non-secret field.
 *
 * `undefined` for anything `new URL` rejects (a scheme-less host is the common
 * typo, and on GNS3 it is a likely one because the address carries a port):
 * the fetch path builds its URLs from the same string, so a source whose base
 * URL cannot be parsed cannot sync at all and must not claim an identity.
 */
export function gns3InstanceKey(config: InventorySourceValues): string | undefined {
  const normalized = normalizeBaseUrl(String(config.baseUrl ?? ""));
  if (!normalized) {
    return undefined;
  }
  const parsed = parseHttpUrl(normalized);
  if (!parsed) {
    return undefined;
  }
  // `host` rather than `hostname` so a non-default port stays part of the
  // identity — on GNS3 that is the usual case, since 3080 is not any scheme's
  // default. The parser has already dropped a scheme's own default port.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
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
// Error mapping — mirrors eveNgProvider's / netboxProvider's
// mapNetworkError / throwForStatus / parseBodyOnce trio so every provider fails
// in the same vocabulary. The JSend envelope layer those two carry has NO
// counterpart here: GNS3 answers with plain JSON, and an error body is
// `{message, status}` (v2) or `{message}` (v3).
// ---------------------------------------------------------------------------

/**
 * WALL-CLOCK DEADLINE — the sentinel `raw()` throws when a request's abort was
 * caused by the CRAWL DEADLINE expiring mid-flight (as opposed to a genuine
 * per-request network timeout with the deadline still far off). The crawl loop
 * CATCHES it and terminates as TRUNCATED — returning the partial results
 * collected so far plus the deadline warning — rather than letting it propagate
 * as a `network` failure that discards the whole crawl. Not an
 * `InventoryProviderError`, so it can never be mistaken for a real fetch error
 * anywhere it might leak (a leak surfaces as a plain Error, loud, not a
 * misclassified network failure).
 */
class CrawlDeadlineExceeded extends Error {
  public constructor() {
    super("GNS3 crawl deadline exceeded");
    this.name = "CrawlDeadlineExceeded";
  }
}

/**
 * INSECURE TLS — what this provider contributes to the SHARED certificate-hint
 * sentence (`services/inventory/certificateHints.ts`).
 *
 * `selfSignedNote` earns its place for the same reason EVE-NG's does: GNS3
 * serves plain HTTP by default, and an install that has been switched to HTTPS
 * is essentially always carrying a certificate it generated itself — so saying
 * so tells the user this is the expected state of their own server rather than
 * something being wrong with it.
 */
const GNS3_CERT_HINT_CONTEXT: CertificateHintContext = {
  optionLabel: ALLOW_INSECURE_TLS_LABEL,
  sectionLabel: ADVANCED_SECTION_LABEL,
  // The clause the user is actually agreeing to; it must not be softened.
  exposureNoun: "the GNS3 password",
  selfSignedNote: ", which is the normal state of a GNS3 server switched to HTTPS"
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
      // every other code keeps the plain "could not reach" wording.
      const certMessage = certificateFailureMessage(code, host, GNS3_CERT_HINT_CONTEXT);
      if (certMessage) {
        return new InventoryProviderError("network", certMessage);
      }
      return new InventoryProviderError("network", `Could not reach ${host}: ${code}.`);
    }
    return new InventoryProviderError("network", `Could not reach ${host}: ${err.message}`);
  }
  return new InventoryProviderError("network", `Could not reach ${host}: ${String(err)}`);
}

/** A RESPONSE BODY, PARSED EXACTLY ONCE — see `parseBodyOnce`. */
type ParsedBody = { readonly json: unknown } | undefined;

/**
 * `JSON.parse` once, with failure reported as `undefined` rather than a throw.
 * The parse happens in `raw` and the value is carried on the response, so the
 * error mapper and the body reader never parse the same (potentially
 * multi-megabyte) node listing twice.
 */
function parseBodyOnce(text: string): ParsedBody {
  try {
    return { json: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * GNS3's error body, in both API versions: `{message, status}` on 2.2 and
 * `{message}` on 3.x. Returned bounded, and ONLY ever used to explain a
 * FAILURE — a success body is read by the callers, never by this.
 */
function errorDetail(parsed: ParsedBody, text: string): string {
  const json = parsed?.json;
  const message = isObject(json) ? str(json.message) : "";
  // FLATTENED HERE, at the boundary where server text ENTERS a sentence this
  // codebase composed (Codex P1, #146) — not at the three call sites that
  // interpolate the result, because a site that has to remember is a site that
  // will forget. A GNS3 controller, or a reverse proxy in front of one,
  // returns this body; a newline in it would mint a line in a notification
  // that reads like one of ours, and a bidi control would reorder the sentence
  // around it. The slice bounds length; this bounds shape.
  return flattenProviderText((message || text).slice(0, BODY_SLICE));
}

/**
 * The layering matches `eveNgProvider.throwForStatus`, minus the envelope rung
 * it does not have:
 *  1. 401/403 ⇒ `auth`. GNS3 uses 403 for BOTH a real permission failure and
 *     the `@open_required` refusal on a closed project, and the two are
 *     indistinguishable by status code — so the ONE caller that can tell them
 *     apart (`controlNodeImpl`, which knows the project's cached status) does
 *     the disambiguation itself before this is ever reached. Everything else
 *     genuinely is a credential problem.
 *  2. A 3xx is a DEAD END: every request is sent `redirect: "manual"`, and the
 *     body that would normally explain a failure is empty on a 3xx — so the
 *     shared sentence names the `Location`, which is the answer.
 *  3. Anything else ⇒ `protocol`, echoing the bounded `message`.
 */
function throwForStatus(status: number, text: string, parsed: ParsedBody, url: URL, location?: string): never {
  const detail = errorDetail(parsed, text) || "no message";
  if (status === 401 || status === 403) {
    throw new InventoryProviderError("auth", `GNS3 rejected the request (HTTP ${status}) at ${url}: ${detail}`);
  }
  if (status >= 300 && status < 400) {
    throw new InventoryProviderError(
      "protocol",
      `GNS3 request to ${url} failed with HTTP ${status}: ${redirectNotFollowedMessage(location)}`
    );
  }
  throw new InventoryProviderError("protocol", `GNS3 request to ${url} failed with HTTP ${status}: ${detail}`);
}

/**
 * One response header, or `undefined`. Defensive about `headers` because the
 * injected `fetch` is a seam: a Response-alike that answers no headers must not
 * throw here, least of all on the error path.
 */
function readHeader(res: Response, name: string): string | undefined {
  const headers = res.headers as unknown as { get?: (name: string) => string | null } | undefined;
  const value = typeof headers?.get === "function" ? headers.get(name) : null;
  return value ?? undefined;
}

interface RawResponse {
  status: number;
  text: string;
  parsed: ParsedBody;
  url: URL;
  location?: string;
}

// ---------------------------------------------------------------------------
// Console address resolution
// ---------------------------------------------------------------------------

/**
 * Copied from `eveNgProvider`'s module-private `isHostLocalOnly`, following the
 * precedent set by `proxmoxProvider`'s copy of `renderFolderTemplate`: providers
 * do not import each other, because a shared helper reached across two provider
 * modules makes one provider's bug fix silently change the other's behaviour on
 * a different vendor's data. The semantics are identical and deliberately so.
 *
 * A console address that is only meaningful ON the GNS3 host. Keeping it would
 * point every console at the USER'S OWN machine, where the connection either
 * fails opaquely or — worse — succeeds against something unrelated that happens
 * to be listening. `0.0.0.0` is not a corner case here: it is what essentially
 * every default GNS3 install reports as `console_host`.
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
 * Adapted from `eveNgProvider`'s module-private `resolveTelnetTarget` (copied,
 * not imported — same reasoning as `isHostLocalOnly` above). GNS3 reports the
 * console as three separate fields rather than as one `telnet://` URL, so there
 * is no URL to parse; what carries over unchanged is the DECISION ORDER, which
 * is the part that must not drift between the sync and the status refresh:
 * override wins over the reported host, and a host that is only meaningful on
 * the server is replaced by the server's own hostname.
 *
 * `undefined` — therefore an ADDRESSLESS placeholder device, which is existing
 * provider-neutral behaviour — when the node has no telnet console: a VNC, HTTP
 * or SPICE console, a console type GNS3 grows later that we do not know
 * (`console_type` is treated as an OPEN enum), `console_type: "none"`, or a null
 * console port.
 *
 * ONE DIVERGENCE FROM THE EVE-NG ORIGINAL, and it is load-bearing: an EMPTY
 * reported host is treated as local-only (⇒ substitute) rather than as
 * "unknown ⇒ no endpoint". On EVE-NG an empty host meant a malformed console
 * URL, where minting an endpoint would invent an address. On GNS3 it is the
 * DOCUMENTED shape of a closed project's node payload — the topology dump omits
 * `console_host` entirely — and most projects are closed most of the time. The
 * console still belongs to the server we are talking to, so dropping the
 * endpoint would downgrade every node of every closed project to addressless,
 * which is an ACTIVE downgrade in `computeSyncPlan`: it clears a working owned
 * server's host and port.
 */
function resolveTelnetTarget(
  consoleType: string,
  consolePort: unknown,
  reportedHost: string,
  consoleHostOverride: string,
  baseHostname: string
): TelnetTarget | undefined {
  if (consoleType.toLowerCase() !== "telnet") {
    return undefined;
  }
  // `console` is `int | null`; null means "no console port allocated".
  if (typeof consolePort !== "number" || !Number.isInteger(consolePort) || consolePort <= 0 || consolePort > 65_535) {
    return undefined;
  }
  const reported = reportedHost.replace(/^\[|\]$/g, "");
  // The override wins over BOTH the reported host and the base URL host: it
  // exists for the NAT case, where neither of those is reachable from here.
  const host = consoleHostOverride || (isHostLocalOnly(reported) ? baseHostname : reported);
  if (!host) {
    return undefined;
  }
  return { host, port: consolePort };
}

// ---------------------------------------------------------------------------
// The version seam
// ---------------------------------------------------------------------------

/**
 * WHICH API THIS CONTROLLER SPEAKS. The two versions differ in three ways and
 * only three, which is why a thin seam rather than two clients is enough:
 *  - the path prefix (`/v2` vs `/v3`);
 *  - authentication (optional HTTP Basic vs mandatory JWT);
 *  - the start/stop response (200 + node vs 204 + a REQUIRED `{}` request body).
 * Everything else — the project list, the node list, the field names, the error
 * body — is the same on both.
 */
export type Gns3ApiVersion = "v2" | "v3";

/** GNS3 3.x's login endpoint. Note the `/access` segment: it is easy to lose. */
const V3_AUTH_PATH = "/v3/access/users/authenticate";

interface Gns3Project {
  id: string;
  /** Display name, falling back to the id so a folder is never named "". */
  name: string;
  /**
   * `status === "opened"`. Anything else — `"closed"`, or a value this client
   * does not recognise — reads as NOT open, which is the conservative direction:
   * a node we cannot confirm is in an opened project is never claimed running,
   * and the single-node routes we would refuse to call are refused.
   */
  opened: boolean;
}

class Gns3ApiClient {
  private apiVersion?: Gns3ApiVersion;
  private token?: string;
  // The crawl's shared deadline, set once per crawl. When present, every
  // request's timeout is bounded by the REMAINING budget (never past it), and
  // the silent JWT re-login is skipped once the deadline has passed. Absent for
  // the non-crawl paths (testConnection, controlNode), which keep fixed timeouts.
  private crawlDeadline?: number;

  public constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string
  ) {}

  public setCrawlDeadline(deadline: number): void {
    this.crawlDeadline = deadline;
  }

  /**
   * The host requests fall back to when GNS3 reports a console on `0.0.0.0`.
   * Brackets stripped so an IPv6 base URL (`http://[::1]:3080`) yields `::1`, an
   * address the telnet transport's `net.connect` can dial; `URL.hostname` keeps
   * the brackets, and the reported-host side strips them too, so both agree.
   */
  public get hostname(): string {
    try {
      return new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return "";
    }
  }

  /** The version this client connected as — only defined after `connect`. */
  public get version(): Gns3ApiVersion | undefined {
    return this.apiVersion;
  }

  /**
   * Build a request URL, mapping `new URL`'s `TypeError` (a scheme-less base URL
   * is the common typo, and on GNS3 a likely one because the address carries a
   * port) into a provider error at the client boundary instead of letting a raw
   * `TypeError: Invalid URL` escape `fetchInventory`.
   */
  private buildUrl(path: string): URL {
    // The BASE is validated (scheme included — see `parseHttpUrl`) before the
    // request URL is built, so a `gns3.local:3080` typo is reported here rather
    // than silently producing a host-less URL the transport may still send.
    if (parseHttpUrl(this.baseUrl)) {
      try {
        return new URL(`${this.baseUrl}${path}`);
      } catch {
        // Falls through to the same message: whatever the concatenation
        // produced, it is not an address.
      }
    }
    throw new InventoryProviderError(
      "network",
      `The GNS3 server URL "${this.baseUrl}" is not a valid URL — include http:// or https://.`
    );
  }

  private async raw(url: URL, init: RequestInit, timeoutMs: number): Promise<{ res: Response; text: string; parsed: ParsedBody }> {
    let res: Response;
    // Cap this request's timeout by the REMAINING crawl budget, so a request
    // issued just before the deadline (or a re-login retry) can never run the
    // full `timeoutMs` past it. The between-request checks trip the deadline
    // before issuing when the budget is already spent, so a >0 floor here is the
    // near-boundary case.
    const effectiveTimeout =
      this.crawlDeadline !== undefined ? Math.min(timeoutMs, Math.max(0, this.crawlDeadline - Date.now())) : timeoutMs;
    try {
      // `redirect: "manual"` on EVERY request. No GNS3 endpoint legitimately
      // redirects; the default `"follow"` would let a 3xx from the controller
      // carry the crawl — and, on 307/308, the login POST body, i.e. the
      // password — to another origin. A 3xx surfaces below as a protocol error
      // instead. It is also the ONLY redirect mode `createInsecureHttpsFetch`
      // accepts, so an opted-in source would otherwise fail inside the adapter.
      res = await this.fetchImpl(url.toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(effectiveTimeout) });
    } catch (err) {
      // A request that STALLED until the crawl deadline aborts exactly when the
      // budget hit zero (its effective timeout WAS the remaining budget).
      // Distinguish that from a genuine per-request network timeout with the
      // deadline still far off: the first is the crawl running out of time (⇒
      // truncate), the second is the server being unreachable (⇒ fail).
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
      // The BODY read can abort too: the controller may send HEADERS before the
      // deadline (so `fetch()` already resolved) then STALL on the body — which
      // is exactly the shape of a 2.2 controller blocking on a closed project's
      // on-disk topology. Classify it the same way as the `fetch()` abort above.
      if (this.crawlDeadline !== undefined && Date.now() >= this.crawlDeadline) {
        throw new CrawlDeadlineExceeded();
      }
      text = "";
    }
    // THE ONE PARSE. Everything downstream reads this value.
    return { res, text, parsed: parseBodyOnce(text) };
  }

  /**
   * Identify the API version, then authenticate. CACHED PER CLIENT — one client
   * is built per operation (`fetchInventory`, `fetchStatus`, `controlNode`,
   * `testConnection`), so detection costs at most one extra round trip per
   * operation and NEVER one per request.
   */
  public async connect(timeoutMs: number): Promise<Gns3ApiVersion> {
    if (this.apiVersion === undefined) {
      this.apiVersion = await this.detectApiVersion(timeoutMs);
    }
    await this.authenticate(timeoutMs);
    return this.apiVersion;
  }

  /**
   * `GET /v3/version` first, because a 3.x controller does NOT serve `/v2` at
   * all and probing the other way round would misidentify it.
   *
   *  - 200 on `/v3/version` ⇒ v3.
   *  - 401 on `/v3/version` ⇒ v3 as well: the route EXISTS and is asking for a
   *    token, which a 2.2 controller (no such path) would never do. GNS3 3.0.5
   *    serves `/v3/version` unauthenticated, so this is a defensive reading
   *    rather than an observed one — but the alternative, falling through to the
   *    v2 probe, ends in "could not identify" on a server we had just
   *    identified.
   *  - anything else ⇒ probe `GET /v2/version`, where BOTH 200 and
   *    401-with-`WWW-Authenticate: Basic` identify v2. The 401 case is not a
   *    nicety: GNS3 2.2 with `auth=True` answers 401 to EVERY request including
   *    this one, so a 200-only rule would refuse to talk to an authenticated 2.2
   *    server at all.
   *
   * A server that identifies as neither fails with BOTH probe results in the
   * message — "could not identify" with no evidence is the least useful sentence
   * this provider could produce.
   */
  private async detectApiVersion(timeoutMs: number): Promise<Gns3ApiVersion> {
    const v3Url = this.buildUrl("/v3/version");
    const v3 = await this.raw(v3Url, { headers: { Accept: "application/json" } }, timeoutMs);
    if (v3.res.status === 200 || v3.res.status === 401) {
      return "v3";
    }
    const v2Url = this.buildUrl("/v2/version");
    const v2 = await this.raw(v2Url, { headers: { Accept: "application/json" } }, timeoutMs);
    if (v2.res.status === 200) {
      return "v2";
    }
    if (v2.res.status === 401 && /basic/i.test(readHeader(v2.res, "www-authenticate") ?? "")) {
      return "v2";
    }
    throw new InventoryProviderError(
      "protocol",
      `${this.baseUrl} did not answer as a GNS3 controller — ${v3Url.pathname} returned HTTP ${v3.res.status} and ${v2Url.pathname} returned HTTP ${v2.res.status}. Check the server URL and its port (3080 by default).`
    );
  }

  /**
   * v2: NOTHING TO DO. Authentication there is optional HTTP Basic against a
   * single server-wide user, and Basic carries no session — the header is
   * attached per request by `authHeaders`, so there is nothing to establish and
   * nothing to expire.
   *
   * v3: mandatory JWT. `POST /v3/access/users/authenticate` with a JSON body
   * returns `{access_token, token_type}`; the token is held IN MEMORY ONLY and
   * never persisted — it is a bearer credential with a 24h default lifetime, and
   * 3.0.5 exposes NO refresh endpoint, so the only correct response to an
   * expired one is to log in again (see `request`). Deliberately no clock
   * arithmetic on the expiry: the token's lifetime is the server's business, the
   * client's clock is not necessarily the server's, and a 401 is the only
   * authority on whether a token still works.
   */
  private async authenticate(timeoutMs: number): Promise<void> {
    if (this.apiVersion !== "v3") {
      return;
    }
    if (!this.username) {
      throw new InventoryProviderError(
        "auth",
        "This is a GNS3 3.x server, which requires a username and password. Add them to this source."
      );
    }
    const url = this.buildUrl(V3_AUTH_PATH);
    const { res, text, parsed } = await this.raw(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: this.username, password: this.password })
      },
      timeoutMs
    );
    if (res.status < 200 || res.status >= 300) {
      if (res.status === 401 || res.status === 403) {
        throw new InventoryProviderError(
          "auth",
          `GNS3 rejected the credentials for "${this.username}" (HTTP ${res.status}): ${errorDetail(parsed, text) || "no message"}`
        );
      }
      throwForStatus(res.status, text, parsed, url, readHeader(res, "location"));
    }
    const token = isObject(parsed?.json) ? (parsed as { json: Record<string, unknown> }).json.access_token : undefined;
    if (!isString(token) || token.length === 0) {
      // Carrying on without a token produces a 401 on the very next call, which
      // would be reported as a wrong password — pointing the user at a
      // credential that is in fact correct.
      throw new InventoryProviderError(
        "protocol",
        `GNS3 accepted the login at ${url} but returned no access_token — a proxy in front of it may be rewriting the response.`
      );
    }
    this.token = token;
  }

  private authHeaders(): Record<string, string> {
    if (this.apiVersion === "v3") {
      return this.token ? { Authorization: `Bearer ${this.token}` } : {};
    }
    // v2 — optional HTTP Basic, a single server-wide account. Sent only when the
    // source carries a username, because a stock 2.2 server runs with
    // `auth=False` and an empty-username header would be a credential of its own.
    if (!this.username) {
      return {};
    }
    return { Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}` };
  }

  /**
   * One request against the version-prefixed API, with the single silent
   * re-login a JWT makes necessary. Exactly ONE retry — a wrong password must
   * not become an unbounded login loop against the lab server — and only on v3,
   * because Basic has no session to renew: replaying it would send the same
   * rejected header a second time.
   *
   * Returns the raw response rather than throwing on a non-2xx, because callers
   * have to tell a 404 (a project deleted mid-crawl — skip it) and a 403 (which
   * on GNS3 may be the closed-project refusal) from every other failure.
   */
  public async request(method: string, path: string, body: unknown, timeoutMs: number): Promise<RawResponse> {
    const url = this.buildUrl(`/${this.apiVersion ?? "v2"}${path}`);
    const send = async (): Promise<{ res: Response; text: string; parsed: ParsedBody }> =>
      this.raw(
        url,
        {
          method,
          headers: {
            Accept: "application/json",
            ...this.authHeaders(),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {})
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        },
        timeoutMs
      );

    let { res, text, parsed } = await send();
    if (res.status === 401 && this.apiVersion === "v3" && this.username) {
      // The JWT aged out mid-crawl (24h default, no refresh endpoint). Skip the
      // re-login once the crawl deadline has passed: two more requests for a
      // token that expired at the tail of an already-overlong crawl is time the
      // budget does not have, and the 401 surfaces instead.
      if (this.crawlDeadline === undefined || Date.now() < this.crawlDeadline) {
        this.token = undefined;
        await this.authenticate(timeoutMs);
        ({ res, text, parsed } = await send());
      }
    }
    return { status: res.status, text, parsed, url, location: readHeader(res, "location") };
  }

  /** `request` plus the 2xx check — the normal read path. */
  public async getJson(path: string, timeoutMs: number): Promise<unknown> {
    const raw = await this.request("GET", path, undefined, timeoutMs);
    if (raw.status < 200 || raw.status >= 300) {
      throwForStatus(raw.status, raw.text, raw.parsed, raw.url, raw.location);
    }
    return raw.parsed?.json;
  }

  /**
   * `GET /projects` — a FLAT array; GNS3 has no project folders and no
   * pagination, so there is no tree to walk and no cursor to follow.
   *
   * THE SHAPE IS STRICT, and the asymmetry with the per-field leniency further
   * down is the point: malformed data FAILS the sync, missing data TRUNCATES it.
   * Coercing a non-array body (a proxy's HTML error page, a 200 carrying an
   * error object) into an empty project list would make the whole inventory look
   * empty, and `computeSyncPlan` would then prune every server this source owns
   * — and its stored credentials — over one bad response.
   */
  public async listProjects(timeoutMs: number): Promise<Gns3Project[]> {
    const data = await this.getJson("/projects", timeoutMs);
    if (!Array.isArray(data)) {
      throw new InventoryProviderError(
        "protocol",
        "GNS3 returned a malformed project list — expected an array. Failing the sync rather than risk pruning every device."
      );
    }
    const projects: Gns3Project[] = [];
    for (const raw of data) {
      if (!isObject(raw)) {
        throw new InventoryProviderError(
          "protocol",
          "GNS3 returned a malformed project entry (not an object). Failing the sync rather than risk pruning that project's servers."
        );
      }
      const id = str(raw.project_id);
      if (!id) {
        // A project with no id cannot be enumerated — there is no request we
        // could make for its nodes — so there is no safe placeholder either.
        // Skipping it would omit an UNKNOWN number of real servers while leaving
        // the crawl non-truncated, and every one of them would be pruned.
        throw new InventoryProviderError(
          "protocol",
          "GNS3 returned a project entry with no project_id. Failing the sync rather than risk pruning that project's servers."
        );
      }
      projects.push({ id, name: str(raw.name) || id, opened: str(raw.status).toLowerCase() === "opened" });
    }
    return projects;
  }

  /**
   * `GET /projects/{id}/nodes` — and it answers 200 FOR A CLOSED PROJECT TOO,
   * deliberately, by reading the project's on-disk topology. That is why the
   * crawl visits every project rather than only the opened ones: a GNS3 server's
   * projects are closed most of the time, and skipping them would import
   * nothing on a typical install (and prune everything on the second sync).
   *
   * What the closed payload OMITS is `console_host` and `status`; `console` (the
   * port) is present but is a PERSISTED HINT the server may reallocate when the
   * project is next opened. Both are handled by the mapper, not here.
   *
   * `undefined` when the project 404s — deleted between the listing that named
   * it and this fetch, which a live server does routinely. Every other failure
   * still throws.
   */
  public async listNodes(projectId: string, timeoutMs: number): Promise<Record<string, unknown>[] | undefined> {
    const raw = await this.request("GET", `/projects/${encodeURIComponent(projectId)}/nodes`, undefined, timeoutMs);
    if (raw.status === 404) {
      return undefined;
    }
    if (raw.status < 200 || raw.status >= 300) {
      throwForStatus(raw.status, raw.text, raw.parsed, raw.url, raw.location);
    }
    const data = raw.parsed?.json;
    if (!Array.isArray(data)) {
      throw new InventoryProviderError(
        "protocol",
        `GNS3 returned a malformed node list for project ${projectId} — expected an array. Failing the sync rather than risk pruning that project's servers.`
      );
    }
    const nodes: Record<string, unknown>[] = [];
    for (const node of data) {
      // A node VALUE that is not an object, or one with no `node_id`, FAILS the
      // sync. It used to be tempting to skip such a node for prune-protection,
      // but an endpoint-less device is an ADDRESSLESS placeholder — an ACTIVE
      // downgrade in `computeSyncPlan` that clears a working owned server's host
      // and port — and a node with no id cannot even be identified. Failing
      // closed protects the profile instead.
      if (!isObject(node)) {
        throw new InventoryProviderError(
          "protocol",
          `GNS3 returned a malformed node in project ${projectId} (not an object). Failing the sync rather than downgrade the node's server over corrupt data.`
        );
      }
      if (!str(node.node_id)) {
        throw new InventoryProviderError(
          "protocol",
          `GNS3 returned a node with no node_id in project ${projectId}. Failing the sync rather than risk pruning that node's server.`
        );
      }
      nodes.push(node);
    }
    return nodes;
  }
}

// ---------------------------------------------------------------------------
// Identity and mapping
// ---------------------------------------------------------------------------

/**
 * The device identity for one node — `<project_id>#<node_id>`, both UUIDs — in
 * ONE place, because `mapNode` (which stamps it onto the device), the status
 * loops (which key their reports by it) and `parseExternalId` (which takes it
 * apart again for Start/Stop) must agree exactly.
 *
 * BOTH HALVES ARE GNS3'S OWN UUIDs, which is the good case EVE-NG does not get:
 * renaming or moving a project does NOT reidentify its nodes, so a rename costs
 * the user nothing. `#` cannot occur in a UUID, but the parse still splits on
 * the LAST one rather than the first, so a server that ever widens either id
 * degrades to a wrong-id error instead of silently addressing another node.
 */
function nodeExternalId(projectId: string, nodeId: string): string {
  return `${projectId}#${nodeId}`;
}

function parseExternalId(externalId: string): { projectId: string; nodeId: string } | undefined {
  const hashIndex = externalId.lastIndexOf("#");
  if (hashIndex <= 0) {
    return undefined;
  }
  const projectId = externalId.slice(0, hashIndex);
  const nodeId = externalId.slice(hashIndex + 1);
  return projectId && nodeId ? { projectId, nodeId } : undefined;
}

/**
 * THE BINARY FOLD. `InventoryDeviceStatus.state` is `running | stopped` and has
 * no third value, so GNS3's three node states collapse: `started` ⇒ running,
 * `stopped` AND `suspended` ⇒ stopped. A suspended node is paused, not gone —
 * calling it "running" would light a green dot on a node that answers nothing,
 * so the contract's honest reading of it is stopped.
 *
 * A CLOSED PROJECT SHORT-CIRCUITS THE WHOLE QUESTION: nothing runs in a project
 * the controller has not opened, so every one of its nodes is `stopped` —
 * derived from the PROJECT, never left "unknown", and never read off the node.
 * The closed payload is a topology dump from disk, and its `status` (when one is
 * there at all) is whatever was last written to the `.gns3` file, which may say
 * `started` about a node that has not existed as a process since the project was
 * closed.
 */
function nodeState(project: Gns3Project, node: Record<string, unknown>): "running" | "stopped" {
  if (!project.opened) {
    return "stopped";
  }
  return str(node.status).toLowerCase() === "started" ? "running" : "stopped";
}

function mapNode(
  project: Gns3Project,
  node: Record<string, unknown>,
  consoleHostOverride: string,
  baseHostname: string
): InventoryDevice {
  const nodeId = str(node.node_id);
  // NEVER DROPPED for a cosmetic data problem: a dropped device reads as
  // "deleted at the source" and the source's prune policy acts on the server.
  // An unnamed node is a naming problem, not a missing device.
  const name = str(node.name) || `node-${nodeId}`;
  const consoleType = str(node.console_type);
  const target = resolveTelnetTarget(consoleType, node.console, str(node.console_host), consoleHostOverride, baseHostname);
  const state = nodeState(project, node);

  const attributes: Record<string, string> = {};
  const put = (key: string, value: string): void => {
    if (value) {
      attributes[key] = value;
    }
  };
  put("project", project.name);
  put("type", str(node.node_type));
  put("console", consoleType);
  put("status", state);
  put("compute", str(node.compute_id));
  put("name", name);

  return {
    externalId: nodeExternalId(project.id, nodeId),
    name,
    // FLAT, one segment: GNS3 has no project folders, so the project name is the
    // entire hierarchy there is.
    folderPath: project.name,
    // No endpoint when the node has no usable telnet console — the sync engine
    // turns such a node into an addressless placeholder and reports it.
    endpoints: target ? [{ kind: "telnet" as const, host: target.host, port: target.port }] : [],
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined
  };
}

// ---------------------------------------------------------------------------
// The crawl, shared by fetchInventory and fetchStatus
// ---------------------------------------------------------------------------

interface CrawlOutcome {
  truncated: boolean;
  warnings: string[];
}

/**
 * ONE crawl for both entry points, so the sync and the status refresh can never
 * disagree about which projects and nodes exist. `visit` is called once per raw
 * node, in server order, and the caller decides what to build from it.
 *
 * DELIBERATELY SERIAL. A closed project's node read is served by the controller
 * from disk, synchronously, on its event loop (2.2) — so a fan-out across
 * projects does not parallelise anything, it just queues work in front of every
 * other client of that controller, the GNS3 GUI included. Serial keeps the
 * server responsive; the wall-clock deadline, not concurrency, is what bounds
 * the crawl.
 *
 * NO PROJECT IS EVER OPENED OR CLOSED. `POST /projects/{id}/open` boots the
 * whole lab (`auto_start` defaults to true), rewrites the user's `.gns3` on
 * disk, reallocates console ports and broadcasts the change to every other
 * connected GNS3 client. A read-only sync that does that is not a read-only
 * sync. The crawl issues GETs and nothing else.
 */
async function crawlNodes(
  client: Gns3ApiClient,
  filter: string,
  deadline: number,
  visit: (project: Gns3Project, node: Record<string, unknown>) => void
): Promise<CrawlOutcome> {
  const warnings: string[] = [];
  let truncated = false;

  const all = await client.listProjects(FETCH_TIMEOUT_MS);
  const matching = all.filter((project) => !filter || project.name.toLowerCase().includes(filter));
  const projects = matching.slice(0, MAX_PROJECTS);
  if (matching.length > projects.length) {
    truncated = true;
    warnings.push(
      `Stopped after ${MAX_PROJECTS} projects — later projects on this server were not scanned. Narrow the Project Filter.`
    );
  }

  let nodeCount = 0;
  let nodesCapped = false;
  let deadlineHit = false;
  let goneProjects = 0;
  for (const project of projects) {
    if (nodesCapped || deadlineHit) {
      break;
    }
    // Checked BEFORE the request so a deadline already passed does not fire one
    // more slow fetch at a controller that is evidently struggling.
    if (Date.now() > deadline) {
      deadlineHit = true;
      truncated = true;
      break;
    }
    let nodes: Record<string, unknown>[] | undefined;
    try {
      nodes = await client.listNodes(project.id, FETCH_TIMEOUT_MS);
    } catch (err) {
      // A node fetch that STALLED until the deadline: keep everything collected
      // so far and stop as TRUNCATED, rather than failing the whole crawl. A
      // real network error still throws.
      if (err instanceof CrawlDeadlineExceeded) {
        deadlineHit = true;
        truncated = true;
        break;
      }
      throw err;
    }
    if (nodes === undefined) {
      // Deleted between the project listing that named it and this fetch — skip
      // it with an aggregate warning rather than aborting a sync over one gone
      // project. TRUNCATED, because its nodes were never seen: absence here must
      // not read as "these devices no longer exist".
      goneProjects++;
      truncated = true;
      continue;
    }
    for (const node of nodes) {
      if (nodeCount >= MAX_NODES) {
        nodesCapped = true;
        truncated = true;
        break;
      }
      nodeCount++;
      visit(project, node);
    }
  }

  if (goneProjects > 0) {
    warnings.push(
      `${goneProjects} project${goneProjects === 1 ? "" : "s"} ${goneProjects === 1 ? "was" : "were"} not found (removed during the scan) and skipped.`
    );
  }
  if (nodesCapped) {
    warnings.push(`Stopped after ${MAX_NODES} nodes — later projects' nodes were not imported. Narrow the Project Filter.`);
  }
  if (deadlineHit) {
    warnings.push(
      `Stopped after ${Math.round(CRAWL_DEADLINE_MS / 1000)}s — the GNS3 crawl exceeded its time limit and later projects were not scanned. Narrow the Project Filter.`
    );
  }
  return { truncated, warnings };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * INSECURE TLS — the two transports one provider instance holds, and the
 * decision between them. `standard` is the injected global `fetch`, untouched;
 * `insecure` is the `node:https` adapter with certificate verification off
 * (`services/inventory/insecureFetch.ts`).
 */
export interface Gns3Transports {
  standard: typeof fetch;
  insecure: typeof fetch;
}

/**
 * BOTH conditions, ANDed, decided PER CONFIG rather than per provider — one
 * registry instance serves every GNS3 source, so the choice cannot be baked in
 * at construction:
 *
 *  (a) the source explicitly opted in (`=== true`, never a truthiness test: the
 *      form stores a real boolean, and an absent field must read as off);
 *  (b) the URL is `https:` — relaxing certificate checks on plain http means
 *      nothing, and the adapter would refuse the URL outright. GNS3's default is
 *      plain HTTP, so this branch carries most real sources.
 *
 * The scheme is read off `normalizeBaseUrl` + `new URL`, which lower-cases it,
 * rather than off the raw string: `HTTPS://…` is https.
 */
export function gns3RunsWithoutCertificateVerification(config: InventorySourceValues): boolean {
  if (config.allowInsecureTls !== true) {
    return false;
  }
  // An unparseable (or non-http) base URL cannot be https; `buildUrl` reports it
  // properly, and until then the SAFE transport is the verifying one.
  return parseHttpUrl(normalizeBaseUrl(String(config.baseUrl ?? "")))?.protocol === "https:";
}

/**
 * ONE decision, asked twice: which transport to connect with, and whether the
 * sync has to disclose that it ran unverified. Both read the predicate above
 * rather than each re-deriving the conditions — a disclosure that could disagree
 * with the transport actually used would be worse than none.
 */
export function selectGns3Transport(transports: Gns3Transports, config: InventorySourceValues): typeof fetch {
  return gns3RunsWithoutCertificateVerification(config) ? transports.insecure : transports.standard;
}

function makeClient(transports: Gns3Transports, config: InventorySourceValues, secrets: InventorySourceSecrets): Gns3ApiClient {
  return new Gns3ApiClient(
    selectGns3Transport(transports, config),
    normalizeBaseUrl(String(config.baseUrl ?? "")),
    str(config.username),
    secrets.password ?? ""
  );
}

async function fetchInventoryImpl(
  transports: Gns3Transports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryTree> {
  const client = makeClient(transports, config, secrets);
  const filter = str(config.filter).toLowerCase();
  const consoleHost = str(config.consoleHost);

  const warnings: string[] = [];
  const deadline = Date.now() + CRAWL_DEADLINE_MS;
  client.setCrawlDeadline(deadline);
  await client.connect(FETCH_TIMEOUT_MS);

  // INSECURE TLS — this sync ran with certificate verification OFF, so it says
  // so, on the warnings channel the plan summary renders.
  if (gns3RunsWithoutCertificateVerification(config)) {
    warnings.push(GNS3_INSECURE_TLS_WARNING);
  }

  const devices: InventoryDevice[] = [];
  // LIVE STATUS ON A SYNC — the running/stopped picture this crawl already has
  // in hand. NO second round trip and no `fetchStatus` call: `mapNode` reads the
  // very same fields. `state` ONLY — see the `InventoryTree.status` contract for
  // why the console fields stay off it (they already flow through the sync plan
  // under the normal ownership rules, and writing them here would set the same
  // address twice under two different rules).
  const statuses: Record<string, InventoryDeviceStatus> = {};
  const outcome = await crawlNodes(client, filter, deadline, (project, node) => {
    const device = mapNode(project, node, consoleHost, client.hostname);
    devices.push(device);
    statuses[device.externalId] = { state: nodeState(project, node) };
  });
  warnings.push(...outcome.warnings);

  return {
    contractVersion: 1,
    devices,
    warnings,
    truncated: outcome.truncated || undefined,
    // The report is PARTIAL exactly where the crawl stopped looking, so
    // `applyInventoryStatus` MERGES it rather than clearing state for nodes
    // nobody examined.
    status: { contractVersion: 1, statuses, truncated: outcome.truncated || undefined }
  };
}

/**
 * LIVE STATUS — the running/stopped state of every node the source can see,
 * keyed by the SAME `${project_id}#${node_id}` externalId `fetchInventory` uses.
 * Reuses the exact crawl, under the same auth/timeout/error discipline, but
 * emits only status — plus, for a RUNNING node, the CURRENT console address.
 *
 * The console fields matter more here than they do on EVE-NG: GNS3 reallocates
 * console ports when a project is opened, and the port carried in a closed
 * project's topology dump is only a hint. A running node's console is the one
 * the controller is actually serving right now, so reporting it is what lets
 * `healSyncedConsolePorts` move a sync-owned server onto the live port. A
 * stopped node — and a running node with no telnet console — carries no console
 * fields at all.
 */
async function fetchStatusImpl(
  transports: Gns3Transports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryStatusReport> {
  const client = makeClient(transports, config, secrets);
  const filter = str(config.filter).toLowerCase();
  const consoleHost = str(config.consoleHost);

  const deadline = Date.now() + CRAWL_DEADLINE_MS;
  client.setCrawlDeadline(deadline);
  await client.connect(FETCH_TIMEOUT_MS);

  const statuses: Record<string, InventoryDeviceStatus> = {};
  const outcome = await crawlNodes(client, filter, deadline, (project, node) => {
    const state = nodeState(project, node);
    const status: InventoryDeviceStatus = { state };
    if (state === "running") {
      const target = resolveTelnetTarget(
        str(node.console_type),
        node.console,
        str(node.console_host),
        consoleHost,
        client.hostname
      );
      if (target) {
        status.consoleHost = target.host;
        status.consolePort = target.port;
      }
    }
    statuses[nodeExternalId(project.id, str(node.node_id))] = status;
  });

  return { contractVersion: 1, statuses, truncated: outcome.truncated || undefined };
}

/**
 * NODE CONTROL — start or stop ONE node, keyed by the same externalId the other
 * members use.
 *
 * THE CLOSED-PROJECT PRE-CHECK is the whole reason this is not two lines. GNS3's
 * single-node routes are `@open_required`: on a closed project they answer
 * HTTP 403 with `{"message": "The project is not opened"}` — a status code
 * INDISTINGUISHABLE from a genuine permission failure, which `throwForStatus`
 * quite correctly maps to `auth`. Telling the user their credentials were
 * rejected when in fact their project is closed sends them to reset a password
 * that works. So the project's status is read FIRST (`GET /projects`, which the
 * crawl already knows how to validate) and a closed project is refused here,
 * with the remedy that actually applies.
 *
 * And the remedy is "open it in GNS3", never "Nexus will open it for you": the
 * open route boots the whole lab, rewrites the `.gns3` on disk and reallocates
 * console ports for every other client. Starting one node must not do that.
 */
async function controlNodeImpl(
  transports: Gns3Transports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets,
  externalId: string,
  action: "start" | "stop"
): Promise<void> {
  const parsed = parseExternalId(externalId);
  if (!parsed) {
    throw new InventoryProviderError("protocol", `Malformed node id "${externalId}" — expected "<projectId>#<nodeId>".`);
  }
  const { projectId, nodeId } = parsed;

  const client = makeClient(transports, config, secrets);
  const version = await client.connect(FETCH_TIMEOUT_MS);

  const project = (await client.listProjects(FETCH_TIMEOUT_MS)).find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new InventoryProviderError(
      "protocol",
      `GNS3 no longer lists the project this node belongs to (${projectId}). Sync this source to bring the inventory up to date.`
    );
  }
  if (!project.opened) {
    throw new InventoryProviderError(
      "protocol",
      `"${flattenProviderText(project.name)}" is closed, and GNS3 refuses to start or stop a node in a closed project. Open the project in GNS3, then try again — Nexus will not open it for you, because opening a project boots every node set to auto-start and reassigns the console ports.`
    );
  }

  const path = `/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/${action}`;
  // THE `{}` BODY IS NOT OPTIONAL ON v3 AND IS UNDOCUMENTED. The 3.x start route
  // declares a request model, so FastAPI makes the body MANDATORY: omitting it
  // answers HTTP 422 with a validation error, not a started node. v2's handler
  // takes no body at all and is happy either way, but it is sent only where it
  // is needed so the v2 request stays byte-identical to what 2.2 has always
  // been asked. `stop` needs no body on either version.
  const body = version === "v3" && action === "start" ? {} : undefined;
  const response = await client.request("POST", path, body, FETCH_TIMEOUT_MS);
  // v2 answers 200 with the node object; v3 answers 204 with nothing. Both are
  // 2xx, so neither is special-cased — only a failure is.
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 403) {
      // The project was open one round trip ago, so a 403 now is either the
      // close-race or a real permission failure — and this is the ONE place that
      // can say so, because it is the only one holding the project's status.
      throw new InventoryProviderError(
        "protocol",
        `GNS3 refused to ${action} this node (HTTP 403): ${errorDetail(response.parsed, response.text) || "no message"}. If the project was closed just now, open it in GNS3 and try again.`
      );
    }
    throwForStatus(response.status, response.text, response.parsed, response.url, response.location);
  }
}

async function testConnectionImpl(
  transports: Gns3Transports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<void> {
  const client = makeClient(transports, config, secrets);
  // `connect` identifies the version and, on 3.x, spends the credentials — but
  // on a 2.2 server with `auth=False` it proves nothing about them, so the read
  // below is what actually exercises the API the sync will use.
  await client.connect(TEST_CONNECTION_TIMEOUT_MS);
  await client.listProjects(TEST_CONNECTION_TIMEOUT_MS);
}

/**
 * INSECURE TLS — the insecure transport is a SECOND injectable so a test can
 * assert which one a given config selects, rather than inferring it. Default
 * construction does no I/O and opens no socket, so building it eagerly here
 * costs nothing even for the (usual) source that never selects it.
 */
export function createGns3Provider(
  fetchImpl: typeof fetch = fetch,
  insecureFetchImpl: typeof fetch = createInsecureHttpsFetch()
): InventoryProvider {
  const transports: Gns3Transports = { standard: fetchImpl, insecure: insecureFetchImpl };
  return {
    id: GNS3_PROVIDER_ID,
    label: "GNS3",
    configFields: GNS3_CONFIG_FIELDS,
    attributeKeys: ["project", "type", "console", "status", "compute", "name"],
    // A PARTIAL status scan, in GNS3's own words. Cause-neutral on purpose:
    // every stopping point here (the project cap, the node cap, the wall-clock
    // deadline) is fixed by the same narrower crawl, and a cap truncates
    // identically on a retry, so "try again" would be bad advice for all of them.
    statusTruncationRemedy: "Narrow the Project Filter to bring this server's projects inside the crawl's limits.",
    instanceKey(config: InventorySourceValues): string | undefined {
      return gns3InstanceKey(config);
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
    // NO `canControlNode`, DELIBERATELY — and the contract
    // (models/inventory.ts) is what decides it, not convenience.
    //
    // The gate must be PURE, SYNCHRONOUS, and must AGREE with `controlNode`'s
    // own refusals: "the menu must never offer what the implementation
    // rejects". `controlNodeImpl` refuses exactly one class of device — a node
    // in a CLOSED project — and that is LIVE STATE, not something
    // `${project_id}#${node_id}` encodes. The gate sees only the id.
    //
    // The tempting fix is to close over the project statuses the last crawl
    // cached. It is the wrong one, in both directions:
    //  - STALE-CLOSED: the user opens the project in the GNS3 GUI, the node
    //    becomes perfectly controllable, and the menu stays hidden until the
    //    next poll. A hidden menu explains nothing and offers no way to find
    //    out, so the user is simply stuck.
    //  - EMPTY CACHE: before the session's first crawl the cache knows nothing
    //    and would have to admit everything anyway — so the same row would carry
    //    a Start/Stop menu or not depending on whether a sync had run since the
    //    window opened. A menu that comes and goes for no visible reason is
    //    worse than one that is always there.
    // The contract already settles this for the twin member: a refusal that
    // depends on live state the id does not carry "is not decidable here, and
    // the implementation's own refusal is the authoritative one. Such a device
    // keeps its menu entry and is told why when it is used, which is honest."
    // So the refusal is made to be worth reading instead — see the
    // closed-project branch in `controlNodeImpl`, which names the project and
    // the one remedy that can actually happen.
    //
    // NO `webConsoleUrl` / `canWebConsole` either. GNS3's own web UI has no
    // per-node console page to link a browser at: a node's console is a telnet
    // or VNC endpoint, which is what `endpoints` already carries and what Nexus
    // opens directly. A member that returned the server's root page would put a
    // "Open Web Console" entry on every row and land the user somewhere that is
    // not that node's console.
  };
}
