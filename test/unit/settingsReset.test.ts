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

import {
  RESET_EXTRA_KEYS,
  resetAllExtraKeys,
  resetExtraKeysForCategory,
  resetSettings
} from "../../src/ui/settingsReset";
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

/**
 * `nexus.terminal.highlighting.rules` is deliberately absent from SETTINGS_META
 * (it has its own editor, not a row in the settings panel), which meant
 * "Reset all Nexus settings to their defaults" never cleared it. The extra-key
 * list closes that gap without putting the array into SETTINGS_META.
 */
describe("resetSettings — extra (non-SETTINGS_META) keys", () => {
  beforeEach(() => {
    updateMock.mockClear();
    getConfigurationMock.mockClear();
  });

  it("exposes the highlighting rules array as a terminal-category extra key", () => {
    expect(RESET_EXTRA_KEYS).toEqual([
      { section: "nexus.terminal.highlighting", key: "rules", category: "terminal" }
    ]);
  });

  it("filters extras by category — terminal gets the rules, other categories get nothing", () => {
    expect(resetExtraKeysForCategory("terminal")).toHaveLength(1);
    expect(resetExtraKeysForCategory("ssh")).toEqual([]);
  });

  it("resetAllExtraKeys is the Reset-All list", () => {
    expect(resetAllExtraKeys()).toEqual(RESET_EXTRA_KEYS);
  });

  // ⊘ The category arrives from a webview message (`msg.category as string`),
  // so an empty or missing one is malformed input — and an implementation that
  // reads it as "no filter" would silently turn a single-category reset into a
  // Reset-All of the extras, wiping a rule array the user never asked about.
  it("resets NO extras for an empty category", () => {
    expect(resetExtraKeysForCategory("")).toEqual([]);
    expect(resetExtraKeysForCategory(undefined as unknown as string)).toEqual([]);
  });

  it("clears each extra key at global scope after the metas", async () => {
    await resetSettings([meta("nexus.ssh", "trustNewHosts")], RESET_EXTRA_KEYS);

    expect(getConfigurationMock).toHaveBeenNthCalledWith(2, "nexus.terminal.highlighting");
    expect(updateMock).toHaveBeenNthCalledWith(2, "rules", undefined, 1);
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("clears nothing extra when no extras are passed", async () => {
    await resetSettings([meta("nexus.ssh", "trustNewHosts")]);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
