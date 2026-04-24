import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { sweepOrphanNexusTerminals } from "../../src/services/terminal/orphanSweep";

function makeTerminal(name: string): vscode.Terminal & { dispose: ReturnType<typeof vi.fn> } {
  return { name, dispose: vi.fn() } as unknown as vscode.Terminal & { dispose: ReturnType<typeof vi.fn> };
}

describe("sweepOrphanNexusTerminals", () => {
  it("disposes tabs matching all three Nexus naming patterns", () => {
    const ssh = makeTerminal("Nexus SSH: prod-web-01");
    const serial = makeTerminal("Nexus Serial: COM3");
    const smart = makeTerminal("Nexus Serial: Cisco Console [Smart Follow]");
    const result = sweepOrphanNexusTerminals([ssh, serial, smart]);

    expect(result.count).toBe(3);
    expect(result.names).toEqual([
      "Nexus SSH: prod-web-01",
      "Nexus Serial: COM3",
      "Nexus Serial: Cisco Console [Smart Follow]"
    ]);
    expect(ssh.dispose).toHaveBeenCalledTimes(1);
    expect(serial.dispose).toHaveBeenCalledTimes(1);
    expect(smart.dispose).toHaveBeenCalledTimes(1);
  });

  it("handles activity-indicator and [Disconnected] / [Stopped] suffix variants", () => {
    const activity = makeTerminal("● Nexus SSH: prod");
    const disconnected = makeTerminal("Nexus SSH: prod [Disconnected]");
    const stopped = makeTerminal("Nexus Serial: Cisco Console [Smart Follow] [Stopped]");
    const result = sweepOrphanNexusTerminals([activity, disconnected, stopped]);

    expect(result.count).toBe(3);
    expect(activity.dispose).toHaveBeenCalled();
    expect(disconnected.dispose).toHaveBeenCalled();
    expect(stopped.dispose).toHaveBeenCalled();
  });

  it("leaves non-Nexus terminals untouched", () => {
    const bash = makeTerminal("bash");
    const zsh = makeTerminal("zsh");
    const custom = makeTerminal("My Custom Terminal");
    const result = sweepOrphanNexusTerminals([bash, zsh, custom]);

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
    const result = sweepOrphanNexusTerminals([similar, nearby]);

    expect(result.count).toBe(0);
    expect(similar.dispose).not.toHaveBeenCalled();
    expect(nearby.dispose).not.toHaveBeenCalled();
  });

  it("returns zero when the terminals array is empty", () => {
    const result = sweepOrphanNexusTerminals([]);
    expect(result.count).toBe(0);
    expect(result.names).toEqual([]);
  });

  it("tolerates a dispose throwing and continues to later entries", () => {
    const a = makeTerminal("Nexus SSH: a");
    const b = makeTerminal("Nexus SSH: b");
    a.dispose.mockImplementation(() => {
      throw new Error("already disposed");
    });
    const result = sweepOrphanNexusTerminals([a, b]);

    expect(result.count).toBe(2);
    expect(a.dispose).toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalled();
  });
});
