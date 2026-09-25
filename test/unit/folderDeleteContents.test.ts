/**
 * Remove Folder → **Delete contents** (`nexus.group.remove`, issue #158).
 *
 * The cascade deletes every profile in the subtree, so it owes each of them the
 * teardown that profile's own Remove performs — otherwise a Local Server keeps
 * running with no row left to stop it from, and an SSH, serial or Local Shell
 * terminal stays open on a profile that no longer exists.
 *
 * Real NexusCore, real profile/server/local-server command modules; only the
 * runtime owners (Local Server manager, tunnel manager, SSH pool, terminals,
 * vault) are fakes, so what is asserted is exactly what they were asked to do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowWarningMessage = vi.fn();

vi.mock("../../src/services/ssh/sshPty", () => ({ SshPty: vi.fn() }));
vi.mock("../../src/services/telnet/telnetPty", () => ({ TelnetPty: vi.fn() }));
vi.mock("../../src/ui/webviewFormPanel", () => ({ WebviewFormPanel: { open: vi.fn() } }));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn()
  },
  window: {
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    createTerminal: vi.fn(),
    onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() }))
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback }))
  },
  env: { clipboard: { writeText: vi.fn() } },
  Uri: { file: (path: string) => ({ fsPath: path, scheme: "file" }) },
  TreeItem: class {
    public constructor(
      public readonly label: string,
      public readonly collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    public constructor(public readonly id: string, public readonly color?: unknown) {}
  },
  ThemeColor: class {
    public constructor(public readonly id: string) {}
  },
  EventEmitter: class {
    public readonly event = vi.fn();
    public fire = vi.fn();
  }
}));

import { FOLDER_TEARDOWN_REPORT_MS, registerProfileCommands } from "../../src/commands/profileCommands";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { FolderTreeItem } from "../../src/ui/nexusTreeProvider";
import { configMutationLock } from "../../src/services/configMutationLock";
import { passphraseSecretKey, passwordSecretKey, proxyPasswordSecretKey } from "../../src/services/ssh/silentAuth";
import type { ServerConfig } from "../../src/models/config";
import type { LocalServerConfig } from "../../src/models/localServer";

function server(id: string, group: string): ServerConfig {
  return { id, name: id, host: "10.0.0.1", port: 22, username: "dev", authType: "password", isHidden: false, group };
}

function localServer(id: string, group: string): LocalServerConfig {
  return { id, name: id, group, executable: "node" };
}

function fakeTerminal() {
  return { dispose: vi.fn() };
}

/**
 * Lab (deleted) holds one profile of every kind, plus a Local Server one level
 * down in Lab/Sub; Keep holds a survivor of every kind. `present(id)` lets the
 * fakes record whether a profile still existed when they were called.
 *
 * `gateTunnel` holds that tunnel's stop open until `releaseTunnelStop()`, so a
 * test can land a write while SSH teardown is waiting on it; `rejectTunnel`
 * makes that tunnel's stop fail.
 */
