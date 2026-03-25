import * as path from "node:path";
import type { AuthProfile } from "../models/config";

export function formatKeyPathDisplayName(keyPath: string): string {
  return path.posix.basename(keyPath.replace(/\\/g, "/"));
}

export function formatAuthProfileLabel(profile: AuthProfile): string {
  const parts = [profile.name, profile.authType, profile.username];
  if (profile.authType === "key" && profile.keyPath) {
    parts.push(formatKeyPathDisplayName(profile.keyPath));
  }
  return parts.join(" — ");
}
