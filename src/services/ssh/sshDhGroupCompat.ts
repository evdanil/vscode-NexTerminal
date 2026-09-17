// Diffie-Hellman named-group compatibility shim.
//
// VS Code's extension host runs on Electron, whose crypto backend cannot
// resolve some standard MODP groups through the *named*
// `crypto.createDiffieHellmanGroup()` API — notably the 1024-bit Oakley
// Group 2 ("modp2") that backs the SSH `diffie-hellman-group1-sha1` key
// exchange. ssh2 calls `createDiffieHellmanGroup("modp2")` for that KEX, so
// on Electron it throws ERR_CRYPTO_UNKNOWN_DH_GROUP ("Unknown DH group") and
// legacy devices that only speak group1-sha1 (old Cisco IOS, e.g. a
// WS-C6509-E) cannot be reached at all — even with the server's legacy
// SSH algorithms option enabled, because no algorithm-list change can fix a
// missing runtime crypto primitive.
//
// The underlying DH math still works via `createDiffieHellman()` with an
// explicit prime, so this shim wraps `createDiffieHellmanGroup` to fall back
// to the well-known prime constant when (and only when) the runtime cannot
// resolve a group by name. On OpenSSL runtimes (plain Node) the original call
// succeeds and behavior is unchanged.
//
// IMPORTANT: ssh2 destructures `createDiffieHellmanGroup` from `require
// ("crypto")` at module load, so this module must be imported BEFORE ssh2 —
// ssh2Connector.ts imports it first for exactly that reason.

type DiffieHellmanGroupFn = (name: string) => unknown;

// Same module instance ssh2 binds to, so the wrapper is visible to it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoCjs = require("node:crypto") as typeof import("node:crypto");

/** RFC 2409 Oakley Group 2 (1024-bit MODP), generator 2 — byte-identical to
 * Node's built-in "modp2" group. Public constant; see RFC 2409 §6.2. */
export const RFC2409_GROUP2_PRIME =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
  "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
  "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381" +
  "FFFFFFFFFFFFFFFF";

const MODP_GENERATOR = Buffer.from([0x02]);

const MODP_GROUP_PRIMES: Record<string, string> = {
  // Only groups a runtime may refuse BY NAME while ssh2 still requests them.
  // modp14-18 (2048-bit and up) remain available on Electron, and group
  // exchange builds its DH from server-supplied parameters, so modp2 is the
  // only evidenced gap (diffie-hellman-group1-sha1).
  modp2: RFC2409_GROUP2_PRIME
};

const INSTALL_MARKER = "__nexusDhGroupCompat";

function buildFallback(name: string): unknown {
  const primeHex = MODP_GROUP_PRIMES[name];
  if (!primeHex) {
    return undefined;
  }
  return cryptoCjs.createDiffieHellman(Buffer.from(primeHex, "hex"), MODP_GENERATOR);
}

/**
 * Wrap `target.createDiffieHellmanGroup` so named groups the runtime refuses
 * fall back to an explicit-prime DiffieHellman with identical parameters.
 * Idempotent. Returns true if it installed the wrapper, false if the target
 * was already wrapped (or has nothing to wrap).
 */
export function installSshDhGroupCompat(
  target: { createDiffieHellmanGroup?: DiffieHellmanGroupFn } = cryptoCjs
): boolean {
  const original = target.createDiffieHellmanGroup;
  if (typeof original !== "function" || (original as { [INSTALL_MARKER]?: boolean })[INSTALL_MARKER]) {
    return false;
  }

  const wrapped = function createDiffieHellmanGroup(this: unknown, name: string): unknown {
    try {
      return original.call(this, name);
    } catch (err) {
      const fallback = buildFallback(name);
      if (fallback === undefined) {
        throw err;
      }
      return fallback;
    }
  };
  (wrapped as { [INSTALL_MARKER]?: boolean })[INSTALL_MARKER] = true;

  try {
    target.createDiffieHellmanGroup = wrapped;
  } catch {
    // The property may be read-only on some runtimes; force it.
    Object.defineProperty(target, "createDiffieHellmanGroup", {
      value: wrapped,
      configurable: true,
      writable: true
    });
  }
  return true;
}

installSshDhGroupCompat();
