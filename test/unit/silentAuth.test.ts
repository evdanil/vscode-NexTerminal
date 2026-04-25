import { describe, expect, it, vi } from "vitest";
import type { AuthProfile, ServerConfig } from "../../src/models/config";
import type { PasswordPrompt, SecretVault, SshConnection, SshConnector } from "../../src/services/ssh/contracts";
import {
  SilentAuthSshFactory,
  passwordSecretKey,
  authProfilePasswordSecretKey,
  authProfilePassphraseSecretKey,
  passphraseSecretKey
} from "../../src/services/ssh/silentAuth";

const baseServer: ServerConfig = {
  id: "srv-1",
  name: "Prod",
  host: "example.com",
  port: 22,
  username: "root",
  authType: "password",
  isHidden: false
};

const fakeConnection: SshConnection = {
  openShell: vi.fn(),
  openDirectTcp: vi.fn(),
  openSftp: vi.fn(),
  exec: vi.fn(),
  requestForwardIn: vi.fn(),
  cancelForwardIn: vi.fn(),
  onTcpConnection: vi.fn().mockReturnValue(() => {}),
  onClose: vi.fn().mockReturnValue(() => {}),
  getBanner: vi.fn().mockReturnValue(undefined),
  dispose: vi.fn()
};

function createVault(seed?: Record<string, string>): SecretVault {
  const entries = new Map(Object.entries(seed ?? {}));
  return {
    get: vi.fn(async (key: string) => entries.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      entries.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      entries.delete(key);
    })
  };
}

describe("SilentAuthSshFactory", () => {
  it("uses stored password without prompting", async () => {
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "saved-secret" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "new-secret", save: true }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    const connection = await factory.connect(baseServer);

    expect(connection).toBe(fakeConnection);
    expect(connector.connect).toHaveBeenCalledWith(baseServer, { password: "saved-secret" });
    expect(prompt.prompt).not.toHaveBeenCalled();
  });

  it("retries with prompted password after auth error and stores when requested", async () => {
    const connector: SshConnector = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "bad-secret" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "fresh-secret", save: true }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    const connection = await factory.connect(baseServer);

    expect(connection).toBe(fakeConnection);
    expect(vault.delete).toHaveBeenCalledWith(passwordSecretKey(baseServer.id));
    expect(prompt.prompt).toHaveBeenCalledOnce();
    expect(vault.store).toHaveBeenCalledWith(passwordSecretKey(baseServer.id), "fresh-secret");
    expect(connector.connect).toHaveBeenNthCalledWith(2, baseServer, { password: "fresh-secret" });
  });

  it("does not retry on non-auth errors", async () => {
    const connector: SshConnector = {
      connect: vi.fn(async () => {
        throw new Error("socket timeout");
      })
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "saved-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    await expect(factory.connect(baseServer)).rejects.toThrow("socket timeout");
    expect(prompt.prompt).not.toHaveBeenCalled();
  });

  it("throws when user cancels password prompt", async () => {
    const connector: SshConnector = {
      connect: vi.fn(async () => {
        throw new Error("authentication failed");
      })
    };
    const vault = createVault();
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => undefined)
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    await expect(factory.connect(baseServer)).rejects.toThrow("Password entry canceled");
  });

  it("bypasses password flow for key auth", async () => {
    const server: ServerConfig = {
      ...baseServer,
      authType: "key",
      keyPath: "C:/id_rsa"
    };
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault();
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    await factory.connect(server);

    expect(connector.connect).toHaveBeenCalledWith(server, {});
    expect(prompt.prompt).not.toHaveBeenCalled();
  });

  it("resolves credentials from auth profile when authProfileId is set", async () => {
    const profile: AuthProfile = {
      id: "prof-1",
      name: "Production",
      username: "root",
      authType: "password"
    };
    const server: ServerConfig = {
      ...baseServer,
      username: "alice",
      authType: "key",
      authProfileId: "prof-1"
    };
    const profilePwKey = authProfilePasswordSecretKey("prof-1");
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [profilePwKey]: "profile-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const lookup = (id: string) => id === "prof-1" ? profile : undefined;
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

    await factory.connect(server);

    // Should use profile credentials, not server's
    expect(connector.connect).toHaveBeenCalledWith(
      expect.objectContaining({ username: "root", authType: "password" }),
      expect.objectContaining({ password: "profile-secret" })
    );
    expect(prompt.prompt).not.toHaveBeenCalled();
  });

  it("uses auth-profile passphrase storage for linked key auth", async () => {
    const profile: AuthProfile = {
      id: "prof-key",
      name: "Shared Key",
      username: "root",
      authType: "key",
      keyPath: "/keys/id_ed25519"
    };
    const server: ServerConfig = {
      ...baseServer,
      authType: "password",
      authProfileId: "prof-key"
    };
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const lookup = (id: string) => id === "prof-key" ? profile : undefined;
    const vault = createVault({ [authProfilePassphraseSecretKey("prof-key")]: "shared-passphrase" });
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

    await factory.connect(server);

    expect(connector.connect).toHaveBeenCalledWith(
      expect.objectContaining({ username: "root", authType: "key", keyPath: "/keys/id_ed25519" }),
      expect.objectContaining({ passphrase: "shared-passphrase" })
    );
    expect(vault.get).toHaveBeenCalledWith(authProfilePassphraseSecretKey("prof-key"));
    expect(vault.get).not.toHaveBeenCalledWith(passphraseSecretKey(server.id));
    expect(prompt.prompt).not.toHaveBeenCalled();
  });

  it("stores prompted passphrase on auth profile and removes server-scoped duplicate", async () => {
    const profile: AuthProfile = {
      id: "prof-key",
      name: "Shared Key",
      username: "root",
      authType: "key",
      keyPath: "/keys/id_ed25519"
    };
    const server: ServerConfig = {
      ...baseServer,
      authProfileId: "prof-key"
    };
    const connector: SshConnector = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error("Encrypted private key requires passphrase"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "fresh-passphrase", save: true }))
    };
    const lookup = (id: string) => id === "prof-key" ? profile : undefined;
    const vault = createVault({ [passphraseSecretKey(server.id)]: "old-duplicate" });
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

    const connection = await factory.connect(server);

    expect(connection).toBe(fakeConnection);
    expect(prompt.prompt).toHaveBeenCalledOnce();
    expect(vault.store).toHaveBeenCalledWith(authProfilePassphraseSecretKey("prof-key"), "fresh-passphrase");
    expect(vault.delete).toHaveBeenCalledWith(passphraseSecretKey(server.id));
    expect(vault.store).not.toHaveBeenCalledWith(passphraseSecretKey(server.id), expect.anything());
  });

  it("falls back to server credentials when profile not found", async () => {
    const server: ServerConfig = {
      ...baseServer,
      authProfileId: "nonexistent"
    };
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(server.id)]: "server-pw" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const lookup = (_id: string) => undefined;
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

    await factory.connect(server);

    expect(connector.connect).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ password: "server-pw" })
    );
  });

  it("uses server credentials when no lookup provided", async () => {
    const server: ServerConfig = {
      ...baseServer,
      authProfileId: "prof-1"
    };
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(server.id)]: "server-pw" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    await factory.connect(server);

    expect(connector.connect).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ password: "server-pw" })
    );
  });
});

