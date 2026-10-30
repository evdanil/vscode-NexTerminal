import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { parseExternalCredentialResponse } from "../../src/services/credentials/externalCredentialProtocol";

const directories: string[] = [];
function run(secret: string, method = "--pass", fail = false) {
  const cwd = mkdtempSync(join(tmpdir(), "nexus-op-example-")); directories.push(cwd);
  // Node stands in for op: `node read --no-newline op://...` runs this fake CLI.
  writeFileSync(join(cwd, "read"), `
    if (process.argv[2] !== "--no-newline") process.exit(8);
    if (${fail}) { process.stderr.write("PRIVATE_ERROR_CANARY"); process.exit(1); }
    const ref = process.argv[3];
    if (ref === "op://Vault/Lab Login/username") process.stdout.write("operator");
    else if (ref === "op://Vault/Lab Login/secret") process.stdout.write(${JSON.stringify(secret)});
    else process.exit(9);
  `);
  return spawnSync(process.execPath, [resolve("examples/external-credentials/1password.cjs"),
    process.execPath, "op://Vault/Lab Login/username", "op://Vault/Lab Login/secret", method],
    { cwd, encoding: "utf8" });
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("1Password provider example", () => {
  it("preserves secret whitespace and quotes in valid password JSON", () => {
    const secret = '  quote" slash\\ newline\n';
    const result = run(secret);
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(parseExternalCredentialResponse(Buffer.from(result.stdout), "password"))
      .toEqual({ method: "password", username: "operator", password: secret });
  });
  it("returns a key accepted by the real provider parser", () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const result = run(key, "--pkey"); expect(result.status).toBe(0);
    const parsed = parseExternalCredentialResponse(Buffer.from(result.stdout), "key");
    expect(parsed.method).toBe("key");
    if (parsed.method === "key") { expect(parsed.privateKey.toString()).toBe(key); parsed.privateKey.fill(0); }
  });
  it("emits no credentials or raw CLI error on failure", () => {
    const result = run("SECRET_CANARY", "--pass", true);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("1Password credential retrieval failed.\n");
  });
  it("rejects an unsupported method without output", () => {
    const result = run("SECRET_CANARY", "--other"); expect(result.status).toBe(1); expect(result.stdout).toBe("");
  });
  it("rejects an empty secret without partial JSON", () => {
    const result = run(""); expect(result.status).toBe(1); expect(result.stdout).toBe("");
  });
});
