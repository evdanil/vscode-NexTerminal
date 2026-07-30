import * as vscode from "vscode";
import { bindingToDisplayLabel } from "../macroBindings";
import { getAssignedBinding } from "../macroBindingHelpers";
import type { TerminalMacro } from "../models/terminalMacro";
import { getMacroFolders, getMacros, saveMacros } from "../macroSettings";
import { findAmbiguousMacroStateKeys, macroStateKey } from "../services/macroAutoTrigger";
import { getValidMacroVariables, hasMacroVariables, scanPlaceholders } from "../services/macroVariables";
import { collectMacroFolders, sanitizeMacroGroup } from "../services/macroFolders";
import {
  captureMacroRefFromRow,
  resolveMacroTarget,
  AMBIGUOUS_MACRO_TARGET_MESSAGE,
  type MacroRef
} from "../services/macroMutation";
import { folderDisplayName, parentPath } from "../utils/folderPaths";
import { naturalComparePath } from "../utils/naturalCompare";
import { MACRO_DRAG_MIME } from "./dndMimeTypes";
import { FolderTreeItem } from "./nexusTreeProvider";
import { VARIABLE_MARKER } from "./macroVariableMarker";

export { VARIABLE_MARKER };

/** §4.10 — reuses the Hub's `FolderTreeItem`, parameterised (see its doc comment). */
const MACRO_FOLDER_CONTEXT_VALUE = "nexus.folder.macros";
const MACRO_FOLDER_ID_PREFIX = "macro-folder";

