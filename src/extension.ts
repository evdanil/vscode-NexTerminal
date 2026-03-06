import * as path from "node:path";
import * as vscode from "vscode";
import { registerFileCommands } from "./commands/fileCommands";
import { registerSerialCommands } from "./commands/serialCommands";
import { registerServerCommands } from "./commands/serverCommands";
import { registerTunnelCommands } from "./commands/tunnelCommands";
import type { CommandContext, SerialTerminalMap, ServerTerminalMap, SessionTerminalMap } from "./commands/types";
import { NexusCore } from "./core/nexusCore";
import { TerminalLoggerFactory } from "./logging/terminalLogger";
import { SerialSidecarManager } from "./services/serial/serialSidecarManager";
import { NexusFileSystemProvider, NEXTERM_SCHEME } from "./services/sftp/nexusFileSystemProvider";
import { SftpService } from "./services/sftp/sftpService";
import { SilentAuthSshFactory, proxyPasswordSecretKey } from "./services/ssh/silentAuth";
import { ProxySshFactory } from "./services/ssh/proxySshFactory";
import { SshConnectionPool } from "./services/ssh/sshConnectionPool";
import { Ssh2Connector } from "./services/ssh/ssh2Connector";
import { VscodeHostKeyVerifier } from "./services/ssh/vscodeHostKeyVerifier";
import { VscodePasswordPrompt } from "./services/ssh/vscodePasswordPrompt";
import { VscodeSecretVault } from "./services/ssh/vscodeSecretVault";
import { MacroAutoTrigger } from "./services/macroAutoTrigger";
import { TerminalHighlighter } from "./services/terminalHighlighter";
import { TunnelManager } from "./services/tunnel/tunnelManager";
import { VscodeConfigRepository } from "./storage/vscodeConfigRepository";
import { VscodeTunnelRegistryStore } from "./storage/vscodeTunnelRegistryStore";
import { TunnelRegistrySync } from "./services/tunnel/tunnelRegistrySync";
import { FileExplorerTreeProvider } from "./ui/fileExplorerTreeProvider";
import { createCollapsedFolderStatePersistence } from "./ui/collapsedFolderStatePersistence";
import { FolderTreeItem, NexusTreeProvider } from "./ui/nexusTreeProvider";
import { SettingsTreeProvider } from "./ui/settingsTreeProvider";
import { TunnelTreeProvider, formatTunnelRoute } from "./ui/tunnelTreeProvider";
import { clamp } from "./utils/helpers";
import { createCoalescedInvoker } from "./utils/coalescedInvoker";
import { registerSettingsCommands } from "./commands/settingsCommands";
import { registerConfigCommands } from "./commands/configCommands";
import { registerMacroCommands, updateMacroContext, migrateMacroSlots } from "./commands/macroCommands";
import { registerProfileCommands } from "./commands/profileCommands";
import { registerAuthProfileCommands } from "./commands/authProfileCommands";
import { resolveTunnelConnectionMode, startTunnel } from "./commands/tunnelCommands";
import { MacroTreeItem, MacroTreeProvider } from "./ui/macroTreeProvider";
import { VscodeColorSchemeStorage } from "./storage/vscodeColorSchemeStorage";
import { ColorSchemeService } from "./services/colorSchemeService";
import { TerminalAppearancePanel } from "./ui/terminalAppearancePanel";
import { tryRegisterResourceLabelFormatter } from "./services/sftp/resourceLabelFormatter";

const MACRO_SKIP_SHELL_COMMANDS = ["nexus.macro.run", "nexus.macro.runBinding"];
const COLLAPSED_FOLDERS_KEY = "nexus.ui.collapsedFolders";

/**
 * Ensure VS Code settings allow macro shortcuts to reach the extension.
 * Three settings are patched:
 *  1. terminal.integrated.commandsToSkipShell — our commands must be in the list
 *  2. terminal.integrated.sendKeybindingsToShell — must be false so the shell doesn't swallow shortcuts
 *  3. window.enableMenuBarMnemonics — must be false so Alt+letter shortcuts don't open menus (Linux/Windows)
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
  // When true the terminal shell receives matched keybindings before VS Code, swallowing macro shortcuts.
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

/** Track which passthrough context keys are currently set to true, so we only update the delta. */
const activePassthroughKeys = new Set<string>();

