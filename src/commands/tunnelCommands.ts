import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type {
  ResolvedTunnelConnectionMode,
  ServerConfig,
  TunnelConnectionMode,
  TunnelProfile,
  TunnelType
} from "../models/config";
import { resolveTunnelType } from "../models/config";
import type { SshFactory } from "../services/ssh/contracts";
import type { TunnelManager } from "../services/tunnel/tunnelManager";
import type { TunnelRegistrySync } from "../services/tunnel/tunnelRegistrySync";
import { serverFormDefinition, tunnelFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { TunnelTreeItem, formatTunnelRoute } from "../ui/tunnelTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { isTunnelRouteChanged } from "../utils/tunnelProfile";
import { browseForKey, collectGroups, formValuesToServer } from "./serverCommands";
import type { CommandContext } from "./types";

export function getDefaultTunnelConnectionMode(): ResolvedTunnelConnectionMode {
  const configured = vscode.workspace
    .getConfiguration("nexus.tunnel")
    .get<ResolvedTunnelConnectionMode>("defaultConnectionMode", "shared");
  return configured === "isolated" ? "isolated" : "shared";
}

function getDefaultReverseBindAddress(): string {
  const configured = vscode.workspace.getConfiguration("nexus.tunnel").get<string>("defaultBindAddress", "127.0.0.1");
  return configured.trim() || "127.0.0.1";
}

function getDefaultSessionTranscriptsEnabled(): boolean {
  return vscode.workspace.getConfiguration("nexus.logging").get<boolean>("sessionTranscripts", true);
}

export async function resolveTunnelConnectionMode(
  profile: TunnelProfile,
  interactive: boolean
): Promise<ResolvedTunnelConnectionMode | undefined> {
  // Reverse tunnels always require a shared connection
  if (resolveTunnelType(profile) === "reverse") {
    return "shared";
  }
  const profileMode: TunnelConnectionMode = profile.connectionMode ?? getDefaultTunnelConnectionMode();
  if (profileMode !== "ask") {
    return profileMode;
  }
  if (!interactive) {
    return getDefaultTunnelConnectionMode();
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Isolated per connection", value: "isolated" as ResolvedTunnelConnectionMode },
      { label: "Shared SSH connection", value: "shared" as ResolvedTunnelConnectionMode }
    ],
    {
      title: `Tunnel mode for "${profile.name}"`,
      canPickMany: false
    }
  );
  return pick?.value;
}

export async function resolveServerForTunnel(
  core: NexusCore,
  profile: TunnelProfile,
  preferredServerId?: string
): Promise<ServerConfig | undefined> {
  const tryResolve = (serverId?: string): ServerConfig | undefined =>
    serverId ? core.getServer(serverId) : undefined;

  const preferred = tryResolve(preferredServerId);
  if (preferred) {
    return preferred;
  }
  const defaultServer = tryResolve(profile.defaultServerId);
  if (defaultServer) {
    return defaultServer;
  }

  const servers = core
    .getSnapshot()
    .servers.slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (servers.length === 0) {
    vscode.window.showWarningMessage("No Nexus servers configured. Add a server first.");
    return undefined;
  }
  if (servers.length === 1) {
    return servers[0];
  }

  const pick = await vscode.window.showQuickPick(
    servers.map((server) => ({
      label: server.name,
      description: `${server.username}@${server.host}${server.isHidden ? " (hidden)" : ""}`,
      server
    })),
    { title: `Start tunnel "${profile.name}" on which server?` }
  );
  return pick?.server;
}

