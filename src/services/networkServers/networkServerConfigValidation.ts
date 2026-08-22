/**
 * Pure, daemon-safe validation for network-server DTOs.
 *
 * This module deliberately has no VS Code dependency: the extension host uses
 * it to sanitize hand-edited settings, while the standalone daemon uses the
 * same checks to reject untrusted environment and RPC input before adapters
 * are created.
 */

import { DEFAULTS } from "./dhcp/engine/dhcpConstants";
import {
  isValidSubOptionCode,
  parseVendorOptionValue,
  type DhcpVendorSpecificEntry,
} from "./dhcp/engine/dhcpBootOptions";
import type { DhcpAdapterConfig } from "./dhcp/DhcpAdapter";
import type { TftpAdapterConfig } from "./tftp/TftpAdapter";
import type { NetworkServerConfigs } from "./core/index";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Must match the bounded allocator's accepted inclusive pool size. */
export const MAX_DHCP_POOL_SIZE = 65_536;

/** Port 0 is deliberately accepted for test and ephemeral OS-assigned binds. */
const MIN_PORT = 0;
const MAX_PORT = 65_535;
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 604_800;
const MAX_DHCP_STRING_BYTES = 255;
const MAX_PATH_BYTES = 4_096;
const MAX_DHCP_ARRAY_ENTRIES = 16;
const MAX_STATIC_RESERVATIONS = 1_024;
const MAX_VENDOR_SUBOPTIONS = 64;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasConfiguredValue(record: Record<string, unknown>, key: string): boolean {
  return hasOwn(record, key) && record[key] !== undefined;
}

/** Describes an untrusted value without invoking its coercion hooks. */
function safeValueDescription(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      if (Number.isNaN(value)) return "NaN";
      if (value === Number.POSITIVE_INFINITY) return "Infinity";
      if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
      return `${value}`;
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "function":
      return "function";
    default:
      return "object";
  }
}

function pushUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) errors.push(`${path}.${key}: Unknown configuration key.`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function ipv4ToInt(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (!Number.isSafeInteger(octet) || octet > 255) return undefined;
    result = result * 256 + octet;
  }
  return result;
}

function parseIpv4(value: unknown, path: string, label: string, errors: string[]): { readonly value: string; readonly numeric: number } | undefined {
  if (typeof value !== "string") {
    errors.push(`${path}: ${label} must be a dotted-quad IPv4 address (got "${safeValueDescription(value)}").`);
    return undefined;
  }
  const numeric = ipv4ToInt(value);
  if (numeric === undefined) {
    errors.push(`${path}: ${label} must be a dotted-quad IPv4 address (got "${value}").`);
    return undefined;
  }
  return { value, numeric };
}

function parseBoundedString(
  value: unknown,
  path: string,
  label: string,
  maximumBytes: number,
  errors: string[],
): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${path}: ${label} must be a string.`);
    return undefined;
  }
  if (value.length === 0) {
    errors.push(`${path}: ${label} must not be empty; omit it to use the default.`);
    return undefined;
  }
  const bytes = utf8Bytes(value);
  if (bytes > maximumBytes) {
    errors.push(`${path}: ${label} is ${bytes} bytes; the maximum is ${maximumBytes}.`);
    return undefined;
  }
  return value;
}

/** Parses a bounded string whose surrounding whitespace has no meaning. */
function parseTrimmedNonBlankString(
  value: unknown,
  path: string,
  label: string,
  maximumBytes: number,
  errors: string[],
): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${path}: ${label} must be a string.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${path}: ${label} must not be blank; omit it to serve boot options to every client.`);
    return undefined;
  }
  const bytes = utf8Bytes(trimmed);
  if (bytes > maximumBytes) {
    errors.push(`${path}: ${label} is ${bytes} bytes; the maximum is ${maximumBytes}.`);
    return undefined;
  }
  return trimmed;
}

function parsePort(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    errors.push(`${path}: Port must be a safe whole number between ${MIN_PORT} and ${MAX_PORT}.`);
    return undefined;
  }
  return value;
}

