import { beforeEach, describe, expect, it, vi } from "vitest";

const { settings, getConfiguration, executeCommand } = vi.hoisted(() => {
  const settings = new Map<string, unknown>();
  return {
    settings,
    // Like VS Code's own configuration object, each one holds the values of
    // the moment it was taken — so a resolver that keeps one across connects
    // keeps stale values, which is what the per-call test has to catch.
    getConfiguration: vi.fn((section: string) => {
      const snapshot = new Map(settings);
      return { get: (key: string) => snapshot.get(`${section}.${key}`) };
    }),
    executeCommand: vi.fn()
  };
});

vi.mock("vscode", () => ({
  workspace: { getConfiguration },
  commands: { executeCommand }
}));

import { openAgentSettings, sshAgentResolver } from "../../src/services/ssh/sshAgentSettings";

describe("sshAgentResolver", () => {
  beforeEach(() => {
    settings.clear();
    getConfiguration.mockClear();
  });

  it("reads nexus.ssh.agent and nexus.ssh.agentPath on every call (⊘ reading them once would need a reload for a change the setting says applies at the next login)", () => {
    const resolve = sshAgentResolver();
    settings.set("nexus.ssh.agent", "custom");
    settings.set("nexus.ssh.agentPath", "/run/first.sock");
    expect(resolve()).toMatchObject({ agent: "/run/first.sock", source: "custom" });

    settings.set("nexus.ssh.agentPath", "/run/second.sock");
    expect(resolve()).toMatchObject({ agent: "/run/second.sock", source: "custom" });
    expect(getConfiguration).toHaveBeenCalledWith("nexus.ssh");
  });

  it("treats a missing, unknown or non-string value as the default (auto, no path)", () => {
    settings.set("nexus.ssh.agent", "custom");
    settings.set("nexus.ssh.agentPath", 42);
    expect(() => sshAgentResolver()()).toThrow(/nexus\.ssh\.agentPath is empty/);
  });
});

describe("openAgentSettings", () => {
  it("opens the Nexus settings panel at the SSH category", async () => {
    await openAgentSettings();
    expect(executeCommand).toHaveBeenCalledWith("nexus.settings.openPanel", "ssh");
  });
});
