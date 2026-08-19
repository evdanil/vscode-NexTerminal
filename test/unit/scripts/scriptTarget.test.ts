import { describe, expect, it, vi } from "vitest";

const quickPickCalls: Array<{ items: Array<{ label: string; sessionId?: string }>; placeHolder?: string }> = [];
let pickBySessionId: string | undefined;

const errorMessages: string[] = [];

vi.mock("vscode", () => ({
  EventEmitter: class {
    public event = () => ({ dispose() {} });
    public fire(): void {}
    public dispose(): void {}
  },
  window: {
    showQuickPick: vi.fn(
      (items: Array<{ label: string; sessionId: string }>, opts?: { placeHolder?: string }) => {
        quickPickCalls.push({ items, placeHolder: opts?.placeHolder });
        if (pickBySessionId === undefined) return Promise.resolve(undefined);
        const found = items.find((i) => i.sessionId === pickBySessionId);
        return Promise.resolve(found);
      }
    ),
    showErrorMessage: vi.fn((msg: string) => {
      errorMessages.push(msg);
      return Promise.resolve(undefined);
    })
  }
}));

import { pickTarget } from "../../../src/services/scripts/scriptTarget";
import type { ScriptTargetDescriptor } from "../../../src/services/scripts/scriptTarget";

function resetPicker(): void {
  quickPickCalls.length = 0;
  pickBySessionId = undefined;
  errorMessages.length = 0;
}

function makeDescriptor(overrides: Partial<ScriptTargetDescriptor> = {}): ScriptTargetDescriptor {
  return {
    displayName: "My Script",
    targetType: undefined,
    targetProfile: undefined,
    ...overrides
  };
}

interface MockSnapshot {
  activeSessions: Array<{ id: string; serverId: string; terminalName: string; protocol?: "ssh" | "telnet" }>;
  activeSerialSessions: Array<{ id: string; profileId: string; terminalName: string }>;
  activeLocalShellSessions?: Array<{ id: string; profileId: string; terminalName: string }>;
  servers: Array<{ id: string; name: string; protocol?: "ssh" | "telnet" }>;
  serialProfiles: Array<{ id: string; name: string }>;
  localShellProfiles?: Array<{ id: string; name: string }>;
}

function makeCore(snapshot: MockSnapshot): Parameters<typeof pickTarget>[1] {
  return {
    getSnapshot: () => snapshot
  } as unknown as Parameters<typeof pickTarget>[1];
}