function parseLeaseTime(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_LEASE_SECONDS || value > MAX_LEASE_SECONDS) {
    errors.push(`${path}: Lease Time must be a safe whole number between ${MIN_LEASE_SECONDS} and ${MAX_LEASE_SECONDS} seconds.`);
    return undefined;
  }
  return value;
}

function parseBoolean(value: unknown, path: string, label: string, errors: string[]): boolean | undefined {
  if (typeof value !== "boolean") {
    errors.push(`${path}: ${label} must be a boolean.`);
    return undefined;
  }
  return value;
}

function canonicalMac(value: string): string | undefined {
  const match = /^([0-9a-f]{2})([:-])([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})$/i.exec(value);
  if (!match) return undefined;
  return [match[1], match[3], match[4], match[5], match[6], match[7]].join(":").toLowerCase();
}

function parseIpv4Array(
  value: unknown,
  path: string,
  label: string,
  errors: string[],
  minimumEntries = 0,
): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: ${label} must be an array of IPv4 addresses.`);
    return undefined;
  }
  if (value.length > MAX_DHCP_ARRAY_ENTRIES) {
    errors.push(`${path}: ${label} has ${value.length} entries; the maximum is ${MAX_DHCP_ARRAY_ENTRIES}.`);
    return undefined;
  }
  if (value.length < minimumEntries) {
    errors.push(`${path}: ${label} must contain at least ${minimumEntries} IPv4 address${minimumEntries === 1 ? "" : "es"}.`);
    return undefined;
  }
  const parsed: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = parseIpv4(value[index], `${path}[${index}]`, label.slice(0, -1), errors);
    if (entry) parsed.push(entry.value);
  }
  return parsed;
}

function parseStaticReservations(value: unknown, path: string, errors: string[]): Record<string, string> | undefined {
  if (!isPlainRecord(value)) {
    errors.push(`${path}: Static reservations must be a MAC-to-IPv4 object.`);
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_STATIC_RESERVATIONS) {
    errors.push(`${path}: Static reservations has ${entries.length} entries; the maximum is ${MAX_STATIC_RESERVATIONS}.`);
    return undefined;
  }
  const parsed: Record<string, string> = {};
  for (const [rawMac, rawIp] of entries) {
    const mac = canonicalMac(rawMac);
    if (!mac) {
      errors.push(`${path}.${rawMac}: Static reservation MAC addresses must be canonicalizable six-octet addresses.`);
      continue;
    }
    if (hasOwn(parsed, mac)) {
      errors.push(`${path}.${rawMac}: Static reservation MAC aliases must not duplicate ${mac}.`);
      continue;
    }
    const ip = parseIpv4(rawIp, `${path}.${mac}`, "Static reservation address", errors);
    if (ip) parsed[mac] = ip.value;
  }
  return parsed;
}

function parseVendorSpecificOptions(value: unknown, path: string, errors: string[]): DhcpVendorSpecificEntry[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: Vendor-specific options must be an array.`);
    return undefined;
  }
  if (value.length > MAX_VENDOR_SUBOPTIONS) {
    errors.push(`${path}: Vendor-specific options has ${value.length} entries; the maximum is ${MAX_VENDOR_SUBOPTIONS}.`);
    return undefined;
  }
  const parsed: DhcpVendorSpecificEntry[] = [];
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = value[index];
    if (!isPlainRecord(entry)) {
      errors.push(`${entryPath}: Vendor-specific option entries must be objects.`);
      continue;
    }
    pushUnknownKeys(entry, ["subOption", "value"], entryPath, errors);
    const subOption = entry.subOption;
    const rawValue = entry.value;
    if (typeof subOption !== "number" || !isValidSubOptionCode(subOption)) {
      errors.push(`${entryPath}.subOption: Vendor sub-option code must be an integer between 1 and 254.`);
      continue;
    }
    const optionValue = parseBoundedString(rawValue, `${entryPath}.value`, "Vendor sub-option value", MAX_DHCP_STRING_BYTES, errors);
    if (optionValue === undefined) continue;
    let bytes: Buffer;
    try {
      bytes = parseVendorOptionValue(optionValue);
    } catch (error) {
      errors.push(`${entryPath}.value: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (bytes.length > MAX_DHCP_STRING_BYTES) {
      errors.push(`${entryPath}.value: Vendor sub-option value is ${bytes.length} bytes; the maximum is ${MAX_DHCP_STRING_BYTES}.`);
      continue;
    }
    totalBytes += bytes.length + 2;
    parsed.push({ subOption, value: optionValue });
  }
  if (totalBytes > MAX_DHCP_STRING_BYTES) {
    errors.push(`${path}: Vendor option 43 payload is ${totalBytes} bytes; the maximum is ${MAX_DHCP_STRING_BYTES}.`);
    return undefined;
  }
  return parsed;
}

function parseTftpConfigAt(value: unknown, path: string): ValidationResult<TftpAdapterConfig> {
  const errors: string[] = [];
  if (!isPlainRecord(value)) return { ok: false, errors: [`${path}: TFTP configuration must be an object.`] };
  pushUnknownKeys(value, ["root", "port", "allowWrite", "interface"], path, errors);
  const parsed: Mutable<TftpAdapterConfig> = {};
  if (hasOwn(value, "root")) {
    const root = parseBoundedString(value.root, `${path}.root`, "Root", MAX_PATH_BYTES, errors);
    if (root !== undefined) parsed.root = root;
  }
  if (hasOwn(value, "port")) {
    const port = parsePort(value.port, `${path}.port`, errors);
    if (port !== undefined) parsed.port = port;
  }
  if (hasOwn(value, "allowWrite")) {
    const allowWrite = parseBoolean(value.allowWrite, `${path}.allowWrite`, "Allow Write", errors);
    if (allowWrite !== undefined) parsed.allowWrite = allowWrite;
  }
  if (hasOwn(value, "interface")) {
    const address = parseIpv4(value.interface, `${path}.interface`, "Interface", errors);
    if (address) parsed.interface = address.value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed, warnings: [] };
}

function parseDhcpConfigAt(value: unknown, path: string): ValidationResult<DhcpAdapterConfig> {
  const errors: string[] = [];
  if (!isPlainRecord(value)) return { ok: false, errors: [`${path}: DHCP configuration must be an object.`] };
  const keys = [
    "rangeStart", "rangeEnd", "subnet", "gateway", "dns", "leaseTimeSec", "serverId", "broadcast", "static",
    "bindAddress", "leaseStorePath", "bootFileName", "nextServer", "tftpServerAddresses", "vendorClassId", "vendorSpecificOptions",
  ];
  pushUnknownKeys(value, keys, path, errors);
  const parsed: Mutable<DhcpAdapterConfig> = {};
  const numericRanges: { rangeStart?: number; rangeEnd?: number } = {};

  if (hasOwn(value, "rangeStart")) {
    const address = parseIpv4(value.rangeStart, `${path}.rangeStart`, "Pool Start", errors);
    if (address) {
      parsed.rangeStart = address.value;
      numericRanges.rangeStart = address.numeric;
    }
  }
  if (hasOwn(value, "rangeEnd")) {
    const address = parseIpv4(value.rangeEnd, `${path}.rangeEnd`, "Pool End", errors);
    if (address) {
      parsed.rangeEnd = address.value;
      numericRanges.rangeEnd = address.numeric;
    }
  }
  if (hasOwn(value, "gateway")) {
    const address = parseIpv4(value.gateway, `${path}.gateway`, "Gateway", errors);
    if (address) parsed.gateway = address.value;
  }
  if (hasOwn(value, "serverId")) {
    const address = parseIpv4(value.serverId, `${path}.serverId`, "Server Identifier", errors);
    if (address) parsed.serverId = address.value;
  }
  if (hasOwn(value, "broadcast")) {
    const address = parseIpv4(value.broadcast, `${path}.broadcast`, "Broadcast Address", errors);
    if (address) parsed.broadcast = address.value;
  }
  if (hasOwn(value, "bindAddress")) {
    const address = parseIpv4(value.bindAddress, `${path}.bindAddress`, "Interface", errors);
    if (address) parsed.bindAddress = address.value;
  }
  if (hasOwn(value, "subnet")) {
    const subnet = parseIpv4(value.subnet, `${path}.subnet`, "Subnet Mask", errors);
    if (subnet) {
      const inverted = (~subnet.numeric) >>> 0;
      if (((inverted + 1) & inverted) !== 0) {
        errors.push(`${path}.subnet: Subnet Mask "${subnet.value}" is not a valid netmask — its set bits must be contiguous (e.g. 255.255.255.0).`);
      } else {
        parsed.subnet = subnet.value;
      }
    }
  }
  if (hasOwn(value, "dns")) {
    const dns = parseIpv4Array(value.dns, `${path}.dns`, "DNS servers", errors, 1);
    if (dns !== undefined) parsed.dns = dns;
  }
  if (hasOwn(value, "tftpServerAddresses")) {
    const addresses = parseIpv4Array(value.tftpServerAddresses, `${path}.tftpServerAddresses`, "TFTP server addresses", errors);
    if (addresses !== undefined) parsed.tftpServerAddresses = addresses;
  }
  if (hasOwn(value, "leaseTimeSec")) {
    const leaseTimeSec = parseLeaseTime(value.leaseTimeSec, `${path}.leaseTimeSec`, errors);
    if (leaseTimeSec !== undefined) parsed.leaseTimeSec = leaseTimeSec;
  }
  if (hasOwn(value, "static")) {
    const staticReservations = parseStaticReservations(value.static, `${path}.static`, errors);
    if (staticReservations !== undefined) parsed.static = staticReservations;
  }
  if (hasOwn(value, "leaseStorePath")) {
    const text = parseBoundedString(value.leaseStorePath, `${path}.leaseStorePath`, "Lease Store Path", MAX_PATH_BYTES, errors);
    if (text !== undefined) parsed.leaseStorePath = text;
  }
  if (hasOwn(value, "bootFileName")) {
    const text = parseBoundedString(value.bootFileName, `${path}.bootFileName`, "Boot File Name", MAX_DHCP_STRING_BYTES, errors);
    if (text !== undefined) parsed.bootFileName = text;
  }
  if (hasOwn(value, "nextServer")) {
    const address = parseIpv4(value.nextServer, `${path}.nextServer`, "Next Server", errors);
    if (address) parsed.nextServer = address.value;
  }
  if (hasOwn(value, "vendorClassId")) {
    const text = parseTrimmedNonBlankString(value.vendorClassId, `${path}.vendorClassId`, "Vendor Class Identifier", MAX_DHCP_STRING_BYTES, errors);
    if (text !== undefined) parsed.vendorClassId = text;
  }
  if (hasOwn(value, "vendorSpecificOptions")) {
    const options = parseVendorSpecificOptions(value.vendorSpecificOptions, `${path}.vendorSpecificOptions`, errors);
    if (options !== undefined) parsed.vendorSpecificOptions = options;
  }

  const rangeStart = numericRanges.rangeStart ?? ipv4ToInt(DEFAULTS.rangeStart)!;
  const rangeEnd = numericRanges.rangeEnd ?? ipv4ToInt(DEFAULTS.rangeEnd)!;
  if (numericRanges.rangeStart !== undefined || numericRanges.rangeEnd !== undefined) {
    if (rangeStart > rangeEnd) {
      const start = parsed.rangeStart ?? DEFAULTS.rangeStart;
      const end = parsed.rangeEnd ?? DEFAULTS.rangeEnd;
      errors.push(`${path}.rangeStart: Pool Start (${start}) must not be higher than Pool End (${end}).`);
    } else if (rangeEnd - rangeStart + 1 > MAX_DHCP_POOL_SIZE) {
      errors.push(`${path}.rangeEnd: DHCP pool size must not exceed ${MAX_DHCP_POOL_SIZE.toLocaleString("en-US")} addresses.`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed, warnings: [] };
}

/**
 * Sanitizes a settings-originated TFTP object. Unlike daemon DTO parsing, a
 * bad field falls back to the adapter default while valid sibling fields are
 * preserved; every dropped field is returned as a warning for one host-side
 * diagnostic.
 */
export function sanitizeTftpConfig(value: unknown): { readonly value: TftpAdapterConfig; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  if (!isPlainRecord(value)) return { value: {}, warnings: ["tftp: TFTP configuration must be an object."] };
  pushUnknownKeys(value, ["root", "port", "allowWrite", "interface"], "tftp", warnings);
  const parsed: Mutable<TftpAdapterConfig> = {};
  if (hasConfiguredValue(value, "root")) {
    const root = parseBoundedString(value.root, "tftp.root", "Root", MAX_PATH_BYTES, warnings);
    if (root !== undefined) parsed.root = root;
  }
  if (hasConfiguredValue(value, "port")) {
    const port = parsePort(value.port, "tftp.port", warnings);
    if (port !== undefined) parsed.port = port;
  }
  if (hasConfiguredValue(value, "allowWrite")) {
    const allowWrite = parseBoolean(value.allowWrite, "tftp.allowWrite", "Allow Write", warnings);
    if (allowWrite !== undefined) parsed.allowWrite = allowWrite;
  }
  if (hasConfiguredValue(value, "interface")) {
    const address = parseIpv4(value.interface, "tftp.interface", "Interface", warnings);
    if (address) parsed.interface = address.value;
  }
  return { value: parsed, warnings };
}

/**
 * Sanitizes settings-originated DHCP fields using the same primitive checks as
 * {@link parseDhcpConfig}. This is deliberately field-tolerant only at the
 * settings boundary; daemon environment and RPC DTOs must use the strict
 * parser above and are rejected as a whole.
 */
export function sanitizeDhcpConfig(value: unknown): { readonly value: DhcpAdapterConfig; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  if (!isPlainRecord(value)) return { value: {}, warnings: ["dhcp: DHCP configuration must be an object."] };
  const keys = [
    "rangeStart", "rangeEnd", "subnet", "gateway", "dns", "leaseTimeSec", "serverId", "broadcast", "static",
    "bindAddress", "leaseStorePath", "bootFileName", "nextServer", "tftpServerAddresses", "vendorClassId", "vendorSpecificOptions",
  ];
  pushUnknownKeys(value, keys, "dhcp", warnings);
  const parsed: Mutable<DhcpAdapterConfig> = {};
  const numericRanges: { rangeStart?: number; rangeEnd?: number } = {};
  if (hasConfiguredValue(value, "rangeStart")) {
    const address = parseIpv4(value.rangeStart, "dhcp.rangeStart", "Pool Start", warnings);
    if (address) {
      parsed.rangeStart = address.value;
      numericRanges.rangeStart = address.numeric;
    }
  }
  if (hasConfiguredValue(value, "rangeEnd")) {
    const address = parseIpv4(value.rangeEnd, "dhcp.rangeEnd", "Pool End", warnings);
    if (address) {
      parsed.rangeEnd = address.value;
      numericRanges.rangeEnd = address.numeric;
    }
  }
  if (hasConfiguredValue(value, "gateway")) {
    const address = parseIpv4(value.gateway, "dhcp.gateway", "Gateway", warnings);
    if (address) parsed.gateway = address.value;
  }
  if (hasConfiguredValue(value, "serverId")) {
    const address = parseIpv4(value.serverId, "dhcp.serverId", "Server Identifier", warnings);
    if (address) parsed.serverId = address.value;
  }
  if (hasConfiguredValue(value, "broadcast")) {
    const address = parseIpv4(value.broadcast, "dhcp.broadcast", "Broadcast Address", warnings);
    if (address) parsed.broadcast = address.value;
  }
  if (hasConfiguredValue(value, "bindAddress")) {
    const address = parseIpv4(value.bindAddress, "dhcp.bindAddress", "Interface", warnings);
    if (address) parsed.bindAddress = address.value;
  }
  if (hasConfiguredValue(value, "subnet")) {
    const subnet = parseIpv4(value.subnet, "dhcp.subnet", "Subnet Mask", warnings);
    if (subnet) {
      const inverted = (~subnet.numeric) >>> 0;
      if (((inverted + 1) & inverted) !== 0) {
        warnings.push(`dhcp.subnet: Subnet Mask "${subnet.value}" is not a valid netmask — its set bits must be contiguous (e.g. 255.255.255.0).`);
      } else {
        parsed.subnet = subnet.value;
      }
    }
  }
  if (hasConfiguredValue(value, "dns")) {
    const dns = parseIpv4Array(value.dns, "dhcp.dns", "DNS servers", warnings, 1);
    if (dns && dns.length > 0) parsed.dns = dns;
  }
  if (hasConfiguredValue(value, "tftpServerAddresses")) {
    const addresses = parseIpv4Array(value.tftpServerAddresses, "dhcp.tftpServerAddresses", "TFTP server addresses", warnings);
    if (addresses && addresses.length > 0) parsed.tftpServerAddresses = addresses;
  }
  if (hasConfiguredValue(value, "leaseTimeSec")) {
    const leaseTimeSec = parseLeaseTime(value.leaseTimeSec, "dhcp.leaseTimeSec", warnings);
    if (leaseTimeSec !== undefined) parsed.leaseTimeSec = leaseTimeSec;
  }
  if (hasConfiguredValue(value, "static")) {
    const staticReservations = parseStaticReservations(value.static, "dhcp.static", warnings);
    if (staticReservations && Object.keys(staticReservations).length > 0) parsed.static = staticReservations;
  }
  if (hasConfiguredValue(value, "leaseStorePath")) {
    const text = parseBoundedString(value.leaseStorePath, "dhcp.leaseStorePath", "Lease Store Path", MAX_PATH_BYTES, warnings);
    if (text !== undefined) parsed.leaseStorePath = text;
  }
  if (hasConfiguredValue(value, "bootFileName")) {
    const text = parseBoundedString(value.bootFileName, "dhcp.bootFileName", "Boot File Name", MAX_DHCP_STRING_BYTES, warnings);
    if (text !== undefined) parsed.bootFileName = text;
  }
  if (hasConfiguredValue(value, "nextServer")) {
    const address = parseIpv4(value.nextServer, "dhcp.nextServer", "Next Server", warnings);
    if (address) parsed.nextServer = address.value;
  }
  if (hasConfiguredValue(value, "vendorClassId")) {
    const text = parseTrimmedNonBlankString(value.vendorClassId, "dhcp.vendorClassId", "Vendor Class Identifier", MAX_DHCP_STRING_BYTES, warnings);
    if (text !== undefined) parsed.vendorClassId = text;
  }
  if (hasConfiguredValue(value, "vendorSpecificOptions")) {
    const options = parseVendorSpecificOptions(value.vendorSpecificOptions, "dhcp.vendorSpecificOptions", warnings);
    if (options && options.length > 0) parsed.vendorSpecificOptions = options;
  }

  if (numericRanges.rangeStart !== undefined || numericRanges.rangeEnd !== undefined) {
    const rangeStart = numericRanges.rangeStart ?? ipv4ToInt(DEFAULTS.rangeStart)!;
    const rangeEnd = numericRanges.rangeEnd ?? ipv4ToInt(DEFAULTS.rangeEnd)!;
    if (rangeStart > rangeEnd || rangeEnd - rangeStart + 1 > MAX_DHCP_POOL_SIZE) {
      const start = parsed.rangeStart ?? DEFAULTS.rangeStart;
      const end = parsed.rangeEnd ?? DEFAULTS.rangeEnd;
      if (rangeStart > rangeEnd) {
        if (numericRanges.rangeStart !== undefined) {
          warnings.push(`dhcp.rangeStart: Pool Start (${start}) is above Pool End (${end}), which describes an empty pool.`);
          delete parsed.rangeStart;
        }
        if (numericRanges.rangeEnd !== undefined) {
          warnings.push(`dhcp.rangeEnd: Pool Start (${start}) is above Pool End (${end}), which describes an empty pool.`);
          delete parsed.rangeEnd;
        }
      } else {
        if (numericRanges.rangeStart !== undefined) {
          warnings.push(`dhcp.rangeStart: DHCP pool size must not exceed ${MAX_DHCP_POOL_SIZE.toLocaleString("en-US")} addresses.`);
          delete parsed.rangeStart;
        }
        if (numericRanges.rangeEnd !== undefined) {
          warnings.push(`dhcp.rangeEnd: DHCP pool size must not exceed ${MAX_DHCP_POOL_SIZE.toLocaleString("en-US")} addresses.`);
          delete parsed.rangeEnd;
        }
      }
    }
  }
  return { value: parsed, warnings };
}

/** Strictly validates a daemon-facing DHCP configuration DTO. */
export function parseDhcpConfig(value: unknown): ValidationResult<DhcpAdapterConfig> {
  return parseDhcpConfigAt(value, "dhcp");
}

/** Strictly validates the complete daemon configuration DTO. */
export function parseNetworkServerConfigs(value: unknown): ValidationResult<NetworkServerConfigs> {
  if (!isPlainRecord(value)) return { ok: false, errors: ["configs: Network server configuration must be an object."] };
  const errors: string[] = [];
  pushUnknownKeys(value, ["tftp", "dhcp"], "configs", errors);
  const parsed: Mutable<NetworkServerConfigs> = {};
  if (hasOwn(value, "tftp")) {
    const tftp = parseTftpConfigAt(value.tftp, "tftp");
    if (tftp.ok) parsed.tftp = tftp.value;
    else errors.push(...tftp.errors);
  }
  if (hasOwn(value, "dhcp")) {
    const dhcp = parseDhcpConfigAt(value.dhcp, "dhcp");
    if (dhcp.ok) parsed.dhcp = dhcp.value;
    else errors.push(...dhcp.errors);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed, warnings: [] };
}

function formString(values: Record<string, unknown>, key: string): unknown {
  if (!hasOwn(values, key)) return undefined;
  const value = values[key];
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formNumber(values: Record<string, unknown>, key: string): unknown {
  const value = formString(values, key);
  if (typeof value !== "string") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function formBoolean(values: Record<string, unknown>, key: string): unknown {
  const value = formString(values, key);
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  return value;
}

interface FormPoolCount {
  readonly value?: number;
  readonly error?: string;
}

function parseFormPoolCount(values: Record<string, unknown>): FormPoolCount {
  if (!hasOwn(values, "poolCount") || values.poolCount === undefined) return {};
  const raw = values.poolCount;
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { error: 'Pool Count must be a whole number of at least 1 (got "").' };
    }
    value = Number(trimmed);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return { error: `Pool Count must be a safe whole number of at least 1 (got "${safeValueDescription(raw)}").` };
  }
  if (value > MAX_DHCP_POOL_SIZE) {
    return { error: `Pool Count must not exceed ${MAX_DHCP_POOL_SIZE.toLocaleString("en-US")} addresses.` };
  }
  return { value };
}

function intToIpv4(value: number): string {
  return [
    Math.floor(value / 16_777_216) % 256,
    Math.floor(value / 65_536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join(".");
}

function formRangeEnd(count: number | undefined, rangeStart: unknown): string | undefined {
  if (count === undefined) return undefined;
  const start = typeof rangeStart === "string" ? ipv4ToInt(rangeStart) : undefined;
  const effectiveStart = start ?? ipv4ToInt(DEFAULTS.rangeStart);
  if (effectiveStart === undefined) return undefined;
  const end = effectiveStart + count - 1;
  if (end > 0xffff_ffff) return undefined;
  return intToIpv4(end);
}

function formCommaList(values: Record<string, unknown>, key: string): unknown {
  const value = formString(values, key);
  if (typeof value !== "string") return value;
  const entries = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function formStaticReservations(values: Record<string, unknown>): unknown {
  const value = formString(values, "static");
  if (typeof value !== "string") return value;
  const entries: Record<string, unknown> = {};
  let invalidLine = 0;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) {
      invalidLine += 1;
      entries[`invalid-static-line-${invalidLine}`] = "";
      continue;
    }
    entries[line.slice(0, equalIndex).trim()] = line.slice(equalIndex + 1).trim();
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function formVendorSpecificOptions(values: Record<string, unknown>): unknown {
  const value = formString(values, "vendorSpecificOptions");
  if (typeof value !== "string") return value;
  const entries: Array<Record<string, unknown>> = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) {
      entries.push({ subOption: 0, value: "" });
      continue;
    }
    entries.push({ subOption: Number(line.slice(0, equalIndex).trim()), value: line.slice(equalIndex + 1).trim() });
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * Returns the first DHCP form error using the historic editor-facing copy.
 * It deliberately strips only the parser's leading field path; validation is
 * still performed by the same daemon-safe field validators.
 */
export function validateTftpFormInput(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return "TFTP form values must be an object.";
  const values = input;
  const config: Record<string, unknown> = {};
  for (const key of ["root", "port", "interface"] as const) {
    const value = key === "port" ? formNumber(values, key) : formString(values, key);
    if (value !== undefined) config[key] = value;
  }
  const allowWrite = formBoolean(values, "allowWrite");
  if (allowWrite !== undefined) config.allowWrite = allowWrite;
  const result = parseNetworkServerConfigs({ tftp: config });
  if (!result.ok) return result.errors[0]?.replace(/^tftp\.[^:]+:\s*/, "");
  if (config.port === 0) return `Port must be a safe whole number between 1 and ${MAX_PORT}.`;
  return undefined;
}

export function validateDhcpFormInput(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return "DHCP form values must be an object.";
  const values = input;
  const poolCount = parseFormPoolCount(values);
  if (poolCount.error) return poolCount.error;
  const config: Record<string, unknown> = {};
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["rangeStart", "rangeStart"], ["rangeEnd", "rangeEnd"], ["subnet", "subnet"], ["gateway", "gateway"],
    ["serverId", "serverId"], ["broadcast", "broadcast"], ["interface", "bindAddress"],
  ];
  for (const [formKey, configKey] of fields) {
    const value = formString(values, formKey);
    if (value !== undefined) config[configKey] = value;
  }
  const derivedRangeEnd = formRangeEnd(poolCount.value, config.rangeStart);
  if (derivedRangeEnd !== undefined) config.rangeEnd = derivedRangeEnd;
  const arrays: ReadonlyArray<readonly [string, string]> = [
    ["dns", "dns"], ["tftpServerAddresses", "tftpServerAddresses"],
  ];
  for (const [formKey, configKey] of arrays) {
    const value = formCommaList(values, formKey);
    if (value !== undefined) config[configKey] = value;
  }
  const leaseTimeSec = formNumber(values, "leaseTimeSec");
  if (leaseTimeSec !== undefined) config.leaseTimeSec = leaseTimeSec;
  const staticReservations = formStaticReservations(values);
  if (staticReservations !== undefined) config.static = staticReservations;
  const vendorSpecificOptions = formVendorSpecificOptions(values);
  if (vendorSpecificOptions !== undefined) config.vendorSpecificOptions = vendorSpecificOptions;
  for (const key of ["bootFileName", "nextServer", "vendorClassId"] as const) {
    const value = formString(values, key);
    if (value !== undefined) config[key] = value;
  }
  const result = parseDhcpConfig(config);
  if (result.ok) return undefined;
  return result.errors[0]?.replace(/^dhcp\.[^:]+:\s*/, "");
}
