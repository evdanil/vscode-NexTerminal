import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import { getMacros } from "../macroSettings";
import type { LocalShellProfile } from "../models/config";
import { LocalShellPty, resolveLocalPtySidecarPath } from "../services/local/localShellPty";
import { pickScriptFromWorkspace } from "../services/scripts/scriptPicker";
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

interface LocalShellLaunchOptions {
  shellPath: string;
  shellArgs?: string[];
  cwd?: string;
  env?: Record<string, string | null | undefined>;
}

interface OpenLocalShellOptions {
  waitForStartup?: boolean;
}

const SOURCE_PROFILE_GUIDANCE =
  "This VS Code profile uses source/autodetect and does not expose a launchable executable path to extensions. Auto-trigger macros require Nexus to launch the shell directly. Choose Custom Shell and enter the command, for example pwsh.exe, powershell.exe, cmd.exe, wsl.exe, /bin/bash, or /bin/zsh.";
const LOCAL_SHELL_AUTOTRIGGER_WARNING_KEY = "nexus.localShell.autoTriggerWarningShown";
const REVIEW_MACROS_ACTION = "Review Macros";
const DISABLE_AUTOTRIGGER_ACTION = "Disable Globally";
const CONTINUE_ACTION = "Continue";

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
  return Array.from(getLaunchableVscodeTerminalProfiles().keys()).sort((a, b) => a.localeCompare(b));
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

function shellPathCandidates(pathValue: string | string[] | undefined): string[] {
  if (typeof pathValue === "string" && pathValue.trim()) {
    return [pathValue];
  }
  if (Array.isArray(pathValue)) {
    return pathValue.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }
  return [];
}

function isBareCommand(value: string): boolean {
  return !/[\\/]/.test(value) && !/^[A-Za-z]:/.test(value);
}

