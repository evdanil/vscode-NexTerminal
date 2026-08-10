import {
  InventoryProviderError,
  type InventoryConfigField,
  type InventoryDevice,
  type InventoryProvider,
  type InventorySourceSecrets,
  type InventorySourceValues,
  type InventoryTree
} from "../../../models/inventory";

export const NETBOX_PROVIDER_ID = "netbox";
export const DEFAULT_FOLDER_TEMPLATE = "{site}/{rack}";

const PAGE_LIMIT = 250;
const HARD_CAP = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
const TEST_CONNECTION_TIMEOUT_MS = 10_000;
// F11 — Nexus owns pagination; a user-supplied filter that also sets these would
// silently fight our own offset math (or leak `brief` mode past what the mapper expects).
const RESERVED_FILTER_KEYS = new Set(["limit", "offset", "brief"]);

const NETBOX_CONFIG_FIELDS: InventoryConfigField[] = [
  {
    id: "baseUrl",
    label: "NetBox Base URL",
    type: "string",
    required: true,
    placeholder: "https://netbox.example.com"
  },
  {
    id: "apiToken",
    label: "API Token",
    type: "password",
    required: true,
    description: "A NetBox API token with read access to DCIM (and Virtualization, if included)."
  },
  {
    id: "filter",
    label: "Device Filter",
    type: "string",
    required: false,
    placeholder: "status=active&site=syd",
    description: "Query string appended to the devices request; not applied to virtual machines."
  },
  {
    id: "folderTemplate",
    label: "Folder Template",
    type: "string",
    required: false,
    placeholder: DEFAULT_FOLDER_TEMPLATE,
    description: "Placeholders: {site} {location} {rack} {role} {tenant}. Empty segments are dropped."
  },
  {
    id: "includeVms",
    label: "Include Virtual Machines",
    type: "boolean",
    required: false,
    description: "Also fetch NetBox virtual machines (no rack/location — site/role/tenant only)."
  },
  {
    // PRIMARY-IP FAMILY PREFERENCE (issue #48 PR-E, backlog #3) — which address
    // family to import when a device carries both an IPv4 and an IPv6 primary IP.
    // `auto` (the default, and the first option so legacy sources render/store it)
    // reads NetBox's own `primary_ip`, byte-identical to pre-PR-E behaviour —
    // which yields IPv6 when both exist. `prefer-ipv4`/`prefer-ipv6` read
    // `primary_ip4`/`primary_ip6` from the SAME device rows (no extra API call),
    // each falling back to `primary_ip` when its family-specific field is absent.
    id: "primaryIpFamily",
    label: "Primary IP Family",
    type: "select",
    required: false,
    options: [
      { label: "Automatic (NetBox primary IP)", value: "auto" },
      { label: "Prefer IPv4", value: "prefer-ipv4" },
      { label: "Prefer IPv6", value: "prefer-ipv6" }
    ],
    description:
      "Which address to import when a device has both IPv4 and IPv6 primary IPs. Automatic uses NetBox's own primary IP (IPv6 when both exist). Prefer options fall back to the primary IP when the device has no address in that family. The out-of-band (BMC) address is never affected."
  }
];

/** PRIMARY-IP FAMILY PREFERENCE (PR-E) — the address family a source prefers. */
type PrimaryIpFamily = "auto" | "prefer-ipv4" | "prefer-ipv6";

/** Coerce a stored config value to a known preference; anything else is `auto`,
 *  so an absent field (legacy source) or a hand-mangled value is zero behaviour
 *  change bit-for-bit. */
function parsePrimaryIpFamily(raw: unknown): PrimaryIpFamily {
  return raw === "prefer-ipv4" || raw === "prefer-ipv6" ? raw : "auto";
}

/**
 * PRIMARY-IP FAMILY PREFERENCE (PR-E) — reads the preferred address off a device
 * row, from the SAME `{ address?: unknown }`-shaped fields NetBox already returns
 * (`primary_ip`, `primary_ip4`, `primary_ip6`) — no new API call. Each family
 * preference falls back to `primary_ip` when its family-specific field carries no
 * usable string address, so a device that has only `primary_ip` never loses its
 * endpoint under a `prefer-*` preference. `auto` reads `primary_ip` directly, so
 * the returned value is byte-identical to pre-PR-E behaviour. Keeps the defensive
 * shape the previous single-field read used; CIDR stripping stays with the caller.
 */
