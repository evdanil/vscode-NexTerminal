import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/models/config";

// The raw CJS exports object — the SAME object ssh2's `require("crypto")`
// destructures at module load, and the one createDiffieHellmanGroup must be
// wrapped on. The ESM namespace (`import * as`) is frozen and cannot be
// patched.
const cryptoCjs = require("node:crypto") as typeof import("node:crypto");

// WHY THIS FILE EXISTS — "Connect failed Unknown DH group" against old Cisco
// devices (e.g. WS-C6509-E, banner "Cisco-1.25"): ssh2 negotiates
// diffie-hellman-group1-sha1 (its Cisco compat strips group-exchange KEX, and
// old IOS advertises nothing newer than group1), then calls
// crypto.createDiffieHellmanGroup("modp2"). VS Code's Electron crypto cannot
// resolve that 1024-bit group BY NAME and throws ERR_CRYPTO_UNKNOWN_DH_GROUP
// before a single handshake byte is sent. The fix is a compat shim — installed
// by the connector module BEFORE ssh2 loads — that falls back to
// createDiffieHellman() with the well-known RFC 2409 group-2 prime when (and
// only when) the named lookup fails.

// RFC 2409 Oakley Group 2 (1024-bit MODP), generator 2 — byte-identical to
// Node's built-in "modp2" group.
export const RFC2409_GROUP2_PRIME_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
  "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
  "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381" +
  "FFFFFFFFFFFFFFFF";

// --- Simulated Electron/BoringSSL runtime ---------------------------------
// Patch node:crypto BEFORE anything imports ssh2 (ssh2 destructures
// createDiffieHellmanGroup at module evaluation). This describe must stay
// first in the file: the shim-logic describes below import the shim module,
// whose evaluation self-installs on node:crypto — wrapping THIS broken
// lookup, which is exactly the production condition being simulated.
const realCreateDiffieHellmanGroup = cryptoCjs.createDiffieHellmanGroup;
const brokenLikeBoringSsl = function createDiffieHellmanGroup(name: string): unknown {
  if (String(name) === "modp2") {
    const err = new Error("Unknown DH group");
    (err as NodeJS.ErrnoException).code = "ERR_CRYPTO_UNKNOWN_DH_GROUP";
    throw err;
  }
  return realCreateDiffieHellmanGroup(name);
};

beforeAll(() => {
  (cryptoCjs as unknown as Record<string, unknown>).createDiffieHellmanGroup = brokenLikeBoringSsl;
});

afterAll(() => {
  (cryptoCjs as unknown as Record<string, unknown>).createDiffieHellmanGroup = realCreateDiffieHellmanGroup;
});

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "c6509",
    name: "WS-C6509-E",
    host: "127.0.0.1",
    port: 0,
    username: "test",
    authType: "password",
    isHidden: false,
    ...overrides
  };
}

