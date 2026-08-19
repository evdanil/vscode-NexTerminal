import * as vscode from "vscode";
import { configMutationLock } from "../configMutationLock";
import type { NexusCore } from "../../core/nexusCore";
import {
  EVE_NG_PROVIDER_ID,
  EVE_NG_STATUS_POLL_FIELD_ID,
  EVE_NG_STATUS_POLL_MAX_SECONDS,
  EVE_NG_STATUS_POLL_MIN_SECONDS
} from "./providers/eveNgProvider";

/** The retired setting. Contributed no longer; still present in users' files. */
export const RETIRED_STATUS_POLL_SECTION = "nexus.inventory";
export const RETIRED_STATUS_POLL_KEY = "statusPollSeconds";

/**
 * The durable "this already ran" record, in `globalState`. It lives OUTSIDE the
 * user's settings file on purpose: the whole point is that it survives a clear
 * that could not be written (see the idempotence note on the function below).
 */
export const STATUS_POLL_MIGRATION_DONE_KEY = "nexus.inventory.statusPollSettingMigrated";

export type StatusPollSettingScope = "global" | "workspace" | "workspaceFolder";

/**
 * The slice of `vscode.ExtensionContext.globalState` this needs — declared
 * structurally so the unit tests can hand it a Map and so nothing here depends
 * on a Memento's other members.
 */
export interface StatusPollMigrationMarkerStore {
  get(key: string): boolean | undefined;
  update(key: string, value: boolean): Thenable<void>;
}

export interface StatusPollMigrationResult {
  /** The old value, after the retired setting's own coercion. Absent when the key was not set. */
  value?: number;
  /** Source ids the value was carried onto. */
  applied: string[];
  /** Configuration scopes the dead key was successfully removed from. */
  cleared: StatusPollSettingScope[];
}

/**
 * Reproduces EXACTLY what `Math.floor(readBoundedNumber("nexus.inventory",
 * "statusPollSeconds", 0, 0, 3600))` returned, because the value worth
 * preserving is the one the poll ACTUALLY ran at — not the raw text in the
 * file. A non-number, `NaN` or `Infinity` degraded to the fallback 0 there, so
 * it degrades to 0 here: that user's poll never ran, and there is nothing to
 * carry.
 */
function coerceRetiredValue(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return EVE_NG_STATUS_POLL_MIN_SECONDS;
  }
  return Math.floor(Math.min(Math.max(raw, EVE_NG_STATUS_POLL_MIN_SECONDS), EVE_NG_STATUS_POLL_MAX_SECONDS));
}

/**
 * ONE-TIME MOVE of the retired global `nexus.inventory.statusPollSeconds`
 * setting onto each EVE-NG source's own **Lab Status Poll Interval** field.
 * Run once per activation; silent by construction — this preserves a value the
 * user already chose, so there is nothing to ask them about.
 *
 * The setting stopped being CONTRIBUTED, which does not remove it from anyone's
 * `settings.json`. Without this, a user who had polling on simply stops getting
 * it, with no message and a now-unknown key left in their file and in every
 * settings export they make afterwards.
 *
 * DECISIONS, and why:
 *
 *  - **Every scope, most-specific wins.** `highlightRuleMigration` deliberately
 *    touches Global only, because it REWRITES the content of a live setting and
 *    a workspace file may be shared. This is the opposite case: the key is dead
 *    in every scope, and the value in the scope that was EFFECTIVE is the one
 *    the poll actually used. Reading Global while a Workspace override was in
 *    force would change the user's interval behind their back, and clearing
 *    only Global would leave the dead key exactly where it is most visible.
 *
 *  - **Sources are global; the value lands on them regardless of which scope it
 *    came from.** A workspace-scoped interval therefore becomes window-wide.
 *    That is a real change in reach, accepted knowingly: inventory sources have
 *    never been workspace-scoped, so the alternative is not "keep it
 *    workspace-scoped", it is "lose it".
 *
 *  - **No EVE-NG sources: the key is still cleared, and nothing is applied.**
 *    The setting governed nothing for that user — only EVE-NG sources report
 *    status — so there is no live behaviour to preserve. Parking the value for
 *    a source that might be added later would arm exactly the surprise this
 *    change exists to remove: a lab box polled at a cadence the user set for
 *    something else, months ago.
 *
 *  - **A value of 0 applies to nothing.** It was the shipped default, and it
 *    polled nothing; writing a 0 onto every source would only churn revisions
 *    and destroy this migration's own "has this source answered yet?" test.
 *
 *  - **Idempotence is a durable marker, not an inference.** A completed pass
 *    records `STATUS_POLL_MIGRATION_DONE_KEY` in `globalState`, and the next
 *    activation returns on it before reading settings at all. It is deliberately
 *    NOT inferred from the settings key being gone, because the clear can FAIL
 *    (a read-only or policy-managed `settings.json`, or a dotfiles-provisioned
 *    one that simply puts the key back) — and it is not inferred from the
 *    sources' own answers either, because "answered" means "the key is present
 *    in the source's config" while the edit form stores NO KEY for a blanked
 *    number field. A user who turns polling off by clearing the field would
 *    otherwise read as unanswered on the next activation and have the old
 *    interval written back: unattended polling at a cadence they switched off.
 *    The same inference would seed any EVE-NG source ADDED between activations,
 *    which the "no EVE-NG sources" note above rejects for the same reason.
 *
 *    Marked only after the work is DONE (see the ordering note below), so a run
 *    that throws mid-carry retries on the next activation rather than losing the
 *    value it was there to preserve. A pass that found no key at all is marked
 *    too: it is a completed pass, and marking it is what stops a key reappearing
 *    in the file later from arming polling behind the user.
 *
 *    The per-source "already answered" check STAYS, now as what it always
 *    honestly was — a rule about not overwriting an answer the user has given,
 *    including an explicit `0` — rather than as the idempotence mechanism.
 *
 *  - **Ordering: apply, then clear.** If the write to a source fails the key
 *    survives and the migration is retried next time; if the clear fails the
 *    values are already safe. Neither order can lose the value, but this one
 *    cannot lose it *and* forget where it was.
 *
 *  - **Fingerprint: unrelated, either way.** The source write bumps `revision`,
 *    not `providerFingerprint` — which is only stamped by add/edit/sync — so
 *    the once-per-source credential re-confirmation caused by ADDING the field
 *    to the provider happens the same whether this ran or not, and running this
 *    before or after makes no difference to it. It runs after
 *    `core.initialize()` for the only reason that matters: it needs the sources.
 *
 *  - **Not recorded in the settings write registry.** That registry exists so
 *    the Settings Guard can tell its own writes from external edits, and it
 *    only watches four keys, none of them this one.
 *
 * Non-fatal by construction: activation must not fail over a settings read, and
 * a poll that does not start is not worth taking a window down for.
 */