describe("scriptTarget / pickTarget", () => {
  it("returns undefined AND surfaces a user-visible error when no sessions match the targetType", async () => {
    resetPicker();
    const core = makeCore({
      activeSessions: [],
      activeSerialSessions: [{ id: "s1", profileId: "p1", terminalName: "serial-A" }],
      servers: [],
      serialProfiles: [{ id: "p1", name: "A" }]
    });
    const result = await pickTarget(makeDescriptor({ targetType: "ssh" }), core);
    expect(result).toBeUndefined();
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toMatch(/no active ssh sessions/i);
  });

  it("shows the QuickPick even when exactly one session matches — so the user knows what they're binding to", async () => {
    resetPicker();
    pickBySessionId = "ssh1";
    const core = makeCore({
      activeSessions: [{ id: "ssh1", serverId: "srv1", terminalName: "web-server-1" }],
      activeSerialSessions: [],
      servers: [{ id: "srv1", name: "Web" }],
      serialProfiles: []
    });
    const result = await pickTarget(makeDescriptor({ targetType: "ssh" }), core);
    expect(result?.id).toBe("ssh1");
    // Picker IS shown (prior behaviour auto-picked silently — confusing when the
    // terminal the script drives isn't visible to the user).
    expect(quickPickCalls).toHaveLength(1);
    expect(quickPickCalls[0].items).toHaveLength(1);
  });

  it("filters by targetType serial", async () => {
    resetPicker();
    pickBySessionId = "ser1";
    const core = makeCore({
      activeSessions: [{ id: "ssh1", serverId: "srv1", terminalName: "web" }],
      activeSerialSessions: [
        { id: "ser1", profileId: "p1", terminalName: "serial-A" },
        { id: "ser2", profileId: "p2", terminalName: "serial-B" }
      ],
      servers: [{ id: "srv1", name: "Web" }],
      serialProfiles: [
        { id: "p1", name: "A" },
        { id: "p2", name: "B" }
      ]
    });
    const result = await pickTarget(makeDescriptor({ targetType: "serial" }), core);
    expect(result?.id).toBe("ser1");
    expect(quickPickCalls).toHaveLength(1);
    expect(quickPickCalls[0].items).toHaveLength(2);
    expect(quickPickCalls[0].items.every((i) => i.label.includes("serial"))).toBe(true);
  });

  it("filters by targetType local and includes Local Shell candidates", async () => {
    resetPicker();
    pickBySessionId = "local1";
    const core = makeCore({
      activeSessions: [{ id: "ssh1", serverId: "srv1", terminalName: "web" }],
      activeSerialSessions: [{ id: "ser1", profileId: "p1", terminalName: "serial-A" }],
      activeLocalShellSessions: [
        { id: "local1", profileId: "local-profile", terminalName: "Nexus Local Shell: Dev" }
      ],
      servers: [{ id: "srv1", name: "Web" }],
      serialProfiles: [{ id: "p1", name: "A" }],
      localShellProfiles: [{ id: "local-profile", name: "Dev" }]
    });
    const result = await pickTarget(makeDescriptor({ targetType: "local" }), core);
    expect(result?.id).toBe("local1");
    expect(quickPickCalls).toHaveLength(1);
    expect(quickPickCalls[0].items).toHaveLength(1);
    expect(quickPickCalls[0].items[0].label).toContain("Nexus Local Shell");
  });

  it("pre-selects matching targetProfile when active (auto-picks without showing the picker)", async () => {
    resetPicker();
    const core = makeCore({
      activeSessions: [],
      activeSerialSessions: [
        { id: "ser1", profileId: "p1", terminalName: "serial-A" },
        { id: "ser2", profileId: "p2", terminalName: "serial-B" }
      ],
      servers: [],
      serialProfiles: [
        { id: "p1", name: "lab-router-a" },
        { id: "p2", name: "lab-router-b" }
      ]
    });
    const result = await pickTarget(makeDescriptor({ targetType: "serial", targetProfile: "lab-router-a" }), core);
    expect(result?.id).toBe("ser1");
    expect(quickPickCalls).toHaveLength(0); // pre-select short-circuits the picker
  });

  it("when targetProfile does not match any active session, falls back to showing picker", async () => {
    resetPicker();
    pickBySessionId = "ssh1";
    const core = makeCore({
      activeSessions: [
        { id: "ssh1", serverId: "srv1", terminalName: "web-server-1" },
        { id: "ssh2", serverId: "srv2", terminalName: "db-server-1" }
      ],
      activeSerialSessions: [],
      servers: [
        { id: "srv1", name: "web" },
        { id: "srv2", name: "db" }
      ],
      serialProfiles: []
    });
    const result = await pickTarget(
      makeDescriptor({ targetType: "ssh", targetProfile: "nonexistent" }),
      core
    );
    expect(result?.id).toBe("ssh1");
    expect(quickPickCalls).toHaveLength(1);
  });

  it("combines SSH and serial sessions when targetType is undefined", async () => {
    resetPicker();
    pickBySessionId = "ssh1";
    const core = makeCore({
      activeSessions: [{ id: "ssh1", serverId: "srv1", terminalName: "web-1" }],
      activeSerialSessions: [{ id: "ser1", profileId: "p1", terminalName: "serial-A" }],
      activeLocalShellSessions: [{ id: "local1", profileId: "local-profile", terminalName: "local-A" }],
      servers: [{ id: "srv1", name: "web" }],
      serialProfiles: [{ id: "p1", name: "A" }],
      localShellProfiles: [{ id: "local-profile", name: "Local" }]
    });
    await pickTarget(makeDescriptor({ targetType: undefined }), core);
    expect(quickPickCalls[0].items).toHaveLength(3);
  });

  it("matches @target-profile by server id before falling back to name", async () => {
    resetPicker();
    const core = makeCore({
      activeSessions: [
        { id: "ssh1", serverId: "srv-alpha", terminalName: "t1" },
        { id: "ssh2", serverId: "srv-bravo", terminalName: "t2" }
      ],
      activeSerialSessions: [],
      servers: [
        { id: "srv-alpha", name: "shared-name" },
        { id: "srv-bravo", name: "shared-name" }
      ],
      serialProfiles: []
    });
    // `srv-bravo` is an exact id match — should auto-pick without QuickPick even though two
    // sessions share the same name "shared-name".
    const result = await pickTarget(
      makeDescriptor({ targetType: "ssh", targetProfile: "srv-bravo" }),
      core
    );
    expect(result?.id).toBe("ssh2");
    expect(quickPickCalls).toHaveLength(0);
  });

  it("surfaces QuickPick when @target-profile name matches multiple active sessions", async () => {
    resetPicker();
    pickBySessionId = "ssh2";
    const core = makeCore({
      activeSessions: [
        { id: "ssh1", serverId: "srv1", terminalName: "edge-a" },
        { id: "ssh2", serverId: "srv2", terminalName: "edge-b" }
      ],
      activeSerialSessions: [],
      // Two servers share the exact same `name`. Script says @target-profile "router"
      // → ambiguous — show the picker narrowed to the two matches.
      servers: [
        { id: "srv1", name: "router" },
        { id: "srv2", name: "router" }
      ],
      serialProfiles: []
    });
    const result = await pickTarget(
      makeDescriptor({ targetType: "ssh", targetProfile: "router" }),
      core
    );
    expect(result?.id).toBe("ssh2");
    expect(quickPickCalls).toHaveLength(1);
    // The picker should only contain the ambiguous matches, not all sessions.
    expect(quickPickCalls[0].items).toHaveLength(2);
  });

  it("still auto-picks a single name match when there are multiple eligible sessions overall", async () => {
    resetPicker();
    const core = makeCore({
      activeSessions: [
        { id: "ssh1", serverId: "srv1", terminalName: "t1" },
        { id: "ssh2", serverId: "srv2", terminalName: "t2" }
      ],
      activeSerialSessions: [],
      servers: [
        { id: "srv1", name: "unique-name" },
        { id: "srv2", name: "other" }
      ],
      serialProfiles: []
    });
    const result = await pickTarget(
      makeDescriptor({ targetType: "ssh", targetProfile: "unique-name" }),
      core
    );
    expect(result?.id).toBe("ssh1");
    expect(quickPickCalls).toHaveLength(0);
  });

  it("matches @target-profile against Local Shell profile id and name, disambiguating duplicate names", async () => {
    resetPicker();
    pickBySessionId = "local2";
    const core = makeCore({
      activeSessions: [],
      activeSerialSessions: [],
      activeLocalShellSessions: [
        { id: "local1", profileId: "local-a", terminalName: "local-a" },
        { id: "local2", profileId: "local-b", terminalName: "local-b" }
      ],
      servers: [],
      serialProfiles: [],
      localShellProfiles: [
        { id: "local-a", name: "Dev" },
        { id: "local-b", name: "Dev" }
      ]
    });

    const byId = await pickTarget(makeDescriptor({ targetType: "local", targetProfile: "local-b" }), core);
    expect(byId?.id).toBe("local2");
    expect(quickPickCalls).toHaveLength(0);

    const byDuplicateName = await pickTarget(makeDescriptor({ targetType: "local", targetProfile: "Dev" }), core);
    expect(byDuplicateName?.id).toBe("local2");
    expect(quickPickCalls).toHaveLength(1);
    expect(quickPickCalls[0].items).toHaveLength(2);
  });
});

