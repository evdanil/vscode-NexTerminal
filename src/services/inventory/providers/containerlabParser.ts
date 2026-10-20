import {
  CONTAINERLAB_MAX_NODES,
  CONTAINERLAB_MIN_VERSION,
  type ContainerlabConfig
} from "./containerlabConfig";
import type { ContainerlabInspection } from "../containerlabRuntimeContracts";
import {
  InventoryProviderError,
  flattenProviderText,
  normalizeInventoryEndpointHost,
  type InventoryDevice,
  type InventoryDeviceStatus,
  type InventoryStatusReport,
  type InventoryTree
} from "../../../models/inventory";

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;

interface ValidatedRow {
  readonly labName: string;
  readonly containerName: string;
  readonly externalId: string;
  readonly image: string;
  readonly state: string;
  readonly ipv4?: string;
  readonly ipv6?: string;
  readonly labels: Record<string, string>;
  readonly nodeName?: string;
}

function protocol(message: string): never {
  throw new InventoryProviderError("protocol", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, allowEmpty = false, allowJsonWhitespace = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim() === "") ||
    (allowJsonWhitespace
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
      : CONTROL_CHARACTER_RE.test(value))
  ) {
    return protocol(`Containerlab inspection field "${field}" must be text.`);
  }
  return value;
}

function safeDisplayText(value: string, field = "text", required = false): string {
  const safe = flattenProviderText(value);
  if (required && safe.length === 0) {
    return protocol(`Containerlab inspection field "${field}" must not be empty.`);
  }
  return safe;
}

function parseVersion(version: string): readonly [number, number, number, string | undefined] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) {
    return protocol(`Containerlab reported an invalid version "${safeDisplayText(version, "version")}".`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return protocol("Containerlab reported an invalid version.");
  }
  return [major, minor, patch, match[4]];
}

function assertSupportedVersion(version: string): void {
  const [major, minor, patch, prerelease] = parseVersion(version);
  if (major === 0 && (minor < 68 || (minor === 68 && patch === 0 && prerelease !== undefined))) {
    return protocol(`Containerlab ${CONTAINERLAB_MIN_VERSION} or later is required for detailed inspection JSON. Upgrade Containerlab on the selected lab host.`);
  }
}

function validateLabels(raw: unknown, labName: string): Record<string, string> {
  if (!isRecord(raw)) {
    return protocol(`Containerlab inspection row for lab "${safeDisplayText(labName)}" has no valid label map.`);
  }
  const labels = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "" || CONTROL_CHARACTER_RE.test(key) || typeof value !== "string") {
      return protocol(`Containerlab inspection row for lab "${safeDisplayText(labName)}" has a malformed label map.`);
    }
    labels[key] = value;
  }
  if (labels.containerlab !== labName) {
    return protocol(`Containerlab inspection row for lab "${safeDisplayText(labName)}" has a mismatched containerlab label.`);
  }
  return labels;
}

function validatePrefixLength(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    return protocol(`Containerlab inspection field "${field}" must be an integer from 0 to ${maximum}.`);
  }
  return value;
}

function validateNetworkSettings(raw: unknown, labName: string): Record<string, unknown> {
  if (!isRecord(raw)) {
    return protocol(`Containerlab inspection row for lab "${safeDisplayText(labName)}" has no valid NetworkSettings object.`);
  }
  requiredString(raw.IPv4addr, "NetworkSettings.IPv4addr", true);
  requiredString(raw.IPv6addr, "NetworkSettings.IPv6addr", true);
  validatePrefixLength(raw.IPv4pLen, "NetworkSettings.IPv4pLen", 32);
  validatePrefixLength(raw.IPv6pLen, "NetworkSettings.IPv6pLen", 128);
  return raw;
}

