import * as vscode from "vscode";
import type { MacroTreeItem } from "../ui/macroTreeProvider";
import { MacroEditorPanel } from "../ui/macroEditorPanel";
import type { MacroProfileOptionInput } from "../ui/macroProfileOptions";
import type { TerminalMacro } from "../models/terminalMacro";
import { macroRunTargetBadge, resolveMacroRunTarget } from "../models/terminalMacro";
import { hasProfileTokens } from "../services/profileTokens";
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
  captureMacroRef,
  captureMacroRefFromRow,
  mutateMacro,
  resolveMacroTarget,
  AMBIGUOUS_MACRO_TARGET_MESSAGE,
  type MacroRef
} from "../services/macroMutation";
import {
  getAncestorPaths,
  folderDisplayName,
  isDescendantOrSelf,
  normalizeFolderPath,
  normalizeOptionalFolderPath,
  parentPath,
  INVALID_FOLDER_PATH_MESSAGE,
  MAX_FOLDER_PATH_LENGTH
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
    label: "IPMI SOL console",
    description: "Fill the BMC address in from the server profile, prompt for username and password, then run ipmitool (leading space keeps it out of shell history).",
    macro: {
      name: "IPMI SOL console",
      // Leading space intentional: docs/macros.md's "Avoiding remote shell
      // history" section documents `HISTCONTROL=ignorespace` — a shipped
      // example should follow its own documented practice.
      //
      // `${profile.ipmiHost}` (issue #48) rather than a prompted `$host`: the
      // address is a fact about the server profile this macro is run against,
      // so Run Macro on Server fills it in. The PASSWORD stays a masked
      // prompt-at-run variable and must never become a literal `-P secret` in
      // a template — an argv password is visible in `ps`, in the terminal
      // scrollback, and in this extension's own TerminalCaptureBuffer, which
      // `nexus.terminal.copyAll` will happily hand to the clipboard.
      text: " ipmitool -I lanplus -H ${profile.ipmiHost} -U $username -P $password sol activate\n",
      runIn: "localTerminal",
      variables: [
        { name: "username", label: "Username" },
        { name: "password", label: "Password", secret: true }
      ]
    }
  },
  {
    id: "ipmi-web-console",
    label: "Launch IPMI web console",
    description: "Open a server's BMC web interface in the browser, using the profile's IPMI / BMC Host.",
    macro: {
      name: "IPMI web console",
      // No trailing newline, deliberately: an older build that does not know
      // `runIn` treats this as an ordinary macro and PASTES the URL into a
      // terminal without executing anything.
      text: "https://${profile.ipmiHost}/",
      runIn: "browser"
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
export function macroWillPrompt(macro: TerminalMacro): boolean {
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
  // A macro that names a server profile (`${profile.…}`) or runs somewhere
  // other than a session cannot be resolved from these entry points: they know
  // which macro the user picked, not which SERVER it is aimed at. Sending
  // anyway would put a literal `${profile.ipmiHost}` — or a bare URL — into
  // whatever terminal happens to be active, which is never what was meant.
  // Hand it to the one command that has a server: nexus.server.runMacro.
  if (hasProfileTokens(macro.text) || resolveMacroRunTarget(macro) !== "session") {
    const action = await vscode.window.showInformationMessage(
      `"${macro.name}" runs against a server profile. Pick the server to run it on.`,
      "Run Macro on Server…"
    );
    if (action) {
      // The macro travels with the redirect: the user already chose it here,
      // and the only thing the other command needs is the server.
      await vscode.commands.executeCommand("nexus.server.runMacro", { macro });
    }
    return;
  }
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

/**
 * Fix 8 — matches `validateNewScriptFolderPath` in `scriptCommands.ts`: a `\`
 * gets its own specific message rather than the generic
 * `INVALID_FOLDER_PATH_MESSAGE`, so the two views' folder-path validation is
 * actually consistent (this user base is on Windows/WSL and will type
 * `Cisco\Routers`).
 */
function validateNewFolderPath(value: string): string | null {
  if (value.includes("\\")) {
    return "Use '/' to separate folders, not '\\'.";
  }
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

/** The prefix substitution a folder rename applies to one descendant path. */
function renamedDescendantPath(path: string, oldPath: string, newPath: string): string {
  return newPath + path.slice(oldPath.length);
}

/**
 * §4.7 / §4.4 — `renameFolder` rewrites `group` on every descendant macro and
 * remaps the explicit-folder list, prefix-safe via `isDescendantOrSelf` (so
 * `Net` never touches `Network`). Renaming onto an existing path merges,
 * matching the Hub's behavior.
 *
 * Returns `false` — having written NOTHING — when the rename would produce a
 * path this codebase can no longer render. A rename is a prefix substitution,
 * so a longer new name lengthens every descendant, and a deep descendant can
 * cross `MAX_FOLDER_PATH_LENGTH`. Past that bound `normalizeFolderPath`
 * rejects it, every read site sanitizes it to `undefined`, and the macro
 * silently drops to the root — the exact data loss §4.2's read-site
 * chokepoint exists to make survivable, arriving here through a command the
 * user explicitly invoked. Validating every resulting path up front also
 * keeps the operation atomic: the folder list and the macro array are two
 * separate writes, and a half-applied rename is worse than a refused one.
 * (Depth cannot change — the rename box collects a single leaf segment — so
 * length is the only way this fires.)
 */
async function renameMacroFolder(oldPath: string, newPath: string): Promise<boolean> {
  const explicit = getMacroFolders();
  const resulting: string[] = [];
  for (const f of explicit) {
    if (isDescendantOrSelf(f, oldPath)) {
      resulting.push(renamedDescendantPath(f, oldPath, newPath));
    }
  }
  for (const m of getMacros()) {
    const group = sanitizeMacroGroup(m.group);
    if (group !== undefined && isDescendantOrSelf(group, oldPath)) {
      resulting.push(renamedDescendantPath(group, oldPath, newPath));
    }
  }
  if (resulting.some((path) => normalizeFolderPath(path) === undefined)) {
    return false;
  }

  const nextExplicit = new Set<string>();
  for (const f of explicit) {
    if (isDescendantOrSelf(f, oldPath)) {
      nextExplicit.add(renamedDescendantPath(f, oldPath, newPath));
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
      return { ...m, group: renamedDescendantPath(group, oldPath, newPath) };
    }
    return m;
  });
  if (changed) {
    await saveMacros(updated);
  }
  return true;
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
  const parent = parentPath(path);
  const affected = macros.filter((m) => {
    const group = sanitizeMacroGroup(m.group);
    return group !== undefined && isDescendantOrSelf(group, path);
  });
  if (affected.length > 0) {
    // Fix 9 — a top-level folder has no parent: its macros land at the root,
    // not "the parent folder" (there isn't one), so the confirmation must
    // word the destination correctly for that case too.
    const destinationPhrase = parent ? "moved to the parent folder" : "moved to the root";
    const choice = await vscode.window.showWarningMessage(
      `Remove folder "${folderDisplayName(path)}"? It contains ${affected.length} macro${affected.length === 1 ? "" : "s"} — they will be ${destinationPhrase}.`,
      { modal: true },
      "Remove Folder"
    );
    if (choice !== "Remove Folder") {
      return;
    }
  }

  // Fix 2 (MAJOR) — `macros` above was captured BEFORE the confirmation
  // dialog, which the user can leave open indefinitely. Anything saved while
  // it was open (another macro command, the Macro Editor, a drag onto a
  // folder, a config import — all in THIS window; see `mutateMacro`'s
  // note on why another window is not the threat) must not be discarded by
  // writing back that stale snapshot — the affected-count message above may
  // already be reading slightly-stale data, but the actual MUTATION below
  // must operate on the latest array.
  const latest = getMacros();
  let changed = false;
  const updatedMacros = latest.map((m) => {
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

/**
 * A tree item's reference to its macro: the stable id, the row's rendered
 * position, AND what was known about that id when the reference was taken,
 * because no two of the three resolve every state — see `resolveMacroTarget`.
 * Duck-typed like every other read of the arg (the `MacroTreeItem` import is
 * `type`-only, see the top-of-file comment).
 *
 * `macros` must be the array as it stood when the user clicked — read it at the
 * top of the handler, before any `await`. See `mutateMacro`'s doc comment.
 */
function macroRefFromItem(macros: readonly TerminalMacro[], item: MacroTreeItem): MacroRef {
  return captureMacroRefFromRow(macros, item);
}

/**
 * The PRE-dialog read (the name to show in a confirmation, the binding to
 * pre-fill in a prompt) — and the point at which an unresolvable target is
 * refused before the user is asked to confirm anything. Returns the index
 * within `macros` and nothing else; the post-dialog write must go through
 * `mutateMacro`, which re-resolves the same `MacroRef` against a freshly read
 * array.
 */
function resolveOrExplain(macros: TerminalMacro[], ref: MacroRef): number {
  const target = resolveMacroTarget(macros, ref);
  if (target.kind === "ambiguous") {
    void vscode.window.showWarningMessage(AMBIGUOUS_MACRO_TARGET_MESSAGE);
    return -1;
  }
  return target.kind === "resolved" ? target.index : -1;
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

    // Opening the editor writes nothing, but it decides which macro the user is
    // about to edit — a stale row's index names a different macro, which puts
    // someone else's record in front of them pre-filled and one Save away. Same
    // resolution as every write path rather than a second, laxer rule here.
    //
    // A target that no longer exists ABORTS, saying so. It used to fall through
    // to `MacroEditorPanel.open(undefined)` on the theory that this "opens with
    // no selection", which is only true for a panel that does not exist yet:
    // `open()` with no index REVEALS an already-open panel and leaves its
    // selection exactly as it was (macroEditorPanel.ts). So Edit on a stale row
    // for a deleted macro brought whatever the user last had open to the front,
    // pre-filled and one Save away — the same wrong-macro-in-front-of-you
    // failure this resolution exists to prevent, arrived at from the "we could
    // not resolve it" branch.
    vscode.commands.registerCommand("nexus.macro.edit", (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item) {
        MacroEditorPanel.open();
        return;
      }
      const macros = getMacros();
      const target = resolveMacroTarget(macros, macroRefFromItem(macros, item));
      if (target.kind === "ambiguous") {
        void vscode.window.showWarningMessage(AMBIGUOUS_MACRO_TARGET_MESSAGE);
        return;
      }
      if (target.kind !== "resolved") {
        void vscode.window.showInformationMessage(
          `"${item.macro.name}" no longer exists — nothing was opened.`
        );
        return;
      }
      MacroEditorPanel.open(target.index);
    }),

    // The clicked ROW — id and position together — is captured up front and
    // re-resolved against a freshly read array after the confirmation dialog
    // (see `resolveMacroTarget` / `mutateMacro`). Re-reading the array after
    // the dialog while still indexing into it with the PRE-dialog index was
    // worse than not re-reading at all: it confidently removed whichever macro
    // had since slid into that slot. Resolving by id ALONE is not the answer
    // either — on a list with duplicate ids (a reachable, deliberately
    // unrepaired state) first-match confirmed one twin's name and deleted the
    // other's record. The overlapping writer is another flow in THIS window
    // (the Macro Editor, a drag onto a folder, an import), not another window;
    // `{ modal: true }` blocks the user, not the host.
    vscode.commands.registerCommand("nexus.macro.remove", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      let ref: MacroRef;
      if (item) {
        ref = macroRefFromItem(getMacros(), item);
      } else {
        const listed = getMacros();
        if (listed.length === 0) {
          void vscode.window.showInformationMessage("No macros defined.");
          return;
        }
        // The quick pick carries the ordinal as well as the id for the same
        // reason a tree item does: it is the only thing that tells two macros
        // sharing an id apart, and the user picked one specific ROW. The
        // reference is captured against `listed` — the array the picks were
        // BUILT from — not a fresh read from after the pick resolved, so its
        // provenance describes the list the user was choosing from.
        const pick = await vscode.window.showQuickPick(
          listed.map((m, i) => ({ label: m.name, description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"), detail: macroFolderDetail(m), id: m.id, index: i })),
          { title: "Select Macro to Remove" }
        );
        if (!pick) {
          return;
        }
        ref = captureMacroRef(listed, pick.id, pick.index);
      }
      const macros = getMacros();
      const index = resolveOrExplain(macros, ref);
      if (index === -1) {
        return;
      }
      const confirmedName = macros[index].name;
      const confirm = await vscode.window.showWarningMessage(
        `Remove macro "${confirmedName}"?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      const outcome = await mutateMacro(ref, (latest, i) => {
        latest.splice(i, 1);
      });
      if (outcome === "ambiguous") {
        // The array shifted under the reference while the modal was up AND the
        // id is shared, so the row the user confirmed can no longer be picked
        // out. Refusing is the only safe answer; saying so is the difference
        // between a fail-safe and a button that does nothing.
        void vscode.window.showWarningMessage(AMBIGUOUS_MACRO_TARGET_MESSAGE);
      } else if (outcome === "missing") {
        // Saying nothing here left the user staring at a confirmation they
        // answered and a sidebar that may look unchanged (the macro could
        // have been renamed away rather than deleted). The end state is what
        // they asked for, so this is informational, not an error.
        void vscode.window.showInformationMessage(`"${confirmedName}" was already removed.`);
      }
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
          // Same badge, same helper, as the Run Macro on Server picker: "sends
          // a line to this terminal" and "opens a browser window" must not look
          // identical in a list.
          const badge = macroRunTargetBadge(m);
          return {
            label: `${prefix}${m.name}`,
            description: `${marker}${badge}${m.secret ? "***" : m.text.replace(/\n/g, "\\n")}`,
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

    // Same identity discipline as `remove` above, and the stakes are higher:
    // `assignBinding` clears the binding from every OTHER macro that holds it,
    // so writing through a pre-dialog index against a re-read array rebound
    // the wrong macro AND stripped a third macro's shortcut.
    vscode.commands.registerCommand("nexus.macro.assignSlot", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      let ref: MacroRef;
      if (item) {
        ref = macroRefFromItem(getMacros(), item);
      } else {
        const listed = getMacros();
        if (listed.length === 0) {
          void vscode.window.showInformationMessage("No macros defined.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          listed.map((m, i) => ({ label: m.name, description: m.secret ? "***" : m.text.replace(/\n/g, "\\n"), detail: macroFolderDetail(m), id: m.id, index: i })),
          { title: "Select Macro" }
        );
        if (!pick) {
          return;
        }
        ref = captureMacroRef(listed, pick.id, pick.index);
      }
      const macros = getMacros();
      const index = resolveOrExplain(macros, ref);
      if (index === -1) {
        return;
      }
      // The prompt's conflict warning is a display concern and reads the
      // pre-dialog snapshot; the WRITE below re-resolves by identity.
      const promptedName = macros[index].name;
      const bindingResult = await promptForBinding(macros, index, getAssignedBinding(macros[index]));
      if (bindingResult === undefined) {
        return; // Cancelled
      }
      const outcome = await mutateMacro(ref, (latest, i) => {
        assignBinding(latest, i, bindingResult);
      });
      if (outcome === "ambiguous") {
        void vscode.window.showWarningMessage(AMBIGUOUS_MACRO_TARGET_MESSAGE);
      } else if (outcome === "missing") {
        void vscode.window.showInformationMessage(
          `"${promptedName}" no longer exists — its keyboard shortcut was not changed.`
        );
      }
    }),

    // §4.4 — swaps with the previous/next macro SHARING THE SAME `group`, not
    // necessarily the adjacent array element. Because same-group neighbours
    // may be non-adjacent, this can swap non-adjacent elements — acceptable,
    // and visible as a bigger jump in the flat run picker.
    //
    // These two are the reason the shared resolver leads with the INDEX rather
    // than the id. A bare `item.index` reorders whatever now sits in that slot:
    // the row for `B` built from `[A, B, C]` carries index 1, and once `A` is
    // deleted the latest array is `[B, C]` — Move Up on that row swapped `C`
    // and `B`, moving the selected macro DOWN and a macro the user never
    // touched up. A bare id lookup fixes that and breaks the other half: these
    // are the commands the tree's own tooltip names as the repair route for a
    // duplicated id ("Reorder any macro with Move Up / Move Down to assign
    // fresh ids"), which only works because a freshly rendered row's index
    // still matches its macro. `resolveMacroTarget` keeps both.
    vscode.commands.registerCommand("nexus.macro.moveUp", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item) {
        return;
      }
      const macros = getMacros();
      const index = resolveOrExplain(macros, macroRefFromItem(macros, item));
      if (index === -1) {
        return;
      }
      const group = sanitizeMacroGroup(macros[index].group);
      const prevIndex = findPreviousInGroup(macros, index, group);
      if (prevIndex === -1) {
        void vscode.window.setStatusBarMessage(
          group ? "Already at the top of this folder" : "Already at the top of the list",
          2000
        );
        return;
      }
      [macros[prevIndex], macros[index]] = [macros[index], macros[prevIndex]];
      await saveMacros(macros);
    }),

    vscode.commands.registerCommand("nexus.macro.moveDown", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      if (!item) {
        return;
      }
      const macros = getMacros();
      const index = resolveOrExplain(macros, macroRefFromItem(macros, item));
      if (index === -1) {
        return;
      }
      const group = sanitizeMacroGroup(macros[index].group);
      const nextIndex = findNextInGroup(macros, index, group);
      if (nextIndex === -1) {
        void vscode.window.setStatusBarMessage(
          group ? "Already at the bottom of this folder" : "Already at the bottom of the list",
          2000
        );
        return;
      }
      [macros[index], macros[nextIndex]] = [macros[nextIndex], macros[index]];
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
      // Fix 5 (§4.5) — the folder may already "exist" only because a macro's
      // `group` derives it (never persisted explicitly, §4.1). Without
      // promoting it to an explicit entry here too, "New Folder" on such a
      // folder is a pure no-op: if the user later moves that last macro out,
      // the folder they just "created" vanishes instead of persisting empty
      // as promised.
      const alreadyExists = allMacroFolders().includes(normalized);
      await ensureMacroFolderExists(normalized);
      if (alreadyExists) {
        void vscode.window.showInformationMessage(`Folder "${normalized}" already exists.`);
      }
    }),

    // On a tree item: that macro. From the palette: a multi-select quick pick
    // of macros first, then the folder picker — the bulk path (§4.6).
    //
    // Fix 3 (MAJOR) — a bounds check on an index proves nothing about
    // IDENTITY once the array has shifted: a stale tree item can hold an
    // index that is back in bounds but now refers to a DIFFERENT macro (the
    // one it was opened for was deleted, and a later macro slid into the
    // same slot). Both the tree-item path and the palette's multi-select
    // path therefore carry a full `MacroRef` (stable id + the row's rendered
    // position) across every `await` below, and the final write re-reads the
    // latest array and re-resolves each reference to at most ONE macro.
    vscode.commands.registerCommand("nexus.macro.moveToFolder", async (arg?: unknown) => {
      const item = arg instanceof Object && "macro" in arg ? (arg as MacroTreeItem) : undefined;
      const macros = getMacros();
      let refs: MacroRef[];
      if (item) {
        if (!item.macro.id) {
          return;
        }
        refs = [macroRefFromItem(macros, item)];
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
            id: m.id,
            index: i
          })),
          { title: "Move to Folder", placeHolder: "Select macros to move", canPickMany: true }
        );
        if (!picks || picks.length === 0) {
          return;
        }
        refs = picks.filter((p) => !!p.id).map((p): MacroRef => captureMacroRef(macros, p.id, p.index));
        if (refs.length === 0) {
          return;
        }
      }

      const destination = await pickFolderDestination(macros);
      if (destination === undefined) {
        return;
      }

      // Re-read the latest array after BOTH awaits above (the quick pick(s)
      // and the folder picker) and re-resolve every reference against it. Each
      // reference names ONE macro: an earlier version updated every entry whose
      // id was in the captured set, which moved both twins of a duplicated id
      // when the user selected one row. A macro deleted mid-flow simply
      // resolves to nothing (no-op, never a ghost record); a macro that slid
      // into a stale index's old slot is untouched because its own id was never
      // captured.
      const latest = getMacros();
      const targetIndices = new Set<number>();
      let unresolvable = 0;
      for (const ref of refs) {
        const target = resolveMacroTarget(latest, ref);
        if (target.kind === "resolved") {
          // Two selected rows resolving to ONE macro is not a duplicate click
          // to be quietly collapsed by the Set — it means two references the
          // user made separately can no longer be told apart, so at most one of
          // them is being honoured and the other macro is silently skipped.
          // Same cause and same remedy as `"ambiguous"` (a shared id), so it is
          // counted and reported the same way rather than swallowed.
          //
          // Unreachable as the resolver stands, and kept deliberately. Two
          // picks can only carry the same id if that id was duplicated in the
          // array the picks were built from, which makes BOTH references
          // `"ambiguous"` — and an ambiguous reference resolves only by exact
          // index, so any two that resolve at all resolve to different indices.
          // That argument is entirely a property of `resolveMacroTarget`'s rule
          // 2; without that rule, this line is the only thing that still
          // reports the skipped macro. The multi-select case in
          // macroCommandsIdentity.test.ts fails only when BOTH are gone, which
          // is exactly what a second line of defence looks like.
          if (targetIndices.has(target.index)) {
            unresolvable += 1;
            continue;
          }
          targetIndices.add(target.index);
        } else if (target.kind === "ambiguous") {
          unresolvable += 1;
        }
      }
      if (unresolvable > 0) {
        void vscode.window.showWarningMessage(AMBIGUOUS_MACRO_TARGET_MESSAGE);
      }
      if (targetIndices.size === 0) {
        return; // Nothing left to move — never a whole-array rewrite for a no-op.
      }
      const updated = latest.map((m, i) => {
        if (!targetIndices.has(i)) {
          return m;
        }
        const next = { ...m };
        if (destination) {
          next.group = destination;
        } else {
          delete next.group;
        }
        return next;
      });
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
          // Fix 5 — this box only ever collects a single leaf segment (the
          // full candidate path is assembled below from the folder's existing
          // parent), but it still let '.', '..', and '\' through, which then
          // silently no-op below via normalizeFolderPath rather than telling
          // the user why. Use the same message every other folder input in
          // this feature uses.
          if (trimmed === "." || trimmed === ".." || trimmed.includes("\\")) {
            return INVALID_FOLDER_PATH_MESSAGE;
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
        void vscode.window.showErrorMessage(INVALID_FOLDER_PATH_MESSAGE);
        return;
      }
      if (!(await renameMacroFolder(oldPath, normalized))) {
        void vscode.window.showErrorMessage(
          `Renaming "${currentName}" to "${newName.trim()}" would push some folder paths past ${MAX_FOLDER_PATH_LENGTH} characters, which would drop those macros to the root. Nothing was renamed — choose a shorter name.`
        );
      }
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
      // Captured HERE, before the clipboard read and the append-newline prompt.
      // Building it at the write site instead (as this did) reads the macro
      // list as it stands AFTER those awaits, which is the one moment its
      // provenance must not come from — see `mutateMacro`'s doc comment.
      const ref = macroRefFromItem(getMacros(), item);
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
      // The worst instance of the same shape: `clipboard.readText()` and the
      // append-newline prompt are both awaits, after which `item.index` is a
      // pre-dialog position and `item.macro.secret` is a pre-dialog FACT.
      //
      // Identity alone is not enough here. The append-newline prompt is a
      // plain non-modal `showInformationMessage`, so the window stays fully
      // interactive: the user can open the Macro Editor on this very macro,
      // untick **Secret**, save, and only then answer the notification. The
      // macro re-resolves perfectly by id — and writing to it now would have
      // `MacroStore.save()` delete its vault entry and put the clipboard
      // password straight into `nexus.macros` in cleartext. So the
      // confidentiality precondition is re-checked against the FRESH record,
      // not the one the context menu was opened on.
      const outcome = await mutateMacro(ref, (macros, i) => {
        if (!macros[i].secret) {
          return false;
        }
        macros[i] = { ...macros[i], text };
      });
      if (outcome === "ambiguous") {
        void vscode.window.showWarningMessage(AMBIGUOUS_MACRO_TARGET_MESSAGE);
        return;
      }
      if (outcome === "skipped") {
        void vscode.window.showWarningMessage(
          `"${item.macro.name}" is no longer a secret macro, so its value was NOT replaced — pasting into it would have stored the clipboard text in plain text. Re-enable Secret first, or use Edit Macro.`
        );
        return;
      }
      if (outcome === "missing") {
        void vscode.window.showInformationMessage(`"${item.macro.name}" no longer exists — nothing was pasted.`);
        return;
      }
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
