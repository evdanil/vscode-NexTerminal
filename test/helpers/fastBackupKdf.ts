import type * as NodeCrypto from "node:crypto";

/**
 * `node:crypto` with a fast `pbkdf2Sync`, for suites that round-trip an
 * encrypted backup but assert only where a value lands in it. Use as
 *
 *   vi.mock("node:crypto", async (importOriginal) =>
 *     (await import("../helpers/fastBackupKdf")).withFastPbkdf2(await importOriginal<typeof import("node:crypto")>()));
 *
 * The backup cipher (`src/utils/configCrypto.ts`) derives its key with 210,000
 * PBKDF2-SHA512 iterations — about 1.7 s per derivation on a loaded 2-core host,
 * so a test that exports and imports a backup or two ran into the unit
 * project's 5 s timeout. Only the derivation is replaced: AES-256-GCM, the
 * payload validation (iteration bounds included) and the backup's readable-half
 * seal all stay real, so a wrong password or an edited file is still refused
 * and the ciphertext is still real ciphertext. The stand-in key is an HKDF of
 * the password over the salt and the iteration count, so a change to any of
 * them still yields a different key, as it does under PBKDF2.
 *
 * `test/unit/configCrypto.test.ts` exercises the real derivation, including
 * decrypting a checked-in payload from the production code, and must not use
 * this.
 */
export function withFastPbkdf2(actual: typeof NodeCrypto): typeof NodeCrypto {
  return {
    ...actual,
    pbkdf2Sync: (password, salt, iterations, keylen, digest) =>
      Buffer.from(actual.hkdfSync(digest, password, salt, `pbkdf2-test-stand-in:${iterations}`, keylen))
  };
}
