import { readFileSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inspected: undefined as { globalValue?: unknown } | undefined,
  // The EFFECTIVE value `config.get()` returns — defaults merged with whatever
  // overrides exist. Deliberately independent of `inspected` so a test can set
  // up the case the migration turns on: a stale-looking effective value with
  // no global override behind it.
  effective: undefined as unknown,
  updateImpl: (async () => undefined) as (key: string, value: unknown, target: unknown) => Promise<void>
}));

const { inspectMock, updateMock, getMock, getConfigurationMock } = vi.hoisted(() => {
  const inspect = vi.fn(() => state.inspected);
  const get = vi.fn((_key: string, defaultValue?: unknown) =>
    state.effective === undefined ? defaultValue : state.effective
  );
  const update = vi.fn((key: string, value: unknown, target: unknown) => state.updateImpl(key, value, target));
  return {
    inspectMock: inspect,
    updateMock: update,
    getMock: get,
    getConfigurationMock: vi.fn(() => ({ inspect, get, update }))
  };
});

vi.mock("vscode", () => ({
  workspace: { getConfiguration: getConfigurationMock },
  ConfigurationTarget: { Global: 1 }
}));

import { migrateHighlightRulesGlobalSetting } from "../../src/services/terminal/highlightRuleMigration";
import {
  clearWriteRegistry,
  consumeNexusConfigWrite
} from "../../src/services/terminal/settingsWriteRegistry";
import type { HighlightRule } from "../../src/utils/highlightRuleValidation";

const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
const shippedDefaults = (JSON.parse(readFileSync(packageJsonPath, "utf8")).contributes.configuration.properties[
  "nexus.terminal.highlighting.rules"
].default ?? []) as HighlightRule[];

const IPV6_V1 =
  "\\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{1,4}\\b|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\\b";

