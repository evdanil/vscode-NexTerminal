import { isIPv4, isIPv6 } from "node:net";
import { ADVANCED_SECTION_LABEL } from "../../../ui/formTypes";
import { certificateFailureMessage, redirectNotFollowedMessage, type CertificateHintContext } from "../certificateHints";
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

export const PROXMOX_PROVIDER_ID = "proxmox";
/**
 * The default template is exactly the `{node}` placeholder: every guest lands in
 * a folder named after the PVE node that runs it — PVE's own primary grouping,
 * and the tree a cluster sync produces before a user customises anything. It
 * must carry the braces: the folder renderer substitutes `{token}` placeholders
 * only, so a bare `node` would render a folder literally named "node" under
 * every guest. Composition (`{pool}/{node}`, `{tag}`) is the user's opt-in
 * through the Folder Template field.
 */
export const DEFAULT_FOLDER_TEMPLATE = "{node}";

// REQUEST AND CRAWL BUDGETS. One place, so the numbers cannot drift between the
// paths that have to agree: the per-request timeouts bound every single call,
// the crawl budget bounds the whole guest-address walk, and the control pair
// bounds one start/stop task's poll. The bounds are generous because the peer
// is a cluster that may be answering for every other request a user has.
const HARD_CAP = 10_000;
const MAX_IP_GUESTS = 1_000;
const FETCH_TIMEOUT_MS = 20_000;
const TEST_CONNECTION_TIMEOUT_MS = 10_000;
const CRAWL_DEADLINE_MS = 120_000;
const CONTROL_POLL_INTERVAL_MS = 2_000;
const CONTROL_DEADLINE_MS = 120_000;

const PROXMOX_API_BASE = "/api2/json";

/**
 * INSECURE TLS — ONE definition of the option's name, used both as the config
 * field's label and inside the certificate-error hint that tells the user to go
 * turn it on. A message naming an option the form does not show is worse than
 * the bare OpenSSL code it replaced, so the two cannot be allowed to drift.
 *
 * Word-for-word EVE-NG's (and NetBox's) label: it is the same option, doing the
 * same thing, and a user with both kinds of source should not have to learn it
 * twice.
 */
const ALLOW_INSECURE_TLS_LABEL = "Allow a Self-Signed or Mismatched Certificate";

/**
 * INSECURE TLS — what a sync that RAN with certificate verification off says
 * about itself, on the `tree.warnings` channel that reaches the sync plan.
 *
 * The opt-in is read once, at transport selection, and would otherwise never be
 * heard from again — so a source ticked for a lab cluster and later repointed at
 * a production one keeps sending the API token over an unauthenticated
 * connection with nothing on screen saying so. (Same answer for a restored
 * backup that enables the flag: an import can already add telnet servers,
 * proxies and jump hosts, so the proportionate response is disclosure, not
 * another gate.)
 *
 * Names the option so it can be found and turned back off, and names the API
 * TOKEN because that — not a password — is what PVE puts on the wire, and it is
 * a bearer credential with no second factor behind it.
 */
export const PROXMOX_INSECURE_TLS_WARNING =
  `Certificate verification is off for this source (\u201c${ALLOW_INSECURE_TLS_LABEL}\u201d) \u2014 the connection is encrypted but unauthenticated, and the Proxmox API token is sent over it.`;

const PROXMOX_CONFIG_FIELDS: InventoryConfigField[] = [
  {
    id: "baseUrl",
    label: "Proxmox Base URL",
    type: "string",
    required: true,
    placeholder: "https://pve.example.com:8006"
  },
  {
    // The least-privilege recipe travels HERE rather than only in the README:
    // this is where a user is staring at an empty token field. PVE splits the
    // rights this provider needs across capabilities that do not imply one
    // another, and the QEMU-agent privilege moved between PVE 8 and PVE 9 —
    // naming both spellings is what keeps an addressless-guest report
    // diagnosable from the field itself.
    id: "apiToken",
    label: "API Token",
    type: "password",
    required: true,
    description:
      "A Proxmox API token (`<user@realm>!<tokenid>` plus its secret) with at least VM.Audit; add VM.PowerMgmt for Start/Stop, VM.GuestAgent.Audit (PVE 9) or VM.Monitor (PVE 8) for VM addresses, and Sys.Audit to import cluster nodes."
  },
  {
    // PVE's own grouping vocabulary. Status is deliberately NOT a placeholder:
    // a guest changes status on every boot, and folders that reshuffle on boot
    // churn the tree and rewrite the sync plan.
    id: "folderTemplate",
    label: "Folder Template",
    type: "string",
    required: false,
    placeholder: DEFAULT_FOLDER_TEMPLATE,
    description:
      "Placeholders: {node} {pool} {type} {tag}. A guest carrying several tags syncs under the alphabetically first one. Empty segments are dropped."
  },
  {
    // PRIMARY-IP FAMILY PREFERENCE — same field id and the same option VALUES
    // as NetBox's field, so the stored vocabulary stays one the shared code
    // reads; only the labels speak PVE. A PVE guest has no NetBox-style
    // server-assigned "primary IP" — the guest reports every interface it has
    // — so the automatic choice is "first address the guest reports".
    id: "primaryIpFamily",
    label: "Primary IP Family",
    type: "select",
    required: false,
    options: [
      { label: "Automatic (as reported by the guest)", value: "auto" },
      { label: "Prefer IPv4", value: "prefer-ipv4" },
      { label: "Prefer IPv6", value: "prefer-ipv6" }
    ],
    description:
      "Which address to import when a guest reports both IPv4 and IPv6 addresses. Automatic takes the first address the guest reports. Prefer options fall back to the other family when the guest has no address in that one."
  },
  {
    // DEFAULT ON, and that default is protective: a guest that is merely
    // powered off would otherwise drop out of every sync, and under a delete
    // prune policy that takes the kept server — and its stored credentials —
    // with it. Turning the box off is an explicit act with that consequence,
    // not something a new source should do silently.
    id: "includeStopped",
    label: "Include Stopped Guests",
    type: "boolean",
    required: false,
    defaultValue: true,
    description: "Stopped guests import as addressless placeholders and can be started from the tree."
  },
  {
    // INSECURE TLS — the shared per-source opt-in (EVE-NG shipped it in
    // 2.8.190, NetBox followed). Default OFF and behind the Advanced
    // disclosure: it turns a safety default off, so it must be a deliberate
    // act rather than something a user finds themselves next to while typing a
    // base URL. A stock PVE host answers on :8006 with a certificate issued by
    // the cluster's own CA, which the connecting machine does not trust — the
    // exact verification failure this option exists to clear.
    //
    // APPENDED to the advanced block so no field above it changes position.
    // The field list is part of the provider fingerprint
    // (`computeProviderFingerprint`, models/inventory.ts) — its ids, labels,
    // types, required flags and ORDER are hashed and stamped onto every source
    // at save time — so any future field must keep this order too.
    id: "allowInsecureTls",
    label: ALLOW_INSECURE_TLS_LABEL,
    type: "boolean",
    required: false,
    defaultValue: false,
    advanced: true,
    // Same voice as EVE-NG's/NetBox's, with the credential named: what Proxmox
    // sends is an API TOKEN, not a password. That clause is the part that must
    // not be softened — it is what the user is actually agreeing to send.
    description:
      "Connects over https without checking the server's certificate. The traffic is encrypted but unauthenticated, so anything on the network path can intercept it \u2014 including the Proxmox API token, which is sent on every request and is a bearer credential. Reasonable for a self-hosted cluster on a network you trust; not for one reachable from outside it. Has no effect on an http base URL, which is not encrypted at all."
  },
  {
    // PVE templates are not guests: a template row cannot be started, and the
    // guest agent never answers for it, so it can never carry an address.
    id: "includeTemplates",
    label: "Include Templates",
    type: "boolean",
    required: false,
    defaultValue: false,
    advanced: true,
    description: "Also import template guests. A Proxmox template carries no addresses and cannot be started."
  },
  {
    // NODES ARE A SECOND CALL, not a row type on the guest listing: the
    // /cluster/resources node rows carry neither an address nor a name, so a
    // node import is only worth the extra request when the token can answer
    // /cluster/status — which needs Sys.Audit, a capability the guest
    // vocabulary never required.
    id: "includeNodes",
    label: "Include Cluster Nodes",
    type: "boolean",
    required: false,
    defaultValue: false,
    advanced: true,
    description:
      "Also import the cluster's nodes as devices. The API token needs Sys.Audit for the node list and their addresses."
  },
  {
    // PER-SOURCE LAB STATUS POLL — EVE-NG's field, minus the session-eviction
    // clause: a PVE API token is stateless (no login session for a poll to
    // evict), so polling costs nothing but the request itself. Advanced,
    // because turning it on starts unattended requests against the cluster.
    id: "statusPollSeconds",
    label: "Lab Status Poll Interval (seconds)",
    type: "number",
    required: false,
    advanced: true,
    min: 0,
    max: 3600,
    // WHOLE SECONDS ONLY (review D2). There is no runtime meaning to give a
    // fractional poll period, so the field refuses one at both layers instead
    // of accepting a value it will quietly floor.
    integer: true,
    placeholder: "0",
    description:
      "How often, in seconds, to refresh this source's running status while the Command Center is visible. 0 turns polling off for this source \u2014 use Refresh Lab Status when you want it."
  }
];

/** PRIMARY-IP FAMILY PREFERENCE — the address family a source prefers. */
type PrimaryIpFamily = "auto" | "prefer-ipv4" | "prefer-ipv6";

/**
 * PER-SOURCE STATUS POLL — the field id and reader the Command Center's poll
 * uses to arm this source's interval (the poll map in the wiring imports both).
 *
 * DELIBERATE DUPLICATION of EVE-NG's `readEveNgStatusPollSeconds`
 * (eveNgProvider.ts), not a shared helper: the field id, its form bounds and
 * its absent-value semantics are provider-local — each provider's config-field
 * list is part of its fingerprint — and a reader keyed off one provider's
 * constant would couple two fingerprints to one module. EVE-NG's export stays
 * untouched for its own tests. The copied clamp/floor body keeps the two
 * sources behaving identically: absent, non-numeric, negative, fractional and
 * out-of-range values all resolve to something a timer can be armed with. The
 * form bounds the value on the way IN, but a source restored from a
 * hand-edited backup never went through the form, and an unclamped read there
 * would arm a millisecond-period timer against the cluster (or a `NaN` period,
 * which reports itself as running and never fires).
 */
export const PROXMOX_STATUS_POLL_FIELD_ID = "statusPollSeconds";
export const PROXMOX_STATUS_POLL_MIN_SECONDS = 0;
export const PROXMOX_STATUS_POLL_MAX_SECONDS = 3600;

