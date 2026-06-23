import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vscode mock — must be defined before importing src modules
// ---------------------------------------------------------------------------

const state = {
  executeCommandCalls: [] as Array<{ cmd: string; args: unknown[] }>,
  showError: vi.fn(),
  showWarning: vi.fn()
};

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(async (cmd: string, ...args: unknown[]) => {
      state.executeCommandCalls.push({ cmd, args });
    })
  },
  window: {
    showErrorMessage: (...args: unknown[]) => {
      state.showError(...args);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (...args: unknown[]) => {
      state.showWarning(...args);
      return Promise.resolve(undefined);
    }
  }
}));

import { parseNexusUri, resolveProfile, createNexusUriHandler } from "../../src/uri/nexusUriHandler";
import type { ServerConfig, SerialProfile, LocalShellProfile } from "../../src/models/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a minimal fake vscode.Uri for parseNexusUri tests. */
function makeUri(path: string, query: string = ""): import("vscode").Uri {
  return { path, query } as unknown as import("vscode").Uri;
}

function makeServer(id: string, name: string): ServerConfig {
  return {
    id,
    name,
    host: "example.com",
    port: 22,
    username: "user",
    authType: "password",
    isHidden: false
  };
}

function makeSerial(id: string, name: string): SerialProfile {
  return {
    id,
    name,
    path: "/dev/ttyUSB0",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false
  };
}

function makeLocalShell(id: string, name: string): LocalShellProfile {
  return {
    id,
    name,
    launchMode: "custom",
    shellPath: "/bin/bash"
  };
}

/** Empty collections helper for the resolver. */
function collections(
  servers: ServerConfig[] = [],
  serialProfiles: SerialProfile[] = [],
  localShellProfiles: LocalShellProfile[] = []
) {
  return { servers, serialProfiles, localShellProfiles };
}

// ---------------------------------------------------------------------------
// parseNexusUri
// ---------------------------------------------------------------------------

describe("parseNexusUri", () => {
  it("returns sftp:false by default", () => {
    const result = parseNexusUri(makeUri("/myserver"));
    expect(result).toEqual({ name: "myserver", id: undefined, sftp: false });
  });

  it("sets sftp:true for ?sftp query flag", () => {
    const result = parseNexusUri(makeUri("/myserver", "sftp"));
    expect(result).toEqual({ name: "myserver", id: undefined, sftp: true });
  });

  it("sets sftp:true for ?sftp=1", () => {
    const result = parseNexusUri(makeUri("/myserver", "sftp=1"));
    expect(result).toEqual({ name: "myserver", id: undefined, sftp: true });
  });

  it("?id= sets id and keeps name", () => {
    const result = parseNexusUri(makeUri("/somename", "id=abc-123"));
    expect(result).toEqual({ name: "somename", id: "abc-123", sftp: false });
  });

  it("?id= works without a path name", () => {
    const result = parseNexusUri(makeUri("/", "id=abc-123"));
    expect(result).toEqual({ name: undefined, id: "abc-123", sftp: false });
  });

  it("uses uri.path verbatim (VS Code already decoded it)", () => {
    // VS Code delivers an already percent-decoded path, so a link to
    // "my%20server" arrives here as "/my server".
    const result = parseNexusUri(makeUri("/my server"));
    expect(result).toEqual({ name: "my server", id: undefined, sftp: false });
  });

  it("preserves a literal percent in the name without throwing (100%)", () => {
    const result = parseNexusUri(makeUri("/100%"));
    expect(result).toEqual({ name: "100%", id: undefined, sftp: false });
  });

  it("does not re-decode percent escapes in the name (db%2Fprod stays intact)", () => {
    const result = parseNexusUri(makeUri("/db%2Fprod"));
    expect(result).toEqual({ name: "db%2Fprod", id: undefined, sftp: false });
  });

  it("empty path and no id returns error", () => {
    const result = parseNexusUri(makeUri("/", ""));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/no profile name or id/i);
  });

  it("empty path with no trailing slash and no id returns error", () => {
    const result = parseNexusUri(makeUri("", ""));
    expect(result).toHaveProperty("error");
  });

  it("trailing slash on name is stripped", () => {
    const result = parseNexusUri(makeUri("/myserver/"));
    expect(result).toEqual({ name: "myserver", id: undefined, sftp: false });
  });

  it("unknown extra query parameters are ignored", () => {
    const result = parseNexusUri(makeUri("/myserver", "foo=bar&baz=qux"));
    expect(result).toEqual({ name: "myserver", id: undefined, sftp: false });
  });
});

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

