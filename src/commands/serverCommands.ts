import * as vscode from "vscode";
import type { ServerConfig } from "../models/config";
import { SshPty } from "../services/ssh/sshPty";
import { ServerTreeItem, SessionTreeItem } from "../ui/nexusTreeProvider";
import { promptServerConfig } from "../ui/prompts";
import { resolveTunnelConnectionMode, startTunnel } from "./tunnelCommands";
import type { CommandContext, ServerTerminalMap } from "./types";

async function pickServer(core: import("../core/nexusCore").NexusCore): Promise<ServerConfig | undefined> {
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

function toServerFromArg(
  core: import("../core/nexusCore").NexusCore,
  arg: unknown
): ServerConfig | undefined {
  if (arg instanceof ServerTreeItem) {
    return arg.server;
  }
  if (arg instanceof SessionTreeItem) {
    return core.getServer(arg.session.serverId);
  }
  if (typeof arg === "object" && arg) {
    const withServer = arg as { server?: ServerConfig };
    if (withServer.server?.id) {
      return core.getServer(withServer.server.id) ?? withServer.server;
    }
    const withSession = arg as { session?: { serverId?: string } };
    if (withSession.session?.serverId) {
      return core.getServer(withSession.session.serverId);
    }
  }
  if (typeof arg === "string") {
    return core.getServer(arg);
  }
  return undefined;
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

function collectGroups(ctx: CommandContext): string[] {
  const snapshot = ctx.core.getSnapshot();
  const groups = new Set<string>();
  for (const server of snapshot.servers) {
    if (server.group) {
      groups.add(server.group);
    }
  }
  for (const profile of snapshot.serialProfiles) {
    if (profile.group) {
      groups.add(profile.group);
    }
  }
  return [...groups].sort((a, b) => a.localeCompare(b));
}

async function connectServer(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${server.name}...`,
      cancellable: false
    },
    async () => {
      const terminalName = `Nexus SSH: ${server.name}`;
      let terminalRef: vscode.Terminal | undefined;
      const pty = new SshPty(
        server,
        ctx.sshFactory,
        {
          onSessionOpened: (sessionId) => {
            ctx.core.registerSession({
              id: sessionId,
              serverId: server.id,
              terminalName,
              startedAt: Date.now()
            });

            for (const tunnel of ctx.core.getSnapshot().tunnels) {
              if (tunnel.autoStart && tunnel.defaultServerId === server.id) {
                void resolveTunnelConnectionMode(tunnel, false).then((mode) => {
                  if (!mode) {
                    return;
                  }
                  return startTunnel(ctx.core, ctx.tunnelManager, ctx.sshFactory, tunnel, server, mode);
                });
              }
            }
          },
          onSessionClosed: (sessionId) => {
            ctx.core.unregisterSession(sessionId);
            if (terminalRef) {
              removeTerminal(server.id, terminalRef, ctx.terminalsByServer);
            }
          }
        },
        ctx.loggerFactory.create("terminal", server.id)
      );
      const terminal = vscode.window.createTerminal({ name: terminalName, pty });
      terminalRef = terminal;
      addTerminal(server.id, terminal, ctx.terminalsByServer);
      terminal.show();
    }
  );
}

async function disconnectServer(ctx: CommandContext, arg?: unknown): Promise<void> {
  const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
  if (!server) {
    return;
  }
  const terminals = ctx.terminalsByServer.get(server.id);
  if (terminals) {
    for (const terminal of terminals) {
      terminal.dispose();
    }
    ctx.terminalsByServer.delete(server.id);
  }
  const activeTunnels = ctx.core.getSnapshot().activeTunnels.filter((t) => t.serverId === server.id);
  await Promise.all(activeTunnels.map((t) => ctx.tunnelManager.stop(t.id)));
}

export function registerServerCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.server.add", async () => {
      const existingGroups = collectGroups(ctx);
      const server = await promptServerConfig(undefined, { mode: "add", existingGroups });
      if (!server) {
        return;
      }
      await ctx.core.addOrUpdateServer(server);
    }),

    vscode.commands.registerCommand("nexus.server.edit", async (arg?: unknown) => {
      const existing = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!existing) {
        return;
      }
      const existingGroups = collectGroups(ctx);
      const updated = await promptServerConfig(existing, { mode: "edit", existingGroups });
      if (!updated) {
        return;
      }
      updated.id = existing.id;
      await ctx.core.addOrUpdateServer(updated);
      if (ctx.core.isServerConnected(existing.id)) {
        void vscode.window.showInformationMessage(
          "Server profile updated. Existing sessions keep current connection settings until reconnect."
        );
      }
    }),

    vscode.commands.registerCommand("nexus.server.remove", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove server "${server.name}" and disconnect all sessions?`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      await disconnectServer(ctx, server.id);
      await ctx.core.removeServer(server.id);
    }),

    vscode.commands.registerCommand("nexus.server.connect", (arg?: unknown) => connectServer(ctx, arg)),
    vscode.commands.registerCommand("nexus.server.disconnect", (arg?: unknown) => disconnectServer(ctx, arg))
  ];
}
