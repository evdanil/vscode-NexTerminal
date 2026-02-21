import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from "node:crypto";

export interface EncryptedPayload {
  kdf: "pbkdf2-sha512";
  iterations: number;
  cipher: "aes-256-gcm";
  iv: string;
  salt: string;
  tag: string;
  ciphertext: string;
}

const ITERATIONS = 210_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 1_000_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function decodeBase64(field: string, value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new Error(`Invalid encrypted payload: ${field} must be base64 string`);
  }
  if (value.length > 0 && (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0)) {
    throw new Error(`Invalid encrypted payload: ${field} is not valid base64`);
  }
  return Buffer.from(value, "base64");
}

function validatePayload(payload: EncryptedPayload): {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  if (payload.kdf !== "pbkdf2-sha512") {
    throw new Error("Unsupported key derivation function");
  }
  if (payload.cipher !== "aes-256-gcm") {
    throw new Error("Unsupported cipher");
  }
  if (!Number.isInteger(payload.iterations) || payload.iterations < MIN_ITERATIONS || payload.iterations > MAX_ITERATIONS) {
    throw new Error("Invalid PBKDF2 iteration count");
  }

  const salt = decodeBase64("salt", payload.salt);
  const iv = decodeBase64("iv", payload.iv);
  const tag = decodeBase64("tag", payload.tag);
  const ciphertext = decodeBase64("ciphertext", payload.ciphertext);

  if (salt.length !== SALT_LENGTH) {
    throw new Error("Invalid encrypted payload: salt has unexpected length");
  }
  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid encrypted payload: iv has unexpected length");
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error("Invalid encrypted payload: tag has unexpected length");
  }

  return { salt, iv, tag, ciphertext };
}

export function encrypt(plaintext: string, password: string): EncryptedPayload {
  const salt = randomBytes(SALT_LENGTH);
  const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, "sha512");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: "pbkdf2-sha512",
    iterations: ITERATIONS,
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64")
  };
}

export function decrypt(payload: EncryptedPayload, password: string): string {
  const { salt, iv, tag, ciphertext } = validatePayload(payload);
  const key = pbkdf2Sync(password, salt, payload.iterations, KEY_LENGTH, "sha512");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