function pathExists(value: string): boolean {
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function chooseShellPath(pathValue: string | string[] | undefined): string | undefined {
  const candidates = shellPathCandidates(pathValue)
    .map((item) => expandLocalShellValue(item))
    .filter((item): item is string => Boolean(item));
  if (candidates.length === 0) return undefined;
  return candidates.find(pathExists) ?? candidates.find(isBareCommand) ?? candidates[0];
}

function firstExistingPath(candidates: string[]): string | undefined {
  return unique(candidates.map((item) => expandLocalShellValue(item) ?? item))
    .find((item) => Boolean(item) && pathExists(item));
}

function readEnv(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  const foundKey = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
  return foundKey ? process.env[foundKey] : undefined;
}

function windowsRoot(): string {
  return readEnv("windir") ?? readEnv("SystemRoot") ?? "C:\\Windows";
}

function windowsSystem32(binary: string): string {
  return `${windowsRoot()}\\System32\\${binary}`;
}

function powershellPath(): string | undefined {
  return firstExistingPath([
    `${windowsRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    "powershell.exe"
  ]);
}

function gitBashPath(): string | undefined {
  const programFiles = readEnv("ProgramFiles") ?? "C:\\Program Files";
  const programFilesX86 = readEnv("ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
  const localAppData = readEnv("LOCALAPPDATA");
  return firstExistingPath([
    `${programFiles}\\Git\\bin\\bash.exe`,
    `${programFiles}\\Git\\usr\\bin\\bash.exe`,
    `${programFilesX86}\\Git\\bin\\bash.exe`,
    `${programFilesX86}\\Git\\usr\\bin\\bash.exe`,
    ...(localAppData ? [`${localAppData}\\Programs\\Git\\bin\\bash.exe`] : [])
  ]);
}

function wslPath(): string | undefined {
  return firstExistingPath([windowsSystem32("wsl.exe"), "wsl.exe"]);
}

function distroNameFromWslProfile(profileName: string): string | undefined {
  const match = profileName.match(/^(.*?)\s*\(WSL\)$/i);
  return match?.[1]?.trim() || undefined;
}

function decodeWslOutput(output: Buffer): string {
  const utf8 = output.toString("utf8");
  return utf8.includes("\u0000")
    ? output.toString("utf16le").replace(/\u0000/g, "")
    : utf8;
}

function listWslDistros(shellPath: string): string[] {
  try {
    const output = execFileSync(shellPath, ["-l", "-q"], {
      timeout: 1500,
      windowsHide: true
    });
    return decodeWslOutput(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes("docker-desktop"));
  } catch {
    return [];
  }
}

function profileFromSource(name: string, source: string | undefined): VscodeTerminalProfileConfig | undefined {
  const normalized = source?.toLowerCase() ?? "";
  if (normalized.includes("powershell")) {
    const path = powershellPath();
    return path ? { path } : undefined;
  }
  if (normalized.includes("git bash")) {
    const path = gitBashPath();
    return path ? { path } : undefined;
  }
  if (normalized.includes("wsl") || distroNameFromWslProfile(name)) {
    const path = wslPath();
    if (!path) return undefined;
    const distro = distroNameFromWslProfile(name);
    return { path, args: distro ? ["-d", distro] : undefined };
  }
  return undefined;
}

function profileFromInferredWslName(name: string): VscodeTerminalProfileConfig | undefined {
  if (name !== "WSL" && !distroNameFromWslProfile(name)) return undefined;
  return profileFromSource(name, "WSL");
}

function normalizeVscodeTerminalProfile(
  name: string,
  profile: VscodeTerminalProfileConfig
): VscodeTerminalProfileConfig | undefined {
  const shellPath = chooseShellPath(profile.path);
  if (shellPath) {
    return { ...profile, path: shellPath };
  }
  const sourceProfile = profileFromSource(name, profile.source);
  if (!sourceProfile) return undefined;
  return {
    ...profile,
    path: sourceProfile.path,
    args: profile.args ?? sourceProfile.args
  };
}

function getLaunchableVscodeTerminalProfiles(): Map<string, VscodeTerminalProfileConfig> {
  const profiles = new Map<string, VscodeTerminalProfileConfig>();
  for (const [name, profile] of Object.entries(getConfiguredVscodeTerminalProfiles())) {
    const normalized = normalizeVscodeTerminalProfile(name, profile);
    if (normalized) profiles.set(name, normalized);
  }

  if (process.platform === "win32") {
    const cmdPath = firstExistingPath([windowsSystem32("cmd.exe")]);
    if (cmdPath && !profiles.has("Command Prompt")) {
      profiles.set("Command Prompt", { path: cmdPath });
    }
    const psPath = powershellPath();
    if (psPath && !profiles.has("PowerShell")) {
      profiles.set("PowerShell", { path: psPath });
    }
    const bashPath = gitBashPath();
    if (bashPath && !profiles.has("Git Bash")) {
      profiles.set("Git Bash", { path: bashPath });
    }
    const wsl = wslPath();
    if (wsl) {
      if (!profiles.has("WSL")) {
        profiles.set("WSL", { path: wsl });
      }
      for (const distro of listWslDistros(wsl)) {
        const name = `${distro} (WSL)`;
        if (!profiles.has(name)) {
          profiles.set(name, { path: wsl, args: ["-d", distro] });
        }
      }
    }
  }

  return profiles;
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

function expandHome(value: string): string {
  return value.replace(/^~(?=\/|\\|$)/, os.homedir());
}

function workspaceFolders(): ReadonlyArray<{ name?: string; uri: { fsPath: string } }> {
  return vscode.workspace.workspaceFolders ?? [];
}

function expandWorkspaceVariables(value: string): string {
  const folders = workspaceFolders();
  const defaultFolder = folders[0]?.uri.fsPath;
  let expanded = value;
  if (defaultFolder) {
    expanded = expanded
      .replace(/\$\{workspaceFolder\}/g, defaultFolder)
      .replace(/\$\{workspaceRoot\}/g, defaultFolder);
  }
  expanded = expanded.replace(/\$\{workspaceFolder:([^}]+)\}/g, (match, name: string) => {
    const folder = folders.find((item) => item.name === name);
    return folder?.uri.fsPath ?? match;
  });
  return expanded;
}

function expandEnvVariables(value: string): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (match, name: string) => readEnv(name) ?? match);
}

function expandLocalShellValue(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return expandEnvVariables(expandWorkspaceVariables(expandHome(value.trim())));
}

function expandLocalShellArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  return args.map((arg) => expandLocalShellValue(arg) ?? "");
}

function expandLocalShellEnv(
  env: Record<string, string | null | undefined> | undefined
): Record<string, string | null | undefined> | undefined {
  if (!env) return undefined;
  const result: Record<string, string | null | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = typeof value === "string" ? expandLocalShellValue(value) : value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeProfileEnv(env: VscodeTerminalProfileConfig["env"]): LocalShellLaunchOptions["env"] {
  if (!env) {
    return undefined;
  }
  const result: NonNullable<LocalShellLaunchOptions["env"]> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" || value === null) {
      result[key] = typeof value === "string" ? expandLocalShellValue(value) : value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function expandLocalShellCwd(cwd: string | undefined): string | undefined {
  return expandLocalShellValue(cwd);
}

export function resolveLocalShellLaunchOptions(profile: LocalShellProfile): LocalShellLaunchOptions {
  if (profile.launchMode === "vscodeProfile") {
    const profileName = profile.vscodeProfileName?.trim();
    if (!profileName) {
      throw new Error("Local Shell profile is missing a VS Code terminal profile name.");
    }
    let terminalProfile = getLaunchableVscodeTerminalProfiles().get(profileName);
    terminalProfile ??= profileFromInferredWslName(profileName);
    if (!terminalProfile) {
      if (getConfiguredVscodeTerminalProfiles()[profileName]) {
        throw new Error(`${SOURCE_PROFILE_GUIDANCE} Profile: "${profileName}".`);
      }
      throw new Error(`VS Code terminal profile "${profileName}" was not found for this platform.`);
    }
    const shellPath = chooseShellPath(terminalProfile.path);
    if (!shellPath) {
      throw new Error(`${SOURCE_PROFILE_GUIDANCE} Profile: "${profileName}".`);
    }
    return {
      shellPath: expandLocalShellValue(shellPath) ?? shellPath,
      shellArgs: expandLocalShellArgs(normalizeProfileArgs(terminalProfile.args)),
      env: normalizeProfileEnv(terminalProfile.env),
      cwd: expandLocalShellCwd(profile.cwd)
    };
  }

  if (!profile.shellPath?.trim()) {
    throw new Error(`Local Shell profile "${profile.name}" is missing a shell path.`);
  }
  return {
    shellPath: expandLocalShellValue(profile.shellPath) ?? profile.shellPath,
    shellArgs: expandLocalShellArgs(profile.shellArgs),
    cwd: expandLocalShellCwd(profile.cwd),
    env: expandLocalShellEnv(profile.env)
  };
}

export const resolveLocalShellTerminalOptions = resolveLocalShellLaunchOptions;

function localShellDescription(profile: LocalShellProfile): string {
  return profile.launchMode === "vscodeProfile"
    ? `VS Code: ${profile.vscodeProfileName ?? ""}`
    : profile.shellPath ?? "";
}

function hasAllTerminalAutoTriggerMacros(): boolean {
  return getMacros().some((macro) =>
    Boolean(macro.triggerPattern) &&
    (macro.triggerScope === undefined || macro.triggerScope === "all-terminals")
  );
}

async function confirmLocalShellAutoTriggers(ctx: CommandContext): Promise<boolean> {
  if (ctx.globalState.get<boolean>(LOCAL_SHELL_AUTOTRIGGER_WARNING_KEY, false)) {
    return true;
  }

  const autoTriggerEnabled = vscode.workspace
    .getConfiguration("nexus.terminal.macros")
    .get<boolean>("autoTrigger", true);
  if (!autoTriggerEnabled || !hasAllTerminalAutoTriggerMacros()) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    "Local Shell auto-trigger is now available. Existing \"All terminals\" macros can also run in Local Shell sessions. Disabling here turns off auto-trigger macros globally for SSH, Serial, and Local Shell.",
    REVIEW_MACROS_ACTION,
    DISABLE_AUTOTRIGGER_ACTION,
    CONTINUE_ACTION
  );
  if (choice === REVIEW_MACROS_ACTION) {
    void vscode.commands.executeCommand("nexus.macro.editor");
    return false;
  }
  if (choice === DISABLE_AUTOTRIGGER_ACTION) {
    await vscode.workspace
      .getConfiguration("nexus.terminal.macros")
      .update("autoTrigger", false, vscode.ConfigurationTarget.Global);
    await ctx.globalState.update(LOCAL_SHELL_AUTOTRIGGER_WARNING_KEY, true);
    return true;
  }
  if (choice === CONTINUE_ACTION) {
    await ctx.globalState.update(LOCAL_SHELL_AUTOTRIGGER_WARNING_KEY, true);
    return true;
  }
  return false;
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

async function openLocalShell(
  ctx: CommandContext,
  profile: LocalShellProfile,
  options: OpenLocalShellOptions = {}
): Promise<string | undefined> {
  const openInEditor = vscode.workspace.getConfiguration("nexus.terminal").get("openLocation") === "editor";
  const launchOptions = resolveLocalShellLaunchOptions(profile);
  if (!(await confirmLocalShellAutoTriggers(ctx))) {
    return undefined;
  }
  const terminalName = `Nexus Local Shell: ${profile.name}`;
  const sessionId = randomUUID();
  let terminalRef: vscode.Terminal | undefined;
  let ptyRef: LocalShellPty | undefined;
  let terminatedEarly = false;
  const triggerObserver = ctx.macroAutoTrigger.createObserver(
    (text) => ptyRef?.handleInput(text),
    () => ctx.focusedTerminal === terminalRef,
    sessionId,
    profile.id
  );
  const pty = new LocalShellPty({
    sidecarPath: resolveLocalPtySidecarPath(ctx.extensionPath),
    shellPath: launchOptions.shellPath,
    shellArgs: launchOptions.shellArgs,
    cwd: launchOptions.cwd,
    env: launchOptions.env,
    terminalName,
    startupCommand: profile.startupCommand,
    outputChannel: ctx.localShellOutputChannel,
    highlighter: ctx.highlighter
  });
  ptyRef = pty;
  pty.addOutputObserver(triggerObserver);
  pty.onDidTerminateEarly(() => {
    terminatedEarly = true;
    if (!ctx.localShellTerminals.has(sessionId)) return;
    ctx.localShellTerminals.delete(sessionId);
    ctx.core.unregisterLocalShellSession(sessionId);
  });
  const terminal = vscode.window.createTerminal({
    name: terminalName,
    pty,
    iconPath: new vscode.ThemeIcon("terminal"),
    location: openInEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel
  });
  terminalRef = terminal;
  if (terminatedEarly) {
    ctx.focusedTerminal = terminal;
    terminal.show();
    return undefined;
  }
  const entry: LocalShellTerminalEntry = { terminal, profileId: profile.id, pty };
  ctx.localShellTerminals.set(sessionId, entry);
  ctx.terminalRegistry?.register(terminal, pty);
  if (terminatedEarly) {
    ctx.localShellTerminals.delete(sessionId);
    ctx.core.unregisterLocalShellSession(sessionId);
    ctx.focusedTerminal = terminal;
    terminal.show();
    return undefined;
  }
  ctx.core.registerLocalShellSession({
    id: sessionId,
    profileId: profile.id,
    terminalName,
    startedAt: Date.now(),
    pty
  });
  ctx.focusedTerminal = terminal;
  terminal.show();
  if (terminatedEarly) {
    ctx.localShellTerminals.delete(sessionId);
    ctx.core.unregisterLocalShellSession(sessionId);
    return undefined;
  }
  if (options.waitForStartup && !(await pty.waitForStartup())) {
    ctx.localShellTerminals.delete(sessionId);
    ctx.core.unregisterLocalShellSession(sessionId);
    return undefined;
  }
  return sessionId;
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
    vscode.commands.registerCommand("nexus.localShell.runWithScript", async (arg?: unknown) => {
      const profile = toLocalShellProfileFromArg(ctx.core, arg) ?? (await pickLocalShellProfile(ctx.core));
      if (!profile) {
        return;
      }
      if (!ctx.scriptRuntimeManager) {
        void vscode.window.showErrorMessage("Nexus script runtime is not available in this context.");
        return;
      }
      const scriptUri = await pickScriptFromWorkspace(ctx.globalStoragePath, "local");
      if (!scriptUri) return;
      try {
        const sessionId = await openLocalShell(ctx, profile, { waitForStartup: true });
        if (!sessionId) return;
        await ctx.scriptRuntimeManager.runScript(scriptUri, sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to open local shell with script: ${message}`);
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
