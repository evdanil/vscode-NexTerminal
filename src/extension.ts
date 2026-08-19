import * as path from "node:path";
import * as vscode from "vscode";
import { registerFileCommands } from "./commands/fileCommands";
import { registerCwdSyncCommands, FOLLOW_TERMINAL_STATE_KEY } from "./commands/cwdSyncCommands";
import { registerScriptCommands } from "./commands/scriptCommands";
import { registerSerialCommands } from "./commands/serialCommands";
import { registerLocalShellCommands } from "./commands/localShellCommands";
import { registerLocalServerCommands } from "./commands/localServerCommands";
import { registerNetworkServerCommands } from "./commands/networkServerCommands";
import { registerNetworkServerProfileCommands } from "./commands/networkServerProfileCommands";
import { registerNetworkServerTransferCommands } from "./commands/networkServerTransferCommands";
import { registerServerCommands, teardownServerRuntime } from "./commands/serverCommands";
import { registerServerMacroCommands } from "./commands/serverMacroCommands";
import { registerBmcCommands } from "./commands/bmcCommands";
import { registerTunnelCommands } from "./commands/tunnelCommands";
import { configMutationLock } from "./services/configMutationLock";
import { ScriptRuntimeManager } from "./services/scripts/scriptRuntimeManager";
import { TerminalRegistry } from "./services/terminal/terminalRegistry";
import { CwdTracker } from "./services/terminal/cwdTracker";
import { CwdSyncCoordinator } from "./services/sftp/cwdSyncCoordinator";
import type { CwdSyncState } from "./services/sftp/cwdSyncCoordinator";
import { detectOrphanNexusTerminals } from "./services/terminal/orphanDetect";
import { migrateHighlightRulesGlobalSetting } from "./services/terminal/highlightRuleMigration";
import { wireViewVisibility } from "./services/terminal/viewVisibilityWiring";
import { startInventoryStatusPoll } from "./services/inventory/inventoryStatusPoll";
import { InventoryStatusDecorationProvider } from "./ui/inventoryStatusDecorationProvider";
import { registerTerminalTabCommands } from "./commands/terminalTabCommands";
import type { CommandContext, LocalShellTerminalMap, LocalServerTerminalMap, SerialTerminalMap, ServerTerminalMap, SessionTerminalMap } from "./commands/types";
import { LocalServerManager, wireLocalServerTerminalCloseListener } from "./services/local/localServerManager";
import { NetworkServerManager } from "./services/networkServers/networkServerManager";
import { NexusCore } from "./core/nexusCore";
import { TerminalLoggerFactory, type LoggerRotationOptions } from "./logging/terminalLogger";
import { flushSessionTranscripts } from "./logging/sessionTranscriptLogger";
import { SerialSidecarManager } from "./services/serial/serialSidecarManager";
import { NexusFileSystemProvider, NEXTERM_SCHEME } from "./services/sftp/nexusFileSystemProvider";
import { registerEditAsRootHint } from "./services/sftp/editAsRootHint";
import { SftpService } from "./services/sftp/sftpService";
import { SudoElevationBroker } from "./services/sftp/sudoElevationBroker";
import { SilentAuthSshFactory, proxyPasswordSecretKey } from "./services/ssh/silentAuth";
import { ProxySshFactory } from "./services/ssh/proxySshFactory";
import { SshConnectionPool } from "./services/ssh/sshConnectionPool";
import { pooledConnectionParamsChanged } from "./services/ssh/pooledConnectionParams";
import { Ssh2Connector } from "./services/ssh/ssh2Connector";
import { VscodeHostKeyVerifier } from "./services/ssh/vscodeHostKeyVerifier";
import { VscodePasswordPrompt } from "./services/ssh/vscodePasswordPrompt";
import { VscodeSecretVault } from "./services/ssh/vscodeSecretVault";
import { MacroAutoTrigger } from "./services/macroAutoTrigger";
import { TerminalHighlighter } from "./services/terminalHighlighter";
import { VscodeMacroStore } from "./storage/vscodeMacroStore";
import { setActiveMacroStore } from "./macroSettings";
import { TunnelManager } from "./services/tunnel/tunnelManager";
import { VscodeConfigRepository } from "./storage/vscodeConfigRepository";
import { VscodeTunnelRegistryStore } from "./storage/vscodeTunnelRegistryStore";
import { TunnelRegistrySync } from "./services/tunnel/tunnelRegistrySync";
import { FileExplorerTreeProvider } from "./ui/fileExplorerTreeProvider";
import { createCollapsedFolderStatePersistence } from "./ui/collapsedFolderStatePersistence";
import { FolderTreeItem, NexusTreeProvider } from "./ui/nexusTreeProvider";
import { ScriptCodeLensProvider } from "./ui/scriptCodeLensProvider";
import { ScriptTreeProvider } from "./ui/scriptTreeProvider";
import { SettingsTreeProvider } from "./ui/settingsTreeProvider";
import { NetworkServerTreeProvider } from "./ui/networkServerTreeProvider";
import { TunnelTreeProvider, formatTunnelRoute } from "./ui/tunnelTreeProvider";
import { clamp } from "./utils/helpers";
import { readBoundedNumber } from "./utils/boundedConfig";
import { createCoalescedInvoker } from "./utils/coalescedInvoker";
import {
  applyActiveEditorChange,
  applyActiveTerminalChange,
  clearTrackedSessionActivity,
  focusSessionTerminal,
  type TerminalFocusChangeOptions
} from "./utils/sessionTerminalFocus";
import { resolveScriptSessionForTerminal, resolveSessionForTerminal } from "./utils/terminalSessionLookup";
import { registerSettingsCommands } from "./commands/settingsCommands";
import { SettingsPanel } from "./ui/settingsPanel";
import { registerConfigCommands } from "./commands/configCommands";
import { registerMacroCommands, updateMacroContext } from "./commands/macroCommands";
import { registerProfileCommands } from "./commands/profileCommands";
import { registerAuthProfileCommands } from "./commands/authProfileCommands";
import { registerDeviceTemplateCommands } from "./commands/deviceTemplateCommands";
import { registerSavedFilterCommands } from "./commands/savedFilterCommands";
import { registerInventoryCommands, type InventoryRuntimeTeardown } from "./commands/inventoryCommands";
import { InventoryProviderRegistry } from "./services/inventory/providerRegistry";
import { createNetboxProvider } from "./services/inventory/providers/netboxProvider";
import { createEveNgProvider } from "./services/inventory/providers/eveNgProvider";
import { createNexusExtensionApi, type NexusExtensionApi } from "./services/inventory/publicApi";
import { resolveTunnelConnectionMode, startTunnel } from "./commands/tunnelCommands";
import { MacroTreeItem, MacroTreeProvider } from "./ui/macroTreeProvider";
import { buildMacroProfileInputsFromSnapshot } from "./ui/macroProfileOptions";
import { VscodeColorSchemeStorage } from "./storage/vscodeColorSchemeStorage";
import { ColorSchemeService } from "./services/colorSchemeService";
import { TerminalAppearancePanel } from "./ui/terminalAppearancePanel";
import { tryRegisterResourceLabelFormatter } from "./services/sftp/resourceLabelFormatter";
import type { SftpServiceConfig } from "./services/sftp/sftpService";
import type { SshConnectionOptions } from "./services/ssh/ssh2Connector";
import { resolveScriptMaxRuntimeMs } from "./services/scripts/maxRuntime";
import { ALL_PASSTHROUGH_KEYS, sanitizePassthroughKeys } from "./services/terminal/passthroughKeys";
import { planSkipShellRepair } from "./services/terminal/skipShellRepair";
import { detectMacroKeybindingBlockers, SKIP_SHELL_BLOCKER } from "./services/terminal/macroKeybindingBlockers";
import { getMacros } from "./macroSettings";
import { SettingsGuardController, targetToScope } from "./services/terminal/settingsGuardController";
import { recordNexusConfigWrite } from "./services/terminal/settingsWriteRegistry";
import { createNexusUriHandler } from "./uri/nexusUriHandler";

const MACRO_SKIP_SHELL_COMMANDS = ["nexus.macro.run", "nexus.macro.runBinding"];
/** Set during activate(); lets repairMacroKeybindings mark its writes as Nexus-own. */
let activeSettingsGuard: SettingsGuardController | undefined;
const COLLAPSED_FOLDERS_KEY = "nexus.ui.collapsedFolders";
// §4.10 — a SEPARATE key from the Hub's, so macro-folder collapse state never
// collides with the Connectivity Hub's folder-of-the-same-name collapse state.
const MACRO_COLLAPSED_FOLDERS_KEY = "nexus.macros.ui.collapsedFolders";

function readTerminalOutputTrace(): boolean {
  return vscode.workspace.getConfiguration("nexus.logging").get<boolean>("terminalOutputTrace", false);
}