function readPrimaryAddress(obj: Record<string, unknown>, family: PrimaryIpFamily): unknown {
  const addressOf = (key: string): unknown => {
    const field = obj[key] as { address?: unknown } | null | undefined;
    return field && typeof field === "object" ? field.address : undefined;
  };
  // H1 (N2) — the family field counts as PRESENT only when it carries a
  // non-empty (trimmed) string. A present-but-empty `primary_ip4: { address: "" }`
  // is not a usable endpoint, so it must fall back to `primary_ip` rather than
  // returning "" and dropping the SSH endpoint. NetBox does not emit that shape
  // today; this hardens the theoretical case without changing any real read.
  const usableAddress = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const primary = addressOf("primary_ip");
  if (family === "prefer-ipv4") {
    const v4 = addressOf("primary_ip4");
    return usableAddress(v4) ? v4 : primary;
  }
  if (family === "prefer-ipv6") {
    const v6 = addressOf("primary_ip6");
    return usableAddress(v6) ? v6 : primary;
  }
  // `auto` reads `primary_ip` directly — byte-identical to pre-PR-E behaviour.
  return primary;
}

/**
 * ALTERNATE HOST (issue #48, Phase 2) — reads the NON-PREFERRED IP-family
 * address off a device row, the counterpart of `readPrimaryAddress` above, from
 * the SAME `primary_ip4` / `primary_ip6` fields (no new API call). Returned
 * CIDR-stripped, or `undefined` when the device offers no usable second address.
 *
 * The rule (user-confirmed, issue #48):
 *  - `prefer-ipv4` → primary is `primary_ip4`, so the alternate is `primary_ip6`.
 *  - `prefer-ipv6` → primary is `primary_ip6`, so the alternate is `primary_ip4`.
 *  - `auto` → primary is NetBox's own `primary_ip`, so the alternate is the OTHER
 *    family field — whichever of `primary_ip4`/`primary_ip6` differs from the
 *    primary host. Both are considered in order and the first that differs wins,
 *    which lands on `primary_ip4` when `primary_ip` is the v6 and on
 *    `primary_ip6` when it is the v4 — the concrete opposite family in each case.
 *
 * Only a present, `stripCidr`-non-empty address that is DISTINCT from
 * `primaryHost` is an alternate: a single-IP device (or one whose family fields
 * collapse to the same address the primary already carries) gets none, so no
 * spurious second SSH endpoint is emitted. `oob_ip` is a single field with no
 * family siblings and is UNAFFECTED — the family preference governs only the SSH
 * primary/alternate pair, exactly as the `oob_ip` block in `mapEntry` documents.
 */
function readAlternateAddress(obj: Record<string, unknown>, family: PrimaryIpFamily, primaryHost: string): string | undefined {
  const addressOf = (key: string): unknown => {
    const field = obj[key] as { address?: unknown } | null | undefined;
    return field && typeof field === "object" ? field.address : undefined;
  };
  const usableAddress = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const v4 = addressOf("primary_ip4");
  const v6 = addressOf("primary_ip6");
  // The candidate family field(s), in priority order. A `prefer-*` source has an
  // explicit non-preferred family; `auto` has none, so it considers both and
  // takes the first that differs from the primary host (see the rule above).
  const candidates: unknown[] = family === "prefer-ipv4" ? [v6] : family === "prefer-ipv6" ? [v4] : [v4, v6];
  for (const candidate of candidates) {
    if (!usableAddress(candidate)) {
      continue;
    }
    const host = stripCidr(candidate);
    if (host.length > 0 && host !== primaryHost) {
      return host;
    }
  }
  return undefined;
}

/** "10.0.0.5/24" -> "10.0.0.5"; "2001:db8::5/64" -> "2001:db8::5". */
export function stripCidr(address: string): string {
  const slash = address.lastIndexOf("/");
  return slash === -1 ? address : address.slice(0, slash);
}

/**
 * Splits `template` on "/", substitutes `{token}` per segment from `vars` (unknown
 * tokens render empty), drops segments that are empty/whitespace-only AFTER
 * substitution, and rejoins. "{site}/{rack}" with only `site` set collapses to
 * just the site segment rather than leaving a dangling "/".
 */
export function renderFolderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .split("/")
    .map((segment) => segment.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => vars[key] ?? ""))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  url = url.replace(/\/api$/i, "");
  return url.replace(/\/+$/, "");
}

