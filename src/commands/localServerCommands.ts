/**
 * @author kanekitakitos
 *
 * Command handlers for the Local Servers subsystem. Surface area:
 *   nexus.localServer.add         — open the unified profile add form with
 *                                   profileType = "localServer" pre-selected
 *   nexus.localServer.start       — spin up a config via LocalServerManager
 *   nexus.localServer.stop        — tear down a running session / all sessions
 *                                   for a given config
 *   nexus.localServer.restart     — stop then start (preserves userInitiated
 *                                   flag so auto-restart does NOT fire again)
 *   nexus.localServer.edit        — open a WebviewFormPanel edit form
 *   nexus.localServer.remove      — disclosure-checked cascade removal under
 *                                   configMutationLock (same pattern as SSH)
 *   nexus.localServer.rename / duplicate / copyInfo
 *                                   — standard CRUD inventory mutations
 *   nexus.localServer.moveToFolder— the single unified move command: one
 *                                   destination picker offering "(root)",
 *                                   "New folder…" and every existing folder
 *   nexus.localServer.moveToRoot  — hidden back-compat alias (shipped before
 *                                   moveToFolder's picker replaced it, so a
 *                                   keybinding bound to it still works);
 *                                   deliberately not declared in package.json,
 *                                   same as nexus.macro.slot
 *   nexus.localServer.inspectLogs — focus/reveal a running server's terminal
 *
 * rename, moveToFolder, moveToRoot, edit and duplicate each re-read the live
 * record under configMutationLock before writing (#108): all five capture their
 * config before an interactive pause — the rename input box, moveToFolder's
 * destination picker, the edit form itself, or, on the palette path,
 * pickLocalServer's own quick pick — and each writes ONLY what it owns, bailing
 * out if the record was removed, already holds the target value, or was
 * concurrently changed to some other value while the prompt was open.
 *
 * duplicate is the one exception to the "bail on divergence" half of that: a
 * fresh id means it clobbers no existing record, and it owns no destination
 * field a concurrent write could contradict, so the newest live state is simply
 * what gets copied. It still has to RE-READ, because the copy's other fields
 * were otherwise spread off a pre-prompt snapshot — the actual defect, not the
 * serialization the lock also buys.
 *
 * The manager is injected via ctx (set up in extension.ts). Commands never
 * write persisted config directly: they route through NexusCore methods that
 * themselves serialize through ConfigRepository, while configMutationLock
 * guards the destructive "remove" entry point, and edit/rename/moveToFolder/
 * moveToRoot/duplicate's stale-capture re-reads, against concurrent writes.
 */

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { configMutationLock } from "../services/configMutationLock";
import {
  LocalServerManager,
  localServerDescription,
  localServerRemovalDisclosure
} from "../services/local/localServerManager";
import {
  type LocalServerConfig,
  LocalServerError
} from "../models/localServer";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { localServerFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import {
  LocalServerConfigTreeItem,
  LocalServerSessionTreeItem
} from "../ui/nexusTreeProvider";
import {
  INVALID_FOLDER_PATH_MESSAGE,
  getAncestorPaths,
  normalizeOptionalFolderPath
} from "../utils/folderPaths";
import { naturalCompare } from "../utils/naturalCompare";
import { collectGroups } from "./serverCommands";
import type { CommandContext } from "./types";

function readString(value: FormValues[string]): string {
  return typeof value === "string" ? value.trim() : "";
}

function splitArgs(value: FormValues[string]): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const args = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return args.length > 0 ? args : undefined;
}

