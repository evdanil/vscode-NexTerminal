import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { LocalShellProfile } from "../models/config";
import { localShellFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { LocalShellProfileTreeItem, LocalShellSessionTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { INVALID_FOLDER_PATH_MESSAGE, normalizeOptionalFolderPath } from "../utils/folderPaths";
import { collectGroups } from "./serverCommands";
import type { CommandContext, LocalShellTerminalEntry } from "./types";

interface VscodeTerminalProfileConfig {
  path?: string | string[];
  args?: string | string[];
  env?: Record<string, string | null | undefined>;
  source?: string;
}

type LocalShellLaunchPlan =
  | { kind: "terminalOptions"; options: vscode.TerminalOptions }
  | { kind: "vscodeProfileCommand"; profileName: string };

const VSCODE_NEW_TERMINAL_WITH_PROFILE_COMMAND = "workbench.action.terminal.newWithProfile";
const OPEN_TERMINAL_TIMEOUT_MS = 5000;

function platformTerminalProfilesKey(): string {
  if (process.platform === "win32") return "profiles.windows";
  if (process.platform === "darwin") return "profiles.osx";
  return "profiles.linux";
}

function getConfiguredVscodeTerminalProfiles(): Record<string, VscodeTerminalProfileConfig> {
  return vscode.workspace
    .getConfiguration("terminal.integrated")
    .get<Record<string, VscodeTerminalProfileConfig>>(platformTerminalProfilesKey(), {});
}

export function getConfiguredVscodeTerminalProfileNames(): string[] {
  return Object.keys(getConfiguredVscodeTerminalProfiles()).sort((a, b) => a.localeCompare(b));
}

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

export function formValuesToLocalShell(values: FormValues, existing?: Partial<LocalShellProfile>): LocalShellProfile | undefined {
  const name = readString(values.name);
  const launchMode = values.launchMode === "vscodeProfile" ? "vscodeProfile" : "custom";
  const vscodeProfileName = readString(values.vscodeProfileName);
  const shellPath = readString(values.shellPath);
  const cwd = readString(values.cwd);
  const startupCommand = readString(values.startupCommand);
  const normalizedGroup = normalizeOptionalFolderPath(values.group);
  if (!name || normalizedGroup === null) {
    return undefined;
  }
  if (launchMode === "vscodeProfile" && !vscodeProfileName) {
    return undefined;
  }
  if (launchMode === "custom" && !shellPath) {
    return undefined;
  }
  return {
    id: existing?.id ?? randomUUID(),
    name,
    launchMode,
    vscodeProfileName: launchMode === "vscodeProfile" ? vscodeProfileName : undefined,
    shellPath: launchMode === "custom" ? shellPath : undefined,
    shellArgs: launchMode === "custom" ? splitArgs(values.shellArgs) : undefined,
    cwd: cwd || undefined,
    env: existing?.env,
    startupCommand: startupCommand || undefined,
    group: normalizedGroup
  };
}

function firstShellPath(pathValue: string | string[] | undefined): string | undefined {
  if (typeof pathValue === "string" && pathValue.trim()) {
    return pathValue;
  }
  if (Array.isArray(pathValue)) {
    return pathValue.find((item) => typeof item === "string" && item.trim());
  }
  return undefined;
}

function normalizeProfileArgs(args: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(args)) {
    return args;
  }
  if (typeof args === "string" && args.length > 0) {
    return [args];
  }
  return undefined;
}

function normalizeProfileEnv(env: VscodeTerminalProfileConfig["env"]): vscode.TerminalOptions["env"] {
  if (!env) {
    return undefined;
  }
  const result: NonNullable<vscode.TerminalOptions["env"]> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" || value === null) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveLocalShellTerminalOptions(profile: LocalShellProfile): vscode.TerminalOptions {
  if (profile.launchMode === "vscodeProfile") {
    const profileName = profile.vscodeProfileName?.trim();
    if (!profileName) {
      throw new Error("Local Shell profile is missing a VS Code terminal profile name.");
    }
    const terminalProfile = getConfiguredVscodeTerminalProfiles()[profileName];
    if (!terminalProfile) {
      throw new Error(`VS Code terminal profile "${profileName}" was not found for this platform.`);
    }
    const shellPath = firstShellPath(terminalProfile.path);
    if (!shellPath) {
      throw new Error(`VS Code terminal profile "${profileName}" does not define an explicit shell path. Source-only or autodetected profiles are not supported for Local Shell.`);
    }
    return {
      shellPath,
      shellArgs: normalizeProfileArgs(terminalProfile.args),
      env: normalizeProfileEnv(terminalProfile.env),
      cwd: profile.cwd,
      name: `Nexus Local Shell: ${profile.name}`
    };
  }

  if (!profile.shellPath?.trim()) {
    throw new Error(`Local Shell profile "${profile.name}" is missing a shell path.`);
  }
  return {
    shellPath: profile.shellPath,
    shellArgs: profile.shellArgs,
    cwd: profile.cwd,
    env: profile.env,
    name: `Nexus Local Shell: ${profile.name}`
  };
}

function resolveLocalShellLaunchPlan(profile: LocalShellProfile): LocalShellLaunchPlan {
  if (profile.launchMode !== "vscodeProfile") {
    return { kind: "terminalOptions", options: resolveLocalShellTerminalOptions(profile) };
  }

  const profileName = profile.vscodeProfileName?.trim();
  if (!profileName) {
    throw new Error("Local Shell profile is missing a VS Code terminal profile name.");
  }

  const terminalProfile = getConfiguredVscodeTerminalProfiles()[profileName];
  if (!terminalProfile || !firstShellPath(terminalProfile.path)) {
    return { kind: "vscodeProfileCommand", profileName };
  }

  return { kind: "terminalOptions", options: resolveLocalShellTerminalOptions(profile) };
}

function localShellDescription(profile: LocalShellProfile): string {
  return profile.launchMode === "vscodeProfile"
    ? `VS Code: ${profile.vscodeProfileName ?? ""}`
    : profile.shellPath ?? "";
}

async function pickLocalShellProfile(core: import("../core/nexusCore").NexusCore): Promise<LocalShellProfile | undefined> {
  const profiles = core.getSnapshot().localShellProfiles;
  if (profiles.length === 0) {
    void vscode.window.showWarningMessage("No Nexus Local Shell profiles configured");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    profiles
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => ({
        label: profile.name,
        description: localShellDescription(profile),
        profile
      })),
    { title: "Select Local Shell Profile" }
  );
  return pick?.profile;
}

