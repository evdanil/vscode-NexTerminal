/**
 * Closed, daemon-safe JSON-line RPC contract for the network-server bridge.
 *
 * The transport is deliberately separate from this module: it can enforce line
 * size and JSON parsing, while this file validates the resulting DTOs without
 * depending on VS Code or either process's lifecycle implementation.
 */

import { MAX_DHCP_POOL_SIZE, MAX_STATIC_RESERVATIONS, parseNetworkServerConfigs } from "./networkServerConfigValidation";
import type { NetworkServerConfigs } from "./core/index";
import type { DhcpAdapterConfig } from "./dhcp/DhcpAdapter";
import type { TftpAdapterConfig } from "./tftp/TftpAdapter";

/** Text is independently bounded at the planned JSON-line transport ceiling. */
export const MAX_RPC_TEXT_BYTES = 1_048_576;
/** Transfer ids are socket endpoint identifiers today; 1 KiB leaves ample protocol headroom. */
export const MAX_TRANSFER_ID_BYTES = 1024;
/** The TFTP engine's fixed default concurrent-transfer ceiling. */
export const MAX_TFTP_TRANSFERS = 64;
/** Dynamic-pool leases plus every configured static reservation may be active together. */
export const MAX_DHCP_RUNTIME_LEASES = MAX_DHCP_POOL_SIZE + MAX_STATIC_RESERVATIONS;

const MAX_SERVICE_COUNT = 2;
const MAX_RPC_DEPTH = 16;
const MAX_SAFE_JSON_ARRAY_ENTRIES = MAX_DHCP_RUNTIME_LEASES;
const MAX_PATH_BYTES = 4096;
const MAX_NETWORK_ADDRESS_BYTES = 255;
const MAX_DHCP_FIELD_BYTES = 255;
const MAX_PORT = 65_535;

export type RpcMethod =
  | "list"
  | "getStatus"
  | "configure"
  | "start"
  | "stop"
  | "restart"
  | "cancelTransfer"
  | "getServiceRuntime";

export type RpcServiceId = "tftp" | "dhcp";
export type RpcLogSource = RpcServiceId | "daemon";
export type RpcServerStatus = "stopped" | "starting" | "running" | "stopping" | "error";
export type RpcLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface RpcServerSnapshot {
  readonly id: RpcServiceId;
  readonly name: string;
  readonly port: number;
  readonly status: RpcServerStatus;
  readonly errorMessage?: string;
}

export interface RpcTftpTransfer {
  readonly id: string;
  readonly peer: { readonly address: string; readonly port: number };
  readonly direction: "rrq" | "wrq";
  readonly filename: string;
  readonly bytes: number;
  readonly totalBytes: number | null;
  readonly blockSize: number;
  readonly windowSize: number;
  readonly speedBps: number;
  readonly etaSec: number | null;
  readonly startedAt: number;
  readonly clientHostname: string | null;
  readonly client: string;
}

export interface RpcDhcpLease {
  readonly mac: string;
  readonly ip: string;
  readonly boundAt: number;
  readonly leaseSec: number;
  readonly expiresAt: number;
  readonly remainingSec: number;
  readonly hostname: string | null;
  readonly leaseType: "dynamic" | "static" | "renewed" | "inform";
  readonly clientId?: string | null;
}

export interface RpcDhcpPacketCounters {
  readonly packetsReceived: number;
  readonly packetsSentEstimate: number;
  readonly discoverCount: number;
  readonly offerCount: number;
  readonly requestCount: number;
  readonly declineCount: number;
  readonly ackCount: number;
  readonly nakCount: number;
  readonly releaseCount: number;
  readonly informCount: number;
}

export interface RpcDhcpPoolInfo {
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly poolSize: number;
  readonly activeCount: number;
  readonly utilizationPct: number;
  readonly staticEntryCount: number;
}

export interface RpcTftpRuntimeSnapshot {
  readonly snapshot: RpcServerSnapshot & { readonly id: "tftp" };
  readonly transfers: readonly RpcTftpTransfer[];
  readonly root: string;
  readonly allowWrite: boolean;
  readonly boundPort: number | null;
}

