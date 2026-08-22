/** @author kanekitakitos */

/**
 * Duration formatting shared by the TFTP and DHCP adapters.
 *
 * Both adapters render elapsed transfer time and remaining lease time into the
 * same human-readable shape, so the formatter lives here instead of being
 * copied into each. Daemon-side module: it must never import `vscode`.
 */

/**
 * Formats a number of seconds into a human-readable duration: `0s`, `32s`,
 * `5m 12s`, `1h 30m 5s`.
 *
 * Non-positive and non-integer inputs collapse to `0s` / the floored second.
 */
export function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return '0s';
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}h ${m}m ${rs}s`;
  if (m > 0) return `${m}m ${rs}s`;
  return `${rs}s`;
}