// Helper: a minimal Duplex mock with a destroy spy.
function makeMockStream(): { destroy: ReturnType<typeof vi.fn> } & object {
  return { destroy: vi.fn() };
}

describe("SilentAuthSshFactory sockFactory (proxy path)", () => {
  // Test 1: password auth, saved password fails, prompted password succeeds.
  // sockFactory called twice; first sock is destroyed, second is not.
  it("password auth: saved pw fails, prompted pw succeeds — sockFactory called twice, first sock destroyed", async () => {
    const firstSock = makeMockStream();
    const secondSock = makeMockStream();
    const socks = [firstSock, secondSock];
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "bad-password" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "good-password", save: false }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    const connection = await factory.connect(baseServer, { sockFactory });

    expect(connection).toBe(fakeConnection);
    expect(sockFactory).toHaveBeenCalledTimes(2);
    // First sock should be destroyed after the failed attempt
    expect(firstSock.destroy).toHaveBeenCalledOnce();
    // Second sock backs the successful connection — must NOT be destroyed
    expect(secondSock.destroy).not.toHaveBeenCalled();
  });

  // Test 2: password auth, saved password fails, prompted password also fails.
  // sockFactory called twice; both socks are destroyed.
  it("password auth: saved pw fails, prompted pw also fails — both socks destroyed", async () => {
    const firstSock = makeMockStream();
    const secondSock = makeMockStream();
    const socks = [firstSock, secondSock];
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockRejectedValueOnce(new Error("authentication failed"))
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "bad-password" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "also-bad", save: false }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    await expect(factory.connect(baseServer, { sockFactory })).rejects.toThrow("authentication failed");

    expect(sockFactory).toHaveBeenCalledTimes(2);
    expect(firstSock.destroy).toHaveBeenCalledOnce();
    expect(secondSock.destroy).toHaveBeenCalledOnce();
  });

  // Test 3: password auth, no saved password, prompted succeeds first try.
  // sockFactory called exactly once; sock not destroyed.
  it("password auth: no saved pw, prompted succeeds first try — sockFactory called once, sock kept", async () => {
    const sock = makeMockStream();
    const sockFactory = vi.fn(async () => sock as any);

    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault(); // no saved password
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "first-try", save: false }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    const connection = await factory.connect(baseServer, { sockFactory });

    expect(connection).toBe(fakeConnection);
    expect(sockFactory).toHaveBeenCalledTimes(1);
    expect(sock.destroy).not.toHaveBeenCalled();
  });

  // Test 4: key auth, saved passphrase fails, prompted passphrase succeeds.
  // sockFactory called twice; first sock destroyed, second kept.
  it("key auth: saved passphrase fails, prompted passphrase succeeds — sockFactory called twice, first sock destroyed", async () => {
    const keyServer: ServerConfig = { ...baseServer, authType: "key", keyPath: "/home/user/.ssh/id_rsa" };
    const firstSock = makeMockStream();
    const secondSock = makeMockStream();
    const socks = [firstSock, secondSock];
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("Encrypted private key requires passphrase"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [passphraseSecretKey(keyServer.id)]: "wrong-passphrase" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "correct-passphrase", save: false }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    const connection = await factory.connect(keyServer, { sockFactory });

    expect(connection).toBe(fakeConnection);
    expect(sockFactory).toHaveBeenCalledTimes(2);
    expect(firstSock.destroy).toHaveBeenCalledOnce();
    expect(secondSock.destroy).not.toHaveBeenCalled();
  });

  // Test 5: no sockFactory provided (direct connection, no proxy).
  // Connector is called without a sock; happy path unchanged.
  it("no sockFactory provided — connector called without sock, happy path unchanged", async () => {
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "saved-pw" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    const connection = await factory.connect(baseServer);

    expect(connection).toBe(fakeConnection);
    expect(connector.connect).toHaveBeenCalledWith(
      baseServer,
      expect.not.objectContaining({ sock: expect.anything() })
    );
    expect(prompt.prompt).not.toHaveBeenCalled();
  });
});