describe("migrateHighlightRulesGlobalSetting", () => {
  beforeEach(() => {
    inspectMock.mockClear();
    updateMock.mockClear();
    getMock.mockClear();
    getConfigurationMock.mockClear();
    clearWriteRegistry();
    state.inspected = undefined;
    state.effective = undefined;
    state.updateImpl = async () => undefined;
  });

  it("rewrites a stale global override at Global scope", async () => {
    state.inspected = {
      globalValue: [{ pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false }]
    };

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(true);
    expect(getConfigurationMock).toHaveBeenCalledWith("nexus.terminal.highlighting");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [key, value, target] = updateMock.mock.calls[0] as [string, HighlightRule[], number];
    expect(key).toBe("rules");
    expect(target).toBe(1);
    expect(value[0].label).toBe("IPv6 addresses");
    expect(value[0].enabled).toBe(false);
    expect(value[0].pattern).not.toBe(IPV6_V1);
  });

  // ⊘ Without the recordNexusConfigWrite call the Settings Guard would file
  // this migration as an EXTERNAL edit in the forensic report.
  it("records the write in the settings write registry", async () => {
    state.inspected = {
      globalValue: [{ pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false }]
    };

    await migrateHighlightRulesGlobalSetting();

    const written = (updateMock.mock.calls[0] as [string, unknown, number])[1];
    expect(
      consumeNexusConfigWrite("nexus.terminal.highlighting.rules", written, Date.now())
    ).toBe(true);
  });

  // ⊘ Ordering, not merely presence — the test above passes whichever side of
  // config.update() the record lands on. The guard classifies the change event
  // that update() produces, and that event can reach the guard before
  // update()'s promise settles, so a record written afterwards is written too
  // late and the migration is filed as an external edit. The check therefore
  // runs from INSIDE the update call.
  it("records the write BEFORE issuing it", async () => {
    state.inspected = {
      globalValue: [{ pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false }]
    };
    let recordedWhenUpdateRan: boolean | undefined;
    state.updateImpl = async (_key, value) => {
      recordedWhenUpdateRan = consumeNexusConfigWrite(
        "nexus.terminal.highlighting.rules",
        value,
        Date.now()
      );
    };

    await migrateHighlightRulesGlobalSetting();

    expect(recordedWhenUpdateRan).toBe(true);
  });

  // ⊘ Discriminator against persisting the SANITIZED array. Validation is a
  // GATE — "is this array safe to touch at all" — not a transform. The
  // sanitizer rebuilds each rule from a whitelist, so writing its output would
  // silently delete fields the user hand-added to settings.json and normalise
  // ones it merely tolerates (an invalid `flags` is dropped rather than
  // failing the array). A one-shot heal that quietly rewrites unrelated parts
  // of a user's settings is a far worse bug than the one it fixes, so the
  // migration upgrades and persists the RAW stored array.
  it("persists the raw stored array — never the sanitizer's rebuild of it", async () => {
    state.inspected = {
      globalValue: [
        { pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false },
        { pattern: "\\bDEPLOYING\\b", color: "cyan", flags: "gm", myNote: "keep me" }
      ]
    };

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(true);
    const written = (updateMock.mock.calls[0] as [string, Array<Record<string, unknown>>, number])[1];
    expect(written[1]).toEqual({
      pattern: "\\bDEPLOYING\\b",
      color: "cyan",
      flags: "gm",
      myNote: "keep me"
    });
  });

  // ⊘ Codex P2 (#79 round 2): validation TOLERATES a non-string `flags` (it
  // reads it as absent rather than failing the array), so the raw array
  // reaches the upgrade with `flags: 42` intact. An upgrade that assumes flags
  // is a string crashes on it, and the migration's outer catch turns that
  // crash into "silently skipped forever" — stale pattern never healed.
  it("heals a rule whose hand-edited flags value is a tolerated non-string", async () => {
    state.inspected = {
      globalValue: [{ pattern: IPV6_V1, color: "magenta", flags: 42, enabled: false }]
    };

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(true);
    const written = (updateMock.mock.calls[0] as [string, Array<Record<string, unknown>>, number])[1];
    expect(written[0].pattern).not.toBe(IPV6_V1);
    // The raw value is preserved in what is persisted — tolerated, not rewritten.
    expect(written[0].flags).toBe(42);
  });

  // ⊘ Codex P2 (#79 round 3): same tolerance class as the non-string case,
  // via a REJECTED STRING — "gm" fails VALID_FLAGS_RE, so the sanitizer drops
  // it and compileRule runs the rule as "gi". Compared literally it blocks the
  // backfill, and with the pattern unchanged the migration then reports no
  // change at all — stale nameless snapshot never healed.
  it("heals a rule whose hand-edited flags string is invalid (runs as the default)", async () => {
    state.inspected = {
      globalValue: [{ pattern: "\\bERR(?:OR)?\\b", color: "red", bold: true, flags: "gm" }]
    };

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(true);
    const written = (updateMock.mock.calls[0] as [string, Array<Record<string, unknown>>, number])[1];
    expect(written[0].label).toBe("Errors");
    expect(written[0].flags).toBe("gm");
  });

  it("does nothing when there is no global override", async () => {
    state.inspected = { globalValue: undefined };

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // ⊘ Discriminator for the "global override only" rule, which the test above
  // cannot make: there, `get()` and `inspect()` agree that nothing is there, so
  // an implementation reading the EFFECTIVE value passes it too (validation
  // rejects undefined anyway). Here the two disagree — a stale-looking
  // effective value with no global override behind it, which is the real shape
  // for a user on the shipped defaults, or one whose only override is at
  // workspace scope. Writing then would materialise a global snapshot out of
  // thin air and recreate the exact shadowing this release exists to undo.
  it("does not write when the effective value looks stale but no GLOBAL override exists", async () => {
    state.inspected = { globalValue: undefined };
    state.effective = [{ pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false }];

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does nothing when the global override is already current", async () => {
    state.inspected = { globalValue: shippedDefaults.map((rule) => ({ ...rule })) };

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does nothing when the global override does not validate", async () => {
    state.inspected = { globalValue: { nonsense: true } };

    const migrated = await migrateHighlightRulesGlobalSetting();

    expect(migrated).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("is non-fatal when the write itself fails", async () => {
    state.inspected = {
      globalValue: [{ pattern: IPV6_V1, color: "magenta", flags: "g", enabled: false }]
    };
    state.updateImpl = async () => {
      throw new Error("settings.json is read-only");
    };

    await expect(migrateHighlightRulesGlobalSetting()).resolves.toBe(false);
  });
});

describe("activation wiring", () => {
  // ⊘ The migration is dead code unless activate() calls it, and there is no
  // cheaper way to assert the wiring than reading the source. Matching the
  // CALL and not merely the name is the whole point: the import line alone
  // satisfies a substring check, so a version of extension.ts that imports the
  // function and never invokes it would pass.
  it("extension.ts calls the migration during activate()", () => {
    const source = readFileSync(path.resolve(__dirname, "..", "..", "src", "extension.ts"), "utf8");
    expect(source).toMatch(/void migrateHighlightRulesGlobalSetting\(\);/);
  });
});