async function fixture(options: { gateTunnel?: string; rejectTunnel?: string } = {}) {
  const repo = new InMemoryConfigRepository();
  const core = new NexusCore(repo);
  await core.initialize();
  await core.addOrUpdateServer(server("srv-lab", "Lab"));
  await core.addOrUpdateServer(server("srv-keep", "Keep"));
  await core.addOrUpdateSerialProfile({
    id: "ser-lab", name: "ser-lab", group: "Lab", path: "/dev/ttyUSB0",
    baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", rtscts: false
  });
  await core.addOrUpdateSerialProfile({
    id: "ser-keep", name: "ser-keep", group: "Keep", path: "/dev/ttyUSB1",
    baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", rtscts: false
  });
  await core.addOrUpdateLocalShellProfile({ id: "sh-lab", name: "sh-lab", group: "Lab", launchMode: "custom", shellPath: "/bin/bash" });
  await core.addOrUpdateLocalShellProfile({ id: "sh-keep", name: "sh-keep", group: "Keep", launchMode: "custom", shellPath: "/bin/bash" });
  await core.addOrUpdateLocalServerConfig(localServer("ls-lab", "Lab"));
  await core.addOrUpdateLocalServerConfig(localServer("ls-sub", "Lab/Sub"));
  await core.addOrUpdateLocalServerConfig(localServer("ls-keep", "Keep"));

  // Each tunnel belongs to one server; teardown must stop only the deleted one's.
  const tunnel = (id: string, serverId: string) => ({
    id, profileId: `p-${id}`, serverId, localPort: 8080, remoteIP: "127.0.0.1", remotePort: 80,
    connectionMode: "isolated" as const, tunnelType: "local" as const, startedAt: 1, bytesIn: 0, bytesOut: 0
  });
  core.registerTunnel(tunnel("tun-lab", "srv-lab"));
  core.registerTunnel(tunnel("tun-keep", "srv-keep"));

  const present = (id: string): "present" | "gone" =>
    core.getServer(id) ?? core.getSerialProfile(id) ?? core.getLocalShellProfile(id) ?? core.getLocalServer(id)
      ? "present"
      : "gone";
  const calls: string[] = [];

  // A crashed auto-restart profile has a timer waiting and no session: the
  // pending restart is modelled as state, so "left armed" is directly visible.
  const pendingRestarts = new Set(["ls-lab", "ls-sub", "ls-keep"]);
  const localServerManager = {
    cancelPendingRestart: vi.fn((id: string) => {
      calls.push(`cancelRestart:${id}:${present(id)}`);
      return pendingRestarts.delete(id);
    }),
    stopConfig: vi.fn(async (id: string, userInitiated?: boolean) => {
      calls.push(`stop:${id}:${present(id)}:${String(userInitiated)}`);
    })
  };

  const terminals = {
    srvLab: fakeTerminal(), srvKeep: fakeTerminal(),
    serLab: fakeTerminal(), serKeep: fakeTerminal(),
    shLab: fakeTerminal(), shKeep: fakeTerminal(),
    lsLab: fakeTerminal(), lsKeep: fakeTerminal()
  };

  let releaseTunnelStop = (): void => undefined;
  const tunnelGate = new Promise<void>((resolve) => { releaseTunnelStop = resolve; });
  let markTunnelStopStarted = (): void => undefined;
  const tunnelStopStarted = new Promise<void>((resolve) => { markTunnelStopStarted = resolve; });

  const vault = new Map<string, string>();
  for (const id of ["srv-lab", "srv-keep"]) {
    vault.set(passwordSecretKey(id), "pw");
    vault.set(passphraseSecretKey(id), "pp");
    vault.set(proxyPasswordSecretKey(id), "proxy");
  }

  const ctx = {
    core,
    terminalsByServer: new Map([
      ["srv-lab", new Set([terminals.srvLab])],
      ["srv-keep", new Set([terminals.srvKeep])]
    ]),
    serialTerminals: new Map([
      ["ser-session-lab", { terminal: terminals.serLab, profileId: "ser-lab" }],
      ["ser-session-keep", { terminal: terminals.serKeep, profileId: "ser-keep" }]
    ]),
    localShellTerminals: new Map([
      ["sh-session-lab", { terminal: terminals.shLab, profileId: "sh-lab" }],
      ["sh-session-keep", { terminal: terminals.shKeep, profileId: "sh-keep" }]
    ]),
    localServerTerminals: new Map([
      ["ls-session-lab", { terminal: terminals.lsLab, configId: "ls-lab" }],
      ["ls-session-keep", { terminal: terminals.lsKeep, configId: "ls-keep" }]
    ]),
    tunnelManager: {
      stop: vi.fn(async (id: string) => {
        calls.push(`stopTunnel:${id}`);
        if (id === options.gateTunnel) {
          markTunnelStopStarted();
          await tunnelGate;
        }
        if (id === options.rejectTunnel) {
          throw new Error("listener would not close");
        }
      })
    },
    sshPool: { disconnect: vi.fn((id: string) => { calls.push(`disconnectPool:${id}`); }) },
    secretVault: {
      get: vi.fn(async (key: string) => vault.get(key)),
      store: vi.fn(async (key: string, value: string) => { vault.set(key, value); }),
      delete: vi.fn(async (key: string) => { vault.delete(key); })
    },
    localServerManager
  };
  registerProfileCommands(ctx as never);
  return {
    core, repo, ctx, calls, pendingRestarts, localServerManager, terminals, vault,
    tunnelStopStarted, releaseTunnelStop
  };
}

/** A second server in Lab, with an open terminal and saved credentials. */
async function addSecondLabServer(f: Awaited<ReturnType<typeof fixture>>) {
  await f.core.addOrUpdateServer(server("srv-lab2", "Lab"));
  const terminal = fakeTerminal();
  f.ctx.terminalsByServer.set("srv-lab2", new Set([terminal]));
  f.vault.set(passwordSecretKey("srv-lab2"), "pw2");
  f.vault.set(passphraseSecretKey("srv-lab2"), "pp2");
  f.vault.set(proxyPasswordSecretKey("srv-lab2"), "proxy2");
  return terminal;
}