describe("SSH diffie-hellman-group1-sha1 on an Electron-like runtime", () => {
  it("completes a handshake against a group1-sha1-only server even though the runtime refuses modp2 by name", async () => {
    // Dynamic imports: the connector module's FIRST import is the compat shim,
    // which must self-install before ssh2 evaluates. Importing ssh2 statically
    // at file top would evaluate it before the patch above.
    const connectorModule = await import("../../src/services/ssh/ssh2Connector");
    const ssh2 = await import("ssh2");

    // The connector body must restore the shared crypto export once ssh2 has
    // captured the wrapper: the extension-host process is shared with other
    // extensions, and a permanent monkey-patch would change behavior for every
    // consumer that comes after us. The handshake below must STILL work — ssh2
    // holds the wrapper in its own closure, not via the module property.
    expect(cryptoCjs.createDiffieHellmanGroup).toBe(brokenLikeBoringSsl);

    const { privateKey } = cryptoCjs.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const hostKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });

    // The 6509's offer: group1 KEX only (ssh2's Cisco compat strips
    // group-exchange, so this is the only mutually supported KEX).
    const server = new ssh2.Server(
      {
        hostKeys: [hostKeyPem],
        algorithms: {
          kex: ["diffie-hellman-group1-sha1"],
          cipher: ["aes128-cbc"],
          hmac: ["hmac-sha1"],
          serverHostKey: ["ssh-rsa"]
        }
      },
      (info) => {
        info.on("authentication", (ctx) => {
          if (ctx.method === "password" && ctx.password === "test") {
            ctx.accept();
          } else {
            ctx.reject();
          }
        });
      }
    );

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;

    try {
      const connector = new connectorModule.Ssh2Connector();
      const connection = await connector.connect(
        makeServer({ legacyAlgorithms: true, port }),
        { password: "test" }
      );
      // Reaching `ready` proves the KEXDH_INIT for group1-sha1 was built and
      // the shared secret computed — the exact step that throws
      // "Unknown DH group" on Electron without the fallback.
      expect(connection).toBeDefined();
      connection.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// --- Shim behavior (module unit tests) --------------------------------------
// These run after the E2E above; the shim module is already installed on
// node:crypto (wrapping the simulated-broken lookup), which is exactly the
// production condition.

describe("installSshDhGroupCompat", () => {
  it("falls back to an explicit-prime DH whose prime is the RFC 2409 group-2 constant", async () => {
    const { installSshDhGroupCompat, RFC2409_GROUP2_PRIME } = await import("../../src/services/ssh/sshDhGroupCompat");
    const target: { createDiffieHellmanGroup(name: string): unknown } = {
      createDiffieHellmanGroup(name: string): unknown {
        if (name === "modp2") {
          const err = new Error("Unknown DH group");
          (err as NodeJS.ErrnoException).code = "ERR_CRYPTO_UNKNOWN_DH_GROUP";
          throw err;
        }
        throw new Error("unexpected group " + name);
      }
    };
    expect(installSshDhGroupCompat(target)).toBe(true);

    const dh = target.createDiffieHellmanGroup("modp2") as { getPrime(enc: "hex"): string };
    expect(dh.getPrime("hex").toUpperCase()).toBe(RFC2409_GROUP2_PRIME);

    // And it performs a real, correct DH exchange.
    const peer = cryptoCjs.createDiffieHellman(
      Buffer.from(RFC2409_GROUP2_PRIME_HEX, "hex"),
      Buffer.from([0x02])
    );
    const ours = target.createDiffieHellmanGroup("modp2") as unknown as {
      generateKeys(): Buffer;
      computeSecret(peer: Buffer): Buffer;
    };
    const ourPublic = ours.generateKeys();
    const peerPublic = peer.generateKeys();
    expect(ours.computeSecret(peerPublic).equals(peer.computeSecret(ourPublic))).toBe(true);
  });

  it("uses the runtime's group untouched when the name resolves", async () => {
    const { installSshDhGroupCompat } = await import("../../src/services/ssh/sshDhGroupCompat");
    const sentinel = Symbol("native-group");
    let calls = 0;
    const target = {
      createDiffieHellmanGroup(_name: string): unknown {
        calls += 1;
        return sentinel;
      }
    };
    installSshDhGroupCompat(target);
    expect(target.createDiffieHellmanGroup("modp14")).toBe(sentinel);
    expect(calls).toBe(1);
  });

  it("rethrows the original error for group names it cannot back", async () => {
    const { installSshDhGroupCompat } = await import("../../src/services/ssh/sshDhGroupCompat");
    const target = {
      createDiffieHellmanGroup(_name: string): never {
        throw new Error("Unknown DH group");
      }
    };
    installSshDhGroupCompat(target);
    expect(() => target.createDiffieHellmanGroup("modp-nonexistent")).toThrow("Unknown DH group");
  });

  it("is idempotent", async () => {
    const { installSshDhGroupCompat } = await import("../../src/services/ssh/sshDhGroupCompat");
    const target = {
      createDiffieHellmanGroup(): null {
        return null;
      }
    };
    expect(installSshDhGroupCompat(target)).toBe(true);
    expect(installSshDhGroupCompat(target)).toBe(false);
  });

  it("uninstall restores the original export once ssh2 has captured the wrapper", async () => {
    const { installSshDhGroupCompat, uninstallSshDhGroupCompat } = await import("../../src/services/ssh/sshDhGroupCompat");
    const original = (): string => "native";
    const target: { createDiffieHellmanGroup(name: string): unknown } = {
      createDiffieHellmanGroup: original
    };
    installSshDhGroupCompat(target);
    expect(target.createDiffieHellmanGroup).not.toBe(original);

    expect(uninstallSshDhGroupCompat(target)).toBe(true);
    expect(target.createDiffieHellmanGroup).toBe(original);

    // ssh2 captured the wrapper by closure at ITS load time; a fresh install
    // after the restore must still work for the next consumer.
    expect(installSshDhGroupCompat(target)).toBe(true);
  });

  it("uninstall is a no-op when nothing is installed", async () => {
    const { uninstallSshDhGroupCompat } = await import("../../src/services/ssh/sshDhGroupCompat");
    const target: { createDiffieHellmanGroup(name: string): string } = {
      createDiffieHellmanGroup: () => "native"
    };
    expect(uninstallSshDhGroupCompat(target)).toBe(false);
  });

  it("uninstall never clobbers a third-party patch installed after ours", async () => {
    const { installSshDhGroupCompat, uninstallSshDhGroupCompat } = await import("../../src/services/ssh/sshDhGroupCompat");
    const original = (): string => "native";
    const target: { createDiffieHellmanGroup(name: string): unknown } = {
      createDiffieHellmanGroup: original
    };
    installSshDhGroupCompat(target);
    const thirdParty = (): string => "someone-elses-wrapper";
    target.createDiffieHellmanGroup = thirdParty;

    // The current export is not ours anymore — leave it alone.
    expect(uninstallSshDhGroupCompat(target)).toBe(false);
    expect(target.createDiffieHellmanGroup).toBe(thirdParty);
  });
});