function validIpv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function validIpv6(host: string): boolean {
  if (host === "" || host.includes("%") || host.includes(":::")) {
    return false;
  }
  const doubleColon = host.indexOf("::");
  if (doubleColon !== -1 && host.indexOf("::", doubleColon + 2) !== -1) {
    return false;
  }
  const hasCompression = doubleColon !== -1;
  const [leftText, rightText = ""] = hasCompression ? host.split("::") : [host, ""];
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  const groups = [...left, ...right];
  let groupCount = groups.length;
  if (groups.some((group) => group.includes("."))) {
    if (
      groups.length === 0 ||
      !groups.at(-1)?.includes(".") ||
      (hasCompression && left.some((group) => group.includes(".")))
    ) {
      return false;
    }
    const ipv4 = groups.at(-1)!;
    if (!validIpv4(ipv4)) {
      return false;
    }
    groupCount++;
  }
  if (groups.some((group) => group === "" || (group.includes(".") ? false : !/^[0-9a-f]{1,4}$/iu.test(group)))) {
    return false;
  }
  return hasCompression ? groupCount < 8 : groupCount === 8;
}

function parseAddress(
  raw: string,
  family: "ipv4" | "ipv6",
  prefixLength: number,
  labName: string,
  containerName: string
): string | undefined {
  if (raw === "") {
    return undefined;
  }
  const pieces = raw.split("/");
  if (pieces.length > 2) {
    return protocol(`Containerlab address for "${safeDisplayText(containerName)}" in lab "${safeDisplayText(labName)}" has an invalid CIDR suffix.`);
  }
  const host = pieces[0];
  if (pieces.length === 2) {
    const cidrPrefix = pieces[1];
    const maximum = family === "ipv4" ? 32 : 128;
    if (!/^\d+$/u.test(cidrPrefix) || Number(cidrPrefix) > maximum || Number(cidrPrefix) !== prefixLength) {
      return protocol(`Containerlab address for "${safeDisplayText(containerName)}" in lab "${safeDisplayText(labName)}" has an invalid CIDR suffix.`);
    }
  }
  const familyValid = family === "ipv4" ? validIpv4(host) : validIpv6(host);
  if (!familyValid || normalizeInventoryEndpointHost(host) !== host) {
    return protocol(`Containerlab address for "${safeDisplayText(containerName)}" in lab "${safeDisplayText(labName)}" is invalid.`);
  }
  return host;
}

function labFolderSegment(labName: string): string {
  let segment = encodeURIComponent(labName);
  if (segment === "." || segment === "..") {
    segment = segment.replace(/\./gu, "%2E");
  }
  return segment;
}

function validateRow(raw: unknown, labName: string, identities: Set<string>): ValidatedRow {
  if (labName === "" || CONTROL_CHARACTER_RE.test(labName)) {
    return protocol("Containerlab detailed inspection contains an invalid lab name.");
  }
  if (!isRecord(raw)) {
    return protocol(`Containerlab inspection row in lab "${safeDisplayText(labName)}" must be an object.`);
  }
  const namesRaw = raw.Names;
  if (!Array.isArray(namesRaw) || namesRaw.length === 0 || !namesRaw.every((name) => typeof name === "string")) {
    return protocol(`Containerlab inspection row in lab "${safeDisplayText(labName)}" has malformed Names.`);
  }
  const containerName = (namesRaw[0] as string).replace(/^\/+/, "");
  if (!containerName || safeDisplayText(containerName, "Names[0]", true) !== containerName) {
    return protocol(`Containerlab inspection row in lab "${safeDisplayText(labName)}" has an invalid container name.`);
  }
  for (const name of namesRaw) {
    if (safeDisplayText(name as string, "Names") !== name) {
      return protocol(`Containerlab inspection row in lab "${safeDisplayText(labName)}" has an invalid Names value.`);
    }
  }
  requiredString(raw.ID, "ID");
  const image = requiredString(raw.Image, "Image");
  const state = requiredString(raw.State, "State");
  requiredString(raw.Status, "Status");
  const labels = validateLabels(raw.Labels, labName);
  const networkSettings = validateNetworkSettings(raw.NetworkSettings, labName);
  const ipv4 = parseAddress(
    networkSettings.IPv4addr as string,
    "ipv4",
    networkSettings.IPv4pLen as number,
    labName,
    containerName
  );
  const ipv6 = parseAddress(
    networkSettings.IPv6addr as string,
    "ipv6",
    networkSettings.IPv6pLen as number,
    labName,
    containerName
  );
  const externalId = JSON.stringify([labName, containerName]);
  if (identities.has(externalId)) {
    return protocol(`Containerlab inspection contains duplicate identity for "${safeDisplayText(containerName)}" in lab "${safeDisplayText(labName)}".`);
  }
  identities.add(externalId);
  const helper = labels["clab-internal-node"] === "true";
  const nodeName = helper ? undefined : safeDisplayText(labels["clab-node-name"] ?? "", "clab-node-name", true);
  return {
    labName,
    containerName,
    externalId,
    image,
    state,
    labels,
    ...(ipv4 ? { ipv4 } : {}),
    ...(ipv6 ? { ipv6 } : {}),
    ...(nodeName ? { nodeName } : {})
  };
}

