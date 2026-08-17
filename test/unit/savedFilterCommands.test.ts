import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";

/**
 * SAVED FILTER DEFINITIONS (issue #48 PR-E, backlog #1) — the manage command and
 * the "Save current filter as…" inline-create affordance, driven through the
 * mocked vscode harness.
 */

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockShowQuickPick = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowErrorMessage = vi.fn();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    })
  },
  window: {
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args)
  }
}));

const { registerSavedFilterCommands } = await import("../../src/commands/savedFilterCommands");
const { createInlineSavedFilterCreation } = await import("../../src/commands/inlineSavedFilterCreation");
const { SAVED_FILTER_SELECT_KEY, inventoryConfigFieldPrefixedKey, SAVED_FILTER_TARGET_FIELD_ID } = await import(
  "../../src/ui/formDefinitions"
);
const { configMutationLock } = await import("../../src/services/configMutationLock");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Drain the microtask/task queue several times so a mocked prompt chain fully
 *  resolves and the command reaches its `configMutationLock.runExclusive` acquire. */
const flushMany = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await flush();
  }
};

async function makeCore(): Promise<NexusCore> {
  const core = new NexusCore(new InMemoryConfigRepository());
  await core.initialize();
  return core;
}

describe("nexus.savedFilter.manage", () => {
  let core: NexusCore;
  let ctx: CommandContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    core = await makeCore();
    ctx = { core } as unknown as CommandContext;
    registerSavedFilterCommands(ctx);
  });

  it("empty state offers 'New Saved Filter' and, on accept, prompts name + query and saves it", async () => {
    mockShowInformationMessage.mockResolvedValueOnce("New Saved Filter");
    mockShowInputBox.mockResolvedValueOnce("Syd core"); // name
    mockShowInputBox.mockResolvedValueOnce("role=core&site=syd"); // filter

    await registeredCommands.get("nexus.savedFilter.manage")!();

    const filters = core.getSnapshot().savedFilters;
    expect(filters).toHaveLength(1);
    expect(filters[0].name).toBe("Syd core");
    expect(filters[0].filter).toBe("role=core&site=syd");
  });

  // EVE-NG (Phase 1) — saved filters apply to whichever provider's source
  // declares a `filter` field, and EVE-NG's matches lab paths rather than a
  // NetBox query string. Naming one provider in the shared prompt tells the
  // other's users the feature is not for them.
  it("words the filter-query prompt without naming a provider (\u2298 \"The NetBox Device Filter query string\" is wrong for an EVE-NG source, which filters on lab paths)", async () => {
    mockShowInformationMessage.mockResolvedValueOnce("New Saved Filter");
    mockShowInputBox.mockResolvedValueOnce("Syd core");
    mockShowInputBox.mockResolvedValueOnce("role=core");

    await registeredCommands.get("nexus.savedFilter.manage")!();

    const queryPrompt = String((mockShowInputBox.mock.calls[1][0] as { prompt: string }).prompt);
    expect(queryPrompt).not.toMatch(/NetBox/i);
    expect(queryPrompt.toLowerCase()).toContain("filter");
  });

  it("editing a row re-prompts name + query (pre-filled) and updates in place, keeping the id", async () => {
    await core.addOrUpdateSavedFilter({ id: "f1", name: "Old", filter: "a=1" });
    // Manage hub: pick the row for f1 (action edit).
    mockShowQuickPick.mockResolvedValueOnce({ label: "Old", action: "edit", filter: { id: "f1", name: "Old", filter: "a=1" } });
    mockShowInputBox.mockResolvedValueOnce("New name"); // name
    mockShowInputBox.mockResolvedValueOnce("a=2"); // filter

    await registeredCommands.get("nexus.savedFilter.manage")!();

    expect(core.getSavedFilter("f1")).toEqual({ id: "f1", name: "New name", filter: "a=2" });
    expect(core.getSnapshot().savedFilters).toHaveLength(1); // still one — updated in place
  });

  it("delete flow removes only the definition after a modal confirm (kills a delete that skips confirmation)", async () => {
    await core.addOrUpdateSavedFilter({ id: "f1", name: "Doomed", filter: "x=1" });
    // Manage hub: pick the Delete… action.
    mockShowQuickPick.mockResolvedValueOnce({ label: "Delete", action: "delete", filter: undefined });
    // Delete sub-picker: choose f1.
    mockShowQuickPick.mockResolvedValueOnce({ label: "Doomed", filter: { id: "f1", name: "Doomed", filter: "x=1" } });
    mockShowWarningMessage.mockResolvedValueOnce("Delete");

    await registeredCommands.get("nexus.savedFilter.manage")!();

    expect(core.getSavedFilter("f1")).toBeUndefined();
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it("delete flow does nothing when the confirm modal is dismissed (kills confirm-then-delete-anyway)", async () => {
    await core.addOrUpdateSavedFilter({ id: "f1", name: "Kept", filter: "x=1" });
    mockShowQuickPick.mockResolvedValueOnce({ label: "Delete", action: "delete", filter: undefined });
    mockShowQuickPick.mockResolvedValueOnce({ label: "Kept", filter: { id: "f1", name: "Kept", filter: "x=1" } });
    mockShowWarningMessage.mockResolvedValueOnce(undefined); // dismissed

    await registeredCommands.get("nexus.savedFilter.manage")!();

    expect(core.getSavedFilter("f1")).toEqual({ id: "f1", name: "Kept", filter: "x=1" });
  });
});