function toLocalShellProfileFromArg(
  core: import("../core/nexusCore").NexusCore,
  arg: unknown
): LocalShellProfile | undefined {
  if (arg instanceof LocalShellProfileTreeItem) {
    return arg.profile;
  }
  if (arg instanceof LocalShellSessionTreeItem) {
    return core.getLocalShellProfile(arg.session.profileId);
  }
  if (typeof arg === "object" && arg) {
    const withProfile = arg as { profile?: LocalShellProfile };
    if (withProfile.profile?.id) {
      return core.getLocalShellProfile(withProfile.profile.id) ?? withProfile.profile;
    }
    const withSession = arg as { session?: { profileId?: string } };
    if (withSession.session?.profileId) {
      return core.getLocalShellProfile(withSession.session.profileId);
    }
  }
  if (typeof arg === "string") {
    return core.getLocalShellProfile(arg);
  }
  return undefined;
}

function toLocalShellSessionIdFromArg(arg: unknown): string | undefined {
  if (arg instanceof LocalShellSessionTreeItem) {
    return arg.session.id;
  }
  if (typeof arg === "object" && arg) {
    return (arg as { session?: { id?: string } }).session?.id;
  }
  return undefined;
}

async function createTerminalFromVscodeProfile(profileName: string, openInEditor: boolean): Promise<vscode.Terminal> {
  const existingTerminals = new Set(vscode.window.terminals);
  let cleanup = () => {};

  const terminalPromise = new Promise<vscode.Terminal>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let listener: vscode.Disposable | undefined;

    const finish = (terminal: vscode.Terminal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(terminal);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      listener?.dispose();
      listener = undefined;
    };

    listener = vscode.window.onDidOpenTerminal((terminal) => {
      if (!existingTerminals.has(terminal)) {
        finish(terminal);
      }
    });
    timeout = setTimeout(() => {
      fail(new Error(`VS Code did not report a new terminal for profile "${profileName}".`));
    }, OPEN_TERMINAL_TIMEOUT_MS);
  });

  try {
    await vscode.commands.executeCommand(VSCODE_NEW_TERMINAL_WITH_PROFILE_COMMAND, {
      profileName,
      location: openInEditor ? "editor" : "view"
    });
  } catch (error) {
    cleanup();
    throw error;
  }

  return terminalPromise;
}

async function openLocalShell(ctx: CommandContext, profile: LocalShellProfile): Promise<void> {
  const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";
  const plan = resolveLocalShellLaunchPlan(profile);
  const terminalName = `Nexus Local Shell: ${profile.name}`;
  const terminal = plan.kind === "terminalOptions"
    ? vscode.window.createTerminal({
      ...plan.options,
      name: terminalName,
      iconPath: new vscode.ThemeIcon("terminal"),
      location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
    })
    : await createTerminalFromVscodeProfile(plan.profileName, openInEditor);
  const sessionId = randomUUID();
  const entry: LocalShellTerminalEntry = { terminal, profileId: profile.id };
  ctx.localShellTerminals.set(sessionId, entry);
  ctx.core.registerLocalShellSession({
    id: sessionId,
    profileId: profile.id,
    terminalName,
    startedAt: Date.now()
  });
  ctx.focusedTerminal = terminal;
  terminal.show();
  if (profile.startupCommand) {
    terminal.sendText(profile.startupCommand);
  }
}