export function readProxmoxStatusPollSeconds(config: InventorySourceValues): number {
  const raw = config[PROXMOX_STATUS_POLL_FIELD_ID];
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    // Includes the ABSENT case (every source that predates the field) and a
    // numeric STRING, which the form never stores but a backup could carry.
    return PROXMOX_STATUS_POLL_MIN_SECONDS;
  }
  const clamped = Math.min(Math.max(raw, PROXMOX_STATUS_POLL_MIN_SECONDS), PROXMOX_STATUS_POLL_MAX_SECONDS);
  // Floor rather than round: a value between 0 and 1 must land on OFF, not on a
  // sub-second period, and no user typing "1.9" meant "poll twice as often".
  return Math.floor(clamped);
}

/** Coerce a stored config value to a known preference; anything else is `auto`,
 *  so an absent field or a hand-mangled value is zero behaviour change
 *  bit-for-bit. */
export function parsePrimaryIpFamily(raw: unknown): PrimaryIpFamily {
  return raw === "prefer-ipv4" || raw === "prefer-ipv6" ? raw : "auto";
}

function normalizeBaseUrl(raw: string): string {
  // Trailing-slash trimming ONLY. The netbox copy this was taken from also
  // strips a trailing "/api"; that strip is deliberately ABSENT here: NetBox's
  // API lives under /api, so a pasted UI root gets trimmed there, but PVE's
  // API root is /api2/json and a "/api" mount prefix is a legitimate
  // reverse-proxy path (https://gateway.example/api) that must survive into
  // every request. Consequence: https://pve.example/api and
  // https://pve.example are DIFFERENT deployments (different instanceKeys) —
  // correct, they are different mounts.
  return raw.trim().replace(/\/+$/, "");
}

/**
 * REVIEW FINDING (P1, cross-instance adoption) — this Proxmox deployment's
 * identity: "the cluster at https://pve.example.com:8006", not "Proxmox". See
 * `InventoryProvider.instanceKey` (models/inventory.ts) for the contract and for
 * what depends on it; `netboxInstanceKey` is the reference implementation this
 * follows structurally.
 *
 * BUILT ON `normalizeBaseUrl`, THE SAME FUNCTION THAT BUILDS EVERY REQUEST. The
 * key has to mean "the endpoint this source actually talks to", so it must be
 * derived from exactly the string the fetch is derived from — a second,
 * independently-written normalizer is a second answer to the same question, and
 * the two would drift. Everything below is canonicalization the URL parser does
 * on top of it, so two spellings of one endpoint yield one key:
 *  - SCHEME AND HOST are lower-cased (both are case-insensitive by RFC 3986, and
 *    `new URL` does it), and a SCHEME-DEFAULT port is dropped — `https://pve:443`
 *    and `https://pve` are the same deployment and now the same key. PVE'S OWN
 *    :8006 IS NOT A SCHEME-DEFAULT PORT and survives: the parser only drops the
 *    port the scheme itself defaults to (443 for https, 80 for http), so
 *    `https://pve.example.com:8006` and `https://pve.example.com` are DIFFERENT
 *    deployments. This is where a reflexive "drop the default port" that
 *    hard-codes 8006 would silently merge two endpoints; the rule is "drop only
 *    what the URL parser calls the scheme's default".
 *  - THE PATH IS KEPT AS TYPED, case included: PVE is commonly reached through a
 *    reverse-proxy prefix (`https://example.com/pve`), those are different
 *    deployments, and path case is server-significant in a way host case is not.
 *  - USERINFO IS DROPPED, and this one is a hard requirement rather than tidiness
 *    — `https://user:secret@pve` is a credential typed into a NON-secret field,
 *    and this key is persisted on every kept server and copied into backups. The
 *    method never sees `secrets`; this is the other half of keeping it clean.
 *  - QUERY AND FRAGMENT ARE DROPPED: neither addresses a deployment, and leaving
 *    them in would split one instance into as many keys as there are stray "?"
 *    suffixes.
 *
 * SCHEME IS PART OF THE IDENTITY (`http://pve` !== `https://pve`), deliberately,
 * even though it is usually the same box behind both. The two failure modes are
 * not symmetrical: treating two instances as one is the finding being fixed and
 * is silent and destructive, while treating one instance as two costs a refused
 * adoption that re-typing the URL repairs.
 *
 * `undefined` for an unparseable or empty base URL — including a bare
 * `pve.example.com` with no scheme, which `new URL` rejects. That is not a
 * loss: the fetch path builds `new URL(...)` from the same string, so a source
 * whose base URL cannot be parsed cannot sync at all, and claiming an identity
 * for it would be claiming one for an endpoint that does not resolve.
 */
export function proxmoxInstanceKey(config: InventorySourceValues): string | undefined {
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
  // `host` (not `hostname`) so a non-default port — for PVE, :8006 — stays part
  // of the identity; the parser has already dropped the scheme's default port
  // and lower-cased both scheme and host.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * INSECURE TLS — what this provider contributes to the SHARED certificate-hint
 * sentence (`services/inventory/certificateHints.ts`). The table of codes and the
 * "turn on <option> in this source's <section>" builder are one copy for every
 * provider that offers the opt-in; only the provider-specific parts are named
 * here.
 *
 * No `selfSignedNote`: a stock PVE host's certificate is issued by the cluster's
 * own CA — untrusted by the connecting machine, but not the "self-signed leaf is
 * this install's expected state" situation EVE-NG's note describes, and this
 * provider cannot promise it either way (admins commonly install a proper
 * certificate through pveproxy).
 */
const PROXMOX_CERT_HINT_CONTEXT: CertificateHintContext = {
  optionLabel: ALLOW_INSECURE_TLS_LABEL,
  sectionLabel: ADVANCED_SECTION_LABEL,
  // NOT "password": Proxmox authenticates with an API token, sent on every
  // request. Naming a password would describe an exposure this user does not
  // have while leaving the one they do have unnamed.
  exposureNoun: "the Proxmox API token"
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
      const certMessage = certificateFailureMessage(code, host, PROXMOX_CERT_HINT_CONTEXT);
      if (certMessage) {
        return new InventoryProviderError("network", certMessage);
      }
      return new InventoryProviderError("network", `Could not reach ${host}: ${code}.`);
    }
    return new InventoryProviderError("network", `Could not reach ${host}: ${err.message}`);
  }
  return new InventoryProviderError("network", `Could not reach ${host}: ${String(err)}`);
}

function throwForStatus(res: RawResponse, url: URL): never {
  const { status } = res;
  // BEFORE any body parsing: an unauthenticated PVE answers 401 with an EMPTY
  // body and the reason in the status line ("HTTP/1.1 401 No ticket"), so the
  // auth error must be constructible without a body at all.
  if (status === 401 || status === 403) {
    throw new InventoryProviderError("auth", `Proxmox rejected the API token (HTTP ${status}) at ${url}.`);
  }
  // A REDIRECT THIS CONNECTION CANNOT TAKE, and a 3xx body is empty — so the
  // message was `failed with HTTP 301: ` and stopped there. Only on the transport
  // that does not follow redirects: the standard one DOES follow them (a PVE
  // source behind a redirecting reverse proxy runs there), and telling that user
  // their connection refuses redirects would be false.
  if (res.redirectNotFollowed && status >= 300 && status < 400) {
    throw new InventoryProviderError(
      "protocol",
      `Proxmox request to ${url} failed with HTTP ${status}: ${redirectNotFollowedMessage(res.location)}`
    );
  }
  throw new InventoryProviderError("protocol", `Proxmox request to ${url} failed with HTTP ${status}: ${pveStatusDetail(res.text)}`);
}

/**
 * PVE puts the human-readable reason for a failure in the `message` member of a
 * `{"data":null,"message":…}` envelope (verified live shape: the agent-missing
 * 500, which pads the message with a trailing newline), and answers other
 * failures with bodies this provider does not control. Read that member when
 * the body is shaped so; fall back to the raw body slice for everything else,
 * so a reverse proxy's HTML error page still reaches the user verbatim.
 */
function pveStatusDetail(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message.trim().slice(0, 200);
      }
    }
  } catch {
    // Not JSON — the raw slice below is the message.
  }
  return text.slice(0, 200);
}

function parseJsonOrThrow(text: string, url: URL): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InventoryProviderError("protocol", `Response from ${url} is not Proxmox JSON — is the base URL correct?`);
  }
}

interface RawResponse {
  status: number;
  text: string;
  /**
   * TRUE only on the transport that cannot follow a redirect (the insecure one —
   * see `ProxmoxTransport`). Carried on the response rather than re-derived where
   * the error is built, so the explanation can never claim a redirect went
   * unfollowed on the transport that would have followed it.
   */
  redirectNotFollowed: boolean;
  /** The response's `Location`, when it sent one — the address the base URL should name. */
  location?: string;
}

/**
 * INSECURE TLS — the two transports one provider instance holds.
 *
 * `standard` is the injected global `fetch`, untouched, and is what every source
 * uses by default. `insecure` is the `node:https` adapter with certificate
 * verification off (`services/inventory/insecureFetch.ts`) — the SAME
 * provider-agnostic transport EVE-NG and NetBox use, not a second implementation.
 */
interface ProxmoxTransports {
  standard: typeof fetch;
  insecure: typeof fetch;
}

/**
 * The transport a request is actually sent with, plus the one `init` member that
 * differs between the two.
 *
 * WHY THE REDIRECT MODE TRAVELS WITH THE TRANSPORT: the insecure adapter REFUSES
 * any mode other than `"manual"` — it never follows a redirect, and accepting
 * `"follow"` while not following would be a silent lie — so an opted-in source
 * that left the default would have every request rejected inside the adapter
 * before a socket opened.
 *
 * It is NOT set on the standard transport: a PVE source behind a reverse proxy
 * that redirects keeps the following behaviour it would have had anyway. A new
 * opt-in may change what happens for sources that take it, and nothing else.
 */
interface ProxmoxTransport {
  fetch: typeof fetch;
  redirect?: "manual";
}

/**
 * BOTH conditions, ANDed, decided PER CONFIG rather than per provider — one
 * registry instance serves every Proxmox source, so the choice cannot be baked in
 * at construction:
 *
 *  (a) the source explicitly opted in (`=== true`, never a truthiness test: the
 *      form stores a real boolean, and an absent field must read as off);
 *  (b) the URL is `https:` — relaxing certificate checks on plain http means
 *      nothing, and the adapter would refuse the URL outright, so an http source
 *      with the box ticked must keep working exactly as before.
 *
 * The scheme is read off `normalizeBaseUrl` + `new URL`, which lower-cases it,
 * rather than off the raw string: `HTTPS://…` is https.
 */
function proxmoxRunsWithoutCertificateVerification(config: InventorySourceValues): boolean {
  if (config.allowInsecureTls !== true) {
    return false;
  }
  try {
    return new URL(normalizeBaseUrl(String(config.baseUrl ?? ""))).protocol === "https:";
  } catch {
    // An unparseable base URL cannot be https, and must not be answered by
    // turning verification off. The fetch path reports it properly.
    return false;
  }
}

