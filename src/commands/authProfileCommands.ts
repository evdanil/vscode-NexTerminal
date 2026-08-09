import * as vscode from "vscode";
import type { AuthProfile, ServerConfig } from "../models/config";
import { FolderTreeItem, ServerTreeItem } from "../ui/nexusTreeProvider";
import { AuthProfileEditorPanel } from "../ui/authProfileEditorPanel";
import { configMutationLock } from "../services/configMutationLock";
import { formatAuthProfileLabel } from "../utils/authProfileLabel";
import { isDescendantOrSelf } from "../utils/folderPaths";
import { naturalCompare } from "../utils/naturalCompare";
import type { CommandContext } from "./types";

async function pickAuthProfile(ctx: CommandContext): Promise<AuthProfile | undefined> {
  const profiles = ctx.core.getSnapshot().authProfiles;
  if (profiles.length === 0) {
    void vscode.window.showWarningMessage("No auth profiles configured. Create one first.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    profiles
      .slice()
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((p) => ({
        label: formatAuthProfileLabel(p),
        profile: p
      })),
    { title: "Select Auth Profile" }
  );
  return pick?.profile;
}

/** "1 server" / "3 servers" — the modal and the report must agree, and both must read. */
function serverCountPhrase(count: number): string {
  return count === 1 ? "1 server" : `${count} servers`;
}

/** The live membership of a folder (including its subfolders) — the set this command writes to. */
function serversInFolder(ctx: CommandContext, folderPath: string): ServerConfig[] {
  return ctx.core.getSnapshot().servers.filter((s) => s.group && isDescendantOrSelf(s.group, folderPath));
}

/**
 * The Apply-to-folder confirmation text, built in ONE place so what the modal
 * discloses and what the write is later re-checked against cannot drift apart —
 * the same "re-render the disclosure and compare" shape the auth profile
 * editor's delete handler uses (ui/authProfileEditorPanel.ts).
 *
 * Its inputs are exactly three: the profile's NAME, the affected server COUNT,
 * and the folder path. The folder path is captured from the invoking tree item
 * and cannot move; the other two are re-derived under the lock and compared. If
 * this text ever gains a fourth input, the checks in the command must gain it
 * too.
 */
function applyToFolderDisclosure(profileName: string, count: number, folderPath: string): string {
  // The second sentence agrees with the first: "1 server" takes "its", N take
  // "their". serverCountPhrase already inflects the count; this sentence used to
  // say "their" regardless, so a one-server folder read "…to 1 server… This links
  // their credentials…". Inflected rather than hedged into "its/their", which is
  // the same "(s)" construction the repo keeps out of user-facing copy.
  const credentials = count === 1 ? "its credentials" : "their credentials";
  return (
    `Link "${profileName}" to ${serverCountPhrase(count)} in "${folderPath}"?\n` +
    `This links ${credentials} to the auth profile.`
  );
}

/** Order-insensitive identity of an affected set — a swap that keeps the count is still a different set. */
function sameServerIds(a: readonly ServerConfig[], b: readonly ServerConfig[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = a.map((s) => s.id).sort();
  const right = b.map((s) => s.id).sort();
  return left.every((id, index) => id === right[index]);
}

/**
 * REVIEW FINDING — writes ONLY the field this command owns, onto each server's
 * LIVE record, re-read immediately before its own write.
 *
 * This used to spread the pre-modal copies the affected set was computed from
 * (`{ ...server, authProfileId }`), which silently reverted every other field
 * of any server edited while the modal (or the wait for the lock) was open — a
 * rename, a port change, a proxy edit — because the whole stale record was
 * written back around the one field the command actually means to set. The same
 * spread would also RESURRECT a record removed in that window, since
 * addOrUpdateServer creates by id. Re-reading and writing `{ ...live,
 * authProfileId }` is the codebase's established shape for a single-field
 * update against live state (`restampProviderFingerprintBestEffort` in
 * commands/inventoryCommands.ts, the displaced-owner restores in
 * commands/serverCommands.ts).
 *
 * Callers hold `configMutationLock`, so no other lock-taking flow can commit
 * between these writes; the per-server re-read additionally covers the lock-free
 * writers (nexus.server.rename, nexus.group.rename's in-place `.group`
 * rewrite) that can land during each pending `addOrUpdateServer`. Beyond that
 * the repo-wide last-writer-wins rule applies, exactly as it does for the
 * server edit form's own write.
 *
 * A server already carrying this link is skipped rather than rewritten: the
 * write would be a no-op in content but still costs a full persist and a change
 * emission per server, which on a large folder is the difference between one
 * flush and N.
 */
async function linkProfileToServers(
  ctx: CommandContext,
  profileId: string,
  serverIds: readonly string[]
): Promise<void> {
  for (const id of serverIds) {
    const live = ctx.core.getServer(id);
    if (!live || live.authProfileId === profileId) {
      continue;
    }
    await ctx.core.addOrUpdateServer({ ...live, authProfileId: profileId });
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

    vscode.commands.registerCommand("nexus.authProfile.applyToFolder", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const folderPath = arg.folderPath;
      const profile = await pickAuthProfile(ctx);
      if (!profile) {
        return;
      }
      const servers = serversInFolder(ctx, folderPath);
      if (servers.length === 0) {
        void vscode.window.showInformationMessage("No servers in this folder.");
        return;
      }
      const shownDisclosure = applyToFolderDisclosure(profile.name, servers.length, folderPath);
      const confirm = await vscode.window.showWarningMessage(shownDisclosure, { modal: true }, "Link");
      if (confirm !== "Link") {
        return;
      }
      // REVIEW FINDING — the confirmation above describes state sampled BEFORE
      // the modal (and before the wait for this lock), and both waits are
      // unbounded: auth profile add/edit/delete and every server command are
      // ordinary commands the user can run while the modal sits open. Without
      // this section the write happened lock-free against those pre-modal
      // copies, so a profile deleted in that window linked a DANGLING id onto N
      // servers (nothing sweeps it afterwards — removeAuthProfile's own clear
      // has already run), and the count and profile name that were consented to
      // no longer described what was written.
      //
      // Hold the lock across the whole write, re-resolve the profile inside it,
      // re-derive the affected set from live state, and refuse if what would
      // now happen differs from what was disclosed — the same "abort, do not
      // silently proceed" answer the auth profile editor's delete handler
      // reaches for a destructive action whose consequences no longer match the
      // consent (ui/authProfileEditorPanel.ts). Re-confirming would mean
      // releasing the lock to show a modal, re-acquiring and re-checking; this
      // command rebuilds every fact it needs from scratch in one click, so
      // saying so and doing nothing is the conservative answer.
      //
      // NO CALLER HOLDS THIS LOCK ALREADY, so acquiring it here cannot deadlock
      // the non-re-entrant AsyncMutex: both apply commands are reachable only
      // from VS Code's command dispatcher (package.json `commands` +
      // view/item/context menus; no `executeCommand` in src/ targets either id,
      // and webExtension.ts only registers unavailable stubs for them). Nothing
      // reached from inside the section acquires it either — NexusCore,
      // storage and services are all lock-free, by the same rule that keeps it
      // out of NexusCore.removeAuthProfile (see that method's doc comment).
      //
      // Acquired AFTER the last prompt, as the lock's contract requires: the
      // quick pick and the modal have both resolved, and nothing inside shows
      // UI — the progress notification is not interactive, and the refusal is
      // deferred out of the section, exactly as the delete handler defers its
      // own.
      let refusal: string | undefined;
      let linkedTo = 0;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Linking auth profile "${profile.name}"...` },
        () =>
          configMutationLock.runExclusive(async () => {
            const live = ctx.core.getAuthProfile(profile.id);
            if (!live) {
              refusal =
                `Auth profile "${profile.name}" was deleted while the confirmation was open — nothing was linked. ` +
                "Choose another profile.";
              return;
            }
            const current = serversInFolder(ctx, folderPath);
            // The set first, because it subsumes the count the disclosure
            // renders: two servers leaving and two arriving keeps the number
            // the user agreed to while changing every record this would write.
            if (!sameServerIds(current, servers)) {
              refusal =
                `The servers in "${folderPath}" changed while the confirmation was open — nothing was linked. ` +
                `Run Apply Auth Profile again to see which servers "${profile.name}" would be linked to now.`;
              return;
            }
            // Whatever else the disclosure is built from — today, the profile's
            // name. Quoted by the name the MODAL used, not the current one:
            // that is the profile the user acted on, and a rename is one of the
            // things this catches.
            if (applyToFolderDisclosure(live.name, current.length, folderPath) !== shownDisclosure) {
              refusal =
                `Auth profile "${profile.name}" changed while the confirmation was open — nothing was linked. ` +
                "Run Apply Auth Profile again to review what it would link now.";
              return;
            }
            linkedTo = current.length;
            await linkProfileToServers(
              ctx,
              live.id,
              current.map((s) => s.id)
            );
          })
      );
      if (refusal !== undefined) {
        void vscode.window.showWarningMessage(refusal);
        return;
      }
      void vscode.window.showInformationMessage(
        `Linked auth profile "${profile.name}" to ${serverCountPhrase(linkedTo)}.`
      );
    }),

    vscode.commands.registerCommand("nexus.authProfile.applyToServer", async (arg?: unknown) => {
      if (!(arg instanceof ServerTreeItem)) {
        return;
      }
      const serverId = arg.server.id;
      const pickedServerName = arg.server.name;
      const profile = await pickAuthProfile(ctx);
      if (!profile) {
        return;
      }
      // The single-server half of the same finding. There is no consent modal
      // here — the quick pick IS the action — so what is re-checked under the
      // lock is only what the write would otherwise get WRONG: a profile id
      // that no longer resolves (a dangling link, on a record nothing sweeps
      // afterwards) and a server record that is gone (which the old
      // whole-record spread would have recreated, resurrecting a server the
      // user just removed).
      //
      // A profile RENAMED between the pick and the write is deliberately NOT
      // refused: the pick names one profile by identity and that is exactly
      // what gets linked, with no count and no consequence text that a rename
      // could falsify. The report below names the profile's CURRENT name so it
      // matches what the user will find in the tree.
      let refusal: string | undefined;
      let linked: { profileName: string; serverName: string } | undefined;
      await configMutationLock.runExclusive(async () => {
        const live = ctx.core.getAuthProfile(profile.id);
        if (!live) {
          refusal =
            `Auth profile "${profile.name}" was deleted while it was being chosen — nothing was linked. ` +
            "Choose another profile.";
          return;
        }
        const liveServer = ctx.core.getServer(serverId);
        if (!liveServer) {
          refusal = `"${pickedServerName}" was removed while the auth profile was being chosen — nothing was linked.`;
          return;
        }
        linked = { profileName: live.name, serverName: liveServer.name };
        await linkProfileToServers(ctx, live.id, [serverId]);
      });
      if (refusal !== undefined) {
        void vscode.window.showWarningMessage(refusal);
        return;
      }
      if (linked) {
        void vscode.window.showInformationMessage(
          `Linked auth profile "${linked.profileName}" to "${linked.serverName}".`
        );
      }
    })
  ];
}
