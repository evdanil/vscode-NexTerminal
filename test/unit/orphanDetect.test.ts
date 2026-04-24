import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { detectOrphanNexusTerminals } from "../../src/services/terminal/orphanDetect";

function makeTerminal(name: string): vscode.Terminal & { dispose: ReturnType<typeof vi.fn> } {
  return { name, dispose: vi.fn() } as unknown as vscode.Terminal & { dispose: ReturnType<typeof vi.fn> };
}

describe("detectOrphanNexusTerminals", () => {
  it("reports tabs matching all three Nexus naming patterns without closing them", () => {
    const ssh = makeTerminal("Nexus SSH: prod-web-01");
    const serial = makeTerminal("Nexus Serial: COM3");
    const smart = makeTerminal("Nexus Serial: Cisco Console [Smart Follow]");
    const result = detectOrphanNexusTerminals([ssh, serial, smart]);

    expect(result.count).toBe(3);
    expect(result.names).toEqual([
      "Nexus SSH: prod-web-01",
      "Nexus Serial: COM3",
      "Nexus Serial: Cisco Console [Smart Follow]"
    ]);
    // Tabs must be left intact — content belongs to the user.
    expect(ssh.dispose).not.toHaveBeenCalled();
    expect(serial.dispose).not.toHaveBeenCalled();
    expect(smart.dispose).not.toHaveBeenCalled();
  });

  it("handles activity-indicator and [Disconnected] / [Stopped] suffix variants", () => {
    const activity = makeTerminal("● Nexus SSH: prod");
    const disconnected = makeTerminal("Nexus SSH: prod [Disconnected]");
    const stopped = makeTerminal("Nexus Serial: Cisco Console [Smart Follow] [Stopped]");
    const result = detectOrphanNexusTerminals([activity, disconnected, stopped]);

    expect(result.count).toBe(3);
    expect(activity.dispose).not.toHaveBeenCalled();
    expect(disconnected.dispose).not.toHaveBeenCalled();
    expect(stopped.dispose).not.toHaveBeenCalled();
  });

  it("leaves non-Nexus terminals untouched and unreported", () => {
    const bash = makeTerminal("bash");
    const zsh = makeTerminal("zsh");
    const custom = makeTerminal("My Custom Terminal");
    const result = detectOrphanNexusTerminals([bash, zsh, custom]);

    expect(result.count).toBe(0);
    expect(result.names).toEqual([]);
    expect(bash.dispose).not.toHaveBeenCalled();
    expect(zsh.dispose).not.toHaveBeenCalled();
    expect(custom.dispose).not.toHaveBeenCalled();
  });

  it("does not false-match strings that merely mention 'Nexus' without the PTY-name format", () => {
    // Guard against future renames or unrelated extensions.
    const similar = makeTerminal("Nexus");
    const nearby = makeTerminal("Nexus Script Runner");
    const result = detectOrphanNexusTerminals([similar, nearby]);

    expect(result.count).toBe(0);
    expect(similar.dispose).not.toHaveBeenCalled();
    expect(nearby.dispose).not.toHaveBeenCalled();
  });

  it("returns zero when the terminals array is empty", () => {
    const result = detectOrphanNexusTerminals([]);
    expect(result.count).toBe(0);
    expect(result.names).toEqual([]);
  });

  it("never calls dispose — detection is strictly read-only", () => {
    const many = [
      makeTerminal("Nexus SSH: a"),
      makeTerminal("Nexus SSH: b"),
      makeTerminal("Nexus Serial: c"),
      makeTerminal("Nexus Serial: d [Smart Follow]"),
      makeTerminal("bash")
    ];
    detectOrphanNexusTerminals(many);
    for (const t of many) {
      expect(t.dispose).not.toHaveBeenCalled();
    }
  });
});
