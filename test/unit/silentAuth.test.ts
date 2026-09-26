import { describe, expect, it, vi } from "vitest";
import type { AuthProfile, HttpConnectProxy, ServerConfig, Socks5Proxy } from "../../src/models/config";
import type { KeyboardInteractiveHandler, PasswordPrompt, SecretVault, SshConnection, SshConnector } from "../../src/services/ssh/contracts";
import type { ContextAwareSshFactory } from "../../src/services/ssh/contracts";
import { configMutationLock } from "../../src/services/configMutationLock";
import { ProxySshFactory, proxyEndpointRoute } from "../../src/services/ssh/proxySshFactory";
import {
  SilentAuthSshFactory,
  deleteServerSecrets,
  passwordSecretKey,
  authProfilePasswordSecretKey,
  authProfilePassphraseSecretKey,
  passphraseSecretKey,
  proxyPasswordSecretKey
} from "../../src/services/ssh/silentAuth";
import { SshConnectionPool } from "../../src/services/ssh/sshConnectionPool";
import { deterministicServerId } from "../../src/services/inventory/deterministicId";
import { PassThrough } from "node:stream";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it("does not read saved credentials when the server is already absent from live state", async () => {
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "saved-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, undefined, () => undefined);

    await expect(factory.connect(baseServer)).rejects.toThrow("configuration changed while connecting");

    expect(vault.get).not.toHaveBeenCalled();
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it("does not release an interactive answer after the live server record is replaced", async () => {
    const liveServer: { current: ServerConfig | undefined } = { current: { ...baseServer, authType: "key", keyPath: "/keys/id_ed25519" } };
    const inputPromptStarted = deferred<void>();
    const inputPromptAnswer = deferred<string | undefined>();
    const connector: SshConnector = {
      connect: vi.fn(async (_server, auth) => {
        await auth.onKeyboardInteractive?.("Verification", "", [{ prompt: "Code: ", echo: false }]);
        return fakeConnection;
      })
    };
    const factory = new SilentAuthSshFactory(
      connector,
      createVault(),
      { prompt: vi.fn() },
      async () => {
        inputPromptStarted.resolve();
        return inputPromptAnswer.promise;
      },
      undefined,
      (id) => (id === baseServer.id ? liveServer.current : undefined)
    );

    const connecting = factory.connect(liveServer.current);
    await inputPromptStarted.promise;
    liveServer.current = { ...liveServer.current! };
    inputPromptAnswer.resolve("stale-interactive-answer");

    await expect(connecting).rejects.toThrow("configuration changed while connecting");
    expect(connector.connect).toHaveBeenCalledOnce();
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
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => id === baseServer.id ? baseServer : undefined
    );

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
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      lookup,
      (id) => id === server.id ? server : undefined
    );

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

  /**
   * REVIEW FINDING (P2) — a profile takes over only the fields it actually
   * SUPPLIES (`authProfileOwnedCredentials`, models/config.ts). Each fixture is
   * built so the wrong implementation — overwriting all three unconditionally —
   * VISIBLY differs: the server carries a usable value in exactly the slot the
   * profile leaves empty.
   */
  it("keeps a synced server's own username when the profile's is whitespace-only (kills substituting profile.username wholesale: the inventory source stored that username as the fallback for precisely this profile, and the connection then ignored it and offered whitespace)", async () => {
    // Only an imported backup can produce this profile: validateAuthProfile
    // checks length, not content, while the profile editor trims and refuses
    // blanks.
    const profile: AuthProfile = { id: "prof-blank", name: "Imported", username: "   ", authType: "password" };
    // What a NetBox sync writes for a source linked to that profile:
    // fallbackUsernameForSource stored the submitted default username, and the
    // sync stamped the link (see syncEngine.ts).
    const server: ServerConfig = {
      ...baseServer,
      username: "labuser",
      authType: "agent",
      authProfileId: "prof-blank"
    };
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const vault = createVault({ [authProfilePasswordSecretKey("prof-blank")]: "profile-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, (id) =>
      id === "prof-blank" ? profile : undefined
    );

    await factory.connect(server);

    expect(connector.connect).toHaveBeenCalledWith(
      // The auth type IS supplied, so it still comes from the profile — that is
      // the whole point of the link on a synced server.
      expect.objectContaining({ username: "labuser", authType: "password" }),
      expect.objectContaining({ password: "profile-secret" })
    );
    expect(prompt.prompt).not.toHaveBeenCalled();
  });

  it("keeps the server's own key path when a key profile carries none (kills blanking keyPath from a profile that has nothing to put there — the server form leaves that control editable for exactly this profile)", async () => {
    const profile: AuthProfile = { id: "prof-keyless", name: "Shared Key", username: "keyuser", authType: "key" };
    const server: ServerConfig = {
      ...baseServer,
      username: "stored-user",
      authType: "password",
      keyPath: "/home/me/.ssh/chosen",
      authProfileId: "prof-keyless"
    };
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const vault = createVault({});
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, (id) =>
      id === "prof-keyless" ? profile : undefined
    );

    await factory.connect(server);

    expect(connector.connect).toHaveBeenCalledWith(
      expect.objectContaining({ username: "keyuser", authType: "key", keyPath: "/home/me/.ssh/chosen" }),
      expect.anything()
    );
  });

  it("trims the credentials it does take over, so what a form displayed is what the connection uses", async () => {
    const profile: AuthProfile = { id: "prof-pad", name: "Padded", username: "  bob  ", authType: "password" };
    const server: ServerConfig = { ...baseServer, username: "stored-user", authProfileId: "prof-pad" };
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const vault = createVault({ [authProfilePasswordSecretKey("prof-pad")]: "profile-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, (id) =>
      id === "prof-pad" ? profile : undefined
    );

    await factory.connect(server);

    expect(connector.connect).toHaveBeenCalledWith(
      expect.objectContaining({ username: "bob" }),
      expect.anything()
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

describe("SilentAuthSshFactory profile-scoped credential preservation", () => {
  // Every server linked to an auth profile shares ONE vault key
  // (auth-profile-password-{id} / auth-profile-passphrase-{id}). A device that
  // rejects the saved credential must not erase it for the rest of the fleet:
  // the credential is only replaced when a device actually authenticates.
  const profile: AuthProfile = {
    id: "prof-fleet",
    name: "Fleet",
    username: "root",
    authType: "password"
  };
  const lookup = (id: string) => (id === "prof-fleet" ? profile : undefined);

  function profileServer(id: string, name: string): ServerConfig {
    return { ...baseServer, id, name, authProfileId: "prof-fleet" };
  }

  it("keeps the profile password when another profile-linked server fails authentication", async () => {
    const serverB = profileServer("srv-b", "Misconfigured");
    const profileKey = authProfilePasswordSecretKey("prof-fleet");
    // Device B rejects the saved password and then rejects the prompted retry
    // too — it never authenticates (the reported misconfigured-device case).
    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
    };
    const vault = createVault({ [profileKey]: "saved-pass" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "typed-on-b", save: true }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

    await expect(factory.connect(serverB)).rejects.toThrow();

    // B's failure must leave the profile credential intact...
    await expect(vault.get(profileKey)).resolves.toBe("saved-pass");
    expect(vault.delete).not.toHaveBeenCalledWith(profileKey);

    // ...so device A still authenticates silently with it.
    const serverA = profileServer("srv-a", "Working");
    await factory.connect(serverA);
    expect(prompt.prompt).toHaveBeenCalledOnce(); // only for B's attempt
    expect(connector.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "srv-a" }),
      expect.objectContaining({ password: "saved-pass" })
    );
  });

  it("keeps the profile passphrase when a profile-linked server rejects it", async () => {
    const keyProfile: AuthProfile = {
      id: "prof-key-fleet",
      name: "Key Fleet",
      username: "root",
      authType: "key",
      keyPath: "/keys/id_ed25519"
    };
    const keyLookup = (id: string) => (id === "prof-key-fleet" ? keyProfile : undefined);
    const serverB: ServerConfig = {
      ...baseServer,
      id: "srv-key-b",
      name: "Key B",
      authProfileId: "prof-key-fleet"
    };
    const profilePassKey = authProfilePassphraseSecretKey("prof-key-fleet");

    // Rejects only device B's saved-passphrase attempt; device A (same
    // profile passphrase) authenticates with it.
    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("Encrypted private key requires passphrase"))
        .mockResolvedValue(fakeConnection)
    };
    const vault = createVault({ [profilePassKey]: "shared-passphrase" });
    // The user cancels the passphrase prompt for B — B never authenticates.
    const prompt: PasswordPrompt = { prompt: vi.fn(async () => undefined) };
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, keyLookup);

    await expect(factory.connect(serverB)).rejects.toThrow("Passphrase entry canceled");

    await expect(vault.get(profilePassKey)).resolves.toBe("shared-passphrase");
    expect(vault.delete).not.toHaveBeenCalledWith(profilePassKey);

    const serverA: ServerConfig = {
      ...baseServer,
      id: "srv-key-a",
      name: "Key A",
      authProfileId: "prof-key-fleet"
    };
    await factory.connect(serverA);
    expect(connector.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "srv-key-a" }),
      expect.objectContaining({ passphrase: "shared-passphrase" })
    );
  });

  it("keeps the profile password when a linked server authenticates but save is declined", async () => {
    const serverB = profileServer("srv-b2", "New Device");
    const profileKey = authProfilePasswordSecretKey("prof-fleet");
    // A stale-but-still-valid profile password is rejected by B; the user
    // types B's working password and answers No to saving it.
    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [profileKey]: "stale-pass" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "good-pass", save: false }))
    };
    const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

    await factory.connect(serverB);

    // Declining to save must not wipe the profile-wide credential...
    await expect(vault.get(profileKey)).resolves.toBe("stale-pass");
    expect(vault.delete).not.toHaveBeenCalledWith(profileKey);

    // ...and device A still authenticates with the password the profile holds.
    const serverA = profileServer("srv-a2", "Existing");
    await factory.connect(serverA);
    expect(connector.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "srv-a2" }),
      expect.objectContaining({ password: "stale-pass" })
    );
  });

  it("updates the profile password when a linked server authenticates with save accepted", async () => {
    const serverB = profileServer("srv-b3", "Rotated");
    const serverA = profileServer("srv-a3", "Fleet Member");
    const profileKey = authProfilePasswordSecretKey("prof-fleet");
    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [profileKey]: "old-pass" });
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "rotated-pass", save: true }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      lookup,
      (id) => id === serverB.id ? serverB : id === serverA.id ? serverA : undefined
    );

    await factory.connect(serverB);

    expect(vault.store).toHaveBeenCalledWith(profileKey, "rotated-pass");
    await expect(vault.get(profileKey)).resolves.toBe("rotated-pass");

    // The rest of the fleet picks up the updated credential.
    await factory.connect(serverA);
    expect(connector.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "srv-a3" }),
      expect.objectContaining({ password: "rotated-pass" })
    );
  });
});

