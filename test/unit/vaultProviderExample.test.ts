import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { generateKeyPairSync } from "node:crypto";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";

const cli = process.execPath;
const providers = ["vault-kv1", "vault-kv2", "aws", "azure"] as const;
function envelope(provider: string, value: unknown): string {
  return JSON.stringify(provider === "vault-kv1" ? { data: value } : provider === "vault-kv2" ? { data: { data: value } } : provider === "aws" ? { SecretString: JSON.stringify(value) } : { value: JSON.stringify(value) });
}
function run(provider: string, stdout: string, method = "--pass", status = 0) {
  let output = "", error = "";
  const child = vi.fn(() => ({ stdout, status, stderr: "SECRET_ERROR_CANARY" }));
  const proc = { argv: ["node", "example", provider, cli, "scope", "secret path", method], exitCode: 0,
    stdout: { write: (s: string) => { output += s; } }, stderr: { write: (s: string) => { error += s; } } };
  runInNewContext(readFileSync(resolve("examples/external-credentials/vault-provider.cjs"), "utf8"), {
    process: proc, require: (name: string) => name === "node:child_process" ? { spawnSync: child } : { isAbsolute: () => true }
  });
  return { output, error, code: proc.exitCode, child };
}
describe.each(providers)("%s provider example", (provider) => {
  it("preserves secrets and emits only protocol fields", () => {
    const password = '  quote" newline\n';
    const result = run(provider, envelope(provider, { username: "operator", password, metadata: "not emitted" }));
    expect(result.code).toBe(0); expect(result.error).toBe("");
    expect(parseExternalCredentialResponse(Buffer.from(result.output), "password")).toEqual({ method: "password", username: "operator", password });
    const args = result.child.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(args[0]).toBe(cli);
    expect(args[1]).toEqual(provider.startsWith("vault") ? ["kv", "get", "-format=json", "-mount=scope", "secret path"] : provider === "aws" ? ["secretsmanager", "get-secret-value", "--region", "scope", "--secret-id", "secret path", "--output", "json", "--no-cli-pager"] : ["-I", "-m", "azure.cli", "keyvault", "secret", "show", "--vault-name", "scope", "--name", "secret path", "--output", "json", "--only-show-errors"]);
    expect(args[2]).toMatchObject({ shell: false, timeout: 20000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  });
  it("returns a private key accepted by Nexus", () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const result = run(provider, envelope(provider, { username: "operator", private_key: key }), "--pkey");
    expect(result.code).toBe(0);
    const parsed = parseExternalCredentialResponse(Buffer.from(result.output), "key");
    expect(parsed.method).toBe("key");
    if (parsed.method === "key") { expect(parsed.privateKey.toString()).toBe(key); parsed.privateKey.fill(0); }
  });
  it.each(["bad-json", "cli-failure", "missing-field", "invalid-method"])("fails closed: %s", (failure) => {
    const result = run(provider, failure === "bad-json" ? "SECRET_INVALID_JSON" : envelope(provider, { username: "operator", ...(failure === "missing-field" ? {} : { password: "SECRET_CANARY" }) }), failure === "invalid-method" ? "--other" : "--pass", failure === "cli-failure" ? 1 : 0);
    expect(result.code).toBe(1); expect(result.output).toBe(""); expect(result.error).toBe("Vault credential retrieval failed.\n");
  });
});
