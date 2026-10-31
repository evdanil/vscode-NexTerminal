import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { utils } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { CredentialProviderError, type CredentialProviderErrorCode } from "../../src/services/credentials/credentialProviderError";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";

const canary = "SECRET_CANARY";
const openSsh = utils.generateKeyPairSync("ed25519", { comment: "synthetic-test-only" });
const encryptedOpenSsh = utils.generateKeyPairSync("ed25519", {
  passphrase: "synthetic-test-only", cipher: "aes256-cbc", rounds: 1
}).private;
const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "sec1", format: "pem" }).toString();
const encryptedPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
  type: "sec1", format: "pem", cipher: "aes-256-cbc", passphrase: "synthetic-test-only"
}).toString();
const passwordResponse = { version: 1, username: "operator", password: canary };
const keyResponse = { version: 1, username: "operator", private_key: openSsh.private };
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

function expectSafeRejection(bytes: Uint8Array, method: "password" | "key" = "password", code: CredentialProviderErrorCode = "invalid-response"): void {
  let caught: unknown;
  try { parseExternalCredentialResponse(bytes, method); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CredentialProviderError);
  const error = caught as CredentialProviderError;
  expect(error.code).toBe(code);
  expect(error.message).not.toContain(canary);
  expect(error.stack).not.toContain(canary);
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(canary);
}

