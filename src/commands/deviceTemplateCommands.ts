import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ProxyConfig, ServerConfig } from "../models/config";
import type { DeviceTemplateProfile, TemplateField, TemplateFieldMode } from "../models/deviceTemplate";
import {
  clearTemplatedStamps,
  filterLabel,
  parseTemplateFilter,
  planManualTemplateApply,
  TEMPLATE_FIELD_SHORT_LABELS,
  unknownFilterKeys,
  type ManualApplyPlan,
  type TemplatableField
} from "../services/inventory/templateApply";
import { buildRuleListItems, filterFeedback, saveOverlapWarnings, templateSetsLabels } from "../services/inventory/templateRulesView";
import type { InventoryProviderRegistry } from "../services/inventory/providerRegistry";
import type { InventorySourceConfig, TemplateRule } from "../models/inventory";
import { configMutationLock } from "../services/configMutationLock";
import {
  clearStaleProxyPasswordSecretsBeforeApply,
  restoreProxyPasswordSecrets,
  isSameAuthenticatedEndpoint,
  type CapturedProxyPasswordSecret
} from "../services/inventory/proxySecretHygiene";
import { proxyPasswordSecretKey } from "../services/ssh/silentAuth";
import { deviceTemplateFormDefinition, type ServerListEntry } from "../ui/formDefinitions";
import type { FormValues } from "../ui/formTypes";
import { WebviewFormPanel } from "../ui/webviewFormPanel";
import { FolderTreeItem } from "../ui/nexusTreeProvider";
import { formValuesToProxy } from "./serverCommands";
import { isDescendantOrSelf } from "../utils/folderPaths";
import { naturalCompare } from "../utils/naturalCompare";
import type { CommandContext } from "./types";

/**
 * DEVICE TEMPLATES (issue #48 PR-T1b) — the user-visible surface on top of the
 * merged T1 engine: the tri-state editor (§7.1), and the manual folder-apply
 * command (§7.4) that clears the stamps of the fields it writes and gates its
 * auth-link fill on the SAME shared eligibility predicates the sync path uses.
 * Adopted copy is reproduced verbatim.
 */

/**
 * Reads one field's `{mode, value}` off the submitted form, or `undefined` when
 * the mode select is "Not set".
 *
 * P3 (adversarial minor 4) — when the mode IS `fill`/`override` but the value
 * control resolves to nothing usable (proxyType "none"/invalid host, no auth
 * profile picked), the field is NOT silently dropped: that discards a choice the
 * user deliberately made and re-opens showing "Not set" where they chose a mode.
 * Instead throw, routing the message through the form framework's validation
 * channel (`webviewFormPanel`'s submit try/catch surfaces it and keeps the form
 * open), exactly like the "Name is required" reject below.
 */
function readTemplateField<T>(
  values: FormValues,
  field: TemplatableField,
  readValue: () => T | undefined
): TemplateField<T> | undefined {
  const rawMode = values[`mode_${field}`];
  if (rawMode !== "fill" && rawMode !== "override") {
    return undefined;
  }
  const value = readValue();
  if (value === undefined) {
    const label = TEMPLATE_FIELD_SHORT_LABELS[field];
    const modeName = rawMode === "override" ? "Override" : "Fill";
    throw new Error(
      `${label} mode is set to ${modeName} but no value is configured. ` +
        `Choose a value for ${label}, or set its mode to "Not set".`
    );
  }
  return { mode: rawMode as TemplateFieldMode, value };
}

/** Turns a submitted device-template editor form into a `DeviceTemplateProfile`. */
export function parseDeviceTemplateFormValues(values: FormValues, existingId?: string): DeviceTemplateProfile {
  const name = typeof values.name === "string" ? values.name.trim() : "";
  if (!name) {
    throw new Error("Name is required");
  }
  const fields: DeviceTemplateProfile["fields"] = {};
  const proxy = readTemplateField<ProxyConfig>(values, "proxy", () => formValuesToProxy(values));
  if (proxy) {
    fields.proxy = proxy;
  }
  const auth = readTemplateField<string>(values, "authProfileId", () => {
    const raw = values.authProfileId;
    return typeof raw === "string" && raw !== "" && !raw.startsWith("__create__") ? raw : undefined;
  });
  if (auth) {
    fields.authProfileId = auth;
  }
  const mpx = readTemplateField<boolean>(values, "multiplexing", () => values.multiplexing === true);
  if (mpx) {
    fields.multiplexing = mpx;
  }
  const legacy = readTemplateField<boolean>(values, "legacyAlgorithms", () => values.legacyAlgorithms === true);
  if (legacy) {
    fields.legacyAlgorithms = legacy;
  }
  const log = readTemplateField<boolean>(values, "logSession", () => values.logSession === true);
  if (log) {
    fields.logSession = log;
  }
  // PR-T3 — the two IPMI id references. Both submit under their own key from a
  // filterable select; a "(None)"/empty pick or the `__create__` sentinel reads
  // as "no value" (throws if a mode was chosen — same as the SSH auth row).
  const ipmiAuth = readTemplateField<string>(values, "ipmiAuthProfileId", () => {
    const raw = values.ipmiAuthProfileId;
    return typeof raw === "string" && raw !== "" && !raw.startsWith("__create__") ? raw : undefined;
  });
  if (ipmiAuth) {
    fields.ipmiAuthProfileId = ipmiAuth;
  }
  const ipmiGateway = readTemplateField<string>(values, "ipmiGatewayServerId", () => {
    const raw = values.ipmiGatewayServerId;
    return typeof raw === "string" && raw !== "" ? raw : undefined;
  });
  if (ipmiGateway) {
    fields.ipmiGatewayServerId = ipmiGateway;
  }
  return { id: existingId ?? randomUUID(), name, fields };
}

function serverListEntries(ctx: CommandContext): ServerListEntry[] {
  return ctx.core.getSnapshot().servers.map((s) => ({ id: s.id, name: s.name }));
}

/** The inventory sources whose `templateRules` reference this template id. */
function sourcesReferencingTemplate(ctx: CommandContext, templateId: string): { id: string; name: string }[] {
  return ctx.core
    .getSnapshot()
    .inventorySources.filter((source) => (source.templateRules ?? []).some((rule) => rule.templateId === templateId))
    .map((source) => ({ id: source.id, name: source.name }));
}

/** Do two referencing-source lists name the exact same set of ids? (order-independent). */
function sameSourceIdSet(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const ids = new Set(a.map((s) => s.id));
  return b.every((s) => ids.has(s.id));
}

/** Opens the editor (Add when `seed` is undefined, Edit otherwise). Returns the
 * panel so the rules flow's inline-create (UX-M5) can await its outcome. */