/**
 * ONE decision, asked twice: which transport to connect with, and whether the
 * sync has to disclose that it ran unverified (`PROXMOX_INSECURE_TLS_WARNING`).
 * Both read the predicate above rather than each re-deriving the conditions — a
 * disclosure that could disagree with the transport actually used would be worse
 * than none, and identity-comparing the returned transport cannot tell the two
 * apart when a caller injects the same function as both.
 */
function selectProxmoxTransport(transports: ProxmoxTransports, config: InventorySourceValues): ProxmoxTransport {
  return proxmoxRunsWithoutCertificateVerification(config)
    ? { fetch: transports.insecure, redirect: "manual" }
    : { fetch: transports.standard };
}

/**
 * ONE request path for BOTH verbs. GET keeps the platform-default init (no
 * explicit `method` member — pinned by the smoke-test's request shape), so the
 * spread is conditional rather than unconditional.
 */
async function rawRequest(
  transport: ProxmoxTransport,
  method: "GET" | "POST",
  url: URL,
  token: string,
  timeoutMs: number
): Promise<RawResponse> {
  let res: Response;
  try {
    res = await transport.fetch(url.toString(), {
      // PVE's token header is ONE string the user assembles in the PVE UI
      // (`PVEAPIToken=<user@realm>!<tokenid>=<secret>`) — no `Token`/`Bearer`
      // prefix and no client-side concatenation to get wrong.
      headers: { Authorization: `PVEAPIToken=${token}`, Accept: "application/json" },
      // Present only on the insecure transport — see `ProxmoxTransport`. Spread
      // so the standard path's `init` stays byte-identical to what a plain
      // fetch would send, rather than gaining an explicit `redirect: undefined`.
      ...(transport.redirect ? { redirect: transport.redirect } : {}),
      ...(method === "GET" ? {} : { method }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw mapNetworkError(err, url);
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  // Defensive about `headers` for the same reason the rest of this module is
  // about the injected `fetch`: a Response-alike that answers none must not throw
  // here, on the error path.
  const headers = res.headers as unknown as { get?: (name: string) => string | null } | undefined;
  const location = (typeof headers?.get === "function" ? headers.get("location") : null) ?? undefined;
  return { status: res.status, text, redirectNotFollowed: transport.redirect === "manual", location };
}

function rawGet(transport: ProxmoxTransport, url: URL, token: string, timeoutMs: number): Promise<RawResponse> {
  return rawRequest(transport, "GET", url, token, timeoutMs);
}

/** The one POST the provider makes — a start/stop mutation (see `controlNodeImpl`). */
function rawPost(transport: ProxmoxTransport, url: URL, token: string, timeoutMs: number): Promise<RawResponse> {
  return rawRequest(transport, "POST", url, token, timeoutMs);
}

async function testConnectionImpl(transport: ProxmoxTransport, baseUrl: string, token: string): Promise<void> {
  // ONE endpoint, no fallback: /version is served on every PVE build (the web
  // UI itself calls it) and answers any valid token, so a failure is always a
  // real answer — there is no older-build 404 shape to route around the way
  // NetBox's smoke test does.
  const versionUrl = new URL(`${baseUrl}${PROXMOX_API_BASE}/version`);
  const raw = await rawGet(transport, versionUrl, token, TEST_CONNECTION_TIMEOUT_MS);
  if (raw.status >= 200 && raw.status < 300) {
    parseJsonOrThrow(raw.text, versionUrl);
    return;
  }
  throwForStatus(raw, versionUrl);
}

/** Coerce a row member to the string the mapping wants; anything but a string reads as absent. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * PVE tags arrive as ONE ";-joined string on the row (`tags: "ops;managed"`).
 * Split, trim, drop empties — the set-valued `tags` attribute and the `{tag}`
 * folder variable both read from this one parser, so they can never disagree
 * about what a guest's tags are.
 */
function parseNetTags(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Copied verbatim from netboxProvider's `renderFolderTemplate` — one renderer,
 * one semantics ("split on '/', substitute unknown/empty to '', trim, drop
 * empty segments, rejoin"), so `{pool}/{node}` on a PVE source folds exactly
 * the way it does on a NetBox one and no template quirk is fixed in one place
 * only.
 */
function renderFolderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .split("/")
    .map((segment) => segment.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => vars[key] ?? ""))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

/**
 * The folder variables a guest row offers — PVE's own grouping vocabulary.
 * `{tag}` is the FIRST TAG IN SORTED (lexicographic) order of the guest's tags,
 * deliberately: it is the one deterministic pick, so a guest carrying several
 * tags syncs under the same folder every sync. Taking the tags in reported
 * order instead would reshuffle folders whenever the user reorders tags in
 * PVE, and folders that reshuffle churn the tree and rewrite the sync plan.
 * An absent pool or tag renders "", which the renderer drops as an empty
 * segment rather than leaving a dangling "/".
 */
function renderGuestVars(row: Record<string, unknown>): Record<string, string> {
  return {
    node: str(row.node),
    pool: str(row.pool),
    type: str(row.type),
    tag: parseNetTags(row.tags).sort()[0] ?? ""
  };
}

// ---------------------------------------------------------------------------
// GUEST ADDRESS RESOLUTION (§IP selection) — the pure pieces. Everything here
// is normalization or selection over the two VERIFIED endpoint shapes; no
// request is made below. The QEMU agent endpoint reports bare addresses and
// `"hardware-address"`; the LXC endpoint reports inet/inet6 CIDR strings and
// `hwaddr`. Both are normalized into the same {name, mac, addresses} shape so
// the selection algorithm never learns which endpoint an interface came from.
// ---------------------------------------------------------------------------

/** One guest interface, normalized. `mac` is lowercased or "" when unreported. */
export interface ProxmoxGuestIface {
  name: string;
  mac: string;
  /** As reported — LXC's inet/inet6 strings keep their CIDR suffix until pick/attribute time. */
  addresses: string[];
}

/** One config `netN` NIC: the property's numeric index and its lowercased MAC. */
export interface ProxmoxNetMac {
  index: number;
  mac: string;
}

/** "192.0.2.10/24" -> "192.0.2.10"; "2001:db8::10/64" -> "2001:db8::10". */
export function stripCidr(address: string): string {
  const slash = address.lastIndexOf("/");
  return slash === -1 ? address : address.slice(0, slash);
}

/**
 * Is this a usable host address? Classification is by SHAPE (`:` ⇒ IPv6), never
 * by the `ip-address-type` vocabulary — the two endpoints use different words
 * (`ipv4/ipv6` vs `inet/inet6`), and the LXC vocabulary has been observed on
 * the agent endpoint, so any type-string read is wrong somewhere.
 *
 * Dropped, per spec: IPv4 loopback 127/8, link-local 169.254/16, the
 * unspecified 0.0.0.0, and everything from multicast/reserved 224/4 up; IPv6
 * loopback ::1, link-local fe80::/10 and multicast ff00::/8. Two defensive
 * additions beyond the spec list, both "not a host address" rather than
 * policy: the unspecified :: (the agent reports it on tentative interfaces)
 * and anything unparseable — a garbage string must not become an endpoint
 * host. CIDR suffixes are stripped before testing, so both endpoint shapes
 * read the same.
 *
 * SYNTAX is delegated, not hand-rolled (review P2): the stdlib `net.isIPv6` /
 * `net.isIPv4` are the codebase's one definition of "a well-formed literal" —
 * they reject the colon-shaped garbage a character whitelist admits
 * (`1:2:3:4:5:6:7:8:9`, `abcd:`, `::ffff:999.999.999.999`), accept the
 * compressed and IPv4-mapped forms real guests report (`2001:db8::1`,
 * `::ffff:192.0.2.7`), and save this file from owning a second, weaker IPv6
 * parser beside the one `profileTokens.isIpv6Literal` already guards its own
 * boundary with. The range exclusions below are policy and stay here, applied
 * to the CANONICALIZED literal — a guest may report the same address in any
 * RFC 4291 spelling, and the exclusions are literal comparisons.
 */
export function isGlobalAddress(raw: string): boolean {
  const addr = stripCidr(raw).toLowerCase();
  if (addr.includes(":")) {
    // A zone suffix (`fe80::1%eth0`) is decoration we cannot connect through —
    // reject it outright rather than strip it (stripping would turn a scoped
    // link-local the guest reported into the global-looking address without
    // its scope). `isIPv6` accepts zone ids, so this check runs first.
    if (addr.includes("%")) {
      return false;
    }
    if (!isIPv6(addr)) {
      return false;
    }
    // The exclusions below compare against CANONICAL spellings, so they must
    // run on the canonical form: `net.isIPv6` accepts spellings the literals
    // would never match — `0:0:0:0:0:0:0:1` is `::1`, and `::ffff:127.0.0.1`
    // serializes to `::ffff:7f00:1`. The WHATWG URL parser canonicalizes any
    // literal `isIPv6` accepted, emitting the RFC 5952 hex form (compressed,
    // lowercase, never a leading zero — so the prefix tests below are sound);
    // `hostname` wraps IPv6 hosts in brackets, which are stripped here. A
    // throw on input that already passed the syntax check means something
    // exotic we will not connect to.
    let canonical: string;
    try {
      canonical = new URL(`http://[${addr}]/`).hostname.slice(1, -1);
    } catch {
      return false;
    }
    if (canonical === "::1" || canonical === "::") {
      return false;
    }
    // IPv4-EMBEDDED canonical shapes — `::ffff:h:h` (mapped, ::ffff:0:0/96)
    // and `::h:h` (compatible, ::/96; deprecated but real) — carry an IPv4
    // address in their last two 16-bit groups, and the SAME exclusions as the
    // dotted branch apply to those bytes: `::ffff:127.0.0.1` is loopback, not
    // an endpoint, whatever spelling the guest reported.
    const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (embedded) {
      const h1 = parseInt(embedded[1], 16);
      const h2 = parseInt(embedded[2], 16);
      return !excludedIpv4([h1 >> 8, h1 & 255, h2 >> 8, h2 & 255]);
    }
    // fe80::/10 spans fe80..febf — first TWO hex digits "fe", third in 8-b.
    if (/^fe[89ab]/.test(canonical)) {
      return false;
    }
    if (canonical.startsWith("ff")) {
      return false;
    }
    return true;
  }
  if (!isIPv4(addr)) {
    return false;
  }
  const octets = addr.split(".").map(Number);
  if (octets.some((o) => o > 255)) {
    return false;
  }
  return !excludedIpv4(octets);
}

// The IPv4 range policy, shared by the dotted branch above and the
// IPv4-EMBEDDED IPv6 forms — ONE definition, so the two families can never
// disagree about which embedded v4 addresses are special.
function excludedIpv4(octets: number[]): boolean {
  if (octets[0] === 127) {
    return true;
  }
  if (octets[0] === 169 && octets[1] === 254) {
    return true;
  }
  if (octets[0] === 0 && octets[1] === 0 && octets[2] === 0 && octets[3] === 0) {
    return true;
  }
  return octets[0] >= 224;
}

/**
 * The QEMU agent's interface list. VERIFIED live shape: the interfaces hide
 * behind an extra `result` member (`{"data":{"result":[…]}}`) — reading `data`
 * as the array finds nothing on a healthy agent. Addresses are taken verbatim
 * in reported order (deduped); classification happens later, by shape.
 */
export function parseQemuAgentIfaces(payload: unknown): ProxmoxGuestIface[] {
  const result = (payload as { data?: { result?: unknown } } | null | undefined)?.data?.result;
  if (!Array.isArray(result)) {
    return [];
  }
  const ifaces: ProxmoxGuestIface[] = [];
  for (const raw of result) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as { name?: unknown; "hardware-address"?: unknown; "ip-addresses"?: unknown };
    const addresses: string[] = [];
    if (Array.isArray(entry["ip-addresses"])) {
      for (const item of entry["ip-addresses"]) {
        const addr = typeof item === "object" && item !== null ? (item as { "ip-address"?: unknown })["ip-address"] : undefined;
        if (typeof addr === "string" && addr.length > 0 && !addresses.includes(addr)) {
          addresses.push(addr);
        }
      }
    }
    const macRaw = entry["hardware-address"];
    ifaces.push({
      name: typeof entry.name === "string" ? entry.name : "",
      mac: typeof macRaw === "string" ? macRaw.toLowerCase() : "",
      addresses
    });
  }
  return ifaces;
}

/**
 * The LXC interfaces list. VERIFIED live shape: `{"data":[{name, hwaddr,
 * inet: "a.b.c.d/24", inet6: "…", ip-addresses: […]}]}`. inet/inet6 are
 * whitespace-split (PVE can pack several addresses in one string) and read
 * FIRST, then any `ip-addresses` entries not already seen — a healthy
 * container repeats itself between the two forms, and duplicates would churn
 * the set-valued attributes. `{"data":null}` is the VERIFIED stopped-container
 * answer (HTTP 200): "no addresses", not a malformed response.
 */
export function parseLxcIfaces(payload: unknown): ProxmoxGuestIface[] {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const ifaces: ProxmoxGuestIface[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as { name?: unknown; hwaddr?: unknown; inet?: unknown; inet6?: unknown; "ip-addresses"?: unknown };
    const addresses: string[] = [];
    const pushTokens = (value: unknown): void => {
      if (typeof value !== "string") {
        return;
      }
      for (const token of value.split(/\s+/)) {
        if (token.length > 0 && !addresses.includes(token)) {
          addresses.push(token);
        }
      }
    };
    pushTokens(entry.inet);
    pushTokens(entry.inet6);
    if (Array.isArray(entry["ip-addresses"])) {
      for (const item of entry["ip-addresses"]) {
        const addr = typeof item === "object" && item !== null ? (item as { "ip-address"?: unknown })["ip-address"] : undefined;
        if (typeof addr === "string" && addr.length > 0 && !addresses.includes(addr)) {
          addresses.push(addr);
        }
      }
    }
    const macRaw = entry.hwaddr;
    ifaces.push({
      name: typeof entry.name === "string" ? entry.name : "",
      mac: typeof macRaw === "string" ? macRaw.toLowerCase() : "",
      addresses
    });
  }
  return ifaces;
}

const NET_KEY = /^net(\d+)$/;
const MAC_SEGMENT = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;

/**
 * The NIC MACs from a guest config (`{"data":{"net0":"virtio=BC:…,…",…}}`).
 * qemu writes `<model>=<MAC>` as the first segment; lxc writes `hwaddr=<MAC>`
 * wherever the property string pleases — so the MAC is matched by SHAPE in any
 * `k=v` part of any segment, never by key or position. `bridge=`, `firewall=`,
 * `name=`, `ip=` and friends never match the shape and are ignored. Keys that
 * are not `netN` are ignored outright. NUMERIC index sort: the entries arrive
 * in object order, and a ten-NIC guest would otherwise sort net10 before net2
 * lexically and rank its eleventh interface above its third.
 */
export function parseNetMacs(configPayload: unknown): ProxmoxNetMac[] {
  const data = (configPayload as { data?: unknown } | null | undefined)?.data;
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const macs: ProxmoxNetMac[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const keyMatch = NET_KEY.exec(key);
    if (!keyMatch || typeof value !== "string") {
      continue;
    }
    for (const segment of value.split(",")) {
      let found: string | undefined;
      for (const part of segment.split("=")) {
        const candidate = part.trim();
        // Shape match only — case-folded after, so `BC:24:…` and `bc:24:…` are
        // the same MAC to every consumer downstream.
        if (MAC_SEGMENT.test(candidate)) {
          found = candidate.toLowerCase();
          break;
        }
      }
      if (found) {
        macs.push({ index: Number.parseInt(keyMatch[1], 10), mac: found });
        break;
      }
    }
  }
  return macs.sort((a, b) => a.index - b.index);
}

/**
 * The PRIMARY address off one interface's addresses (§IP selection 4): `auto`
 * takes the first global in reported order; a `prefer-*` family takes its
 * first global, FALLING BACK to the other family when the interface has none —
 * a family preference must never manufacture an addressless device. Returns
 * the CIDR-stripped host, or undefined when the interface holds no global.
 */
export function pickAddress(addresses: string[], family: PrimaryIpFamily): string | undefined {
  const globals = addresses.filter(isGlobalAddress).map(stripCidr).filter((host) => host.length > 0);
  const v6 = (host: string): boolean => host.includes(":");
  if (family === "prefer-ipv4") {
    return globals.find((host) => !v6(host)) ?? globals.find(v6);
  }
  if (family === "prefer-ipv6") {
    return globals.find(v6) ?? globals.find((host) => !v6(host));
  }
  return globals[0];
}

/**
 * The §IP selection 3 order: interfaces whose MAC matches a config `netN` MAC
 * first — ascending numeric netN index, net0 being PVE's own primary-NIC
 * notion — then unmatched interfaces in enumeration order. This is how "prefer
 * real NICs over in-guest virtual ones" works WITHOUT name parsing: docker
 * bridges and ZeroTier taps carry MACs PVE has never seen, so they always sort
 * behind the guest's known NICs. MAC comparison is case-insensitive (the
 * parsers already lowercase; this re-folds defensively so a caller passing
 * PVE-cased config MACs still matches).
 */
export function ifaceOrder(ifaces: ProxmoxGuestIface[], macs: ProxmoxNetMac[]): ProxmoxGuestIface[] {
  const configIndex = new Map<string, number>();
  for (const { index, mac } of macs) {
    if (!configIndex.has(mac.toLowerCase())) {
      configIndex.set(mac.toLowerCase(), index);
    }
  }
  const matched: { iface: ProxmoxGuestIface; order: number; position: number }[] = [];
  const unmatched: ProxmoxGuestIface[] = [];
  ifaces.forEach((iface, position) => {
    const order = iface.mac ? configIndex.get(iface.mac.toLowerCase()) : undefined;
    if (order === undefined) {
      unmatched.push(iface);
    } else {
      matched.push({ iface, order, position });
    }
  });
  // Two interfaces sharing one config MAC (a malformed config) keep their
  // reported order — the tiebreak, not the rule.
  matched.sort((a, b) => a.order - b.order || a.position - b.position);
  return [...matched.map((m) => m.iface), ...unmatched];
}

/** What the per-guest crawl hands back: MACs from config, ifaces from the IP endpoint. */
interface GuestAddressData {
  macs: ProxmoxNetMac[];
  ifaces: ProxmoxGuestIface[];
}

/**
 * Fills one mapped guest's endpoints and IP attributes from its crawled
 * addresses (§IP selection). ATTRIBUTES cover ALL interfaces regardless of
 * which one filled Host: every global address (ip/ip6 sets), every reported
 * MAC (lowercased) and every interface name that holds a global (ifname) —
 * the chosen interface is a routing decision, not a disclosure filter. Empty
 * sets are omitted: an empty key would read as a matchable value to template
 * filters.
 *
 * ENDPOINTS follow the netbox convention: the FIRST `kind: "ssh"` endpoint is
 * the primary host (`selectSshEndpoint` → `ServerConfig.host`), the SECOND is
 * the alternate (`selectAltEndpoint` → `altHost`) — the chosen interface's
 * other-family global, only when present and DISTINCT from the primary. The
 * chosen interface is the first in §3 order holding at least one global, and
 * the primary never goes missing under a family preference (pickAddress falls
 * back across families). A NAMELESS guest still gains the attributes but keeps
 * NO endpoint — it cannot become a server, so an address on it would only
 * invite a half-mapped placeholder (netbox convention).
 */
function fillGuestEndpoints(device: InventoryDevice, data: GuestAddressData, family: PrimaryIpFamily): void {
  const ip = new Set<string>();
  const ip6 = new Set<string>();
  const macs = new Set<string>();
  const ifnames = new Set<string>();
  for (const iface of data.ifaces) {
    let holdsGlobal = false;
    for (const raw of iface.addresses) {
      if (!isGlobalAddress(raw)) {
        continue;
      }
      const host = stripCidr(raw);
      if (host.length === 0) {
        continue;
      }
      (host.includes(":") ? ip6 : ip).add(host);
      holdsGlobal = true;
    }
    if (holdsGlobal) {
      ifnames.add(iface.name);
    }
    if (iface.mac) {
      macs.add(iface.mac);
    }
  }
  const attrs: Record<string, string[]> = {};
  if (ip.size > 0) {
    attrs.ip = [...ip];
  }
  if (ip6.size > 0) {
    attrs.ip6 = [...ip6];
  }
  if (macs.size > 0) {
    attrs.mac = [...macs];
  }
  if (ifnames.size > 0) {
    attrs.ifname = [...ifnames];
  }
  if (Object.keys(attrs).length > 0) {
    device.attributes = { ...device.attributes, ...attrs };
  }

  const chosen = ifaceOrder(data.ifaces, data.macs).find((iface) => iface.addresses.some(isGlobalAddress));
  if (!chosen || !device.name) {
    return;
  }
  const primary = pickAddress(chosen.addresses, family);
  if (!primary) {
    return;
  }
  const endpoints: InventoryDevice["endpoints"] = [{ kind: "ssh", host: primary, port: 22 }];
  const chosenGlobals = chosen.addresses.filter(isGlobalAddress).map(stripCidr);
  const otherFamily = primary.includes(":") ? chosenGlobals.filter((host) => !host.includes(":")) : chosenGlobals.filter((host) => host.includes(":"));
  const alternate = otherFamily.find((host) => host !== primary);
  if (alternate) {
    endpoints.push({ kind: "ssh", host: alternate, port: 22 });
  }
  device.endpoints = endpoints;
}

/**
 * One guest row → one InventoryDevice. Endpoints and IP attributes are filled
 * from `data` when the per-guest address crawl ran (see
 * `fillGuestEndpoints`); without it — a stopped guest, a template, a crawl
 * capped before this guest — the device stays addressless, which is the honest
 * answer and the engine's cue for its own addressless disclosure. Same
 * defensive rule as netbox's `mapEntry`: a row without a usable vmid has no
 * stable externalId, and emitting a fabricated one (`"undefined"`) would
 * poison the adoption identity every kept server carries — so the row aborts
 * the sync loudly instead of quietly vanishing (a silently skipped row reads
 * as "gone at the source" and gets its server pruned).
 */
function mapGuest(
  row: Record<string, unknown>,
  template: string,
  data?: GuestAddressData,
  family: PrimaryIpFamily = "auto"
): InventoryDevice {
  const hasUsableVmid =
    (typeof row.vmid === "number" && Number.isFinite(row.vmid)) ||
    (typeof row.vmid === "string" && row.vmid.length > 0);
  if (!hasUsableVmid) {
    throw new InventoryProviderError("protocol", `guest row has no usable vmid — refusing to sync.`);
  }
  const name = str(row.name);
  // Set-valued `put` idiom (netbox's deviceAttributes): a key appears only when
  // it has content, so a row without pool/tags never carries an empty entry
  // that a template filter could match against. ONLY the documented keys — the
  // row's other members (cpu, mem, maxdisk, netin, …) are PVE statistics that
  // change constantly and must not churn matching attributes.
  const attrs: Record<string, string[]> = {};
  const put = (key: string, values: string[]): void => {
    if (values.length > 0) {
      attrs[key] = values;
    }
  };
  // `put` expects PRE-FILTERED values (netbox's pairValues/tagValues strip
  // empties before calling it); `one` does that for a single-valued member, so
  // an absent pool reads as "no pool" rather than as a set holding "".
  const one = (value: string): string[] => (value.length > 0 ? [value] : []);
  put("type", one(str(row.type)));
  put("node", one(str(row.node)));
  put("pool", one(str(row.pool)));
  put("tags", parseNetTags(row.tags));
  // running/stopped only. PVE also emits "unknown" (before RRD data exists);
  // the state is genuinely unknown, and inventing one would be a lie the live
  // status poll immediately contradicts — so no status attribute at all.
  const status = row.status === "running" || row.status === "stopped" ? str(row.status) : "";
  put("status", status ? [status] : []);
  const device: InventoryDevice = {
    externalId: String(row.vmid),
    name,
    folderPath: renderFolderTemplate(template, renderGuestVars(row)),
    // Endpoints are filled in below ONLY from the crawl's data; a NAMELESS
    // guest keeps none even then (netbox convention): it cannot become a
    // server, so an address on it would only invite a half-mapped placeholder.
    endpoints: [],
    attributes: Object.keys(attrs).length > 0 ? attrs : undefined
  };
  if (data) {
    fillGuestEndpoints(device, data, family);
  }
  return device;
}

/**
 * One node row + its joined /cluster/status entry → one InventoryDevice.
 *
 * The resources row carries ONLY existence — its verified shape is
 * `{id: "node/pve", node: "pve", type: "node", status: "online"|"offline"|"unknown"}`,
 * with no `name` and no `ip` member — so everything the device shows comes from
 * the joined entry, and every part of that join is optional: no entry (the
 * Sys.Audit call failed or never listed this node) and no `ip` on the entry
 * each mean an ADDRESSLESS device, because a node exists whether or not this
 * token may read its address. `status` maps the entry's NUMERIC `online` 1/0 to
  * running/stopped; anything else — absent, or a malformed payload's string —
  * invents no state, the omit-only rule (a guest's "unknown" also CLEARS the
  * id, because a guest row is observed per fetch; a node entry here may not
  * correspond to any guest row at all — see the status path's cleared list).
 *
 * NO folderPath: a node lands at the source's targetFolder root. PVE's
 * node-named folders belong to GUESTS (the default `{node}` template); nesting
 * a node device under a folder named after itself would be the tree citing
 * itself as its own parent.
 *
 * A row without a usable node name is skipped rather than thrown: unlike a
 * guest's missing vmid, no server can ever be keyed to a name the API never
 * sent (`"node/"` would be a wholly fabricated identity), so a skip strands
 * nothing for the prune phase to reap.
 */
function mapNode(row: Record<string, unknown>, status?: Record<string, unknown>): InventoryDevice | undefined {
  const name = str(row.node);
  if (!name) {
    return undefined;
  }
  const attributes: Record<string, string[]> = { type: ["node"], node: [name] };
  if (status !== undefined) {
    if (status.online === 1) {
      attributes.status = ["running"];
    } else if (status.online === 0) {
      attributes.status = ["stopped"];
    }
  }
  const ip = status === undefined ? "" : str(status.ip);
  return {
    externalId: `node/${name}`,
    name,
    endpoints: ip ? [{ kind: "ssh", host: ip, port: 22 }] : [],
    attributes
  };
}

/**
 * ONE call for the whole guest listing: /cluster/resources WITHOUT a type
 * parameter returns guests and nodes in one payload — node rows are filtered
 * below (and, when node import is opted into, re-sourced from /cluster/status,
 * which is the only endpoint carrying their name and address), so no per-type
 * request fan-out exists on this path. The STATUS poll (`fetchStatusImpl`)
 * reads through this same function.
 *
 * Fail closed on shape: the success envelope is `{"data": [...]}`. A payload
 * whose `data` is not an array is corruption, and on BOTH paths an
 * empty-but-valid reading of it would act on devices that were never really
 * gone: the sync's prune phase would delete the servers a mangled listing
 * "no longer has", and a complete status report is applied clear-then-apply
 * (`applyInventoryStatus`), so one mangled 200 body would DELETE every
 * live-state decoration the source has until the next healthy poll. Throwing
 * is the safe answer for each caller: the sync aborts (prune skipped), and
 * `fetchProviderStatus` degrades a poll throw to "no update", retaining
 * decorations.
 */
async function fetchResources(
  transport: ProxmoxTransport,
  baseUrl: string,
  token: string,
  timeoutMs: number
): Promise<unknown[]> {
  const url = new URL(`${baseUrl}${PROXMOX_API_BASE}/cluster/resources`);
  const raw = await rawGet(transport, url, token, timeoutMs);
  if (raw.status < 200 || raw.status >= 300) {
    throwForStatus(raw, url);
  }
  const parsed = parseJsonOrThrow(raw.text, url);
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new InventoryProviderError("protocol", `Response from ${url} has no resource list ("data" is not an array).`);
  }
  return data;
}

/**
 * ONE per-guest GET, best-effort: resolves the parsed envelope on a 2xx answer
 * and `undefined` on ANY failure (non-2xx, network, non-JSON). Per-guest
 * failures are TOLERATED, never surfaced — a guest whose agent is not running
 * (the COMMON case, a verified 500) or whose config the token cannot read must
 * degrade to addressless, not abort a crawl over hundreds of healthy guests.
 * Only an unexpected error shape (a bug, not an API answer) still throws.
 */
async function tryGetJson(transport: ProxmoxTransport, url: URL, token: string, timeoutMs: number): Promise<unknown | undefined> {
  try {
    const raw = await rawGet(transport, url, token, timeoutMs);
    if (raw.status < 200 || raw.status >= 300) {
      return undefined;
    }
    return parseJsonOrThrow(raw.text, url);
  } catch (err) {
    if (err instanceof InventoryProviderError) {
      return undefined;
    }
    throw err;
  }
}

/**
 * ONE /cluster/status GET, best-effort: the parsed `data` array on a healthy
 * answer, `undefined` on ANY failure — non-2xx (403 without Sys.Audit is the
 * EXPECTED answer for a token granted only the guest vocabulary), network,
 * non-JSON, or a `data` that is not an array. Node import degrades over this to
 * addressless, status-less devices — it never aborts the sync: the nodes'
 * existence is already established by the resources payload, and a cluster the
 * token may list but not join addresses for must still sync its guests.
 */
async function fetchClusterStatus(
  transport: ProxmoxTransport,
  baseUrl: string,
  token: string,
  timeoutMs: number
): Promise<unknown[] | undefined> {
  const url = new URL(`${baseUrl}${PROXMOX_API_BASE}/cluster/status`);
  const payload = await tryGetJson(transport, url, token, timeoutMs);
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? data : undefined;
}

/**
 * THE guest-row filter, shared by the sync and the status poll — one function,
 * so the two paths can never drift on their shared rules: a device the sync
 * never created must not get a status, and the poll must not report a guest
 * the sync would have dropped. Guests are `qemu`/`lxc` rows only (node rows
 * share the payload but carry neither name nor address in it); template rows
 * are excluded unless `includeTemplates`; and `includeStopped` gates
 * everything that is not running — including status "unknown", which PVE
 * emits before RRD data exists and which follows the same gate as a stopped
 * row (§Spec).
 *
 * The status poll routes template rows through its OWN branch (see
 * fetchStatusImpl's loop — never status-reported; the vmid is collected into
 * the report's `clearedExternalIds` instead) and passes `includeTemplates`
 * FALSE for the guest rows it does send here; the argument gates only
 * `template === 1` rows, so the value is inert for them and kept false so the
 * filter can never accidentally admit a template on the poll path. The sync honors the opt-in through this same filter. The poll
 * also pins `includeStopped` TRUE for its rows — status reports reality, and
 * the device-set preference belongs to the sync — so the shared rules (type
 * and template gating) stay single-sourced here while the reporting path
 * never omits a guest the device set may still hold.
 */
function isImportableGuestRow(row: Record<string, unknown>, includeStopped: boolean, includeTemplates: boolean): boolean {
  if (row.type !== "qemu" && row.type !== "lxc") {
    return false;
  }
  if (row.template === 1 && !includeTemplates) {
    return false;
  }
  return includeStopped || row.status === "running";
}

/**
 * The two per-guest address fetches (§IP selection): the guest config (NIC
 * MACs, for the §3 interface ordering) and the type's IP endpoint (qemu agent
 * / lxc interfaces). Both best-effort, in this order — the config informs how
 * the agent's interfaces are RANKED, so it must land first. `deadline` is the
 * crawl's shared wall-clock budget; each request's timeout is the
 * FETCH_TIMEOUT ceiling capped by the deadline's REMAINING slice (EVE-NG
 * idiom), so a request issued near the deadline aborts when the budget hits
 * zero instead of running its full 20s past it.
 */
async function resolveGuestIps(
  transport: ProxmoxTransport,
  baseUrl: string,
  token: string,
  row: Record<string, unknown>,
  deadline: number
): Promise<GuestAddressData> {
  const node = encodeURIComponent(str(row.node));
  const kind = row.type === "qemu" || row.type === "lxc" ? row.type : "";
  const vmid = encodeURIComponent(String(row.vmid));
  if (!node || !kind) {
    return { macs: [], ifaces: [] };
  }
  const budget = (): number => Math.min(FETCH_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
  const macs: ProxmoxNetMac[] = [];
  const configUrl = new URL(`${baseUrl}${PROXMOX_API_BASE}/nodes/${node}/${kind}/${vmid}/config`);
  const configPayload = await tryGetJson(transport, configUrl, token, budget());
  if (configPayload !== undefined) {
    macs.push(...parseNetMacs(configPayload));
  }
  // The budget can be spent by the config call; issuing the second request on
  // a zero slice would only burn an instant abort. What is collected stays.
  if (budget() <= 0) {
    return { macs, ifaces: [] };
  }
  const ipUrl = new URL(
    kind === "qemu"
      ? `${baseUrl}${PROXMOX_API_BASE}/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`
      : `${baseUrl}${PROXMOX_API_BASE}/nodes/${node}/lxc/${vmid}/interfaces`
  );
  const ipPayload = await tryGetJson(transport, ipUrl, token, budget());
  const ifaces = ipPayload === undefined ? [] : kind === "qemu" ? parseQemuAgentIfaces(ipPayload) : parseLxcIfaces(ipPayload);
  return { macs, ifaces };
}

async function fetchInventoryImpl(
  transports: ProxmoxTransports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryTree> {
  const transport = selectProxmoxTransport(transports, config);
  const baseUrl = normalizeBaseUrl(String(config.baseUrl ?? ""));
  const token = secrets.apiToken ?? "";
  const template =
    typeof config.folderTemplate === "string" && config.folderTemplate.trim()
      ? config.folderTemplate
      : DEFAULT_FOLDER_TEMPLATE;
  // DEFAULT ON (the field's own comment says why): only an explicit false —
  // never a truthiness test — turns it off, so an absent field keeps the
  // protective default and a stored non-boolean cannot silently drop guests.
  const includeStopped = config.includeStopped !== false;
  const includeTemplates = config.includeTemplates === true;
  // Which family the primary ssh endpoint prefers — read ONCE, here, so every
  // guest of the sync answers to the same preference.
  const family = parsePrimaryIpFamily(config.primaryIpFamily);

  const warnings: string[] = [];
  // INSECURE TLS — this sync ran with certificate verification OFF, so it says
  // so, on the same channel as everything else the user needs to know about the
  // run. Read from the SAME predicate the transport was chosen with, so the
  // disclosure can never disagree with what actually happened on the wire.
  if (proxmoxRunsWithoutCertificateVerification(config)) {
    warnings.push(PROXMOX_INSECURE_TLS_WARNING);
  }

  const rows = await fetchResources(transport, baseUrl, token, FETCH_TIMEOUT_MS);

  const devices: InventoryDevice[] = [];
  // THE SYNC'S CLEAR COLLECTION — the same list the STATUS poll collects (see
  // fetchStatusImpl's template and unknown branches), gathered from the rows
  // this loop OBSERVES so the sync can report the two stateless classes it
  // cannot decorate: converted templates and guests PVE cannot describe yet.
  const clearedExternalIds: string[] = [];
  // Running, non-template guests awaiting their address crawl. Templates never
  // crawl (no agent ever answers for one) and stopped guests cannot answer —
  // the crawl is the only per-guest fan-out this provider makes, so it is
  // gated twice over.
  const crawl: { row: Record<string, unknown>; device: InventoryDevice }[] = [];
  // The DEVICE cap's trip — the ONLY thing that can mark the tree `truncated`
  // (the crawl budgets below warn but never truncate; see the tree
  // composition below) — and the cap's ONE warning must fire once, after both
  // mapping loops have run.
  let capTripped = false;
  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index];
    // Fail closed on a corrupted row rather than skipping it: a silently
    // skipped row would make its server fall out of the engine's present set
    // and be pruned — the same hazard netbox's mapEntry refuses to risk.
    if (typeof raw !== "object" || raw === null) {
      throw new InventoryProviderError(
        "protocol",
        `row ${index} of ${PROXMOX_API_BASE}/cluster/resources is not a JSON object — refusing to sync.`
      );
    }
    const row = raw as Record<string, unknown>;
    // TEMPLATE/UNKNOWN CLEARS — decided by the ROW ALONE, BEFORE the shared
    // filter below (which drops exactly these rows from the device set when
    // the opt-ins say so), mirroring fetchStatusImpl's branches. WHY the
    // device cap does not bound this list: the cap counts EMITTED DEVICES,
    // while template-ness and observed-statelessness are properties of the
    // listing row itself and stay true past it — the poll shares its ONE cap
    // budget because its statuses and clears are one bounded set, and this
    // report carries no statuses at all. The vmid guard is the poll's: a row
    // with no usable vmid names no server, so it clears nothing.
    const isTemplate = row.template === 1;
    const hasUsableVmid =
      (typeof row.vmid === "number" && Number.isFinite(row.vmid)) ||
      (typeof row.vmid === "string" && row.vmid.length > 0);
    if (hasUsableVmid) {
      if (isTemplate) {
        clearedExternalIds.push(String(row.vmid));
      } else if (row.status === "unknown" && isImportableGuestRow(row, true, false)) {
        // includeStopped is pinned TRUE here exactly as on the poll path —
        // observed is observed; the sync's device-set preference must not
        // gate an explicit clear for a guest it may have synced while it
        // still reported a state.
        clearedExternalIds.push(String(row.vmid));
      }
    }
    // Node rows (and storage and the other non-guest types the endpoint mixes
    // in) are ignored here — node import sources them from /cluster/status
    // when opted in. The type/template/includeStopped gates are the SHARED
    // `isImportableGuestRow`, so the status poll's guest rows track the device
    // set this loop produces (template rows are the one REPORTING divergence —
    // neither path ever status-reports one: the poll collects its vmid into
    // `clearedExternalIds` (see fetchStatusImpl's template branch), and this
    // loop now collects the same list above for the tree's own clear-only
    // report).
    if (!isImportableGuestRow(row, includeStopped, includeTemplates)) {
      continue;
    }
    // HARD CAP, client-side, counted over EMITTED DEVICES — guests here, plus
    // the node branch below when includeNodes is on (controller ruling): a cap
    // that only counted guests would let node devices append past it. Beyond
    // the cap rows are simply not mapped, and `truncated` makes the engine skip
    // pruning: a capped fetch must never be read as "these devices no longer
    // exist at the source".
    if (devices.length >= HARD_CAP) {
      capTripped = true;
      continue;
    }
    const device = mapGuest(row, template);
    devices.push(device);
    if (row.status === "running" && row.template !== 1) {
      crawl.push({ row, device });
    }
  }

  // NODE IMPORT (§Fetch) — strictly `=== true`, never a truthiness test: the
  // form stores a real boolean, and an absent field must read as off (the same
  // strictness the insecure-TLS opt-in is pinned to; a restored backup's "true"
  // string must not switch a second request on). The resources payload's node
  // rows establish existence only; names and addresses come from ONE
  // /cluster/status call joined by node name, because those rows carry neither
  // member. Any /cluster/status failure degrades the nodes to addressless and
  // status-less rather than aborting — the guests above must still sync.
  if (config.includeNodes === true) {
    const statusEntries = await fetchClusterStatus(transport, baseUrl, token, FETCH_TIMEOUT_MS);
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of statusEntries ?? []) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const name = str(e.name);
      if (e.type === "node" && name) {
        byName.set(name, e);
      }
    }
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const row = raw as Record<string, unknown>;
      if (row.type !== "node") {
        continue;
      }
      // Same cap the guest loop enforces, over the SAME devices array: nodes
      // only fill the room the guests left, and once it is spent the remaining
      // nodes must read as TRUNCATED (never pruned), not as vanished.
      if (devices.length >= HARD_CAP) {
        capTripped = true;
        break;
      }
      const device = mapNode(row, byName.get(str(row.node)));
      if (device) {
        devices.push(device);
      }
    }
  }

  // ONE warning for the device cap, whichever loop tripped it. It names
  // DEVICES because that is what the cap counts (guests, plus nodes when
  // includeNodes is on) — a "guests" wording would misreport the mixed case —
  // and the node loop breaks on the check above rather than pushing its own
  // line, so a guest-side trip can never produce two warnings.
  if (capTripped) {
    warnings.push(`Truncated at ${HARD_CAP} devices — narrow the source.`);
  }

  // GUEST ADDRESS CRAWL (§IP selection) — running, non-template guests only,
  // under TWO budgets: MAX_IP_GUESTS caps the request fan-out and a shared
  // wall-clock deadline caps the crawl's time (EVE-NG idiom). Either budget
  // stopping the crawl leaves the untouched guests ADDRESSLESS — never
  // dropped — but sets NO tree flag: the device listing above is complete
  // either way, so pruning over it stays correct (see the tree composition
  // below). Only the warning says what happened.
  if (crawl.length > 0) {
    const deadline = Date.now() + CRAWL_DEADLINE_MS;
    let crawled = 0;
    let ipCapped = false;
    let deadlineHit = false;
    for (const guest of crawl) {
      if (crawled >= MAX_IP_GUESTS) {
        ipCapped = true;
        break;
      }
      if (Date.now() > deadline) {
        deadlineHit = true;
        break;
      }
      crawled++;
      const data = await resolveGuestIps(transport, baseUrl, token, guest.row, deadline);
      fillGuestEndpoints(guest.device, data, family);
      // A guest whose requests stalled to the deadline is already addressless;
      // the clock check here (not only at the loop top) keeps the LAST guest's
      // stall from going unnoticed.
      if (Date.now() > deadline) {
        deadlineHit = true;
        break;
      }
    }
    if (ipCapped) {
      warnings.push(
        `Address crawl stopped at ${MAX_IP_GUESTS} guests — the remaining guests arrived without addresses and will pick them up on a later sync.`
      );
    }
    if (deadlineHit) {
      warnings.push(
        `Address crawl stopped after ${Math.round(CRAWL_DEADLINE_MS / 1000)}s — the remaining guests arrived without addresses and will pick them up on a later sync.`
      );
    }
  }

  // THE SYNC'S CLEAR-ONLY REPORT — attached when, and ONLY when, the listing
  // pass observed rows that must lose a stale decoration; the empty case stays
  // ABSENT (the poll's empty-cleared omission idiom) so a sync that observed
  // no conversions keeps the exact "sync carries no status" behavior §4.12.8
  // documents.
  //
  // WHY `truncated` MUST be true here: the report carries NO states at all, so
  // as a COMPLETE report its clear-then-apply would wipe this source's ENTIRE
  // runtime status. As a TRUNCATED (merging) report it removes exactly the
  // observed-but-stateless ids and retains every other guest's decoration —
  // which is precisely the truth (the sync observed these rows; it reports no
  // states). The merge also deliberately preserves any earlier refresh's
  // partial warning: the sync apply's truncated check only gates the
  // `statusAppliedGeneration` invalidation (inventoryCommands.ts), it never
  // warns, so there is nothing here to silence. The engine needs no change —
  // `applyInventoryStatus` already honors cleared lists under merge.
  // `truncated` is DEVICE-LEVEL ONLY: it claims device ROWS were omitted from
  // the tree, and only the hard cap can omit rows — the device listing is ONE
  // complete /cluster/resources call, and the crawl budgets bound address
  // RESOLUTION, not device OBSERVATION. computeSyncPlan reads `truncated` as
  // "the device listing is incomplete" and skips the prune phase over it;
  // pruning compares against the complete listing, so it is safe (and
  // correct) to prune after a crawl-limited sync.
  //
  // NOT the same flag as `fetchStatusImpl`'s `truncated` (device cap /
  // node-join failure ⇒ merge semantics) or the clear-only report's
  // `status.truncated` built just below (merge semantics for
  // observed-but-stateless rows): those are STATUS-report flags with
  // different meanings — do not unify them with this one.
  const tree: InventoryTree = { contractVersion: 1, devices, warnings, truncated: capTripped || undefined };
  if (clearedExternalIds.length > 0) {
    tree.status = { contractVersion: 1, statuses: {}, truncated: true, clearedExternalIds };
  }
  return tree;
}

