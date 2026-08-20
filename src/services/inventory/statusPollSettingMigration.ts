import * as vscode from "vscode";
import { configMutationLock } from "../configMutationLock";
import type { NexusCore } from "../../core/nexusCore";
import type { InspectableConfiguration } from "../../utils/configurationInspection";
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

/**
 * Only Global. The migration reads and clears exactly one scope — see the
 * "Global only, in both directions" note on the function below.
 */
export type StatusPollSettingScope = "global";

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
 *
 * Exported because config import carries the same retired key out of an old
 * export (see `configCommands.applySettings`) and must land the same number on
 * a source that this would — one coercion rule, not two that can drift.
 */
export function coerceRetiredStatusPollSeconds(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return EVE_NG_STATUS_POLL_MIN_SECONDS;
  }
  return Math.floor(Math.min(Math.max(raw, EVE_NG_STATUS_POLL_MIN_SECONDS), EVE_NG_STATUS_POLL_MAX_SECONDS));
}

/**
 * THE ONE READ of the retired key, for every consumer: its GLOBAL value, and
 * nothing else. Exported so config EXPORT reads exactly the scope this
 * migration reads (review D1) instead of re-deriving the rule beside it.
 *
 * The generic reader (`getConfiguredSettingValue`) deliberately prefers a
 * WORKSPACE or FOLDER value, which is right for a setting that means "how this
 * window behaves" and wrong for this one: it is being moved onto INVENTORY
 * SOURCES, which are machine-wide. Reading the effective scope anywhere would
 * promote one workspace's number onto every window — through the migration if
 * it read that way (it no longer does), or, one machine later, through a backup
 * that captured it and a restore that applied it to every source the import
 * created. The scope note in the doc comment below is the full argument; this
 * function is what keeps both callers on the same side of it.
 *
 * Returns the RAW value. Every caller coerces through
 * `coerceRetiredStatusPollSeconds` (or, on the import path, validates first),
 * so a non-numeric value is handled where it can be reported rather than
 * silently normalised here.
 */
export function readGlobalRetiredStatusPollValue(config: InspectableConfiguration): unknown {
  return config.inspect?.<unknown>(RETIRED_STATUS_POLL_KEY)?.globalValue;
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
 *  - **Global only, in both directions — read AND clear** (review C1), the same
 *    rule `highlightRuleMigration` follows. An earlier revision read the
 *    EFFECTIVE scope (workspace over global) on the grounds that it was the
 *    value the poll actually used. That is true of one window and false of two:
 *    `configMutationLock` is module-local, `globalState` has no
 *    compare-and-set, and two windows opening different workspaces for the
 *    first time can both see the marker absent before either writes it. With a
 *    per-workspace read they then carry DIFFERENT numbers onto the same,
 *    machine-wide sources and whichever host committed last decided the
 *    cadence — a coin toss, and one workspace's preference destroyed by it.
 *
 *    Reading Global makes the outcome a function of state both windows share:
 *    the same number, onto the same sources, so the two runs are the same run
 *    and the order they finish in stops mattering. (The second window's write
 *    is either skipped by the per-source answered check or is a byte-identical
 *    rewrite of what the first one stored.) No distributed lock, and nothing
 *    that has to be right about timing.
 *
 *    What that gives up, stated plainly: a WORKSPACE- or FOLDER-scoped override
 *    is not carried onto the sources. It is not deleted either — the clear is
 *    Global-only too, so the number stays in the workspace's own
 *    `settings.json`, flagged by VS Code as an unknown setting, where the user
 *    can read it and type it into the source's Lab Status Poll Interval field.
 *    Deleting a value we have decided not to honour is the one outcome with no
 *    way back, so it is the one thing not done here.
 *
 *  - **Sources are global, so the value has to be too.** That is the substantive
 *    reason the scope narrowing is not merely a race fix: a source is
 *    machine-wide, and promoting a number scoped to ONE workspace onto it
 *    changes the cadence in every other window, including workspaces the user
 *    never set it in. The Global value is the only one that already means "how
 *    this machine polls".
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
    // GLOBAL ONLY (review C1) — the one scope every window agrees on, which is
    // what makes two concurrent first activations produce one outcome instead
    // of a race. A workspace override is deliberately neither read nor cleared;
    // see the scope note in the doc comment above.
    const globalValue = readGlobalRetiredStatusPollValue(config);

    if (globalValue === undefined) {
      // A completed pass with nothing to carry — marked like any other, so a key
      // that reappears in the file afterwards is not migrated behind the user.
      await markMigrated(markers);
      return { applied: [], cleared: [] };
    }

    const seconds = coerceRetiredStatusPollSeconds(globalValue);

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
    try {
      await config.update(RETIRED_STATUS_POLL_KEY, undefined, vscode.ConfigurationTarget.Global);
      cleared.push("global");
    } catch {
      // Read-only / policy-managed settings, or a file something else owns.
      // The values are already on the sources and the marker below is what
      // makes the next activation a no-op, so a dead key left in the file
      // costs the user nothing but the key itself.
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