function openDeviceTemplateEditor(ctx: CommandContext, seed?: DeviceTemplateProfile): WebviewFormPanel {
  const snapshot = ctx.core.getSnapshot();
  const definition = deviceTemplateFormDefinition(seed, serverListEntries(ctx), snapshot.authProfiles);
  const formId = seed?.id ? `device-template-edit-${seed.id}` : "device-template-add";
  // FIX B (issue #48 PR-T1b / PR #62 Codex review round 2) — the revision of the
  // record this Edit editor is seeded from, captured before the (unbounded) time
  // the form sits open. `revision` is minted fresh on every
  // `addOrUpdateDeviceTemplate`, so it is the signal that distinguishes "still the
  // record I opened" from "deleted" or "edited elsewhere" at save time. Add-mode
  // (no seed) has no revision and nothing to compare — a fresh id is minted on save.
  const seedRevision = seed?.revision;
  return WebviewFormPanel.open(formId, definition, {
    onSubmit: async (values) => {
      const template = parseDeviceTemplateFormValues(values, seed?.id);
      // FIX C (issue #48 PR-T1b / PR #62 Codex review round 5) — serialize the
      // whole revalidate-then-persist under `configMutationLock`. The round-2/round-1
      // guards below are SYNCHRONOUS-check-then-persist: they close the CHECK
      // interleaving on the single-threaded host, but NOT two concurrent async
      // PERSISTS. `addOrUpdateDeviceTemplate` installs the record then `await`s a
      // whole-array `saveDeviceTemplates`; a delete of the same id, running lock-free,
      // could sweep the record and its source rules while this Save's persist is still
      // in flight — and if this Save's whole-array persist commits LAST, it resurrects
      // the deleted record on disk (last-writer-wins) while its rules are already gone:
      // a torn state. Holding the lock across the revalidation AND the write makes this
      // Save mutually exclusive with the delete flow (and with sync-apply / manual-apply
      // / source persistence, which hold the same lock), so no other template mutation
      // can be mid-persist here. Moving the revision check INSIDE the lock is the point:
      // it now covers "a Save that passed the check and already entered persistence."
      //
      // NO REENTRANCY: this is the codebase's command-layer discipline — the command
      // holds the lock, the core methods (`addOrUpdateDeviceTemplate`,
      // `getDeviceTemplate`, `getAuthProfile`) stay lock-free primitives and never
      // acquire it themselves, so wrapping here cannot deadlock against them.
      // `runExclusive` propagates the callback's thrown error out unchanged (it returns
      // the callback's promise), so the throw-to-keep-form-open behavior is preserved:
      // a rejected revalidation still surfaces through WebviewFormPanel's submit
      // try/catch. The `Sync Affected Sources` dispatch below stays OUTSIDE the lock —
      // it runs after the save and itself dispatches `nexus.inventory.syncNow`, which
      // takes this same lock, and must not nest.
      await configMutationLock.runExclusive(async () => {
        // FIX B (PR #62 Codex round 2) — an Edit whose template was DELETED while the
        // editor sat open must not resurrect it, and one edited ELSEWHERE must not be
        // silently clobbered. `addOrUpdateDeviceTemplate` treats a now-missing id as a
        // brand-new template (it upserts by id), so without this guard a Save re-creates
        // the deleted record — detached from the source rules the deletion swept.
        // Re-resolve the seeded id against LIVE core (now under the lock) and reject a
        // missing record (deleted) or a changed revision (stale edit), keeping the form
        // open with the reason. Add-mode (no `seed?.id`) is unaffected: there is no
        // prior record.
        if (seed?.id !== undefined) {
          const liveTemplate = ctx.core.getDeviceTemplate(seed.id);
          if (liveTemplate === undefined) {
            throw new Error(
              "This device template was deleted while the editor was open — nothing was saved. " +
                "Reopen Manage Device Templates to create it again if you still need it."
            );
          }
          if (liveTemplate.revision !== seedRevision) {
            throw new Error(
              "This device template was changed elsewhere while the editor was open — nothing was saved. " +
                "Reopen it to pick up the current version, then redo your edit."
            );
          }
        }
        // MECHANISM 2 (P2 #4, PR #62 Codex round 1) — resolve a submitted
        // `authProfileId` against LIVE core immediately before persisting. The
        // profile-deletion sweep (`removeAuthProfile`) only clears the link off
        // templates that ALREADY reference the profile — it cannot reach the link
        // this Save is about to write for the FIRST time (or newly point at a
        // different profile). So a profile deleted while this editor sat open
        // would otherwise be persisted as a dangling `fields.authProfileId` that
        // §5.3 reference-validation later drops with a warning at apply time —
        // silent to the author. `authProfileId` is the only templatable field that
        // carries a cross-record reference resolved here; `proxy.jumpHostId` is
        // validated at apply time (§5.3) against the target fleet, not against a
        // single form. Throwing routes through WebviewFormPanel's submit try/catch,
        // which keeps the editor open with the message — exactly like
        // `readTemplateField`'s "no value" reject.
        const linkedAuthProfileId = template.fields.authProfileId?.value;
        if (linkedAuthProfileId !== undefined && ctx.core.getAuthProfile(linkedAuthProfileId) === undefined) {
          throw new Error(
            "The selected auth profile no longer exists — it was deleted while this editor was open. " +
              'Choose another auth profile, or set the Auth Profile field\'s mode to "Not set".'
          );
        }
        // The BMC `ipmiAuthProfileId` (issue #48 PR-T3) is the second templatable
        // field carrying a cross-record reference into the AuthProfile store, so
        // it gets the SAME live-core revalidation as the SSH link above, in the
        // same locked section: a profile deleted while this editor sat open would
        // otherwise persist as a dangling `fields.ipmiAuthProfileId` that §5.3
        // silently drops at apply time. No parallel gateway guard —
        // `ipmiGatewayServerId` is a server-list reference validated at apply time
        // (§5.3 skip-and-warn), exactly like `proxy.jumpHostId`, per the comment
        // above; only auth-profile refs are revalidated in the form.
        const linkedIpmiAuthProfileId = template.fields.ipmiAuthProfileId?.value;
        if (linkedIpmiAuthProfileId !== undefined && ctx.core.getAuthProfile(linkedIpmiAuthProfileId) === undefined) {
          throw new Error(
            "The selected IPMI auth profile no longer exists — it was deleted while this editor was open. " +
              'Choose another IPMI auth profile, or set the IPMI Auth Profile field\'s mode to "Not set".'
          );
        }
        await ctx.core.addOrUpdateDeviceTemplate(template);
      });
      // U1 (§6.1 UX-S8) — the VERBATIM save toast (single "saved." wording, not a
      // created/updated split), telling the user the edit takes effect on each
      // source's next sync. The `Sync Affected Sources` button is offered only
      // when at least one source's rules reference this template — a just-created
      // template referenced by nothing shows the toast without the button.
      const affected = sourcesReferencingTemplate(ctx, template.id);
      const SYNC = "Sync Affected Sources";
      const message = `Device template "${template.name}" saved. Changes apply on each source's next sync.`;
      const choice =
        affected.length > 0
          ? await vscode.window.showInformationMessage(message, SYNC)
          : (void vscode.window.showInformationMessage(message), undefined);
      if (choice === SYNC) {
        // Reuse the existing sync-now flow (with its plan preview) for every
        // referencing source — never a second, previewless write path (§6.1).
        for (const source of affected) {
          await vscode.commands.executeCommand("nexus.inventory.syncNow", source.id);
        }
      }
    }
  });
}