describe("inline 'Save current filter as…' affordance (PR-E)", () => {
  let core: NexusCore;
  const filterKey = inventoryConfigFieldPrefixedKey(SAVED_FILTER_TARGET_FIELD_ID);

  beforeEach(async () => {
    vi.clearAllMocks();
    core = await makeCore();
  });

  function fakePanel() {
    return { addSelectOption: vi.fn(), onDidDispose: vi.fn(), dispose: vi.fn() };
  }

  it("saves the CURRENT Device Filter text under a prompted name and appends it to the picker", async () => {
    const controller = createInlineSavedFilterCreation({ core });
    const panel = fakePanel();
    controller.attachPanel(panel as never);
    mockShowInputBox.mockResolvedValueOnce("Reusable");

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "role=core&site=syd" });
    await flush();

    const filters = core.getSnapshot().savedFilters;
    expect(filters).toHaveLength(1);
    expect(filters[0].name).toBe("Reusable");
    expect(filters[0].filter).toBe("role=core&site=syd");
    // Appended to the picker so the user sees it land — P1: with its query as the
    // option description, so the just-saved row shows its query line immediately.
    // FIX B — and with the raw filter as the trailing fillValue arg, so re-picking
    // the just-saved row fills the Device Filter synchronously like any other row.
    expect(panel.addSelectOption).toHaveBeenCalledWith(
      SAVED_FILTER_SELECT_KEY,
      filters[0].id,
      "Reusable",
      "role=core&site=syd",
      "role=core&site=syd"
    );
  });

  it("with no Device Filter typed yet, warns and saves NOTHING (kills saving an empty definition)", async () => {
    const controller = createInlineSavedFilterCreation({ core });
    const panel = fakePanel();
    controller.attachPanel(panel as never);

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "   " });
    await flush();

    expect(mockShowWarningMessage).toHaveBeenCalled();
    expect(mockShowInputBox).not.toHaveBeenCalled();
    expect(core.getSnapshot().savedFilters).toHaveLength(0);
  });

  it("ignores a create fired by a DIFFERENT select's key (kills a handler that fires on any create)", async () => {
    const controller = createInlineSavedFilterCreation({ core });
    const panel = fakePanel();
    controller.attachPanel(panel as never);

    controller.handleCreateInline("authProfileId", { [filterKey]: "role=core" });
    await flush();

    expect(mockShowInputBox).not.toHaveBeenCalled();
    expect(core.getSnapshot().savedFilters).toHaveLength(0);
  });

  it("cancelling the name prompt saves nothing", async () => {
    const controller = createInlineSavedFilterCreation({ core });
    const panel = fakePanel();
    controller.attachPanel(panel as never);
    mockShowInputBox.mockResolvedValueOnce(undefined); // cancelled

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "role=core" });
    await flush();

    expect(core.getSnapshot().savedFilters).toHaveLength(0);
    expect(panel.addSelectOption).not.toHaveBeenCalled();
  });
});

/**
 * FIX A (issue #48 PR-E / PR #64 Codex review round 2) — every saved-filter
 * mutation serializes through `configMutationLock` at the command layer, mirroring
 * the device-template lock discipline. These tests hold the shared lock with a
 * simulated reset/import critical section and assert the mutation is SERIALIZED
 * behind it (does not interleave) — a bare "was called" would be vacuous.
 *
 * Against HEAD 695d6af the saved-filter mutations run lock-free, so they land
 * WHILE the reset's critical section is still holding the lock — the
 * "still zero while the lock is held" assertions go red there.
 */
