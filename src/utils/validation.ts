import type { AuthProfile, ServerConfig, TunnelProfile, SerialProfile, ProxyConfig } from "../models/config";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function validateSerialDeviceHint(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    isOptionalNonEmptyString(obj.manufacturer) &&
    isOptionalNonEmptyString(obj.serialNumber) &&
    isOptionalNonEmptyString(obj.vendorId) &&
    isOptionalNonEmptyString(obj.productId)
  );
}

export function validateProxyConfig(proxy: unknown): proxy is ProxyConfig {
  if (typeof proxy !== "object" || proxy === null) {
    return false;
  }
  const obj = proxy as Record<string, unknown>;
  if (obj.type === "ssh") {
    return isNonEmptyString(obj.jumpHostId);
  }
  if (obj.type === "socks5") {
    return isNonEmptyString(obj.host) && isValidPort(obj.port);
  }
  if (obj.type === "http") {
    return isNonEmptyString(obj.host) && isValidPort(obj.port);
  }
  return false;
}

export function validateServerConfig(item: unknown): item is ServerConfig {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  if (
    !(
      isNonEmptyString(obj.id) &&
      isNonEmptyString(obj.name) &&
      isNonEmptyString(obj.host) &&
      typeof obj.port === "number" &&
      isNonEmptyString(obj.username) &&
      (obj.authType === "password" || obj.authType === "key" || obj.authType === "agent")
    )
  ) {
    return false;
  }
  if (obj.proxy !== undefined && obj.proxy !== null) {
    if (!validateProxyConfig(obj.proxy)) {
      return false;
    }
  }
  if (obj.legacyAlgorithms !== undefined && typeof obj.legacyAlgorithms !== "boolean") {
    return false;
  }
  if (obj.authProfileId !== undefined && (typeof obj.authProfileId !== "string" || obj.authProfileId === "")) {
    return false;
  }
  return true;
}

export function validateTunnelProfile(item: unknown): item is TunnelProfile {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  return (
    isNonEmptyString(obj.id) &&
    isNonEmptyString(obj.name) &&
    typeof obj.localPort === "number" &&
    isNonEmptyString(obj.remoteIP) &&
    typeof obj.remotePort === "number"
  );
}

export function validateSerialProfile(item: unknown): item is SerialProfile {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  return (
    isNonEmptyString(obj.id) &&
    isNonEmptyString(obj.name) &&
    isNonEmptyString(obj.path) &&
    typeof obj.baudRate === "number" &&
    (obj.mode === undefined || obj.mode === "standard" || obj.mode === "smartFollow") &&
    validateSerialDeviceHint(obj.deviceHint)
  );
}

export function validateAuthProfile(item: unknown): item is AuthProfile {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  return (
    isNonEmptyString(obj.id) &&
    isNonEmptyString(obj.name) &&
    isNonEmptyString(obj.username) &&
    (obj.authType === "password" || obj.authType === "key" || obj.authType === "agent")
  );
}
