import * as vscode from "vscode";
import type { MacroTreeItem } from "../ui/macroTreeProvider";
import { MacroEditorPanel } from "../ui/macroEditorPanel";
import type { MacroProfileOptionInput } from "../ui/macroProfileOptions";
import type { TerminalMacro } from "../models/terminalMacro";
import {
  bindingToContextKey,
  bindingToDisplayLabel,
  isValidBinding
} from "../macroBindings";
import {
  confirmBindingWarnings,
  getMacroFolders,
  getMacros,
  saveMacroFolders,
  saveMacros
} from "../macroSettings";
import {
  assignBinding,
  findBindingOwnerIndex,
  getAssignedBinding,
  normalizeBinding
} from "../macroBindingHelpers";
import { repositoryBlobUrl } from "../utils/repositoryLinks";
import { getValidMacroVariables, hasMacroVariables, scanPlaceholders, withRedactedVariables } from "../services/macroVariables";
import { collectMacroFolders, sanitizeMacroGroup } from "../services/macroFolders";
import {
  getAncestorPaths,
  folderDisplayName,
  isDescendantOrSelf,
  normalizeFolderPath,
  normalizeOptionalFolderPath,
  parentPath,
  INVALID_FOLDER_PATH_MESSAGE
} from "../utils/folderPaths";
import { runMacro } from "./macroVariablePrompt";
// NOT imported from "../ui/macroTreeProvider": that module's `class MacroTreeItem
// extends vscode.TreeItem` executes at load time, and a plain value import from
// it would force this module (and every test that imports it) to load `vscode`
// fully shaped. See macroVariableMarker.ts's own doc comment.
import { VARIABLE_MARKER } from "../ui/macroVariableMarker";

type MacroTemplate = {
  id: string;
  label: string;
  description: string;
  macro: TerminalMacro;
};

export const MACRO_TEMPLATES: MacroTemplate[] = [
  {
    id: "send-command",
    label: "Send command",
    description: "Send a common command to the active terminal.",
    macro: {
      name: "Show version",
      text: "show version\n"
    }
  },
  {
    id: "password",
    label: "Send password when prompted",
    description: "Create a paused secret prompt macro without storing a sample password.",
    macro: {
      name: "Password prompt",
      text: "",
      secret: true,
      triggerPattern: "[Pp]assword:\\s*$",
      triggerScope: "active-session",
      triggerInitiallyDisabled: true
    }
  },
  {
    id: "confirm",
    label: "Wait and send confirmation",
    description: "Send yes when a confirmation prompt appears.",
    macro: {
      name: "Confirm yes",
      text: "yes\n",
      triggerPattern: "(confirm|continue).*\\?\\s*$",
      triggerScope: "active-session"
    }
  },
  {
    id: "scoped-auto-trigger",
    label: "Scoped auto-trigger example",
    description: "Run a command only for the active terminal when a prompt returns.",
    macro: {
      name: "Prompt scoped command",
      text: "show clock\n",
      triggerPattern: "[$#] $",
      triggerScope: "active-session",
      triggerInitiallyDisabled: true
    }
  },
  {
    // §9.7 — the origin story for the whole feature (GitHub issue #35): the
    // exact ipmitool line from the feature request, with host/username/password
    // declared and password masked. Most first macros come from this picker, so
    // without an entry here the feature is discoverable only by opening the
    // editor and happening to notice the new Variables section.
    id: "prompted-command",
    label: "Prompted command",
    description: "Prompt for host, username, and password, then run a templated command (leading space keeps it out of remote shell history).",
    macro: {
      name: "IPMI SOL console",
      // Leading space intentional: docs/macros.md's "Avoiding remote shell
      // history" section documents `HISTCONTROL=ignorespace` — a shipped
      // example should follow its own documented practice.
      text: " ipmitool -I lanplus -H $host -U $username -P $password sol activate\n",
      variables: [
        { name: "host", label: "Host" },
        { name: "username", label: "Username" },
        { name: "password", label: "Password", secret: true }
      ]
    }
  }
];

/**
 * §9.6 — the quick-pick marker must reflect whether the macro will ACTUALLY
 * prompt (same distinction, and same scan, as macroTreeProvider.ts's sidebar
 * marker): a macro that declares a variable but never references its
 * placeholder in the text sends immediately on click, so marking it would lie
 * about the click behavior. Routing decisions (`runOrSendMacro` below) stay
 * shape-based via `hasMacroVariables()` — a declared-but-unused variable still
 * needs its escapes resolved and its target pinned, both of which only happen
 * on the `runMacro()` path.
 */
