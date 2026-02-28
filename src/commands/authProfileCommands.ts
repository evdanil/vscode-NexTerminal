import * as vscode from "vscode";
import type { AuthProfile, ServerConfig } from "../models/config";
import { FolderTreeItem, ServerTreeItem } from "../ui/nexusTreeProvider";
import { AuthProfileEditorPanel } from "../ui/authProfileEditorPanel";
import { authProfilePasswordSecretKey, passwordSecretKey } from "../services/ssh/silentAuth";
import { isDescendantOrSelf } from "../utils/folderPaths";
import type { CommandContext } from "./types";

type CommandCenterItem = FolderTreeItem | ServerTreeItem;

function resolveCommandCenterItems(arg: unknown, allSelected: unknown): CommandCenterItem[] {
  if (Array.isArray(allSelected) && allSelected.length > 0) {
    const selectedItems = allSelected.filter(
      (item): item is CommandCenterItem =>
        item instanceof FolderTreeItem || item instanceof ServerTreeItem
    );
    if (selectedItems.length > 0) {
      return selectedItems;
    }
  }
  if (arg instanceof FolderTreeItem || arg instanceof ServerTreeItem) {
    return [arg];
  }
  return [];
}

function collectServersFromSelection(
  items: CommandCenterItem[],
  allServers: ServerConfig[]
): ServerConfig[] {
  const seen = new Set<string>();
  const result: ServerConfig[] = [];
  for (const item of items) {
    if (item instanceof ServerTreeItem) {
      if (!seen.has(item.server.id)) {
        seen.add(item.server.id);
        result.push(item.server);
      }
    } else if (item instanceof FolderTreeItem) {
      for (const s of allServers) {
        if (s.group && isDescendantOrSelf(s.group, item.folderPath) && !seen.has(s.id)) {
          seen.add(s.id);
          result.push(s);
        }
      }
    }
  }
  return result;
}

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

async function confirmApply(profile: AuthProfile, count: number): Promise<boolean> {
  const confirm = await vscode.window.showWarningMessage(
    `Apply "${profile.name}" to ${count} server(s)?\nThis overwrites their authentication settings.`,
    { modal: true },
    "Apply"
  );
  return confirm === "Apply";
}

async function applyAuthProfileToServers(
  ctx: CommandContext,
  profile: AuthProfile,
  servers: import("../models/config").ServerConfig[]
): Promise<void> {
  const profilePw = ctx.secretVault
    ? await ctx.secretVault.get(authProfilePasswordSecretKey(profile.id))
    : undefined;
  for (const server of servers) {
    const current = ctx.core.getServer(server.id) ?? server;
    const updated = {
      ...current,
      username: profile.username,
      authType: profile.authType,
      keyPath: profile.keyPath
    };
    await ctx.core.addOrUpdateServer(updated);
    if (!ctx.secretVault) {
      continue;
    }
    if (profile.authType === "password" && profilePw) {
      await ctx.secretVault.store(passwordSecretKey(server.id), profilePw);
    } else {
      await ctx.secretVault.delete(passwordSecretKey(server.id));
    }
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

    vscode.commands.registerCommand("nexus.authProfile.applyToFolder", async (arg?: unknown, allSelected?: unknown) => {
      const items = resolveCommandCenterItems(arg, allSelected);
      if (items.length === 0) {
        return;
      }
      const servers = collectServersFromSelection(items, ctx.core.getSnapshot().servers);
      if (servers.length === 0) {
        void vscode.window.showInformationMessage("No servers found in selection.");
        return;
      }
      const profile = await pickAuthProfile(ctx);
      if (!profile) {
        return;
      }
      if (!await confirmApply(profile, servers.length)) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Applying auth profile "${profile.name}"...` },
        () => applyAuthProfileToServers(ctx, profile, servers)
      );
      void vscode.window.showInformationMessage(`Applied auth profile "${profile.name}" to ${servers.length} server(s).`);
    }),

    vscode.commands.registerCommand("nexus.authProfile.applyToServer", async (arg?: unknown, allSelected?: unknown) => {
      const items = resolveCommandCenterItems(arg, allSelected);
      if (items.length === 0) {
        return;
      }
      const servers = collectServersFromSelection(items, ctx.core.getSnapshot().servers);
      if (servers.length === 0) {
        return;
      }
      const profile = await pickAuthProfile(ctx);
      if (!profile) {
        return;
      }
      if (servers.length > 1 && !await confirmApply(profile, servers.length)) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Applying auth profile "${profile.name}"...` },
        () => applyAuthProfileToServers(ctx, profile, servers)
      );
      if (servers.length === 1) {
        void vscode.window.showInformationMessage(`Applied auth profile "${profile.name}" to "${servers[0].name}".`);
      } else {
        void vscode.window.showInformationMessage(`Applied auth profile "${profile.name}" to ${servers.length} server(s).`);
      }
    })
  ];
}