/** UX-M5 empty-state placeholder for the manage hub (never the legacy dead-end). */
const EMPTY_STATE_PLACEHOLDER =
  "No device templates yet. A device template applies shared settings — proxy, auth profile, and more — to servers synced from inventory.";

/**
 * U3 (§7.1 CRUD, §6.2) — the confirm modal + `removeDeviceTemplate` wiring, using
 * the auth-profile delete idiom (a modal naming the template). Per §6.2 the record
 * is removed and every referencing `templateRules` entry cleared, but applied
 * VALUES and STAMPS already on servers are KEPT (reclaimable) — the modal says so.
 */
async function deleteDeviceTemplateFlow(ctx: CommandContext): Promise<void> {
  const templates = ctx.core.getSnapshot().deviceTemplates;
  if (templates.length === 0) {
    return;
  }
  const pick = await vscode.window.showQuickPick(
    templates
      .slice()
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((t) => ({ label: t.name, description: describeTemplateFields(t), template: t })),
    { title: "Delete Device Template", placeHolder: "Select a device template to delete" }
  );
  if (!pick) {
    return;
  }
  const referencing = sourcesReferencingTemplate(ctx, pick.template.id);
  const sourceNote =
    referencing.length > 0
      ? ` It is cleared from ${referencing.length === 1 ? "1 inventory source's rules" : `${referencing.length} inventory sources' rules`}.`
      : "";
  const detail = `Values and stamps already applied to servers are kept — deleting removes only the template and its rules.${sourceNote}`;
  const confirm = await vscode.window.showWarningMessage(
    `Delete device template "${pick.template.name}"?`,
    { modal: true, detail },
    "Delete"
  );
  if (confirm !== "Delete") {
    return;
  }
  // FIX C (issue #48 PR-T1b / PR #62 Codex review round 5) — serialize the removal
  // under `configMutationLock` and REVALIDATE inside the exclusive section, mirroring
  // the manual-apply (`applyToFolder`) and auth-profile-delete divergence guards. The
  // confirm modal above is an unbounded wait; a concurrent editor Save, sync-apply, or
  // another delete can run while it sits open. Two lock-free whole-array persists
  // completing out of order tear disk state (a Save's late persist resurrects a record
  // this delete already swept). Holding the lock across the revalidation AND
  // `removeDeviceTemplate` makes this mutually exclusive with those flows (which hold
  // the same lock), so no other template persist can be mid-flight. NO REENTRANCY:
  // `removeDeviceTemplate` is a lock-free core primitive (command-layer discipline).
  // The modal already resolved, and nothing below shows UI while the lock is held
  // (the deferred `refusal` toast fires after release), honoring the lock's
  // "never hold across interactive UI" rule.
  let refusal: string | undefined;
  await configMutationLock.runExclusive(async () => {
    // The picked template must still exist — a concurrent delete/reset could have
    // removed it while the confirm sat open. Name the change rather than silently
    // reporting a deletion of nothing.
    const live = ctx.core.getDeviceTemplate(pick.template.id);
    if (live === undefined) {
      refusal =
        `The device template "${pick.template.name}" was changed while the confirmation was open — nothing was deleted. ` +
        "Reopen Manage Device Templates to review the current templates.";
      return;
    }
    // FIX (issue #48 PR-T1b / PR #62 Codex review round 6) — existence alone is not
    // enough: an editor Save (e.g. a rename) that completes while the confirm modal
    // sits open serializes behind this lock, but leaves a NEWLY-EDITED incarnation of
    // the same id. The existence check would wave it through and this delete would
    // sweep a template whose edit the confirmation never disclosed. `revision` is
    // minted fresh on every `addOrUpdateDeviceTemplate`, so it is the signal that the
    // record diverged from the one the modal named. This is the delete-side twin of
    // the round-2 edit-save revision guard (and the round-1 apply revision guard).
    if (live.revision !== pick.template.revision) {
      refusal =
        `The device template "${pick.template.name}" was changed while the confirmation was open — nothing was deleted. ` +
        "Run Delete again to review the current version.";
      return;
    }
    // The disclosed referencing-source set must still match what the confirm modal
    // showed. A rule added/removed under the open modal would make the "cleared from
    // N sources' rules" disclosure untruthful — refuse and ask the user to re-run so
    // the disclosure is accurate (same divergence-refusal shape as the manual-apply
    // and auth-profile-delete guards).
    if (!sameSourceIdSet(sourcesReferencingTemplate(ctx, pick.template.id), referencing)) {
      refusal =
        `What deleting "${pick.template.name}" would clear changed while the confirmation was open — nothing was deleted. ` +
        "Delete it again to review what it is referenced by now.";
      return;
    }
    await ctx.core.removeDeviceTemplate(pick.template.id);
  });
  if (refusal !== undefined) {
    void vscode.window.showWarningMessage(refusal);
    return;
  }
  void vscode.window.showInformationMessage(`Device template "${pick.template.name}" deleted.`);
}

async function manageDeviceTemplates(ctx: CommandContext): Promise<void> {
  const templates = ctx.core.getSnapshot().deviceTemplates;
  if (templates.length === 0) {
    // Constructive placeholder + New button (UX-M5) — never "No X configured".
    const choice = await vscode.window.showInformationMessage(EMPTY_STATE_PLACEHOLDER, "New Device Template");
    if (choice === "New Device Template") {
      openDeviceTemplateEditor(ctx);
    }
    return;
  }
  const NEW = "$(add) New Device Template";
  const DELETE = "$(trash) Delete a Device Template…";
  type ManageAction = "new" | "delete" | "edit";
  const pick = await vscode.window.showQuickPick(
    [
      { label: NEW, action: "new" as ManageAction, template: undefined as DeviceTemplateProfile | undefined },
      ...templates
        .slice()
        .sort((a, b) => naturalCompare(a.name, b.name))
        .map((t) => ({ label: t.name, description: describeTemplateFields(t), action: "edit" as ManageAction, template: t as DeviceTemplateProfile | undefined })),
      // U3 — a dedicated delete entry, so selecting a template row keeps its
      // meaning (edit) and delete is an explicit, separately-confirmed choice.
      { label: DELETE, action: "delete" as ManageAction, template: undefined as DeviceTemplateProfile | undefined }
    ],
    { title: "Manage Device Templates", placeHolder: "Select a device template to edit, create a new one, or delete one" }
  );
  if (!pick) {
    return;
  }
  if (pick.action === "delete") {
    await deleteDeviceTemplateFlow(ctx);
    return;
  }
  openDeviceTemplateEditor(ctx, pick.template);
}

