import type { AuthType, ServerConfig } from "./config";

export interface StoredAuthProfile {
  id: string;
  name: string;
  username: string;
  authType: AuthType;
  keyPath?: string;
}

export interface ExternalCredentialInvocation {
  executable: string;
  args: readonly string[];
}

export interface ExternalAuthProfile {
  id: string;
  name: string;
  authType: "external";
  external: {
    version: 1;
    method: "password" | "key";
    invocation?: ExternalCredentialInvocation;
  };
  username?: never;
  keyPath?: never;
}

export type AuthProfile = StoredAuthProfile | ExternalAuthProfile;

export function isExternalAuthProfile(profile: AuthProfile | undefined): profile is ExternalAuthProfile {
  return profile?.authType === "external";
}

export type AuthProfileOwnedCredentials = Partial<Pick<ServerConfig, "username" | "authType" | "keyPath">>;

/** Static supplied values only. Dynamic ownership is a separate question. */
export function authProfileOwnedCredentials(profile: AuthProfile | undefined): AuthProfileOwnedCredentials {
  if (!profile || isExternalAuthProfile(profile)) return {};
  const owned: AuthProfileOwnedCredentials = { authType: profile.authType };
  const username = typeof profile.username === "string" ? profile.username.trim() : "";
  if (username !== "") owned.username = username;
  const keyPath = typeof profile.keyPath === "string" ? profile.keyPath.trim() : "";
  if (keyPath !== "") owned.keyPath = keyPath;
  return owned;
}

/** External credentials arrive at sign-in, so all dormant server fields stay owned. */
export function authProfileFieldOwnership(profile: AuthProfile | undefined): { username: boolean; authType: boolean; keyPath: boolean } {
  if (isExternalAuthProfile(profile)) return { username: true, authType: true, keyPath: true };
  const owned = authProfileOwnedCredentials(profile);
  return { username: owned.username !== undefined, authType: owned.authType !== undefined, keyPath: owned.keyPath !== undefined };
}

/** No secrets, retrieved values or display name enter connection/approval identity. */
export function authProfileConnectionIdentity(profile: AuthProfile | undefined): readonly unknown[] {
  if (!profile) return ["missing"];
  if (isExternalAuthProfile(profile)) {
    const { version, method, invocation } = profile.external;
    return [profile.id, "external", version, method,
      invocation ? [invocation.executable, [...invocation.args]] : null];
  }
  const owned = authProfileOwnedCredentials(profile);
  return ["stored", owned.authType, owned.username ?? null, owned.keyPath ?? null];
}

/** Plain configuration objects only; arrays/prototype-supplied fields are never invocation metadata. */
export function isPlainCredentialConfig(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Pure and portable: host filesystem checks belong to the Node runner. */
export function validateExternalCredentialInvocation(value: unknown): value is ExternalCredentialInvocation {
  if (!isPlainCredentialConfig(value) || Object.keys(value).some((key) => key !== "executable" && key !== "args")) return false;
  const { executable, args } = value;
  if (typeof executable !== "string" || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(executable)) return false;
  // Accept foreign-host paths in backups, without expanding variables or normalizing bytes.
  const absolute = executable.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(executable) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/u.test(executable);
  if (!absolute || !Array.isArray(args) || args.length > 32) return false;
  const encoder = new TextEncoder();
  return Array.from(args).every((arg: unknown) => typeof arg === "string" && arg.length > 0 && arg === arg.trim() &&
    !/[\u0000\r\n]/u.test(arg) && encoder.encode(arg).byteLength <= 4096);
}
