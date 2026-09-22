import * as path from "node:path";
import * as vscode from "vscode";
import { defaultSshDir } from "../ssh/deploySshKey";
import { createSshConfigIo } from "../ssh/sshConfigIo";
import { convertSshConfig, localLoginName } from "../../utils/sshConfigImport";
import { resolveSshConfig } from "../../utils/sshConfigParser";

/**
 * Marker for the strictly-once `~/.ssh/config` import offer. Versioned in the
 * key itself: a future offer with different wording or different criteria is a
 * NEW key, never a reset of this one — a user who said no once must not be
 * asked again by a rewrite.
 */
export const SSH_CONFIG_OFFER_KEY = "nexus.import.sshConfigOffer.v1";

/** Same 2 MB ceiling the import command applies. Nothing oversized is read here either. */
const SSH_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One-time offer to import `~/.ssh/config`, shown at most once ever per
 * install.
 *
 * WHAT IT PROMISES ACTIVATION. It never throws and never rejects — every step
 * is inside one try/catch that swallows — and it is called fire-and-forget, so
 * a slow or hostile filesystem delays nothing. A notification that cannot be
 * shown is a notification not shown; it is not an activation failure.
 *
 * WHEN IT STAYS SILENT: the marker is set; the file does not exist or cannot be
 * read; it parses to zero importable hosts. That last one is the case worth
 * naming, because a config made only of `Host *` defaults blocks, or only of
 * Includes that resolve to nothing, parses FINE and yields nothing to import —
 * offering there would be an interruption with no action behind it.
 *
 * THE MARKER IS SET WHEN THE NOTIFICATION IS SHOWN, NOT WHEN IT IS ANSWERED.
 * VS Code notifications are dismissible, auto-collapse into the bell, and
 * commonly go unanswered; keying the marker on the answer would re-ask on every
 * start until someone clicked a button, which is precisely the nagging this
 * offer must not become. "You are told once" is the contract, so the message
 * also names the permanent route (`Nexus: Import…`) — the offer never comes
 * back, and a user who says Dismiss today has to be able to find it in March.
 *
 * KNOWN RACE, and why it is survivable. `globalState` has no compare-and-set
 * (see the doc comment atop `vscodeConfigRepository.ts`, and the same hazard
 * written out in `statusPollSettingMigration.ts`), so two windows starting for
 * the first time can both read the marker absent before either writes it, and
 * both show the offer. Accept both and the imports collide: each
 * `applyImportedSessions` write persists a FULL server snapshot under a
 * `configMutationLock` that is module-local — one process's lock, not a
 * machine-wide one — so last writer wins and the other window's servers can be
 * dropped. The mitigation is the ssh-config importer's skip-existing dedupe
 * (`applySshConfigResult` in `configCommands.ts`): the two windows import the
 * same file, so by the time the second one runs, either it sees the first
 * one's servers and imports nothing, or it races and writes a snapshot
 * containing the same hosts the other window was creating. Duplicate rows are
 * what that dedupe prevents; a genuinely concurrent unrelated edit lost to the
 * snapshot write is the pre-existing `globalState` limitation, reported (not
 * prevented) by `onConcurrentOverwrite`.
 */
export async function maybeOfferSshConfigImport(context: vscode.ExtensionContext): Promise<void> {
  try {
    if (context.globalState.get(SSH_CONFIG_OFFER_KEY) !== undefined) {
      return;
    }

    const configPath = path.join(defaultSshDir(), "config");
    const uri = vscode.Uri.file(configPath);

    // stat before anything else: the common case is "no file", and it costs one
    // syscall to find out rather than a parse.
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0 || stat.size > SSH_CONFIG_MAX_BYTES) {
      return;
    }

    const parsed = await resolveSshConfig(configPath, createSshConfigIo(SSH_CONFIG_MAX_BYTES));
    const importable = convertSshConfig(parsed, { defaultUsername: localLoginName() }).sessions.length;
    if (importable === 0) {
      return;
    }

    // Before the message, deliberately (see the contract above). If this write
    // fails, no offer is made at all — better a missed offer than one that
    // repeats forever because its marker never landed.
    await context.globalState.update(SSH_CONFIG_OFFER_KEY, true);

    const choice = await vscode.window.showInformationMessage(
      `Nexus found ${importable} SSH ${importable === 1 ? "host" : "hosts"} in ~/.ssh/config. ` +
        "Import them as connection profiles? This offer is shown only once — you can always run Nexus: Import… later.",
      "Import",
      "Dismiss"
    );
    if (choice === "Import") {
      // The path is already known, so the command is handed the URI and skips
      // its own file dialog.
      await vscode.commands.executeCommand("nexus.config.import.sshConfig", uri);
    }
  } catch {
    // Deliberately silent and deliberately total. This runs during activation;
    // an unreadable home directory, a filesystem provider that throws on stat,
    // or a globalState write that fails must cost the user nothing but this
    // one offer.
  }
}