describe("FIX A — saved-filter mutations serialize under configMutationLock", () => {
  let core: NexusCore;
  let ctx: CommandContext;
  const filterKey = inventoryConfigFieldPrefixedKey(SAVED_FILTER_TARGET_FIELD_ID);

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    core = await makeCore();
    ctx = { core } as unknown as CommandContext;
    registerSavedFilterCommands(ctx);
  });

  /** Acquire the lock and hold it until the returned `release` is called — a
   *  stand-in for a Complete Reset / replace-import mutation phase in flight. */
  function holdLock(): { held: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = configMutationLock.runExclusive(() => gate);
    return { held, release };
  }

  it("manage-flow ADD does not land while the lock is held, then lands on release (kills a lock-free add)", async () => {
    const { held, release } = holdLock();
    // Empty-state manage → New Saved Filter → name + query prompts.
    mockShowInformationMessage.mockResolvedValueOnce("New Saved Filter");
    mockShowInputBox.mockResolvedValueOnce("Syd core");
    mockShowInputBox.mockResolvedValueOnce("role=core");

    const cmd = registeredCommands.get("nexus.savedFilter.manage")!();
    await flushMany();
    // The prompts have all resolved; the only thing left is the lock acquire.
    // Lock-free (HEAD): the add already ran → length 1 here. Serialized (fix):
    // it is queued behind the held lock → still zero.
    expect(core.getSnapshot().savedFilters).toHaveLength(0);

    release();
    await held;
    await cmd;
    expect(core.getSnapshot().savedFilters).toHaveLength(1);
    expect(core.getSnapshot().savedFilters[0]).toMatchObject({ name: "Syd core", filter: "role=core" });
  });

  it("delete does not land while the lock is held, then lands on release (kills a lock-free delete)", async () => {
    await core.addOrUpdateSavedFilter({ id: "f1", name: "Doomed", filter: "x=1" });
    const { held, release } = holdLock();
    mockShowQuickPick.mockResolvedValueOnce({ label: "Delete", action: "delete", filter: undefined });
    mockShowQuickPick.mockResolvedValueOnce({ label: "Doomed", filter: { id: "f1", name: "Doomed", filter: "x=1" } });
    mockShowWarningMessage.mockResolvedValueOnce("Delete");

    const cmd = registeredCommands.get("nexus.savedFilter.manage")!();
    await flushMany();
    // Lock-free (HEAD): removeSavedFilter already swept f1 → undefined here.
    // Serialized (fix): still present, queued behind the held lock.
    expect(core.getSavedFilter("f1")).toBeDefined();

    release();
    await held;
    await cmd;
    expect(core.getSavedFilter("f1")).toBeUndefined();
  });

  it("inline 'Save current filter as…' does not land while the lock is held, then lands on release", async () => {
    const controller = createInlineSavedFilterCreation({ core });
    const panel = { addSelectOption: vi.fn(), onDidDispose: vi.fn(), dispose: vi.fn() };
    controller.attachPanel(panel as never);
    const { held, release } = holdLock();
    mockShowInputBox.mockResolvedValueOnce("Reusable");

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "role=core" });
    await flushMany();
    expect(core.getSnapshot().savedFilters).toHaveLength(0);

    release();
    await held;
    await flushMany();
    expect(core.getSnapshot().savedFilters).toHaveLength(1);
    // The picker append (a webview post) fires only AFTER the lock releases, and
    // carries the raw filter as the fillValue arg (FIX B) so a re-pick fills
    // synchronously.
    expect(panel.addSelectOption).toHaveBeenCalledWith(
      SAVED_FILTER_SELECT_KEY,
      core.getSnapshot().savedFilters[0].id,
      "Reusable",
      "role=core",
      "role=core"
    );
  });

  it("EDIT re-reads the live record UNDER the lock and refuses when it diverged while the editor was open (resolve-under-lock — kills an unconditional clobber)", async () => {
    await core.addOrUpdateSavedFilter({ id: "f1", name: "Old", filter: "a=1" });
    // Manage hub: pick the row for f1 seeded at its OLD revision.
    mockShowQuickPick.mockResolvedValueOnce({ label: "Old", action: "edit", filter: { id: "f1", name: "Old", filter: "a=1" } });
    // Name prompt resolves normally.
    mockShowInputBox.mockResolvedValueOnce("Editor name");
    // While the SECOND prompt (query) is open, the SAME filter is edited elsewhere
    // — the live record diverges from the seed this editor opened on.
    mockShowInputBox.mockImplementationOnce(async () => {
      await core.addOrUpdateSavedFilter({ id: "f1", name: "Concurrent", filter: "zzz" });
      return "a=2";
    });

    await registeredCommands.get("nexus.savedFilter.manage")!();

    // Against HEAD (editSavedFilter writes unconditionally) the editor's
    // "Editor name"/"a=2" would clobber the concurrent edit. The resolve-under-lock
    // guard refuses instead: the concurrent value survives and a warning is shown.
    expect(core.getSavedFilter("f1")).toEqual({ id: "f1", name: "Concurrent", filter: "zzz" });
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("changed elsewhere while the editor was open — nothing was saved")
    );
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("updated."));
  });
});
