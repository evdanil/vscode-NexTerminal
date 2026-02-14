import * as path from "node:path";
import * as vscode from "vscode";
import { NexusCore } from "./core/nexusCore";
import { TerminalLoggerFactory } from "./logging/terminalLogger";
import type { ServerConfig, TunnelProfile } from "./models/config";
import { SerialPty } from "./services/serial/serialPty";
import { SerialSidecarManager } from "./services/serial/serialSidecarManager";
import { SilentAuthSshFactory } from "./services/ssh/silentAuth";
import { Ssh2Connector } from "./services/ssh/ssh2Connector";
import { SshPty } from "./services/ssh/sshPty";
import { VscodePasswordPrompt } from "./services/ssh/vscodePasswordPrompt";
import { VscodeSecretVault } from "./services/ssh/vscodeSecretVault";
import { TunnelManager } from "./services/tunnel/tunnelManager";
import { VscodeConfigRepository } from "./storage/vscodeConfigRepository";
import { NexusTreeProvider, ServerTreeItem } from "./ui/nexusTreeProvider";
import { promptServerConfig, promptTunnelProfile } from "./ui/prompts";
import { TunnelTreeItem, TunnelTreeProvider } from "./ui/tunnelTreeProvider";

type ServerTerminalMap = Map<string, Set<vscode.Terminal>>;
type SerialTerminalMap = Map<string, vscode.Terminal>;

let tunnelManagerRef: TunnelManager | undefined;
let serialSidecarRef: SerialSidecarManager | undefined;
let terminalsByServerRef: ServerTerminalMap | undefined;
let serialTerminalsRef: SerialTerminalMap | undefined;

async function pickServer(core: NexusCore): Promise<ServerConfig | undefined> {
  const servers = core.getSnapshot().servers.filter((server) => !server.isHidden);
  if (servers.length === 0) {
    vscode.window.showWarningMessage("No Nexus servers configured");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    servers.map((server) => ({
      label: server.name,
      description: `${server.username}@${server.host}:${server.port}`,
      server
    })),
    { title: "Select Nexus Server" }
  );
  return pick?.server;
}

async function pickTunnel(core: NexusCore): Promise<TunnelProfile | undefined> {
  const tunnels = core.getSnapshot().tunnels;
  if (tunnels.length === 0) {
    vscode.window.showWarningMessage("No Nexus tunnel profiles configured");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    tunnels.map((profile) => ({
      label: profile.name,
      description: `${profile.localPort} -> ${profile.remoteIP}:${profile.remotePort}`,
      profile
    })),
    { title: "Select Tunnel Profile" }
  );
  return pick?.profile;
}

async function pickSerialPort(serialSidecar: SerialSidecarManager): Promise<string | undefined> {
  const ports = await serialSidecar.listPorts();
  if (ports.length === 0) {
    vscode.window.showInformationMessage("No serial ports found (or serial module unavailable).");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    ports.map((port) => ({
      label: port.path,
      description: port.manufacturer ?? ""
    })),
    { title: "Select Serial Port" }
  );
  return pick?.label;
}

async function promptBaudRate(defaultValue = 115200): Promise<number | undefined> {
  const baudInput = await vscode.window.showInputBox({
    title: "Serial Baud Rate",
    value: `${defaultValue}`,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return "Enter a positive integer baud rate";
      }
      return undefined;
    }
  });
  if (!baudInput) {
    return undefined;
  }
  return Number(baudInput);
}

function getConnectedServerIds(core: NexusCore): string[] {
  return [...new Set(core.getSnapshot().activeSessions.map((session) => session.serverId))];
}