export class MacroTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly macro: TerminalMacro,
    public readonly index: number,
    public readonly displayBinding?: string,
    triggerDisabled?: boolean,
    /**
     * Another macro in the list this row was drawn from resolves to the same
     * `macroStateKey()` — for a macro with a real id, that means the same id.
     *
     * PUBLIC, and read back off the row by `captureMacroRefFromRow()`
     * (services/macroMutation.ts), because it is the earliest and therefore
     * most trustworthy answer to "was this id shared when the user pointed at
     * it?": it predates the click, so a re-keying save landing between the
     * paint and the click cannot erase it. See `resolveMacroTarget`'s rule 2.
     */
    public readonly identityConflict?: boolean
  ) {
    const prefix = displayBinding ? `[${bindingToDisplayLabel(displayBinding)}] ` : "";
    super(`${prefix}${macro.name}`, vscode.TreeItemCollapsibleState.None);
    this.id = `macro:${index}`;

    // \u00a74.2 \u2014 `variables` is untrusted at every read site: shape-guarded helpers
    // only, never a bare `macro.variables` truthy check.
    const hasVariables = hasMacroVariables(macro);

    // \u00a79.6 \u2014 the marker and icon must reflect whether the macro will ACTUALLY
    // prompt, not merely whether it declares a `variables` array. A macro that
    // declares `port` but never references `$port` in its text sends immediately
    // on click \u2014 "click = sends immediately" vs "click = opens prompts" is exactly
    // the distinction the marker exists to communicate, so it keys off the same
    // scan the tooltip below already uses, never the raw shape check.
    const declaredNames = hasVariables ? getValidMacroVariables(macro).map((v) => v.name) : [];
    const promptedNames = hasVariables ? scanPlaceholders(macro.text, declaredNames).used : [];
    const willPrompt = promptedNames.length > 0;
    const variableMarker = willPrompt ? VARIABLE_MARKER : "";

    if (macro.secret) {
      this.description = `${variableMarker}\u2022\u2022\u2022\u2022\u2022`;
    } else {
      const preview = macro.text.replace(/\n/g, "\u21b5");
      this.description = `${variableMarker}\u2192 ${preview.length > 40 ? preview.slice(0, 37) + "..." : preview}`;
    }
    this.command = {
      command: "nexus.macro.runItem",
      title: "Run Macro",
      arguments: [this]
    };
    const bindingHint = displayBinding ? ` (${bindingToDisplayLabel(displayBinding)})` : "";
    if (macro.secret) {
      this.tooltip = `${macro.name}${bindingHint} (secret)`;
    } else {
      this.tooltip = `${macro.name}${bindingHint}\n${macro.text.replace(/\n/g, "\\n")}`;
    }

    // \u00a79.6 \u2014 names only; values do not exist at this point. Only names whose
    // placeholder actually appears (unescaped) in the text are ever prompted
    // for (\u00a75.3), so this mirrors runMacro()'s own scan rather than just
    // listing every declaration.
    if (willPrompt) {
      this.tooltip += `\nPrompts for: ${promptedNames.join(", ")}`;
    }

    // \u00a76.3 \u2014 a macro with BOTH a triggerPattern and variables must never
    // render as a live trigger macro: macroAutoTrigger.reload()'s in-loop
    // `continue` means such a rule never compiles, so the zap icon,
    // enable/disable toggle, and "active"/"paused" tooltip would all be dead
    // controls for a rule that can never fire.
    //
    // `identityConflict` is the same situation for the same reason: another macro in
    // this set resolves to the same `macroStateKey()`, so reload()'s ambiguity
    // `continue` compiles no rule for it either. Keeping the plain contextValue is
    // what removes the Pause/Resume items (their `when` clauses match only the
    // `.triggered` context values), which in turn keeps `setDisabled()`'s refusal to
    // write under an ambiguous key from ever reading as a dead button.
    const isTriggerMacro = !!macro.triggerPattern && !hasVariables && !identityConflict;

    if (isTriggerMacro) {
      const state = triggerDisabled ? "paused" : "active";
      const intervalHint = macro.triggerInterval ? `, every ${macro.triggerInterval}s` : "";
      this.tooltip += `\nAuto-trigger: /${macro.triggerPattern}/ (${state}${intervalHint})`;
      const base = triggerDisabled ? "nexus.macro.triggered.disabled" : "nexus.macro.triggered";
      this.contextValue = macro.secret ? base.replace("nexus.macro.", "nexus.macro.secret.") : base;
      this.iconPath = new vscode.ThemeIcon(triggerDisabled ? "circle-slash" : "zap");
    } else {
      // A suppressed auto-trigger must say so, or the macro is just silently broken.
      // The identity conflict is reported ahead of the variables note when both apply:
      // variables-vs-trigger is a documented design rule, an identity conflict is
      // corrupt data the user has to act on \u2014 and the action is stated, because it is
      // not guessable. Reorder rather than "edit this macro": any write re-keys
      // duplicates (MacroStore.save()), and Move Up / Move Down are the commands that
      // still ACT on a macro whose id is shared, whereas the macro editor refuses
      // (macroEditorPanel.ts).
      //
      // That still holds after the move commands were routed through
      // `resolveMacroTarget` (services/macroMutation.ts), which refuses an ambiguous
      // id \u2014 but only when it has nothing else to go on. A row rendered by this very
      // provider carries the index it was built at, and the resolver honours that
      // index whenever the macro still sitting there carries the same id, so a click
      // on a freshly rendered twin resolves to the exact row clicked. The refusal is
      // reachable only from a row that is BOTH stale and ambiguous, where a refresh
      // (any tree repaint) restores the advice. This tooltip is the only stated
      // recovery path out of a duplicate-id state, so macroCommandsIdentity.test.ts
      // pins it: "moveUp still reorders the clicked row — the remedy the sidebar
      // tooltip names must actually work".
      const conflictSuppressed = !!identityConflict && !!macro.triggerPattern;
      if (conflictSuppressed) {
        this.tooltip +=
          "\nAuto-trigger suppressed: another macro has the same internal id. Reorder any macro with Move Up / Move Down to assign fresh ids.";
      } else if (hasVariables && macro.triggerPattern) {
        this.tooltip += "\nAuto-trigger suppressed: macro has variables";
      }
      // contextValue is intentionally UNCHANGED for variable macros (\u00a79.6) \u2014
      // only the icon and tooltip differ; the context menu stays the one for
      // a plain (or secret) macro. Same for an identity conflict.
      this.contextValue = macro.secret ? "nexus.macro.secret" : "nexus.macro";
      this.iconPath = new vscode.ThemeIcon(
        conflictSuppressed ? "warning" : (willPrompt ? "symbol-parameter" : (macro.secret ? "lock" : "terminal"))
      );
    }
  }
}