/**
 * A one-line "Sets: Proxy, Auth Profile" summary. PR-T3 review FIX 6 — delegates
 * to the shared `templateSetsLabels` enumeration (the single source of field
 * order, §7.2), so this hub / Apply-picker summary and the rules-view detail read
 * the SAME spelling and ordering everywhere. Keeps this surface's own empty-state
 * string ("Sets nothing yet").
 */
function describeTemplateFields(template: DeviceTemplateProfile): string {
  const set = templateSetsLabels(template);
  return set.length > 0 ? `Sets: ${set.join(", ")}` : "Sets nothing yet";
}

function serversInFolder(ctx: CommandContext, folderPath: string): ServerConfig[] {
  return ctx.core.getSnapshot().servers.filter((s) => s.group && isDescendantOrSelf(s.group, folderPath));
}

/** B1 — do two server lists name the exact same set of ids? (order-independent). */
function sameServerIds(a: readonly ServerConfig[], b: readonly ServerConfig[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const ids = new Set(a.map((s) => s.id));
  return b.every((s) => ids.has(s.id));
}

async function pickTemplate(ctx: CommandContext): Promise<DeviceTemplateProfile | undefined> {
  const templates = ctx.core.getSnapshot().deviceTemplates;
  if (templates.length === 0) {
    // Zero-template state (UX-M5) — a MODAL (P6, §7.4 UX-M5 "shows a modal") so
    // it cannot be missed, offering New instead of a dead-end warning.
    const choice = await vscode.window.showInformationMessage(EMPTY_STATE_PLACEHOLDER, { modal: true }, "New Device Template");
    if (choice === "New Device Template") {
      openDeviceTemplateEditor(ctx);
    }
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    templates
      .slice()
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((t) => ({ label: t.name, description: describeTemplateFields(t), template: t })),
    { title: "Apply Device Template" }
  );
  return pick?.template;
}

/** "1 server" / "3 servers" — the modal and the report must agree. */
function serverCountPhrase(count: number): string {
  return count === 1 ? "1 server" : `${count} servers`;
}

/** "1 hand-configured login" / "9 hand-configured logins" (P5 pluralization). */
function loginCountPhrase(count: number): string {
  return `${count} hand-configured ${count === 1 ? "login" : "logins"}`;
}

/**
 * The §7.4 (UX-S7) consent-modal BODY — the per-field dry-run lines with the
 * auth link's skips split by reason, the plan's reference-validation warnings
 * (U2 — dangling jump host / auth profile / self-proxy: every dropped-for-
 * reference field must be visible before the user confirms), and the verbatim
 * ownership sentence. Rendered into the modal's `detail` slot (P7); the headline
 * that names the template + folder is the modal `message`.
 *
 * P5 — the per-line counts go through `serverCountPhrase` / `loginCountPhrase`,
 * so "1 server will be set" and "replacing 1 hand-configured login" read
 * correctly, not "1 servers"/"1 logins".
 */
function buildConsentModalDetail(plan: ManualApplyPlan): string {
  const lines: string[] = [];
  const valueLine = (field: TemplatableField, stats: { mode: TemplateFieldMode; willSet: number; skipped: number } | undefined): void => {
    if (!stats) {
      return;
    }
    const mode = stats.mode === "override" ? "Override" : "Fill";
    lines.push(`${TEMPLATE_FIELD_SHORT_LABELS[field]} (${mode}): ${serverCountPhrase(stats.willSet)} will be set, ${stats.skipped} skipped`);
  };
  valueLine("proxy", plan.proxy);
  valueLine("multiplexing", plan.multiplexing);
  valueLine("legacyAlgorithms", plan.legacyAlgorithms);
  valueLine("logSession", plan.logSession);
  valueLine("ipmiAuthProfileId", plan.ipmiAuthProfileId);
  valueLine("ipmiGatewayServerId", plan.ipmiGatewayServerId);
  if (plan.auth) {
    const a = plan.auth;
    if (a.mode === "fill") {
      let line = `Auth Profile (Fill): ${serverCountPhrase(a.linked)} will be linked; ${a.skippedAlreadyLinked} skipped (already linked); ${a.skippedLoginConfigured} skipped (SSH login already configured)`;
      if (a.skippedNeedsKey > 0) {
        line += `; ${a.skippedNeedsKey} skipped (profile needs a key file the server doesn't have)`;
      }
      lines.push(line);
    } else {
      let line = `Auth Profile (Override): ${serverCountPhrase(a.linked)} will be linked, replacing ${loginCountPhrase(a.replacingHandConfigured)}`;
      if (a.skippedNeedsKey > 0) {
        line += `; ${a.skippedNeedsKey} skipped (profile needs a key file the server doesn't have)`;
      }
      lines.push(line);
    }
  }
  // U2 — surface every reference-validation warning (a field silently dropped
  // because its jump host / auth profile is gone, or a per-device self-proxy
  // skip) so the user never consents to a plan that quietly discarded a field.
  for (const warning of plan.warnings) {
    lines.push(warning);
  }
  lines.push("");
  lines.push("Values applied here count as your own edits — future inventory syncs will not change them.");
  return lines.join("\n");
}

/** Builds a `ManualApplyPlan` from live core state for a set of servers. */
function planFor(ctx: CommandContext, template: DeviceTemplateProfile, servers: readonly ServerConfig[]): ManualApplyPlan {
  const liveServerIds = new Set(ctx.core.getSnapshot().servers.map((s) => s.id));
  return planManualTemplateApply({
    template,
    servers,
    sourceDefaultUsername: (sourceId) => ctx.core.getInventorySource(sourceId)?.defaultUsername,
    authProfile: (id) => ctx.core.getAuthProfile(id),
    hasServer: (id) => liveServerIds.has(id)
  });
}

/**
 * Applies the plan's writes to LIVE server records, re-read immediately before
 * each write (the `authProfileCommands.ts` single-writer discipline), and clears
 * the stamps of the fields each write touched (§7.4 ownership rule). Non-synced
 * servers have no `origin`, so the clear is a no-op there.
 *
 * REFERENCE FIELDS ARE RE-RESOLVED PER WRITE (issue #48 PR-T3, PR #66 Codex round
 * 6). The three cross-record references — `ipmiGatewayServerId` (a `ServerConfig.id`)
 * and the two auth links (`authProfileId` / `ipmiAuthProfileId`, `AuthProfile.id`s) —
 * are validated at PLAN time, but this loop yields at every `addOrUpdateServer`, so
 * a concurrent deletion can land between writes. The flagged path: `nexus.group.remove`
 * (folder delete) prunes servers WITHOUT taking `configMutationLock`, so it can delete
 * the selected IPMI gateway from another folder mid-apply even though this apply runs
 * under the lock. Its deletion sweep (`clearGatewayReferencesTo`) only reaches servers
 * ALREADY written; a server written AFTER it would re-introduce the dangling link, which
 * then silently routes IPMI locally. So each reference is RE-RESOLVED against live core
 * immediately before the write and, if it no longer resolves, SKIPPED and dropped from
 * the stamp-clear set (neither written nor recorded as hand-owned). Robust without a
 * second lock: every deletion path mutates `this.servers` / the auth store in memory
 * synchronously before its own persist await, so this synchronous re-read always observes
 * a committed deletion. The gateway is the demonstrated race; the two auth checks are the
 * same-class guard (never persist a dangling reference) and cost one lookup each.
 */
export async function applyPlanWrites(ctx: CommandContext, plan: ManualApplyPlan): Promise<number> {
  let applied = 0;
  for (const write of plan.serverWrites) {
    const live = ctx.core.getServer(write.serverId);
    if (!live) {
      continue;
    }
    const next: ServerConfig = { ...live };
    // A field skipped below (its reference no longer resolves) must NOT be treated
    // as written by the §7.4 stamp clear — so work off a mutable copy of the plan's
    // written-field list and drop any reference we decline to persist.
    const writtenFields = [...write.writtenFields];
    const dropWritten = (field: TemplatableField): void => {
      const i = writtenFields.indexOf(field);
      if (i >= 0) {
        writtenFields.splice(i, 1);
      }
    };
    if (write.proxy !== undefined) {
      next.proxy = write.proxy;
    }
    if (write.multiplexing !== undefined) {
      next.multiplexing = write.multiplexing;
    }
    if (write.legacyAlgorithms !== undefined) {
      next.legacyAlgorithms = write.legacyAlgorithms;
    }
    if (write.logSession !== undefined) {
      next.logSession = write.logSession;
    }
    if (write.authProfileId !== undefined) {
      if (ctx.core.getAuthProfile(write.authProfileId) !== undefined) {
        next.authProfileId = write.authProfileId;
      } else {
        dropWritten("authProfileId"); // profile deleted since the plan was computed
      }
    }
    if (write.ipmiAuthProfileId !== undefined) {
      if (ctx.core.getAuthProfile(write.ipmiAuthProfileId) !== undefined) {
        next.ipmiAuthProfileId = write.ipmiAuthProfileId;
      } else {
        dropWritten("ipmiAuthProfileId");
      }
    }
    if (write.ipmiGatewayServerId !== undefined) {
      if (ctx.core.getServer(write.ipmiGatewayServerId) !== undefined) {
        next.ipmiGatewayServerId = write.ipmiGatewayServerId;
      } else {
        dropWritten("ipmiGatewayServerId"); // gateway server pruned since the plan was computed
      }
    }
    // §7.4 — clear the stamps of exactly the fields written, so every one reads
    // as a hand edit (row 7) to later syncs. `clearTemplatedStamps` also clears
    // `syncedAuthProfileId` when the auth link is among the written fields.
    const clearedOrigin = clearTemplatedStamps(live.origin, writtenFields);
    if (clearedOrigin === undefined) {
      delete next.origin;
    } else {
      next.origin = clearedOrigin;
    }
    await ctx.core.addOrUpdateServer(next);
    applied++;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// §7.2 (PR-T2) "Edit Template Rules…" — the QuickPick-driven rule management flow
// (list → add / edit / remove), matching the codebase's sequential-prompt
// precedents (`manageSources`) rather than a dynamic list editor in the static
// form framework. The three-slot rows, live filter feedback, and save-time
// warnings live in the pure `templateRulesView` module; this is the thin vscode
// orchestrator over it.
// ---------------------------------------------------------------------------

/** UX-S3 (VERBATIM) — the one-breath cascade explanation, the ONE place cascade vocabulary lives. */
const CASCADE_PLACEHOLDER =
  "Most specific rule wins, per setting — a narrow rule overrides only the settings its template sets; broader rules still supply the rest. Order here doesn't matter.";

/** UX-M5 — open the New Device Template editor and RESOLVE with the template that lands (or undefined if dismissed), so the rule flow can continue with it selected. */
function createTemplateInteractively(ctx: CommandContext): Promise<DeviceTemplateProfile | undefined> {
  const knownIds = new Set(ctx.core.getSnapshot().deviceTemplates.map((t) => t.id));
  return new Promise<DeviceTemplateProfile | undefined>((resolve) => {
    let settled = false;
    const panel = openDeviceTemplateEditor(ctx);
    const stop = ctx.core.onDidChange(() => {
      const added = ctx.core.getSnapshot().deviceTemplates.find((t) => !knownIds.has(t.id));
      if (added && !settled) {
        settled = true;
        stop();
        resolve(added);
      }
    });
    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        stop();
        resolve(undefined); // editor closed without a save
      }
    });
  });
}

