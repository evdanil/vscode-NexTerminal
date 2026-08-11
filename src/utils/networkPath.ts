/**
 * Local-path helpers shared by the SFTP transfer engine and the drag-drop upload
 * path. Pure functions only (no `vscode`, no `node:fs`) so they stay trivially
 * testable and safe to import from the worker-adjacent bundles.
 */

export interface TransferTuning {
  concurrency: number;
  chunkSize: number;
}

/**
 * Pins ssh2's own implicit fastGet/fastPut defaults (SFTP.js `fastXfer`) so the
 * values we send are visible and assertable instead of silently inherited.
 */
export const DEFAULT_TRANSFER_TUNING: TransferTuning = { concurrency: 64, chunkSize: 32768 };

/**
 * Conservative profile for Windows network paths. ssh2's default issues up to 64
 * concurrent 32 KB `fs` operations against the local file; libuv's default
 * threadpool is 4 threads, so against SMB that queues ~60 blocked operations and
 * starves the whole extension host's threadpool whenever the share stalls. 8
 * keeps the pool saturated with a bounded queue and caps in-flight data at 256 KB.
 */
export const NETWORK_TRANSFER_TUNING: TransferTuning = { concurrency: 8, chunkSize: 32768 };

/**
 * True for a Windows network path in any of its spellings: `\\server\share`,
 * `//server/share`, `\\?\UNC\...`, `\\.\UNC\...`.
 *
 * Mapped drive letters (`Z:\...`) are indistinguishable from local disks without
 * win32 API calls, so they intentionally get the default profile — no worse than
 * the behavior before this helper existed.
 */
export function isWindowsNetworkPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /^[\\/]{2}/.test(p);
}

export function resolveTransferTuning(
  localPath: string,
  platform: NodeJS.Platform = process.platform
): TransferTuning {
  return isWindowsNetworkPath(localPath, platform) ? NETWORK_TRANSFER_TUNING : DEFAULT_TRANSFER_TUNING;
}

/**
 * True when `err` is VS Code's UNC access restriction
 * (`security.restrictUNCAccess` / `security.allowedUNCHosts`), which Node's path
 * validation raises as `ERR_UNC_HOST_NOT_ALLOWED`.
 *
 * Matched on `err.code` ONLY, never on message text: the message is translatable
 * and version-dependent, and `vscode.workspace.fs` launders this very error into
 * code `"Unknown"` with the original text appended — so a message match would
 * both misfire on the laundered variant and break whenever VS Code rewords it.
 * That is exactly why the local-side IO in the upload path uses `node:fs`, which
 * preserves the real code.
 */
export function isUNCAccessError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ERR_UNC_HOST_NOT_ALLOWED";
}

/**
 * One blocked host, plus a representative blocked path the remediation flow
 * re-probes after the setting is written (a bare host set would not do).
 * `host` keeps the ORIGINAL spelling so messages echo what the user typed.
 */
export interface BlockedUNCHost {
  host: string;
  probePath: string;
}

/**
 * Hosts VS Code's UNC restriction blocked during ONE operation, keyed by
 * lower-cased host name.
 *
 * Case-insensitive on purpose: Windows treats `\\NAS\share` and `\\nas\share`
 * as the same host, and VS Code's own allowlist check lower-cases before
 * comparing. Keying on the raw spelling made a single share that appeared in
 * both spellings inside one drop produce two consent flows for one host.
 */
export type BlockedUNCHosts = Map<string, BlockedUNCHost>;

/**
 * Records `localPath`'s UNC host in `collected`, first spelling wins.
 * Returns false when the path is not a UNC path at all (nothing recorded).
 */
export function recordBlockedUNCHost(collected: BlockedUNCHosts, localPath: string): boolean {
  const host = getUNCHost(localPath);
  if (!host) {
    return false;
  }
  const key = host.toLowerCase();
  if (!collected.has(key)) {
    collected.set(key, { host, probePath: localPath });
  }
  return true;
}

const UNC_ROOTS = ["\\\\.\\UNC\\", "\\\\?\\UNC\\", "\\\\"] as const;

/**
 * Extracts the host segment from a UNC path, mirroring VS Code's own extraction
 * (`vs/base/node/unc`) so the host we name in a message is the host VS Code
 * checks against `security.allowedUNCHosts`. Forward-slash spellings
 * (`//host/share`) are normalized first; anything else returns undefined.
 */
export function getUNCHost(p: string): string | undefined {
  if (typeof p !== "string") {
    return undefined;
  }
  const normalized = p.replace(/\//g, "\\");
  for (const root of UNC_ROOTS) {
    if (!normalized.startsWith(root)) {
      continue;
    }
    const separatorIndex = normalized.indexOf("\\", root.length);
    if (separatorIndex === -1) {
      continue;
    }
    const host = normalized.substring(root.length, separatorIndex);
    if (host) {
      return host;
    }
  }
  return undefined;
}
