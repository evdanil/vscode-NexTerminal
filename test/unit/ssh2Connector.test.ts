import { describe, expect, it } from "vitest";
import { buildConnectConfig, LEGACY_ALGORITHMS } from "../../src/services/ssh/ssh2Connector";
import type { ServerConfig } from "../../src/models/config";

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "s1",
    name: "Test Server",
    host: "example.com",
    port: 22,
    username: "dev",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

describe("buildConnectConfig", () => {
  it("returns base config without algorithms when legacyAlgorithms is not set", async () => {
    const config = await buildConnectConfig(makeServer(), "password123");
    expect(config.host).toBe("example.com");
    expect(config.port).toBe(22);
    expect(config.username).toBe("dev");
    expect(config.password).toBe("password123");
    expect((config as any).algorithms).toBeUndefined();
  });

  it("returns base config without algorithms when legacyAlgorithms is false", async () => {
    const config = await buildConnectConfig(makeServer({ legacyAlgorithms: false }), "pw");
    expect((config as any).algorithms).toBeUndefined();
  });

  it("includes LEGACY_ALGORITHMS when legacyAlgorithms is true", async () => {
    const config = await buildConnectConfig(makeServer({ legacyAlgorithms: true }), "pw");
    expect((config as any).algorithms).toBe(LEGACY_ALGORITHMS);
  });

  it("applies custom connection options", async () => {
    const config = await buildConnectConfig(
      makeServer(),
      "password123",
      undefined,
      undefined,
      {
        readyTimeoutMs: 12_000,
        keepaliveIntervalMs: 0,
        keepaliveCountMax: 7
      }
    );

    expect(config.readyTimeout).toBe(12_000);
    expect(config.keepaliveInterval).toBe(0);
    expect(config.keepaliveCountMax).toBe(7);
  });

  it("clamps connection options to safe runtime bounds", async () => {
    const config = await buildConnectConfig(
      makeServer(),
      "password123",
      undefined,
      undefined,
      {
        readyTimeoutMs: 1,
        keepaliveIntervalMs: -5,
        keepaliveCountMax: 999
      }
    );

    expect(config.readyTimeout).toBe(5_000);
    expect(config.keepaliveInterval).toBe(0);
    expect(config.keepaliveCountMax).toBe(30);
  });

  it("LEGACY_ALGORITHMS contains expected algorithm families", () => {
    expect(LEGACY_ALGORITHMS.kex.append).toContain("diffie-hellman-group1-sha1");
    expect(LEGACY_ALGORITHMS.cipher.append).toContain("3des-cbc");
    expect(LEGACY_ALGORITHMS.serverHostKey.append).toContain("ssh-dss");
    expect(LEGACY_ALGORITHMS.hmac.append).toContain("hmac-md5");
  });

  it("LEGACY_ALGORITHMS excludes broken and unsupported ciphers", () => {
    const ciphers = LEGACY_ALGORITHMS.cipher.append as string[];
    // RC4 - cryptographically broken
    expect(ciphers).not.toContain("arcfour");
    expect(ciphers).not.toContain("arcfour128");
    expect(ciphers).not.toContain("arcfour256");
    // Dropped by OpenSSL 3.x - cause silent handshake timeouts
    expect(ciphers).not.toContain("cast128-cbc");
    expect(ciphers).not.toContain("blowfish-cbc");
  });
});