async function resolveServerForTunnel(
  core: NexusCore,
  profile: TunnelProfile,
  preferredServerId?: string
): Promise<ServerConfig | undefined> {
  const connectedServerIds = new Set(getConnectedServerIds(core));
  const tryResolve = (serverId?: string): ServerConfig | undefined => {
    if (!serverId || !connectedServerIds.has(serverId)) {
      return undefined;
    }
    return core.getServer(serverId);
  };

  const preferred = tryResolve(preferredServerId);
  if (preferred) {
    return preferred;
  }
  const defaultServer = tryResolve(profile.defaultServerId);
  if (defaultServer) {
    return defaultServer;
  }

  const connectedServers = [...connectedServerIds]
    .map((serverId) => core.getServer(serverId))
    .filter((server): server is ServerConfig => !!server);
  if (connectedServers.length === 0) {
    vscode.window.showWarningMessage("No active server sessions. Connect to a server first.");
    return undefined;
  }
  if (connectedServers.length === 1) {
    return connectedServers[0];
  }

  const pick = await vscode.window.showQuickPick(
    connectedServers.map((server) => ({
      label: server.name,
      description: `${server.username}@${server.host}`,
      server
    })),
    { title: `Start tunnel "${profile.name}" on which server?` }
  );
  return pick?.server;
}

function addTerminal(serverId: string, terminal: vscode.Terminal, terminalsByServer: ServerTerminalMap): void {
  let terminals = terminalsByServer.get(serverId);
  if (!terminals) {
    terminals = new Set();
    terminalsByServer.set(serverId, terminals);
  }
  terminals.add(terminal);
}

function removeTerminal(serverId: string, terminal: vscode.Terminal, terminalsByServer: ServerTerminalMap): void {
  const terminals = terminalsByServer.get(serverId);
  if (!terminals) {
    return;
  }
  terminals.delete(terminal);
  if (terminals.size === 0) {
    terminalsByServer.delete(serverId);
  }
}

async function startTunnel(
  core: NexusCore,
  tunnelManager: TunnelManager,
  profile: TunnelProfile,
  server: ServerConfig
): Promise<void> {
  if (!core.isServerConnected(server.id)) {
    vscode.window.showWarningMessage(`Server "${server.name}" is not connected. Open a session first.`);
    return;
  }
  await tunnelManager.start(profile, server);
}

async function stopTunnelByProfile(core: NexusCore, tunnelManager: TunnelManager, profileId: string): Promise<void> {
  const active = core.getSnapshot().activeTunnels.find((tunnel) => tunnel.profileId === profileId);
  if (!active) {
    return;
  }
  await tunnelManager.stop(active.id);
}

function toServerFromArg(core: NexusCore, arg: unknown): ServerConfig | undefined {
  if (arg instanceof ServerTreeItem) {
    return arg.server;
  }
  if (typeof arg === "string") {
    return core.getServer(arg);
  }
  return undefined;
}

