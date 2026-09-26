import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/commands/types";
import { NexusCore } from "../../src/core/nexusCore";
import { InMemoryConfigRepository } from "../../src/storage/inMemoryConfigRepository";
import type { InventoryProvider } from "../../src/models/inventory";
import { InventoryProviderRegistry } from "../../src/services/inventory/providerRegistry";

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

/** A source form's provider, reduced to what the inline affordance reads: the
 *  `filter` config field it saves from, under the label that provider gives it. */
function providerWithFilterField(label: string, providerLabel = "Fixture"): InventoryProvider {
  return {
    id: `fixture-${label.toLowerCase().replace(/\W+/g, "-")}`,
    label: providerLabel,
    configFields: [{ id: "filter", label, type: "string" }],
    testConnection: async () => undefined,
    fetchInventory: async () => ({ nodes: [] }) as never
  };
}
const DEVICE_FILTER_PROVIDER = providerWithFilterField("Device Filter", "NetBox-like");
/** A provider whose source form has no filter field, so no Saved Filter picker (Proxmox's shape). */
const NO_FILTER_PROVIDER: InventoryProvider = { ...DEVICE_FILTER_PROVIDER, id: "no-filter", label: "Proxmox-like", configFields: [] };
/**
 * The command lists the registry's providers and reads each one's fields through
 * `configFieldsOf` alone (issue #195). The listed providers carry no
 * `configFields` of their own, so a read of the provider's array, which the
 * provider can change after registering, finds nothing and throws.
 */
const registryOf = (...providers: InventoryProvider[]) => {
  const fieldsOf = new Map(providers.map(({ configFields, ...listed }) => [listed as InventoryProvider, configFields] as const));
  return {
    list: () => [...fieldsOf.keys()],
    configFieldsOf: (provider: InventoryProvider) => fieldsOf.get(provider)!,
    snapshotOf: (provider: InventoryProvider) => ({ id: provider.id, label: provider.label, configFields: fieldsOf.get(provider)! })
  } as unknown as Parameters<typeof registerSavedFilterCommands>[1];
};