/**
 * LIVE STATUS (§Status) — the running/stopped state of everything the source
 * can see, keyed by the SAME externalIds `fetchInventory` uses (bare vmid for
 * guests, `node/<name>` for nodes), so each status maps onto the server it
 * belongs to.
 *
 * ONE /cluster/resources call for the guests and — only when node import is
 * opted into — ONE /cluster/status for the nodes. There is deliberately NO
 * per-guest crawl here: the poll runs while the Command Center is visible,
 * against a cluster that may be answering for a hundred guests, and every
 * state it needs already sits on the listing rows. The crawl's config/agent
 * fan-out exists to find ADDRESSES, which a status report never carries.
 *
  * Guests: `status` maps running/stopped; a row with status "unknown" (PVE
  * emits it for a guest it OBSERVED, before RRD data exists) is OMITTED rather
  * than given an invented state, and its vmid is explicitly CLEARED — the row
  * was seen and genuinely has no state, the same class as a converted
  * template, so a previously status-bearing guest loses its stale decoration
  * even under a merging report, where a plain omission would retain it (its
  * Start/Stop menu included) for as long as the report keeps merging. On a
  * COMPLETE report the apply is clear-then-apply (`applyInventoryStatus`),
  * which drops that decoration anyway; the explicit clear keeps the two report
  * shapes consistent. Retaining prior state for absent entries is a property
  * of TRUNCATED reports only. The sync's
 * guest filters apply to guest rows (`isImportableGuestRow`); template rows
 * route through their OWN branch and are NEVER status-reported — their vmids
 * are collected into the report's `clearedExternalIds` instead, EVERY template
 * row regardless of the opt-in (which governs only the SYNC device set), so a
 * guest converted into a template loses its stale decoration explicitly even
 * under a merging report. The full truthfulness/merge argument sits on the
 * loop's template branch. The SYNC device set is unchanged (templates still
 * import as addressless placeholders when includeTemplates is on), and the
 * sync now collects the SAME clears onto its own clear-only tree report —
 * see fetchInventoryImpl's loop. NO console fields:
 * the listing rows carry nothing to fill them with, and the console-heal path
 * those fields feed exists for providers whose consoles actually move
 * (EVE-NG's telnet).
 *
 * Nodes: `online` 1/0 from the /cluster/status join — the ONLY endpoint
 * carrying the numeric flag. The resources payload's node-row `status`
 * ("online"/"offline" strings) is a degraded, version-dependent shape and is
  * never read here; an entry whose `online` is absent or unrecognizable
  * invents no state and is omitted — the omit-only half of the guest
  * "unknown" rule (a node entry is not an observed guest row, so it does not
  * join the cleared list).
 *
 * TRUNCATION: two sources. The same HARD_CAP as the sync, in the same order
 * (guests first, then nodes) — entries beyond it are simply not collected;
 * and, when node import is on, a FAILED /cluster/status join — the poll
 * reached the guests but not the nodes, so the report is partial. Either
 * flag makes applyInventoryStatus MERGE, retaining prior state for whatever
 * the report omits while still applying the entries it carries. A COMPLETE
 * report is the opposite — authoritative, clear-then-apply — which is
 * exactly why a mangled payload must fail closed through `fetchResources`
 * rather than degrade to an empty-but-valid report. There is deliberately NO
 * wall-clock deadline: the path makes at most two sequential requests, each
 * bounded by its own timeout, so a stall surfaces as a thrown network error
 * (degraded by the sanctioned caller to "no update") rather than as a
 * partial report — there is no fan-out whose partial progress a deadline
 * would salvage.
 */
