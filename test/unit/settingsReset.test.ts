import { describe, expect, it, vi, beforeEach } from "vitest";

const { updateMock, getConfigurationMock } = vi.hoisted(() => {
  const update = vi.fn();
  return {
    updateMock: update,
    getConfigurationMock: vi.fn(() => ({ update }))
  };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: getConfigurationMock
  },
  ConfigurationTarget: { Global: 1 }
}));

import { resetSettings } from "../../src/ui/settingsReset";
import type { SettingMeta } from "../../src/ui/settingsMetadata";

function meta(section: string, key: string): SettingMeta {
  return {
    section,
    key,
    label: key,
    type: "boolean",
    category: "ssh"
  };
}

describe("resetSettings", () => {
  beforeEach(() => {
    updateMock.mockClear();
    getConfigurationMock.mockClear();
  });

  it("clears each meta's value at global scope", async () => {
    await resetSettings([meta("nexus.logging", "sessionTranscripts"), meta("nexus.ssh", "trustNewHosts")]);

    expect(getConfigurationMock).toHaveBeenNthCalledWith(1, "nexus.logging");
    expect(getConfigurationMock).toHaveBeenNthCalledWith(2, "nexus.ssh");
    expect(updateMock).toHaveBeenNthCalledWith(1, "sessionTranscripts", undefined, 1);
    expect(updateMock).toHaveBeenNthCalledWith(2, "trustNewHosts", undefined, 1);
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing for an empty meta list", async () => {
    await resetSettings([]);
    expect(getConfigurationMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("awaits each update before resolving", async () => {
    const order: string[] = [];
    updateMock.mockImplementation(async (key: string) => {
      order.push(`start:${key}`);
      await Promise.resolve();
      order.push(`end:${key}`);
    });

    await resetSettings([meta("a", "one"), meta("b", "two")]);

    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });
});
