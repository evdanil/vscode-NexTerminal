import { beforeAll, describe, expect, it } from "vitest";
import { encrypt, decrypt, type EncryptedPayload } from "../../src/utils/configCrypto";

/**
 * Written once by the production `encrypt` (password below, 210,000
 * iterations) and checked in. Round trips cannot catch a change that is wrong
 * on both sides at once, such as a different digest, salt encoding or argument
 * order in both `pbkdf2Sync` calls. Every backup already on disk would stop
 * decrypting, and only a fixed payload shows it.
 */
const KNOWN_PASSWORD = "nexus-kat-password";
const KNOWN_PLAINTEXT = '{"passwords":{"srv-1":"known-answer"}}';
const KNOWN_PAYLOAD: EncryptedPayload = {
  kdf: "pbkdf2-sha512",
  iterations: 210_000,
  cipher: "aes-256-gcm",
  iv: "cakapUfpu9jBn7tJ",
  salt: "2b/vzRVc6qWv3w1mFHFwJQ==",
  tag: "Fg/WhCVLie0johlqU2YOkw==",
  ciphertext: "z0cE6IY1awG/FnQPw+4XScWttg22BQdmq/h5UuuGJ4K2/P3dwIw="
};

// These tests run the real key derivation on purpose, and each derivation is
// 210,000 iterations of PBKDF2-SHA512. The budget is sized as derivations per
// test times their cost under load. No test here does more than two, and one
// derivation has taken up to about 2 s on a loaded 2-core host, so a test
// needs up to about 4-5 s. That is the unit project's whole 5 s default. 30 s
// covers it with a wide margin, for this suite only. The suites that only
// round-trip a backup replace the derivation instead
// (test/helpers/fastBackupKdf.ts).
describe("configCrypto", { timeout: 30_000 }, () => {
  // One payload for the tests that only read its fields or feed a malformed
  // copy to `decrypt`, which rejects those before it derives a key.
  let shared: EncryptedPayload;
  beforeAll(() => {
    shared = encrypt("hello", "password");
  }, 30_000);

  it("decrypts a payload written by an earlier build (known answer: the key derivation and cipher have not changed on both sides at once)", () => {
    expect(decrypt(KNOWN_PAYLOAD, KNOWN_PASSWORD)).toBe(KNOWN_PLAINTEXT);
  });

  it("round-trips with correct password", () => {
    const plaintext = '{"passwords":{"s1":"secret123"}}';
    const password = "testpassword";
    const payload = encrypt(plaintext, password);
    expect(decrypt(payload, password)).toBe(plaintext);
  });

  it("throws on wrong password", () => {
    const payload = encrypt("hello", "correctpassword");
    expect(() => decrypt(payload, "wrongpassword")).toThrow();
  });

  it("handles empty string payload", () => {
    const payload = encrypt("", "mypassword");
    expect(decrypt(payload, "mypassword")).toBe("");
  });

  it("produces different ciphertext for same input (random salt/iv)", () => {
    const a = encrypt("same", "same");
    const b = encrypt("same", "same");
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("stores algorithm metadata in payload", () => {
    const payload = shared;
    expect(payload.kdf).toBe("pbkdf2-sha512");
    expect(payload.cipher).toBe("aes-256-gcm");
    expect(payload.iterations).toBe(210_000);
    expect(typeof payload.iv).toBe("string");
    expect(typeof payload.salt).toBe("string");
    expect(typeof payload.tag).toBe("string");
    expect(typeof payload.ciphertext).toBe("string");
  });

  it("handles unicode content", () => {
    const plaintext = '{"name":"Сервер","emoji":"🔑"}';
    const payload = encrypt(plaintext, "password123");
    expect(decrypt(payload, "password123")).toBe(plaintext);
  });

  it("rejects unsupported algorithm metadata", () => {
    const payload = shared;
    expect(() => decrypt({ ...payload, kdf: "scrypt" as any }, "password")).toThrow("Unsupported key derivation function");
    expect(() => decrypt({ ...payload, cipher: "aes-256-cbc" as any }, "password")).toThrow("Unsupported cipher");
  });

  it("rejects invalid iteration counts", () => {
    const payload = shared;
    expect(() => decrypt({ ...payload, iterations: 1 }, "password")).toThrow("Invalid PBKDF2 iteration count");
    expect(() => decrypt({ ...payload, iterations: 2_000_000 }, "password")).toThrow("Invalid PBKDF2 iteration count");
  });

  it("rejects malformed payload fields", () => {
    const payload = shared;
    expect(() => decrypt({ ...payload, iv: "not/base64!!" }, "password")).toThrow("iv is not valid base64");
    expect(() => decrypt({ ...payload, tag: "AAAA" }, "password")).toThrow("tag has unexpected length");
  });
});