function splitEnvFromTextarea(value: FormValues[string]): Record<string, string | null | undefined> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const result: Record<string, string | null | undefined> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIdx = line.indexOf("=");
    if (equalIdx <= 0) continue;
    const key = line.slice(0, equalIdx).trim();
    const rawValue = line.slice(equalIdx + 1);
    // Three distinct states: `KEY=null` unsets, `KEY=undefined` leaves the
    // inherited value alone, and `KEY=` sets an empty string. Folding "" in
    // with "null" made the empty string unexpressible and the field hint's
    // promise about `KEY=` false. Note the hint documents only two of the
    // three — `KEY=undefined` is implemented here but deliberately undocumented
    // in the UI, so this comment is the record of it, not a restatement of what
    // the form already says.
    if (rawValue === "null") {
      result[key] = null;
    } else if (rawValue === "undefined") {
      result[key] = undefined;
    } else if (rawValue === "") {
      result[key] = "";
    } else {
      result[key] = rawValue.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function formValuesToLocalServer(values: FormValues, existing?: Partial<LocalServerConfig>): LocalServerConfig | undefined {
  const name = readString(values.name);
  const executable = readString(values.executable);
  const normalizedGroup = normalizeOptionalFolderPath(values.group);
  if (!name || !executable || normalizedGroup === null) {
    return undefined;
  }
  const description = readString(values.description);
  const cwd = readString(values.cwd);
  const autoRestart =
    values.autoRestart === "on" ||
    values.autoRestart === true ||
    values.autoRestart === "true";
  const maxAutoRestartsRaw = typeof values.maxAutoRestarts === "string"
    ? values.maxAutoRestarts.trim()
    : typeof values.maxAutoRestarts === "number"
      ? String(values.maxAutoRestarts)
      : "";
  // `parseInt(...) || 0` mapped unparseable text to 0, which now *means*
  // something — "never restart this" — so a typo would silently disable
  // auto-restart. Garbage and an empty field both have to stay unset, and only
  // a real number counts, including a deliberate 0.
  const parsedMaxAutoRestarts = maxAutoRestartsRaw
    ? Number.parseInt(maxAutoRestartsRaw, 10)
    : Number.NaN;
  const maxAutoRestarts =
    Number.isFinite(parsedMaxAutoRestarts) && parsedMaxAutoRestarts >= 0
      ? parsedMaxAutoRestarts
      : undefined;
  return {
    id: existing?.id ?? randomUUID(),
    name,
    executable,
    args: splitArgs(values.args),
    cwd: cwd || undefined,
    env: splitEnvFromTextarea(values.env),
    autoRestart: autoRestart || undefined,
    // `|| undefined` erased a deliberate 0 — the one value a user types to mean
    // "do not restart this" — and an unset field then took the default of five,
    // the exact opposite of the request.
    maxAutoRestarts: maxAutoRestarts ?? undefined,
    description: description || undefined,
    group: normalizedGroup
  };
}

/**
 * Compare two `group` values as folders rather than as raw strings.
 *
 * "no folder" can reach this record by two spellings — `undefined`, which is
 * what moveToRoot, the removal cascade and `normalizeOptionalFolderPath` all
 * write, and a literal `""`. Nothing in the current code path produces the
 * second: `normalizeOptionalFolderPath` maps blank AND non-string input to
 * `undefined`, never to `""`. A `""` group therefore only survives in a record
 * that predates the current normalizer, or one hand-imported or hand-edited
 * straight into settings, and the coercion below exists for that legacy shape
 * alone — not for anything the form can still submit.
 *
 * It is kept because a raw `!==` between the two spellings reads as a folder
 * CHANGE, which would make the edit form's untouched-group guard fire on a
 * record that never moved.
 */
function sameFolder(a: string | undefined, b: string | undefined): boolean {
  return (a || undefined) === (b || undefined);
}

function toLocalServerFromArg(
  core: import("../core/nexusCore").NexusCore,
  arg: unknown
): LocalServerConfig | undefined {
  if (arg instanceof LocalServerConfigTreeItem) {
    return arg.config;
  }
  if (arg instanceof LocalServerSessionTreeItem) {
    return core.getLocalServer(arg.session.configId);
  }
  if (typeof arg === "object" && arg) {
    const withConfig = arg as { config?: LocalServerConfig };
    if (withConfig.config?.id) {
      return core.getLocalServer(withConfig.config.id) ?? withConfig.config;
    }
    const withSession = arg as { session?: { configId?: string } };
    if (withSession.session?.configId) {
      return core.getLocalServer(withSession.session.configId);
    }
  }
  if (typeof arg === "string") {
    return core.getLocalServer(arg);
  }
  return undefined;
}

function toLocalServerSessionIdFromArg(arg: unknown): string | undefined {
  if (arg instanceof LocalServerSessionTreeItem) {
    return arg.session.id;
  }
  if (typeof arg === "object" && arg) {
    return (arg as { session?: { id?: string } }).session?.id;
  }
  return undefined;
}

/**
 * Narrows the picker to the configs a command can actually act on.
 *
 * `stop` and `inspectLogs` are the only two that need it: every other verb
 * (restart / edit / remove / rename / duplicate / copyInfo / move…) operates
 * on a config whatever its runtime state. Offering all of them from a Stop
 * picker made the user guess which rows were live and then answered most
 * picks with a refusal.
 */
interface LocalServerPickFilter {
  include: (configId: string) => boolean;
  /** Shown instead of an empty picker, matching the scripts-stop wording. */
  emptyMessage: string;
}

async function pickLocalServer(
  core: import("../core/nexusCore").NexusCore,
  title = "Select Local Server",
  filter?: LocalServerPickFilter
): Promise<LocalServerConfig | undefined> {
  const configured = core.getSnapshot().localServers;
  if (configured.length === 0) {
    void vscode.window.showWarningMessage("No Nexus Local Servers configured.");
    return undefined;
  }
  // Filtering rather than annotating, which is what every sibling stop-like
  // picker in this codebase already does: tunnelCommands lists activeTunnels,
  // serialCommands lists serialTerminals, scriptCommands lists getRuns().
  const servers = filter ? configured.filter((config) => filter.include(config.id)) : configured;
  if (servers.length === 0) {
    void vscode.window.showInformationMessage(filter!.emptyMessage);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    servers
      .slice()
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((config) => ({
        label: config.name,
        description: localServerDescription(config),
        detail: config.description,
        config
      })),
    { title }
  );
  return pick?.config;
}

/**
 * Every folder path a local server could be moved into.
 *
 * `collectGroups` walks servers, serial and local-shell profiles but not local
 * servers, so a folder that only holds local servers would be missing from its
 * own subsystem's picker. Their groups are unioned in here rather than added to
 * the shared helper, which is used for other things.
 */
function localServerFolderPaths(ctx: CommandContext): string[] {
  const folders = new Set(collectGroups(ctx));
  for (const server of ctx.core.getSnapshot().localServers) {
    if (!server.group) continue;
    for (const ancestor of getAncestorPaths(server.group)) {
      folders.add(ancestor);
    }
  }
  return [...folders].sort(naturalCompare);
}

/**
 * The destination picker behind `moveToFolder`: "(root)", "New folder…", and
 * every existing folder — the same shape macros have used all along
 * (`pickFolderDestination` in macroCommands).
 *
 * Returns a folder path, `null` for "(root)" (clears `group`), or `undefined`
 * if the user cancelled at any step.
 *
 * This is what replaced a separate always-present "Move to Root" entry, which
 * needed a per-row `.inFolder` contextValue marker to know when to appear and
 * duplicated in one narrow menu item what the picker offers as one of its
 * choices.
 */
async function pickLocalServerFolderDestination(
  ctx: CommandContext,
  config: LocalServerConfig
): Promise<string | null | undefined> {
  // `folderKind`, not `kind` — vscode.QuickPickItem already declares its own
  // numeric-enum `kind` (for separators), and intersecting a same-named
  // string-literal property with it collapses to `never`.
  type Choice = vscode.QuickPickItem & { folderKind: "root" | "new" | "folder"; path?: string };
  const current = config.group;
  const items: Choice[] = [
    { label: "(root)", folderKind: "root", description: current ? undefined : "current" },
    { label: "$(new-folder) New folder…", folderKind: "new" },
    ...localServerFolderPaths(ctx).map((folder): Choice => ({
      label: folder,
      folderKind: "folder",
      path: folder,
      description: folder === current ? "current" : undefined
    }))
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Move to Folder",
    placeHolder: "Select a destination folder"
  });
  if (!picked) return undefined;
  if (picked.folderKind === "root") return null;
  if (picked.folderKind === "folder") return picked.path ?? null;

  const name = await vscode.window.showInputBox({
    title: "New Local Server Folder",
    prompt: "Enter a folder path (use / for nested folders)",
    placeHolder: "e.g. Backends/APIs",
    validateInput: (value) => {
      if (!value.trim()) return "Folder path cannot be empty";
      return normalizeOptionalFolderPath(value) === null ? INVALID_FOLDER_PATH_MESSAGE : null;
    }
  });
  if (!name) return undefined;
  const normalized = normalizeOptionalFolderPath(name);
  // `null` is a rejected path and `""` a blank one; neither is a destination,
  // and treating either as root would move the server somewhere the user never
  // asked for.
  if (!normalized) return undefined;
  return normalized;
}

