import { describe, expect, it } from "vitest";
import { createWebviewNonce } from "../../src/ui/shared/webviewNonce";

describe("createWebviewNonce", () => {
  it("returns a non-empty string", () => {
    expect(createWebviewNonce()).not.toBe("");
  });

  it("encodes 16 random bytes as base64 (24-char, '='-padded)", () => {
    const nonce = createWebviewNonce();
    // 16 bytes → 24 base64 chars including the trailing '=' pad.
    expect(nonce).toHaveLength(24);
    expect(nonce.endsWith("=")).toBe(true);
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
  });

  it("produces a fresh value on each call", () => {
    const values = new Set(Array.from({ length: 50 }, () => createWebviewNonce()));
    // Collisions across 50 draws of 128 random bits are astronomically unlikely.
    expect(values.size).toBe(50);
  });

  it("only contains base64 characters", () => {
    for (let i = 0; i < 20; i++) {
      expect(createWebviewNonce()).toMatch(/^[A-Za-z0-9+/]+=*$/);
    }
  });
});
