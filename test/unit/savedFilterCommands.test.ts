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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    expect(panel.addSelectOption).toHaveBeenCalledWith(
      SAVED_FILTER_SELECT_KEY,
      filters[0].id,
      "Reusable",
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
