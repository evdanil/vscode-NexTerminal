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

export type StatusPollSettingScope = "global" | "workspace" | "workspaceFolder";

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
 *  - **Idempotence has two layers.** Clearing the key is the primary one: the
 *    next activation finds nothing and returns immediately. The second covers
 *    the case where the clear FAILS (a read-only or policy-locked settings
 *    file) — only a source with NO stored answer is written, and the first run
 *    gave every one of them an answer. An explicit `0` on a source counts as an
 *    answer, so a user who has deliberately turned one source off is never
 *    re-enabled by a retried migration.
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
export async function migrateGlobalStatusPollSetting(core: NexusCore): Promise<StatusPollMigrationResult> {
  try {
    const config = vscode.workspace.getConfiguration(RETIRED_STATUS_POLL_SECTION);
    const inspected = config.inspect<unknown>(RETIRED_STATUS_POLL_KEY);
    // Least specific first, so the LAST entry is the effective one.
    const present = [
      { scope: "global" as const, target: vscode.ConfigurationTarget.Global, value: inspected?.globalValue },
      { scope: "workspace" as const, target: vscode.ConfigurationTarget.Workspace, value: inspected?.workspaceValue },
      { scope: "workspaceFolder" as const, target: vscode.ConfigurationTarget.WorkspaceFolder, value: inspected?.workspaceFolderValue }
    ].filter((entry) => entry.value !== undefined);

    if (present.length === 0) {
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
            const live = core.getInventorySource(candidate.id);
            if (!live || live.config[EVE_NG_STATUS_POLL_FIELD_ID] !== undefined) {
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
        // Read-only / policy-locked settings. The values are already on the
        // sources; the second idempotence layer covers the retry.
      }
    }

    return { value: seconds, applied, cleared };
  } catch {
    return { applied: [], cleared: [] };
  }
}
