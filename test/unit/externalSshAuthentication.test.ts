import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AnyAuthMethod, NextAuthHandler, KeyboardInteractiveAuthMethod, PublicKeyAuthMethod } from "ssh2";
import { createExternalSshAuthentication } from "../../src/services/ssh/externalSshAuthentication";

const pem = (): Buffer => Buffer.from(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));
function next(adapter: ReturnType<typeof createExternalSshAuthentication>, methods: string[] | null = null, partial = false): AnyAuthMethod | false {
  // ssh2 supports synchronous return values and initially passes null; its typings omit both.
  return (adapter.connectOptions.authHandler as (methods: string[] | null, partial: boolean, cb: NextAuthHandler) => AnyAuthMethod | false)(methods, partial, vi.fn());
}

describe("external SSH authentication", () => {
  it("offers the external password once, then keyboard-interactive once, without top-level secrets or other methods", () => {
    const credential = { method: "password" as const, username: "provider-user", password: " secret " };
    const adapter = createExternalSshAuthentication(credential);
    expect(Object.keys(adapter.connectOptions).sort()).toEqual(["authHandler", "tryKeyboard", "username"]);
    expect(adapter.connectOptions.username).toBe("provider-user");
    expect(next(adapter)).toEqual({ type: "password", username: "provider-user", password: " secret " });
    expect(next(adapter, ["keyboard-interactive", "password", "agent"])).toMatchObject({ type: "keyboard-interactive", username: "provider-user" });
    expect(next(adapter, ["password", "keyboard-interactive", "agent"])).toBe(false);
    adapter.dispose();
    expect(credential.password).toBe(" secret ");
    expect(next(adapter)).toBe(false);
  });

  it.each([true, false])("refuses partial success or unavailable fallback (partial=%s)", (partial) => {
    const adapter = createExternalSshAuthentication({ method: "password", username: "user", password: "secret" });
    next(adapter);
    expect(next(adapter, ["password", "publickey", "agent"], partial)).toBe(false);
    expect(next(adapter, ["keyboard-interactive"])).toBe(false);
  });

  it.each([
    { prompts: [{ prompt: "Password: ", echo: false }], expected: ["secret"] },
    { prompts: [{ prompt: "user@example.test's password:", echo: false }], expected: ["secret"] },
    { prompts: [{ prompt: "Password:", echo: true }], expected: [] },
    { prompts: [{ prompt: "OTP:", echo: false }], expected: [] },
    { prompts: [{ prompt: "Password or verification code:", echo: false }], expected: [] },
    { prompts: [{ prompt: "New password:", echo: false }], expected: [] },
    { prompts: [{ prompt: "Password:", echo: false }, { prompt: "OTP:", echo: false }], expected: [] }
  ])("only answers one recognized non-echo password challenge: $prompts", ({ prompts, expected }) => {
    const adapter = createExternalSshAuthentication({ method: "password", username: "user", password: "secret" });
    next(adapter);
    const method = next(adapter, ["keyboard-interactive"]) as KeyboardInteractiveAuthMethod;
    const finish = vi.fn();
    method.prompt("", "", "", prompts, finish);
    expect(finish).toHaveBeenLastCalledWith(expected);
    method.prompt("", "", "", [{ prompt: "Password:", echo: false }], finish);
    expect(finish).toHaveBeenLastCalledWith([]);
    adapter.dispose();
    method.prompt("", "", "", prompts, finish);
    expect(finish).toHaveBeenLastCalledWith([]);
  });

  it("reports unsupported challenges without echoing provider or server data", () => {
    const onInteractionRequired = vi.fn();
    const adapter = createExternalSshAuthentication({ method: "password", username: "private-user", password: "private-password" }, { onInteractionRequired });
    next(adapter);
    const method = next(adapter, ["keyboard-interactive"]) as KeyboardInteractiveAuthMethod;
    const finish = vi.fn();
    method.prompt("private-banner", "private-instructions", "", [{ prompt: "OTP", echo: false }], finish);
    expect(onInteractionRequired).toHaveBeenCalledWith();
    expect(finish).toHaveBeenCalledWith([]);
  });

  it("owns a separate key copy and wipes it on disposal, without fallback or reuse", () => {
    const borrowed = pem();
    const adapter = createExternalSshAuthentication({ method: "key", username: "key-user", privateKey: borrowed });
    const method = next(adapter) as PublicKeyAuthMethod;
    expect(method).toMatchObject({ type: "publickey", username: "key-user" });
    expect(method.key).not.toBe(borrowed);
    expect(method.key).toEqual(borrowed);
    expect(adapter.connectOptions.tryKeyboard).toBe(false);
    borrowed.fill(0);
    expect((method.key as Buffer).some((byte) => byte !== 0)).toBe(true);
    expect(next(adapter, ["publickey", "keyboard-interactive", "password", "agent"])).toBe(false);
    adapter.dispose();
    adapter.dispose();
    expect((method.key as Buffer).every((byte) => byte === 0)).toBe(true);
    expect(next(adapter)).toBe(false);
  });

  it("refuses invalid and encrypted keys with controlled errors", () => {
    const encrypted = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "private-passphrase" });
    for (const key of ["private-key-secret-invalid", encrypted]) {
      expect(() => createExternalSshAuthentication({ method: "key", username: "secret-username", privateKey: Buffer.from(key) })).toThrow("External credential program returned an invalid response.");
    }
  });
});