export async function startTunnel(
  core: NexusCore,
  tunnelManager: TunnelManager,
  sshFactory: SshFactory,
  profile: TunnelProfile,
  server: ServerConfig,
  connectionMode: ResolvedTunnelConnectionMode,
  registrySync?: TunnelRegistrySync
): Promise<void> {
  if (core.getSnapshot().activeTunnels.some((tunnel) => tunnel.profileId === profile.id)) {
    void vscode.window.showInformationMessage(`Tunnel "${profile.name}" is already running.`);
    return;
  }

  if (registrySync) {
    await registrySync.syncNow();
    const remoteOwner = await registrySync.checkRemoteOwnership(profile.id, profile.localPort);
    if (remoteOwner) {
      const action = await vscode.window.showWarningMessage(
        `Tunnel "${profile.name}" is already active in another VS Code window (localhost:${profile.localPort}). The forwarded port is accessible from this window too.`,
        "Open in Browser"
      );
      if (action === "Open in Browser") {
        void vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${profile.localPort}`));
      }
      return;
    }
  }

  if (connectionMode === "shared") {
    const authenticated = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting tunnel "${profile.name}"`,
        cancellable: false
      },
      async () => {
        try {
          const connection = await sshFactory.connect(server);
          connection.dispose();
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown SSH error";
          if (message.toLowerCase().includes("password entry canceled")) {
            void vscode.window.showInformationMessage(`Tunnel "${profile.name}" start canceled.`);
            return false;
          }
          void vscode.window.showErrorMessage(
            `Failed to authenticate tunnel "${profile.name}" on "${server.name}": ${message}`
          );
          return false;
        }
      }
    );

    if (!authenticated) {
      return;
    }
  }

  await tunnelManager.start(profile, server, { connectionMode });
}

export async function stopTunnelByProfile(
  core: NexusCore,
  tunnelManager: TunnelManager,
  profileId: string
): Promise<void> {
  const active = core.getSnapshot().activeTunnels.find((tunnel) => tunnel.profileId === profileId);
  if (!active) {
    return;
  }
  await tunnelManager.stop(active.id);
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
      description: formatTunnelRoute(profile),
      profile
    })),
    { title: "Select Tunnel Profile" }
  );
  return pick?.profile;
}

function toTunnelFromArg(core: NexusCore, arg: unknown): TunnelProfile | undefined {
  if (arg instanceof TunnelTreeItem) {
    return arg.profile;
  }
  if (typeof arg === "object" && arg) {
    const withProfile = arg as { profile?: TunnelProfile };
    if (withProfile.profile?.id) {
      return core.getTunnel(withProfile.profile.id) ?? withProfile.profile;
    }
  }
  if (typeof arg === "string") {
    return core.getTunnel(arg);
  }
  return undefined;
}

async function startTunnelCommand(ctx: CommandContext, arg?: unknown): Promise<void> {
  const profile = toTunnelFromArg(ctx.core, arg) ?? (await pickTunnel(ctx.core));
  if (!profile) {
    return;
  }
  const server = await resolveServerForTunnel(ctx.core, profile);
  if (!server) {
    return;
  }
  const connectionMode = await resolveTunnelConnectionMode(profile, true);
  if (!connectionMode) {
    return;
  }
  await startTunnel(ctx.core, ctx.tunnelManager, ctx.sshFactory, profile, server, connectionMode, ctx.registrySync);
}

async function stopTunnelCommand(ctx: CommandContext, arg?: unknown): Promise<void> {
  const profile = toTunnelFromArg(ctx.core, arg);
  if (profile) {
    await stopTunnelByProfile(ctx.core, ctx.tunnelManager, profile.id);
    return;
  }
  const active = ctx.core.getSnapshot().activeTunnels;
  if (active.length === 0) {
    return;
  }
  const pick = await vscode.window.showQuickPick(
    active.map((item) => {
      const prof = ctx.core.getTunnel(item.profileId);
      return {
        label: prof?.name ?? item.profileId,
        description: prof ? formatTunnelRoute(prof) : `${item.localPort} -> ${item.remoteIP}:${item.remotePort}`,
        active: item
      };
    }),
    { title: "Stop active tunnel" }
  );
  if (!pick) {
    return;
  }
  await ctx.tunnelManager.stop(pick.active.id);
}

