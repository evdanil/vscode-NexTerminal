import {
  InventoryProviderError,
  type InventorySourceDefaultRoute,
  type InventorySourceValues
} from "../../../models/inventory";

export interface ContainerlabConfig {
  readonly location: "local" | "ssh";
  readonly labHostId?: string;
  readonly runner: "host" | "disposable" | "existing";
  readonly containerlabExecutable: string;
  readonly dockerExecutable: string;
  readonly runnerImage?: string;
  readonly runnerContainer?: string;
  readonly dockerSocket: string;
  readonly sudo: boolean;
  readonly deviceConnection: "automatic" | "direct";
  readonly labFilter: string;
  readonly addressPreference: "ipv4" | "ipv6";
}

export const CONTAINERLAB_MIN_VERSION = "0.68.0";
export const CONTAINERLAB_MAX_NODES = 10_000;

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;

function invalid(message: string): never {
  throw new InventoryProviderError("protocol", message);
}

function readString(
  values: InventorySourceValues,
  key: string,
  fallback?: string,
  allowEmpty = false
): string | undefined {
  const value = values[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    return invalid(`Containerlab setting "${key}" must be text.`);
  }
  if (CONTROL_CHARACTER_RE.test(value)) {
    return invalid(`Containerlab setting "${key}" cannot contain control characters.`);
  }
  if (value === "" && allowEmpty) {
    return value;
  }
  if (value.trim() === "" || value !== value.trim()) {
    return invalid(`Containerlab setting "${key}" must not be empty or padded with whitespace.`);
  }
  return value;
}

function readEnum<T extends string>(
  values: InventorySourceValues,
  key: string,
  choices: readonly T[],
  fallback: T
): T {
  const value = values[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !choices.includes(value as T)) {
    return invalid(`Containerlab setting "${key}" has an invalid value.`);
  }
  return value as T;
}

function validateExecutable(key: string, value: string): string {
  if (value.startsWith("-") || value.includes("\\") || /\s/u.test(value)) {
    return invalid(`Containerlab setting "${key}" must be an executable name or absolute path, not an option or malformed path.`);
  }
  if (value.includes("/") && !value.startsWith("/")) {
    return invalid(`Containerlab setting "${key}" must be an executable name or absolute path.`);
  }
  return value;
}

function validateRunnerReference(key: string, value: string): string {
  if (value.startsWith("-") || /\s/u.test(value)) {
    return invalid(`Containerlab setting "${key}" must be a runner reference, not an option-shaped value.`);
  }
  return value;
}

function validateSocketPath(value: string): string {
  const segments = value.split("/");
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.includes(",") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return invalid('Containerlab setting "dockerSocket" must be an absolute Unix socket path without dot segments or commas.');
  }
  return value;
}

export function parseContainerlabConfig(values: InventorySourceValues): ContainerlabConfig {
  const location = readEnum(values, "location", ["local", "ssh"], "local");
  const runner = readEnum(values, "runner", ["host", "disposable", "existing"], "host");
  const deviceConnection = readEnum(values, "deviceConnection", ["automatic", "direct"], "automatic");
  const addressPreference = readEnum(values, "addressPreference", ["ipv4", "ipv6"], "ipv4");

  const rawLabHostId = readString(values, "labHostId");
  const labHostId = rawLabHostId === undefined ? undefined : validateRunnerReference("labHostId", rawLabHostId);
  if (location === "ssh" && !labHostId) {
    return invalid('Containerlab setting "labHostId" is required for remote SSH execution.');
  }

  const rawImage = readString(values, "runnerImage", undefined, true);
  const runnerImage = rawImage ? validateRunnerReference("runnerImage", rawImage) : undefined;
  const rawContainer = readString(values, "runnerContainer", undefined, true);
  const runnerContainer = rawContainer ? validateRunnerReference("runnerContainer", rawContainer) : undefined;
  if (runner === "disposable" && !runnerImage) {
    return invalid('Containerlab setting "runnerImage" is required for the disposable runner.');
  }
  if (runner === "existing" && !runnerContainer) {
    return invalid('Containerlab setting "runnerContainer" is required for the existing-container runner.');
  }

  const rawContainerlabExecutable = readString(values, "containerlabExecutable", "containerlab", true);
  const containerlabExecutable = validateExecutable(
    "containerlabExecutable",
    rawContainerlabExecutable || "containerlab"
  );
  const rawDockerExecutable = readString(values, "dockerExecutable", "docker", true);
  const dockerExecutable = validateExecutable("dockerExecutable", rawDockerExecutable || "docker");
  const dockerSocket = validateSocketPath(readString(values, "dockerSocket", "/var/run/docker.sock")!);
  const sudoValue = values.sudo;
  if (sudoValue !== undefined && typeof sudoValue !== "boolean") {
    return invalid('Containerlab setting "sudo" must be a boolean.');
  }
  const sudo = sudoValue === true;
  const labFilter = readString(values, "labFilter", "", true)!;

  return {
    location,
    ...(labHostId ? { labHostId } : {}),
    runner,
    containerlabExecutable,
    dockerExecutable,
    ...(runnerImage ? { runnerImage } : {}),
    ...(runnerContainer ? { runnerContainer } : {}),
    dockerSocket,
    sudo,
    deviceConnection,
    labFilter,
    addressPreference
  };
}

export function containerlabDefaultRoute(config: ContainerlabConfig): InventorySourceDefaultRoute {
  if (config.deviceConnection === "direct" || config.location === "local") {
    return { kind: "direct" };
  }
  if (!config.labHostId) {
    return invalid('Containerlab remote device connections require a configured lab host SSH profile.');
  }
  return { kind: "ssh", jumpHostId: config.labHostId };
}
