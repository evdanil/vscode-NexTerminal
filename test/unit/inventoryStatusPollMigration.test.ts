import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PER-SOURCE LAB STATUS POLL — the one-time move of the retired global
 * `nexus.inventory.statusPollSeconds` setting onto each EVE-NG source's own
 * Lab Status Poll Interval field.
 *
 * The setting stops being contributed, but it does NOT stop existing: it sits
 * in the user's `settings.json` with a value they chose. Dropping the feature
 * out from under them silently — their labs quietly stop refreshing, and the
 * dead key stays in the file and in every future settings export — is the
 * failure this exists to prevent.
 */
const state = vi.hoisted(() => ({
  inspected: undefined as
    | { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
    | undefined,
  updateImpl: (async () => undefined) as (key: string, value: unknown, target: unknown) => Promise<void>
}));

const { inspectMock, updateMock, getConfigurationMock } = vi.hoisted(() => {
  const inspect = vi.fn(() => state.inspected);
  const update = vi.fn((key: string, value: unknown, target: unknown) => state.updateImpl(key, value, target));
  return {
    inspectMock: inspect,
    updateMock: update,
    getConfigurationMock: vi.fn(() => ({ inspect, update }))
  };
});

vi.mock("vscode", () => ({
  workspace: { getConfiguration: getConfigurationMock },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
}));

import {
  RETIRED_STATUS_POLL_KEY,
  RETIRED_STATUS_POLL_SECTION,
  migrateGlobalStatusPollSetting
} from "../../src/services/inventory/statusPollSettingMigration";
import { configMutationLock } from "../../src/services/configMutationLock";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import { EVE_NG_PROVIDER_ID } from "../../src/services/inventory/providers/eveNgProvider";
import type { InventorySourceConfig, InventorySourceValues } from "../../src/models/inventory";

const GLOBAL = 1;
const WORKSPACE = 2;
const WORKSPACE_FOLDER = 3;

function makeSource(id: string, providerId: string, config: InventorySourceValues = {}): InventorySourceConfig {
  return {
    id,
    providerId,
    name: id,
    targetFolder: "Labs",
    prunePolicy: "orphan",
    defaultUsername: "admin",
    config,
    secretFieldIds: []
  };
}

async function coreWith(...sources: InventorySourceConfig[]): Promise<NexusCore> {
  const core = new NexusCore(new InMemoryConfigRepository());
  await core.initialize();
  for (const source of sources) {
    await core.addOrUpdateInventorySource(source);
  }
  return core;
}

const pollOf = (core: NexusCore, id: string): unknown => core.getInventorySource(id)?.config.statusPollSeconds;

describe("migrateGlobalStatusPollSetting", () => {
  beforeEach(() => {
    inspectMock.mockClear();
    updateMock.mockClear();
    getConfigurationMock.mockClear();
    state.inspected = undefined;
    state.updateImpl = async () => undefined;
  });

  it("reads the retired key from its real section", async () => {
    await migrateGlobalStatusPollSetting(await coreWith());
    expect(getConfigurationMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_SECTION);
    expect(inspectMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY);
    expect(RETIRED_STATUS_POLL_SECTION).toBe("nexus.inventory");
    expect(RETIRED_STATUS_POLL_KEY).toBe("statusPollSeconds");
  });

  it("does NOTHING when the user never set the key — no source touched, no settings write (⊘ a migration that writes unconditionally materialises a key in settings.json for every user who never had one, and re-revisions every source on every activation)", async () => {
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
    const revision = core.getInventorySource("eve-1")?.revision;

    const result = await migrateGlobalStatusPollSetting(core);

    expect(result).toEqual({ applied: [], cleared: [] });
    expect(updateMock).not.toHaveBeenCalled();
    expect(pollOf(core, "eve-1")).toBeUndefined();
    expect(core.getInventorySource("eve-1")?.revision).toBe(revision);
  });

  it("carries a set value onto every EVE-NG source that has no interval of its own, and clears the dead key (⊘ dropping the setting without this silently stops the polling a user had configured, and leaves an unknown key in their settings.json forever)", async () => {
    state.inspected = { globalValue: 45 };
    const core = await coreWith(
      makeSource("eve-1", EVE_NG_PROVIDER_ID),
      makeSource("eve-2", EVE_NG_PROVIDER_ID),
      makeSource("nb-1", "netbox")
    );

    const result = await migrateGlobalStatusPollSetting(core);

    expect(result.value).toBe(45);
    expect(result.applied.sort()).toEqual(["eve-1", "eve-2"]);
    expect(pollOf(core, "eve-1")).toBe(45);
    expect(pollOf(core, "eve-2")).toBe(45);
    // A NetBox source has no such field and reports no status at all.
    expect(core.getInventorySource("nb-1")?.config).toEqual({});
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
    expect(result.cleared).toEqual(["global"]);
  });

  it("never overwrites a source that already answered the field — INCLUDING an explicit 0, which is a deliberate 'off' (⊘ treating 0 as 'unanswered' re-enables polling on the one source the user turned it off for)", async () => {
    state.inspected = { globalValue: 45 };
    const core = await coreWith(
      makeSource("explicit-off", EVE_NG_PROVIDER_ID, { statusPollSeconds: 0 }),
      makeSource("explicit-on", EVE_NG_PROVIDER_ID, { statusPollSeconds: 10 }),
      makeSource("unanswered", EVE_NG_PROVIDER_ID)
    );

    const result = await migrateGlobalStatusPollSetting(core);

    expect(pollOf(core, "explicit-off")).toBe(0);
    expect(pollOf(core, "explicit-on")).toBe(10);
    expect(pollOf(core, "unanswered")).toBe(45);
    expect(result.applied).toEqual(["unanswered"]);
  });

  it("clears the key but applies nothing when the old value was 0 — the shipped default, which polled nothing (⊘ writing a 0 onto every source re-revisions them and blocks the migration's own 'unanswered' test forever after)", async () => {
    state.inspected = { globalValue: 0 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
    const revision = core.getInventorySource("eve-1")?.revision;

    const result = await migrateGlobalStatusPollSetting(core);

    expect(result.applied).toEqual([]);
    expect(pollOf(core, "eve-1")).toBeUndefined();
    expect(core.getInventorySource("eve-1")?.revision).toBe(revision);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
  });

  it("clears the key when there are NO EVE-NG sources to carry it to (⊘ leaving it parked lets a source added months later silently start polling at a cadence set for a source that no longer exists)", async () => {
    state.inspected = { globalValue: 45 };
    const core = await coreWith(makeSource("nb-1", "netbox"));

    const result = await migrateGlobalStatusPollSetting(core);

    expect(result.applied).toEqual([]);
    expect(result.cleared).toEqual(["global"]);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
  });

  it("preserves a value set in WORKSPACE scope and clears it there, not only in Global (⊘ a Global-only migration silently discards the value of a user who set it per-workspace, and leaves the dead key in the file)", async () => {
    state.inspected = { workspaceValue: 20 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    const result = await migrateGlobalStatusPollSetting(core);

    expect(pollOf(core, "eve-1")).toBe(20);
    expect(result.cleared).toEqual(["workspace"]);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, WORKSPACE);
    expect(updateMock).not.toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
  });

  it("takes the MOST SPECIFIC scope's value — the one the poll actually used — and clears every scope that held the key (⊘ migrating the Global value while a Workspace override was the effective one changes the interval behind the user's back)", async () => {
    state.inspected = { globalValue: 45, workspaceValue: 20, workspaceFolderValue: 5 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    const result = await migrateGlobalStatusPollSetting(core);

    expect(pollOf(core, "eve-1")).toBe(5);
    expect(result.cleared).toEqual(["global", "workspace", "workspaceFolder"]);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, WORKSPACE);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, WORKSPACE_FOLDER);
  });

  it("reproduces the retired setting's OWN coercion: clamped to 0..3600, floored, and anything non-finite read as 0 (⊘ carrying a hand-edited 99999 or NaN straight onto a source stores a value the field itself would refuse)", async () => {
    const migrated = async (raw: unknown): Promise<unknown> => {
      state.inspected = { globalValue: raw };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
      await migrateGlobalStatusPollSetting(core);
      return pollOf(core, "eve-1");
    };

    expect(await migrated(99_999)).toBe(3600);
    expect(await migrated(30.9)).toBe(30);
    expect(await migrated(-5)).toBeUndefined(); // clamps to 0 → nothing to carry
    expect(await migrated(Number.NaN)).toBeUndefined();
    expect(await migrated("45")).toBeUndefined(); // the poll read a string as 0 too
  });

  it("cannot run twice: the cleared key makes the second activation a no-op, and a source added afterwards is NOT retro-polled (⊘ a migration that keeps finding the old value re-applies it to every source the user adds from then on)", async () => {
    state.inspected = { globalValue: 45 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    await migrateGlobalStatusPollSetting(core);
    // The clear happened; a real settings store now reports the key as absent.
    state.inspected = undefined;
    updateMock.mockClear();

    await core.addOrUpdateInventorySource(makeSource("eve-2", EVE_NG_PROVIDER_ID));
    const second = await migrateGlobalStatusPollSetting(core);

    expect(second).toEqual({ applied: [], cleared: [] });
    expect(updateMock).not.toHaveBeenCalled();
    expect(pollOf(core, "eve-2")).toBeUndefined();
  });

  it("is idempotent even if the CLEAR failed, because an already-answered source is skipped (⊘ a migration whose only guard is the cleared key re-writes every source on every activation when settings.json is read-only)", async () => {
    state.inspected = { globalValue: 45 };
    state.updateImpl = async () => { throw new Error("settings.json is read-only"); };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    const first = await migrateGlobalStatusPollSetting(core);
    expect(first.applied).toEqual(["eve-1"]);
    expect(first.cleared).toEqual([]);
    const revision = core.getInventorySource("eve-1")?.revision;

    const second = await migrateGlobalStatusPollSetting(core);
    expect(second.applied).toEqual([]);
    expect(core.getInventorySource("eve-1")?.revision).toBe(revision);
  });

  it("writes the sources under configMutationLock, so it cannot interleave with an import/reset holding it (⊘ an unlocked write can land between a replace-mode import's own read and write and be thrown away, or throw one away)", async () => {
    state.inspected = { globalValue: 45 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = configMutationLock.runExclusive(async () => { await held; });

    const migration = migrateGlobalStatusPollSetting(core);
    await Promise.resolve();
    await Promise.resolve();
    // Blocked behind the holder — nothing written yet.
    expect(pollOf(core, "eve-1")).toBeUndefined();

    release();
    await holder;
    await migration;
    expect(pollOf(core, "eve-1")).toBe(45);
  });

  it("never throws out of activation when the settings read itself blows up (⊘ an unguarded migration takes the whole extension down on a corrupt configuration)", async () => {
    inspectMock.mockImplementationOnce(() => { throw new Error("configuration unavailable"); });
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    await expect(migrateGlobalStatusPollSetting(core)).resolves.toEqual({ applied: [], cleared: [] });
  });
});
