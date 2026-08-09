import { randomUUID } from "node:crypto";
import type { ProxyConfig } from "./config";

/**
 * How forcefully a templated field is applied.
 *  - `fill`     — WRITE-ONCE: applies only where the field was never configured.
 *                 It never rewrites an existing value, not even one the sync
 *                 itself wrote earlier (see the §4.3 mode gate in
 *                 services/inventory/templateApply.ts).
 *  - `override` — beats source data and the sync's own earlier writes, and
 *                 propagates template edits to still-sync-owned values — but
 *                 NEVER touches a hand edit.
 */
export type TemplateFieldMode = "fill" | "override";

/** One templated field: the value the template supplies and how forcefully. */
export interface TemplateField<T> {
  mode: TemplateFieldMode;
  value: T;
}

/**
 * A named, partial-ServerConfig-shaped bundle of values, applied to servers
 * synced from inventory by the rules on `InventorySourceConfig.templateRules`.
 * Referenced by id everywhere, so a rename is free.
 *
 * Pure model — no `vscode` import, so the engine (services/inventory/
 * templateApply.ts) can consume it and unit tests can build it directly.
 */
export interface DeviceTemplateProfile {
  id: string; // randomUUID at creation
  name: string; // user-facing
  /**
   * Incarnation token, same contract as `InventorySourceConfig.revision`
   * (models/inventory.ts): assigned fresh by NexusCore on every write,
   * backfilled at load for legacy records (see ensureDeviceTemplateRevision).
   * Exists so a pre-apply fast-fail can detect "template edited mid-sync" the
   * same way `sourceConfigUnchanged` detects a source edit — but that comparison
   * lands with T1b (deferred; see NexusCore.removeAuthProfile), so in T1 the
   * revision is recorded and not yet compared.
   */
  revision?: string;
  /**
   * A field that is ABSENT is one the template says nothing about — the
   * cascade falls through it to the next-most-specific rule. There is no
   * "clear" mode in v1 (see §11 open question 3), so absence is unambiguous.
   *
   * Only these five v1 fields are templatable. `host`/`name`/`ipmiHost`
   * (identity), `group` (folder placement), `username`/`authType`/`keyPath`
   * (auth-profile machinery), and `port` (deferred, §4.6) are deliberately
   * excluded. `authProfileId` is a LINK only — never copied credentials — and
   * reuses the existing `ServerOrigin.syncedAuthProfileId` stamp rather than a
   * twin in `origin.templated`.
   */
  fields: {
    proxy?: TemplateField<ProxyConfig>;
    authProfileId?: TemplateField<string>; // AuthProfile.id
    multiplexing?: TemplateField<boolean>;
    legacyAlgorithms?: TemplateField<boolean>;
    logSession?: TemplateField<boolean>;
    // Reserved — added by PR-T3 once PR-B / PR-C land the ServerConfig fields:
    // ipmiAuthProfileId?: TemplateField<string>;
    // ipmiGatewayServerId?: TemplateField<string>;
  };
}

/**
 * Backfills a revision onto a template loaded from persisted storage that
 * predates the `revision` field. Called by the repository getters at LOAD time
 * only — never by NexusCore, which regenerates a revision on every WRITE
 * (addOrUpdateDeviceTemplate). Returns the input unchanged (same reference)
 * when a revision is already present, so it is safe to map over every loaded
 * record. Mirrors `ensureInventorySourceRevision` (models/inventory.ts).
 */
export function ensureDeviceTemplateRevision(template: DeviceTemplateProfile): DeviceTemplateProfile {
  return template.revision ? template : { ...template, revision: randomUUID() };
}