/** The template a rule applies — an existing one, or a freshly created one (UX-M5 zero-template empty state). */
async function pickRuleTemplate(ctx: CommandContext, seedTemplateId: string | undefined): Promise<DeviceTemplateProfile | undefined> {
  // U1 (PR-T2 review) — the rule's CURRENT template sorts FIRST and is marked, so
  // an Edit visibly opens on the value the rule already carries (VS Code honours
  // `picked` only for canPickMany, so this single-select needs a visible marker
  // AND ordering, not a no-op `picked:`, or a mis-pick silently rewires the rule).
  const templates = ctx.core.getSnapshot().deviceTemplates.slice().sort((a, b) => {
    if (a.id === seedTemplateId && b.id !== seedTemplateId) {
      return -1;
    }
    if (b.id === seedTemplateId && a.id !== seedTemplateId) {
      return 1;
    }
    return naturalCompare(a.name, b.name);
  });
  interface TemplateRow extends vscode.QuickPickItem {
    template?: DeviceTemplateProfile;
    create?: boolean;
  }
  const rows: TemplateRow[] = templates.map((t) => {
    const isCurrent = t.id === seedTemplateId;
    const fields = describeTemplateFields(t);
    return {
      label: isCurrent ? `$(check) ${t.name}` : t.name,
      description: isCurrent ? (fields ? `current • ${fields}` : "current") : fields,
      template: t
    };
  });
  if (rows.length > 0) {
    rows.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  }
  rows.push({ label: templates.length === 0 ? "No device templates yet — create one now" : "$(add) Create new device template…", create: true });
  const pick = await vscode.window.showQuickPick(rows, {
    title: "Rule Template",
    placeHolder: templates.length === 0 ? "No device templates yet — create one now" : "Choose the device template this rule applies"
  });
  if (!pick) {
    return undefined;
  }
  if (pick.create) {
    return createTemplateInteractively(ctx); // continues the flow with the new template selected
  }
  return pick.template;
}