async function fetchStatusImpl(
  transports: ProxmoxTransports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryStatusReport> {
  const transport = selectProxmoxTransport(transports, config);
  const baseUrl = normalizeBaseUrl(String(config.baseUrl ?? ""));
  const token = secrets.apiToken ?? "";
  // The opt-in reads with the same strictness as the sync: only `=== true`
  // turns the node join on (a restored backup's "true" string must not switch
  // a request on). includeStopped is deliberately NOT read here — see the
  // guest branch below — and includeTemplates is not read EITHER: a template
  // row is never status-reported and always clears, whatever the sync opt-in
  // says (see the template branch below).

  // The sync's fail-closed listing read, shared: on the poll path the throw is
  // what protects the decorations — see fetchResources's doc comment.
  const rows = await fetchResources(transport, baseUrl, token, FETCH_TIMEOUT_MS);

  const statuses: Record<string, InventoryDeviceStatus> = {};
  const clearedExternalIds: string[] = [];
  let entryCount = 0;
  let capTripped = false;
  // The /cluster/status join, when node import is on, can fail (403 without
  // Sys.Audit, network, non-array payload) — see the branch below.
  let joinFailed = false;
  for (const raw of rows) {
    // A corrupted row is SKIPPED here where the sync throws. The asymmetry is
    // bounded loss: a sync skip would drop a device from the engine's present
    // set and the prune phase would delete its server, so the sync fails
    // closed; here a skip costs only this entry's decoration, and only on a
    // COMPLETE report (clear-then-apply) — one garbage row must not blind a
    // poll that successfully read a thousand good ones.
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const row = raw as Record<string, unknown>;
    // Templates are decided by the row ALONE, before the shared filter, and
    // are NEVER status-reported. WHY round 2's `{ state: "stopped" }` rule
    // died: per-vmid template-ness is invisible to the apply's control gate —
    // a template's bare numeric vmid passes canControlNode — so a KNOWN status
    // on a template row lights the Start/Stop menu that PVE refuses to serve.
    // A template therefore carries no status at all, and the never-act-blind
    // rule keeps every control menu off its row. What replaces the constant is
    // the report's `clearedExternalIds`: EVERY template row's vmid — regardless
    // of includeTemplates, which governs only the SYNC device set, because the
    // template need not be in it for the server it was synced as to still
    // exist — is collected here, and applyInventoryStatus removes that id's
    // entry even under a MERGING (truncated) report, where a merely-omitted
    // entry is retained. That is the converted-guest case: a VM turned into a
    // template keeps its prior "running" decoration on every merging report
    // unless the report names the vmid as explicitly gone. The apply ignores
    // ids matching no owned server, so an unsynced template's cleared id
    // cannot light anything. Cleared entries share the ONE hard-cap budget
    // with statuses — a template beyond the cap keeps its stale highlight
    // exactly as long as a guest beyond it does, the same partial-report
    // honesty. RESIDUAL, none: with no status the Start/Stop menu never
    // appears for a template. The SYNC device set is unchanged —
    // isImportableGuestRow still honors includeTemplates there — and the sync
    // collects the same clears for its own clear-only tree report (see
    // fetchInventoryImpl's loop).
    const isTemplate = row.template === 1;
    if (!isTemplate && !isImportableGuestRow(row, true, false)) {
      // includeStopped is pinned TRUE — on the STATUS call only; the sync
      // keeps honoring the config. WHY: status reports reality (EVE-NG's
      // precedent: all nodes are reported; the tree decides), and
      // includeStopped is a SYNC device-set preference, not a reporting
      // filter. With the orphan/keep prune policies a retained stopped server
      // must show truthful stopped + Start; with delete the apply ignores
      // statuses for unmatched servers (engine-side gate in nexusCore), so
      // reporting a guest the sync skipped cannot light anything.
      continue;
    }
    if (entryCount >= HARD_CAP) {
      capTripped = true;
      continue;
    }
    const hasUsableVmid =
      (typeof row.vmid === "number" && Number.isFinite(row.vmid)) ||
      (typeof row.vmid === "string" && row.vmid.length > 0);
    if (!hasUsableVmid) {
      continue;
    }
    if (isTemplate) {
      clearedExternalIds.push(String(row.vmid));
    } else if (row.status === "unknown") {
      // Round 5 (P2) — "unknown" is what PVE reports for a row it OBSERVED
      // (the guest is listed; only its RRD data has not caught up), so this
      // row is the same class as a converted template: seen, explicitly
      // stateless. Merely omitting it left a previously status-bearing guest
      // holding its stale running/stopped — and the Start/Stop menu riding
      // it — on every MERGING report (e.g. for as long as the Sys.Audit join
      // keeps failing), potentially indefinitely; so its vmid is cleared
      // explicitly, the template branch's mechanism, under the same shared
      // cap budget (beyond the cap the check above has already skipped it,
      // the same partial-report honesty as any unobserved row). Any OTHER
      // unusable status stays a plain skip: PVE emits only
      // running/stopped/unknown, so anything else is a payload shape we
      // cannot vouch for, not an observed state.
      clearedExternalIds.push(String(row.vmid));
    } else {
      // A guest row's status field is trusted only when it names a real
      // state; "unknown" (handled above) invents nothing.
      if (row.status !== "running" && row.status !== "stopped") {
        continue;
      }
      statuses[String(row.vmid)] = { state: row.status };
    }
    entryCount++;
  }

  // Node statuses ride the SAME opt-in as the node import, gated with the same
  // `=== true` strictness, and the join call is the same best-effort
  // fetchClusterStatus the sync uses — a 403 without Sys.Audit fails the join,
  // not the poll. But a failed join makes the report PARTIAL, not complete
  // (controller ruling): we reached the guests and not the nodes, and a
  // complete report is applied clear-then-apply, which would drop every
  // node's decoration until the join answered again. Flagging `truncated`
  // makes applyInventoryStatus MERGE instead — guest updates still apply,
  // and the nodes' prior state is retained for the entries the report omits.
  // A PRESENT entry with no usable `online` still invents nothing: it is
  // omitted — omit-only, unlike an unknown guest row (observed, so cleared):
  // a node entry here is not a guest row and may match no guest at all.
  if (config.includeNodes === true) {
    const entries = await fetchClusterStatus(transport, baseUrl, token, FETCH_TIMEOUT_MS);
    // fetchClusterStatus's `undefined` is its failure sentinel (non-2xx,
    // network, non-JSON, non-array data); a healthy EMPTY array is a real
    // answer, not a failure.
    if (entries === undefined) {
      joinFailed = true;
    }
    for (const entry of entries ?? []) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const name = str(e.name);
      if (e.type !== "node" || !name) {
        continue;
      }
      if (entryCount >= HARD_CAP) {
        capTripped = true;
        break;
      }
      if (e.online === 1) {
        statuses[`node/${name}`] = { state: "running" };
        entryCount++;
      } else if (e.online === 0) {
        statuses[`node/${name}`] = { state: "stopped" };
        entryCount++;
      }
    }
  }

  // The key is OMITTED when complete rather than the sync's `|| undefined`
  // idiom: the downstream validator rejects ANY report carrying a non-boolean
  // `truncated` — including one present with the value undefined — and would
  // degrade the whole poll to "no update". (The sync TREE's validator instead
  // tolerates a present-but-undefined key, so the idiom is safe there.)
  const report: InventoryStatusReport = { contractVersion: 1, statuses };
  // Same omission idiom for the cleared list: absent ⇒ a no-op downstream, and
  // an empty list asserts nothing an absent one doesn't.
  if (clearedExternalIds.length > 0) {
    report.clearedExternalIds = clearedExternalIds;
  }
  if (capTripped || joinFailed) {
    report.truncated = true;
  }
  return report;
}