function toTunnelFromArg(core: NexusCore, arg: unknown): TunnelProfile | undefined {
  if (arg instanceof TunnelTreeItem) {
    return arg.profile;
  }
  if (typeof arg === "string") {
    return core.getTunnel(arg);
  }
  return undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repository = new VscodeConfigRepository(context);
  const core = new NexusCore(repository);
  await core.initialize();

  const loggerFactory = new TerminalLoggerFactory(path.join(context.globalStorageUri.fsPath, "logs"));
  const sshFactory = new SilentAuthSshFactory(new Ssh2Connector(), new VscodeSecretVault(context), new VscodePasswordPrompt());
  const tunnelManager = new TunnelManager(sshFactory);
  const sidecarPath = path.join(__dirname, "services", "serial", "serialSidecarWorker.js");
  const serialSidecar = new SerialSidecarManager(sidecarPath);
  const terminalsByServer: ServerTerminalMap = new Map();
  const serialTerminals: SerialTerminalMap = new Map();

  tunnelManagerRef = tunnelManager;
  serialSidecarRef = serialSidecar;
  terminalsByServerRef = terminalsByServer;
  serialTerminalsRef = serialTerminals;

  const nexusTreeProvider = new NexusTreeProvider(async (serverId, tunnelProfileId) => {
    const profile = core.getTunnel(tunnelProfileId);
    const server = core.getServer(serverId);
    if (!profile || !server) {
      return;
    }
    await startTunnel(core, tunnelManager, profile, server);
  });
  const tunnelTreeProvider = new TunnelTreeProvider();

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

  const syncViews = (): void => {
    const snapshot = core.getSnapshot();
    nexusTreeProvider.setSnapshot(snapshot);
    tunnelTreeProvider.setSnapshot(snapshot);
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
      void vscode.window.showErrorMessage(`Nexus tunnel error: ${message}`);
    }
  });

  async function connectServer(arg?: unknown): Promise<void> {
    const server = toServerFromArg(core, arg) ?? (await pickServer(core));
    if (!server) {
      return;
    }
    const terminalName = `Nexus SSH: ${server.name}`;
    let terminalRef: vscode.Terminal | undefined;
    const pty = new SshPty(
      server,
      sshFactory,
      {
        onSessionOpened: (sessionId) => {
          core.registerSession({
            id: sessionId,
            serverId: server.id,
            terminalName,
            startedAt: Date.now()
          });

          for (const tunnel of core.getSnapshot().tunnels) {
            if (tunnel.autoStart && tunnel.defaultServerId === server.id) {
              void startTunnel(core, tunnelManager, tunnel, server);
            }
          }
        },
        onSessionClosed: (sessionId) => {
          core.unregisterSession(sessionId);
          if (terminalRef) {
            removeTerminal(server.id, terminalRef, terminalsByServer);
          }
        }
      },
      loggerFactory.create("terminal", server.id)
    );
    const terminal = vscode.window.createTerminal({ name: terminalName, pty });
    terminalRef = terminal;
    addTerminal(server.id, terminal, terminalsByServer);
    terminal.show();
  }

  async function disconnectServer(arg?: unknown): Promise<void> {
    const server = toServerFromArg(core, arg) ?? (await pickServer(core));
    if (!server) {
      return;
    }
    const terminals = terminalsByServer.get(server.id);
    if (terminals) {
      for (const terminal of terminals) {
        terminal.dispose();
      }
      terminalsByServer.delete(server.id);
    }
    const activeTunnels = core.getSnapshot().activeTunnels.filter((tunnel) => tunnel.serverId === server.id);
    await Promise.all(activeTunnels.map((tunnel) => tunnelManager.stop(tunnel.id)));
  }

  async function startTunnelCommand(arg?: unknown): Promise<void> {
    const profile = toTunnelFromArg(core, arg) ?? (await pickTunnel(core));
    if (!profile) {
      return;
    }
    const server = await resolveServerForTunnel(core, profile);
    if (!server) {
      return;
    }
    await startTunnel(core, tunnelManager, profile, server);
  }

  async function stopTunnelCommand(arg?: unknown): Promise<void> {
    const profile = toTunnelFromArg(core, arg);
    if (profile) {
      await stopTunnelByProfile(core, tunnelManager, profile.id);
      return;
    }
    const active = core.getSnapshot().activeTunnels;
    if (active.length === 0) {
      return;
    }
    const pick = await vscode.window.showQuickPick(
      active.map((item) => ({
        label: core.getTunnel(item.profileId)?.name ?? item.profileId,
        description: `${item.localPort} -> ${item.remoteIP}:${item.remotePort}`,
        active: item
      })),
      { title: "Stop active tunnel" }
    );
    if (!pick) {
      return;
    }
    await tunnelManager.stop(pick.active.id);
  }

  const refreshCommand = vscode.commands.registerCommand("nexus.refresh", async () => {
    await core.initialize();
    syncViews();
  });

  const addServerCommand = vscode.commands.registerCommand("nexus.server.add", async () => {
    const server = await promptServerConfig();
    if (!server) {
      return;
    }
    await core.addOrUpdateServer(server);
  });

  const removeServerCommand = vscode.commands.registerCommand("nexus.server.remove", async (arg?: unknown) => {
    const server = toServerFromArg(core, arg) ?? (await pickServer(core));
    if (!server) {
      return;
    }
    await disconnectServer(server);
    await core.removeServer(server.id);
  });

  const connectServerCommand = vscode.commands.registerCommand("nexus.server.connect", connectServer);
  const disconnectServerCommand = vscode.commands.registerCommand("nexus.server.disconnect", disconnectServer);

  const addTunnelCommand = vscode.commands.registerCommand("nexus.tunnel.add", async () => {
    const profile = await promptTunnelProfile();
    if (!profile) {
      return;
    }
    const defaultServer = await pickServer(core);
    if (defaultServer) {
      profile.defaultServerId = defaultServer.id;
    }
    await core.addOrUpdateTunnel(profile);
  });

  const removeTunnelCommand = vscode.commands.registerCommand("nexus.tunnel.remove", async (arg?: unknown) => {
    const profile = toTunnelFromArg(core, arg) ?? (await pickTunnel(core));
    if (!profile) {
      return;
    }
    await stopTunnelByProfile(core, tunnelManager, profile.id);
    await core.removeTunnel(profile.id);
  });

  const startTunnelCmd = vscode.commands.registerCommand("nexus.tunnel.start", startTunnelCommand);
  const stopTunnelCmd = vscode.commands.registerCommand("nexus.tunnel.stop", stopTunnelCommand);

  const connectSerialCommand = vscode.commands.registerCommand("nexus.serial.connect", async () => {
    try {
      const portPath = await pickSerialPort(serialSidecar);
      if (!portPath) {
        return;
      }
      const baudRate = await promptBaudRate();
      if (!baudRate) {
        return;
      }

      const terminalName = `Nexus Serial: ${portPath}`;
      let terminalRef: vscode.Terminal | undefined;
      const pty = new SerialPty(
        serialSidecar,
        { path: portPath, baudRate },
        {
          onSessionOpened: (sessionId) => {
            if (terminalRef) {
              serialTerminals.set(sessionId, terminalRef);
            }
          },
          onSessionClosed: (sessionId) => {
            serialTerminals.delete(sessionId);
          }
        },
        loggerFactory.create("terminal", `serial-${portPath}`)
      );

      const terminal = vscode.window.createTerminal({ name: terminalName, pty });
      terminalRef = terminal;
      terminal.show();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown serial connection error";
      void vscode.window.showErrorMessage(`Failed to open serial terminal: ${message}`);
    }
  });

  const disconnectSerialCommand = vscode.commands.registerCommand("nexus.serial.disconnect", async () => {
    if (serialTerminals.size === 0) {
      void vscode.window.showInformationMessage("No active serial sessions.");
      return;
    }

    const pick = await vscode.window.showQuickPick(
      [...serialTerminals.entries()].map(([sessionId, terminal]) => ({
        label: terminal.name,
        description: sessionId,
        terminal
      })),
      { title: "Disconnect serial session" }
    );
    if (!pick) {
      return;
    }
    pick.terminal.dispose();
  });

  const listSerialPortsCommand = vscode.commands.registerCommand("nexus.serial.listPorts", async () => {
    try {
      const portPath = await pickSerialPort(serialSidecar);
      if (!portPath) {
        return;
      }
      void vscode.window.showInformationMessage(`Selected serial port: ${portPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown serial error";
      void vscode.window.showErrorMessage(`Failed to list serial ports: ${message}`);
    }
  });

  context.subscriptions.push(
    commandCenterView,
    tunnelView,
    refreshCommand,
    addServerCommand,
    removeServerCommand,
    connectServerCommand,
    disconnectServerCommand,
    addTunnelCommand,
    removeTunnelCommand,
    startTunnelCmd,
    stopTunnelCmd,
    connectSerialCommand,
    disconnectSerialCommand,
    listSerialPortsCommand,
    {
      dispose: () => {
        unsubscribeCore();
        unsubscribeTunnel();
        for (const [, terminal] of serialTerminals.entries()) {
          terminal.dispose();
        }
        serialTerminals.clear();
        serialSidecar.dispose();
        void tunnelManager.stopAll();
      }
    }
  );
}

export async function deactivate(): Promise<void> {
  if (terminalsByServerRef) {
    for (const [, terminals] of terminalsByServerRef.entries()) {
      for (const terminal of terminals) {
        terminal.dispose();
      }
    }
    terminalsByServerRef.clear();
  }
  if (serialTerminalsRef) {
    for (const [, terminal] of serialTerminalsRef.entries()) {
      terminal.dispose();
    }
    serialTerminalsRef.clear();
  }
  serialSidecarRef?.dispose();
  if (tunnelManagerRef) {
    await tunnelManagerRef.stopAll();
  }
}
