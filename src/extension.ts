import * as path from "node:path";
import * as vscode from "vscode";
import { registerSerialCommands } from "./commands/serialCommands";
import { registerServerCommands } from "./commands/serverCommands";
import { registerTunnelCommands } from "./commands/tunnelCommands";
import type { CommandContext, SerialTerminalMap, ServerTerminalMap, SessionTerminalMap } from "./commands/types";
import { NexusCore } from "./core/nexusCore";
import { TerminalLoggerFactory } from "./logging/terminalLogger";
import { SerialSidecarManager } from "./services/serial/serialSidecarManager";
import { SilentAuthSshFactory } from "./services/ssh/silentAuth";
import { Ssh2Connector } from "./services/ssh/ssh2Connector";
import { VscodePasswordPrompt } from "./services/ssh/vscodePasswordPrompt";
import { VscodeSecretVault } from "./services/ssh/vscodeSecretVault";
import { TunnelManager } from "./services/tunnel/tunnelManager";
import { VscodeConfigRepository } from "./storage/vscodeConfigRepository";
import { NexusTreeProvider } from "./ui/nexusTreeProvider";
import { SettingsTreeProvider } from "./ui/settingsTreeProvider";
import { TunnelTreeProvider } from "./ui/tunnelTreeProvider";
import { clamp } from "./utils/helpers";
import { registerSettingsCommands } from "./commands/settingsCommands";
import { registerConfigCommands } from "./commands/configCommands";
import { registerMacroCommands, updateMacroContext } from "./commands/macroCommands";
import { registerProfileCommands } from "./commands/profileCommands";
import { resolveTunnelConnectionMode, startTunnel } from "./commands/tunnelCommands";
import { MacroTreeProvider } from "./ui/macroTreeProvider";

const MACRO_SKIP_SHELL_COMMANDS = ["nexus.macro.run", "nexus.macro.slot"];

/**
 * Ensure VS Code settings allow Alt+S / Alt+N macro keybindings to reach the extension.
 * Three settings are patched:
 *  1. terminal.integrated.commandsToSkipShell — our commands must be in the list
 *  2. terminal.integrated.sendKeybindingsToShell — must be false so the shell doesn't swallow shortcuts
 *  3. window.enableMenuBarMnemonics — must be false so Alt+letter doesn't open menus (Linux/Windows)
 */