/** The control poll's cadence beat. A `setTimeout` promise, so tests drive it with fake timers. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NODE CONTROL (§Control) — start or stop ONE guest, keyed by the bare vmid
 * externalId `fetchInventory`/`fetchStatus` emit. Unlike `fetchStatusImpl`,
 * failures PROPAGATE (contract note, models/inventory.ts:346-355): the caller
 * issued a mutation and must learn when it did not happen.
 *
 * The shape this walks, verified live: the vmid alone does not name node+type,
 * so a fresh `?type=vm` lookup resolves them (a guest can migrate between
 * syncs — the last tree is never trusted); the POST answers HTTP 200
 * IMMEDIATELY with `{"data":"UPID:…"}`, and the task's verdict is visible ONLY
 * by polling the task endpoint — a POST 200 says nothing about success ("VM 105
 * already running" travels as a stopped task with a non-OK `exitstatus`, and a
 * success task carries `exitstatus: "OK"`). Nodes (`"node/<name>"` externalIds)
 * are refused before any HTTP call: PVE nodes are not start/stop targets from
 * Nexus. A deadline expiry reports honestly — the task continues server-side.
 */
async function controlNodeImpl(
  transports: ProxmoxTransports,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets,
  externalId: string,
  action: "start" | "stop"
): Promise<void> {
  if (externalId.startsWith("node/")) {
    throw new InventoryProviderError(
      "protocol",
      `Nodes cannot be started or stopped from Nexus ("${externalId}" is a Proxmox node).`
    );
  }
  const transport = selectProxmoxTransport(transports, config);
  const baseUrl = normalizeBaseUrl(String(config.baseUrl ?? ""));
  const token = secrets.apiToken ?? "";

  const lookupUrl = new URL(`${baseUrl}${PROXMOX_API_BASE}/cluster/resources?type=vm`);
  const lookupRaw = await rawGet(transport, lookupUrl, token, FETCH_TIMEOUT_MS);
  if (lookupRaw.status < 200 || lookupRaw.status >= 300) {
    throwForStatus(lookupRaw, lookupUrl);
  }
  // Fail-closed like the sync's listing read (fetchResources): a mangled
  // payload must not read as "the guest is gone".
  const lookupParsed = parseJsonOrThrow(lookupRaw.text, lookupUrl);
  const rows = (lookupParsed as { data?: unknown }).data;
  if (!Array.isArray(rows)) {
    throw new InventoryProviderError("protocol", `Response from ${lookupUrl} has no resource list ("data" is not an array).`);
  }
  let target: { node: string; kind: "qemu" | "lxc" } | undefined;
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (String(row.vmid) !== externalId) {
      continue;
    }
    // A row matching the vmid but carrying an unusable node/type folds into
    // "not found" — nothing actionable could be built from it either way.
    if ((row.type === "qemu" || row.type === "lxc") && str(row.node)) {
      target = { node: row.node as string, kind: row.type };
      break;
    }
  }
  if (!target) {
    throw new InventoryProviderError(
      "protocol",
      `Guest ${externalId} is no longer present in the Proxmox cluster — re-sync the source and try again.`
    );
  }

  const actionUrl = new URL(
    `${baseUrl}${PROXMOX_API_BASE}/nodes/${encodeURIComponent(target.node)}/${target.kind}/${encodeURIComponent(externalId)}/status/${action}`
  );
  const actionRaw = await rawPost(transport, actionUrl, token, FETCH_TIMEOUT_MS);
  if (actionRaw.status < 200 || actionRaw.status >= 300) {
    // 401/403 surface as auth errors here — the mapping is the SAME one every
    // path uses; control just does not swallow the result.
    throwForStatus(actionRaw, actionUrl);
  }
  const actionParsed = parseJsonOrThrow(actionRaw.text, actionUrl);
  const upid = (actionParsed as { data?: unknown }).data;
  if (typeof upid !== "string" || !upid.startsWith("UPID:")) {
    throw new InventoryProviderError(
      "protocol",
      `Proxmox did not return a task id for the ${action} of guest ${externalId} — the request cannot be tracked.`
    );
  }

  const taskUrl = new URL(
    `${baseUrl}${PROXMOX_API_BASE}/nodes/${encodeURIComponent(target.node)}/tasks/${encodeURIComponent(upid)}/status`
  );
  // Wall-clock deadline, not a poll counter: a slow poll path must not stretch
  // the wait past what the user was told. The deadline is checked BEFORE each
  // request and the request's timeout is capped by the remaining budget (the
  // address crawl's min(timeout, remaining) idiom): a poll issued near the
  // limit must abort with the budget instead of running its full 20s past the
  // deadline, and a spent budget ends the poll without another request. The
  // sleep helper uses setTimeout, so under vitest fake timers the clock and
  // the cadence advance together.
  const deadline = Date.now() + CONTROL_DEADLINE_MS;
  const deadlineError = () =>
    new InventoryProviderError(
      "protocol",
      `Proxmox ${action} of guest ${externalId} is still running after ${CONTROL_DEADLINE_MS / 1000}s — the task continues on the PVE node; check its task log there.`
    );
  while (true) {
    await sleep(CONTROL_POLL_INTERVAL_MS);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw deadlineError();
    }
    const taskRaw = await rawGet(transport, taskUrl, token, Math.min(FETCH_TIMEOUT_MS, remaining));
    if (taskRaw.status < 200 || taskRaw.status >= 300) {
      throwForStatus(taskRaw, taskUrl);
    }
    const taskParsed = parseJsonOrThrow(taskRaw.text, taskUrl);
    const task = (taskParsed as { data?: unknown }).data;
    if (typeof task !== "object" || task === null) {
      throw new InventoryProviderError("protocol", `Task status response from ${taskUrl} carries no task payload.`);
    }
    const t = task as Record<string, unknown>;
    if (t.status === "stopped") {
      if (t.exitstatus === "OK") {
        return;
      }
      // The task's own message is the only truthful explanation available —
      // carry it verbatim (verified live: "VM 105 already running").
      throw new InventoryProviderError(
        "protocol",
        `Proxmox ${action} of guest ${externalId} failed: ${str(t.exitstatus) || "the task finished without an exit status"}.`
      );
    }
    // A response that consumed the whole remaining budget reports at the
    // deadline, not a cadence beat later — the pre-request check above cannot
    // see budget an in-flight request spends.
    if (Date.now() >= deadline) {
      throw deadlineError();
    }
  }
}