export function registerLocalShellCommands(ctx: CommandContext): vscode.Disposable[] {
  const closeListener = vscode.window.onDidCloseTerminal((terminal) => {
    for (const [sessionId, entry] of ctx.localShellTerminals.entries()) {
      if (entry.terminal === terminal) {
        ctx.localShellTerminals.delete(sessionId);
        ctx.core.unregisterLocalShellSession(sessionId);
      }
    }
  });

  return [
    closeListener,
    vscode.commands.registerCommand("nexus.localShell.add", () => {
      void vscode.commands.executeCommand("nexus.profile.add", { addMode: "localShell", profileType: "localShell" });
    }),
    vscode.commands.registerCommand("nexus.localShell.connect", async (arg?: unknown) => {
      const profile = toLocalShellProfileFromArg(ctx.core, arg) ?? (await pickLocalShellProfile(ctx.core));
      if (!profile) {
        return;
      }
      try {
        await openLocalShell(ctx, profile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to open local shell: ${message}`);
      }
    }),
    vscode.commands.registerCommand("nexus.localShell.edit", async (arg?: unknown) => {
      const existing = toLocalShellProfileFromArg(ctx.core, arg) ?? (await pickLocalShellProfile(ctx.core));
      if (!existing) return;
      WebviewFormPanel.open("local-shell-edit", localShellFormDefinition(existing, collectGroups(ctx), {
        vscodeTerminalProfileNames: getConfiguredVscodeTerminalProfileNames()
      }), {
        onSubmit: async (values) => {
          if (normalizeOptionalFolderPath(values.group) === null) {
            throw new Error(INVALID_FOLDER_PATH_MESSAGE);
          }
          const updated = formValuesToLocalShell(values, existing);
          if (!updated) {
            throw new Error("Fill in the required local shell fields before saving.");
          }
          await ctx.core.addOrUpdateLocalShellProfile(updated);
        }
      });
    }),
    vscode.commands.registerCommand("nexus.localShell.remove", async (arg?: unknown) => {
      const profile = toLocalShellProfileFromArg(ctx.core, arg) ?? (await pickLocalShellProfile(ctx.core));
      if (!profile) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove local shell profile "${profile.name}" and close all sessions?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") return;
      for (const [sessionId, entry] of ctx.localShellTerminals.entries()) {
        if (entry.profileId === profile.id) {
          entry.terminal.dispose();
          ctx.localShellTerminals.delete(sessionId);
        }
      }
      await ctx.core.removeLocalShellProfile(profile.id);
    }),
    vscode.commands.registerCommand("nexus.localShell.disconnect", async (arg?: unknown) => {
      const sessionId = toLocalShellSessionIdFromArg(arg);
      if (sessionId) {
        const entry = ctx.localShellTerminals.get(sessionId);
        entry?.terminal.dispose();
        ctx.localShellTerminals.delete(sessionId);
        ctx.core.unregisterLocalShellSession(sessionId);
        return;
      }
      const profile = toLocalShellProfileFromArg(ctx.core, arg);
      if (profile) {
        for (const [activeSessionId, entry] of ctx.localShellTerminals.entries()) {
          if (entry.profileId === profile.id) {
            entry.terminal.dispose();
            ctx.localShellTerminals.delete(activeSessionId);
            ctx.core.unregisterLocalShellSession(activeSessionId);
          }
        }
      }
    }),
    vscode.commands.registerCommand("nexus.localShell.rename", async (arg?: unknown) => {
      const profile = toLocalShellProfileFromArg(ctx.core, arg) ?? (await pickLocalShellProfile(ctx.core));
      if (!profile) return;
      const newName = await vscode.window.showInputBox({
        title: "Rename Local Shell Profile",
        value: profile.name,
        prompt: "Enter new name",
        validateInput: (value) => (value.trim() ? null : "Name cannot be empty")
      });
      if (newName && newName.trim() !== profile.name) {
        await ctx.core.addOrUpdateLocalShellProfile({ ...profile, name: newName.trim() });
      }
    }),
    vscode.commands.registerCommand("nexus.localShell.duplicate", async (arg?: unknown) => {
      const profile = toLocalShellProfileFromArg(ctx.core, arg) ?? (await pickLocalShellProfile(ctx.core));
      if (!profile) return;
      await ctx.core.addOrUpdateLocalShellProfile({ ...profile, id: randomUUID(), name: `${profile.name} (copy)` });
    }),
    vscode.commands.registerCommand("nexus.localShell.copyInfo", async (arg?: unknown) => {
      const profile = toLocalShellProfileFromArg(ctx.core, arg) ?? (await pickLocalShellProfile(ctx.core));
      if (!profile) return;
      const info = localShellDescription(profile);
      await vscode.env.clipboard.writeText(info);
      void vscode.window.showInformationMessage(`Copied: ${info}`);
    })
  ];
}