/**
 * Cached value of `nexus.logging.terminalOutputTrace`, refreshed by the
 * configuration listener in `activate()`.
 *
 * It is read once per received chunk, on the terminal's hot path — far too
 * often to go through `getConfiguration()` each time, which is the whole point
 * of the setting. Caching also means the flag reads as a single property load
 * in the overwhelmingly common case where the trace is off.
 */
let terminalOutputTraceEnabled = false;

function resolveLogRotationOptions(): LoggerRotationOptions {
  const loggingConfig = vscode.workspace.getConfiguration("nexus.logging");
  const maxFileSizeMb = clamp(Math.floor(loggingConfig.get<number>("maxFileSizeMb", 10)), 1, 1024);
  const maxRotatedFiles = clamp(Math.floor(loggingConfig.get<number>("maxRotatedFiles", 1)), 0, 99);
  return {
    maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
    maxRotatedFiles
  };
}

/**
 * Repair VS Code settings so macro shortcuts reach the extension.
 * Three settings are patched:
 *  1. terminal.integrated.commandsToSkipShell — our commands must be in the list;
 *     orphaned `nexus.macro.slot` entries (from v2.3.1–v2.8.27) are also removed here.
 *     NOTE: `nexus.macro.slot` remains a registered back-compat command alias — only
 *     its skip-shell registration is cleaned up, the command itself stays active.
 *  2. terminal.integrated.sendKeybindingsToShell — must be false so the shell doesn't swallow shortcuts
 *  3. window.enableMenuBarMnemonics — must be false so Alt+letter shortcuts don't open menus (Linux/Windows)
 *
 * All config.update() calls are awaited sequentially to avoid races.
 */