describe("nexus.savedFilter.manage", () => {
  let core: NexusCore;
  let ctx: CommandContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredCommands.clear();
    core = await makeCore();
    ctx = { core } as unknown as CommandContext;
    registerSavedFilterCommands(ctx, registryOf(DEVICE_FILTER_PROVIDER, NO_FILTER_PROVIDER));
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

  // Issue #152 — the same library feeds every provider's filter field, and only
  // NetBox's takes a query string: on an EVE-NG or GNS3 source the text is a
  // substring of a lab path or project name, which `role=…&site=…` never is.
  it("offers no NetBox query as the filter-query example (⊘ placeHolder 'e.g. role=core-switch&site=syd')", async () => {
    mockShowInformationMessage.mockResolvedValueOnce("New Saved Filter");
    mockShowInputBox.mockResolvedValueOnce("Syd core");
    mockShowInputBox.mockResolvedValueOnce("role=core");

    await registeredCommands.get("nexus.savedFilter.manage")!();

    const queryBox = mockShowInputBox.mock.calls[1][0] as { prompt?: string; placeHolder?: string };
    expect(`${queryBox.prompt ?? ""} ${queryBox.placeHolder ?? ""}`).not.toMatch(/role=|site=/);
  });

  it("the empty state names no provider's field (⊘ 'next to a source's Device Filter' — EVE-NG and GNS3 forms have a Lab / Project Filter)", async () => {
    mockShowInformationMessage.mockResolvedValueOnce(undefined); // dismissed

    await registeredCommands.get("nexus.savedFilter.manage")!();

    const emptyState = String(mockShowInformationMessage.mock.calls[0][0]);
    expect(emptyState).toContain("No saved filters yet");
    expect(emptyState).toContain("Save current filter as…");
    expect(emptyState).not.toContain("Device Filter");
  });

  // Codex on #164 — Proxmox source forms have no filter field, so no picker. The
  // empty state names the forms that do, from the registered providers, and a
  // registry with none of them is not pointed at a picker at all.
  it("the empty state points only at forms that have a Saved Filter picker, named from the registered providers (⊘ sending a Proxmox-only user to a picker their form never shows)", async () => {
    const labLike = providerWithFilterField("Lab Filter", "Lab-like");
    registeredCommands.clear();
    registerSavedFilterCommands(ctx, registryOf(DEVICE_FILTER_PROVIDER, NO_FILTER_PROVIDER, labLike));
    mockShowInformationMessage.mockResolvedValueOnce(undefined);

    await registeredCommands.get("nexus.savedFilter.manage")!();

    const emptyState = String(mockShowInformationMessage.mock.calls[0][0]);
    expect(emptyState).toContain("NetBox-like and Lab-like source forms");
    expect(emptyState).not.toContain("Proxmox-like");
  });

  it("names the registered label after a provider changes its label getter", async () => {
    const registry = new InventoryProviderRegistry();
    const provider = providerWithFilterField("Device Filter", "Stable Provider");
    registry.register(provider);
    Object.defineProperty(provider, "label", { get: () => { throw new Error("live label read"); } });
    registeredCommands.clear();
    registerSavedFilterCommands(ctx, registry);
    mockShowInformationMessage.mockResolvedValueOnce(undefined);

    await registeredCommands.get("nexus.savedFilter.manage")!();

    expect(String(mockShowInformationMessage.mock.calls[0][0])).toContain("Stable Provider source forms");
  });

  // Codex on #164 — provider labels come from the public API; the sentence is ours.
  it("the empty state makes each provider label inert and leaves out one with nothing visible (⊘ a label adding or reordering lines in the notification)", async () => {
    registeredCommands.clear();
    registerSavedFilterCommands(
      ctx,
      registryOf(
        providerWithFilterField("Device Filter", "Net\nBox\u202E\u200B"),
        providerWithFilterField("Lab Filter", "\u200B"),
        providerWithFilterField("Project Filter", "GNS3-like")
      )
    );
    mockShowInformationMessage.mockResolvedValueOnce(undefined);

    await registeredCommands.get("nexus.savedFilter.manage")!();

    const emptyState = String(mockShowInformationMessage.mock.calls[0][0]);
    expect(emptyState).toContain("on Net Box and GNS3-like source forms");
    expect(emptyState).not.toMatch(/[\n\u202E\u200B]/);
  });

  it("with only providers that have no filter field, the empty state offers no picker at all (⊘ a remedy the user's forms cannot show)", async () => {
    registeredCommands.clear();
    registerSavedFilterCommands(ctx, registryOf(NO_FILTER_PROVIDER));
    mockShowInformationMessage.mockResolvedValueOnce(undefined);

    await registeredCommands.get("nexus.savedFilter.manage")!();

    const emptyState = String(mockShowInformationMessage.mock.calls[0][0]);
    expect(emptyState).toContain("No saved filters yet");
    expect(emptyState).not.toContain("Save current filter as");
    expect(emptyState).not.toContain("picker");
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
    const controller = createInlineSavedFilterCreation({ core, configFields: DEVICE_FILTER_PROVIDER.configFields });
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
    const controller = createInlineSavedFilterCreation({ core, configFields: DEVICE_FILTER_PROVIDER.configFields });
    const panel = fakePanel();
    controller.attachPanel(panel as never);

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "   " });
    await flush();

    expect(mockShowWarningMessage).toHaveBeenCalled();
    expect(mockShowInputBox).not.toHaveBeenCalled();
    expect(core.getSnapshot().savedFilters).toHaveLength(0);
  });

  // Issue #152 — the warning tells the user which field to type in, so it must
  // be the field this form actually shows.
  it("the nothing-typed warning names the form's OWN filter field (⊘ 'Type a Device Filter first' on a Project Filter form)", async () => {
    const controller = createInlineSavedFilterCreation({ core, configFields: providerWithFilterField("Project Filter").configFields });
    controller.attachPanel(fakePanel() as never);

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "" });
    await flush();

    const warning = String(mockShowWarningMessage.mock.calls[0]?.[0]);
    expect(warning).toContain("Project Filter");
    expect(warning).not.toContain("Device Filter");
  });

  // Codex on #164 — the label comes from the provider, the sentence from us.
  it("the nothing-typed warning makes the field label inert (⊘ a line break, bidi override or zero-width character from a provider's label reshaping the warning)", async () => {
    const controller = createInlineSavedFilterCreation({ core, configFields: providerWithFilterField("Project\nFilter\u202E\u200B").configFields });
    controller.attachPanel(fakePanel() as never);

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "" });
    await flush();

    const warning = String(mockShowWarningMessage.mock.calls[0]?.[0]);
    expect(warning.startsWith("Project Filter is empty")).toBe(true);
    expect(warning).not.toMatch(/[\n\u202E\u200B]/);
  });

  // A provider with no filter field renders no picker, so a create that names the
  // picker's key has no field behind it — neither a text to save nor a field to
  // name in the warning. Proxmox is the built-in case.
  it("does nothing for a provider with no filter field (⊘ a fallback that still prompts, saves, or warns about a field the form does not have)", async () => {
    const controller = createInlineSavedFilterCreation({ core, configFields: NO_FILTER_PROVIDER.configFields });
    const panel = fakePanel();
    controller.attachPanel(panel as never);

    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "role=core" });
    controller.handleCreateInline(SAVED_FILTER_SELECT_KEY, { [filterKey]: "" });
    await flush();

    expect(mockShowInputBox).not.toHaveBeenCalled();
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(core.getSnapshot().savedFilters).toHaveLength(0);
    expect(panel.addSelectOption).not.toHaveBeenCalled();
  });

  it("ignores a create fired by a DIFFERENT select's key (kills a handler that fires on any create)", async () => {
    const controller = createInlineSavedFilterCreation({ core, configFields: DEVICE_FILTER_PROVIDER.configFields });
    const panel = fakePanel();
    controller.attachPanel(panel as never);

    controller.handleCreateInline("authProfileId", { [filterKey]: "role=core" });
    await flush();

    expect(mockShowInputBox).not.toHaveBeenCalled();
    expect(core.getSnapshot().savedFilters).toHaveLength(0);
  });

  it("cancelling the name prompt saves nothing", async () => {
    const controller = createInlineSavedFilterCreation({ core, configFields: DEVICE_FILTER_PROVIDER.configFields });
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
    registerSavedFilterCommands(ctx, registryOf(DEVICE_FILTER_PROVIDER, NO_FILTER_PROVIDER));
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
    const controller = createInlineSavedFilterCreation({ core, configFields: DEVICE_FILTER_PROVIDER.configFields });
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