export interface RpcDhcpRuntimeSnapshot {
  readonly snapshot: RpcServerSnapshot & { readonly id: "dhcp" };
  readonly leases: readonly RpcDhcpLease[];
  readonly packetCounters: RpcDhcpPacketCounters;
  readonly poolInfo: RpcDhcpPoolInfo;
  readonly boundPort: number | null;
}

export type RpcRuntimeSnapshot = RpcTftpRuntimeSnapshot | RpcDhcpRuntimeSnapshot;

export type RpcParams<M extends RpcMethod> =
  M extends "list" ? never
    : M extends "getStatus" | "stop" | "getServiceRuntime" ? { readonly id: RpcServiceId }
      : M extends "configure" ? { readonly configs: NetworkServerConfigs }
        : M extends "start" | "restart"
          ? ({ readonly id: "tftp"; readonly config?: TftpAdapterConfig }
            | { readonly id: "dhcp"; readonly config?: DhcpAdapterConfig })
          : M extends "cancelTransfer" ? { readonly id: "tftp"; readonly transferId: string }
            : never;

export type RpcRequest<M extends RpcMethod = RpcMethod> = M extends RpcMethod
  ? { readonly id: number; readonly method: M }
    & (M extends "list" ? { readonly params?: never } : { readonly params: RpcParams<M> })
  : never;

export type RpcResult<M extends RpcMethod> =
  M extends "list" ? readonly RpcServerSnapshot[]
    : M extends "getStatus" ? RpcServerSnapshot
      : M extends "configure" ? { readonly ok: true; readonly changed: readonly RpcServiceId[] }
        : M extends "start" | "stop" | "restart" ? { readonly ok: true; readonly id: RpcServiceId }
          : M extends "cancelTransfer" ? { readonly ok: boolean; readonly id: "tftp"; readonly transferId: string }
            : M extends "getServiceRuntime" ? RpcRuntimeSnapshot
              : never;

export interface RpcError {
  readonly code: string;
  readonly message: string;
}

export type RpcEnvelope =
  | { readonly id: number; readonly result: JsonValue }
  | { readonly id: number; readonly error: RpcError };

export type RpcEvent =
  | { readonly event: "ready"; readonly data: null }
  | { readonly event: "statusChange"; readonly data: { readonly id: RpcServiceId; readonly status: RpcServerStatus; readonly error?: string } }
  | { readonly event: "log"; readonly data: { readonly id: RpcLogSource; readonly level: RpcLogLevel; readonly message: string } }
  | { readonly event: "runtimeUpdate"; readonly data: { readonly id: RpcServiceId } }
  | { readonly event: "connection"; readonly data: { readonly id: RpcServiceId; readonly connection: RpcConnectionEvent } };

export interface RpcConnectionEvent {
  readonly phase: "started" | "completed" | "failed";
  readonly summary: string;
  readonly detail?: string;
  readonly code?: string;
  readonly id?: string;
  readonly resource?: string;
  readonly client?: string;
}

export type RpcParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type Fields = ReadonlyMap<string, unknown>;

function accepted<T>(value: T): RpcParseResult<T> {
  return { ok: true, value };
}

function rejected<T = never>(error: string): RpcParseResult<T> {
  return { ok: false, error };
}

function safely<T>(parse: () => RpcParseResult<T>): RpcParseResult<T> {
  try {
    return parse();
  } catch {
    return rejected("Malformed RPC value.");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns a snapshot of own enumerable data properties without calling a
 * getter. JSON.parse can only produce this shape, so accessors and hidden
 * fields are rejected rather than accidentally becoming part of the protocol.
 */
function fieldsOf(value: unknown): Fields | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const fields = new Map<string, unknown>();
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    fields.set(key, descriptor.value);
  }
  return fields;
}

function exactFields(value: unknown, allowed: readonly string[], required: readonly string[]): Fields | undefined {
  const fields = fieldsOf(value);
  if (!fields) return undefined;
  const allowedSet = new Set(allowed);
  for (const key of fields.keys()) {
    if (!allowedSet.has(key)) return undefined;
  }
  for (const key of required) {
    if (!fields.has(key)) return undefined;
  }
  return fields;
}

