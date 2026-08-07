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
  }
];

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

/**
 * FIX 1 — a device/VM missing a name or a usable primary IP is still emitted
 * into the tree (with an empty `endpoints` array) rather than dropped
 * entirely. Dropping it would make the sync engine believe the device no
 * longer exists at the source, pruning the server it previously created even
 * though the device is merely unmappable this fetch — data loss for a purely
 * cosmetic NetBox data-quality issue. Only an entry with no `id` at all (no
 * way to construct a stable externalId) is genuinely dropped.
 */
function mapEntry(raw: unknown, template: string, kind: "device" | "vm"): InventoryDevice | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.id === undefined || obj.id === null) return undefined;
  const name = typeof obj.name === "string" ? obj.name : "";
  const primaryIp = obj.primary_ip as { address?: unknown } | null | undefined;
  const address = primaryIp && typeof primaryIp === "object" ? primaryIp.address : undefined;
  const usable = Boolean(name) && typeof address === "string" && address.length > 0;
  const vars = kind === "device" ? deviceVars(obj) : vmVars(obj);
  const folderPath = renderFolderTemplate(template, vars);
  return {
    // Prefixed and coexisting on purpose: a device and a VM can share the same
    // numeric NetBox id, and an unprefixed `String(id)` would silently merge them.
    externalId: `${kind}:${String(obj.id)}`,
    name,
    folderPath: folderPath || undefined,
    endpoints: usable ? [{ kind: "ssh", host: stripCidr(address as string), port: 22 }] : []
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
  // IP), not "dropped from the tree" — mapEntry only returns undefined when
  // there's no id at all to key an externalId on.
  let skippedCount = 0;
  for (const raw of rawDevices) {
    const mapped = mapEntry(raw, template, "device");
    if (!mapped) continue;
    devices.push(mapped);
    if (mapped.endpoints.length === 0) skippedCount++;
  }
  for (const raw of rawVms) {
    const mapped = mapEntry(raw, template, "vm");
    if (!mapped) continue;
    devices.push(mapped);
    if (mapped.endpoints.length === 0) skippedCount++;
  }
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
