import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
let onDidReceiveMessageHandler: ((msg: Record<string, unknown>) => void) | undefined;
let onDidDisposeHandler: (() => void) | undefined;
let lastHtml = "";
/**
 * Every assignment to `webview.html`, i.e. every `render()`. Counted rather than merely
 * captured because "did NOT re-render" is a real assertion in this file: re-rendering rebuilds
 * the panel from the STORE, so doing it after a failed save silently discards the edit the user
 * is being told was not saved.
 */
let htmlWrites = 0;

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: {
        set html(value: string) {
          lastHtml = value;
          htmlWrites++;
        },
        get html() {
          return lastHtml;
        },
        onDidReceiveMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
          onDidReceiveMessageHandler = handler;
          return { dispose: vi.fn() };
        }),
        postMessage: (...args: unknown[]) => mockPostMessage(...args)
      },
      onDidDispose: vi.fn((handler: () => void) => {
        onDidDisposeHandler = handler;
        return { dispose: vi.fn() };
      }),
      reveal: vi.fn(),
      dispose: vi.fn()
    })),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args)
  },
  ViewColumn: { Active: 1 },
  ConfigurationTarget: { Global: 1 },
  commands: { executeCommand: vi.fn() }
}));

vi.mock("node:crypto", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:crypto")>();
  return {
    ...orig,
    randomBytes: (n: number) => Buffer.alloc(n, "a")
  };
});

import type { InMemoryMacroStore } from "../../src/storage/inMemoryMacroStore";
import type { DuplicateIdMacroStore } from "../helpers/duplicateIdMacroStore";
import type { TerminalMacro } from "../../src/models/terminalMacro";

// macroSettings holds module-level `activeStore`; resetModules() between cases
// clears it, so both the store wiring and the panel must come from the SAME
// freshly-imported module graph. These are populated by `harness()`.
let store: InMemoryMacroStore;
let getMacros: () => TerminalMacro[];

async function harness(macros: TerminalMacro[]): Promise<void> {
  vi.resetModules();
  const macroSettings = await import("../../src/macroSettings");
  const { InMemoryMacroStore } = await import("../../src/storage/inMemoryMacroStore");
  store = new InMemoryMacroStore();
  await store.initialize();
  // save() assigns ids to entries that lack one
  if (macros.length > 0) {
    await store.save(macros);
  }
  macroSettings.setActiveMacroStore(store);
  getMacros = macroSettings.getMacros;
}

async function openPanel(index?: number) {
  const { MacroEditorPanel } = await import("../../src/ui/macroEditorPanel");
  MacroEditorPanel.open(index);
  return { sendMessage: onDidReceiveMessageHandler! };
}