function mapDevice(row: ValidatedRow, config: ContainerlabConfig): InventoryDevice {
  const ipv4 = row.ipv4;
  const ipv6 = row.ipv6;
  const preferred = config.addressPreference === "ipv4" ? ipv4 : ipv6;
  const fallback = config.addressPreference === "ipv4" ? ipv6 : ipv4;
  const address = preferred ?? fallback;
  const nodeName = row.nodeName!;
  const lab = safeDisplayText(row.labName, "lab name", true);
  const kind = safeDisplayText(row.labels["clab-node-kind"] ?? "", "clab-node-kind");
  const image = safeDisplayText(row.image, "Image");
  const attributes: Record<string, string> = {
    lab,
    nodeName,
    name: nodeName
  };
  if (kind) attributes.kind = kind;
  if (image) attributes.image = image;
  return {
    externalId: row.externalId,
    name: nodeName,
    folderPath: labFolderSegment(row.labName),
    endpoints: address ? [{ kind: "ssh", host: address, port: 22 }] : [],
    attributes
  };
}

function mapStatus(row: ValidatedRow): InventoryDeviceStatus | undefined {
  const state = row.state.toLowerCase();
  if (state === "running") {
    return { state: "running" };
  }
  if (["created", "exited", "dead", "paused"].includes(state)) {
    return { state: "stopped" };
  }
  return undefined;
}

export function parseContainerlabInspection(inspection: ContainerlabInspection, config: ContainerlabConfig): InventoryTree {
  if (!isRecord(inspection)) {
    return protocol("Containerlab inspection result must be an object.");
  }
  const version = requiredString(inspection.version, "version");
  assertSupportedVersion(version);
  const stdout = requiredString(inspection.stdout, "stdout", true, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return protocol("Containerlab returned malformed detailed inspection JSON.");
  }
  if (!isRecord(parsed)) {
    return protocol("Containerlab detailed inspection JSON must be an object grouped by lab name.");
  }

  const identities = new Set<string>();
  const validated: ValidatedRow[] = [];
  for (const [labName, rawRows] of Object.entries(parsed)) {
    if (labName === "" || !Array.isArray(rawRows)) {
      return protocol("Containerlab detailed inspection JSON must map each non-empty lab name to a row array.");
    }
    for (const rawRow of rawRows) {
      validated.push(validateRow(rawRow, labName, identities));
    }
  }

  const selected = validated.filter((row) =>
    row.labels["clab-internal-node"] !== "true" && (config.labFilter === "" || row.labName === config.labFilter)
  );
  const truncated = selected.length > CONTAINERLAB_MAX_NODES;
  const mapped = selected.slice(0, CONTAINERLAB_MAX_NODES);
  const devices = mapped.map((row) => mapDevice(row, config));
  const statuses: InventoryStatusReport["statuses"] = {};
  const clearedExternalIds: string[] = [];
  for (const row of mapped) {
    const status = mapStatus(row);
    if (status) {
      statuses[row.externalId] = status;
    } else {
      clearedExternalIds.push(row.externalId);
    }
  }
  const status: InventoryStatusReport = {
    contractVersion: 1,
    statuses,
    ...(truncated ? { truncated: true } : {}),
    ...(clearedExternalIds.length > 0 ? { clearedExternalIds } : {})
  };
  return {
    contractVersion: 1,
    devices,
    status,
    ...(truncated ? { truncated: true } : {})
  };
}
