import * as vscode from "vscode";
import type { NexusCore } from "../core/nexusCore";
import type {
  ResolvedTunnelConnectionMode,
  ServerConfig,
  TunnelConnectionMode,
  TunnelProfile
} from "../models/config";
import type { SilentAuthSshFactory } from "../services/ssh/silentAuth";
import type { TunnelManager } from "../services/tunnel/tunnelManager";
import { TunnelTreeItem } from "../ui/tunnelTreeProvider";
import { promptTunnelProfile } from "../ui/prompts";
import { isTunnelRouteChanged } from "../utils/tunnelProfile";
import type { CommandContext } from "./types";

export function getDefaultTunnelConnectionMode(): ResolvedTunnelConnectionMode {
  const configured = vscode.workspace
    .getConfiguration("nexus.tunnel")
    .get<ResolvedTunnelConnectionMode>("defaultConnectionMode", "isolated");
  return configured === "shared" ? "shared" : "isolated";
}

export async function resolveTunnelConnectionMode(
  profile: TunnelProfile,
  interactive: boolean
): Promise<ResolvedTunnelConnectionMode | undefined> {
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
  sshFactory: SilentAuthSshFactory,
  profile: TunnelProfile,
  server: ServerConfig,
  connectionMode: ResolvedTunnelConnectionMode
): Promise<void> {
  if (core.getSnapshot().activeTunnels.some((tunnel) => tunnel.profileId === profile.id)) {
    void vscode.window.showInformationMessage(`Tunnel "${profile.name}" is already running.`);
    return;
  }

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
      description: `${profile.localPort} -> ${profile.remoteIP}:${profile.remotePort}`,
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
  await startTunnel(ctx.core, ctx.tunnelManager, ctx.sshFactory, profile, server, connectionMode);
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
    active.map((item) => ({
      label: ctx.core.getTunnel(item.profileId)?.name ?? item.profileId,
      description: `${item.localPort} -> ${item.remoteIP}:${item.remotePort}`,
      active: item
    })),
    { title: "Stop active tunnel" }
  );
  if (!pick) {
    return;
  }
  await ctx.tunnelManager.stop(pick.active.id);
}

export function registerTunnelCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.tunnel.add", async () => {
      const profile = await promptTunnelProfile(undefined, { mode: "add" });
      if (!profile) {
        return;
      }
      const servers = ctx.core.getSnapshot().servers.filter((s) => !s.isHidden);
      if (servers.length > 0) {
        const pick = await vscode.window.showQuickPick(
          servers.map((server) => ({
            label: server.name,
            description: `${server.username}@${server.host}:${server.port}`,
            server
          })),
          { title: "Select Nexus Server" }
        );
        if (pick) {
          profile.defaultServerId = pick.server.id;
        }
      }
      await ctx.core.addOrUpdateTunnel(profile);
    }),

    vscode.commands.registerCommand("nexus.tunnel.edit", async (arg?: unknown) => {
      const existing = toTunnelFromArg(ctx.core, arg) ?? (await pickTunnel(ctx.core));
      if (!existing) {
        return;
      }
      const updated = await promptTunnelProfile(existing, { mode: "edit" });
      if (!updated) {
        return;
      }
      updated.id = existing.id;
      updated.defaultServerId = existing.defaultServerId;

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
      await startTunnel(ctx.core, ctx.tunnelManager, ctx.sshFactory, updated, server, mode);
    }),

    vscode.commands.registerCommand("nexus.tunnel.remove", async (arg?: unknown) => {
      const profile = toTunnelFromArg(ctx.core, arg) ?? (await pickTunnel(ctx.core));
      if (!profile) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove tunnel "${profile.name}"?`,
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
    vscode.commands.registerCommand("nexus.tunnel.stop", (arg?: unknown) => stopTunnelCommand(ctx, arg))
  ];
}
