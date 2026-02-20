import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "../../src/utils/configCrypto";

describe("configCrypto", () => {
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
    const payload = encrypt("data", "password");
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
});