function macroWillPrompt(macro: TerminalMacro): boolean {
  if (!hasMacroVariables(macro)) return false;
  const declaredNames = getValidMacroVariables(macro).map((v) => v.name);
  return scanPlaceholders(macro.text, declaredNames).used.length > 0;
}

function sendMacroText(text: string): void {
  void vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text });
}

/**
 * Routes a macro run through `runMacro()` (target-pinned prompt-and-send) when it
 * declares variables (§8.5), or through the unchanged `sendMacroText()` same-tick
 * path otherwise — §8.1's "scope of the change": a macro with no variables must
 * see zero behavior change (§4.1).
 */
async function runOrSendMacro(macro: TerminalMacro): Promise<void> {
  if (hasMacroVariables(macro)) {
    await runMacro(macro);
  } else {
    sendMacroText(macro.text);
  }
}

function cloneMacro(macro: TerminalMacro): TerminalMacro {
  // A shallow `{ ...macro }` still shares `variables` (array + entry objects)
  // by reference. Every macro created from a template would otherwise mutate
  // — and be mutated by — the module-level `MACRO_TEMPLATES` entry, since
  // MacroEditorPanel and array plumbing elsewhere edit `variables` in place.
  const clone: TerminalMacro = { ...macro };
  if (Array.isArray(macro.variables)) {
    clone.variables = macro.variables.map((variable) => ({ ...variable }));
  }
  return clone;
}

function macroDocsUrl(): string {
  return repositoryBlobUrl("docs/macros.md");
}

function resolveMacroTemplate(picked: unknown): MacroTemplate | undefined {
  if (!picked || typeof picked !== "object") return undefined;
  const maybe = picked as { template?: MacroTemplate; templateId?: string; id?: string; label?: string };
  if (maybe.template) return maybe.template;
  return MACRO_TEMPLATES.find(
    (template) => template.id === maybe.templateId || template.id === maybe.id || template.label === maybe.label
  );
}

async function addMacroFromTemplate(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    MACRO_TEMPLATES.map((template) => ({
      label: template.label,
      description: template.description,
      templateId: template.id,
      template
    })),
    {
      title: "Add Macro From Template",
      placeHolder: "Choose a starter macro"
    }
  );
  const template = resolveMacroTemplate(picked);
  if (!template) return;

  const macros = getMacros();
  macros.push(cloneMacro(template.macro));
  const index = macros.length - 1;
  await saveMacros(macros);
  updateMacroContext();
  MacroEditorPanel.open(index);
}

/** Track which context keys are currently set to true, so we only update the delta. */
const activeContextKeys = new Set<string>();

function updateBindingContextKeys(): void {
  const macros = getMacros();
  const assignedBindings = new Set(
    macros.map((macro) => getAssignedBinding(macro)).filter((binding): binding is string => binding !== undefined)
  );

  // Set true for newly assigned bindings
  for (const binding of assignedBindings) {
    const key = bindingToContextKey(binding);
    if (!activeContextKeys.has(key)) {
      activeContextKeys.add(key);
      void vscode.commands.executeCommand("setContext", key, true);
    }
  }

  // Set false for previously active bindings that are no longer assigned
  const newActiveKeys = new Set(
    [...assignedBindings].map((b) => bindingToContextKey(b))
  );
  for (const key of activeContextKeys) {
    if (!newActiveKeys.has(key)) {
      activeContextKeys.delete(key);
      void vscode.commands.executeCommand("setContext", key, false);
    }
  }
}

export function updateMacroContext(): void {
  void vscode.commands.executeCommand("setContext", "nexus.hasMacros", getMacros().length > 0);
  updateBindingContextKeys();
}

// `migrateMacroSlots()` used to live here and was called from `activate()`. It rewrote
// every macro's legacy `slot` into `keybinding` and then `saveMacros()`d the whole list,
// which made `MacroStore.save()` — the one place that re-keys duplicate macro ids — an
// ACTIVATION path. The duplicate-id fail-safe is built on that never happening: re-keying
// at startup turns "neither twin auto-triggers" into "both compile", so a secret twin can
// auto-send the other's password before the user has seen any warning. It is now
// `withMigratedSlot()` (storage/macroStore.ts), applied when the store resolves records,
// so no write is needed at all and the on-disk `slot` is rewritten by the next save the
// user actually asks for. See that function and `MacroStore.save()`'s doc comment.