/**
 * INSECURE TLS — the insecure transport is a SECOND injectable so a test can
 * assert which one a given config selects, rather than inferring it. Default
 * construction does no I/O and opens no socket, so building it eagerly here
 * costs nothing even for the (usual) source that never selects it.
 */
export function createProxmoxProvider(
  fetchImpl: typeof fetch = fetch,
  insecureFetchImpl: typeof fetch = createInsecureHttpsFetch()
): InventoryProvider {
  const transports: ProxmoxTransports = { standard: fetchImpl, insecure: insecureFetchImpl };
  return {
    id: PROXMOX_PROVIDER_ID,
    label: "Proxmox",
    configFields: PROXMOX_CONFIG_FIELDS,
    // The filter keys this provider's device `attributes` can carry — see the
    // `attributeKeys` contract on `InventoryProvider`. `tag` is the filter key;
    // the attribute is `tags` (the shared parser aliases them), and `name` is
    // the provider-agnostic reserved key. The `ip*`/`mac`/`ifname` sets are
    // filled by the guest address crawl (running guests only), so a filter on
    // them matches nothing on a stopped guest — the vocabulary stays declared
    // in one place regardless.
    attributeKeys: ["type", "node", "pool", "tag", "status", "ip", "ip6", "mac", "ifname", "name"],
    instanceKey(config: InventorySourceValues): string | undefined {
      return proxmoxInstanceKey(config);
    },
    async testConnection(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void> {
      const baseUrl = normalizeBaseUrl(String(config.baseUrl ?? ""));
      const token = secrets.apiToken ?? "";
      await testConnectionImpl(selectProxmoxTransport(transports, config), baseUrl, token);
    },
    // The contract REQUIRES this member; the implementation fail-closes on
    // corrupted payloads and on its own hard cap (see `fetchInventoryImpl`) —
    // an empty tree would otherwise read as "the source legitimately has no
    // devices" and the prune phase would act on that.
    fetchInventory(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryTree> {
      return fetchInventoryImpl(transports, config, secrets);
    },
    // The optional status member (§Status) — the poll path's one-call report.
    fetchStatus(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryStatusReport> {
      return fetchStatusImpl(transports, config, secrets);
    },
    // The optional control member (§Control) — and the deliberate contrast
    // with fetchStatus above: this MUTATES the source, so a failure propagates
    // to the user (models/inventory.ts:346-355) rather than degrading to a
    // no-op the way a poll's failure does.
    controlNode(
      config: InventorySourceValues,
      secrets: InventorySourceSecrets,
      externalId: string,
      action: "start" | "stop"
    ): Promise<void> {
      return controlNodeImpl(transports, config, secrets, externalId, action);
    },
    // The device-aware control gate (§Control, P2 review fix) — bare vmids
    // only: controlNodeImpl refuses `node/<name>` externalIds with a protocol
    // error before any HTTP call, and the menu must never offer what the
    // implementation rejects. An imported cluster node keeps its
    // running/offline decoration; it just never gets a Start/Stop entry.
    canControlNode(externalId: string): boolean {
      return /^\d+$/.test(externalId);
    }
  };
}
