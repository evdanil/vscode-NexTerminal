import * as vscode from "vscode";
import type { UnifiedProfileSeed } from "../ui/formDefinitions";
import { unifiedProfileFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { FolderTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { formValuesToServer, browseForKey, collectGroups, syncProxyPasswordSecret } from "./serverCommands";
import { AuthProfileEditorPanel } from "../ui/authProfileEditorPanel";
import { authProfilePasswordSecretKey, passwordSecretKey } from "../services/ssh/silentAuth";
import { formValuesToSerial, scanForPort } from "./serialCommands";
import type { CommandContext } from "./types";
import {
  normalizeFolderPath,
  normalizeOptionalFolderPath,
  INVALID_FOLDER_PATH_MESSAGE,
  folderDisplayName,
  isDescendantOrSelf,
  MAX_FOLDER_DEPTH
} from "../utils/folderPaths";

export function openUnifiedForm(ctx: CommandContext, seed?: UnifiedProfileSeed): void {
  const existingGroups = collectGroups(ctx);
  const defaultLogSession = vscode.workspace.getConfiguration("nexus.logging").get<boolean>("sessionTranscripts", true);
  const snapshot = ctx.core.getSnapshot();
  const serverList = snapshot.servers.map((s) => ({ id: s.id, name: s.name }));
  const definition = unifiedProfileFormDefinition(seed, existingGroups, defaultLogSession, serverList, snapshot.authProfiles);
  const panel = WebviewFormPanel.open("profile-add", definition, {
    onSubmit: async (values: FormValues) => {
      if (normalizeOptionalFolderPath(values.group) === null) {
        throw new Error(INVALID_FOLDER_PATH_MESSAGE);
      }
      if (values.profileType === "serial") {
        const profile = formValuesToSerial(values);
        if (!profile) {
          return;
        }
        await ctx.core.addOrUpdateSerialProfile(profile);
      } else {
        const server = formValuesToServer(values);
        if (!server) {
          return;
        }
        await ctx.core.addOrUpdateServer(server);
        await syncProxyPasswordSecret(ctx, server.id, values);
        // Copy auth profile password to server if profile was selected
        const authProfileId = typeof values.authProfileId === "string" ? values.authProfileId : "";
        if (authProfileId && ctx.secretVault) {
          const profilePw = await ctx.secretVault.get(authProfilePasswordSecretKey(authProfileId));
          if (profilePw) {
            await ctx.secretVault.store(passwordSecretKey(server.id), profilePw);
          }
        }
      }
    },
    onBrowse: browseForKey,
    onScan: () => scanForPort(ctx),
    onCreateInline: (key) => {
      if (key === "authProfileId") {
        AuthProfileEditorPanel.openNew(ctx.core, ctx.secretVault);
        const knownIds = new Set(snapshot.authProfiles.map((p) => p.id));
        const unsub = ctx.core.onDidChange(() => {
          const newProfiles = ctx.core.getSnapshot().authProfiles;
          const added = newProfiles.find((p) => !knownIds.has(p.id));
          if (added) {
            panel.addSelectOption("authProfileId", added.id, `${added.name} — ${added.authType} — ${added.username}`);
            unsub();
          }
        });
      }
    },
    onAutofill: async (_key, value) => {
      const profile = ctx.core.getAuthProfile(value);
      if (!profile) {
        return undefined;
      }
      return {
        username: profile.username,
        authType: profile.authType,
        ...(profile.keyPath ? { keyPath: profile.keyPath } : {})
      };
    }
  });
}

export function registerProfileCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.profile.add", (arg?: unknown) => {
      const group = arg instanceof FolderTreeItem ? arg.folderPath : undefined;
      openUnifiedForm(ctx, { profileType: "ssh", group });
    }),

    vscode.commands.registerCommand("nexus.group.add", async (arg?: unknown) => {
      const parentPath = arg instanceof FolderTreeItem ? arg.folderPath : undefined;
      const parentDepth = parentPath ? parentPath.split("/").length : 0;
      if (parentDepth >= MAX_FOLDER_DEPTH) {
        void vscode.window.showWarningMessage(`Maximum folder nesting depth is ${MAX_FOLDER_DEPTH} levels.`);
        return;
      }
      const title = parentPath ? `New Subfolder in "${folderDisplayName(parentPath)}"` : "New Folder";
      const name = await vscode.window.showInputBox({
        title,
        prompt: "Enter folder name",
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return "Folder name cannot be empty";
          }
          if (trimmed.includes("/")) {
            return "Folder name cannot contain '/'";
          }
          const fullPath = parentPath ? parentPath + "/" + trimmed : trimmed;
          if (!normalizeFolderPath(fullPath)) {
            return "Invalid folder name";
          }
          const allGroups = new Set(collectGroups(ctx));
          if (allGroups.has(fullPath)) {
            return "A folder with this name already exists";
          }
          return null;
        }
      });
      if (!name) {
        return;
      }
      const fullPath = parentPath ? parentPath + "/" + name.trim() : name.trim();
      await ctx.core.addGroup(fullPath);
    }),

    vscode.commands.registerCommand("nexus.group.remove", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const folderPath = arg.folderPath;
      const items = ctx.core.getItemsInFolder(folderPath, true);
      const hasContents = items.servers.length > 0 || items.serialProfiles.length > 0;

      if (!hasContents) {
        // Empty folder — remove silently
        await ctx.core.removeFolderCascade(folderPath, false);
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Remove folder "${folderDisplayName(folderPath)}"? It contains ${items.servers.length + items.serialProfiles.length} item(s).`,
        { modal: true },
        "Move to parent",
        "Delete contents"
      );
      if (choice === "Move to parent") {
        await ctx.core.removeFolderCascade(folderPath, false);
      } else if (choice === "Delete contents") {
        await ctx.core.removeFolderCascade(folderPath, true);
      }
    })
  ];
}