/**
 * REVIEW FINDING (P1, cross-instance adoption) — this NetBox deployment's
 * identity: "the NetBox at https://netbox.example.com", not "NetBox". See
 * `InventoryProvider.instanceKey` (models/inventory.ts) for the contract and for
 * what depends on it; this is the reference implementation.
 *
 * BUILT ON `normalizeBaseUrl`, THE SAME FUNCTION THAT BUILDS EVERY REQUEST. The
 * key has to mean "the endpoint this source actually talks to", so it must be
 * derived from exactly the string the fetch is derived from — a second,
 * independently-written normalizer is a second answer to the same question, and
 * the two would drift. Everything below is canonicalization the URL parser does
 * on top of it, so two spellings of one endpoint yield one key:
 *  - SCHEME AND HOST are lower-cased (both are case-insensitive by RFC 3986, and
 *    `new URL` does it), and a DEFAULT PORT is dropped — `https://nb:443` and
 *    `https://NB` are the same deployment and now the same key.
 *  - THE PATH IS KEPT AS TYPED, case included: NetBox is commonly mounted under
 *    a prefix (`https://example.com/netbox`), those are different deployments,
 *    and path case is server-significant in a way host case is not.
 *  - USERINFO IS DROPPED, and this one is a hard requirement rather than tidiness
 *    — `https://user:token@netbox` is a credential typed into a NON-secret field,
 *    and this key is persisted on every kept server and copied into backups. The
 *    method never sees `secrets`; this is the other half of keeping it clean.
 *  - QUERY AND FRAGMENT ARE DROPPED: neither addresses a deployment, and leaving
 *    them in would split one instance into as many keys as there are stray "?"
 *    suffixes.
 *
 * SCHEME IS PART OF THE IDENTITY (`http://nb` !== `https://nb`), deliberately,
 * even though it is usually the same box behind both. The two failure modes are
 * not symmetrical: treating two instances as one is the finding being fixed and
 * is silent and destructive, while treating one instance as two costs a refused
 * adoption that the plan explains and that re-typing the URL repairs.
 *
 * `undefined` for an unparseable or empty base URL — including a bare
 * `netbox.example.com` with no scheme, which `new URL` rejects. That is not a
 * loss: the fetch path builds `new URL(`${baseUrl}/api/...`)` from the same
 * string, so a source whose base URL cannot be parsed cannot sync at all, and
 * claiming an identity for it would be claiming one for an endpoint that does
 * not resolve.
 */
export function netboxInstanceKey(config: InventorySourceValues): string | undefined {
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
  // `host` (not `hostname`) so a non-default port stays part of the identity;
  // the parser has already dropped the scheme's default port and lower-cased
  // both scheme and host.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

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
    throw new InventoryProviderError("auth", `NetBox rejected the API token (HTTP ${status}) at ${url}.`);
  }
  throw new InventoryProviderError(
    "protocol",
    `NetBox request to ${url} failed with HTTP ${status}: ${text.slice(0, 200)}`
  );
}

function parseJsonOrThrow(text: string, url: URL): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InventoryProviderError("protocol", `Response from ${url} is not NetBox JSON — is the base URL correct?`);
  }
}

interface RawResponse {
  status: number;
  text: string;
}

async function rawGet(fetchImpl: typeof fetch, url: URL, token: string, timeoutMs: number): Promise<RawResponse> {
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
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
  return { status: res.status, text };
}

async function netboxGetJson(fetchImpl: typeof fetch, url: URL, token: string, timeoutMs: number): Promise<unknown> {
  const { status, text } = await rawGet(fetchImpl, url, token, timeoutMs);
  if (status < 200 || status >= 300) {
    throwForStatus(status, text, url);
  }
  return parseJsonOrThrow(text, url);
}

interface PagedResult {
  count: number;
  results: unknown[];
}

function validatePagedShape(json: unknown, url: URL): PagedResult {
  if (
    typeof json !== "object" ||
    json === null ||
    typeof (json as { count?: unknown }).count !== "number" ||
    !Array.isArray((json as { results?: unknown }).results)
  ) {
    throw new InventoryProviderError("protocol", `Response from ${url} is not NetBox JSON — is the base URL correct?`);
  }
  const { count } = json as { count: number };
  // A negative or non-integer count (e.g. `{ count: -1, results: [] }`) satisfies `typeof
  // count === "number"` above but makes `fetchAllPages`'s `collected.length < count` loop
  // condition false on the very first page, so the endpoint reads as a complete, empty
  // inventory instead of a malformed response — silently pruning every server this endpoint
  // owns rather than failing loudly.
  if (!Number.isInteger(count) || count < 0) {
    throw new InventoryProviderError(
      "protocol",
      `Response from ${url} reported an invalid count (${count}) — is the base URL correct?`
    );
  }
  return json as unknown as PagedResult;
}

interface CapState {
  remaining: number;
  // FIX 3 — set exactly once, at the moment the hard cap physically stops a
  // fetch (`remaining` reaches 0). This is NOT the same as "truncated": an
  // inventory that has precisely HARD_CAP records also drives `remaining` to
  // 0, but nothing was left uncollected. fetchInventoryImpl combines this
  // with `reportedTotal` to tell the two apart before marking the tree
  // truncated.
  capped: boolean;
  // Sum of the NetBox-reported `count` for every endpoint actually fetched
  // this run (devices, plus VMs when included and not skipped by an
  // already-exhausted cap) — compared against HARD_CAP to detect a genuine
  // truncation.
  reportedTotal: number;
}