/** UX-S2 — the filter InputBox with live, severity-graded feedback via the validation channel. Returns the raw entered filter, or undefined on cancel. */
async function promptRuleFilter(seed: string | undefined, attributeKeys: readonly string[] | undefined): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "Rule Filter",
    prompt: "Keys: role, site, location, rack, tenant, status, platform, tag, name — e.g. role=switch&site=syd",
    value: seed ?? "",
    ignoreFocusOut: true,
    validateInput: (input) => {
      const fb = filterFeedback(input, attributeKeys);
      const severity = fb.blocking
        ? vscode.InputBoxValidationSeverity.Error // empty value blocks accept (§2.3)
        : fb.severity === "warning"
          ? vscode.InputBoxValidationSeverity.Warning // unknown key — non-blocking (§2.2)
          : vscode.InputBoxValidationSeverity.Info; // the live "Matches devices where…" note
      return { message: fb.message, severity };
    }
  });
}

/**
 * M3 (PR-T2 review) — persist a rule DELTA under the config lock, resolving it
 * against the source read FRESH INSIDE the lock (the T1b resolve-under-lock
 * discipline). `apply` receives the current `templateRules` and returns the new
 * array, or `"diverged"` when the specific rule this flow set out to edit has
 * itself changed or vanished under a concurrent edit — in which case nothing is
 * saved and the user gets the house "changed while open, re-run" message rather
 * than a wholesale overwrite that silently drops the other window's edit. The
 * unknown-key warning is raised only for `changedRule` (the rule just written),
 * not every rule in the source (P4).
 */
async function saveTemplateRules(
  ctx: CommandContext,
  live: InventorySourceConfig,
  apply: (freshRules: TemplateRule[]) => TemplateRule[] | "diverged",
  changedRule: TemplateRule | undefined,
  attributeKeys: readonly string[] | undefined
): Promise<void> {
  let savedRules: TemplateRule[] | undefined;
  let diverged = false;
  await configMutationLock.runExclusive(async () => {
    const fresh = ctx.core.getInventorySource(live.id);
    if (fresh === undefined) {
      return; // source removed underneath us
    }
    const next = apply(fresh.templateRules ?? []);
    if (next === "diverged") {
      diverged = true;
      return;
    }
    // Codex round 2 #2 — resolve the rule's template UNDER THE LOCK before persisting
    // (the T1b resolve-under-lock discipline). The template picked in this flow can be
    // deleted (its deletion sweep run) between the picker closing and the filter prompt
    // being accepted; persisting then leaves a rule pointing at a missing template that
    // is silently skipped on every future sync. If the template is gone, refuse — treat
    // it as the same "changed while you were editing" divergence, saving nothing. Only
    // add/edit carries a template ref (`changedRule`); a removal has none.
    if (changedRule !== undefined && ctx.core.getDeviceTemplate(changedRule.templateId) === undefined) {
      diverged = true;
      return;
    }
    savedRules = next;
    await ctx.core.addOrUpdateInventorySource({ ...fresh, templateRules: next.length > 0 ? next : undefined });
  });
  if (diverged) {
    void vscode.window.showWarningMessage(
      "These template rules were changed in another window while this editor was open — nothing was saved. Re-run Edit Template Rules and try again."
    );
    return;
  }
  if (savedRules === undefined) {
    return;
  }
  const templatesById = new Map(ctx.core.getSnapshot().deviceTemplates.map((t) => [t.id, t] as const));
  for (const w of saveOverlapWarnings(savedRules, templatesById)) {
    void vscode.window.showWarningMessage(w);
  }
  // P4 — warn only about the rule just written, not every rule on the source.
  if (changedRule !== undefined) {
    const unknown = unknownFilterKeys(parseTemplateFilter(changedRule.filter), attributeKeys);
    if (unknown.length > 0) {
      // U2 — carry §2.2's actionable "Known keys: …" clause the live-feedback path
      // (templateRulesView.filterFeedback) already shows; the save-time toast must too.
      const known = (attributeKeys ?? []).join(", ");
      void vscode.window.showWarningMessage(
        `Rule "${filterLabel(changedRule.filter)}": key '${unknown[0]}' is not one this source's provider reports — this rule will never match. Known keys: ${known}`
      );
    }
  }
}

/** Add a new rule or edit an existing one: pick template (or create), enter filter, persist. */
async function addOrEditTemplateRule(
  ctx: CommandContext,
  live: InventorySourceConfig,
  existing: TemplateRule | undefined,
  attributeKeys: readonly string[] | undefined
): Promise<void> {
  const template = await pickRuleTemplate(ctx, existing?.templateId);
  if (template === undefined) {
    return;
  }
  const raw = await promptRuleFilter(existing?.filter, attributeKeys);
  if (raw === undefined) {
    return; // cancelled
  }
  // Empty / whitespace canonicalizes to a catch-all (absent filter), §2.3.
  const filter = raw.trim() === "" ? undefined : raw.trim();
  const newRule: TemplateRule = { id: existing?.id ?? randomUUID(), templateId: template.id, filter };
  await saveTemplateRules(
    ctx,
    live,
    (freshRules) => {
      if (existing === undefined) {
        return [...freshRules, newRule]; // ADD — a fresh UUID, so no id collision with concurrent edits
      }
      // EDIT — replace by id, preserving a concurrent edit to any OTHER rule. If
      // the rule we set out to edit is gone OR its own filter/template was
      // concurrently changed while this editor sat in the prompts, refuse rather
      // than resurrect/clobber it — existence alone is not enough (Codex round 1
      // #1): a same-rule concurrent edit passes `some` yet must not be overwritten
      // by this editor's `newRule`, which was seeded from the now-stale `existing`.
      const freshExisting = freshRules.find((r) => r.id === existing.id);
      if (freshExisting === undefined) {
        return "diverged"; // deleted underneath us
      }
      if (freshExisting.filter !== existing.filter || freshExisting.templateId !== existing.templateId) {
        return "diverged"; // concurrently changed — do not clobber the other edit
      }
      return freshRules.map((r) => (r.id === existing.id ? newRule : r));
    },
    newRule,
    attributeKeys
  );
}