function errorMessageFor(error: unknown, prefix: string): string {
  if (error instanceof LocalServerError) {
    return `${prefix}: ${error.message} (${error.code})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}

export function registerLocalServerCommands(
  ctx: CommandContext & { localServerManager: LocalServerManager }
): vscode.Disposable[] {
  const manager = ctx.localServerManager;

  /**
   * Everything Stop can act on. Not just "has a live session": a config in its
   * stopping grace window and one waiting out an auto-restart backoff are both
   * things a user can meaningfully stop, and the second is the whole point of
   * cancelPendingRestart — filtering it out of the picker would put that fix
   * out of reach from the palette.
   */
  const stoppable = (configId: string): boolean =>
    Boolean(manager.getActiveSessionIdForConfig(configId)) ||
    manager.isStoppingConfig(configId) ||
    manager.hasPendingRestart(configId);

  const STOPPABLE_FILTER = {
    include: stoppable,
    emptyMessage: "No Nexus local servers are running."
  };

  /**
   * Anything with a terminal worth looking at — a live session, or the tab a
   * crashed session left behind. Restricting this to live sessions would put
   * a crashed server's own failure output out of reach from the palette.
   */
  const INSPECTABLE_FILTER = {
    include: (configId: string) =>
      Boolean(manager.getActiveSessionIdForConfig(configId)) ||
      manager.lastTerminalForConfig(configId) !== undefined,
    emptyMessage: "No Nexus local server has an open terminal to inspect."
  };

  return [
    vscode.commands.registerCommand("nexus.localServer.add", () => {
      void vscode.commands.executeCommand("nexus.profile.add", {
        addMode: "profile",
        profileType: "localServer"
      });
    }),

    vscode.commands.registerCommand("nexus.localServer.start", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core));
      if (!config) return;
      try {
        await manager.start(config);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to start local server"));
      }
    }),

    vscode.commands.registerCommand("nexus.localServer.stop", async (arg?: unknown) => {
      const sessionId = toLocalServerSessionIdFromArg(arg);
      try {
        if (sessionId) {
          await manager.stop(sessionId, true);
          return;
        }
        // Palette invocation carries no tree item. Falling back to the picker
        // here is what restart / edit / remove already do; without it the
        // command dead-ended on a "right-click something instead" notice that
        // offered no way to proceed.
        const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Stop Local Server", STOPPABLE_FILTER));
        if (!config) return;
        // stopConfig no-ops on a config with nothing running, so say so rather
        // than swallowing the request the way the old dead end did.
        if (!manager.getActiveSessionIdForConfig(config.id)) {
          // A session already on its way down is excluded from
          // getActiveSessionIdForConfig so restart() can re-start the config
          // immediately — but the tree row still reads "stopping" for that
          // window, so "is not running" here reads as affirmatively wrong.
          if (manager.isStoppingConfig(config.id)) {
            void vscode.window.showInformationMessage(`Local server "${config.name}" is already stopping.`);
            return;
          }
          // "Nothing running" is not the same as "nothing about to run". A
          // crashed auto-restart profile spends its whole backoff window —
          // up to 30s — with no session, and reporting "not running" and
          // returning left the timer armed to spawn the process again
          // seconds after the user explicitly stopped it. `start()` already
          // calls that timer off, which is why Restart got this right and
          // Stop did not.
          if (manager.cancelPendingRestart(config.id)) {
            void vscode.window.showInformationMessage(
              `Local server "${config.name}" is stopped — its pending auto-restart was cancelled.`
            );
            return;
          }
          void vscode.window.showInformationMessage(`Local server "${config.name}" is not running.`);
          return;
        }
        await manager.stopConfig(config.id, true);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to stop local server"));
      }
    }),

    vscode.commands.registerCommand("nexus.localServer.restart", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Restart Local Server"));
      if (!config) return;
      try {
        await manager.restart(config);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessageFor(error, "Failed to restart local server"));
      }
    }),

    vscode.commands.registerCommand("nexus.localServer.inspectLogs", async (arg?: unknown) => {
      const sessionId = toLocalServerSessionIdFromArg(arg);
      if (sessionId) {
        const terminal = manager.inspectLogsTerminal(sessionId);
        if (terminal) {
          terminal.show();
          return;
        }
      }
      // Same dead end as stop had: from the palette there was no tree item, so
      // the command could only report that it had nothing to show. The picker
      // makes the choice available; the "not running" notice survives, now
      // scoped to the config the user actually chose.
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Inspect Local Server Logs", INSPECTABLE_FILTER));
      if (!config) return;
      const active = manager.getActiveSessionIdForConfig(config.id);
      if (active) {
        manager.inspectLogsTerminal(active)?.show();
        return;
      }
      // A crash unregisters the session but deliberately leaves the terminal
      // open, because the failure output on it is the whole reason to look.
      // Refusing here — with that tab sitting in the panel — was the command
      // declining exactly when it was most useful.
      const last = manager.lastTerminalForConfig(config.id);
      if (last) {
        last.show();
        return;
      }
      void vscode.window.showInformationMessage("No running local server session to display.");
    }),

    vscode.commands.registerCommand("nexus.localServer.edit", async (arg?: unknown) => {
      const existing = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Edit Local Server"));
      if (!existing) return;
      // Sampled as PRIMITIVES, before the form opens, and deliberately not read
      // off `existing` later. `toLocalServerFromArg` hands back NexusCore's own
      // live record object, and `_renameFolderPath` / `removeFolderCascade`
      // rewrite `.group` on that very object IN PLACE — so by submit time
      // `existing.group` already reads the post-cascade value and comparing
      // against it would find no change to defer to. These three are what the
      // form was actually rendered from.
      const editedId = existing.id;
      const editedName = existing.name;
      const groupWhenFormOpened = existing.group;
      WebviewFormPanel.open("local-server-edit", localServerFormDefinition(existing, collectGroups(ctx)), {
        onSubmit: async (values) => {
          if (normalizeOptionalFolderPath(values.group) === null) {
            throw new Error(INVALID_FOLDER_PATH_MESSAGE);
          }
          // #108 FOLLOW-UP — this was one of SEVERAL lock-free writes to the
          // localServers collection that the #108 audit missed; the drag-to-
          // folder handler and the unified Add Profile form's local-server
          // branch are the others, both outside this file and both tracked
          // separately. What singles this one out is the length of its
          // interactive pause: a webview form the user can leave open for
          // hours, against an input box or a picker measured in seconds.
          // addOrUpdateLocalServerConfig persists the WHOLE collection on
          // every call (read-modify-write of the full array), which is exactly
          // what configMutationLock exists to serialize — rename,
          // moveToFolder, moveToRoot, duplicate and remove in this same file
          // already do.
          //
          // Re-resolve the LIVE record inside the lock rather than building
          // from the pre-form snapshot, the same shape nexus.localShell.edit
          // uses: form-backed fields still come from `values` and win as
          // before, but anything the form does not carry sources from the
          // current record instead of being reverted to what it was when the
          // form opened.
          await configMutationLock.runExclusive(async () => {
            const live = ctx.core.getLocalServer(editedId);
            if (!live) {
              throw new Error(`Local server "${editedName}" was removed while this form was open. Nothing was saved.`);
            }
            const updated = formValuesToLocalServer(values, live);
            if (!updated) {
              throw new Error("Fill in the required local server fields before saving.");
            }
            // `group` IS a form field, so `values` always carries a value for
            // it — including when the user never touched it. That makes the
            // folder-cascade race invisible to the re-resolve above: a folder
            // rename or removeFolderCascade (both lock-protected, both rewrite
            // each affected record's `group` IN PLACE) landing while the form
            // sat open would be silently reverted by the form's pre-cascade
            // value on Save, potentially stranding the record in a folder that
            // no longer exists.
            //
            // So `group` is only taken from the form when the user actually
            // CHANGED it — an explicit choice still wins, as it must. An
            // untouched field expresses no intent, and deferring to the live
            // record there is the #84 P2-1 bail applied to the one field this
            // form shares with the move commands.
            if (
              sameFolder(updated.group, groupWhenFormOpened) &&
              !sameFolder(live.group, groupWhenFormOpened)
            ) {
              updated.group = live.group;
            }
            // `name` has the same shape of race via a DIFFERENT command:
            // nexus.localServer.rename is its own lock-protected, live-reread
            // handler for exactly this field, running independently of this
            // form. If it lands while this form sits open, the form's stale
            // `values.name` would otherwise silently revert it on Save even
            // though the user never touched the Name field here.
            if (updated.name === editedName && live.name !== editedName) {
              updated.name = live.name;
            }
            await ctx.core.addOrUpdateLocalServerConfig(updated);
          });
        }
      });
    }),

    vscode.commands.registerCommand("nexus.localServer.remove", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Remove Local Server"));
      if (!config) return;
      const configId = config.id;
      const confirmedName = config.name;
      const shownDisclosure = localServerRemovalDisclosure(confirmedName);
      const confirm = await vscode.window.showWarningMessage(
        shownDisclosure,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") return;
      let alreadyRemoved: string | undefined;
      let refusal: string | undefined;
      await configMutationLock.runExclusive(async () => {
        const current = ctx.core.getLocalServer(configId);
        if (!current) {
          alreadyRemoved = `Local server "${confirmedName}" was already removed.`;
          return;
        }
        if (localServerRemovalDisclosure(current.name) !== shownDisclosure) {
          refusal =
            `Local server "${confirmedName}" changed while the confirmation was open — ` +
            "nothing was removed. Remove it again to review the current details.";
          return;
        }
        try {
          await manager.stopConfig(configId, true);
        } catch {
          /* best effort; session cleanup is also gated by the cascade helper */
        }
        for (const [sessionId, entry] of ctx.localServerTerminals.entries()) {
          if (entry.configId === configId) {
            entry.terminal.dispose();
            ctx.localServerTerminals.delete(sessionId);
            ctx.core.unregisterLocalServerSession(sessionId);
          }
        }
        await ctx.core.removeLocalServerConfig(configId);
      });
      if (alreadyRemoved !== undefined) {
        void vscode.window.showInformationMessage(alreadyRemoved);
        return;
      }
      if (refusal !== undefined) {
        void vscode.window.showWarningMessage(refusal);
      }
    }),

    vscode.commands.registerCommand("nexus.localServer.rename", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Rename Local Server"));
      if (!config) return;
      const newName = await vscode.window.showInputBox({
        title: "Rename Local Server",
        value: config.name,
        prompt: "Enter new name",
        validateInput: (value) => (value.trim() ? null : "Name cannot be empty")
      });
      if (!newName || newName.trim() === config.name) return;
      const trimmedName = newName.trim();
      // #108 — same fix, and the same reasoning, as nexus.server.rename (#84
      // P1/P2-1): serialize under configMutationLock and RE-READ the live
      // record inside the lock, applying ONLY the name. `config` was
      // captured before the input box opened, and nexus.localServer.edit
      // writes the same record; committing the captured full snapshot would
      // revert that edit in every field except the one this prompt owns.
      await configMutationLock.runExclusive(async () => {
        const live = ctx.core.getLocalServer(config.id);
        if (!live || live.name === trimmedName) {
          return; // removed, or already renamed to this value, while the box was open
        }
        // #84 P2-1 — BAIL if a CONCURRENT rename changed the name to some OTHER
        // value while this box was open: writing here would overwrite that
        // newer rename with a decision made against a stale name.
        if (live.name !== config.name) {
          return;
        }
        await ctx.core.addOrUpdateLocalServerConfig({ ...live, name: trimmedName });
      });
    }),

    vscode.commands.registerCommand("nexus.localServer.duplicate", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Duplicate Local Server"));
      if (!config) return;
      // #108 FOLLOW-UP — the fresh id does mean no EXISTING record can be
      // clobbered by this write, but that was never the whole risk: `config`
      // is captured BEFORE the tree item's or the quick pick's interactive
      // pause, and every OTHER field of the copy was being spread off that
      // stale snapshot. Rename the folder "Backend" to "Platform" while the
      // picker sits open and the copy landed back in a folder that no longer
      // exists; the same applies to a concurrent rename or edit of any field.
      //
      // So this is a re-resolve, like rename / moveToFolder / moveToRoot
      // above — only simpler. Those own a single destination field a
      // concurrent write could overwrite, so they bail when the live value
      // diverged to some OTHER value. duplicate owns no such field: it makes
      // no decision about the source record at all, it only copies it. The
      // newest live state is therefore always the right thing to copy, and
      // the only bail is the source having been removed outright.
      //
      // Serialization still matters on its own: addOrUpdateLocalServerConfig
      // persists the whole collection, so an unserialized copy racing a
      // lock-holding section (replace-mode import, folder cascade) can commit
      // against a stale collection snapshot and drop that section's writes.
      await configMutationLock.runExclusive(async () => {
        const live = ctx.core.getLocalServer(config.id);
        if (!live) {
          return; // removed while the prompt was open — nothing left to copy
        }
        await ctx.core.addOrUpdateLocalServerConfig({
          ...live,
          id: randomUUID(),
          name: `${live.name} (copy)`
        });
      });
    }),

    vscode.commands.registerCommand("nexus.localServer.copyInfo", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Copy Local Server Info"));
      if (!config) return;
      const info = localServerDescription(config);
      await vscode.env.clipboard.writeText(info);
      void vscode.window.showInformationMessage(`Copied: ${info}`);
    }),

    vscode.commands.registerCommand("nexus.localServer.moveToFolder", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Move Local Server"));
      if (!config) return;
      const destination = await pickLocalServerFolderDestination(ctx, config);
      if (destination === undefined) return;
      // `null` is the picker's "(root)" choice; the stored field is optional.
      const target = destination ?? undefined;
      // #108 — same capture-then-write shape as nexus.localServer.rename just
      // above (and nexus.server.rename, #84 P1/P2-1): `config` was captured
      // before the destination picker opened, so re-read the live record under
      // the lock and apply ONLY the field this prompt owns (`group`).
      await configMutationLock.runExclusive(async () => {
        const live = ctx.core.getLocalServer(config.id);
        if (!live || live.group === target) {
          return; // removed, or already in this folder, while the picker was open
        }
        // #84 P2-1 — BAIL if a CONCURRENT move changed the group to some OTHER
        // value while the picker was open: writing here would overwrite that
        // newer move with a decision made against a stale folder path.
        if (live.group !== config.group) {
          return;
        }
        await ctx.core.addOrUpdateLocalServerConfig({ ...live, group: target });
      });
    }),

    // Undeclared in package.json — invisible in the palette and menus, but this
    // ID shipped, so a keybinding or task bound to it keeps working. Its old
    // one-step behaviour is kept as-is: root, no destination picker.
    vscode.commands.registerCommand("nexus.localServer.moveToRoot", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Move to Root"));
      if (!config) return;
      // #108 — same capture-then-write shape as nexus.localServer.moveToFolder
      // just above: on the palette path `config` comes from pickLocalServer's
      // quick pick, which embeds a snapshot taken when the picker OPENED, and
      // the user may sit on it for an unbounded time. Re-read the live record
      // under the lock and apply ONLY the field this command owns (`group`).
      await configMutationLock.runExclusive(async () => {
        const live = ctx.core.getLocalServer(config.id);
        if (!live || live.group === undefined) {
          return; // removed, or already at the root, while the picker was open
        }
        // #84 P2-1 — BAIL if a CONCURRENT move changed the group to some OTHER
        // value while the picker was open: writing here would overwrite that
        // newer move with a decision made against a stale folder path.
        if (live.group !== config.group) {
          return;
        }
        await ctx.core.addOrUpdateLocalServerConfig({ ...live, group: undefined });
      });
    })
  ];
}