describe("pickTarget — telnet sessions", () => {
  /**
   * TELNET (Phase 0) — a telnet session is an `ActiveSession` exactly like an
   * SSH one; the ONLY thing separating them is the protocol on the server the
   * session names. That is what makes these fixtures discriminating: a filter
   * that keys off the collection (which is all it could do before) puts both
   * sessions in both buckets and every assertion below fails.
   */
  const snapshot: MockSnapshot = {
    activeSessions: [
      { id: "ssh-1", serverId: "srv-ssh", terminalName: "Nexus SSH: prod" },
      { id: "tel-1", serverId: "srv-tel", terminalName: "Nexus Telnet: eve-r1" }
    ],
    activeSerialSessions: [],
    activeLocalShellSessions: [],
    servers: [
      { id: "srv-ssh", name: "prod" },
      { id: "srv-tel", name: "eve-r1", protocol: "telnet" }
    ],
    serialProfiles: [],
    localShellProfiles: []
  };

  it("offers only telnet sessions for @target-type telnet", async () => {
    resetPicker();
    pickBySessionId = "tel-1";
    const picked = await pickTarget(makeDescriptor({ targetType: "telnet" }), makeCore(snapshot));

    expect(picked?.id).toBe("tel-1");
    expect(quickPickCalls[0].items.map((i) => i.sessionId)).toEqual(["tel-1"]);
  });

  it("excludes telnet sessions from @target-type ssh", async () => {
    resetPicker();
    pickBySessionId = "ssh-1";
    await pickTarget(makeDescriptor({ targetType: "ssh" }), makeCore(snapshot));

    expect(quickPickCalls[0].items.map((i) => i.sessionId)).toEqual(["ssh-1"]);
  });

  it("offers both when no target type is declared", async () => {
    resetPicker();
    pickBySessionId = "tel-1";
    await pickTarget(makeDescriptor(), makeCore(snapshot));

    expect(quickPickCalls[0].items.map((i) => i.sessionId)).toEqual(["ssh-1", "tel-1"]);
  });

  it("labels a telnet candidate as Telnet", async () => {
    resetPicker();
    pickBySessionId = "tel-1";
    await pickTarget(makeDescriptor({ targetType: "telnet" }), makeCore(snapshot));

    expect(quickPickCalls[0].items[0]).toEqual(
      expect.objectContaining({ description: "Telnet • eve-r1" })
    );
  });

  // ⊘ MINOR-6 (review) — the picked item's `targetKind` must come from the
  // server's protocol, not from parsing the description string. Pinning it here
  // is what stops a reworded picker label from silently reclassifying every
  // telnet session as SSH.
  it("tags each candidate with the protocol it was classified by", async () => {
    resetPicker();
    pickBySessionId = "tel-1";
    await pickTarget(makeDescriptor(), makeCore(snapshot));

    const items = quickPickCalls[0].items as Array<{ sessionId: string; targetKind: string }>;
    expect(items.find((i) => i.sessionId === "ssh-1")?.targetKind).toBe("ssh");
    expect(items.find((i) => i.sessionId === "tel-1")?.targetKind).toBe("telnet");
  });

  it("tags a name-disambiguation candidate by protocol too", async () => {
    resetPicker();
    // Two sessions sharing a server NAME across protocols force the narrowed
    // picker, which is the other place the kind was derived from display copy.
    const shared: MockSnapshot = {
      ...snapshot,
      activeSessions: [
        { id: "ssh-1", serverId: "srv-ssh", terminalName: "Nexus SSH: edge" },
        { id: "tel-1", serverId: "srv-tel", terminalName: "Nexus Telnet: edge" }
      ],
      servers: [
        { id: "srv-ssh", name: "edge" },
        { id: "srv-tel", name: "edge", protocol: "telnet" }
      ]
    };
    pickBySessionId = "tel-1";
    await pickTarget(makeDescriptor({ targetProfile: "edge" }), makeCore(shared));

    const items = quickPickCalls[0].items as Array<{ sessionId: string; targetKind: string }>;
    expect(items.find((i) => i.sessionId === "ssh-1")?.targetKind).toBe("ssh");
    expect(items.find((i) => i.sessionId === "tel-1")?.targetKind).toBe("telnet");
  });

  it("auto-picks a telnet session by server name", async () => {
    resetPicker();
    const picked = await pickTarget(
      makeDescriptor({ targetType: "telnet", targetProfile: "eve-r1" }),
      makeCore(snapshot)
    );
    expect(picked?.id).toBe("tel-1");
    expect(quickPickCalls).toHaveLength(0);
  });

  it("reports the absence of telnet sessions in the message the user sees", async () => {
    resetPicker();
    await pickTarget(
      makeDescriptor({ targetType: "telnet" }),
      makeCore({ ...snapshot, activeSessions: [snapshot.activeSessions[0]] })
    );
    expect(errorMessages.join("\n")).toContain("Telnet");
  });
});