/** Everything the Macros tree can render: a macro leaf, or a folder (§4.3, §4.10). */
export type MacroTreeElement = MacroTreeItem | FolderTreeItem;

/**
 * Correlates a `handleDrag` with the reference that drag captured, which stays
 * HOST-SIDE (`MacroTreeProvider.lastDragCapture`). Module-level so two provider
 * instances can never mint the same token and read each other's capture.
 *
 * It is only a lookup key, never evidence: a payload naming the current token is
 * treated as the drag this view most recently started, and the provenance it
 * gets is the one this view computed for that drag. There is nothing to gain by
 * guessing it — a payload must also name the same id, so the most a forged token
 * can do is replay this view's own last drag.
 */
let dragSequence = 0;

/** What a drop payload is worth on its own, before the retained capture is consulted. */
interface ParsedDragPayload {
  /**
   * Provenance is always `"unverified"`: the payload is a string in a
   * `DataTransfer` and nothing in it can establish what was true when the drag
   * started. Only `MacroTreeProvider.lastDragCapture` can, and only for the drag
   * it actually recorded.
   */
  readonly ref: MacroRef;
  /** Present only when the payload named one; matched against the retained capture. */
  readonly dragToken?: string;
}

/**
 * Reads back what `handleDrag` wrote. Defensive rather than a bare
 * `JSON.parse`: `DataTransfer` contents are whatever the drag source put there,
 * and a plain (non-JSON) string is treated as a bare macro id so a payload from
 * any other producer still resolves by identity instead of being dropped on the
 * floor. Returns `undefined` only when there is no id to act on at all.
 *
 * **Nothing in the payload sets provenance.** It cannot: a boolean written into
 * this MIME by `handleDrag` and one written by anything else are the same bytes,
 * so honouring `idAmbiguous: false` as "checked, and it was unique" was a claim
 * of uniqueness available to any producer — including a stale one — which is
 * exactly what `resolveMacroTarget`'s rule 2b exists to refuse. Every payload
 * therefore parses as `"unverified"`, and a drag this view actually started gets
 * its real provenance back from `lastDragCapture`, which no payload can reach.
 *
 * So an indexed payload from anywhere else is honoured at the position it names
 * or refused (rule 2b): a wrong position is proof the producer's view of the
 * list is stale, and falling back to the id from there is how
 * `{"id":"x","index":1}` naming the second of two twins ends up moving the first
 * one after a save re-keys them. Bare ids are unaffected — with no position
 * claimed there is nothing to be stale about, and that contract predates the
 * index.
 */
function parseMacroDragPayload(payload: string): ParsedDragPayload | undefined {
  const unverified = (id: string): ParsedDragPayload => ({ ref: { id, idWhenCaptured: "unverified" } });
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return unverified(payload); // A bare id string — resolve by identity alone.
  }
  if (typeof parsed === "string") {
    return parsed ? unverified(parsed) : undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    // Valid JSON but not an object or string — e.g. a numeric-looking id, which
    // `JSON.parse` happily turns into a number. The raw text is the id.
    return unverified(payload);
  }
  const { id, index, dragToken } = parsed as { id?: unknown; index?: unknown; dragToken?: unknown };
  if (typeof id !== "string" || !id) {
    return undefined;
  }
  const ref: MacroRef =
    typeof index === "number" ? { id, index, idWhenCaptured: "unverified" } : { id, idWhenCaptured: "unverified" };
  return typeof dragToken === "string" && dragToken ? { ref, dragToken } : { ref };
}

function makeMacroFolderItem(path: string, collapsibleState: vscode.TreeItemCollapsibleState): FolderTreeItem {
  return new FolderTreeItem(
    path,
    folderDisplayName(path),
    collapsibleState,
    false,
    MACRO_FOLDER_CONTEXT_VALUE,
    MACRO_FOLDER_ID_PREFIX
  );
}

