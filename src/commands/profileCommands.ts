import * as vscode from "vscode";
import type { UnifiedProfileSeed } from "../ui/formDefinitions";
import { unifiedProfileFormDefinition, unifiedProfileFormId } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { FolderTreeItem, LocalShellProfileTreeItem, SerialProfileTreeItem, ServerTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { formValuesToServer, browseForKey, collectGroups, syncProxyPasswordSecret } from "./serverCommands";
import { formValuesToSerial, scanForPort } from "./serialCommands";
import { formValuesToLocalShell, getConfiguredVscodeTerminalProfileNames } from "./localShellCommands";
import type { CommandContext } from "./types";
import { createInlineAuthProfileCreation } from "./inlineAuthProfileCreation";
import {
  normalizeFolderPath,
  normalizeOptionalFolderPath,
  INVALID_FOLDER_PATH_MESSAGE,
  folderDisplayName,
  isDescendantOrSelf,
  MAX_FOLDER_DEPTH
} from "../utils/folderPaths";

interface ProfileActionPick extends vscode.QuickPickItem {
  command: string;
}

function isUnifiedProfileSeed(arg: unknown): arg is UnifiedProfileSeed {
  if (!arg || typeof arg !== "object") {
    return false;
  }
  const candidate = arg as Partial<UnifiedProfileSeed>;
  return candidate.profileType === "ssh" ||
    candidate.profileType === "serial" ||
    candidate.profileType === "localShell" ||
    candidate.addMode === "profile" ||
    candidate.addMode === "ssh" ||
    candidate.addMode === "serial" ||
    candidate.addMode === "localShell" ||
    typeof candidate.group === "string";
}

export function openUnifiedForm(ctx: CommandContext, seed?: UnifiedProfileSeed): void {
  const existingGroups = collectGroups(ctx);
  const defaultLogSession = vscode.workspace.getConfiguration("nexus.logging").get<boolean>("sessionTranscripts", true);
  const snapshot = ctx.core.getSnapshot();
  const serverList = snapshot.servers.map((s) => ({ id: s.id, name: s.name }));
  const definition = unifiedProfileFormDefinition(seed, existingGroups, defaultLogSession, serverList, snapshot.authProfiles, {
    vscodeTerminalProfileNames: getConfiguredVscodeTerminalProfileNames()
  });
  const addMode = seed?.addMode ?? "profile";
  definition.testable = addMode !== "localShell";
  if (addMode === "profile") {
    definition.testableWhen = { field: "profileType", value: ["ssh", "serial"] };
  }
  const inlineAuthProfile = createInlineAuthProfileCreation(ctx);
  const panel = WebviewFormPanel.open(unifiedProfileFormId(seed), definition, {
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
      } else if (values.profileType === "localShell") {
        const profile = formValuesToLocalShell(values);
        if (!profile) {
          throw new Error("Fill in the required local shell fields before saving.");
        }
        await ctx.core.addOrUpdateLocalShellProfile(profile);
      } else {
        const server = formValuesToServer(values);
        if (!server) {
          return;
        }
        await ctx.core.addOrUpdateServer(server);
        await syncProxyPasswordSecret(ctx, server.id, values);
      }
    },
    onBrowse: browseForKey,
    onScan: () => scanForPort(ctx),
    onCreateInline: inlineAuthProfile.handleCreateInline,
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
    },
    onTest: async (values: FormValues) => {
      if (values.profileType === "serial") {
        const draft = formValuesToSerial(values);
        if (!draft) {
          void vscode.window.showWarningMessage("Fill in the required serial fields (Name, Port) before testing.");
          return;
        }
        await vscode.commands.executeCommand("nexus.serial.testConnection", { profile: draft });
      } else if (values.profileType === "localShell") {
        return;
      } else {
        const draft = formValuesToServer(values);
        if (!draft) {
          void vscode.window.showWarningMessage("Fill in the required fields (Name, Host, Username) before testing.");
          return;
        }
        await vscode.commands.executeCommand("nexus.server.testConnection", { server: draft });
      }
    }
  });
  inlineAuthProfile.attachPanel(panel);
}

export function registerProfileCommands(ctx: CommandContext): vscode.Disposable[] {
  const showProfileActions = async (arg?: unknown): Promise<void> => {
    if (arg instanceof ServerTreeItem) {
      const picks: ProfileActionPick[] = [
        { label: "Connect", command: "nexus.server.connect" },
        { label: "Test Connection", command: "nexus.server.testConnection" },
        ...(ctx.core.isServerConnected(arg.server.id)
          ? [{ label: "Browse Files", command: "nexus.files.browse" }]
          : []),
        { label: "Connect and Run Script", command: "nexus.server.runWithScript" },
        { label: "Edit", command: "nexus.server.edit" },
        { label: "Duplicate", command: "nexus.server.duplicate" },
        { label: "Copy Connection Info", command: "nexus.server.copyInfo" },
        { label: "Delete", command: "nexus.server.remove" }
      ];
      const picked = await vscode.window.showQuickPick(picks, { title: "Profile Actions" });
      if (picked) {
        await vscode.commands.executeCommand(picked.command, arg);
      }
      return;
    }

    if (arg instanceof SerialProfileTreeItem) {
      const picks: ProfileActionPick[] = [
        { label: "Connect", command: "nexus.serial.connect" },
        { label: "Test Connection", command: "nexus.serial.testConnection" },
        { label: "Connect and Run Script", command: "nexus.serial.runWithScript" },
        { label: "Edit", command: "nexus.serial.edit" },
        { label: "Duplicate", command: "nexus.serial.duplicate" },
        { label: "Copy Port Info", command: "nexus.serial.copyInfo" },
        { label: "Delete", command: "nexus.serial.remove" }
      ];
      const picked = await vscode.window.showQuickPick(picks, { title: "Profile Actions" });
      if (picked) {
        await vscode.commands.executeCommand(picked.command, arg);
      }
      return;
    }

    if (arg instanceof LocalShellProfileTreeItem) {
      const picks: ProfileActionPick[] = [
        { label: "Open Local Shell", command: "nexus.localShell.connect" },
        { label: "Edit", command: "nexus.localShell.edit" },
        { label: "Duplicate", command: "nexus.localShell.duplicate" },
        { label: "Copy Shell Info", command: "nexus.localShell.copyInfo" },
        { label: "Delete", command: "nexus.localShell.remove" }
      ];
      const picked = await vscode.window.showQuickPick(picks, { title: "Profile Actions" });
      if (picked) {
        await vscode.commands.executeCommand(picked.command, arg);
      }
    }
  };

  return [
    vscode.commands.registerCommand("nexus.profile.add", (arg?: unknown) => {
      if (arg instanceof FolderTreeItem) {
        openUnifiedForm(ctx, { group: arg.folderPath });
        return;
      }
      openUnifiedForm(ctx, isUnifiedProfileSeed(arg) ? arg : undefined);
    }),

    vscode.commands.registerCommand("nexus.profile.actions", showProfileActions),

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
      const itemCount = items.servers.length + items.serialProfiles.length + items.localShellProfiles.length;
      const hasContents = itemCount > 0;

      if (!hasContents) {
        // Empty folder — remove silently
        await ctx.core.removeFolderCascade(folderPath, false);
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Remove folder "${folderDisplayName(folderPath)}"? It contains ${itemCount} item(s).`,
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