/**
 * P1-B (Codex) — a session's transport is fixed the moment it opens. Editing
 * the server's Protocol afterwards must not reclassify a terminal that is
 * already connected: the open SSH terminal is still speaking SSH, and offering
 * it to a `@target-type telnet` script sends automation down the wrong
 * transport (and vice versa).
 */
describe("pickTarget — classification follows the SESSION, not the live config", () => {
  // ⊘ The config says telnet, the session says ssh. An implementation that
  // reads `snapshot.servers[…].protocol` classifies this session as telnet and
  // both assertions below flip.
  it("keeps an SSH session SSH after its server is flipped to telnet", async () => {
    resetPicker();
    const snapshot: MockSnapshot = {
      activeSessions: [{ id: "ssh-1", serverId: "srv-1", terminalName: "Nexus SSH: edge", protocol: "ssh" }],
      activeSerialSessions: [],
      activeLocalShellSessions: [],
      // The user edited the profile while the terminal stayed open.
      servers: [{ id: "srv-1", name: "edge", protocol: "telnet" }],
      serialProfiles: [],
      localShellProfiles: []
    };

    pickBySessionId = "ssh-1";
    expect((await pickTarget(makeDescriptor({ targetType: "ssh" }), makeCore(snapshot)))?.id).toBe("ssh-1");

    resetPicker();
    await pickTarget(makeDescriptor({ targetType: "telnet" }), makeCore(snapshot));
    expect(quickPickCalls).toHaveLength(0);
    expect(errorMessages.join("\n")).toContain("Telnet");
  });

  it("keeps a telnet session telnet after its server is flipped to SSH", async () => {
    resetPicker();
    const snapshot: MockSnapshot = {
      activeSessions: [{ id: "tel-1", serverId: "srv-1", terminalName: "Nexus Telnet: edge", protocol: "telnet" }],
      activeSerialSessions: [],
      activeLocalShellSessions: [],
      servers: [{ id: "srv-1", name: "edge" }],
      serialProfiles: [],
      localShellProfiles: []
    };

    pickBySessionId = "tel-1";
    expect((await pickTarget(makeDescriptor({ targetType: "telnet" }), makeCore(snapshot)))?.id).toBe("tel-1");

    resetPicker();
    await pickTarget(makeDescriptor({ targetType: "ssh" }), makeCore(snapshot));
    expect(quickPickCalls).toHaveLength(0);
  });

  // Back-compat: a session registered without the field falls back to the
  // server's configured protocol — today's behaviour for anything that has not
  // been taught to stamp it.
  it("falls back to the server's protocol when the session carries none", async () => {
    resetPicker();
    const snapshot: MockSnapshot = {
      activeSessions: [{ id: "tel-1", serverId: "srv-1", terminalName: "Nexus Telnet: edge" }],
      activeSerialSessions: [],
      activeLocalShellSessions: [],
      servers: [{ id: "srv-1", name: "edge", protocol: "telnet" }],
      serialProfiles: [],
      localShellProfiles: []
    };
    pickBySessionId = "tel-1";
    expect((await pickTarget(makeDescriptor({ targetType: "telnet" }), makeCore(snapshot)))?.id).toBe("tel-1");
  });
});