async function promptForBinding(
  macros: ReturnType<typeof getMacros>,
  excludeIndex?: number,
  currentBinding?: string
): Promise<string | null | undefined> {
  // Returns: string = chosen binding, null = "None" selected, undefined = cancelled
  const result = await vscode.window.showInputBox({
    title: "Assign Keyboard Shortcut",
    prompt: "Enter a key combination (e.g., alt+m, alt+shift+5, ctrl+shift+a) or leave empty for none",
    value: currentBinding ?? "",
    placeHolder: "alt+m",
    validateInput(value) {
      const normalized = normalizeBinding(value);
      if (!normalized) {
        return undefined;
      }
      if (!isValidBinding(normalized)) {
        return "Invalid binding. Use alt+KEY, alt+shift+KEY, or ctrl+shift+KEY where KEY is A-Z or 0-9.";
      }
      // Check for conflict — warn but allow proceeding
      const owner = findBindingOwnerIndex(macros, normalized, excludeIndex);
      if (owner >= 0) {
        return {
          message: `Already used by "${macros[owner].name}". It will be reassigned if you proceed.`,
          severity: vscode.InputBoxValidationSeverity.Warning
        };
      }
      return undefined;
    }
  });

  if (result === undefined) {
    return undefined;
  }
  if (!result.trim()) {
    return null;
  }

  const normalized = normalizeBinding(result);
  if (!normalized) {
    return null;
  }
  if (!(await confirmBindingWarnings(normalized))) {
    return undefined;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Folders (§4 of docs/plans/2026-07-30-macro-script-folders.md)
// ---------------------------------------------------------------------------

/**
 * Duck-typed, mirroring the existing `"macro" in arg` check just above: a
 * value import of `FolderTreeItem` from `../ui/nexusTreeProvider` would force
 * this module (and every test importing it) to load `vscode` fully shaped —
 * the same reason `MacroTreeItem` is imported as `type` only (see the
 * top-of-file comment on that import).
 */
function asFolderArg(arg: unknown): { folderPath: string } | undefined {
  return arg instanceof Object && "folderPath" in arg && typeof (arg as { folderPath: unknown }).folderPath === "string"
    ? (arg as { folderPath: string })
    : undefined;
}

/** §4.8 — folder path goes in `detail`, never `description` (already carries the variable marker + `***`/text preview). */
function macroFolderDetail(macro: TerminalMacro): string | undefined {
  const group = sanitizeMacroGroup(macro.group);
  return group ? `Folder: ${group}` : undefined;
}

/** The full rendered folder set (explicit ∪ derived from macro groups), per §4.1. */
function allMacroFolders(macros: TerminalMacro[] = getMacros()): string[] {
  return collectMacroFolders(macros, getMacroFolders());
}

/**
 * Persists `path` (and every ancestor of it) as an explicit folder — mirrors
 * `NexusCore.addGroup()`, which likewise seeds every ancestor so a nested
 * folder created in one step leaves each ancestor independently existing and
 * empty-persistable (§1.1).
 */
async function ensureMacroFolderExists(path: string): Promise<void> {
  const next = new Set(getMacroFolders());
  for (const ancestor of getAncestorPaths(path)) next.add(ancestor);
  await saveMacroFolders([...next]);
}

function validateNewFolderPath(value: string): string | null {
  const normalized = normalizeOptionalFolderPath(value);
  if (normalized === null) {
    return INVALID_FOLDER_PATH_MESSAGE;
  }
  if (!normalized) {
    return "Folder path cannot be empty";
  }
  return null;
}

/**
 * §4.7 — the shared folder picker behind `moveToFolder`: existing folders,
 * "New folder…", and "(root)". Returns a folder path, `null` for "(root)"
 * (clears `group`), or `undefined` if the user cancelled at any step.
 */
async function pickFolderDestination(macros: TerminalMacro[]): Promise<string | null | undefined> {
  const folders = allMacroFolders(macros);
  // `folderKind`, not `kind` — `vscode.QuickPickItem` already declares its own
  // `kind?: QuickPickItemKind` (for separators); intersecting a same-named
  // string-literal property with that numeric-enum one collapses to `never`.
  type Choice = vscode.QuickPickItem & { folderKind: "root" | "new" | "folder"; path?: string };
  const items: Choice[] = [
    { label: "(root)", folderKind: "root" },
    { label: "$(new-folder) New folder…", folderKind: "new" },
    ...folders.map((f): Choice => ({ label: f, folderKind: "folder", path: f }))
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Move to Folder",
    placeHolder: "Select a destination folder"
  });
  if (!picked) {
    return undefined;
  }
  if (picked.folderKind === "root") {
    return null;
  }
  if (picked.folderKind === "folder") {
    return picked.path;
  }

  const name = await vscode.window.showInputBox({
    title: "New Macro Folder",
    prompt: "Enter a folder path (use / for nested folders)",
    placeHolder: "e.g. Cisco/Routers",
    validateInput: validateNewFolderPath
  });
  if (!name) {
    return undefined;
  }
  const normalized = normalizeOptionalFolderPath(name);
  if (!normalized) {
    return undefined;
  }
  await ensureMacroFolderExists(normalized);
  return normalized;
}

/**
 * §4.7 / §4.4 — `renameFolder` rewrites `group` on every descendant macro and
 * remaps the explicit-folder list, prefix-safe via `isDescendantOrSelf` (so
 * `Net` never touches `Network`). Renaming onto an existing path merges,
 * matching the Hub's behavior.
 */
async function renameMacroFolder(oldPath: string, newPath: string): Promise<void> {
  const explicit = getMacroFolders();
  const nextExplicit = new Set<string>();
  for (const f of explicit) {
    if (isDescendantOrSelf(f, oldPath)) {
      nextExplicit.add(newPath + f.slice(oldPath.length));
    } else {
      nextExplicit.add(f);
    }
  }
  for (const ancestor of getAncestorPaths(newPath)) {
    nextExplicit.add(ancestor);
  }
  await saveMacroFolders([...nextExplicit]);

  const macros = getMacros();
  let changed = false;
  const updated = macros.map((m) => {
    const group = sanitizeMacroGroup(m.group);
    if (group !== undefined && isDescendantOrSelf(group, oldPath)) {
      changed = true;
      return { ...m, group: newPath + group.slice(oldPath.length) };
    }
    return m;
  });
  if (changed) {
    await saveMacros(updated);
  }
}

/**
 * §4.7 — re-parents descendants to the removed folder's parent, preserving
 * substructure; drops the explicit-folder entry. Never deletes macros. The
 * `suffix.slice(1) || undefined` idiom mirrors `removeFolderCascade`
 * (`nexusCore.ts:445-463`) exactly: it handles nested paths, root-level
 * removal, and `""` canonicalization identically.
 */
async function removeMacroFolder(path: string): Promise<void> {
  const macros = getMacros();
  const affected = macros.filter((m) => {
    const group = sanitizeMacroGroup(m.group);
    return group !== undefined && isDescendantOrSelf(group, path);
  });
  if (affected.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Remove folder "${folderDisplayName(path)}"? It contains ${affected.length} macro${affected.length === 1 ? "" : "s"} — they will be moved to the parent folder.`,
      { modal: true },
      "Remove Folder"
    );
    if (choice !== "Remove Folder") {
      return;
    }
  }

  const parent = parentPath(path);
  let changed = false;
  const updatedMacros = macros.map((m) => {
    const group = sanitizeMacroGroup(m.group);
    if (group === undefined || !isDescendantOrSelf(group, path)) {
      return m;
    }
    changed = true;
    const suffix = group.slice(path.length);
    const newGroup = parent ? parent + suffix : (suffix.slice(1) || undefined);
    const next = { ...m };
    if (newGroup) {
      next.group = newGroup;
    } else {
      delete next.group;
    }
    return next;
  });
  if (changed) {
    await saveMacros(updatedMacros);
  }

  const explicit = getMacroFolders();
  const nextExplicit = new Set<string>();
  for (const f of explicit) {
    if (!isDescendantOrSelf(f, path)) {
      nextExplicit.add(f);
      continue;
    }
    if (f === path) {
      continue; // drop the removed folder's own explicit entry
    }
    const suffix = f.slice(path.length);
    const newFolder = parent ? parent + suffix : suffix.slice(1);
    if (newFolder) {
      nextExplicit.add(newFolder);
    }
  }
  await saveMacroFolders([...nextExplicit]);
}

/** §4.4 — same-`group` neighbours may be non-adjacent in the array. */
function findPreviousInGroup(macros: TerminalMacro[], index: number, group: string | undefined): number {
  for (let i = index - 1; i >= 0; i--) {
    if (sanitizeMacroGroup(macros[i].group) === group) {
      return i;
    }
  }
  return -1;
}

function findNextInGroup(macros: TerminalMacro[], index: number, group: string | undefined): number {
  for (let i = index + 1; i < macros.length; i++) {
    if (sanitizeMacroGroup(macros[i].group) === group) {
      return i;
    }
  }
  return -1;
}

export function registerMacroCommands(profileProvider?: () => MacroProfileOptionInput[]): vscode.Disposable[] {
  if (profileProvider) {
    MacroEditorPanel.setProfileProvider(profileProvider);
  }

  return [
    vscode.commands.registerCommand("nexus.macro.add", () => {
      MacroEditorPanel.openNew();
    }),

    vscode.commands.registerCommand("nexus.macro.addFromTemplate", async () => {
      await addMacroFromTemplate();
    }),

    vscode.commands.registerCommand("nexus.macro.openDocs", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(macroDocsUrl()));
    }),

    vscode.commands.registerCommand("nexus.macro.editor", () => {
      MacroEditorPanel.open();
    }),

    vscode.commands.registerCommand("nexus.macro.edit", (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (item) {
        MacroEditorPanel.open(item.index);
      } else {
        MacroEditorPanel.open();
      }
    }),

    vscode.commands.registerCommand("nexus.macro.remove", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      let index: number;
      if (item) {
        index = item.index;
      } else {
        const macros = getMacros();
        if (macros.length === 0) {
          void vscode.window.showInformationMessage("No macros defined.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          macros.map((m, i) => ({ label: m.name, description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"), detail: macroFolderDetail(m), index: i })),
          { title: "Select Macro to Remove" }
        );
        if (!pick) {
          return;
        }
        index = pick.index;
      }
      const macros = getMacros();
      const macro = macros[index];
      if (!macro) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove macro "${macro.name}"?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      macros.splice(index, 1);
      await saveMacros(macros);
    }),

    vscode.commands.registerCommand("nexus.macro.run", async () => {
      const macros = getMacros();
      if (macros.length === 0) {
        const action = await vscode.window.showInformationMessage(
          "No macros defined.",
          "Add Blank Macro"
        );
        if (action === "Add Blank Macro") {
          await vscode.commands.executeCommand("nexus.macro.add");
        }
        return;
      }

      const pick = await vscode.window.showQuickPick(
        macros.map((m, i) => {
          const binding = getAssignedBinding(m);
          const prefix = binding ? `[${bindingToDisplayLabel(binding)}] ` : "";
          // §9.6 — same marker (and same "will it actually prompt" scan) as the
          // sidebar: "click = sends immediately" and "click = opens prompts" are
          // different enough behaviors to flag here too.
          const marker = macroWillPrompt(m) ? VARIABLE_MARKER : "";
          return {
            label: `${prefix}${m.name}`,
            description: `${marker}${m.secret ? "***" : m.text.replace(/\n/g, "\\n")}`,
            detail: macroFolderDetail(m),
            index: i
          };
        }),
        { title: "Run Macro", placeHolder: "Select a macro to send to the terminal" }
      );
      if (!pick) {
        return;
      }
      await runOrSendMacro(macros[pick.index]);
    }),

    vscode.commands.registerCommand("nexus.macro.runBinding", async (arg?: unknown) => {
      const args = arg as { binding?: string } | undefined;
      const binding = normalizeBinding(args?.binding);
      if (!binding) {
        return;
      }
      const macros = getMacros();
      const macro = macros.find((m) => getAssignedBinding(m) === binding);
      if (macro) {
        await runOrSendMacro(macro);
      }
    }),

    vscode.commands.registerCommand("nexus.macro.slot", async (arg?: unknown) => {
      const args = arg as { index?: number } | undefined;
      const index = args?.index;
      if (typeof index !== "number") {
        return;
      }
      const macros = getMacros();
      const targetSlot = (index + 1) % 10;
      const targetBinding = `alt+${targetSlot}`;

      // First try new keybinding system
      const bindingMacro = macros.find((m) => getAssignedBinding(m) === targetBinding);
      if (bindingMacro) {
        await runOrSendMacro(bindingMacro);
        return;
      }

      const slotMacro = macros.find((m) => m.slot === targetSlot);
      if (slotMacro) {
        await runOrSendMacro(slotMacro);
      }
    }),

    vscode.commands.registerCommand("nexus.macro.runItem", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (item) {
        await runOrSendMacro(item.macro);
      }
    }),

    vscode.commands.registerCommand("nexus.macro.assignSlot", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      let index: number;
      if (item) {
        index = item.index;
      } else {
        const macros = getMacros();
        if (macros.length === 0) {
          void vscode.window.showInformationMessage("No macros defined.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          macros.map((m, i) => ({ label: m.name, description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"), detail: macroFolderDetail(m), index: i })),
          { title: "Select Macro" }
        );
        if (!pick) {
          return;
        }
        index = pick.index;
      }
      const macros = getMacros();
      const macro = macros[index];
      if (!macro) {
        return;
      }
      const bindingResult = await promptForBinding(macros, index, getAssignedBinding(macro));
      if (bindingResult === undefined) {
        return; // Cancelled
      }
      assignBinding(macros, index, bindingResult);
      await saveMacros(macros);
    }),

    // §4.4 — swaps with the previous/next macro SHARING THE SAME `group`, not
    // necessarily the adjacent array element. Because same-group neighbours
    // may be non-adjacent, this can swap non-adjacent elements — acceptable,
    // and visible as a bigger jump in the flat run picker.
    vscode.commands.registerCommand("nexus.macro.moveUp", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item || item.index < 0) {
        return;
      }
      const macros = getMacros();
      if (item.index >= macros.length) {
        return;
      }
      const group = sanitizeMacroGroup(macros[item.index].group);
      const prevIndex = findPreviousInGroup(macros, item.index, group);
      if (prevIndex === -1) {
        void vscode.window.setStatusBarMessage(
          group ? "Already at the top of this folder" : "Already at the top of the list",
          2000
        );
        return;
      }
      [macros[prevIndex], macros[item.index]] = [macros[item.index], macros[prevIndex]];
      await saveMacros(macros);
    }),

    vscode.commands.registerCommand("nexus.macro.moveDown", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item || item.index < 0) {
        return;
      }
      const macros = getMacros();
      if (item.index >= macros.length) {
        return;
      }
      const group = sanitizeMacroGroup(macros[item.index].group);
      const nextIndex = findNextInGroup(macros, item.index, group);
      if (nextIndex === -1) {
        void vscode.window.setStatusBarMessage(
          group ? "Already at the bottom of this folder" : "Already at the bottom of the list",
          2000
        );
        return;
      }
      [macros[item.index], macros[nextIndex]] = [macros[nextIndex], macros[item.index]];
      await saveMacros(macros);
    }),

    // ---- Folders (§4.5, §4.7) ----------------------------------------------

    vscode.commands.registerCommand("nexus.macro.newFolder", async () => {
      const name = await vscode.window.showInputBox({
        title: "New Macro Folder",
        prompt: "Enter a folder path (use / for nested folders)",
        placeHolder: "e.g. Cisco/Routers",
        validateInput: validateNewFolderPath
      });
      if (!name) {
        return;
      }
      const normalized = normalizeOptionalFolderPath(name);
      if (!normalized) {
        return;
      }
      if (allMacroFolders().includes(normalized)) {
        void vscode.window.showInformationMessage(`Folder "${normalized}" already exists.`);
        return;
      }
      await ensureMacroFolderExists(normalized);
    }),

    // On a tree item: that macro. From the palette: a multi-select quick pick
    // of macros first, then the folder picker — the bulk path (§4.6).
    vscode.commands.registerCommand("nexus.macro.moveToFolder", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      const macros = getMacros();
      let targetIndices: number[];
      if (item) {
        targetIndices = [item.index];
      } else {
        if (macros.length === 0) {
          void vscode.window.showInformationMessage("No macros defined.");
          return;
        }
        const picks = await vscode.window.showQuickPick(
          macros.map((m, i) => ({
            label: m.name,
            description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"),
            detail: macroFolderDetail(m),
            index: i
          })),
          { title: "Move to Folder", placeHolder: "Select macros to move", canPickMany: true }
        );
        if (!picks || picks.length === 0) {
          return;
        }
        targetIndices = picks.map((p) => p.index);
      }

      const destination = await pickFolderDestination(macros);
      if (destination === undefined) {
        return;
      }
      const updated = [...macros];
      for (const idx of targetIndices) {
        const next = { ...updated[idx] };
        if (destination) {
          next.group = destination;
        } else {
          delete next.group;
        }
        updated[idx] = next;
      }
      await saveMacros(updated);
    }),

    // On a folder: opens the editor with the Folder field pre-seeded (mirrors
    // profileCommands.ts:174-176 seeding the Hub's profile form).
    vscode.commands.registerCommand("nexus.macro.addToFolder", (arg?: unknown) => {
      const folder = asFolderArg(arg);
      if (!folder) {
        return;
      }
      MacroEditorPanel.openNew({ group: folder.folderPath });
    }),

    vscode.commands.registerCommand("nexus.macro.renameFolder", async (arg?: unknown) => {
      const folder = asFolderArg(arg);
      if (!folder) {
        return;
      }
      const oldPath = folder.folderPath;
      const currentName = folderDisplayName(oldPath);
      const newName = await vscode.window.showInputBox({
        title: "Rename Folder",
        value: currentName,
        prompt: "Enter new folder name",
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return "Folder name cannot be empty";
          }
          if (trimmed.includes("/")) {
            return "Folder name cannot contain '/'";
          }
          return null;
        }
      });
      if (!newName || newName.trim() === currentName) {
        return;
      }
      const parent = parentPath(oldPath);
      const candidatePath = parent ? `${parent}/${newName.trim()}` : newName.trim();
      const normalized = normalizeFolderPath(candidatePath);
      if (!normalized) {
        return;
      }
      await renameMacroFolder(oldPath, normalized);
    }),

    // Re-parents descendants, preserving substructure; never deletes macros.
    vscode.commands.registerCommand("nexus.macro.removeFolder", async (arg?: unknown) => {
      const folder = asFolderArg(arg);
      if (!folder) {
        return;
      }
      await removeMacroFolder(folder.folderPath);
    }),

    vscode.commands.registerCommand("nexus.macro.copySecret", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item?.macro.secret) {
        return;
      }
      await vscode.env.clipboard.writeText(item.macro.text);
      void vscode.window.showInformationMessage(`Copied "${item.macro.name}" value to clipboard.`);
    }),

    vscode.commands.registerCommand("nexus.macro.pasteSecret", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item?.macro.secret) {
        return;
      }
      const clipText = await vscode.env.clipboard.readText();
      if (!clipText) {
        void vscode.window.showInformationMessage("Clipboard is empty.");
        return;
      }
      let text = clipText;
      if (!text.endsWith("\n")) {
        const choice = await vscode.window.showInformationMessage(
          "Append newline (\\n) to the end of the pasted text?",
          "Yes",
          "No"
        );
        if (choice === undefined) {
          return;
        }
        if (choice === "Yes") {
          text += "\n";
        }
      }
      const macros = getMacros();
      const macro = macros[item.index];
      if (!macro) {
        return;
      }
      macro.text = text;
      await saveMacros(macros);
      void vscode.window.showInformationMessage(`Updated "${item.macro.name}" from clipboard.`);
    }),

    vscode.commands.registerCommand("nexus.macro.copyAllAsJson", async () => {
      const macros = getMacros();
      // Redact macro-level secret text AND normalize variable declarations: a masked
      // variable's `default` is plaintext, and unsanitized ingestion paths (legacy
      // settings absorption) can persist one that the runtime never reads.
      const sanitized = macros.map((m) => withRedactedVariables(m.secret ? { ...m, text: "" } : m));
      await vscode.env.clipboard.writeText(JSON.stringify(sanitized, null, 2));
      const secretCount = macros.filter((m) => m.secret).length;
      const suffix = secretCount > 0
        ? ` (${secretCount} secret value${secretCount === 1 ? "" : "s"} redacted)`
        : "";
      void vscode.window.showInformationMessage(`Copied ${macros.length} macro${macros.length === 1 ? "" : "s"} to clipboard${suffix}.`);
    })
  ];
}