describe("resolveProfile", () => {
  const ssh = makeServer("ssh-id", "Production");
  const serial = makeSerial("serial-id", "Console");
  const localShell = makeLocalShell("local-id", "DevShell");

  it("finds an SSH server by id", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { id: "ssh-id" });
    expect(result.profile?.id).toBe("ssh-id");
    expect(result.kind).toBe("ssh");
    expect(result.ambiguous).toBe(false);
  });

  it("finds a serial profile by id", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { id: "serial-id" });
    expect(result.profile?.id).toBe("serial-id");
    expect(result.kind).toBe("serial");
    expect(result.ambiguous).toBe(false);
  });

  it("finds a local-shell profile by id", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { id: "local-id" });
    expect(result.profile?.id).toBe("local-id");
    expect(result.kind).toBe("localShell");
    expect(result.ambiguous).toBe(false);
  });

  it("finds an SSH server by case-insensitive name", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { name: "production" });
    expect(result.profile?.id).toBe("ssh-id");
    expect(result.kind).toBe("ssh");
  });

  it("finds a serial profile by case-insensitive name", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { name: "console" });
    expect(result.profile?.id).toBe("serial-id");
    expect(result.kind).toBe("serial");
  });

  it("finds a local-shell profile by case-insensitive name", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { name: "devshell" });
    expect(result.profile?.id).toBe("local-id");
    expect(result.kind).toBe("localShell");
  });

  it("cross-type name ambiguity returns first (ssh wins over serial) + ambiguous:true", () => {
    // Same name across SSH and Serial — deterministic order is ssh → serial.
    const sshDup = makeServer("ssh-dup", "Shared");
    const serialDup = makeSerial("serial-dup", "shared");
    const result = resolveProfile(collections([sshDup], [serialDup], []), { name: "shared" });
    expect(result.profile?.id).toBe("ssh-dup");
    expect(result.kind).toBe("ssh");
    expect(result.ambiguous).toBe(true);
  });

  it("cross-type ambiguity between serial and localShell returns serial first", () => {
    const serialDup = makeSerial("serial-dup", "Box");
    const localDup = makeLocalShell("local-dup", "box");
    const result = resolveProfile(collections([], [serialDup], [localDup]), { name: "box" });
    expect(result.profile?.id).toBe("serial-dup");
    expect(result.kind).toBe("serial");
    expect(result.ambiguous).toBe(true);
  });

  it("returns undefined profile/kind when no match found", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { name: "nope" });
    expect(result.profile).toBeUndefined();
    expect(result.kind).toBeUndefined();
    expect(result.ambiguous).toBe(false);
  });

  it("returns undefined for unknown id", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { id: "no-such-id" });
    expect(result.profile).toBeUndefined();
    expect(result.kind).toBeUndefined();
    expect(result.ambiguous).toBe(false);
  });

  it("prefers id lookup over name when both supplied", () => {
    const result = resolveProfile(collections([ssh], [serial], [localShell]), { id: "serial-id", name: "production" });
    expect(result.profile?.id).toBe("serial-id");
    expect(result.kind).toBe("serial");
  });
});

// ---------------------------------------------------------------------------
// createNexusUriHandler (handleUri)
// ---------------------------------------------------------------------------