function formValuesToTunnel(values: FormValues, existingId?: string, existingConnectionMode?: TunnelConnectionMode): TunnelProfile | undefined {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const tunnelType = (typeof values.tunnelType === "string" ? values.tunnelType : "local") as TunnelType;
  const serverId = typeof values.defaultServerId === "string" && values.defaultServerId ? values.defaultServerId : undefined;

  let localPort: number;
  let remoteIP: string;
  let remotePort: number;
  let remoteBindAddress: string | undefined;
  let localTargetIP: string | undefined;

  switch (tunnelType) {
    case "reverse":
      localPort = typeof values.localPort_reverse === "number" ? values.localPort_reverse : 0;
      remotePort = typeof values.remotePort_reverse === "number" ? values.remotePort_reverse : 0;
      remoteBindAddress = typeof values.remoteBindAddress === "string" ? values.remoteBindAddress.trim() : "127.0.0.1";
      localTargetIP = typeof values.localTargetIP === "string" ? values.localTargetIP.trim() : "127.0.0.1";
      remoteIP = remoteBindAddress;
      break;
    case "dynamic":
      localPort = typeof values.localPort_dynamic === "number" ? values.localPort_dynamic : 1080;
      remoteIP = "0.0.0.0";
      remotePort = 0;
      break;
    default:
      localPort = typeof values.localPort === "number" ? values.localPort : 0;
      remoteIP = typeof values.remoteIP === "string" ? values.remoteIP.trim() : "127.0.0.1";
      remotePort = typeof values.remotePort === "number" ? values.remotePort : 0;
      break;
  }

  // Force shared mode for reverse tunnels
  const connectionMode = tunnelType === "reverse" ? "shared" : existingConnectionMode;

  const notes = typeof values.notes === "string" ? values.notes.trim() : undefined;

  return {
    id: existingId ?? randomUUID(),
    name,
    localPort,
    remoteIP,
    remotePort,
    defaultServerId: serverId,
    autoStart: values.autoStart === true,
    connectionMode,
    tunnelType: tunnelType === "local" ? undefined : tunnelType,
    remoteBindAddress,
    localTargetIP,
    notes: notes || undefined
  };
}

