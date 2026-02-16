import * as vscode from "vscode";
import type { UnifiedProfileSeed } from "../ui/formDefinitions";
import { unifiedProfileFormDefinition } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { GroupTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { formValuesToServer, browseForKey, collectGroups } from "./serverCommands";
import { formValuesToSerial } from "./serialCommands";
import type { CommandContext } from "./types";

export function openUnifiedForm(ctx: CommandContext, seed?: UnifiedProfileSeed): void {
  const existingGroups = collectGroups(ctx);
  const definition = unifiedProfileFormDefinition(seed, existingGroups);
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
    onBrowse: browseForKey
  });
}

export function registerProfileCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.profile.add", (arg?: unknown) => {
      const group = arg instanceof GroupTreeItem ? arg.groupName : undefined;
      openUnifiedForm(ctx, { profileType: "ssh", group });
    }),

    vscode.commands.registerCommand("nexus.group.add", async () => {
      const name = await vscode.window.showInputBox({
        title: "New Group",
        prompt: "Enter group name",
        validateInput: (value) => {
          if (!value.trim()) {
            return "Group name cannot be empty";
          }
          const existing = ctx.core.getSnapshot().explicitGroups;
          const snapshot = ctx.core.getSnapshot();
          const allGroups = new Set(existing);
          for (const s of snapshot.servers) {
            if (s.group) allGroups.add(s.group);
          }
          for (const p of snapshot.serialProfiles) {
            if (p.group) allGroups.add(p.group);
          }
          if (allGroups.has(value.trim())) {
            return "A group with this name already exists";
          }
          return null;
        }
      });
      if (!name) {
        return;
      }
      await ctx.core.addGroup(name.trim());
    }),

    vscode.commands.registerCommand("nexus.group.remove", async (arg?: unknown) => {
      if (!(arg instanceof GroupTreeItem)) {
        return;
      }
      const groupName = arg.groupName;
      const confirm = await vscode.window.showWarningMessage(
        `Remove group "${groupName}"? Items in this group will be ungrouped.`,
        { modal: true },
        "Remove"
      );
      if (confirm !== "Remove") {
        return;
      }
      const snapshot = ctx.core.getSnapshot();
      for (const server of snapshot.servers) {
        if (server.group === groupName) {
          await ctx.core.addOrUpdateServer({ ...server, group: undefined });
        }
      }
      for (const profile of snapshot.serialProfiles) {
        if (profile.group === groupName) {
          await ctx.core.addOrUpdateSerialProfile({ ...profile, group: undefined });
        }
      }
      await ctx.core.removeExplicitGroup(groupName);
    })
  ];
}