describe("external credential protocol", () => {
  it.each(["", " \n\t"])('preserves a password exactly with surrounding JSON whitespace %j', (whitespace) => {
    const password = " \n\t" + canary + "\r\n ";
    const bytes = Buffer.from(whitespace + JSON.stringify({ version: 1, username: " operator ", password }) + whitespace);
    const before = Buffer.from(bytes);
    expect(parseExternalCredentialResponse(bytes, "password")).toEqual({ method: "password", username: " operator ", password });
    expect(bytes).toEqual(before);
  });

  it.each([openSsh.private, pem])("returns independently owned usable unencrypted private-key bytes", (private_key) => {
    const bytes = encode({ ...keyResponse, private_key });
    const before = Buffer.from(bytes);
    const result = parseExternalCredentialResponse(bytes, "key");
    expect(result.method).toBe("key");
    if (result.method !== "key") throw new Error("Expected key");
    expect(result.username).toBe("operator");
    expect(result.privateKey).toEqual(Buffer.from(private_key));
    expect(bytes).toEqual(before);
    bytes.fill(0);
    expect(result.privateKey.toString()).toBe(private_key);
    result.privateKey.fill(0);
  });

  it.each([
    ["null", null], ["array", [passwordResponse]], ["version", { ...passwordResponse, version: 2 }],
    ["string version", { ...passwordResponse, version: "1" }], ["missing version", { username: "operator", password: canary }],
    ["unknown property", { ...passwordResponse, [canary]: true }],
    ["prototype property", JSON.parse('{"version":1,"username":"operator","password":"SECRET_CANARY","__proto__":{}}')],
    ["passphrase", { ...passwordResponse, passphrase: canary }],
    ["both credentials", { ...passwordResponse, private_key: openSsh.private }],
    ["wrong credential", keyResponse], ["missing password", { version: 1, username: canary }],
    ["empty password", { ...passwordResponse, password: "" }], ["numeric password", { ...passwordResponse, password: 42 }],
    ["null password", { ...passwordResponse, password: null }], ["object password", { ...passwordResponse, password: { canary } }],
    ["missing username", { version: 1, password: canary }], ["empty username", { ...passwordResponse, username: "" }],
    ["numeric username", { ...passwordResponse, username: 42 }], ["NUL username", { ...passwordResponse, username: "op\0erator" }],
    ["CR username", { ...passwordResponse, username: "op\rerator" }], ["LF username", { ...passwordResponse, username: "op\nerator" }],
    ["long username", { ...passwordResponse, username: "é".repeat(513) }],
    ["long password", { ...passwordResponse, password: "é".repeat(32769) }]
  ])("rejects %s without exposing response data", (_name, value) => expectSafeRejection(encode(value)));

  it.each([
    ["password response", passwordResponse], ["public key", { ...keyResponse, private_key: openSsh.public }],
    ["encrypted OpenSSH", { ...keyResponse, private_key: encryptedOpenSsh }],
    ["encrypted PEM", { ...keyResponse, private_key: encryptedPem }],
    ["passphrase", { ...keyResponse, passphrase: canary }],
    ["empty key", { ...keyResponse, private_key: "" }], ["numeric key", { ...keyResponse, private_key: 42 }],
    ["PEM-looking text", { ...keyResponse, private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\n" + canary + "\n-----END OPENSSH PRIVATE KEY-----" }],
    ["unsupported format", { ...keyResponse, private_key: "PuTTY-User-Key-File-2: ssh-ed25519\nComment: " + canary }],
    ["long key", { ...keyResponse, private_key: "é".repeat(98305) }]
  ])("rejects key %s safely", (_name, value) => expectSafeRejection(encode(value), "key"));

  it.each([
    ["malformed JSON", Buffer.from('{"password":"' + canary + '",')],
    ["concatenated JSON", Buffer.concat([encode(passwordResponse), encode(passwordResponse)])],
    ["banner", Buffer.from(canary + "\n" + JSON.stringify(passwordResponse))],
    ["invalid UTF-8", Buffer.concat([encode(passwordResponse), Buffer.from([0xc3, 0x28])])]
  ])("rejects %s safely", (_name, bytes) => expectSafeRejection(bytes));

  it("rejects invalid UTF-8 inside a JSON string instead of replacing it", () => {
    expectSafeRejection(Buffer.concat([Buffer.from('{"version":1,"username":"operator","password":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
  });

  it("enforces the combined byte limit before UTF-8 and field validation", () => {
    const bytes = Buffer.alloc(256 * 1024 + 1, 0xff);
    expectSafeRejection(bytes, "password", "output-too-large");
  });

  it("accepts the combined response boundary including surrounding JSON whitespace", () => {
    const json = encode(passwordResponse);
    const bytes = Buffer.concat([json, Buffer.alloc(256 * 1024 - json.length, 0x20)]);
    expect(parseExternalCredentialResponse(bytes, "password")).toEqual({ method: "password", username: "operator", password: canary });
  });

  it("accepts exact username and password UTF-8 limits", () => {
    const username = "é".repeat(512);
    const password = "é".repeat(32768);
    expect(parseExternalCredentialResponse(encode({ version: 1, username, password }), "password"))
      .toEqual({ method: "password", username, password });
  });

  it("accepts a private key at its byte limit without normalizing its bytes", () => {
    const private_key = openSsh.private + " ".repeat(192 * 1024 - Buffer.byteLength(openSsh.private));
    const result = parseExternalCredentialResponse(encode({ ...keyResponse, private_key }), "key");
    expect(result.method).toBe("key");
    if (result.method === "key") {
      expect(result.privateKey.toString()).toBe(private_key);
      result.privateKey.fill(0);
    }
  });

  it("replaces thrown key parser exceptions with a controlled error", () => {
    const spy = vi.spyOn(utils, "parseKey").mockImplementation(() => { throw new Error(canary); });
    try { expectSafeRejection(encode(keyResponse), "key"); } finally { spy.mockRestore(); }
  });

  it("installed ssh2 rejects encrypted keys without invoking KDF or decryption", () => {
    const localRequire = createRequire(import.meta.url);
    const parserPath = localRequire.resolve("ssh2/lib/protocol/keyParser");
    const kdf = vi.fn(() => { throw new Error("KDF must not run"); });
    const decrypt = vi.fn(() => { throw new Error("Decryption must not run"); });
    const module = { exports: {} };
    runInNewContext(readFileSync(parserPath, "utf8"), {
      Buffer, module, exports: module.exports,
      require: (name: string): unknown => {
        if (name === "bcrypt-pbkdf") return { pbkdf: kdf };
        const dependency: unknown = createRequire(parserPath)(name);
        return name === "crypto" ? { ...(dependency as Record<string, unknown>), createDecipheriv: decrypt } : dependency;
      }
    }, { filename: parserPath });
    const parser = module.exports as { parseKey: typeof utils.parseKey };
    for (const key of [encryptedOpenSsh, encryptedPem]) {
      const result = parser.parseKey(key);
      expect(result).toHaveProperty("message", expect.stringContaining("no passphrase given"));
    }
    expect(kdf).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
});

const codes: CredentialProviderErrorCode[] = [
  "unconfigured", "untrusted-workspace", "approval-required", "cancelled", "configuration-changed", "queue-full",
  "queue-timeout", "spawn-failed", "invalid-template", "timed-out", "cleanup-failed", "output-too-large", "exited", "invalid-response", "unsupported-consumer"
];
describe("credential provider errors", () => {
  it.each(codes)("derives a controlled message for %s", (code) => {
    const error = new CredentialProviderError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.cause).toBeUndefined();
  });
  it("retains only a safe integer exit code", () => {
    expect(new CredentialProviderError("exited", 7).exitCode).toBe(7);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const error = new CredentialProviderError("exited", invalid);
      expect(error.exitCode).toBeUndefined();
      expect(error.message).not.toContain(String(invalid));
    }
  });
});