describe("SilentAuthSshFactory onAuthMessage (MFA banner surfacing)", () => {
  it("keyboard-interactive handler emits name then instructions via onAuthMessage before prompting", async () => {
    let handler: KeyboardInteractiveHandler | undefined;
    const connector: SshConnector = {
      connect: vi.fn(async (_server, auth) => {
        handler = auth.onKeyboardInteractive;
        return fakeConnection;
      })
    };
    // authType "agent" hits the single-attempt connect branch — no
    // password/passphrase prompting to route around, keeping this test
    // focused purely on the keyboard-interactive handler's message ordering.
    const server: ServerConfig = { ...baseServer, authType: "agent" };
    const vault = createVault();
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const inputPromptFn = vi.fn(async () => "123456");
    const onAuthMessage = vi.fn();
    const factory = new SilentAuthSshFactory(connector, vault, prompt, inputPromptFn);

    await factory.connect(server, { onAuthMessage });

    expect(handler).toBeDefined();
    const responses = await handler!(
      "Duo two-factor login",
      "Enter a passcode or select one of the following options:\n1. Duo Push\n2. Phone call",
      [{ prompt: "Passcode or option (1-2): ", echo: true }]
    );

    expect(onAuthMessage).toHaveBeenNthCalledWith(1, "Duo two-factor login");
    expect(onAuthMessage).toHaveBeenNthCalledWith(
      2,
      "Enter a passcode or select one of the following options:\n1. Duo Push\n2. Phone call"
    );
    // Both auth messages must fire before the user is prompted.
    expect(Math.max(...onAuthMessage.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...inputPromptFn.mock.invocationCallOrder)
    );
    expect(responses).toEqual(["123456"]);
  });

  it("does not emit blank (whitespace-only) name/instructions", async () => {
    let handler: KeyboardInteractiveHandler | undefined;
    const connector: SshConnector = {
      connect: vi.fn(async (_server, auth) => {
        handler = auth.onKeyboardInteractive;
        return fakeConnection;
      })
    };
    const server: ServerConfig = { ...baseServer, authType: "agent" };
    const vault = createVault();
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const inputPromptFn = vi.fn(async () => "answer");
    const onAuthMessage = vi.fn();
    const factory = new SilentAuthSshFactory(connector, vault, prompt, inputPromptFn);

    await factory.connect(server, { onAuthMessage });
    await handler!("   ", "\n\t ", [{ prompt: "Password: ", echo: false }]);

    expect(onAuthMessage).not.toHaveBeenCalled();
  });

  it("password autofill for /password/i prompts still works when onAuthMessage is provided", async () => {
    let handler: KeyboardInteractiveHandler | undefined;
    const connector: SshConnector = {
      connect: vi.fn(async (_server, auth) => {
        handler = auth.onKeyboardInteractive;
        return fakeConnection;
      })
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "saved-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const inputPromptFn = vi.fn(async () => "should-not-be-used");
    const onAuthMessage = vi.fn();
    const factory = new SilentAuthSshFactory(connector, vault, prompt, inputPromptFn);

    await factory.connect(baseServer, { onAuthMessage });
    const responses = await handler!("", "", [{ prompt: "Password: ", echo: false }]);

    expect(responses).toEqual(["saved-secret"]);
    expect(inputPromptFn).not.toHaveBeenCalled();
    expect(onAuthMessage).not.toHaveBeenCalled();
  });

  it("forwards onAuthMessage to connector.connect's auth object", async () => {
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "saved-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const onAuthMessage = vi.fn();
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    await factory.connect(baseServer, { onAuthMessage });

    expect(connector.connect).toHaveBeenCalledWith(baseServer, expect.objectContaining({ onAuthMessage }));
  });

  it("does not add an onAuthMessage key to connector.connect's auth object when none is provided (no regression)", async () => {
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "saved-secret" });
    const prompt: PasswordPrompt = { prompt: vi.fn() };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);

    await factory.connect(baseServer);

    expect(connector.connect).toHaveBeenCalledWith(baseServer, { password: "saved-secret" });
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

describe("SilentAuthSshFactory vault-failure isolation (Stage B)", () => {
  // Each test drives a flow where the saved-credential first attempt returns an
  // auth error so the prompted-retry path (Stage A + Stage B) actually fires.
  // Stage A must succeed and Stage B's vault op must throw — the connection
  // must still be returned and the sock must NOT be destroyed.

  // Case 1: password + save=true, vault.store throws.
  it("password + save: vault.store throws after connect — connection returned, sock not destroyed", async () => {
    const secondSock = makeMockStream();
    const socks = [makeMockStream(), secondSock]; // first=bad-pw attempt, second=prompted
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "bad-pw" });
    // Override store to throw after connect succeeds
    (vault.store as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("vault locked"));

    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "prompted-pw", save: true }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => id === baseServer.id ? baseServer : undefined
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const connection = await factory.connect(baseServer, { sockFactory });

      expect(connection).toBe(fakeConnection);
      expect(secondSock.destroy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledOnce();
      const [msg] = consoleSpy.mock.calls[0] as [string, ...unknown[]];
      expect(msg).toContain(baseServer.name);
      expect(msg).toContain("password");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // Case 2: password + save=false, vault.delete throws.
  it("password + no-save: vault.delete throws after connect — connection returned, sock not destroyed", async () => {
    const secondSock = makeMockStream();
    const socks = [makeMockStream(), secondSock];
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [passwordSecretKey(baseServer.id)]: "bad-pw" });
    // delete is called first to clear bad-pw (on auth error), then again in Stage B (save=false).
    // We want the Stage B delete (second call) to throw.
    (vault.delete as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)    // first call: clear bad-pw after auth error
      .mockRejectedValueOnce(new Error("vault locked")); // second call: Stage B

    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "prompted-pw", save: false }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => id === baseServer.id ? baseServer : undefined
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const connection = await factory.connect(baseServer, { sockFactory });

      expect(connection).toBe(fakeConnection);
      expect(secondSock.destroy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledOnce();
      const [msg] = consoleSpy.mock.calls[0] as [string, ...unknown[]];
      expect(msg).toContain(baseServer.name);
      expect(msg).toContain("password");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // Case 3: key + save=true, primary vault.store(passphraseKey) throws.
  it("key + save: primary vault.store(passphraseKey) throws after connect — connection returned, sock not destroyed", async () => {
    const keyServer: ServerConfig = { ...baseServer, authType: "key", keyPath: "/home/user/.ssh/id_rsa" };
    const secondSock = makeMockStream();
    const socks = [makeMockStream(), secondSock];
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("Encrypted private key requires passphrase"))
        .mockResolvedValueOnce(fakeConnection)
    };
    // Saved (wrong) passphrase triggers the first failure.
    const vault = createVault({ [passphraseSecretKey(keyServer.id)]: "wrong-passphrase" });
    // vault.delete is called first to clear wrong passphrase, then vault.store throws in Stage B.
    (vault.store as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("vault locked"));

    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "correct-passphrase", save: true }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => id === keyServer.id ? keyServer : undefined
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const connection = await factory.connect(keyServer, { sockFactory });

      expect(connection).toBe(fakeConnection);
      expect(secondSock.destroy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledOnce();
      const [msg] = consoleSpy.mock.calls[0] as [string, ...unknown[]];
      expect(msg).toContain(keyServer.name);
      expect(msg).toContain("passphrase");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // Case 4: key + save=true, primary vault.store succeeds but legacy
  // vault.delete(legacyServerPassphraseKey) throws.
  // Uses an auth profile so legacyServerPassphraseKey !== passphraseKey.
  it("key + save: primary vault.store succeeds, legacy vault.delete throws — connection returned, sock not destroyed", async () => {
    const profile: AuthProfile = {
      id: "prof-key-2",
      name: "Shared Key 2",
      username: "root",
      authType: "key",
      keyPath: "/keys/id_ed25519"
    };
    const serverWithProfile: ServerConfig = {
      ...baseServer,
      authProfileId: "prof-key-2"
    };
    // passphraseKey = authProfilePassphraseSecretKey(profile.id)
    // legacyServerPassphraseKey = passphraseSecretKey(server.id)  ← different
    const profilePassKey = authProfilePassphraseSecretKey("prof-key-2");
    const legacyKey = passphraseSecretKey(serverWithProfile.id);

    const secondSock = makeMockStream();
    const socks = [makeMockStream(), secondSock];
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("Encrypted private key requires passphrase"))
        .mockResolvedValueOnce(fakeConnection)
    };
    // Seed the vault with an old profile passphrase (wrong) so the first attempt fails.
    const vault = createVault({ [profilePassKey]: "old-passphrase" });
    // A profile-scoped passphrase survives a rejection (the auth-error path
    // no longer deletes it), so the ONLY vault.delete in this flow is the
    // Stage B legacy cleanup — which is the one that throws.
    (vault.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("vault locked"));

    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "new-passphrase", save: true }))
    };
    const lookup = (id: string) => id === "prof-key-2" ? profile : undefined;
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      lookup,
      (id) => id === serverWithProfile.id ? serverWithProfile : undefined
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const connection = await factory.connect(serverWithProfile, { sockFactory });

      expect(connection).toBe(fakeConnection);
      expect(secondSock.destroy).not.toHaveBeenCalled();
      // The legacy delete threw — console.error should have fired once.
      expect(consoleSpy).toHaveBeenCalledOnce();
      const [msg] = consoleSpy.mock.calls[0] as [string, ...unknown[]];
      expect(msg).toContain(serverWithProfile.name);
      expect(msg).toContain("passphrase");
      // Primary store should have been called with the profile key.
      expect(vault.store).toHaveBeenCalledWith(profilePassKey, "new-passphrase");
      // Legacy key involved.
      expect(legacyKey).not.toBe(profilePassKey);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // Case 5: key + save=false, vault.delete(passphraseKey) throws in Stage B.
  it("key + no-save: vault.delete throws after connect — connection returned, sock not destroyed", async () => {
    const keyServer: ServerConfig = { ...baseServer, authType: "key", keyPath: "/home/user/.ssh/id_rsa" };
    const secondSock = makeMockStream();
    const socks = [makeMockStream(), secondSock];
    const sockFactory = vi.fn(async () => socks.shift() as any);

    const connector: SshConnector = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("Encrypted private key requires passphrase"))
        .mockResolvedValueOnce(fakeConnection)
    };
    const vault = createVault({ [passphraseSecretKey(keyServer.id)]: "wrong-passphrase" });
    // vault.delete is called first to clear wrong passphrase (on passphrase error),
    // then again in Stage B (save=false). We want Stage B delete to throw.
    (vault.delete as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)    // first call: clear wrong passphrase
      .mockRejectedValueOnce(new Error("vault locked")); // Stage B

    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "correct-passphrase", save: false }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => id === keyServer.id ? keyServer : undefined
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const connection = await factory.connect(keyServer, { sockFactory });

      expect(connection).toBe(fakeConnection);
      expect(secondSock.destroy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledOnce();
      const [msg] = consoleSpy.mock.calls[0] as [string, ...unknown[]];
      expect(msg).toContain(keyServer.name);
      expect(msg).toContain("passphrase");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("SilentAuthSshFactory secret writes racing with Replace", () => {
  it("does not save a password after the same server id is re-added with identical values", async () => {
    const target: ServerConfig = { ...baseServer };
    const liveServers = new Map<string, ServerConfig>([[target.id, target]]);
    const handshake = deferred<SshConnection>();
    const handshakeStarted = deferred<void>();
    const passwordKey = passwordSecretKey(target.id);
    const vault = createVault();
    const connector: SshConnector = {
      connect: vi.fn(() => {
        handshakeStarted.resolve();
        return handshake.promise;
      })
    };
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "password-from-removed-record", save: true }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => liveServers.get(id)
    );

    const connecting = factory.connect(target);
    await handshakeStarted.promise;
    await configMutationLock.runExclusive(async () => {
      await vault.delete(passwordKey);
      liveServers.set(target.id, { ...target });
    });
    handshake.resolve(fakeConnection);
    await expect(connecting).resolves.toBe(fakeConnection);

    expect(await vault.get(passwordKey)).toBeUndefined();
    expect(vault.store).not.toHaveBeenCalledWith(passwordKey, "password-from-removed-record");
  });

  it("saves a direct prompted password for a copied config while its live record is unchanged", async () => {
    const liveTarget: ServerConfig = { ...baseServer };
    const callerCopy: ServerConfig = { ...liveTarget };
    const liveServers = new Map<string, ServerConfig>([[liveTarget.id, liveTarget]]);
    const passwordKey = passwordSecretKey(liveTarget.id);
    const vault = createVault();
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "current-record-password", save: true }))
    };
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => liveServers.get(id)
    );

    await factory.connect(callerCopy);

    expect(vault.store).toHaveBeenCalledWith(passwordKey, "current-record-password");
  });

  it("keeps the primary credential record when an alternate-host clone authenticates", async () => {
    const target: ServerConfig = {
      ...baseServer,
      host: "primary.example.com",
      altHost: "10.0.0.2"
    };
    const liveServers = new Map<string, ServerConfig>([[target.id, target]]);
    const vault = createVault();
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "alternate-host-password", save: true }))
    };
    const connector: SshConnector = {
      connect: vi.fn(async () => fakeConnection)
    };
    const authFactory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      undefined,
      (id) => liveServers.get(id)
    );
    const proxyFactory = new ProxySshFactory(authFactory, (id) => liveServers.get(id), vault);

    await proxyFactory.connectWithContext(
      { ...target, host: target.altHost! },
      { credentialSource: target }
    );

    expect(connector.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "10.0.0.2" }),
      expect.objectContaining({ password: "alternate-host-password" })
    );
    expect(vault.store).toHaveBeenCalledWith(passwordSecretKey(target.id), "alternate-host-password");
  });

  it("does not save a profile password after Replace moves its SSH jump route", async () => {
    const profile: AuthProfile = {
      id: "profile-pw",
      name: "Shared password",
      username: "root",
      authType: "password"
    };
    const target: ServerConfig = {
      ...baseServer,
      authProfileId: profile.id,
      proxy: { type: "ssh", jumpHostId: "jump-1" }
    };
    const jump: ServerConfig = {
      ...baseServer,
      id: "jump-1",
      name: "Old jump",
      host: "old-jump.internal"
    };
    const liveServers = new Map<string, ServerConfig>([[target.id, target], [jump.id, jump]]);
    const passwordKey = authProfilePasswordSecretKey(profile.id);
    const jumpConnectionPending = deferred<SshConnection>();
    const jumpConnectStarted = deferred<void>();
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const vault = createVault();
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "old-route-password", save: true }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      (id) => id === profile.id ? profile : undefined,
      (id) => liveServers.get(id)
    );
    const proxyFactory = new ProxySshFactory(factory, (id) => liveServers.get(id), vault);
    const jumpFactory = {
      connectWithContext: vi.fn(() => {
        jumpConnectStarted.resolve();
        return jumpConnectionPending.promise;
      })
    } as unknown as ContextAwareSshFactory;
    proxyFactory.setJumpHostConnectionFactory(jumpFactory);

    const connecting = proxyFactory.connect(target);
    await jumpConnectStarted.promise;

    await configMutationLock.runExclusive(async () => {
      await vault.delete(passwordKey);
      liveServers.set(target.id, { ...target });
      liveServers.set(jump.id, { ...jump, host: "new-jump.internal" });
    });

    const routedSocket = { pause: vi.fn(), destroy: vi.fn() };
    const openDirectTcp = vi.fn(async () => routedSocket as any);
    jumpConnectionPending.resolve({
      ...fakeConnection,
      openDirectTcp
    });
    await expect(connecting).rejects.toThrow("configuration changed while connecting");

    expect(await vault.get(passwordKey)).toBeUndefined();
    expect(openDirectTcp).not.toHaveBeenCalled();
    expect(connector.connect).not.toHaveBeenCalled();
    expect(vault.store).not.toHaveBeenCalledWith(passwordKey, "old-route-password");
  });

  it("does not save a profile passphrase after Replace changes the key file", async () => {
    const profile: AuthProfile = {
      id: "profile-key",
      name: "Rotated key",
      username: "root",
      authType: "key",
      keyPath: "/keys/old-id_ed25519"
    };
    const target: ServerConfig = { ...baseServer, authProfileId: profile.id };
    let liveProfile = profile;
    const passphraseKey = authProfilePassphraseSecretKey(profile.id);
    const handshake = deferred<SshConnection>();
    const handshakeStarted = deferred<void>();
    let attempts = 0;
    const connector: SshConnector = {
      connect: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Encrypted private key requires passphrase");
        }
        handshakeStarted.resolve();
        return handshake.promise;
      })
    };
    const vault = createVault();
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async () => ({ password: "old-key-passphrase", save: true }))
    };
    const factory = new SilentAuthSshFactory(
      connector,
      vault,
      prompt,
      undefined,
      (id) => id === profile.id ? liveProfile : undefined,
      (id) => id === target.id ? target : undefined
    );

    const connecting = factory.connect(target);
    await handshakeStarted.promise;

    await configMutationLock.runExclusive(async () => {
      await vault.delete(passphraseKey);
      liveProfile = { ...profile, keyPath: "/keys/new-id_ed25519" };
    });
    handshake.resolve(fakeConnection);
    await expect(connecting).resolves.toBe(fakeConnection);

    expect(await vault.get(passphraseKey)).toBeUndefined();
    expect(vault.store).not.toHaveBeenCalledWith(passphraseKey, "old-key-passphrase");
  });
});

