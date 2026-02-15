import type { ServerConfig, TunnelProfile, SerialProfile } from "../models/config";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validateServerConfig(item: unknown): item is ServerConfig {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  return (
    isNonEmptyString(obj.id) &&
    isNonEmptyString(obj.name) &&
    isNonEmptyString(obj.host) &&
    typeof obj.port === "number" &&
    isNonEmptyString(obj.username) &&
    (obj.authType === "password" || obj.authType === "key" || obj.authType === "agent")
  );
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
    typeof obj.baudRate === "number"
  );
}
