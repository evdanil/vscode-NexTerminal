import { beforeEach, describe, expect, it, vi } from "vitest";

const mockShowInformationMessage = vi.fn();
const mockExecuteCommand = vi.fn();
const mockGetConfiguration = vi.fn(() => ({ get: (_key: string, def: unknown) => def }));

let openHandler: ((doc: { uri: { scheme: string; toString(): string } }) => void | Promise<void>) | undefined;

vi.mock("vscode", () => ({
  FilePermission: { Readonly: 1 },
  workspace: {
    onDidOpenTextDocument: vi.fn((cb: any) => {
      openHandler = cb;
      return { dispose: vi.fn() };
    }),
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args)
  },
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args)
  },
  commands: {
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args)
  }
}));

import { registerEditAsRootHint } from "../../src/services/sftp/editAsRootHint";
import { NEXTERM_SCHEME } from "../../src/services/sftp/nexusFileSystemProvider";

function nextermDoc(path = "/etc/sudoers") {
  const uriString = `nexterm://srv-1${path}`;
  return { uri: { scheme: NEXTERM_SCHEME, toString: () => uriString } };
}

function createProvider(overrides?: { permissions?: number | undefined; isElevated?: boolean; statThrows?: boolean }) {
  return {
    isElevated: vi.fn(() => overrides?.isElevated ?? false),
    stat: vi.fn(async () => {
      if (overrides?.statThrows) {
        throw new Error("boom");
      }
      return { permissions: overrides?.permissions };
    }),
    markElevated: vi.fn()
  };
}

describe("registerEditAsRootHint (P6b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openHandler = undefined;
    mockGetConfiguration.mockReturnValue({ get: (_key: string, def: unknown) => def });
  });

  it("shows the hint for a read-only nexterm:// file and offers Edit as Root", async () => {
    const provider = createProvider({ permissions: 1 }); // FilePermission.Readonly
    registerEditAsRootHint(provider as any);
    mockShowInformationMessage.mockResolvedValue(undefined);

    await openHandler!(nextermDoc());

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "This file is read-only on the remote host. Use Edit as Root (sudo) to modify it.",
      "Edit as Root"
    );
  });

  it("marks the file elevated and opens it when the Edit as Root button is clicked", async () => {
    const provider = createProvider({ permissions: 1 });
    registerEditAsRootHint(provider as any);
    mockShowInformationMessage.mockResolvedValue("Edit as Root");

    await openHandler!(nextermDoc());

    expect(provider.markElevated).toHaveBeenCalledWith(expect.objectContaining({ scheme: NEXTERM_SCHEME }));
    expect(mockExecuteCommand).toHaveBeenCalledWith("vscode.open", expect.anything());
  });

  it("never fires for a writable file", async () => {
    const provider = createProvider({ permissions: undefined }); // writable: stat() returns no Readonly bit
    registerEditAsRootHint(provider as any);

    await openHandler!(nextermDoc());

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("does not fire for a non-nexterm document", async () => {
    const provider = createProvider({ permissions: 1 });
    registerEditAsRootHint(provider as any);

    await openHandler!({ uri: { scheme: "file", toString: () => "file:///etc/sudoers" } });

    expect(provider.stat).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("does not fire when nexus.sftp.sudo.enabled is off", async () => {
    mockGetConfiguration.mockReturnValue({ get: (key: string, def: unknown) => (key === "sudo.enabled" ? false : def) });
    const provider = createProvider({ permissions: 1 });
    registerEditAsRootHint(provider as any);

    await openHandler!(nextermDoc());

    expect(provider.stat).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("does not fire for a URI already marked elevated", async () => {
    const provider = createProvider({ permissions: 1, isElevated: true });
    registerEditAsRootHint(provider as any);

    await openHandler!(nextermDoc());

    expect(provider.stat).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it("fires at most once per URI per session", async () => {
    const provider = createProvider({ permissions: 1 });
    registerEditAsRootHint(provider as any);
    mockShowInformationMessage.mockResolvedValue(undefined);

    await openHandler!(nextermDoc());
    await openHandler!(nextermDoc());

    expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("still hints a second, different read-only file in the same session", async () => {
    const provider = createProvider({ permissions: 1 });
    registerEditAsRootHint(provider as any);
    mockShowInformationMessage.mockResolvedValue(undefined);

    await openHandler!(nextermDoc("/etc/sudoers"));
    await openHandler!(nextermDoc("/etc/shadow"));

    expect(mockShowInformationMessage).toHaveBeenCalledTimes(2);
  });

  it("swallows a stat failure without showing the hint", async () => {
    const provider = createProvider({ statThrows: true });
    registerEditAsRootHint(provider as any);

    await expect(openHandler!(nextermDoc())).resolves.toBeUndefined();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });
});