/**
 * Offset-based pagination — never follows the response's `next` URL (a reverse
 * proxy can mangle its scheme/host, and it is attacker-influenced JSON-body
 * content we'd otherwise be handing straight to fetch()). Advances
 * `offset += results.length` each page and stops once `collected >= count`.
 *
 * F2 — a page reporting zero results while the server's own `count` says more
 * remain is refused rather than silently treated as "done": that shape means the
 * server disagrees with itself, and looping on it forever (offset never
 * advancing) is the alternative this guards against.
 *
 * F2 — the iteration bound is derived from actual observed page size rather
 * than a fixed constant tuned to PAGE_LIMIT=250: a server that clamps the
 * page size down (e.g. to 100, as some NetBox deployments do) needs
 * proportionally more iterations to reach the same target, and a fixed bound
 * sized for 250-item pages would falsely fail it. The bound is anchored to
 * the LARGEST page size seen so far — if a later page shrinks (a genuinely
 * misbehaving/stalling server), the bound stays pinned to the best progress
 * rate actually demonstrated instead of drifting to excuse the new, slower
 * rate, so a truly stuck server still trips the post-loop guard below.
 *
 * FINDING 1 — `count` is captured from the FIRST page only and held fixed
 * for the rest of this endpoint's fetch. Overwriting it with every page's
 * reported count (as a naive offset-pagination loop would) lets a
 * server-side add/delete between page requests shift the offsets mid-fetch:
 * a still-existing record can be skipped (and then wrongly pruned by the
 * sync engine) or duplicated across two pages. Any subsequent page
 * reporting a different count means the collection changed while we were
 * paging through it, so this aborts loudly rather than silently continuing
 * with offsets that no longer line up. The invariant is per-endpoint —
 * devices and VMs are separate calls to this function, each with their own
 * first-page count.
 */
async function fetchAllPages(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  token: string,
  timeoutMs: number,
  filterParams: URLSearchParams,
  capState: CapState
): Promise<unknown[]> {
  const collected: unknown[] = [];
  let offset = 0;
  let count = Number.POSITIVE_INFINITY;
  let firstPageCount: number | undefined;
  let iterations = 0;
  let maxPageSize = 0;
  let maxIterations = Number.POSITIVE_INFINITY; // unbounded until the first page tells us a real page size

  while (collected.length < count && iterations < maxIterations) {
    iterations++;
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));
    for (const [key, value] of filterParams) {
      url.searchParams.append(key, value);
    }

    const page = validatePagedShape(await netboxGetJson(fetchImpl, url, token, timeoutMs), url);
    if (firstPageCount === undefined) {
      firstPageCount = page.count;
    } else if (page.count !== firstPageCount) {
      throw new InventoryProviderError(
        "protocol",
        `NetBox reported a different count at offset ${offset} (${page.count}) than the first page reported (${firstPageCount}) for ${baseUrl}${path} — records were likely added or removed during the sync; retry the sync.`
      );
    }
    count = page.count;

    if (page.results.length === 0) {
      if (collected.length < count) {
        throw new InventoryProviderError(
          "protocol",
          `NetBox returned an empty page at offset ${offset} while reporting count ${count} — aborting to avoid an infinite loop.`
        );
      }
      break;
    }

    maxPageSize = Math.max(maxPageSize, page.results.length);
    maxIterations = Math.ceil(Math.min(count, HARD_CAP) / maxPageSize) + 1;

    // FINDING 1 — reject a page that would push this endpoint's collected
    // total beyond the pinned first-page `count`, e.g. {count: 1, results:
    // [row1, row2]} silently read as a complete 2-device inventory. Guarded
    // against the *legitimate* hard-cap path: if the hard cap is what's
    // actually going to limit how many of this page's rows get collected
    // (capAllowance < count — strictly less), the shortfall is explained by
    // the cap, not by the server over-reporting, so no error.
    //
    // capAllowance === count is NOT part of that exception: it means the
    // remaining budget matches the reported count exactly (the server
    // legitimately has no more than we can take), so any row beyond `count`
    // on this page is unexplained by the cap — the server is reporting a
    // count it then contradicts with an overrun page. That must be rejected
    // the same as the capAllowance > count case, or the extra row is
    // silently dropped by the inner collection loop below, capState.capped
    // ends up true, and reportedTotal lands exactly at HARD_CAP — which
    // fetchInventoryImpl reads as a non-truncated tree, re-enabling pruning
    // while the dropped row's server is still real.
    const capAllowance = collected.length + capState.remaining;
    const projectedTotal = collected.length + page.results.length;
    if (capAllowance >= count && projectedTotal > count) {
      throw new InventoryProviderError(
        "protocol",
        `NetBox reported count ${count} for ${baseUrl}${path} but the page at offset ${offset} carries ${page.results.length} row(s), which would bring the collected total to ${projectedTotal} — aborting rather than accepting an inventory larger than reported.`
      );
    }

    for (const item of page.results) {
      if (capState.remaining <= 0) break;
      collected.push(item);
      capState.remaining--;
    }
    offset += page.results.length;

    if (capState.remaining <= 0) {
      capState.capped = true;
      break;
    }
  }

  // FIX 2 — the loop above can also exit because `iterations` hit
  // maxIterations while the server still reports more devices than we
  // collected. That is NOT the hard-cap path — it means NetBox kept sending
  // short/odd-sized pages (relative to the best page size it demonstrated)
  // and pagination gave up early. Silently returning a partial list here is
  // indistinguishable, downstream, from every uncollected device having been
  // deleted at the source, so this aborts loudly instead — same spirit as
  // the empty-page throw above.
  if (collected.length < Math.min(count, HARD_CAP) && !capState.capped) {
    throw new InventoryProviderError(
      "protocol",
      `NetBox pagination for ${baseUrl}${path} stopped after ${iterations} page(s) having collected ${collected.length} of ${count} reported devices — aborting rather than returning a truncated inventory.`
    );
  }

  // FIX 3 — accumulate this endpoint's reported total so fetchInventoryImpl
  // can tell a genuine truncation (more records exist than were collected)
  // from an exact fit at HARD_CAP after combining devices + VMs.
  capState.reportedTotal += count;

  return collected;
}

