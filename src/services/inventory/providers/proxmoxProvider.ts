import { ADVANCED_SECTION_LABEL } from "../../../ui/formTypes";
import { certificateFailureMessage, redirectNotFollowedMessage, type CertificateHintContext } from "../certificateHints";
import { createInsecureHttpsFetch } from "../insecureFetch";
import {
  InventoryProviderError,
  type InventoryConfigField,
  type InventoryDevice,
  type InventoryProvider,
  type InventorySourceSecrets,
  type InventorySourceValues,
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

/** Coerce a stored config value to a known preference; anything else is `auto`,
 *  so an absent field or a hand-mangled value is zero behaviour change
 *  bit-for-bit. */
export function parsePrimaryIpFamily(raw: unknown): PrimaryIpFamily {
  return raw === "prefer-ipv4" || raw === "prefer-ipv6" ? raw : "auto";
}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  // The /api strip is NetBox baggage kept on purpose: nothing in PVE's URL
  // space ends in a bare "/api" (the API root is /api2/json), so the strip is
  // inert here — and a stray "/api" suffix pasted onto a PVE host folds onto
  // the same instance key and the same request spelling as the bare host
  // instead of fragmenting into a deployment of its own.
  url = url.replace(/\/api$/i, "");
  return url.replace(/\/+$/, "");
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

async function rawGet(transport: ProxmoxTransport, url: URL, token: string, timeoutMs: number): Promise<RawResponse> {
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

/**
 * One guest row → one InventoryDevice, ADDRESSLESS: endpoints are filled by
 * the per-guest address crawl in a later change, and until then an empty array
 * is the honest answer. Same defensive rule as netbox's `mapEntry`: a row
 * without a usable vmid has no stable externalId, and emitting a fabricated
 * one (`"undefined"`) would poison the adoption identity every kept server
 * carries — so the row aborts the sync loudly instead of quietly vanishing
 * (a silently skipped row reads as "gone at the source" and gets its server
 * pruned).
 */
function mapGuest(row: Record<string, unknown>, template: string): InventoryDevice {
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
  return {
    externalId: String(row.vmid),
    name,
    folderPath: renderFolderTemplate(template, renderGuestVars(row)),
    // Endpoints arrive with the address crawl. A NAMELESS guest must keep no
    // endpoint even then (netbox convention): it cannot become a server, so an
    // address on it would only invite a half-mapped placeholder.
    endpoints: [],
    attributes: Object.keys(attrs).length > 0 ? attrs : undefined
  };
}

/**
 * ONE call for the whole guest listing: /cluster/resources WITHOUT a type
 * parameter returns guests and nodes in one payload — node rows are filtered
 * below (and, when node import arrives, re-sourced from /cluster/status, which
 * is the only endpoint carrying their name and address), so no per-type
 * request fan-out exists on this path.
 *
 * Fail closed on shape: the success envelope is `{"data": [...]}`. A payload
 * whose `data` is not an array is corruption — iterating a truthy object (or
 * reading null as empty) would present a mangled answer as "the source
 * legitimately has no devices", and the prune phase would act on exactly that.
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
    throw new InventoryProviderError(
      "protocol",
      `Response from ${url} has no resource list ("data" is not an array) — refusing to sync.`
    );
  }
  return data;
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
  let truncated = false;
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
    // Guests only: qemu VMs and lxc containers. Node rows share this payload
    // but carry neither name nor address in it — they are ignored here (node
    // import sources them from /cluster/status when opted in), as are storage
    // and the other non-guest types the endpoint mixes in.
    if (row.type !== "qemu" && row.type !== "lxc") {
      continue;
    }
    if (row.template === 1 && !includeTemplates) {
      continue;
    }
    // includeStopped gates everything that is not running — including status
    // "unknown", which follows the same gate as a stopped row (§Spec).
    if (!includeStopped && row.status !== "running") {
      continue;
    }
    // HARD CAP, client-side. Beyond the cap guests are simply not mapped, and
    // `truncated` makes the engine skip pruning: a capped fetch must never be
    // read as "these guests no longer exist at the source".
    if (devices.length >= HARD_CAP) {
      truncated = true;
      continue;
    }
    devices.push(mapGuest(row, template));
  }
  if (truncated) {
    warnings.push(`Truncated at ${HARD_CAP} guests — narrow the source.`);
  }

  return { contractVersion: 1, devices, warnings, truncated: truncated || undefined };
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
    // declared even though the address work arrives later: a key nobody filters
    // on warns nobody, and the vocabulary stays in one place.
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
    }
  };
}
