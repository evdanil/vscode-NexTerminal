/**
 * Reverse-DNS identity for TFTP clients.
 *
 * A bench full of switches all called `192.168.1.x` is hard to read, so every
 * place a transfer's client is shown (sidebar rows, tooltips, connection
 * toasts) goes through {@link formatTftpClient}. There is deliberately ONE
 * format — `hostname (ip)` when a PTR record exists, the bare IP when it does
 * not — so the same client never reads two different ways in two places.
 *
 * This module runs inside the network-server daemon child process: it must not
 * import `vscode`. `node:dns` is a Node built-in, not a new dependency.
 */

import { promises as dns } from 'node:dns';

/** How long a resolved hostname stays usable before it is looked up again. */
const SUCCESS_TTL_MS = 5 * 60_000;
/**
 * Negative results expire much sooner: a device that just booted may only
 * register its PTR record a few seconds after its first TFTP request.
 */
const FAILURE_TTL_MS = 60_000;
/**
 * `dns.promises.reverse` has no timeout option on Node 20.x, and the platform
 * default (5 attempts × 5 s) would keep a query alive far past the point where
 * the answer is still interesting. A black-holed resolver must degrade to "no
 * hostname" quickly, never stall the caller.
 */
const LOOKUP_TIMEOUT_MS = 2_000;

/** One cached answer (`hostname: null` = looked up, no PTR record). */
interface CacheEntry {
  readonly hostname: string | null;
  readonly expiresAt: number;
}

/**
 * Renders a client for display. The single source of truth for the format.
 *
 * @param address  Raw peer IPv4 — always available.
 * @param hostname Reverse-DNS name, or `null`/`undefined` if unresolved.
 * @returns `"hostname (ip)"` when resolved, otherwise just `"ip"`.
 */
export function formatTftpClient(address: string, hostname?: string | null): string {
  const name = hostname?.trim();
  if (!name || name.toLowerCase() === address.toLowerCase()) return address;
  return `${name} (${address})`;
}

/**
 * Per-IP reverse-DNS cache with a hard per-lookup timeout.
 *
 * Lookups are fire-and-forget by design: a transfer never waits on DNS, and a
 * hostname that only appears a second later simply rides the next runtime
 * snapshot into the sidebar.
 */
export class ReverseDnsCache {
  /** Resolved (and negatively resolved) answers, keyed by IP. */
  private readonly entries = new Map<string, CacheEntry>();
  /** In-flight lookups, so N concurrent transfers from one host issue 1 query. */
  private readonly inFlight = new Map<string, Promise<string | null>>();

  /**
   * @param timeoutMs Per-lookup deadline. Defaults to {@link LOOKUP_TIMEOUT_MS}.
   */
  public constructor(private readonly timeoutMs: number = LOOKUP_TIMEOUT_MS) {}

  /**
   * Non-blocking read of an already-known hostname.
   *
   * @param address Peer IPv4.
   * @returns Hostname, or `null` when unknown, unresolvable, or expired.
   */
  public getCached(address: string): string | null {
    const entry = this.entries.get(address);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(address);
      return null;
    }
    return entry.hostname;
  }

  /**
   * Resolves (or joins an in-flight resolution of) a peer's hostname.
   *
   * Never rejects and never throws — DNS failure is an ordinary outcome here.
   *
   * @param address Peer IPv4.
   * @returns Hostname, or `null` if there is none within {@link timeoutMs}.
   */
  public async resolve(address: string): Promise<string | null> {
    const cached = this.entries.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.hostname;

    const running = this.inFlight.get(address);
    if (running) return running;

    const task = this.lookup(address)
      .catch(() => null)
      .then((hostname) => {
        this.inFlight.delete(address);
        this.entries.set(address, {
          hostname,
          expiresAt: Date.now() + (hostname === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
        });
        return hostname;
      });
    this.inFlight.set(address, task);
    return task;
  }

  /** Drops every cached answer. Called when the TFTP adapter stops. */
  public clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /**
   * One reverse lookup, bounded by {@link timeoutMs}.
   *
   * @param address Peer IPv4.
   * @returns First PTR name, or `null` on error/timeout/empty answer.
   */
  private async lookup(address: string): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
      if (timer.unref) timer.unref();
    });
    try {
      const names = await Promise.race([
        dns.reverse(address).catch(() => null),
        deadline,
      ]);
      const first = names?.[0]?.trim();
      return first ? first : null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
