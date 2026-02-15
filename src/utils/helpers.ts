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
