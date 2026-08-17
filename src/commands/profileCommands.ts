import * as vscode from "vscode";
import type { UnifiedProfileSeed } from "../ui/formDefinitions";
import { unifiedProfileFormDefinition, unifiedProfileFormId } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { FolderTreeItem, LocalShellProfileTreeItem, SerialProfileTreeItem, ServerTreeItem } from "../ui/nexusTreeProvider";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { authProfileCredentialMirror, formValuesToServer, browseForKey, collectGroups, syncProxyPasswordSecret } from "./serverCommands";
import { serverConfigsEqual, type ServerConfig } from "../models/config";
import { configMutationLock } from "../services/configMutationLock";
import { proxyPasswordSecretKey } from "../services/ssh/silentAuth";
import { formValuesToSerial, scanForPort } from "./serialCommands";
import { formValuesToLocalShell, getConfiguredVscodeTerminalProfileNames } from "./localShellCommands";
import type { CommandContext } from "./types";
import { createInlineAuthProfileCreation } from "./inlineAuthProfileCreation";
import {
  normalizeFolderPath,
  normalizeOptionalFolderPath,
  INVALID_FOLDER_PATH_MESSAGE,
  folderDisplayName,
  MAX_FOLDER_DEPTH
} from "../utils/folderPaths";

interface ProfileActionPick extends vscode.QuickPickItem {
  command: string;
}

/**
 * Byte-identical to the sentence the server edit form and the inventory source
 * form each refuse with (commands/serverCommands.ts,
 * commands/inventoryCommands.ts). Duplicated rather than shared for the same
 * reason those two already duplicate it between themselves: each form module
 * owns its own refusal copy, and there is no messages module to hang it on.
 */
const MISSING_AUTH_PROFILE_MESSAGE =
  "The selected auth profile no longer exists. Choose another, or clear the Auth Profile field.";

/**
 * The IPMI-link twin, duplicated here for the same reason the message above is
 * (each form module owns its own refusal copy; no messages module to share it
 * on). Byte-identical to `MISSING_IPMI_AUTH_PROFILE_MESSAGE` in
 * commands/serverCommands.ts.
 */
