import type { AuthProfile } from "../models/config";
import { AuthProfileEditorPanel } from "../ui/authProfileEditorPanel";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { formatAuthProfileLabel } from "../utils/authProfileLabel";
import type { CommandContext } from "./types";

type InlineAuthProfileContext = Pick<CommandContext, "core" | "secretVault">;

function authProfileOptionLabel(profile: AuthProfile): string {
  return formatAuthProfileLabel(profile);
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
      // Both the SSH auth select (`authProfileId`) and the IPMI one
      // (`ipmiAuthProfileId`, C2) offer "Create new auth profile…"; the new
      // profile is appended to WHICHEVER field triggered the create. The IPMI
      // field carries no autofill, so it never mirrors the profile into the SSH
      // controls — that follow-up is gated on `authProfileId` in formHtml.ts.
      if ((key !== "authProfileId" && key !== "ipmiAuthProfileId") || !panel) {
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
        panel?.addSelectOption(key, added.id, authProfileOptionLabel(added));
        clearWatcher();
      });
    }
  };
}
