import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockShowInformationMessage = vi.fn();
const mockExecuteCommand = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockReadDirectory = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args)
  },
  commands: {
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  },
  workspace: {
    fs: {
      stat: (...args: unknown[]) => mockStat(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
      readDirectory: (...args: unknown[]) => mockReadDirectory(...args)
    }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: "file" })
  },
  FileType: { File: 1, Directory: 2 }
}));

import { maybeOfferSshConfigImport, SSH_CONFIG_OFFER_KEY } from "../../src/services/import/sshConfigImportOffer";

const sshDir = path.join(os.homedir(), ".ssh");
const configPath = path.join(sshDir, "config");

/** Map-backed stand-in for the real `globalState` Memento. */
function makeContext(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    context: {
      globalState: {
        get: (key: string) => store.get(key),
        update: async (key: string, value: unknown) => {
          store.set(key, value);
        }
      }
    } as unknown as import("vscode").ExtensionContext
  };
}

/** Serve one ssh config file at ~/.ssh/config; everything else is ENOENT. */
function serveConfig(text: string, size = Buffer.byteLength(text, "utf8")): void {
  mockStat.mockImplementation(async (uri: { fsPath: string }) => {
    if (uri.fsPath === configPath) return { type: 1, size };
    throw new Error(`ENOENT: ${uri.fsPath}`);
  });
  mockReadFile.mockImplementation(async (uri: { fsPath: string }) => {
    if (uri.fsPath === configPath) return Buffer.from(text, "utf8");
    throw new Error(`ENOENT: ${uri.fsPath}`);
  });
  mockReadDirectory.mockImplementation(async () => []);
}

const REAL_CONFIG = "Host web1\n  HostName web1.example.com\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n";

describe("one-time ~/.ssh/config import offer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowInformationMessage.mockResolvedValue(undefined);
  });

  it("offers EXACTLY ONCE across two activations (⊘ keying the marker on anything but 'was shown' re-offers on every start)", async () => {
    const { context } = makeContext();
    serveConfig(REAL_CONFIG);

    await maybeOfferSshConfigImport(context);
    await maybeOfferSshConfigImport(context);

    expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("sets the marker BEFORE the notification is answered — a dismissed (unanswered) offer never returns (⊘ updating globalState after the await re-offers until someone clicks)", async () => {
    const { context, store } = makeContext();
    serveConfig(REAL_CONFIG);

    let markerAtShowTime: unknown;
    mockShowInformationMessage.mockImplementation(async () => {
      markerAtShowTime = store.get(SSH_CONFIG_OFFER_KEY);
      // The user closes the toast without choosing — the common case.
      return undefined;
    });

    await maybeOfferSshConfigImport(context);

    expect(markerAtShowTime).toBe(true);
    expect(store.get(SSH_CONFIG_OFFER_KEY)).toBe(true);
  });

  it("does not touch the filesystem at all once the marker is set (⊘ re-reading the config every activation is work nobody asked for)", async () => {
    const { context } = makeContext({ [SSH_CONFIG_OFFER_KEY]: true });
    serveConfig(REAL_CONFIG);

    await maybeOfferSshConfigImport(context);

    expect(mockStat).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("stays silent, and leaves the marker UNSET, when ~/.ssh/config does not exist (⊘ burning the one-shot marker on a machine with no config means the offer never comes when the file appears)", async () => {
    const { context, store } = makeContext();
    mockStat.mockRejectedValue(new Error("ENOENT"));

    await maybeOfferSshConfigImport(context);

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
    expect(store.has(SSH_CONFIG_OFFER_KEY)).toBe(false);
  });

  it("stays silent for a config that parses but yields ZERO importable hosts — all defaults blocks (⊘ offering an import with nothing to import is an interruption with no action behind it)", async () => {
    const { context } = makeContext();
    serveConfig("Host *\n  User root\n  ServerAliveInterval 60\n\nHost *.internal\n  User admin\n");

    await maybeOfferSshConfigImport(context);

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("stays silent for a config whose only content is Includes that resolve to nothing", async () => {
    const { context } = makeContext();
    serveConfig("Include config.d/*\nInclude missing_file\n");

    await maybeOfferSshConfigImport(context);

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("stays silent for an oversized config — the 2 MB ceiling applies here too, and the file is never read", async () => {
    const { context } = makeContext();
    serveConfig(REAL_CONFIG, 3 * 1024 * 1024);

    await maybeOfferSshConfigImport(context);

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("NEVER rejects into activation when the filesystem throws (⊘ an unguarded stat/readFile rejection propagates out of activate())", async () => {
    const { context } = makeContext();
    mockStat.mockImplementation(async () => ({ type: 1, size: 100 }));
    mockReadFile.mockRejectedValue(new Error("EACCES"));
    mockReadDirectory.mockRejectedValue(new Error("EACCES"));

    await expect(maybeOfferSshConfigImport(context)).resolves.toBeUndefined();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("NEVER rejects into activation when globalState.update throws", async () => {
    serveConfig(REAL_CONFIG);
    const context = {
      globalState: {
        get: () => undefined,
        update: async () => {
          throw new Error("state write failed");
        }
      }
    } as unknown as import("vscode").ExtensionContext;

    await expect(maybeOfferSshConfigImport(context)).resolves.toBeUndefined();
    // No marker means no offer: better a missed offer than one that repeats forever.
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("names the host count and the permanent route, with Import and Dismiss buttons (⊘ an offer that never returns and names no other way in strands the user who dismisses it)", async () => {
    const { context } = makeContext();
    serveConfig(`${REAL_CONFIG}\nHost db\n  HostName db.example.com\n`);

    await maybeOfferSshConfigImport(context);

    const [message, ...buttons] = mockShowInformationMessage.mock.calls[0];
    expect(message).toContain("2 SSH hosts");
    expect(message).toContain("Nexus: Import…");
    expect(buttons).toEqual(["Import", "Dismiss"]);
  });

  it("[Import] runs the import command with the already-resolved URI, so the file dialog is skipped (⊘ dropping the argument re-asks for a path the offer just found)", async () => {
    const { context } = makeContext();
    serveConfig(REAL_CONFIG);
    mockShowInformationMessage.mockResolvedValue("Import");

    await maybeOfferSshConfigImport(context);

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "nexus.config.import.sshConfig",
      expect.objectContaining({ fsPath: configPath })
    );
  });

  it("[Dismiss] imports nothing", async () => {
    const { context } = makeContext();
    serveConfig(REAL_CONFIG);
    mockShowInformationMessage.mockResolvedValue("Dismiss");

    await maybeOfferSshConfigImport(context);

    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });
});
