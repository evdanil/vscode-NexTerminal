import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { AuthProfile, AuthType } from "../models/config";
import { authProfileFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { FolderTreeItem, ServerTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { authProfilePasswordSecretKey, passwordSecretKey } from "../services/ssh/silentAuth";
import { isDescendantOrSelf } from "../utils/folderPaths";
import { browseForKey } from "./serverCommands";
import type { CommandContext } from "./types";

const VALID_AUTH_TYPES = new Set<string>(["password", "key", "agent"]);
function isAuthType(value: unknown): value is AuthType {
  return typeof value === "string" && VALID_AUTH_TYPES.has(value);
}

function formValuesToAuthProfile(values: FormValues, existingId?: string): AuthProfile | undefined {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  const username = typeof values.username === "string" ? values.username.trim() : "";
  if (!name || !username) {
    return undefined;
  }
  return {
    id: existingId ?? randomUUID(),
    name,
    username,
    authType: isAuthType(values.authType) ? values.authType : "password",
    keyPath: typeof values.keyPath === "string" && values.keyPath ? values.keyPath : undefined
  };
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

async function applyAuthProfileToServers(
  ctx: CommandContext,
  profile: AuthProfile,
  servers: import("../models/config").ServerConfig[]
): Promise<void> {
  const profilePw = ctx.secretVault
    ? await ctx.secretVault.get(authProfilePasswordSecretKey(profile.id))
    : undefined;
  for (const server of servers) {
    const updated = {
      ...server,
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
      const definition = authProfileFormDefinition();
      WebviewFormPanel.open("authProfile-add", definition, {
        onSubmit: async (values) => {
          const profile = formValuesToAuthProfile(values);
          if (!profile) {
            return;
          }
          await ctx.core.addOrUpdateAuthProfile(profile);
          const password = typeof values.password === "string" ? values.password : "";
          if (ctx.secretVault) {
            const key = authProfilePasswordSecretKey(profile.id);
            if (profile.authType === "password" && password) {
              await ctx.secretVault.store(key, password);
            } else {
              await ctx.secretVault.delete(key);
            }
          }
          void vscode.window.showInformationMessage(`Auth profile "${profile.name}" created.`);
        },
        onBrowse: browseForKey
      });
    }),

    vscode.commands.registerCommand("nexus.authProfile.manage", async () => {
      const profiles = ctx.core.getSnapshot().authProfiles;
      if (profiles.length === 0) {
        const create = await vscode.window.showInformationMessage(
          "No auth profiles configured.",
          "Create One"
        );
        if (create === "Create One") {
          void vscode.commands.executeCommand("nexus.authProfile.add");
        }
        return;
      }

      type ProfilePickItem = vscode.QuickPickItem & { profile: AuthProfile; action?: "edit" | "delete" };
      const items: ProfilePickItem[] = [];
      for (const p of profiles) {
        items.push(
          { label: `$(edit) Edit: ${p.name}`, description: `${p.authType} — ${p.username}`, profile: p, action: "edit" },
          { label: `$(trash) Delete: ${p.name}`, description: `${p.authType} — ${p.username}`, profile: p, action: "delete" }
        );
      }

      const pick = await vscode.window.showQuickPick(items, { title: "Manage Auth Profiles" });
      if (!pick) {
        return;
      }

      if (pick.action === "delete") {
        const confirm = await vscode.window.showWarningMessage(
          `Delete auth profile "${pick.profile.name}"?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }
        if (ctx.secretVault) {
          await ctx.secretVault.delete(authProfilePasswordSecretKey(pick.profile.id));
        }
        await ctx.core.removeAuthProfile(pick.profile.id);
        void vscode.window.showInformationMessage(`Auth profile "${pick.profile.name}" deleted.`);
        return;
      }

      // Edit
      const existing = pick.profile;
      const definition = authProfileFormDefinition(existing);
      WebviewFormPanel.open("authProfile-edit", definition, {
        onSubmit: async (values) => {
          const updated = formValuesToAuthProfile(values, existing.id);
          if (!updated) {
            return;
          }
          await ctx.core.addOrUpdateAuthProfile(updated);
          const password = typeof values.password === "string" ? values.password : "";
          if (ctx.secretVault) {
            const key = authProfilePasswordSecretKey(updated.id);
            if (updated.authType !== "password") {
              await ctx.secretVault.delete(key);
            } else if (password) {
              await ctx.secretVault.store(key, password);
            } else if (existing.authType !== "password") {
              // Don't retain stale password when switching from key/agent to password with no new secret.
              await ctx.secretVault.delete(key);
            }
          }
          void vscode.window.showInformationMessage(`Auth profile "${updated.name}" updated.`);
        },
        onBrowse: browseForKey
      });
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
        `Apply "${profile.name}" to ${servers.length} server(s) in "${folderPath}"?\nThis overwrites their authentication settings.`,
        { modal: true },
        "Apply"
      );
      if (confirm !== "Apply") {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Applying auth profile "${profile.name}"...` },
        () => applyAuthProfileToServers(ctx, profile, servers)
      );
      void vscode.window.showInformationMessage(`Applied auth profile "${profile.name}" to ${servers.length} server(s).`);
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
      void vscode.window.showInformationMessage(`Applied auth profile "${profile.name}" to "${server.name}".`);
    })
  ];
}