describe("createNexusUriHandler", () => {
  const sshServer = makeServer("ssh-server-id", "MyServer");
  const serialProfile = makeSerial("serial-profile-id", "MySerial");
  const localShellProfile = makeLocalShell("local-shell-id", "MyShell");

  function makeCore(opts: {
    servers?: ServerConfig[];
    serialProfiles?: SerialProfile[];
    localShellProfiles?: LocalShellProfile[];
  }) {
    return {
      getSnapshot: () => ({
        servers: opts.servers ?? [],
        serialProfiles: opts.serialProfiles ?? [],
        localShellProfiles: opts.localShellProfiles ?? []
      })
    } as unknown as import("../../src/core/nexusCore").NexusCore;
  }

  beforeEach(() => {
    state.executeCommandCalls = [];
    state.showError.mockClear();
    state.showWarning.mockClear();
  });

  it("SSH profile dispatches nexus.server.connect with id", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ servers: [sshServer] }) });
    await handler.handleUri(makeUri("/MyServer"));
    expect(state.executeCommandCalls).toEqual([
      { cmd: "nexus.server.connect", args: [sshServer.id] }
    ]);
    expect(state.showError).not.toHaveBeenCalled();
  });

  it("SSH profile with ?sftp dispatches connect then nexus.files.browse", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ servers: [sshServer] }) });
    await handler.handleUri(makeUri("/MyServer", "sftp"));
    expect(state.executeCommandCalls).toEqual([
      { cmd: "nexus.server.connect", args: [sshServer.id] },
      { cmd: "nexus.files.browse", args: [sshServer.id] }
    ]);
    expect(state.showError).not.toHaveBeenCalled();
  });

  it("Serial profile dispatches nexus.serial.connect with id", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ serialProfiles: [serialProfile] }) });
    await handler.handleUri(makeUri("/MySerial"));
    expect(state.executeCommandCalls).toEqual([
      { cmd: "nexus.serial.connect", args: [serialProfile.id] }
    ]);
    expect(state.showError).not.toHaveBeenCalled();
  });

  it("Local Shell profile dispatches nexus.localShell.connect with id", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ localShellProfiles: [localShellProfile] }) });
    await handler.handleUri(makeUri("/MyShell"));
    expect(state.executeCommandCalls).toEqual([
      { cmd: "nexus.localShell.connect", args: [localShellProfile.id] }
    ]);
    expect(state.showError).not.toHaveBeenCalled();
  });

  it("?sftp on a serial profile shows error and dispatches nothing", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ serialProfiles: [serialProfile] }) });
    await handler.handleUri(makeUri("/MySerial", "sftp"));
    expect(state.showError).toHaveBeenCalledOnce();
    expect(state.showError).toHaveBeenCalledWith("Nexus: SFTP is only available for SSH profiles.");
    expect(state.executeCommandCalls).toHaveLength(0);
  });

  it("?sftp on a local-shell profile shows error and dispatches nothing", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ localShellProfiles: [localShellProfile] }) });
    await handler.handleUri(makeUri("/MyShell", "sftp"));
    expect(state.showError).toHaveBeenCalledOnce();
    expect(state.executeCommandCalls).toHaveLength(0);
  });

  it("error path (empty path, no id) calls showErrorMessage and dispatches nothing", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ servers: [sshServer] }) });
    await handler.handleUri(makeUri("/", ""));
    expect(state.showError).toHaveBeenCalledOnce();
    expect(state.executeCommandCalls).toHaveLength(0);
  });

  it("unknown profile shows error and dispatches nothing", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ servers: [sshServer] }) });
    await handler.handleUri(makeUri("/no-such-profile"));
    expect(state.showError).toHaveBeenCalledOnce();
    expect(state.executeCommandCalls).toHaveLength(0);
  });

  it("ambiguous name calls showWarningMessage and still opens the first match", async () => {
    const sshDup = makeServer("ssh-dup-id", "Dup");
    const serialDup = makeSerial("serial-dup-id", "dup");
    const handler = createNexusUriHandler({
      core: makeCore({ servers: [sshDup], serialProfiles: [serialDup] })
    });
    await handler.handleUri(makeUri("/dup"));
    expect(state.showWarning).toHaveBeenCalledOnce();
    // First match (ssh) is used.
    expect(state.executeCommandCalls).toEqual([
      { cmd: "nexus.server.connect", args: [sshDup.id] }
    ]);
  });

  it("id= in query overrides name for resolution", async () => {
    const handler = createNexusUriHandler({ core: makeCore({ servers: [sshServer] }) });
    await handler.handleUri(makeUri("/wrong-name", `id=${sshServer.id}`));
    expect(state.executeCommandCalls).toEqual([
      { cmd: "nexus.server.connect", args: [sshServer.id] }
    ]);
    expect(state.showError).not.toHaveBeenCalled();
  });
});