/** The source whose rules to edit — the arg, the only source, or a picker. */
async function pickSourceForRules(ctx: CommandContext): Promise<InventorySourceConfig | undefined> {
  const sources = ctx.core.getSnapshot().inventorySources;
  if (sources.length === 0) {
    // P5 (PR-T2 review) — house style: offer the action, not a dead end.
    const choice = await vscode.window.showWarningMessage(
      "Template rules live on an inventory source, and none is configured yet.",
      "Add Inventory Source"
    );
    if (choice === "Add Inventory Source") {
      await vscode.commands.executeCommand("nexus.inventory.addSource");
    }
    return undefined;
  }
  if (sources.length === 1) {
    return sources[0];
  }
  const pick = await vscode.window.showQuickPick(
    sources.map((s) => ({ label: s.name, source: s })),
    { title: "Edit Template Rules", placeHolder: "Choose an inventory source" }
  );
  return pick?.source;
}

/** §7.2 — the "Edit Template Rules…" management loop (list → add / edit / remove / floor→editSource). */
async function editTemplateRules(ctx: CommandContext, registry: InventoryProviderRegistry, sourceIdArg?: string): Promise<void> {
  const chosen = sourceIdArg ? ctx.core.getInventorySource(sourceIdArg) : await pickSourceForRules(ctx);
  if (chosen === undefined) {
    return;
  }
  const attributeKeys = registry.get(chosen.providerId)?.attributeKeys;
  for (;;) {
    const live = ctx.core.getInventorySource(chosen.id);
    if (live === undefined) {
      return; // source removed underneath us
    }
    const rules = live.templateRules ?? [];
    const templatesById = new Map(ctx.core.getSnapshot().deviceTemplates.map((t) => [t.id, t] as const));
    const items = buildRuleListItems(live, rules, templatesById, (id) => ctx.core.getAuthProfile(id)?.name);
    interface RuleRow extends vscode.QuickPickItem {
      ruleId?: string;
      floor?: boolean;
      add?: boolean;
    }
    const rows: RuleRow[] = items.map((i) => ({
      label: i.label,
      description: i.description,
      detail: i.detail,
      ruleId: i.ruleId,
      floor: i.floor
    }));
    rows.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    rows.push({ label: "$(add) Add rule…", add: true });
    const picked = await vscode.window.showQuickPick(rows, { title: `Template Rules — ${live.name}`, placeHolder: CASCADE_PLACEHOLDER });
    if (!picked) {
      return;
    }
    if (picked.floor) {
      // UX-S4 — the implicit source-default floor row routes to editSource, where the source auth profile lives.
      await vscode.commands.executeCommand("nexus.inventory.editSource", live.id);
      return;
    }
    if (picked.add) {
      await addOrEditTemplateRule(ctx, live, undefined, attributeKeys);
      continue;
    }
    if (picked.ruleId !== undefined) {
      const existing = rules.find((r) => r.id === picked.ruleId);
      if (existing === undefined) {
        continue;
      }
      const action = await vscode.window.showQuickPick(
        [
          { label: "$(edit) Edit…", act: "edit" as const },
          { label: "$(trash) Remove", act: "remove" as const }
        ],
        { title: filterLabel(existing.filter) }
      );
      if (!action) {
        continue;
      }
      if (action.act === "remove") {
        // REMOVE is idempotent and commutes with a concurrent edit to any other
        // rule, so it applies onto fresh with no divergence check — filtering an
        // already-gone id is a harmless no-op. No unknown-key check on a removal.
        await saveTemplateRules(ctx, live, (freshRules) => freshRules.filter((r) => r.id !== existing.id), undefined, attributeKeys);
      } else {
        await addOrEditTemplateRule(ctx, live, existing, attributeKeys);
      }
    }
  }
}