function ensureMacroKeybindingsWork(): void {
  // --- 1. commandsToSkipShell ---
  const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
  const inspect = termConfig.inspect<string[]>("commandsToSkipShell");

  // Patch any user-customised levels so our commands survive alongside their entries.
  const levels: Array<{ value: string[] | undefined; target: vscode.ConfigurationTarget }> = [
    { value: inspect?.globalValue, target: vscode.ConfigurationTarget.Global },
    { value: inspect?.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
    { value: inspect?.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
  ];

  let patchedAny = false;
  for (const { value, target } of levels) {
    if (value !== undefined) {
      const missing = MACRO_SKIP_SHELL_COMMANDS.filter(cmd => !value.includes(cmd));
      if (missing.length > 0) {
        void termConfig.update("commandsToSkipShell", [...value, ...missing], target);
      }
      patchedAny = true;
    }
  }

  // Safety net: if no user-level value exists, configurationDefaults SHOULD cover us.
  // Verify the effective (resolved) value actually contains our commands.
  // If not, write to Global to guarantee they work on first install.
  if (!patchedAny) {
    const effective = termConfig.get<string[]>("commandsToSkipShell", []);
    const missing = MACRO_SKIP_SHELL_COMMANDS.filter(cmd => !effective.includes(cmd));
    if (missing.length > 0) {
      void termConfig.update("commandsToSkipShell", [...effective, ...missing], vscode.ConfigurationTarget.Global);
    }
  }

  // --- 2. sendKeybindingsToShell ---
  // When true the terminal shell receives matched keybindings before VS Code, swallowing Alt+N.
  const sendInspect = termConfig.inspect<boolean>("sendKeybindingsToShell");
  if (sendInspect?.globalValue === true) {
    void termConfig.update("sendKeybindingsToShell", false, vscode.ConfigurationTarget.Global);
  } else if (sendInspect?.globalValue === undefined && termConfig.get<boolean>("sendKeybindingsToShell") === true) {
    void termConfig.update("sendKeybindingsToShell", false, vscode.ConfigurationTarget.Global);
  }

  // --- 3. enableMenuBarMnemonics ---
  // When true (default on Linux/Windows) Alt+letter opens the menu bar, e.g. Alt+S → Selection menu.
  const winConfig = vscode.workspace.getConfiguration("window");
  const mnemonicInspect = winConfig.inspect<boolean>("enableMenuBarMnemonics");
  if (mnemonicInspect?.globalValue === true) {
    void winConfig.update("enableMenuBarMnemonics", false, vscode.ConfigurationTarget.Global);
  } else if (mnemonicInspect?.globalValue === undefined && winConfig.get<boolean>("enableMenuBarMnemonics") === true) {
    void winConfig.update("enableMenuBarMnemonics", false, vscode.ConfigurationTarget.Global);
  }
}

const ALL_PASSTHROUGH_KEYS = ["b", "e", "g", "j", "k", "n", "o", "p", "r", "w"] as const;

function updatePassthroughContext(): void {
  const config = vscode.workspace.getConfiguration("nexus.terminal");
  const masterEnabled = config.get<boolean>("keyboardPassthrough", false);
  const selectedKeys = config.get<string[]>("passthroughKeys", [...ALL_PASSTHROUGH_KEYS]);
  const activeSet = masterEnabled ? new Set(selectedKeys.map(k => k.toLowerCase())) : new Set<string>();
  for (const key of ALL_PASSTHROUGH_KEYS) {
    void vscode.commands.executeCommand("setContext", `nexus.passthrough.ctrl${key.toUpperCase()}`, activeSet.has(key));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repository = new VscodeConfigRepository(context);
  const core = new NexusCore(repository);
  await core.initialize();

  const loggingConfig = vscode.workspace.getConfiguration("nexus.logging");
  const maxFileSizeMb = clamp(Math.floor(loggingConfig.get<number>("maxFileSizeMb", 10)), 1, 1024);
  const maxRotatedFiles = clamp(Math.floor(loggingConfig.get<number>("maxRotatedFiles", 1)), 0, 99);
  const loggerFactory = new TerminalLoggerFactory(path.join(context.globalStorageUri.fsPath, "logs"), {
    maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
    maxRotatedFiles
  });
  const sshFactory = new SilentAuthSshFactory(
    new Ssh2Connector(),
    new VscodeSecretVault(context),
    new VscodePasswordPrompt(),
    (message, isPassword) =>
      Promise.resolve(
        vscode.window.showInputBox({
          title: "Nexus SSH",
          prompt: message.replace(/:\s*$/, ""),
          password: isPassword,
          ignoreFocusOut: true
        })
      )
  );
  const tunnelManager = new TunnelManager(sshFactory);
  const extensionRoot = path.resolve(__dirname, "..");
  const sidecarPath = path.join(__dirname, "services", "serial", "serialSidecarWorker.js");
  const serialSidecar = new SerialSidecarManager(sidecarPath, extensionRoot);
  const terminalsByServer: ServerTerminalMap = new Map();
  const sessionTerminals: SessionTerminalMap = new Map();
  const serialTerminals: SerialTerminalMap = new Map();

  const defaultSessionLogDir = path.join(context.globalStorageUri.fsPath, "session-logs");

  const ctx: CommandContext = {
    core,
    tunnelManager,
    serialSidecar,
    sshFactory,
    loggerFactory,
    get sessionLogDir() {
      const custom = vscode.workspace.getConfiguration("nexus.logging").get<string>("sessionLogDirectory", "");
      return custom || defaultSessionLogDir;
    },
    terminalsByServer,
    sessionTerminals,
    serialTerminals
  };

  const nexusTreeProvider = new NexusTreeProvider({
    async onTunnelDropped(serverId, tunnelProfileId) {
      const profile = core.getTunnel(tunnelProfileId);
      const server = core.getServer(serverId);
      if (!profile || !server) {
        return;
      }
      const connectionMode = await resolveTunnelConnectionMode(profile, true);
      if (!connectionMode) {
        return;
      }
      await startTunnel(core, tunnelManager, sshFactory, profile, server, connectionMode);
    },
    async onItemGroupChanged(itemType, itemId, newGroup) {
      if (itemType === "server") {
        const server = core.getServer(itemId);
        if (server) {
          await core.addOrUpdateServer({ ...server, group: newGroup });
        }
      } else {
        const profile = core.getSerialProfile(itemId);
        if (profile) {
          await core.addOrUpdateSerialProfile({ ...profile, group: newGroup });
        }
      }
    }
  });
  const tunnelTreeProvider = new TunnelTreeProvider();
  const settingsTreeProvider = new SettingsTreeProvider(defaultSessionLogDir);
  const commandCenterView = vscode.window.createTreeView("nexusCommandCenter", {
    treeDataProvider: nexusTreeProvider,
    dragAndDropController: nexusTreeProvider,
    showCollapseAll: true
  });
  const tunnelView = vscode.window.createTreeView("nexusTunnels", {
    treeDataProvider: tunnelTreeProvider,
    dragAndDropController: tunnelTreeProvider,
    showCollapseAll: true
  });

  const settingsView = vscode.window.createTreeView("nexusSettings", {
    treeDataProvider: settingsTreeProvider
  });

  const macroTreeProvider = new MacroTreeProvider();
  const macroView = vscode.window.createTreeView("nexusMacros", {
    treeDataProvider: macroTreeProvider
  });
  updateMacroContext();
  updatePassthroughContext();
  ensureMacroKeybindingsWork();

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = "nexusCommandCenter.focus";
  statusBarItem.show();

  const syncViews = (): void => {
    const snapshot = core.getSnapshot();
    nexusTreeProvider.setSnapshot(snapshot);
    tunnelTreeProvider.setSnapshot(snapshot);
    statusBarItem.text = `$(terminal) Nexus: ${snapshot.activeSessions.length} sessions, ${snapshot.activeTunnels.length} tunnels`;
  };
  syncViews();

  const unsubscribeCore = core.onDidChange(() => syncViews());
  const unsubscribeTunnel = tunnelManager.onDidChange((event) => {
    if (event.type === "started") {
      core.registerTunnel(event.tunnel);
      const logger = loggerFactory.create("tunnel", event.tunnel.id);
      logger.log(
        `started profile=${event.tunnel.profileId} local=${event.tunnel.localPort} remote=${event.tunnel.remoteIP}:${event.tunnel.remotePort}`
      );
      logger.close();
      return;
    }
    if (event.type === "traffic") {
      core.updateTunnelTraffic(event.tunnelId, event.bytesIn, event.bytesOut);
      return;
    }
    if (event.type === "stopped") {
      core.unregisterTunnel(event.tunnelId);
      return;
    }
    if (event.type === "error") {
      const message = event.error instanceof Error ? event.error.message : event.message;
      const active = event.tunnelId
        ? core.getSnapshot().activeTunnels.find((item) => item.id === event.tunnelId)
        : undefined;
      const profile = active ? core.getTunnel(active.profileId) : undefined;
      const route = active ? `${active.localPort} -> ${active.remoteIP}:${active.remotePort}` : undefined;
      if (message.includes("Channel open failure: Connection refused")) {
        void vscode.window.showErrorMessage(
          `Nexus tunnel error: Remote endpoint refused ${route ?? "requested route"}. Verify target host/port service is listening and reachable from SSH server.`
        );
        return;
      }
      void vscode.window.showErrorMessage(
        `Nexus tunnel error${profile ? ` (${profile.name})` : ""}: ${message}${route ? ` [${route}]` : ""}`
      );
    }
  });

  const refreshCommand = vscode.commands.registerCommand("nexus.refresh", async () => {
    await core.initialize();
    syncViews();
  });

  const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("nexus.logging") || event.affectsConfiguration("nexus.tunnel") || event.affectsConfiguration("nexus.terminal")) {
      settingsTreeProvider.refresh();
    }
    if (event.affectsConfiguration("nexus.terminal.macros")) {
      macroTreeProvider.refresh();
      updateMacroContext();
    }
    if (event.affectsConfiguration("nexus.terminal.keyboardPassthrough") || event.affectsConfiguration("nexus.terminal.passthroughKeys")) {
      updatePassthroughContext();
    }
  });

  const serverDisposables = registerServerCommands(ctx);
  const tunnelDisposables = registerTunnelCommands(ctx);
  const serialDisposables = registerSerialCommands(ctx);
  const profileDisposables = registerProfileCommands(ctx);
  const settingsDisposables = registerSettingsCommands(settingsTreeProvider, () => ctx.sessionLogDir);
  const configDisposables = registerConfigCommands(core);
  const macroDisposables = registerMacroCommands(macroTreeProvider);

  context.subscriptions.push(
    commandCenterView,
    tunnelView,
    settingsView,
    macroView,
    statusBarItem,
    refreshCommand,
    configChangeListener,
    ...serverDisposables,
    ...tunnelDisposables,
    ...serialDisposables,
    ...profileDisposables,
    ...settingsDisposables,
    ...configDisposables,
    ...macroDisposables,
    {
      dispose: () => {
        unsubscribeCore();
        unsubscribeTunnel();
        for (const [, entry] of serialTerminals.entries()) {
          entry.terminal.dispose();
        }
        serialTerminals.clear();
        serialSidecar.dispose();
        void tunnelManager.stopAll();
      }
    }
  );
}

export async function deactivate(): Promise<void> {
  // Cleanup is handled via context.subscriptions disposables
}
