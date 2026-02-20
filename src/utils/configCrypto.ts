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
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

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
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = pbkdf2Sync(password, salt, payload.iterations, KEY_LENGTH, "sha512");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
