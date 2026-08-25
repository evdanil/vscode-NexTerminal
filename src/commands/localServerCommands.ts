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
 *   nexus.localServer.rename / duplicate / copyInfo / moveToFolder / moveToRoot
 *                                   — standard CRUD inventory mutations
 *   nexus.localServer.inspectLogs — focus/reveal a running server's terminal
 *
 * The manager is injected via ctx (set up in extension.ts). Commands never
 * write persisted config directly: they route through NexusCore methods that
 * themselves serialize through ConfigRepository, while configMutationLock
 * guards the destructive "remove" entry point against rename/import races.
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
      WebviewFormPanel.open("local-server-edit", localServerFormDefinition(existing, collectGroups(ctx)), {
        onSubmit: async (values) => {
          if (normalizeOptionalFolderPath(values.group) === null) {
            throw new Error(INVALID_FOLDER_PATH_MESSAGE);
          }
          const updated = formValuesToLocalServer(values, existing);
          if (!updated) {
            throw new Error("Fill in the required local server fields before saving.");
          }
          await ctx.core.addOrUpdateLocalServerConfig(updated);
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
      if (newName && newName.trim() !== config.name) {
        await ctx.core.addOrUpdateLocalServerConfig({ ...config, name: newName.trim() });
      }
    }),

    vscode.commands.registerCommand("nexus.localServer.duplicate", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Duplicate Local Server"));
      if (!config) return;
      await ctx.core.addOrUpdateLocalServerConfig({ ...config, id: randomUUID(), name: `${config.name} (copy)` });
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
      const group = await vscode.window.showInputBox({
        title: "Move to Folder",
        value: config.group ?? "",
        prompt: "Folder path (use / for nesting)",
        validateInput: (value) => normalizeOptionalFolderPath(value) === null ? INVALID_FOLDER_PATH_MESSAGE : null
      });
      if (group === undefined) return;
      const normalized = normalizeOptionalFolderPath(group);
      if (normalized === null) return;
      await ctx.core.addOrUpdateLocalServerConfig({ ...config, group: normalized });
    }),

    vscode.commands.registerCommand("nexus.localServer.moveToRoot", async (arg?: unknown) => {
      const config = toLocalServerFromArg(ctx.core, arg) ?? (await pickLocalServer(ctx.core, "Move to Root"));
      if (!config) return;
      await ctx.core.addOrUpdateLocalServerConfig({ ...config, group: undefined });
    })
  ];
}