describe("deleteServerSecrets", () => {
  function vaultFailingOn(failingKey: string) {
    const attempted: string[] = [];
    const vault: SecretVault = {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
      delete: vi.fn(async (key: string) => {
        attempted.push(key);
        if (key === failingKey) throw new Error("keychain locked");
      })
    };
    return { vault, attempted };
  }

  it("deletes the server's password, passphrase and proxy password — every key saved under its id", async () => {
    const { vault, attempted } = vaultFailingOn("none");
    await deleteServerSecrets(vault, "srv-1");
    // ⊘ a list missing a key strands that secret on every delete path.
    expect(attempted).toEqual([passwordSecretKey("srv-1"), passphraseSecretKey("srv-1"), proxyPasswordSecretKey("srv-1")]);
  });

  it("rejects on the first failure by default, so a caller that still holds the record can stop", async () => {
    const { vault, attempted } = vaultFailingOn(passphraseSecretKey("srv-1"));
    // ⊘ swallowing by default: nexus.server.remove would delete the record anyway.
    await expect(deleteServerSecrets(vault, "srv-1")).rejects.toThrow("keychain locked");
    expect(attempted).toEqual([passwordSecretKey("srv-1"), passphraseSecretKey("srv-1")]);
  });

  it("with bestEffort, still attempts the remaining keys after one fails, and resolves", async () => {
    const { vault, attempted } = vaultFailingOn(passphraseSecretKey("srv-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // ⊘ stopping at the failure strands the proxy password behind it.
    await expect(deleteServerSecrets(vault, "srv-1", { bestEffort: true })).resolves.toBeUndefined();
    expect(attempted).toEqual([passwordSecretKey("srv-1"), passphraseSecretKey("srv-1"), proxyPasswordSecretKey("srv-1")]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
// Issue #177 — with nothing saved, concurrent logins that need the same
// password (or key passphrase) each opened their own prompt. VS Code shows one
// input box at a time, so the later prompt dismissed the earlier one, which
// then read as a cancel and failed that login — most visibly with isolated
// tunnels, where every client logs in on its own. The answer is now shared by
// the logins that would save it under the same key, for the same endpoint (a
// password) or key file (a passphrase), until one login that used it settles.
describe("SilentAuthSshFactory — concurrent logins share one prompt (issue #177)", () => {
  type Answer = { password: string; save: boolean } | undefined;

  /** A prompt that stays open until the test answers it. */
  function openPrompt(): { prompt: PasswordPrompt; answer: (value: Answer) => void } {
    const pending: Array<(value: Answer) => void> = [];
    return {
      prompt: { prompt: vi.fn(() => new Promise<Answer>((resolve) => pending.push(resolve))) },
      answer: (value) => {
        for (const resolve of pending.splice(0)) {
          resolve(value);
        }
      }
    };
  }

  /** Lets every login run up to its vault read and prompt before anything is answered. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  const sentPasswords = (connector: SshConnector) =>
    (connector.connect as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[1] as { password?: string }).password);

  describe("server password", () => {
    it("keeps a freshly saved password when an older saved-password attempt fails later", async () => {
      const key = passwordSecretKey(baseServer.id);
      const staleAttempt = gate();
      let savedAttempts = 0;
      const connector: SshConnector = {
        connect: vi.fn(async (_server, auth) => {
          if (auth.password === "old") {
            savedAttempts += 1;
            if (savedAttempts === 1) await staleAttempt.promise;
            throw new Error("All configured authentication methods failed");
          }
          return fakeConnection;
        })
      };
      const vault = createVault({ [key]: "old" });
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ password: "new", save: true })
          .mockResolvedValueOnce(undefined)
      };
      const factory = new SilentAuthSshFactory(
        connector, vault, prompt, undefined, undefined,
        (id) => id === baseServer.id ? baseServer : undefined
      );

      const slow = factory.connect(baseServer);
      await vi.waitFor(() => expect(savedAttempts).toBe(1));
      await factory.connect(baseServer);
      expect(await vault.get(key)).toBe("new");

      staleAttempt.open();
      await expect(slow).rejects.toThrow("Password entry canceled");
      expect(await vault.get(key)).toBe("new");
    });

    it("does not save a prompt answer after sync removes and recreates its deterministic server id", async () => {
      const serverId = deterministicServerId("source-id", "external-device-id");
      const oldServer: ServerConfig = { ...baseServer, id: serverId };
      const live = { current: oldServer as ServerConfig | undefined };
      const handshakeStarted = gate();
      const handshake = gate();
      const connector: SshConnector = {
        connect: vi.fn(async () => {
          handshakeStarted.open();
          await handshake.promise;
          return fakeConnection;
        })
      };
      const vault = createVault();
      const prompt: PasswordPrompt = { prompt: vi.fn(async () => ({ password: "old-record-password", save: true })) };
      // The live lookup is the record-provenance hook added by the overlapping
      // #201 fix. Keep this regression runnable on #214's pre-merge constructor;
      // once #201 lands, this passes through the real constructor argument.
      const FactoryWithLiveLookup = SilentAuthSshFactory as unknown as new (
        connector: SshConnector,
        vault: SecretVault,
        prompt: PasswordPrompt,
        inputPromptFn: undefined,
        authProfileLookup: undefined,
        liveServerLookup: (id: string) => ServerConfig | undefined
      ) => SilentAuthSshFactory;
      const factory = new FactoryWithLiveLookup(connector, vault, prompt, undefined, undefined, (id) =>
        id === serverId ? live.current : undefined
      );

      const connecting = factory.connect(oldServer);
      await handshakeStarted.promise;

      // Inventory sync retires the old row and its secret, then adds a fresh
      // object under the same deterministic id. Its config is intentionally
      // identical: only record provenance distinguishes the two incarnations.
      live.current = undefined;
      await deleteServerSecrets(vault, serverId);
      live.current = { ...oldServer };
      handshake.open();

      await expect(connecting).resolves.toBe(fakeConnection);
      expect(vault.store).not.toHaveBeenCalledWith(passwordSecretKey(serverId), "old-record-password");
      await expect(vault.get(passwordSecretKey(serverId))).resolves.toBeUndefined();
    });

    it("asks once when a second login arrives while the prompt is open, and both log in with the answer", async () => {
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const { prompt, answer } = openPrompt();
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      const first = factory.connect(baseServer);
      const second = factory.connect(baseServer);
      await settle();
      answer({ password: "pw", save: true });

      await expect(Promise.all([first, second])).resolves.toEqual([fakeConnection, fakeConnection]);
      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      expect(sentPasswords(connector)).toEqual(["pw", "pw"]);
    });

    it("reuses an answer whose login is still in flight and has not saved it yet", async () => {
      const login = gate();
      const connector: SshConnector = {
        connect: vi.fn(async () => {
          await login.promise;
          return fakeConnection;
        })
      };
      const vault = createVault();
      const prompt: PasswordPrompt = { prompt: vi.fn(async () => ({ password: "pw", save: true })) };
      const factory = new SilentAuthSshFactory(
        connector,
        vault,
        prompt,
        undefined,
        undefined,
        (id) => id === baseServer.id ? baseServer : undefined
      );

      const first = factory.connect(baseServer);
      await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1));
      const second = factory.connect(baseServer);
      await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(2));
      login.open();
      await Promise.all([first, second]);

      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      expect(sentPasswords(connector)).toEqual(["pw", "pw"]);
      expect(vault.store).toHaveBeenCalledWith(passwordSecretKey(baseServer.id), "pw");
    });

    it("still shares the answer while the login that used it is saving it", async () => {
      // Until the save completes the vault has nothing to offer a new login;
      // forgetting the answer before then would open a second prompt.
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const saving = gate();
      const store = vault.store;
      vault.store = vi.fn(async (key: string, value: string) => {
        await saving.promise;
        await store(key, value);
      });
      const prompt: PasswordPrompt = { prompt: vi.fn(async () => ({ password: "pw", save: true })) };
      const factory = new SilentAuthSshFactory(
        connector,
        vault,
        prompt,
        undefined,
        undefined,
        (id) => id === baseServer.id ? baseServer : undefined
      );

      const first = factory.connect(baseServer);
      await vi.waitFor(() => expect(vault.store).toHaveBeenCalledTimes(1));
      const second = factory.connect(baseServer);
      await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(2));
      saving.open();
      await Promise.all([first, second]);

      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      expect(sentPasswords(connector)).toEqual(["pw", "pw"]);
    });

    it("cancels every login waiting on a prompt the user cancelled, then asks again at the next login", async () => {
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const { prompt, answer } = openPrompt();
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      const first = factory.connect(baseServer);
      const second = factory.connect(baseServer);
      await settle();
      answer(undefined);
      const firstFailure = await first.catch((error: unknown) => error);
      const secondFailure = await second.catch((error: unknown) => error);
      expect(firstFailure).toBeInstanceOf(Error);
      expect((firstFailure as Error).message).toContain("Password entry canceled");
      expect(secondFailure).toBe(firstFailure);
      expect(prompt.prompt).toHaveBeenCalledTimes(1);

      const third = factory.connect(baseServer);
      await settle();
      answer({ password: "pw", save: false });
      await expect(third).resolves.toBe(fakeConnection);
      expect(prompt.prompt).toHaveBeenCalledTimes(2);
    });

    it("fails every login waiting on a prompt that itself fails, then asks again at the next login", async () => {
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      let failPrompt!: (error: Error) => void;
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockImplementationOnce(() => new Promise<Answer>((_resolve, reject) => {
            failPrompt = reject;
          }))
          .mockResolvedValueOnce({ password: "pw", save: false })
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      const first = factory.connect(baseServer);
      const second = factory.connect(baseServer);
      await settle();
      failPrompt(new Error("input box failed"));
      await expect(first).rejects.toThrow("input box failed");
      await expect(second).rejects.toThrow("input box failed");
      expect(prompt.prompt).toHaveBeenCalledTimes(1);

      await expect(factory.connect(baseServer)).resolves.toBe(fakeConnection);
      expect(prompt.prompt).toHaveBeenCalledTimes(2);
    });

    it("asks again after a login that used the answer fails, and never saves the rejected password", async () => {
      // The answer may be what failed; the next login must not inherit it.
      const connector: SshConnector = {
        connect: vi.fn()
          .mockRejectedValueOnce(new Error("All configured authentication methods failed"))
          .mockResolvedValue(fakeConnection)
      };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ password: "wrong", save: true })
          .mockResolvedValueOnce({ password: "pw", save: true })
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      await expect(factory.connect(baseServer)).rejects.toThrow("authentication methods failed");
      await factory.connect(baseServer);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual(["wrong", "pw"]);
      expect(vault.store).not.toHaveBeenCalledWith(passwordSecretKey(baseServer.id), "wrong");
    });

    it("asks again at the next login for a password the user chose not to save", async () => {
      // Declining to save means nothing outlives the logins it was typed for —
      // not the vault, and not an answer kept in memory.
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ password: "first", save: false })
          .mockResolvedValueOnce({ password: "second", save: false })
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      await factory.connect(baseServer);
      await factory.connect(baseServer);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual(["first", "second"]);
    });

    it("asks again once the saved password is gone, rather than reviving an answer already saved", async () => {
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ password: "old", save: true })
          .mockResolvedValueOnce({ password: "new", save: true })
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      await factory.connect(baseServer);
      await vault.delete(passwordSecretKey(baseServer.id));
      await factory.connect(baseServer);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual(["old", "new"]);
    });

    // A password is only ever sent to the endpoint it was typed for. An edit or
    // an inventory sync can repoint a server while its prompt is open.
    it.each([
      ["host", { host: "other.example.com" }],
      ["port", { port: 2222 }],
      ["username", { username: "admin" }]
    ] as const)("never gives an answer to a login whose %s has changed since it was asked for", async (_field, change) => {
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn(async (server: ServerConfig) => ({
          password: `pw-for-${server.username}@${server.host}:${server.port}`,
          save: false
        }))
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);
      const repointed: ServerConfig = { ...baseServer, ...change };

      await Promise.all([factory.connect(baseServer), factory.connect(repointed)]);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual([
        "pw-for-root@example.com:22",
        `pw-for-${repointed.username}@${repointed.host}:${repointed.port}`
      ]);
    });

    // The caller resolves the route (ProxySshFactory: see the "resolved route"
    // tests below); this factory only compares it.
    it("shares an answer only between logins on the same route", async () => {
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ password: "pw-route-a", save: false })
          .mockResolvedValueOnce({ password: "pw-route-b", save: false })
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);
      const viaBastion: ServerConfig = { ...baseServer, proxy: { type: "ssh", jumpHostId: "bastion-1" } };

      await Promise.all([
        factory.connect(viaBastion, { route: () => "route-a" }),
        factory.connect({ ...viaBastion }, { route: () => "route-a" }),
        factory.connect({ ...viaBastion }, { route: () => "route-b" })
      ]);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual(["pw-route-a", "pw-route-a", "pw-route-b"]);
    });

    it("never shares an answer for a login through a proxy whose route the caller did not resolve", async () => {
      // Its jump host's address is unknown here, so there is nothing to compare.
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const { prompt, answer } = openPrompt();
      const factory = new SilentAuthSshFactory(connector, vault, prompt);
      const viaBastion = (): ServerConfig => ({ ...baseServer, proxy: { type: "ssh", jumpHostId: "bastion-1" } });

      const first = factory.connect(viaBastion());
      const second = factory.connect(viaBastion());
      await settle();
      answer({ password: "pw", save: false });
      await vi.waitFor(() => expect(prompt.prompt).toHaveBeenCalledTimes(2));
      answer({ password: "pw", save: false });
      await Promise.all([first, second]);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
    });

    it("never gives an answer to another server on the same auth profile unless it is the same endpoint", async () => {
      // A profile-scoped password is saved under one key for the whole fleet,
      // but a password typed for one device is not sent to another.
      const profile: AuthProfile = { id: "prof-fleet", name: "Fleet", username: "ops", authType: "password" };
      const lookup = (id: string) => (id === profile.id ? profile : undefined);
      const deviceA: ServerConfig = { ...baseServer, id: "srv-a", name: "A", host: "a.example.com", authProfileId: profile.id };
      const deviceB: ServerConfig = { ...baseServer, id: "srv-b", name: "B", host: "b.example.com", authProfileId: profile.id };
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn(async (server: ServerConfig) => ({ password: `pw-for-${server.host}`, save: false }))
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

      await Promise.all([factory.connect(deviceA), factory.connect(deviceB)]);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual(["pw-for-a.example.com", "pw-for-b.example.com"]);
    });

    it("does not share a profile password when only the alternate host differs", async () => {
      const profile: AuthProfile = { id: "prof-alt-host", name: "Fleet", username: "ops", authType: "password" };
      const lookup = (id: string) => id === profile.id ? profile : undefined;
      const deviceA: ServerConfig = {
        ...baseServer,
        id: "srv-alt-a",
        host: "primary.example.com",
        altHost: "alt-a.example.com",
        authProfileId: profile.id
      };
      const deviceB: ServerConfig = {
        ...baseServer,
        id: "srv-alt-b",
        host: "primary.example.com",
        altHost: "alt-b.example.com",
        authProfileId: profile.id
      };
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const answers = [deferred<Answer>(), deferred<Answer>()];
      let promptIndex = 0;
      const prompt: PasswordPrompt = { prompt: vi.fn(() => answers[promptIndex++].promise) };
      const liveServers = new Map([[deviceA.id, deviceA], [deviceB.id, deviceB]]);
      const factory = new SilentAuthSshFactory(
        connector,
        vault,
        prompt,
        undefined,
        lookup,
        (id) => liveServers.get(id)
      );

      const first = factory.connect(deviceA);
      await settle();
      const second = factory.connect(deviceB);
      await settle();
      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      answers[0].resolve({ password: "password-for-alt-a", save: false });
      await vi.waitFor(() => expect(prompt.prompt).toHaveBeenCalledTimes(2));
      answers[1].resolve({ password: "password-for-alt-b", save: false });
      await Promise.all([first, second]);

      expect(sentPasswords(connector)).toEqual(["password-for-alt-a", "password-for-alt-b"]);
    });

    it("still shares a password between profile-linked records with the same full endpoint", async () => {
      const profile: AuthProfile = { id: "prof-same-endpoint", name: "Fleet", username: "ops", authType: "password" };
      const lookup = (id: string) => id === profile.id ? profile : undefined;
      const deviceA: ServerConfig = {
        ...baseServer,
        id: "srv-same-a",
        host: "primary.example.com",
        altHost: "alt.example.com",
        authProfileId: profile.id
      };
      const deviceB: ServerConfig = { ...deviceA, id: "srv-same-b" };
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const { prompt, answer } = openPrompt();
      const liveServers = new Map([[deviceA.id, deviceA], [deviceB.id, deviceB]]);
      const factory = new SilentAuthSshFactory(
        connector,
        vault,
        prompt,
        undefined,
        lookup,
        (id) => liveServers.get(id)
      );

      const first = factory.connect(deviceA);
      await settle();
      const second = factory.connect(deviceB);
      await settle();
      answer({ password: "shared-profile-password", save: false });
      await Promise.all([first, second]);

      expect(prompt.prompt).toHaveBeenCalledOnce();
      expect(sentPasswords(connector)).toEqual(["shared-profile-password", "shared-profile-password"]);
    });

    it.each([
      { description: "changed alternate host", replacementAltHost: "alt-b.example.com" },
      { description: "identical values", replacementAltHost: "alt-a.example.com" }
    ])("does not let a same-ID record with $description inherit or persist the pending answer", async ({ replacementAltHost }) => {
      const original: ServerConfig = { ...baseServer, altHost: "alt-a.example.com" };
      const liveServers = new Map<string, ServerConfig>([[original.id, original]]);
      const passwordKey = passwordSecretKey(original.id);
      const answers = [deferred<Answer>(), deferred<Answer>()];
      let promptIndex = 0;
      const prompt: PasswordPrompt = { prompt: vi.fn(() => answers[promptIndex++].promise) };
      const vault = createVault();
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const factory = new SilentAuthSshFactory(
        connector,
        vault,
        prompt,
        undefined,
        undefined,
        (id) => liveServers.get(id)
      );

      const removedRecordLogin = factory.connect(original);
      const removedAttemptResultPromise = removedRecordLogin.then(() => "resolved", () => "rejected");
      await settle();
      const replacement: ServerConfig = { ...original, altHost: replacementAltHost };
      liveServers.set(replacement.id, replacement);
      const replacementLogin = factory.connect(replacement);
      await settle();
      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      answers[0].resolve({ password: "password-from-removed-record", save: true });
      await vi.waitFor(() => expect(prompt.prompt).toHaveBeenCalledTimes(2));
      answers[1].resolve({ password: "password-from-replacement", save: true });
      const removedAttemptResult = await removedAttemptResultPromise;
      await replacementLogin;

      expect(removedAttemptResult).toBe("rejected");
      expect(vault.store).not.toHaveBeenCalledWith(passwordKey, "password-from-removed-record");
      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual(["password-from-replacement"]);
      expect(vault.store).toHaveBeenCalledWith(passwordKey, "password-from-replacement");
    });

    it("does not share between two servers that name the same address through different jump hosts", async () => {
      // Lab devices commonly reuse management addresses: the same user@host:port
      // reached through another jump host is another machine.
      const labOne: ServerConfig = { ...baseServer, id: "srv-lab1-r1", name: "lab1-r1", proxy: { type: "ssh", jumpHostId: "bastion-1" } };
      const labTwo: ServerConfig = { ...baseServer, id: "srv-lab2-r1", name: "lab2-r1", proxy: { type: "ssh", jumpHostId: "bastion-2" } };
      const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn(async (server: ServerConfig) => ({ password: `pw-for-${server.name}`, save: false }))
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      await Promise.all([factory.connect(labOne), factory.connect(labTwo)]);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPasswords(connector)).toEqual(["pw-for-lab1-r1", "pw-for-lab2-r1"]);
    });
  });

  // A login can fail after the prompt without ever reaching the server: its
  // transport (a proxy or jump-host hop) fails to open. The answer was never
  // tried, but that login is over, and it must not leave the answer behind.
  it.each([
    { credential: "password", server: baseServer, failing: 1 },
    // The saved-passphrase attempt opens the first transport; the prompted retry opens the second.
    { credential: "passphrase", server: { ...baseServer, authType: "key" as const, keyPath: "/keys/id_ed25519" }, failing: 2 }
  ])("asks again for the $credential after a login whose transport failed once it was answered", async ({ server, failing }) => {
    const connector: SshConnector = {
      connect: vi.fn(async (_server: ServerConfig, auth: { passphrase?: string }) => {
        if (server.authType === "key" && !auth.passphrase) {
          throw new Error("Encrypted private OpenSSH key detected, but no passphrase given");
        }
        return fakeConnection;
      })
    };
    const vault = createVault();
    const prompt: PasswordPrompt = { prompt: vi.fn(async () => ({ password: "secret", save: false })) };
    const factory = new SilentAuthSshFactory(connector, vault, prompt);
    let opened = 0;
    const sockFactory = vi.fn(async () => {
      opened += 1;
      if (opened === failing) {
        throw new Error("proxy hop failed");
      }
      return makeMockStream() as never;
    });

    await expect(factory.connect(server, { sockFactory })).rejects.toThrow("proxy hop failed");
    await expect(factory.connect(server)).resolves.toBe(fakeConnection);

    expect(prompt.prompt).toHaveBeenCalledTimes(2);
  });

  describe("key passphrase", () => {
    /** An encrypted key: a login without a passphrase is refused the way ssh2 refuses it. */
    function encryptedKeyConnector(): SshConnector {
      return {
        connect: vi.fn(async (_server: ServerConfig, auth: { passphrase?: string }) => {
          if (!auth.passphrase) {
            throw new Error("Encrypted private OpenSSH key detected, but no passphrase given");
          }
          return fakeConnection;
        })
      };
    }
    const sentPassphrases = (connector: SshConnector) =>
      (connector.connect as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => (call[1] as { passphrase?: string }).passphrase)
        .filter((passphrase) => passphrase !== undefined);
    const keyServer: ServerConfig = { ...baseServer, authType: "key", keyPath: "/keys/id_ed25519" };

    it("keeps a freshly saved passphrase when an older saved-passphrase attempt fails later", async () => {
      const key = passphraseSecretKey(keyServer.id);
      const staleAttempt = gate();
      let savedAttempts = 0;
      const connector: SshConnector = {
        connect: vi.fn(async (_server, auth) => {
          if (auth.passphrase === "old") {
            savedAttempts += 1;
            if (savedAttempts === 1) await staleAttempt.promise;
            throw new Error("Cannot parse privateKey: bad decrypt");
          }
          return fakeConnection;
        })
      };
      const vault = createVault({ [key]: "old" });
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ password: "new", save: true })
          .mockResolvedValueOnce(undefined)
      };
      const factory = new SilentAuthSshFactory(
        connector, vault, prompt, undefined, undefined,
        (id) => id === keyServer.id ? keyServer : undefined
      );

      const slow = factory.connect(keyServer);
      await vi.waitFor(() => expect(savedAttempts).toBe(1));
      await factory.connect(keyServer);
      expect(await vault.get(key)).toBe("new");

      staleAttempt.open();
      await expect(slow).rejects.toThrow("Passphrase entry canceled");
      expect(await vault.get(key)).toBe("new");
    });

    it("asks once when concurrent logins need the passphrase, and both log in with it", async () => {
      const connector = encryptedKeyConnector();
      const vault = createVault();
      const { prompt, answer } = openPrompt();
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      const first = factory.connect(keyServer);
      const second = factory.connect(keyServer);
      await settle();
      answer({ password: "phrase", save: true });

      await expect(Promise.all([first, second])).resolves.toEqual([fakeConnection, fakeConnection]);
      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      expect(sentPassphrases(connector)).toEqual(["phrase", "phrase"]);
    });

    it("asks once for servers sharing a key auth profile, whose passphrase is saved under one key", async () => {
      const profile: AuthProfile = { id: "prof-key", name: "Fleet key", username: "ops", authType: "key", keyPath: "/keys/fleet" };
      const lookup = (id: string) => (id === profile.id ? profile : undefined);
      const deviceA: ServerConfig = { ...baseServer, id: "srv-a", name: "A", host: "a.example.com", authProfileId: profile.id };
      const deviceB: ServerConfig = { ...baseServer, id: "srv-b", name: "B", host: "b.example.com", authProfileId: profile.id };
      const connector = encryptedKeyConnector();
      const vault = createVault();
      const { prompt, answer } = openPrompt();
      const liveServers = new Map<string, ServerConfig>([[deviceA.id, deviceA], [deviceB.id, deviceB]]);
      const factory = new SilentAuthSshFactory(
        connector,
        vault,
        prompt,
        undefined,
        lookup,
        (id) => liveServers.get(id)
      );

      const first = factory.connect(deviceA);
      const second = factory.connect(deviceB);
      await settle();
      answer({ password: "fleet-phrase", save: true });
      await Promise.all([first, second]);

      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      expect(sentPassphrases(connector)).toEqual(["fleet-phrase", "fleet-phrase"]);
      expect(vault.store).toHaveBeenCalledWith(authProfilePassphraseSecretKey(profile.id), "fleet-phrase");
    });

    it("uses a current joiner when a queued profile passphrase owner's record is replaced", async () => {
      const profile: AuthProfile = { id: "prof-key", name: "Fleet key", username: "ops", authType: "key", keyPath: "/keys/fleet" };
      const deviceA: ServerConfig = { ...baseServer, id: "srv-a", name: "A", host: "a.example.com", authProfileId: profile.id };
      const deviceB: ServerConfig = { ...baseServer, id: "srv-b", name: "B", host: "b.example.com", authProfileId: profile.id };
      const blocker: ServerConfig = { ...baseServer, id: "blocker", name: "Blocker" };
      const liveServers = new Map<string, ServerConfig>([[deviceA.id, deviceA], [deviceB.id, deviceB], [blocker.id, blocker]]);
      const blockerAnswer = deferred<{ password: string; save: boolean } | undefined>();
      const opened: string[] = [];
      const prompt: PasswordPrompt = {
        prompt: vi.fn(async (server) => {
          opened.push(server.name);
          return server.id === blocker.id
            ? blockerAnswer.promise
            : { password: "fleet-phrase", save: true };
        })
      };
      const connector: SshConnector = {
        connect: vi.fn(async (server, auth) => {
          if (server.authType === "key" && !auth.passphrase) {
            throw new Error("Encrypted private OpenSSH key detected, but no passphrase given");
          }
          return fakeConnection;
        })
      };
      const vault = createVault();
      const factory = new SilentAuthSshFactory(
        connector, vault, prompt, undefined,
        (id) => id === profile.id ? profile : undefined,
        (id) => liveServers.get(id)
      );

      const first = factory.connect(blocker);
      await vi.waitFor(() => expect(opened).toEqual(["Blocker"]));
      const stale = factory.connect(deviceA);
      const staleFailure = expect(stale).rejects.toThrow("configuration changed while connecting");
      const fresh = factory.connect(deviceB);
      await settle();
      liveServers.set(deviceA.id, { ...deviceA });

      blockerAnswer.resolve({ password: "blocker-password", save: false });
      await first;
      await staleFailure;
      await fresh;
      expect(opened).toEqual(["Blocker", "B (key passphrase)"]);
      expect(vault.store).toHaveBeenCalledWith(authProfilePassphraseSecretKey(profile.id), "fleet-phrase");
    });

    it("does not let a profile-shared answer delete a replacement server passphrase", async () => {
      type Answer = { password: string; save: boolean } | undefined;
      const profile: AuthProfile = { id: "prof-key", name: "Fleet key", username: "ops", authType: "key", keyPath: "/keys/fleet" };
      const deviceA: ServerConfig = { ...baseServer, id: "srv-a", name: "A", host: "a.example.com", authProfileId: profile.id };
      const deviceB: ServerConfig = { ...baseServer, id: "srv-b", name: "B", host: "b.example.com", authProfileId: profile.id };
      const standaloneB: ServerConfig = {
        ...deviceB,
        authProfileId: undefined,
        authType: "key",
        keyPath: "/keys/replacement"
      };
      const liveServers = new Map<string, ServerConfig>([[deviceA.id, deviceA], [deviceB.id, deviceB]]);
      const connector = encryptedKeyConnector();
      const vault = createVault();
      const profileAnswer = deferred<Answer>();
      const replacementAnswer = deferred<Answer>();
      const prompt: PasswordPrompt = {
        prompt: vi.fn((server: ServerConfig) =>
          server.keyPath === profile.keyPath ? profileAnswer.promise : replacementAnswer.promise
        )
      };
      const factory = new SilentAuthSshFactory(
        connector,
        vault,
        prompt,
        undefined,
        (id) => id === profile.id ? profile : undefined,
        (id) => liveServers.get(id)
      );

      const owner = factory.connect(deviceA);
      const joined = factory.connect(deviceB);
      const joinedFailure = expect(joined).rejects.toThrow("configuration changed while connecting");
      await settle();
      expect(prompt.prompt).toHaveBeenCalledOnce();

      // B is edited while the profile prompt is still open. Its replacement
      // prompt waits, then saves a new server-scoped passphrase.
      liveServers.set(deviceB.id, standaloneB);
      const replacementLogin = factory.connect(standaloneB);
      await settle();
      expect(prompt.prompt).toHaveBeenCalledOnce();

      // A remains the live owner of the shared profile answer, and may still
      // use and save it. B's old record was replaced, so its joiner must stop
      // before sending that answer and must not erase B's replacement key.
      profileAnswer.resolve({ password: "fleet-passphrase", save: true });
      await vi.waitFor(() => expect(prompt.prompt).toHaveBeenCalledTimes(2));
      replacementAnswer.resolve({ password: "new-B-passphrase", save: true });
      await expect(replacementLogin).resolves.toBe(fakeConnection);
      await expect(owner).resolves.toBe(fakeConnection);
      await joinedFailure;

      expect(vault.store).toHaveBeenCalledWith(authProfilePassphraseSecretKey(profile.id), "fleet-passphrase");
      await expect(vault.get(passphraseSecretKey(deviceB.id))).resolves.toBe("new-B-passphrase");
    });

    it("asks once for the passphrase of one key file whatever route each login takes", async () => {
      // A passphrase only unlocks the key file here; it is never sent anywhere,
      // so the route a login takes does not change what it was typed for.
      const profile: AuthProfile = { id: "prof-key", name: "Fleet key", username: "ops", authType: "key", keyPath: "/keys/fleet" };
      const lookup = (id: string) => (id === profile.id ? profile : undefined);
      const lab1: ServerConfig = { ...baseServer, id: "srv-lab1", name: "lab1", authProfileId: profile.id, proxy: { type: "ssh", jumpHostId: "bastion-1" } };
      const lab2: ServerConfig = { ...baseServer, id: "srv-lab2", name: "lab2", authProfileId: profile.id, proxy: { type: "socks5", host: "proxy.local", port: 1080 } };
      const connector = encryptedKeyConnector();
      const vault = createVault();
      const { prompt, answer } = openPrompt();
      const factory = new SilentAuthSshFactory(connector, vault, prompt, undefined, lookup);

      const first = factory.connect(lab1);
      const second = factory.connect(lab2);
      await settle();
      answer({ password: "fleet-phrase", save: false });
      await Promise.all([first, second]);

      expect(prompt.prompt).toHaveBeenCalledTimes(1);
    });

    it("never gives a passphrase typed for one key file to a login that now uses another", async () => {
      const connector = encryptedKeyConnector();
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn(async (server: ServerConfig) => ({ password: `phrase-for-${server.keyPath}`, save: false }))
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);
      const rekeyed: ServerConfig = { ...keyServer, keyPath: "/keys/id_rsa" };

      await Promise.all([factory.connect(keyServer), factory.connect(rekeyed)]);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(sentPassphrases(connector)).toEqual(["phrase-for-/keys/id_ed25519", "phrase-for-/keys/id_rsa"]);
    });

    it("asks again after a login that used the passphrase fails", async () => {
      const connector: SshConnector = {
        connect: vi.fn(async (_server: ServerConfig, auth: { passphrase?: string }) => {
          if (auth.passphrase !== "right") {
            throw new Error("Cannot parse privateKey: bad decrypt");
          }
          return fakeConnection;
        })
      };
      const vault = createVault();
      const prompt: PasswordPrompt = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ password: "wrong", save: true })
          .mockResolvedValueOnce({ password: "right", save: true })
      };
      const factory = new SilentAuthSshFactory(connector, vault, prompt);

      await expect(factory.connect(keyServer)).rejects.toThrow("bad decrypt");
      await factory.connect(keyServer);

      expect(prompt.prompt).toHaveBeenCalledTimes(2);
      expect(vault.store).not.toHaveBeenCalledWith(passphraseSecretKey(keyServer.id), "wrong");
    });
  });
});