/** F11 — strips Nexus-reserved query params (we control pagination), warning when any were present. */
function parseFilter(raw: string, warnings: string[]): URLSearchParams {
  const result = new URLSearchParams();
  if (!raw.trim()) return result;
  const stripped: string[] = [];
  for (const [key, value] of new URLSearchParams(raw)) {
    if (RESERVED_FILTER_KEYS.has(key.toLowerCase())) {
      if (!stripped.includes(key)) stripped.push(key);
      continue;
    }
    result.append(key, value);
  }
  if (stripped.length > 0) {
    warnings.push(
      `Ignored reserved filter parameter${stripped.length === 1 ? "" : "s"} (${stripped.join(", ")}) — Nexus controls pagination.`
    );
  }
  return result;
}

function nameOf(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

function deviceVars(raw: Record<string, unknown>): Record<string, string> {
  return {
    site: nameOf(raw.site),
    location: nameOf(raw.location),
    rack: nameOf(raw.rack),
    // NetBox >=3.6 renamed device_role -> role; both are tried so either version maps.
    role: nameOf(raw.role) || nameOf(raw.device_role),
    tenant: nameOf(raw.tenant)
  };
}

function vmVars(raw: Record<string, unknown>): Record<string, string> {
  // Deliberately no rack/location — NetBox VMs don't have either, and cluster is
  // intentionally not offered as a folder axis in Phase 1.
  return {
    site: nameOf(raw.site),
    location: "",
    rack: "",
    role: nameOf(raw.role) || nameOf(raw.device_role),
    tenant: nameOf(raw.tenant)
  };
}

/** NetBox nested objects carry both `name` (display) and `slug` (the URL dialect). */
function slugOf(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { slug?: unknown }).slug === "string") {
    return (value as { slug: string }).slug;
  }
  return "";
}

function dedupeNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((v) => v !== ""))];
}

/** DEVICE TEMPLATES (§2.2 A-M4) — a nested `{name, slug}` object as its `[displayName, slug]` set. */
function pairValues(raw: unknown): string[] {
  return dedupeNonEmpty([nameOf(raw), slugOf(raw)]);
}

/** NetBox `status` is `{ value, label }`; `.value` is the slug-like one, `.label` the display. */
function statusValues(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const value = (raw as { value?: unknown }).value;
  const label = (raw as { label?: unknown }).label;
  return dedupeNonEmpty([typeof value === "string" ? value : "", typeof label === "string" ? label : ""]);
}

/** `tags` is an array of `{name, slug}` — flattened to every tag's name and slug. */
function tagValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const tag of raw) {
    out.push(nameOf(tag), slugOf(tag));
  }
  return dedupeNonEmpty(out);
}