function arrayValues(value: unknown, maximumEntries: number): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return undefined;
  const length = lengthDescriptor.value as number;
  if (length < 0 || length > maximumEntries) return undefined;

  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    values.push(descriptor.value);
  }
  return values;
}

/** Creates a plain JSON clone so downstream configuration parsing cannot touch hostile accessors. */
function cloneJsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > MAX_RPC_DEPTH) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;

  const array = arrayValues(value, MAX_SAFE_JSON_ARRAY_ENTRIES);
  if (array) {
    const cloned: JsonValue[] = [];
    for (const entry of array) {
      const parsed = cloneJsonValue(entry, depth + 1);
      if (parsed === undefined) return undefined;
      cloned.push(parsed);
    }
    return cloned;
  }

  const fields = fieldsOf(value);
  if (!fields) return undefined;
  const cloned: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, entry] of fields) {
    const parsed = cloneJsonValue(entry, depth + 1);
    if (parsed === undefined) return undefined;
    cloned[key] = parsed;
  }
  return cloned;
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!allowEmpty && value.length === 0) return undefined;
  return Buffer.byteLength(value, "utf8") <= maximumBytes ? value : undefined;
}

function serviceId(value: unknown): RpcServiceId | undefined {
  return value === "tftp" || value === "dhcp" ? value : undefined;
}

function logSource(value: unknown): RpcLogSource | undefined {
  return value === "daemon" ? value : serviceId(value);
}

function serverStatus(value: unknown): RpcServerStatus | undefined {
  return value === "stopped" || value === "starting" || value === "running" || value === "stopping" || value === "error"
    ? value
    : undefined;
}

function logLevel(value: unknown): RpcLogLevel | undefined {
  return value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error" ? value : undefined;
}

