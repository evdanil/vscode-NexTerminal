import type { SerialParity } from "../models/config";

export function toParityCode(parity: SerialParity | undefined): string {
  switch (parity) {
    case "even":
      return "E";
    case "odd":
      return "O";
    case "mark":
      return "M";
    case "space":
      return "S";
    default:
      return "N";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `globalState.get(key, [])` returns the default only when the key is ABSENT.
 * A corrupt non-array value (object/string/null from a Settings Sync conflict or
 * storage corruption) would otherwise be iterated directly and throw during
 * activation. Degrade any non-array shape to an empty list.
 */
export function asArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

/**
 * Guard a caller-supplied number against a corrupt or absent value, then clamp
 * it into `[min, max]`. `Number.isFinite` never coerces, so it rejects a
 * non-number outright — no `typeof` pre-check is needed.
 *
 * This is the shared body of what used to be six separate private helpers
 * (`normalizeRpcTimeoutMs`, `normalizeSocks5HandshakeTimeoutMs`,
 * `normalizeProxyTimeoutMs`, `normalizeConfigValue`, `normalizeTimeout`,
 * `clampLength`), each spelling the same expression with its own bounds.
 * `readBoundedNumber` (utils/boundedConfig.ts) is the VS Code-settings sibling.
 */
export function normalizeBoundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? clamp(Math.floor(value as number), min, max) : fallback;
}