describe("SilentAuthSshFactory — interactive prompts do not overlap", () => {
  it("does not open a queued password prompt after its server record is replaced", async () => {
    const firstAnswer = deferred<{ password: string; save: boolean } | undefined>();
    const other: ServerConfig = { ...baseServer, id: "other", name: "Other" };
    let liveOther = other;
    const opened: string[] = [];
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async (server) => {
        opened.push(server.name);
        return server.id === baseServer.id
          ? firstAnswer.promise
          : { password: "stale-password", save: false };
      })
    };
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const factory = new SilentAuthSshFactory(
      connector, createVault(), prompt, undefined, undefined,
      (id) => id === baseServer.id ? baseServer : id === other.id ? liveOther : undefined
    );

    const first = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["Prod"]));
    const second = factory.connect(other);
    const secondFailure = expect(second).rejects.toThrow("configuration changed while connecting");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    liveOther = { ...other };

    firstAnswer.resolve({ password: "first-password", save: false });
    await first;
    await secondFailure;
    expect(opened).toEqual(["Prod"]);
  });

  it("does not open a queued password prompt after its connection owner closes", async () => {
    const firstAnswer = deferred<{ password: string; save: boolean } | undefined>();
    const other: ServerConfig = { ...baseServer, id: "other", name: "Other" };
    const opened: string[] = [];
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async (server) => {
        opened.push(server.name);
        return server.id === baseServer.id
          ? firstAnswer.promise
          : { password: "obsolete-password", save: false };
      })
    };
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const factory = new SilentAuthSshFactory(connector, createVault(), prompt);
    let ownerActive = true;

    const first = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["Prod"]));
    const second = factory.connect(other, { isActive: () => ownerActive });
    const secondFailure = expect(second).rejects.toThrow("connection attempt ended");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    ownerActive = false;

    firstAnswer.resolve({ password: "first-password", save: false });
    await first;
    await secondFailure;
    expect(opened).toEqual(["Prod"]);
    expect(connector.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared queued password prompt for a live login when its first owner closes", async () => {
    const firstAnswer = deferred<{ password: string; save: boolean } | undefined>();
    const other: ServerConfig = { ...baseServer, id: "other", name: "Other" };
    const opened: string[] = [];
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async (server) => {
        opened.push(server.name);
        return server.id === baseServer.id
          ? firstAnswer.promise
          : { password: "shared-password", save: false };
      })
    };
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const factory = new SilentAuthSshFactory(connector, createVault(), prompt);
    let firstOwnerActive = true;

    const blocker = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["Prod"]));
    const abandoned = factory.connect(other, { isActive: () => firstOwnerActive });
    const abandonedFailure = expect(abandoned).rejects.toThrow("connection attempt ended");
    const live = factory.connect(other, { isActive: () => true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    firstOwnerActive = false;

    firstAnswer.resolve({ password: "first-password", save: false });
    await blocker;
    await abandonedFailure;
    await live;
    expect(opened).toEqual(["Prod", "Other"]);
    expect(connector.connect).toHaveBeenCalledTimes(2);
  });

  it("answers a saved-password keyboard challenge while another prompt is open", async () => {
    const password = deferred<{ password: string; save: boolean } | undefined>();
    const savedServer: ServerConfig = { ...baseServer, id: "saved" };
    const opened: string[] = [];
    let savedResponse: string[] | undefined;
    const connector: SshConnector = {
      connect: vi.fn(async (server, auth) => {
        if (server.id === savedServer.id) {
          savedResponse = await auth.onKeyboardInteractive?.("", "", [{ prompt: "Password:", echo: false }]);
        }
        return fakeConnection;
      })
    };
    const factory = new SilentAuthSshFactory(
      connector,
      createVault({ [passwordSecretKey(savedServer.id)]: "saved-pw" }),
      { prompt: vi.fn(async () => { opened.push("password"); return password.promise; }) },
      async () => { opened.push("keyboard input"); return undefined; }
    );

    const first = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["password"]));
    const second = factory.connect(savedServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const answeredBeforeFirstPromptClosed = savedResponse;

    password.resolve({ password: "other-pw", save: false });
    await Promise.all([first, second]);
    expect(answeredBeforeFirstPromptClosed).toEqual(["saved-pw"]);
    expect(opened).toEqual(["password"]);
  });

  it("drops a queued verification prompt when its SSH handshake ends", async () => {
    const password = deferred<{ password: string; save: boolean } | undefined>();
    const opened: string[] = [];
    const agentServer: ServerConfig = { ...baseServer, id: "agent", authType: "agent" };
    const connector: SshConnector = {
      connect: vi.fn(async (server, auth) => {
        if (server.id === agentServer.id) {
          const controller = new AbortController();
          const reply = auth.onKeyboardInteractive?.("Verification", "", [{ prompt: "Code:", echo: false }], controller.signal);
          controller.abort();
          void reply?.catch(() => {});
          throw new Error("Timed out while waiting for handshake");
        }
        return fakeConnection;
      })
    };
    const factory = new SilentAuthSshFactory(
      connector, createVault(),
      { prompt: vi.fn(async () => { opened.push("password"); return password.promise; }) },
      async () => { opened.push("code"); return "123456"; }
    );

    const first = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["password"]));
    await expect(factory.connect(agentServer)).rejects.toThrow("Timed out while waiting for handshake");
    expect(opened).toEqual(["password"]);

    password.resolve({ password: "pw", save: false });
    await first;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual(["password"]);
  });

  it("waits for a different server's password prompt to finish", async () => {
    const firstAnswer = deferred<{ password: string; save: boolean } | undefined>();
    const opened: string[] = [];
    const prompt: PasswordPrompt = {
      prompt: vi.fn(async (server) => {
        opened.push(server.name);
        return server.id === baseServer.id
          ? firstAnswer.promise
          : { password: "second-password", save: false };
      })
    };
    const connector: SshConnector = { connect: vi.fn(async () => fakeConnection) };
    const factory = new SilentAuthSshFactory(connector, createVault(), prompt);
    const other = { ...baseServer, id: "srv-2", name: "Other" };

    const first = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["Prod"]));
    const second = factory.connect(other);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual(["Prod"]);

    firstAnswer.resolve({ password: "first-password", save: false });
    await Promise.all([first, second]);
    expect(opened).toEqual(["Prod", "Other"]);
  });

  it("waits for a keyboard-interactive code before opening a password prompt", async () => {
    const code = deferred<string | undefined>();
    const opened: string[] = [];
    const agentServer: ServerConfig = { ...baseServer, id: "agent", authType: "agent" };
    const connector: SshConnector = {
      connect: vi.fn(async (server, auth) => {
        if (server.id === agentServer.id) {
          expect(await auth.onKeyboardInteractive?.("Verification", "", [{ prompt: "Code:", echo: false }])).toEqual(["123456"]);
        }
        return fakeConnection;
      })
    };
    const factory = new SilentAuthSshFactory(
      connector, createVault(),
      { prompt: vi.fn(async () => { opened.push("password"); return { password: "pw", save: false }; }) },
      async () => { opened.push("code"); return code.promise; }
    );

    const first = factory.connect(agentServer);
    await vi.waitFor(() => expect(opened).toEqual(["code"]));
    const second = factory.connect(baseServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual(["code"]);

    code.resolve("123456");
    await Promise.all([first, second]);
    expect(opened).toEqual(["code", "password"]);
  });

  it("waits for a password prompt before opening a keyboard-interactive code", async () => {
    const password = deferred<{ password: string; save: boolean } | undefined>();
    const opened: string[] = [];
    const agentServer: ServerConfig = { ...baseServer, id: "agent", authType: "agent" };
    const connector: SshConnector = {
      connect: vi.fn(async (server, auth) => {
        if (server.id === agentServer.id) {
          expect(await auth.onKeyboardInteractive?.("Verification", "", [{ prompt: "Code:", echo: false }])).toEqual(["123456"]);
        }
        return fakeConnection;
      })
    };
    const factory = new SilentAuthSshFactory(
      connector, createVault(),
      { prompt: vi.fn(async () => { opened.push("password"); return password.promise; }) },
      async () => { opened.push("code"); return "123456"; }
    );

    const first = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["password"]));
    const second = factory.connect(agentServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual(["password"]);

    password.resolve({ password: "pw", save: false });
    await Promise.all([first, second]);
    expect(opened).toEqual(["password", "code"]);
  });

  it("drops a queued keyboard-interactive code when its terminal closes", async () => {
    const password = deferred<{ password: string; save: boolean } | undefined>();
    const opened: string[] = [];
    const agentServer: ServerConfig = { ...baseServer, id: "agent", authType: "agent" };
    const connector: SshConnector = {
      connect: vi.fn(async (server, auth) => {
        if (server.id === agentServer.id) {
          await auth.onKeyboardInteractive?.("Verification", "", [{ prompt: "Code:", echo: false }]);
        }
        return fakeConnection;
      })
    };
    const factory = new SilentAuthSshFactory(
      connector, createVault(),
      { prompt: vi.fn(async () => { opened.push("password"); return password.promise; }) },
      async () => { opened.push("code"); return "123456"; }
    );
    let ownerActive = true;

    const first = factory.connect(baseServer);
    await vi.waitFor(() => expect(opened).toEqual(["password"]));
    const second = factory.connect(agentServer, { isActive: () => ownerActive });
    const secondFailure = expect(second).rejects.toThrow("connection attempt ended");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    ownerActive = false;

    password.resolve({ password: "pw", save: false });
    await first;
    await secondFailure;
    expect(opened).toEqual(["password"]);
  });
});