function updatePassthroughContext(): void {
  const config = vscode.workspace.getConfiguration("nexus.terminal");
  const masterEnabled = config.get<boolean>("keyboardPassthrough", false);
  const selectedKeys = config.get<string[]>("passthroughKeys", [...ALL_PASSTHROUGH_KEYS]);
  const activeSet = masterEnabled ? new Set(selectedKeys.map(k => k.toLowerCase())) : new Set<string>();

  for (const key of ALL_PASSTHROUGH_KEYS) {
    const contextKey = `nexus.passthrough.ctrl${key.toUpperCase()}`;
    const shouldBeActive = activeSet.has(key);
    const isActive = activePassthroughKeys.has(contextKey);
    if (shouldBeActive && !isActive) {
      activePassthroughKeys.add(contextKey);
      void vscode.commands.executeCommand("setContext", contextKey, true);
    } else if (!shouldBeActive && isActive) {
      activePassthroughKeys.delete(contextKey);
      void vscode.commands.executeCommand("setContext", contextKey, false);
    }
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
  const secretVault = new VscodeSecretVault(context);
  const hostKeyVerifier = new VscodeHostKeyVerifier(context.globalState);
  const sshFactory = new SilentAuthSshFactory(
    new Ssh2Connector(hostKeyVerifier),
    secretVault,
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
  const proxiedFactory = new ProxySshFactory(
    sshFactory,
    (id) => core.getServer(id),
    secretVault
  );
  const multiplexingConfig = vscode.workspace.getConfiguration("nexus.ssh.multiplexing");
  const pool = new SshConnectionPool(proxiedFactory, {
    enabled: multiplexingConfig.get<boolean>("enabled", true),
    idleTimeoutMs: Math.min(
      multiplexingConfig.get<number>("idleTimeout", 300) * 1000,
      3_600_000
    )
  });
  const tunnelManager = new TunnelManager(pool, sshFactory);
  const extensionRoot = path.resolve(__dirname, "..");
  const sidecarPath = path.join(__dirname, "services", "serial", "serialSidecarWorker.js");
  const serialSidecar = new SerialSidecarManager(sidecarPath, extensionRoot);
  const registryStore = new VscodeTunnelRegistryStore(context);
  const registrySync = new TunnelRegistrySync(registryStore, core, vscode.env.sessionId);
  await registrySync.initialize();

  const terminalsByServer: ServerTerminalMap = new Map();
  const sessionTerminals: SessionTerminalMap = new Map();
  const serialTerminals: SerialTerminalMap = new Map();

  const highlighter = new TerminalHighlighter();
  const macroAutoTrigger = new MacroAutoTrigger();
  const colorSchemeStorage = new VscodeColorSchemeStorage(context);
  const colorSchemeService = new ColorSchemeService(colorSchemeStorage);
  const sftpConfig = vscode.workspace.getConfiguration("nexus.sftp");
  const sftpService = new SftpService(pool, {
    cacheTtlMs: sftpConfig.get<number>("cacheTtlSeconds", 10) * 1000,
    maxCacheEntries: sftpConfig.get<number>("maxCacheEntries", 500),
  });
  const fileSystemProvider = new NexusFileSystemProvider(sftpService);
  const fsRegistration = vscode.workspace.registerFileSystemProvider(NEXTERM_SCHEME, fileSystemProvider, { isCaseSensitive: true });

  // Keep nexterm:// labels in POSIX style on Windows.
  tryRegisterResourceLabelFormatter(vscode.workspace, NEXTERM_SCHEME);
  const fileExplorerProvider = new FileExplorerTreeProvider(sftpService);
  const defaultSessionLogDir = path.join(context.globalStorageUri.fsPath, "session-logs");

  const ctx: CommandContext = {
    core,
    tunnelManager,
    serialSidecar,
    sshFactory: pool,
    sshPool: pool,
    loggerFactory,
    get sessionLogDir() {
      const custom = vscode.workspace.getConfiguration("nexus.logging").get<string>("sessionLogDirectory", "");
      return custom || defaultSessionLogDir;
    },
    terminalsByServer,
    sessionTerminals,
    serialTerminals,
    highlighter,
    macroAutoTrigger,
    sftpService,
    fileExplorerProvider,
    secretVault,
    registrySync
  };

  const nexusTreeProvider = new NexusTreeProvider({
    async onTunnelDropped(serverId, tunnelProfileId) {
      const profile = core.getTunnel(tunnelProfileId);
      const server = core.getServer(serverId);
      if (!profile) {
        vscode.window.showWarningMessage("Cannot start tunnel: tunnel profile not found.");
        return;
      }
      if (!server) {
        vscode.window.showWarningMessage("Cannot start tunnel: server not found.");
        return;
      }
      const connectionMode = await resolveTunnelConnectionMode(profile, true);
      if (!connectionMode) {
        return; // User canceled — intentional
      }
      try {
        await startTunnel(core, tunnelManager, pool, profile, server, connectionMode, registrySync);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        vscode.window.showErrorMessage(`Failed to start tunnel "${profile.name}": ${message}`);
      }
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
    },
    async onFolderMoved(oldPath, newParentPath) {
      await core.moveFolder(oldPath, newParentPath);
    }
  });
  const tunnelTreeProvider = new TunnelTreeProvider();
  const settingsTreeProvider = new SettingsTreeProvider();
  const savedCollapsed = context.globalState.get<string[]>(COLLAPSED_FOLDERS_KEY, []);
  nexusTreeProvider.loadCollapsedFolders(savedCollapsed);
  const collapsedFolderStatePersistence = createCollapsedFolderStatePersistence(
    (paths) => context.globalState.update(COLLAPSED_FOLDERS_KEY, paths),
    {
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to persist collapsed folder state: ${message}`);
      }
    }
  );
  const persistCollapsedFolders = (): void => {
    collapsedFolderStatePersistence.schedule(nexusTreeProvider.getCollapsedFolders());
  };
  const handleFolderStateChange = (element: unknown, isCollapsed: boolean): void => {
    if (!(element instanceof FolderTreeItem)) {
      return;
    }
    if (isCollapsed) {
      nexusTreeProvider.collapseFolder(element.folderPath);
    } else {
      nexusTreeProvider.expandFolder(element.folderPath);
    }
    persistCollapsedFolders();
  };

  const commandCenterView = vscode.window.createTreeView("nexusCommandCenter", {
    treeDataProvider: nexusTreeProvider,
    dragAndDropController: nexusTreeProvider,
    showCollapseAll: true
  });
  void vscode.commands.executeCommand("setContext", "nexus.filterActive", false);

  const filterCommand = vscode.commands.registerCommand("nexus.filter", async () => {
    const value = await vscode.window.showInputBox({
      title: "Filter Connectivity Hub",
      prompt: "Show only matching servers by name or hostname",
      placeHolder: "e.g. prod or 192.168",
      value: nexusTreeProvider.getFilterText(),
    });
    if (value === undefined) return;
    if (value.trim() === "") {
      nexusTreeProvider.clearFilter();
      void vscode.commands.executeCommand("setContext", "nexus.filterActive", false);
    } else {
      nexusTreeProvider.setFilter(value);
      void vscode.commands.executeCommand("setContext", "nexus.filterActive", true);
    }
  });

  const filterClearCommand = vscode.commands.registerCommand("nexus.filter.clear", () => {
    nexusTreeProvider.clearFilter();
    void vscode.commands.executeCommand("setContext", "nexus.filterActive", false);
  });

  const collapseListener = commandCenterView.onDidCollapseElement((e) => {
    handleFolderStateChange(e.element, true);
  });
  const expandListener = commandCenterView.onDidExpandElement((e) => {
    handleFolderStateChange(e.element, false);
  });
  const tunnelView = vscode.window.createTreeView("nexusTunnels", {
    treeDataProvider: tunnelTreeProvider,
    dragAndDropController: tunnelTreeProvider,
    showCollapseAll: true
  });

  const settingsView = vscode.window.createTreeView("nexusSettings", {
    treeDataProvider: settingsTreeProvider
  });

  const fileExplorerView = vscode.window.createTreeView("nexusFileExplorer", {
    treeDataProvider: fileExplorerProvider,
    dragAndDropController: fileExplorerProvider,
    showCollapseAll: true,
    canSelectMany: true
  });

  const macroTreeProvider = new MacroTreeProvider((_macro, index) => macroAutoTrigger.isDisabled(index));
  const macroView = vscode.window.createTreeView("nexusMacros", {
    treeDataProvider: macroTreeProvider
  });
  await migrateMacroSlots();
  updateMacroContext();
  updatePassthroughContext();
  ensureMacroKeybindingsWork();

  const autoRefreshInterval = vscode.workspace.getConfiguration("nexus.sftp").get<number>("autoRefreshInterval", 10);
  fileExplorerProvider.setAutoRefreshInterval(autoRefreshInterval);
  fileExplorerView.onDidChangeVisibility((e) => {
    fileExplorerProvider.setViewVisibility(e.visible);
    if (e.visible) {
      fileExplorerProvider.refresh();
    }
  });

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = "nexusCommandCenter.focus";
  statusBarItem.show();

  const syncViewsImmediate = (): void => {
    const snapshot = core.getSnapshot();
    nexusTreeProvider.setSnapshot(snapshot);
    tunnelTreeProvider.setSnapshot(snapshot);
    const totalTunnels = snapshot.activeTunnels.length + snapshot.remoteTunnels.length;
    statusBarItem.text = `$(terminal) Nexus: ${snapshot.activeSessions.length} sessions, ${totalTunnels} tunnels`;
    if (snapshot.remoteTunnels.length > 0) {
      statusBarItem.tooltip = `${snapshot.activeTunnels.length} local, ${snapshot.remoteTunnels.length} in other window`;
    } else {
      statusBarItem.tooltip = undefined;
    }

    const activeServerId = fileExplorerProvider.getActiveServerId();
    if (activeServerId && !core.isServerConnected(activeServerId)) {
      sftpService.disconnect(activeServerId);
      fileExplorerProvider.clearActiveServer();
    }
  };
  const viewSync = createCoalescedInvoker(syncViewsImmediate, 150);
  const syncViews = (): void => {
    viewSync.schedule();
  };
  syncViewsImmediate();

  let previousServers = new Map<string, import("./models/config").ServerConfig>(
    core.getSnapshot().servers.map(s => [s.id, s])
  );

  const unsubscribeCore = core.onDidChange((snapshot) => {
    syncViews();
    for (const server of snapshot.servers) {
      const prev = previousServers.get(server.id);
      if (prev && (
        prev.host !== server.host ||
        prev.port !== server.port ||
        prev.username !== server.username ||
        prev.authType !== server.authType ||
        prev.keyPath !== server.keyPath ||
        prev.multiplexing !== server.multiplexing ||
        prev.legacyAlgorithms !== server.legacyAlgorithms ||
        JSON.stringify(prev.proxy) !== JSON.stringify(server.proxy)
      )) {
        pool.disconnect(server.id);
        // Clear stale proxy password when proxy endpoint changes to prevent
        // sending one proxy's credentials to a different proxy server.
        if (JSON.stringify(prev.proxy) !== JSON.stringify(server.proxy)) {
          void secretVault.delete(proxyPasswordSecretKey(server.id));
        }
      }
    }
    previousServers = new Map(snapshot.servers.map(s => [s.id, s]));
  });
  const unsubscribeTunnel = tunnelManager.onDidChange((event) => {
    if (event.type === "started") {
      core.registerTunnel(event.tunnel);
      void registrySync.registerTunnel(event.tunnel);
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
      const stoppingTunnel = core.getSnapshot().activeTunnels.find((t) => t.id === event.tunnelId);
      core.unregisterTunnel(event.tunnelId);
      if (stoppingTunnel) {
        void registrySync.unregisterTunnel(stoppingTunnel.profileId);
      }
      return;
    }
    if (event.type === "error") {
      const message = event.error instanceof Error ? event.error.message : event.message;
      const active = event.tunnelId
        ? core.getSnapshot().activeTunnels.find((item) => item.id === event.tunnelId)
        : undefined;
      const profile = active ? core.getTunnel(active.profileId) : undefined;
      const route = profile ? formatTunnelRoute(profile) : (active ? `${active.localPort} -> ${active.remoteIP}:${active.remotePort}` : undefined);
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
    viewSync.flush();
  });

  const windowFocusListener = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      void registrySync.syncNow();
    }
  });

  const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("nexus.terminal.macros")) {
      macroAutoTrigger.reload();
      updateMacroContext();
      macroTreeProvider.refresh();
    }
    if (event.affectsConfiguration("nexus.terminal.keyboardPassthrough") || event.affectsConfiguration("nexus.terminal.passthroughKeys")) {
      updatePassthroughContext();
    }
    if (event.affectsConfiguration("nexus.terminal.highlighting")) {
      highlighter.reload();
    }
    if (event.affectsConfiguration("nexus.ui.showTreeDescriptions")) {
      nexusTreeProvider.refresh();
    }
    if (event.affectsConfiguration("nexus.sftp.cacheTtlSeconds") || event.affectsConfiguration("nexus.sftp.maxCacheEntries")) {
      const cfg = vscode.workspace.getConfiguration("nexus.sftp");
      sftpService.updateCacheConfig({
        cacheTtlMs: cfg.get<number>("cacheTtlSeconds", 10) * 1000,
        maxCacheEntries: cfg.get<number>("maxCacheEntries", 500),
      });
    }
    if (event.affectsConfiguration("nexus.sftp.autoRefreshInterval")) {
      const interval = vscode.workspace.getConfiguration("nexus.sftp").get<number>("autoRefreshInterval", 10);
      fileExplorerProvider.setAutoRefreshInterval(interval);
    }
  });

  const serverDisposables = registerServerCommands(ctx);
  const tunnelDisposables = registerTunnelCommands(ctx);
  const serialDisposables = registerSerialCommands(ctx);
  const profileDisposables = registerProfileCommands(ctx);
  const settingsDisposables = registerSettingsCommands(() => ctx.sessionLogDir);
  const authProfileDisposables = registerAuthProfileCommands(ctx);
  const configDisposables = registerConfigCommands(core, secretVault);
  const macroDisposables = registerMacroCommands();
  const disableTriggerCmd = vscode.commands.registerCommand("nexus.macro.disableTrigger", (item?: MacroTreeItem) => {
    if (item?.macro.triggerPattern) {
      macroAutoTrigger.setDisabled(item.index, true);
      macroTreeProvider.refresh();
    }
  });
  const enableTriggerCmd = vscode.commands.registerCommand("nexus.macro.enableTrigger", (item?: MacroTreeItem) => {
    if (item?.macro.triggerPattern) {
      macroAutoTrigger.setDisabled(item.index, false);
      macroTreeProvider.refresh();
    }
  });
  const fileDisposables = registerFileCommands(ctx);

  const appearanceCommand = vscode.commands.registerCommand("nexus.terminal.appearance", () => {
    TerminalAppearancePanel.open(colorSchemeService);
  });

  context.subscriptions.push(
    commandCenterView,
    collapseListener,
    expandListener,
    tunnelView,
    settingsView,
    settingsTreeProvider,
    macroView,
    fileExplorerView,
    fsRegistration,
    statusBarItem,
    refreshCommand,
    filterCommand,
    filterClearCommand,
    appearanceCommand,
    windowFocusListener,
    configChangeListener,
    ...serverDisposables,
    ...tunnelDisposables,
    ...serialDisposables,
    ...profileDisposables,
    ...settingsDisposables,
    ...authProfileDisposables,
    ...configDisposables,
    ...macroDisposables,
    disableTriggerCmd,
    enableTriggerCmd,
    ...fileDisposables,
    {
      dispose: () => {
        void collapsedFolderStatePersistence.flush();
        collapsedFolderStatePersistence.dispose();
      }
    },
    {
      dispose: () => {
        unsubscribeCore();
        unsubscribeTunnel();
        for (const [, entry] of serialTerminals.entries()) {
          entry.terminal.dispose();
        }
        serialTerminals.clear();
        serialSidecar.dispose();
        fileExplorerProvider.dispose();
        sftpService.dispose();
        void tunnelManager.stopAll();
        registrySync.dispose();
        void registrySync.cleanupOwnEntries();
        viewSync.dispose();
        pool.dispose();
      }
    }
  );
}

export async function deactivate(): Promise<void> {
  // Cleanup is handled via context.subscriptions disposables
}