export function registerTunnelCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.tunnel.add", () => {
      const servers = ctx.core.getSnapshot().servers.filter((s) => !s.isHidden);
      const definition = tunnelFormDefinition(undefined, {
        servers,
        defaultBindAddress: getDefaultReverseBindAddress()
      });
      const panel = WebviewFormPanel.open("tunnel-add", definition, {
        onSubmit: async (values) => {
          const profile = formValuesToTunnel(values);
          if (!profile) {
            return;
          }
          await ctx.core.addOrUpdateTunnel(profile);
        },
        onCreateInline: (key) => {
          if (key === "defaultServerId") {
            const existingGroups = collectGroups(ctx);
            const serverDef = serverFormDefinition(undefined, existingGroups, getDefaultSessionTranscriptsEnabled());
            WebviewFormPanel.open("tunnel-add-server", serverDef, {
              onSubmit: async (serverValues) => {
                const server = formValuesToServer(serverValues);
                if (!server) {
                  return;
                }
                await ctx.core.addOrUpdateServer(server);
                panel.addSelectOption("defaultServerId", server.id, server.name);
              },
              onBrowse: browseForKey
            });
          }
        }
      });
    }),

    vscode.commands.registerCommand("nexus.tunnel.edit", async (arg?: unknown) => {
      const existing = toTunnelFromArg(ctx.core, arg) ?? (await pickTunnel(ctx.core));
      if (!existing) {
        return;
      }
      const servers = ctx.core.getSnapshot().servers.filter((s) => !s.isHidden);
      const definition = tunnelFormDefinition(existing, {
        servers,
        defaultBindAddress: getDefaultReverseBindAddress()
      });
      const panel = WebviewFormPanel.open("tunnel-edit", definition, {
        onSubmit: async (values) => {
          const updated = formValuesToTunnel(values, existing.id, existing.connectionMode);
          if (!updated) {
            return;
          }

          const previousActive = ctx.core
            .getSnapshot()
            .activeTunnels.find((tunnel) => tunnel.profileId === existing.id);
          await ctx.core.addOrUpdateTunnel(updated);

          if (!previousActive || !isTunnelRouteChanged(existing, updated)) {
            return;
          }

          const restartChoice = await vscode.window.showWarningMessage(
            `Tunnel "${updated.name}" route changed while active. Restart now to apply new route?`,
            "Restart now",
            "Keep current route"
          );
          if (restartChoice !== "Restart now") {
            void vscode.window.showInformationMessage("Route changes will apply the next time the tunnel starts.");
            return;
          }

          await ctx.tunnelManager.stop(previousActive.id);
          const server = ctx.core.getServer(previousActive.serverId);
          if (!server) {
            void vscode.window.showWarningMessage(
              "Tunnel stopped. Could not restart automatically because its server profile is unavailable."
            );
            return;
          }
          const mode = await resolveTunnelConnectionMode(updated, false);
          if (!mode) {
            return;
          }
          await startTunnel(ctx.core, ctx.tunnelManager, ctx.sshFactory, updated, server, mode, ctx.registrySync);
        },
        onCreateInline: (key) => {
          if (key === "defaultServerId") {
            const existingGroups = collectGroups(ctx);
            const serverDef = serverFormDefinition(undefined, existingGroups, getDefaultSessionTranscriptsEnabled());
            WebviewFormPanel.open("tunnel-edit-server", serverDef, {
              onSubmit: async (serverValues) => {
                const server = formValuesToServer(serverValues);
                if (!server) {
                  return;
                }
                await ctx.core.addOrUpdateServer(server);
                panel.addSelectOption("defaultServerId", server.id, server.name);
              },
              onBrowse: browseForKey
            });
          }
        }
      });
    }),

    vscode.commands.registerCommand("nexus.tunnel.remove", async (arg?: unknown) => {
      const profile = toTunnelFromArg(ctx.core, arg) ?? (await pickTunnel(ctx.core));
      if (!profile) {
        return;
      }
      const isRemote = ctx.core.getSnapshot().remoteTunnels.some((r) => r.profileId === profile.id);
      const confirmMsg = isRemote
        ? `Tunnel "${profile.name}" is running in another window. Removing the profile won't stop the running tunnel. Remove anyway?`
        : `Remove tunnel "${profile.name}"?`;
      const confirm = await vscode.window.showWarningMessage(
        confirmMsg,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      await stopTunnelByProfile(ctx.core, ctx.tunnelManager, profile.id);
      await ctx.core.removeTunnel(profile.id);
    }),

    vscode.commands.registerCommand("nexus.tunnel.start", (arg?: unknown) => startTunnelCommand(ctx, arg)),
    vscode.commands.registerCommand("nexus.tunnel.stop", (arg?: unknown) => stopTunnelCommand(ctx, arg)),

    vscode.commands.registerCommand("nexus.tunnel.restart", async (arg?: unknown) => {
      const profile = toTunnelFromArg(ctx.core, arg);
      if (!profile) {
        return;
      }
      const active = ctx.core.getSnapshot().activeTunnels.find((t) => t.profileId === profile.id);
      if (!active) {
        return;
      }
      const server = ctx.core.getServer(active.serverId);
      if (!server) {
        return;
      }
      await ctx.tunnelManager.stop(active.id);
      const mode = await resolveTunnelConnectionMode(profile, false);
      if (!mode) {
        return;
      }
      await startTunnel(ctx.core, ctx.tunnelManager, ctx.sshFactory, profile, server, mode, ctx.registrySync);
    }),

    vscode.commands.registerCommand("nexus.tunnel.copyInfo", async (arg?: unknown) => {
      const profile = toTunnelFromArg(ctx.core, arg) ?? (await pickTunnel(ctx.core));
      if (!profile) {
        return;
      }
      const info = formatTunnelRoute(profile);
      await vscode.env.clipboard.writeText(info);
      void vscode.window.showInformationMessage(`Copied: ${info}`);
    }),

    vscode.commands.registerCommand("nexus.tunnel.openBrowser", (arg?: unknown) => {
      if (arg instanceof TunnelTreeItem && (arg.activeTunnelId || arg.isRemote)) {
        // Reverse tunnels have no local listener to open
        if (resolveTunnelType(arg.profile) === "reverse") {
          void vscode.window.showInformationMessage("Reverse tunnels listen on the remote side, not locally.");
          return;
        }
        const url = `http://localhost:${arg.profile.localPort}`;
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),

    vscode.commands.registerCommand("nexus.tunnel.duplicate", async (arg?: unknown) => {
      const profile = toTunnelFromArg(ctx.core, arg) ?? (await pickTunnel(ctx.core));
      if (!profile) {
        return;
      }
      const copy = { ...profile, id: randomUUID(), name: `${profile.name} (copy)` };
      await ctx.core.addOrUpdateTunnel(copy);
    })
  ];
}