async function repairMacroKeybindings(): Promise<void> {
  // --- 1. commandsToSkipShell ---
  const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
  const inspect = termConfig.inspect<string[]>("commandsToSkipShell");
  const effective = termConfig.get<string[]>("commandsToSkipShell", []);

  // planSkipShellRepair handles: dropping nexus.macro.slot orphans, appending missing
  // commands, and the global-fallback write when no user-level override exists.
  const levels: Array<{ value: string[] | undefined; target: vscode.ConfigurationTarget }> = [
    { value: inspect?.globalValue, target: vscode.ConfigurationTarget.Global },
    { value: inspect?.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
    { value: inspect?.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
  ];

  const writes = planSkipShellRepair(levels, effective, MACRO_SKIP_SHELL_COMMANDS);
  for (const { target, value } of writes) {
    // "global-fallback" maps to ConfigurationTarget.Global (same write; different label for clarity)
    const configTarget = target === "global-fallback"
      ? vscode.ConfigurationTarget.Global
      : target;
    activeSettingsGuard?.recordOwnWrite(targetToScope(configTarget), value);
    await termConfig.update("commandsToSkipShell", value, configTarget);
  }

  // --- 2. sendKeybindingsToShell ---
  // When true the terminal shell receives matched keybindings before VS Code, swallowing macro shortcuts.
  const sendInspect = termConfig.inspect<boolean>("sendKeybindingsToShell");
  if (sendInspect?.globalValue === true) {
    recordNexusConfigWrite("terminal.integrated.sendKeybindingsToShell", false, Date.now());
    await termConfig.update("sendKeybindingsToShell", false, vscode.ConfigurationTarget.Global);
  } else if (sendInspect?.globalValue === undefined && termConfig.get<boolean>("sendKeybindingsToShell") === true) {
    recordNexusConfigWrite("terminal.integrated.sendKeybindingsToShell", false, Date.now());
    await termConfig.update("sendKeybindingsToShell", false, vscode.ConfigurationTarget.Global);
  }

  // --- 3. enableMenuBarMnemonics ---
  // When true (default on Linux/Windows) Alt+letter opens the menu bar, e.g. Alt+S → Selection menu.
  const winConfig = vscode.workspace.getConfiguration("window");
  const mnemonicInspect = winConfig.inspect<boolean>("enableMenuBarMnemonics");
  if (mnemonicInspect?.globalValue === true) {
    recordNexusConfigWrite("window.enableMenuBarMnemonics", false, Date.now());
    await winConfig.update("enableMenuBarMnemonics", false, vscode.ConfigurationTarget.Global);
  } else if (mnemonicInspect?.globalValue === undefined && winConfig.get<boolean>("enableMenuBarMnemonics") === true) {
    recordNexusConfigWrite("window.enableMenuBarMnemonics", false, Date.now());
    await winConfig.update("enableMenuBarMnemonics", false, vscode.ConfigurationTarget.Global);
  }
}

async function confirmAndRepairMacroKeybindings(): Promise<void> {
  const picked = await vscode.window.showWarningMessage(
    "Update global VS Code terminal/menu settings so Nexus macro keybindings reach the extension?",
    { modal: true },
    "Fix Keybindings"
  );
  if (picked !== "Fix Keybindings") return;
  await repairMacroKeybindings();
  void vscode.window.showInformationMessage("Nexus macro keybinding settings were updated.");
}

/** globalState key: user clicked "Don't Show Again" on the proactive blocker hint. */
const MACRO_BLOCKER_HINT_DISMISSED_KEY = "nexus.macros.keybindingBlockerHintDismissed";
/** Once-per-session cap: set when the proactive hint toast is shown. */
let macroBlockerHintShownThisSession = false;

/**
 * Read-only check for VS Code settings that swallow Nexus macro shortcuts. If any
 * are found, surface a non-modal, dismissible hint pointing at the existing repair.
 * This NEVER writes settings — the only write path remains the explicit repair
 * command, triggered by the user clicking "Fix Keybindings".
 *
 * Suppressed when: there are no macros (no shortcuts to care about); the user
 * previously chose "Don't Show Again"; or the hint already fired this session.
 * The dismissed flag only gates this proactive toast — it never blocks the
 * explicit `nexus.settings.fixMacroKeybindings` command.
 */
async function maybeWarnMacroKeybindingsBlocked(context: vscode.ExtensionContext): Promise<void> {
  if (macroBlockerHintShownThisSession) return;
  if (getMacros().length === 0) return;
  if (context.globalState.get<boolean>(MACRO_BLOCKER_HINT_DISMISSED_KEY, false)) return;

  const termConfig = vscode.workspace.getConfiguration("terminal.integrated");
  const winConfig = vscode.workspace.getConfiguration("window");
  const blockers = detectMacroKeybindingBlockers({
    sendKeybindingsToShell: termConfig.get("sendKeybindingsToShell"),
    commandsToSkipShell: termConfig.get("commandsToSkipShell"),
    enableMenuBarMnemonics: winConfig.get("enableMenuBarMnemonics"),
    requiredCommands: MACRO_SKIP_SHELL_COMMANDS
  });
  // The Settings Guard auto-repairs commandsToSkipShell when enabled, so warning
  // about that specific blocker here is redundant — drop it unless the guard is off.
  // The two boolean blockers (sendKeybindingsToShell, enableMenuBarMnemonics) are
  // NOT auto-fixed by the guard, so they are always kept.
  const guardEnabled = vscode.workspace
    .getConfiguration("nexus.settingsGuard")
    .get<boolean>("enabled", true);
  const shownBlockers = guardEnabled
    ? blockers.filter((b) => b !== SKIP_SHELL_BLOCKER)
    : blockers;
  if (shownBlockers.length === 0) return;

  macroBlockerHintShownThisSession = true;
  const choice = await vscode.window.showWarningMessage(
    `Nexus macro shortcuts are blocked by VS Code settings: ${shownBlockers[0]}. Fix now?`,
    "Fix Keybindings",
    "Don't Show Again"
  );
  if (choice === "Fix Keybindings") {
    // The toast click IS the consent — go straight to the repair, no second modal.
    await repairMacroKeybindings();
    void vscode.window.showInformationMessage("Nexus macro keybinding settings were updated.");
  } else if (choice === "Don't Show Again") {
    void context.globalState.update(MACRO_BLOCKER_HINT_DISMISSED_KEY, true);
  }
}

/** Track which passthrough context keys are currently set to true, so we only update the delta. */
const activePassthroughKeys = new Set<string>();

function updatePassthroughContext(): void {
  const config = vscode.workspace.getConfiguration("nexus.terminal");
  const masterEnabled = config.get<boolean>("keyboardPassthrough", true);
  // sanitizePassthroughKeys handles corrupt/empty/non-array values gracefully by
  // falling back to the full default set — no automatic settings.json writes needed.
  const selectedKeys = sanitizePassthroughKeys(config.get("passthroughKeys"));
  const activeSet = masterEnabled ? new Set(selectedKeys) : new Set<string>();

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

function readBoundedMs(section: string, key: string, fallbackSeconds: number, minSeconds: number, maxSeconds: number): number {
  return readBoundedNumber(section, key, fallbackSeconds, minSeconds, maxSeconds) * 1000;
}

function readSshConnectionOptions(): SshConnectionOptions {
  return {
    readyTimeoutMs: readBoundedMs("nexus.ssh", "connectionTimeout", 60, 5, 300),
    keepaliveIntervalMs: readBoundedMs("nexus.ssh", "keepaliveInterval", 10, 0, 300),
    keepaliveCountMax: Math.floor(readBoundedNumber("nexus.ssh", "keepaliveCountMax", 3, 1, 30))
  };
}

function readSftpServiceConfig(): SftpServiceConfig {
  return {
    cacheTtlMs: readBoundedMs("nexus.sftp", "cacheTtlSeconds", 10, 0, 300),
    maxCacheEntries: Math.floor(readBoundedNumber("nexus.sftp", "maxCacheEntries", 500, 10, 5000)),
    commandTimeoutMs: readBoundedMs("nexus.sftp", "commandTimeout", 300, 10, 3600),
    operationTimeoutMs: readBoundedMs("nexus.sftp", "operationTimeout", 30, 5, 300),
    maxDeleteDepth: Math.floor(readBoundedNumber("nexus.sftp", "deleteDepthLimit", 100, 10, 500)),
    maxDeleteOps: Math.floor(readBoundedNumber("nexus.sftp", "deleteOperationLimit", 10000, 100, 100000)),
    // Same dial as the editor-open limit: both are "how many bytes of one file
    // Nexus will hold in the extension host's heap".
    maxInMemoryTransferBytes:
      Math.floor(readBoundedNumber("nexus.sftp", "maxOpenFileSizeMB", 5, 1, 200)) * 1024 * 1024,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<NexusExtensionApi> {
  // Detect tabs left behind by a previous extension host (window reload, update,
  // disable-then-enable). The old host's PTY link to each tab is already dead;
  // `writeEmitter` events from deactivate lose the IPC flush race
  // (microsoft/vscode#122825, #140697), so the tab is a frozen husk. We do NOT
  // close these tabs — the last-rendered content is often worth reviewing — but
  // we do surface a one-time notification so the user knows the tabs will not
  // respond to input and can close them at their leisure.
  const orphans = detectOrphanNexusTerminals(vscode.window.terminals);
  if (orphans.count > 0) {
    const message =
      orphans.count === 1
        ? "Nexus: 1 session disconnected after an extension reload or restart. The tab is frozen on its last output — close it manually when you are done reviewing. Reconnect from the Connectivity Hub when ready."
        : `Nexus: ${orphans.count} sessions disconnected after an extension reload or restart. The tabs are frozen on their last output — close them manually when you are done reviewing. Reconnect from the Connectivity Hub when ready.`;
    void vscode.window.showInformationMessage(message);
  }

  // Heal a stale user snapshot of nexus.terminal.highlighting.rules in global
  // settings (label-less rules from before v2.8.182, the truncating IPv6
  // pattern from before v2.8.187). Fire-and-forget and non-fatal: the read-time
  // upgrade in TerminalHighlighter/HighlightRuleEditorPanel already makes
  // behaviour correct, so this only tidies settings.json and future exports and
  // must never delay or break activation.
  void migrateHighlightRulesGlobalSetting();

  const repository = new VscodeConfigRepository(context);
  const core = new NexusCore(repository);
  await core.initialize();

  terminalOutputTraceEnabled = readTerminalOutputTrace();
  const loggerFactory = new TerminalLoggerFactory(
    path.join(context.globalStorageUri.fsPath, "logs"),
    resolveLogRotationOptions,
    () => terminalOutputTraceEnabled
  );
  const secretVault = new VscodeSecretVault(context);

  // B4 — the built-in providers are registered up front so they're available
  // to registerInventoryCommands (below) and to any third party registering
  // through the public API returned from this function. Registration ORDER is
  // the order the add-source provider picker lists them in.
  const inventoryProviderRegistry = new InventoryProviderRegistry();
  inventoryProviderRegistry.register(createNetboxProvider());
  inventoryProviderRegistry.register(createEveNgProvider());

  const macroStore = new VscodeMacroStore(context);
  await macroStore.initialize();
  setActiveMacroStore(macroStore);
  context.subscriptions.push({ dispose: () => setActiveMacroStore(undefined) });

  // One-time non-modal toast after the first legacy absorption (Settings Sync replay, etc.)
  const absorbedCount = macroStore.getLastAbsorbedCount();
  const noticeShown = context.globalState.get<boolean>("nexus.macros.migrationNoticeShown", false);
  if (absorbedCount > 0 && !noticeShown) {
    void vscode.window.showInformationMessage(
      `Nexus moved ${absorbedCount} macro${absorbedCount === 1 ? "" : "s"} to secure storage. Any remaining nexus.terminal.macros blocks in your synced or shared settings.json can be deleted — they will be absorbed automatically on next launch.`,
      "Dismiss",
      "Don't show again"
    ).then((choice) => {
      if (choice === "Don't show again") {
        void context.globalState.update("nexus.macros.migrationNoticeShown", true);
      }
    });
  }

  // Started before the macro-blocker hint as a best-effort head start. The hint
  // reads config synchronously, so on overnight damage both notifications can
  // still appear once: the stale hint plus the guard's restore toast.
  const settingsGuard = new SettingsGuardController(
    context,
    MACRO_SKIP_SHELL_COMMANDS,
    () => getMacros().length > 0
  );
  activeSettingsGuard = settingsGuard;
  settingsGuard.start();
  const settingsGuardReportCommand = vscode.commands.registerCommand(
    "nexus.settingsGuard.showReport",
    () => settingsGuard.showReport()
  );

  // Read-only hint: if macro shortcuts are blocked by VS Code settings, point the
  // user at the repair. Runs after the macro store is initialized so getMacros()
  // is populated. Does not block activation.
  void maybeWarnMacroKeybindingsBlocked(context);

  // Post-ready SSH client errors, connection closes, SFTP channel faults, UNC
  // blocks and per-transfer byte counts all land here. Always on and free — an
  // output channel is inert until someone opens it — because the failure modes
  // this fixes (a keepalive timeout dropping every tab, a transfer that moved
  // zero bytes) were previously undiagnosable from the field. Follows the
  // per-feature channel naming used by "Nexus Scripts" / "Nexus Local Shell" /
  // "Nexus Directory Sync".
  const sshDiagnosticsChannel = vscode.window.createOutputChannel("Nexus SSH");
  context.subscriptions.push(sshDiagnosticsChannel);
  const sshDiagnostics = (line: string): void => {
    sshDiagnosticsChannel.appendLine(`${new Date().toISOString()} ${line}`);
  };

  const hostKeyVerifier = new VscodeHostKeyVerifier(context.globalState);
  const sshConnector = new Ssh2Connector(hostKeyVerifier, readSshConnectionOptions(), sshDiagnostics);
  const sshFactory = new SilentAuthSshFactory(
    sshConnector,
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
      ),
    (id) => core.getAuthProfile(id)
  );
  const proxiedFactory = new ProxySshFactory(
    sshFactory,
    (id) => core.getServer(id),
    secretVault,
    readBoundedMs("nexus.ssh", "proxyTimeout", 60, 5, 300),
    // Per-connect proxy-password prompt (design doc §5.3; §11 OQ2) — realizes the
    // prompt §5.3 assumed for a template's authenticated socks5/http proxy, which
    // carries no secret. Fired by ProxySshFactory only for a username-bearing proxy
    // with no stored `proxy-password-{id}`. Masked, never logged (matching the
    // VscodePasswordPrompt discipline); on entry it stores the secret per-server so
    // it is one-time (the per-server vault entry IS the §5.3 model), and returns
    // undefined on cancel (ProxySshFactory then falls back to the prior behavior).
    async (server, proxy) => {
      const label = proxy.type === "socks5" ? "SOCKS5" : "HTTP";
      const endpoint = proxy.username
        ? `${proxy.username}@${proxy.host}:${proxy.port}`
        : `${proxy.host}:${proxy.port}`;
      const password = await vscode.window.showInputBox({
        title: `Nexus ${label} Proxy Password`,
        prompt: `Enter password for ${label} proxy ${endpoint}`,
        password: true,
        ignoreFocusOut: true
      });
      if (password === undefined) {
        return undefined;
      }
      return { password, save: true };
    }
  );
  const multiplexingConfig = vscode.workspace.getConfiguration("nexus.ssh.multiplexing");
  const pool = new SshConnectionPool(proxiedFactory, {
    enabled: multiplexingConfig.get<boolean>("enabled", true),
    idleTimeoutMs: readBoundedMs("nexus.ssh.multiplexing", "idleTimeout", 300, 0, 3600)
  });
  proxiedFactory.setJumpHostConnectionFactory(pool);
  const tunnelManager = new TunnelManager(
    pool,
    sshFactory,
    readBoundedMs("nexus.tunnel", "socks5HandshakeTimeout", 10, 2, 60)
  );
  const extensionRoot = path.resolve(__dirname, "..");
  const sidecarPath = path.join(__dirname, "services", "serial", "serialSidecarWorker.js");
  const serialSidecar = new SerialSidecarManager(
    sidecarPath,
    extensionRoot,
    readBoundedMs("nexus.serial", "rpcTimeout", 10, 2, 60)
  );
  const registryStore = new VscodeTunnelRegistryStore(context);
  const registrySync = new TunnelRegistrySync(registryStore, core, vscode.env.sessionId);
  await registrySync.initialize();

  const terminalsByServer: ServerTerminalMap = new Map();
  const sessionTerminals: SessionTerminalMap = new Map();
  const serialTerminals: SerialTerminalMap = new Map();
  const localShellTerminals: LocalShellTerminalMap = new Map();
  const localServerTerminals: LocalServerTerminalMap = new Map();

  const highlighter = new TerminalHighlighter();
  const macroAutoTrigger = new MacroAutoTrigger();

  const scriptOutputChannel = vscode.window.createOutputChannel("Nexus Scripts");
  const localShellOutputChannel = vscode.window.createOutputChannel("Nexus Local Shell");
  const scriptRuntimeManager = new ScriptRuntimeManager({
    core,
    macroAutoTrigger,
    outputChannel: scriptOutputChannel,
    workerPath: path.join(context.extensionPath, "dist", "services", "scripts", "scriptWorker.js"),
    assetsDir: vscode.Uri.file(path.join(context.extensionPath, "dist", "services", "scripts", "assets")),
    globalStoragePath: context.globalStorageUri.fsPath
  });
  // Reverse-lookup: given a VS Code Terminal, find the Nexus session id that owns it.
  const resolveTrackedSessionForTerminal = (terminal: vscode.Terminal | undefined): string | undefined =>
    resolveSessionForTerminal(terminal, sessionTerminals, serialTerminals, localShellTerminals, localServerTerminals);
  const resolveScriptCapableSessionForTerminal = (terminal: vscode.Terminal | undefined): string | undefined =>
    resolveScriptSessionForTerminal(terminal, sessionTerminals, serialTerminals, localShellTerminals, localServerTerminals);
  const globalStoragePath = context.globalStorageUri.fsPath;
  SettingsPanel.setGlobalStoragePath(globalStoragePath);
  const scriptTreeProvider = new ScriptTreeProvider(scriptRuntimeManager, globalStoragePath);
  const scriptCommandDisposables = registerScriptCommands(
    scriptRuntimeManager,
    scriptOutputChannel,
    globalStoragePath,
    resolveScriptCapableSessionForTerminal,
    () => scriptTreeProvider.refresh()
  );
  const scriptCodeLensProvider = new ScriptCodeLensProvider(scriptRuntimeManager);
  // §5.5 — now hierarchical (folders can nest scripts many levels deep), same
  // as the other tree-shaped sidebars (Hub, Tunnels, Macros, File Explorer).
  const scriptsView = vscode.window.createTreeView("nexusScripts", {
    treeDataProvider: scriptTreeProvider,
    showCollapseAll: true,
    // §5.9 — drag a script onto a folder to move it there.
    //
    // `canSelectMany` is deliberately NOT set. It would let a drag carry several
    // scripts, but it also changes what every EXISTING script context command
    // receives: VS Code starts passing the whole selection, and Run / Stop /
    // Delete / Edit all act on the first row only. Silently deleting one of
    // three selected scripts is a worse bug than the one this fixes. The
    // provider's drag handler already takes an array, so enabling it later is a
    // one-line change once those commands handle a multi-selection.
    dragAndDropController: scriptTreeProvider
  });
  // F11 — register CodeLens for file://, vscode-remote://, and untitled:// so the
  // ▶ Run / ◼ Stop lens surfaces for scripts opened over Remote-SSH or as untitled drafts.
  const scriptCodeLensRegistration = vscode.languages.registerCodeLensProvider(
    [
      { language: "javascript", scheme: "file" },
      { language: "javascript", scheme: "vscode-remote" },
      { language: "javascript", scheme: "untitled" }
    ],
    scriptCodeLensProvider
  );

  // Script runtime status bar item — separate from the existing Nexus Connectivity Hub item.
  const scriptStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
  scriptStatusBarItem.command = "nexus.script.openOutput";
  scriptStatusBarItem.name = "Nexus Scripts";
  // F4 — persistent input-lock indicator. Placed slightly to the right of the run indicator.
  const scriptLockStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
  scriptLockStatusBarItem.name = "Nexus Scripts — Input Lock";
  let scriptStatusBarTick: ReturnType<typeof setInterval> | undefined;
  // P1 — expose nexusHasRunningScripts context key so keybindings (ctrl+alt+s) can gate on it.
  let hadRunningScripts = false;
  const renderScriptStatusBar = (): void => {
    const runs = scriptRuntimeManager.getRuns();
    // --- Run indicator ---
    if (runs.length === 0) {
      scriptStatusBarItem.hide();
      scriptLockStatusBarItem.hide();
      if (scriptStatusBarTick) {
        clearInterval(scriptStatusBarTick);
        scriptStatusBarTick = undefined;
      }
      if (hadRunningScripts) {
        hadRunningScripts = false;
        void vscode.commands.executeCommand("setContext", "nexusHasRunningScripts", false);
      }
      return;
    }
    if (!hadRunningScripts) {
      hadRunningScripts = true;
      void vscode.commands.executeCommand("setContext", "nexusHasRunningScripts", true);
    }
    if (runs.length > 1) {
      scriptStatusBarItem.text = `$(sync~spin) ${runs.length} scripts running`;
    } else {
      const r = runs[0];
      const op = r.currentOperation;
      const elapsed = op ? Math.max(0, Math.floor((Date.now() - op.startedAt) / 1000)) : 0;
      scriptStatusBarItem.text = op
        ? `$(sync~spin) ${r.scriptName} — ${op.label} (${elapsed}s)`
        : `$(sync~spin) ${r.scriptName}`;
    }
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = true;
    for (const r of runs) {
      const stopArg = encodeURIComponent(JSON.stringify([r.sessionId]));
      tooltip.appendMarkdown(
        `**${r.scriptName}** on ${r.sessionName} — [◼ Stop](command:nexus.script.stop?${stopArg})\n\n`
      );
    }
    scriptStatusBarItem.tooltip = tooltip;
    scriptStatusBarItem.show();
    if (!scriptStatusBarTick) {
      scriptStatusBarTick = setInterval(renderScriptStatusBar, 1_000);
    }

    // --- F4: persistent input-lock indicator ---
    const lockedRuns = runs.filter((r) => r.inputLockHeld);
    if (lockedRuns.length === 0) {
      scriptLockStatusBarItem.hide();
    } else if (lockedRuns.length === 1) {
      const r = lockedRuns[0];
      scriptLockStatusBarItem.text = "$(lock) Terminal locked — click to stop";
      scriptLockStatusBarItem.tooltip = `Input is locked by "${r.scriptName}" on ${r.sessionName}. Click to stop.`;
      scriptLockStatusBarItem.command = {
        title: "Stop Nexus Script",
        command: "nexus.script.stop",
        arguments: [r.sessionId]
      };
      scriptLockStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      scriptLockStatusBarItem.show();
    } else {
      scriptLockStatusBarItem.text = `$(lock) ${lockedRuns.length} terminals locked`;
      scriptLockStatusBarItem.tooltip = "Input is locked by multiple scripts. Click to choose one to stop.";
      // No argument → the command handler will quick-pick when multiple runs exist.
      scriptLockStatusBarItem.command = "nexus.script.stop";
      scriptLockStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      scriptLockStatusBarItem.show();
    }
  };

  // S3 — max-runtime watchdog. One timer per session; cleared on script end.
  const scriptWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const clearScriptWatchdog = (sessionId: string): void => {
    const t = scriptWatchdogs.get(sessionId);
    if (t) {
      clearTimeout(t);
      scriptWatchdogs.delete(sessionId);
    }
  };
  const startScriptWatchdog = (sessionId: string, scriptName: string): void => {
    const scriptsConfig = vscode.workspace.getConfiguration("nexus.scripts");
    const maxMs = resolveScriptMaxRuntimeMs(scriptsConfig);
    if (typeof maxMs !== "number" || maxMs <= 0) return;
    const capped = Math.max(10_000, Math.floor(maxMs));
    clearScriptWatchdog(sessionId);
    const timer = setTimeout(() => {
      scriptWatchdogs.delete(sessionId);
      scriptOutputChannel.appendLine(
        `[watchdog] "${scriptName}" exceeded max runtime of ${capped}ms — stopping.`
      );
      void scriptRuntimeManager.stopScript(sessionId, "max-runtime-exceeded");
    }, capped);
    scriptWatchdogs.set(sessionId, timer);
  };

  const scriptStatusBarListener = scriptRuntimeManager.onDidChangeRun((event) => {
    // S3 watchdog lifecycle + F6 error toasts. F4 lock indicator is driven from the
    // `inputLockHeld` field on each run snapshot (no side cache needed).
    if (event.kind === "started") {
      startScriptWatchdog(event.run.sessionId, event.run.scriptName);
    } else if (event.kind === "ended") {
      clearScriptWatchdog(event.run.sessionId);
      // F6 — toast on failures that *aren't* the documented user-error codes
      // (Timeout / ConnectionLost / Stopped / Cancelled). Those are the error
      // contract scripts ride on; toasting them would be noise.
      if (event.finalState === "failed" && event.failureReason && event.failureReason !== "expected") {
        const scriptName = event.run.scriptName;
        void (async () => {
          const picked = await vscode.window.showErrorMessage(
            `Script ${scriptName} failed. See the Nexus Scripts output for details.`,
            "Show Output"
          );
          if (picked === "Show Output") {
            void vscode.commands.executeCommand("nexus.script.openOutput");
          }
        })();
      }
    }
    renderScriptStatusBar();
  });
  const colorSchemeStorage = new VscodeColorSchemeStorage(context);
  const colorSchemeService = new ColorSchemeService(colorSchemeStorage);
  const sftpService = new SftpService(pool, readSftpServiceConfig(), sshDiagnostics);
  const elevationBroker = new SudoElevationBroker(sftpService, (id) => core.getServer(id));
  const fileSystemProvider = new NexusFileSystemProvider(sftpService, elevationBroker);
  const fsRegistration = vscode.workspace.registerFileSystemProvider(NEXTERM_SCHEME, fileSystemProvider, { isCaseSensitive: true });
  // Password cache and elevated-URI state are per-server and must not survive a
  // disconnect. nexus.files.disconnect (fileCommands.ts) already clears both
  // directly, but this pool listener is the backstop for every OTHER path back to
  // zero refs on a server's pooled SSH connection (an SSH terminal tab closing, an
  // idle timeout) — those never go through the File Explorer's Disconnect command.
  const elevationTeardownListener = pool.onDidChange((event) => {
    if (event.type === "disconnected") {
      elevationBroker.clearCachedPassword(event.serverId);
      fileSystemProvider.clearElevatedForServer(event.serverId);
    }
  });
  const editAsRootHintListener = registerEditAsRootHint(fileSystemProvider);

  // Keep nexterm:// labels in POSIX style on Windows.
  tryRegisterResourceLabelFormatter(vscode.workspace, NEXTERM_SCHEME);
  const fileExplorerProvider = new FileExplorerTreeProvider(sftpService, sshDiagnostics);
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
    localShellTerminals,
    localServerTerminals,
    highlighter,
    macroAutoTrigger,
    sftpService,
    fileExplorerProvider,
    fileSystemProvider,
    elevationBroker,
    secretVault,
    registrySync,
    focusedTerminal: vscode.window.activeTerminal ?? undefined,
    activityIndicators: new Map(),
    scriptRuntimeManager,
    terminalRegistry: undefined,
    localShellOutputChannel,
    globalStoragePath,
    extensionPath: context.extensionPath,
    globalState: context.globalState,
    sshDiagnostics
  };
  const terminalRegistry = new TerminalRegistry(core);
  context.subscriptions.push(terminalRegistry);
  ctx.terminalRegistry = terminalRegistry;

  const localServerManager = new LocalServerManager({
    core,
    extensionPath: context.extensionPath,
    terminals: localServerTerminals,
    terminalRegistry,
    outputChannel: localShellOutputChannel,
    highlighter,
    diagnostics: (line) => localShellOutputChannel.appendLine(`${new Date().toISOString()} [Local Server] ${line}`)
  });
  context.subscriptions.push(localServerManager);

  // The channel is created here rather than inside the manager so the
  // inspectLogs command can reveal the same instance the daemon writes to.
  const networkServerOutputChannel = vscode.window.createOutputChannel("Nexus Network Servers");
  context.subscriptions.push(networkServerOutputChannel);
  const networkServerManager = new NetworkServerManager({
    core,
    extensionPath: context.extensionPath,
    globalStoragePath,
    outputChannel: networkServerOutputChannel
  });
  context.subscriptions.push(networkServerManager);
  ctx.networkServerManager = networkServerManager;
  ctx.networkServerOutputChannel = networkServerOutputChannel;

  // --- Directory sync (issue #35) — CwdTracker + CwdSyncCoordinator wiring ---
  // No existing generic "Nexus" output channel exists to reuse (only the
  // feature-scoped "Nexus Scripts" / "Nexus Local Shell" / "Nexus Settings
  // Guard" channels do) — §7.6 requires somewhere greppable to log
  // suppressions/failures, so a new channel is created here, following the
  // same per-feature naming convention as those three.
  const cwdSyncOutputChannel = vscode.window.createOutputChannel("Nexus Directory Sync");
  // Per-session last-output timestamp, fed by the OSC 7 observer in
  // serverCommands.ts on every chunk; read by CwdSyncDeps.lastOutputAt so
  // CwdTracker.isStale() can use its elapsed-time staleness signal (§7.5)
  // rather than degrading to authority-change-only staleness detection.
  const cwdLastOutputAt = new Map<string, number>();
  const cwdTracker = new CwdTracker();
  const cwdSyncCoordinator = new CwdSyncCoordinator({
    tracker: cwdTracker,
    provider: fileExplorerProvider,
    sftp: sftpService,
    core,
    now: () => Date.now(),
    log: (message) => cwdSyncOutputChannel.appendLine(message),
    lastOutputAt: (sessionId) => cwdLastOutputAt.get(sessionId)
  });
  ctx.cwdTracker = cwdTracker;
  ctx.cwdSyncCoordinator = cwdSyncCoordinator;
  ctx.cwdLastOutputAt = cwdLastOutputAt;
  ctx.cwdSyncOutputChannel = cwdSyncOutputChannel;
  context.subscriptions.push(cwdSyncOutputChannel, cwdSyncCoordinator, cwdTracker);

  // §9 — Phase 1 ships zero settings; the Follow Terminal Directory toggle is
  // per-window UI state in globalState (not settings.json), restored here and
  // persisted by the nexus.files.followTerminal / unfollowTerminal commands.
  cwdSyncCoordinator.setFollowing(context.globalState.get<boolean>(FOLLOW_TERMINAL_STATE_KEY, false));

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
        // #84 P1 (Codex, serialization audit) — a drag-drop group change persists
        // a FULL server snapshot; serialize it under configMutationLock and
        // RE-READ the live record inside the lock, applying ONLY the group so a
        // concurrent background port-heal is never reverted (the same discipline
        // as the rename fix).
        await configMutationLock.runExclusive(async () => {
          const live = core.getServer(itemId);
          if (live) {
            await core.addOrUpdateServer({ ...live, group: newGroup });
          }
        });
      } else if (itemType === "serial") {
        const profile = core.getSerialProfile(itemId);
        if (profile) {
          await core.addOrUpdateSerialProfile({ ...profile, group: newGroup });
        }
      } else if (itemType === "localShell") {
        const profile = core.getLocalShellProfile(itemId);
        if (profile) {
          await core.addOrUpdateLocalShellProfile({ ...profile, group: newGroup });
        }
      } else if (itemType === "localServer") {
        const config = core.getLocalServer(itemId);
        if (config) {
          await core.addOrUpdateLocalServerConfig({ ...config, group: newGroup });
        }
      }
    },
    async onFolderMoved(oldPath, newParentPath) {
      // #84 P1 (serialization audit) — moveFolder rewrites `group` on every server
      // in the subtree and persists a FULL server snapshot; serialize it under
      // configMutationLock (it reads/mutates the live map inside the lock).
      await configMutationLock.runExclusive(() => core.moveFolder(oldPath, newParentPath));
    }
  });
  const tunnelTreeProvider = new TunnelTreeProvider();
  const networkServerTreeProvider = new NetworkServerTreeProvider();
  // Core + registry so the Settings tree can render one row per inventory
  // source (name, provider label, last sync) with inline actions, and refresh
  // them on any core change.
  const settingsTreeProvider = new SettingsTreeProvider(core, inventoryProviderRegistry);
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
  // LIVE STATUS (Phase 2) — the running-lab highlight. Registered globally; it
  // decorates only the nexus-status: resourceUris the Command Center tree stamps
  // on running servers and their lab folders. Fed the latest snapshot in
  // syncViewsImmediate below.
  const inventoryStatusDecoration = new InventoryStatusDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(inventoryStatusDecoration), inventoryStatusDecoration);
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

  const networkServerView = vscode.window.createTreeView("nexusNetworkServers", {
    treeDataProvider: networkServerTreeProvider,
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

  // §8.2 — CwdSyncCoordinator's derived state renders onto the existing
  // TreeView handle: `description` for the persistent state line (all seven
  // states), `message` only for the rateLimited state (the one abnormal
  // condition the user did not cause — it pushes the tree down, so it is
  // reserved for that case). Both are plain property sets — never a tree
  // refresh, so repainting this costs nothing.
  let lastCwdSyncFollowing: boolean | undefined;
  let lastCwdSyncPaused: boolean | undefined;
  const renderCwdSyncViewState = (state: CwdSyncState): void => {
    switch (state.kind) {
      case "off":
        fileExplorerView.description = undefined;
        fileExplorerView.message = undefined;
        break;
      case "following":
        fileExplorerView.description = `Following ${state.terminalName}`;
        fileExplorerView.message = undefined;
        break;
      case "noSource":
        fileExplorerView.description = `Following ${state.terminalName} — shell not reporting a directory`;
        fileExplorerView.message = undefined;
        break;
      case "stale":
        fileExplorerView.description = `Following ${state.terminalName} — stale`;
        fileExplorerView.message = undefined;
        break;
      case "pinned":
        fileExplorerView.description = "Paused — manual navigation";
        fileExplorerView.message = undefined;
        break;
      case "otherServer": {
        const otherServerName = core.getServer(state.otherServerId)?.name ?? state.otherServerId;
        fileExplorerView.description = `Not following — ${state.terminalName} is on ${otherServerName}`;
        fileExplorerView.message = undefined;
        break;
      }
      case "rateLimited":
        fileExplorerView.description = "Following off — too many directory changes";
        fileExplorerView.message =
          `"${state.terminalName}" reported directory changes faster than Nexus can follow, so sync was stopped for this session. Toggle Follow Terminal Directory off and back on to resume.`;
        break;
    }
  };
  // Context keys for the three-way toolbar toggle (§8.1), driven off the same
  // derived state — same setContext + change-guard pattern as
  // TerminalRegistry.refreshContextKeys (only fire setContext when the value
  // actually changes). `followPaused` is derived from state.kind === "pinned"
  // since CwdSyncCoordinator exposes no raw isPaused() getter — getState()
  // already returns "off" whenever no SSH session is focused (regardless of
  // any internal pin), which is the right UX here: there is nothing to
  // "Resume" toward without a focused session.
  const refreshCwdSyncContextKeys = (state: CwdSyncState): void => {
    const following = cwdSyncCoordinator.isFollowing();
    const paused = state.kind === "pinned";
    if (lastCwdSyncFollowing !== following) {
      lastCwdSyncFollowing = following;
      void vscode.commands.executeCommand("setContext", "nexus.files.followingTerminal", following);
    }
    if (lastCwdSyncPaused !== paused) {
      lastCwdSyncPaused = paused;
      void vscode.commands.executeCommand("setContext", "nexus.files.followPaused", paused);
    }
  };
  const renderCwdSyncState = (): void => {
    const state = cwdSyncCoordinator.getState();
    renderCwdSyncViewState(state);
    refreshCwdSyncContextKeys(state);
  };
  const cwdSyncStateListener = cwdSyncCoordinator.onDidChangeState(renderCwdSyncState);
  context.subscriptions.push({ dispose: cwdSyncStateListener });
  renderCwdSyncState();

  const macroTreeProvider = new MacroTreeProvider((macro) => macroAutoTrigger.isDisabled(macro));
  const savedMacroCollapsed = context.globalState.get<string[]>(MACRO_COLLAPSED_FOLDERS_KEY, []);
  macroTreeProvider.loadCollapsedFolders(savedMacroCollapsed);
  // §4.10 — adopts the Hub's hand-rolled collapse persistence with a SEPARATE
  // globalState key: reusing the Hub's `collapsedFolderStatePersistence`/
  // `handleFolderStateChange` would let a macro folder path collapse/expand
  // the Hub's OWN folder of the same name (both are `FolderTreeItem`
  // instances, but each view's collapse state must stay independent).
  const macroCollapsedFolderStatePersistence = createCollapsedFolderStatePersistence(
    (paths) => context.globalState.update(MACRO_COLLAPSED_FOLDERS_KEY, paths),
    {
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to persist macro collapsed folder state: ${message}`);
      }
    }
  );
  const persistMacroCollapsedFolders = (): void => {
    macroCollapsedFolderStatePersistence.schedule(macroTreeProvider.getCollapsedFolders());
  };
  const handleMacroFolderStateChange = (element: unknown, isCollapsed: boolean): void => {
    if (!(element instanceof FolderTreeItem)) {
      return;
    }
    if (isCollapsed) {
      macroTreeProvider.collapseFolder(element.folderPath);
    } else {
      macroTreeProvider.expandFolder(element.folderPath);
    }
    persistMacroCollapsedFolders();
  };
  const macroView = vscode.window.createTreeView("nexusMacros", {
    treeDataProvider: macroTreeProvider,
    dragAndDropController: macroTreeProvider,
    showCollapseAll: true
  });
  const macroCollapseListener = macroView.onDidCollapseElement((e) => {
    handleMacroFolderStateChange(e.element, true);
  });
  const macroExpandListener = macroView.onDidExpandElement((e) => {
    handleMacroFolderStateChange(e.element, false);
  });
  const macroAutoTriggerListener = macroAutoTrigger.onDidChange(() => {
    macroTreeProvider.refresh();
  });
  const macroStoreSubscription = macroStore.onDidChange(() => {
    macroAutoTrigger.reload();
    updateMacroContext();
    macroTreeProvider.refresh();
  });
  context.subscriptions.push({ dispose: macroStoreSubscription });
  // NOTE: nothing on this path may call `saveMacros()` / `MacroStore.save()`. The listener
  // registered just above reaches `MacroAutoTrigger.reload()` synchronously, and `save()`
  // re-keys duplicate macro ids — so an activation-time save would clear a duplicate-id
  // conflict and compile both twins before the user has seen the tree's warning about it.
  // The legacy `slot` migration that used to run here is now a read-time normalization in
  // the store (`withMigratedSlot()`, storage/macroStore.ts).
  updateMacroContext();
  updatePassthroughContext();

  const sftpConfig = vscode.workspace.getConfiguration("nexus.sftp");
  const autoRefreshInterval = readBoundedNumber("nexus.sftp", "autoRefreshInterval", 10, 0, 60);
  fileExplorerProvider.setAutoRefreshInterval(autoRefreshInterval);
  const remoteWatchMode = sftpConfig.get<string>("remoteWatchMode", "auto") === "polling" ? "polling" as const : "auto" as const;
  fileExplorerProvider.setRemoteWatchMode(remoteWatchMode);
  // BLOCKER fix: `createTreeView()` never fires `onDidChangeVisibility` at
  // registration, so without an explicit seed both `fileExplorerProvider`'s
  // polling (`isViewVisible`) and `cwdSyncCoordinator`'s buffering
  // (`visible`) start out believing the view is hidden even in a freshly
  // opened window where it is already showing — the feature would then do
  // nothing until the user manually hid and reopened the File Explorer.
  // `wireViewVisibility` seeds both from `fileExplorerView.visible`
  // immediately, then keeps them updated via the real event.
  context.subscriptions.push(
    wireViewVisibility(fileExplorerView, (visible) => {
      fileExplorerProvider.setViewVisibility(visible);
      cwdSyncCoordinator.setViewVisible(visible);
      if (visible) {
        fileExplorerProvider.refresh();
      }
    })
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = "nexusCommandCenter.focus";
  statusBarItem.show();

  const syncViewsImmediate = (): void => {
    const snapshot = core.getSnapshot();
    nexusTreeProvider.setSnapshot(snapshot);
    tunnelTreeProvider.setSnapshot(snapshot);
    networkServerTreeProvider.setSnapshot(snapshot);
    inventoryStatusDecoration.update(snapshot);
    const totalTunnels = snapshot.activeTunnels.length + snapshot.remoteTunnels.length;
    statusBarItem.text = `$(terminal) Nexus: ${snapshot.activeSessions.length + snapshot.activeLocalShellSessions.length} sessions, ${totalTunnels} tunnels`;
    if (snapshot.remoteTunnels.length > 0) {
      statusBarItem.tooltip = `${snapshot.activeTunnels.length} local, ${snapshot.remoteTunnels.length} in other window`;
    } else {
      statusBarItem.tooltip = undefined;
    }

    const activeServerId = fileExplorerProvider.getActiveServerId();
    if (activeServerId && !core.isServerConnected(activeServerId)) {
      sftpService.disconnect(activeServerId);
      fileExplorerProvider.clearActiveServer();
      // §8.3: the pin clears automatically on an explorer server change —
      // this auto-disconnect path changes the explorer's active server just
      // as much as an explicit disconnect/browse does.
      cwdSyncCoordinator.notifyExplorerServerChanged();
    }
  };
  const viewSync = createCoalescedInvoker(syncViewsImmediate, 150);
  const syncViews = (): void => {
    viewSync.schedule();
  };
  syncViewsImmediate();

  // Both focus listeners share one deps object and delegate to
  // `sessionTerminalFocus.ts`, where the §5.3-rule-7 invariant ("editor focus
  // must NOT clear focusedSessionId") is documented and unit-tested. Keep these
  // wrappers thin — any focus policy belongs in those two functions.
  const focusChangeOptions: TerminalFocusChangeOptions = {
    core,
    activityIndicators: ctx.activityIndicators,
    target: ctx,
    resolveSessionId: resolveTrackedSessionForTerminal
  };

  const editorFocusListener = vscode.window.onDidChangeActiveTextEditor(() => {
    applyActiveEditorChange(focusChangeOptions);
  });

  const terminalActivityListener = vscode.window.onDidChangeActiveTerminal((terminal) => {
    applyActiveTerminalChange(focusChangeOptions, terminal ?? undefined);
  });

  let previousServers = new Map<string, import("./models/config").ServerConfig>(
    core.getSnapshot().servers.map(s => [s.id, s])
  );
  let previousAuthProfiles = new Map<string, import("./models/config").AuthProfile>(
    core.getSnapshot().authProfiles.map((profile) => [profile.id, profile])
  );

  const unsubscribeCore = core.onDidChange((snapshot) => {
    syncViews();
    for (const server of snapshot.servers) {
      const prev = previousServers.get(server.id);
      if (prev && pooledConnectionParamsChanged(prev, server)) {
        pool.invalidate(server.id);
        // Clear stale proxy password when proxy endpoint changes to prevent
        // sending one proxy's credentials to a different proxy server.
        if (JSON.stringify(prev.proxy) !== JSON.stringify(server.proxy)) {
          void secretVault.delete(proxyPasswordSecretKey(server.id));
        }
      }
    }
    const changedAuthProfileIds = new Set<string>();
    const currentAuthProfileIds = new Set(snapshot.authProfiles.map((profile) => profile.id));
    for (const profile of snapshot.authProfiles) {
      if (previousAuthProfiles.get(profile.id) !== profile) {
        changedAuthProfileIds.add(profile.id);
      }
    }
    for (const profileId of previousAuthProfiles.keys()) {
      if (!currentAuthProfileIds.has(profileId)) {
        changedAuthProfileIds.add(profileId);
      }
    }
    if (changedAuthProfileIds.size > 0) {
      const affectedServerIds = new Set<string>();
      for (const server of snapshot.servers) {
        if (server.authProfileId && changedAuthProfileIds.has(server.authProfileId)) {
          affectedServerIds.add(server.id);
        }
      }
      for (const server of previousServers.values()) {
        if (server.authProfileId && changedAuthProfileIds.has(server.authProfileId)) {
          affectedServerIds.add(server.id);
        }
      }
      for (const serverId of affectedServerIds) {
        pool.invalidate(serverId);
      }
    }
    previousServers = new Map(snapshot.servers.map(s => [s.id, s]));
    previousAuthProfiles = new Map(snapshot.authProfiles.map((profile) => [profile.id, profile]));
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

  const focusSessionCommand = vscode.commands.registerCommand("nexus.focusSessionTerminal", (sessionId: string, type: "ssh" | "serial" | "localShell") => {
    focusSessionTerminal(
      {
        core,
        sessionTerminals,
        serialTerminals,
        localShellTerminals,
        activityIndicators: ctx.activityIndicators,
        onTerminalFocused: (terminal) => {
          ctx.focusedTerminal = terminal;
          core.setFocusedSession(sessionId);
        }
      },
      sessionId,
      type
    );
  });

  const refreshCommand = vscode.commands.registerCommand("nexus.refresh", async () => {
    await core.initialize();
    viewSync.flush();
    scriptTreeProvider.refresh();
  });

  const windowFocusListener = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      void registrySync.syncNow();
    }
  });

  const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("nexus.terminal.macros.autoTrigger") ||
      event.affectsConfiguration("nexus.terminal.macros.defaultCooldown") ||
      event.affectsConfiguration("nexus.terminal.macros.bufferLength")
    ) {
      macroAutoTrigger.reload();
    }
    if (event.affectsConfiguration("nexus.terminal.keyboardPassthrough") || event.affectsConfiguration("nexus.terminal.passthroughKeys")) {
      updatePassthroughContext();
    }
    if (event.affectsConfiguration("nexus.terminal.highlighting")) {
      highlighter.reload();
    }
    if (event.affectsConfiguration("nexus.logging.terminalOutputTrace")) {
      // Applies to sessions that are already open — loggers read the flag per
      // chunk through the provider handed to TerminalLoggerFactory.
      terminalOutputTraceEnabled = readTerminalOutputTrace();
    }
    if (
      event.affectsConfiguration("terminal.integrated.sendKeybindingsToShell") ||
      event.affectsConfiguration("terminal.integrated.commandsToSkipShell") ||
      event.affectsConfiguration("window.enableMenuBarMnemonics")
    ) {
      // Re-check on relevant settings changes. The once-per-session cap means
      // this re-arms the hint only if it was healthy at startup and just became
      // blocked (or if the user toggled before the first toast fired).
      void maybeWarnMacroKeybindingsBlocked(context);
    }
    if (event.affectsConfiguration("nexus.ui.showTreeDescriptions")) {
      nexusTreeProvider.refresh();
    }
    if (
      event.affectsConfiguration("nexus.ssh.connectionTimeout") ||
      event.affectsConfiguration("nexus.ssh.keepaliveInterval") ||
      event.affectsConfiguration("nexus.ssh.keepaliveCountMax")
    ) {
      sshConnector.updateConnectionOptions(readSshConnectionOptions());
    }
    if (event.affectsConfiguration("nexus.ssh.proxyTimeout")) {
      proxiedFactory.updateProxyTimeout(readBoundedMs("nexus.ssh", "proxyTimeout", 60, 5, 300));
    }
    if (event.affectsConfiguration("nexus.tunnel.socks5HandshakeTimeout")) {
      tunnelManager.updateSocks5HandshakeTimeout(readBoundedMs("nexus.tunnel", "socks5HandshakeTimeout", 10, 2, 60));
    }
    if (event.affectsConfiguration("nexus.serial.rpcTimeout")) {
      serialSidecar.updateRpcTimeout(readBoundedMs("nexus.serial", "rpcTimeout", 10, 2, 60));
    }
    if (
      event.affectsConfiguration("nexus.sftp.cacheTtlSeconds") ||
      event.affectsConfiguration("nexus.sftp.maxCacheEntries") ||
      event.affectsConfiguration("nexus.sftp.commandTimeout") ||
      event.affectsConfiguration("nexus.sftp.operationTimeout") ||
      event.affectsConfiguration("nexus.sftp.deleteDepthLimit") ||
      event.affectsConfiguration("nexus.sftp.deleteOperationLimit") ||
      event.affectsConfiguration("nexus.sftp.maxOpenFileSizeMB")
    ) {
      sftpService.updateConfig(readSftpServiceConfig());
    }
    if (event.affectsConfiguration("nexus.sftp.autoRefreshInterval")) {
      const interval = readBoundedNumber("nexus.sftp", "autoRefreshInterval", 10, 0, 60);
      fileExplorerProvider.setAutoRefreshInterval(interval);
    }
    if (event.affectsConfiguration("nexus.sftp.remoteWatchMode")) {
      const mode = vscode.workspace.getConfiguration("nexus.sftp").get<string>("remoteWatchMode", "auto") === "polling" ? "polling" as const : "auto" as const;
      fileExplorerProvider.setRemoteWatchMode(mode);
    }
    if (event.affectsConfiguration("nexus.sftp.maxOpenFileSizeMB")) {
      fileExplorerProvider.refresh();
    }
    if (event.affectsConfiguration("nexus.networkServers")) {
      // Pushes the new values to the daemon so a stopped service picks them up
      // on its next start without an extra round trip. Running services keep
      // what they launched with until explicitly restarted.
      void networkServerManager.syncConfiguration();
      // Configuration rows (TFTP root, DHCP pool, static reservations) render
      // straight from settings, so they go stale without an explicit repaint —
      // no NexusCore state changed here to drive one.
      networkServerTreeProvider.refresh();
    }
  });

  const serverDisposables = registerServerCommands(ctx);
  const serverMacroDisposables = registerServerMacroCommands(ctx);
  const bmcDisposables = registerBmcCommands(ctx);
  const tunnelDisposables = registerTunnelCommands(ctx);
  const serialDisposables = registerSerialCommands(ctx);
  const localShellDisposables = registerLocalShellCommands(ctx);
  const localServerCloseListener = wireLocalServerTerminalCloseListener({
    core,
    localServerTerminals,
    manager: localServerManager
  });
  const localServerCtx = { ...ctx, localServerManager } as const;
  const localServerDisposables = registerLocalServerCommands(localServerCtx);
  const networkServerDisposables = registerNetworkServerCommands({ ...ctx, networkServerManager });
  const networkServerProfileDisposables = registerNetworkServerProfileCommands({ ...ctx, networkServerManager });
  const networkServerTransferDisposables = registerNetworkServerTransferCommands({ ...ctx, networkServerManager });
  registerTerminalTabCommands(context, {
    registry: terminalRegistry,
    sessionTerminals: ctx.sessionTerminals,
    serialTerminals: ctx.serialTerminals,
    localShellTerminals: ctx.localShellTerminals,
    localServerTerminals: ctx.localServerTerminals
  });
  const profileDisposables = registerProfileCommands(ctx);
  const settingsDisposables = registerSettingsCommands(() => ctx.sessionLogDir);
  const authProfileDisposables = registerAuthProfileCommands(ctx);
  const deviceTemplateDisposables = registerDeviceTemplateCommands(ctx, inventoryProviderRegistry);
  const savedFilterDisposables = registerSavedFilterCommands(ctx);
  // F1 — same objects nexus.server.remove tears down with (ctx carries core/tunnelManager/sshPool).
  const inventoryTeardown: InventoryRuntimeTeardown = {
    teardownServerRuntime: (serverId: string, shouldAbort?: () => boolean) => teardownServerRuntime(ctx, serverId, shouldAbort)
  };
  const inventoryDisposables = registerInventoryCommands(core, inventoryProviderRegistry, secretVault, inventoryTeardown);
  // LIVE STATUS (Phase 2) — opt-in poll of EVE-NG lab running status, gated on
  // the Command Center being visible and nexus.inventory.statusPollSeconds > 0.
  // Seeds from commandCenterView.visible up front (createTreeView never fires the
  // visibility event at registration), re-arms/stops on the config change, and
  // is disposed with the extension.
  const inventoryStatusPoll = startInventoryStatusPoll({
    view: commandCenterView,
    getIntervalSeconds: () => Math.floor(readBoundedNumber("nexus.inventory", "statusPollSeconds", 0, 0, 3600)),
    onDidChangeInterval: (listener) =>
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nexus.inventory.statusPollSeconds")) {
          listener();
        }
      }),
    // Return the thenable so the poll's in-flight latch can await the sweep.
    // The `__poll` marker tells refreshStatus this is the background path, so it
    // stays silent on total failure (the manual command warns instead).
    fire: () => Promise.resolve(vscode.commands.executeCommand("nexus.inventory.refreshStatus", { __poll: true })).then(() => undefined)
  });
  context.subscriptions.push(inventoryStatusPoll);
  const configDisposables = registerConfigCommands(core, secretVault, context);
  const macroDisposables = registerMacroCommands(() => {
    return buildMacroProfileInputsFromSnapshot(core.getSnapshot());
  });
  const disableTriggerCmd = vscode.commands.registerCommand("nexus.macro.disableTrigger", (item?: MacroTreeItem) => {
    if (item?.macro.triggerPattern) {
      macroAutoTrigger.setDisabled(item.macro, true);
    }
  });
  const enableTriggerCmd = vscode.commands.registerCommand("nexus.macro.enableTrigger", (item?: MacroTreeItem) => {
    if (item?.macro.triggerPattern) {
      macroAutoTrigger.setDisabled(item.macro, false);
    }
  });
  const fileDisposables = registerFileCommands(ctx);
  const cwdSyncDisposables = registerCwdSyncCommands(ctx);

  const uriHandlerRegistration = vscode.window.registerUriHandler(createNexusUriHandler({ core }));

  const appearanceCommand = vscode.commands.registerCommand("nexus.terminal.appearance", () => {
    TerminalAppearancePanel.open(colorSchemeService);
  });
  const fixMacroKeybindingsCommand = vscode.commands.registerCommand(
    "nexus.settings.fixMacroKeybindings",
    () => confirmAndRepairMacroKeybindings()
  );

  context.subscriptions.push(
    commandCenterView,
    collapseListener,
    expandListener,
    tunnelView,
    networkServerView,
    settingsView,
    settingsTreeProvider,
    macroAutoTrigger,
    macroView,
    macroCollapseListener,
    macroExpandListener,
    macroAutoTriggerListener,
    scriptRuntimeManager,
    scriptOutputChannel,
    localShellOutputChannel,
    scriptTreeProvider,
    scriptCodeLensProvider,
    scriptsView,
    scriptCodeLensRegistration,
    scriptStatusBarItem,
    scriptLockStatusBarItem,
    scriptStatusBarListener,
    {
      dispose: () => {
        if (scriptStatusBarTick) clearInterval(scriptStatusBarTick);
        for (const t of scriptWatchdogs.values()) clearTimeout(t);
        scriptWatchdogs.clear();
      }
    },
    ...scriptCommandDisposables,
    fileExplorerView,
    fsRegistration,
    fileSystemProvider,
    elevationBroker,
    { dispose: elevationTeardownListener },
    editAsRootHintListener,
    statusBarItem,
    refreshCommand,
    settingsGuard,
    settingsGuardReportCommand,
    fixMacroKeybindingsCommand,
    uriHandlerRegistration,
    focusSessionCommand,
    filterCommand,
    filterClearCommand,
    appearanceCommand,
    windowFocusListener,
    configChangeListener,
    editorFocusListener,
    terminalActivityListener,
    ...serverDisposables,
    ...serverMacroDisposables,
    ...bmcDisposables,
    ...tunnelDisposables,
    ...serialDisposables,
    ...localShellDisposables,
    localServerCloseListener,
    ...localServerDisposables,
    ...networkServerDisposables,
    ...networkServerProfileDisposables,
    ...networkServerTransferDisposables,
    ...profileDisposables,
    ...settingsDisposables,
    ...authProfileDisposables,
    ...deviceTemplateDisposables,
    ...savedFilterDisposables,
    ...inventoryDisposables,
    ...configDisposables,
    ...macroDisposables,
    disableTriggerCmd,
    enableTriggerCmd,
    ...fileDisposables,
    ...cwdSyncDisposables,
    {
      dispose: () => {
        void collapsedFolderStatePersistence.flush();
        collapsedFolderStatePersistence.dispose();
      }
    },
    {
      dispose: () => {
        void macroCollapsedFolderStatePersistence.flush();
        macroCollapsedFolderStatePersistence.dispose();
      }
    },
    {
      dispose: () => {
        unsubscribeCore();
        unsubscribeTunnel();
        const shutdownReason = "Nexus extension is shutting down. This session has been closed.";
        const snapshot = core.getSnapshot();
        for (const session of snapshot.activeSessions) {
          try {
            session.pty?.markShuttingDown(shutdownReason);
          } catch (err) {
            // One misbehaving PTY must not block the others from getting a banner.
            console.error("[Nexus] markShuttingDown failed for SSH session", session.id, err);
          }
        }
        for (const session of snapshot.activeSerialSessions) {
          try {
            session.pty?.markShuttingDown(shutdownReason);
          } catch (err) {
            console.error("[Nexus] markShuttingDown failed for serial session", session.id, err);
          }
        }
        for (const session of snapshot.activeLocalShellSessions) {
          try {
            session.pty?.markShuttingDown(shutdownReason);
          } catch (err) {
            console.error("[Nexus] markShuttingDown failed for local shell session", session.id, err);
          }
        }
        for (const session of snapshot.activeLocalServerSessions) {
          try {
            session.pty?.markShuttingDown(shutdownReason);
          } catch (err) {
            console.error("[Nexus] markShuttingDown failed for local server session", session.id, err);
          }
        }
        serialTerminals.clear();
        localShellTerminals.clear();
        localServerTerminals.clear();
        serialSidecar.dispose();
        fileExplorerProvider.dispose();
        sftpService.dispose();
        void tunnelManager.stopAll();
        void localServerManager.stopAll();
        // Kills the daemon child explicitly rather than relying on subscription
        // order, so UDP 69/67 are released before the host process goes away.
        networkServerManager.dispose();
        registrySync.dispose();
        void registrySync.cleanupOwnEntries();
        viewSync.dispose();
        pool.dispose();
      }
    }
  );

  return createNexusExtensionApi(inventoryProviderRegistry);
}

export async function deactivate(): Promise<void> {
  // Cleanup is handled via context.subscriptions disposables. VS Code calls
  // this function first and disposes those subscriptions immediately
  // afterwards, without waiting for the promise returned here — so the PTY
  // teardown that pushes each session's transcript tail into the writer has
  // not run yet at this point. Yield a turn to let it run, then wait for the
  // tail to actually reach disk: the writer is buffered, and a drain that was
  // already in flight when the tail was queued can only chain it, which
  // nothing else in the teardown path would wait on.
  //
  // The wait is bounded inside flushSessionTranscripts — a hung filesystem
  // must not hold extension-host shutdown open.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await flushSessionTranscripts();
}
