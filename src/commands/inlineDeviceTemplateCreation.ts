import * as vscode from "vscode";
import type { DeviceTemplateProfile } from "../models/deviceTemplate";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import type { CommandContext } from "./types";

type InlineDeviceTemplateContext = Pick<CommandContext, "core">;

/**
 * DEVICE TEMPLATES (issue #48 PR-T1b) — the source form's "Create new device
 * template…" affordance, the exact shape of `createInlineAuthProfileCreation`:
 * open the New Device Template editor, watch core for the template that lands,
 * and inject it into whichever select triggered the create so it can be selected
 * without reopening the source form.
 */
export interface InlineDeviceTemplateCreationController {
  attachPanel(panel: WebviewFormPanel): void;
  handleCreateInline(key: string): void;
}

export function createInlineDeviceTemplateCreation(
  ctx: InlineDeviceTemplateContext
): InlineDeviceTemplateCreationController {
  let panel: WebviewFormPanel | undefined;
  let stopWatchingCore: (() => void) | undefined;

  const clearWatcher = (): void => {
    if (stopWatchingCore) {
      stopWatchingCore();
      stopWatchingCore = undefined;
    }
  };

  return {
    attachPanel(nextPanel) {
      panel = nextPanel;
      nextPanel.onDidDispose(() => {
        clearWatcher();
        panel = undefined;
      });
    },
    handleCreateInline(key) {
      if (key !== "deviceTemplateId" || !panel) {
        return;
      }
      void vscode.commands.executeCommand("nexus.deviceTemplate.add");
      clearWatcher();

      const knownIds = new Set(ctx.core.getSnapshot().deviceTemplates.map((t: DeviceTemplateProfile) => t.id));
      stopWatchingCore = ctx.core.onDidChange(() => {
        const added = ctx.core.getSnapshot().deviceTemplates.find((t: DeviceTemplateProfile) => !knownIds.has(t.id));
        if (!added) {
          return;
        }
        panel?.addSelectOption(key, added.id, added.name);
        clearWatcher();
      });
    }
  };
}