export function registerDeviceTemplateCommands(ctx: CommandContext, registry: InventoryProviderRegistry): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.deviceTemplate.add", () => {
      openDeviceTemplateEditor(ctx);
    }),

    vscode.commands.registerCommand("nexus.deviceTemplate.manage", () => manageDeviceTemplates(ctx)),

    vscode.commands.registerCommand("nexus.deviceTemplate.editRules", (arg?: unknown) =>
      editTemplateRules(ctx, registry, typeof arg === "string" ? arg : undefined)
    ),

    vscode.commands.registerCommand("nexus.deviceTemplate.applyToFolder", async (arg?: unknown) => {
      if (!(arg instanceof FolderTreeItem)) {
        return;
      }
      const folderPath = arg.folderPath;
      const template = await pickTemplate(ctx);
      if (!template) {
        return;
      }
      const servers = serversInFolder(ctx, folderPath);
      if (servers.length === 0) {
        void vscode.window.showInformationMessage("No servers in this folder.");
        return;
      }
      // MECHANISM 1 (P1 #1, PR #62 Codex round 1) — the revision of the template
      // the modal below is rendered from, captured before the unbounded modal
      // wait. `revision` is minted fresh on every `addOrUpdateDeviceTemplate`, so
      // it is the ONLY signal that distinguishes a value-only in-place edit
      // (override proxy host A→B, a boolean flip) from no edit at all: such an
      // edit keeps the field set, the modes and the per-field counts identical,
      // so `buildConsentModalDetail` renders byte-for-byte the same text and the
      // detail comparator below waves it through — while the recomputed plan
      // would write values the user never saw disclosed.
      const pickedRevision = template.revision;
      const previewPlan = planFor(ctx, template, servers);
      // P7 — a headline naming the template + folder in `message`, the per-field
      // plan lines + `plan.warnings` (U2) in `detail`. `shownDetail` is captured
      // as the disclosure the user consents to, and is the B1 comparator below.
      const shownDetail = buildConsentModalDetail(previewPlan);
      const confirm = await vscode.window.showWarningMessage(
        `Apply device template "${template.name}" to "${folderPath}"?`,
        { modal: true, detail: shownDetail },
        "Apply"
      );
      if (confirm !== "Apply") {
        return;
      }
      // B1 (correctness M1) — the modal above was rendered from `previewPlan`,
      // sampled BEFORE the modal and BEFORE this lock, and both waits are
      // unbounded: a concurrent sync/add/edit can change the folder's server set
      // or the template's fields while the modal sits open. Applying the
      // recomputed plan UNCONDITIONALLY would link/replace/stamp servers the user
      // never saw disclosed (e.g. override auth linking 32 servers after the
      // modal said 2). Mirror `authProfileCommands.ts:193-212` exactly: re-derive
      // under the lock and REFUSE on any divergence — the target server SET (it
      // subsumes the count) AND the full per-field disclosure (`shownDetail`,
      // which encodes every count and warning line). Only apply when the
      // recomputed plan matches what was consented to.
      let refusal: string | undefined;
      let applied = 0;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Applying device template "${template.name}"...` },
        () =>
          configMutationLock.runExclusive(async () => {
            const live = ctx.core.getDeviceTemplate(template.id);
            if (!live) {
              // Lesser sibling — template deleted mid-modal: name the deletion
              // rather than silently report "Applied … to 0 servers."
              refusal =
                `The template was deleted while the confirmation was open — nothing was applied. ` +
                "Run Apply Device Template again to review what it would apply now.";
              return;
            }
            // MECHANISM 1 (P1 #1) — the value-only-edit guard the detail
            // comparator below cannot be: `revision` changes on every save, so a
            // template edited in place while this modal sat open (its fields,
            // modes and counts unchanged, hence its `buildConsentModalDetail`
            // identical) is caught HERE and nowhere else. Placed before the
            // server-set and detail guards, which catch orthogonal drift (folder
            // membership; target-value changes that DO alter the rendered plan).
            if (live.revision !== pickedRevision) {
              refusal =
                `The device template "${template.name}" was edited while the confirmation was open — nothing was applied. ` +
                "Run Apply Device Template again to review the current plan.";
              return;
            }
            const current = serversInFolder(ctx, folderPath);
            // The set first, because it subsumes the count the disclosure renders:
            // two servers leaving and two arriving keeps the number the user
            // agreed to while changing every record this would write.
            if (!sameServerIds(current, servers)) {
              refusal =
                `The servers in "${folderPath}" changed while the confirmation was open — nothing was applied. ` +
                "Run Apply Device Template again to see what it would apply now.";
              return;
            }
            const plan = planFor(ctx, live, current);
            // Everything else the disclosure is built from — the template's fields
            // and each target's current values, all folded into the plan lines.
            if (buildConsentModalDetail(plan) !== shownDetail) {
              refusal =
                `What this template would apply to "${folderPath}" changed while the confirmation was open — nothing was applied. ` +
                "Run Apply Device Template again to review the current plan.";
              return;
            }
            // FIX A (issue #48 PR-T1b / PR #62 Codex review round 2, SECURITY) — the
            // manual apply is the SECOND writer of server proxy config, and until now
            // it published `write.proxy` (applyPlanWrites, below) without clearing the
            // server's stale `proxy-password-{id}`. `ProxySshFactory` reads that secret
            // by server id and would send the OLD endpoint's password to the NEW proxy
            // — the exact round-9/11 leak the sync path already closes. Route this path
            // through the SAME shared hygiene helper (proxySecretHygiene.ts), clearing
            // BEFORE applyPlanWrites publishes, inside this same locked section,
            // fail-closed with restore-on-failure — mirroring the sync ordering exactly
            // (capture+delete → publish → restore-on-failure). §5.3: templates never
            // carry proxy SECRETS, so the new proxy prompts per-connect and clearing
            // the stale secret loses nothing the new proxy should have.
            //
            // The change list is built only from writes that actually set the proxy
            // (`write.proxy !== undefined`): a write that touches no proxy field, or a
            // server the apply doesn't touch, contributes nothing. `before` is the live
            // server's current proxy; `after` is that server with the incoming proxy.
            const vault = ctx.secretVault;
            const proxyChanges: Array<{ before: ServerConfig; after: ServerConfig }> = [];
            for (const write of plan.serverWrites) {
              if (write.proxy === undefined) {
                continue;
              }
              const liveServer = ctx.core.getServer(write.serverId);
              if (!liveServer) {
                continue;
              }
              proxyChanges.push({ before: liveServer, after: { ...liveServer, proxy: write.proxy } });
            }
            let capturedProxySecrets: CapturedProxyPasswordSecret[] = [];
            if (vault && proxyChanges.length > 0) {
              try {
                // Fail closed — the helper restores anything it deleted in this pass and
                // rethrows on a delete/read error, so a proxy change we cannot secure is
                // never published. Abort with the house "run again" wording.
                capturedProxySecrets = await clearStaleProxyPasswordSecretsBeforeApply(vault, proxyChanges);
              } catch {
                refusal =
                  `Could not securely update the proxy settings for "${folderPath}" — nothing was applied. ` +
                  "Run Apply Device Template again.";
                return;
              }
            }
            try {
              applied = await applyPlanWrites(ctx, plan);
            } catch (error) {
              // FIX A′ (issue #48 PR-T1b / PR #62 Codex review round 3, SECURITY) — the
              // restore here MUST be per-server CONDITIONAL, not blanket. Unlike the sync
              // path's atomic `applyInventorySyncPlan` (on throw nothing committed, old
              // proxy live everywhere → its unconditional restore is correct), the manual
              // path's `applyPlanWrites` loops `core.addOrUpdateServer` per server, and
              // that method installs the new record in memory then awaits `saveServers`
              // with NO rollback on reject. A mid-loop failure therefore leaves the
              // already-processed servers COMMITTED on their NEW proxy while the later
              // ones stayed on the OLD one. A blanket restore would re-arm the committed
              // (new-proxy) servers with the OLD endpoint's password — `ProxySshFactory`
              // would then send that password to the new endpoint: the exact leak this
              // whole path exists to prevent.
              //
              // So restore a captured secret ONLY for a server whose CURRENT live proxy
              // is still the OLD authenticated endpoint that secret was captured for
              // (`isSameAuthenticatedEndpoint(liveProxy, beforeProxy)`). A server now on
              // the NEW proxy (its write landed) keeps its secret deleted — the new
              // template proxy carries no stored secret and prompts per-connect (§5.3),
              // so leaving it deleted is correct and leak-free. The boundary server (new
              // proxy in memory but its own save was the failing one) reads "new" and is
              // skipped: that fails SAFE — a per-connect password prompt, never a leak.
              // Invariant: no server is ever left holding the NEW proxy AND the OLD
              // endpoint's password.
              if (vault) {
                const beforeProxyByKey = new Map<string, { id: string; beforeProxy: typeof proxyChanges[number]["before"]["proxy"] }>();
                for (const { before } of proxyChanges) {
                  beforeProxyByKey.set(proxyPasswordSecretKey(before.id), { id: before.id, beforeProxy: before.proxy });
                }
                const restorable = capturedProxySecrets.filter((secret) => {
                  const origin = beforeProxyByKey.get(secret.key);
                  if (!origin) {
                    return false;
                  }
                  const liveProxy = ctx.core.getServer(origin.id)?.proxy;
                  return isSameAuthenticatedEndpoint(liveProxy, origin.beforeProxy);
                });
                await restoreProxyPasswordSecrets(vault, restorable);
              }
              throw error;
            }
          })
      );
      if (refusal !== undefined) {
        void vscode.window.showWarningMessage(refusal);
        return;
      }
      void vscode.window.showInformationMessage(
        `Applied device template "${template.name}" to ${serverCountPhrase(applied)}.`
      );
    })
  ];
}
