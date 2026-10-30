import { utils } from "ssh2";
import {
  EXTERNAL_CREDENTIAL_PASSWORD_MAX_BYTES,
  EXTERNAL_CREDENTIAL_PRIVATE_KEY_MAX_BYTES,
  EXTERNAL_CREDENTIAL_STDOUT_MAX_BYTES,
  EXTERNAL_CREDENTIAL_USERNAME_MAX_BYTES,
  type ResolvedExternalCredential
} from "./contracts";
import { CredentialProviderError } from "./credentialProviderError";

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

/** Caller owns and wipes bytes; a successful key result owns a separate buffer. */
export function parseExternalCredentialResponse(
  bytes: Uint8Array,
  method: "password" | "key"
): ResolvedExternalCredential {
  if (bytes.byteLength > EXTERNAL_CREDENTIAL_STDOUT_MAX_BYTES) {
    throw new CredentialProviderError("output-too-large");
  }
  let privateKey: Buffer | undefined;
  try {
    const response: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (typeof response !== "object" || response === null || Array.isArray(response)) throw new Error();
    const fields = response as Record<string, unknown>;
    const credentialField = method === "password" ? "password" : "private_key";
    if (Object.keys(fields).some((field) => field !== "version" && field !== "username" && field !== credentialField) ||
      fields.version !== 1 || !isBoundedString(fields.username, EXTERNAL_CREDENTIAL_USERNAME_MAX_BYTES) ||
      /[\0\r\n]/u.test(fields.username)) throw new Error();

    if (method === "password") {
      if (!isBoundedString(fields.password, EXTERNAL_CREDENTIAL_PASSWORD_MAX_BYTES)) throw new Error();
      return { method: "password", username: fields.username, password: fields.password };
    }

    if (!isBoundedString(fields.private_key, EXTERNAL_CREDENTIAL_PRIVATE_KEY_MAX_BYTES) ||
      !/^\s*-----BEGIN (?:OPENSSH|RSA|DSA|EC) PRIVATE KEY-----/u.test(fields.private_key)) throw new Error();
    privateKey = Buffer.from(fields.private_key, "utf8");
    // Without a passphrase ssh2 rejects encryption before KDF/decryption. Byte limits
    // bound input allocation, not the CPU time of arbitrary key parsing.
    const parsed = utils.parseKey(privateKey);
    const keys = Array.isArray(parsed) ? parsed : [parsed];
    if (keys.length !== 1 || keys.some((key) => key instanceof Error || !key.isPrivateKey())) throw new Error();
    return { method: "key", username: fields.username, privateKey };
  } catch {
    privateKey?.fill(0);
    // JSON/key parser exceptions can contain provider data; never retain a cause.
    throw new CredentialProviderError("invalid-response");
  }
}