describe("MacroEditorPanel id-keyed save/delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `vi.clearAllMocks()` clears CALLS but keeps implementations, so a
    // mockImplementation that performs a concurrent store write (see the
    // staleness cases below) would otherwise leak into every later test in
    // this file.
    mockShowWarningMessage.mockReset();
    onDidReceiveMessageHandler = undefined;
    onDidDisposeHandler = undefined;
    lastHtml = "";
    htmlWrites = 0;
  });

  /**
   * The Folder input's rendered value, read back out of the HTML the panel
   * produced. Tests post THIS back as `group`, exactly as the webview's
   * `group: folderVal || null` does — so a renderer that shows the wrong thing
   * and a save handler that mishandles it are both in scope, instead of the
   * test hard-coding what it wishes the webview had sent.
   */
  function renderedFolderValue(): string {
    const match = /<input type="text" id="macro-folder" value="([^"]*)"/.exec(lastHtml);
    return match ? match[1] : "";
  }

  /**
   * The render key stamped into the page the panel has CURRENTLY drawn, read
   * back out of that page exactly as the webview would post it.
   *
   * Tests that let a write land before they send capture this BEFORE the write:
   * the page that posts is the one that was on screen when the user clicked, and
   * naming it is what makes the message a stale one rather than an impossible
   * one. Nothing about the id travels with it — see `MacroEditorPanel.renderedRefs`.
   */
  function renderedGeneration(): number {
    const match = /var currentRenderGeneration = (\d+);/.exec(lastHtml);
    return match ? Number(match[1]) : -1;
  }

  it("save by id targets the correct macro after an external reorder", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;

    // Panel was opened on Beta (render-time index 1)
    const { sendMessage } = await openPanel(1);
    const betaPage = renderedGeneration();

    // External reorder: Beta is now at index 0
    await store.save([before[1], before[0]]);

    // Save carries the stale render-time index 1 but the stable Beta id, from
    // the page that was on screen before the reorder — the ordinary case, and
    // the one a witness keyed only to the LATEST render would wrongly refuse.
    await sendMessage({
      type: "save",
      index: 1,
      id: betaId,
      renderGeneration: betaPage,
      name: "Beta-edited",
      text: "b2",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null
    });

    const after = getMacros();
    const beta = after.find((m) => m.id === betaId);
    const alpha = after.find((m) => m.id === before[0].id);
    expect(beta?.name).toBe("Beta-edited");
    expect(beta?.text).toBe("b2");
    // Alpha must be untouched — the stale index 1 now points at Alpha
    expect(alpha?.name).toBe("Alpha");
    expect(alpha?.text).toBe("a");
  });

  it("save with a stale id (macro deleted externally) does not write or overwrite another macro", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;

    const { sendMessage } = await openPanel(1);
    const betaPage = renderedGeneration();

    // Beta deleted externally; only Alpha remains
    await store.save([before[0]]);

    await sendMessage({
      type: "save",
      index: 1,
      id: betaId,
      renderGeneration: betaPage,
      name: "Beta-edited",
      text: "b2",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null
    });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Alpha");
    expect(after[0].text).toBe("a");
    // No "saved" ack — the save was rejected
    expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  describe("duplicate macro ids (a list that predates the unique-id invariant)", () => {
    // The editor resolves its target by id, so two macros sharing one make "which macro
    // did the user open" unanswerable. InMemoryMacroStore re-keys duplicates on save, so
    // this needs a store that surfaces persisted state verbatim — which is exactly what
    // VscodeMacroStore.reloadFromState() now does, having stopped repairing ids on load.
    //
    // `DuplicateIdMacroStore` rather than a store double written inline here: its
    // `save()` runs the REAL `assignUniqueMacroIds()`, which is the whole mechanism
    // the render-time-witness cases below turn on. A double that carried duplicates
    // across `save()` would make those cases unwritable (see that class's doc).
    async function harnessWithDuplicateIds(
      initial: TerminalMacro[] = [
        { id: "dup", name: "Alpha", text: "a" },
        { id: "dup", name: "Beta", text: "b" }
      ],
      openIndex = 1 // opened on the SECOND twin
    ): Promise<{
      store: DuplicateIdMacroStore;
      macros: () => TerminalMacro[];
      sendMessage: (msg: Record<string, unknown>) => void;
    }> {
      vi.resetModules();
      const macroSettings = await import("../../src/macroSettings");
      const { DuplicateIdMacroStore: FreshStore } = await import("../helpers/duplicateIdMacroStore");
      const dupStore = new FreshStore(initial);
      macroSettings.setActiveMacroStore(dupStore);
      const { MacroEditorPanel } = await import("../../src/ui/macroEditorPanel");
      MacroEditorPanel.open(openIndex);
      return { store: dupStore, macros: () => dupStore.getAll(), sendMessage: onDidReceiveMessageHandler! };
    }

    /**
     * The Macro Editor's own save payload, as its webview posts it
     * (macroEditorHtml.ts) — `renderGeneration` read back out of the page that
     * is on screen right now, which is what a click in that page would send.
     * Overriding it is how a case reaches for an OLDER page.
     */
    function dupSaveMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: "save",
        index: 1,
        id: "dup",
        renderGeneration: renderedGeneration(),
        name: "Beta-edited",
        text: "b2",
        secret: false,
        keybinding: null,
        triggerPattern: null,
        triggerCooldown: 3,
        triggerInterval: null,
        triggerInitiallyDisabled: false,
        triggerScope: "all-terminals",
        triggerProfileId: null,
        ...overrides
      };
    }

    it("refuses to save rather than write the edited macro over its twin", async () => {
      const { macros, sendMessage } = await harnessWithDuplicateIds();

      // The honest message from the page on screen: the panel drew it over
      // `[Alpha(dup), Beta(dup)]`, so the reference it looks up under that page's
      // key is ambiguous, and so is the array as it stands. Both halves agree here;
      // the cases below are the ones where they do not.
      await sendMessage(dupSaveMsg());

      // Taking the first match would have turned Alpha into "Beta-edited", silently
      // destroying it — and the id conflict makes that the FIRST macro, not the one the
      // user was looking at.
      expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
      expect(macros().map((m) => m.text)).toEqual(["a", "b"]);
      expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("same internal id")
      );
    });

    it("refuses to delete rather than remove the wrong macro", async () => {
      const { macros, sendMessage } = await harnessWithDuplicateIds();

      await sendMessage({ type: "delete", index: 1, id: "dup", renderGeneration: renderedGeneration() });

      expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("same internal id")
      );
    });

    /**
     * The form is the longest-lived reference to a macro in this feature, and until
     * now the only ref-taking surface with no render-time witness: a tree row carries
     * `MacroTreeItem.identityConflict`, a drag captures one host-side, and the webview
     * carried an id and nothing else.
     *
     * That gap is reachable without any exotic timing. `[Alpha(dup), Beta(dup)]`, form
     * open on Beta; ANY write at all lands (a drag onto a folder, another command,
     * an import) and `assignUniqueMacroIds()` lets Alpha KEEP `dup` while Beta is
     * handed a fresh one. The panel re-renders, but a click in the old DOM — or a
     * message already in IPC flight — still carries `dup`. Checked against the array
     * as it stands then, `dup` has exactly ONE holder and nothing looks wrong, so the
     * form's contents (Beta's name, text, secret flag) are written over ALPHA, under
     * a "saved" toast. Only what was true at render can rule that out.
     *
     * The witness therefore lives in the PANEL, keyed by render
     * (`MacroEditorPanel.renderedRefs`); the page carries only that key. An earlier
     * revision posted the answer itself back as a boolean, which cannot be made to
     * work: a `false` that is stale, forged or merely defaulted is the same bytes as
     * an honest one, so the sender could assert its way past the check. The
     * "assertions" block below is that attack, and every case in it must stay red
     * against a host that reads any of it.
     */
    describe("render-time identity witness", () => {
      /** The unrelated, id-preserving write that nevertheless re-keys the twins. */
      async function rekey(store: DuplicateIdMacroStore): Promise<void> {
        const latest = store.getAll();
        await store.save(latest);
      }

      it("stamps a render key into the page and nothing else about the id", async () => {
        const { store } = await harnessWithDuplicateIds();
        // The page is drawn over a SHARED id and says so nowhere: what the panel
        // knew is in `renderedRefs`, under this key. A page that carried the answer
        // is a page that can be edited into carrying a different one.
        const first = renderedGeneration();
        expect(first).toBeGreaterThan(0);
        expect(lastHtml).not.toMatch(/[Aa]mbiguous/);

        // Every render is a new page and a new key, so a message can always be
        // placed against the render it actually came from.
        await rekey(store);
        expect(renderedGeneration()).toBeGreaterThan(first);
      });

      it("refuses a save from a form rendered over a shared id, even though the id is unique by the time the message lands", async () => {
        const { store, macros, sendMessage } = await harnessWithDuplicateIds();
        const sharedPage = renderedGeneration(); // the page the user is looking at
        await rekey(store);
        // The state the resolver now faces: `dup` has exactly one holder, and it is
        // ALPHA — the macro the user never opened.
        expect(macros().filter((m) => m.id === "dup")).toHaveLength(1);
        expect(macros()[0].id).toBe("dup");

        await sendMessage(dupSaveMsg({ renderGeneration: sharedPage }));

        expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
        expect(macros().map((m) => m.text)).toEqual(["a", "b"]);
        expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
        expect(mockShowWarningMessage).toHaveBeenCalledWith(
          expect.stringContaining("same internal id")
        );
      });

      it("refuses a delete from a form rendered over a shared id after the same re-key", async () => {
        const { store, macros, sendMessage } = await harnessWithDuplicateIds();
        const sharedPage = renderedGeneration();
        await rekey(store);
        mockShowWarningMessage.mockResolvedValue("Delete");

        await sendMessage({ type: "delete", index: 1, id: "dup", renderGeneration: sharedPage });

        // Both survive. Without the witness this deletes Alpha, after a modal that
        // names Alpha — so the confirmation reads correct and the wrong macro dies.
        expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
        expect(mockShowWarningMessage).toHaveBeenCalledWith(
          expect.stringContaining("same internal id")
        );
      });

      /**
       * Codex's three adversarial messages, which is how the posted-boolean design
       * died: it treated a literal `false` as "checked, and it was unique", and a
       * literal `false` is indistinguishable whether it is stale, forged, defaulted
       * or honest. Each case below carries that exact forgery, and each must fail
       * against a host that reads it — `["Beta-edited", "Beta"]` was the observed
       * outcome of the first one.
       *
       * They differ in what they claim about WHICH page sent them, because that is
       * the only thing the panel accepts from the message at all:
       */
      describe("a message that asserts its own uniqueness", () => {
        it("with no render key — from no page this panel ever drew", async () => {
          const { store, macros, sendMessage } = await harnessWithDuplicateIds();
          await rekey(store);
          const forged = dupSaveMsg({ idAmbiguous: false });
          delete forged.renderGeneration;

          await sendMessage(forged);

          expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
          expect(macros().map((m) => m.text)).toEqual(["a", "b"]);
          expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
          expect(mockShowWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("changed externally")
          );
        });

        it("with the honest key of the page drawn over the shared id — the wire cannot overrule the record", async () => {
          const { store, macros, sendMessage } = await harnessWithDuplicateIds();
          const sharedPage = renderedGeneration();
          await rekey(store);

          await sendMessage(dupSaveMsg({ renderGeneration: sharedPage, idAmbiguous: false }));

          expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
          expect(macros().map((m) => m.text)).toEqual(["a", "b"]);
          expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
          expect(mockShowWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("same internal id")
          );
        });

        it("with the CURRENT key, which belongs to a page drawn over a different id", async () => {
          // After the re-key the panel redrew over `Beta(new-id)`. Naming that page
          // while carrying `dup` is not a stale message, it is an impossible one:
          // the record under that key says nothing about `dup`.
          const { store, macros, sendMessage } = await harnessWithDuplicateIds();
          await rekey(store);
          expect(macros()[1].id).not.toBe("dup");

          await sendMessage(dupSaveMsg({ renderGeneration: renderedGeneration(), idAmbiguous: false }));

          expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
          expect(macros().map((m) => m.text)).toEqual(["a", "b"]);
          expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
        });

        it("...and the same forgery on DELETE takes the same path", async () => {
          const { store, macros, sendMessage } = await harnessWithDuplicateIds();
          await rekey(store);
          mockShowWarningMessage.mockResolvedValue("Delete");

          await sendMessage({ type: "delete", index: 1, id: "dup", idAmbiguous: false });

          expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
        });
      });

      it("refuses a render key of the wrong TYPE — only a number can name a render", async () => {
        const { store, macros, sendMessage } = await harnessWithDuplicateIds();
        const sharedPage = renderedGeneration();
        await rekey(store);

        await sendMessage(dupSaveMsg({ renderGeneration: String(sharedPage) }));

        expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
        expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
      });

      it("a form rendered over a UNIQUE id still saves normally — the guard must not refuse every form", async () => {
        // The counterweight. Same re-key, same stale index, same older page, but the
        // id was never shared: `Beta` must still be the macro that gets written. A
        // rule that refused whenever the rendered index no longer matched — or
        // whenever the page was not the newest one — would pass every case above and
        // break this one.
        const { store, macros, sendMessage } = await harnessWithDuplicateIds([
          { id: "a", name: "Alpha", text: "a" },
          { id: "b", name: "Beta", text: "b" }
        ]);
        const betaPage = renderedGeneration();
        await store.save([store.getAll()[1], store.getAll()[0]]); // Beta now at index 0

        await sendMessage(dupSaveMsg({ id: "b", renderGeneration: betaPage }));

        expect(macros().find((m) => m.id === "b")?.name).toBe("Beta-edited");
        expect(macros().find((m) => m.id === "a")?.name).toBe("Alpha");
        expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
      });

      it("keeps only the last few renders — a page far enough back fails closed", async () => {
        // `MAX_RETAINED_RENDERS` bounds `renderedRefs`, and the eviction must fail
        // CLOSED: an aged-out page is answered exactly like one that never existed,
        // never by falling back to the live array.
        //
        // The fixture is a page whose reference WOULD resolve — ids unique, macro
        // still present — so "refused" can only be the eviction. Over an ambiguous
        // page the refusal would come from the record itself and prove nothing.
        const { store, macros, sendMessage } = await harnessWithDuplicateIds([
          { id: "a", name: "Alpha", text: "a" },
          { id: "b", name: "Beta", text: "b" }
        ]);
        const betaPage = renderedGeneration();
        for (let i = 0; i < 10; i++) {
          await rekey(store); // each store write re-renders, retiring one more page
        }
        expect(renderedGeneration()).toBeGreaterThan(betaPage + 8);

        await sendMessage(dupSaveMsg({ id: "b", renderGeneration: betaPage }));

        expect(macros().map((m) => m.name)).toEqual(["Alpha", "Beta"]);
        expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
        expect(mockShowWarningMessage).toHaveBeenCalledWith(
          expect.stringContaining("changed externally")
        );
      });
    });
  });

  it("delete by id removes the correct macro after an external reorder", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;
    const alphaId = before[0].id!;
    mockShowWarningMessage.mockResolvedValue("Delete");

    const { sendMessage } = await openPanel(1);
    const betaPage = renderedGeneration();

    // External reorder: Beta now at index 0
    await store.save([before[1], before[0]]);

    // Delete carries the stale render-time index 1 but the stable Beta id
    await sendMessage({ type: "delete", index: 1, id: betaId, renderGeneration: betaPage });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(alphaId);
    expect(after[0].name).toBe("Alpha");
  });

  it("delete with a stale id (already deleted externally) does not remove another macro", async () => {
    await harness([
      { name: "Alpha", text: "a" },
      { name: "Beta", text: "b" }
    ]);
    const before = getMacros();
    const betaId = before[1].id!;
    mockShowWarningMessage.mockResolvedValue("Delete");

    const { sendMessage } = await openPanel(1);
    const betaPage = renderedGeneration();

    // Beta deleted externally
    await store.save([before[0]]);

    await sendMessage({ type: "delete", index: 1, id: betaId, renderGeneration: betaPage });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Alpha");
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it("a store failure is REPORTED rather than swallowed — notification, in-panel error, and no false 'saved'", async () => {
    // `onDidReceiveMessage` is a VS Code EVENT listener, not a command handler: nothing awaits
    // the promise it returns and nothing reports its rejection. So a rejecting `handleMessage`
    // produces no notification, no in-panel error, and — because only a `saved` message clears
    // it — a webview still showing "Unsaved changes" with no explanation.
    //
    // This is not theoretical. `VscodeMacroStore.save()` writes both `globalState` and
    // `SecretStorage`, and either can reject — a locked OS keyring, a corrupt or read-only
    // extension storage database. A save republishes every secret the window holds, so a
    // failing keyring rejects EVERY save containing any secret macro, including an edit to an
    // unrelated plain one. This editor is the primary secret-editing surface. Every other
    // `saveMacros()` call site in the extension is awaited inside a registered command
    // handler, where VS Code reports the rejection itself; this one is the exception.
    await harness([{ name: "Alpha", text: "a\n" }]);
    const { sendMessage } = await openPanel(0);
    const id = getMacros()[0].id!;

    const failure = new Error("EPERM: globalState is not writable, so nothing was saved.");
    vi.spyOn(store, "save").mockRejectedValue(failure);
    const rendersBefore = htmlWrites;

    // Must not reject: nothing upstream can catch it.
    await expect(
      Promise.resolve(
        sendMessage({
          type: "save",
          index: 0,
          id,
          name: "Alpha (renamed)",
          text: "a\n",
          secret: false,
          keybinding: null,
          triggerPattern: null,
          triggerCooldown: 3,
          triggerInterval: null,
          triggerInitiallyDisabled: false,
          triggerScope: "all-terminals",
          triggerProfileId: null,
          variables: [],
          renderGeneration: renderedGeneration()
        })
      )
    ).resolves.toBeUndefined();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("globalState is not writable")
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "saveError", field: "save" })
    );
    // The save did not happen, so it must not be reported as one — `saved` is the only thing
    // that clears the dirty flag, and a cleared flag on an unsaved edit is how the edit gets
    // closed and lost.
    expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });
    // And the panel is NOT rebuilt. `render()` reads the STORE, which for a failed save still
    // holds the pre-edit macro, so re-rendering would throw away the very text the error is
    // telling the user was not saved — the exact outcome reporting the failure exists to
    // avoid. Reporting the error and then calling `render()` satisfies every other assertion
    // in this test; it fails here.
    expect(htmlWrites).toBe(rendersBefore);
    expect(lastHtml).toContain("Alpha");
    expect(lastHtml).not.toContain("Alpha (renamed)");
  });

  it("a store failure on DELETE is reported as a failed delete, and does not rebuild the panel either", async () => {
    // The same store call backs both Save and Delete, so the one `catch` at the message
    // subscription sees both. Reporting a failed delete as "could not save the macro" describes
    // an action the user did not take, and the in-panel slot said "Not saved:" for something
    // that was never a save.
    await harness([{ name: "Alpha", text: "a\n" }]);
    const { sendMessage } = await openPanel(0);
    const id = getMacros()[0].id!;
    mockShowWarningMessage.mockResolvedValue("Delete");

    vi.spyOn(store, "save").mockRejectedValue(new Error("EACCES: permission denied"));
    const rendersBefore = htmlWrites;

    await expect(
      Promise.resolve(sendMessage({ type: "delete", index: 0, id, renderGeneration: renderedGeneration() }))
    ).resolves.toBeUndefined();

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("could not delete the macro")
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "saveError", field: "save", message: expect.stringContaining("Not deleted:") })
    );
    expect(htmlWrites).toBe(rendersBefore);
  });

  it("creating a new macro (null id) appends and assigns an id", async () => {
    await harness([]);
    const { sendMessage } = await openPanel();

    await sendMessage({
      type: "save",
      index: null,
      id: null,
      name: "Fresh",
      text: "f",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null
    });

    const after = getMacros();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Fresh");
    expect(typeof after[0].id).toBe("string");
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
  });

  /**
   * `renderGeneration` is part of the base because the webview always sends it:
   * it is baked next to `currentId` at render and posted back with every save
   * and delete (macroEditorHtml.ts). Read at CALL time, so it names the page the
   * panel currently has drawn — a case that wants an older page overrides it,
   * and one that wants no page at all deletes it. See the "render-time identity
   * witness" block for what each is worth.
   */
  function baseSaveMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "save",
      index: null,
      id: null,
      renderGeneration: renderedGeneration(),
      name: "Test",
      text: "run $host",
      secret: false,
      keybinding: null,
      triggerPattern: null,
      triggerCooldown: 3,
      triggerInterval: null,
      triggerInitiallyDisabled: false,
      triggerScope: "all-terminals",
      triggerProfileId: null,
      variables: [],
      ...overrides
    };
  }

  describe("variables validation (§9.4) and persistence (§9.5)", () => {
    it("rejects an invalid variable name on the correct row", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ variables: [{ name: "9bad" }] }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variable",
        row: 0,
        message: expect.stringContaining("not a valid variable name")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects a duplicate variable name on the second row", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ variables: [{ name: "host" }, { name: "host" }] }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variable",
        row: 1,
        message: expect.stringContaining("Duplicate variable name")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects more than the max variables as an array-level error, not a row error", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();
      const variables = Array.from({ length: 11 }, (_, i) => ({ name: `v${i}` }));

      await sendMessage(baseSaveMsg({ variables }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variables",
        message: expect.stringContaining("at most 10 variables")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects a masked variable with a non-empty default", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({
        variables: [{ name: "password", secret: true, default: "hunter2" }]
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "variable",
        row: 0,
        message: expect.stringContaining("masked and cannot have a default value")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects a macro declaring both variables and a trigger pattern, on the trigger field", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({
        triggerPattern: "foo",
        variables: [{ name: "host" }]
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("prompt for input or auto-trigger")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("rejects a macro that both runs outside its session and auto-triggers, on the Run In field", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ triggerPattern: "foo", runIn: "browser" }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "runIn",
        message: expect.stringContaining("auto-trigger or run outside its session")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("persists a non-default runIn and drops it again when the macro goes back to the session", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ text: "https://${profile.ipmiHost}/", runIn: "browser" }));
      expect(getMacros()[0].runIn).toBe("browser");

      const macroId = getMacros()[0].id!;
      const { sendMessage: sendAgain } = await openPanel(0);
      await sendAgain(baseSaveMsg({ index: 0, id: macroId, text: "https://x/", runIn: "session" }));

      // Absent MEANS session — a stored "session" would put a field on the
      // record that no build before this one understands, and leaving the old
      // value alive through the `{ ...existingMacro }` spread would keep the
      // macro opening a browser after the user said not to.
      expect(getMacros()[0].runIn).toBeUndefined();
    });

    it("persists a valid variables array, dropping empty label/default fields", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({
        variables: [
          { name: "host", label: "Host" },
          { name: "password", secret: true }
        ]
      }));

      const after = getMacros();
      expect(after).toHaveLength(1);
      expect(after[0].variables).toEqual([
        { name: "host", label: "Host" },
        { name: "password", secret: true }
      ]);
    });

    it("clearing all variable rows actually clears the stored array, not resurrected via the spread (§9.5)", async () => {
      await harness([
        { name: "IPMI", text: "run $host", variables: [{ name: "host" }] }
      ]);
      const before = getMacros();
      const macroId = before[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        text: "run $host",
        variables: []
      }));

      const after = getMacros();
      expect(after).toHaveLength(1);
      expect(after[0].variables).toBeUndefined();
      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
    });
  });

  describe("hidden variable declarations block a suppressed-trigger save (Fix B)", () => {
    it("rejects a save that would un-suppress a trigger hidden behind malformed variable declarations", async () => {
      // The stored macro carries an invalid-named declaration that
      // getValidMacroVariables() filters out before the editor builds its rows — the
      // editor renders zero variable rows for it, but MacroAutoTrigger still keys
      // suppression on the raw (non-empty) array. Before Fix B, opening this macro
      // and pressing Save (submitting zero variables, trigger unchanged) deleted the
      // array and left the trigger live: the secret text would start auto-sending on
      // any output matching "Password:".
      await harness([
        {
          id: "hidden-1",
          name: "Password",
          text: "hunter2\n",
          secret: true,
          triggerPattern: "[Pp]assword:",
          variables: [{ name: "2bad" }]
        }
      ]);
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: "hidden-1",
        name: "Password",
        text: "hunter2\n",
        secret: true,
        triggerPattern: "[Pp]assword:",
        variables: []
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("malformed variable declarations")
      });
      expect(mockPostMessage).not.toHaveBeenCalledWith({ type: "saved" });

      // Nothing was mutated — the save was rejected before saveMacros() ran.
      const after = getMacros();
      expect(after[0].triggerPattern).toBe("[Pp]assword:");
      expect(after[0].variables).toEqual([{ name: "2bad" }]);
    });

    it("allows clearing hidden malformed declarations when no trigger is being saved", async () => {
      await harness([
        {
          id: "hidden-2",
          name: "Cmd",
          text: "run\n",
          variables: [{ name: "2bad" }]
        }
      ]);
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: "hidden-2",
        name: "Cmd",
        text: "run\n",
        triggerPattern: null,
        variables: []
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
      const after = getMacros();
      expect(after[0].variables).toBeUndefined();
      expect(after[0].triggerPattern).toBeUndefined();
    });

    it("hidden declarations plus an incoming variables payload hits the ordinary variables/trigger conflict, not the new hidden-declaration message", async () => {
      await harness([
        {
          id: "hidden-3",
          name: "Password",
          text: "hunter2\n",
          secret: true,
          triggerPattern: "[Pp]assword:",
          variables: [{ name: "2bad" }]
        }
      ]);
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: "hidden-3",
        name: "Password",
        text: "hunter2\n",
        secret: true,
        triggerPattern: "[Pp]assword:",
        variables: [{ name: "host" }]
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("prompt for input or auto-trigger")
      });
      expect(mockPostMessage).not.toHaveBeenCalledWith({
        type: "saveError",
        field: "trigger",
        message: expect.stringContaining("malformed variable declarations")
      });
      expect(getMacros()[0].triggerPattern).toBe("[Pp]assword:");
    });
  });

  describe("Folder field round-trip (§4.11)", () => {
    it("persists a valid folder on a new macro", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ group: "Cisco/Routers" }));

      expect(getMacros()[0].group).toBe("Cisco/Routers");
      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
    });

    it("null/absent group persists as no group at all", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ group: null }));

      expect(getMacros()[0].group).toBeUndefined();
    });

    it("clearing a previously-set group on an existing macro actually removes it (not resurrected via the spread)", async () => {
      await harness([{ name: "M", text: "t", group: "Cisco" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({ index: 0, id: macroId, group: null }));

      expect(getMacros()[0].group).toBeUndefined();
    });

    it("rejects a path-traversal group and does not persist the macro", async () => {
      await harness([]);
      const { sendMessage } = await openPanel();

      await sendMessage(baseSaveMsg({ group: "../secrets" }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "folder",
        message: expect.stringContaining("Invalid folder path")
      });
      expect(getMacros()).toHaveLength(0);
    });

    it("a name-only save PRESERVES a stored-but-unrenderable folder path byte-for-byte, and shows it so it can be corrected", async () => {
      // The most ordinary write path there is: open a macro whose stored group
      // is `Cisco\Routers` (a Windows separator, typed into settings.json and
      // absorbed verbatim), change ONLY the name, Save. The editor used to
      // sanitize that group to an empty Folder field, the webview posted
      // `group: null`, and the host deleted it — making §4.9.3's "kept
      // byte-for-byte and shown at the root until you correct it" false, on the
      // one surface where correcting it is supposed to happen.
      await harness([{ name: "Old", text: "x", group: "Cisco\\Routers" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      // Half one: there is now something to correct.
      expect(renderedFolderValue()).toBe("Cisco\\Routers");

      // Half two: leaving it alone keeps it. The payload is whatever the
      // webview would actually have sent for that rendered field.
      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        name: "New",
        text: "x",
        group: renderedFolderValue() || null
      }));

      const after = getMacros();
      expect(after[0].name).toBe("New");
      expect(after[0].group).toBe("Cisco\\Routers");
      expect(mockPostMessage).toHaveBeenCalledWith({ type: "saved" });
    });

    it("EDITING an unrenderable folder path is validated like any other input — untouched means preserved, touched means decide", async () => {
      await harness([{ name: "Old", text: "x", group: "Cisco\\Routers" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        name: "New",
        text: "x",
        group: "Cisco\\Routers\\Old" // the user typed into the field
      }));

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: "saveError",
        field: "folder",
        message: expect.stringContaining("Invalid folder path")
      });
      expect(getMacros()[0].name).toBe("Old"); // nothing saved
      expect(getMacros()[0].group).toBe("Cisco\\Routers");
    });

    it("correcting an unrenderable folder path in the field is what actually rewrites it", async () => {
      await harness([{ name: "Old", text: "x", group: "Cisco\\Routers" }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      await sendMessage(baseSaveMsg({ index: 0, id: macroId, name: "Old", text: "x", group: "Cisco/Routers" }));

      expect(getMacros()[0].group).toBe("Cisco/Routers");
    });

    it("a pathological multi-megabyte stored group never reaches the DOM, and survives a name-only save", async () => {
      // §4.2's stress case, reachable from a hand-edited settings.json through
      // the legacy-absorption path. Rendering it raw would ship 8 MB into the
      // webview on every render; deleting it would be the same data loss as
      // above. Neither: the field stays blank with a notice, and the value is
      // preserved.
      const huge = "X".repeat(8_000_000);
      await harness([{ name: "Old", text: "x", group: huge }]);
      const macroId = getMacros()[0].id!;
      const { sendMessage } = await openPanel(0);

      expect(renderedFolderValue()).toBe("");
      expect(lastHtml.length).toBeLessThan(1_000_000);

      await sendMessage(baseSaveMsg({
        index: 0,
        id: macroId,
        name: "New",
        text: "x",
        group: renderedFolderValue() || null
      }));

      expect(getMacros()[0].name).toBe("New");
      expect(getMacros()[0].group).toBe(huge);
    });

    it("addToFolder's seed (openNew({ group })) round-trips into the rendered HTML, and a save with no folder change persists that seeded value", async () => {
      await harness([]);
      const { MacroEditorPanel } = await import("../../src/ui/macroEditorPanel");
      MacroEditorPanel.openNew({ group: "Cisco" });
      expect(lastHtml).toContain('<input type="text" id="macro-folder" value="Cisco"');

      await onDidReceiveMessageHandler!(baseSaveMsg({ group: "Cisco" }));

      expect(getMacros()[0].group).toBe("Cisco");
    });
  });

  /**
   * The Macro Editor was the 4th and 5th instance of the shape `mutateMacroById`
   * exists to kill: snapshot `getMacros()`, resolve by id, then hold that
   * snapshot and index across an await and write the whole array back.
   *
   * The awaits are real dialogs, and the writer that overlaps them is in the
   * SAME window — `confirmBindingWarnings` is a plain non-modal
   * `showWarningMessage` (macroSettings.ts), so the window stays fully
   * interactive while its toast is up, and `{ modal: true }` on the delete
   * confirmation blocks only the user's input, never the extension host's async
   * work.
   */
  describe("writes re-resolve against a freshly read array, never a pre-dialog snapshot", () => {
    it("THE EDITED macro's own concurrent folder move survives the save, when the Folder field was untouched", async () => {
      // The case the sibling test below cannot see. It moves a DIFFERENT macro,
      // so re-resolving by id is enough to protect it — the whole defect here is
      // that the record being saved is composed from the PRE-dialog snapshot and
      // then written over the latest one, so every field on the edited macro
      // reverts, `group` included.
      //
      // Journey: editor open on M (at the root), assign ctrl+shift+f, Save →
      // the non-modal "common VS Code shortcut / Use Anyway" toast appears →
      // while it is up the user drags M ITSELF into "Cisco" → Use Anyway. The
      // save changed the macro's text, never its Folder field, so it has no
      // business deciding where M lives.
      await harness([{ name: "M", text: "m" }]);
      const edited = getMacros()[0];
      const { sendMessage } = await openPanel(0);

      mockShowWarningMessage.mockImplementation(async () => {
        await store.save(getMacros().map((m) => (m.id === edited.id ? { ...m, group: "Cisco" } : m)));
        return "Use Anyway";
      });

      await sendMessage(baseSaveMsg({
        index: 0,
        id: edited.id,
        name: "M",
        text: "m2",
        keybinding: "ctrl+shift+f"
      }));

      const after = getMacros()[0];
      expect(mockShowWarningMessage).toHaveBeenCalled(); // the toast really fired
      expect(after.group).toBe("Cisco"); // the drag survived
      expect(after.text).toBe("m2"); // ...and the edit still applied
      expect(after.keybinding).toBe("ctrl+shift+f");
    });

    it("a macro dragged into a folder while the NON-modal binding warning is up is not silently reverted", async () => {
      // The review's exact journey: editor open on M, assign ctrl+shift+f,
      // Save → "is a common VS Code shortcut / Use Anyway" toast appears →
      // while it is up the user drags another macro into a folder → Use Anyway.
      //
      // This one moves a macro OTHER than the edited one, which is what makes it
      // a test of the write ROUTE (re-resolve and touch one slot, never write
      // back the whole pre-dialog array). The edited macro's own fields need the
      // separate test above.
      await harness([
        { name: "M", text: "m" },
        { name: "Other", text: "o" }
      ]);
      const [edited, other] = getMacros();
      const { sendMessage } = await openPanel(0);

      mockShowWarningMessage.mockImplementation(async () => {
        await store.save(
          getMacros().map((m) => (m.id === other.id ? { ...m, group: "Cisco" } : m))
        );
        return "Use Anyway";
      });

      await sendMessage(baseSaveMsg({
        index: 0,
        id: edited.id,
        name: "M",
        text: "m2",
        keybinding: "ctrl+shift+f"
      }));

      const after = getMacros();
      expect(mockShowWarningMessage).toHaveBeenCalled(); // the toast really fired
      expect(after.find((m) => m.id === other.id)?.group).toBe("Cisco"); // the drag survived
      expect(after.find((m) => m.id === edited.id)?.text).toBe("m2"); // ...and the save applied
      expect(after.find((m) => m.id === edited.id)?.keybinding).toBe("ctrl+shift+f");
    });

    it("a macro DELETED while the non-modal binding warning is up is not resurrected by the save", async () => {
      // The other half of writing back a stale array: it does not just revert
      // edits, it puts deleted records back.
      await harness([
        { name: "M", text: "m" },
        { name: "Doomed", text: "d" }
      ]);
      const [edited, doomed] = getMacros();
      const { sendMessage } = await openPanel(0);

      mockShowWarningMessage.mockImplementation(async () => {
        await store.save(getMacros().filter((m) => m.id !== doomed.id));
        return "Use Anyway";
      });

      await sendMessage(baseSaveMsg({
        index: 0,
        id: edited.id,
        name: "M",
        text: "m2",
        keybinding: "ctrl+shift+f"
      }));

      expect(getMacros().map((m) => m.name)).toEqual(["M"]);
    });

    it("a macro saved while the delete confirmation is open is not discarded", async () => {
      await harness([
        { name: "Alpha", text: "a" },
        { name: "Beta", text: "b" }
      ]);
      const betaId = getMacros()[1].id!;
      const { sendMessage } = await openPanel(1);

      mockShowWarningMessage.mockImplementation(async () => {
        await store.save([...getMacros(), { name: "Gamma", text: "g" }]);
        return "Delete";
      });

      await sendMessage({ type: "delete", index: 1, id: betaId, renderGeneration: renderedGeneration() });

      expect(getMacros().map((m) => m.name)).toEqual(["Alpha", "Gamma"]);
    });
  });

  it("subscribes to the store and re-renders on external change; disposes the subscription", async () => {
    await harness([{ name: "Alpha", text: "a" }]);
    await openPanel(0);
    const initialHtml = lastHtml;
    expect(initialHtml).toContain("Alpha");

    // External rename should refresh the panel HTML
    const current = getMacros();
    await store.save([{ ...current[0], name: "Renamed" }]);
    expect(lastHtml).toContain("Renamed");

    // Dispose removes the subscription — later store changes must not re-render
    onDidDisposeHandler!();
    const htmlAtDispose = lastHtml;
    await store.save([{ name: "After Dispose", text: "z" }]);
    expect(lastHtml).toBe(htmlAtDispose);
  });
});
