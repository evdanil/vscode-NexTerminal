import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import type { AuthType, ServerConfig } from "../models/config";
import { createSessionTranscript } from "../logging/sessionTranscriptLogger";
import { SshPty } from "../services/ssh/sshPty";
import { serverFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { GroupTreeItem, ServerTreeItem, SessionTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
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

export function formValuesToServer(values: FormValues, existingId?: string, preserveIsHidden = false): ServerConfig | undefined {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  const host = typeof values.host === "string" ? values.host.trim() : "";
  const username = typeof values.username === "string" ? values.username.trim() : "";
  if (!name || !host || !username) {
    return undefined;
  }
  return {
    id: existingId ?? randomUUID(),
    name,
    host,
    port: typeof values.port === "number" ? values.port : 22,
    username,
    authType: (values.authType as AuthType) ?? "password",
    keyPath: typeof values.keyPath === "string" && values.keyPath ? values.keyPath : undefined,
    group: typeof values.group === "string" && values.group ? values.group : undefined,
    isHidden: preserveIsHidden,
    logSession: values.logSession !== false
  };
}

export { browseForKey, collectGroups };

async function browseForKey(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    title: "Select SSH Private Key",
    defaultUri: vscode.Uri.file(os.homedir() + "/.ssh/"),
    openLabel: "Select Key",
    filters: { "All Files": ["*"] }
  });
  return uris?.[0]?.fsPath;
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
            if (terminalRef) {
              ctx.sessionTerminals.set(sessionId, terminalRef);
            }

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
            ctx.sessionTerminals.delete(sessionId);
            if (terminalRef) {
              removeTerminal(server.id, terminalRef, ctx.terminalsByServer);
            }
          }
        },
        ctx.loggerFactory.create("terminal", server.id),
        createSessionTranscript(ctx.sessionLogDir, server.name, server.logSession !== false)
      );
      const terminal = vscode.window.createTerminal({ name: terminalName, pty });
      terminalRef = terminal;
      addTerminal(server.id, terminal, ctx.terminalsByServer);
      terminal.show();
    }
  );
}

async function disconnectServer(ctx: CommandContext, arg?: unknown): Promise<void> {
  // If arg is a single session node, disconnect only that session
  if (arg instanceof SessionTreeItem) {
    const terminal = ctx.sessionTerminals.get(arg.session.id);
    if (terminal) {
      terminal.dispose();
    }
    return;
  }

  // Otherwise disconnect all sessions for the server
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
    vscode.commands.registerCommand("nexus.server.add", () => {
      const existingGroups = collectGroups(ctx);
      const definition = serverFormDefinition(undefined, existingGroups);
      WebviewFormPanel.open("server-add", definition, {
        onSubmit: async (values) => {
          const server = formValuesToServer(values);
          if (!server) {
            return;
          }
          await ctx.core.addOrUpdateServer(server);
        },
        onBrowse: browseForKey
      });
    }),

    vscode.commands.registerCommand("nexus.server.edit", async (arg?: unknown) => {
      const existing = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!existing) {
        return;
      }
      const existingGroups = collectGroups(ctx);
      const definition = serverFormDefinition(existing, existingGroups);
      WebviewFormPanel.open("server-edit", definition, {
        onSubmit: async (values) => {
          const updated = formValuesToServer(values, existing.id, existing.isHidden);
          if (!updated) {
            return;
          }
          await ctx.core.addOrUpdateServer(updated);
          if (ctx.core.isServerConnected(existing.id)) {
            void vscode.window.showInformationMessage(
              "Server profile updated. Existing sessions keep current connection settings until reconnect."
            );
          }
        },
        onBrowse: browseForKey
      });
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
    vscode.commands.registerCommand("nexus.server.disconnect", (arg?: unknown) => disconnectServer(ctx, arg)),

    vscode.commands.registerCommand("nexus.server.copyInfo", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const info = `${server.username}@${server.host}:${server.port}`;
      await vscode.env.clipboard.writeText(info);
      void vscode.window.showInformationMessage(`Copied: ${info}`);
    }),

    vscode.commands.registerCommand("nexus.server.duplicate", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const copy = { ...server, id: randomUUID(), name: `${server.name} (copy)` };
      await ctx.core.addOrUpdateServer(copy);
    }),

    vscode.commands.registerCommand("nexus.server.rename", async (arg?: unknown) => {
      const server = toServerFromArg(ctx.core, arg) ?? (await pickServer(ctx.core));
      if (!server) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        title: "Rename Server",
        value: server.name,
        prompt: "Enter new name",
        validateInput: (value) => (value.trim() ? null : "Name cannot be empty")
      });
      if (!newName || newName.trim() === server.name) {
        return;
      }
      await ctx.core.addOrUpdateServer({ ...server, name: newName.trim() });
    }),

    vscode.commands.registerCommand("nexus.group.rename", async (arg?: unknown) => {
      if (!(arg instanceof GroupTreeItem)) {
        return;
      }
      const oldName = arg.groupName;
      const newName = await vscode.window.showInputBox({
        title: "Rename Group",
        value: oldName,
        prompt: "Enter new group name",
        validateInput: (value) => (value.trim() ? null : "Group name cannot be empty")
      });
      if (!newName || newName.trim() === oldName) {
        return;
      }
      const trimmedName = newName.trim();
      const snapshot = ctx.core.getSnapshot();
      for (const server of snapshot.servers) {
        if (server.group === oldName) {
          await ctx.core.addOrUpdateServer({ ...server, group: trimmedName });
        }
      }
      for (const profile of snapshot.serialProfiles) {
        if (profile.group === oldName) {
          await ctx.core.addOrUpdateSerialProfile({ ...profile, group: trimmedName });
        }
      }
    }),

    vscode.commands.registerCommand("nexus.group.connect", async (arg?: unknown) => {
      if (!(arg instanceof GroupTreeItem)) {
        return;
      }
      const servers = ctx.core
        .getSnapshot()
        .servers.filter((s) => s.group === arg.groupName && !s.isHidden);
      for (const server of servers) {
        void connectServer(ctx, server.id);
      }
    }),

    vscode.commands.registerCommand("nexus.group.disconnect", async (arg?: unknown) => {
      if (!(arg instanceof GroupTreeItem)) {
        return;
      }
      const servers = ctx.core
        .getSnapshot()
        .servers.filter((s) => s.group === arg.groupName && !s.isHidden);
      for (const server of servers) {
        await disconnectServer(ctx, server.id);
      }
    })
  ];
}