const MISSING_IPMI_AUTH_PROFILE_MESSAGE =
  "The selected IPMI auth profile no longer exists. Choose another, or clear the IPMI Auth Profile field.";

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
  // TELNET (Phase 0, MAJOR-3) — see serverCommands.ts: the protocol is what
  // keeps telnet servers out of the SSH-infrastructure pickers.
  const serverList = snapshot.servers.map((s) => ({ id: s.id, name: s.name, protocol: s.protocol }));
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
        const builtServer = formValuesToServer(values);
        if (!builtServer) {
          return;
        }
        let server: ServerConfig = builtServer;
        // FINDING 2 (P2, edit-race review, sibling) — same record+secret
        // pairing as nexus.server.edit (serverCommands.ts), for the
        // add/create path: addOrUpdateServer and syncProxyPasswordSecret
        // must commit as one generation against captureBackupStateForExport,
        // which reads server records + proxy-password secrets together
        // under this SAME configMutationLock — see the edit-path comment in
        // serverCommands.ts for the full torn-pair scenario. No UI runs
        // inside this span.
        await configMutationLock.runExclusive(async () => {
          // REVIEW FINDING — the Add form mirrors a chosen auth profile's
          // credentials into its fields (`onAutofill` below), and can then sit
          // open indefinitely while auth profile add/edit/delete run as
          // ordinary commands. Re-resolve the submitted link against LIVE core
          // state before anything is written, and while holding the lock every
          // auth profile write also takes (ui/authProfileEditorPanel.ts), so
          // the answer cannot move between this check and the write below.
          // Without it, deleting the profile while the form was open wrote a
          // DANGLING authProfileId onto a brand-new server —
          // removeAuthProfile's own reference clearing has already run by
          // then, nothing revisits the record afterwards, and nothing in the
          // UI reports it. Throwing here reaches the user as "Save failed: …"
          // and leaves the panel open with its contents intact, which is what
          // the message tells them to act on. First statement in the section
          // on purpose: nothing has been written yet, so there is nothing to
          // roll back.
          //
          // WHY ONLY THE MISSING CASE, and not the server EDIT form's full
          // `serverAuthProfileRejection` (commands/serverCommands.ts). That
          // guard has two halves, and only one of them has a counterpart here.
          // Its ownership-signature half exists solely because
          // `preserveLinkedServerCredentials` reads the LIVE profile to decide
          // which submitted credential fields are the user's own input and
          // which come back from the STORED record — a decision made about a
          // form nobody rendered if the profile's shape moved underneath it,
          // which silently discards a field the user typed or writes the
          // profile's own mirrored value over the record's. That helper does
          // not run on this path at all: it returns `next` untouched without an
          // `existing`, and there is no stored record to put anything back
          // from. This path writes the submission verbatim, so a new server
          // linked here ALWAYS stores the profile's mirrored credentials as its
          // own — that is the intended value underneath the link, not a
          // corruption, and a drifted shape only makes it one profile edit
          // stale. That is the same state the record would be in had the user
          // pressed Save a moment earlier, and it is what the link itself
          // means: the live profile decides at connect time regardless. Same
          // reasoning `inventoryAuthProfileRejection` uses to omit the server
          // form's comparand — compare what this save actually READS from the
          // profile, which here is the id and nothing else.
          //
          // The missing half has no such excuse: an id that resolves to nothing
          // is not one edit stale, it is a reference to a record that does not
          // exist, and it is the one outcome no save may leave behind.
          if (server.authProfileId !== undefined && ctx.core.getAuthProfile(server.authProfileId) === undefined) {
            throw new Error(MISSING_AUTH_PROFILE_MESSAGE);
          }
          // The IPMI-link twin of the check just above (`ipmiAuthProfileId`,
          // issue #48). Same dangling-reference hazard — a BMC auth profile
          // picked here and deleted while the form sat open would write a
          // dangling id onto the brand-new server, which nothing revisits. Same
          // existence-only test, for the same reason it is only the MISSING
          // case above and not the server EDIT form's full signature check: the
          // IPMI link mirrors no credentials into this form, it only supplies
          // `${profile.ipmiUsername}` at macro-run time (resolved live then), so
          // an id that resolves to nothing is the one and only thing to catch.
          if (server.ipmiAuthProfileId !== undefined && ctx.core.getAuthProfile(server.ipmiAuthProfileId) === undefined) {
            throw new Error(MISSING_IPMI_AUTH_PROFILE_MESSAGE);
          }
          // JUMP-HOST IPMI ROUTING (issue #48 PR-C, PR #65 Codex round 10) — the
          // server-list twin of the two auth-link guards above, and for the same
          // reason: the add form can sit open while the chosen IPMI gateway
          // server is deleted, and the deletion sweep (removeServer /
          // applyInventorySyncPlan / removeFolderCascade) cannot reach a server
          // that does not exist yet. Drop a gateway id that names no live server
          // so the new record can't be born with a dangling link. Because
          // `ipmiGatewayServerId` is a SERVER reference it checks
          // `ctx.core.getServer` (not `getAuthProfile`). Unlike the two auth
          // guards this does NOT throw: a dangling gateway degrades silently to
          // "run locally" at runtime, so the round-9/10 invariant is simply to
          // never PERSIST the dangling link — existence-check only, silent drop,
          // still under the same lock every server write takes. A live id and an
          // unset "(None)" are kept. The new server's own freshly-minted id can't
          // collide with the gateway pick (chosen from existing servers), so
          // there is no self-reference concern here.
          if (server.ipmiGatewayServerId !== undefined && ctx.core.getServer(server.ipmiGatewayServerId) === undefined) {
            server = { ...server, ipmiGatewayServerId: undefined };
          }
          // FINDINGS 2+3 (P2, create-rollback review, sibling) — same
          // single-owner displacement as the nexus.server.edit rollback
          // (serverCommands.ts): if `server` enables
          // openFileExplorerOnFirstConnect, addOrUpdateServer below clears
          // it from whichever OTHER server currently holds it. Capture that
          // displaced owner (if any) BEFORE the write lands, so a failed
          // secret sync can hand its flag back on rollback instead of
          // leaving it cleared for good.
          const displacedOwner = server.openFileExplorerOnFirstConnect
            ? ctx.core.getSnapshot().servers.find((s) => s.openFileExplorerOnFirstConnect && s.id !== server.id)
            : undefined;
          await ctx.core.addOrUpdateServer(server);
          try {
            await syncProxyPasswordSecret(ctx, server.id, values);
          } catch {
            // FINDING 1 (P2, create-rollback review) — the server record above
            // just committed, but its proxy secret never did. Left alone, the
            // form still reports failure while the record persists, and a
            // retry (fresh id per submission — formValuesToServer always
            // mints one for this add path) creates a duplicate alongside this
            // orphaned, secret-less leftover. Roll the record back — and
            // clean up any secret write that DID land before the rejection —
            // so a retry starts clean. Both are best-effort: a rollback
            // failure must not mask the original secret-storage error, and
            // there is nothing further below this span to make it not
            // best-effort against.
            //
            // FINDING 2 (P2, create-rollback-report review) — removeServer's
            // own persist can itself reject (e.g. the same storage backend
            // that just rejected the secret write is unavailable). When that
            // happens the in-memory delete already landed but disk still has
            // the record — it reappears after a reload — while the generic
            // "was not created" message would tell the user the opposite of
            // what actually happened. Track that failure separately and swap
            // in wording that tells the truth: the record may still be
            // there and needs manual cleanup.
            let removeFailed = false;
            try {
              await ctx.core.removeServer(server.id);
            } catch {
              removeFailed = true;
            }
            if (displacedOwner) {
              // Same concurrent-change rule as the nexus.server.edit rollback:
              // if the displaced owner's live record is still exactly what
              // addOrUpdateServer(server) left it (the captured record with
              // the flag cleared), hand the flag straight back.
              //
              // FINDING 2 (P2, displaced-owner-merge review, sibling) — if
              // it's since diverged (e.g. a concurrent rename of the
              // displaced owner), the old all-or-nothing check skipped the
              // restore entirely and left the flag cleared for good.
              // Restore ONLY the flag onto the displaced owner's CURRENT
              // record, preserving every field the concurrent change
              // touched, unless:
              //  - the displaced owner was concurrently deleted
              //    (currentDisplaced is undefined) — nothing to restore the
              //    flag onto, or
              //  - some other server already holds the flag now (checked
              //    against the live snapshot, taken AFTER this submission's
              //    own record was removed above) — restoring here would
              //    violate the single-owner invariant addOrUpdateServer
              //    otherwise enforces.
              //
              // FINDING 1 (P2, current-flag-owner review, sibling) — same
              // hoist as the nexus.server.edit rollback (serverCommands.ts):
              // the currentFlagOwner check used to guard ONLY the divergent
              // (else) branch, not the exact-match branch above it. Hoist it
              // so it guards BOTH branches — skip the restore entirely
              // whenever another server currently holds the flag, even on
              // the exact-match path.
              try {
                const currentDisplaced = ctx.core.getSnapshot().servers.find((s) => s.id === displacedOwner.id);
                if (currentDisplaced !== undefined) {
                  const currentFlagOwner = ctx.core.getSnapshot().servers.find((s) => s.openFileExplorerOnFirstConnect);
                  if (!currentFlagOwner) {
                    if (serverConfigsEqual(currentDisplaced, { ...displacedOwner, openFileExplorerOnFirstConnect: undefined })) {
                      await ctx.core.addOrUpdateServer({ ...displacedOwner, openFileExplorerOnFirstConnect: true });
                    } else {
                      await ctx.core.addOrUpdateServer({ ...currentDisplaced, openFileExplorerOnFirstConnect: true });
                    }
                  }
                }
                // else: the displaced owner was concurrently deleted —
                // nothing to restore the flag onto.
              } catch {
                void vscode.window.showErrorMessage(
                  `Could not restore the previous auto-open setting on "${displacedOwner.name}" after a failed save — re-check its settings.`
                );
              }
            }
            if (ctx.secretVault) {
              try {
                await ctx.secretVault.delete(proxyPasswordSecretKey(server.id));
              } catch {
                // best-effort rollback — ignore
              }
            }
            if (removeFailed) {
              throw new Error(
                `Could not store proxy credentials for "${server.name}" and the partially created server could not be removed — delete it manually if it appears.`
              );
            }
            throw new Error(`Could not store proxy credentials for "${server.name}" — the server was not created.`);
          }
        });
      }
    },
    onBrowse: browseForKey,
    onScan: () => scanForPort(ctx),
    onCreateInline: inlineAuthProfile.handleCreateInline,
    onAutofill: async (_key, value) => authProfileCredentialMirror(ctx.core.getAuthProfile(value)),
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
        { label: "Run Macro on Server…", command: "nexus.server.runMacro" },
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
        { label: "Open and Run Script", command: "nexus.localShell.runWithScript" },
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