function dhcpLeaseType(value: unknown): RpcDhcpLease["leaseType"] | undefined {
  return value === "dynamic" || value === "static" || value === "renewed" || value === "inform" ? value : undefined;
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

/** TFTP's current tsize parser produces finite integers beyond Number.MAX_SAFE_INTEGER. */
function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function finiteNumber(value: unknown, minimum = 0, maximum = Number.MAX_VALUE): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function port(value: unknown): number | undefined {
  return safeInteger(value, 0, MAX_PORT);
}

function nullablePort(value: unknown): number | null | undefined {
  return value === null ? null : port(value);
}

function parsedArray<T>(value: unknown, maximumEntries: number, parse: (entry: unknown) => T | undefined): readonly T[] | undefined {
  const entries = arrayValues(value, maximumEntries);
  if (!entries) return undefined;
  const parsed: T[] = [];
  for (const entry of entries) {
    const item = parse(entry);
    if (item === undefined) return undefined;
    parsed.push(item);
  }
  return parsed;
}

function parseSnapshot(value: unknown): RpcServerSnapshot | undefined {
  const fields = exactFields(value, ["id", "name", "port", "status", "errorMessage"], ["id", "name", "port", "status"]);
  if (!fields) return undefined;
  const id = serviceId(fields.get("id"));
  const name = boundedString(fields.get("name"), MAX_RPC_TEXT_BYTES);
  const parsedPort = port(fields.get("port"));
  const status = serverStatus(fields.get("status"));
  if (!id || name === undefined || parsedPort === undefined || !status) return undefined;

  const errorMessage = fields.has("errorMessage")
    ? boundedString(fields.get("errorMessage"), MAX_RPC_TEXT_BYTES, true)
    : undefined;
  if (fields.has("errorMessage") && errorMessage === undefined) return undefined;
  return errorMessage === undefined
    ? { id, name, port: parsedPort, status }
    : { id, name, port: parsedPort, status, errorMessage };
}

function parseTftpTransfer(value: unknown): RpcTftpTransfer | undefined {
  const fields = exactFields(value, [
    "id", "peer", "direction", "filename", "bytes", "totalBytes", "blockSize", "windowSize", "speedBps", "etaSec", "startedAt",
    "clientHostname", "client",
  ], [
    "id", "peer", "direction", "filename", "bytes", "totalBytes", "blockSize", "windowSize", "speedBps", "etaSec", "startedAt",
    "clientHostname", "client",
  ]);
  if (!fields) return undefined;
  const id = boundedString(fields.get("id"), MAX_TRANSFER_ID_BYTES);
  const peer = exactFields(fields.get("peer"), ["address", "port"], ["address", "port"]);
  const address = peer ? boundedString(peer.get("address"), MAX_NETWORK_ADDRESS_BYTES) : undefined;
  const peerPort = peer ? port(peer.get("port")) : undefined;
  const rawDirection = fields.get("direction");
  const direction = rawDirection === "rrq" || rawDirection === "wrq" ? rawDirection : undefined;
  const filename = boundedString(fields.get("filename"), MAX_RPC_TEXT_BYTES);
  const bytes = safeInteger(fields.get("bytes"));
  const totalBytes = fields.get("totalBytes") === null ? null : nonnegativeInteger(fields.get("totalBytes"));
  const blockSize = safeInteger(fields.get("blockSize"), 1, MAX_PORT);
  const windowSize = safeInteger(fields.get("windowSize"), 1, MAX_PORT);
  const speedBps = finiteNumber(fields.get("speedBps"));
  const etaSec = fields.get("etaSec") === null ? null : finiteNumber(fields.get("etaSec"));
  const startedAt = safeInteger(fields.get("startedAt"));
  const clientHostname = fields.get("clientHostname") === null
    ? null
    : boundedString(fields.get("clientHostname"), MAX_NETWORK_ADDRESS_BYTES);
  const client = boundedString(fields.get("client"), MAX_RPC_TEXT_BYTES);
  if (
    id === undefined || !peer || address === undefined || peerPort === undefined || direction === undefined || filename === undefined
    || bytes === undefined || totalBytes === undefined || blockSize === undefined || windowSize === undefined || speedBps === undefined
    || etaSec === undefined || startedAt === undefined || clientHostname === undefined || client === undefined
  ) return undefined;
  return {
    id,
    peer: { address, port: peerPort },
    direction,
    filename,
    bytes,
    totalBytes,
    blockSize,
    windowSize,
    speedBps,
    etaSec,
    startedAt,
    clientHostname,
    client,
  };
}

function parseDhcpLease(value: unknown): RpcDhcpLease | undefined {
  const fields = exactFields(value, [
    "mac", "ip", "boundAt", "leaseSec", "expiresAt", "remainingSec", "hostname", "leaseType", "clientId",
  ], ["mac", "ip", "boundAt", "leaseSec", "expiresAt", "remainingSec", "hostname", "leaseType"]);
  if (!fields) return undefined;
  const mac = boundedString(fields.get("mac"), MAX_DHCP_FIELD_BYTES);
  const ip = boundedString(fields.get("ip"), MAX_NETWORK_ADDRESS_BYTES);
  const boundAt = safeInteger(fields.get("boundAt"));
  const leaseSec = safeInteger(fields.get("leaseSec"));
  const expiresAt = safeInteger(fields.get("expiresAt"));
  const remainingSec = safeInteger(fields.get("remainingSec"));
  const hostname = fields.get("hostname") === null ? null : boundedString(fields.get("hostname"), MAX_DHCP_FIELD_BYTES, true);
  const leaseType = dhcpLeaseType(fields.get("leaseType"));
  const clientId = !fields.has("clientId") ? undefined
    : fields.get("clientId") === null ? null : boundedString(fields.get("clientId"), MAX_DHCP_FIELD_BYTES, true);
  if (
    mac === undefined || ip === undefined || boundAt === undefined || leaseSec === undefined || expiresAt === undefined
    || remainingSec === undefined || hostname === undefined || leaseType === undefined || (fields.has("clientId") && clientId === undefined)
  ) return undefined;
  const base = { mac, ip, boundAt, leaseSec, expiresAt, remainingSec, hostname, leaseType };
  return clientId === undefined ? base : { ...base, clientId };
}

function parsePacketCounters(value: unknown): RpcDhcpPacketCounters | undefined {
  const keys = [
    "packetsReceived", "packetsSentEstimate", "discoverCount", "offerCount", "requestCount", "declineCount", "ackCount", "nakCount",
    "releaseCount", "informCount",
  ];
  const fields = exactFields(value, keys, keys);
  if (!fields) return undefined;
  const parsed = keys.map((key) => safeInteger(fields.get(key)));
  if (parsed.some((entry) => entry === undefined)) return undefined;
  return {
    packetsReceived: parsed[0]!,
    packetsSentEstimate: parsed[1]!,
    discoverCount: parsed[2]!,
    offerCount: parsed[3]!,
    requestCount: parsed[4]!,
    declineCount: parsed[5]!,
    ackCount: parsed[6]!,
    nakCount: parsed[7]!,
    releaseCount: parsed[8]!,
    informCount: parsed[9]!,
  };
}

function parsePoolInfo(value: unknown): RpcDhcpPoolInfo | undefined {
  const fields = exactFields(value, ["rangeStart", "rangeEnd", "poolSize", "activeCount", "utilizationPct", "staticEntryCount"], [
    "rangeStart", "rangeEnd", "poolSize", "activeCount", "utilizationPct", "staticEntryCount",
  ]);
  if (!fields) return undefined;
  const rangeStart = boundedString(fields.get("rangeStart"), MAX_NETWORK_ADDRESS_BYTES);
  const rangeEnd = boundedString(fields.get("rangeEnd"), MAX_NETWORK_ADDRESS_BYTES);
  const poolSize = safeInteger(fields.get("poolSize"), 0, MAX_DHCP_POOL_SIZE);
  const activeCount = safeInteger(fields.get("activeCount"), 0, MAX_DHCP_RUNTIME_LEASES);
  const utilizationPct = finiteNumber(fields.get("utilizationPct"), 0, 100);
  const staticEntryCount = safeInteger(fields.get("staticEntryCount"), 0, MAX_STATIC_RESERVATIONS);
  if (
    rangeStart === undefined || rangeEnd === undefined || poolSize === undefined || activeCount === undefined
    || utilizationPct === undefined || staticEntryCount === undefined
  ) return undefined;
  return { rangeStart, rangeEnd, poolSize, activeCount, utilizationPct, staticEntryCount };
}

function parseTftpRuntime(fields: Fields): RpcTftpRuntimeSnapshot | undefined {
  if (!hasExactShape(fields, ["snapshot", "transfers", "root", "allowWrite", "boundPort"], ["snapshot", "transfers", "root", "allowWrite", "boundPort"])) return undefined;
  const snapshot = parseSnapshot(fields.get("snapshot"));
  const transfers = parsedArray(fields.get("transfers"), MAX_TFTP_TRANSFERS, parseTftpTransfer);
  const root = boundedString(fields.get("root"), MAX_PATH_BYTES);
  const allowWrite = fields.get("allowWrite");
  const boundPort = nullablePort(fields.get("boundPort"));
  if (!snapshot || snapshot.id !== "tftp" || !transfers || root === undefined || typeof allowWrite !== "boolean" || boundPort === undefined) return undefined;
  return { snapshot: snapshot as RpcTftpRuntimeSnapshot["snapshot"], transfers, root, allowWrite, boundPort };
}

function parseDhcpRuntime(fields: Fields): RpcDhcpRuntimeSnapshot | undefined {
  if (!hasExactShape(fields, ["snapshot", "leases", "packetCounters", "poolInfo", "boundPort"], ["snapshot", "leases", "packetCounters", "poolInfo", "boundPort"])) return undefined;
  const snapshot = parseSnapshot(fields.get("snapshot"));
  const leases = parsedArray(fields.get("leases"), MAX_DHCP_RUNTIME_LEASES, parseDhcpLease);
  const packetCounters = parsePacketCounters(fields.get("packetCounters"));
  const poolInfo = parsePoolInfo(fields.get("poolInfo"));
  const boundPort = nullablePort(fields.get("boundPort"));
  if (!snapshot || snapshot.id !== "dhcp" || !leases || !packetCounters || !poolInfo || boundPort === undefined) return undefined;
  return { snapshot: snapshot as RpcDhcpRuntimeSnapshot["snapshot"], leases, packetCounters, poolInfo, boundPort };
}

function hasExactShape(fields: Fields, allowed: readonly string[], required: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  for (const key of fields.keys()) {
    if (!allowedSet.has(key)) return false;
  }
  return required.every((key) => fields.has(key));
}

function parseRuntime(value: unknown): RpcRuntimeSnapshot | undefined {
  const fields = fieldsOf(value);
  if (!fields || !fields.has("snapshot")) return undefined;
  const snapshot = parseSnapshot(fields.get("snapshot"));
  if (!snapshot) return undefined;
  return snapshot.id === "tftp" ? parseTftpRuntime(fields) : parseDhcpRuntime(fields);
}

function parseListResult(value: unknown): readonly RpcServerSnapshot[] | undefined {
  const snapshots = parsedArray(value, MAX_SERVICE_COUNT, parseSnapshot);
  if (!snapshots) return undefined;
  const ids = new Set(snapshots.map((snapshot) => snapshot.id));
  return ids.size === snapshots.length ? snapshots : undefined;
}

function parseConfigureResult(value: unknown): RpcResult<"configure"> | undefined {
  const fields = exactFields(value, ["ok", "changed"], ["ok", "changed"]);
  if (!fields || fields.get("ok") !== true) return undefined;
  const changed = parsedArray(fields.get("changed"), MAX_SERVICE_COUNT, serviceId);
  if (!changed || new Set(changed).size !== changed.length) return undefined;
  return { ok: true, changed };
}

function parseLifecycleResult(value: unknown): { readonly ok: true; readonly id: RpcServiceId } | undefined {
  const fields = exactFields(value, ["ok", "id"], ["ok", "id"]);
  if (!fields || fields.get("ok") !== true) return undefined;
  const id = serviceId(fields.get("id"));
  return id ? { ok: true, id } : undefined;
}

function parseCancelTransferResult(value: unknown): RpcResult<"cancelTransfer"> | undefined {
  const fields = exactFields(value, ["ok", "id", "transferId"], ["ok", "id", "transferId"]);
  if (!fields || typeof fields.get("ok") !== "boolean" || fields.get("id") !== "tftp") return undefined;
  const transferId = boundedString(fields.get("transferId"), MAX_TRANSFER_ID_BYTES);
  return transferId === undefined ? undefined : { ok: fields.get("ok") as boolean, id: "tftp", transferId };
}

function resultParser<M extends RpcMethod>(parse: (value: unknown) => RpcResult<M> | undefined): (value: unknown) => RpcParseResult<RpcResult<M>> {
  return (value) => safely(() => {
    const parsed = parse(value);
    return parsed === undefined ? rejected("Malformed RPC result.") : accepted(parsed);
  });
}

export const rpcResultParsers = {
  list: resultParser<"list">(parseListResult),
  getStatus: resultParser<"getStatus">(parseSnapshot),
  configure: resultParser<"configure">(parseConfigureResult),
  start: resultParser<"start">(parseLifecycleResult),
  stop: resultParser<"stop">(parseLifecycleResult),
  restart: resultParser<"restart">(parseLifecycleResult),
  cancelTransfer: resultParser<"cancelTransfer">(parseCancelTransferResult),
  getServiceRuntime: resultParser<"getServiceRuntime">(parseRuntime),
} satisfies { readonly [Method in RpcMethod]: (value: unknown) => RpcParseResult<RpcResult<Method>> };

function parseConfig(value: unknown, id?: RpcServiceId): NetworkServerConfigs | undefined {
  const cloned = cloneJsonValue(value);
  if (cloned === undefined) return undefined;
  const configs = id === undefined
    ? cloned
    : id === "tftp" ? { tftp: cloned } : { dhcp: cloned };
  const parsed = parseNetworkServerConfigs(configs);
  return parsed.ok ? parsed.value : undefined;
}

function parseServiceParams(value: unknown): { readonly id: RpcServiceId } | undefined {
  const fields = exactFields(value, ["id"], ["id"]);
  const id = fields ? serviceId(fields.get("id")) : undefined;
  return id ? { id } : undefined;
}

function parseStartOrRestartParams(value: unknown): RpcParams<"start"> | undefined {
  const fields = exactFields(value, ["id", "config"], ["id"]);
  if (!fields) return undefined;
  const id = serviceId(fields.get("id"));
  if (!id) return undefined;
  if (!fields.has("config")) return { id };
  const configs = parseConfig(fields.get("config"), id);
  if (!configs) return undefined;
  return id === "tftp"
    ? { id, config: configs.tftp! }
    : { id, config: configs.dhcp! };
}

function parseRequestUnsafe(value: unknown): RpcParseResult<RpcRequest> {
  const fields = exactFields(value, ["id", "method", "params"], ["id", "method"]);
  if (!fields) return rejected("Malformed RPC request.");
  const id = safeInteger(fields.get("id"));
  const method = fields.get("method");
  if (id === undefined || typeof method !== "string") return rejected("Malformed RPC request.");

  switch (method) {
    case "list":
      return fields.has("params") ? rejected("Malformed RPC request.") : accepted({ id, method });
    case "getStatus":
    case "stop":
    case "getServiceRuntime": {
      if (!fields.has("params")) return rejected("Malformed RPC request.");
      const params = parseServiceParams(fields.get("params"));
      return params === undefined ? rejected("Malformed RPC request.") : accepted({ id, method, params });
    }
    case "configure": {
      if (!fields.has("params")) return rejected("Malformed RPC request.");
      const params = exactFields(fields.get("params"), ["configs"], ["configs"]);
      const configs = params ? parseConfig(params.get("configs")) : undefined;
      return configs === undefined ? rejected("Malformed RPC request.") : accepted({ id, method, params: { configs } });
    }
    case "start":
    case "restart": {
      if (!fields.has("params")) return rejected("Malformed RPC request.");
      const params = parseStartOrRestartParams(fields.get("params"));
      return params === undefined ? rejected("Malformed RPC request.") : accepted({ id, method, params });
    }
    case "cancelTransfer": {
      if (!fields.has("params")) return rejected("Malformed RPC request.");
      const params = exactFields(fields.get("params"), ["id", "transferId"], ["id", "transferId"]);
      const transferId = params ? boundedString(params.get("transferId"), MAX_TRANSFER_ID_BYTES) : undefined;
      if (!params || params.get("id") !== "tftp" || transferId === undefined) return rejected("Malformed RPC request.");
      return accepted({ id, method, params: { id: "tftp", transferId } });
    }
    default:
      return rejected("Unknown RPC method.");
  }
}

/** Parses an untrusted host-to-daemon request into one closed method variant. */
export function parseRpcRequest(value: unknown): RpcParseResult<RpcRequest> {
  return safely(() => parseRequestUnsafe(value));
}

function parseError(value: unknown): RpcError | undefined {
  const fields = exactFields(value, ["code", "message"], ["code", "message"]);
  if (!fields) return undefined;
  const code = boundedString(fields.get("code"), MAX_RPC_TEXT_BYTES);
  const message = boundedString(fields.get("message"), MAX_RPC_TEXT_BYTES, true);
  return code === undefined || message === undefined ? undefined : { code, message };
}

/** Parses a daemon-to-host response envelope; method-specific result validation happens separately. */
export function parseRpcEnvelope(value: unknown): RpcParseResult<RpcEnvelope> {
  return safely(() => {
    const fields = exactFields(value, ["id", "result", "error"], ["id"]);
    if (!fields) return rejected("Malformed RPC envelope.");
    const id = safeInteger(fields.get("id"));
    const hasResult = fields.has("result");
    const hasError = fields.has("error");
    if (id === undefined || hasResult === hasError) return rejected("Malformed RPC envelope.");
    if (hasResult) {
      const result = cloneJsonValue(fields.get("result"));
      return result === undefined ? rejected("Malformed RPC envelope.") : accepted({ id, result });
    }
    const error = parseError(fields.get("error"));
    return error === undefined ? rejected("Malformed RPC envelope.") : accepted({ id, error });
  });
}

function parseConnectionEvent(value: unknown): RpcConnectionEvent | undefined {
  const fields = exactFields(value, ["phase", "summary", "detail", "code", "id", "resource", "client"], ["phase", "summary"]);
  if (!fields) return undefined;
  const rawPhase = fields.get("phase");
  const phase = rawPhase === "started" || rawPhase === "completed" || rawPhase === "failed"
    ? rawPhase
    : undefined;
  const summary = boundedString(fields.get("summary"), MAX_RPC_TEXT_BYTES);
  const detail = !fields.has("detail") ? undefined : boundedString(fields.get("detail"), MAX_RPC_TEXT_BYTES, true);
  const code = !fields.has("code") ? undefined : boundedString(fields.get("code"), MAX_RPC_TEXT_BYTES);
  const id = !fields.has("id") ? undefined : boundedString(fields.get("id"), MAX_TRANSFER_ID_BYTES);
  const resource = !fields.has("resource") ? undefined : boundedString(fields.get("resource"), MAX_RPC_TEXT_BYTES);
  const client = !fields.has("client") ? undefined : boundedString(fields.get("client"), MAX_RPC_TEXT_BYTES);
  if (
    phase === undefined || summary === undefined || (fields.has("detail") && detail === undefined)
    || (fields.has("code") && code === undefined) || (fields.has("id") && id === undefined)
    || (fields.has("resource") && resource === undefined) || (fields.has("client") && client === undefined)
  ) return undefined;
  return {
    phase,
    summary,
    ...(detail === undefined ? {} : { detail }),
    ...(code === undefined ? {} : { code }),
    ...(id === undefined ? {} : { id }),
    ...(resource === undefined ? {} : { resource }),
    ...(client === undefined ? {} : { client }),
  };
}

function parseEventUnsafe(value: unknown): RpcParseResult<RpcEvent> {
  const fields = exactFields(value, ["event", "data"], ["event", "data"]);
  if (!fields || typeof fields.get("event") !== "string") return rejected("Malformed RPC event.");
  const event = fields.get("event");
  const data = fields.get("data");
  switch (event) {
    case "ready":
      return data === null ? accepted({ event, data }) : rejected("Malformed RPC event.");
    case "statusChange": {
      const eventData = exactFields(data, ["id", "status", "error"], ["id", "status"]);
      const id = eventData ? serviceId(eventData.get("id")) : undefined;
      const status = eventData ? serverStatus(eventData.get("status")) : undefined;
      const error = !eventData || !eventData.has("error") ? undefined : boundedString(eventData.get("error"), MAX_RPC_TEXT_BYTES, true);
      if (!eventData || !id || !status || (eventData.has("error") && error === undefined)) return rejected("Malformed RPC event.");
      return accepted(error === undefined ? { event, data: { id, status } } : { event, data: { id, status, error } });
    }
    case "log": {
      const eventData = exactFields(data, ["id", "level", "message"], ["id", "level", "message"]);
      const id = eventData ? logSource(eventData.get("id")) : undefined;
      const level = eventData ? logLevel(eventData.get("level")) : undefined;
      const message = eventData ? boundedString(eventData.get("message"), MAX_RPC_TEXT_BYTES, true) : undefined;
      return !eventData || !id || !level || message === undefined
        ? rejected("Malformed RPC event.")
        : accepted({ event, data: { id, level, message } });
    }
    case "runtimeUpdate": {
      const eventData = exactFields(data, ["id"], ["id"]);
      const id = eventData ? serviceId(eventData.get("id")) : undefined;
      return id ? accepted({ event, data: { id } }) : rejected("Malformed RPC event.");
    }
    case "connection": {
      const eventData = exactFields(data, ["id", "connection"], ["id", "connection"]);
      const id = eventData ? serviceId(eventData.get("id")) : undefined;
      const connection = eventData ? parseConnectionEvent(eventData.get("connection")) : undefined;
      return !id || !connection ? rejected("Malformed RPC event.") : accepted({ event, data: { id, connection } });
    }
    default:
      return rejected("Unknown RPC event.");
  }
}

/** Parses a daemon push notification into one closed event variant. */
export function parseRpcEvent(value: unknown): RpcParseResult<RpcEvent> {
  return safely(() => parseEventUnsafe(value));
}