/**
 * DEVICE TEMPLATES (§2.2 A-M4) — the per-device MATCHING metadata for template
 * rule filters, from the SAME rows pagination already fetched (no new API call,
 * same argument as `oob_ip`). Each of `role/site/location/rack/tenant/platform`
 * emits a set-valued `[displayName, slug]` (deduped, empties omitted — m9c) so
 * a filter copied from a NetBox URL (which speaks slugs) and one typed with a
 * display name both match; `status` emits `[value, label]`; `tags` emits every
 * tag's name and slug. Set-valued matching (any element) then gives name-OR-slug
 * for free, with zero special cases in the matcher. VMs get the same MINUS
 * rack/location, mirroring `vmVars`' documented asymmetry. Keys are the lowercase
 * attribute names; `tag`→`tags` aliasing happens in the matcher's parser, not
 * here (the attribute is plural because it holds a set). Returns `undefined` when
 * nothing survived, so the device carries no `attributes` at all.
 */
function deviceAttributes(obj: Record<string, unknown>, kind: "device" | "vm"): Record<string, string | string[]> | undefined {
  const attrs: Record<string, string[]> = {};
  const put = (key: string, values: string[]): void => {
    if (values.length > 0) {
      attrs[key] = values;
    }
  };
  // NetBox >=3.6 renamed device_role -> role; prefer whichever object carries data.
  const roleRaw = nameOf(obj.role) || slugOf(obj.role) ? obj.role : obj.device_role;
  put("role", pairValues(roleRaw));
  put("site", pairValues(obj.site));
  put("tenant", pairValues(obj.tenant));
  put("platform", pairValues(obj.platform));
  if (kind === "device") {
    put("location", pairValues(obj.location));
    put("rack", pairValues(obj.rack));
  }
  put("status", statusValues(obj.status));
  put("tags", tagValues(obj.tags));
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/**
 * FIX 1 — a device/VM missing a name or a usable primary IP is still emitted
 * into the tree (with an empty `endpoints` array) rather than dropped
 * entirely. Dropping it would make the sync engine believe the device no
 * longer exists at the source, pruning the server it previously created even
 * though the device is merely unmappable this fetch — data loss for a purely
 * cosmetic NetBox data-quality issue. Only an entry with no `id` at all (no
 * way to construct a stable externalId) is genuinely dropped.
 *
 * FINDING 1 — "dropped" above must mean "aborts the whole sync", not
 * "silently skipped and forgotten". A page is a structurally valid paged
 * response (validatePagedShape already vetted `count`/`results`), so
 * fetchAllPages considers every row in it faithfully collected; if a row
 * here is null, not an object, or has no usable id, silently returning
 * `undefined` would make that row vanish from the `devices` array while the
 * pagination accounting still believes the reported count was fully
 * collected. Any server this row corresponds to then falls out of the
 * engine's present set and gets pruned — the same fail-closed hazard the
 * count-drift and negative-count guards above exist to prevent. So this
 * throws a protocol error naming the endpoint and row index instead of
 * returning `undefined`.
 */
function mapEntry(
  raw: unknown,
  endpointPath: string,
  index: number,
  template: string,
  kind: "device" | "vm",
  primaryIpFamily: PrimaryIpFamily
): InventoryDevice {
  if (typeof raw !== "object" || raw === null) {
    throw new InventoryProviderError(
      "protocol",
      `row ${index} of ${endpointPath} is not a JSON object — refusing to sync.`
    );
  }
  const obj = raw as Record<string, unknown>;
  const hasUsableId =
    (typeof obj.id === "number" && Number.isFinite(obj.id)) || (typeof obj.id === "string" && obj.id.length > 0);
  if (!hasUsableId) {
    throw new InventoryProviderError("protocol", `row ${index} of ${endpointPath} has no id — refusing to sync.`);
  }
  const name = typeof obj.name === "string" ? obj.name : "";
  // PRIMARY-IP FAMILY PREFERENCE (PR-E) — the SSH endpoint's address is chosen by
  // the source's family preference off the same row (primary_ip / primary_ip4 /
  // primary_ip6). `auto` is byte-identical to the previous single `primary_ip`
  // read. The `oob_ip` block below is UNAFFECTED: `oob_ip` is a single NetBox
  // field with no v4/v6 siblings, so no family preference can (or does) govern it.
  const address = readPrimaryAddress(obj, primaryIpFamily);
  const usable = Boolean(name) && typeof address === "string" && address.length > 0;
  const vars = kind === "device" ? deviceVars(obj) : vmVars(obj);
  const folderPath = renderFolderTemplate(template, vars);
  const primaryHost = usable ? stripCidr(address as string) : undefined;
  const endpoints: InventoryDevice["endpoints"] = primaryHost !== undefined ? [{ kind: "ssh", host: primaryHost, port: 22 }] : [];
  // ALTERNATE HOST (issue #48, Phase 2) — the NON-PREFERRED IP-family address is
  // emitted as a SECOND `kind: "ssh"` endpoint AFTER the primary one. THE ENDPOINT
  // CONVENTION (see models/inventory.ts): the FIRST ssh endpoint is the primary
  // host; the SECOND ssh endpoint is the alternate host. The sync engine's
  // `selectSshEndpoint` maps the first onto `ServerConfig.host` and
  // `selectAltEndpoint` maps the second onto `ServerConfig.altHost`. Only emitted
  // when a primary exists (an alternate with no primary would be meaningless) and
  // when `readAlternateAddress` finds one that is present, CIDR-stripped-non-empty
  // and DISTINCT from the primary. The `oob_ip` → redfish block below is untouched.
  if (primaryHost !== undefined) {
    const altHost = readAlternateAddress(obj, primaryIpFamily, primaryHost);
    if (altHost !== undefined) {
      endpoints.push({ kind: "ssh", host: altHost, port: 22 });
    }
  }
  // Out-of-band management address, read with the same defensive shape as
  // `primary_ip` and from the same rows the pagination already fetches (no new
  // API call, no new config field). DEVICES ONLY — NetBox VMs have no `oob_ip`,
  // the same field asymmetry `vmVars` above already documents.
  //
  // `kind: "redfish"` rather than `"ipmi-sol"`: `oob_ip` is a generic OOB
  // address and `ServerConfig.ipmiHost` calls itself "IPMI / BMC / Redfish". The
  // sync engine selects on EITHER kind, so the choice is cosmetic and a
  // third-party provider emitting `ipmi-sol` maps identically.
  //
  // Emitted independently of `usable`: a device with an `oob_ip` and no primary
  // IP still carries this endpoint (and is still counted in the no-SSH warning
  // below — see the `skippedCount` predicate).
  if (kind === "device") {
    const oobIp = obj.oob_ip as { address?: unknown } | null | undefined;
    const oobAddress = oobIp && typeof oobIp === "object" ? oobIp.address : undefined;
    if (typeof oobAddress === "string") {
      // Emptiness is checked AFTER `stripCidr`, not before: a degenerate address
      // that is nothing BUT a prefix ("/24") is non-empty going in and empty
      // coming out, and would otherwise put `{ kind: "redfish", host: "" }` onto
      // the tree. The SSH path's `usable` gate has always tested the value it
      // actually emits; this is the same gate on the value this one emits.
      const host = stripCidr(oobAddress);
      if (host) {
        endpoints.push({ kind: "redfish", host });
      }
    }
  }
  return {
    // Prefixed and coexisting on purpose: a device and a VM can share the same
    // numeric NetBox id, and an unprefixed `String(id)` would silently merge them.
    externalId: `${kind}:${String(obj.id)}`,
    name,
    folderPath: folderPath || undefined,
    endpoints,
    // DEVICE TEMPLATES (§2.2 A-M4) — matching metadata for template rule filters,
    // names AND slugs, from the same rows. Absent when the device carries none.
    attributes: deviceAttributes(obj, kind)
  };
}

async function testConnectionImpl(fetchImpl: typeof fetch, baseUrl: string, token: string): Promise<void> {
  const statusUrl = new URL(`${baseUrl}/api/status/`);
  const primary = await rawGet(fetchImpl, statusUrl, token, TEST_CONNECTION_TIMEOUT_MS);
  if (primary.status >= 200 && primary.status < 300) {
    parseJsonOrThrow(primary.text, statusUrl);
    return;
  }
  // F2/testConnection contract — only a 404 (endpoint not present on older NetBox)
  // falls back; an auth failure (401/403) must bubble as-is, never masked by a
  // fallback request that could itself succeed with a still-bad token on a laxer endpoint.
  if (primary.status === 404) {
    const devicesUrl = new URL(`${baseUrl}/api/dcim/devices/`);
    devicesUrl.searchParams.set("limit", "1");
    devicesUrl.searchParams.set("brief", "true");
    const fallback = await rawGet(fetchImpl, devicesUrl, token, TEST_CONNECTION_TIMEOUT_MS);
    if (fallback.status >= 200 && fallback.status < 300) {
      parseJsonOrThrow(fallback.text, devicesUrl);
      return;
    }
    throwForStatus(fallback.status, fallback.text, devicesUrl);
  }
  throwForStatus(primary.status, primary.text, statusUrl);
}

async function fetchInventoryImpl(
  fetchImpl: typeof fetch,
  config: InventorySourceValues,
  secrets: InventorySourceSecrets
): Promise<InventoryTree> {
  const baseUrl = normalizeBaseUrl(String(config.baseUrl ?? ""));
  const token = secrets.apiToken ?? "";
  const template =
    typeof config.folderTemplate === "string" && config.folderTemplate.trim() ? config.folderTemplate : DEFAULT_FOLDER_TEMPLATE;
  const includeVms = config.includeVms === true;
  const primaryIpFamily = parsePrimaryIpFamily(config.primaryIpFamily);

  const warnings: string[] = [];
  const filterParams = parseFilter(typeof config.filter === "string" ? config.filter : "", warnings);
  const capState: CapState = { remaining: HARD_CAP, capped: false, reportedTotal: 0 };

  const rawDevices = await fetchAllPages(
    fetchImpl,
    baseUrl,
    "/api/dcim/devices/",
    token,
    FETCH_TIMEOUT_MS,
    filterParams,
    capState
  );
  // F11 — filter applies to devices only; VMs get Nexus's own pagination params and nothing else.
  // F3 — devices alone can exhaust the cap before VMs are ever queried; that
  // skip is itself evidence of truncation (see `vmsSkippedByCap` below), since
  // we have no way to know whether VMs exist beyond what we never asked for.
  const vmsSkippedByCap = includeVms && capState.remaining <= 0;
  const rawVms =
    includeVms && !vmsSkippedByCap
      ? await fetchAllPages(
          fetchImpl,
          baseUrl,
          "/api/virtualization/virtual-machines/",
          token,
          FETCH_TIMEOUT_MS,
          new URLSearchParams(),
          capState
        )
      : [];

  const devices: InventoryDevice[] = [];
  // FIX 1 — "skipped" now means "mapped with no endpoints" (unmappable name or
  // IP), not "dropped from the tree" — mapEntry throws (FINDING 1) rather
  // than returning undefined for a row with no usable id.
  //
  // Keyed on "has no SSH endpoint", NOT on `endpoints.length === 0`: since
  // `oob_ip` can put an endpoint on a device that has no primary IP, the length
  // test would silently drop exactly those devices out of this warning while
  // they remain just as unmappable to SSH as before.
  const hasNoSshEndpoint = (mapped: InventoryDevice): boolean => !mapped.endpoints.some((e) => e.kind === "ssh");
  let skippedCount = 0;
  rawDevices.forEach((raw, index) => {
    const mapped = mapEntry(raw, "/api/dcim/devices/", index, template, "device", primaryIpFamily);
    devices.push(mapped);
    if (hasNoSshEndpoint(mapped)) skippedCount++;
  });
  rawVms.forEach((raw, index) => {
    const mapped = mapEntry(raw, "/api/virtualization/virtual-machines/", index, template, "vm", primaryIpFamily);
    devices.push(mapped);
    if (hasNoSshEndpoint(mapped)) skippedCount++;
  });
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} device${skippedCount === 1 ? "" : "s"} without a primary IP were skipped.`);
  }

  // FIX 3 — an exact-cap fetch (the source has precisely HARD_CAP records) must
  // NOT be marked truncated: the sync engine treats `truncated` as "fail closed,
  // never prune" and would skip pruning on this source forever. Only mark it
  // when the fetch actually stopped short of what NetBox reports exists —
  // comparing the combined reported total across devices (+ VMs, when
  // included and not skipped by an already-exhausted cap) against HARD_CAP.
  // Whenever `capped` is true, exactly HARD_CAP records were collected, so
  // "reportedTotal > collected" reduces to "reportedTotal > HARD_CAP".
  const truncated = capState.capped && (vmsSkippedByCap || capState.reportedTotal > HARD_CAP);
  if (truncated) {
    warnings.push(`Truncated at ${HARD_CAP} devices — narrow the filter.`);
  }

  return { contractVersion: 1, devices, warnings, truncated: truncated || undefined };
}

export function createNetboxProvider(fetchImpl: typeof fetch = fetch): InventoryProvider {
  return {
    id: NETBOX_PROVIDER_ID,
    label: "NetBox",
    configFields: NETBOX_CONFIG_FIELDS,
    // DEVICE TEMPLATES (§2.2 A-M4) — the filter keys this provider's device
    // `attributes` can carry. `tag` is the filter key; the attribute is `tags`
    // (the parser aliases them). `name` is the provider-agnostic reserved key.
    attributeKeys: ["role", "site", "location", "rack", "tenant", "status", "platform", "tag", "name"],
    instanceKey(config: InventorySourceValues): string | undefined {
      return netboxInstanceKey(config);
    },
    async testConnection(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<void> {
      const baseUrl = normalizeBaseUrl(String(config.baseUrl ?? ""));
      const token = secrets.apiToken ?? "";
      await testConnectionImpl(fetchImpl, baseUrl, token);
    },
    fetchInventory(config: InventorySourceValues, secrets: InventorySourceSecrets): Promise<InventoryTree> {
      return fetchInventoryImpl(fetchImpl, config, secrets);
    }
  };
}
