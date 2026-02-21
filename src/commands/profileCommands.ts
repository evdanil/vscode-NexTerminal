import * as vscode from "vscode";
import type { UnifiedProfileSeed } from "../ui/formDefinitions";
import { unifiedProfileFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { FolderTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { formValuesToServer, browseForKey, collectGroups } from "./serverCommands";
import { formValuesToSerial, scanForPort } from "./serialCommands";
import type { CommandContext } from "./types";
import { normalizeFolderPath, folderDisplayName, isDescendantOrSelf, MAX_FOLDER_DEPTH } from "../utils/folderPaths";

export function openUnifiedForm(ctx: CommandContext, seed?: UnifiedProfileSeed): void {
  const existingGroups = collectGroups(ctx);
  const defaultLogSession = vscode.workspace.getConfiguration("nexus.logging").get<boolean>("sessionTranscripts", true);
  const definition = unifiedProfileFormDefinition(seed, existingGroups, defaultLogSession);
  WebviewFormPanel.open("profile-add", definition, {
    onSubmit: async (values: FormValues) => {
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
      }
    },
    onBrowse: browseForKey,
    onScan: () => scanForPort(ctx)
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