// Issue #177 (review) — the route a password is shared on is the jump
// connection a login actually tunnels through, not the jump host's
// configuration: NexusCore updates a server before the change reaches the pool,
// so for a moment a changed configuration still rides the old pooled
// connection — and a replaced connection can carry an unchanged one. These
// drive the real ProxySshFactory, with the real pool as its jump-host factory,
// over the real SilentAuthSshFactory; only the SSH transport is faked.
describe("ProxySshFactory + SilentAuthSshFactory — a password is shared only through the same jump connection (issue #177)", () => {
  type Answer = { password: string; save: boolean } | undefined;
  const bastion: ServerConfig = { ...baseServer, id: "bastion", name: "Bastion", host: "10.0.0.1", username: "ops" };
  const target: ServerConfig = { ...baseServer, id: "srv-target", name: "Target", host: "172.16.0.5", proxy: { type: "ssh", jumpHostId: bastion.id } };

  /**
   * `firstBastionTunnels` caps how many tunnels the first bastion connection
   * opens before it reports itself gone ("Not connected"), which makes the pool
   * move that lease onto a fallback connection of its own.
   */
  function setUp(firstBastionTunnels = Infinity) {
    const servers = new Map([bastion, target].map((server) => [server.id, server]));
    // The bastion's password is saved, so the target's prompt is the only one.
    const vault = createVault({ [passwordSecretKey(bastion.id)]: "saved-bastion" });
    let bastionConnections = 0;
    const connector: SshConnector = {
      connect: vi.fn(async (server: ServerConfig) => {
        let budget = server.id === bastion.id && ++bastionConnections === 1 ? firstBastionTunnels : Infinity;
        return {
          ...fakeConnection,
          openDirectTcp: vi.fn(async () => {
            if (budget-- <= 0) {
              throw new Error("Not connected");
            }
            return new PassThrough();
          }),
          dispose: vi.fn()
        };
      })
    };
    const pending: Array<(value: Answer) => void> = [];
    const prompt: PasswordPrompt = { prompt: vi.fn(() => new Promise<Answer>((resolve) => pending.push(resolve))) };
    const factory = new ProxySshFactory(new SilentAuthSshFactory(connector, vault, prompt), (id) => servers.get(id), vault);
    const pool = new SshConnectionPool(factory, { enabled: true, idleTimeoutMs: 0 });
    factory.setJumpHostConnectionFactory(pool);
    const calls = (connector.connect as ReturnType<typeof vi.fn>).mock.calls;
    let reachedPrompt = 0;
    return {
      servers,
      pool,
      prompt,
      /** Starts a login to the target and waits until it is at its prompt, or joined another; `done` is the login. */
      login: async (): Promise<{ done: Promise<SshConnection> }> => {
        const login = factory.connect({ ...target, proxy: { type: "ssh", jumpHostId: bastion.id } });
        reachedPrompt += 1;
        const expected = reachedPrompt;
        await vi.waitFor(() =>
          expect((vault.get as ReturnType<typeof vi.fn>).mock.calls.filter(([key]) => key === passwordSecretKey(target.id))).toHaveLength(expected)
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return { done: login };
      },
      answerEach: () => pending.splice(0).forEach((resolve, i) => resolve({ password: `pw-${i + 1}`, save: false })),
      answerAll: (answer: Answer) => pending.splice(0).forEach((resolve) => resolve(answer)),
      targetPasswords: () =>
        calls.filter((call) => (call[0] as ServerConfig).id === target.id).map((call) => (call[1] as { password?: string }).password).sort(),
      bastionLogins: () => calls.filter((call) => (call[0] as ServerConfig).id === bastion.id).length
    };
  }

  it("asks once for logins that tunnel through the same pooled jump connection", async () => {
    const run = setUp();
    const first = await run.login();
    const second = await run.login();
    run.answerEach();
    await Promise.all([first.done, second.done]);

    expect(run.bastionLogins()).toBe(1);
    expect(run.prompt.prompt).toHaveBeenCalledTimes(1);
    expect(run.targetPasswords()).toEqual(["pw-1", "pw-1"]);
  });

  it("asks again for a login through a replacement jump connection, even with the configuration unchanged", async () => {
    const run = setUp();
    const first = await run.login();
    run.pool.invalidate(bastion.id);
    const second = await run.login();
    run.answerEach();
    await vi.waitFor(() => expect(run.prompt.prompt).toHaveBeenCalledTimes(2));
    run.answerAll({ password: "pw-2", save: false });
    await Promise.all([first.done, second.done]);

    expect(run.bastionLogins()).toBe(2);
    expect(run.prompt.prompt).toHaveBeenCalledTimes(2);
    expect(run.targetPasswords()).toEqual(["pw-1", "pw-2"]);
  });

  it("does not send a shared answer through a jump connection its login fell back to after joining", async () => {
    // The route is checked again once the login's socket is open: a pooled
    // jump connection that fails to open a tunnel moves the lease onto a
    // fallback connection of its own, made from the jump host's configuration
    // as the lease found it — which may no longer be the host the answer was
    // typed for.
    const run = setUp(1);
    const first = await run.login();
    const second = await run.login();
    run.answerEach();

    await expect(first.done).resolves.toBeDefined();
    await expect(second.done).rejects.toThrow(/was not sent/);
    expect(run.bastionLogins()).toBe(2);
    expect(run.prompt.prompt).toHaveBeenCalledTimes(1);
    expect(run.targetPasswords()).toEqual(["pw-1"]);
  });

  it("still sends its own answer through a fallback jump connection, as before", async () => {
    // Only an answer typed for another login's route is held back: a login
    // that asked for its own password is not failed by the pool's fallback.
    const run = setUp(0);
    const only = await run.login();
    run.answerAll({ password: "pw", save: false });

    await expect(only.done).resolves.toBeDefined();
    expect(run.bastionLogins()).toBe(2);
    expect(run.targetPasswords()).toEqual(["pw"]);
  });

  it("shares an answer with a login still riding the old jump connection after its configuration changed, and only with those", async () => {
    // The edit has landed in the configuration but not yet reached the pool:
    // the second login still tunnels through the connection the first did.
    // Once the pool lets that go, the next login's route is a new one.
    const run = setUp();
    const first = await run.login();
    run.servers.set(bastion.id, { ...bastion, host: "10.0.0.2" });
    const second = await run.login();
    run.pool.invalidate(bastion.id);
    const third = await run.login();
    run.answerEach();
    await vi.waitFor(() => expect(run.prompt.prompt).toHaveBeenCalledTimes(2));
    run.answerAll({ password: "pw-2", save: false });
    await Promise.all([first.done, second.done, third.done]);

    expect(run.bastionLogins()).toBe(2);
    expect(run.prompt.prompt).toHaveBeenCalledTimes(2);
    expect(run.targetPasswords()).toEqual(["pw-1", "pw-1", "pw-2"]);
  });
});

describe("proxyEndpointRoute", () => {
  it.each<[string, Socks5Proxy | HttpConnectProxy, Socks5Proxy | HttpConnectProxy]>([
    ["SOCKS5 proxies on different hosts", { type: "socks5", host: "p1", port: 1080 }, { type: "socks5", host: "p2", port: 1080 }],
    ["SOCKS5 proxies on different ports", { type: "socks5", host: "p1", port: 1080 }, { type: "socks5", host: "p1", port: 1081 }],
    ["SOCKS5 proxies as different users", { type: "socks5", host: "p1", port: 1080, username: "a" }, { type: "socks5", host: "p1", port: 1080, username: "b" }],
    ["a SOCKS5 and an HTTP proxy at one address", { type: "socks5", host: "p1", port: 8080 }, { type: "http", host: "p1", port: 8080 }],
    ["HTTP proxies on different hosts", { type: "http", host: "p1", port: 8080 }, { type: "http", host: "p2", port: 8080 }]
  ])("tells apart %s", (_name, a, b) => {
    expect(proxyEndpointRoute(a)).not.toBe(proxyEndpointRoute(b));
  });

  it("is the same for equal endpoints held in separate objects", () => {
    expect(proxyEndpointRoute({ type: "http", host: "p1", port: 8080, username: "u" })).toBe(
      proxyEndpointRoute({ username: "u", port: 8080, host: "p1", type: "http" })
    );
  });
});
