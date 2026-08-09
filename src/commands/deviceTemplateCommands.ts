import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ProxyConfig, ServerConfig } from "../models/config";
import type { DeviceTemplateProfile, TemplateField, TemplateFieldMode } from "../models/deviceTemplate";
import {
  clearTemplatedStamps,
  planManualTemplateApply,
  TEMPLATE_FIELD_SHORT_LABELS,
  type ManualApplyPlan,
  type TemplatableField
} from "../services/inventory/templateApply";
import { configMutationLock } from "../services/configMutationLock";
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

/** Reads one field's `{mode, value}` off the submitted form, or `undefined` when
 *  the mode select is "Not set" (or the value control produced nothing usable). */
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
    return undefined;
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
  return { id: existingId ?? randomUUID(), name, fields };
}

function serverListEntries(ctx: CommandContext): ServerListEntry[] {
  return ctx.core.getSnapshot().servers.map((s) => ({ id: s.id, name: s.name }));
}

/** Opens the editor (Add when `seed` is undefined, Edit otherwise). */
function openDeviceTemplateEditor(ctx: CommandContext, seed?: DeviceTemplateProfile): void {
  const snapshot = ctx.core.getSnapshot();
  const definition = deviceTemplateFormDefinition(seed, serverListEntries(ctx), snapshot.authProfiles);
  const formId = seed?.id ? `device-template-edit-${seed.id}` : "device-template-add";
  WebviewFormPanel.open(formId, definition, {
    onSubmit: async (values) => {
      const template = parseDeviceTemplateFormValues(values, seed?.id);
      await ctx.core.addOrUpdateDeviceTemplate(template);
      void vscode.window.showInformationMessage(
        seed?.id ? `Device template "${template.name}" updated.` : `Device template "${template.name}" created.`
      );
    }
  });
}

/** UX-M5 empty-state placeholder for the manage hub (never the legacy dead-end). */
const EMPTY_STATE_PLACEHOLDER =
  "No device templates yet. A device template applies shared settings — proxy, auth profile, and more — to servers synced from inventory.";

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
  const pick = await vscode.window.showQuickPick(
    [
      { label: NEW, template: undefined as DeviceTemplateProfile | undefined },
      ...templates
        .slice()
        .sort((a, b) => naturalCompare(a.name, b.name))
        .map((t) => ({ label: t.name, description: describeTemplateFields(t), template: t }))
    ],
    { title: "Manage Device Templates", placeHolder: "Select a device template to edit, or create a new one" }
  );
  if (!pick) {
    return;
  }
  openDeviceTemplateEditor(ctx, pick.template);
}

/** A one-line "Sets: Proxy, Auth Profile" summary via the shared short-label map. */
function describeTemplateFields(template: DeviceTemplateProfile): string {
  const set: string[] = [];
  for (const field of ["proxy", "authProfileId", "multiplexing", "legacyAlgorithms", "logSession"] as TemplatableField[]) {
    if (template.fields[field] !== undefined) {
      set.push(TEMPLATE_FIELD_SHORT_LABELS[field]);
    }
  }
  return set.length > 0 ? `Sets: ${set.join(", ")}` : "Sets nothing yet";
}

function serversInFolder(ctx: CommandContext, folderPath: string): ServerConfig[] {
  return ctx.core.getSnapshot().servers.filter((s) => s.group && isDescendantOrSelf(s.group, folderPath));
}

async function pickTemplate(ctx: CommandContext): Promise<DeviceTemplateProfile | undefined> {
  const templates = ctx.core.getSnapshot().deviceTemplates;
  if (templates.length === 0) {
    // Zero-template state (UX-M5) — offer New instead of a dead-end warning.
    const choice = await vscode.window.showInformationMessage(EMPTY_STATE_PLACEHOLDER, "New Device Template");
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

/**
 * The §7.4 (UX-S7) consent modal: per-field dry-run lines with the auth link's
 * skips split by reason, closing with the verbatim ownership sentence.
 */
function buildConsentModal(plan: ManualApplyPlan): string {
  const lines: string[] = [];
  const valueLine = (field: TemplatableField, stats: { mode: TemplateFieldMode; willSet: number; skipped: number } | undefined): void => {
    if (!stats) {
      return;
    }
    const mode = stats.mode === "override" ? "Override" : "Fill";
    lines.push(`${TEMPLATE_FIELD_SHORT_LABELS[field]} (${mode}): ${stats.willSet} servers will be set, ${stats.skipped} skipped`);
  };
  valueLine("proxy", plan.proxy);
  valueLine("multiplexing", plan.multiplexing);
  valueLine("legacyAlgorithms", plan.legacyAlgorithms);
  valueLine("logSession", plan.logSession);
  if (plan.auth) {
    const a = plan.auth;
    if (a.mode === "fill") {
      let line = `Auth Profile (Fill): ${a.linked} servers will be linked; ${a.skippedAlreadyLinked} skipped (already linked); ${a.skippedLoginConfigured} skipped (SSH login already configured)`;
      if (a.skippedNeedsKey > 0) {
        line += `; ${a.skippedNeedsKey} skipped (profile needs a key file the server doesn't have)`;
      }
      lines.push(line);
    } else {
      let line = `Auth Profile (Override): ${a.linked} servers will be linked, replacing ${a.replacingHandConfigured} hand-configured logins`;
      if (a.skippedNeedsKey > 0) {
        line += `; ${a.skippedNeedsKey} skipped (profile needs a key file the server doesn't have)`;
      }
      lines.push(line);
    }
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
 */
async function applyPlanWrites(ctx: CommandContext, plan: ManualApplyPlan): Promise<number> {
  let applied = 0;
  for (const write of plan.serverWrites) {
    const live = ctx.core.getServer(write.serverId);
    if (!live) {
      continue;
    }
    const next: ServerConfig = { ...live };
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
      next.authProfileId = write.authProfileId;
    }
    // §7.4 — clear the stamps of exactly the fields written, so every one reads
    // as a hand edit (row 7) to later syncs. `clearTemplatedStamps` also clears
    // `syncedAuthProfileId` when the auth link is among the written fields.
    const clearedOrigin = clearTemplatedStamps(live.origin, write.writtenFields);
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

export function registerDeviceTemplateCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("nexus.deviceTemplate.add", () => {
      openDeviceTemplateEditor(ctx);
    }),

    vscode.commands.registerCommand("nexus.deviceTemplate.manage", () => manageDeviceTemplates(ctx)),

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
      const previewPlan = planFor(ctx, template, servers);
      const confirm = await vscode.window.showWarningMessage(buildConsentModal(previewPlan), { modal: true }, "Apply");
      if (confirm !== "Apply") {
        return;
      }
      // Re-derive under the lock from live state, then write once per server —
      // the same "abort nothing, recompute from scratch" shape the auth-profile
      // apply command uses.
      let applied = 0;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Applying device template "${template.name}"...` },
        () =>
          configMutationLock.runExclusive(async () => {
            const live = ctx.core.getDeviceTemplate(template.id);
            if (!live) {
              return;
            }
            const current = serversInFolder(ctx, folderPath);
            const plan = planFor(ctx, live, current);
            applied = await applyPlanWrites(ctx, plan);
          })
      );
      void vscode.window.showInformationMessage(
        `Applied device template "${template.name}" to ${serverCountPhrase(applied)}.`
      );
    })
  ];
}
