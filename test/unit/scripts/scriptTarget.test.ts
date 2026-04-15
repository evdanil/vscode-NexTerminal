import { describe, expect, it, vi } from "vitest";

const quickPickCalls: Array<{ items: Array<{ label: string; sessionId?: string }>; placeHolder?: string }> = [];
let pickBySessionId: string | undefined;

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
    )
  }
}));

import { pickTarget } from "../../../src/services/scripts/scriptTarget";
import type { ScriptTargetDescriptor } from "../../../src/services/scripts/scriptTarget";

function resetPicker(): void {
  quickPickCalls.length = 0;
  pickBySessionId = undefined;
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
  activeSessions: Array<{ id: string; serverId: string; terminalName: string }>;
  activeSerialSessions: Array<{ id: string; profileId: string; terminalName: string }>;
  servers: Array<{ id: string; name: string }>;
  serialProfiles: Array<{ id: string; name: string }>;
}

function makeCore(snapshot: MockSnapshot): Parameters<typeof pickTarget>[1] {
  return {
    getSnapshot: () => snapshot
  } as unknown as Parameters<typeof pickTarget>[1];
}

describe("scriptTarget / pickTarget", () => {
  it("returns undefined when no sessions match the targetType", async () => {
    resetPicker();
    const core = makeCore({
      activeSessions: [],
      activeSerialSessions: [{ id: "s1", profileId: "p1", terminalName: "serial-A" }],
      servers: [],
      serialProfiles: [{ id: "p1", name: "A" }]
    });
    const result = await pickTarget(makeDescriptor({ targetType: "ssh" }), core);
    expect(result).toBeUndefined();
  });

  it("auto-picks when exactly one session matches (ssh)", async () => {
    resetPicker();
    const core = makeCore({
      activeSessions: [{ id: "ssh1", serverId: "srv1", terminalName: "web-server-1" }],
      activeSerialSessions: [],
      servers: [{ id: "srv1", name: "Web" }],
      serialProfiles: []
    });
    const result = await pickTarget(makeDescriptor({ targetType: "ssh" }), core);
    expect(result?.id).toBe("ssh1");
    expect(quickPickCalls).toHaveLength(0);
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
      servers: [{ id: "srv1", name: "web" }],
      serialProfiles: [{ id: "p1", name: "A" }]
    });
    await pickTarget(makeDescriptor({ targetType: undefined }), core);
    expect(quickPickCalls[0].items).toHaveLength(2);
  });
});