/** Lets every already-runnable continuation run: a few macrotask turns. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function removeFolder(folderPath: string): Promise<void> {
  await registeredCommands.get("nexus.group.remove")!(new FolderTreeItem(folderPath, folderPath));
}

beforeEach(() => {
  registeredCommands.clear();
  mockShowWarningMessage.mockReset();
  // Each test answers the modal with a Once value; anything after it (the
  // teardown-failure warning) is dismissed.
  mockShowWarningMessage.mockResolvedValue(undefined);
});

/** The teardown-failure warnings shown after the confirmation modal. */
function warningsAfterModal(): string[] {
  return mockShowWarningMessage.mock.calls.slice(1).map(([message]) => String(message));
}

describe("Remove Folder → Delete contents (#158)", () => {
  it("stops each Local Server in the subtree and calls off its pending restart BEFORE its profile is removed — and only those", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    await removeFolder("Lab");

    // ⊘ the pre-fix cascade: no call at all, the process outlives its profile.
    // ⊘ stopping after removeFolderCascade: these would read ":gone".
    // ⊘ a non-recursive walk: ls-sub (Lab/Sub) would be missing.
    for (const id of ["ls-lab", "ls-sub"]) {
      expect(f.calls).toContain(`cancelRestart:${id}:present`);
      expect(f.calls).toContain(`stop:${id}:present:true`);
    }
    // ⊘ calling manager.stopConfig directly instead of the shared helper: a
    // crashed server waiting out its back-off has no session to stop, so only
    // the cancel disarms its timer — which would otherwise respawn it if a
    // restore or import brought the same id back within the back-off.
    expect(f.pendingRestarts.has("ls-lab")).toBe(false);
    expect(f.pendingRestarts.has("ls-sub")).toBe(false);
    expect(f.terminals.lsLab.dispose).toHaveBeenCalledTimes(1);
    expect([...f.ctx.localServerTerminals.keys()]).toEqual(["ls-session-keep"]);

    // ⊘ stopping every Local Server: the one in Keep is not being deleted.
    expect(f.pendingRestarts.has("ls-keep")).toBe(true);
    expect(f.localServerManager.stopConfig).not.toHaveBeenCalledWith("ls-keep", expect.anything());
    expect(f.terminals.lsKeep.dispose).not.toHaveBeenCalled();

    expect(f.core.getLocalServer("ls-lab")).toBeUndefined();
    expect(f.core.getLocalServer("ls-sub")).toBeUndefined();
    expect(f.core.getLocalServer("ls-keep")).toBeDefined();
    expect((await f.repo.getLocalServers()).map((c) => c.id)).toEqual(["ls-keep"]);
  });

  it("closes the open sessions of the SSH, serial and Local Shell profiles it deletes, as their own Remove does, and leaves other folders' open", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    await removeFolder("Lab");

    // ⊘ the pre-fix cascade: every one of these terminals stayed open (and the
    // SSH one stayed connected, its tunnel still forwarding) with no profile
    // behind it.
    expect(f.terminals.srvLab.dispose).toHaveBeenCalledTimes(1);
    expect(f.calls).toContain("stopTunnel:tun-lab");
    expect(f.calls).toContain("disconnectPool:srv-lab");
    expect(f.ctx.terminalsByServer.has("srv-lab")).toBe(false);
    expect(f.terminals.serLab.dispose).toHaveBeenCalledTimes(1);
    expect([...f.ctx.serialTerminals.keys()]).toEqual(["ser-session-keep"]);
    expect(f.terminals.shLab.dispose).toHaveBeenCalledTimes(1);
    expect([...f.ctx.localShellTerminals.keys()]).toEqual(["sh-session-keep"]);

    // ⊘ tearing down by kind rather than by folder membership.
    expect(f.terminals.srvKeep.dispose).not.toHaveBeenCalled();
    expect(f.terminals.serKeep.dispose).not.toHaveBeenCalled();
    expect(f.terminals.shKeep.dispose).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("stopTunnel:tun-keep");
    expect(f.calls).not.toContain("disconnectPool:srv-keep");

    expect(f.core.getServer("srv-lab")).toBeUndefined();
    expect(f.core.getSerialProfile("ser-lab")).toBeUndefined();
    expect(f.core.getLocalShellProfile("sh-lab")).toBeUndefined();
  });

  it("deletes the saved credentials of the servers it deletes, as Remove Server does, and only theirs", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    await removeFolder("Lab");

    // ⊘ the pre-fix cascade: all three stayed in SecretStorage, orphaned.
    expect(f.vault.has(passwordSecretKey("srv-lab"))).toBe(false);
    expect(f.vault.has(passphraseSecretKey("srv-lab"))).toBe(false);
    expect(f.vault.has(proxyPasswordSecretKey("srv-lab"))).toBe(false);
    // ⊘ clearing by kind: the survivor keeps every credential.
    expect(f.vault.get(passwordSecretKey("srv-keep"))).toBe("pw");
    expect(f.vault.get(passphraseSecretKey("srv-keep"))).toBe("pp");
    expect(f.vault.get(proxyPasswordSecretKey("srv-keep"))).toBe("proxy");
  });

  it("says in the confirmation that Delete contents closes sessions and stops running Local Servers — naming Local Servers only when the folder has one", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValue(undefined);

    await removeFolder("Lab");
    const [message, options] = mockShowWarningMessage.mock.calls[0] as [string, { modal?: boolean; detail?: string }];
    expect(message).toBe('Remove folder "Lab"? It contains 5 item(s).');
    expect(options.modal).toBe(true);
    // ⊘ the pre-fix confirmation, which said nothing about either.
    expect(options.detail).toContain("closes their open sessions");
    expect(options.detail).toContain("stops their running local servers");

    // A folder with no Local Server gets no sentence about one.
    await f.core.removeLocalServerConfig("ls-keep");
    mockShowWarningMessage.mockClear();
    await removeFolder("Keep");
    const [, keepOptions] = mockShowWarningMessage.mock.calls[0] as [string, { detail?: string }];
    expect(keepOptions.detail).toContain("closes their open sessions");
    expect(keepOptions.detail).not.toMatch(/local server/i);
  });

  it("tears down exactly the servers it deleted: one edited into the folder while an SSH teardown waits is neither deleted without teardown nor torn down", async () => {
    // A server edit landing while teardownServerRuntime waits on a tunnel
    // stop. The lock is released by then, so any writer can; the tests write
    // straight to core so that a red run cannot wedge the shared lock.
    const f = await fixture({ gateTunnel: "tun-lab" });
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    const removing = removeFolder("Lab");
    await f.tunnelStopStarted;
    await f.core.addOrUpdateServer(server("srv-keep", "Lab"));
    f.releaseTunnelStop();
    await removing;

    // ⊘ SSH teardown BEFORE the cascade, from a membership read taken before
    // the wait: srv-keep, moved in during it, is deleted with its terminal
    // still open and its credentials still saved.
    const deleted = f.core.getServer("srv-keep") === undefined;
    expect(f.terminals.srvKeep.dispose).toHaveBeenCalledTimes(deleted ? 1 : 0);
    expect(f.vault.has(passwordSecretKey("srv-keep"))).toBe(!deleted);
    // …and the move itself stands: it landed after the cascade, into a folder
    // that is being deleted no longer.
    expect(f.core.getServer("srv-keep")?.group).toBe("Lab");
  });

  it("leaves a server re-created under the same id during its teardown connected", async () => {
    const f = await fixture({ gateTunnel: "tun-lab" });
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    const removing = removeFolder("Lab");
    await f.tunnelStopStarted;
    // An edit form still open on srv-lab saves it back under its id — the lock
    // is free while the teardown waits (see the test above on writing to core).
    await f.core.addOrUpdateServer(server("srv-lab", "Elsewhere"));
    f.releaseTunnelStop();
    await removing;

    // ⊘ no re-check after the wait: the live server's pooled connection is
    // dropped from under it. (Its credentials went before it came back — they
    // are deleted without waiting on the teardown; see the never-settling
    // stop test. One back before cleanup starts keeps them: the test below.)
    expect(f.core.getServer("srv-lab")).toBeDefined();
    expect(f.calls).not.toContain("disconnectPool:srv-lab");
  });

  it("skips a server re-created under the same id before its teardown starts: its terminals, tunnels and credentials are untouched", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");
    // Hold the cascade's persist open; the record is already out of memory.
    const saveServers = f.repo.saveServers.bind(f.repo);
    let releaseSave = (): void => undefined;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    let markSaveStarted = (): void => undefined;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    let gated = true;
    f.repo.saveServers = async (servers) => {
      if (gated) {
        gated = false;
        markSaveStarted();
        await saveGate;
      }
      await saveServers(servers);
    };

    const removing = removeFolder("Lab");
    await saveStarted;
    // Only a writer that skips configMutationLock can land here — none does
    // today, but the lock is a convention, not an invariant. The same check
    // covers the commonplace case: an edit saved after the lock is released
    // and before this server's turn.
    await f.core.addOrUpdateServer(server("srv-lab", "Elsewhere"));
    releaseSave();
    await removing;

    // ⊘ no pre-teardown re-check: teardownServerRuntime would close the live
    // server's terminal and stop its tunnel before `shouldAbort` is ever asked.
    expect(f.core.getServer("srv-lab")?.group).toBe("Elsewhere");
    expect(f.terminals.srvLab.dispose).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("stopTunnel:tun-lab");
    expect(f.vault.get(passwordSecretKey("srv-lab"))).toBe("pw");
  });

  it("carries on past a server whose teardown fails — the next server is still torn down and its credentials deleted — and says so once", async () => {
    const f = await fixture({ rejectTunnel: "tun-lab" });
    const lab2Terminal = await addSecondLabServer(f);
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    // ⊘ an uncontained rejection (an unguarded await, or Promise.all): it
    // escapes, srv-lab2 may keep its terminal and credentials, and the
    // command rejects with nothing shown.
    await expect(removeFolder("Lab")).resolves.toBeUndefined();

    expect(f.calls).toContain("stopTunnel:tun-lab");
    expect(lab2Terminal.dispose).toHaveBeenCalledTimes(1);
    expect(f.calls).toContain("disconnectPool:srv-lab2");
    expect(f.vault.has(passwordSecretKey("srv-lab2"))).toBe(false);
    expect(f.vault.has(passphraseSecretKey("srv-lab2"))).toBe(false);
    expect(f.vault.has(proxyPasswordSecretKey("srv-lab2"))).toBe(false);
    // The failed one's record is gone, so its credentials go too.
    expect(f.vault.has(passwordSecretKey("srv-lab"))).toBe(false);

    const warnings = warningsAfterModal();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 of its servers did not disconnect cleanly");
    expect(mockShowWarningMessage.mock.calls[1]).toContain("Reload Window");
  });

  it("does not let a server whose tunnel stop never settles hold up the others: the next is still torn down, and both lose their credentials", async () => {
    const f = await fixture({ gateTunnel: "tun-lab" });
    const lab2Terminal = await addSecondLabServer(f);
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    const removing = removeFolder("Lab");
    try {
      await f.tunnelStopStarted;
      await drain();

      // ⊘ one server at a time (fb34dc5), whatever the order of its two
      // steps: srv-lab2 waits behind srv-lab's stop forever.
      expect(lab2Terminal.dispose).toHaveBeenCalledTimes(1);
      expect(f.calls).toContain("disconnectPool:srv-lab2");
      expect(f.vault.has(passwordSecretKey("srv-lab2"))).toBe(false);
      // ⊘ credentials deleted after the teardown, even concurrently: srv-lab's
      // stay saved for as long as its stop hangs.
      expect(f.vault.has(passwordSecretKey("srv-lab"))).toBe(false);
      expect(f.vault.has(passphraseSecretKey("srv-lab"))).toBe(false);
      expect(f.vault.has(proxyPasswordSecretKey("srv-lab"))).toBe(false);
    } finally {
      f.releaseTunnelStop();
      await removing;
    }
  });

  it("reports within a bound when a teardown never settles, counting the unfinished server", async () => {
    const f = await fixture({ gateTunnel: "tun-lab" }); // never released
    await addSecondLabServer(f);
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      void removeFolder("Lab").then(() => { settled = true; });
      await f.tunnelStopStarted;
      await vi.advanceTimersByTimeAsync(FOLDER_TEARDOWN_REPORT_MS);

      // ⊘ waiting for every teardown to settle (Promise.allSettled unbounded,
      // or fb34dc5's loop): the command never finishes and nothing is shown.
      expect(settled).toBe(true);
      const warnings = warningsAfterModal();
      expect(warnings).toHaveLength(1);
      // ⊘ counting only rejections: a hung stop is not a clean disconnect.
      expect(warnings[0]).toContain("1 of its servers did not disconnect cleanly");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no teardown warning when every server disconnects", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    await removeFolder("Lab");

    expect(f.core.getServer("srv-lab")).toBeUndefined();
    // ⊘ warning unconditionally.
    expect(warningsAfterModal()).toEqual([]);
  });

  it("does not hold configMutationLock while a server's teardown waits on the network", async () => {
    // A reverse tunnel's stop awaits the SSH peer (cancelForwardIn); a slow
    // or stuck peer must not queue every other edit, sync, import and removal
    // behind this delete.
    const f = await fixture({ gateTunnel: "tun-lab" });
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");

    const removing = removeFolder("Lab");
    await f.tunnelStopStarted;
    const acquired = configMutationLock.runExclusive(async () => "acquired");
    const timedOut = new Promise((resolve) => setTimeout(() => resolve("still held"), 200));
    let outcome: unknown;
    try {
      outcome = await Promise.race([acquired, timedOut]);
    } finally {
      // Released either way, so a red run does not wedge the shared lock for
      // every test after it.
      f.releaseTunnelStop();
      await removing;
      await acquired;
    }

    // ⊘ SSH teardown inside the locked section (4d48022): the lock is held
    // until the tunnel stop resolves, which here is never.
    expect(outcome).toBe("acquired");
    // The records went under the lock, before the wait.
    expect(f.core.getServer("srv-lab")).toBeUndefined();
    expect(f.calls).toContain("disconnectPool:srv-lab");
  });

  it("still tears down and deletes the credentials of the servers it removed when a save other than the server list fails, then reports the failure", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");
    // One of the cascade's saves fails after it has already removed the
    // records from memory — they are gone from the tree either way, and the
    // server list itself did reach storage.
    f.repo.saveGroups = async () => { throw new Error("disk full"); };

    // ⊘ dropping the error: the command must still fail the way it did.
    await expect(removeFolder("Lab")).rejects.toThrow("disk full");

    expect(f.core.getServer("srv-lab")).toBeUndefined();
    // ⊘ cleanup that only runs once the cascade resolves (4d48022): these
    // servers are orphaned — still connected, credentials still saved.
    expect(f.terminals.srvLab.dispose).toHaveBeenCalledTimes(1);
    expect(f.calls).toContain("stopTunnel:tun-lab");
    expect(f.calls).toContain("disconnectPool:srv-lab");
    // ⊘ keeping credentials on any save failure: the deletion is on disk, so
    // these would be orphans.
    expect(f.vault.has(passwordSecretKey("srv-lab"))).toBe(false);
    // ⊘ falling back to every server: the survivor is untouched.
    expect(f.terminals.srvKeep.dispose).not.toHaveBeenCalled();
    expect(f.vault.get(passwordSecretKey("srv-keep"))).toBe("pw");
  });

  it("keeps the credentials of the servers it removed when the server list itself fails to save — but still tears their runtime down and reports the failure", async () => {
    const f = await fixture();
    mockShowWarningMessage.mockResolvedValueOnce("Delete contents");
    // The deletion never reached storage: after a restart srv-lab is back,
    // at the same address, and would need its saved credentials.
    f.repo.saveServers = async () => { throw new Error("disk full"); };

    await expect(removeFolder("Lab")).rejects.toThrow("disk full");

    // ⊘ deleting on any save failure (e180748): srv-lab comes back after a
    // restart with no password, passphrase or proxy password.
    expect(f.vault.get(passwordSecretKey("srv-lab"))).toBe("pw");
    expect(f.vault.get(passphraseSecretKey("srv-lab"))).toBe("pp");
    expect(f.vault.get(proxyPasswordSecretKey("srv-lab"))).toBe("proxy");
    // ⊘ skipping all cleanup on this failure: the record is out of memory
    // already, so a session left open would have no row to close it from.
    expect(f.core.getServer("srv-lab")).toBeUndefined();
    expect(f.terminals.srvLab.dispose).toHaveBeenCalledTimes(1);
    expect(f.calls).toContain("stopTunnel:tun-lab");
    expect(f.calls).toContain("disconnectPool:srv-lab");
  });

  it("stops and closes nothing on Move to parent or when the confirmation is dismissed", async () => {
    // ⊘ a teardown hoisted above the choice.
    for (const choice of [undefined, "Move to parent"]) {
      const f = await fixture();
      mockShowWarningMessage.mockResolvedValueOnce(choice);

      await removeFolder("Lab");

      expect(f.localServerManager.cancelPendingRestart).not.toHaveBeenCalled();
      expect(f.localServerManager.stopConfig).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
      expect(f.pendingRestarts.size).toBe(3);
      expect(f.vault.size).toBe(6);
      expect(f.core.getLocalServer("ls-lab")).toBeDefined();
    }
  });
});
