import * as vscode from "vscode";
import { bindingToDisplayLabel } from "../macroBindings";
import { getAssignedBinding } from "../macroBindingHelpers";
import type { TerminalMacro } from "../models/terminalMacro";
import { getMacroFolders, getMacros, saveMacros } from "../macroSettings";
import { findAmbiguousMacroStateKeys, macroStateKey } from "../services/macroAutoTrigger";
import { getValidMacroVariables, hasMacroVariables, scanPlaceholders } from "../services/macroVariables";
import { collectMacroFolders, sanitizeMacroGroup } from "../services/macroFolders";
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
    identityConflict?: boolean
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
      // duplicates (MacroStore.save()), but Move Up/Move Down resolve their target by
      // tree index, whereas the macro editor resolves by id and therefore refuses to
      // act on a macro whose id is shared (macroEditorPanel.ts).
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

  /** §4.9 — the payload is the dragged macro's stable `id`, never an index. */
  public async handleDrag(
    source: readonly MacroTreeElement[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const item = source[0];
    if (item instanceof MacroTreeItem && item.macro.id) {
      dataTransfer.set(MACRO_DRAG_MIME, new vscode.DataTransferItem(item.macro.id));
    }
    // Folders are not draggable in v1 (§4.9) — nothing else to serialize.
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
    const macroId = await transferItem.asString();
    if (!macroId) {
      return;
    }

    let targetFolder: string | undefined;
    if (target === undefined) {
      targetFolder = undefined;
    } else if (target instanceof FolderTreeItem) {
      targetFolder = target.folderPath;
    } else {
      targetFolder = sanitizeMacroGroup(target.macro.group);
    }

    const macros = getMacros();
    const index = macros.findIndex((m) => m.id === macroId);
    if (index === -1) {
      return;
    }
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
