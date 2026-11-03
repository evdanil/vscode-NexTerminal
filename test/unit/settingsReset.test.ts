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
 * Highlight rules, the profile catalog and its default are edited outside
 * SETTINGS_META. Reset must clear all three overrides so the shipped default
 * profile is restored, rather than leaving a custom catalog active or empty.
 */
describe("resetSettings — extra (non-SETTINGS_META) keys", () => {
  beforeEach(() => {
    updateMock.mockClear();
    getConfigurationMock.mockClear();
  });

  it("exposes legacy rules, the catalog and its default as terminal-category extra keys", () => {
    expect(RESET_EXTRA_KEYS).toEqual([
      { section: "nexus.terminal.highlighting", key: "rules", category: "terminal" },
      { section: "nexus.terminal.highlighting", key: "profiles", category: "terminal" },
      { section: "nexus.terminal.highlighting", key: "defaultProfile", category: "terminal" }
    ]);
  });

  it("filters extras by category — terminal gets all highlight settings, other categories get nothing", () => {
    expect(resetExtraKeysForCategory("terminal").map((extra) => extra.key)).toEqual(["rules", "profiles", "defaultProfile"]);
    expect(resetExtraKeysForCategory("ssh")).toEqual([]);
  });

  it("Reset All includes the entire highlighting configuration", () => {
    expect(resetAllExtraKeys().map((extra) => `${extra.section}.${extra.key}`)).toEqual([
      "nexus.terminal.highlighting.rules",
      "nexus.terminal.highlighting.profiles",
      "nexus.terminal.highlighting.defaultProfile"
    ]);
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

    expect(getConfigurationMock.mock.calls).toEqual([
      ["nexus.ssh"],
      ["nexus.terminal.highlighting"],
      ["nexus.terminal.highlighting"],
      ["nexus.terminal.highlighting"]
    ]);
    expect(updateMock.mock.calls).toEqual([
      ["trustNewHosts", undefined, 1],
      ["rules", undefined, 1],
      ["profiles", undefined, 1],
      ["defaultProfile", undefined, 1]
    ]);
  });

  it("clears nothing extra when no extras are passed", async () => {
    await resetSettings([meta("nexus.ssh", "trustNewHosts")]);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
