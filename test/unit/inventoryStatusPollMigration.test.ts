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
  migrateGlobalStatusPollSetting,
  type StatusPollMigrationResult
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

/**
 * The durable "already ran" marker, `globalState` in production. A plain Map
 * here — the point of the marker is that it does NOT live in the user's
 * settings file, so nothing about it needs the vscode configuration mock.
 */
function makeMarkerStore(initial: Record<string, boolean> = {}) {
  const store = new Map<string, boolean>(Object.entries(initial));
  return {
    get: vi.fn((key: string) => store.get(key)),
    update: vi.fn(async (key: string, value: boolean) => {
      store.set(key, value);
    })
  };
}

let markers: ReturnType<typeof makeMarkerStore>;
const migrate = (core: NexusCore, store: ReturnType<typeof makeMarkerStore> = markers) =>
  migrateGlobalStatusPollSetting(core, store);

describe("migrateGlobalStatusPollSetting", () => {
  beforeEach(() => {
    inspectMock.mockClear();
    updateMock.mockClear();
    getConfigurationMock.mockClear();
    state.inspected = undefined;
    state.updateImpl = async () => undefined;
    markers = makeMarkerStore();
  });

  it("reads the retired key from its real section", async () => {
    await migrate(await coreWith());
    expect(getConfigurationMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_SECTION);
    expect(inspectMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY);
    expect(RETIRED_STATUS_POLL_SECTION).toBe("nexus.inventory");
    expect(RETIRED_STATUS_POLL_KEY).toBe("statusPollSeconds");
  });

  it("does NOTHING when the user never set the key — no source touched, no settings write (⊘ a migration that writes unconditionally materialises a key in settings.json for every user who never had one, and re-revisions every source on every activation)", async () => {
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
    const revision = core.getInventorySource("eve-1")?.revision;

    const result = await migrate(core);

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

    const result = await migrate(core);

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

    const result = await migrate(core);

    expect(pollOf(core, "explicit-off")).toBe(0);
    expect(pollOf(core, "explicit-on")).toBe(10);
    expect(pollOf(core, "unanswered")).toBe(45);
    expect(result.applied).toEqual(["unanswered"]);
  });

  it("clears the key but applies nothing when the old value was 0 — the shipped default, which polled nothing (⊘ writing a 0 onto every source re-revisions them and blocks the migration's own 'unanswered' test forever after)", async () => {
    state.inspected = { globalValue: 0 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
    const revision = core.getInventorySource("eve-1")?.revision;

    const result = await migrate(core);

    expect(result.applied).toEqual([]);
    expect(pollOf(core, "eve-1")).toBeUndefined();
    expect(core.getInventorySource("eve-1")?.revision).toBe(revision);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
  });

  it("clears the key when there are NO EVE-NG sources to carry it to (⊘ leaving it parked lets a source added months later silently start polling at a cadence set for a source that no longer exists)", async () => {
    state.inspected = { globalValue: 45 };
    const core = await coreWith(makeSource("nb-1", "netbox"));

    const result = await migrate(core);

    expect(result.applied).toEqual([]);
    expect(result.cleared).toEqual(["global"]);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
  });

  it("preserves a value set in WORKSPACE scope and clears it there, not only in Global (⊘ a Global-only migration silently discards the value of a user who set it per-workspace, and leaves the dead key in the file)", async () => {
    state.inspected = { workspaceValue: 20 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    const result = await migrate(core);

    expect(pollOf(core, "eve-1")).toBe(20);
    expect(result.cleared).toEqual(["workspace"]);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, WORKSPACE);
    expect(updateMock).not.toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
  });

  it("takes the MOST SPECIFIC scope's value — the one the poll actually used — and clears every scope that held the key (⊘ migrating the Global value while a Workspace override was the effective one changes the interval behind the user's back)", async () => {
    state.inspected = { globalValue: 45, workspaceValue: 20, workspaceFolderValue: 5 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    const result = await migrate(core);

    expect(pollOf(core, "eve-1")).toBe(5);
    expect(result.cleared).toEqual(["global", "workspace", "workspaceFolder"]);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, GLOBAL);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, WORKSPACE);
    expect(updateMock).toHaveBeenCalledWith(RETIRED_STATUS_POLL_KEY, undefined, WORKSPACE_FOLDER);
  });

  it("reproduces the retired setting's OWN coercion: clamped to 0..3600, floored, and anything non-finite read as 0 (⊘ carrying a hand-edited 99999 or NaN straight onto a source stores a value the field itself would refuse)", async () => {
    // A fresh core AND a fresh marker store per value: each one stands for a
    // separate installation whose settings.json held that raw value.
    const migrated = async (raw: unknown): Promise<unknown> => {
      state.inspected = { globalValue: raw };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
      await migrate(core, makeMarkerStore());
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

    await migrate(core);
    // The clear happened; a real settings store now reports the key as absent.
    state.inspected = undefined;
    updateMock.mockClear();

    await core.addOrUpdateInventorySource(makeSource("eve-2", EVE_NG_PROVIDER_ID));
    const second = await migrate(core);

    expect(second).toEqual({ applied: [], cleared: [] });
    expect(updateMock).not.toHaveBeenCalled();
    expect(pollOf(core, "eve-2")).toBeUndefined();
  });

  it("is idempotent even if the CLEAR failed — the durable marker, not the settings key, is what says it already ran (⊘ a migration whose only guard is the cleared key re-writes every source on every activation when settings.json is read-only)", async () => {
    state.inspected = { globalValue: 45 };
    state.updateImpl = async () => { throw new Error("settings.json is read-only"); };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    const first = await migrate(core);
    expect(first.applied).toEqual(["eve-1"]);
    expect(first.cleared).toEqual([]);
    const revision = core.getInventorySource("eve-1")?.revision;

    const second = await migrate(core);
    expect(second.applied).toEqual([]);
    expect(core.getInventorySource("eve-1")?.revision).toBe(revision);
  });

  /**
   * REVIEW M1 — the two halves the settings key could not cover, both reachable
   * from ONE ordinary sequence: the clear fails (a read-only or policy-managed
   * settings.json — precisely the case the fallback layer exists for, and also a
   * dotfiles-provisioned file that simply re-adds the key), so the key is still
   * there on the next activation and the migration used to read every source as
   * unanswered again.
   */
  describe("the durable already-ran marker", () => {
    it("does NOT re-enable polling on a source whose interval the user has since BLANKED, when the settings clear failed (⊘ inferring 'already ran' from the settings key re-writes the old 45 s onto a source the user deliberately turned off — unattended polling of a system that evicts their EVE-NG browser session)", async () => {
      state.inspected = { globalValue: 45 };
      state.updateImpl = async () => { throw new Error("settings.json is read-only"); };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

      expect((await migrate(core)).applied).toEqual(["eve-1"]);

      // The user blanks the field in the edit form. `formValuesToProviderConfig`
      // stores NO KEY for an empty number field, so the source goes back to
      // looking exactly like one that never answered.
      const live = core.getInventorySource("eve-1")!;
      await core.addOrUpdateInventorySource({ ...live, config: {} });
      const revision = core.getInventorySource("eve-1")?.revision;

      const second = await migrate(core);

      expect(second.applied).toEqual([]);
      expect(pollOf(core, "eve-1")).toBeUndefined();
      expect(core.getInventorySource("eve-1")?.revision).toBe(revision);
    });

    it("does NOT seed a source ADDED after the migration ran, even when the settings clear failed (⊘ the same hole seeds every EVE-NG source added later at a cadence set for a source that may no longer exist — the outcome this module's own design notes reject)", async () => {
      state.inspected = { globalValue: 45 };
      state.updateImpl = async () => { throw new Error("settings.json is read-only"); };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

      await migrate(core);
      inspectMock.mockClear();

      await core.addOrUpdateInventorySource(makeSource("eve-2", EVE_NG_PROVIDER_ID));
      const second = await migrate(core);

      expect(second).toEqual({ applied: [], cleared: [] });
      expect(pollOf(core, "eve-2")).toBeUndefined();
      // And the marker short-circuits BEFORE the settings read: it is the gate,
      // not a tie-breaker consulted after the key is found.
      expect(inspectMock).not.toHaveBeenCalled();
    });

    it("marks a pass that found NO key at all, so a settings file that re-adds it later cannot arm polling behind the user (⊘ marking only when something was carried leaves a dotfiles-provisioned key to migrate itself onto every source on some later activation)", async () => {
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

      await migrate(core); // nothing set: a clean install's first activation

      state.inspected = { globalValue: 45 }; // the key reappears
      const second = await migrate(core);

      expect(second.applied).toEqual([]);
      expect(pollOf(core, "eve-1")).toBeUndefined();
    });

    it("is NOT marked when the source write FAILED, so the next activation retries the carry (⊘ marking before the work is done abandons the value on the one run that actually needed to preserve it)", async () => {
      state.inspected = { globalValue: 45 };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
      const write = vi.spyOn(core, "addOrUpdateInventorySource").mockRejectedValueOnce(new Error("storage full"));

      const first = await migrate(core);
      expect(first.applied).toEqual([]);
      expect(pollOf(core, "eve-1")).toBeUndefined();

      write.mockRestore();
      const second = await migrate(core);

      expect(second.applied).toEqual(["eve-1"]);
      expect(pollOf(core, "eve-1")).toBe(45);
    });
  });

  it("writes the sources under configMutationLock, so it cannot interleave with an import/reset holding it (⊘ an unlocked write can land between a replace-mode import's own read and write and be thrown away, or throw one away)", async () => {
    state.inspected = { globalValue: 45 };
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = configMutationLock.runExclusive(async () => { await held; });

    const migration = migrate(core);
    await Promise.resolve();
    await Promise.resolve();
    // Blocked behind the holder — nothing written yet.
    expect(pollOf(core, "eve-1")).toBeUndefined();

    release();
    await holder;
    await migration;
    expect(pollOf(core, "eve-1")).toBe(45);
  });

  /**
   * ORDERING — apply first, clear second. Neither order can lose the value in
   * the ordinary case, but only this one cannot lose it when a step FAILS: the
   * retired key in `settings.json` is the sole remaining copy of the user's
   * interval until a source actually holds it, so clearing first and then
   * failing the source write destroys it outright — gone from settings and
   * never written anywhere else. The module's doc comment spends a paragraph on
   * this; nothing pinned it.
   */
  describe("the apply-then-clear ordering", () => {
    it("has already carried the value onto the sources by the time it clears the key (⊘ clearing first leaves a window where the value exists nowhere)", async () => {
      state.inspected = { globalValue: 45 };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
      let pollAtClearTime: unknown = "never cleared";
      state.updateImpl = async () => {
        pollAtClearTime = pollOf(core, "eve-1");
      };

      await migrate(core);

      expect(pollAtClearTime).toBe(45);
    });

    it("does NOT clear the key when the carry FAILED, so the retry still has something to read (⊘ clearing first and then failing the source write loses the user's interval permanently — out of settings.json and never onto a source)", async () => {
      state.inspected = { globalValue: 45 };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));
      vi.spyOn(core, "addOrUpdateInventorySource").mockRejectedValueOnce(new Error("storage full"));

      const result = await migrate(core);

      expect(result).toEqual({ applied: [], cleared: [] });
      expect(updateMock).not.toHaveBeenCalled();
      expect(pollOf(core, "eve-1")).toBeUndefined();
    });
  });

  /**
   * The candidate list is computed from a snapshot taken OUTSIDE
   * `configMutationLock`, so by the time the migration's own locked section
   * runs, a lock-holding writer — a replace-mode config import, a complete
   * reset, an inventory command — may have moved every record underneath it.
   * The re-read inside the lock is what makes the write land on the record it
   * was decided for; these pin it in each direction it can go wrong.
   */
  describe("the in-lock re-read", () => {
    /** Runs `mutate` while holding configMutationLock, with the migration queued behind it. */
    async function withQueuedMigration(
      core: NexusCore,
      mutate: () => Promise<void>
    ): Promise<StatusPollMigrationResult> {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const holder = configMutationLock.runExclusive(async () => {
        await held;
        await mutate();
      });
      const migration = migrate(core); // captures its candidates, then queues on the lock
      await Promise.resolve();
      await Promise.resolve();
      release();
      await holder;
      return migration;
    }

    it("skips a candidate REMOVED while the migration waited on the lock (⊘ writing the stale snapshot back through addOrUpdateInventorySource RESURRECTS a source a reset or a replace-mode import had just deleted)", async () => {
      state.inspected = { globalValue: 45 };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

      const result = await withQueuedMigration(core, () => core.removeInventorySource("eve-1"));

      expect(result.applied).toEqual([]);
      expect(core.getInventorySource("eve-1")).toBeUndefined();
    });

    it("skips a candidate that ANSWERED the field while the migration waited on the lock (⊘ trusting the snapshot overwrites the interval the user just chose with the migrated one)", async () => {
      state.inspected = { globalValue: 45 };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

      const result = await withQueuedMigration(core, async () => {
        const live = core.getInventorySource("eve-1")!;
        await core.addOrUpdateInventorySource({ ...live, config: { statusPollSeconds: 10 } });
      });

      expect(result.applied).toEqual([]);
      expect(pollOf(core, "eve-1")).toBe(10);
    });

    it("skips a candidate whose id was recreated as a DIFFERENT PROVIDER while the migration waited on the lock (⊘ re-checking existence and answered-ness but not the provider lands an EVE-NG-only field in a NetBox source's config and bumps its revision)", async () => {
      state.inspected = { globalValue: 45 };
      const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

      // A replace-mode import queues on the same lock and can delete-and-recreate
      // a source id under a different provider — the same-id incarnation hazard
      // `isSameSourceIncarnation` re-validates everywhere else.
      const result = await withQueuedMigration(core, async () => {
        await core.removeInventorySource("eve-1");
        await core.addOrUpdateInventorySource(makeSource("eve-1", "netbox"));
      });

      expect(result.applied).toEqual([]);
      const replacement = core.getInventorySource("eve-1");
      expect(replacement?.providerId).toBe("netbox"); // the fixture really did swap it
      expect(replacement?.config).toEqual({});
    });
  });

  it("never throws out of activation when the settings read itself blows up (⊘ an unguarded migration takes the whole extension down on a corrupt configuration)", async () => {
    inspectMock.mockImplementationOnce(() => { throw new Error("configuration unavailable"); });
    const core = await coreWith(makeSource("eve-1", EVE_NG_PROVIDER_ID));

    await expect(migrate(core)).resolves.toEqual({ applied: [], cleared: [] });
  });
});