export async function migrateGlobalStatusPollSetting(
  core: NexusCore,
  markers: StatusPollMigrationMarkerStore
): Promise<StatusPollMigrationResult> {
  try {
    if (markers.get(STATUS_POLL_MIGRATION_DONE_KEY) === true) {
      return { applied: [], cleared: [] };
    }
    const config = vscode.workspace.getConfiguration(RETIRED_STATUS_POLL_SECTION);
    const inspected = config.inspect<unknown>(RETIRED_STATUS_POLL_KEY);
    // Least specific first, so the LAST entry is the effective one.
    const present = [
      { scope: "global" as const, target: vscode.ConfigurationTarget.Global, value: inspected?.globalValue },
      { scope: "workspace" as const, target: vscode.ConfigurationTarget.Workspace, value: inspected?.workspaceValue },
      { scope: "workspaceFolder" as const, target: vscode.ConfigurationTarget.WorkspaceFolder, value: inspected?.workspaceFolderValue }
    ].filter((entry) => entry.value !== undefined);

    if (present.length === 0) {
      // A completed pass with nothing to carry — marked like any other, so a key
      // that reappears in the file afterwards is not migrated behind the user.
      await markMigrated(markers);
      return { applied: [], cleared: [] };
    }

    const seconds = coerceRetiredValue(present[present.length - 1].value);

    const applied: string[] = [];
    if (seconds > EVE_NG_STATUS_POLL_MIN_SECONDS) {
      const candidates = core
        .getSnapshot()
        .inventorySources.filter(
          (source) => source.providerId === EVE_NG_PROVIDER_ID && source.config[EVE_NG_STATUS_POLL_FIELD_ID] === undefined
        );
      if (candidates.length > 0) {
        // The normal persistence path, serialized against the config-level
        // flows (replace-mode import, complete reset) and the inventory
        // commands the same way they serialize against each other.
        await configMutationLock.runExclusive(async () => {
          for (const candidate of candidates) {
            // Re-read inside the lock: the snapshot was taken outside it, and
            // the record may have been removed or answered since.
            //
            // INCLUDING THE PROVIDER (review L1). A replace-mode import queues on
            // this same lock and can delete-and-recreate a source id as a
            // DIFFERENT provider, so existence and answered-ness alone would land
            // an EVE-NG-only field in (say) a NetBox source's config and bump its
            // revision for it. Same-id recreation is the incarnation hazard this
            // codebase re-validates for everywhere else (`isSameSourceIncarnation`).
            const live = core.getInventorySource(candidate.id);
            if (!live || live.providerId !== EVE_NG_PROVIDER_ID || live.config[EVE_NG_STATUS_POLL_FIELD_ID] !== undefined) {
              continue;
            }
            await core.addOrUpdateInventorySource({
              ...live,
              config: { ...live.config, [EVE_NG_STATUS_POLL_FIELD_ID]: seconds }
            });
            applied.push(live.id);
          }
        });
      }
    }

    const cleared: StatusPollSettingScope[] = [];
    for (const entry of present) {
      try {
        await config.update(RETIRED_STATUS_POLL_KEY, undefined, entry.target);
        cleared.push(entry.scope);
      } catch {
        // Read-only / policy-managed settings, or a file something else owns.
        // The values are already on the sources and the marker below is what
        // makes the next activation a no-op, so a dead key left in the file
        // costs the user nothing but the key itself.
      }
    }

    // LAST, and only on a pass that got this far: everything above either
    // succeeded or was deliberately survivable.
    await markMigrated(markers);

    return { value: seconds, applied, cleared };
  } catch {
    return { applied: [], cleared: [] };
  }
}

/**
 * Non-fatal on its own: a `globalState` write that rejects must not turn a
 * successful carry into a reported failure. The cost is that this installation
 * runs the migration again next activation, where the cleared key (if the clear
 * did work) and the sources' own answers still hold the line.
 */
async function markMigrated(markers: StatusPollMigrationMarkerStore): Promise<void> {
  try {
    await markers.update(STATUS_POLL_MIGRATION_DONE_KEY, true);
  } catch {
    // Deliberately swallowed — see above.
  }
}