export class MacroTreeProvider
  implements vscode.TreeDataProvider<MacroTreeElement>, vscode.TreeDragAndDropController<MacroTreeElement>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MacroTreeElement | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  // §4.10 — folders default EXPANDED; this set only ever holds explicitly
  // collapsed paths (mirrors NexusTreeProvider's collapsedFolders).
  private readonly collapsedFolders = new Set<string>();

  // §4.9 — a distinct MIME so this view does not advertise acceptance of the
  // Hub's server/serial/folder drags (and vice versa).
  public readonly dragMimeTypes = [MACRO_DRAG_MIME];
  public readonly dropMimeTypes = [MACRO_DRAG_MIME];

  /**
   * The reference the most recent `handleDrag` captured, kept HERE rather than
   * serialized into the payload. Both halves of a drag run in the extension
   * host, so the one fact a drop needs and cannot recompute — what was true
   * about the dragged id when the gesture STARTED — never has to survive a trip
   * through a string a stranger could have written.
   *
   * Only one is kept: a `DataTransfer` belongs to exactly one drag, and starting
   * another replaces the one before it.
   */
  private lastDragCapture: { readonly token: string; readonly ref: MacroRef } | undefined;

  public constructor(
    private readonly isTriggerDisabled: (macro: TerminalMacro) => boolean = () => false
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: MacroTreeElement): vscode.TreeItem {
    return element;
  }

  public collapseFolder(path: string): void {
    this.collapsedFolders.add(path);
  }

  public expandFolder(path: string): void {
    this.collapsedFolders.delete(path);
  }

  public getCollapsedFolders(): string[] {
    return [...this.collapsedFolders];
  }

  public loadCollapsedFolders(paths: string[]): void {
    this.collapsedFolders.clear();
    for (const p of paths) {
      this.collapsedFolders.add(p);
    }
  }

  /**
   * §4.3 — folders are a display projection; `MacroTreeItem.index` stays the
   * TRUE index into `getMacros()`, computed against the FULL flat array
   * before any per-folder filtering — never a filtered ordinal. §4.4 —
   * folders sort by `naturalComparePath` and render first; macros render in
   * ARRAY ORDER (both inside a folder and at root), since that order is what
   * `moveUp`/`moveDown` (and the flat run quick pick) operate on.
   */
  public getChildren(element?: MacroTreeElement): MacroTreeElement[] {
    const macros = getMacros();
    // Derived from THIS render's macro list via the same helper `MacroAutoTrigger.reload()`
    // uses, rather than queried off the trigger instance: identical input, identical
    // rule, no way for the tree to disagree with what actually compiled. Computed over the
    // FULL flat array, not the current folder's slice — ambiguity is a property of the
    // whole macro list, and two twins can sit in different folders.
    const ambiguousKeys = findAmbiguousMacroStateKeys(macros);
    const explicitFolders = getMacroFolders();
    const allFolders = collectMacroFolders(macros, explicitFolders);
    const targetPath = element instanceof FolderTreeItem ? element.folderPath : undefined;

    const childFolders = allFolders
      .filter((f) => parentPath(f) === targetPath)
      .sort((a, b) => naturalComparePath(a, b))
      .map((f) =>
        makeMacroFolderItem(
          f,
          this.collapsedFolders.has(f)
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded
        )
      );

    const macroItems: MacroTreeItem[] = [];
    macros.forEach((macro, index) => {
      if (sanitizeMacroGroup(macro.group) !== targetPath) return;
      const displayBinding = getAssignedBinding(macro);
      const triggerDisabled = macro.triggerPattern ? this.isTriggerDisabled(macro) : undefined;
      const identityConflict = ambiguousKeys.has(macroStateKey(macro));
      macroItems.push(new MacroTreeItem(macro, index, displayBinding, triggerDisabled, identityConflict));
    });

    return [...childFolders, ...macroItems];
  }

  /**
   * §4.9 — the payload is the dragged macro's stable `id`, the position of the
   * row it was dragged FROM, and a token naming the capture this view retained
   * for that drag. Never the index alone: a bare index is what a drop would
   * misapply the moment the array shifts between drag and drop.
   *
   * The index rides along because the id cannot separate two macros that share
   * one (a reachable, deliberately unrepaired state — see
   * `resolveMacroTarget`), and dragging a row is the most literal "this one,
   * right here" gesture in the whole view. It is only ever honoured when the
   * macro at that position still carries the dragged id, so a stale payload
   * falls back to id resolution rather than moving a bystander.
   *
   * The capture is what makes that fallback safe, and it deliberately does NOT
   * ride along. A drop is a second gesture, arbitrarily later, and a re-keying
   * `save()` in between (any macro write at all) splits a shared id so the drop
   * sees a perfectly unique one — pointing at the twin the user did not drag. An
   * id that was already GONE at drag time is the mirror image: a config import
   * or an undo can hand that id to a macro the user has never seen, and rule 0
   * is what stops the drop landing on it. Only what was true when the drag
   * STARTED rules either out, so it is taken here — the one moment this view is
   * looking at the same list the user is — and kept in `lastDragCapture`, where
   * no payload can contradict it.
   */
  public async handleDrag(
    source: readonly MacroTreeElement[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const item = source[0];
    if (item instanceof MacroTreeItem && item.macro.id) {
      const token = `drag-${++dragSequence}`;
      this.lastDragCapture = { token, ref: captureMacroRefFromRow(getMacros(), item) };
      dataTransfer.set(
        MACRO_DRAG_MIME,
        new vscode.DataTransferItem(
          JSON.stringify({
            id: item.macro.id,
            index: item.index,
            dragToken: token
          })
        )
      );
    }
    // Folders are not draggable in v1 (§4.9) — nothing else to serialize.
  }

  /**
   * The reference a drop acts on: the retained capture when the payload names
   * the drag this view is holding AND the same macro id it was taken for,
   * otherwise whatever the payload alone is worth (`"unverified"`).
   *
   * The id check is not ceremony. The token identifies a GESTURE; the capture's
   * provenance describes one specific id, and applying it to any other id would
   * be attaching this view's word to a macro it never looked at.
   */
  private dragRefFor(parsed: ParsedDragPayload): MacroRef {
    const captured = this.lastDragCapture;
    if (captured !== undefined && parsed.dragToken === captured.token && captured.ref.id === parsed.ref.id) {
      return captured.ref;
    }
    return parsed.ref;
  }

  /**
   * A drop onto a folder sets that macro's `group`; onto another macro row,
   * targets THAT macro's own folder; onto root (`target === undefined`)
   * clears `group` — the inverse gesture, mirroring the Hub's
   * `NexusTreeProvider.handleDrop()` treatment of a root drop.
   */
  public async handleDrop(
    target: MacroTreeElement | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const transferItem = dataTransfer.get(MACRO_DRAG_MIME);
    if (!transferItem) {
      return;
    }
    const payload = await transferItem.asString();
    if (!payload) {
      return;
    }
    const parsed = parseMacroDragPayload(payload);
    if (!parsed) {
      return;
    }
    const ref = this.dragRefFor(parsed);

    let targetFolder: string | undefined;
    if (target === undefined) {
      targetFolder = undefined;
    } else if (target instanceof FolderTreeItem) {
      targetFolder = target.folderPath;
    } else {
      targetFolder = sanitizeMacroGroup(target.macro.group);
    }

    const macros = getMacros();
    const dragged = resolveMacroTarget(macros, ref);
    if (dragged.kind === "ambiguous") {
      // The payload's position no longer holds the dragged macro AND its id is
      // shared, so there is no way to tell the twins apart. Dropping "the first
      // one" would move a macro the user did not drag.
      void vscode.window.showWarningMessage(AMBIGUOUS_MACRO_TARGET_MESSAGE);
      return;
    }
    if (dragged.kind !== "resolved") {
      return;
    }
    const index = dragged.index;
    if (sanitizeMacroGroup(macros[index].group) === targetFolder) {
      return; // no-op — already in the target folder
    }
    const updated = { ...macros[index] };
    if (targetFolder) {
      updated.group = targetFolder;
    } else {
      delete updated.group;
    }
    macros[index] = updated;
    await saveMacros(macros);
  }
}
