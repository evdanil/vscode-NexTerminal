import * as os from "node:os";
import * as path from "node:path";
import type { AuthProfile } from "../models/config";

export function normalizeKeyPathForComparison(keyPath: string): string {
  const trimmed = keyPath.trim();
  if (!trimmed) {
    return "";
  }

  const expandedHome = trimmed === "~"
    ? os.homedir()
    : trimmed.replace(/^~(?=\/|\\)/, os.homedir());
  const slashNormalized = expandedHome.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashNormalized);

  return normalized.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
}

export function formatKeyPathDisplayName(keyPath: string): string {
  return path.posix.basename(normalizeKeyPathForComparison(keyPath));
}

export function formatAuthProfileLabel(profile: AuthProfile): string {
  const parts = [profile.name, profile.authType, profile.username];
  if (profile.authType === "key" && profile.keyPath) {
    parts.push(formatKeyPathDisplayName(profile.keyPath));
  }
  return parts.join(" — ");
}
