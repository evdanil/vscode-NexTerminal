import type { AuthProfile } from "../models/config";
import { AuthProfileEditorPanel } from "../ui/authProfileEditorPanel";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import type { CommandContext } from "./types";

type InlineAuthProfileContext = Pick<CommandContext, "core" | "secretVault">;

function authProfileOptionLabel(profile: AuthProfile): string {
  return `${profile.name} — ${profile.authType} — ${profile.username}`;
}

export interface InlineAuthProfileCreationController {
  attachPanel(panel: WebviewFormPanel): void;
  handleCreateInline(key: string): void;
}

export function createInlineAuthProfileCreation(
  ctx: InlineAuthProfileContext
): InlineAuthProfileCreationController {
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
      if (key !== "authProfileId" || !panel) {
        return;
      }

      AuthProfileEditorPanel.openNew(ctx.core, ctx.secretVault);
      clearWatcher();

      const knownIds = new Set(ctx.core.getSnapshot().authProfiles.map((profile) => profile.id));
      stopWatchingCore = ctx.core.onDidChange(() => {
        const added = ctx.core.getSnapshot().authProfiles.find((profile) => !knownIds.has(profile.id));
        if (!added) {
          return;
        }
        panel?.addSelectOption("authProfileId", added.id, authProfileOptionLabel(added));
        clearWatcher();
      });
    }
  };
}
