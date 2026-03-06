import * as vscode from "vscode";
import type { AuthProfile } from "../models/config";
import { FolderTreeItem, ServerTreeItem } from "../ui/nexusTreeProvider";
import { AuthProfileEditorPanel } from "../ui/authProfileEditorPanel";
import { isDescendantOrSelf } from "../utils/folderPaths";
import type { CommandContext } from "./types";

async function pickAuthProfile(ctx: CommandContext): Promise<AuthProfile | undefined> {
  const profiles = ctx.core.getSnapshot().authProfiles;
  if (profiles.length === 0) {
    void vscode.window.showWarningMessage("No auth profiles configured. Create one first.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.name,
      description: `${p.authType} — ${p.username}`,
      profile: p
    })),
    { title: "Select Auth Profile" }
  );
  return pick?.profile;
}

async function applyAuthProfileToServers(
  ctx: CommandContext,
  profile: AuthProfile,
  servers: import("../models/config").ServerConfig[]
): Promise<void> {
  for (const server of servers) {
    await ctx.core.addOrUpdateServer({ ...server, authProfileId: profile.id });
  }
}

export function registerAuthProfileCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.authProfile.add", () => {
      AuthProfileEditorPanel.openNew(ctx.core, ctx.secretVault);
    }),

    vscode.commands.registerCommand("nexus.authProfile.manage", () => {
      AuthProfileEditorPanel.open(ctx.core, ctx.secretVault);
    }),

    vscode.commands.registerCommand("nexus.authProfile.applyToFolder", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const folderPath = arg.folderPath;
      const profile = await pickAuthProfile(ctx);
      if (!profile) {
        return;
      }
      const servers = ctx.core.getSnapshot().servers.filter(
        (s) => s.group && isDescendantOrSelf(s.group, folderPath)
      );
      if (servers.length === 0) {
        void vscode.window.showInformationMessage("No servers in this folder.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Link "${profile.name}" to ${servers.length} server(s) in "${folderPath}"?\nThis links their credentials to the auth profile.`,
        { modal: true },
        "Link"
      );
      if (confirm !== "Link") {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Linking auth profile "${profile.name}"...` },
        () => applyAuthProfileToServers(ctx, profile, servers)
      );
      void vscode.window.showInformationMessage(`Linked auth profile "${profile.name}" to ${servers.length} server(s).`);
    }),

    vscode.commands.registerCommand("nexus.authProfile.applyToServer", async (arg?: unknown) => {
      let server: import("../models/config").ServerConfig | undefined;
      if (arg instanceof ServerTreeItem) {
        server = arg.server;
      }
      if (!server) {
        return;
      }
      const profile = await pickAuthProfile(ctx);
      if (!profile) {
        return;
      }
      await applyAuthProfileToServers(ctx, profile, [server]);
      void vscode.window.showInformationMessage(`Linked auth profile "${profile.name}" to "${server.name}".`);
    })
  ];
}
