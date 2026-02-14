import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../src/models/config";
import type { PasswordPrompt, SecretVault, SshConnection, SshConnector } from "../../src/services/ssh/contracts";
import { SilentAuthSshFactory, passwordSecretKey } from "../../src/services/ssh/silentAuth";

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
  onClose: vi.fn().mockReturnValue(() => {}),
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
});
